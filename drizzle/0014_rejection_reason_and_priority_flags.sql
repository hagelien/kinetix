-- Issue #247: Standardized rejection reasons on pending_edits.
-- Stores one of REJECTION_REASONS (see src/lib/rejectionReasons.ts) alongside
-- the existing free-text `rejection_comment`.
ALTER TABLE "pending_edits" ADD COLUMN "rejection_reason" VARCHAR(40);
--> statement-breakpoint

-- Issue #249: Manual queue boost for the kinetix-agent.
-- Moderators/admins flag a (drug, parameter) pair so the next agent cycle picks
-- it up before the popularity-based default queue. `parameter` may be NULL to
-- mean "any/all parameters on this drug".
CREATE TABLE "parameter_priority_flags" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "drug_id" INTEGER NOT NULL REFERENCES "drugs"("id") ON DELETE CASCADE,
  "parameter" VARCHAR(60),
  "status" VARCHAR(20) NOT NULL DEFAULT 'active',
  "note" TEXT,
  "flagged_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "resolved_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMP DEFAULT NOW() NOT NULL,
  "resolved_at" TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX "param_priority_status_idx" ON "parameter_priority_flags" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE INDEX "param_priority_drug_param_idx" ON "parameter_priority_flags" USING btree ("drug_id", "parameter");
