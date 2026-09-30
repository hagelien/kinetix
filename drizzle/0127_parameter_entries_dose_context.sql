-- Cmax release B (#1340): the dose-context and reported-statistic columns on
-- parameter_entries, nullable, with no requirement and no backfill.
--
-- See docs/plans/2026-09-17-cmax-dose-context.md, *Migration strategy*. This
-- is the second of four releases. Release A (#1339) made the drug-delete
-- teardown remove a drug's own entries explicitly instead of relying on the
-- drug_id cascade; it is deployed everywhere, so the ON DELETE RESTRICT keys
-- added here never meet a teardown that expects the cascade to clear them.
--
-- Every column is nullable and nothing writes one yet: the writers arrive in
-- release C, the CHECK constraints that require them in release D. An insert
-- from the previous deployment, which names none of these columns, stays
-- valid against this schema, and so does every row already stored.
--
-- No backfill, deliberately. Setting administered_drug_id = drug_id on legacy
-- rows would assert that each analyte was the substance administered, which
-- is false for evidence this table already holds (a metabolite's tmax is
-- measured after the parent is dosed). Null keeps its honest meaning: not
-- recorded.
--
-- The two drug references carry their foreign keys from the start. A nullable
-- FK constrains only rows that have a value, so it costs the previous
-- deployment nothing; and deferring it would open a window in which a
-- reference could be orphaned, after which creating the FK would fail on data
-- the rollout itself produced. ON DELETE RESTRICT because administration
-- identity is provenance: evidence must never be silently detached from the
-- substance that produced it.
ALTER TABLE "parameter_entries"
  ADD COLUMN IF NOT EXISTS "central_value" numeric(14, 6),
  ADD COLUMN IF NOT EXISTS "central_statistic" varchar(24),
  ADD COLUMN IF NOT EXISTS "interval_kind" varchar(24),
  ADD COLUMN IF NOT EXISTS "dose_value" numeric(14, 6),
  ADD COLUMN IF NOT EXISTS "dose_low" numeric(14, 6),
  ADD COLUMN IF NOT EXISTS "dose_high" numeric(14, 6),
  ADD COLUMN IF NOT EXISTS "dose_unit" varchar(20),
  ADD COLUMN IF NOT EXISTS "dose_basis" varchar(20),
  ADD COLUMN IF NOT EXISTS "dose_salt_form" varchar(60),
  ADD COLUMN IF NOT EXISTS "dose_regimen" varchar(20),
  ADD COLUMN IF NOT EXISTS "dose_interval_hours" numeric(10, 4),
  ADD COLUMN IF NOT EXISTS "dose_number" integer,
  ADD COLUMN IF NOT EXISTS "regimen_duration_hours" numeric(10, 4),
  ADD COLUMN IF NOT EXISTS "prior_dosing_regular" boolean,
  ADD COLUMN IF NOT EXISTS "iv_input_mode" varchar(16),
  ADD COLUMN IF NOT EXISTS "administration_duration_min" numeric(10, 4),
  ADD COLUMN IF NOT EXISTS "release_profile" varchar(20),
  ADD COLUMN IF NOT EXISTS "physical_form" varchar(20),
  ADD COLUMN IF NOT EXISTS "prandial_state" varchar(16),
  ADD COLUMN IF NOT EXISTS "administered_drug_id" integer
    CONSTRAINT "parameter_entries_administered_drug_id_drugs_id_fk"
    REFERENCES "drugs"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "coadministration_state" varchar(24),
  ADD COLUMN IF NOT EXISTS "interacting_drug_id" integer
    CONSTRAINT "parameter_entries_interacting_drug_id_drugs_id_fk"
    REFERENCES "drugs"("id") ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS "pk_population" varchar(32),
  ADD COLUMN IF NOT EXISTS "population_qualifier" varchar(80),
  ADD COLUMN IF NOT EXISTS "value_basis" varchar(24);
--> statement-breakpoint

-- A RESTRICT key is checked on every delete of a drugs row, and a drug merge
-- repoints both columns by value. Without an index each of those is a full
-- scan of parameter_entries. Partial, because only dose-context entries will
-- ever carry a value and every legacy row keeps null.
CREATE INDEX IF NOT EXISTS "parameter_entries_administered_drug_idx"
  ON "parameter_entries" ("administered_drug_id")
  WHERE "administered_drug_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "parameter_entries_interacting_drug_idx"
  ON "parameter_entries" ("interacting_drug_id")
  WHERE "interacting_drug_id" IS NOT NULL;
