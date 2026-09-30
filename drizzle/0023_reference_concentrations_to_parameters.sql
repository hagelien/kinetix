-- Move therapeutic reference concentrations into the normal drug-parameter store.
--
-- The standalone reference_concentrations table remains for legacy reads in
-- this migration, but the editable source of truth is now the reviewed
-- therapeuticConcentration parameter.

WITH fallback_actor AS (
  INSERT INTO users (email, username, role, email_verified_at)
  SELECT
    'migration@kinetix.internal',
    'kinetix-migration',
    'authenticated',
    NOW()
  WHERE NOT EXISTS (SELECT 1 FROM users)
  ON CONFLICT (email) DO NOTHING
  RETURNING id
),
migration_actor AS (
  SELECT id
  FROM (
    SELECT id, 0 AS priority FROM users WHERE username = 'kinetix-agent'
    UNION ALL
    SELECT id, 1 AS priority FROM users WHERE role = 'admin'
    UNION ALL
    SELECT id, 2 AS priority FROM users
    UNION ALL
    SELECT id, 3 AS priority FROM fallback_actor
  ) candidates
  ORDER BY priority, id
  LIMIT 1
),
latest_therapeutic AS (
  SELECT DISTINCT ON (rc.drug_id)
    rc.drug_id,
    COALESCE(rc.created_by, (SELECT id FROM migration_actor)) AS created_by,
    rc.citation_id,
    rc.created_at,
    rc.updated_at,
    jsonb_strip_nulls(
      jsonb_build_object(
        'min', CASE WHEN rc.low IS NOT NULL THEN rc.low::double precision END,
        'max', CASE WHEN rc.high IS NOT NULL THEN rc.high::double precision END,
        'unit', rc.unit,
        'note', concat_ws(' - ', NULLIF(rc.matrix, ''), NULLIF(rc.comments, ''))
      )
    ) AS value
  FROM reference_concentrations rc
  WHERE rc.scenario = 'living_therapeutic'
    AND (rc.low IS NOT NULL OR rc.high IS NOT NULL)
  ORDER BY rc.drug_id, rc.updated_at DESC, rc.created_at DESC, rc.id DESC
),
existing_parameters AS (
  SELECT dp.drug_id, dp.value
  FROM drug_parameters dp
  WHERE dp.parameter = 'therapeuticConcentration'
),
upserted AS (
  INSERT INTO drug_parameters AS dp (
    drug_id,
    parameter,
    value,
    updated_by,
    created_at,
    updated_at
  )
  SELECT
    drug_id,
    'therapeuticConcentration',
    value,
    created_by,
    created_at,
    updated_at
  FROM latest_therapeutic
  ON CONFLICT (drug_id, parameter) DO UPDATE
    SET value = EXCLUDED.value,
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at
    WHERE dp.value IS DISTINCT FROM EXCLUDED.value
  RETURNING drug_id
)
INSERT INTO drug_parameter_revisions (
  drug_id,
  parameter,
  old_value,
  new_value,
  edit_summary,
  reference_id,
  reference_ids,
  created_by,
  created_at
)
SELECT
  lt.drug_id,
  'therapeuticConcentration',
  ep.value,
  lt.value,
  'Migrate legacy therapeutic reference concentration',
  lt.citation_id,
  CASE WHEN lt.citation_id IS NULL THEN NULL ELSE ARRAY[lt.citation_id] END,
  lt.created_by,
  lt.updated_at
FROM latest_therapeutic lt
LEFT JOIN existing_parameters ep ON ep.drug_id = lt.drug_id
WHERE EXISTS (
  SELECT 1 FROM upserted u WHERE u.drug_id = lt.drug_id
);
