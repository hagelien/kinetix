-- #345 P2: persist agent hook fire outcomes.
--
-- `agentHooks.ts` fires a POST to the Claude Code Routine API every
-- time a user-visible event happens (comment, approval, …). The fire
-- is best-effort, so failures used to vanish into a `console.warn`.
-- This table captures one row per hook attempt so admins can see what
-- the routine actually received and act on outages.
--
-- `outcome` is application-enforced:
--   'success' — 2xx response from the fire endpoint.
--   'failed'  — non-2xx response or network throw.
--   'skipped' — env vars unset (local dev / preview); fire was a no-op.

CREATE TABLE "agent_hook_runs" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "event" VARCHAR(40) NOT NULL,
  "target_type" VARCHAR(40),
  "target_id" INTEGER,
  "outcome" VARCHAR(20) NOT NULL,
  "http_status" INTEGER,
  "error_message" TEXT,
  "duration_ms" INTEGER,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX "agent_hook_runs_created_idx" ON "agent_hook_runs" USING btree ("created_at" DESC);
--> statement-breakpoint
CREATE INDEX "agent_hook_runs_outcome_idx" ON "agent_hook_runs" USING btree ("outcome", "created_at" DESC);
