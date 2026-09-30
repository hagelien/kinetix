-- Per-run token usage for scheduled agent runs, attributed to capability tier.
--
-- The tiered-agent rollout (docs/superpowers/specs/2026-08-24-tiered-agent-cost-architecture.md)
-- is justified only if accuracy holds while cost falls, and nothing recorded
-- cost: the earlier agent_run_stats table (0052) was dropped in 0084 because
-- its only consumer was a quota estimate. This table answers a different
-- question — tokens (and so cost) per tier and per workflow — and is read by
-- scripts/benchmark-agent-tiers.ts next to the accuracy metrics.
--
-- One row per run, appended through POST /api/agent-run-usage with the
-- revocable kxat_ agent token. Token counts are summed from the runner's own
-- transcript by scripts/kinetix-log-run-usage.ts, never self-reported by the
-- model. `model_tier` is a server-side snapshot of agents.model_tier at write
-- time (the same pattern as agent_verifications.verifier_tier, 0113) so a
-- later reclassification of the identity cannot move past runs between tiers.
-- Cost is not stored: prices change, so the report applies a rate card.
-- `model_usage` splits the totals by the model that spent them, so a subagent
-- on a cheaper model is priced at its own rate.
--
-- A re-log of the same (agent, session) updates only the counts; the tier
-- snapshot, workflow and created_at stay those of the first write.
CREATE TABLE IF NOT EXISTS "agent_run_usage" (
  "id" serial PRIMARY KEY NOT NULL,
  "agent_id" integer,
  "created_by" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "model_tier" varchar(20),
  "workflow" varchar(20) NOT NULL,
  "runtime" varchar(20) NOT NULL,
  "model" varchar(80),
  "session_id" varchar(128),
  "started_at" timestamp,
  "duration_ms" integer,
  "input_tokens" bigint DEFAULT 0 NOT NULL,
  "output_tokens" bigint DEFAULT 0 NOT NULL,
  "cache_creation_tokens" bigint DEFAULT 0 NOT NULL,
  "cache_read_tokens" bigint DEFAULT 0 NOT NULL,
  "model_usage" jsonb,
  "notes" text
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_run_usage"
    ADD CONSTRAINT "agent_run_usage_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_run_usage"
    ADD CONSTRAINT "agent_run_usage_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_run_usage_agent_session_uq" ON "agent_run_usage" ("agent_id","session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_usage_created_at_idx" ON "agent_run_usage" ("created_at");
