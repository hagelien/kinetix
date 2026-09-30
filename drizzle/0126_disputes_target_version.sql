-- Bind a dispute to the payload version it objects to.
--
-- POST /api/disputes has never recorded which version of a target it
-- contests. The only anchor was `created_at`, and a payload can be revised
-- between when a reviewer reads it and when they post the objection — the
-- dispute then reads as being about content the author no longer has, with
-- nothing on the row to catch the mismatch (see #1321).
--
-- `target_version` stores the same opaque `verificationTargetVersion` token
-- POST /api/agent-verifications already validates against (an ISO timestamp,
-- or for a pending_edit, `<submittedAt>|<status>`). POST /api/disputes now
-- requires and validates one at creation; the column is nullable only so
-- rows written before this migration (already resolved or long-open) do not
-- need a backfill nobody can supply — a null target_version simply means
-- "predates this check" and no reader treats it as a match or a mismatch.
ALTER TABLE "disputes"
  ADD COLUMN IF NOT EXISTS "target_version" varchar(80);
