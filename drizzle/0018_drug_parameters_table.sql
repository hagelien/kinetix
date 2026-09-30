-- #302 P2: introduce a generic drug_parameters row table to replace the
-- per-column storage on `drugs` for halfLife, volumeOfDistribution,
-- bioavailability, proteinBinding, bloodPlasmaRatio, tmax, pKa, and
-- molecularWeight. Each row holds the parameter-kind-shaped payload as
-- jsonb (NumericRange for the range/scalar/fraction/ratio kinds, a JSON
-- number for molecularWeight). The `cmax` (peak_concentration) column
-- is intentionally not migrated — it was retired in #255 and is kept on
-- `drugs` only to prevent destructive schema-diff drift.
--
-- This migration is one-shot: it creates the table, backfills every
-- existing value, then drops the source columns. Code in this PR
-- reads/writes drug_parameters exclusively for the migrated parameters
-- via the api/_lib/drugParameterStore helper; the API serializer
-- preserves the legacy `drug.<param>` response shape so consumers
-- (sidebar, drug table, simulator, …) need no changes.

CREATE TABLE "drug_parameters" (
  "drug_id" INTEGER NOT NULL REFERENCES "drugs"("id") ON DELETE CASCADE,
  "parameter" VARCHAR(60) NOT NULL,
  "value" JSONB NOT NULL,
  "updated_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("drug_id", "parameter")
);
--> statement-breakpoint

CREATE INDEX "drug_parameters_param_idx" ON "drug_parameters" USING btree ("parameter");
--> statement-breakpoint

-- Backfill the seven jsonb-shaped range parameters. The source columns
-- already contain NumericRange-shaped jsonb so the value is copied as-is.
INSERT INTO "drug_parameters" ("drug_id", "parameter", "value")
SELECT id, 'halfLife', "half_life" FROM "drugs" WHERE "half_life" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "drug_parameters" ("drug_id", "parameter", "value")
SELECT id, 'volumeOfDistribution', "volume_of_distribution" FROM "drugs" WHERE "volume_of_distribution" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "drug_parameters" ("drug_id", "parameter", "value")
SELECT id, 'bioavailability', "bioavailability" FROM "drugs" WHERE "bioavailability" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "drug_parameters" ("drug_id", "parameter", "value")
SELECT id, 'proteinBinding', "protein_binding" FROM "drugs" WHERE "protein_binding" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "drug_parameters" ("drug_id", "parameter", "value")
SELECT id, 'bloodPlasmaRatio', "blood_plasma_ratio" FROM "drugs" WHERE "blood_plasma_ratio" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "drug_parameters" ("drug_id", "parameter", "value")
SELECT id, 'tmax', "tmax" FROM "drugs" WHERE "tmax" IS NOT NULL;
--> statement-breakpoint
INSERT INTO "drug_parameters" ("drug_id", "parameter", "value")
SELECT id, 'pKa', "pka" FROM "drugs" WHERE "pka" IS NOT NULL;
--> statement-breakpoint

-- molecularWeight is numeric(10,4) → wrap as a JSON number (to_jsonb on
-- a numeric value yields the canonical JSON number representation).
INSERT INTO "drug_parameters" ("drug_id", "parameter", "value")
SELECT id, 'molecularWeight', to_jsonb("molecular_weight"::numeric)
FROM "drugs" WHERE "molecular_weight" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "drugs" DROP COLUMN "half_life";
--> statement-breakpoint
ALTER TABLE "drugs" DROP COLUMN "volume_of_distribution";
--> statement-breakpoint
ALTER TABLE "drugs" DROP COLUMN "bioavailability";
--> statement-breakpoint
ALTER TABLE "drugs" DROP COLUMN "protein_binding";
--> statement-breakpoint
ALTER TABLE "drugs" DROP COLUMN "blood_plasma_ratio";
--> statement-breakpoint
ALTER TABLE "drugs" DROP COLUMN "tmax";
--> statement-breakpoint
ALTER TABLE "drugs" DROP COLUMN "pka";
--> statement-breakpoint
ALTER TABLE "drugs" DROP COLUMN "molecular_weight";
