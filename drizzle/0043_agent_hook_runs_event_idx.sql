-- Covers the admin hook-run log query that filters by event type:
--   WHERE event = ? ORDER BY created_at DESC LIMIT ?
-- Without this index the query falls back to a full table scan of
-- agent_hook_runs, which grows with every hook fire. The existing
-- agent_hook_runs_outcome_idx covers the outcome= filter; this covers
-- the event= filter with the same DESC-ordered created_at for the sort.
CREATE INDEX CONCURRENTLY "agent_hook_runs_event_created_idx"
  ON "agent_hook_runs" ("event", "created_at" DESC);
