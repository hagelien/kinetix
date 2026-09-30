CREATE TABLE "reference_concentrations" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "drug_id" INTEGER NOT NULL REFERENCES "drugs"("id") ON DELETE CASCADE,
  "low" NUMERIC(14, 6),
  "high" NUMERIC(14, 6),
  "unit" VARCHAR(20) NOT NULL,
  "matrix" VARCHAR(20) NOT NULL,
  "scenario" VARCHAR(30) NOT NULL,
  "n" INTEGER,
  "comments" TEXT,
  "citation_id" INTEGER REFERENCES "citations"("id") ON DELETE SET NULL,
  "created_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMP DEFAULT NOW() NOT NULL,
  "updated_at" TIMESTAMP DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ref_conc_drug_idx" ON "reference_concentrations" USING btree ("drug_id");
--> statement-breakpoint
CREATE INDEX "ref_conc_drug_matrix_scenario_idx" ON "reference_concentrations" USING btree ("drug_id", "matrix", "scenario");
