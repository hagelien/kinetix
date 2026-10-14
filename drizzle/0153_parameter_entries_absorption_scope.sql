-- Formulation and population on absorption readings (#12; decision of
-- 2026-10-07 on that issue, which #82 builds on).
--
-- An oral Tmax from an extended-release product and one from an immediate-
-- release tablet describe different absorption phases, and a sublingual Tmax
-- measured in healthy volunteers is not a postoperative one. Until now the
-- only place to say so was free-text `comments`, because 0129 (restated by
-- 0135) held every dose-context column to Cmax. The owner's decision is to
-- reuse those columns and their vocabularies rather than add new ones, for
-- the absorption parameters first:
--
--   tmax, ka, bioavailability, absorptionModel
--
-- may now carry, optionally:
--
--   release_profile, physical_form        — the formulation
--   dose_regimen, dose_interval_hours     — single dose vs a weekly/monthly depot
--   pk_population, population_qualifier   — who was studied
--
-- and nothing else of the dose context: no dose, salt, infusion, prandial
-- state, administered/interacting drug or value basis. Every other parameter
-- keeps 0135's rule unchanged. The registry mirrors this
-- (`doseContext: 'optional'`, src/lib/drugParameters.ts) and the application
-- validator is `validateDoseContext` in its 'optional' mode
-- (src/lib/entryDoseContext.ts, `ENTRY_SCOPE_FIELD_KEYS`); the column lists
-- below are asserted equal to it by tests/drizzle-dose-context-checks.test.ts.
--
-- The dependencies between these fields (an interval only on a non-single
-- regimen and only positive; a population qualifier only beside a stated,
-- non-healthy-adult population) are already enforced for every row by 0129's
-- `parameter_entries_dose_context_dependencies`, and their vocabularies by
-- `parameter_entries_dose_context_vocabulary`, so neither changes here.
--
-- Only relaxes: every stored row satisfied the previous, stricter form, so it
-- satisfies this one, and a deployment still running the previous code never
-- writes a row this refuses. No backfill.
ALTER TABLE "parameter_entries"
  DROP CONSTRAINT IF EXISTS "parameter_entries_dose_context_forbidden";
--> statement-breakpoint
ALTER TABLE "parameter_entries"
  ADD CONSTRAINT "parameter_entries_dose_context_forbidden"
  CHECK (
    "parameter" = 'cmax'
    OR (
      "dose_value" IS NULL AND "dose_low" IS NULL AND "dose_high" IS NULL
      AND "dose_unit" IS NULL AND "dose_basis" IS NULL AND "dose_salt_form" IS NULL
      AND "dose_number" IS NULL
      AND "regimen_duration_hours" IS NULL AND "prior_dosing_regular" IS NULL
      AND "iv_input_mode" IS NULL AND "administration_duration_min" IS NULL
      AND "prandial_state" IS NULL
      AND "administered_drug_id" IS NULL AND "coadministration_state" IS NULL
      AND "interacting_drug_id" IS NULL AND "value_basis" IS NULL
      AND (
        "parameter" IN ('bioavailability', 'tmax', 'ka', 'absorptionModel')
        OR (
          "dose_regimen" IS NULL AND "dose_interval_hours" IS NULL
          AND "release_profile" IS NULL AND "physical_form" IS NULL
          AND "pk_population" IS NULL AND "population_qualifier" IS NULL
        )
      )
    )
  );
