-- Formulation, regimen and population scope on the absorption parameters (#12).
--
-- A parameter entry could scope by matrix, scenario and route, but not by
-- formulation or population, so an extended-release-only Tmax (OPANA ER) was
-- proposed as bare `oral` and would have stood as oxymorphone's general oral
-- Tmax, and a population claim lived in free-text comments no validator
-- reaches. The columns for both already exist (migration 0127) with closed
-- vocabularies (0129); 0129/0135's `parameter_entries_dose_context_forbidden`
-- held them to Cmax alone.
--
-- Owner decision on #12: reuse those columns rather than add new ones, opening
-- the formulation, regimen and population fields — `dose_regimen`,
-- `dose_interval_hours`, `release_profile`, `physical_form`, `pk_population`,
-- `population_qualifier` — to the absorption-related parameters `tmax`, `ka`,
-- `bioavailability` and `absorptionModel` (registry `doseContext: 'optional'`,
-- `OPTIONAL_DOSE_CONTEXT_FIELD_KEYS` in src/lib/entryDoseContext.ts). Every
-- other dose-context column stays Cmax's alone, on every other parameter all
-- of them do, and the reported statistic stays open to every parameter as 0135
-- left it. The rules those fields obey when set (a single dose has no
-- interval; a population qualifier qualifies a stated non-healthy-adult
-- population; the closed vocabularies) are 0129's dependency and vocabulary
-- CHECKs, which already hold on every row.
--
-- Only relaxes: no backfill, and every existing row satisfies the new CHECK as
-- it stands, because it satisfied the stricter one this replaces.
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
