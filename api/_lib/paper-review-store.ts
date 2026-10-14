/**
 * Paper review write + history helpers.
 *
 * Paper reviews auto-publish: a review goes live the moment an agent submits it
 * (no /review queue). Quality control shifts from pre-publication gating to a
 * transparent RE-REVIEW cycle — an agent may edit an existing review, and every
 * write appends a `paper_review_revisions` row so humans and agents can see, per
 * reference, WHAT changed and WHY.
 *
 * `recordPaperReview` is the single write path, shared by the public POST route
 * (auto-publish) and the legacy pending-edit approval path (draining any review
 * queued before this change). Both upsert the one-current-review-per-citation
 * row and append exactly one history revision.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb, isInPoolTransaction } from './db.js';
import {
  agents,
  approvals,
  paperReviewRevisions,
  paperReviews,
  pdfRequests,
  users,
} from '../../db/schema.js';
import {
  clearVerificationsForTarget,
  recordImplicitAgentApproval,
} from './agent-verifications.js';
import {
  findDrugsCitingCitation,
  lockDrugsCitingCitation,
  recomputeSummariesCitingCitation,
} from './parameter-entries-store.js';
import {
  tryLockDrugForRecompute,
  tryLockLateDrugsCitingCitation,
} from './citation-merge.js';

/**
 * A review write that would have had to wait for a drug lock while holding
 * rows a citation merge may be queued on, and so did not. Nothing is written —
 * the write's own changes are rolled back to its savepoint first — so the
 * caller's transaction is as it was; re-running the write records it.
 */
export class PaperReviewDrugLockedError extends Error {
  readonly statusHint = 409;
  readonly code = 'paper_review_drug_locked';

  constructor(
    readonly citationId: number,
    readonly drugId: number,
  ) {
    super(
      `paper review of citation ${citationId} not recorded: drug ${drugId}, whose ` +
        'parameter summaries the review recomputes, was locked by another write. Retry to record it.',
    );
    this.name = 'PaperReviewDrugLockedError';
  }
}

export interface PaperReviewInput {
  reviewMarkdown: string;
  overallScore: number | null;
  conclusionSupport: string | null;
  reviewConfidence: string | null;
  readInFull: boolean;
  /** Why this (re-)review was made. Null on the first review. */
  editSummary?: string | null;
}

export interface RecordedPaperReview {
  /** paper_reviews.id (stable across re-reviews — the upsert keeps the row). */
  id: number;
  citationId: number;
  /** The paper_review_revisions.id appended by this write. */
  revisionId: number;
}

/**
 * Auto-publish (or re-review) the review for a citation. Upserts the live
 * `paper_reviews` row, appends one `paper_review_revisions` history row, resets
 * peer signals against the now-changed content, re-stamps the author's implicit
 * approval, and — only for a read-in-full review — closes any open PDF request
 * for the citation.
 *
 * Uses `getDb()` throughout, so it participates in an ambient pool transaction
 * when the caller opened one (the approval path) and runs as plain sequential
 * writes otherwise (the public POST route, matching its prior behavior).
 */
export async function recordPaperReview(args: {
  citationId: number;
  authorUserId: number;
  input: PaperReviewInput;
  /**
   * How to take the drug locks the recompute needs, up front. `wait` (the
   * default) is right only for a caller whose transaction holds nothing yet —
   * the public POST route. A caller that already holds rows passes `try`: the
   * approval path holds the edit's `pending_edits` row, which a citation merge
   * holding a drug rewrites, so waiting for a drug there closes the cycle
   * #243 removed. A drug that stays held throws
   * {@link PaperReviewDrugLockedError} before anything is written.
   */
  drugLocks?: 'wait' | 'try';
}): Promise<RecordedPaperReview> {
  const db = getDb();
  const { citationId, authorUserId, input } = args;

  // Only the review SCORE feeds the aggregation weight. Capture it before the
  // upsert so a re-review that changes only prose / confidence / readInFull
  // doesn't trigger a no-op parameter recompute (which would append an
  // identical-value revision and drop the prior approval state).
  const [prior] = await db
    .select({ overallScore: paperReviews.overallScore })
    .from(paperReviews)
    .where(eq(paperReviews.citationId, citationId))
    .limit(1);
  const priorScore = prior?.overallScore ?? null;
  const recomputes = priorScore !== input.overallScore;

  // The recompute below locks every drug citing this paper. Take those locks
  // now, before the review row: a citation merge holds them (#243) while it
  // rewrites this row, so reaching them only after the upsert would wait on the
  // merge while holding the row it is waiting for.
  const lockedDrugs = new Set<number>();
  if (recomputes && args.drugLocks === 'try') {
    for (const drugId of await findDrugsCitingCitation(citationId)) {
      if (!(await tryLockDrugForRecompute(db, drugId))) {
        throw new PaperReviewDrugLockedError(citationId, drugId);
      }
      lockedDrugs.add(drugId);
    }
  } else if (recomputes) {
    for (const drugId of await lockDrugsCitingCitation(citationId)) lockedDrugs.add(drugId);
  }

  // Everything below runs under a savepoint when a recompute follows, so a
  // drug that turns out late and held (see the recompute) can undo it all.
  const atomic = recomputes && isInPoolTransaction();
  if (atomic) await db.execute(sql`SAVEPOINT paper_review_write`);
  try {
    const recorded = await writeReview(db, citationId, authorUserId, input);
    if (recomputes) {
      // The scan above covers entries that cited the paper when it ran. A
      // drug whose first such entry committed since is tried, never waited
      // for: this transaction now holds the review row, and a citation merge
      // that saw the new entry holds that drug and waits for the row.
      const heldDrugId = await tryLockLateDrugsCitingCitation(db, citationId, lockedDrugs);
      if (heldDrugId !== null) throw new PaperReviewDrugLockedError(citationId, heldDrugId);
      // Refresh the cached value for every summarizable parameter whose
      // entries cite this paper — but only when the score actually changed,
      // so a prose-only re-review doesn't churn revisions or reset approval
      // state.
      await recomputeSummariesCitingCitation(citationId, authorUserId);
    }
    if (atomic) await db.execute(sql`RELEASE SAVEPOINT paper_review_write`);
    return recorded;
  } catch (err) {
    if (atomic) {
      // The original error is the one worth surfacing; a rollback that fails
      // too leaves the transaction to the caller's own rollback.
      await db
        .execute(sql`ROLLBACK TO SAVEPOINT paper_review_write`)
        .then(() => db.execute(sql`RELEASE SAVEPOINT paper_review_write`))
        .catch(() => undefined);
    }
    throw err;
  }
}

/**
 * The review's own writes: the upserted row, its revision, the reset peer
 * signals and the PDF request it settles.
 */
async function writeReview(
  db: ReturnType<typeof getDb>,
  citationId: number,
  authorUserId: number,
  input: PaperReviewInput,
): Promise<RecordedPaperReview> {
  const [row] = await db
    .insert(paperReviews)
    .values({
      citationId,
      reviewMarkdown: input.reviewMarkdown,
      overallScore: input.overallScore,
      conclusionSupport: input.conclusionSupport,
      reviewConfidence: input.reviewConfidence,
      readInFull: input.readInFull,
      createdBy: authorUserId,
    })
    .onConflictDoUpdate({
      target: paperReviews.citationId,
      set: {
        reviewMarkdown: input.reviewMarkdown,
        overallScore: input.overallScore,
        conclusionSupport: input.conclusionSupport,
        reviewConfidence: input.reviewConfidence,
        readInFull: input.readInFull,
        createdBy: authorUserId,
        updatedAt: new Date(),
      },
    })
    .returning({ id: paperReviews.id });

  if (!row) throw new Error('paper_reviews upsert returned no row');

  // History row: WHAT changed lives in the self-contained snapshot; WHY lives
  // in editSummary.
  const [rev] = await db
    .insert(paperReviewRevisions)
    .values({
      paperReviewId: row.id,
      citationId,
      reviewMarkdown: input.reviewMarkdown,
      overallScore: input.overallScore,
      conclusionSupport: input.conclusionSupport,
      reviewConfidence: input.reviewConfidence,
      readInFull: input.readInFull,
      editSummary: input.editSummary ?? null,
      createdBy: authorUserId,
    })
    .returning({ id: paperReviewRevisions.id });

  // The review content just changed, so peer verdicts and endorsement stamps
  // tied to the prior content no longer apply — clear them, then re-stamp the
  // author's implicit approval so a fresh re-review round starts clean.
  await clearVerificationsForTarget({
    targetType: 'paper_review',
    targetId: row.id,
  });
  await db
    .delete(approvals)
    .where(
      and(
        eq(approvals.targetType, 'paper_review'),
        eq(approvals.targetId, row.id),
      ),
    );
  await recordImplicitAgentApproval({
    userId: authorUserId,
    targetType: 'paper_review',
    targetId: row.id,
  });

  // A read-in-full review means the paper was obtained, so any open PDF
  // request for this citation is moot. A `readInFull: false` review means the
  // opposite: the reviewer had an abstract, or withdrew an earlier attestation
  // — the full text is exactly what is still missing, so cancelling the request
  // retracts the one signal that would get it supplied. Before this guard the
  // cancel was unconditional, which quietly took such a paper out of the
  // request queue while every fact citing it stayed blocked by
  // `reference_not_judged`. Nothing reopens a request, so the paper then rested
  // entirely on the gap class in `listFullTextGaps` to stay visible at all.
  if (input.readInFull) {
    await db
      .update(pdfRequests)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(pdfRequests.citationId, citationId),
          eq(pdfRequests.status, 'open'),
        ),
      );
  }

  return { id: row.id, citationId, revisionId: rev?.id ?? 0 };
}

export interface PaperReviewRevisionView {
  id: number;
  reviewMarkdown: string;
  overallScore: number | null;
  conclusionSupport: string | null;
  reviewConfidence: string | null;
  readInFull: boolean;
  editSummary: string | null;
  createdAt: string;
  author: {
    id: number | null;
    username: string | null;
    displayName: string | null;
    role: string | null;
    isAgent: boolean;
  };
}

/**
 * Revision history for a citation's paper review, newest first. Public read
 * (mirrors drug-parameter-history): the author's email is never exposed.
 */
export async function listPaperReviewHistory(
  citationId: number,
  limit = 100,
): Promise<PaperReviewRevisionView[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: paperReviewRevisions.id,
      reviewMarkdown: paperReviewRevisions.reviewMarkdown,
      overallScore: paperReviewRevisions.overallScore,
      conclusionSupport: paperReviewRevisions.conclusionSupport,
      reviewConfidence: paperReviewRevisions.reviewConfidence,
      readInFull: paperReviewRevisions.readInFull,
      editSummary: paperReviewRevisions.editSummary,
      createdAt: paperReviewRevisions.createdAt,
      authorId: users.id,
      authorUsername: users.username,
      authorDisplayName: users.displayName,
      authorRole: users.role,
      isAgent: sql<boolean>`${agents.id} is not null`,
    })
    .from(paperReviewRevisions)
    .leftJoin(users, eq(paperReviewRevisions.createdBy, users.id))
    .leftJoin(agents, eq(agents.userId, users.id))
    .where(eq(paperReviewRevisions.citationId, citationId))
    .orderBy(desc(paperReviewRevisions.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    reviewMarkdown: r.reviewMarkdown,
    overallScore: r.overallScore,
    conclusionSupport: r.conclusionSupport,
    reviewConfidence: r.reviewConfidence,
    readInFull: r.readInFull,
    editSummary: r.editSummary,
    createdAt: r.createdAt.toISOString(),
    author: {
      id: r.authorId ?? null,
      username: r.authorUsername ?? null,
      displayName: r.authorDisplayName ?? null,
      role: r.authorRole ?? null,
      isAgent: Boolean(r.isAgent),
    },
  }));
}
