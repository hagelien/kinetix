CREATE TABLE "verification_log" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "target_type" VARCHAR(30) NOT NULL,
  "target_id" INTEGER,
  "parameter" VARCHAR(60),
  "verified_at" TIMESTAMP DEFAULT NOW() NOT NULL,
  "agent_notes" TEXT,
  "sources_consulted_count" INTEGER NOT NULL DEFAULT 0,
  "concordance" VARCHAR(10),
  "outcome" VARCHAR(30) NOT NULL,
  "created_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMP DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "verification_log_target_param_idx" ON "verification_log" USING btree ("target_type", "target_id", "parameter", "verified_at");
--> statement-breakpoint
CREATE INDEX "verification_log_type_verified_idx" ON "verification_log" USING btree ("target_type", "verified_at");
