-- Server-side session revocation.
--
-- A session is a signed JWT checked only for its signature, the user row, and
-- the per-user re-auth window (`last_auth_at` + `session_max_days`), so there
-- was no way to end one early: removing a person from the allowlist left
-- their session working for up to 60 days, and an admin had no force-logout
-- short of rotating JWT_SECRET for everyone. Each session token carries the
-- generation it was issued under (`gen`); revoking a user's sessions bumps
-- this counter, and api/_lib/auth.ts rejects a token from an older one.
-- A counter rather than a timestamp: `iat` has whole-second precision, so a
-- time cutoff cannot tell a token minted just before the revocation from one
-- minted just after it in the same second.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "session_generation" integer DEFAULT 0 NOT NULL;
