-- Gap 2 of #38 (#214): match an agent's outputs to its logged runs by runner
-- session id instead of a time window. Nullable on purpose: human rows and rows
-- written before this migration stay NULL, and the tier benchmark falls back to
-- the time window for them. Matches agent_run_usage.session_id (varchar 128).
ALTER TABLE "pending_edits" ADD COLUMN IF NOT EXISTS "run_session_id" varchar(128);--> statement-breakpoint
ALTER TABLE "agent_verifications" ADD COLUMN IF NOT EXISTS "run_session_id" varchar(128);
