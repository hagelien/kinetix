-- The reported statistic on every numeric source value, not only Cmax.
--
-- A source value's central number used to have one slot outside Cmax: the
-- `median` column ("median preferred, mean fallback"). A source reporting
-- "0.54 (0.12) h, mean (SD)" was therefore stored as a median with
-- 0.42–0.66 as unlabelled bounds, and a reviewer correctly disputing the
-- statistic had nowhere to send the proposal back to. Migration 0127 already
-- added the columns that say what the number is — `central_value`,
-- `central_statistic`, `interval_kind` — but 0129 held them to Cmax together
-- with the rest of the dose context. They are not dose context: every
-- numeric parameter can be a mean, a median or a single subject.
--
-- This migration lets every parameter carry them, optionally, and mirrors the
-- application's rules for a stated statistic (src/lib/entryDoseContext.ts,
-- `validateReportedStatistic` in its 'optional' mode). No backfill: every
-- existing non-Cmax row holds NULL in all three columns and satisfies both
-- constraints as it stands; its bare `median` stays the unlabelled legacy
-- centre it always was.

-- 0129's "no dose context outside Cmax", minus the three statistic columns.
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

-- A stated statistic outside Cmax. A central value and its statistic come
-- together, and replace the legacy `median` rather than sitting beside it
-- (canonicalizeReportedStatistic folds a labelled median into central_value).
-- An interval kind names two bounds that are there, and a labelled centre
-- beside bounds names what they are ('unknown' if the source does not say).
-- A censored threshold
-- (qualifier) and a categorical model-structure value keep their own shapes
-- and carry no statistic. An SD or SEM is symmetric, to within one tick of
-- the numeric(14,6) scale, around the centre it disperses; every centre lies
-- within its bounds; a single subject is a cohort of one.
ALTER TABLE "parameter_entries"
  DROP CONSTRAINT IF EXISTS "parameter_entries_reported_statistic";
--> statement-breakpoint
ALTER TABLE "parameter_entries"
  ADD CONSTRAINT "parameter_entries_reported_statistic"
  CHECK (
    "parameter" = 'cmax'
    OR (
      ("central_value" IS NULL) = ("central_statistic" IS NULL)
      AND ("central_value" IS NULL OR "median" IS NULL)
      AND ("interval_kind" IS NULL
           OR ("low" IS NOT NULL AND "high" IS NOT NULL AND "median" IS NULL))
      AND ("central_value" IS NULL
           OR ("low" IS NULL AND "high" IS NULL)
           OR "interval_kind" IS NOT NULL)
      AND ("qualifier" IS NULL
           OR ("central_value" IS NULL AND "interval_kind" IS NULL))
      AND ("categorical_value" IS NULL
           OR ("central_value" IS NULL AND "interval_kind" IS NULL))
      AND ("interval_kind" IS NULL OR "interval_kind" NOT IN ('sd', 'sem')
           OR ("central_value" IS NOT NULL
               AND abs(("high" - "central_value") - ("central_value" - "low")) <= 0.000001))
      AND ("central_value" IS NULL OR "low" IS NULL OR "central_value" >= "low")
      AND ("central_value" IS NULL OR "high" IS NULL OR "central_value" <= "high")
      AND ("central_statistic" IS DISTINCT FROM 'single_subject' OR "n" IS NULL OR "n" = 1)
    )
  );
