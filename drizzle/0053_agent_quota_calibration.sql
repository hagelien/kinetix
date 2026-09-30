-- Account-wide rate-limit calibration snapshots (see agents/remote-routine-setup.md §6c).
--
-- An interactive Claude Code statusline probe is the only place Anthropic
-- exposes rate_limits.five_hour.{used_percentage,resets_at}; it POSTs each
-- reading here through /api/agent-quota-calibration with the kxat_ token. The
-- 5-hour window pools across routines and interactive use on the same account,
-- so pairing a reading's percentage with the routine's token spend in the same
-- window backs out the unpublished absolute quota:
--   quota ≈ window_tokens / (five_hour_pct / 100).

CREATE TABLE IF NOT EXISTS "agent_quota_calibration" (
  "id" serial PRIMARY KEY NOT NULL,
  "created_by" integer,
  "observed_at" timestamp DEFAULT now() NOT NULL,
  "five_hour_pct" double precision NOT NULL,
  "five_hour_resets_at" timestamp,
  "seven_day_pct" double precision,
  "seven_day_resets_at" timestamp,
  "source" varchar(20)
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_quota_calibration"
    ADD CONSTRAINT "agent_quota_calibration_created_by_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_quota_calibration_observed_idx" ON "agent_quota_calibration" ("observed_at");
