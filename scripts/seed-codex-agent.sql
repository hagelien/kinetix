-- Seed the `codex-agent` maintenance agent: a second drug-database
-- maintenance worker that runs the same routine as `kinetix-agent`
-- (agents/drug-db-maintainer.md) under a DISTINCT identity.
--
-- Why this exists: the peer-verification protocol (agents/peer-verification-protocol.md,
-- PR #575) is symmetric — agent A independently judges agent B's work — and
-- the server blocks self-verification. With only `kinetix-agent` registered,
-- a single token was shared across two schedulers, so both runs authenticated
-- as the same agent and no agent-on-agent review could occur (the queue
-- filters out the caller's own authorship). Standing up `codex-agent` as its
-- own user + agents row, with its own `kxat_` token, gives the second
-- scheduler a separate identity so the two maintenance agents verify each
-- other's parameter/wiki/discussion changes.
--
-- This mirrors the documented recipe in agents/adding-a-new-agent.md (Step 1).
-- After running this, mint the agent's token once and wire it into the second
-- scheduler's KINETIX_TOKEN (do NOT reuse kinetix-agent's token):
--   AGENT_SLUG=codex-agent npm run seed:agent-token
--
-- Status changes later (suspend/reactivate/deactivate) must go through the
-- audited admin transition endpoint, not raw UPDATEs, so the
-- agent_status_history trail and the backing user's role stay in sync.
--
-- Run with:
--   psql "$DATABASE_URL" -f scripts/seed-codex-agent.sql
--
-- Self-guarding: ON_ERROR_STOP plus a pre-flight gate aborts (no COMMIT) if
-- the slug/email/username already exist, so re-running can't create a
-- duplicate or partial identity.

\set ON_ERROR_STOP on

BEGIN;

-- Serialise with consensus re-checks: a new active agent changes the quorum
-- a check is counting (src/lib/agentPoolLock.ts). Held until COMMIT.
SELECT pg_advisory_xact_lock(1357, 0);

-- Pre-flight gate: refuse to run if any of the unique keys already exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agents WHERE slug = 'codex-agent') THEN
    RAISE EXCEPTION 'agents.slug=codex-agent already exists; nothing to seed.';
  END IF;
  IF EXISTS (SELECT 1 FROM users
             WHERE email = 'codex-agent@kinetix.internal'
                OR username = 'codex-agent') THEN
    RAISE EXCEPTION 'a users row for codex-agent already exists; aborting to avoid a split identity.';
  END IF;
END $$;

WITH new_user AS (
  INSERT INTO users (email, username, role, email_verified_at)
  VALUES ('codex-agent@kinetix.internal', 'codex-agent', 'contributor', now())
  RETURNING id
)
INSERT INTO agents (user_id, name, name_en, slug, description, description_en, status, hooks_enabled)
SELECT id,
       'Kinetix vedlikeholdsagent (Codex)',
       'Kinetix maintenance agent (Codex)',
       'codex-agent',
       'Andre vedlikeholdsarbeider for legemiddeldatabasen; kjører samme syklus som kinetix-agent under egen identitet slik at de to fagfellevurderer hverandres endringer.',
       'Second drug-database maintenance worker; runs the same cycle as kinetix-agent under a distinct identity so the two peer-verify each other''s changes.',
       'active', false
FROM new_user
RETURNING id AS agent_id, user_id, slug, status;

COMMIT;
