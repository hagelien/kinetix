/**
 * Reference concentrations endpoint.
 *   GET    — public (no auth required).
 *            `?id=<int>`         → single row, 404 if missing
 *            `?drugId=<int>`     → `{ items: [...] }`
 *              (optional `?matrix=` / `?scenario=` filters)
 *   POST   — admin only. Insert a new reference concentration row.
 *   PATCH  — admin only. `?id=<int>` updates an existing row.
 *   DELETE — admin only. `?id=<int>` removes a row.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  json,
  error,
  withErrorHandling,
  publicCacheHeaders,
  noStoreHeaders,
} from './_lib/response.js';
import { getUserFromRequest } from './_lib/auth.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { ParameterNotApplicableError } from './_lib/parameterApplicabilityStore.js';
import {
  deleteReferenceConcentration,
  getReferenceConcentrationById,
  insertReferenceConcentration,
  listReferenceConcentrations,
  listReferenceConcentrationsForDrugIds,
  serializeReferenceConcentration,
  updateReferenceConcentration,
} from './_lib/reference-concentrations-helpers.js';
import {
  referenceConcentrationInputSchema,
  referenceConcentrationUpdateSchema,
  REFERENCE_MATRICES,
  REFERENCE_SCENARIOS,
  SCENARIO_TO_PARAMETER,
  type ReferenceMatrix,
  type ReferenceScenario,
} from '../src/lib/referenceConcentrations.js';
import { runInPoolTransaction } from './_lib/db.js';
import {
  entryDuplicateExists,
  recomputeAndCacheParameterSummary,
} from './_lib/parameter-entries-store.js';
import type { ParameterEntryInput } from '../src/lib/parameterEntries.js';
import {
  assertReferencesJudgedForActor,
  ReferenceGateError,
} from './_lib/pending-edits-helpers.js';
import { markEntryMutationsConflicted } from './_lib/entry-conflicts.js';
import { recordApproval } from './_lib/approvals.js';
import { recordImplicitAgentApproval } from './_lib/agent-verifications.js';
import { isDrugParameterId } from '../src/lib/drugParameters.js';

/**
 * Refresh the cached aggregate for a parameter after its entries change and,
 * like the /api/parameter-entries admin-direct path, stamp the acting admin's
 * approval on the resulting revision so the derived live value isn't shown as
 * unapproved. The store no-ops for non-summarizable parameters.
 */
async function recomputeParameterCache(
  drugId: number,
  parameter: string,
  actorUserId: number,
): Promise<void> {
  if (!isDrugParameterId(parameter)) return;
  const revisionId = await recomputeAndCacheParameterSummary(
    drugId,
    parameter,
    actorUserId,
  );
  if (revisionId != null) {
    // recordApproval writes a human approvals row (the admin IS the approver);
    // the implicit-agent helper no-ops for a non-agent admin, so it alone would
    // leave the revision unapproved. Stamp both. Mirrors recomputeCache in
    // api/parameter-entries.ts.
    await recordApproval({
      targetType: 'drug_parameter_revision',
      targetId: revisionId,
      approvedBy: actorUserId,
    });
    await recordImplicitAgentApproval({
      userId: actorUserId,
      targetType: 'drug_parameter_revision',
      targetId: revisionId,
    });
  }
}

/**
 * Actor-aware citation gate for the compatibility write paths. An agent whose
 * backing user is an admin must still only cite sources it has read in full and
 * judged (these rows feed the aggregate cache); humans are trusted and this
 * no-ops for them. Returns a handled error response, or null to proceed.
 */
async function gateCitation(
  res: ServerResponse,
  citationId: number,
  userId: number,
): Promise<boolean> {
  try {
    await assertReferencesJudgedForActor([citationId], userId);
    return true;
  } catch (err) {
    if (err instanceof ReferenceGateError) {
      error(res, 400, err.message, 'reference_not_judged');
      return false;
    }
    throw err;
  }
}

// Reference ranges are public, read-heavy metadata used by monographs and
// simulator overlays. Admin writes are rare, so a short CDN cache cuts repeated
// Neon reads while keeping newly curated rows visible within minutes.
const PUBLIC_REFERENCE_CACHE_HEADERS = publicCacheHeaders({
  sMaxAge: 300,
  staleWhileRevalidate: 3600,
});
const FRESH_REFERENCE_CACHE_HEADERS = noStoreHeaders();

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );

    switch (req.method) {
      case 'GET':
        return handleGet(res, url);
      case 'POST':
        assertSameOrigin(req);
        return handleCreate(req, res);
      case 'PATCH':
        assertSameOrigin(req);
        return handleUpdate(req, res, url);
      case 'DELETE':
        assertSameOrigin(req);
        return handleDelete(req, res, url);
      default:
        error(res, 405, 'Method not allowed');
    }
  },
);

function parsePositiveInt(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parsePositiveIntCsv(raw: string | null): number[] | null {
  if (raw === null) return null;
  const ids: number[] = [];
  for (const part of raw.split(',')) {
    const id = parsePositiveInt(part.trim());
    if (id === null) return null;
    ids.push(id);
  }
  return [...new Set(ids)];
}

async function handleGet(res: ServerResponse, url: URL): Promise<void> {
  const idParam = url.searchParams.get('id');
  const drugIdParam = url.searchParams.get('drugId');
  const drugIdsParam = url.searchParams.get('drugIds');
  const cacheHeaders =
    url.searchParams.get('fresh') === '1'
      ? FRESH_REFERENCE_CACHE_HEADERS
      : PUBLIC_REFERENCE_CACHE_HEADERS;

  if (idParam !== null) {
    const id = parsePositiveInt(idParam);
    if (id === null) {
      error(res, 400, 'Invalid id');
      return;
    }
    const row = await getReferenceConcentrationById(id);
    if (!row) {
      error(res, 404, 'Reference concentration not found');
      return;
    }
    json(
      res,
      200,
      { item: serializeReferenceConcentration(row) },
      { headers: cacheHeaders },
    );
    return;
  }

  if (drugIdParam === null && drugIdsParam === null) {
    error(res, 400, 'Missing id, drugId, or drugIds query parameter');
    return;
  }

  const drugId = drugIdParam === null ? null : parsePositiveInt(drugIdParam);
  if (drugIdParam !== null && drugId === null) {
    error(res, 400, 'Invalid drugId');
    return;
  }

  const drugIds =
    drugIdsParam === null ? null : parsePositiveIntCsv(drugIdsParam);
  if (
    drugIdsParam !== null &&
    (drugIds === null || drugIds.length === 0 || drugIds.length > 100)
  ) {
    error(res, 400, 'Invalid drugIds');
    return;
  }

  const matrixParam = url.searchParams.get('matrix');
  if (
    matrixParam !== null &&
    !(REFERENCE_MATRICES as readonly string[]).includes(matrixParam)
  ) {
    error(res, 400, 'Invalid matrix');
    return;
  }
  const scenarioParam = url.searchParams.get('scenario');
  if (
    scenarioParam !== null &&
    !(REFERENCE_SCENARIOS as readonly string[]).includes(scenarioParam)
  ) {
    error(res, 400, 'Invalid scenario');
    return;
  }

  const filter = {
    matrix: (matrixParam as ReferenceMatrix | null) ?? undefined,
    scenario: (scenarioParam as ReferenceScenario | null) ?? undefined,
  };

  if (drugId !== null) {
    const rows = await listReferenceConcentrations({
      drugId,
      ...filter,
    });
    json(
      res,
      200,
      { items: rows.map(serializeReferenceConcentration) },
      { headers: cacheHeaders },
    );
    return;
  }

  const rows = await listReferenceConcentrationsForDrugIds(
    drugIds ?? [],
    filter,
  );
  const itemsByDrugId: Record<
    string,
    ReturnType<typeof serializeReferenceConcentration>[]
  > = {};
  for (const drugId of drugIds ?? []) itemsByDrugId[String(drugId)] = [];
  for (const row of rows) {
    const key = String(row.drugId);
    itemsByDrugId[key] ??= [];
    itemsByDrugId[key].push(serializeReferenceConcentration(row));
  }
  json(res, 200, { itemsByDrugId }, { headers: cacheHeaders });
}

// Build the identifying tuple entryDuplicateExists needs from a legacy payload.
// The parameter is derived from the scenario (1:1), matching how rows are stored.
function toDuplicateInput(
  drugId: number,
  data: {
    scenario: ReferenceScenario;
    matrix: ReferenceMatrix;
    unit: string;
    low?: number;
    high?: number;
    citationId?: number;
  },
): ParameterEntryInput {
  return {
    drugId,
    parameter: SCENARIO_TO_PARAMETER[data.scenario],
    matrix: data.matrix,
    scenario: data.scenario,
    unit: data.unit,
    low: data.low,
    high: data.high,
    citationId: data.citationId,
  } as ParameterEntryInput;
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (
    !auth ||
    !(await callerCan(auth.role, CAP['referenceConcentration.write']))
  ) {
    error(res, 403, 'Admin role required');
    return;
  }

  const parsed = await parseAndValidate(req, referenceConcentrationInputSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  // These rows now feed the multi-value aggregate cache as source entries, so a
  // value with no citation would become a weighted scientific source with no
  // provenance. Require a citation (matching the new entry model).
  if (parsed.data.citationId == null) {
    error(res, 400, 'A citation is required', 'citation_required');
    return;
  }
  // These rows feed the aggregate cache, so an agent-admin must cite a source it
  // has read in full and judged (no-op for a human admin). Same gate as
  // /api/parameter-entries.
  if (!(await gateCitation(res, parsed.data.citationId, auth.userId))) return;
  // Same shared parameter_entries table as /api/parameter-entries: reject an
  // exact-duplicate observation so a retried compat POST can't be pooled twice.
  if (await entryDuplicateExists(toDuplicateInput(parsed.data.drugId, parsed.data))) {
    error(
      res,
      409,
      'An identical source value already exists for this parameter.',
      'param_entry_duplicate',
    );
    return;
  }

  let row;
  try {
    row = await runInPoolTransaction(async () => {
      const created = await insertReferenceConcentration({
        input: parsed.data,
        createdBy: auth.userId,
      });
      await recomputeParameterCache(created.drugId, created.parameter, auth.userId);
      return created;
    });
  } catch (err: unknown) {
    // Same 409 and stable code every other write surface returns; this route
    // writes the same parameter_entries row, so it must refuse it the same way.
    if (err instanceof ParameterNotApplicableError) {
      error(res, 409, err.message, err.code);
      return;
    }
    throw err;
  }
  json(res, 201, { item: serializeReferenceConcentration(row) });
}

async function handleUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (
    !auth ||
    !(await callerCan(auth.role, CAP['referenceConcentration.write']))
  ) {
    error(res, 403, 'Admin role required');
    return;
  }

  const id = parsePositiveInt(url.searchParams.get('id'));
  if (id === null) {
    error(res, 400, 'Missing or invalid id');
    return;
  }

  const parsed = await parseAndValidate(
    req,
    referenceConcentrationUpdateSchema,
  );
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  if (parsed.data.citationId == null) {
    error(res, 400, 'A citation is required', 'citation_required');
    return;
  }
  if (!(await gateCitation(res, parsed.data.citationId, auth.userId))) return;

  const existing = await getReferenceConcentrationById(id);
  if (!existing) {
    error(res, 404, 'Reference concentration not found');
    return;
  }
  // Reject an update that would make this legacy row an exact duplicate of
  // ANOTHER entry (self excluded), same guard as /api/parameter-entries.
  if (
    await entryDuplicateExists(
      toDuplicateInput(existing.drugId, parsed.data),
      id,
    )
  ) {
    error(
      res,
      409,
      'This change would duplicate an existing source value for this parameter.',
      'param_entry_duplicate',
    );
    return;
  }

  let row;
  try {
    row = await runInPoolTransaction(async () => {
    const updated = await updateReferenceConcentration({ id, input: parsed.data });
    if (!updated) return null;
    // This legacy route writes the SAME parameter_entries row as
    // /api/parameter-entries, so it must apply the identical guard: any open
    // update/delete proposal for this entry is now stale and must be marked
    // conflicted, or approving it later would silently reverse this admin edit.
    await markEntryMutationsConflicted(updated.id);
    await recomputeParameterCache(updated.drugId, updated.parameter, auth.userId);
    // A scenario change can move the row to a different parameter; refresh the
    // one it left behind too.
    if (existing.parameter !== updated.parameter) {
      await recomputeParameterCache(
        existing.drugId,
        existing.parameter,
        auth.userId,
      );
    }
    return updated;
    });
  } catch (err: unknown) {
    // A scenario change can move the row onto a pair an editor has marked not
    // applicable. Nothing committed, so it is the same 409 the create path and
    // every other write surface return.
    if (err instanceof ParameterNotApplicableError) {
      error(res, 409, err.message, err.code);
      return;
    }
    throw err;
  }
  if (!row) {
    error(res, 404, 'Reference concentration not found');
    return;
  }
  json(res, 200, { item: serializeReferenceConcentration(row) });
}

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (
    !auth ||
    !(await callerCan(auth.role, CAP['referenceConcentration.write']))
  ) {
    error(res, 403, 'Admin role required');
    return;
  }

  const id = parsePositiveInt(url.searchParams.get('id'));
  if (id === null) {
    error(res, 400, 'Missing or invalid id');
    return;
  }

  const removed = await runInPoolTransaction(async () => {
    const existing = await getReferenceConcentrationById(id);
    const ok = await deleteReferenceConcentration(id);
    if (ok && existing) {
      // Same shared table as /api/parameter-entries: mark stale update/delete
      // proposals for this now-removed entry conflicted before recomputing.
      // pending_edits.targetId has no FK, so the marker still applies post-delete.
      await markEntryMutationsConflicted(existing.id);
      await recomputeParameterCache(
        existing.drugId,
        existing.parameter,
        auth.userId,
      );
    }
    return ok;
  });
  if (!removed) {
    error(res, 404, 'Reference concentration not found');
    return;
  }
  json(res, 200, { ok: true });
}
