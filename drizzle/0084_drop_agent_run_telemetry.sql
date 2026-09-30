-- Decommission the agent run-token telemetry and quota-calibration tables.
--
-- Both existed solely to count the tokens a scheduled routine spent and to
-- back-calculate the unpublished 5-hour quota from those counts:
--   - agent_run_stats        — one row per routine run (token totals, cost,
--                              stop reason), written by /api/agent-run-stats,
--   - agent_quota_calibration — statusline /usage readings, paired with the
--                              run-stats token sums to estimate the quota.
-- The endpoints, the logging script, the statusline probe, and the
-- token-budget rerun gate have all been removed, along with the prompt
-- sections that told the agent to feed them. Nothing references these tables
-- any more.
--
-- DROP TABLE is irreversible — take a snapshot first (Neon branch or pg_dump).
-- No CASCADE: neither table is the target of a foreign key, so a plain drop is
-- correct and fails loudly if some unexpected dependency remains.
DROP TABLE IF EXISTS "agent_run_stats";
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_quota_calibration";
