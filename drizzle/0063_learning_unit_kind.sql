-- Kinetix Learn Phase D: clinical cases reuse the learning_units table.
-- A new `kind` discriminator distinguishes a source-anchored learning unit
-- ('unit', the default) from a §5.4 clinical case ('clinical_case'). Storing
-- cases here means the Phase C attempts/competence/spaced-review/My Path engine
-- (all FK learning_units.id) covers cases with no further schema changes.
-- Additive and backward-compatible: every existing row defaults to 'unit'.
ALTER TABLE "learning_units" ADD COLUMN IF NOT EXISTS "kind" VARCHAR(20) NOT NULL DEFAULT 'unit';
