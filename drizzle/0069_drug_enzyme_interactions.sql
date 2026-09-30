-- Drug↔enzyme interactions (#785, Phase 6 follow-up). The DDI-perpetrator
-- relationship that the existing tables can't express: a drug that
-- induces/inhibits (or is a substrate of) a metabolic enzyme, pointing at the
-- canonical enzyme in the unified bio_entities registry.

CREATE TABLE "drug_enzyme_interactions" (
  "id" SERIAL PRIMARY KEY,
  "drug_id" INTEGER NOT NULL REFERENCES "drugs"("id") ON DELETE CASCADE,
  "bio_entity_id" INTEGER NOT NULL REFERENCES "bio_entities"("id") ON DELETE CASCADE,
  "role" VARCHAR(20) NOT NULL,
  "strength" VARCHAR(20),
  "note" TEXT,
  "reference_ids" INTEGER[],
  "sort_order" INTEGER DEFAULT 0 NOT NULL,
  "created_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMP DEFAULT now() NOT NULL,
  "updated_at" TIMESTAMP DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "drug_enzyme_interactions_drug_idx"
  ON "drug_enzyme_interactions" ("drug_id");
--> statement-breakpoint
CREATE INDEX "drug_enzyme_interactions_entity_idx"
  ON "drug_enzyme_interactions" ("bio_entity_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "drug_enzyme_interactions_unique_idx"
  ON "drug_enzyme_interactions" ("drug_id", "bio_entity_id", "role");
