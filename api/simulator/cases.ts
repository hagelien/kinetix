/**
 * Simulator cases CRUD endpoint.
 *   GET    — List user's cases (no id), get single case (?id=)
 *            • `?kind=…` restricts the list to rows whose
 *              `caseData.kind` matches and includes `caseData` in the
 *              response so the client can validate / render.
 *   POST   — Create new case (requires auth)
 *   PUT    — Update case (?id=, requires auth, must own)
 *   DELETE — Delete case (?id=, requires auth, must own)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq, desc, and, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { json, error, withErrorHandling } from '../_lib/response.js';
import { getDb, runInPoolTransaction } from '../_lib/db.js';
import { getUserFromRequest } from '../_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from '../_lib/validate.js';
import { drugs, simulatorCases } from '../../db/schema.js';
import { lockDrugForEntryApplicability } from '../_lib/parameterApplicabilityStore.js';
import { parseInternalDrugComponentId } from '../../src/lib/drugComponentId.js';

const caseSchema = z.object({
  name: z.string().min(1).max(500),
  caseData: z.record(z.string(), z.unknown()),
});

/**
 * Pull every drug reference the merge fold knows about out of a raw
 * `caseData` payload — matches the two shapes it rewrites when a drug is
 * deleted (see step 10 of `mergeDrugs`):
 *   - Forward-simulator cases: `case_data.drugs[].drugId` is built by
 *     `buildDrugComponentId` — a bare PubChem CID, or (#1256) a `drug:<id>`
 *     internal-id key for a CID-less drug.
 *   - KineLab cases: `case_data.input.analyte` is the drug's slug.
 * These are the only paths the save path can validate without also parsing
 * every downstream engine's schema. Anything else in the JSON is opaque
 * user data.
 */
function extractCaseDrugRefs(
  caseData: Record<string, unknown>,
): { keys: Set<string>; slugs: Set<string> } {
  const keys = new Set<string>();
  const slugs = new Set<string>();
  const drugsArr = caseData.drugs;
  if (Array.isArray(drugsArr)) {
    for (const d of drugsArr) {
      if (d && typeof d === 'object' && 'drugId' in d) {
        const drugId = (d as Record<string, unknown>).drugId;
        if (typeof drugId === 'string' && drugId.length > 0) keys.add(drugId);
      }
    }
  }
  const input = caseData.input;
  if (input && typeof input === 'object') {
    const analyte = (input as Record<string, unknown>).analyte;
    if (
      typeof analyte === 'string' &&
      analyte.length > 0 &&
      caseData.kind === 'kinelab-case'
    ) {
      slugs.add(analyte);
    }
  }
  return { keys, slugs };
}

/**
 * Resolve every drug reference in a case payload to a canonical drug id.
 * Returns the found ids and the requested refs that didn't resolve — the
 * caller uses the missing set to build the 409 error, and the id set to
 * take per-drug advisory locks in a well-defined order in the save
 * transaction below.
 */
async function resolveCaseDrugRefs(
  db: ReturnType<typeof getDb>,
  caseData: Record<string, unknown>,
): Promise<{
  drugIds: number[];
  missingKeys: string[];
  missingSlugs: string[];
}> {
  const { keys, slugs } = extractCaseDrugRefs(caseData);
  if (keys.size === 0 && slugs.size === 0) {
    return { drugIds: [], missingKeys: [], missingSlugs: [] };
  }
  // A `drug:<id>` key (#1256) names an internal id unambiguously and is
  // looked up by id alone. A bare numeric key predates that fix (or names a
  // CID under it) and keeps the old dual lookup, so an already-saved case
  // keyed by a CID-less drug's bare id still resolves.
  const internalIdKeys: number[] = [];
  const legacyNumericKeys: number[] = [];
  for (const key of keys) {
    const internalId = parseInternalDrugComponentId(key);
    if (internalId != null) {
      internalIdKeys.push(internalId);
      continue;
    }
    const n = Number(key);
    if (Number.isInteger(n) && n > 0) legacyNumericKeys.push(n);
  }
  const conditions = [] as ReturnType<typeof and>[];
  if (internalIdKeys.length > 0) {
    conditions.push(inArray(drugs.id, internalIdKeys));
  }
  if (legacyNumericKeys.length > 0) {
    conditions.push(inArray(drugs.id, legacyNumericKeys));
    conditions.push(inArray(drugs.pubchemCid, legacyNumericKeys));
  }
  if (slugs.size > 0) conditions.push(inArray(drugs.slug, Array.from(slugs)));
  if (conditions.length === 0) {
    return { drugIds: [], missingKeys: [], missingSlugs: [] };
  }
  const rows = await db
    .select({ id: drugs.id, pubchemCid: drugs.pubchemCid, slug: drugs.slug })
    .from(drugs)
    .where(or(...conditions));
  const foundKeys = new Set<string>();
  const foundSlugs = new Set<string>();
  const drugIds: number[] = [];
  for (const r of rows) {
    // Every spelling this row could legitimately be referenced by — id and
    // pubchemCid are both globally unique, so adding all of them can never
    // mark a different drug's key as found.
    foundKeys.add(String(r.id));
    foundKeys.add(`drug:${r.id}`);
    if (r.pubchemCid != null) foundKeys.add(String(r.pubchemCid));
    if (r.slug) foundSlugs.add(r.slug);
    drugIds.push(r.id);
  }
  const missingKeys = [...keys].filter((k) => !foundKeys.has(k));
  const missingSlugs = [...slugs].filter((s) => !foundSlugs.has(s));
  return {
    drugIds: Array.from(new Set(drugIds)).sort((a, b) => a - b),
    missingKeys,
    missingSlugs,
  };
}

/**
 * Save a case inside a transaction that holds `lockDrugForEntryApplicability`
 * on every referenced drug (sorted, so a merge and multiple concurrent
 * saves can't deadlock) and re-verifies existence AFTER acquiring the
 * lock. The outer resolve-drugs pass rejects the common shape (a case
 * authored against a since-deleted drug), but a merge that commits
 * between the resolve and the write would otherwise slip a stale ref
 * through — closing that check-to-write window requires validating +
 * saving while holding the same per-drug lock the merge holds. If the
 * lock re-verify fails (a merge committed between the two SELECTs),
 * returns `stale` so the caller responds 409.
 */
async function saveCaseWithMergeLock<T>(
  caseData: Record<string, unknown>,
  work: () => Promise<T>,
): Promise<
  | { kind: 'ok'; result: T }
  | { kind: 'missing'; missingKeys: string[]; missingSlugs: string[] }
> {
  const db = getDb();
  const resolved = await resolveCaseDrugRefs(db, caseData);
  if (resolved.missingKeys.length > 0 || resolved.missingSlugs.length > 0) {
    return {
      kind: 'missing',
      missingKeys: resolved.missingKeys,
      missingSlugs: resolved.missingSlugs,
    };
  }
  if (resolved.drugIds.length === 0) {
    // Nothing to lock — the payload references no drugs.
    return { kind: 'ok', result: await work() };
  }
  return await runInPoolTransaction(async () => {
    for (const drugId of resolved.drugIds) {
      await lockDrugForEntryApplicability(drugId);
    }
    // Re-verify every drug still exists under the lock — a merge that
    // committed between the outer resolve and the lock acquisition would
    // have removed one of them.
    const txDb = getDb();
    const stillRows = await txDb
      .select({ id: drugs.id })
      .from(drugs)
      .where(inArray(drugs.id, resolved.drugIds));
    if (stillRows.length !== resolved.drugIds.length) {
      const foundIds = new Set(stillRows.map((r) => r.id));
      const gone = resolved.drugIds.filter((id) => !foundIds.has(id));
      return {
        kind: 'missing' as const,
        missingKeys: gone.map((id) => String(id)),
        missingSlugs: [],
      };
    }
    return { kind: 'ok' as const, result: await work() };
  });
}

function respondCaseDrugMissing(
  res: ServerResponse,
  missing: { missingKeys: string[]; missingSlugs: string[] },
): void {
  const detail = [
    ...missing.missingKeys.map((k) => `drugId=${k}`),
    ...missing.missingSlugs.map((s) => `analyte=${s}`),
  ].join(', ');
  error(
    res,
    409,
    `Case references drug(s) that no longer exist: ${detail}. Reload the drug picker and re-select the surviving entry.`,
    'case_drug_missing',
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

  switch (req.method) {
    case 'GET':
      return handleGet(req, res, url);
    case 'POST':
      assertSameOrigin(req);
      return handleCreate(req, res);
    case 'PUT':
      assertSameOrigin(req);
      return handleUpdate(req, res, url);
    case 'DELETE':
      assertSameOrigin(req);
      return handleDelete(req, res, url);
    default:
      error(res, 405, 'Method not allowed');
  }
});

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const id = url.searchParams.get('id');
  const user = await getUserFromRequest(req);
  if (!user) return error(res, 401, 'Authentication required');

  if (id) {
    const db = getDb();
    const [row] = await db
      .select()
      .from(simulatorCases)
      .where(
        and(
          eq(simulatorCases.id, Number(id)),
          eq(simulatorCases.createdBy, user.userId),
        ),
      )
      .limit(1);

    if (!row) return error(res, 404, 'Case not found');
    json(res, 200, row);
    return;
  }

  // List — shows only user's cases. When `?kind=…` is supplied (e.g.
  // `?kind=kinelab-case`), restrict to rows whose `case_data->>'kind'`
  // matches and include `caseData` in the response so the client can
  // hydrate. Without `?kind`, keep the legacy slim shape so the existing
  // forward-simulator listing stays cheap.
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 100);
  const offset = Number(url.searchParams.get('offset') ?? 0);
  const kind = url.searchParams.get('kind');
  const db = getDb();

  if (kind) {
    const rows = await db
      .select({
        id: simulatorCases.id,
        name: simulatorCases.name,
        caseData: simulatorCases.caseData,
        createdAt: simulatorCases.createdAt,
        updatedAt: simulatorCases.updatedAt,
      })
      .from(simulatorCases)
      .where(
        and(
          eq(simulatorCases.createdBy, user.userId),
          sql`${simulatorCases.caseData}->>'kind' = ${kind}`,
        ),
      )
      .orderBy(desc(simulatorCases.updatedAt))
      .limit(limit)
      .offset(offset);

    json(res, 200, { cases: rows });
    return;
  }

  const rows = await db
    .select({
      id: simulatorCases.id,
      name: simulatorCases.name,
      createdAt: simulatorCases.createdAt,
      updatedAt: simulatorCases.updatedAt,
    })
    .from(simulatorCases)
    .where(eq(simulatorCases.createdBy, user.userId))
    .orderBy(desc(simulatorCases.updatedAt))
    .limit(limit)
    .offset(offset);

  json(res, 200, { cases: rows });
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const user = await getUserFromRequest(req);
  if (!user) return error(res, 401, 'Authentication required');

  const result = await parseAndValidate(req, caseSchema);
  if ('error' in result) return error(res, 400, result.error);

  const outcome = await saveCaseWithMergeLock(result.data.caseData, async () => {
    const [row] = await getDb()
      .insert(simulatorCases)
      .values({
        name: result.data.name,
        caseData: result.data.caseData,
        createdBy: user.userId,
      })
      .returning();
    return row;
  });
  if (outcome.kind === 'missing') {
    respondCaseDrugMissing(res, outcome);
    return;
  }
  json(res, 201, outcome.result);
}

async function handleUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const user = await getUserFromRequest(req);
  if (!user) return error(res, 401, 'Authentication required');

  const id = Number(url.searchParams.get('id'));
  if (!id) return error(res, 400, 'Missing id parameter');

  const db = getDb();

  // Check ownership
  const [existing] = await db
    .select({ createdBy: simulatorCases.createdBy })
    .from(simulatorCases)
    .where(eq(simulatorCases.id, id))
    .limit(1);

  if (!existing) return error(res, 404, 'Case not found');
  if (existing.createdBy !== user.userId)
    return error(res, 403, 'Not authorized');

  const result = await parseAndValidate(req, caseSchema);
  if ('error' in result) return error(res, 400, result.error);

  const outcome = await saveCaseWithMergeLock(result.data.caseData, async () => {
    const [updated] = await getDb()
      .update(simulatorCases)
      .set({
        name: result.data.name,
        caseData: result.data.caseData,
        updatedAt: new Date(),
      })
      .where(eq(simulatorCases.id, id))
      .returning();
    return updated;
  });
  if (outcome.kind === 'missing') {
    respondCaseDrugMissing(res, outcome);
    return;
  }
  json(res, 200, outcome.result);
}

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const user = await getUserFromRequest(req);
  if (!user) return error(res, 401, 'Authentication required');

  const id = Number(url.searchParams.get('id'));
  if (!id) return error(res, 400, 'Missing id parameter');

  const db = getDb();

  const [existing] = await db
    .select({ createdBy: simulatorCases.createdBy })
    .from(simulatorCases)
    .where(eq(simulatorCases.id, id))
    .limit(1);

  if (!existing) return error(res, 404, 'Case not found');
  if (existing.createdBy !== user.userId)
    return error(res, 403, 'Not authorized');

  await db.delete(simulatorCases).where(eq(simulatorCases.id, id));
  json(res, 200, { deleted: true });
}
