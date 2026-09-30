-- Per-run telemetry for scheduled agent routines (see agents/remote-routine-setup.md §6).
--
-- Each routine run appends one row through /api/agent-run-stats using the
-- revocable kxat_ agent token (never a direct DATABASE_URL), summing the
-- session transcript's token usage. This lets the operator learn empirically
-- how much a typical cycle costs and, via the optional observed_five_hour_pct
-- calibration column, back out the unpublished 5-hour quota over time:
--   quota ≈ window_tokens / (observed_five_hour_pct / 100).

CREATE TABLE IF NOT EXISTS "agent_run_stats" (
  "id" serial PRIMARY KEY NOT NULL,
  "created_by" integer,
  "session_id" varchar(64),
  "started_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "duration_ms" integer,
  "cycles_completed" integer DEFAULT 1 NOT NULL,
  "input_tokens" bigint DEFAULT 0 NOT NULL,
  "output_tokens" bigint DEFAULT 0 NOT NULL,
  "cache_creation_tokens" bigint DEFAULT 0 NOT NULL,
  "cache_read_tokens" bigint DEFAULT 0 NOT NULL,
  "total_tokens" bigint DEFAULT 0 NOT NULL,
  "total_cost_usd" double precision,
  "model" varchar(60),
  "stop_reason" varchar(30),
  "observed_five_hour_pct" double precision,
  "per_cycle" jsonb,
  "notes" text
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_run_stats"
    ADD CONSTRAINT "agent_run_stats_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_stats_created_by_idx" ON "agent_run_stats" ("created_by","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_stats_created_at_idx" ON "agent_run_stats" ("created_at");
