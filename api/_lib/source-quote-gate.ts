import {
  highRiskEditNeedsSourceQuote,
  pendingEditSourceQuote,
} from './agent-verifications.js';
import { quoteAfterUpdate } from './parameter-entries-store.js';

/**
 * The target row and patch of a `param_entry` UPDATE proposal, or `null` when
 * the proposal is not one.
 *
 * Only an update has a stored row behind it, and so only an update has an
 * effective quote that can differ from the one its payload carries. A create
 * and a delete are settled by the payload alone.
 */
function entryUpdateOf(pending: {
  editType: string | null | undefined;
  targetId?: number | null;
  proposedValue?: unknown;
}): { targetId: number; patch: Parameters<typeof quoteAfterUpdate>[1] } | null {
  if (pending.editType !== 'param_entry') return null;
  const value = pending.proposedValue;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.op !== 'update' || pending.targetId == null) return null;
  const patch = record.patch;
  if (!patch || typeof patch !== 'object') return null;
  return {
    targetId: pending.targetId,
    patch: patch as Parameters<typeof quoteAfterUpdate>[1],
  };
}

/**
 * True when publishing this proposal unattended would put a calculation-driving
 * value on the record with no verbatim quote behind it.
 *
 * ## Why the payload cannot answer this
 *
 * For most proposals it can: the quote travels in the payload and what is sent
 * is what is stored. For a `param_entry` UPDATE it cannot, and reading the
 * payload is wrong in BOTH directions:
 *
 *  - an OMITTED quote is routinely preserved from the stored row — the editor
 *    omits an untouched quote deliberately — so a payload-only read holds a
 *    proposal that publishes perfectly well attested, and a contributor fixing
 *    a typo in the comments of a well-quoted entry could never get it out;
 *  - a STATED quote may be an echo of the sentence already stored, which the
 *    write recognises as unchanged and puts back through the preserve-or-clear
 *    rule — clearing it once the reading has moved. A payload-only read sees a
 *    non-empty string, authorizes the publication, and the value lands with no
 *    provenance at all: the #1201 failure, reached through the gate built to
 *    prevent it.
 *
 * Only the write knows which happens, so for every in-scope update we ask the
 * write, whatever the payload says. Asking it — rather than re-deriving the
 * preserve-or-clear rule here — is what keeps the gate and the update from
 * drifting apart, which is how the second direction opened in the first place.
 *
 * ## Why it lives here
 *
 * Two callers need this answer: the live gate (`applyOnAgentConsensus`) and the
 * shadow dossier, which compares the generic governance engine against the
 * legacy one. The dossier's whole value is that a divergence means a difference
 * in reasoning; a second copy of this rule would make a divergence mean a
 * difference in *transcription* instead, and worse, a drifted copy would report
 * agreement on the edits where the two engines actually differ. One statement,
 * one behaviour.
 */
export async function highRiskProposalWouldPublishUnquoted(
  pending: {
    editType: string | null | undefined;
    parameter: string | null | undefined;
    targetId?: number | null;
    proposedValue?: unknown;
    proposedMeta?: unknown;
  },
  onError?: (err: unknown) => void,
): Promise<boolean> {
  if (!highRiskEditNeedsSourceQuote(pending)) return false;

  const update = entryUpdateOf(pending);
  if (!update) return pendingEditSourceQuote(pending) == null;

  try {
    return (await quoteAfterUpdate(update.targetId, update.patch)) === null;
  } catch (err) {
    // Fail closed. A fault means we do not know what the write would leave
    // behind, and "we do not know" must never authorize an unattended
    // publication of a calculation-driving value; the edit waits for a human.
    onError?.(err);
    return true;
  }
}
