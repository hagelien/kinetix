/**
 * Drug metabolism endpoint.
 *   GET ?drugId=   — current metabolism box (profile + metabolite/precursor
 *                    links), or `{ metabolism: null }` when empty.
 *   PUT ?drugId=   — replace the metabolism box. Contributor+ submissions are
 *                    queued as a pending edit (editType='metabolism'); admins
 *                    write directly unless they pass `submitForReview: true`.
 *
 * Metabolism is full-replace: the client sends the complete desired state and
 * the apply step (here for admins, in applyApprovedEdit for the review queue)
 * clears and re-inserts the rows. See api/_lib/metabolismStore.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb, runInPoolTransaction } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { metabolismWriteSchema } from './_lib/schemas.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import { drugs, pendingEdits } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { recordImplicitAgentApproval } from './_lib/agent-verifications.js';
import {
  getDrugMetabolism,
  MetabolismWriteError,
  replaceDrugMetabolism,
  toMetabolismWriteInput,
  validateMetabolismInput,
} from './_lib/metabolismStore.js';
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

    switch (req.method) {
      case 'GET':
        return handleGet(res, drugId);
      case 'PUT':
        assertSameOrigin(req);
        return handlePut(req, res, drugId);
      default:
        error(res, 405, 'Method not allowed');
    }
  },
);

async function handleGet(res: ServerResponse, drugId: number): Promise<void> {
  const metabolism = await getDrugMetabolism(getDb(), drugId);
  json(res, 200, { metabolism });
}

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
  if (!(await callerCan(auth.role, CAP['edit.metabolism.submit']))) {
    error(
      res,
      403,
      'Contributor role or higher required to submit metabolism edits',
    );
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

  const parsed = await parseAndValidate(req, metabolismWriteSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const { editSummary, submitForReview, ...payload } = parsed.data;
  const input = toMetabolismWriteInput(payload);

  // Reject obviously-broken submissions early (dangling links, duplicate
  // names) so the review queue never fills with unapprovable rows.
  try {
    await validateMetabolismInput(getDb(), drugId, input);
  } catch (err) {
    if (err instanceof MetabolismWriteError) {
      error(res, err.statusHint, err.message);
      return;
    }
    throw err;
  }

  // Non-admins, and admins who opt in, route through the review queue. The
  // proposedValue carries the full desired state (including display-only
  // names) so the review card and approval re-validate the exact payload.
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
            editType: 'metabolism',
            targetId: drugId,
            proposedValue: payload as never,
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

  // Admin direct write. Share the per-drug advisory lock with the merge
  // admin: full-replacement DELETEs child rows and re-inserts a stale
  // pre-merge payload, so without the lock a concurrent merge's just-folded
  // loser-only rows would be silently overwritten. Under the lock the merge
  // and the direct write serialize; the drug re-verify inside the lock
  // turns a merge-deleted target into an accurate 404.
  //
  // Ordering alone isn't enough. If the merge holds the advisory lock and
  // this request has to wait for it, by the time we get the lock the merge
  // has already folded loser-only child rows onto this winner — and our
  // request payload was built before that fold, so applying it would delete
  // exactly those rows. Reuse the `snapshot` taken above (before any
  // unlocked work), re-read `drugs.updatedAt` under the lock, and reject
  // with `drug_changed` if it drifted so the admin sees a 409 and reloads
  // instead of a silent overwrite.
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
      await replaceDrugMetabolism(getDb(), drugId, input, auth.userId);
      return { kind: 'ok' };
    });
  } catch (err) {
    if (err instanceof MetabolismWriteError) {
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

  const metabolism = await getDrugMetabolism(getDb(), drugId);
  json(res, 200, { metabolism });
}
