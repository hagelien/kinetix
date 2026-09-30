-- Phase 1 of multi-value drug parameters.
--
-- Generalize the single-purpose reference_concentrations table into a
-- per-parameter, multi-value SOURCE store: parameter_entries. One row is one
-- value for one drug parameter as reported by one source, carrying its own
-- biological matrix. This reverses the direction of migration 0023 (which had
-- collapsed reference_concentrations into the single-value
-- drug_parameters.therapeuticConcentration and demoted the table to legacy
-- reads). The table and every row survive — we rename in place and add the
-- `parameter` column, so no data is reconstructed and citation_id FKs are kept.

-- ── Step 1: rename the table and its indexes in place ──────────────────────
-- Idempotent guards: the neon-http migrator auto-commits each statement
-- individually (no wrapping transaction), so a failure later in this file
-- leaves these earlier statements committed while the migration stays
-- unrecorded — the whole file then re-runs on the next deploy. Each rename is
-- therefore a no-op once the post-rename name already exists.
DO $$
BEGIN
  IF to_regclass('public.reference_concentrations') IS NOT NULL
     AND to_regclass('public.parameter_entries') IS NULL THEN
    ALTER TABLE "reference_concentrations" RENAME TO "parameter_entries";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.ref_conc_drug_idx') IS NOT NULL
     AND to_regclass('public.parameter_entries_drug_idx') IS NULL THEN
    ALTER INDEX "ref_conc_drug_idx" RENAME TO "parameter_entries_drug_idx";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.ref_conc_drug_matrix_scenario_idx') IS NOT NULL
     AND to_regclass('public.parameter_entries_drug_matrix_scenario_idx') IS NULL THEN
    ALTER INDEX "ref_conc_drug_matrix_scenario_idx"
      RENAME TO "parameter_entries_drug_matrix_scenario_idx";
  END IF;
END $$;
--> statement-breakpoint

-- ── Step 2: add the generalizing columns ───────────────────────────────────
-- ADD COLUMN IF NOT EXISTS so a re-run after a partial apply is a no-op.
ALTER TABLE "parameter_entries" ADD COLUMN IF NOT EXISTS "parameter" varchar(60);
--> statement-breakpoint
ALTER TABLE "parameter_entries"
  ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "parameter_entries"
  ADD COLUMN IF NOT EXISTS "median" numeric(14, 6);
--> statement-breakpoint
ALTER TABLE "parameter_entries"
  ADD COLUMN IF NOT EXISTS "qualifier" varchar(8);
--> statement-breakpoint
-- Existing rows are real reference-concentration sources → 'legacy'. The Step-5
-- synthetic rows below set 'grandfathered' explicitly.
ALTER TABLE "parameter_entries"
  ADD COLUMN IF NOT EXISTS "origin" varchar(20) DEFAULT 'legacy' NOT NULL;
--> statement-breakpoint

-- ── Step 3: back-fill `parameter` from the legacy `scenario` bucket ─────────
-- The interpretive-concentration scenarios map to the interpretive-concentration
-- parameters. `scenario` is retained as finer-grained context (and the Phase-2
-- aggregator is scenario-aware), so the three scenarios without a clean bucket
-- (postmortem_non_intox, case_report, case_series) land in their nearest
-- interpretive home without losing the original scenario tag.
UPDATE "parameter_entries" SET "parameter" = CASE "scenario"
  WHEN 'living_therapeutic'    THEN 'therapeuticConcentration'
  WHEN 'living_toxic'          THEN 'toxicConcentration'
  WHEN 'living_dui'            THEN 'impairmentConcentration'
  WHEN 'postmortem_mono_intox' THEN 'fatalConcentration'
  WHEN 'postmortem_poly_intox' THEN 'fatalConcentration'
  WHEN 'postmortem_non_intox'  THEN 'fatalConcentration'
  WHEN 'case_report'           THEN 'toxicConcentration'
  WHEN 'case_series'           THEN 'toxicConcentration'
  ELSE 'toxicConcentration'
END
WHERE "parameter" IS NULL;
--> statement-breakpoint
ALTER TABLE "parameter_entries" ALTER COLUMN "parameter" SET NOT NULL;
--> statement-breakpoint

-- ── Step 4: new indexes for the generalized access patterns ─────────────────
CREATE INDEX IF NOT EXISTS "parameter_entries_drug_param_idx"
  ON "parameter_entries" ("drug_id", "parameter");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "parameter_entries_citation_idx"
  ON "parameter_entries" ("citation_id");
--> statement-breakpoint

-- ── Step 5: grandfather hand-authored drug_parameters values ────────────────
-- Existing single values (0023-migrated, seeded, or agent-authored) that have
-- NO backing entry are converted into a synthetic entry so the Phase-2 aggregate
-- recompute never SILENTLY replaces a curated value with an empty one.
--
-- Matrix is defaulted to 'whole_blood' on purpose: the aggregate normalizes to
-- whole blood, and a whole-blood entry passes through the matrix conversion
-- unchanged, so the displayed number is preserved EXACTLY regardless of the
-- drug's blood:plasma ratio. Whole blood is also the forensic-toxicology default
-- matrix. The assumption is flagged in `comments` for curator review.
--
-- Scoped to the five INTERPRETIVE CONCENTRATION parameters only. loq/lod are
-- deliberately excluded: they are analytical limits with (a) no interpretive
-- `scenario` (the NOT NULL column would force a false 'case_report' label) and
-- (b) a different canonical unit (ng/mL vs mg/L), so a unit-less authored value
-- must not be blanket-assigned mg/L here. Their authored drug_parameters value
-- is preserved untouched and is grandfathered by the Phase-2 aggregate's
-- "authored value survives while 0 entries exist" rule instead.
--
-- Because every backfilled row is a concentration, mg/L is the correct CANONICAL
-- unit for a value that carries none (not a cross-parameter fabrication).
-- The authored central estimate (median, else mean) is preserved in the new
-- `median` column so aggregation uses the curated point, not the bound midpoint.
--
-- The skip guard matches on the derived VALUE (low/high/median/unit), not merely
-- on (drug, parameter). A stale pre-0023 legacy row that maps to the same
-- parameter but a DIFFERENT value must not suppress grandfathering of a value
-- that was edited after 0023 — otherwise the Phase-2 recompute would aggregate
-- only the older evidence and silently overwrite the newer curated value.
WITH authored AS (
  SELECT
    dp."drug_id" AS drug_id,
    dp."parameter" AS parameter,
    -- low/high from the NumericRange. A min/max range keeps its bounds; a
    -- min-only (or max-only) value keeps that single bound; a point value
    -- (median→mean with no min/max) collapses to low = high = the point.
    CASE
      WHEN NULLIF(dp."value" ->> 'min', '') IS NOT NULL
        THEN (dp."value" ->> 'min')::numeric(14, 6)
      WHEN NULLIF(dp."value" ->> 'max', '') IS NOT NULL
        THEN NULL
      ELSE COALESCE(
        NULLIF(dp."value" ->> 'median', '')::numeric(14, 6),
        NULLIF(dp."value" ->> 'mean', '')::numeric(14, 6)
      )
    END AS low,
    CASE
      WHEN NULLIF(dp."value" ->> 'max', '') IS NOT NULL
        THEN (dp."value" ->> 'max')::numeric(14, 6)
      WHEN NULLIF(dp."value" ->> 'min', '') IS NOT NULL
        THEN NULL
      ELSE COALESCE(
        NULLIF(dp."value" ->> 'median', '')::numeric(14, 6),
        NULLIF(dp."value" ->> 'mean', '')::numeric(14, 6)
      )
    END AS high,
    -- Preserve the authored central estimate (median preferred over mean).
    COALESCE(
      NULLIF(dp."value" ->> 'median', '')::numeric(14, 6),
      NULLIF(dp."value" ->> 'mean', '')::numeric(14, 6)
    ) AS median,
    COALESCE(NULLIF(dp."value" ->> 'unit', ''), 'mg/L') AS unit,
    -- Preserve a strict-threshold operator (e.g. '<') so "< 120" is not
    -- silently weakened into an inclusive bound. Only the four canonical
    -- NumericRange operators are valid here; anything else in the (un-typed)
    -- JSONB `qualifier` field is invalid data that must NOT be copied — it can
    -- overflow the varchar(8) column (code 22001) and is not a real operator.
    -- Bounds and note are preserved regardless, so no meaning is lost.
    CASE
      WHEN (dp."value" ->> 'qualifier') IN ('<', '>', '≤', '≥')
        THEN dp."value" ->> 'qualifier'
      ELSE NULL
    END AS qualifier,
    NULLIF(dp."value" ->> 'note', '') AS note,
    dp."updated_by" AS updated_by,
    dp."created_at" AS created_at,
    dp."updated_at" AS updated_at
  FROM "drug_parameters" dp
  WHERE dp."parameter" IN (
      'therapeuticConcentration',
      'supratherapeuticConcentration',
      'impairmentConcentration',
      'toxicConcentration',
      'fatalConcentration'
    )
    AND jsonb_typeof(dp."value") = 'object'
    -- Only when a numeric value is actually present.
    AND (
      NULLIF(dp."value" ->> 'min', '') IS NOT NULL
      OR NULLIF(dp."value" ->> 'max', '') IS NOT NULL
      OR NULLIF(dp."value" ->> 'median', '') IS NOT NULL
      OR NULLIF(dp."value" ->> 'mean', '') IS NOT NULL
    )
)
INSERT INTO "parameter_entries" (
  "drug_id", "parameter", "low", "high", "median", "qualifier", "unit", "matrix",
  "scenario", "n", "comments", "origin", "sort_order", "citation_id",
  "created_by", "created_at", "updated_at"
)
SELECT
  a.drug_id,
  a.parameter,
  a.low,
  a.high,
  a.median,
  a.qualifier,
  a.unit,
  'whole_blood',
  CASE a.parameter
    WHEN 'therapeuticConcentration'      THEN 'living_therapeutic'
    WHEN 'supratherapeuticConcentration' THEN 'living_toxic'
    WHEN 'impairmentConcentration'       THEN 'living_dui'
    WHEN 'toxicConcentration'            THEN 'living_toxic'
    WHEN 'fatalConcentration'            THEN 'postmortem_mono_intox'
    ELSE 'living_therapeutic'
  END,
  NULL,
  concat_ws(
    ' ',
    a.note,
    '[legacy value imported to parameter_entries; matrix defaulted to whole blood — verify]'
  ),
  -- Synthetic cache-preservation row, not an independent source: excluded from
  -- the legacy compatibility endpoint.
  'grandfathered',
  0,
  -- Newest citation recorded for this parameter, when any.
  (
    SELECT r."reference_id"
    FROM "drug_parameter_revisions" r
    WHERE r."drug_id" = a.drug_id
      AND r."parameter" = a.parameter
      AND r."reference_id" IS NOT NULL
    ORDER BY r."created_at" DESC, r."id" DESC
    LIMIT 1
  ),
  a.updated_by,
  a.created_at,
  a.updated_at
FROM authored a
-- Skip only when a WHOLE-BLOOD entry already represents this exact curated value
-- (null-safe comparison). The matrix must match: an existing serum/plasma entry
-- with the same literal bounds is NOT equivalent, because Phase 2 normalizes it
-- to whole blood via the drug's blood:plasma ratio and would land on a different
-- number — so the synthetic whole-blood entry must still be created to preserve
-- the value exactly. A stale row with a different value does not suppress it
-- either, and the whole-blood match keeps the backfill idempotent on re-run.
WHERE NOT EXISTS (
  SELECT 1 FROM "parameter_entries" pe
  WHERE pe."drug_id" = a.drug_id
    AND pe."parameter" = a.parameter
    AND pe."matrix" = 'whole_blood'
    AND pe."low" IS NOT DISTINCT FROM a.low
    AND pe."high" IS NOT DISTINCT FROM a.high
    AND pe."median" IS NOT DISTINCT FROM a.median
    AND pe."unit" = a.unit
);
