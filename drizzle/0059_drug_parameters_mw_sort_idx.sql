-- Partial functional index supporting ORDER BY molecularWeight on the drug
-- search and full-view APIs.
--
-- GET /api/drugs?sort=molecularWeight joins drug_parameters on
-- (drug_id, parameter = 'molecularWeight') and orders by
-- (value::text::numeric).  Without this index the planner must scan all
-- molecularWeight rows and materialise + sort the full result set before
-- applying LIMIT, which grows with the drug catalog.
--
-- The WHERE guard (jsonb_typeof = 'number') keeps the index creation safe if
-- any anomalous non-numeric value exists, and matches the implicit assumption
-- in the query's cast chain.  Non-number rows are excluded from the index and
-- sort as NULL LAST, consistent with the NULLS LAST clause in the ORDER BY.
CREATE INDEX CONCURRENTLY IF NOT EXISTS drug_parameters_mw_sort_idx
  ON drug_parameters ((value::text::numeric))
  WHERE parameter = 'molecularWeight'
    AND jsonb_typeof(value) = 'number';
