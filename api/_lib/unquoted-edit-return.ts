/**
 * Sending an unquoted calculation-driving proposal back to the agent that
 * submitted it.
 *
 * A calculation-driving parameter never publishes on agent consensus without
 * the verbatim sentence its value was read off (`source-quote-gate.ts`). That
 * guard stays exactly as it is. What changes is where a held proposal goes:
 * it used to wait in /review for a person, though nothing about it needed a
 * person's judgment. The agents are not in disagreement and nobody disputed
 * the value; the proposal is simply missing a field its own author can supply.
 *
 * So the proposal is returned to its author with a note naming the missing
 * quote. The author's §2.C return reconciliation (`agents/drug-db-maintainer.md`)
 * already handles exactly this state: it re-reads the source, adds the quote and
 * resubmits, and the peers verify the attested version. People come in only
 * when the agents cannot settle something between them, not to type in a
 * sentence an agent can copy from the paper.
 *
 * It is a note-only return, the same shape as a reviewer's comment-only return:
 * the payload is untouched, the verdicts formed against it stay, and
 * `proposed_meta.returnedAt` holds consensus until the author actually revises
 * (`returnStandsUnrevised`).
 */

import { eq } from 'drizzle-orm';
import { getDb, inTransaction } from './db.js';
import { pendingEdits } from '../../db/schema.js';
import { fireAgentHookForSubmitterAsync } from './agentHooks.js';
import { isActiveAgentUser, pendingEditSourceQuote } from './agent-verifications.js';
import {
  hasOpenDispute,
  pendingEditUpheldRulingStands,
  unresolvedDisputeVerdictCount,
} from './disputes.js';
import { returnStandsUnrevised } from './pending-edit-review-token.js';
import { lockVerificationSourceRow } from './verification-targets.js';

/** The note's fixed prefix, so the author and the queue can recognise it. */
export const UNQUOTED_RETURN_PREFIX = '[source quote missing — returned automatically]';

/**
 * The note on an automatic return. A proposal already marked stale
 * (`proposed_meta.conflict`) has a second blocker the quote does not clear —
 * the approval refuses it until the author rebases — so the note says so;
 * naming only the quote would send the author back with an edit that still
 * cannot apply.
 */
export function composeUnquotedReturnNote(
  parameter: string | null,
  opts: { conflicted?: boolean } = {},
): string {
  const note =
    `${UNQUOTED_RETURN_PREFIX} ${parameter ?? 'This parameter'} drives ` +
    `calculations, so it publishes on peer consensus only with the verbatim ` +
    `sentence (or table row) from the primary source that states this value. ` +
    `Re-read the source, add that sentence as the quote, and resubmit. If no ` +
    `sentence in the source states this value for the condition you claim, ` +
    `narrow the claim to what the source does state, or withdraw the proposal.`;
  if (!opts.conflicted) return note;
  return (
    `${note} The value this proposal changes has also been changed since you ` +
    `proposed it, so the proposal is stale: re-read its current state and ` +
    `revise the proposal against it as well, or withdraw it if the change ` +
    `already covers yours.`
  );
}

export type UnquotedReturnOutcome =
  | { returned: true }
  | {
      returned: false;
      reason:
        | 'not_found'
        | 'not_open'
        | 'human_submitted'
        | 'revised_since'
        | 'quote_stated'
        | 'disputed'
        | 'return_stands'
        | 'upheld_ruling_stands';
    };

/**
 * Return the pending edit to its submitting agent for a missing source quote,
 * when the missing quote is the only thing standing between it and
 * publication.
 *
 * Every condition is decided inside one transaction, after taking the pending
 * edit's row lock — the same source-row lock a verdict write
 * (`recordVerification`) and a dispute (`upsertOpenDispute`) take first. So a
 * dispute raised concurrently either commits before this check (and is seen)
 * or waits until the return has committed; it can never land in between and
 * be overwritten by a note that says only the quote is missing.
 *
 * Not returned, and left for the ordinary hold:
 * - a human contributor's proposal: it never publishes on agent consensus,
 *   and agents do not moderate human work;
 * - a payload that states a quote: the write treats it as an echo of the
 *   stored sentence, and re-sending it cannot clear that;
 * - a proposal anyone disputes, by agent verdict or human dispute: the note
 *   would misstate the objection, and the author's revision would clear the
 *   dispute verdicts with the value unchanged;
 * - a proposal a reviewer already returned, or an upheld ruling still binds,
 *   that has not been revised since: replacing that return note with this one
 *   would let the author clear it by adding only a quote.
 *
 * `submittedAt` is the version the caller found unquoted; a proposal revised
 * since then is left alone.
 */
export async function returnUnquotedAgentEdit(args: {
  pendingEditId: number;
  submittedAt: Date | null;
}): Promise<UnquotedReturnOutcome> {
  const outcome = await inTransaction(async (): Promise<
    UnquotedReturnOutcome & { edit?: { id: number; submittedBy: number; editType: string; targetId: number | null } }
  > => {
    const db = getDb();
    await lockVerificationSourceRow(db, 'pending_edit', args.pendingEditId);
    const [edit] = await db
      .select({
        id: pendingEdits.id,
        status: pendingEdits.status,
        editType: pendingEdits.editType,
        targetId: pendingEdits.targetId,
        submittedBy: pendingEdits.submittedBy,
        submittedAt: pendingEdits.submittedAt,
        parameter: pendingEdits.parameter,
        proposedValue: pendingEdits.proposedValue,
        proposedMeta: pendingEdits.proposedMeta,
      })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, args.pendingEditId))
      .limit(1);
    if (!edit) return { returned: false, reason: 'not_found' };
    if (edit.status !== 'pending') return { returned: false, reason: 'not_open' };
    if (
      args.submittedAt &&
      edit.submittedAt &&
      edit.submittedAt.getTime() !== args.submittedAt.getTime()
    ) {
      return { returned: false, reason: 'revised_since' };
    }
    if (edit.submittedBy == null || !(await isActiveAgentUser(edit.submittedBy))) {
      return { returned: false, reason: 'human_submitted' };
    }
    if (pendingEditSourceQuote(edit) !== null) {
      return { returned: false, reason: 'quote_stated' };
    }
    if (
      (await unresolvedDisputeVerdictCount({ targetType: 'pending_edit', targetId: edit.id })) > 0 ||
      (await hasOpenDispute({ targetType: 'pending_edit', targetId: edit.id }))
    ) {
      return { returned: false, reason: 'disputed' };
    }
    if (returnStandsUnrevised(edit.proposedMeta)) {
      return { returned: false, reason: 'return_stands' };
    }
    if (await pendingEditUpheldRulingStands(edit.id, edit.proposedMeta)) {
      return { returned: false, reason: 'upheld_ruling_stands' };
    }

    const meta =
      edit.proposedMeta && typeof edit.proposedMeta === 'object' && !Array.isArray(edit.proposedMeta)
        ? (edit.proposedMeta as Record<string, unknown>)
        : {};
    const now = new Date();
    await db
      .update(pendingEdits)
      .set({
        status: 'returned',
        // A return, not a rejection: no reason category, as on the manual path.
        rejectionReason: null,
        rejectionComment: composeUnquotedReturnNote(edit.parameter, {
          conflicted: Boolean(meta.conflict),
        }),
        // No person decided this; the system applied a standing rule.
        reviewedBy: null,
        reviewedAt: now,
        // Holds consensus until the author actually revises
        // (`returnStandsUnrevised`), as a reviewer's note-only return does.
        proposedMeta: { ...meta, returnedAt: now.toISOString() } as never,
      })
      .where(eq(pendingEdits.id, edit.id));
    return {
      returned: true,
      edit: {
        id: edit.id,
        submittedBy: edit.submittedBy,
        editType: edit.editType,
        targetId: edit.targetId ?? null,
      },
    };
  });
  if (!outcome.returned) return outcome;

  // After the commit, as on the manual path: the same wake-up a manual return
  // fires, so the author revises this cycle.
  const edit = outcome.edit!;
  fireAgentHookForSubmitterAsync(edit.submittedBy, {
    kind: 'edit_returned',
    pendingEditId: edit.id,
    editType: edit.editType,
    targetId: edit.targetId,
  });
  return { returned: true };
}
