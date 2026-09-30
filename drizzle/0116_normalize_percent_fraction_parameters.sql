-- Normalize fraction parameters stored as percentages.
--
-- `bioavailability` and `proteinBinding` are `kind: 'fraction'` in the registry
-- (src/lib/drugParameters.ts): `allowedUnits: ['fraction']`, bounds 0–1. A
-- handful of rows nonetheless hold the percentage under `unit: '%'` — protein
-- binding of 80 rather than 0.8. They predate the registry-validated write
-- path: `scripts/seed-drugs.ts` stores a value that fails `spec.zod` as-is
-- (with a warning), so the auto-extracted OpenFDA/Wikidata figures went in
-- carrying the unit their source reported.
--
-- Nothing can read them correctly. They are out of bounds for their own
-- parameter, so the API rejects any edit to them; the drug table only looks
-- right because `normalizeRangeInput({ asFraction: true })` divides anything
-- over 1 by 100 on the way to the cell, a heuristic the monograph sidebar and
-- the comparison page do not apply — those render "80 %" beside "0.3" for the
-- same quantity.
--
-- Which rows this reaches, in the live database at the time of writing: three
-- `proteinBinding` rows (caffeine, ketamine, remifentanil), all stamped with
-- the same 2026-05-07 bulk timestamp. The other rows of that import are gone
-- already — every drug with `parameter_entries` had its drug-level cache
-- recomputed in `fraction` by the aggregation pipeline, and these three have no
-- entries, so nothing ever overwrote them.
--
-- Scope, deliberately:
--   * `parameter_entries` is NOT touched. It holds no percent-united row (589
--     `bioavailability` + `proteinBinding` entries, all `fraction`) and cannot
--     acquire one: every entry write validates the unit against the parameter's
--     `allowedUnits` (validateEntryForParameter in src/lib/parameterEntries.ts).
--   * `drug_parameter_revisions` is NOT touched. Its `old_value`/`new_value`
--     record what was stored at the time; rewriting them would falsify the
--     audit trail rather than repair data anything reads.
--
-- The guard below leaves any row alone whose numbers do not land inside the
-- parameter's 0–1 bounds once divided — a value over 100 under `unit: '%'` is
-- not a percentage anyone can interpret, and a silent /100 would turn an
-- obvious error into a plausible one. None exist today; the WHERE clause is
-- what keeps that true if one appears between this being written and applied.
--
-- Re-running changes nothing: the WHERE clause selects on `unit = '%'`, which
-- no surviving row carries.

UPDATE "drug_parameters" AS dp
SET "value" =
      (dp."value" - 'min' - 'max' - 'median' - 'mean')
      || jsonb_build_object('unit', 'fraction')
      || (CASE WHEN dp."value" ? 'min' THEN jsonb_build_object('min', round((dp."value" ->> 'min')::numeric / 100, 6)) ELSE '{}'::jsonb END)
      || (CASE WHEN dp."value" ? 'max' THEN jsonb_build_object('max', round((dp."value" ->> 'max')::numeric / 100, 6)) ELSE '{}'::jsonb END)
      || (CASE WHEN dp."value" ? 'median' THEN jsonb_build_object('median', round((dp."value" ->> 'median')::numeric / 100, 6)) ELSE '{}'::jsonb END)
      || (CASE WHEN dp."value" ? 'mean' THEN jsonb_build_object('mean', round((dp."value" ->> 'mean')::numeric / 100, 6)) ELSE '{}'::jsonb END),
    "updated_at" = now()
WHERE dp."parameter" IN ('bioavailability', 'proteinBinding')
  AND jsonb_typeof(dp."value") = 'object'
  AND dp."value" ->> 'unit' = '%'
  AND dp."value" ?| ARRAY['min', 'max', 'median', 'mean']
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_each(dp."value") AS kv(k, v)
    WHERE kv.k IN ('min', 'max', 'median', 'mean')
      AND (
        jsonb_typeof(kv.v) <> 'number'
        OR (kv.v)::text::numeric < 0
        OR (kv.v)::text::numeric > 100
      )
  );
