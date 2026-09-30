-- Numeric drug parameters: split the standalone `value` field of a
-- NumericRange into `mean` + `median`. The legacy single value is a central
-- figure, so it migrates into `median` (mean is left unset for editors to
-- fill in later). After this, application code reads `median` (preferred)
-- then `mean`, and no longer reads `value`.
--
-- This rewrites the inner `value` jsonb key in every place a NumericRange is
-- persisted: the live drug_parameters table, the per-parameter edit history
-- (drug_parameter_revisions.old_value / new_value), and any in-flight
-- parameter edits awaiting review (pending_edits.proposed_value). Each guard
-- requires an object carrying a `value` key, so JSON numbers (molecularWeight,
-- pubchemCid), strings (text params), and arrays (aliases) are untouched.

-- ── drug_parameters (live values) ───────────────────────────────────────────
UPDATE "drug_parameters"
SET "value" = ("value" - 'value') || jsonb_build_object('median', "value"->'value')
WHERE jsonb_typeof("value") = 'object'
  AND "value" ? 'value'
  AND NOT ("value" ? 'median');
--> statement-breakpoint
UPDATE "drug_parameters"
SET "value" = "value" - 'value'
WHERE jsonb_typeof("value") = 'object'
  AND "value" ? 'value';
--> statement-breakpoint

-- ── drug_parameter_revisions (edit history) ─────────────────────────────────
UPDATE "drug_parameter_revisions"
SET "old_value" = ("old_value" - 'value') || jsonb_build_object('median', "old_value"->'value')
WHERE jsonb_typeof("old_value") = 'object'
  AND "old_value" ? 'value'
  AND NOT ("old_value" ? 'median');
--> statement-breakpoint
UPDATE "drug_parameter_revisions"
SET "old_value" = "old_value" - 'value'
WHERE jsonb_typeof("old_value") = 'object'
  AND "old_value" ? 'value';
--> statement-breakpoint
UPDATE "drug_parameter_revisions"
SET "new_value" = ("new_value" - 'value') || jsonb_build_object('median', "new_value"->'value')
WHERE jsonb_typeof("new_value") = 'object'
  AND "new_value" ? 'value'
  AND NOT ("new_value" ? 'median');
--> statement-breakpoint
UPDATE "drug_parameter_revisions"
SET "new_value" = "new_value" - 'value'
WHERE jsonb_typeof("new_value") = 'object'
  AND "new_value" ? 'value';
--> statement-breakpoint

-- ── pending_edits (in-flight parameter edits) ───────────────────────────────
UPDATE "pending_edits"
SET "proposed_value" = ("proposed_value" - 'value') || jsonb_build_object('median', "proposed_value"->'value')
WHERE "edit_type" = 'parameter'
  AND jsonb_typeof("proposed_value") = 'object'
  AND "proposed_value" ? 'value'
  AND NOT ("proposed_value" ? 'median');
--> statement-breakpoint
UPDATE "pending_edits"
SET "proposed_value" = "proposed_value" - 'value'
WHERE "edit_type" = 'parameter'
  AND jsonb_typeof("proposed_value") = 'object'
  AND "proposed_value" ? 'value';
--> statement-breakpoint

-- ── drug_receptor_targets (pharmacodynamic measurement columns) ──────────────
-- Each of these eight jsonb columns is a NumericRange (binding/potency/
-- efficacy metrics). Same value→median split as everywhere else.
UPDATE "drug_receptor_targets"
SET "affinity" = ("affinity" - 'value') || jsonb_build_object('median', "affinity"->'value')
WHERE jsonb_typeof("affinity") = 'object' AND "affinity" ? 'value' AND NOT ("affinity" ? 'median');
--> statement-breakpoint
UPDATE "drug_receptor_targets" SET "affinity" = "affinity" - 'value'
WHERE jsonb_typeof("affinity") = 'object' AND "affinity" ? 'value';
--> statement-breakpoint
UPDATE "drug_receptor_targets"
SET "potency" = ("potency" - 'value') || jsonb_build_object('median', "potency"->'value')
WHERE jsonb_typeof("potency") = 'object' AND "potency" ? 'value' AND NOT ("potency" ? 'median');
--> statement-breakpoint
UPDATE "drug_receptor_targets" SET "potency" = "potency" - 'value'
WHERE jsonb_typeof("potency") = 'object' AND "potency" ? 'value';
--> statement-breakpoint
UPDATE "drug_receptor_targets"
SET "efficacy" = ("efficacy" - 'value') || jsonb_build_object('median', "efficacy"->'value')
WHERE jsonb_typeof("efficacy") = 'object' AND "efficacy" ? 'value' AND NOT ("efficacy" ? 'median');
--> statement-breakpoint
UPDATE "drug_receptor_targets" SET "efficacy" = "efficacy" - 'value'
WHERE jsonb_typeof("efficacy") = 'object' AND "efficacy" ? 'value';
--> statement-breakpoint
UPDATE "drug_receptor_targets"
SET "ki" = ("ki" - 'value') || jsonb_build_object('median', "ki"->'value')
WHERE jsonb_typeof("ki") = 'object' AND "ki" ? 'value' AND NOT ("ki" ? 'median');
--> statement-breakpoint
UPDATE "drug_receptor_targets" SET "ki" = "ki" - 'value'
WHERE jsonb_typeof("ki") = 'object' AND "ki" ? 'value';
--> statement-breakpoint
UPDATE "drug_receptor_targets"
SET "ic50" = ("ic50" - 'value') || jsonb_build_object('median', "ic50"->'value')
WHERE jsonb_typeof("ic50") = 'object' AND "ic50" ? 'value' AND NOT ("ic50" ? 'median');
--> statement-breakpoint
UPDATE "drug_receptor_targets" SET "ic50" = "ic50" - 'value'
WHERE jsonb_typeof("ic50") = 'object' AND "ic50" ? 'value';
--> statement-breakpoint
UPDATE "drug_receptor_targets"
SET "ec50" = ("ec50" - 'value') || jsonb_build_object('median', "ec50"->'value')
WHERE jsonb_typeof("ec50") = 'object' AND "ec50" ? 'value' AND NOT ("ec50" ? 'median');
--> statement-breakpoint
UPDATE "drug_receptor_targets" SET "ec50" = "ec50" - 'value'
WHERE jsonb_typeof("ec50") = 'object' AND "ec50" ? 'value';
--> statement-breakpoint
UPDATE "drug_receptor_targets"
SET "emax" = ("emax" - 'value') || jsonb_build_object('median', "emax"->'value')
WHERE jsonb_typeof("emax") = 'object' AND "emax" ? 'value' AND NOT ("emax" ? 'median');
--> statement-breakpoint
UPDATE "drug_receptor_targets" SET "emax" = "emax" - 'value'
WHERE jsonb_typeof("emax") = 'object' AND "emax" ? 'value';
--> statement-breakpoint
UPDATE "drug_receptor_targets"
SET "selectivity_ratio" = ("selectivity_ratio" - 'value') || jsonb_build_object('median', "selectivity_ratio"->'value')
WHERE jsonb_typeof("selectivity_ratio") = 'object' AND "selectivity_ratio" ? 'value' AND NOT ("selectivity_ratio" ? 'median');
--> statement-breakpoint
UPDATE "drug_receptor_targets" SET "selectivity_ratio" = "selectivity_ratio" - 'value'
WHERE jsonb_typeof("selectivity_ratio") = 'object' AND "selectivity_ratio" ? 'value';

-- Note: in-flight receptor_targets pending edits (pending_edits.proposed_value
-- with edit_type='receptor_targets') nest measurements inside a mechanisms[]
-- array and are intentionally not deep-rewritten here. They are full-replace
-- payloads re-validated by zod at approval time, which now accepts mean/median
-- and drops any stale `value` key — a harmless degradation for rare transient
-- rows. New submissions never carry `value` (the zod schema rejects it).
