-- Support the scheduled agent's rejection-learning scan:
-- status='rejected', reviewed_at watermark, agent submitter, newest first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "pending_edits_rejection_scan_idx"
ON "pending_edits" ("status", "reviewed_at" DESC, "submitted_by");
