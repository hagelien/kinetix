-- When an agent's capability tier last changed (issue 216).
--
-- `agent_run_usage.model_tier` is snapshotted when the run is logged, at its
-- end, so a run in flight while an admin reclassifies the agent is filed under
-- the new tier. Recording the time of the change lets
-- scripts/benchmark-agent-tiers.ts find a run whose span contains it and leave
-- it out of the tier comparison.
--
-- Set by the admin agent PATCH only when the value actually changes. NULL
-- means no change since this migration; nothing is backfilled, because the
-- time of an earlier change was never recorded. Only the latest change is
-- kept.

ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "model_tier_changed_at" timestamp;
