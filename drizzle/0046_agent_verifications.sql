-- Agent-to-agent verifications.
--
-- One row per (agent, target) judgment. Targets are polymorphic and reuse the
-- approval target_type taxonomy plus one new value, 'pending_edit', so agents
-- can also verify items while they sit in the moderator queue.
--
-- The submitter's implicit-approve row is written by the API at submission
-- time (is_implicit = TRUE, verdict = 'approve'). Combined with the
-- self-verification block at the POST handler this models "the initial action
-- where an agent adds or edits content counts as one review approval" without
-- special-casing the count callers.

CREATE TABLE IF NOT EXISTS "agent_verifications" (
  "id"            SERIAL PRIMARY KEY,
  "agent_id"      INTEGER NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "target_type"   VARCHAR(40) NOT NULL,
  "target_id"     INTEGER NOT NULL,
  "verdict"       VARCHAR(20) NOT NULL,
  "rationale_md"  TEXT NOT NULL DEFAULT '',
  "evidence_refs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "model"         VARCHAR(60),
  "is_implicit"   BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at"    TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"    TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_verifs_unique_idx"
  ON "agent_verifications" ("agent_id", "target_type", "target_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_verifs_target_idx"
  ON "agent_verifications" ("target_type", "target_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_verifs_target_dispute_idx"
  ON "agent_verifications" ("target_type", "target_id")
  WHERE "verdict" = 'dispute';
