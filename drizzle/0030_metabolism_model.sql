CREATE TABLE "drug_metabolism_profiles" (
  "drug_id" INTEGER PRIMARY KEY NOT NULL REFERENCES "drugs"("id") ON DELETE CASCADE,
  "enzymes" JSONB DEFAULT '[]'::jsonb NOT NULL,
  "elimination_routes" JSONB DEFAULT '[]'::jsonb NOT NULL,
  "excreted_unchanged_fraction" NUMERIC(6, 4),
  "metabolized_fraction" NUMERIC(6, 4),
  "renal_unchanged_fraction" NUMERIC(6, 4),
  "fecal_biliary_fraction" NUMERIC(6, 4),
  "evidence_note" TEXT,
  "reference_ids" INTEGER[],
  "updated_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMP DEFAULT now() NOT NULL,
  "updated_at" TIMESTAMP DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drug_metabolites" (
  "id" SERIAL PRIMARY KEY,
  "parent_drug_id" INTEGER NOT NULL REFERENCES "drugs"("id") ON DELETE CASCADE,
  "metabolite_drug_id" INTEGER REFERENCES "drugs"("id") ON DELETE SET NULL,
  "metabolite_name" VARCHAR(300) NOT NULL,
  "conversion_fraction" NUMERIC(6, 4),
  "activity" VARCHAR(20) DEFAULT 'unknown' NOT NULL,
  "sort_order" INTEGER DEFAULT 0 NOT NULL,
  "evidence_note" TEXT,
  "reference_ids" INTEGER[],
  "created_at" TIMESTAMP DEFAULT now() NOT NULL,
  "updated_at" TIMESTAMP DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "drug_metabolites_parent_idx"
  ON "drug_metabolites" ("parent_drug_id");
--> statement-breakpoint
CREATE INDEX "drug_metabolites_metabolite_drug_idx"
  ON "drug_metabolites" ("metabolite_drug_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "drug_metabolites_parent_name_idx"
  ON "drug_metabolites" ("parent_drug_id", "metabolite_name");
