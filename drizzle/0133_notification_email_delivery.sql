-- Opt-in email delivery for in-app notifications (#1233 follow-up).
--
-- Every email is built from a `notifications` row, so delivery state lives on
-- the row:
--
--   audience          'author' — feedback on the recipient's own contribution;
--                     'reviewer' — the review queue. Matches the two email
--                     opt-ins in users.notification_settings
--                     (src/lib/emailNotificationPrefs.ts).
--   email_handled_at  set once the row has been emailed (alone or in a
--                     summary), or skipped because it predates the user's
--                     opt-in. NULL = still owed an email if the user opts in
--                     to its audience. Written only AFTER a successful send.
--   email_claimed_at  a delivery run's lease on the row while it sends. Taken
--                     with a conditional UPDATE, so overlapping runs never
--                     send a row concurrently; a lapsed lease (the run died
--                     mid-send) makes the row claimable again.
--
-- Rows written before this migration are marked handled: nobody opted in to
-- anything yet, and the first delivery run must not mail the whole history.
-- They are all dispute notices, sent to the reviewers and to the disputed
-- target's author; the author's copies are backfilled as 'author' (feedback
-- on their own work), resolving the author per target type exactly as
-- targetAuthorUserId (api/_lib/agent-verifications.ts) does. Rows the
-- previous build keeps writing during the deploy window land with the
-- 'reviewer' default and a NULL email_handled_at; the inbox still shows their
-- excerpt to the target's author (listNotifications), and every email run
-- re-tags them first (reclassifyTargetAuthorNotices), so a user already
-- opted in through the legacy toggle gets them as feedback.
ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "audience" varchar(20) NOT NULL DEFAULT 'reviewer';
--> statement-breakpoint
UPDATE "notifications" n SET "audience" = 'author'
WHERE n."type" IN ('dispute_opened', 'dispute_resolved')
  AND n."dispute_id" IS NOT NULL
  AND n."user_id" = CASE n."target_type"
    WHEN 'wiki_revision' THEN (SELECT created_by FROM wiki_revisions WHERE id = n."target_id")
    WHEN 'drug_parameter_revision' THEN (SELECT created_by FROM drug_parameter_revisions WHERE id = n."target_id")
    WHEN 'drug_discussion' THEN (SELECT created_by FROM drug_parameter_discussions WHERE id = n."target_id")
    WHEN 'paper_review' THEN (SELECT created_by FROM paper_reviews WHERE id = n."target_id")
    WHEN 'learning_unit_revision' THEN (SELECT created_by FROM learning_unit_revisions WHERE id = n."target_id")
    WHEN 'pending_edit' THEN (SELECT submitted_by FROM pending_edits WHERE id = n."target_id")
  END;
--> statement-breakpoint
ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "email_handled_at" timestamp;
--> statement-breakpoint
ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "email_claimed_at" timestamp;
--> statement-breakpoint
UPDATE "notifications" SET "email_handled_at" = now() WHERE "email_handled_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_email_pending_idx"
  ON "notifications" ("user_id", "created_at")
  WHERE "email_handled_at" IS NULL;
--> statement-breakpoint

-- When the user's last email summary went out (daily / weekly / monthly), or
-- the baseline set when they switched email on. NULL = never.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "last_email_digest_at" timestamp;
--> statement-breakpoint

-- When the delivery job last sent this user any email. Orders each run's
-- recipients least recently served first, so a run that ends on its time
-- budget leaves the users it did not reach at the front of the next one.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "last_email_sent_at" timestamp;
--> statement-breakpoint

-- A delivery run's lease on this user's current summary period while it
-- builds and sends it. Taken with a conditional UPDATE, so overlapping runs
-- never send the same period twice; a lapsed lease (the run died) makes the
-- period claimable again. last_email_digest_at is written only once the
-- summary was sent or there was nothing to send.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "email_digest_claimed_at" timestamp;
