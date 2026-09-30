-- Corrective re-run of migration 0078's grandfather backfill (Step 5) with a
-- qualifier-aware skip guard.
--
-- 0078's guard compared low/high/median/unit/matrix but NOT `qualifier`, so a
-- hand-authored strict-threshold value like "< 120" could be suppressed by a
-- pre-existing whole-blood entry whose bounds/median/unit matched but whose
-- operator differed (e.g. a bare 120), leaving only the semantically different
-- entry. 0078 is already applied and cannot be edited in place, so this
-- migration re-runs the same idempotent backfill with the corrected guard: it
-- adds a synthetic whole-blood entry for any authored value that was wrongly
-- skipped, while leaving every correctly grandfathered row untouched (they now
-- match on qualifier too). In a database where 0078's guard suppressed nothing
-- this is a no-op.
WITH authored AS (
  SELECT
    dp."drug_id" AS drug_id,
    dp."parameter" AS parameter,
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
    COALESCE(
      NULLIF(dp."value" ->> 'median', '')::numeric(14, 6),
      NULLIF(dp."value" ->> 'mean', '')::numeric(14, 6)
    ) AS median,
    COALESCE(NULLIF(dp."value" ->> 'unit', ''), 'mg/L') AS unit,
    -- Only the four canonical NumericRange operators are valid; anything else
    -- in the un-typed JSONB `qualifier` is invalid data that must not be copied
    -- (it can overflow the varchar(8) column — code 22001).
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
  'grandfathered',
  0,
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
-- Qualifier-aware guard: an entry that matches on bounds/median/unit but NOT on
-- the comparison operator is NOT equivalent, so it no longer suppresses the
-- grandfathered row. Correctly grandfathered rows (which already carry the same
-- qualifier) still match and are skipped, keeping this idempotent.
WHERE NOT EXISTS (
  SELECT 1 FROM "parameter_entries" pe
  WHERE pe."drug_id" = a.drug_id
    AND pe."parameter" = a.parameter
    AND pe."matrix" = 'whole_blood'
    AND pe."low" IS NOT DISTINCT FROM a.low
    AND pe."high" IS NOT DISTINCT FROM a.high
    AND pe."median" IS NOT DISTINCT FROM a.median
    AND pe."qualifier" IS NOT DISTINCT FROM a.qualifier
    AND pe."unit" = a.unit
);
