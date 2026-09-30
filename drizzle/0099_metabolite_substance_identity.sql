-- One metabolite link per substance, not per spelling.
--
-- `drug_metabolites` was unique on (parent_drug_id, metabolite_name), but that
-- column is a *label*, not a key: the metabolism editor pre-fills it from the
-- linked drug's name in the editing user's language, the research importer
-- copies the paper's spelling, the farmakologiportalen importer copies the
-- Norwegian one. So one substance reached the table repeatedly under different
-- strings, each carrying the same `metabolite_drug_id`, and every writer's
-- ON CONFLICT DO NOTHING (keyed on the name) waved them through.
--
-- The monograph sidebar renders `metabolite_drug_id`'s localized name and only
-- falls back to `metabolite_name` when nothing is linked, so those rows print
-- as the *same line, twice* — cocaine listed "benzoylecgonin · inaktiv" and
-- "kokaetylen · aktiv" twice each, which reads as broken data rather than as
-- two rows.
--
-- This resolves the duplicates a live catalog already holds and adds the index
-- that keys on the substance. Deleting the extra rows outright would drop
-- whatever a later row alone carried (a conversion fraction, a note, its
-- citations), so each one is either folded into the row that survives it or
-- kept — never simply discarded. Which of those it gets is the subject of the
-- comment on the statement below.
--
-- Every statement is re-runnable, and there are as few of them as possible,
-- because **each chunk commits on its own**. `drizzle-orm/neon-http`'s migrator
-- sends every statement-breakpoint chunk through its own `session.execute` —
-- one HTTP request, one implicit transaction — so a file is not a transaction
-- here however it reads. And migrations run during `vercel build` while the
-- *previous* build is still accepting writes, so the gap between two chunks is
-- a gap a live importer can insert a duplicate into.
--
-- That is why the whole resolution below is one statement rather than several:
-- split across chunks, a duplicate landing after the fold committed would be
-- ranked and deleted by the next chunk without ever being folded in, which
-- loses its range, note and citations silently. As one statement every arm
-- shares a snapshot, so a row arriving later is neither folded, unlinked nor
-- deleted — it survives as a duplicate, the CREATE UNIQUE INDEX chunk fails,
-- and the deploy aborts rather than corrupting anything. Re-running the file
-- then resolves the late row and succeeds. Loud and recoverable is the
-- direction to fail in; silent is not.

-- Resolve each duplicate group, all in one statement. A group is either
-- **consistent** — no two rows state the same field differently — or it is
-- not, and the two cases are handled in opposite ways:
--
--   * Consistent: the rows are the same claim spelled several ways. The
--     surviving row (lowest sort_order, ties by id — the one a curator listed
--     first) absorbs every field and every citation, and the rest are deleted.
--     Nothing is lost, and no citation moves onto a claim it does not support,
--     because there is only one claim in the group.
--   * Inconsistent: somewhere in the group two rows disagree about a known
--     activity, a conversion range, or an evidence note. Then **nothing moves
--     at all**. The survivor is left exactly as it is, and every other row is
--     *unlinked* — `metabolite_drug_id` set to NULL, which drops it out of the
--     new index's reach while leaving the row whole: its claim, its note and
--     its own citations intact, still listed on the monograph as a free-text
--     entry beside the linked one.
--
-- All-or-nothing per group is deliberate, and stricter than it needs to be for
-- the rows that happen to agree. The alternative — fold the agreeing rows,
-- unlink the rest — cannot be expressed without deciding what "agrees" means
-- against a target that is itself being assembled, and every non-recursive
-- approximation of that leaks: comparing rows to the survivor lets two donors
-- contradict each other while agreeing with an empty survivor vacuously, and
-- comparing them to a per-field winner lets a row be unlinked for its activity
-- while its conversion range is still copied onto the survivor — which then
-- shows a measurement whose citation stayed behind on the unlinked row. A
-- group with a disagreement in it is already a curator's problem; the useful
-- guarantee is that this migration does not silently rearrange the evidence
-- inside it. Fields and citations move together or not at all.
--
-- (The read-side merge in `dedupeMetaboliteLinks` then collapses whatever of
-- the leftovers is genuinely redundant, so a reader still sees one line per
-- substance without any of it being written down as fact.)
WITH ranked AS (
  SELECT
    id,
    sort_order,
    conversion_fraction,
    conversion_fraction_min,
    conversion_fraction_max,
    activity,
    evidence_note,
    reference_ids,
    -- One text key for the whole 0–1 range, because the three columns are one
    -- quantity: a row states a range or it does not, and two rows state the
    -- same range or they do not. Compared column by column instead, a median
    -- of 0.8 and bounds of 0.2–0.5 would look like three separate agreements
    -- and merge into a median outside its own bounds. numeric(6,4) renders at
    -- a fixed scale, so equal values always produce equal text.
    CASE
      WHEN num_nonnulls(
        conversion_fraction,
        conversion_fraction_min,
        conversion_fraction_max
      ) = 0 THEN NULL
      ELSE coalesce(conversion_fraction::text, '~')
        || '|' || coalesce(conversion_fraction_min::text, '~')
        || '|' || coalesce(conversion_fraction_max::text, '~')
    END AS range_key,
    first_value(id) OVER (
      PARTITION BY parent_drug_id, metabolite_drug_id
      ORDER BY sort_order, id
    ) AS keep_id
  FROM "drug_metabolites"
  WHERE "metabolite_drug_id" IS NOT NULL
),
-- One row per duplicate group: whether it is consistent, and — for the ones
-- that are — the single value of each field. `count(DISTINCT …)` ignores
-- NULLs, so a row that states nothing about a field is not a second opinion
-- about it.
grouped AS (
  SELECT
    ranked.keep_id,
    count(*) AS n,
    count(DISTINCT NULLIF(activity, 'unknown')) AS activity_variants,
    -- Blank is absent, not a second opinion: `btrim(evidence_note)` alone
    -- makes a row holding '' count as a variant, so one stray empty string
    -- would mark an otherwise-identical group inconsistent — and the fold
    -- below would keep the '' and drop the real note.
    count(DISTINCT NULLIF(btrim(evidence_note), '')) AS note_variants,
    count(DISTINCT range_key) AS range_variants,
    (array_remove(array_agg(NULLIF(activity, 'unknown') ORDER BY sort_order, id), NULL))[1] AS activity,
    (array_remove(array_agg(NULLIF(btrim(evidence_note), '') ORDER BY sort_order, id), NULL))[1] AS evidence_note,
    (
      SELECT ARRAY[
        r2.conversion_fraction,
        r2.conversion_fraction_min,
        r2.conversion_fraction_max
      ]
      FROM ranked r2
      WHERE r2.keep_id = ranked.keep_id AND r2.range_key IS NOT NULL
      ORDER BY r2.sort_order, r2.id
      LIMIT 1
    ) AS conversion_range,
    (
      SELECT array_agg(DISTINCT u.ref ORDER BY u.ref)
      FROM ranked r3, unnest(r3.reference_ids) AS u(ref)
      WHERE r3.keep_id = ranked.keep_id
    ) AS reference_ids
  FROM ranked
  GROUP BY ranked.keep_id
  HAVING count(*) > 1
),
consistent AS (
  SELECT * FROM grouped
  WHERE activity_variants <= 1 AND note_variants <= 1 AND range_variants <= 1
),
folded AS (
  UPDATE "drug_metabolites" m
  SET
    "conversion_fraction" = c.conversion_range[1],
    "conversion_fraction_min" = c.conversion_range[2],
    "conversion_fraction_max" = c.conversion_range[3],
    "activity" = COALESCE(c.activity, m."activity"),
    "evidence_note" = c.evidence_note,
    "reference_ids" = COALESCE(c.reference_ids, m."reference_ids"),
    "updated_at" = now()
  FROM consistent c
  WHERE m."id" = c.keep_id
  RETURNING m."id"
),
unlinked AS (
  -- Every non-survivor of a group that disagrees with itself. Idempotent: with
  -- metabolite_drug_id NULL the row is no longer in `ranked` at all, so a
  -- re-run neither sees it nor touches it again.
  UPDATE "drug_metabolites" m
  SET "metabolite_drug_id" = NULL, "updated_at" = now()
  FROM ranked r
  JOIN grouped g ON g.keep_id = r.keep_id
  WHERE m."id" = r.id
    AND r.id <> r.keep_id
    AND NOT (
      g.activity_variants <= 1
      AND g.note_variants <= 1
      AND g.range_variants <= 1
    )
  RETURNING m."id"
)
-- Drop the rows the fold absorbed, and only those. A data-modifying CTE runs
-- exactly once and to completion whether or not the primary query reads it,
-- and every arm here sees the same snapshot — so none can miss a row another
-- one moved, and the three touch disjoint rows (survivors of consistent
-- groups / non-survivors of inconsistent ones / non-survivors of consistent
-- ones).
DELETE FROM "drug_metabolites" x
USING ranked r
JOIN consistent c ON c.keep_id = r.keep_id
WHERE x."id" = r.id AND r.id <> r.keep_id;
--> statement-breakpoint

-- The identity key. Partial: an unresolved free-text link has no substance to
-- key on, and those stay covered by drug_metabolites_parent_name_idx. Built
-- non-concurrently: the table holds one row per metabolite link, so the brief
-- lock costs nothing, and a plain build fails outright on a duplicate the
-- statement above could not see — which is the signal wanted here — where a
-- CONCURRENTLY build would leave an INVALID index behind instead.
CREATE UNIQUE INDEX IF NOT EXISTS "drug_metabolites_parent_metabolite_drug_idx"
  ON "drug_metabolites" ("parent_drug_id", "metabolite_drug_id")
  WHERE "metabolite_drug_id" IS NOT NULL;
