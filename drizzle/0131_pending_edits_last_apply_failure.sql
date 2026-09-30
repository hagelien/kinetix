-- Persist the last agent-consensus apply refusal (issue #1364).
--
-- The retry sweep and the verdict-POST path already compute `apply_failed`
-- when quorum passes but the write itself deterministically refuses (a
-- parameter collision, a moved wiki-fact target) — but nothing stored it, so
-- the read-only status the review card polls re-ran the same gates, saw them
-- pass, and reported `ready: true` even though every retry was failing
-- identically. Keyed to the `pendingEditReviewToken` the failed attempt was
-- made against, so a stale failure from a since-revised proposal is never
-- read back as current.
ALTER TABLE "pending_edits"
  ADD COLUMN IF NOT EXISTS "last_consensus_apply_failure" jsonb;
