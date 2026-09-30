-- The control phase after a blind dispute (issue #1357).
--
-- A peer dispute is formed blind, and that stays. But a dispute that stands
-- against a peer approval now gets one sanctioned second look: its author is
-- shown the other reviewers' rationales and either maintains the dispute with
-- an addendum or withdraws it. Each row is written when the peers are shown
-- (outcome 'disclosed'), records the decision that follows, and keeps the
-- ORIGINAL blind verdict immutable — the live agent_verifications row is
-- rewritten on a withdrawal, the blind signal survives here.
CREATE TABLE IF NOT EXISTS "agent_verdict_reconsiderations" (
  "id" serial PRIMARY KEY NOT NULL,
  "verification_id" integer NOT NULL,
  "agent_id" integer NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "target_type" varchar(40) NOT NULL,
  "target_id" integer NOT NULL,
  "target_version" varchar(80) NOT NULL,
  "original_verdict" varchar(20) NOT NULL,
  "original_rationale_md" text NOT NULL,
  "original_evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "original_verifier_tier" varchar(20),
  "original_model" varchar(60),
  "original_recorded_at" timestamp NOT NULL,
  "outcome" varchar(20) DEFAULT 'disclosed' NOT NULL,
  "addendum_md" text DEFAULT '' NOT NULL,
  "decided_at" timestamp,
  "decision_model" varchar(60),
  "decision_verifier_tier" varchar(20),
  "peer_disclosures" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "peer_verdicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_verdict_reconsiderations_unique_idx"
  ON "agent_verdict_reconsiderations" ("agent_id", "target_type", "target_id", "target_version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_verdict_reconsiderations_target_idx"
  ON "agent_verdict_reconsiderations" ("target_type", "target_id");
--> statement-breakpoint
-- The tier a verdict was written under, never restamped (the existing
-- verifier_tier is the effective tier, which a demotion rewrites on pending
-- targets). Nullable: rows written before this column fall back to
-- verifier_tier in readers.
ALTER TABLE "agent_verifications"
  ADD COLUMN IF NOT EXISTS "recorded_verifier_tier" varchar(20);
