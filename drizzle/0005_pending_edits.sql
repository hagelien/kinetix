CREATE TABLE "pending_edits" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "edit_type" VARCHAR(20) NOT NULL,
  "target_id" INTEGER,
  "parameter" VARCHAR(60),
  "proposed_value" JSONB NOT NULL,
  "proposed_meta" JSONB,
  "reference_id" INTEGER REFERENCES "citations"("id") ON DELETE SET NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "rejection_comment" TEXT,
  "submitted_by" INTEGER NOT NULL REFERENCES "users"("id"),
  "reviewed_by" INTEGER REFERENCES "users"("id"),
  "submitted_at" TIMESTAMP DEFAULT NOW() NOT NULL,
  "reviewed_at" TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX "pending_edits_status_idx" ON "pending_edits" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "pending_edits_target_idx" ON "pending_edits" USING btree ("edit_type", "target_id");
--> statement-breakpoint
CREATE INDEX "pending_edits_submitted_by_idx" ON "pending_edits" USING btree ("submitted_by");
--> statement-breakpoint
ALTER TABLE "drug_parameter_revisions" ADD COLUMN "pending_edit_id" INTEGER REFERENCES "pending_edits"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "wiki_revisions" ADD COLUMN "pending_edit_id" INTEGER REFERENCES "pending_edits"("id") ON DELETE SET NULL;
