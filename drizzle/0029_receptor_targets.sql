-- Receptor target data model (#432).
--
-- Targets are canonical biological entities (including subtypes/variants).
-- Drug-specific pharmacodynamic measurements live on the junction table.

CREATE TABLE "receptor_targets" (
  "id" SERIAL PRIMARY KEY,
  "slug" VARCHAR(120) NOT NULL UNIQUE,
  "symbol" VARCHAR(80) NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "name_en" VARCHAR(200),
  "target_class" VARCHAR(60),
  "organism" VARCHAR(80) NOT NULL DEFAULT 'Homo sapiens',
  "external_ids" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMP NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX "receptor_targets_symbol_idx"
  ON "receptor_targets" ("symbol");
--> statement-breakpoint

CREATE INDEX "receptor_targets_target_class_idx"
  ON "receptor_targets" ("target_class");
--> statement-breakpoint

CREATE TABLE "drug_receptor_targets" (
  "id" SERIAL PRIMARY KEY,
  "drug_id" INTEGER NOT NULL REFERENCES "drugs"("id") ON DELETE CASCADE,
  "receptor_target_id" INTEGER NOT NULL REFERENCES "receptor_targets"("id") ON DELETE CASCADE,
  "interaction_type" VARCHAR(60) NOT NULL DEFAULT 'unspecified',
  "affinity" JSONB,
  "potency" JSONB,
  "efficacy" JSONB,
  "ki" JSONB,
  "ic50" JSONB,
  "ec50" JSONB,
  "emax" JSONB,
  "selectivity_ratio" JSONB,
  "reference_ids" INTEGER[],
  "evidence_note" TEXT,
  "created_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX "drug_receptor_targets_drug_idx"
  ON "drug_receptor_targets" ("drug_id");
--> statement-breakpoint

CREATE INDEX "drug_receptor_targets_target_idx"
  ON "drug_receptor_targets" ("receptor_target_id");
--> statement-breakpoint

CREATE INDEX "drug_receptor_targets_interaction_idx"
  ON "drug_receptor_targets" ("interaction_type");
--> statement-breakpoint

CREATE UNIQUE INDEX "drug_receptor_targets_unique_idx"
  ON "drug_receptor_targets" ("drug_id", "receptor_target_id", "interaction_type");
