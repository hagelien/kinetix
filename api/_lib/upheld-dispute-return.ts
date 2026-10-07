/**
 * Returning the pending edit an upheld dispute was ruled against.
 *
 * Upholding a dispute used to be pure bookkeeping: the row closed, the author
 * lost the right to approve their own submission
 * (`self_approval_blocked_by_upheld_dispute`), a `dispute_resolved` notice
 * went out — and the edit itself sat in the queue exactly as before. Nothing
 * downstream moved. The submitting agent's own reconciliation sweeps look for
 * two states and neither is "a ruling was made": §2.B of
 * `agents/drug-db-maintainer.md` scans its open edits for *agent dispute
 * verdicts* (which survive a ruling, so an agent-raised objection does keep
 * driving the loop), and §2.C scans for edits a reviewer *returned*. A
 * human-raised dispute produces no verdict row at all, so upholding one left
 * the edit parked until a moderator separately clicked "return" and retyped
 * the objection into the return note.
 *
 * The objection is already the note. A dispute must be ≥20 characters of
 * substantive reasoning with its evidence attached (`createDisputeSchema`),
 * and in practice reads like the return note a reviewer would have written —
 * what is wrong, why, and the correction to make. So upholding now returns the
 * edit and carries that text over verbatim as `rejection_comment`, which is
 * the field §2.C already reads (and already treats as untrusted prose). The
 * existing return machinery then does the rest: the submitting agent is woken
 * by the same `edit_returned` hook a manual return fires, revises the payload,
 * and resubmits — the autonomous loop the ruling was always pointing at.
 *
 * What this deliberately does NOT do:
 * - touch the payload. A return is "fix this", not a reviewer rewrite, so
 *   `proposed_meta.revisedAt` stays as it was and the upheld ruling keeps
 *   standing until the author makes an actual revision.
 * - clear verifications. No content changed, so the verdicts formed against
 *   this payload are still about this payload.
 * - move anything that is not an open proposal. An edit already approved,
 *   rejected or returned is left alone.
 */

import { and, eq, sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { pendingEdits, type AgentVerificationEvidenceRef } from '../../db/schema.js';
import { fireAgentHookForSubmitterAsync } from './agentHooks.js';
import {
  isActiveAgentUser,
  isSelfReviewAgentUser,
} from './agent-verifications.js';
import { isModelStructureParameter } from '../../src/lib/drugParameters.js';
import { pendingEditTargetVersionSubmittedAt } from './disputes.js';
import { notifyEditDecision } from './editDecisionNotifications.js';

/**
 * Cap for the composed note. `pending_edits.rejection_comment` is unbounded
 * `text`, but a reviewer-supplied return note is capped at 2000 chars
 * (`reviewPendingEditSchema`) and a dispute reason may run to 5000, so the
 * generated note stays inside the limit every other writer respects rather
 * than producing a row no human could have submitted.
 */
export const UPHELD_RETURN_NOTE_MAX = 2000;

/**
 * How much of the objection's own words a truncated note keeps, whatever the
 * evidence line costs. A note that is all citations and no reasoning tells the
 * author nothing about what to change, which is the one thing it exists to say.
 */
const MIN_BODY_CHARS = 400;

export type UpheldReturnSkipReason =
  | 'not_found'
  | 'not_open'
  | 'own_edit_not_allowed'
  | 'decide_not_allowed'
  | 'agent_moderation_not_allowed'
  | 'model_structure_not_allowed'
  | 'revised_since';

export type UpheldReturnOutcome =
  | { returned: true }
  | { returned: false; reason: UpheldReturnSkipReason };

/**
 * When this edit's payload was last actually revised, per the marker the
 * submitter-update branch stamps (`api/pending-edits.ts` owns the write). Not
 * `submitted_at`, which moves on a status-only resubmit.
 */
function payloadRevisedAt(proposedMeta: unknown): Date | null {
  if (!proposedMeta || typeof proposedMeta !== 'object') return null;
  const raw = (proposedMeta as Record<string, unknown>).revisedAt;
  if (typeof raw !== 'string') return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/** How much of a quote-only evidence ref the note carries. */
const EVIDENCE_QUOTE_MAX = 160;

/**
 * Render one evidence ref as a compact, human-readable token.
 *
 * `evidenceRefSchema` accepts a ref carrying only a `quote` — a passage from a
 * source that has no citation row yet — and the dispute panel shows it. A
 * formatter that reads only `citationId`/`url` dropped that form from the note
 * entirely, and since the resolved dispute is not readable through the open
 * feed (#1318) the author had no way back to it. The quote is untrusted author
 * text like the reason it supports, so it is length-bounded and quoted, never
 * interpreted.
 */
function formatEvidenceRef(ref: AgentVerificationEvidenceRef): string | null {
  const parts: string[] = [];
  if (typeof ref.citationId === 'number') parts.push(`#${ref.citationId}`);
  if (typeof ref.url === 'string' && ref.url.trim()) parts.push(ref.url.trim());
  if (parts.length > 0) return parts.join(' ');

  const quote = typeof ref.quote === 'string' ? ref.quote.trim() : '';
  if (!quote) return null;
  const shown =
    quote.length > EVIDENCE_QUOTE_MAX
      ? `${quote.slice(0, EVIDENCE_QUOTE_MAX).trimEnd()}…`
      : quote;
  return `«${shown}»`;
}

/**
 * The return note an upheld dispute produces: a one-line marker naming the
 * ruling, then the objection's own words, then its evidence.
 *
 * The marker matters as much as the text. A returned edit reaches the author
 * with no other indication of where the note came from, and "a moderator
 * agreed with an objection" is a different instruction from "a reviewer wants
 * a change" — it says the correction has already been argued and sourced, so
 * answer *that*, not the note in isolation. The dispute id identifies the row
 * this note came from; `GET /api/disputes` serves the OPEN feed only, so an
 * upheld row is not readable there and the note has to carry what the author
 * needs — which is why the evidence line renders a quote-only ref too (#1318).
 *
 * `reasonMd` is author-authored, untrusted text. It is copied verbatim into a
 * data field that every reader — the /review card, the submitting agent's
 * §2.C sweep — already handles as untrusted prose; it is never interpreted
 * here.
 */
export function composeUpheldReturnNote(args: {
  disputeId: number;
  source: string;
  reasonMd: string;
  evidenceRefs?: AgentVerificationEvidenceRef[];
  /** When the objection was raised, so the author can date it. */
  raisedAt?: Date | null;
  /** Who ruled: a moderator (default) or the T3 adjudication panel. */
  ruledBy?: 'moderator' | 'adjudication_panel';
}): string {
  // The marker dates the objection as well as naming it. The return refuses a
  // payload revised after `raisedAt`, but nothing can establish which version
  // the objection's *prose* was written about — a reviewer can read one
  // version and post about it after the submitter replaced it (#1321). Saying
  // when it was raised lets the author check it against their own revision
  // history instead of assuming it describes what they have now.
  const raised =
    args.raisedAt && Number.isFinite(args.raisedAt.getTime())
      ? `, raised ${args.raisedAt.toISOString().slice(0, 16)}Z`
      : '';
  const header =
    `[dispute #${args.disputeId} (${args.source}${raised}) upheld by ` +
    `${args.ruledBy === 'adjudication_panel' ? 'the T3 adjudication panel' : 'a moderator'}` +
    ` — revise and resubmit, or withdraw]`;
  const evidence = (args.evidenceRefs ?? [])
    .map(formatEvidenceRef)
    .filter((token): token is string => token !== null);
  const body = args.reasonMd.trim();
  const tail = evidence.length > 0 ? `\n\nBelegg: ${evidence.join(', ')}` : '';

  const full = `${header}\n\n${body}${tail}`;
  if (full.length <= UPHELD_RETURN_NOTE_MAX) return full;

  // Trim the objection's body first: the marker and the sources are what make
  // a shortened note actionable (which ruling, which evidence to re-read).
  //
  // The evidence line is budgeted too, not assumed small. A dispute may carry
  // 20 refs of a 2000-char URL each (`evidenceRefSchema`), which alone dwarfs
  // the cap — appending it unconditionally would have produced a note tens of
  // thousands of characters long out of a function that exports a 2000-char
  // limit, violating the contract every other writer of this column keeps.
  const ellipsis = ' […]';
  const overhead = header.length + 2 + ellipsis.length;
  const tailRoom = Math.max(0, UPHELD_RETURN_NOTE_MAX - overhead - MIN_BODY_CHARS);
  const boundedTail =
    tail.length <= tailRoom
      ? tail
      : `${tail.slice(0, Math.max(0, tailRoom - ellipsis.length)).trimEnd()}${
          tailRoom > 0 ? ellipsis : ''
        }`;
  const room = UPHELD_RETURN_NOTE_MAX - overhead - boundedTail.length;
  const trimmed =
    room > 0 ? `${body.slice(0, room).trimEnd()}${ellipsis}` : ellipsis.trim();
  return `${header}\n\n${trimmed}${boundedTail}`;
}

/**
 * Return the pending edit this upheld dispute was ruled against, carrying the
 * objection over as the return note.
 *
 * A return is a moderation act, so it carries the moderation guards whatever
 * door it comes through. `PATCH /api/pending-edits` refuses a return without
 * `review.edit.decide`, refuses the caller's own submission without
 * `review.edit.decideOwn` (`return_self_not_allowed`), refuses any review
 * action on a model-structure axis without `edit.modelStructure.decide` (a
 * cited enum whose approval changes the model family, admin-tier by default),
 * and refuses an active agent moderating a *human* contributor's proposal
 * outright
 * (`agent_moderation_of_human_edit_not_allowed` — agents peer-verify human
 * work, they do not decide it). `dispute.resolve` alone is none of those: it
 * defaults to the same editor tier but is a different capability with its own
 * floor, and an agent can be given the editor role (`setAgentRole`), so
 * without these an uphold was a side door to exactly the transition the manual
 * path refuses.
 *
 * A refused return does not undo the ruling — the dispute stays upheld and the
 * caller reports the skip, so the UI can say the proposal still needs a
 * disposition from someone who may give it one.
 */
export async function returnPendingEditForUpheldDispute(args: {
  pendingEditId: number;
  disputeId: number;
  source: string;
  reasonMd: string;
  evidenceRefs?: AgentVerificationEvidenceRef[];
  /** When the objection was raised (`disputes.created_at`) — used for the note's stamp, not the staleness check below. */
  disputeRaisedAt: Date | null;
  /**
   * The dispute row's own captured version (`disputes.target_version`,
   * #1321/#1327), refreshed only when its author re-disputes — unlike
   * `disputeRaisedAt`, so it stays current when a dispute is re-stated against
   * a later revision without changing what it objects to. Preferred over
   * `disputeRaisedAt` for the staleness check when present; null for a row
   * written before the column existed, or an already-resolved row read back
   * without it.
   */
  targetVersion?: string | null;
  /** The moderator who ruled; null when the T3 adjudication panel did. */
  resolvedBy: number | null;
  mayDecide: boolean;
  mayDecideOwn: boolean;
  mayDecideModelStructure: boolean;
  /**
   * The T3 adjudication panel's converged ruling (api/_lib/adjudication/
   * closure.ts), not a person's. No identity decides, so there is no
   * self-decision to guard; and by the owner's governance decision a panel
   * that converged on an agent's objection returns the proposal whoever
   * submitted it, a person's included — the one door through which agents
   * send back a person's work. The model-structure guard still applies.
   */
  byAdjudicationPanel?: boolean;
}): Promise<UpheldReturnOutcome> {
  if (!args.mayDecide) return { returned: false, reason: 'decide_not_allowed' };
  const db = getDb();
  const [edit] = await db
    .select({
      id: pendingEdits.id,
      status: pendingEdits.status,
      editType: pendingEdits.editType,
      targetId: pendingEdits.targetId,
      submittedBy: pendingEdits.submittedBy,
      // Both needed to reproduce the manual path's guards: `parameter` decides
      // whether this is a model-structure axis, `submittedAt` is the version
      // the ruling was made against.
      parameter: pendingEdits.parameter,
      submittedAt: pendingEdits.submittedAt,
      proposedMeta: pendingEdits.proposedMeta,
    })
    .from(pendingEdits)
    .where(eq(pendingEdits.id, args.pendingEditId))
    .limit(1);

  if (!edit) return { returned: false, reason: 'not_found' };
  if (edit.status !== 'pending') return { returned: false, reason: 'not_open' };
  const isModelStructure =
    edit.editType === 'param_entry' &&
    typeof edit.parameter === 'string' &&
    isModelStructureParameter(edit.parameter);

  if (!args.byAdjudicationPanel && args.resolvedBy !== null && edit.submittedBy === args.resolvedBy) {
    // The manual path does not read `review.edit.decideOwn` alone for a
    // self-decision, and neither may this one. The capability is the *human*
    // grant and explicitly excludes active agents: an agent token is clamped
    // to editor at authentication, so an admin who lowered decideOwn to its
    // editor floor would otherwise hand every agent at once the licence
    // `agents.self_review_enabled` exists to hand out one at a time. An agent
    // therefore self-returns only through its own row's grant, and not on a
    // clinical case or a model-structure axis — the two carve-outs that ask
    // for a genuine second party whatever the author is trusted with.
    const resolverIsAgent = await isActiveAgentUser(args.resolvedBy);
    const bySelfReviewGrant =
      resolverIsAgent &&
      edit.editType !== 'clinical_case' &&
      !isModelStructure &&
      (await isSelfReviewAgentUser(args.resolvedBy));
    const byCapability = args.mayDecideOwn && !resolverIsAgent;
    if (!bySelfReviewGrant && !byCapability) {
      return { returned: false, reason: 'own_edit_not_allowed' };
    }
  }
  // The agent-versus-human guard is unconditional on the manual path, so it is
  // unconditional here: an agent never decides a human contributor's proposal,
  // however it was granted the role. Agent-on-agent moderation stays allowed —
  // that is the peer pipeline working as designed.
  if (
    !args.byAdjudicationPanel &&
    args.resolvedBy !== null &&
    (await isActiveAgentUser(args.resolvedBy)) &&
    !(await isActiveAgentUser(edit.submittedBy))
  ) {
    return { returned: false, reason: 'agent_moderation_not_allowed' };
  }
  // A cited categorical axis whose approval changes the model family is
  // admin-tier to decide (`edit.modelStructure.decide`), and `PATCH
  // /api/pending-edits` refuses *every* review action on one without it — a
  // return included.
  if (!args.mayDecideModelStructure && isModelStructure) {
    return { returned: false, reason: 'model_structure_not_allowed' };
  }

  // The objection has to be about the payload that would be returned under it.
  // The row lock below closes the read→write gap, but the gap that opens when
  // the moderator loads the card is wider than any lock inside this call — and
  // no version token reaches here, since a dispute is resolved by id from the
  // queue as readily as from the card. So compare the marker the data already
  // has: a material revision recorded *after* the objection's anchor means the
  // objection predates what is now in the row, and returning it would
  // attribute the ruling to content nobody objected to.
  //
  // `proposed_meta.revisedAt` is the marker, not `submitted_at`, which a bare
  // `{status:'pending'}` resubmit re-stamps without changing a byte (#592).
  // The anchor is `targetVersion`'s `submittedAt` half when the dispute row
  // carries one — refreshed only when the dispute's own author re-disputes,
  // so re-stating an objection against a later revision (confirming it still
  // applies) moves the anchor forward and the return is no longer refused for
  // a revision the author already re-confirmed against (#1327). A row written
  // before that column existed, or read back without it, falls back to the
  // objection's raw `created_at` — the same fallback `upheldRulingStands`
  // uses. Either way this is the safe direction — a stale anchor skips the
  // return and the moderator decides by hand.
  const revisedAt = payloadRevisedAt(edit.proposedMeta);
  const disputeAnchor =
    pendingEditTargetVersionSubmittedAt(args.targetVersion) ??
    args.disputeRaisedAt;
  if (
    revisedAt &&
    disputeAnchor &&
    revisedAt.getTime() > disputeAnchor.getTime()
  ) {
    return { returned: false, reason: 'revised_since' };
  }

  const updated = await db
    .update(pendingEdits)
    .set({
      status: 'returned',
      // A return is not a rejection: the standardized reason category belongs
      // to terminal rejections and drives the agent-learning ledger, so it
      // stays null here exactly as on the manual return path.
      rejectionReason: null,
      rejectionComment: composeUpheldReturnNote({
        disputeId: args.disputeId,
        source: args.source,
        reasonMd: args.reasonMd,
        evidenceRefs: args.evidenceRefs,
        raisedAt: args.disputeRaisedAt,
        ruledBy: args.byAdjudicationPanel ? 'adjudication_panel' : 'moderator',
      }),
      reviewedBy: args.resolvedBy,
      reviewedAt: new Date(),
    })
    // The same optimistic lock a reviewer's own return takes
    // (`pendingEditReviewerLock` in api/pending-edits.ts), for the same
    // reason: status alone leaves the read→write gap open. A submitter
    // revision keeps the row `pending` while replacing the payload and
    // re-stamping `submitted_at`, so a status-only predicate would still
    // match and return the *corrected* proposal under an objection written
    // against the version it replaced — the one thing an upheld ruling must
    // never do, since the ruling binds the payload, not the row.
    //
    // `submitted_at` is compared truncated: the column stores microseconds
    // from the DB's `now()` while drizzle reads it back truncated to
    // milliseconds, so a plain equality never matches a freshly submitted row.
    .where(
      and(
        eq(pendingEdits.id, args.pendingEditId),
        eq(pendingEdits.status, 'pending'),
        ...(edit.submittedAt
          ? [
              sql`date_trunc('milliseconds', ${pendingEdits.submittedAt}) = ${edit.submittedAt}`,
            ]
          : []),
      ),
    )
    .returning({ id: pendingEdits.id });

  // Nothing matched: the edit was decided, or revised, between the read and
  // the write. Either way this ruling no longer applies to what is in the row,
  // and the caller reports the skip rather than writing a stale objection over
  // fresh content.
  if (updated.length === 0) return { returned: false, reason: 'revised_since' };

  // Same wake-up the manual return fires: the submitting agent reconciles this
  // cycle instead of waiting for its next scheduled sweep. No-op for human
  // submitters and when hooks aren't configured.
  fireAgentHookForSubmitterAsync(edit.submittedBy, {
    kind: 'edit_returned',
    pendingEditId: edit.id,
    editType: edit.editType,
    targetId: edit.targetId ?? null,
  });
  await notifyEditDecision({
    edit,
    decision: 'returned',
    actorUserId: args.resolvedBy,
    note: args.byAdjudicationPanel
      ? 'A dispute raised against it was upheld by the T3 adjudication panel.'
      : 'A dispute raised against it was upheld.',
  });

  return { returned: true };
}
