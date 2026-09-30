/**
 * Not-applicable markers — an editor records that a (drug, parameter) pair is
 * not a defined quantity, so it stops counting as a gap.
 *
 *   GET    /api/drug-parameter-applicability?drugId=N   — list (any auth)
 *   PUT    /api/drug-parameter-applicability            — set (editor/admin)
 *   DELETE /api/drug-parameter-applicability?drugId=N&parameter=id — lift
 *
 * This is the pair-level layer of the applicability model in
 * src/lib/parameterApplicability.ts. Most unfillable pairs need no row here:
 * "a substance nobody administers has no bioavailability" is derived from
 * `drugs.substance_class` and covers whole classes at once. Use a marker for
 * the one-offs that rule cannot express.
 *
 * Writing is deliberately editor-gated rather than open to the contributor
 * agents that hit these pairs. Retiring a work item is a scientific judgement,
 * and an agent that could silence its own queue would be able to hide real
 * gaps as easily as impossible ones. The agent's move on an exhaustive-but-
 * empty search is to log concordance='absent' and say so in the parameter
 * discussion thread; that already suppresses the pair for ABSENT_RECHECK_DAYS,
 * which is long enough for a human to see the comment and decide.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq, inArray } from 'drizzle-orm';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { putParameterApplicabilitySchema } from './_lib/schemas.js';
import { drugs, users } from '../db/schema.js';
import { isDrugParameterId } from './_lib/drugParameterIds.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import {
  deleteApplicability,
  listApplicabilityForDrug,
  upsertApplicability,
  withDrugApplicabilityLock,
  type ApplicabilityRow,
} from './_lib/parameterApplicabilityStore.js';
import {
  getDrugParameterValue,
  isStoredInDrugParameters,
} from './_lib/drugParameterStore.js';
import { hasAnyEntryForParameter } from './_lib/parameter-entries-store.js';

async function canWrite(role: string): Promise<boolean> {
  return callerCan(role, CAP['parameterApplicability.write']);
}

/**
 * Attach the setter's display identity. Email is omitted deliberately — GET is
 * open to any authenticated user, and the same harvesting concern applies here
 * as on the priority-flags endpoint.
 */
async function enrich(
  rows: ApplicabilityRow[],
): Promise<Array<Record<string, unknown>>> {
  if (rows.length === 0) return [];
  const db = getDb();
  const userIds = Array.from(
    new Set(rows.map((r) => r.setBy).filter((v): v is number => v !== null)),
  );
  const userRows = userIds.length
    ? await db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          role: users.role,
        })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const userById = new Map(userRows.map((u) => [u.id, u]));
  return rows.map((r) => ({
    ...r,
    setByUser: r.setBy ? (userById.get(r.setBy) ?? null) : null,
  }));
}

/** Shared parse of the drugId/parameter pair used by DELETE. */
function readPair(
  url: URL,
): { drugId: number; parameter: string } | { message: string } {
  const drugId = Number(url.searchParams.get('drugId'));
  if (!Number.isInteger(drugId) || drugId <= 0) {
    return { message: 'A positive integer drugId is required' };
  }
  const parameter = url.searchParams.get('parameter');
  if (!parameter) return { message: 'A parameter is required' };
  if (!isDrugParameterId(parameter)) return { message: 'Invalid parameter id' };
  return { drugId, parameter };
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
      return handleList(req, res, url);
    case 'PUT':
      assertSameOrigin(req);
      return handlePut(req, res);
    case 'DELETE':
      assertSameOrigin(req);
      return handleDelete(req, res, url);
    default:
      error(res, 405, 'Method not allowed');
  }
});

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
  const drugId = Number(url.searchParams.get('drugId'));
  if (!Number.isInteger(drugId) || drugId <= 0) {
    error(res, 400, 'A positive integer drugId is required');
    return;
  }
  const db = getDb();
  const rows = await listApplicabilityForDrug(db, drugId);
  json(res, 200, { applicability: await enrich(rows) });
}

async function handlePut(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  if (!(await canWrite(auth.role))) {
    error(res, 403, 'Editor or admin role required');
    return;
  }

  const parsed = await parseAndValidate(req, putParameterApplicabilitySchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }
  const { drugId, parameter, reason } = parsed.data;
  if (!isDrugParameterId(parameter)) {
    error(res, 400, 'Invalid parameter id');
    return;
  }
  // Only the grouped parameters live in `drug_parameters` and reach the gap
  // queue. Drug metadata (names, aliases, PubChem CID) is neither a measurable
  // quantity nor something the queue asks for, so a marker on it would be
  // inert — reject it rather than storing a row that means nothing.
  if (!isStoredInDrugParameters(parameter)) {
    error(
      res,
      400,
      'Only measurable parameters can be marked; drug metadata has no applicability.',
      'parameter_not_markable',
    );
    return;
  }

  const db = getDb();
  const [drug] = await db
    .select({ id: drugs.id })
    .from(drugs)
    .where(eq(drugs.id, drugId))
    .limit(1);
  if (!drug) {
    error(res, 404, 'Drug not found');
    return;
  }

  // The invariant runs both ways. The write paths refuse to store a value for
  // a marked pair; this refuses to mark a pair that already holds one, since
  // either order would otherwise leave the database asserting that the
  // quantity is undefined while still serving a number for it. Clearing the
  // value (or its source entries) first is the editor's call, not something to
  // do implicitly on their behalf — deleting curated data as a side effect of
  // a classification change is not a safe default.
  //
  // Checked and written inside one transaction holding the per-drug
  // applicability lock, because both directions are check-then-write: run
  // concurrently with a parameter write, each side could read no conflict and
  // then commit, and the pair would end up marked *and* valued. The parameter
  // write takes the same lock, so whichever goes second sees the other's
  // committed row.
  const conflict = await withDrugApplicabilityLock(drugId, async () => {
    const tx = getDb();

    if ((await getDrugParameterValue(tx, drugId, parameter)) !== null) {
      return 'parameter_has_value' as const;
    }
    // ANY entry, grandfathered included. The aggregation drops the migration's
    // synthetic rows once a real source exists, but GET /api/parameter-entries
    // still renders them — so borrowing that exclusion here would let a pair
    // whose only entry is grandfathered be marked while the UI keeps showing a
    // source value for the quantity just declared undefined.
    if (await hasAnyEntryForParameter(drugId, parameter)) {
      return 'parameter_has_entries' as const;
    }

    return await upsertApplicability(tx, {
      drugId,
      parameter,
      status: parsed.data.status ?? 'not_applicable',
      reason,
      setBy: auth.userId,
    });
  });

  if (conflict === 'parameter_has_value') {
    error(
      res,
      409,
      'This parameter has a stored value; clear it before marking the pair not applicable.',
      'parameter_has_value',
    );
    return;
  }
  if (conflict === 'parameter_has_entries') {
    error(
      res,
      409,
      'This parameter has source entries; remove them before marking the pair not applicable.',
      'parameter_has_entries',
    );
    return;
  }

  const [enriched] = await enrich([conflict]);
  json(res, 200, { applicability: enriched });
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
  if (!(await canWrite(auth.role))) {
    error(res, 403, 'Editor or admin role required');
    return;
  }
  const pair = readPair(url);
  if ('message' in pair) {
    error(res, 400, pair.message);
    return;
  }
  const db = getDb();
  const removed = await deleteApplicability(db, pair.drugId, pair.parameter);
  if (!removed) {
    error(res, 404, 'No applicability marker for that drug and parameter');
    return;
  }
  json(res, 200, { deleted: true });
}
