-- Server-side session revocation.
--
-- A session is a signed JWT checked only for its signature, the user row, and
-- the per-user re-auth window (`last_auth_at` + `session_max_days`), so there
-- was no way to end one early: removing a person from the allowlist left
-- their session working for up to 60 days, and an admin had no force-logout
-- short of rotating JWT_SECRET for everyone. A session token issued before
-- this timestamp is rejected (api/_lib/auth.ts). NULL revokes nothing.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "sessions_valid_after" timestamp;
