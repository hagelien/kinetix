-- Issue #310: Restructure user roles into 4 tiers.
-- Existing taxonomy was (viewer, editor, admin); new taxonomy is
-- (authenticated, contributor, editor, admin) with a new "authenticated"
-- tier inserted below the previous "viewer" — read-only beyond anonymous,
-- may comment, but cannot submit pending edits.
--
-- Migration intent: existing 'viewer' rows were already permitted to
-- submit pending edits (the kinetix-agent runs at this tier), so they
-- map cleanly to 'contributor'. New signups will default to
-- 'authenticated' and must be promoted to 'contributor' before they can
-- submit edits.

UPDATE "users" SET "role" = 'contributor' WHERE "role" = 'viewer';
--> statement-breakpoint

ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'authenticated';
