/**
 * In-app (and, for users who opted in, email) notice to a human submitter
 * that a reviewer decided their pending edit: approved, rejected, or returned
 * for changes. Agents are skipped inside {@link notifyContributionFeedback};
 * they are woken through their hooks instead.
 */
import type { NotificationType } from '../../db/schema.js';
import { notifyContributionFeedback } from './notifications.js';

export type EditDecision = 'approved' | 'rejected' | 'returned';

const TYPE: Record<EditDecision, NotificationType> = {
  approved: 'edit_approved',
  rejected: 'edit_rejected',
  returned: 'edit_returned',
};

// Titles are stored in fixed English and localized at the React boundary and
// in the email templates by `type`, like the dispute notifications.
const TITLE: Record<EditDecision, string> = {
  approved: 'Your edit was approved',
  rejected: 'Your edit was rejected',
  returned: 'Your edit was returned for changes',
};

export async function notifyEditDecision(args: {
  edit: { id: number; submittedBy: number; editType: string };
  decision: EditDecision;
  /** The deciding reviewer, or null for an automatic decision. */
  actorUserId: number | null;
  /** The reviewer's comment, rejection reason or return note, if any. */
  note?: string | null;
}): Promise<void> {
  const note = args.note?.trim();
  await notifyContributionFeedback({
    recipientUserId: args.edit.submittedBy,
    actorUserId: args.actorUserId,
    type: TYPE[args.decision],
    targetType: 'pending_edit',
    targetId: args.edit.id,
    title: TITLE[args.decision],
    bodyMd: note ? note : null,
    // `status=all`: a reviewer-tier author's /review defaults to the pending
    // filter, which would hide the very edit that was just decided.
    url: `/review?id=${args.edit.id}&status=all`,
  });
}

/**
 * For a decision that has ALREADY committed on its own (reject, return): the
 * notice is ancillary, so a failure to write it is logged rather than thrown.
 * Throwing would answer the reviewer with a 500 for a decision that stands,
 * and a retry would then act on an edit that is no longer open. The approval
 * path does not use this: it writes the notice inside the approval
 * transaction, so the two commit together.
 */
export async function notifyEditDecisionAfterCommit(
  args: Parameters<typeof notifyEditDecision>[0],
): Promise<void> {
  try {
    await notifyEditDecision(args);
  } catch (err) {
    console.error(
      `[pending-edits] ${args.decision} notice for edit ${args.edit.id} failed:`,
      err,
    );
  }
}
