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
 * What a case payload's drug references resolved to. `keyIds` / `slugIds`
 * map every requested ref to the sorted ids of the drugs it matched (empty
 * when it matched none), so two resolutions can be compared ref by ref.
 */
export interface CaseDrugResolution {
  drugIds: number[];
  keyIds: Map<string, number[]>;
  slugIds: Map<string, number[]>;
  missingKeys: string[];
  missingSlugs: string[];
}

/**
 * Resolve every drug reference in a case payload to a canonical drug id.
 * Returns the found ids, the per-ref mapping and the requested refs that
 * didn't resolve — the caller uses the missing set to build the 409 error,
 * the id set to take per-drug advisory locks in a well-defined order in the
 * save transaction below, and the mapping to notice a ref that moved while
 * it waited for those locks.
 */
async function resolveCaseDrugRefs(
  db: ReturnType<typeof getDb>,
  caseData: Record<string, unknown>,
): Promise<CaseDrugResolution> {
  const { keys, slugs } = extractCaseDrugRefs(caseData);
  // Nothing queryable (no refs, or only keys that are neither `drug:<id>` nor
  // a positive integer): nothing to lock and, as before, nothing reported.
  const empty = (): CaseDrugResolution => ({
    drugIds: [],
    keyIds: new Map(),
    slugIds: new Map(),
    missingKeys: [],
    missingSlugs: [],
  });
  if (keys.size === 0 && slugs.size === 0) return empty();
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
  if (conditions.length === 0) return empty();
  const rows = await db
    .select({ id: drugs.id, pubchemCid: drugs.pubchemCid, slug: drugs.slug })
    .from(drugs)
    .where(or(...conditions));
  const keyIds = new Map<string, Set<number>>([...keys].map((k) => [k, new Set()]));
  const slugIds = new Map<string, Set<number>>([...slugs].map((s) => [s, new Set()]));
  const drugIds = new Set<number>();
  for (const r of rows) {
    // Every spelling this row could legitimately be referenced by — id and
    // pubchemCid are both globally unique, so matching on all of them can
    // never attribute a different drug's key to this row.
    const spellings = [String(r.id), `drug:${r.id}`];
    if (r.pubchemCid != null) spellings.push(String(r.pubchemCid));
    for (const s of spellings) keyIds.get(s)?.add(r.id);
    if (r.slug) slugIds.get(r.slug)?.add(r.id);
    drugIds.add(r.id);
  }
  const sorted = (ids: Set<number>) => [...ids].sort((a, b) => a - b);
  const keyMap = new Map([...keyIds].map(([k, ids]) => [k, sorted(ids)]));
  const slugMap = new Map([...slugIds].map(([s, ids]) => [s, sorted(ids)]));
  return {
    drugIds: sorted(drugIds),
    keyIds: keyMap,
    slugIds: slugMap,
    missingKeys: [...keyMap].filter(([, ids]) => ids.length === 0).map(([k]) => k),
    missingSlugs: [...slugMap].filter(([, ids]) => ids.length === 0).map(([s]) => s),
  };
}

/**
 * Compare the resolution taken before the per-drug locks with the one taken
 * under them. Returns null when every ref still names the same drug(s) and
 * the id set is unchanged; otherwise the refs whose mapping moved. A non-null
 * result with both lists empty means the id sets differ without any single
 * ref accounting for it — still a change, still refused.
 */
export function caseDrugResolutionDrift(
  before: Pick<CaseDrugResolution, 'drugIds' | 'keyIds' | 'slugIds'>,
  after: Pick<CaseDrugResolution, 'drugIds' | 'keyIds' | 'slugIds'>,
): { changedKeys: string[]; changedSlugs: string[] } | null {
  const sameIds = (a: readonly number[] | undefined, b: readonly number[] | undefined) =>
    (a ?? []).length === (b ?? []).length &&
    (a ?? []).every((id, i) => id === (b ?? [])[i]);
  const changed = (
    x: ReadonlyMap<string, number[]>,
    y: ReadonlyMap<string, number[]>,
  ) =>
    [...new Set([...x.keys(), ...y.keys()])].filter(
      (ref) => !sameIds(x.get(ref), y.get(ref)),
    );
  const changedKeys = changed(before.keyIds, after.keyIds);
  const changedSlugs = changed(before.slugIds, after.slugIds);
  if (
    changedKeys.length === 0 &&
    changedSlugs.length === 0 &&
    sameIds(before.drugIds, after.drugIds)
  ) {
    return null;
  }
  return { changedKeys, changedSlugs };
}

/**
 * Save a case inside a transaction that holds `lockDrugForEntryApplicability`
 * on every referenced drug (sorted, so a merge and multiple concurrent
 * saves can't deadlock) and re-resolves every ref AFTER acquiring the lock.
 *
 * The outer resolve-drugs pass rejects the common shape (a case authored
 * against a since-deleted drug) and picks which drugs to lock, but it runs
 * unlocked. A writer holding one of those locks — a merge deleting the drug,
 * a merge `--adopt-cid` or `retarget:cid` moving its CID and rewriting the
 * saved cases — can commit between that pass and the lock grant. Checking
 * only that the locked ids still exist is not enough: after a CID move the
 * drug is still there, but the case's bare-CID key no longer names it, and
 * the writer's one rewrite of `simulator_cases` has already run. So the refs
 * are resolved again under the lock: one that no longer resolves returns
 * `missing`, and one that now resolves differently returns `changed` — the
 * locks held are then for the wrong drugs, so the save is refused (409)
 * rather than continued, and the client re-selects and saves again.
 */
async function saveCaseWithMergeLock<T>(
  caseData: Record<string, unknown>,
  work: () => Promise<T>,
): Promise<
  | { kind: 'ok'; result: T }
  | { kind: 'missing'; missingKeys: string[]; missingSlugs: string[] }
  | { kind: 'changed'; changedKeys: string[]; changedSlugs: string[] }
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
    // Re-resolve under the lock, on the transaction's own client.
    const locked = await resolveCaseDrugRefs(getDb(), caseData);
    if (locked.missingKeys.length > 0 || locked.missingSlugs.length > 0) {
      return {
        kind: 'missing' as const,
        missingKeys: locked.missingKeys,
        missingSlugs: locked.missingSlugs,
      };
    }
    const drift = caseDrugResolutionDrift(resolved, locked);
    if (drift) return { kind: 'changed' as const, ...drift };
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

function respondCaseDrugChanged(
  res: ServerResponse,
  changed: { changedKeys: string[]; changedSlugs: string[] },
): void {
  const detail = [
    ...changed.changedKeys.map((k) => `drugId=${k}`),
    ...changed.changedSlugs.map((s) => `analyte=${s}`),
  ].join(', ');
  error(
    res,
    409,
    `Case references drug(s) that changed while it was being saved${detail ? `: ${detail}` : ''}. Reload the drug picker, re-select the entry and save again.`,
    'case_drug_changed',
  );
}

function respondCaseDrugConflict(
  res: ServerResponse,
  outcome:
    | { kind: 'missing'; missingKeys: string[]; missingSlugs: string[] }
    | { kind: 'changed'; changedKeys: string[]; changedSlugs: string[] },
): void {
  if (outcome.kind === 'missing') respondCaseDrugMissing(res, outcome);
  else respondCaseDrugChanged(res, outcome);
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
  if (outcome.kind !== 'ok') {
    respondCaseDrugConflict(res, outcome);
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
  if (outcome.kind !== 'ok') {
    respondCaseDrugConflict(res, outcome);
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
