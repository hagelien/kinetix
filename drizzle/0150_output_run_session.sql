-- Which agent run wrote an output (issue #214, split from #38 Gap 2).
--
-- scripts/benchmark-agent-tiers.ts divides each logged run's cost by the
-- outputs it produced. It used to tie an output to a run by identity and time
-- window only, so two routines sharing one agent token, overlapping in time,
-- with one usage log failing, credited the unlogged run's accepted edits and
-- verdicts to the logged one and understated its cost per output.
--
-- `run_session_id` is the runner session id an agent sends in the
-- X-Kinetix-Run-Session header (scripts/kinetix-api.sh), stamped by the write
-- paths only for agent-token requests; it equals agent_run_usage.session_id
-- for the same run. Human rows stay NULL.
--
-- Nullable and not backfilled: a row written before this migration (or by a
-- client that sends no header) has no recorded run, and the benchmark falls
-- back to the time window for exactly those rows. No index: the benchmark is
-- the only reader and already scans these rows by time.
--
-- Every statement is separated by a statement-breakpoint marker: the production
-- migrator sends each chunk as one prepared statement.

ALTER TABLE pending_edits ADD COLUMN IF NOT EXISTS run_session_id varchar(128);
--> statement-breakpoint
ALTER TABLE agent_verifications ADD COLUMN IF NOT EXISTS run_session_id varchar(128);
