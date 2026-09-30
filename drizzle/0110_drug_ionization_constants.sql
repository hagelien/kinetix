-- Structured ionization constants (structured-ionization-constants issue).
--
-- Replaces the single scalar `pKa` drug parameter for molecules with more than
-- one ionizable group. Each row is one acid-dissociation equilibrium keyed by
-- the net-charge transition it represents (protonated_charge → deprotonated_charge,
-- adjacent integers differing by one). Distinct transitions are distinct rows
-- and are never pooled; multiple measurements of the same transition aggregate
-- into one row's pKa with their sources in reference_ids.
--
-- Migration is conservative: the generic `pKa` drug_parameters value is kept in
-- parallel and NOT auto-converted, because the stored number does not record
-- whether it is acidic or basic.

CREATE TABLE "drug_ionization_constants" (
  "id" SERIAL PRIMARY KEY,
  "drug_id" INTEGER NOT NULL REFERENCES "drugs"("id") ON DELETE CASCADE,
  "pka" NUMERIC(6, 3) NOT NULL,
  "protonated_charge" INTEGER NOT NULL,
  "deprotonated_charge" INTEGER NOT NULL,
  "constant_type" VARCHAR(20) NOT NULL DEFAULT 'macroscopic',
  "evidence_type" VARCHAR(20) NOT NULL DEFAULT 'experimental',
  "site_label" VARCHAR(120),
  "temperature_c" NUMERIC(5, 2),
  "medium" VARCHAR(120),
  "reference_ids" INTEGER[],
  "note" TEXT,
  "origin" VARCHAR(20) NOT NULL DEFAULT 'curated',
  "created_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX "drug_ionization_constants_drug_idx"
  ON "drug_ionization_constants" ("drug_id");
--> statement-breakpoint

CREATE INDEX "drug_ionization_constants_transition_idx"
  ON "drug_ionization_constants" ("drug_id", "protonated_charge", "deprotonated_charge");
--> statement-breakpoint

-- One row per reconciliation identity, so two overlapping imports for the same
-- drug cannot each insert a row for the same measurement. NULL qualifiers are
-- folded via COALESCE (Postgres treats NULLs as distinct in a plain unique
-- index), and temperature is compared as its stored text so it matches the
-- NUMERIC(5,2) rounding the importer canonicalizes to.
CREATE UNIQUE INDEX "drug_ionization_constants_identity_uidx"
  ON "drug_ionization_constants" (
    "drug_id",
    "protonated_charge",
    "deprotonated_charge",
    "constant_type",
    "evidence_type",
    lower(coalesce("site_label", '')),
    lower(coalesce("medium", '')),
    coalesce("temperature_c"::text, '')
  );
