/**
 * Multi-value parameter entries endpoint (Phase 3).
 *   GET    ?drugId=[&parameter=]  — public list of a drug's entries.
 *   POST                          — create an entry.
 *   PATCH  ?id=                   — update an entry.
 *   DELETE ?id=                   — delete an entry.
 *
 * Writes fork like /api/drug-parameter: an admin writes directly (and the
 * parameter's cached aggregate is recomputed in the same transaction), while a
 * contributor — or an admin passing submitForReview — queues a `param_entry`
 * pending edit for the /review queue. Agents are citation-gated (a cited source
 * must have a read-in-full paper_review); humans are trusted.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, eq, sql } from 'drizzle-orm';
import {
  json,
  error,
  withErrorHandling,
  publicCacheHeaders,
  noStoreHeaders,
} from './_lib/response.js';
// `inTransaction` rather than `runInPoolTransaction` throughout the parameter-entry write paths
// (§12.3.1 of docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
// These units of work are reachable from a governance adapter's `apply()`,
// which opens the transaction itself; opening a second Pool from inside one
// would put this work on a *different connection*, blocking on the
// transaction-scoped drug advisory locks and row locks the outer connection
// already holds — a hang until timeout, not an error. Joining changes nothing
// for the endpoints: outside a transaction `inTransaction` opens one.
import { getDb, inTransaction } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import { citations, drugs, pendingEdits } from '../db/schema.js';
import {
  parameterEntryCreateRequestSchema,
  parameterEntryUpdateRequestSchema,
  type ParameterEntryInput,
  type ParameterEntryPatch,
} from './_lib/schemas.js';
import {
  assertReferencesJudgedForActor,
  ReferenceGateError,
} from './_lib/pending-edits-helpers.js';
import { markEntryMutationsConflicted } from './_lib/entry-conflicts.js';
import {
  withParamEntryPayloadLocks,
  type ParamEntryLockRefusal,
} from './_lib/param-entry-payload-locks.js';
import { isUniqueViolation } from './_lib/drugs-helpers.js';
import {
  isActiveAgentUser,
  recordImplicitAgentApproval,
} from './_lib/agent-verifications.js';
import { recordApproval } from './_lib/approvals.js';
import {
  isDrugParameterId,
  isModelStructureParameter,
  parameterAuthoringGated,
  parameterAuthoringGatedMessage,
  parameterDoseContextMode,
} from '../src/lib/drugParameters.js';
import {
  deleteParameterEntryRow,
  entryDuplicateExists,
  getParameterEntryRowById,
  insertParameterEntry,
  getCmaxViewForDrug,
  listEntriesForDrug,
  recomputeParameterAndDependents,
  updateParameterEntryRow,
} from './_lib/parameter-entries-store.js';
import { validateEntryForParameter } from '../src/lib/parameterEntries.js';
import {
  lockDrugForEntryApplicability,
  parameterWriteBlockedBy,
} from './_lib/parameterApplicabilityStore.js';

const PUBLIC_CACHE = publicCacheHeaders({ sMaxAge: 300, staleWhileRevalidate: 3600 });

function parsePositiveInt(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Model-shape entries always pass through review when submitted by an agent;
 * for humans, direct write additionally requires the editor-floored decision
 * capability. This keeps the dedicated endpoint aligned with the queue gate.
 */
async function mustQueueModelStructure(
  userId: number,
  role: string,
  parameter: string,
): Promise<boolean> {
  if (!isModelStructureParameter(parameter)) return false;
  return (
    (await isActiveAgentUser(userId)) ||
    !(await callerCan(role, CAP['edit.modelStructure.decide']))
  );
}

async function recomputeCache(
  drugId: number,
  parameter: string,
  actorUserId: number,
): Promise<void> {
  if (!isDrugParameterId(parameter)) return;
  const revisionId = await recomputeParameterAndDependents(
    drugId,
    parameter,
    actorUserId,
    { approvedBy: actorUserId },
  );
  // A trusted admin-direct write produces the live revision; stamp the admin's
  // approval so it isn't shown as unapproved. recordApproval writes a human
  // approvals row (the acting admin IS the approver) — the implicit-agent helper
  // no-ops for a plain human admin, so it alone would leave the revision
  // unapproved. Stamp both so an agent-admin's stake is recorded too. Mirrors
  // the reviewed-entry apply path (pending-edits-helpers.ts).
  if (revisionId != null) {
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

export default withErrorHandling(async function handler(req, res): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
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
});

async function handleGet(res: ServerResponse, url: URL): Promise<void> {
  const drugId = parsePositiveInt(url.searchParams.get('drugId'));
  if (drugId === null) {
    error(res, 400, 'Missing or invalid drugId');
    return;
  }
  // `?summary=cmax`: the dose-normalized Cmax summary, derived at read time
  // from the entries (never stored), together with the Cmax rows it was
  // computed from. One response, so one cache entry: the per-dose view shows
  // these rows, never a separately cached list that may be newer or older
  // than the summary. Same caching rules as the list below.
  if (url.searchParams.get('summary') === 'cmax') {
    const { items, summary } = await getCmaxViewForDrug(drugId);
    const freshSummary = url.searchParams.get('fresh') !== null;
    json(res, 200, { summary, items }, { headers: freshSummary ? noStoreHeaders() : PUBLIC_CACHE });
    return;
  }
  const parameter = url.searchParams.get('parameter') ?? undefined;
  const items = await listEntriesForDrug(drugId, parameter);
  // `?fresh=1` is what a curation surface asks with. The default response is
  // public and edge-cached (s-maxage + stale-while-revalidate), which is right
  // for readers but wrong for the person who just wrote an entry: the CDN kept
  // serving the pre-write list — an empty source list under a plot that already
  // had the sources — for as long as the stale window lasted. Answering no-store
  // keeps that variant out of every cache in the path.
  const fresh = url.searchParams.get('fresh') !== null;
  json(res, 200, { items }, { headers: fresh ? noStoreHeaders() : PUBLIC_CACHE });
}

/**
 * Answer a proposal write that `withParamEntryPayloadLocks` refused: the
 * target entry moved to another drug (a merge landed first), or a drug the
 * payload names is gone (a delete or merge landed first). Nothing was written.
 */
function refuseLockedWrite(res: ServerResponse, refusal: ParamEntryLockRefusal): void {
  if (refusal.refused === 'target_moved') {
    error(
      res,
      409,
      'The entry was moved to another substance while this proposal was being written; reload and try again',
      'param_entry_target_moved',
    );
  } else if (refusal.refused === 'drug_missing') {
    error(
      res,
      409,
      `The proposal names substance #${refusal.drugId}, which no longer exists`,
      'param_entry_drug_missing',
    );
  } else {
    error(res, 404, 'Parameter entry not found', 'param_entry_not_found');
  }
}

/**
 * A dose-context entry (Cmax) that does not name the substance dosed was
 * dosed with its own drug: store the explicit self-reference the RFC requires
 * rather than leaving `administeredDrugId` absent. Only an OMITTED field is
 * defaulted — an explicit `null` is a writer saying something, and validation
 * refuses it.
 */
function withSelfAdministeredDefault(input: ParameterEntryInput): ParameterEntryInput {
  if (
    parameterDoseContextMode(input.parameter) === 'required' &&
    input.administeredDrugId === undefined
  ) {
    return { ...input, administeredDrugId: input.drugId };
  }
  return input;
}

/** Strip request-only extras, leaving the payload that is stored/re-validated. */
function toStoredInput(
  data: Record<string, unknown>,
): ParameterEntryInput {
  const { editSummary: _e, submitForReview: _s, ...input } = data;
  void _e;
  void _s;
  return input as ParameterEntryInput;
}
function toStoredPatch(data: Record<string, unknown>): ParameterEntryPatch {
  const { editSummary: _e, submitForReview: _s, ...patch } = data;
  void _e;
  void _s;
  return patch as ParameterEntryPatch;
}

async function gateCitation(
  citationId: number,
  userId: number,
  res: ServerResponse,
): Promise<boolean> {
  // Verify the citation resolves before accepting the write. The judged-source
  // gate no-ops for humans and treats a missing citation as an empty set, so
  // without this a nonexistent id would slip through and only surface as a
  // generic 500 on the citation FK at insert time.
  const [cite] = await getDb()
    .select({ id: citations.id })
    .from(citations)
    .where(eq(citations.id, citationId))
    .limit(1);
  if (!cite) {
    error(res, 400, 'Cited source not found', 'citation_not_found');
    return false;
  }
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

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (
    !auth ||
    !(await callerCan(auth.role, CAP['edit.parameterEntry.submit']))
  ) {
    error(res, 403, 'Contributor role required');
    return;
  }
  const parsed = await parseAndValidate(req, parameterEntryCreateRequestSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }
  const data = parsed.data as Record<string, unknown>;
  const input = withSelfAdministeredDefault(toStoredInput(data));
  // The dose-context authoring gate (Cmax release B): the parameter is
  // registered so an approval can parse a release-C proposal, but CREATING one
  // is refused on both branches below — the direct write and the queued
  // proposal — until release C opens it. Checked before anything else so
  // neither branch can be reached.
  if (parameterAuthoringGated(input.parameter)) {
    error(
      res,
      403,
      parameterAuthoringGatedMessage(input.parameter),
      'parameter_authoring_gated',
    );
    return;
  }
  // Registry rules (unit, bounds, matrix/scenario applicability) run here rather
  // than inside the request schema so the failure carries a stable code the
  // editor can translate — a raw zod message would reach a Norwegian
  // contributor in English. The stored payload is re-checked at approval.
  const invalid = validateEntryForParameter(input.parameter, input);
  if (invalid) {
    error(res, 400, invalid, 'param_entry_invalid_for_parameter');
    return;
  }
  // Resolve the target drug before either write branch: parameter_entries.drug_id
  // has an FK, and pending_edits.target_id does not, so a nonexistent (but
  // positive) drugId would otherwise queue a permanent unknown-target proposal or
  // fail at the FK as a generic 500.
  const [drug] = await getDb()
    .select({ id: drugs.id })
    .from(drugs)
    .where(eq(drugs.id, input.drugId))
    .limit(1);
  if (!drug) {
    error(res, 404, 'Target drug not found', 'drug_not_found');
    return;
  }
  // An entry is evidence for a value of this quantity, so it cannot be filed
  // against a pair that has no such quantity — whether because an editor
  // marked it or because the substance is never administered. Rejected here
  // rather than left to the recompute (which skips silently) so the
  // contributor gets told why, and before the pending-edit branch so a
  // proposal that could only ever be rejected never reaches a reviewer.
  const entryBlockedBy = await parameterWriteBlockedBy(
    getDb(),
    input.drugId,
    input.parameter,
  );
  if (entryBlockedBy) {
    error(
      res,
      409,
      entryBlockedBy === 'substance_class'
        ? 'This substance is not administered, so this parameter is not a defined quantity for it; correct its substanceClass if the classification is wrong.'
        : 'This parameter is marked not applicable for this substance; lift the marker via /api/drug-parameter-applicability before adding source entries.',
      'parameter_not_applicable',
    );
    return;
  }
  if (!(await gateCitation(input.citationId, auth.userId, res))) return;

  // Distinct create proposals coexist (a parameter is multi-value), so there is
  // no open-edit dedup — but an EXACT duplicate observation is rejected below,
  // both here (direct insert) and at approval, so it can't be pooled twice.
  //
  // The submit runs inside a pool transaction that takes the same per-drug
  // advisory lock the merge admin does. This closes the drug-merge race: the
  // check at line 214 was outside any lock, so an admin merge could delete
  // the loser drug between that check and the insert here, landing a pending
  // edit against a drug row that no longer exists. Under the lock the
  // existence re-check is authoritative — a merge blocks until this
  // transaction commits, or vice versa.
  if (
    !(await callerCan(auth.role, CAP['edit.directWrite'])) ||
    (await mustQueueModelStructure(auth.userId, auth.role, input.parameter)) ||
    data.submitForReview
  ) {
    // Every drug the proposal names — the target and any dose-context drug —
    // is locked in one sorted set and re-read under the locks before the
    // insert (`withParamEntryPayloadLocks`), so a concurrent delete or merge
    // either sees this proposal or makes it refuse; it cannot land naming a
    // drug that is already gone.
    const locked = await withParamEntryPayloadLocks(
      { op: 'create', targetId: input.drugId, proposedValue: { op: 'create', input } },
      async () => {
        const [row] = await getDb()
          .insert(pendingEdits)
          .values({
            editType: 'param_entry',
            targetId: input.drugId,
            parameter: input.parameter,
            proposedValue: { op: 'create', input } as never,
            proposedMeta: { editSummary: data.editSummary } as never,
            referenceId: input.citationId,
            referenceIds: [input.citationId],
            status: 'pending',
            submittedBy: auth.userId,
          })
          .returning();
        if (!row) throw new Error('pendingEdits insert returned no row');
        return row;
      },
    );
    if (locked.refused) {
      if (
        locked.refused === 'target_missing' ||
        (locked.refused === 'drug_missing' && locked.drugId === input.drugId)
      ) {
        error(res, 404, 'Target drug not found', 'drug_not_found');
      } else {
        refuseLockedWrite(res, locked);
      }
      return;
    }
    const created = locked.value;
    await recordImplicitAgentApproval({
      userId: auth.userId,
      targetType: 'pending_edit',
      targetId: created.id,
    });
    json(res, 201, { pending: true, pendingEditId: created.id });
    return;
  }

  if (await entryDuplicateExists(input)) {
    error(
      res,
      409,
      'An identical source value already exists for this parameter.',
      'param_entry_duplicate',
    );
    return;
  }
  // Re-check under the per-drug lock inside the write transaction. The
  // pre-check above is for the error message and for the pending-edit branch;
  // on its own it is a check-then-write, so a marker created between it and
  // this insert would land beside the entry it forbids. The duplicate
  // re-check inside the lock closes a merge race too — a concurrent merge
  // that folds a matching loser entry onto this winner between the outer
  // dedup check and lock acquisition would otherwise let this insert land
  // as a silent second copy of the same observation, double-pooling it
  // through source-weighted aggregation.
  type CreateOutcome =
    | { kind: 'ok'; row: Awaited<ReturnType<typeof insertParameterEntry>> }
    | { kind: 'not_applicable' }
    | { kind: 'duplicate' };
  const outcome = await inTransaction<CreateOutcome>(async () => {
    await lockDrugForEntryApplicability(input.drugId);
    if (await parameterWriteBlockedBy(getDb(), input.drugId, input.parameter)) {
      return { kind: 'not_applicable' };
    }
    if (await entryDuplicateExists(input)) {
      return { kind: 'duplicate' };
    }
    const row = await insertParameterEntry(input, auth.userId);
    await recomputeCache(row.drugId, row.parameter, auth.userId);
    return { kind: 'ok', row };
  });
  if (outcome.kind === 'not_applicable') {
    error(
      res,
      409,
      'This parameter is not a defined quantity for this substance.',
      'parameter_not_applicable',
    );
    return;
  }
  if (outcome.kind === 'duplicate') {
    error(
      res,
      409,
      'An identical source value already exists for this parameter.',
      'param_entry_duplicate',
    );
    return;
  }
  json(res, 201, { id: outcome.row.id });
}

async function handleUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (
    !auth ||
    !(await callerCan(auth.role, CAP['edit.parameterEntry.submit']))
  ) {
    error(res, 403, 'Contributor role required');
    return;
  }
  const id = parsePositiveInt(url.searchParams.get('id'));
  if (id === null) {
    error(res, 400, 'Missing or invalid id');
    return;
  }
  const existing = await getParameterEntryRowById(id);
  if (!existing) {
    error(res, 404, 'Parameter entry not found');
    return;
  }
  const parsed = await parseAndValidate(req, parameterEntryUpdateRequestSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }
  const data = parsed.data as Record<string, unknown>;
  const patch = toStoredPatch(data);
  // An update payload carries no `parameter` (it is immutable on the row), so
  // the registry-driven unit/bounds/matrix/scenario rules can't run inside the
  // schema — apply them here against the target row's parameter.
  const invalid = validateEntryForParameter(existing.parameter, patch);
  if (invalid) {
    error(res, 400, invalid, 'param_entry_invalid_for_parameter');
    return;
  }
  if (!(await gateCitation(patch.citationId, auth.userId, res))) return;

  if (
    !(await callerCan(auth.role, CAP['edit.directWrite'])) ||
    (await mustQueueModelStructure(auth.userId, auth.role, existing.parameter)) ||
    data.submitForReview
  ) {
    if (await hasOpenMutationEdit(id, existing.parameter)) {
      json(res, 409, {
        error: 'A pending edit already exists for this entry',
        code: 'entry_pending_conflict',
      });
      return;
    }
    // Take the same per-drug advisory lock the merge admin does, then
    // re-verify the target entry still exists under the lock — closes the
    // drug-merge dedup race: without the lock, a merge could delete this
    // entry via the identical-row dedup at step 7 between our getEntry above
    // and the insert below, landing a pending edit against an entry that no
    // longer exists (and later fails approval with param_entry_target_missing).
    type MutationOutcome =
      | { kind: 'ok'; row: typeof pendingEdits.$inferSelect }
      | { kind: 'gone' }
      | { kind: 'dedup' }
      | { kind: 'refused'; refusal: ParamEntryLockRefusal };
    let outcome: MutationOutcome;
    try {
      // Owner + dose-context drugs locked and re-read, and the entry re-read
      // under them (`withParamEntryPayloadLocks`).
      const locked = await withParamEntryPayloadLocks(
        { op: 'update', targetId: id, proposedValue: { op: 'update', patch } },
        async (): Promise<MutationOutcome> => {
          const [row] = await getDb()
            .insert(pendingEdits)
            .values({
              editType: 'param_entry',
              targetId: id,
              parameter: existing.parameter,
              proposedValue: { op: 'update', patch } as never,
              proposedMeta: { editSummary: data.editSummary } as never,
              referenceId: patch.citationId,
              referenceIds: [patch.citationId],
              status: 'pending',
              submittedBy: auth.userId,
            })
            .returning();
          if (!row) throw new Error('pendingEdits insert returned no row');
          return { kind: 'ok', row };
        },
      );
      outcome =
        locked.refused === null
          ? locked.value
          : locked.refused === 'target_missing'
            ? { kind: 'gone' }
            : { kind: 'refused', refusal: locked };
    } catch (err) {
      if (isUniqueViolation(err)) {
        outcome = { kind: 'dedup' };
      } else {
        throw err;
      }
    }
    if (outcome.kind === 'gone') {
      error(res, 404, 'Parameter entry not found', 'param_entry_not_found');
      return;
    }
    if (outcome.kind === 'refused') {
      refuseLockedWrite(res, outcome.refusal);
      return;
    }
    if (outcome.kind === 'dedup') {
      json(res, 409, {
        error: 'A pending edit already exists for this entry',
        code: 'entry_pending_conflict',
      });
      return;
    }
    await recordImplicitAgentApproval({
      userId: auth.userId,
      targetType: 'pending_edit',
      targetId: outcome.row.id,
    });
    json(res, 201, { pending: true, pendingEditId: outcome.row.id });
    return;
  }

  // Reject an update that would make this row an exact duplicate of ANOTHER
  // entry (same citation/matrix/scenario/unit/qualifier/value) — aggregation
  // would then double-weight the observation. drug + parameter are immutable, so
  // they come from the existing row.
  if (
    await entryDuplicateExists(
      { ...patch, drugId: existing.drugId, parameter: existing.parameter },
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
  // Direct writes share the per-drug advisory lock with the merge admin so
  // an in-flight merge can't delete this row via dedup between our
  // getParameterEntryRowById above and updateParameterEntryRow below. The row
  // lock inside the UPDATE only converts the race into a silent post-delete
  // no-op — the update returns no row, but without a lock+outcome check we
  // would still respond 200 as though the patch was saved.
  type DirectOutcome = { kind: 'ok' } | { kind: 'gone' };
  const directOutcome = await inTransaction<DirectOutcome>(async () => {
    await lockDrugForEntryApplicability(existing.drugId);
    const row = await updateParameterEntryRow(id, patch);
    if (!row) return { kind: 'gone' };
    await markEntryMutationsConflicted(id);
    await recomputeCache(row.drugId, row.parameter, auth.userId);
    return { kind: 'ok' };
  });
  if (directOutcome.kind === 'gone') {
    error(res, 404, 'Parameter entry not found', 'param_entry_not_found');
    return;
  }
  json(res, 200, { id });
}

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (
    !auth ||
    !(await callerCan(auth.role, CAP['edit.parameterEntry.submit']))
  ) {
    error(res, 403, 'Contributor role required');
    return;
  }
  const id = parsePositiveInt(url.searchParams.get('id'));
  if (id === null) {
    error(res, 400, 'Missing or invalid id');
    return;
  }
  const existing = await getParameterEntryRowById(id);
  if (!existing) {
    error(res, 404, 'Parameter entry not found');
    return;
  }
  const submitForReview = url.searchParams.get('submitForReview') === 'true';

  if (
    !(await callerCan(auth.role, CAP['edit.directWrite'])) ||
    (await mustQueueModelStructure(auth.userId, auth.role, existing.parameter)) ||
    submitForReview
  ) {
    if (await hasOpenMutationEdit(id, existing.parameter)) {
      json(res, 409, {
        error: 'A pending edit already exists for this entry',
        code: 'entry_pending_conflict',
      });
      return;
    }
    // Same drug-merge-race guard as the update branch above — lock the
    // drug, re-verify the entry, then insert.
    type MutationOutcome =
      | { kind: 'ok'; row: typeof pendingEdits.$inferSelect }
      | { kind: 'gone' }
      | { kind: 'dedup' }
      | { kind: 'refused'; refusal: ParamEntryLockRefusal };
    let outcome: MutationOutcome;
    try {
      // The owner locked and the entry re-read under it, through the same
      // primitive as every other proposal writer (a delete names no nested
      // drug, so the set is the owner alone).
      const locked = await withParamEntryPayloadLocks(
        { op: 'delete', targetId: id, proposedValue: { op: 'delete' } },
        async (): Promise<MutationOutcome> => {
          const [row] = await getDb()
            .insert(pendingEdits)
            .values({
              editType: 'param_entry',
              targetId: id,
              parameter: existing.parameter,
              proposedValue: { op: 'delete' } as never,
              status: 'pending',
              submittedBy: auth.userId,
            })
            .returning();
          if (!row) throw new Error('pendingEdits insert returned no row');
          return { kind: 'ok', row };
        },
      );
      outcome =
        locked.refused === null
          ? locked.value
          : locked.refused === 'target_missing'
            ? { kind: 'gone' }
            : { kind: 'refused', refusal: locked };
    } catch (err) {
      if (isUniqueViolation(err)) {
        outcome = { kind: 'dedup' };
      } else {
        throw err;
      }
    }
    if (outcome.kind === 'gone') {
      error(res, 404, 'Parameter entry not found', 'param_entry_not_found');
      return;
    }
    if (outcome.kind === 'refused') {
      refuseLockedWrite(res, outcome.refusal);
      return;
    }
    if (outcome.kind === 'dedup') {
      json(res, 409, {
        error: 'A pending edit already exists for this entry',
        code: 'entry_pending_conflict',
      });
      return;
    }
    await recordImplicitAgentApproval({
      userId: auth.userId,
      targetType: 'pending_edit',
      targetId: outcome.row.id,
    });
    json(res, 201, { pending: true, pendingEditId: outcome.row.id });
    return;
  }

  // Same drug-merge-race guard as the direct update branch — share the
  // per-drug advisory lock and turn a lost row race into an accurate 404
  // instead of a silent 200.
  type DirectOutcome = { kind: 'ok' } | { kind: 'gone' };
  const directOutcome = await inTransaction<DirectOutcome>(async () => {
    await lockDrugForEntryApplicability(existing.drugId);
    const row = await deleteParameterEntryRow(id);
    if (!row) return { kind: 'gone' };
    // pending_edits.targetId is a plain int (no FK to the deleted row), so
    // marking stale update/delete proposals conflicted still works post-delete.
    await markEntryMutationsConflicted(id);
    await recomputeCache(row.drugId, row.parameter, auth.userId);
    return { kind: 'ok' };
  });
  if (directOutcome.kind === 'gone') {
    error(res, 404, 'Parameter entry not found', 'param_entry_not_found');
    return;
  }
  json(res, 200, { ok: true });
}

/** True when an open update/delete param_entry edit already targets this entry. */
async function hasOpenMutationEdit(
  entryId: number,
  parameter: string,
): Promise<boolean> {
  const [open] = await getDb()
    .select({ id: pendingEdits.id })
    .from(pendingEdits)
    .where(
      and(
        eq(pendingEdits.editType, 'param_entry'),
        eq(pendingEdits.targetId, entryId),
        eq(pendingEdits.parameter, parameter),
        eq(pendingEdits.status, 'pending'),
        // A create's targetId is a DRUG id (not an entry id); exclude creates so
        // they can't collide with an unrelated entry whose id equals that drug
        // id — matching the open-entry unique index predicate.
        sql`(${pendingEdits.proposedValue} ->> 'op') <> 'create'`,
      ),
    )
    .limit(1);
  return Boolean(open);
}
