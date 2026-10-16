-- Wrong sign-in code guesses since the account last signed in.
--
-- `magic_link_failed_attempts` caps the guesses against one code, but it is
-- reset whenever a new code is issued, and a new code could be had every 60 s
-- indefinitely — about 7,200 guesses a day against a 900,000-code space for
-- anyone who knows an allowlisted email. This counter is never reset by a new
-- code, only by a successful sign-in, and auth-request lengthens the issue
-- cooldown as it grows (api/_lib/magic-link.ts `issueCooldownMs`).

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "magic_link_failures_since_auth" integer DEFAULT 0 NOT NULL;
