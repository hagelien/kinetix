-- Record when an open dispute was escalated for being overdue (issue #1233).
--
-- The scheduled open-dispute digest (api/dispute-digest.ts, a Vercel cron)
-- escalates every open dispute that has waited past the overdue threshold
-- (src/lib/disputeAge.ts) to the admins, once. This column is what makes that
-- once: the digest claims a dispute by setting it with a conditional UPDATE
-- (`WHERE escalated_at IS NULL`), so two overlapping runs never escalate the
-- same dispute twice. NULL means not escalated. Nullable, no backfill: a
-- dispute already overdue when this ships escalates on the first run.
ALTER TABLE "disputes"
  ADD COLUMN IF NOT EXISTS "escalated_at" timestamp;
