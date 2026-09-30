-- Model-structure axes as categorical parameter entries (CV-1b).
--
-- A drug's PK MODEL SHAPE — its disposition (one- vs two-compartment), its
-- elimination kinetics (first-order / saturable / CL·V) and each route's input
-- (bolus / infusion / first- / zero- / mixed-order …) — is a scientific property
-- of the drug, cited like any other. It is the one thing the engine cannot infer
-- from the numbers, so it lives here beside them rather than being hand-authored
-- in code. The three axes are stored as ordinary `parameter_entries` rows under
-- the parameter ids `dispositionModel` / `eliminationModel` / `absorptionModel`,
-- so they inherit the same citation, provenance and review machinery.
--
-- The value is categorical, not numeric, so it needs its own column: `low`/
-- `high`/`median` cannot hold "one-compartment". `categorical_value` carries it;
-- a model-axis row sets it and holds NO numeric value, and every other parameter
-- leaves it NULL. The admissible words per axis are the kinetics-core vocabulary
-- (`DISPOSITION_KINDS` / `ELIMINATION_KINDS` / `ABSORPTION_KINDS`); the CHECK
-- below mirrors them, and `src/lib/modelStructureVocabulary.test.ts` holds the
-- two in step so an axis value can never be admissible in the engine and
-- inadmissible in the column, or vice versa.

ALTER TABLE "parameter_entries"
  ADD COLUMN IF NOT EXISTS "categorical_value" VARCHAR(40);
--> statement-breakpoint

-- The per-axis vocabulary, in one place. For a model-axis parameter the value
-- must be one of that axis's words; for every other parameter `categorical_value`
-- must be NULL (the column applies only to the model-structure axes). COALESCE to
-- FALSE because a CHECK that evaluates to NULL *passes*: `NULL IN (...)` is NULL,
-- so an axis row with a NULL value would otherwise slip through the gate written
-- to require one.
CREATE OR REPLACE FUNCTION "parameter_entries_categorical_value_ok"(
  p_parameter TEXT,
  p_value TEXT
) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(CASE p_parameter
    WHEN 'dispositionModel' THEN
      p_value IN ('one-compartment', 'two-compartment')
    WHEN 'eliminationModel' THEN
      p_value IN ('first-order', 'michaelis-menten', 'clv-structural')
    WHEN 'absorptionModel' THEN
      p_value IN ('bolus', 'iv-infusion', 'first-order', 'zero-order', 'mixed', 'transit')
    ELSE
      p_value IS NULL
  END, FALSE);
$$;
--> statement-breakpoint

ALTER TABLE "parameter_entries"
  DROP CONSTRAINT IF EXISTS "parameter_entries_categorical_vocabulary";
--> statement-breakpoint

ALTER TABLE "parameter_entries"
  ADD CONSTRAINT "parameter_entries_categorical_vocabulary"
  CHECK ("parameter_entries_categorical_value_ok"("parameter", "categorical_value"));
--> statement-breakpoint

-- A categorical value and a numeric value are mutually exclusive: a model-axis
-- row is not a measurement, so it carries no low/high/median/qualifier. The
-- numeric parameters keep `categorical_value` NULL (already enforced by the
-- vocabulary rule's ELSE branch), so this only has to constrain the categorical
-- rows.
ALTER TABLE "parameter_entries"
  DROP CONSTRAINT IF EXISTS "parameter_entries_categorical_excludes_numeric";
--> statement-breakpoint

ALTER TABLE "parameter_entries"
  ADD CONSTRAINT "parameter_entries_categorical_excludes_numeric"
  CHECK (
    "categorical_value" IS NULL
    OR (
      "low" IS NULL AND "high" IS NULL AND "median" IS NULL AND "qualifier" IS NULL
    )
  );
--> statement-breakpoint

-- A model shape is not a measurement, so it carries no observational DIMENSIONS
-- either: no unit (the column is NOT NULL, so the empty string is its "unset"),
-- no biological matrix, no interpretive scenario. `validateCategoricalEntry`
-- rejects all three on the write path; this mirrors that at the database so a
-- direct writer (a script, a manual `INSERT`) cannot persist a declaration the
-- application would consider invalid. Numeric rows keep `categorical_value` NULL
-- and pass the first branch untouched.
ALTER TABLE "parameter_entries"
  DROP CONSTRAINT IF EXISTS "parameter_entries_categorical_no_dimensions";
--> statement-breakpoint

ALTER TABLE "parameter_entries"
  ADD CONSTRAINT "parameter_entries_categorical_no_dimensions"
  CHECK (
    "categorical_value" IS NULL
    OR (
      "unit" = '' AND "matrix" IS NULL AND "scenario" IS NULL
    )
  );
