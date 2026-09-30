-- Reactivate the kinetix-agent after a suspension. Mirrors the CTE in
-- api/_lib/agentHelpers.ts:115-174 used by the admin lifecycle
-- endpoint, so it produces the same end-state and audit row.
--
-- Why this exists: routine runs were degrading to commented_only /
-- 403-on-wiki_fact because the backing user was at
-- role='authenticated'. That's the lifecycle's expected demotion
-- when an agent is suspended (#319 / migration 0024 + 0026), not a
-- role-config bug — the prior tier is stashed in
-- agents.pre_suspension_role. Reactivation restores it.
--
-- The agent is identified by `agents.slug = 'kinetix-agent'` (seeded
-- in scripts/seed-agent-user.ts). Do NOT switch this back to a
-- hard-coded `id` literal — serial ids are environment-specific and
-- a stale id can reactivate the wrong suspended agent.
--
-- Run with the actor's id substituted for :actor_id (admin user
-- performing the reactivation). Example:
--   psql "$DATABASE_URL" -v actor_id=<your-admin-user-id> \
--     -f scripts/reactivate-kinetix-agent.sql
--
-- The script is self-guarding: ON_ERROR_STOP plus a pre-flight DO
-- block aborts the transaction (no COMMIT) if the agent isn't
-- currently suspended, and a post-flight DO block aborts if the
-- backing user's role wasn't restored. A no-op COMMIT is impossible.

\set ON_ERROR_STOP on

BEGIN;

-- Pre-flight gate: the agent row must exist and be currently
-- suspended. Anything else means the operator's mental model
-- doesn't match reality — bail before mutating.
DO $$
DECLARE
  v_status TEXT;
  v_pre    TEXT;
  v_role   TEXT;
BEGIN
  SELECT a.status, a.pre_suspension_role, u.role
    INTO v_status, v_pre, v_role
  FROM agents a
  JOIN users  u ON u.id = a.user_id
  WHERE a.slug = 'kinetix-agent';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No agent row with slug=kinetix-agent; nothing to reactivate.';
  END IF;
  IF v_status <> 'suspended' THEN
    RAISE EXCEPTION 'Expected agents.status=suspended for kinetix-agent, got %; aborting.', v_status;
  END IF;
  IF v_pre IS NULL THEN
    RAISE EXCEPTION 'pre_suspension_role is NULL for a suspended agent; lifecycle invariant broken, abort.';
  END IF;
  RAISE NOTICE 'Pre-flight ok: status=%, pre_suspension_role=%, backing user role=%', v_status, v_pre, v_role;
END $$;

-- Mutation: flip status, restore role, write history. Driven by the
-- slug-resolved id rather than a literal serial.
WITH
  agent_snapshot AS (
    SELECT a.id, a.user_id, a.pre_suspension_role
    FROM agents a
    WHERE a.slug = 'kinetix-agent'
  ),
  agent_update AS (
    UPDATE agents SET
      status = 'active',
      pre_suspension_role = NULL,
      status_changed_by = :actor_id,
      status_changed_at = NOW(),
      status_change_reason = 'Reactivate after #310 role-taxonomy + suspension demotion left routine unable to submit pending edits.',
      updated_at = NOW()
    WHERE id = (SELECT id FROM agent_snapshot) AND status = 'suspended'
    RETURNING id, user_id
  ),
  user_sync AS (
    UPDATE users SET
      role = COALESCE(
        NULLIF((SELECT pre_suspension_role FROM agent_snapshot), 'authenticated'),
        'contributor'
      ),
      updated_at = NOW()
    WHERE id IN (SELECT user_id FROM agent_update WHERE user_id IS NOT NULL)
      AND role = 'authenticated'
    RETURNING id, role
  ),
  history_insert AS (
    INSERT INTO agent_status_history
      (agent_id, from_status, to_status, changed_by, changed_at, reason)
    SELECT id, 'suspended', 'active', :actor_id, NOW(),
           'Reactivate after #310 role-taxonomy + suspension demotion left routine unable to submit pending edits.'
    FROM agent_update
    RETURNING id
  )
SELECT
  (SELECT id FROM agent_update)        AS agent_updated_id,
  (SELECT role FROM user_sync)         AS new_user_role,
  (SELECT id FROM history_insert)      AS history_row_id;

-- Post-flight gate: the backing user must no longer be at the
-- demotion tier. If something raced us (status changed between the
-- gate and the UPDATE, or the user_sync WHERE missed), abort instead
-- of committing a partial / no-op transaction.
DO $$
DECLARE
  v_status TEXT;
  v_role   TEXT;
BEGIN
  SELECT a.status, u.role
    INTO v_status, v_role
  FROM agents a
  JOIN users  u ON u.id = a.user_id
  WHERE a.slug = 'kinetix-agent';

  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'Post-flight: agents.status is % (expected active); reactivation did not take, aborting.', v_status;
  END IF;
  IF v_role = 'authenticated' THEN
    RAISE EXCEPTION 'Post-flight: users.role is still authenticated; pre_suspension_role restore failed, aborting.';
  END IF;
  RAISE NOTICE 'Post-flight ok: status=%, backing user role=%', v_status, v_role;
END $$;

COMMIT;
