-- Approval stamps (#344).
--
-- Polymorphic approvals table: a row records one user/agent endorsing
-- one specific revision or comment. The first stamp is created
-- automatically when a reviewer approves a pending edit (via
-- applyApprovedEdit); subsequent stamps come from voluntary
-- POST /api/approvals calls by other reviewers.
--
-- targetType values:
--   'wiki_revision'           -> wiki_revisions.id
--   'drug_parameter_revision' -> drug_parameter_revisions.id
--   'drug_discussion'         -> drug_parameter_discussions.id
--
-- We don't add SQL FK constraints because the target table varies by
-- targetType. The unique index on (targetType, targetId, approvedBy)
-- makes "I already stamped this" idempotent without a SELECT.

CREATE TABLE IF NOT EXISTS "approvals" (
  "id" SERIAL PRIMARY KEY,
  "target_type" VARCHAR(40) NOT NULL,
  "target_id" INTEGER NOT NULL,
  "approved_by" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approvals_target_user_idx"
  ON "approvals" ("target_type", "target_id", "approved_by");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_target_idx"
  ON "approvals" ("target_type", "target_id");
