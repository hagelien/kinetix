-- Composite index for reviewer queue queries:
-- WHERE status = 'pending' ORDER BY submitted_at DESC LIMIT 100.
-- The existing status-only index (pending_edits_status_idx) required a
-- separate filesort after the filter; this covers both in a single scan,
-- eliminating the sort step as the pending_edits table grows over time.
CREATE INDEX CONCURRENTLY "pending_edits_status_sort_idx"
  ON "pending_edits" ("status", "submitted_at" DESC);
