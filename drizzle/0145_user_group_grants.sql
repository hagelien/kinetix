-- Feature groups now carry their restricted features as data.
--
-- Until now one feature group was named in the source tree and every gate on
-- the restricted laboratory material (analytical methods, the postmortem
-- cohort, the laboratory's own detection times, the pattern-profile nav entry)
-- checked membership of that slug. The gates now ask whether any of the
-- user's groups carries the matching grant in `user_groups.grants`
-- (`GROUP_GRANT` in src/lib/featureAccess.ts), so which group unlocks what is
-- an admin decision kept in the database.
--
-- The existing group keeps exactly the access it had: it is found by the md5
-- of its slug (so the slug itself is not written here), plus the neutral `lab`
-- slug that 0027 now seeds on a fresh database.
--
-- Every statement is separated by a statement-breakpoint marker: the production
-- migrator sends each chunk as one prepared statement.

ALTER TABLE "user_groups"
  ADD COLUMN IF NOT EXISTS "grants" JSONB NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint

UPDATE "user_groups"
SET "grants" = '["methods.read","pmConcentrations.read","refsDetectionTimes.read","patternProfile.view"]'::jsonb,
    "updated_at" = now()
WHERE md5("slug") = 'c5945d0e3394cb647791fb58615f7f56'
   OR "slug" = 'lab';
