-- Retire the drug-level pharmacodynamic parameters and replace them with the
-- free-text primary/secondary/tertiary mechanism fields.
--
-- The old quantitative drug-level params (Ki, IC50, EC50, Emax, selectivity
-- ratio, effect threshold, toxic effect threshold) are no longer declared in
-- the parameter registry (src/lib/drugParameters.ts), so the API rejects new
-- writes for them and the sidebar never renders them. The equivalent
-- quantitative data still lives, per-target, on `drug_receptor_targets`; only
-- the drug-level aggregate values stored in the generic `drug_parameters`
-- key/value table are removed here. This is purely a data cleanup — there is
-- no dedicated column to drop.

DELETE FROM "drug_parameters"
WHERE "parameter" IN (
  'ki',
  'ic50',
  'ec50',
  'emax',
  'selectivityRatio',
  'effectThreshold',
  'toxicEffectThreshold'
);
--> statement-breakpoint

-- Retire any history/discussion/flag rows that hung off those retired
-- drug-level parameters so they don't dangle in the review surfaces.
DELETE FROM "drug_parameter_revisions"
WHERE "parameter" IN (
  'ki',
  'ic50',
  'ec50',
  'emax',
  'selectivityRatio',
  'effectThreshold',
  'toxicEffectThreshold'
);
--> statement-breakpoint

DELETE FROM "pending_edits"
WHERE "edit_type" = 'parameter'
  AND "parameter" IN (
    'ki',
    'ic50',
    'ec50',
    'emax',
    'selectivityRatio',
    'effectThreshold',
    'toxicEffectThreshold'
  );
--> statement-breakpoint

-- Clear any agent priority flags raised against the retired drug-level params.
DELETE FROM "parameter_priority_flags"
WHERE "parameter" IN (
  'ki',
  'ic50',
  'ec50',
  'emax',
  'selectivityRatio',
  'effectThreshold',
  'toxicEffectThreshold'
);
--> statement-breakpoint

-- Drop drug-scoped discussion threads anchored on the retired params (topic
-- fact discussions, which reuse this column with wiki_page_id set, are left
-- untouched).
DELETE FROM "drug_parameter_discussions"
WHERE "drug_id" IS NOT NULL
  AND "parameter" IN (
    'ki',
    'ic50',
    'ec50',
    'emax',
    'selectivityRatio',
    'effectThreshold',
    'toxicEffectThreshold'
  );
