-- Cmax release D (#1342): the constraints that REQUIRE what release B added
-- and release C writes.
--
-- docs/plans/2026-09-17-cmax-dose-context.md, *Migration strategy*: code that
-- handles a column's values ships first (B), code that creates them second
-- (C), and the requirement last — here, once every instance runs C's writers,
-- so no running deployment can issue an insert these CHECKs refuse. No
-- backfill of any kind: every legacy row holds NULL in every dose-context
-- column and satisfies every constraint below as it stands.
--
-- The API's zod validation (src/lib/entryDoseContext.ts) stays the richer
-- error surface; these mirror its rules at the database, so a
-- direct writer (a script, a manual INSERT) cannot store a row the application
-- would refuse. The vocabulary lists are asserted equal to the TypeScript ones
-- by tests/drizzle-dose-context-checks.test.ts.

-- A dose-context parameter's reading names the substance dosed — its own drug
-- for a self-administered observation — and says what its number is.
ALTER TABLE "parameter_entries"
  DROP CONSTRAINT IF EXISTS "parameter_entries_dose_context_required";
--> statement-breakpoint
ALTER TABLE "parameter_entries"
  ADD CONSTRAINT "parameter_entries_dose_context_required"
  CHECK (
    "parameter" <> 'cmax'
    OR ("administered_drug_id" IS NOT NULL AND "value_basis" IS NOT NULL)
  );
--> statement-breakpoint

-- Every other parameter carries no dose context at all (registry
-- `doseContext: 'forbidden'`).
ALTER TABLE "parameter_entries"
  DROP CONSTRAINT IF EXISTS "parameter_entries_dose_context_forbidden";
--> statement-breakpoint
ALTER TABLE "parameter_entries"
  ADD CONSTRAINT "parameter_entries_dose_context_forbidden"
  CHECK (
    "parameter" = 'cmax'
    OR (
      "central_value" IS NULL AND "central_statistic" IS NULL AND "interval_kind" IS NULL
      AND "dose_value" IS NULL AND "dose_low" IS NULL AND "dose_high" IS NULL
      AND "dose_unit" IS NULL AND "dose_basis" IS NULL AND "dose_salt_form" IS NULL
      AND "dose_regimen" IS NULL AND "dose_interval_hours" IS NULL AND "dose_number" IS NULL
      AND "regimen_duration_hours" IS NULL AND "prior_dosing_regular" IS NULL
      AND "iv_input_mode" IS NULL AND "administration_duration_min" IS NULL
      AND "release_profile" IS NULL AND "physical_form" IS NULL AND "prandial_state" IS NULL
      AND "administered_drug_id" IS NULL AND "coadministration_state" IS NULL
      AND "interacting_drug_id" IS NULL AND "pk_population" IS NULL
      AND "population_qualifier" IS NULL AND "value_basis" IS NULL
    )
  );
--> statement-breakpoint

-- The dose has exactly one shape: an exact value, a two-sided non-degenerate
-- range, or none — never both, never half a range, never a zero-width range
-- (that is an exact dose), and never a non-positive dose. A dose number needs
-- its unit.
ALTER TABLE "parameter_entries"
  DROP CONSTRAINT IF EXISTS "parameter_entries_dose_shape";
--> statement-breakpoint
ALTER TABLE "parameter_entries"
  ADD CONSTRAINT "parameter_entries_dose_shape"
  CHECK (
    NOT ("dose_value" IS NOT NULL AND ("dose_low" IS NOT NULL OR "dose_high" IS NOT NULL))
    AND (("dose_low" IS NULL) = ("dose_high" IS NULL))
    AND ("dose_low" IS NULL OR "dose_low" < "dose_high")
    AND ("dose_value" IS NULL OR "dose_value" > 0)
    AND ("dose_low" IS NULL OR "dose_low" > 0)
    AND (("dose_value" IS NULL AND "dose_low" IS NULL) OR "dose_unit" IS NOT NULL)
  );
--> statement-breakpoint

-- Fields meaningful only beside another: a salt form with a salt basis, an
-- interacting drug with an interaction arm, an infusion time with an infusion
-- (and an infusion always with one), a positive dosing interval.
ALTER TABLE "parameter_entries"
  DROP CONSTRAINT IF EXISTS "parameter_entries_dose_context_dependencies";
--> statement-breakpoint
ALTER TABLE "parameter_entries"
  ADD CONSTRAINT "parameter_entries_dose_context_dependencies"
  -- IS NOT DISTINCT FROM, never `=`: a CHECK passes when its expression is
  -- NULL, so `"dose_basis" = 'salt'` would admit a salt form beside a MISSING
  -- basis — the exact row this constraint exists to refuse.
  CHECK (
    ("dose_salt_form" IS NULL OR "dose_basis" IS NOT DISTINCT FROM 'salt')
    AND ("interacting_drug_id" IS NULL
         OR "coadministration_state" IS NOT DISTINCT FROM 'with_interacting_drug')
    AND ("administration_duration_min" IS NULL
         OR "iv_input_mode" IS NOT DISTINCT FROM 'infusion')
    AND ("iv_input_mode" IS DISTINCT FROM 'infusion'
         OR ("administration_duration_min" IS NOT NULL AND "administration_duration_min" > 0))
    AND ("dose_interval_hours" IS NULL OR "dose_interval_hours" > 0)
    AND ("dose_number" IS NULL OR "dose_number" >= 1)
    AND ("regimen_duration_hours" IS NULL OR "regimen_duration_hours" >= 0)
    -- The regimen's shape: a single dose has no interval; a dose count and a
    -- regimen duration belong to a multiple-dose regimen; regular prior
    -- dosing to a multiple or steady-state one.
    AND ("dose_interval_hours" IS NULL OR "dose_regimen" IS DISTINCT FROM 'single')
    AND ("dose_number" IS NULL OR "dose_regimen" IS NOT DISTINCT FROM 'multiple')
    AND ("regimen_duration_hours" IS NULL OR "dose_regimen" IS NOT DISTINCT FROM 'multiple')
    AND ("prior_dosing_regular" IS NULL
         OR "dose_regimen" IS NOT DISTINCT FROM 'multiple'
         OR "dose_regimen" IS NOT DISTINCT FROM 'steady_state')
    -- IV input metadata describes intravenous administration only.
    AND ("iv_input_mode" IS NULL OR "route" IS NULL OR "route" = 'iv')
    -- A population qualifier qualifies a stated, non-healthy-adult population.
    AND ("population_qualifier" IS NULL
         OR ("pk_population" IS NOT NULL AND "pk_population" <> 'healthy_adult'))
  );
--> statement-breakpoint

-- For a dose-context parameter the bounds and what they are come together:
-- bounds with no interval kind, or an interval kind with no bounds, is not a
-- reading. A censored threshold (qualifier) carries neither.
ALTER TABLE "parameter_entries"
  DROP CONSTRAINT IF EXISTS "parameter_entries_dose_context_interval";
--> statement-breakpoint
ALTER TABLE "parameter_entries"
  ADD CONSTRAINT "parameter_entries_dose_context_interval"
  CHECK (
    "parameter" <> 'cmax'
    OR (("low" IS NULL) = ("high" IS NULL)
        AND (("low" IS NULL) = ("interval_kind" IS NULL)))
  );
--> statement-breakpoint

-- A dose-context parameter's reading is a reported value: a central value, an
-- interval, or both. A central value says what statistic it is, unless it is a
-- censored threshold (qualifier), which takes no statistic, no interval and no
-- median. An SD or SEM is a dispersion around a central value, symmetric to
-- within one tick of the numeric(14,6) scale; every central value lies within
-- its bounds; a single subject is a cohort of one.
ALTER TABLE "parameter_entries"
  DROP CONSTRAINT IF EXISTS "parameter_entries_dose_context_reported_value";
--> statement-breakpoint
ALTER TABLE "parameter_entries"
  ADD CONSTRAINT "parameter_entries_dose_context_reported_value"
  CHECK (
    "parameter" <> 'cmax'
    OR (
      ("central_value" IS NOT NULL OR "low" IS NOT NULL)
      AND ("central_value" IS NULL OR "qualifier" IS NOT NULL OR "central_statistic" IS NOT NULL)
      AND ("central_statistic" IS NULL OR "central_value" IS NOT NULL)
      AND ("qualifier" IS NULL
           OR ("central_value" IS NOT NULL AND "central_statistic" IS NULL
               AND "interval_kind" IS NULL AND "median" IS NULL
               AND "low" IS NULL AND "high" IS NULL))
      AND ("interval_kind" IS NULL OR "interval_kind" NOT IN ('sd', 'sem')
           OR ("central_value" IS NOT NULL
               AND abs(("high" - "central_value") - ("central_value" - "low")) <= 0.000001))
      -- The median shorthand is always folded into central_value with
      -- central_statistic 'median' before a Cmax row is stored
      -- (canonicalizeReportedStatistic), so a stored median is a second,
      -- contradicting statement of the same reading.
      AND "median" IS NULL
      AND ("low" IS NULL OR "high" IS NULL OR "low" <= "high")
      AND ("central_value" IS NULL OR "low" IS NULL OR "central_value" >= "low")
      AND ("central_value" IS NULL OR "high" IS NULL OR "central_value" <= "high")
      AND ("central_statistic" IS DISTINCT FROM 'single_subject' OR "n" IS NULL OR "n" = 1)
    )
  );
--> statement-breakpoint

-- What the number is decides its unit and whether it needs a dose. A
-- concentration carries a concentration unit and the dose it followed (a raw
-- concentration means nothing without it). A dose-normalized ratio carries a
-- concentration-per-dose unit, and a stated dose unit is in the same family
-- (absolute or per-kg) as the ratio's denominator. Both unit lists equal the
-- TypeScript constants (asserted by a test).
ALTER TABLE "parameter_entries"
  DROP CONSTRAINT IF EXISTS "parameter_entries_dose_context_value_basis";
--> statement-breakpoint
ALTER TABLE "parameter_entries"
  ADD CONSTRAINT "parameter_entries_dose_context_value_basis"
  CHECK (
    ("value_basis" IS DISTINCT FROM 'concentration'
     OR ("unit" IN ('mg/L', 'µg/mL', 'ng/mL', 'µg/L', 'ng/L', 'mg/dL', 'mmol/L', 'µmol/L', 'nmol/L')
         AND ("dose_value" IS NOT NULL OR "dose_low" IS NOT NULL)))
    AND ("value_basis" IS DISTINCT FROM 'dose_normalized'
     OR ("unit" IN (
       'mg/L/µg', 'mg/L/mg', 'mg/L/g', 'mg/L/(µg/kg)', 'mg/L/(mg/kg)',
       'µg/mL/µg', 'µg/mL/mg', 'µg/mL/g', 'µg/mL/(µg/kg)', 'µg/mL/(mg/kg)',
       'ng/mL/µg', 'ng/mL/mg', 'ng/mL/g', 'ng/mL/(µg/kg)', 'ng/mL/(mg/kg)',
       'µg/L/µg', 'µg/L/mg', 'µg/L/g', 'µg/L/(µg/kg)', 'µg/L/(mg/kg)',
       'ng/L/µg', 'ng/L/mg', 'ng/L/g', 'ng/L/(µg/kg)', 'ng/L/(mg/kg)',
       'mg/dL/µg', 'mg/dL/mg', 'mg/dL/g', 'mg/dL/(µg/kg)', 'mg/dL/(mg/kg)',
       'mmol/L/µg', 'mmol/L/mg', 'mmol/L/g', 'mmol/L/(µg/kg)', 'mmol/L/(mg/kg)',
       'µmol/L/µg', 'µmol/L/mg', 'µmol/L/g', 'µmol/L/(µg/kg)', 'µmol/L/(mg/kg)',
       'nmol/L/µg', 'nmol/L/mg', 'nmol/L/g', 'nmol/L/(µg/kg)', 'nmol/L/(mg/kg)'
         )
         AND ("dose_unit" IS NULL
              OR ("unit" LIKE '%/kg)') = ("dose_unit" LIKE '%/kg'))))
  );
--> statement-breakpoint

-- NUMERIC admits 'NaN', and NaN sorts ABOVE every finite value, so a `> 0`
-- rule alone passes it (the trap migration 0106 closed for the regimen
-- tables). The application refuses non-finite numbers; so does the database,
-- for every dose-context numeric column and a Cmax row's bounds. (These
-- columns carry a precision, which already refuses the infinities; they are
-- listed anyway so the rule does not depend on the typmod.)
ALTER TABLE "parameter_entries"
  DROP CONSTRAINT IF EXISTS "parameter_entries_dose_context_finite";
--> statement-breakpoint
ALTER TABLE "parameter_entries"
  ADD CONSTRAINT "parameter_entries_dose_context_finite"
  CHECK (
    ("central_value" IS NULL OR "central_value" NOT IN ('NaN', 'Infinity', '-Infinity'))
    AND ("dose_value" IS NULL OR "dose_value" NOT IN ('NaN', 'Infinity', '-Infinity'))
    AND ("dose_low" IS NULL OR "dose_low" NOT IN ('NaN', 'Infinity', '-Infinity'))
    AND ("dose_high" IS NULL OR "dose_high" NOT IN ('NaN', 'Infinity', '-Infinity'))
    AND ("dose_interval_hours" IS NULL OR "dose_interval_hours" NOT IN ('NaN', 'Infinity', '-Infinity'))
    AND ("regimen_duration_hours" IS NULL OR "regimen_duration_hours" NOT IN ('NaN', 'Infinity', '-Infinity'))
    AND ("administration_duration_min" IS NULL OR "administration_duration_min" NOT IN ('NaN', 'Infinity', '-Infinity'))
    AND ("parameter" <> 'cmax'
         OR (("low" IS NULL OR "low" NOT IN ('NaN', 'Infinity', '-Infinity'))
             AND ("high" IS NULL OR "high" NOT IN ('NaN', 'Infinity', '-Infinity'))))
  );
--> statement-breakpoint

-- The closed vocabularies. Each list equals the TypeScript constant of the same
-- name in src/lib/entryDoseContext.ts (asserted by a test).
ALTER TABLE "parameter_entries"
  DROP CONSTRAINT IF EXISTS "parameter_entries_dose_context_vocabulary";
--> statement-breakpoint
ALTER TABLE "parameter_entries"
  ADD CONSTRAINT "parameter_entries_dose_context_vocabulary"
  CHECK (
    ("central_statistic" IS NULL OR "central_statistic" IN ('arithmetic_mean', 'geometric_mean', 'median', 'single_subject', 'unknown'))
    AND ("interval_kind" IS NULL OR "interval_kind" IN ('sd', 'sem', 'ci95', 'iqr', 'range', 'unknown'))
    AND ("dose_unit" IS NULL OR "dose_unit" IN ('µg', 'mg', 'g', 'µg/kg', 'mg/kg'))
    AND ("dose_basis" IS NULL OR "dose_basis" IN ('active-moiety', 'parent', 'salt', 'free-base'))
    AND ("dose_regimen" IS NULL OR "dose_regimen" IN ('single', 'multiple', 'steady_state', 'unknown'))
    AND ("iv_input_mode" IS NULL OR "iv_input_mode" IN ('bolus', 'infusion', 'unknown'))
    AND ("release_profile" IS NULL OR "release_profile" IN ('immediate', 'modified', 'not_applicable', 'unknown'))
    AND ("physical_form" IS NULL OR "physical_form" IN ('tablet_capsule', 'solution', 'suspension', 'other', 'unknown'))
    AND ("prandial_state" IS NULL OR "prandial_state" IN ('fasted', 'fed', 'unspecified'))
    AND ("coadministration_state" IS NULL OR "coadministration_state" IN ('monotherapy', 'with_interacting_drug', 'unknown'))
    AND ("pk_population" IS NULL OR "pk_population" IN ('healthy_adult', 'patients_unspecified', 'hepatic_impairment', 'renal_impairment', 'metabolizer_phenotype', 'paediatric', 'elderly', 'pregnancy', 'other', 'unknown'))
    AND ("value_basis" IS NULL OR "value_basis" IN ('concentration', 'dose_normalized'))
  );
