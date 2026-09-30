/**
 * Consolidated admin API endpoint.
 * Dispatches by ?resource= parameter:
 *   ?resource=users            — GET list, PATCH role (admin)
 *   ?resource=categories       — GET public, POST/DELETE admin
 *   ?resource=allowed-domains  — GET/POST/DELETE (admin)
 *   ?resource=allowed-emails   — GET/POST/DELETE (admin)
 *   ?resource=groups           — GET/POST/PATCH/DELETE (admin)
 *   ?resource=agents           — GET/POST/PATCH/DELETE (admin) — #319
 *   ?resource=agent-hook-runs  — GET (admin) — #345
 *   ?resource=settings         — GET/PATCH (admin) — runtime policy switches
 *   ?resource=nav-visibility   — GET public (cached, fail-open; provenance
 *                                for capability holders), PATCH admin —
 *                                hidden header nav links (#1240, #1307)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import {
  json,
  error,
  noStoreHeaders,
  withErrorHandling,
} from './_lib/response.js';
import { getDb, getNeonClient } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan, requireCapability } from './_lib/permissions-store.js';
import {
  applySiteSettings,
  getSiteSettingsMatrix,
  UnknownSiteSettingError,
} from './_lib/site-settings-store.js';
import {
  getHiddenNavItemsState,
  loadHiddenNavItems,
  setHiddenNavItem,
  UnknownNavItemError,
} from './_lib/nav-visibility-store.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import {
  updateAgentWithTierRestamp,
  withAgentPoolGrowthLock,
} from './_lib/agent-verifications.js';
import { retryAgentConsensus } from './agent-verifications.js';
import { generateSlug } from './_lib/slug.js';
import {
  addAllowedDomainSchema,
  addAllowedEmailSchema,
  createUserGroupSchema,
  createAgentSchema,
  patchUserGroupMembersSchema,
  patchAgentSchema,
  transitionAgentStatusSchema,
  issueAgentTokenSchema,
  revokeAgentTokenSchema,
  setAgentRoleSchema,
  updateSiteSettingsSchema,
  updateHiddenNavItemSchema,
} from './_lib/schemas.js';
import { and } from 'drizzle-orm';
import {
  users,
  wikiCategories,
  allowedEmailDomains,
  allowedEmails,
  userGroups,
  userGroupMembers,
  agents,
  agentStatusHistory,
  agentHookRuns,
  agentTokens,
} from '../db/schema.js';
import { z } from 'zod';
import { ROLE_VALUES } from '../src/lib/roles.js';
import {
  AgentAdminError,
  AgentTransitionError,
  issueAgentToken,
  revokeAgentToken,
  setAgentRole,
  transitionAgentStatus,
} from './_lib/agentHelpers.js';

/**
 * Serialize an agent token row for the admin client — deliberately omits
 * `tokenHash` so the secret material never leaves the server.
 */
function serializeAgentToken(row: typeof agentTokens.$inferSelect) {
  return {
    id: row.id,
    agentId: row.agentId,
    prefix: row.prefix,
    label: row.label,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

const updateRoleSchema = z.object({
  userId: z.number().int().positive(),
  role: z.enum(ROLE_VALUES),
});

const createCategorySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
});

function isPublicAdminRead(resource: string | null, method?: string): boolean {
  return (
    method === 'GET' &&
    (resource === 'categories' || resource === 'nav-visibility')
  );
}

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  );
  const resource = url.searchParams.get('resource');

  if (!isPublicAdminRead(resource, req.method)) {
    for (const [key, value] of Object.entries(noStoreHeaders())) {
      if (value !== undefined) res.setHeader(key, value);
    }
  }

  if (
    req.method === 'POST' ||
    req.method === 'PATCH' ||
    req.method === 'DELETE'
  ) {
    assertSameOrigin(req);
  }

  if (resource === 'users') {
    return handleUsers(req, res);
  }
  if (resource === 'categories') {
    return handleCategories(req, res, url);
  }
  if (resource === 'allowed-domains') {
    return handleAllowedDomains(req, res, url);
  }
  if (resource === 'allowed-emails') {
    return handleAllowedEmails(req, res, url);
  }
  if (resource === 'groups') {
    return handleGroups(req, res, url);
  }
  if (resource === 'agents') {
    return handleAgents(req, res, url);
  }
  if (resource === 'agent-hook-runs') {
    return handleAgentHookRuns(req, res, url);
  }
  if (resource === 'settings') {
    return handleSiteSettings(req, res);
  }
  if (resource === 'nav-visibility') {
    return handleNavVisibility(req, res);
  }

  error(
    res,
    400,
    'Invalid resource. Use ?resource=users|categories|allowed-domains|allowed-emails|groups|agents|agent-hook-runs|settings|nav-visibility',
  );
});

/**
 * Runtime policy switches (`site_settings`).
 *
 * GET returns every switch in the registry with its effective value, its
 * shipped default and who last changed it — the registry is the source of
 * truth, so a switch that has never been touched still appears (marked
 * `isDefault`). PATCH takes a partial `{ settings: { id: boolean } }`, applies
 * it as one unit, and answers with the same shape as GET.
 */
async function handleSiteSettings(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'GET') {
    const auth = await requireCapability(
      req,
      res,
      CAP['admin.settings.manage'],
    );
    if (!auth) return;
    json(res, 200, await getSiteSettingsMatrix());
    return;
  }

  if (req.method === 'PATCH') {
    const auth = await requireCapability(
      req,
      res,
      CAP['admin.settings.manage'],
    );
    if (!auth) return;

    const result = await parseAndValidate(req, updateSiteSettingsSchema);
    if ('error' in result) {
      error(res, 400, result.error);
      return;
    }

    let settings;
    try {
      settings = await applySiteSettings(result.data.settings, auth.userId);
    } catch (err) {
      if (err instanceof UnknownSiteSettingError) {
        error(res, 400, err.message, err.code);
        return;
      }
      throw err;
    }

    // Past this point the change is COMMITTED. The form also renders who
    // changed what and when, and that provenance only exists server-side — but
    // a failed read of it must not turn a committed write into a 500. The
    // client treats an error as "the save did not happen" and reverts its
    // toggle, which in the dangerous direction would leave the gate disabled
    // while the UI still shows it on. So the matrix read is best-effort. When
    // it succeeds its `settings` win (a real read, accurate for every switch,
    // including any a concurrent admin changed); when it fails we fall back to
    // `applySiteSettings`'s answer, which is authoritative for the switches
    // this request wrote. `rows: null` tells the client only that provenance
    // could not be refreshed — not that there is none.
    let rows = null;
    try {
      const matrix = await getSiteSettingsMatrix();
      rows = matrix.rows;
      settings = matrix.settings;
    } catch (err) {
      console.warn('[admin] settings saved but the matrix re-read failed', err);
    }
    json(res, 200, { settings, rows });
    return;
  }

  error(res, 405, 'Method not allowed');
}

/**
 * Hidden header nav links (`site_settings` under `nav.hiddenMenuItems`, #1240).
 *
 * GET is public — the whole point is that an anonymous or non-admin visitor's
 * header reads it to decide what to render, and nothing here is secret (an
 * admin can still reach a hidden route by URL). PATCH toggles one item and is
 * admin-gated (#1316: a whole-list replace let two managers' concurrent
 * changes silently overwrite each other).
 *
 * The public payload is served through `loadHiddenNavItems()` — cached and
 * fail-open to "hide nothing" — rather than `getHiddenNavItemsState()`'s
 * uncached provenance join. Every SPA bootstrap hits this GET, so the
 * uncached path meant an unavailable database or a pre-0096 table produced a
 * 500 for every visitor instead of the documented fail-open response (#1307).
 * A caller holding `admin.navVisibility.manage` still gets the provenance
 * join — that's what `NavVisibilityAdminSection`'s initial load and its
 * post-failure re-read rely on for the "changed by" line — so the capability
 * check below reserves the uncached query for the protected admin view
 * without splitting this into a second endpoint. Resolving that capability
 * is itself a DB read (auth lookup), so any failure there falls back to the
 * public path too, rather than surfacing as a 500 for signed-in visitors.
 * The provenance query itself can fail the same way (#1372) — a database
 * that predates migration 0096 still has working auth tables — so that call
 * is also guarded, and falls back to the same fail-open payload with null
 * provenance instead of a 500.
 */
async function handleNavVisibility(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'GET') {
    // Resolving the caller's identity/capability is itself a DB read, so it
    // must not be allowed to defeat the fail-open guarantee below: an
    // authenticated visitor hitting an unavailable database still gets the
    // cached "hide nothing" payload rather than a 500 (#1307 review, P2).
    let canSeeProvenance = false;
    try {
      const auth = await getUserFromRequest(req);
      canSeeProvenance =
        !!auth &&
        (await callerCan(auth.role, CAP['admin.navVisibility.manage']));
    } catch {
      canSeeProvenance = false;
    }
    if (canSeeProvenance) {
      // The provenance join itself can fail independently of the capability
      // check above — most reproducibly when the database predates migration
      // 0096 while the auth tables still work (#1372). That must not turn
      // this fail-open GET into a 500 for an admin or delegated manager: fall
      // through to the same anonymous payload the non-privileged branch
      // below serves, just without provenance.
      try {
        json(res, 200, await getHiddenNavItemsState());
        return;
      } catch {
        // fall through to the fail-open payload
      }
    }
    json(res, 200, {
      hiddenItems: await loadHiddenNavItems(),
      updatedAt: null,
      updatedBy: null,
    });
    return;
  }

  if (req.method === 'PATCH') {
    const auth = await requireCapability(
      req,
      res,
      CAP['admin.navVisibility.manage'],
    );
    if (!auth) return;

    const result = await parseAndValidate(req, updateHiddenNavItemSchema);
    if ('error' in result) {
      error(res, 400, result.error);
      return;
    }

    try {
      const state = await setHiddenNavItem(
        result.data.id,
        result.data.hidden,
        auth.userId,
      );
      json(res, 200, state);
    } catch (err) {
      if (err instanceof UnknownNavItemError) {
        error(res, 400, err.message, err.code);
        return;
      }
      throw err;
    }
    return;
  }

  error(res, 405, 'Method not allowed');
}

async function handleUsers(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 403, 'Admin role required');
    return;
  }
  // Listing users also backs the group-membership picker, so a delegated
  // group manager needs the read even though role changes stay with
  // admin.users.manage — otherwise the groups pane loads with nobody to add.
  const canManageUsers = await callerCan(auth.role, CAP['admin.users.manage']);
  const canReadUsers =
    canManageUsers ||
    (req.method === 'GET' &&
      (await callerCan(auth.role, CAP['admin.groups.manage'])));
  if (!canReadUsers) {
    error(res, 403, 'Admin role required');
    return;
  }

  const db = getDb();

  if (req.method === 'GET') {
    try {
      const allUsers = await db
        .select({
          id: users.id,
          email: users.email,
          username: users.username,
          role: users.role,
          createdAt: users.createdAt,
        })
        .from(users)
        .orderBy(users.createdAt);

      json(res, 200, { users: allUsers });
    } catch {
      error(res, 500, 'Failed to list users');
    }
    return;
  }

  if (req.method === 'PATCH') {
    if (!canManageUsers) {
      error(res, 403, 'Admin role required');
      return;
    }
    const result = await parseAndValidate(req, updateRoleSchema);
    if ('error' in result) {
      error(res, 400, result.error);
      return;
    }

    const { userId, role } = result.data;

    try {
      if (role === 'admin') {
        const [agent] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.userId, userId))
          .limit(1);
        if (agent) {
          error(
            res,
            400,
            'Agent users cannot be assigned the admin role',
            'agent_admin_role_forbidden',
          );
          return;
        }
      }

      // Single CTE: lock the current role, apply the update, and write the
      // audit row atomically. A separate pre-read then UPDATE then INSERT
      // would leave a TOCTOU window where a concurrent PATCH could cause the
      // audit's from_role to record a stale value.
      const neonSql = getNeonClient();
      const [ctaRow] = (await neonSql`
          WITH locked_user AS (
            SELECT id, role FROM users WHERE id = ${userId} FOR UPDATE
          ),
          upd AS (
            UPDATE users u SET role = ${role}, updated_at = NOW()
            FROM locked_user l
            WHERE u.id = l.id
            RETURNING u.id, l.role AS from_role, u.role
          ),
          audit AS (
            INSERT INTO user_role_history (user_id, from_role, to_role, changed_by)
            SELECT id, from_role, role, ${auth.userId}
            FROM upd
          )
          SELECT id, role FROM upd
        `) as Array<{ id: number; role: string }>;

      if (!ctaRow) {
        error(res, 404, 'User not found');
        return;
      }

      json(res, 200, { user: ctaRow });
    } catch {
      error(res, 500, 'Failed to update user role');
    }
    return;
  }

  error(res, 405, 'Method not allowed');
}

async function handleCategories(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const db = getDb();

  // GET: List categories (public)
  if (req.method === 'GET') {
    try {
      const categories = await db
        .select()
        .from(wikiCategories)
        .orderBy(wikiCategories.name);

      json(res, 200, { categories });
    } catch {
      error(res, 500, 'Failed to list categories');
    }
    return;
  }

  // All write operations require admin
  const auth = await getUserFromRequest(req);
  if (!auth || !(await callerCan(auth.role, CAP['admin.categories.manage']))) {
    error(res, 403, 'Admin role required');
    return;
  }

  if (req.method === 'POST') {
    const result = await parseAndValidate(req, createCategorySchema);
    if ('error' in result) {
      error(res, 400, result.error);
      return;
    }

    const { name, description } = result.data;

    try {
      const [category] = await db
        .insert(wikiCategories)
        .values({
          name,
          slug: generateSlug(name),
          description: description ?? null,
        })
        .returning();

      json(res, 201, { category });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('unique') || message.includes('duplicate')) {
        error(res, 409, 'Category already exists');
      } else {
        error(res, 500, 'Failed to create category');
      }
    }
    return;
  }

  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) {
      error(res, 400, 'Missing id parameter');
      return;
    }

    try {
      await db.delete(wikiCategories).where(eq(wikiCategories.id, Number(id)));
      json(res, 200, { message: 'Category deleted' });
    } catch {
      error(res, 500, 'Failed to delete category');
    }
    return;
  }

  error(res, 405, 'Method not allowed');
}

async function handleAllowedDomains(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth || !(await callerCan(auth.role, CAP['admin.allowlist.manage']))) {
    error(res, 403, 'Admin role required');
    return;
  }

  const db = getDb();

  if (req.method === 'GET') {
    const rows = await db
      .select()
      .from(allowedEmailDomains)
      .orderBy(allowedEmailDomains.domain);
    json(res, 200, { domains: rows });
    return;
  }

  if (req.method === 'POST') {
    const parsed = await parseAndValidate(req, addAllowedDomainSchema);
    if ('error' in parsed) {
      error(res, 400, parsed.error);
      return;
    }
    try {
      const [row] = await db
        .insert(allowedEmailDomains)
        .values({
          domain: parsed.data.domain.toLowerCase(),
          addedBy: auth.userId,
        })
        .returning();
      json(res, 201, { domain: row });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('unique') || message.includes('duplicate')) {
        error(res, 409, 'Domain already on allowlist');
      } else {
        error(res, 500, 'Failed to add domain');
      }
    }
    return;
  }

  if (req.method === 'DELETE') {
    const id = Number(url.searchParams.get('id'));
    if (!id) {
      error(res, 400, 'Missing id parameter');
      return;
    }
    await db.delete(allowedEmailDomains).where(eq(allowedEmailDomains.id, id));
    json(res, 200, { deleted: true });
    return;
  }

  error(res, 405, 'Method not allowed');
}

// ─── Agents (#319) ─────────────────────────────────────────────────────────
//
// Admin CRUD over the agents table. Creating an agent provisions both
// the backing users row (role=contributor by default; admin can promote
// later via the existing users PATCH) and the agents row. neon-http
// has no interactive transactions, so the POST path preflights the
// agents.slug uniqueness BEFORE inserting the user row, and on a late
// failure (race against another admin) cleans up the orphan user.
//
// PATCH ?id=N — edits display fields (name, slug, description,
// maintainer). Status transitions live on a separate path:
// PATCH ?id=N&action=transition with { status, reason? }. This makes
// the lifecycle change an explicit action (audited via
// agent_status_history) rather than a side-effect of a display edit.
//
// DELETE ?id=N transitions the agent to 'deactivated' (terminal
// soft-delete). Row is retained so pending_edits / revisions keep
// their FK targets; backing user is demoted to `authenticated`.

async function handleAgents(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth || !(await callerCan(auth.role, CAP['admin.agents.manage']))) {
    error(res, 403, 'Admin role required');
    return;
  }

  const db = getDb();

  if (req.method === 'GET') {
    // Per-agent token listing (metadata only — never the secret/hash).
    if (url.searchParams.get('sub') === 'tokens') {
      const id = Number(url.searchParams.get('id'));
      if (!id) {
        error(res, 400, 'Missing id parameter');
        return;
      }
      const tokenRows = await db
        .select()
        .from(agentTokens)
        .where(eq(agentTokens.agentId, id))
        .orderBy(desc(agentTokens.createdAt));
      json(res, 200, { tokens: tokenRows.map(serializeAgentToken) });
      return;
    }

    // Admin view returns *every* row (incl. suspended / deactivated)
    // with linked user metadata so the admin can re-activate or
    // repair entries.
    const rows = await db
      .select({
        id: agents.id,
        userId: agents.userId,
        name: agents.name,
        nameEn: agents.nameEn,
        slug: agents.slug,
        description: agents.description,
        descriptionEn: agents.descriptionEn,
        maintainerUserId: agents.maintainerUserId,
        status: agents.status,
        statusChangedBy: agents.statusChangedBy,
        statusChangedAt: agents.statusChangedAt,
        statusChangeReason: agents.statusChangeReason,
        preSuspensionRole: agents.preSuspensionRole,
        hooksEnabled: agents.hooksEnabled,
        selfReviewEnabled: agents.selfReviewEnabled,
        modelTier: agents.modelTier,
        createdAt: agents.createdAt,
        username: users.username,
        email: users.email,
        userRole: users.role,
      })
      .from(agents)
      .leftJoin(users, eq(users.id, agents.userId))
      .orderBy(agents.name);

    // Pull recent history rows in one query and group on the
    // application side; cheaper than per-agent LATERAL subselects on
    // neon-http and keeps the admin GET as a flat JSON payload.
    type HistoryRow = {
      id: number;
      agentId: number;
      fromStatus: string | null;
      toStatus: string;
      changedBy: number | null;
      changedAt: Date;
      reason: string | null;
    };
    const historyByAgent = new Map<number, HistoryRow[]>();
    if (rows.length > 0) {
      const agentIds = rows.map((r) => r.id);
      // Bound the fetch at "latest 5 per agent" via a window function
      // so the payload doesn't grow with the global history table.
      // Expand the agent-id list into discrete `IN ($1, $2, …)` params:
      // passing the JS array straight to ANY(${arr}) via db.execute()
      // makes neon-http serialize it as a string ("1") which Postgres
      // rejects with `malformed array literal`. sql.join binds each
      // id as its own integer parameter, so a single-element list also
      // works. db.execute returns plain objects (no Date coercion) so
      // we map columns explicitly; Postgres returns timestamps as
      // strings here, hence the explicit Date construction.
      const idsList = sql.join(
        agentIds.map((id) => sql`${id}`),
        sql`, `,
      );
      const raw = await db.execute(sql`
        SELECT id, agent_id, from_status, to_status, changed_by, changed_at, reason
        FROM (
          SELECT id, agent_id, from_status, to_status, changed_by, changed_at, reason,
                 ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY changed_at DESC) AS rn
          FROM agent_status_history
          WHERE agent_id IN (${idsList})
        ) ranked
        WHERE rn <= 5
        ORDER BY agent_id, changed_at DESC
      `);
      const historyRows: HistoryRow[] = (
        raw.rows as Array<Record<string, unknown>>
      ).map((r) => ({
        id: Number(r.id),
        agentId: Number(r.agent_id),
        fromStatus: r.from_status as string | null,
        toStatus: r.to_status as string,
        changedBy: r.changed_by == null ? null : Number(r.changed_by),
        changedAt: new Date(r.changed_at as string),
        reason: r.reason as string | null,
      }));
      for (const row of historyRows) {
        const arr = historyByAgent.get(row.agentId);
        if (arr) {
          arr.push(row);
        } else {
          historyByAgent.set(row.agentId, [row]);
        }
      }
    }

    const enriched = rows.map((r) => ({
      ...r,
      statusChangedAt: r.statusChangedAt
        ? r.statusChangedAt.toISOString()
        : null,
      createdAt: r.createdAt.toISOString(),
      history: (historyByAgent.get(r.id) ?? []).map((h) => ({
        id: h.id,
        fromStatus: h.fromStatus,
        toStatus: h.toStatus,
        changedBy: h.changedBy,
        changedAt: h.changedAt.toISOString(),
        reason: h.reason,
      })),
    }));
    json(res, 200, { agents: enriched });
    return;
  }

  if (req.method === 'POST') {
    // Token + role actions are agent-scoped POSTs distinguished by
    // ?action=; the default (no action) is agent creation.
    const postAction = url.searchParams.get('action');
    if (
      postAction === 'issue-token' ||
      postAction === 'revoke-token' ||
      postAction === 'set-role'
    ) {
      const id = Number(url.searchParams.get('id'));
      if (!id) {
        error(res, 400, 'Missing id parameter');
        return;
      }
      try {
        if (postAction === 'issue-token') {
          const parsed = await parseAndValidate(req, issueAgentTokenSchema);
          if ('error' in parsed) {
            error(res, 400, parsed.error);
            return;
          }
          const expiresAt = new Date(
            Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000,
          );
          const { token, row } = await issueAgentToken({
            agentId: id,
            label: parsed.data.label ?? null,
            expiresAt,
            actorId: auth.userId,
          });
          // `token` (plaintext) is returned exactly once and never again.
          json(res, 201, { token, tokenMeta: serializeAgentToken(row) });
          return;
        }
        if (postAction === 'revoke-token') {
          const parsed = await parseAndValidate(req, revokeAgentTokenSchema);
          if ('error' in parsed) {
            error(res, 400, parsed.error);
            return;
          }
          const row = await revokeAgentToken({
            agentId: id,
            tokenId: parsed.data.tokenId,
            actorId: auth.userId,
          });
          json(res, 200, { tokenMeta: serializeAgentToken(row) });
          return;
        }
        // set-role
        const parsed = await parseAndValidate(req, setAgentRoleSchema);
        if ('error' in parsed) {
          error(res, 400, parsed.error);
          return;
        }
        const result = await setAgentRole({
          agentId: id,
          role: parsed.data.role,
          actorId: auth.userId,
        });
        json(res, 200, { agent: result.agent, role: result.role });
        return;
      } catch (err) {
        if (err instanceof AgentAdminError) {
          error(res, err.status, err.message, err.code);
          return;
        }
        throw err;
      }
    }

    const parsed = await parseAndValidate(req, createAgentSchema);
    if ('error' in parsed) {
      error(res, 400, parsed.error);
      return;
    }
    const data = parsed.data;
    const slug = data.slug ?? generateSlug(data.name);
    if (!/^[a-z0-9-]+$/.test(slug)) {
      error(res, 400, 'Generated slug is invalid; supply an explicit slug');
      return;
    }

    if (data.maintainerUserId) {
      const [maintainer] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, data.maintainerUserId))
        .limit(1);
      if (!maintainer) {
        error(res, 400, 'Maintainer user not found');
        return;
      }
    }

    // Preflight slug uniqueness BEFORE inserting the user row — without
    // this, a late slug collision (after the users insert succeeded)
    // leaves an orphan verified user in the table with no agent row,
    // and that orphan blocks future retries on the same email/username.
    // The race window between this check and the agent insert is
    // covered by an explicit cleanup in the catch branch below.
    const [existingSlug] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.slug, slug))
      .limit(1);
    if (existingSlug) {
      error(res, 409, 'Slug already in use', 'agent_slug_conflict');
      return;
    }

    let createdUserId: number | null = null;
    try {
      const [user] = await db
        .insert(users)
        .values({
          email: data.email,
          username: data.username,
          role: data.role,
          // Mark the email pre-verified — agents don't go through the
          // magic-link flow. The backing operator owns the address.
          emailVerifiedAt: new Date(),
        })
        .returning({ id: users.id });
      if (!user) throw new Error('failed to create user row');
      createdUserId = user.id;

      // A new active agent enlarges the pool consensus counts, so it is
      // inserted under the pool lock a consensus re-check shares
      // (withAgentPoolGrowthLock): an approval being re-checked never counts
      // a pool this insert is about to change.
      const agentRow = await withAgentPoolGrowthLock(async () => {
        const [created] = await getDb()
          .insert(agents)
          .values({
            userId: user.id,
            name: data.name,
            nameEn: data.nameEn ?? null,
            slug,
            description: data.description ?? null,
            descriptionEn: data.descriptionEn ?? null,
            maintainerUserId: data.maintainerUserId ?? null,
            modelTier: data.modelTier ?? null,
            status: 'active',
            statusChangedBy: auth.userId,
            statusChangedAt: new Date(),
          })
          .returning();

        // Seed the audit log with the "created → active" transition so
        // every state change is reflected in agent_status_history,
        // including the initial one.
        if (created) {
          await getDb().insert(agentStatusHistory).values({
            agentId: created.id,
            fromStatus: null,
            toStatus: 'active',
            changedBy: auth.userId,
            reason: null,
          });
        }
        return created;
      });

      json(res, 201, { agent: agentRow, user });
    } catch (err: unknown) {
      // Roll back the orphan user row when the agent insert is what
      // failed (slug race, FK error, etc.). If the user insert itself
      // failed, createdUserId is still null and there's nothing to
      // clean up.
      if (createdUserId !== null) {
        await db.delete(users).where(eq(users.id, createdUserId));
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('unique') || message.includes('duplicate')) {
        error(
          res,
          409,
          'Agent username, email, or slug already in use',
          'agent_already_exists',
        );
        return;
      }
      throw err;
    }
    return;
  }

  if (req.method === 'PATCH') {
    const id = Number(url.searchParams.get('id'));
    if (!id) {
      error(res, 400, 'Missing id parameter');
      return;
    }

    // Two distinct PATCH shapes:
    //   ?action=transition  → status lifecycle change, audited
    //   (default)           → display-field edit, no audit row
    const action = url.searchParams.get('action');
    if (action === 'transition') {
      const parsed = await parseAndValidate(req, transitionAgentStatusSchema);
      if ('error' in parsed) {
        error(res, 400, parsed.error);
        return;
      }
      try {
        const result = await transitionAgentStatus({
          agentId: id,
          to: parsed.data.status,
          actorId: auth.userId,
          reason: parsed.data.reason ?? null,
        });
        json(res, 200, { agent: result.agent, history: result.history });
      } catch (err) {
        if (err instanceof AgentTransitionError) {
          if (err.code === 'agent_not_found') {
            error(res, 404, err.message, 'agent_not_found');
            return;
          }
          if (err.code === 'status_conflict') {
            error(res, 409, err.message, 'status_conflict');
            return;
          }
          error(res, 400, err.message, err.code);
          return;
        }
        throw err;
      }
      return;
    }

    const parsed = await parseAndValidate(req, patchAgentSchema);
    if ('error' in parsed) {
      error(res, 400, parsed.error);
      return;
    }
    const data = parsed.data;

    if (data.maintainerUserId) {
      const [maintainer] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, data.maintainerUserId))
        .limit(1);
      if (!maintainer) {
        error(res, 400, 'Maintainer user not found');
        return;
      }
    }

    const update: Record<string, unknown> = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.nameEn !== undefined) update.nameEn = data.nameEn;
    if (data.slug !== undefined) update.slug = data.slug;
    if (data.description !== undefined) update.description = data.description;
    if (data.descriptionEn !== undefined)
      update.descriptionEn = data.descriptionEn;
    if (data.maintainerUserId !== undefined) {
      update.maintainerUserId = data.maintainerUserId;
    }
    if (data.hooksEnabled !== undefined)
      update.hooksEnabled = data.hooksEnabled;
    if (data.selfReviewEnabled !== undefined)
      update.selfReviewEnabled = data.selfReviewEnabled;
    if (data.modelTier !== undefined) update.modelTier = data.modelTier;
    update.updatedAt = new Date();

    try {
      const { updated, touched } = await updateAgentWithTierRestamp(id, update);
      if (!updated) {
        error(res, 404, 'Agent not found');
        return;
      }
      // The tier change and the re-stamp of this agent's pending verdicts
      // committed together (see updateAgentWithTierRestamp). Now re-run
      // consensus on those edits rather than waiting for another approval
      // that may never come (issue #1357). `touched` already only carries
      // publishable approvals (see restampPendingVerdictTiers), which keeps
      // this bounded in practice to this one agent's own still-pending
      // approvals — not capped further and handed to the periodic sweep,
      // because the sweep's oldest-first candidate window can itself be
      // monopolized by older held rows (issue #1367) and would then never
      // reach these at all (issue #1369's review).
      for (const pendingEditId of new Set(touched)) {
        try {
          await retryAgentConsensus(pendingEditId);
        } catch (err) {
          console.error(
            `[agent-consensus] retry after tier change failed for ${pendingEditId}`,
            err,
          );
        }
      }
      json(res, 200, { agent: updated });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('unique') || message.includes('duplicate')) {
        error(res, 409, 'Slug already in use', 'agent_slug_conflict');
        return;
      }
      throw err;
    }
    return;
  }

  if (req.method === 'DELETE') {
    const id = Number(url.searchParams.get('id'));
    if (!id) {
      error(res, 400, 'Missing id parameter');
      return;
    }
    // Soft-delete: transition into the terminal `deactivated` state.
    // The row is retained so drug_parameter_revisions / pending_edits
    // FK back to users.id stay intact; the backing user is demoted
    // and a history row is recorded inside `transitionAgentStatus`.
    const rawReason = url.searchParams.get('reason');
    try {
      await transitionAgentStatus({
        agentId: id,
        to: 'deactivated',
        actorId: auth.userId,
        reason: rawReason ?? null,
      });
      json(res, 200, { deactivated: true });
    } catch (err) {
      if (err instanceof AgentTransitionError) {
        if (err.code === 'agent_not_found') {
          error(res, 404, err.message, 'agent_not_found');
          return;
        }
        error(res, 400, err.message, err.code);
        return;
      }
      throw err;
    }
    return;
  }

  error(res, 405, 'Method not allowed');
}

async function handleAllowedEmails(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth || !(await callerCan(auth.role, CAP['admin.allowlist.manage']))) {
    error(res, 403, 'Admin role required');
    return;
  }

  const db = getDb();

  if (req.method === 'GET') {
    const rows = await db
      .select()
      .from(allowedEmails)
      .orderBy(allowedEmails.email);
    json(res, 200, { emails: rows });
    return;
  }

  if (req.method === 'POST') {
    const parsed = await parseAndValidate(req, addAllowedEmailSchema);
    if ('error' in parsed) {
      error(res, 400, parsed.error);
      return;
    }
    try {
      const [row] = await db
        .insert(allowedEmails)
        .values({
          email: parsed.data.email.toLowerCase(),
          addedBy: auth.userId,
        })
        .returning();
      json(res, 201, { email: row });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('unique') || message.includes('duplicate')) {
        error(res, 409, 'Email already on allowlist');
      } else {
        error(res, 500, 'Failed to add email');
      }
    }
    return;
  }

  if (req.method === 'DELETE') {
    const id = Number(url.searchParams.get('id'));
    if (!id) {
      error(res, 400, 'Missing id parameter');
      return;
    }
    await db.delete(allowedEmails).where(eq(allowedEmails.id, id));
    json(res, 200, { deleted: true });
    return;
  }

  error(res, 405, 'Method not allowed');
}

// ─── Agent hook runs (#345) ────────────────────────────────────────────────
//
// Read-only view onto `agent_hook_runs` so admins can audit the
// Claude Code routine fire endpoint's health. Supports optional
// `outcome` (success|failed|skipped) and `event` filters plus simple
// `limit` pagination (default 50, max 200).

async function handleGroups(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth || !(await callerCan(auth.role, CAP['admin.groups.manage']))) {
    error(res, 403, 'Admin role required');
    return;
  }

  const db = getDb();

  if (req.method === 'GET') {
    const groups = await db.select().from(userGroups).orderBy(userGroups.name);
    const membersByGroup = new Map<
      number,
      Array<{ id: number; email: string; username: string; role: string }>
    >();

    if (groups.length > 0) {
      const rows = await db
        .select({
          groupId: userGroupMembers.groupId,
          id: users.id,
          email: users.email,
          username: users.username,
          role: users.role,
        })
        .from(userGroupMembers)
        .innerJoin(users, eq(users.id, userGroupMembers.userId))
        .where(
          inArray(
            userGroupMembers.groupId,
            groups.map((g) => g.id),
          ),
        )
        .orderBy(users.username);

      for (const row of rows) {
        const arr = membersByGroup.get(row.groupId) ?? [];
        arr.push({
          id: row.id,
          email: row.email,
          username: row.username,
          role: row.role,
        });
        membersByGroup.set(row.groupId, arr);
      }
    }

    json(res, 200, {
      groups: groups.map((group) => ({
        ...group,
        createdAt: group.createdAt.toISOString(),
        updatedAt: group.updatedAt.toISOString(),
        members: membersByGroup.get(group.id) ?? [],
      })),
    });
    return;
  }

  if (req.method === 'POST') {
    const parsed = await parseAndValidate(req, createUserGroupSchema);
    if ('error' in parsed) {
      error(res, 400, parsed.error);
      return;
    }

    const slug = parsed.data.slug ?? generateSlug(parsed.data.name);
    if (!/^[a-z0-9-]+$/.test(slug)) {
      error(res, 400, 'Generated slug is invalid; supply an explicit slug');
      return;
    }

    try {
      const [group] = await db
        .insert(userGroups)
        .values({
          slug,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
        })
        .returning();
      json(res, 201, { group });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('unique') || message.includes('duplicate')) {
        error(res, 409, 'Group slug already exists');
        return;
      }
      throw err;
    }
    return;
  }

  if (req.method === 'PATCH') {
    const groupId = Number(url.searchParams.get('id'));
    if (!groupId) {
      error(res, 400, 'Missing id parameter');
      return;
    }

    const parsed = await parseAndValidate(req, patchUserGroupMembersSchema);
    if ('error' in parsed) {
      error(res, 400, parsed.error);
      return;
    }

    const [group] = await db
      .select({ id: userGroups.id })
      .from(userGroups)
      .where(eq(userGroups.id, groupId))
      .limit(1);
    if (!group) {
      error(res, 404, 'Group not found');
      return;
    }

    const userIds = [...new Set(parsed.data.userIds)];
    if (userIds.length > 0) {
      const existing = await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, userIds));
      if (existing.length !== userIds.length) {
        error(res, 400, 'One or more users do not exist');
        return;
      }
    }

    // Atomic multi-statement replacement via neon's HTTP batch transaction
    // (BEGIN/statements/COMMIT in one HTTP call). Sibling CTEs share the
    // same snapshot so DELETE + INSERT in one WITH would still see the
    // pre-delete row and fail with a unique-key error for any member that
    // is retained across the save. Sequential statements in a real
    // transaction don't have this problem.
    const neonSql = getNeonClient();
    const stmts: ReturnType<typeof neonSql>[] = [
      neonSql`DELETE FROM user_group_members WHERE group_id = ${groupId}`,
    ];
    if (userIds.length > 0) {
      // Build VALUES rows individually so we get proper parameterisation
      // rather than relying on neon's array unnest handling.
      stmts.push(
        neonSql`INSERT INTO user_group_members (group_id, user_id, added_by)
          SELECT ${groupId}, uid, ${auth.userId}
          FROM unnest(${userIds}::int[]) AS uid`,
      );
    }
    stmts.push(
      neonSql`UPDATE user_groups SET updated_at = NOW() WHERE id = ${groupId}`,
    );
    await neonSql.transaction(stmts);

    const [updated] = await db
      .select()
      .from(userGroups)
      .where(eq(userGroups.id, groupId));
    json(res, 200, { group: updated });
    return;
  }

  if (req.method === 'DELETE') {
    const groupId = Number(url.searchParams.get('id'));
    if (!groupId) {
      error(res, 400, 'Missing id parameter');
      return;
    }
    await db.delete(userGroups).where(eq(userGroups.id, groupId));
    json(res, 200, { deleted: true });
    return;
  }

  error(res, 405, 'Method not allowed');
}

const HOOK_RUN_OUTCOMES = new Set(['success', 'failed', 'skipped']);

async function handleAgentHookRuns(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (
    !auth ||
    !(await callerCan(auth.role, CAP['admin.agentHookRuns.read']))
  ) {
    error(res, 403, 'Admin role required');
    return;
  }
  if (req.method !== 'GET') {
    error(res, 405, 'Method not allowed');
    return;
  }
  const db = getDb();

  const limitParam = Number(url.searchParams.get('limit'));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(200, Math.floor(limitParam))
      : 50;
  const outcomeFilter = url.searchParams.get('outcome');
  const eventFilter = url.searchParams.get('event');

  const conditions = [];
  if (outcomeFilter) {
    if (!HOOK_RUN_OUTCOMES.has(outcomeFilter)) {
      error(res, 400, 'Invalid outcome filter');
      return;
    }
    conditions.push(eq(agentHookRuns.outcome, outcomeFilter));
  }
  if (eventFilter) {
    conditions.push(eq(agentHookRuns.event, eventFilter));
  }

  const query = db
    .select({
      id: agentHookRuns.id,
      event: agentHookRuns.event,
      targetType: agentHookRuns.targetType,
      targetId: agentHookRuns.targetId,
      outcome: agentHookRuns.outcome,
      httpStatus: agentHookRuns.httpStatus,
      errorMessage: agentHookRuns.errorMessage,
      durationMs: agentHookRuns.durationMs,
      createdAt: agentHookRuns.createdAt,
    })
    .from(agentHookRuns);
  const rows = await (
    conditions.length > 0 ? query.where(and(...conditions)) : query
  )
    .orderBy(desc(agentHookRuns.createdAt))
    .limit(limit);

  json(res, 200, {
    runs: rows.map((r) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}
