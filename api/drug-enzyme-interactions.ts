/**
 * Drug↔enzyme interactions endpoint (#785 Phase 6 follow-up).
 *   GET ?drugId=  — list a drug's enzyme interactions (substrate/inducer/
 *                   inhibitor rows against canonical enzyme entities).
 *   PUT ?drugId=  — full-replace them. Contributor+ submissions queue as a
 *                   pending edit (editType='enzyme_interaction'); admins write
 *                   directly unless they pass `submitForReview: true`.
 *
 * Mirrors the metabolism / receptor-target write pattern.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb, runInPoolTransaction } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { enzymeInteractionsWriteSchema } from './_lib/schemas.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import { drugs, pendingEdits } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { recordImplicitAgentApproval } from './_lib/agent-verifications.js';
import {
  EnzymeInteractionWriteError,
  getDrugEnzymeInteractions,
  replaceDrugEnzymeInteractions,
  validateEnzymeInteractionsInput,
} from './_lib/enzymeInteractionStore.js';
import {
  lockDrugForEntryApplicability,
  withDrugApplicabilityLock,
} from './_lib/parameterApplicabilityStore.js';

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    const drugId = Number(url.searchParams.get('drugId'));
    if (!drugId || !Number.isInteger(drugId) || drugId <= 0) {
      error(res, 400, 'Missing or invalid drugId');
      return;
    }

    if (req.method === 'GET') {
      const interactions = await getDrugEnzymeInteractions(getDb(), drugId);
      json(res, 200, { interactions });
      return;
    }
    if (req.method === 'PUT') {
      assertSameOrigin(req);
      return handlePut(req, res, drugId);
    }
    error(res, 405, 'Method not allowed');
  },
);

async function handlePut(
  req: IncomingMessage,
  res: ServerResponse,
  drugId: number,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  if (!(await callerCan(auth.role, CAP['edit.enzymeInteraction.submit']))) {
    error(res, 403, 'Contributor role or higher required');
    return;
  }

  // Snapshot the drug before any unlocked work touches it — including
  // `parseAndValidate` reading the request body below, not just the business
  // validation and direct-write permission check that follow it. Both
  // branches compare a post-lock re-read against this snapshot to detect a
  // merge that landed while the request was in flight (#1076 item 1;
  // snapshot position per Codex review on #1426 — taking it any later, even
  // after only the body read, leaves a gap of the handler's own making for a
  // merge to land in, undetected, before the snapshot is taken). A gap
  // between the client observing the pre-merge state and this point — e.g.
  // the request's own network transit — is not something a server-side
  // snapshot, however early, can close; that would need the client to send
  // its own expected version, which is a larger, cross-cutting change to
  // every full-replacement submit endpoint and out of scope for #1076 item 1.
  const [pre] = await getDb()
    .select({ updatedAt: drugs.updatedAt })
    .from(drugs)
    .where(eq(drugs.id, drugId))
    .limit(1);
  if (!pre) {
    error(res, 404, 'Target drug not found', 'drug_not_found');
    return;
  }
  const snapshot = pre.updatedAt;

  const parsed = await parseAndValidate(req, enzymeInteractionsWriteSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const { editSummary, submitForReview, interactions } = parsed.data;

  try {
    await validateEnzymeInteractionsInput(getDb(), drugId, interactions);
  } catch (err) {
    if (err instanceof EnzymeInteractionWriteError) {
      error(res, err.statusHint, err.message);
      return;
    }
    throw err;
  }

  if (
    !(await callerCan(auth.role, CAP['edit.directWrite'])) ||
    submitForReview
  ) {
    // Share the per-drug advisory lock with the merge admin: without it, a
    // submission landing between the merge's up-front refusal check and its
    // teardown delete is neither caught nor serialized, and an approval
    // later REPLACEs the merged drug's list with a payload authored against
    // the pre-merge loser. An id-only re-check isn't enough either: a PUT
    // against the merge's WINNER still finds the drug there after the merge
    // commits, so it would happily queue a full-replacement proposal built
    // from pre-merge state right after the merge folded the loser's rows
    // onto it. Same snapshot-and-compare the admin direct-write branch below
    // uses: `drugs.updatedAt` is bumped by the merge on the winner, so a
    // drift between the snapshot above and the post-lock read means a merge
    // landed while this request was in flight.
    type QueueOutcome =
      | { kind: 'ok'; id: number }
      | { kind: 'gone' }
      | { kind: 'changed' };
    const outcome = await withDrugApplicabilityLock(
      drugId,
      async (): Promise<QueueOutcome> => {
        const [drugInTx] = await getDb()
          .select({ updatedAt: drugs.updatedAt })
          .from(drugs)
          .where(eq(drugs.id, drugId))
          .limit(1);
        if (!drugInTx) return { kind: 'gone' };
        if (drugInTx.updatedAt.getTime() !== snapshot.getTime()) {
          return { kind: 'changed' };
        }
        const [row] = await getDb()
          .insert(pendingEdits)
          .values({
            editType: 'enzyme_interaction',
            targetId: drugId,
            proposedValue: { interactions } as never,
            proposedMeta: (editSummary ? { editSummary } : null) as never,
            status: 'pending',
            submittedBy: auth.userId,
          })
          .returning({ id: pendingEdits.id });
        if (!row) throw new Error('pendingEdits insert returned no row');
        return { kind: 'ok', id: row.id };
      },
    );
    if (outcome.kind === 'gone') {
      error(res, 404, 'Target drug not found', 'drug_not_found');
      return;
    }
    if (outcome.kind === 'changed') {
      error(
        res,
        409,
        'The drug changed while this request was in flight (a concurrent merge folded new rows onto it). Reload the drug and re-submit.',
        'drug_changed',
      );
      return;
    }

    await recordImplicitAgentApproval({
      userId: auth.userId,
      targetType: 'pending_edit',
      targetId: outcome.id,
    });

    json(res, 201, { pending: true, pendingEditId: outcome.id });
    return;
  }

  // Admin direct write — same merge-lock protocol as drug-metabolism.ts and
  // drug-receptor-targets.ts. Full-replacement DELETEs the child rows and
  // re-inserts a stale pre-merge payload, so the advisory lock serializes
  // with the merge admin and the drug re-verify turns a merge-deleted
  // target into a 404 instead of a silent overwrite. Ordering isn't enough:
  // after waiting for a merge the drug still exists but its child rows now
  // include just-folded loser data, and this pre-merge payload would delete
  // them. Reuse the `snapshot` taken above (before any unlocked work),
  // re-read under the lock, and 409 with `drug_changed` when it drifted.
  type DirectOutcome = { kind: 'ok' } | { kind: 'gone' } | { kind: 'changed' };
  let outcome: DirectOutcome;
  try {
    outcome = await runInPoolTransaction<DirectOutcome>(async () => {
      await lockDrugForEntryApplicability(drugId);
      const [drugInTx] = await getDb()
        .select({ updatedAt: drugs.updatedAt })
        .from(drugs)
        .where(eq(drugs.id, drugId))
        .limit(1);
      if (!drugInTx) return { kind: 'gone' };
      if (drugInTx.updatedAt.getTime() !== snapshot.getTime()) {
        return { kind: 'changed' };
      }
      await replaceDrugEnzymeInteractions(getDb(), drugId, interactions, auth.userId);
      return { kind: 'ok' };
    });
  } catch (err) {
    if (err instanceof EnzymeInteractionWriteError) {
      error(res, err.statusHint, err.message);
      return;
    }
    throw err;
  }
  if (outcome.kind === 'gone') {
    error(res, 404, 'Target drug not found', 'drug_not_found');
    return;
  }
  if (outcome.kind === 'changed') {
    error(
      res,
      409,
      'The drug changed while this request was in flight (a concurrent merge folded new rows onto it). Reload the drug and re-submit.',
      'drug_changed',
    );
    return;
  }

  const interactionsOut = await getDrugEnzymeInteractions(getDb(), drugId);
  json(res, 200, { interactions: interactionsOut });
}
