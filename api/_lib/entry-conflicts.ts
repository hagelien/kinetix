/**
 * Marking pending `param_entry` proposals stale after a direct write.
 *
 * Its own module because both sides of the pipeline need it and neither can
 * import the other: `pending-edits-helpers` (the approval path) already depends
 * on `parameter-entries-store` (the writes), so the writes cannot depend back
 * on it without a cycle. The rule belongs to neither — it is what every direct
 * writer of `parameter_entries` owes the review queue.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { pendingEdits } from '../../db/schema.js';
import { getDb } from './db.js';
import { ACTIVE_PENDING_EDIT_STATUSES } from './pending-edit-statuses.js';

/**
 * The statuses a `param_entry` proposal can still reach an approval from.
 *
 * `pending` is in the queue now; `returned` is waiting on its author; `draft`
 * is pulled back but resubmittable. All three can end up approved carrying the
 * payload they hold today, so all three can reverse a direct write.
 */
const RESUBMITTABLE_STATUSES = ACTIVE_PENDING_EDIT_STATUSES;

/**
 * Mark open update/delete `param_entry` proposals for an entry as conflicted
 * after any admin-direct mutation of that physical `parameter_entries` row. A
 * later approval of a now-stale snapshot would otherwise silently reverse the
 * admin's change; the conflict marker makes the approval refuse (the same guard
 * the review pipeline uses). Creates are exempt (they target a drug, not the
 * entry, and never conflict with a direct write). Shared by BOTH write paths
 * onto the table — api/parameter-entries.ts and the legacy compatibility route
 * api/reference-concentrations.ts — so neither can bypass the guard.
 *
 * Every status a proposal can still be RESUBMITTED from counts as open, not
 * only `pending`. A `returned` proposal is waiting for its author to answer a
 * reviewer, and a `draft` is one they pulled back to work on; both go back into
 * the queue with whatever payload they carry, and a resubmission that changes
 * nothing keeps the stale snapshot. Marking only `pending` left exactly that
 * path unguarded — the author resubmits, the marker was never written, and the
 * approval reverses a direct write with nothing to warn the reviewer. A genuine
 * rebase clears the marker on its way through (`nextProposedMetaPreservingConflict`),
 * so this costs an author nothing except the requirement to look.
 *
 * Decided and rejected statuses stay out: `approved` and `rejected` are history,
 * and a conflict marker on them would be noise on rows nobody can act on.
 *
 * Matched by the UNIQUE entry id alone — never by parameter. A scenario change
 * can move the row to a different parameter bucket, but a proposal queued
 * against it still stores the OLD parameter; filtering on the new parameter
 * would miss exactly the stale proposal we must conflict. `targetId` is the
 * entry's PK, so it identifies the row unambiguously; the op filter excludes
 * creates (whose targetId is a drug id).
 *
 * ## Why each marker carries a unique `id`
 *
 * The author's PATCH decides whether a conflict is one they have already seen
 * and rebased against, or one written since — by comparing the marker on the
 * row against the marker their snapshot carried
 * (`nextProposedMetaPreservingConflict`). That comparison is only as good as
 * the marker's ability to tell two markings apart, and a constant
 * `{"reason":"direct_admin_write"}` cannot tell them apart at all.
 *
 * So: direct write A marks the proposal. The author loads it and sees the
 * marker. Direct write B marks it again — byte-identical. The author rebases
 * against A, PATCHes, and the comparison finds the stored marker equal to the
 * one they saw, concludes it is addressed, and drops it. B's conflict is now
 * invisible, the approval sees a clean proposal, and it reverses B's write and
 * the provenance that came with it. Presence standing in for identity, which
 * is the same mistake as presence standing in for assertion.
 *
 * `gen_random_uuid()` makes every marking distinct, so "the marker I saw" and
 * "a marker written since" can never be confused whatever their reason. `at`
 * (`clock_timestamp()`, which advances WITHIN a transaction where `now()` does
 * not) is for the operator reading a proposal that will not clear — it says
 * when the write that blocked it landed. Consumers only test the marker for
 * presence, so the added fields cost nothing downstream.
 */
export async function markEntryMutationsConflicted(
  entryId: number | number[],
): Promise<void> {
  const ids = Array.isArray(entryId) ? entryId : [entryId];
  if (ids.length === 0) return;
  await getDb()
    .update(pendingEdits)
    .set({
      proposedMeta: sql`CASE WHEN jsonb_typeof(${pendingEdits.proposedMeta}) = 'object' THEN ${pendingEdits.proposedMeta} ELSE '{}'::jsonb END || jsonb_build_object('conflict', jsonb_build_object(
        'reason', 'direct_admin_write',
        'id', gen_random_uuid()::text,
        'at', clock_timestamp()
      ))` as never,
    })
    .where(
      and(
        eq(pendingEdits.editType, 'param_entry'),
        inArray(pendingEdits.targetId, ids),
        inArray(pendingEdits.status, RESUBMITTABLE_STATUSES),
        sql`(${pendingEdits.proposedValue} ->> 'op') <> 'create'`,
      ),
    );
}
