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

import { and, eq, sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { pendingEdits } from '../../db/schema.js';
import { fireAgentHookForSubmitterAsync } from './agentHooks.js';
import { isActiveAgentUser } from './agent-verifications.js';

/** The note's fixed prefix, so the author and the queue can recognise it. */
export const UNQUOTED_RETURN_PREFIX = '[source quote missing — returned automatically]';

export function composeUnquotedReturnNote(parameter: string | null): string {
  return (
    `${UNQUOTED_RETURN_PREFIX} ${parameter ?? 'This parameter'} drives ` +
    `calculations, so it publishes on peer consensus only with the verbatim ` +
    `sentence (or table row) from the primary source that states this value. ` +
    `Re-read the source, add that sentence as the quote, and resubmit. If no ` +
    `sentence in the source states this value for the condition you claim, ` +
    `narrow the claim to what the source does state, or withdraw the proposal.`
  );
}

export type UnquotedReturnOutcome =
  | { returned: true }
  | { returned: false; reason: 'not_found' | 'not_open' | 'human_submitted' | 'raced' };

/**
 * Return the pending edit to its submitting agent for a missing source quote.
 *
 * Only an active agent's proposal is returned: a human contributor's proposal
 * never publishes on agent consensus in the first place, and agents do not
 * moderate human work. `submittedAt` is the version the caller found unquoted;
 * the write matches it, so a proposal the author revised in the meantime (for
 * instance by adding the quote) is left alone.
 */
export async function returnUnquotedAgentEdit(args: {
  pendingEditId: number;
  submittedAt: Date | null;
}): Promise<UnquotedReturnOutcome> {
  const db = getDb();
  const [edit] = await db
    .select({
      id: pendingEdits.id,
      status: pendingEdits.status,
      editType: pendingEdits.editType,
      targetId: pendingEdits.targetId,
      submittedBy: pendingEdits.submittedBy,
      parameter: pendingEdits.parameter,
      proposedMeta: pendingEdits.proposedMeta,
    })
    .from(pendingEdits)
    .where(eq(pendingEdits.id, args.pendingEditId))
    .limit(1);
  if (!edit) return { returned: false, reason: 'not_found' };
  if (edit.status !== 'pending') return { returned: false, reason: 'not_open' };
  if (edit.submittedBy == null || !(await isActiveAgentUser(edit.submittedBy))) {
    return { returned: false, reason: 'human_submitted' };
  }

  const meta =
    edit.proposedMeta && typeof edit.proposedMeta === 'object' && !Array.isArray(edit.proposedMeta)
      ? (edit.proposedMeta as Record<string, unknown>)
      : {};
  const updated = await db
    .update(pendingEdits)
    .set({
      status: 'returned',
      // A return, not a rejection: no reason category, as on the manual path.
      rejectionReason: null,
      rejectionComment: composeUnquotedReturnNote(edit.parameter),
      // No person decided this; the system applied a standing rule.
      reviewedBy: null,
      reviewedAt: new Date(),
      proposedMeta: { ...meta, returnedAt: new Date().toISOString() } as never,
    })
    // The version the caller examined, compared truncated for the same reason
    // as the reviewer lock (`pendingEditReviewerLock`): the column stores
    // microseconds, drizzle reads milliseconds back.
    .where(
      and(
        eq(pendingEdits.id, edit.id),
        eq(pendingEdits.status, 'pending'),
        ...(args.submittedAt
          ? [sql`date_trunc('milliseconds', ${pendingEdits.submittedAt}) = ${args.submittedAt}`]
          : []),
      ),
    )
    .returning({ id: pendingEdits.id });
  if (updated.length === 0) return { returned: false, reason: 'raced' };

  // The same wake-up a manual return fires, so the author revises this cycle.
  fireAgentHookForSubmitterAsync(edit.submittedBy, {
    kind: 'edit_returned',
    pendingEditId: edit.id,
    editType: edit.editType,
    targetId: edit.targetId ?? null,
  });
  return { returned: true };
}
