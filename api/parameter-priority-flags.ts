/**
 * Parameter priority flags — moderators/admins push specific (drug, parameter)
 * pairs to the front of the kinetix-agent's queue. The agent's prioritization
 * loop (§3 in agents/drug-db-maintainer.md) selects active flags before any
 * popularity-based bucket.
 *
 * `parameter` is any agent work target (`_lib/agent-work-targets.ts`): a
 * `DrugParameterId`, or one of the relationship-shaped coverage areas
 * (`metabolism`, `pharmacodynamics`) that have no parameter id because they
 * have no single value to pool. NULL still means the whole drug.
 *
 *   GET    /api/parameter-priority-flags                       — list (any auth)
 *   GET    /api/parameter-priority-flags?drugId=&parameter=    — single lookup (any auth)
 *   POST   /api/parameter-priority-flags                       — create (editor/admin)
 *   PATCH  /api/parameter-priority-flags?id=N                  — update status/note (editor/admin)
 *   DELETE /api/parameter-priority-flags?id=N                  — cancel (editor/admin)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import {
  createParameterPriorityFlagSchema,
  patchParameterPriorityFlagSchema,
} from './_lib/schemas.js';
import { drugs, parameterPriorityFlags, users, agents } from '../db/schema.js';
import { isAgentWorkTarget } from './_lib/agent-work-targets.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import { resolveDrugName } from '../src/lib/drugNames.js';

async function isModerator(role: string): Promise<boolean> {
  return callerCan(role, CAP['parameterFlag.write']);
}

type Row = typeof parameterPriorityFlags.$inferSelect;

type DrugRef = { id: number; names: Record<string, string> };
type UserRef = {
  id: number;
  username: string;
  displayName: string | null;
  role: string;
  isAgent: boolean;
};

/**
 * Build the enriched flag record from pre-fetched lookup maps. Pure and
 * synchronous so the drug-name resolution is unit-testable without a DB.
 */
export function mapEnrichedFlag(
  row: Row,
  drugById: Map<number, DrugRef>,
  userById: Map<number, UserRef>,
): Record<string, unknown> {
  return {
    ...row,
    // Resolve in the site's primary language (Norwegian) — this admin panel is
    // a Norwegian-default moderation surface. resolveDrugName falls back to
    // English when no 'nb' name exists. Matches the /review queues.
    drugName: drugById.has(row.drugId)
      ? resolveDrugName(drugById.get(row.drugId)!.names, 'nb')
      : null,
    flaggedByUser: row.flaggedBy ? (userById.get(row.flaggedBy) ?? null) : null,
    resolvedByUser: row.resolvedBy
      ? (userById.get(row.resolvedBy) ?? null)
      : null,
  };
}

async function enrich(rows: Row[]): Promise<Array<Record<string, unknown>>> {
  if (rows.length === 0) return [];
  const db = getDb();
  const drugIds = Array.from(new Set(rows.map((r) => r.drugId)));
  const userIds = Array.from(
    new Set(
      rows
        .flatMap((r) => [r.flaggedBy, r.resolvedBy])
        .filter((v): v is number => typeof v === 'number'),
    ),
  );

  const [drugRows, userRows] = await Promise.all([
    drugIds.length
      ? db
          .select({ id: drugs.id, names: drugs.names })
          .from(drugs)
          .where(inArray(drugs.id, drugIds))
      : Promise.resolve(
          [] as Array<{ id: number; names: Record<string, string> }>,
        ),
    userIds.length
      ? db
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            // Email omitted — GET on this endpoint is accessible to any
            // authenticated user (role=authenticated and above), so including
            // email would let low-privilege accounts harvest moderator and
            // editor addresses by scanning priority flags. Same rationale as
            // the wiki-pages, pending-edits, agents, and drug-discussions
            // endpoints.
            role: users.role,
            isAgent: sql<boolean>`${agents.id} is not null`,
          })
          .from(users)
          .leftJoin(agents, eq(agents.userId, users.id))
          .where(inArray(users.id, userIds))
      : Promise.resolve(
          [] as Array<{
            id: number;
            username: string;
            displayName: string | null;
            role: string;
            isAgent: boolean;
          }>,
        ),
  ]);

  const drugById = new Map(drugRows.map((d) => [d.id, d]));
  const userById = new Map(userRows.map((u) => [u.id, u]));

  return rows.map((r) => mapEnrichedFlag(r, drugById, userById));
}

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    switch (req.method) {
      case 'GET':
        return handleList(req, res, url);
      case 'POST':
        assertSameOrigin(req);
        return handleCreate(req, res);
      case 'PATCH':
        assertSameOrigin(req);
        return handlePatch(req, res, url);
      case 'DELETE':
        assertSameOrigin(req);
        return handleDelete(req, res, url);
      default:
        error(res, 405, 'Method not allowed');
    }
  },
);

async function handleList(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }

  const db = getDb();
  const status = url.searchParams.get('status');
  const drugIdParam = url.searchParams.get('drugId');
  const parameterParam = url.searchParams.get('parameter');

  const conditions = [];
  if (status && status !== 'all') {
    conditions.push(eq(parameterPriorityFlags.status, status));
  } else if (!status) {
    // Default: only active flags so the agent + UI consume the queue.
    conditions.push(eq(parameterPriorityFlags.status, 'active'));
  }
  if (drugIdParam) {
    const drugId = Number(drugIdParam);
    if (!Number.isFinite(drugId)) {
      error(res, 400, 'Invalid drugId');
      return;
    }
    conditions.push(eq(parameterPriorityFlags.drugId, drugId));
  }
  if (parameterParam !== null) {
    if (parameterParam === '' || parameterParam === 'null') {
      conditions.push(isNull(parameterPriorityFlags.parameter));
    } else {
      if (!isAgentWorkTarget(parameterParam)) {
        error(res, 400, 'Invalid parameter');
        return;
      }
      conditions.push(eq(parameterPriorityFlags.parameter, parameterParam));
    }
  }

  const rows = await db
    .select()
    .from(parameterPriorityFlags)
    .where(conditions.length ? and(...conditions) : undefined)
    // Oldest active flags first — preserves moderator-set FIFO order.
    .orderBy(
      asc(parameterPriorityFlags.createdAt),
      desc(parameterPriorityFlags.id),
    )
    .limit(200);

  json(res, 200, { flags: await enrich(rows) });
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  if (!(await isModerator(auth.role))) {
    error(res, 403, 'Editor or admin role required');
    return;
  }

  const parsed = await parseAndValidate(req, createParameterPriorityFlagSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  if (parsed.data.parameter && !isAgentWorkTarget(parsed.data.parameter)) {
    error(res, 400, 'Invalid parameter id');
    return;
  }

  const db = getDb();
  const [drug] = await db
    .select({ id: drugs.id })
    .from(drugs)
    .where(eq(drugs.id, parsed.data.drugId))
    .limit(1);
  if (!drug) {
    error(res, 404, 'Drug not found');
    return;
  }

  // Suppress duplicate active flags for the same (drug, parameter) tuple — the
  // queue should reflect the most recent moderator intent without piling up.
  const dupeConditions = [
    eq(parameterPriorityFlags.drugId, parsed.data.drugId),
    eq(parameterPriorityFlags.status, 'active'),
  ];
  if (parsed.data.parameter) {
    dupeConditions.push(
      eq(parameterPriorityFlags.parameter, parsed.data.parameter),
    );
  } else {
    dupeConditions.push(isNull(parameterPriorityFlags.parameter));
  }
  const [existing] = await db
    .select()
    .from(parameterPriorityFlags)
    .where(and(...dupeConditions))
    .limit(1);

  if (existing) {
    if (parsed.data.note !== undefined) {
      await db
        .update(parameterPriorityFlags)
        .set({ note: parsed.data.note ?? null })
        .where(eq(parameterPriorityFlags.id, existing.id));
    }
    const [enriched] = await enrich([
      { ...existing, note: parsed.data.note ?? existing.note },
    ]);
    json(res, 200, { flag: enriched });
    return;
  }

  const [row] = await db
    .insert(parameterPriorityFlags)
    .values({
      drugId: parsed.data.drugId,
      parameter: parsed.data.parameter ?? null,
      note: parsed.data.note ?? null,
      flaggedBy: auth.userId,
    })
    .returning();
  if (!row) throw new Error('parameterPriorityFlags insert returned no row');

  const [enriched] = await enrich([row]);
  json(res, 201, { flag: enriched });
}

async function handlePatch(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  if (!(await isModerator(auth.role))) {
    error(res, 403, 'Editor or admin role required');
    return;
  }

  const id = Number(url.searchParams.get('id'));
  if (!id) {
    error(res, 400, 'Missing id');
    return;
  }

  const parsed = await parseAndValidate(req, patchParameterPriorityFlagSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const db = getDb();
  const isClosing =
    parsed.data.status === 'resolved' || parsed.data.status === 'cancelled';
  await db
    .update(parameterPriorityFlags)
    .set({
      status: parsed.data.status,
      ...(parsed.data.note !== undefined
        ? { note: parsed.data.note ?? null }
        : {}),
      ...(isClosing
        ? { resolvedBy: auth.userId, resolvedAt: new Date() }
        : { resolvedBy: null, resolvedAt: null }),
    })
    .where(eq(parameterPriorityFlags.id, id));

  const [row] = await db
    .select()
    .from(parameterPriorityFlags)
    .where(eq(parameterPriorityFlags.id, id))
    .limit(1);
  if (!row) {
    error(res, 404, 'Flag not found');
    return;
  }
  const [enriched] = await enrich([row]);
  json(res, 200, { flag: enriched });
}

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  if (!(await isModerator(auth.role))) {
    error(res, 403, 'Editor or admin role required');
    return;
  }

  const id = Number(url.searchParams.get('id'));
  if (!id) {
    error(res, 400, 'Missing id');
    return;
  }

  const db = getDb();
  await db
    .update(parameterPriorityFlags)
    .set({
      status: 'cancelled',
      resolvedBy: auth.userId,
      resolvedAt: new Date(),
    })
    .where(eq(parameterPriorityFlags.id, id));
  json(res, 200, { ok: true });
}
