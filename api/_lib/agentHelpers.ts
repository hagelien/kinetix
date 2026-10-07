/**
 * Server-side helpers for the agent lifecycle (#319 P3).
 *
 * `transitionAgentStatus` is the single entry point every status
 * change goes through — admin PATCH, the DELETE soft-delete, and any
 * future automated flows. It enforces the state machine in
 * `src/lib/agentStatus.ts`, writes a history row, and keeps the
 * backing user's role in sync.
 */
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { agents, agentStatusHistory, agentTokens } from '../../db/schema.js';
import {
  type AgentStatus,
  canTransition,
  isAgentStatus,
} from '../../src/lib/agentStatus.js';
import { ROLES } from '../../src/lib/roles.js';
import { generateAgentToken } from './auth.js';

/**
 * Errors from the agent token / role admin operations. Carries an HTTP
 * status the route maps directly onto the response, plus a stable `code`
 * for the client.
 */
export class AgentAdminError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentAdminError';
  }
}

export class AgentTransitionError extends Error {
  constructor(
    public readonly code:
      | 'agent_not_found'
      | 'invalid_status'
      | 'invalid_transition'
      | 'status_conflict',
    message: string,
    public readonly from?: AgentStatus,
    public readonly to?: AgentStatus,
  ) {
    super(message);
    this.name = 'AgentTransitionError';
  }
}

export interface TransitionResult {
  agent: typeof agents.$inferSelect;
  history: typeof agentStatusHistory.$inferSelect;
}

/**
 * Move an agent from its current status to `to`. Throws
 * `AgentTransitionError` on invalid input; caller maps the `code`
 * field onto an HTTP status (404 / 400 / 409).
 *
 * Side effects on a successful transition (all committed atomically
 * as a single SQL statement):
 *   - `agents.status`, `status_changed_*`, `pre_suspension_role`,
 *     `updated_at` updated under an observed-status WHERE guard.
 *   - Row inserted into `agent_status_history`.
 *   - Backing user's role synced:
 *       'active'  → restore `pre_suspension_role` (falls back to
 *                   `contributor`); only lifts users currently at
 *                   `authenticated`, so manual elevations survive.
 *       'suspended' / 'deactivated' → demote to `authenticated`.
 *
 * Atomicity: neon-http has no interactive transactions, so we bundle
 * the writes into a single `WITH … UPDATE … INSERT` statement. CTEs
 * share a snapshot and either all-or-none commit, which (a) keeps
 * the captured `pre_suspension_role` consistent with the user-role
 * demote, (b) prevents a partial commit where status moved but role
 * didn't, and (c) serialises concurrent admin requests on the
 * UPDATE's row-level lock (no "another admin deactivated between
 * our status write and our role write" interleaving is possible).
 */
export async function transitionAgentStatus(args: {
  agentId: number;
  to: AgentStatus | string;
  actorId: number;
  reason?: string | null;
}): Promise<TransitionResult> {
  if (!isAgentStatus(args.to)) {
    throw new AgentTransitionError(
      'invalid_status',
      `Unknown agent status: ${String(args.to)}`,
    );
  }
  const to: AgentStatus = args.to;

  const db = getDb();

  // Preflight read: gives us the `from` value for `canTransition`
  // and lets us distinguish 404 (no row at all) from 409 (row exists
  // but status changed under us). The atomic CTE below re-checks the
  // status as the authoritative concurrency guard.
  const [current] = await db
    .select({
      id: agents.id,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.id, args.agentId))
    .limit(1);
  if (!current) {
    throw new AgentTransitionError('agent_not_found', 'Agent not found');
  }
  const from = current.status as AgentStatus;
  if (!canTransition(from, to)) {
    throw new AgentTransitionError(
      'invalid_transition',
      `Cannot transition agent from ${from} to ${to}`,
      from,
      to,
    );
  }

  const now = new Date();
  const reason = args.reason ?? null;

  // Single-statement CTE that snapshots the row, updates agents,
  // syncs users.role, and inserts the history entry. Sub-statements
  // chain via RETURNING so user_sync + history_insert only fire if
  // the agent_update WHERE matched the observed `from` status. If
  // any sub-statement errors, the whole statement rolls back.
  const result = await db.execute(sql`
    WITH
      agent_snapshot AS (
        SELECT a.id, a.user_id, a.pre_suspension_role
        FROM agents a
        WHERE a.id = ${args.agentId}
        FOR UPDATE
      ),
      locked_user AS (
        SELECT u.id, u.role
        FROM users u
        WHERE u.id IN (
          SELECT user_id FROM agent_snapshot WHERE user_id IS NOT NULL
        )
        FOR UPDATE
      ),
      agent_update AS (
        UPDATE agents SET
          status = ${to},
          pre_suspension_role = CASE
            WHEN ${to}::text = 'suspended'
              THEN (SELECT role FROM locked_user)
            ELSE NULL
          END,
          status_changed_by = ${args.actorId},
          status_changed_at = ${now},
          status_change_reason = ${reason},
          updated_at = ${now}
        WHERE id = ${args.agentId} AND status = ${from}
        RETURNING id, user_id, name, name_en, slug, description, description_en,
                  maintainer_user_id, status, status_changed_by, status_changed_at,
                  status_change_reason, pre_suspension_role, hooks_enabled,
                  self_review_enabled, model_tier, adjudicator, model_family,
                  created_at, updated_at
      ),
      user_sync AS (
        UPDATE users u SET
          role = CASE
            WHEN ${to}::text = 'active' THEN
              COALESCE(
                NULLIF((SELECT pre_suspension_role FROM agent_snapshot), ${ROLES.authenticated}),
                ${ROLES.contributor}
              )
            ELSE ${ROLES.authenticated}
          END,
          updated_at = ${now}
        FROM locked_user l
        WHERE u.id = l.id
          AND u.id IN (
            SELECT user_id FROM agent_update WHERE user_id IS NOT NULL
          )
          AND (${to}::text <> 'active' OR u.role = ${ROLES.authenticated})
        RETURNING u.id, l.role AS from_role, u.role
      ),
      history_insert AS (
        INSERT INTO agent_status_history
          (agent_id, from_status, to_status, changed_by, changed_at, reason)
        SELECT id, ${from}, ${to}, ${args.actorId}, ${now}, ${reason}
        FROM agent_update
        RETURNING id, agent_id, from_status, to_status, changed_by, changed_at, reason
      ),
      role_audit AS (
        INSERT INTO user_role_history (user_id, from_role, to_role, changed_by, changed_at)
        SELECT s.id, s.from_role, s.role, ${args.actorId}, ${now}
        FROM user_sync s
      )
    SELECT
      a.id, a.user_id, a.name, a.name_en, a.slug, a.description, a.description_en,
      a.maintainer_user_id, a.status, a.status_changed_by, a.status_changed_at,
      a.status_change_reason, a.pre_suspension_role, a.hooks_enabled,
      a.self_review_enabled, a.model_tier, a.adjudicator, a.model_family,
      a.created_at, a.updated_at,
      h.id AS history_id, h.from_status AS history_from_status,
      h.to_status AS history_to_status, h.changed_by AS history_changed_by,
      h.changed_at AS history_changed_at, h.reason AS history_reason
    FROM agent_update a
    LEFT JOIN history_insert h ON h.agent_id = a.id
  `);

  const rows = result.rows as Array<Record<string, unknown>>;
  const [row] = rows;
  if (!row) {
    // The CTE's UPDATE matched zero rows — the status changed under
    // us between the preflight SELECT and the statement.
    throw new AgentTransitionError(
      'status_conflict',
      `Agent status changed concurrently; expected ${from}`,
      from,
      to,
    );
  }

  const agent: typeof agents.$inferSelect = {
    id: Number(row.id),
    userId: Number(row.user_id),
    name: row.name as string,
    nameEn: row.name_en as string | null,
    slug: row.slug as string,
    description: row.description as string | null,
    descriptionEn: row.description_en as string | null,
    maintainerUserId:
      row.maintainer_user_id == null ? null : Number(row.maintainer_user_id),
    status: row.status as string,
    statusChangedBy:
      row.status_changed_by == null ? null : Number(row.status_changed_by),
    statusChangedAt: row.status_changed_at
      ? new Date(row.status_changed_at as string)
      : null,
    statusChangeReason: row.status_change_reason as string | null,
    preSuspensionRole: row.pre_suspension_role as string | null,
    hooksEnabled: Boolean(row.hooks_enabled),
    selfReviewEnabled: Boolean(row.self_review_enabled),
    modelTier: (row.model_tier as string | null) ?? null,
    adjudicator: Boolean(row.adjudicator),
    modelFamily: (row.model_family as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
  const history: typeof agentStatusHistory.$inferSelect = {
    id: Number(row.history_id),
    agentId: Number(row.id),
    fromStatus: row.history_from_status as string | null,
    toStatus: row.history_to_status as string,
    changedBy:
      row.history_changed_by == null ? null : Number(row.history_changed_by),
    changedAt: new Date(row.history_changed_at as string),
    reason: row.history_reason as string | null,
  };

  return { agent, history };
}

/**
 * Issue a persistent API token for an agent. Returns the plaintext
 * secret (for one-time display) alongside the stored row; only the
 * SHA-256 hash is persisted. Refuses deactivated agents — a terminal
 * row should never gain fresh credentials.
 *
 * The status check is folded into the INSERT (`SELECT … WHERE EXISTS(…
 * status <> 'deactivated')`) so a concurrent deactivation between the
 * check and the write can't mint a token for a terminal agent. Zero
 * rows inserted means the agent is missing or was just deactivated; a
 * follow-up read distinguishes 404 from 409.
 */
export async function issueAgentToken(args: {
  agentId: number;
  label?: string | null;
  expiresAt: Date;
  actorId: number;
}): Promise<{ token: string; row: typeof agentTokens.$inferSelect }> {
  const db = getDb();
  const { token, hash, prefix } = generateAgentToken();

  const result = await db.execute(sql`
    INSERT INTO agent_tokens
      (agent_id, token_hash, prefix, label, created_by, expires_at)
    SELECT ${args.agentId}, ${hash}, ${prefix}, ${args.label ?? null},
           ${args.actorId}, ${args.expiresAt}
    WHERE EXISTS (
      SELECT 1 FROM agents WHERE id = ${args.agentId} AND status <> 'deactivated'
    )
    RETURNING id, agent_id, token_hash, prefix, label, created_by,
              created_at, expires_at, last_used_at, revoked_at, revoked_by
  `);

  const inserted = (result.rows as Array<Record<string, unknown>>)[0];
  if (!inserted) {
    // Nothing inserted: the agent is gone or (concurrently) deactivated.
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, args.agentId))
      .limit(1);
    if (!agent) {
      throw new AgentAdminError(404, 'agent_not_found', 'Agent not found');
    }
    throw new AgentAdminError(
      409,
      'agent_terminal',
      'Cannot issue tokens for a deactivated agent',
    );
  }

  const row: typeof agentTokens.$inferSelect = {
    id: Number(inserted.id),
    agentId: Number(inserted.agent_id),
    tokenHash: inserted.token_hash as string,
    prefix: inserted.prefix as string,
    label: inserted.label as string | null,
    createdBy: inserted.created_by == null ? null : Number(inserted.created_by),
    createdAt: new Date(inserted.created_at as string),
    expiresAt: new Date(inserted.expires_at as string),
    lastUsedAt: inserted.last_used_at
      ? new Date(inserted.last_used_at as string)
      : null,
    revokedAt: inserted.revoked_at
      ? new Date(inserted.revoked_at as string)
      : null,
    revokedBy: inserted.revoked_by == null ? null : Number(inserted.revoked_by),
  };
  return { token, row };
}

/**
 * Revoke a token. Idempotent: re-revoking keeps the original
 * `revokedAt`/`revokedBy` (via COALESCE) and still returns the row.
 * Scoped to `agentId` so an admin can't revoke another agent's token by
 * guessing an id.
 */
export async function revokeAgentToken(args: {
  agentId: number;
  tokenId: number;
  actorId: number;
}): Promise<typeof agentTokens.$inferSelect> {
  const db = getDb();
  const now = new Date();
  const [row] = await db
    .update(agentTokens)
    .set({
      revokedAt: sql`COALESCE(${agentTokens.revokedAt}, ${now})`,
      revokedBy: sql`COALESCE(${agentTokens.revokedBy}, ${args.actorId})`,
    })
    .where(
      and(
        eq(agentTokens.id, args.tokenId),
        eq(agentTokens.agentId, args.agentId),
      ),
    )
    .returning();
  if (!row) {
    throw new AgentAdminError(404, 'token_not_found', 'Token not found');
  }
  return row;
}

/**
 * Change an agent's permission tier post-creation. Restricted to
 * contributor ↔ editor — agents never carry `admin`. Lifecycle-aware:
 *   - active     → set the backing user's live role directly.
 *   - suspended  → stash on `pre_suspension_role` so reactivation
 *                  restores the new tier; the live role stays
 *                  `authenticated` while suspended.
 *   - deactivated→ rejected (terminal).
 *
 * Each write carries an observed-status predicate so a concurrent
 * transition (another admin suspending/deactivating between the
 * preflight read and the write) can't slip a stale role through. The
 * active path bundles the agent + user writes into a single CTE so the
 * `users.role` update only lands while the agent is still active —
 * otherwise it would re-enable JWT-authenticated writes for an agent
 * that just left the `active` state. A zero-row match raises a 409.
 */
export async function setAgentRole(args: {
  agentId: number;
  role: string;
  actorId: number;
}): Promise<{ agent: typeof agents.$inferSelect; role: string }> {
  if (args.role !== ROLES.contributor && args.role !== ROLES.editor) {
    throw new AgentAdminError(
      400,
      'invalid_role',
      'Agent role must be contributor or editor',
    );
  }
  const db = getDb();
  const now = new Date();

  const [agent] = await db
    .select({ id: agents.id, userId: agents.userId, status: agents.status })
    .from(agents)
    .where(eq(agents.id, args.agentId))
    .limit(1);
  if (!agent) {
    throw new AgentAdminError(404, 'agent_not_found', 'Agent not found');
  }
  if (agent.status === 'deactivated') {
    throw new AgentAdminError(
      409,
      'agent_terminal',
      'Cannot change the role of a deactivated agent',
    );
  }

  if (agent.status === 'suspended') {
    const [updated] = await db
      .update(agents)
      .set({ preSuspensionRole: args.role, updatedAt: now })
      .where(and(eq(agents.id, args.agentId), eq(agents.status, 'suspended')))
      .returning();
    if (!updated) {
      throw new AgentAdminError(
        409,
        'status_conflict',
        'Agent status changed concurrently; expected suspended',
      );
    }
    // Live role intentionally untouched while suspended.
    return { agent: updated, role: ROLES.authenticated };
  }

  // Active path: update the agent and sync the user's role in a single
  // statement so the role write is gated on the agent still being
  // 'active'. If a concurrent transition moved it out of 'active', the
  // agent_update CTE matches zero rows, user_sync touches nothing, and
  // the SELECT returns empty → 409.
  // locked_user captures the current users.role before the update so the
  // user_role_history audit row records an accurate from_role atomically.
  const result = await db.execute(sql`
    WITH agent_update AS (
      UPDATE agents SET updated_at = ${now}
      WHERE id = ${args.agentId} AND status = 'active'
      RETURNING id, user_id, name, name_en, slug, description, description_en,
                maintainer_user_id, status, status_changed_by, status_changed_at,
                status_change_reason, pre_suspension_role, hooks_enabled,
                self_review_enabled, model_tier, adjudicator, model_family,
                created_at, updated_at
    ),
    locked_user AS (
      SELECT u.id, u.role
      FROM users u
      WHERE u.id IN (SELECT user_id FROM agent_update)
      FOR UPDATE
    ),
    user_sync AS (
      UPDATE users u SET role = ${args.role}, updated_at = ${now}
      FROM locked_user l
      WHERE u.id = l.id
      RETURNING u.id, l.role AS from_role, u.role
    ),
    role_audit AS (
      INSERT INTO user_role_history (user_id, from_role, to_role, changed_by)
      SELECT id, from_role, role, ${args.actorId}
      FROM user_sync
    )
    SELECT id, user_id, name, name_en, slug, description, description_en,
           maintainer_user_id, status, status_changed_by, status_changed_at,
           status_change_reason, pre_suspension_role, hooks_enabled,
           self_review_enabled, model_tier, adjudicator, model_family,
           created_at, updated_at
    FROM agent_update
  `);

  const row = (result.rows as Array<Record<string, unknown>>)[0];
  if (!row) {
    throw new AgentAdminError(
      409,
      'status_conflict',
      'Agent status changed concurrently; expected active',
    );
  }

  const updated: typeof agents.$inferSelect = {
    id: Number(row.id),
    userId: Number(row.user_id),
    name: row.name as string,
    nameEn: row.name_en as string | null,
    slug: row.slug as string,
    description: row.description as string | null,
    descriptionEn: row.description_en as string | null,
    maintainerUserId:
      row.maintainer_user_id == null ? null : Number(row.maintainer_user_id),
    status: row.status as string,
    statusChangedBy:
      row.status_changed_by == null ? null : Number(row.status_changed_by),
    statusChangedAt: row.status_changed_at
      ? new Date(row.status_changed_at as string)
      : null,
    statusChangeReason: row.status_change_reason as string | null,
    preSuspensionRole: row.pre_suspension_role as string | null,
    hooksEnabled: Boolean(row.hooks_enabled),
    selfReviewEnabled: Boolean(row.self_review_enabled),
    modelTier: (row.model_tier as string | null) ?? null,
    adjudicator: Boolean(row.adjudicator),
    modelFamily: (row.model_family as string | null) ?? null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
  return { agent: updated, role: args.role };
}
