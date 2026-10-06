/**
 * Drug parameter edit endpoint.
 *   GET ?drugId=&parameter=   — get current value + spec metadata
 *   PUT ?drugId=&parameter=   — update value (writes a revision); editor+
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, desc, eq, sql } from 'drizzle-orm';
import { json, error, withErrorHandling } from './_lib/response.js';
// `inTransaction` rather than `runInPoolTransaction` throughout the drug-parameter write path
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
import { updateDrugParameterSchema } from './_lib/schemas.js';
import {
  drugs,
  drugParameterRevisions,
  drugInteractions,
  pendingEdits,
} from '../db/schema.js';
import {
  DRUG_PARAMETERS,
  isDrugParameterId,
  isRangeKind,
  parameterAcceptsAuthoredValue,
  parameterRequiresReference,
  type DrugParameterId,
} from '../src/lib/drugParameters.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import {
  buildParameterUpdate,
  isUniqueViolation,
  ParameterApplyError,
  readParameterValue,
} from './_lib/drugs-helpers.js';
import {
  assertReferencesJudgedForActor,
  ReferenceGateError,
} from './_lib/pending-edits-helpers.js';
import { getDrugParameterMap } from './_lib/drugParameterStore.js';
import {
  lockDrugForEntryApplicability,
  parameterWriteBlockedBy,
  ParameterNotApplicableError,
} from './_lib/parameterApplicabilityStore.js';
import { recordImplicitAgentApproval } from './_lib/agent-verifications.js';
import {
  agentProposalLacksSourceQuote,
  SOURCE_QUOTE_REQUIRED_MESSAGE,
} from './_lib/source-quote-gate.js';
import {
  isNormalizationInput,
  recomputeSummariesForDrug,
} from './_lib/parameter-entries-store.js';

function parseQuery(
  url: URL,
): { drugId: number; parameter: DrugParameterId } | string {
  const drugId = Number(url.searchParams.get('drugId'));
  const parameter = url.searchParams.get('parameter');
  if (!drugId || Number.isNaN(drugId)) return 'Missing or invalid drugId';
  if (!parameter || !isDrugParameterId(parameter))
    return 'Missing or invalid parameter';
  return { drugId, parameter };
}

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );

    const query = parseQuery(url);
    if (typeof query === 'string') {
      error(res, 400, query);
      return;
    }

    switch (req.method) {
      case 'GET':
        return handleGet(res, query.drugId, query.parameter);
      case 'PUT':
        assertSameOrigin(req);
        return handleUpdate(req, res, query.drugId, query.parameter);
      default:
        error(res, 405, 'Method not allowed');
    }
  },
);

async function handleGet(
  res: ServerResponse,
  drugId: number,
  parameter: DrugParameterId,
): Promise<void> {
  const db = getDb();

  // Run both queries in parallel for existing drugs, but do not let a
  // parameter-map read failure mask the canonical 404 for a missing drug.
  const paramMapPromise = getDrugParameterMap(db, drugId).then(
    (value) => ({ ok: true as const, value }),
    (cause: unknown) => ({ ok: false as const, cause }),
  );
  const [row] = await db
    .select()
    .from(drugs)
    .where(eq(drugs.id, drugId))
    .limit(1);

  if (!row) {
    error(res, 404, 'Drug not found');
    return;
  }

  const paramMapResult = await paramMapPromise;
  if (!paramMapResult.ok) throw paramMapResult.cause;
  const paramMap = paramMapResult.value;

  const spec = DRUG_PARAMETERS[parameter];
  // Common fields surfaced to every consumer; range/text/number kinds attach
  // their own specifics so the UI can render the right input shape without
  // re-importing the registry.
  const baseSpec = {
    id: spec.id,
    label: spec.label,
    longLabel: spec.longLabel,
    kind: spec.kind,
  } as const;
  let specPayload: Record<string, unknown> = { ...baseSpec };
  if (isRangeKind(spec.kind) || spec.kind === 'struct') {
    const rs = spec as Extract<
      typeof spec,
      { kind: 'range' | 'fraction' | 'ratio' | 'scalar' | 'struct' }
    >;
    specPayload = {
      ...baseSpec,
      allowedUnits: rs.allowedUnits,
      canonicalUnit: rs.canonicalUnit,
      bounds: rs.bounds,
      requiresMinMax: rs.requiresMinMax,
    };
  } else if (spec.kind === 'text') {
    specPayload = {
      ...baseSpec,
      maxLength: spec.maxLength,
      required: spec.required,
    };
  } else if (spec.kind === 'number') {
    specPayload = {
      ...baseSpec,
      bounds: spec.bounds,
      isInteger: spec.isInteger,
      unique: spec.unique,
      unitLabel: spec.unitLabel,
    };
  } else if (spec.kind === 'list') {
    specPayload = {
      ...baseSpec,
      maxItems: spec.maxItems,
      maxItemLength: spec.maxItemLength,
    };
  }

  json(res, 200, {
    parameter,
    value: readParameterValue(
      row as Record<string, unknown>,
      parameter,
      paramMap,
    ),
    spec: specPayload,
  });
}

async function handleUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  drugId: number,
  parameter: DrugParameterId,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  if (!(await callerCan(auth.role, CAP['edit.parameter.submit']))) {
    error(
      res,
      403,
      'Contributor role or higher required to submit parameter edits',
    );
    return;
  }

  // A source-value-backed parameter has no authored value to submit: what the
  // table, the forest plot and the simulator read is the aggregate recomputed
  // from its `parameter_entries`. A typed-in number would either be overwritten
  // by the next recompute or sit outside the pool entirely, which is the state
  // this rule exists to prevent — so refuse every such write, with or without
  // entries already on the pair, and name the endpoint that does accept it.
  // Checked before the body is parsed: nothing about the payload can make this
  // parameter editable, and the same rule is re-applied at approval time.
  if (!parameterAcceptsAuthoredValue(parameter)) {
    error(
      res,
      409,
      'This parameter is derived from its source values; add or edit those via /api/parameter-entries instead.',
      'parameter_entry_backed',
    );
    return;
  }

  const parsed = await parseAndValidate(req, updateDrugParameterSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const spec = DRUG_PARAMETERS[parameter];
  const valid = spec.zod.safeParse(parsed.data.value);
  if (!valid.success) {
    error(
      res,
      400,
      'Invalid value: ' +
        valid.error.issues
          .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
          .join('; '),
    );
    return;
  }

  const referenceIds =
    parsed.data.referenceIds ??
    (parsed.data.referenceId ? [parsed.data.referenceId] : []);
  const primaryReferenceId = referenceIds[0] ?? null;

  // Identity/constant metadata (names, aliases, molecular mass, PubChem CID)
  // may be saved without a source; every other parameter must cite one.
  if (parameterRequiresReference(parameter) && referenceIds.length === 0) {
    error(res, 400, 'At least one reference is required for this parameter');
    return;
  }

  // Reference gate: an agent may only cite resolvable references that have
  // been read in full and judged. Applies to both the pending-edit and the
  // admin direct-write paths below. Human contributors are exempt — they are
  // trusted readers, and the cited source joins the agent review queue once the
  // parameter is live. An empty list (exempt metadata) passes either way.
  try {
    await assertReferencesJudgedForActor(referenceIds, auth.userId);
  } catch (err) {
    if (err instanceof ReferenceGateError) {
      error(res, 400, err.message, 'reference_not_judged');
      return;
    }
    throw err;
  }

  const db = getDb();

  // This quantity is not defined for this substance — either an editor marked
  // the pair, or the drug's substanceClass says it is never administered and
  // so has no dose for this parameter to describe. Storing a value would leave
  // two answers to the same question live at once, so refuse and name the fix.
  // Checked for pending edits too: a proposal that can only ever be rejected
  // is not worth a reviewer's time.
  const writeBlockedBy = await parameterWriteBlockedBy(db, drugId, parameter);
  if (writeBlockedBy) {
    error(
      res,
      409,
      new ParameterNotApplicableError(drugId, parameter, writeBlockedBy).message,
      'parameter_not_applicable',
    );
    return;
  }

  // Current state, fetched once and shared by the references-refresh union
  // (below) and the admin direct-write path (further down). A null `existing`
  // here just skips the union — the pending-edit path re-verifies existence
  // under the per-drug advisory lock (closes the drug-merge race), and the
  // admin direct-write asserts it separately with a 404.
  const [existing] = await db
    .select()
    .from(drugs)
    .where(eq(drugs.id, drugId))
    .limit(1);
  const existingParams = existing ? await getDrugParameterMap(db, drugId) : null;
  const currentValue = existing
    ? readParameterValue(
        existing as Record<string, unknown>,
        parameter,
        existingParams,
      )
    : null;

  // References-refresh union (#857 follow-up). A value-unchanged edit is a
  // "just add a source" refresh: the agent playbook (drug-db-maintainer §3.5)
  // submits ONLY the new citation ids — re-listing the parameter's older ones
  // would trip the read-in-full reference gate — while the review diff and the
  // approval path treat the submitted list as the parameter's *complete* new
  // reference set. The result is that every older reference the refresh omitted
  // renders as removed and, once approved, is genuinely dropped from the live
  // citation set. Merge the submitted references with the parameter's current
  // (latest-revision) set so the refresh is additive by construction and can
  // never silently drop a citation that already backs the value. The reference
  // gate above ran on the submitted ids only; the retained prior ids are
  // already live and are grandfathered past it. A genuine value change still
  // replaces the references (the old sources backed the old value).
  let effectiveReferenceIds = referenceIds;
  if (
    existing &&
    referenceIds.length > 0 &&
    parameterValueUnchanged(spec, currentValue, valid.data)
  ) {
    const currentRefs = await latestRevisionReferenceIds(db, drugId, parameter);
    effectiveReferenceIds = unionReferenceIds(referenceIds, currentRefs);
  }

  // Before choosing queued versus direct: an agent granted direct writes
  // would otherwise publish the unquoted value at once.
  if (
    await agentProposalLacksSourceQuote(auth.userId, {
      editType: 'parameter',
      parameter,
      proposedValue: valid.data,
      proposedMeta: { sourceQuote: parsed.data.sourceQuote },
    })
  ) {
    error(res, 400, SOURCE_QUOTE_REQUIRED_MESSAGE, 'source_quote_required');
    return;
  }

  // Non-admin users, or admins explicitly choosing review, create a pending edit.
  if (
    !(await callerCan(auth.role, CAP['edit.directWrite'])) ||
    parsed.data.submitForReview
  ) {
    // At most one OPEN pending edit per (drug, parameter). The pre-check returns
    // a clean 409 carrying the existing row id so a contributor (or an agent)
    // can endorse/refine it instead of re-proposing; the unique index
    // pending_edits_open_parameter_idx closes the concurrent-submit race. This
    // is what stops the review queue from filling with duplicate parameter
    // edits — a contributor token's GET /api/pending-edits hides sibling
    // submitters' open rows, so the dedup must be enforced server-side.
    const [openEdit] = await db
      .select({ id: pendingEdits.id })
      .from(pendingEdits)
      .where(
        and(
          eq(pendingEdits.editType, 'parameter'),
          eq(pendingEdits.targetId, drugId),
          eq(pendingEdits.parameter, parameter),
          eq(pendingEdits.status, 'pending'),
        ),
      )
      .limit(1);
    if (openEdit) {
      json(res, 409, {
        error: 'A pending edit already exists for this parameter',
        code: 'parameter_pending_conflict',
        pendingEditId: openEdit.id,
      });
      return;
    }

    // The submit runs inside a pool transaction that takes the same per-drug
    // advisory lock the merge admin does, then re-verifies the drug exists.
    // This closes the drug-merge race: without the lock, an admin merge could
    // delete the drug row between the pre-checks above and the insert here,
    // landing a pending edit against a drug that no longer exists (never
    // approvable). Under the lock the existence re-check is authoritative —
    // a merge blocks until this transaction commits, or vice versa. This
    // tightens the previous "historically tolerates a missing drug row"
    // behavior: a dangling target_id was never useful, and refusing it here
    // is strictly better than filing a proposal that can never be approved.
    let row: typeof pendingEdits.$inferSelect | undefined;
    let drugMissing = false;
    try {
      const result = await inTransaction(async () => {
        await lockDrugForEntryApplicability(drugId);
        const [drugInTx] = await getDb()
          .select({ id: drugs.id })
          .from(drugs)
          .where(eq(drugs.id, drugId))
          .limit(1);
        if (!drugInTx) return null;
        const [inserted] = await getDb()
          .insert(pendingEdits)
          .values({
            editType: 'parameter',
            targetId: drugId,
            parameter,
            proposedValue: valid.data as never,
            proposedMeta: {
              editSummary: parsed.data.editSummary,
              // Read back by the consensus gate (highRiskEditLacksSourceQuote):
              // a calculation-driving parameter does not auto-publish on peer
              // consensus without the sentence its value was read off.
              sourceQuote: parsed.data.sourceQuote,
            } as never,
            referenceId: primaryReferenceId,
            referenceIds: effectiveReferenceIds.length
              ? effectiveReferenceIds
              : null,
            status: 'pending',
            submittedBy: auth.userId,
          })
          .returning();
        return inserted;
      });
      if (result == null) {
        drugMissing = true;
      } else {
        row = result;
      }
    } catch (err) {
      // Lost the race to a concurrent submission — the unique index fired.
      if (isUniqueViolation(err)) {
        json(res, 409, {
          error: 'A pending edit already exists for this parameter',
          code: 'parameter_pending_conflict',
        });
        return;
      }
      throw err;
    }
    if (drugMissing) {
      error(res, 404, 'Drug not found');
      return;
    }

    if (!row) throw new Error('pendingEdits insert returned no row');

    await recordImplicitAgentApproval({
      userId: auth.userId,
      targetType: 'pending_edit',
      targetId: row.id,
    });

    json(res, 201, { pending: true, pendingEditId: row.id });
    return;
  }

  // Admin: direct update. `existing` and `currentValue` were resolved above
  // (shared with the references-refresh union) and are reused here.
  if (!existing) {
    error(res, 404, 'Drug not found');
    return;
  }

  const oldValue = currentValue;
  const newValue = valid.data;

  // Hold the merge advisory lock through the WHOLE direct write —
  // `buildParameterUpdate` may write drug_parameters, then we bump the drug
  // row, then we insert the revision. Without the outer lock, a concurrent
  // merge can move the value onto the winner and delete the loser between
  // buildParameterUpdate's own transaction release and the revision insert:
  // the revision insert then violates its drug FK and returns 500 even
  // though the value has already appeared on the winner without the
  // intended revision. Under one lock+transaction, the merge blocks until
  // this whole sequence commits (or vice versa) and the drug re-verify
  // turns a merge-deleted target into a clean 404.
  type WriteOutcome =
    | { kind: 'ok'; revisionId: number }
    | { kind: 'gone' }
    | { kind: 'apply_error'; error: ParameterApplyError }
    | { kind: 'not_applicable'; error: ParameterNotApplicableError }
    | { kind: 'value_collides' };
  let outcome: WriteOutcome;
  try {
    outcome = await inTransaction<WriteOutcome>(async () => {
      await lockDrugForEntryApplicability(drugId);
      const txDb = getDb();
      const [drugInTx] = await txDb
        .select({ id: drugs.id })
        .from(drugs)
        .where(eq(drugs.id, drugId))
        .limit(1);
      if (!drugInTx) return { kind: 'gone' };
      let columnUpdate: Record<string, unknown>;
      try {
        columnUpdate = await buildParameterUpdate({
          drugId,
          parameter,
          newValue,
          existing,
          applyingUserId: auth.userId,
        });
      } catch (err) {
        if (err instanceof ParameterApplyError) return { kind: 'apply_error', error: err };
        if (err instanceof ParameterNotApplicableError)
          return { kind: 'not_applicable', error: err };
        throw err;
      }
      try {
        await txDb
          .update(drugs)
          .set({
            ...columnUpdate,
            updatedAt: new Date(),
            popularityScore: sql`${drugs.popularityScore} + 1`,
          } as never)
          .where(eq(drugs.id, drugId));
      } catch (err) {
        if (isUniqueViolation(err)) return { kind: 'value_collides' };
        throw err;
      }
      const [revision] = await txDb
        .insert(drugParameterRevisions)
        .values({
          drugId,
          parameter,
          oldValue: oldValue as never,
          newValue: newValue as never,
          editSummary: parsed.data.editSummary ?? null,
          referenceId: primaryReferenceId,
          referenceIds: effectiveReferenceIds.length
            ? effectiveReferenceIds
            : null,
          createdBy: auth.userId,
        })
        .returning({ id: drugParameterRevisions.id });
      if (!revision)
        throw new Error('drugParameterRevisions insert returned no row');
      // Record the interaction for popularity / audit inside the same
      // merge-locked tx. Left outside, the tx released the advisory lock
      // and a concurrent merge could delete the drug before this insert
      // ran, so the FK-500 hit even though the parameter change had
      // already committed on the survivor.
      await txDb.insert(drugInteractions).values({
        drugId,
        userId: auth.userId,
        eventType: 'edit',
      });
      return { kind: 'ok', revisionId: revision.id };
    });
  } catch (err) {
    throw err;
  }
  if (outcome.kind === 'gone') {
    error(res, 404, 'Drug not found');
    return;
  }
  if (outcome.kind === 'apply_error') {
    error(res, outcome.error.statusHint, outcome.error.message);
    return;
  }
  if (outcome.kind === 'not_applicable') {
    error(res, 409, outcome.error.message, outcome.error.code);
    return;
  }
  if (outcome.kind === 'value_collides') {
    error(res, 409, `${parameter} value collides with an existing drug row`);
    return;
  }

  await recordImplicitAgentApproval({
    userId: auth.userId,
    targetType: 'drug_parameter_revision',
    targetId: outcome.revisionId,
  });

  // Editing a normalization input (blood:plasma ratio, molecular weight) restales
  // every summarizable parameter's cached aggregate — recompute them so the
  // cached value used by the table/simulator matches the read-time summary. Wrap
  // in a transaction so each recompute's advisory lock actually serializes
  // against concurrent entry mutations (a lock on the base auto-commit client
  // releases immediately).
  if (isNormalizationInput(parameter)) {
    await inTransaction(async () => {
      await recomputeSummariesForDrug(drugId, auth.userId);
    });
  }

  // A priority flag is an explicit "dig deep here" instruction: it stays active
  // through committed value changes so agents keep working the parameter, and is
  // cleared only when a human moderator resolves it (see the flag endpoint and
  // agents/drug-db-maintainer.md §3 A0).

  json(res, 200, { parameter, value: newValue });
}

/**
 * The reference ids on the parameter's latest applied revision — the set the
 * review diff treats as the parameter's "current" citations. Empty when the
 * parameter has no prior revision (a first-time value).
 */
async function latestRevisionReferenceIds(
  db: ReturnType<typeof getDb>,
  drugId: number,
  parameter: DrugParameterId,
): Promise<number[]> {
  const [rev] = await db
    .select({
      referenceId: drugParameterRevisions.referenceId,
      referenceIds: drugParameterRevisions.referenceIds,
    })
    .from(drugParameterRevisions)
    .where(
      and(
        eq(drugParameterRevisions.drugId, drugId),
        eq(drugParameterRevisions.parameter, parameter),
      ),
    )
    .orderBy(desc(drugParameterRevisions.createdAt))
    .limit(1);
  if (!rev) return [];
  if (rev.referenceIds && rev.referenceIds.length > 0) return rev.referenceIds;
  return rev.referenceId != null ? [rev.referenceId] : [];
}

/**
 * Submitted ids first (keeping the caller's primary at index 0), then any
 * current id not already present. Dedupes and drops non-positive ids.
 */
function unionReferenceIds(submitted: number[], current: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of [...submitted, ...current]) {
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * True when the submitted value equals the parameter's current value. Both are
 * normalized through the parameter's zod schema so defaulted fields or key
 * ordering never produce a spurious "changed" (which would skip the union and
 * let a references refresh drop live citations). A value the schema can't parse
 * falls back to a raw comparison — conservatively treated as changed.
 */
function parameterValueUnchanged(
  spec: (typeof DRUG_PARAMETERS)[DrugParameterId],
  current: unknown,
  submitted: unknown,
): boolean {
  if (current === null || current === undefined) return false;
  const norm = (v: unknown): string => {
    const parsed = spec.zod.safeParse(v);
    return JSON.stringify(parsed.success ? parsed.data : v);
  };
  return norm(current) === norm(submitted);
}
