import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb, inTransaction } from './db.js';
import {
  drugs,
  drugParameterRevisions,
  drugInteractions,
  wikiPages,
  wikiRevisions,
  pendingEdits,
  parameterEntries,
  paperReviews,
  citations,
  learningUnits,
  learningUnitRevisions,
} from '../../db/schema.js';
import {
  ensureTopicSectionIds,
  extractPlaintext,
  renderHtml,
} from './tiptap-utils.js';
import { generateSlug } from './slug.js';
import { nestedDrugIdsOf, paramEntryLockSet } from './param-entry-payload-locks.js';
import { isDrugParameterId } from './drugParameterIds.js';
import {
  buildParameterUpdate,
  insertDrug,
  isUniqueViolation,
  ParameterApplyError,
  readParameterValue,
  validateParameterBag,
  applyInitialParameters,
  type InsertDrugInput,
} from './drugs-helpers.js';
import { getDrugParameterMap } from './drugParameterStore.js';
import {
  insertParameterEntry,
  entryDuplicateExists,
  getParameterEntryRowById,
  updateParameterEntryRow,
  deleteParameterEntryRow,
  recomputeParameterAndDependents,
  recomputeSummariesForDrug,
  isNormalizationInput,
} from './parameter-entries-store.js';
import {
  lockDrugForEntryApplicability,
  parameterWriteBlockedBy,
} from './parameterApplicabilityStore.js';
import {
  effectiveProposalReferenceIds,
  parameterEntryEditSchema,
  validateEntryForParameter,
} from '../../src/lib/parameterEntries.js';
import { parameterAcceptsAuthoredValue } from '../../src/lib/drugParameters.js';
import {
  replaceDrugMetabolism,
  toMetabolismWriteInput,
} from './metabolismStore.js';
import { replaceDrugReceptorTargets } from './receptorTargetStore.js';
import { replaceDrugEnzymeInteractions } from './enzymeInteractionStore.js';
import {
  createBioEntity,
  updateBioEntity,
} from './bioEntityStore.js';
import {
  ensureEntityMonograph,
  resolveOwningDrugIdForMonograph,
} from './monograph-helpers.js';
import { isReferenceGateEnabled } from './site-settings-store.js';
import {
  metabolismWriteSchema,
  receptorTargetsWriteSchema,
  enzymeInteractionsWriteSchema,
  bioEntityEditSchema,
} from './schemas.js';
import {
  applyFactOp,
  isFactNode,
  isMonographContentV2,
  wrapV1AsV2,
  type FactOperation,
  type MonographContentV2,
  type MonographFactNode,
  type TipTapDoc,
} from '../../src/lib/monographContent.js';
import { applyTopicFactOp } from '../../src/lib/topicFactOps.js';
import {
  isValidTopicSectionId,
  listTopicSectionIds,
} from '../../src/lib/topicSections.js';
import {
  applyAddSection,
  applyEditSection,
  applyRemoveSection,
  applyReorderSection,
  clearSectionFacts,
  countSectionBodyNodes,
} from '../../src/lib/topicSectionOps.js';
import {
  createPaperReviewSchema,
  wikiSectionPayloadSchema,
  learningUnitMetaSchema,
  clinicalCaseMetaSchema,
} from './schemas.js';
import {
  getMonographField,
  isMonographSectionId,
  isMergedMonographFieldId,
  type MonographSectionId,
} from '../../src/lib/monographSections.js';
import { newDrugFieldsSchema } from './schemas.js';
import { pendingEditReviewToken } from './pending-edit-review-token.js';
import {
  extractDrugLinksFromJson,
  type DrugLinkRef,
} from '../../src/lib/drugMergeLinks.js';
import { recordApproval } from './approvals.js';
import { recordPaperReview } from './paper-review-store.js';
import { recordImplicitAgentApproval } from './agent-verifications.js';
import { fireAgentHookForActorAsync, isAgentUser } from './agentHooks.js';
import { notifyEditDecision } from './editDecisionNotifications.js';
import { isSiteLandingPageUrl } from '../../src/lib/publicDatabaseRecord.js';

/**
 * Typed error for `wiki_fact` approval invariant failures (unknown
 * section/field, missing target, fact-not-found, etc.). The PATCH handler
 * maps this to a 4xx response so reviewers see actionable feedback
 * instead of a generic 500 when an edit is approved against stale state.
 */
export class WikiFactApprovalError extends Error {
  constructor(
    message: string,
    public statusHint = 400,
  ) {
    super(message);
    this.name = 'WikiFactApprovalError';
  }
}

/**
 * Thrown when a fact or parameter cites a resolvable reference that has not
 * been read in full and judged. Carries the offending citation ids so callers
 * can return a 400 with a clear, actionable message.
 */
export class ReferenceGateError extends Error {
  constructor(public readonly unjudgedCitationIds: number[]) {
    super(
      `References [${unjudgedCitationIds.join(', ')}] must have a paper review ` +
        `claiming the paper was read in full before they can back a fact or ` +
        `parameter. Submit a paper review (POST /api/paper-reviews) with ` +
        `readInFull: true for each, then retry.`,
    );
    this.name = 'ReferenceGateError';
  }
}

export class PendingEditReviewTokenMismatchError extends Error {
  readonly statusHint = 409;
  readonly code: string = 'pending_edit_review_token_mismatch';

  constructor(
    message = 'This edit changed since it was loaded; refresh before approving',
  ) {
    super(message);
    this.name = 'PendingEditReviewTokenMismatchError';
  }
}

/**
 * The approval's target entry was reassigned to another drug between the
 * preflight read and the advisory lock, so the lock we hold is over the drug
 * that used to own it.
 *
 * A SUBCLASS on purpose. Every caller already treats a review-token mismatch as
 * "your view is stale, nothing was applied" — 409 at the endpoint, "not
 * applied" at the consensus gate — and that is exactly the right handling here.
 * Making it a separate hierarchy would mean finding and updating each of those
 * sites, and a site somebody missed would surface an approval race as a 500.
 * The distinct code is so an operator reading a log can tell the two apart.
 */
export class EntryOwnerMovedError extends PendingEditReviewTokenMismatchError {
  override readonly code = 'pending_edit_entry_owner_moved';

  constructor() {
    super(
      'This entry moved to another drug while the approval was being prepared; retry',
    );
    this.name = 'EntryOwnerMovedError';
  }
}

/**
 * Reference gate (the "read in full and judged" guarantee). A fact or
 * parameter may only cite resolvable references (pmid/doi/url) that carry a
 * read-in-full paper review. `freetext` references are exempt — they cannot be
 * reviewed. A *pending* paper-review submission with readInFull: true counts,
 * so an agent can review-then-cite within one cycle; an approved review counts
 * too. Throws {@link ReferenceGateError} listing any resolvable citation that
 * satisfies neither.
 *
 * This bare form is **unconditional** — it is not affected by the admin switch.
 * Its one direct caller is the `learning_unit` submission path, where the
 * read-in-full requirement is not the agent discipline but the definition of a
 * learning unit: the unit consumes an existing `paper_review` instead of
 * re-reviewing the source, so a unit anchored to an unreviewed paper has
 * nothing to teach from. The switch belongs to the agent gate and is applied by
 * {@link assertReferencesJudgedForActor}.
 */
export async function assertReferencesJudged(
  referenceIds: number[],
): Promise<void> {
  const ids = [...new Set(referenceIds)].filter(
    (n) => Number.isInteger(n) && n > 0,
  );
  if (ids.length === 0) return;

  const db = getDb();

  // Three sequential queries, not a single db.batch() round trip: `.batch()`
  // is a neon-http-only affordance, and this helper also runs inside a pool
  // transaction (agent-consensus auto-apply goes through runInPoolTransaction,
  // via inTransaction), where getDb() hands back the neon-serverless
  // pool-transaction client instead — which does not implement `.batch()`
  // (#1356). The freetext filter and the resolvability check are done in JS
  // after all three resolve.
  //
  // Fetch citation types to identify which are resolvable (non-freetext).
  const citeRows = await db
    .select({
      id: citations.id,
      type: citations.type,
      identifier: citations.identifier,
    })
    .from(citations)
    .where(inArray(citations.id, ids));
  // Live, approved reviews with the read-in-full attestation.
  const approvedRows = await db
    .select({ citationId: paperReviews.citationId })
    .from(paperReviews)
    .where(
      and(
        inArray(paperReviews.citationId, ids),
        eq(paperReviews.readInFull, true),
      ),
    );
  // Pending paper-review submissions count too, but only when the pending
  // payload itself claims read-in-full.
  const pendingRows = await db
    .select({
      targetId: pendingEdits.targetId,
      proposedValue: pendingEdits.proposedValue,
    })
    .from(pendingEdits)
    .where(
      and(
        eq(pendingEdits.editType, 'paper_review'),
        eq(pendingEdits.status, 'pending'),
        inArray(pendingEdits.targetId, ids),
      ),
    );

  const resolvableIds = new Set(
    citeRows.filter((c) => c.type !== 'freetext').map((c) => c.id),
  );
  if (resolvableIds.size === 0) return;

  const judged = new Set<number>(
    approvedRows.map((r) => r.citationId).filter((id) => resolvableIds.has(id)),
  );
  for (const row of pendingRows) {
    const pv = row.proposedValue as { readInFull?: unknown } | null;
    if (row.targetId != null && resolvableIds.has(row.targetId) && pv && pv.readInFull === true) {
      judged.add(row.targetId);
    }
  }

  // A site's front page names no specific source, so no review of it can back
  // a claim: it stays unjudged until the claim is re-cited to the exact page or
  // study (agents/fulltext-acquisition.md §0c).
  for (const c of citeRows) {
    if (c.type === 'url' && isSiteLandingPageUrl(c.identifier)) judged.delete(c.id);
  }

  const unjudged = [...resolvableIds].filter((id) => !judged.has(id));
  if (unjudged.length > 0) {
    throw new ReferenceGateError(unjudged);
  }
}

/**
 * Actor-aware reference gate. The read-in-full requirement is an **agent**
 * discipline, not a human one: an autonomous agent must not let an unread
 * (abstract-only) source back a factual claim, so it must review a paper before
 * citing it. A human contributor is trusted to have read the paper they cite —
 * blocking them on a missing `paper_review` is wrong, since no agent has gotten
 * to that source yet. So for human actors the gate is skipped entirely: the
 * fact or parameter goes live immediately, and the cited source is left for the
 * agent review queue, which it joins automatically the moment the claim is live
 * (a resolvable citation used by live content but lacking a read-in-full review
 * is exactly what {@link findCitationsNeedingFullReview} surfaces — no explicit
 * enqueue step is needed). Only agent actors are held to
 * {@link assertReferencesJudged}.
 *
 * This is also where the admin switch applies (Admin → Settings, the
 * `referenceGate.blockUnreviewedCitations` site setting; ON by default). Turned
 * off, the gate is a no-op: the write goes through and the unreviewed citation
 * is left to the follow-up review queue, which picks it up automatically the
 * moment the claim is live ({@link findCitationsNeedingFullReview}). The check
 * lives HERE rather than at each of the four routes that call this, so there is
 * exactly one place the agent gate can be on or off — a route that forgot to
 * consult the switch would keep blocking after an admin turned it off, with
 * nothing saying why. It deliberately does NOT sit in
 * {@link assertReferencesJudged}: that would also relax the `learning_unit`
 * path, which gates humans as well and is a different guarantee.
 */
export async function assertReferencesJudgedForActor(
  referenceIds: number[],
  actorUserId: number,
): Promise<void> {
  // Nothing to gate when no references are cited (e.g. exempt metadata edits) —
  // short-circuit before the actor lookup so the common case stays db-free.
  if (referenceIds.length === 0) return;
  // Read the switch before the actor lookup: when the gate is off there is
  // nothing to decide, so the hot write path skips both queries entirely.
  if (!(await isReferenceGateEnabled())) return;
  if (!(await isAgentUser(actorUserId))) return;
  await assertReferencesJudged(referenceIds);
}

/**
 * Decide whether a paper review's read-in-full attestation looks unsupported.
 *
 * The `readInFull` flag is self-reported by the submitting agent — nothing in
 * the system proves it actually read the whole paper rather than the abstract.
 * This returns true only for the genuine contradiction: the review attests
 * read-in-full, yet the citation still has an **open** PDF request (an agent
 * previously declared the full text unavailable) and **no** stored PDF was ever
 * supplied. That pairing means either the reviewer found a legitimately free
 * full text (fine — a human/peer confirms) or it attested from the abstract
 * (the failure mode we want surfaced). It is a flag for human/peer scrutiny,
 * never a hard block: the legitimate free-full-text case (no request, no PDF)
 * is deliberately NOT flagged, so false positives stay rare.
 */
export function isReadInFullUnverified(
  readInFull: boolean,
  hasOpenPdfRequest: boolean,
  hasStoredPdf: boolean,
): boolean {
  return readInFull && hasOpenPdfRequest && !hasStoredPdf;
}

/**
 * Pick the factId that uniquely identifies the row's target for conflict
 * detection. For replace/remove ops the anchor is canonical; for add ops
 * the new fact node's id is the only meaningful key (no other edit can
 * have known about it pre-approval). Returns null when neither is
 * present, which short-circuits the conflict scan harmlessly.
 */
function factConflictKey(
  edit: Pick<
    typeof pendingEdits.$inferSelect,
    'factOperation' | 'proposedValue' | 'factTargetAnchor'
  >,
): string | null {
  if (edit.factOperation === 'add') {
    const node = edit.proposedValue as { attrs?: { factId?: unknown } } | null;
    const id = node?.attrs?.factId;
    return typeof id === 'string' && id ? id : null;
  }
  if (
    edit.factOperation === 'replace' ||
    edit.factOperation === 'remove' ||
    edit.factOperation === 'reorder'
  ) {
    const anchor = (edit.factTargetAnchor ?? {}) as Record<string, unknown>;
    return typeof anchor.factId === 'string' && anchor.factId
      ? (anchor.factId as string)
      : null;
  }
  return null;
}

function buildConflictMarker(
  approvedEditId: number,
  reviewerId: number,
): string {
  return JSON.stringify({
    conflict: {
      approvedEditId,
      reviewerId,
      flaggedAt: new Date().toISOString(),
    },
  });
}


/**
 * Flag every pending edit of the given editTypes that targets `pageId`
 * (excluding `excludeId`) as stale, attributing the conflict to the
 * just-approved edit. Used by the wiki_page / wiki_fact branches of
 * markConflictingPendingEdits to mark cross-type conflicts.
 *
 * Uses a single UPDATE with JSONB merge (||) instead of one UPDATE per
 * conflicting row, cutting the number of Neon round-trips from O(n) to 1.
 */
async function flagConflictingPending(
  editTypes: Array<'wiki_page' | 'wiki_fact' | 'wiki_section'>,
  pageId: number,
  excludeId: number,
  reviewerId: number,
): Promise<void> {
  const db = getDb();
  const marker = buildConflictMarker(excludeId, reviewerId);
  await db
    .update(pendingEdits)
    .set({
      proposedMeta:
        sql`CASE WHEN jsonb_typeof(${pendingEdits.proposedMeta}) = 'object' THEN ${pendingEdits.proposedMeta} ELSE '{}'::jsonb END || ${marker}::jsonb` as never,
    })
    .where(
      and(
        inArray(pendingEdits.editType, editTypes),
        eq(pendingEdits.targetId, pageId),
        eq(pendingEdits.status, 'pending'),
        ne(pendingEdits.id, excludeId),
      ),
    );
}

async function markConflictingPendingEdits(
  edit: typeof pendingEdits.$inferSelect,
  reviewerId: number,
): Promise<void> {
  const db = getDb();

  if (edit.editType === 'parameter' && edit.targetId && edit.parameter) {
    const marker = buildConflictMarker(edit.id, reviewerId);
    await db
      .update(pendingEdits)
      .set({
        proposedMeta:
          sql`CASE WHEN jsonb_typeof(${pendingEdits.proposedMeta}) = 'object' THEN ${pendingEdits.proposedMeta} ELSE '{}'::jsonb END || ${marker}::jsonb` as never,
      })
      .where(
        and(
          eq(pendingEdits.editType, 'parameter'),
          eq(pendingEdits.targetId, edit.targetId),
          eq(pendingEdits.parameter, edit.parameter),
          eq(pendingEdits.status, 'pending'),
          ne(pendingEdits.id, edit.id),
        ),
      );
    return;
  }

  if (edit.editType === 'param_entry' && edit.targetId && edit.parameter) {
    // Only update/delete edits collide: they target a specific entry id, and
    // approving one makes any other open update/delete on the SAME entry stale.
    // `create` proposals are intentionally not conflicted (a parameter is
    // multi-value; many new entries coexist), mirroring the open-entry index.
    const marker = buildConflictMarker(edit.id, reviewerId);
    await db
      .update(pendingEdits)
      .set({
        proposedMeta:
          sql`CASE WHEN jsonb_typeof(${pendingEdits.proposedMeta}) = 'object' THEN ${pendingEdits.proposedMeta} ELSE '{}'::jsonb END || ${marker}::jsonb` as never,
      })
      .where(
        and(
          eq(pendingEdits.editType, 'param_entry'),
          eq(pendingEdits.targetId, edit.targetId),
          eq(pendingEdits.parameter, edit.parameter),
          eq(pendingEdits.status, 'pending'),
          ne(pendingEdits.id, edit.id),
          sql`(${pendingEdits.proposedValue} ->> 'op') <> 'create'`,
        ),
      );
    return;
  }

  if (edit.editType === 'wiki_page' && edit.targetId) {
    // Same-type whole-page edits targeting this page: another
    // approval would silently overwrite the snapshot we just applied.
    // Cross-type wiki_fact + wiki_section edits targeting the same
    // page are also stale — the splice they computed against the
    // previous page content may either misplace its target or fail
    // to find its anchor after this whole-page update.
    await flagConflictingPending(
      ['wiki_page', 'wiki_fact', 'wiki_section'],
      edit.targetId,
      edit.id,
      reviewerId,
    );
    return;
  }

  if (edit.editType === 'wiki_section' && edit.targetId) {
    // Section CRUD reshapes the heading list, so any pending edit
    // anchored on a sectionId on the same page may now be stale:
    // - wiki_section: a remove/reorder/rename may have invalidated
    //   another pending op's anchor or position.
    // - wiki_fact: facts anchor on sectionId; a removed or moved
    //   section breaks the splice.
    // - wiki_page: would overwrite the section change with the
    //   pre-section snapshot.
    await flagConflictingPending(
      ['wiki_page', 'wiki_fact', 'wiki_section'],
      edit.targetId,
      edit.id,
      reviewerId,
    );
    return;
  }

  if (edit.editType === 'wiki_fact' && edit.targetId) {
    // Cross-type: pending wiki_page edits targeting the same page
    // would, when approved, overwrite the page content with their
    // pre-fact snapshot and drop the fact we just spliced in (#348).
    // Mark them stale so a reviewer rebases.
    await flagConflictingPending(
      ['wiki_page'],
      edit.targetId,
      edit.id,
      reviewerId,
    );

    // Same-type wiki_fact rows are conflicted when:
    // 1. They share the same fact anchor (replace/remove/reorder
    //    against the same factId) — a stored op authored against
    //    the previous anchor state will misfire after this approval.
    // 2. They are reorder ops in the same section AND the
    //    just-approved op changed the section's fact list (add,
    //    remove, reorder). Pending reorders carry hard-coded
    //    positions computed against the pre-approval ordering;
    //    once that ordering shifts, the position lands on the
    //    wrong slot or no-ops silently. Replace ops don't change
    //    fact-list cardinality so they don't trigger this branch.
    // Two adds on different sections / factIds happily coexist, so
    // we don't blanket-conflict by editType alone.
    const targetFactId = factConflictKey(edit);
    const targetChangesFactList =
      edit.factOperation === 'add' ||
      edit.factOperation === 'remove' ||
      edit.factOperation === 'reorder';
    if (targetFactId || targetChangesFactList) {
      // For `add` ops the conflict key lives at proposedValue.attrs.factId.
      // Fetching the full TipTap document just to read that one field wastes
      // bandwidth proportional to page length; extract it via a JSONB path
      // expression instead. Also exclude the approved edit itself in SQL to
      // avoid transferring its row only to discard it in the JS filter.
      const conflicts = await db
        .select({
          id: pendingEdits.id,
          factOperation: pendingEdits.factOperation,
          sectionId: pendingEdits.sectionId,
          factTargetAnchor: pendingEdits.factTargetAnchor,
          proposedFactId: sql<string | null>`(${pendingEdits.proposedValue}->'attrs'->>'factId')`,
        })
        .from(pendingEdits)
        .where(
          and(
            eq(pendingEdits.editType, 'wiki_fact'),
            eq(pendingEdits.targetId, edit.targetId),
            eq(pendingEdits.status, 'pending'),
            ne(pendingEdits.id, edit.id),
          ),
        );

      const conflictIds = conflicts
        .filter((conflict) => {
          const conflictFactId =
            conflict.factOperation === 'add'
              ? (typeof conflict.proposedFactId === 'string' &&
                conflict.proposedFactId
                  ? conflict.proposedFactId
                  : null)
              : (() => {
                  const anchor = (conflict.factTargetAnchor ?? {}) as Record<
                    string,
                    unknown
                  >;
                  return typeof anchor.factId === 'string' && anchor.factId
                    ? (anchor.factId as string)
                    : null;
                })();
          const sameAnchor = targetFactId !== null && conflictFactId === targetFactId;
          const staleReorderInSection =
            targetChangesFactList &&
            conflict.factOperation === 'reorder' &&
            conflict.sectionId === edit.sectionId;
          return sameAnchor || staleReorderInSection;
        })
        .map((c) => c.id);

      if (conflictIds.length > 0) {
        const marker = buildConflictMarker(edit.id, reviewerId);
        await db
          .update(pendingEdits)
          .set({
            proposedMeta:
              sql`CASE WHEN jsonb_typeof(${pendingEdits.proposedMeta}) = 'object' THEN ${pendingEdits.proposedMeta} ELSE '{}'::jsonb END || ${marker}::jsonb` as never,
          })
          .where(inArray(pendingEdits.id, conflictIds));
      }
    }
    return;
  }

  if (edit.editType === 'wiki_new') {
    const meta = (edit.proposedMeta ?? {}) as Record<string, unknown>;
    const title = typeof meta.title === 'string' ? meta.title : null;
    const drugCid = typeof meta.drugCid === 'number' ? meta.drugCid : null;
    const newDrug = (meta.newDrug ?? null) as InsertDrugInput | null;
    const newDrugPubchemCid =
      newDrug && typeof newDrug.pubchemCid === 'number'
        ? newDrug.pubchemCid
        : null;
    const resolvedSlug = title ? generateSlug(title) : null;

    // Extract only the three scalar fields needed for conflict detection rather
    // than fetching the entire proposedMeta JSONB object (which can include a
    // full newDrug payload). Also exclude the approved edit itself in SQL.
    const pendingNewConflicts = await db
      .select({
        id: pendingEdits.id,
        title: sql<string | null>`(${pendingEdits.proposedMeta}->>'title')`,
        drugCid: sql<string | null>`(${pendingEdits.proposedMeta}->>'drugCid')`,
        pubchemCid: sql<string | null>`(${pendingEdits.proposedMeta}->'newDrug'->>'pubchemCid')`,
      })
      .from(pendingEdits)
      .where(
        and(
          eq(pendingEdits.editType, 'wiki_new'),
          eq(pendingEdits.status, 'pending'),
          ne(pendingEdits.id, edit.id),
        ),
      );

    const conflictIds: number[] = [];
    for (const conflict of pendingNewConflicts) {
      const conflictTitle = conflict.title;
      const sameTitle = !!title && conflictTitle === title;
      const sameDrug =
        drugCid !== null &&
        conflict.drugCid !== null &&
        Number(conflict.drugCid) === drugCid;
      const samePubchem =
        newDrugPubchemCid !== null &&
        conflict.pubchemCid !== null &&
        Number(conflict.pubchemCid) === newDrugPubchemCid;
      const sameSlug =
        resolvedSlug !== null &&
        conflictTitle !== null &&
        generateSlug(conflictTitle) === resolvedSlug;
      if (sameTitle || sameDrug || samePubchem || sameSlug) {
        conflictIds.push(conflict.id);
      }
    }

    if (conflictIds.length > 0) {
      const marker = buildConflictMarker(edit.id, reviewerId);
      await db
        .update(pendingEdits)
        .set({
          proposedMeta:
            sql`CASE WHEN jsonb_typeof(${pendingEdits.proposedMeta}) = 'object' THEN ${pendingEdits.proposedMeta} ELSE '{}'::jsonb END || ${marker}::jsonb` as never,
        })
        .where(inArray(pendingEdits.id, conflictIds));
    }
  }

  if (edit.editType === 'learning_unit' && edit.targetId) {
    // An approved whole-unit edit replaces the unit content snapshot; any
    // other pending learning_unit edit targeting the same unit was authored
    // against the pre-approval content and will silently overwrite this
    // revision if approved unchanged. Mark them stale so a reviewer rebases.
    const marker = buildConflictMarker(edit.id, reviewerId);
    await db
      .update(pendingEdits)
      .set({
        proposedMeta:
          sql`CASE WHEN jsonb_typeof(${pendingEdits.proposedMeta}) = 'object' THEN ${pendingEdits.proposedMeta} ELSE '{}'::jsonb END || ${marker}::jsonb` as never,
      })
      .where(
        and(
          eq(pendingEdits.editType, 'learning_unit'),
          eq(pendingEdits.targetId, edit.targetId),
          eq(pendingEdits.status, 'pending'),
          ne(pendingEdits.id, edit.id),
        ),
      );
  }

  if (edit.editType === 'clinical_case' && edit.targetId) {
    // Same rationale as learning_unit: an approved whole-case edit replaces the
    // content snapshot, so any other pending clinical_case edit targeting the
    // same case was authored against stale content. Mark them so a reviewer
    // rebases instead of silently overwriting this revision.
    const marker = buildConflictMarker(edit.id, reviewerId);
    await db
      .update(pendingEdits)
      .set({
        proposedMeta:
          sql`CASE WHEN jsonb_typeof(${pendingEdits.proposedMeta}) = 'object' THEN ${pendingEdits.proposedMeta} ELSE '{}'::jsonb END || ${marker}::jsonb` as never,
      })
      .where(
        and(
          eq(pendingEdits.editType, 'clinical_case'),
          eq(pendingEdits.targetId, edit.targetId),
          eq(pendingEdits.status, 'pending'),
          ne(pendingEdits.id, edit.id),
        ),
      );
  }
}

type PendingEditRow = typeof pendingEdits.$inferSelect;

export async function applyApprovedLearningUnit(
  db: ReturnType<typeof getDb>,
  edit: PendingEditRow,
  reviewerId: number,
): Promise<void> {
  const meta = learningUnitMetaSchema.parse(edit.proposedMeta ?? {});
  const content = edit.proposedValue;

  let unitId = edit.targetId ?? null;
  if (unitId == null) {
    if (!edit.referenceIds || edit.referenceIds.length !== 1) {
      throw new Error('learning_unit requires exactly one anchor citation');
    }
    const [unit] = await db
      .insert(learningUnits)
      .values({
        citationId: edit.referenceIds[0]!,
        slug: meta.slug,
        title: meta.title,
        content: content as never,
        difficulty: meta.difficulty,
        domains: meta.domains as never,
        status: 'published',
        createdBy: edit.submittedBy,
        updatedBy: edit.submittedBy,
      })
      .returning({ id: learningUnits.id });
    if (!unit) throw new Error('learning_unit insert returned no row');
    unitId = unit.id;
  } else {
    await db
      .update(learningUnits)
      .set({
        title: meta.title,
        slug: meta.slug,
        content: content as never,
        difficulty: meta.difficulty,
        domains: meta.domains as never,
        updatedBy: edit.submittedBy,
        updatedAt: new Date(),
      })
      .where(eq(learningUnits.id, unitId));
  }

  const [unitRev] = await db
    .insert(learningUnitRevisions)
    .values({
      unitId,
      content: content as never,
      editSummary: meta.editSummary ?? null,
      pendingEditId: edit.id,
      createdBy: edit.submittedBy,
    })
    .returning({ id: learningUnitRevisions.id });

  if (unitRev) {
    await recordApproval({
      targetType: 'learning_unit_revision',
      targetId: unitRev.id,
      approvedBy: reviewerId,
    });
    await recordImplicitAgentApproval({
      userId: edit.submittedBy,
      targetType: 'learning_unit_revision',
      targetId: unitRev.id,
    });
    fireAgentHookForActorAsync(edit.submittedBy, {
      kind: 'learning_unit_approved',
      pendingEditId: edit.id,
      revisionId: unitRev.id,
      unitId,
    });
  }
}

/**
 * Apply an approved `clinical_case` edit into a `learning_units` row tagged
 * `kind:'clinical_case'`. Mirrors applyApprovedLearningUnit (same revision +
 * verification target), with two differences: the case anchors its PRIMARY
 * cited source (`referenceIds[0]`) — additional cited sources live in the
 * scenario prose — and the row carries `kind:'clinical_case'` so the reader/
 * renderer branch on it. NOTE: this path runs only for HUMAN approvals; agent
 * consensus can never reach it (applyOnAgentConsensus refuses clinical cases —
 * spec §12 Stage 12).
 */
export async function applyApprovedClinicalCase(
  db: ReturnType<typeof getDb>,
  edit: PendingEditRow,
  reviewerId: number,
): Promise<void> {
  const meta = clinicalCaseMetaSchema.parse(edit.proposedMeta ?? {});
  const content = edit.proposedValue;

  let unitId = edit.targetId ?? null;
  if (unitId == null) {
    if (!edit.referenceIds || edit.referenceIds.length < 1) {
      throw new Error('clinical_case requires at least one anchor citation');
    }
    const [unit] = await db
      .insert(learningUnits)
      .values({
        citationId: edit.referenceIds[0]!,
        slug: meta.slug,
        title: meta.title,
        content: content as never,
        difficulty: meta.difficulty,
        domains: meta.domains as never,
        status: 'published',
        kind: 'clinical_case',
        createdBy: edit.submittedBy,
        updatedBy: edit.submittedBy,
      })
      .returning({ id: learningUnits.id });
    if (!unit) throw new Error('clinical_case insert returned no row');
    unitId = unit.id;
  } else {
    await db
      .update(learningUnits)
      .set({
        title: meta.title,
        slug: meta.slug,
        content: content as never,
        difficulty: meta.difficulty,
        domains: meta.domains as never,
        updatedBy: edit.submittedBy,
        updatedAt: new Date(),
      })
      .where(eq(learningUnits.id, unitId));
  }

  const [unitRev] = await db
    .insert(learningUnitRevisions)
    .values({
      unitId,
      content: content as never,
      editSummary: meta.editSummary ?? null,
      pendingEditId: edit.id,
      createdBy: edit.submittedBy,
    })
    .returning({ id: learningUnitRevisions.id });

  if (unitRev) {
    await recordApproval({
      targetType: 'learning_unit_revision',
      targetId: unitRev.id,
      approvedBy: reviewerId,
    });
    await recordImplicitAgentApproval({
      userId: edit.submittedBy,
      targetType: 'learning_unit_revision',
      targetId: unitRev.id,
    });
    fireAgentHookForActorAsync(edit.submittedBy, {
      kind: 'learning_unit_approved',
      pendingEditId: edit.id,
      revisionId: unitRev.id,
      unitId,
    });
  }
}

export async function applyApprovedEdit(
  editId: number,
  reviewerId: number,
  expectedReviewToken?: string,
  opts: {
    /**
     * Runs inside the approval transaction, after the pending-edit row lock
     * and before anything is written. Throwing aborts the approval. Agent
     * consensus uses it to re-check its gate under the lock, so a decision
     * read before a concurrent change (a tier downgrade) cannot publish after
     * it (issue #1357).
     */
    revalidate?: () => Promise<void>;
  } = {},
): Promise<void> {
  // Run the whole approval inside one transaction on the Pool driver and take
  // a row lock on the pending edit. getDb() returns the transaction client for
  // the duration (see runInPoolTransaction), so every effect below — drug/wiki
  // writes, revision inserts, approval records and conflict marking — runs on
  // the same connection and commits or rolls back atomically with the final
  // status stamp. That removes the window where an effect could be applied but
  // the status left `pending` (which let a reviewer retry double-apply).
  //
  // The lock also serialises the freshness guard: a concurrent submitter PATCH
  // issues `UPDATE pending_edits ... WHERE id` (a no-key update) and blocks on
  // the lock until we commit, so the row cannot be mutated or moved back to
  // `draft` between the re-check and the stamp (#592). The mode is FOR NO KEY
  // UPDATE, not FOR UPDATE: our own child-revision inserts reference this row
  // via `pending_edit_id` and take a FOR KEY SHARE lock on it to validate the
  // FK; FOR KEY SHARE conflicts with FOR UPDATE but not with FOR NO KEY UPDATE,
  // while FOR NO KEY UPDATE still conflicts with the submitter's no-key update.
  // `inTransaction`, not `runInPoolTransaction`: this helper is reachable from
  // a governance adapter's `apply()`, which opens the unit of work itself
  // (§12.3.1). Opening a second Pool from in there would put the inner work on
  // a *different connection*, where it would block on the transaction-scoped
  // drug advisory locks and the `FOR NO KEY UPDATE` below that the outer
  // connection already holds — a hang until timeout, not an error. Joining is
  // also invisible to every existing caller: outside a transaction
  // `inTransaction` opens one, so the endpoints behave exactly as before.
  await inTransaction(async () => {
    const db = getDb();

    // Preflight-read the edit (no row lock) to discover which drug
    // advisory locks approval must hold, and acquire them BEFORE the
    // `FOR NO KEY UPDATE` on `pending_edits`. The merge fold takes
    // advisory → row (advisory lock on the drug first, then
    // `FOR UPDATE` on matching pending_edits in rewriteWikiLinks); the
    // approval must follow the same lock order or two overlapping
    // transactions form an ABBA cycle and PostgreSQL aborts one.
    // Content can only shift between the preflight and the row-lock
    // read if a concurrent submitter re-drafts the edit; the review
    // token check below catches that shift and rejects the approval.
    const [preflight] = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.id, editId))
      .limit(1);
    if (!preflight) throw new Error('Pending edit not found');
    const lockIds = await drugAdvisoryLockIdsForEdit(db, preflight);
    for (const drugId of lockIds) {
      await lockDrugForEntryApplicability(drugId);
    }
    // …and the drug an entry proposal locked is only the right drug if the
    // entry still belongs to it. See `assertLockedEntryOwner`.
    await assertLockedEntryOwner(db, preflight, lockIds);

    const [edit] = await db
      .select()
      .from(pendingEdits)
      .where(eq(pendingEdits.id, editId))
      .for('no key update')
      .limit(1);

    if (!edit) throw new Error('Pending edit not found');
    // Unconditional preflight-vs-row token check. `expectedReviewToken` is
    // OPTIONAL (agent-consensus paths call in without it) and only catches
    // drift between the reviewer's UI and the row. But a submitter re-draft
    // between our preflight above and this row-lock read would also shift
    // the content — the drug-lock set we derived from the preflight was
    // for the OLD payload, and applying the NEW payload could publish a
    // link to a drug we never held the merge advisory lock on. Compare
    // the two tokens directly and abort on any drift so no approval ever
    // proceeds against a payload it didn't lock for.
    if (
      edit.status !== 'pending' ||
      pendingEditReviewToken(preflight) !== pendingEditReviewToken(edit) ||
      (expectedReviewToken !== undefined &&
        expectedReviewToken !== pendingEditReviewToken(edit))
    ) {
      throw new PendingEditReviewTokenMismatchError();
    }
    if (((edit.proposedMeta ?? {}) as Record<string, unknown>).conflict) {
      throw new Error(
        'This pending edit conflicts with a change that has already been approved',
      );
    }
    if (opts.revalidate) await opts.revalidate();

    await applyApprovedEditEffects(db, edit, reviewerId);
  });
}

/**
 * Apply an approved `param_entry` edit: create/update/delete the entry, then
 * recompute the parameter's cached aggregate. The recompute writes a
 * drug_parameter_revision, which we stamp with the reviewer's approval and the
 * submitter's implicit approval, and fire the parameter_approved agent hook —
 * reusing the existing drug-parameter approval machinery (no new target type).
 */
/**
 * Refuse to publish a source entry for a quantity the substance does not have.
 *
 * Deliberately its own helper rather than leaning on `upsertDrugParameter`'s
 * backstop: the entry row is written by `insertParameterEntry` /
 * `updateParameterEntryRow`, and the recompute that would reach that backstop
 * skips excluded parameters instead of throwing. So nothing downstream fails
 * the approval — the entry simply lands next to the marker forbidding it.
 */
async function assertEntryParameterApplicable(
  drugId: number,
  parameter: string,
): Promise<void> {
  // Take the per-drug lock before reading. The approval already runs in a
  // transaction, but it does not reach the lock until the recompute — long
  // after the entry row is inserted — so without this a marker creation could
  // slip between this read and the insert, see no entry (ours is
  // uncommitted), and commit. The lock is re-entrant, so the recompute's later
  // acquisition is free, and taking it here just widens the hold to cover the
  // check-and-insert as one unit.
  await lockDrugForEntryApplicability(drugId);
  const blocked = await parameterWriteBlockedBy(getDb(), drugId, parameter);
  if (!blocked) return;
  throw new ParameterApplyError(
    blocked === 'substance_class'
      ? 'Approval rejected: this substance is not administered, so this parameter is not a defined quantity for it; correct its substanceClass before approving source entries.'
      : 'Approval rejected: this parameter is marked not applicable for this substance; lift the marker before approving source entries.',
    409,
    'parameter_not_applicable',
  );
}

async function applyApprovedParameterEntry(
  edit: PendingEditRow,
  reviewerId: number,
): Promise<void> {
  const parsed = parameterEntryEditSchema.safeParse(edit.proposedValue);
  if (!parsed.success) {
    throw new ParameterApplyError(
      'Approval rejected: invalid parameter-entry payload: ' +
        parsed.error.issues
          .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
          .join('; '),
      400,
      'param_entry_invalid_payload',
    );
  }

  // Bind the payload to what the reviewer saw. The generic resubmit flow can
  // mutate proposedValue without touching the pending row's target/reference
  // columns (which drive the review card + enrichment), so cross-check:
  //  - a create must insert for the queued drug + parameter, not another;
  //  - the payload citation must be one the pending row advertises.
  // A mismatch means the card and the applied entry diverge — reject it.
  if (parsed.data.op === 'create') {
    if (
      parsed.data.input.drugId !== edit.targetId ||
      parsed.data.input.parameter !== edit.parameter
    ) {
      throw new ParameterApplyError(
        'Approval rejected: proposal target no longer matches the queued drug/parameter.',
        409,
        'param_entry_target_mismatch',
      );
    }
  }
  // The last stop for a nested drug reference (Cmax release B, #1340): a
  // proposal whose dose context names a drug that no longer exists is refused
  // rather than published into a dangling reference. Every writer of the
  // payload already re-reads the drugs under their locks
  // (`withParamEntryPayloadLocks`); this covers a proposal that predates that,
  // or any path that slips past it — the approval already holds every
  // referenced drug's lock (`drugAdvisoryLockIdsForEdit`), so the read is
  // authoritative.
  const nestedIds = nestedDrugIdsOf(parsed.data);
  if (nestedIds.length > 0) {
    const present = new Set(
      (
        await getDb()
          .select({ id: drugs.id })
          .from(drugs)
          .where(inArray(drugs.id, nestedIds))
      ).map((row) => row.id),
    );
    const missing = nestedIds.find((id) => !present.has(id));
    if (missing !== undefined) {
      throw new ParameterApplyError(
        `Approval rejected: the proposal names substance #${missing} as the drug administered or the interacting drug, and it no longer exists.`,
        409,
        'param_entry_drug_missing',
      );
    }
  }

  // An EMPTY `reference_ids` is a row that never set one, not a row citing
  // nothing — the singular `reference_id` is what it advertises, and what the
  // queue hydration shows, `readEffectiveReferenceIds` accepts on a resubmit,
  // and the review card's preflight checks against. A `??` here kept the empty
  // array and refused a legacy row for citing the very source it lists, which
  // is the card-vs-approval disagreement this shared inspector exists to
  // prevent — in the one direction where the card says nothing.
  const pendingReferenceIds = effectiveProposalReferenceIds(edit);

  // Re-run the citation gate at approval time. The proposedValue can be altered
  // through the generic pending-edit resubmit flow (which only gates wiki_fact/
  // parameter), so a create/update could arrive citing an unread resolvable
  // source; gate the payload's citation for the original submitter before
  // publishing. (No-op for humans and for delete.)
  const payloadCitationId =
    parsed.data.op === 'create'
      ? parsed.data.input.citationId
      : parsed.data.op === 'update'
        ? parsed.data.patch.citationId
        : null;
  if (
    payloadCitationId != null &&
    !pendingReferenceIds.includes(payloadCitationId)
  ) {
    throw new ParameterApplyError(
      'Approval rejected: proposal citation no longer matches the reviewed reference.',
      409,
      'param_entry_citation_mismatch',
    );
  }
  if (payloadCitationId != null) {
    try {
      await assertReferencesJudgedForActor([payloadCitationId], edit.submittedBy);
    } catch (err) {
      if (err instanceof ReferenceGateError) {
        throw new ParameterApplyError(
          `Approval rejected: ${err.message}`,
          400,
          'param_entry_reference_not_judged',
        );
      }
      throw err;
    }
  }

  let target: { drugId: number; parameter: string };
  if (parsed.data.op === 'create') {
    // Reject an exact duplicate at approval time too — two contributors could
    // queue identical observations that individually pass submission.
    if (await entryDuplicateExists(parsed.data.input)) {
      throw new ParameterApplyError(
        'Approval rejected: an identical source value already exists.',
        409,
        'param_entry_duplicate',
      );
    }
    // An entry is evidence for a value of this quantity, so it cannot be filed
    // against a pair that has none. The submission endpoint checks this, but
    // only against the rules as they stood when the entry was queued — a
    // marker added, or the drug reclassified, in the meantime has to be caught
    // here. The recompute's own guard is not enough: it *skips* rather than
    // throwing (so one excluded parameter cannot block its siblings), which
    // would let this approval commit the entry and leave it beside the marker
    // that forbids it.
    await assertEntryParameterApplicable(
      parsed.data.input.drugId,
      parsed.data.input.parameter,
    );
    target = await insertParameterEntry(parsed.data.input, edit.submittedBy);
  } else if (parsed.data.op === 'update') {
    if (!edit.targetId) throw new Error('Missing target entry id');
    // drug + parameter are immutable, so read them from the live row to build
    // the duplicate-check tuple; reject an update that would collide with a
    // DIFFERENT identical row (self excluded).
    const current = await getParameterEntryRowById(edit.targetId);
    // The patch carries no `parameter`, so the registry rules (unit, bounds,
    // matrix/scenario applicability) can only be re-checked here, against the
    // live row's parameter. Same check the PATCH endpoint runs at submission.
    if (current) {
      const invalid = validateEntryForParameter(
        current.parameter,
        parsed.data.patch,
      );
      if (invalid) {
        throw new ParameterApplyError(
          `Approval rejected: ${invalid}`,
          400,
          'param_entry_invalid_for_parameter',
        );
      }
    }
    if (
      current &&
      (await entryDuplicateExists(
        {
          ...parsed.data.patch,
          drugId: current.drugId,
          parameter: current.parameter,
        },
        edit.targetId,
      ))
    ) {
      throw new ParameterApplyError(
        'Approval rejected: this change would duplicate an existing source value.',
        409,
        'param_entry_duplicate',
      );
    }
    // Same re-check as the create branch: the pair may have become undefined
    // while this edit waited in the queue.
    if (current) {
      await assertEntryParameterApplicable(current.drugId, current.parameter);
    }
    const updated = await updateParameterEntryRow(
      edit.targetId,
      parsed.data.patch,
    );
    if (!updated) {
      throw new ParameterApplyError(
        'Approval rejected: target entry no longer exists',
        409,
        'param_entry_target_missing',
      );
    }
    target = updated;
  } else {
    if (!edit.targetId) throw new Error('Missing target entry id');
    const deleted = await deleteParameterEntryRow(edit.targetId);
    if (!deleted) {
      throw new ParameterApplyError(
        'Approval rejected: target entry no longer exists',
        409,
        'param_entry_target_missing',
      );
    }
    target = deleted;
  }

  if (!isDrugParameterId(target.parameter)) return;
  // ...and anything downstream: the blood:plasma ratio is entry-backed too, and
  // every concentration aggregate is normalized with it, so a B/P entry restales
  // this drug's concentration summaries as well.
  const revisionId = await recomputeParameterAndDependents(
    target.drugId,
    target.parameter,
    edit.submittedBy,
    {
      // Link the revision to this approved edit so the peer sweep (which joins
      // drug_parameter_revisions on pending_edit_id) offers it for verification.
      pendingEditId: edit.id,
      approvedBy: reviewerId,
    },
  );
  if (revisionId != null) {
    await recordApproval({
      targetType: 'drug_parameter_revision',
      targetId: revisionId,
      approvedBy: reviewerId,
    });
    await recordImplicitAgentApproval({
      userId: edit.submittedBy,
      targetType: 'drug_parameter_revision',
      targetId: revisionId,
    });
    fireAgentHookForActorAsync(edit.submittedBy, {
      kind: 'parameter_approved',
      pendingEditId: edit.id,
      revisionId,
      drugId: target.drugId,
      parameter: target.parameter,
    });
  }
}

/**
 * The drug a `param_entry` proposal will write to.
 *
 * A create targets the DRUG (its `targetId` is the drug id, and the payload
 * carries it too); an update or delete targets the ENTRY, so the drug comes
 * from the row.
 *
 * For an update or delete this read is a GUESS, not a fact, and the caller has
 * to treat it as one. This comment used to assert that an entry never moves
 * between drugs. It does: `mergeDrugRows` reassigns every entry from the loser
 * to the winner. So the drug this returns can be the loser by the time the
 * lock is taken, and a lock over the loser protects nothing — which rebuilds
 * the very ABBA pair (advisory lock vs. `pending_edits` row lock) that taking
 * the lock here exists to prevent. `assertLockedEntryOwner` re-reads it under
 * the lock; see there.
 */
async function paramEntryEditDrugId(
  db: ReturnType<typeof getDb>,
  edit: typeof pendingEdits.$inferSelect,
): Promise<number | null> {
  const value = edit.proposedValue;
  const op =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>).op
      : null;
  if (op === 'create') {
    const input = (value as Record<string, unknown>).input;
    const drugId =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>).drugId
        : null;
    if (typeof drugId === 'number') return drugId;
    return typeof edit.targetId === 'number' ? edit.targetId : null;
  }
  if (edit.targetId == null) return null;
  const [row] = await db
    .select({ drugId: parameterEntries.drugId })
    .from(parameterEntries)
    .where(eq(parameterEntries.id, edit.targetId))
    .limit(1);
  return row?.drugId ?? null;
}

/**
 * Refuse the approval if the target entry moved to another drug between the
 * preflight read and the advisory lock.
 *
 * `paramEntryEditDrugId` reads the owner with no lock held, because there is
 * nothing to lock yet — the id it returns is what tells us which lock to take.
 * A `mergeDrugRows` committing in that window reassigns the entry from the
 * loser to the winner, and the approval then holds a lock over a drug that no
 * longer owns anything it is about. That lock protects nothing: the approval
 * goes on to take the `pending_edits` row lock and, deeper in, requests the
 * WINNER's advisory lock — while a direct writer already holding the winner's
 * lock requests that same row in `markEntryMutationsConflicted`. Advisory-then-
 * row on one side, row-then-advisory on the other: the exact ABBA cycle that
 * hoisting this lock to the top was meant to eliminate, rebuilt by a stale read.
 *
 * Refusing rather than re-locking, deliberately. Acquiring the winner's lock
 * from here would mean taking a lock whose id can be LOWER than one already
 * held, breaking the ascending-id order every other party observes
 * (`mergeDrugRows` sorts its pair) — trading a deadlock we understand for one
 * we would have to reason about every time the set changes. Rolling back and
 * retrying is not available either: this runs under `inTransaction`, which
 * JOINS a governance adapter's outer transaction, and the inner work has no
 * standing to abort it.
 *
 * So the approval refuses with the error the callers already handle as "your
 * view is stale, nothing was applied" — 409 to a reviewer, "not applied" to the
 * consensus gate. The next attempt reads the winner in its own preflight and
 * locks it correctly. The cost is one wasted approval attempt per merge that
 * lands mid-approval, and a merge is a rare administrative act; the alternative
 * is publishing under a lock that guards the wrong drug.
 *
 * Exported for its own test. The interleave it guards needs two connections
 * writing at once, which the single-connection integration harness cannot
 * stage; the rule it enforces — an owner outside the locked set is a refusal —
 * is what can be pinned, and is.
 */
export async function assertLockedEntryOwner(
  db: ReturnType<typeof getDb>,
  preflight: typeof pendingEdits.$inferSelect,
  lockIds: number[],
): Promise<void> {
  if (preflight.editType !== 'param_entry') return;
  const value = preflight.proposedValue;
  const op =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>).op
      : null;
  // A create names its drug in the payload rather than reading it off a row, so
  // there is no stale read to catch — and no entry yet for a merge to move.
  if (op !== 'update' && op !== 'delete') return;
  if (preflight.targetId == null) return;

  const owner = await paramEntryEditDrugId(db, preflight);
  // A vanished entry is not an ownership move: the apply below is what reports
  // it, with a message about the entry rather than about locking.
  if (owner == null) return;
  if (!lockIds.includes(owner)) throw new EntryOwnerMovedError();
}

/**
 * Every drug advisory-lock id the approval must hold before touching the
 * `pending_edits` row lock, derived from the drug links embedded in the
 * proposal's content. Called from `applyApprovedEdit` BEFORE the
 * `FOR NO KEY UPDATE` acquisition to keep the lock order aligned with the
 * merge fold: merge takes advisory → row, so the approval must take
 * advisory → row too, otherwise an ABBA deadlock kills one transaction
 * (merge holds advisory on a drug and requests `FOR UPDATE` on our edit
 * in rewriteWikiLinks; approval would hold `FOR NO KEY UPDATE` and
 * request the advisory here).
 *
 * Slug links go through `resolveOwningDrugIdForMonograph` so a legacy
 * monograph (whose `wiki_pages.drug_cid` still holds the PubChem CID
 * rather than the internal id) locks the same key the merge does.
 *
 * A `param_entry` edit is here for the same reason, against different writers.
 * Its drug lock used to be taken deep inside the apply (by
 * `assertEntryParameterApplicable`), i.e. AFTER the row lock — the opposite
 * order from every direct writer of `parameter_entries`, each of which holds
 * the drug lock while it marks the proposals against a row it rewrites
 * conflicted (`markEntryMutationsConflicted`). That is an ABBA pair: the writer
 * holds advisory and wants the row, the approval holds the row and wants
 * advisory, and PostgreSQL resolves it by killing one of them. Taking it here
 * puts every party on one order — advisory, then row — so they queue instead.
 * The later acquisition inside the apply is re-entrant and free.
 */
async function drugAdvisoryLockIdsForEdit(
  db: ReturnType<typeof getDb>,
  edit: typeof pendingEdits.$inferSelect,
): Promise<number[]> {
  if (edit.editType === 'param_entry') {
    // The owning drug AND every drug the dose context names (Cmax release B,
    // #1340), sorted once — the same set, in the same order, every other
    // writer of a `param_entry` payload locks (`withParamEntryPayloadLocks`).
    // An owner locked outside the sort would reopen the ABBA cycle against a
    // merge of a nested drug into it.
    const drugId = await paramEntryEditDrugId(db, edit);
    return paramEntryLockSet(drugId, edit.proposedValue);
  }
  if (
    edit.editType !== 'wiki_new' &&
    edit.editType !== 'wiki_page' &&
    edit.editType !== 'wiki_fact'
  ) {
    return [];
  }
  const content =
    edit.editType === 'wiki_fact' ? edit.proposedValue : edit.proposedValue;
  const refs = extractDrugLinksFromJson(content);
  if (refs.length === 0) return [];
  const ids = new Set<number>();
  const slugs: string[] = [];
  for (const ref of refs) {
    if (ref.kind === 'id') ids.add(ref.key);
    else slugs.push(ref.key);
  }
  if (slugs.length > 0) {
    const slugRows = await db
      .select({ drugCid: wikiPages.drugCid, slug: wikiPages.slug })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.pageType, 'drug_monograph'),
          inArray(wikiPages.slug, slugs),
        ),
      );
    for (const row of slugRows) {
      if (row.drugCid == null) continue;
      const owning = await resolveOwningDrugIdForMonograph(db, row.drugCid);
      if (owning != null) ids.add(owning);
    }
  }
  return Array.from(ids).sort((a, b) => a - b);
}

/**
 * Refuse a wiki_new/wiki_page/wiki_fact approval whose stored content links
 * to a drug that no longer exists. `wiki_pages`/`pending_edits.proposed_value`
 * are rewritten in-place by the merge fold, but a proposal submitted AFTER
 * the merge committed carries the loser id/slug in its content and would
 * publish a broken monograph link on approval. `resolveLockDrugId` classifies
 * a proposal for a non-drug topic page as `not_drug_scoped`, so the submit
 * lock doesn't catch it either — this is the last stop before publication.
 * Refuses with a `WikiFactApprovalError` (mapped to 409 by the caller) so
 * the reviewer sees exactly which links to fix.
 *
 * The caller (`applyApprovedEdit`) has already acquired
 * `lockDrugForEntryApplicability` on every referenced drug before the
 * `FOR NO KEY UPDATE` on the pending edit row — see
 * `drugAdvisoryLockIdsForEdit`. Those locks serialize this validation
 * with a concurrent merge: the merge either committed before the locks
 * were taken (revalidation sees the drug is gone → 409) or is waiting
 * behind our tx (its rewrite runs against post-approval content).
 */
async function assertDrugLinksResolve(
  db: ReturnType<typeof getDb>,
  content: unknown,
  proposalKind: 'wiki_page' | 'wiki_fact' | 'wiki_new',
): Promise<void> {
  const refs = extractDrugLinksFromJson(content);
  if (refs.length === 0) return;
  const ids = new Set<number>();
  const slugs = new Set<string>();
  for (const ref of refs) {
    if (ref.kind === 'id') ids.add(ref.key);
    else slugs.add(ref.key);
  }

  const missing: DrugLinkRef[] = [];
  if (ids.size > 0) {
    const rows = await db
      .select({ id: drugs.id })
      .from(drugs)
      .where(inArray(drugs.id, Array.from(ids)));
    const found = new Set(rows.map((r) => r.id));
    for (const id of ids) if (!found.has(id)) missing.push({ kind: 'id', key: id });
  }
  if (slugs.size > 0) {
    // Look up slugs across ALL wiki pages, not just drug monographs. Topic
    // pages (page_type = 'topic') also live at `/wiki/<slug>`, so a
    // legitimate topic-page link would otherwise be reported as a deleted
    // drug and 409 the approval. Only refuse when the slug resolves to no
    // wiki page at all — meaning the target really is gone.
    const rows = await db
      .select({ slug: wikiPages.slug })
      .from(wikiPages)
      .where(inArray(wikiPages.slug, Array.from(slugs)));
    const found = new Set(rows.map((r) => r.slug));
    for (const slug of slugs)
      if (!found.has(slug)) missing.push({ kind: 'slug', key: slug });
  }
  if (missing.length === 0) return;
  const detail = missing
    .map((m) => (m.kind === 'id' ? `/wiki/drug/${m.key}` : `/wiki/${m.key}`))
    .join(', ');
  throw new WikiFactApprovalError(
    `${proposalKind}: content links to deleted drug monograph(s) — ${detail}. A merge removed the target after this proposal was authored. Update the proposal to link to the surviving drug (or drop the link) before re-approving.`,
    409,
  );
}

async function applyApprovedEditEffects(
  db: ReturnType<typeof getDb>,
  edit: PendingEditRow,
  reviewerId: number,
): Promise<void> {
  const editId = edit.id;
  if (edit.editType === 'parameter') {
    if (!edit.targetId || !edit.parameter)
      throw new Error('Missing target or parameter');
    if (!isDrugParameterId(edit.parameter))
      throw new Error('Invalid parameter');

    // The submission gate on /api/drug-parameter only saw the applicability
    // rules as they stood when the edit was queued. A marker added, or the
    // drug reclassified as an analyte, in the meantime would otherwise have
    // this approval publish the very value those rules say cannot exist.
    // Re-check at apply time, where the decision becomes final.
    const blockedBy = await parameterWriteBlockedBy(
      db,
      edit.targetId,
      edit.parameter,
    );
    if (blockedBy) {
      throw new ParameterApplyError(
        blockedBy === 'substance_class'
          ? 'Approval rejected: this substance is not administered, so this parameter is not a defined quantity for it; correct its substanceClass before approving a value.'
          : 'Approval rejected: this parameter is marked not applicable for this substance; lift the marker before approving a value.',
        409,
        // Same code the entry-approval branch emits: the review card maps it to
        // review.errors.parameterNotApplicable, and without it the Norwegian
        // reviewer gets the English prose above.
        'parameter_not_applicable',
      );
    }

    // A source-value-backed parameter carries no authored value: what it
    // publishes is the aggregate recomputed from its `parameter_entries`. The
    // submission gate on /api/drug-parameter refuses these, so reaching here
    // means an edit queued before that gate existed — apply it and the number
    // would sit outside the pool until the next recompute wiped it, orphaning
    // this approval. Rejected after the applicability re-check above, which
    // answers the stronger question (the quantity is not defined for this
    // substance at all) and whose message names the fix the reviewer needs.
    if (!parameterAcceptsAuthoredValue(edit.parameter)) {
      throw new ParameterApplyError(
        'Approval rejected: this parameter is derived from its source values; add or edit those instead.',
        409,
        // Coded so the review card can print the Norwegian prose, as with the
        // applicability refusal above.
        'parameter_entry_backed',
      );
    }

    const oldDrug = await db
      .select()
      .from(drugs)
      .where(eq(drugs.id, edit.targetId))
      .limit(1);
    if (!oldDrug[0]) throw new Error('Drug not found');

    // Pre-fetch the drug_parameters map so readParameterValue can resolve
    // grouped parameters (#302 P2) when capturing the oldValue snapshot.
    const oldParams = await getDrugParameterMap(db, edit.targetId);
    const oldValue = readParameterValue(
      oldDrug[0] as Record<string, unknown>,
      edit.parameter,
      oldParams,
    );
    const newValue = edit.proposedValue;
    const meta = (edit.proposedMeta ?? {}) as Record<string, unknown>;

    const columnUpdate = await buildParameterUpdate({
      drugId: edit.targetId,
      parameter: edit.parameter,
      newValue,
      existing: oldDrug[0],
      applyingUserId: reviewerId,
    });

    try {
      await db
        .update(drugs)
        .set({
          ...columnUpdate,
          updatedAt: new Date(),
          popularityScore: sql`${drugs.popularityScore} + 1`,
        } as never)
        .where(eq(drugs.id, edit.targetId));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ParameterApplyError(
          `Approval rejected: ${edit.parameter} value collides with an existing drug row`,
          409,
        );
      }
      throw err;
    }

    // Same fallback as the citation gate: recording `[]` for a legacy row would
    // drop the very citation the approval gated on out of the revision log.
    const revisionReferenceIds = effectiveProposalReferenceIds(edit);
    const [paramRev] = await db
      .insert(drugParameterRevisions)
      .values({
        drugId: edit.targetId,
        parameter: edit.parameter,
        oldValue: oldValue as never,
        newValue: newValue as never,
        editSummary: (meta.editSummary as string) ?? null,
        referenceId: edit.referenceId,
        referenceIds: revisionReferenceIds.length
          ? revisionReferenceIds
          : undefined,
        pendingEditId: edit.id,
        createdBy: edit.submittedBy,
      })
      .returning({ id: drugParameterRevisions.id });
    if (paramRev) {
      await recordApproval({
        targetType: 'drug_parameter_revision',
        targetId: paramRev.id,
        approvedBy: reviewerId,
      });
      await recordImplicitAgentApproval({
        userId: edit.submittedBy,
        targetType: 'drug_parameter_revision',
        targetId: paramRev.id,
      });
      fireAgentHookForActorAsync(edit.submittedBy, {
        kind: 'parameter_approved',
        pendingEditId: edit.id,
        revisionId: paramRev.id,
        drugId: edit.targetId,
        parameter: edit.parameter,
      });
    }

    // A normalization input changed (blood:plasma ratio, molecular weight) —
    // restale every summarizable parameter's cached aggregate for this drug.
    // Link the derived revisions to this approved edit and stamp the same
    // reviewer/author approvals so they aren't unapproved level-0 rows invisible
    // to the peer sweep (which joins through pending_edit_id).
    if (isNormalizationInput(edit.parameter)) {
      await recomputeSummariesForDrug(edit.targetId, edit.submittedBy, {
        pendingEditId: edit.id,
        approvedBy: reviewerId,
      });
    }

    // A priority flag on this parameter (or a whole-drug flag) is intentionally
    // left active — it is a "dig deep here" instruction that persists across
    // approved edits so agents keep working the parameter until a human
    // moderator resolves it (agents/drug-db-maintainer.md §3 A0).

    await db.insert(drugInteractions).values({
      drugId: edit.targetId,
      userId: edit.submittedBy,
      eventType: 'edit',
    });
  } else if (edit.editType === 'wiki_page') {
    if (!edit.targetId) throw new Error('Missing target page ID');
    const meta = (edit.proposedMeta ?? {}) as Record<string, unknown>;
    await assertDrugLinksResolve(db, edit.proposedValue, 'wiki_page');

    // Look up the target's page type so topic pages get their section
    // anchors minted server-side at approval (monographs are left untouched).
    const [targetPage] = await db
      .select({ pageType: wikiPages.pageType })
      .from(wikiPages)
      .where(eq(wikiPages.id, edit.targetId))
      .limit(1);
    const nextContent = ensureTopicSectionIds(
      targetPage?.pageType,
      edit.proposedValue,
    );
    const contentHtml = renderHtml(nextContent);
    const contentPlaintext = extractPlaintext(nextContent);

    await db
      .update(wikiPages)
      .set({
        content: nextContent as never,
        contentHtml,
        contentPlaintext,
        title: (meta.title as string) ?? undefined,
        updatedBy: edit.submittedBy,
        updatedAt: new Date(),
      })
      .where(eq(wikiPages.id, edit.targetId));

    const [pageRev] = await db
      .insert(wikiRevisions)
      .values({
        pageId: edit.targetId,
        content: nextContent as never,
        contentHtml,
        editSummary: (meta.editSummary as string) ?? null,
        pendingEditId: edit.id,
        createdBy: edit.submittedBy,
      })
      .returning({ id: wikiRevisions.id });
    if (pageRev) {
      await recordApproval({
        targetType: 'wiki_revision',
        targetId: pageRev.id,
        approvedBy: reviewerId,
      });
      await recordImplicitAgentApproval({
        userId: edit.submittedBy,
        targetType: 'wiki_revision',
        targetId: pageRev.id,
      });
      fireAgentHookForActorAsync(edit.submittedBy, {
        kind: 'monograph_approved',
        pendingEditId: edit.id,
        revisionId: pageRev.id,
        pageId: edit.targetId,
      });
    }
  } else if (edit.editType === 'metabolism') {
    if (!edit.targetId) throw new Error('Missing target drug id');
    // Re-validate the stored payload through the same schema the submit
    // endpoint used, so a row queued before a schema change (or via a
    // different write path) can't apply an out-of-spec metabolism box.
    const parsed = metabolismWriteSchema.safeParse(edit.proposedValue);
    if (!parsed.success) {
      throw new ParameterApplyError(
        'Approval rejected: invalid metabolism payload: ' +
          parsed.error.issues
            .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
            .join('; '),
        400,
      );
    }
    const { editSummary: _editSummary, submitForReview: _submitForReview, ...payload } =
      parsed.data;
    await replaceDrugMetabolism(
      db,
      edit.targetId,
      toMetabolismWriteInput(payload),
      edit.submittedBy,
    );
  } else if (edit.editType === 'receptor_targets') {
    if (!edit.targetId) throw new Error('Missing target drug id');
    // Re-validate the stored payload through the same schema the submit
    // endpoint used, so a row queued before a schema change can't apply an
    // out-of-spec set of mechanisms.
    const parsed = receptorTargetsWriteSchema.safeParse(edit.proposedValue);
    if (!parsed.success) {
      throw new ParameterApplyError(
        'Approval rejected: invalid receptor-target payload: ' +
          parsed.error.issues
            .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
            .join('; '),
        400,
      );
    }
    await replaceDrugReceptorTargets(
      db,
      edit.targetId,
      parsed.data.mechanisms,
      edit.submittedBy,
    );
  } else if (edit.editType === 'enzyme_interaction') {
    if (!edit.targetId) throw new Error('Missing target drug id');
    const parsed = enzymeInteractionsWriteSchema.safeParse(edit.proposedValue);
    if (!parsed.success) {
      throw new ParameterApplyError(
        'Approval rejected: invalid enzyme-interaction payload: ' +
          parsed.error.issues
            .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
            .join('; '),
        400,
      );
    }
    await replaceDrugEnzymeInteractions(
      db,
      edit.targetId,
      parsed.data.interactions,
      edit.submittedBy,
    );
  } else if (edit.editType === 'bio_entity') {
    // Re-validate the queued payload through the same schema the submit
    // endpoint stripped it down to, so a row queued before a schema change
    // can't apply an out-of-spec entity. The original submitter is credited
    // as the entity's author / monograph creator.
    const parsed = bioEntityEditSchema.safeParse(edit.proposedValue);
    if (!parsed.success) {
      throw new ParameterApplyError(
        'Approval rejected: invalid bio-entity payload: ' +
          parsed.error.issues
            .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
            .join('; '),
        400,
      );
    }
    if (parsed.data.op === 'create') {
      const entity = await createBioEntity(db, parsed.data.entity);
      // Mint the empty monograph up front, mirroring drug creation and the
      // admin direct-write path in api/bio-entities.ts (#785).
      await ensureEntityMonograph(db, entity, edit.submittedBy);
    } else {
      if (!edit.targetId) throw new Error('Missing target entity id');
      const updated = await updateBioEntity(db, edit.targetId, parsed.data.patch);
      if (!updated) {
        throw new ParameterApplyError(
          'Approval rejected: target entity no longer exists',
          409,
        );
      }
    }
  } else if (edit.editType === 'param_entry') {
    await applyApprovedParameterEntry(edit, reviewerId);
  } else if (edit.editType === 'wiki_fact') {
    await applyApprovedWikiFact(edit, reviewerId);
  } else if (edit.editType === 'wiki_section') {
    await applyApprovedWikiSection(edit, reviewerId);
  } else if (edit.editType === 'paper_review') {
    await applyApprovedPaperReview(edit, reviewerId);
  } else if (edit.editType === 'learning_unit') {
    await applyApprovedLearningUnit(db, edit, reviewerId);
  } else if (edit.editType === 'clinical_case') {
    await applyApprovedClinicalCase(db, edit, reviewerId);
  } else if (edit.editType === 'wiki_new') {
    const meta = (edit.proposedMeta ?? {}) as Record<string, unknown>;
    const title = (meta.title as string) ?? 'Untitled';
    const slug = generateSlug(title);
    // proposedMeta is z.any() in the pending-edits schema, so the
    // submission path may have stored an unbounded molecularWeight.
    // Re-validate through newDrugFieldsSchema before insertDrug so a
    // pre-#302 pending edit (or a hand-crafted submission) can't write
    // an out-of-spec MW into the JSONB store.
    let newDrugInput: InsertDrugInput | null = null;
    if (meta.newDrug && typeof meta.newDrug === 'object') {
      const parsed = newDrugFieldsSchema.safeParse(meta.newDrug);
      if (!parsed.success) {
        throw new Error(
          'Approval rejected: pending newDrug payload failed validation: ' +
            parsed.error.issues
              .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
              .join('; '),
        );
      }
      newDrugInput = parsed.data as InsertDrugInput;
    }
    const parametersBag = (meta.parameters ?? null) as Record<
      string,
      unknown
    > | null;
    const parametersReferenceId =
      typeof meta.parametersReferenceId === 'number'
        ? meta.parametersReferenceId
        : (edit.referenceId ?? null);

    // Pre-validate parameters against the registry before any writes so a
    // bad pending edit surfaces as a clean approval error instead of
    // leaving half-created rows.
    let parameterEntries: ReturnType<typeof validateParameterBag> = [];
    if (parametersBag && Object.keys(parametersBag).length > 0) {
      parameterEntries = validateParameterBag(parametersBag);
      if (parameterEntries.length > 0 && !parametersReferenceId) {
        throw new Error(
          'parametersReferenceId is required to approve an edit with PK values',
        );
      }
    }

    const [existingPage] = await db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(eq(wikiPages.slug, slug))
      .limit(1);
    if (existingPage) {
      throw new Error('A page with this title already exists');
    }

    // Create the drug row first if requested so the wikiPages.drugCid
    // reference is valid by the time we insert the monograph.
    let finalDrugId: number | null =
      typeof meta.drugCid === 'number' ? meta.drugCid : null;
    if (newDrugInput) {
      try {
        // The reviewer's id powers drug_parameters.updated_by when the
        // newDrug payload includes a molecularWeight value.
        const drugRow = await insertDrug({
          ...newDrugInput,
          createdBy: reviewerId,
        });
        finalDrugId = drugRow.id;
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new Error(
            'A drug with this slug or PubChem CID already exists; unlink or edit the pending entry before approving',
          );
        }
        throw err;
      }
    }

    const newPageType = (meta.pageType as string) ?? 'topic';
    await assertDrugLinksResolve(db, edit.proposedValue, 'wiki_new');
    // Guarantee topic-page section anchors at approval time too, so an
    // agent- or human-authored wiki_new whose client skipped minting still
    // lands with targetable headings.
    const newContent = ensureTopicSectionIds(newPageType, edit.proposedValue);
    const contentHtml = renderHtml(newContent);
    const contentPlaintext = extractPlaintext(newContent);

    const [page] = await db
      .insert(wikiPages)
      .values({
        slug,
        title,
        content: newContent as never,
        contentHtml,
        contentPlaintext,
        pageType: newPageType,
        drugCid: finalDrugId ?? undefined,
        status: 'published',
        createdBy: edit.submittedBy,
        updatedBy: edit.submittedBy,
      })
      .returning();

    if (page) {
      const [newRev] = await db
        .insert(wikiRevisions)
        .values({
          pageId: page.id,
          content: newContent as never,
          contentHtml,
          editSummary: (meta.editSummary as string) ?? 'Første versjon',
          pendingEditId: edit.id,
          createdBy: edit.submittedBy,
        })
        .returning({ id: wikiRevisions.id });
      if (newRev && page) {
        await recordApproval({
          targetType: 'wiki_revision',
          targetId: newRev.id,
          approvedBy: reviewerId,
        });
        await recordImplicitAgentApproval({
          userId: edit.submittedBy,
          targetType: 'wiki_revision',
          targetId: newRev.id,
        });
        fireAgentHookForActorAsync(edit.submittedBy, {
          kind: 'monograph_approved',
          pendingEditId: edit.id,
          revisionId: newRev.id,
          pageId: page.id,
        });
      }
    }

    if (parameterEntries.length > 0 && finalDrugId && parametersReferenceId) {
      const drugIdForHook = finalDrugId;
      const { revisionIds } = await applyInitialParameters({
        drugId: drugIdForHook,
        entries: parameterEntries,
        referenceId: parametersReferenceId,
        userId: edit.submittedBy,
        editSummary: (meta.editSummary as string) ?? undefined,
        pendingEditId: edit.id,
      });
      // Auto-stamp every parameter revision the wiki_new approval
      // produced and notify the hook agent (#344, #345). Without
      // the stamp, parameter facts created through monograph
      // creation would silently start at zero approvals even though
      // direct parameter approvals always carry one. Without the
      // hook, the agent would never see them until the next
      // scheduled cycle. The matching parameter id is on each entry,
      // not the revision row itself, so we zip the two arrays.
      for (let i = 0; i < revisionIds.length; i += 1) {
        const revId = revisionIds[i];
        const entry = parameterEntries[i];
        if (revId === undefined) continue;
        await recordApproval({
          targetType: 'drug_parameter_revision',
          targetId: revId,
          approvedBy: reviewerId,
        });
        await recordImplicitAgentApproval({
          userId: edit.submittedBy,
          targetType: 'drug_parameter_revision',
          targetId: revId,
        });
        if (entry) {
          fireAgentHookForActorAsync(edit.submittedBy, {
            kind: 'parameter_approved',
            pendingEditId: edit.id,
            revisionId: revId,
            drugId: drugIdForHook,
            parameter: entry.id,
          });
        }
      }
    }
  }

  // Stamp the final status on the same transaction as every effect above, so
  // they commit or roll back together. markConflictingPendingEdits also runs
  // on this transaction (via getDb()); if it throws, the status stamp and all
  // effects roll back together rather than leaving the edit `pending` with its
  // changes already applied.
  await db
    .update(pendingEdits)
    .set({
      status: 'approved',
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
    })
    .where(eq(pendingEdits.id, editId));

  await markConflictingPendingEdits(edit, reviewerId);

  // Same transaction as the status stamp: the submitter's notice exists iff
  // the approval committed. Every approval path (reviewer, agent consensus,
  // governance adapter) funnels through here.
  await notifyEditDecision({ edit, decision: 'approved', actorUserId: reviewerId });
}

/**
 * Approval handler for editType='paper_review'. Reviews now auto-publish, so
 * this branch only ever runs for a review queued BEFORE that change (drained
 * by migration 0073, or a residual legacy row). It reuses the shared
 * `recordPaperReview` write path — upsert the live row + append a revision +
 * reset peer signals + close the PDF request — then adds the human/consensus
 * reviewer's approval stamp and notifies the submitting agent.
 */
async function applyApprovedPaperReview(
  edit: typeof pendingEdits.$inferSelect,
  reviewerId: number,
): Promise<void> {
  if (!edit.targetId) {
    throw new WikiFactApprovalError('paper_review: missing citation id');
  }
  const value = materializePaperReviewForApproval(edit.proposedValue);

  const recorded = await recordPaperReview({
    citationId: edit.targetId,
    authorUserId: edit.submittedBy,
    input: {
      reviewMarkdown: value.reviewMarkdown,
      overallScore: value.overallScore,
      conclusionSupport: value.conclusionSupport,
      reviewConfidence: value.reviewConfidence,
      readInFull: value.readInFull,
      editSummary: null,
    },
  });

  // recordPaperReview already stamped the author's implicit approval and
  // cleared stale stamps; add the reviewer's explicit approval on top.
  await recordApproval({
    targetType: 'paper_review',
    targetId: recorded.id,
    approvedBy: reviewerId,
  });
  fireAgentHookForActorAsync(edit.submittedBy, {
    kind: 'paper_review_approved',
    pendingEditId: edit.id,
    paperReviewId: recorded.id,
    citationId: edit.targetId,
  });
}

export function materializePaperReviewForApproval(value: unknown): {
  reviewMarkdown: string;
  overallScore: number | null;
  conclusionSupport: string | null;
  reviewConfidence: string | null;
  readInFull: boolean;
} {
  if (!value || typeof value !== 'object') {
    throw new WikiFactApprovalError(
      'paper_review: proposedValue must be an object',
    );
  }
  const raw = value as Record<string, unknown>;
  const parsed = createPaperReviewSchema.safeParse({
    reviewMarkdown: raw.reviewMarkdown,
    // Pending reviews queued before the read-in-full attestation existed
    // carry no flag; default them to false so they still approve (landing as
    // not-attested, matching the column default).
    readInFull: typeof raw.readInFull === 'boolean' ? raw.readInFull : false,
    ...(raw.overallScore != null ? { overallScore: raw.overallScore } : {}),
    ...(raw.conclusionSupport != null
      ? { conclusionSupport: raw.conclusionSupport }
      : {}),
    ...(raw.reviewConfidence != null
      ? { reviewConfidence: raw.reviewConfidence }
      : {}),
  });
  if (!parsed.success) {
    throw new WikiFactApprovalError(
      'paper_review: pending payload failed validation: ' +
        parsed.error.issues
          .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
          .join('; '),
    );
  }
  return {
    reviewMarkdown: parsed.data.reviewMarkdown,
    overallScore: parsed.data.overallScore ?? null,
    conclusionSupport: parsed.data.conclusionSupport ?? null,
    reviewConfidence: parsed.data.reviewConfidence ?? null,
    readInFull: parsed.data.readInFull,
  };
}

/**
 * Approval handler for editType='wiki_fact'. Loads the target page, parses
 * the stored content (wrapping legacy v1 docs into v2 transparently),
 * dispatches add/replace/remove via `applyFactOp`, regenerates the cached
 * HTML/plaintext, writes a `wiki_revisions` row pointing at the pending
 * edit, and persists the new envelope.
 *
 * Throws on any invariant violation (unknown sectionId, missing target
 * fact, etc.) so the API surfaces a clean 4xx instead of a half-applied
 * mutation.
 */
async function applyApprovedWikiFact(
  edit: typeof pendingEdits.$inferSelect,
  reviewerId: number,
): Promise<void> {
  const db = getDb();

  if (!edit.targetId)
    throw new WikiFactApprovalError('wiki_fact: missing target page id');
  if (!edit.sectionId)
    throw new WikiFactApprovalError('wiki_fact: missing sectionId');
  if (!edit.factOperation)
    throw new WikiFactApprovalError('wiki_fact: missing factOperation');

  const op = edit.factOperation as FactOperation;
  if (op !== 'add' && op !== 'replace' && op !== 'remove' && op !== 'reorder') {
    throw new WikiFactApprovalError(
      `wiki_fact: unsupported factOperation "${op}"`,
    );
  }

  const sectionIdRaw = edit.sectionId;
  const fieldId = edit.fieldId ?? undefined;
  const anchor = (edit.factTargetAnchor ?? {}) as Record<string, unknown>;
  const factId = typeof anchor.factId === 'string' ? anchor.factId : undefined;

  let factNode: MonographFactNode | null = null;
  if (op === 'add' || op === 'replace') {
    factNode = materializeFactForApproval(edit);
    // A fact node's TipTap body may embed drug links. If the target drug
    // was deleted by a merge after this proposal was authored, publishing
    // would leave a broken link — refuse rather than approve the stale
    // reference. `remove`/`reorder` don't add new content, so they skip
    // this check.
    if (factNode) {
      await assertDrugLinksResolve(db, factNode, 'wiki_fact');
    }
  }

  // Reorder ships its destination index in proposedValue.position.
  let reorderPosition: number | undefined;
  if (op === 'reorder') {
    const pv = edit.proposedValue as { position?: unknown } | null;
    if (
      !pv ||
      typeof pv !== 'object' ||
      typeof (pv as { position?: unknown }).position !== 'number' ||
      !Number.isInteger((pv as { position: number }).position) ||
      (pv as { position: number }).position < 0
    ) {
      throw new WikiFactApprovalError(
        'wiki_fact reorder: proposedValue.position must be a non-negative integer',
      );
    }
    reorderPosition = (pv as { position: number }).position;
    if (!factId) {
      throw new WikiFactApprovalError(
        'wiki_fact reorder: factTargetAnchor.factId is required',
      );
    }
  }

  const [page] = await db
    .select({
      id: wikiPages.id,
      content: wikiPages.content,
      pageType: wikiPages.pageType,
    })
    .from(wikiPages)
    .where(eq(wikiPages.id, edit.targetId))
    .limit(1);
  if (!page)
    throw new WikiFactApprovalError('wiki_fact: target page not found', 404);

  let nextContent: unknown;
  if (page.pageType === 'drug_monograph') {
    if (!isMonographSectionId(sectionIdRaw)) {
      throw new WikiFactApprovalError(
        `wiki_fact: unknown sectionId "${sectionIdRaw}"`,
      );
    }
    const sectionId = sectionIdRaw as MonographSectionId;
    // Defense-in-depth: the POST handler already rejects unknown
    // fieldIds, but a row could predate that check or be inserted via a
    // different path. Refuse to merge into an undeclared field — the
    // v2 renderer only walks schema-declared fields, so the fact would
    // silently disappear.
    if (
      fieldId &&
      !getMonographField(sectionId, fieldId) &&
      !isMergedMonographFieldId(sectionId, fieldId)
    ) {
      throw new WikiFactApprovalError(
        `wiki_fact: unknown fieldId "${fieldId}" for section "${sectionId}"`,
      );
    }
    const currentContent: MonographContentV2 = isMonographContentV2(
      page.content,
    )
      ? (page.content as MonographContentV2)
      : wrapV1AsV2(page.content);
    if (op === 'reorder') {
      // Monograph fact reorder is filed as a follow-up; the splice
      // throws on its own but we surface a cleaner error here.
      throw new WikiFactApprovalError(
        'wiki_fact reorder is not yet supported on drug-monograph pages — file a follow-up if you need it',
      );
    }
    try {
      nextContent = applyFactOp(
        currentContent,
        op,
        { sectionId, fieldId, factId },
        factNode,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /not found/i.test(message) ? 404 : 400;
      throw new WikiFactApprovalError(`wiki_fact: ${message}`, status);
    }
  } else if (
    page.pageType === 'topic' ||
    page.pageType === 'entity_monograph'
  ) {
    // Topic pages (and entity monographs, #785) keep a flat v1 doc; sectionIds
    // live as `data-section-id` attributes on heading nodes (#348). Validate
    // both shape and presence — same checks as the POST handler, since
    // a row could have been queued before the migration ran.
    if (!isValidTopicSectionId(sectionIdRaw)) {
      throw new WikiFactApprovalError(
        `wiki_fact: invalid topic sectionId "${sectionIdRaw}"`,
      );
    }
    if (fieldId) {
      throw new WikiFactApprovalError(
        `wiki_fact: fieldId is not supported on topic pages (sectionId="${sectionIdRaw}")`,
      );
    }
    const currentDoc = (page.content ?? {
      type: 'doc',
      content: [],
    }) as TipTapDoc;
    const known = listTopicSectionIds(currentDoc);
    if (!known.includes(sectionIdRaw)) {
      throw new WikiFactApprovalError(
        `wiki_fact: sectionId "${sectionIdRaw}" not found on target page`,
        404,
      );
    }
    try {
      nextContent = applyTopicFactOp(
        currentDoc,
        op,
        {
          sectionId: sectionIdRaw,
          factId,
          ...(reorderPosition !== undefined
            ? { position: reorderPosition }
            : {}),
        },
        factNode,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /not found/i.test(message) ? 404 : 400;
      throw new WikiFactApprovalError(`wiki_fact: ${message}`, status);
    }
  } else {
    throw new WikiFactApprovalError(
      `wiki_fact: unsupported pageType "${page.pageType}"`,
    );
  }

  const contentHtml = renderHtml(nextContent);
  const contentPlaintext = extractPlaintext(nextContent);

  await db
    .update(wikiPages)
    .set({
      content: nextContent as never,
      contentHtml,
      contentPlaintext,
      updatedBy: edit.submittedBy,
      updatedAt: new Date(),
    })
    .where(eq(wikiPages.id, edit.targetId));

  const [factRev] = await db
    .insert(wikiRevisions)
    .values({
      pageId: edit.targetId,
      content: nextContent as never,
      contentHtml,
      editSummary:
        // Keep the revision summary tight — surface the operation + statement
        // (truncated) so reviewers browsing history can see what changed
        // without opening the full diff.
        summarizeFactRevision(op, edit.factStatement, factId ?? null),
      pendingEditId: edit.id,
      createdBy: edit.submittedBy,
    })
    .returning({ id: wikiRevisions.id });
  if (factRev) {
    await recordApproval({
      targetType: 'wiki_revision',
      targetId: factRev.id,
      approvedBy: reviewerId,
    });
    await recordImplicitAgentApproval({
      userId: edit.submittedBy,
      targetType: 'wiki_revision',
      targetId: factRev.id,
    });
    fireAgentHookForActorAsync(edit.submittedBy, {
      kind: 'wiki_fact_approved',
      pendingEditId: edit.id,
      revisionId: factRev.id,
      pageId: edit.targetId,
      sectionId: sectionIdRaw,
      operation: op,
      factStatement: edit.factStatement,
    });
  }
}

/**
 * Build the fact node that approval will splice into the page. Validates that
 * the stored `proposedValue` still matches the reviewed `factStatement`, then
 * refreshes its embedded `attrs.referenceIds` from the column-level
 * `referenceIds`, which is the source of truth that `PATCH /api/pending-edits`
 * updates. Without this resync, references edited after submission would
 * silently revert to the POST-time set on approval.
 *
 * Exported for unit testing — see tests/api/wiki-fact-approval.test.ts.
 */
export function materializeFactForApproval(
  edit: typeof pendingEdits.$inferSelect,
): MonographFactNode {
  if (!isFactNode(edit.proposedValue)) {
    throw new WikiFactApprovalError(
      'wiki_fact: proposedValue is not a valid fact node',
    );
  }
  const stored = edit.proposedValue as MonographFactNode;
  // Pin a non-empty factId. The PATCH handler already locks factId
  // immutability for wiki_fact rows, but verify here in case a row
  // pre-dates that guard or arrives via a different write path. An
  // empty/whitespace id would silently break later replace/remove
  // anchoring (anchors require non-empty ids).
  if (
    typeof stored.attrs.factId !== 'string' ||
    stored.attrs.factId.trim() === ''
  ) {
    throw new WikiFactApprovalError(
      'wiki_fact: proposedValue.attrs.factId must be a non-empty string',
    );
  }
  // For replace ops, also verify the embedded factId still matches the
  // anchor — Phase 2a's replaceFactInSection enforces this at apply time
  // via createFactNode contracts, but catching it earlier produces a
  // clearer error for the reviewer.
  if (edit.factOperation === 'replace') {
    const anchor = (edit.factTargetAnchor ?? {}) as Record<string, unknown>;
    const anchorId = typeof anchor.factId === 'string' ? anchor.factId : null;
    if (!anchorId) {
      throw new WikiFactApprovalError(
        'wiki_fact: replace requires factTargetAnchor.factId',
      );
    }
    if (stored.attrs.factId !== anchorId) {
      throw new WikiFactApprovalError(
        `wiki_fact: proposedValue.attrs.factId "${stored.attrs.factId}" does not match factTargetAnchor "${anchorId}"`,
      );
    }
  }
  if (edit.factOperation === 'add' || edit.factOperation === 'replace') {
    const factStatement = edit.factStatement?.trim();
    if (!factStatement) {
      throw new WikiFactApprovalError(
        'wiki_fact: factStatement is required for add/replace approval',
      );
    }
    if (factNodePlaintext(stored) !== factStatement) {
      throw new WikiFactApprovalError(
        'wiki_fact: proposedValue content does not match reviewed factStatement',
      );
    }
  }
  const columnRefs =
    edit.referenceIds && edit.referenceIds.length > 0
      ? edit.referenceIds
      : edit.referenceId
        ? [edit.referenceId]
        : [];
  return {
    ...stored,
    attrs: {
      ...stored.attrs,
      referenceIds: columnRefs,
    },
  };
}

function factNodePlaintext(node: MonographFactNode): string {
  function readNode(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const record = value as { text?: unknown; content?: unknown };
    const text = typeof record.text === 'string' ? record.text : '';
    if (!Array.isArray(record.content)) return text;
    return text + record.content.map(readNode).join('');
  }

  return node.content.map(readNode).join(' ').replace(/\s+/g, ' ').trim();
}

function summarizeFactRevision(
  op: FactOperation,
  statement: string | null,
  factId: string | null,
): string {
  // Norwegian, matching the `review.factOp*` labels the review UI shows for the
  // same four operations: this string is stored on the revision and rendered
  // verbatim in the page history, so it cannot be localized later.
  const head =
    op === 'add'
      ? 'Legg til fakta'
      : op === 'replace'
        ? 'Erstatt fakta'
        : op === 'reorder'
          ? 'Flytt fakta'
          : 'Fjern fakta';
  if (op === 'remove' || op === 'reorder') {
    return factId ? `${head} (${factId})` : head;
  }
  const trimmed = (statement ?? '').trim();
  if (!trimmed) return head;
  const snippet = trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
  return `${head}: ${snippet}`;
}

/**
 * Approval handler for editType='wiki_section' (#349). Topic-page-only:
 * mutates the heading list of the target page (add / edit-rename /
 * reorder / remove). Re-validates the same invariants the POST handler
 * checked so a row queued before the page changed surfaces a clean 4xx
 * instead of mangling the doc.
 */
async function applyApprovedWikiSection(
  edit: typeof pendingEdits.$inferSelect,
  reviewerId: number,
): Promise<void> {
  const db = getDb();
  if (!edit.targetId) {
    throw new WikiFactApprovalError('wiki_section: missing target page id');
  }
  const payload = wikiSectionPayloadSchema.safeParse(edit.proposedValue);
  if (!payload.success) {
    throw new WikiFactApprovalError(
      'wiki_section: invalid stored payload (' +
        payload.error.issues.map((i) => i.message).join('; ') +
        ')',
    );
  }
  const op = payload.data;

  const [page] = await db
    .select({
      id: wikiPages.id,
      content: wikiPages.content,
      pageType: wikiPages.pageType,
    })
    .from(wikiPages)
    .where(eq(wikiPages.id, edit.targetId))
    .limit(1);
  if (!page) {
    throw new WikiFactApprovalError('wiki_section: target page not found', 404);
  }
  if (page.pageType !== 'topic' && page.pageType !== 'entity_monograph') {
    throw new WikiFactApprovalError(
      `wiki_section: unsupported pageType "${page.pageType}"`,
    );
  }

  const currentDoc = (page.content ?? {
    type: 'doc',
    content: [],
  }) as TipTapDoc;

  let nextDoc: TipTapDoc;
  let summary: string;
  try {
    if (op.operation === 'add') {
      const result = applyAddSection(currentDoc, {
        headingText: op.headingText,
        headingLevel: op.headingLevel,
        position: op.position,
      });
      nextDoc = result.doc;
      summary = `Legg til seksjon: ${op.headingText} (${result.sectionId})`;
    } else {
      const sid = edit.sectionId;
      if (!sid) {
        throw new WikiFactApprovalError(
          `wiki_section ${op.operation}: missing sectionId`,
        );
      }
      if (!isValidTopicSectionId(sid)) {
        throw new WikiFactApprovalError(
          `wiki_section: invalid sectionId "${sid}"`,
        );
      }
      const known = listTopicSectionIds(currentDoc);
      if (!known.includes(sid)) {
        throw new WikiFactApprovalError(
          `wiki_section: sectionId "${sid}" not found on target page`,
          404,
        );
      }
      if (op.operation === 'edit') {
        nextDoc = applyEditSection(currentDoc, {
          sectionId: sid,
          headingText: op.headingText,
        });
        summary = `Endre seksjonsnavn ${sid}: ${op.headingText}`;
      } else if (op.operation === 'reorder') {
        nextDoc = applyReorderSection(currentDoc, {
          sectionId: sid,
          position: op.position,
        });
        summary = `Flytt seksjon ${sid} → posisjon ${op.position}`;
      } else {
        // remove (with optional cascade #360)
        const cascade = op.cascade === true;
        if (!cascade && countSectionBodyNodes(currentDoc, sid) > 0) {
          throw new WikiFactApprovalError(
            `wiki_section: section "${sid}" is not empty; remove its facts first or set cascade: true`,
          );
        }
        let workingDoc = currentDoc;
        let pendingFactIds: number[] = [];
        if (cascade) {
          // Strip live fact nodes from the section body. Non-fact
          // prose stays — if any remains, applyRemoveSection below
          // throws, the catch block re-raises, and the pending fact
          // rejections are never written. That ordering matters
          // because the rejections are durable and not in a
          // transaction (Codex review on #370 round 1).
          workingDoc = clearSectionFacts(workingDoc, sid);
          // Stage the pending-fact ids for rejection AFTER the
          // splice succeeds. Collecting now is cheap and lets us
          // skip a second round-trip post-success.
          const pendingFacts = await db
            .select({ id: pendingEdits.id })
            .from(pendingEdits)
            .where(
              and(
                eq(pendingEdits.editType, 'wiki_fact'),
                eq(pendingEdits.targetId, edit.targetId!),
                eq(pendingEdits.sectionId, sid),
                eq(pendingEdits.status, 'pending'),
              ),
            );
          pendingFactIds = pendingFacts.map((p) => p.id);
        }
        // Try the splice first. If non-fact prose remains, this
        // throws and no DB writes have happened yet.
        nextDoc = applyRemoveSection(workingDoc, { sectionId: sid });
        let cascadeRejectedCount = 0;
        if (cascade && pendingFactIds.length > 0) {
          // Splice succeeded — now durably reject the pending fact
          // edits in a single batch update.
          await db
            .update(pendingEdits)
            .set({
              status: 'rejected',
              rejectionReason: 'out_of_scope',
              rejectionComment: `Cascade-rejected when section "${sid}" was removed via wiki_section#${edit.id}`,
              reviewedBy: reviewerId,
              reviewedAt: new Date(),
            })
            .where(inArray(pendingEdits.id, pendingFactIds));
          cascadeRejectedCount = pendingFactIds.length;
        }
        summary = cascade
          ? `Fjern seksjon ${sid} (kaskade: avviste ${cascadeRejectedCount} ventende faktaendringer)`
          : `Fjern seksjon ${sid}`;
      }
    }
  } catch (err) {
    if (err instanceof WikiFactApprovalError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const status = /not found/i.test(message) ? 404 : 400;
    throw new WikiFactApprovalError(`wiki_section: ${message}`, status);
  }

  const contentHtml = renderHtml(nextDoc);
  const contentPlaintext = extractPlaintext(nextDoc);

  await db
    .update(wikiPages)
    .set({
      content: nextDoc as never,
      contentHtml,
      contentPlaintext,
      updatedBy: edit.submittedBy,
      updatedAt: new Date(),
    })
    .where(eq(wikiPages.id, edit.targetId));

  const [sectionRev] = await db
    .insert(wikiRevisions)
    .values({
      pageId: edit.targetId,
      content: nextDoc as never,
      contentHtml,
      editSummary: summary,
      pendingEditId: edit.id,
      createdBy: edit.submittedBy,
    })
    .returning({ id: wikiRevisions.id });
  if (sectionRev) {
    await recordApproval({
      targetType: 'wiki_revision',
      targetId: sectionRev.id,
      approvedBy: reviewerId,
    });
    await recordImplicitAgentApproval({
      userId: edit.submittedBy,
      targetType: 'wiki_revision',
      targetId: sectionRev.id,
    });
    fireAgentHookForActorAsync(edit.submittedBy, {
      kind: 'wiki_section_approved',
      pendingEditId: edit.id,
      revisionId: sectionRev.id,
      pageId: edit.targetId,
      operation: op.operation,
      sectionId: edit.sectionId ?? null,
    });
  }
}
