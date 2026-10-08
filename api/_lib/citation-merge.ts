import { and, eq, inArray, or, sql } from 'drizzle-orm';
import {
  bioEntityFunctions,
  citationPdfs,
  citations,
  drugEliminationRoutes,
  drugEnzymeInteractions,
  drugIonizationConstants,
  drugMetabolismProfiles,
  drugMetabolites,
  drugParameterRevisions,
  drugReceptorTargets,
  learningUnits,
  paperReviewRevisions,
  paperReviews,
  parameterEntries,
  patternReferenceAggregates,
  patternReferenceCases,
  patternReferenceCohorts,
  pdfInboxItems,
  pdfRequests,
  pendingEdits,
  wikiPages,
  wikiRevisions,
} from '../../db/schema.js';
import {
  mergeAltIds,
  rewriteCitationIdsInJson,
  type CitationAltIds,
} from '../../src/lib/citationHandles.js';
import { normalizeReferenceMetadata } from './reference-metadata.js';
import {
  isCitationWorkKind,
  mergeStoredClassifications,
  type CitationWorkKindVerdict,
} from '../../src/lib/citationWorkKind.js';
// The same check the drug writers use. Drizzle re-throws the driver's error
// as a `DrizzleQueryError` whose own message is "Failed query: …", so the
// SQLSTATE lives on `cause` — reading the top level answers "no" for every
// real violation, and this merge would have rethrown the race it means to
// absorb.
import { isUniqueViolation } from './drugs-helpers.js';
import { recomputeSummariesCitingCitation } from './parameter-entries-store.js';
import { isInPoolTransaction } from './db.js';
import type { getDb } from './db.js';

type Db = ReturnType<typeof getDb>;

/**
 * Serialize merges that converge on one surviving citation.
 *
 * Two `resolveCitation` calls folding two populated losers into the same empty
 * winner both read the destination as empty — their preflights and their
 * statement snapshots alike — and their writes touch disjoint rows, so nothing
 * makes them collide. Both moves succeed and two independent transcriptions
 * end up under one admission: exactly what the group preflight refuses when
 * the same work arrives sequentially. A snapshot cannot see a row that did not
 * exist when it was taken, and no guard written inside one statement closes
 * that.
 *
 * What does is the pattern `parameterApplicabilityStore` already uses for
 * check-then-write: a transaction-scoped advisory lock, keyed on the thing two
 * callers contend for — here the surviving citation, which is what they share
 * by definition.
 *
 * **Taken only inside a transaction, and not pretended otherwise.** On the
 * auto-commit client the lock releases the moment its own `SELECT` returns and
 * serializes nothing; that store's comment calls a lock that quietly
 * serializes nothing "how the first attempt at this failed review", and this
 * file has already made that mistake once with `FOR UPDATE`. Both callers that
 * merge — `resolveCitation` and the backfill CLI — open one around their merge
 * group for exactly this reason. The CLI needs it as much as the request path
 * does: it runs against a live deployment, so the fold racing it comes from a
 * request rather than from a second run of itself.
 *
 * A caller may also find the pair already merged, by this lock's holder or by
 * anyone else. That is handled below as the no-op it is rather than as an
 * error: failing there would fail a submission *because* serialization worked.
 */
const CITATION_MERGE_LOCK_NAMESPACE = 1087;

/**
 * Retried briefly, never waited on. `commitSources` resolves every source of
 * one bundle inside a single transaction, so a caller holds each winner's lock
 * until that whole loop commits — and two ingestions whose bundles name the
 * same two split papers in opposite order would each wait for a lock the other
 * holds. Postgres breaks that by killing one, which fails an ingestion that had
 * nothing wrong with it. A try that never blocks registers no wait, so no
 * wait-for cycle can form on this lock at all.
 *
 * The retries are what make that affordable rather than defeatist. The holder
 * is usually a request finishing its own merge group in milliseconds, and it
 * is folding *its* loser — not this one. So standing aside on the first refusal
 * would leave this pair split on the strength of an unrelated fold, and a split
 * pair is the whole defect this module exists to prevent: two reviews of one
 * paper, admissible under one handle and not the other.
 *
 * A few short attempts, then defer — bounded so two callers polling for each
 * other's locks both give up rather than livelocking. Deferring is safe in the
 * narrow sense that nothing is lost: the resolution returned is unaffected, and
 * the pair is folded by the next write declaring its handle or by
 * `merge:split-citations`. It is not silent, because "safe" and "fine" are not
 * the same thing — `deferred` reaches the CLI's own count and
 * `resolveCitation`'s result, and a warning names the pair that was left.
 */
const MERGE_LOCK_ATTEMPTS = 4;
const MERGE_LOCK_BACKOFF_MS = 40;

async function tryLockMergeWinner(db: Db, winnerId: number): Promise<boolean> {
  if (!isInPoolTransaction()) return true;
  for (let attempt = 0; ; attempt += 1) {
    const result = await db.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${CITATION_MERGE_LOCK_NAMESPACE}::int, ${winnerId}::int) AS locked`,
    );
    if ((result.rows[0] as { locked?: boolean } | undefined)?.locked === true) return true;
    if (attempt + 1 >= MERGE_LOCK_ATTEMPTS) return false;
    await new Promise((resolve) => {
      setTimeout(resolve, MERGE_LOCK_BACKOFF_MS * (attempt + 1));
    });
  }
}

/**
 * Fold one citation row into another (#1018): everything that pointed at
 * `loserId` is repointed at `winnerId`, the loser's handle is preserved as an
 * alt id on the winner, and the loser row is deleted.
 *
 * The two rows are the same paper under two handles, so this is not a data
 * merge in the usual sense — there is nothing to reconcile except the review.
 * `paper_reviews` is unique on `citation_id`, so a split pair can carry two
 * live reviews; {@link chooseSurvivingReview} picks one and the other's
 * revision history is re-parented onto it rather than dropped, since it IS
 * review history of this paper.
 */

/** Tables whose `reference_ids` integer array can name a citation. */
const REFERENCE_ID_ARRAY_TABLES = [
  bioEntityFunctions,
  drugMetabolismProfiles,
  drugEliminationRoutes,
  drugMetabolites,
  drugReceptorTargets,
  drugEnzymeInteractions,
  drugIonizationConstants,
  drugParameterRevisions,
  pendingEdits,
] as const;

/**
 * A merge refused because two of the citations carry admissions of one
 * reference dataset that cannot be folded together. Its own class so the admin
 * route can answer with a 409 the operator can act on rather than a 500.
 */
export class CitationCohortConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CitationCohortConflictError';
  }
}

export interface CitationMergeStats {
  winnerId: number;
  loserId: number;
  reviewsDropped: number;
  reviewRevisionsMoved: number;
  rowsRepointed: number;
  jsonDocumentsRewritten: number;
  /**
   * What happened to the cached parameter summaries this merge invalidates.
   * `skipped` means a recompute was warranted but no actor was supplied to
   * attribute the resulting revisions to — surfaced rather than swallowed, so a
   * caller cannot leave stale values behind without it showing up.
   */
  summaryRecompute: 'ran' | 'skipped' | 'not-needed';
  /**
   * True when another merge into this same winner was already running and this
   * one stood aside. Nothing was folded; the holder does it, or the next write
   * declaring the handle, or `merge:split-citations`.
   */
  deferred?: boolean;
}

/**
 * Which of two reviews of the same paper survives. `read_in_full` wins outright
 * — it is the attestation that gates whether the paper may back a fact or a
 * parameter, and losing it would silently make every citing claim inadmissible.
 * Between two reviews of equal standing the newest wins, because a re-review
 * supersedes.
 */
export function chooseSurvivingReview<
  T extends { id: number; readInFull: boolean; updatedAt: Date | null },
>(a: T, b: T): { winner: T; loser: T } {
  if (a.readInFull !== b.readInFull) {
    return a.readInFull ? { winner: a, loser: b } : { winner: b, loser: a };
  }
  const aTime = a.updatedAt?.getTime() ?? 0;
  const bTime = b.updatedAt?.getTime() ?? 0;
  if (aTime !== bTime) {
    return aTime > bTime ? { winner: a, loser: b } : { winner: b, loser: a };
  }
  // Deterministic tie-break so a dry-run plan and the apply run agree.
  return a.id >= b.id ? { winner: a, loser: b } : { winner: b, loser: a };
}

/** Repoint `reference_ids` arrays, de-duplicating where both ids were listed. */
async function repointReferenceIdArrays(
  db: Db,
  winnerId: number,
  loserId: number,
): Promise<number> {
  let touched = 0;
  for (const table of REFERENCE_ID_ARRAY_TABLES) {
    // A plain `array_replace` would leave `{7,7}` when a row already cited both
    // handles, which renders as two markers for one paper. Dedupe by first
    // occurrence rather than sorting: reference order is authored, and it
    // decides the [1][2] numbering.
    //
    // Written as a correlated sub-select instead of an UPDATE … FROM join
    // because not every table here has an `id` column to join on
    // (`drug_metabolism_profiles` is keyed by `drug_id`).
    const result = await db.execute<{ merged: number }>(sql`
      UPDATE ${table}
      SET reference_ids = (
        SELECT array_agg(v ORDER BY ord)
        FROM (
          SELECT u.v AS v, min(u.ord) AS ord
          FROM unnest(
            array_replace(${table}.reference_ids, ${loserId}, ${winnerId})
          ) WITH ORDINALITY AS u(v, ord)
          GROUP BY u.v
        ) deduped
      )
      WHERE ${loserId} = ANY(${table}.reference_ids)
      RETURNING 1 AS merged
    `);
    touched += result.rows?.length ?? 0;
  }
  return touched;
}

/** Rewrite citation ids embedded in stored JSON documents. */
async function rewriteJsonDocuments(
  db: Db,
  winnerId: number,
  loserId: number,
): Promise<number> {
  let rewritten = 0;

  const pages = await db
    .select({ id: wikiPages.id, content: wikiPages.content })
    .from(wikiPages)
    .where(sql`${wikiPages.content}::text LIKE ${`%${loserId}%`}`);
  for (const page of pages) {
    const { value, changed } = rewriteCitationIdsInJson(
      page.content,
      loserId,
      winnerId,
    );
    if (!changed) continue;
    await db
      .update(wikiPages)
      .set({ content: value })
      .where(eq(wikiPages.id, page.id));
    rewritten += 1;
  }

  // Revision snapshots too: the loser row is deleted, so a marker left pointing
  // at it renders as a broken reference in the page history.
  const revisions = await db
    .select({ id: wikiRevisions.id, content: wikiRevisions.content })
    .from(wikiRevisions)
    .where(sql`${wikiRevisions.content}::text LIKE ${`%${loserId}%`}`);
  for (const revision of revisions) {
    const { value, changed } = rewriteCitationIdsInJson(
      revision.content,
      loserId,
      winnerId,
    );
    if (!changed) continue;
    await db
      .update(wikiRevisions)
      .set({ content: value })
      .where(eq(wikiRevisions.id, revision.id));
    rewritten += 1;
  }

  // A queued edit's payload carries its own referenceIds and is re-validated
  // against the citation gate at approval time, so a dangling id there would
  // reject the edit long after the merge.
  const queued = await db
    .select({
      id: pendingEdits.id,
      proposedValue: pendingEdits.proposedValue,
    })
    .from(pendingEdits)
    .where(sql`${pendingEdits.proposedValue}::text LIKE ${`%${loserId}%`}`);
  for (const edit of queued) {
    const { value, changed } = rewriteCitationIdsInJson(
      edit.proposedValue,
      loserId,
      winnerId,
    );
    if (!changed) continue;
    await db
      .update(pendingEdits)
      .set({ proposedValue: value })
      .where(eq(pendingEdits.id, edit.id));
    rewritten += 1;
  }

  // A conversation-ingestion fact names the papers nobody has read in full in
  // `proposedMeta.unverifiedReferenceIds`, and consensus holds it until each
  // has a read-in-full review (`pendingEditCitesUnreadSources`). Left on the
  // loser, that lookup would query a deleted citation forever, so a review of
  // the surviving paper could never release the fact.
  //
  // One statement, touching only that key: the row's other metadata is not
  // this merge's to write, and a whole-object copy read beforehand could
  // overwrite a marker written meanwhile (a reviewer's `returnedAt`, a
  // `conflict`). The UPDATE reads the row it writes.
  const marked = await db
    .update(pendingEdits)
    .set({
      proposedMeta: sql`jsonb_set(
        ${pendingEdits.proposedMeta},
        '{unverifiedReferenceIds}',
        (
          select coalesce(jsonb_agg(m.v order by m.first), '[]'::jsonb)
          from (
            select
              case when e.v = to_jsonb(${winnerId}::int) or e.v = to_jsonb(${loserId}::int)
                then to_jsonb(${winnerId}::int) else e.v end as v,
              min(e.ord) as first
            from jsonb_array_elements(${pendingEdits.proposedMeta} -> 'unverifiedReferenceIds')
              with ordinality as e(v, ord)
            group by 1
          ) as m
        )
      )`,
    })
    .where(
      sql`${pendingEdits.proposedMeta}->'unverifiedReferenceIds' @> ${JSON.stringify([loserId])}::jsonb`,
    )
    .returning({ id: pendingEdits.id });
  rewritten += marked.length;

  return rewritten;
}

/**
 * Lock the proposals that cite `citationId` (other than queued paper reviews),
 * in id order, before the merge touches any review row. Whatever their status:
 * a draft or returned proposal can be resubmitted as pending mid-merge, and
 * consensus could then take it before the merge reaches it.
 *
 * Agent consensus publishing an ingested fact holds the fact's row and then
 * takes its cited papers' review rows FOR SHARE (`lockPendingEditSourceReviews`):
 * proposal first, review evidence second. Inside a transaction (the
 * `resolveCitation` fold), the merge would otherwise update the loser's
 * `paper_reviews` row first and only then reach the proposals citing it — the
 * reverse order, which PostgreSQL resolves by aborting one of the two as a
 * deadlock. Taking the proposals up front gives both paths one order. Without
 * a transaction (the CLI over http) each statement commits on its own and this
 * is a no-op. Returns the locked ids.
 */
export async function lockPendingEditsCitingCitation(
  db: Db,
  citationId: number,
): Promise<number[]> {
  const result = await db.execute<{ id: number }>(sql`
    SELECT id FROM pending_edits
    WHERE edit_type <> 'paper_review'
      AND (
        reference_id = ${citationId}
        OR ${citationId} = ANY(reference_ids)
        OR proposed_value -> 'attrs' -> 'referenceIds' @> ${JSON.stringify([citationId])}::jsonb
        OR proposed_meta -> 'unverifiedReferenceIds' @> ${JSON.stringify([citationId])}::jsonb
      )
    ORDER BY id
    FOR NO KEY UPDATE
  `);
  return (result.rows ?? []).map((row) => Number(row.id));
}

/**
 * Move the loser's paper review onto the winner, or drop it when the winner
 * already has one. Revisions follow the surviving review either way.
 *
 * `winnerReviewChanged` reports whether the winner ends up under a DIFFERENT
 * review than it started with. That drives the summary recompute: a review's
 * `overall_score` is a weight in source-weighted aggregation, so swapping the
 * review behind a citation moves every cached parameter value citing it.
 */
async function mergePaperReviews(
  db: Db,
  winnerId: number,
  loserId: number,
): Promise<{
  dropped: number;
  revisionsMoved: number;
  winnerReviewChanged: boolean;
}> {
  const reviews = await db
    .select({
      id: paperReviews.id,
      citationId: paperReviews.citationId,
      readInFull: paperReviews.readInFull,
      updatedAt: paperReviews.updatedAt,
    })
    .from(paperReviews)
    .where(inArray(paperReviews.citationId, [winnerId, loserId]));

  const winnerReview = reviews.find((r) => r.citationId === winnerId);
  const loserReview = reviews.find((r) => r.citationId === loserId);

  // Revision history is history of this paper regardless of which row it was
  // filed under, so it is re-parented before any review row disappears.
  let revisionsMoved = 0;
  let dropped = 0;

  if (!loserReview) {
    const moved = await db
      .update(paperReviewRevisions)
      .set({ citationId: winnerId })
      .where(eq(paperReviewRevisions.citationId, loserId))
      .returning({ id: paperReviewRevisions.id });
    // The winner keeps the review it already had (or its lack of one).
    return { dropped: 0, revisionsMoved: moved.length, winnerReviewChanged: false };
  }

  if (!winnerReview) {
    await db
      .update(paperReviews)
      .set({ citationId: winnerId })
      .where(eq(paperReviews.id, loserReview.id));
    const moved = await db
      .update(paperReviewRevisions)
      .set({ citationId: winnerId })
      .where(eq(paperReviewRevisions.citationId, loserId))
      .returning({ id: paperReviewRevisions.id });
    // The winner had no review and now carries the loser's.
    return { dropped: 0, revisionsMoved: moved.length, winnerReviewChanged: true };
  }

  const { winner, loser } = chooseSurvivingReview(winnerReview, loserReview);
  // Both arms are needed, and the second is the one that is easy to miss.
  //
  // `paper_review_revisions.paper_review_id` is ON DELETE CASCADE, so retiring
  // a review takes its history with it. When the LOSER row's review is the one
  // kept — `read_in_full` beating an abstract-only review on the winner row —
  // the review about to be deleted is the WINNER citation's, and its revisions
  // carry `citationId = winnerId`. A citation-scoped move would therefore skip
  // exactly the rows the cascade is about to destroy, silently dropping the
  // history of a review that lost on standing but is still history of this
  // paper. Matching on the retired review's id as well catches them.
  const moved = await db
    .update(paperReviewRevisions)
    .set({ citationId: winnerId, paperReviewId: winner.id })
    .where(
      or(
        eq(paperReviewRevisions.citationId, loserId),
        eq(paperReviewRevisions.paperReviewId, loser.id),
      ),
    )
    .returning({ id: paperReviewRevisions.id });
  revisionsMoved = moved.length;

  if (winner.id !== winnerReview.id) {
    // The loser row's review is the one to keep: retire the winner row's review
    // first so the unique index on citation_id has room.
    await db.delete(paperReviews).where(eq(paperReviews.id, loser.id));
    await db
      .update(paperReviews)
      .set({ citationId: winnerId })
      .where(eq(paperReviews.id, winner.id));
  } else {
    await db.delete(paperReviews).where(eq(paperReviews.id, loser.id));
  }
  dropped = 1;

  return {
    dropped,
    revisionsMoved,
    winnerReviewChanged: winner.id !== winnerReview.id,
  };
}

/**
 * Repoint a one-row-per-citation side table, keeping the winner's row when both
 * sides have one (the unique index leaves no other option).
 */
async function repointUniquePerCitation(
  db: Db,
  table: typeof pdfRequests | typeof citationPdfs,
  winnerId: number,
  loserId: number,
): Promise<number> {
  const existing = await db
    .select({ id: table.id })
    .from(table)
    .where(eq(table.citationId, winnerId))
    .limit(1);
  if (existing.length > 0) {
    // The loser's row is redundant: same paper, and the winner already carries
    // the asset/request. It goes away with the citation row's ON DELETE CASCADE.
    return 0;
  }
  const moved = await db
    .update(table)
    .set({ citationId: winnerId })
    .where(eq(table.citationId, loserId))
    .returning({ id: table.id });
  return moved.length;
}

/**
 * Repoint the bulk PDF inbox at the surviving citation.
 *
 * `pdf_inbox_items.matched_citation_id` is `ON DELETE SET NULL`, so leaving it
 * behind does not fail the merge — it quietly empties. Two things break when
 * it does. An **attached** row is the audit record of how a paper's full text
 * came to be linked, and null there means it no longer says which paper. A
 * **pending** row stops being reported by `citationsWithPendingInboxItems`, so
 * the PDF-request queue goes back to telling a contributor the full text is
 * missing while a copy sits unlinked in the inbox — the exact wasted trip the
 * inbox exists to prevent.
 *
 * The stored `candidates` snapshot is rewritten in the same pass. It is
 * recomputed on demand and the listing hydrates citations fresh, so a stale id
 * renders as a bare number rather than a title — but it is also what the
 * "Link" buttons are built from, and clicking one for a citation that no
 * longer exists is a refusal a reader cannot act on.
 *
 * Unlike `pdf_requests` and `citation_pdfs` there is no per-citation unique
 * index here: many files can point at one paper, so every row moves rather
 * than the loser's being dropped as redundant.
 */
async function repointInboxItems(
  db: Db,
  winnerId: number,
  loserId: number,
): Promise<number> {
  const moved = await db
    .update(pdfInboxItems)
    .set({ matchedCitationId: winnerId })
    .where(eq(pdfInboxItems.matchedCitationId, loserId))
    .returning({ id: pdfInboxItems.id });

  // The candidate list is jsonb, so the rewrite happens in SQL rather than by
  // reading every row back out. Only rows that actually name the loser are
  // touched.
  const rewritten = (await db.execute<{ id: number }>(sql`
    update pdf_inbox_items
    set candidates = (
      select jsonb_agg(
        case
          when (candidate ->> 'citationId')::int = ${loserId}
            then jsonb_set(candidate, '{citationId}', to_jsonb(${winnerId}::int))
          else candidate
        end
      )
      from jsonb_array_elements(candidates) as candidate
    )
    where jsonb_typeof(candidates) = 'array'
      and candidates @> ${JSON.stringify([{ citationId: loserId }])}::jsonb
    returning id
  `)) as { rows?: Array<{ id: number }> } | Array<{ id: number }>;
  const rewrittenRows = Array.isArray(rewritten) ? rewritten : (rewritten.rows ?? []);

  // A row can be in both sets; count the union so the merge's reported total
  // is a row count rather than a write count.
  const touched = new Set<number>([
    ...moved.map((row) => row.id),
    ...rewrittenRows.map((row) => Number(row.id)),
  ]);
  return touched.size;
}

type ReferenceCohortRow = typeof patternReferenceCohorts.$inferSelect;

/**
 * Refuse a merge that would fold away an admitted dataset URL — **before**
 * anything is written.
 *
 * Two cohorts of one dataset admitted from different URLs are two verification
 * baselines: an import accepts only what its own cohort records, so folding one
 * away narrows what the atlas will take, and the survivor is whichever citation
 * won on handle rank. The immutability trigger makes it unrepairable
 * afterwards, so this refuses rather than choosing.
 *
 * *Any* distinct pair, including null against a URL. A no-URL admission
 * replaced by one carrying a URL gains a baseline it never had; the other way
 * round loses the only machine-readable one. Both are changes to what a future
 * import will accept, and neither is a merge's business.
 *
 * Checked here rather than where the fold happens because the CLI runs without
 * a transaction: a throw halfway through has already moved reviews, scalar
 * consumers and PDFs, so a merge reported as refused would in fact be half
 * applied — and declining to re-admit the cohort would not put the citations
 * back.
 *
 * **Takes the whole group, not a pair.** A paper split across three handles is
 * merged one loser at a time, by both callers — the CLI's loop and
 * `resolveCitation`. A pair-at-a-time check passes on the first loser when the
 * winner carries no cohort yet, commits it, and only then meets the second
 * loser's conflicting baseline: the operation fails overall with one citation
 * already merged, which is the half-applied merge this exists to prevent, one
 * step further out. Every member of the group is compared against every other
 * before the first of them moves.
 */
export async function assertNoConflictingCohortBaselines(
  db: Db,
  citationIds: readonly number[],
): Promise<void> {
  const ids = [...new Set(citationIds)];
  if (ids.length < 2) return;

  const cohorts = await db
    .select()
    .from(patternReferenceCohorts)
    .where(inArray(patternReferenceCohorts.citationId, ids));

  // Grouped by dataset identity across the whole group rather than by which
  // citation happens to hold the row: after the merges they are all one
  // citation's cohorts, so which pair collides depends on nothing the check
  // should care about.
  const byIdentity = new Map<string, ReferenceCohortRow[]>();
  for (const cohort of cohorts) {
    const key = cohortIdentityKey(cohort);
    const group = byIdentity.get(key);
    if (group) group.push(cohort);
    else byIdentity.set(key, [cohort]);
  }
  const colliding = [...byIdentity.values()].filter((group) => group.length > 1);
  if (colliding.length === 0) return;

  // Every member against every other, rather than each against the first one
  // seen. Three handles for one dataset fold two rows into one, and anchoring
  // on the first hides a conflict between the second and the third: an empty
  // first row would make two independent transcriptions look like two
  // one-sided moves, the group would pass, and the second merge would refuse
  // with the first already applied — the half-applied group this preflight
  // exists to prevent.
  const populated = await cohortsCarryingAtlasRows(
    db,
    colliding.flatMap((group) => group.map((cohort) => cohort.id)),
  );
  for (const group of colliding) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        assertFoldable(group[i]!, group[j]!);
        assertFoldableAtlas(group[i]!, group[j]!, populated);
      }
    }
  }
}

/**
 * Which of these cohorts have atlas rows imported under them.
 *
 * Cases and aggregates only. Specimens, exposures and observations hang off a
 * case and cascade with it, so a cohort with no cases has none of them either.
 */
async function cohortsCarryingAtlasRows(
  db: Db,
  cohortIds: readonly number[],
): Promise<Set<number>> {
  const ids = [...new Set(cohortIds)];
  if (ids.length === 0) return new Set();
  const [cases, aggregates] = await Promise.all([
    db
      .selectDistinct({ cohortId: patternReferenceCases.cohortId })
      .from(patternReferenceCases)
      .where(inArray(patternReferenceCases.cohortId, ids)),
    db
      .selectDistinct({ cohortId: patternReferenceAggregates.cohortId })
      .from(patternReferenceAggregates)
      .where(inArray(patternReferenceAggregates.cohortId, ids)),
  ]);
  return new Set([...cases, ...aggregates].map((row) => row.cohortId));
}

/**
 * Refuse to fold two cohorts that have both been imported.
 *
 * The fold deletes the redundant row, and §18.2's chain cascades from it, so
 * the cases, specimens, observations and aggregates under it go too. What
 * licensed deleting the row at all was that the identity tuple is equality of
 * dataset and the survivor carries the same points — which is true of the
 * *admission* and says nothing about whether anyone imported it. Two cohorts
 * of one dataset can hold two independent transcriptions, and there is no
 * reading of a citation merge that decides which transcription the atlas
 * keeps.
 *
 * One side populated is not the same question. Those rows are the only copy,
 * and the surviving admission is the same dataset by identity, so they move
 * rather than being deleted or refused — see `moveAtlasRows`.
 */
function assertFoldableAtlas(
  kept: ReferenceCohortRow,
  folded: ReferenceCohortRow,
  populated: ReadonlySet<number>,
): void {
  if (!populated.has(kept.id) || !populated.has(folded.id)) return;
  throw new CitationCohortConflictError(
    `Citation merge would fold reference cohort ${folded.id} into ${kept.id}, but both have ` +
      `reference cases or aggregates imported under them. Folding deletes one transcription ` +
      `of the dataset and a merge cannot choose between them — withdraw the admission that ` +
      `should not stand (§34.3), then merge again.`,
  );
}

/**
 * Refuse to fold `folded` into `kept` when their dataset URLs differ.
 *
 * Called from the preflight above *and* immediately before the fold itself.
 * The preflight reads once, and a concurrent merge can change what it read: two
 * `resolveCitation` calls repointing two losers of one paper into a
 * cohort-less winner each pass their own preflight, and the one that loses the
 * repoint race then folds into a row its preflight never saw. Checking only up
 * front would let that fold drop a baseline — so the check lives with the
 * delete, where the loss would happen, and the preflight is what turns it from
 * a late failure into an early one.
 */
function assertFoldable(kept: ReferenceCohortRow, folded: ReferenceCohortRow): void {
  if (kept.sourceDatasetUrl === folded.sourceDatasetUrl) return;
  throw new CitationCohortConflictError(
    `Citation merge would fold reference cohort ${folded.id} into ${kept.id}, but they were ` +
      `admitted from different dataset URLs (${kept.sourceDatasetUrl ?? 'none'} and ` +
      `${folded.sourceDatasetUrl ?? 'none'}). Both are import-verification baselines, so one ` +
      `cannot be dropped by a merge — re-admit the dataset (§34.3) and merge again.`,
  );
}

/** The five columns §16.5 makes a cohort's identity. */
function cohortIdentityKey(row: ReferenceCohortRow): string {
  return [
    row.sourceDatasetHash,
    row.transformationVersion,
    row.importerVersion,
    row.subgroupKey,
  ].join('\u0000');
}

/**
 * Where two cohorts of one dataset disagree about how they were described.
 *
 * Only the fields that bear on how a band is matched or read — the audit
 * columns and timestamps differ by construction and saying so would bury the
 * answer in noise.
 */
function describeCohortDifferences(
  kept: ReferenceCohortRow,
  folded: ReferenceCohortRow,
): string[] {
  const fields = [
    'name',
    'cohortType',
    'design',
    'evidenceTier',
    'populationNote',
    'analyticalNote',
    'timeOrigin',
    'sourceDatasetUrl',
    'version',
  ] as const;
  return fields.flatMap((field) =>
    kept[field] === folded[field]
      ? []
      : [`${field} (kept ${JSON.stringify(kept[field])}, folded ${JSON.stringify(folded[field])})`],
  );
}

/**
 * Repoint admitted reference cohorts (spec §18.1).
 *
 * `pattern_reference_cohorts.citation_id` is `NOT NULL` and `ON DELETE
 * RESTRICT`, so leaving it out of this list does not fail quietly: an ordinary
 * DOI→PMID merge would fail on the foreign key when the loser row is deleted.
 * A cascading key instead of a restrictive one would be worse — it would delete
 * an admitted cohort and every reference case and observation hanging off it,
 * which is atlas data a named admin took responsibility for.
 *
 * The merge can also collide two cohorts onto one identity tuple: the same
 * dataset admitted twice under two handles for one paper, which is exactly what
 * a merge says those handles were. Reconciled by deleting the redundant row
 * rather than by letting the unique index reject the merge — and deleted rather
 * than left in place, because the foreign key is RESTRICT: a row still pointing
 * at the loser blocks the citation delete and fails the merge just as loudly.
 *
 * What licenses deleting atlas data at all is that the identity tuple is
 * equality of *dataset*, not of description: same hash, same importer version,
 * same transformation version, same subgroup. The two rows are one admission
 * recorded twice, and the winner's copy carries the same points.
 *
 * Which of the two branches a cohort takes is read once and then confirmed by
 * the write: a repoint rejected by the identity index means another merge
 * placed that identity under the winner in between, so the fold is what this
 * pair should have done and it does it. Nothing here holds a lock or a
 * snapshot — the http driver offers neither — so the alternative is a merge
 * that fails after moving reviews and consumers.
 */
async function repointReferenceCohorts(
  db: Db,
  winnerId: number,
  loserId: number,
): Promise<number> {
  const losing = await db
    .select()
    .from(patternReferenceCohorts)
    .where(eq(patternReferenceCohorts.citationId, loserId));
  if (losing.length === 0) return 0;

  const winning = await db
    .select()
    .from(patternReferenceCohorts)
    .where(eq(patternReferenceCohorts.citationId, winnerId));
  const taken = new Map(winning.map((row) => [cohortIdentityKey(row), row]));

  let moved = 0;
  for (const cohort of losing) {
    const key = cohortIdentityKey(cohort);
    let kept = taken.get(key);
    if (!kept) {
      try {
        await db
          .update(patternReferenceCohorts)
          .set({ citationId: winnerId })
          .where(eq(patternReferenceCohorts.id, cohort.id));
        taken.set(key, cohort);
        moved += 1;
        continue;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Another merge placed this identity under the winner between the read
        // above and this write. `resolveCitation` runs from ordinary
        // serverless requests, so two of them folding two losers of one paper
        // into a winner that carried no cohort both find nothing taken — and
        // there is no transaction here to have held a snapshot, nor a lock to
        // serialize on over the http driver. Letting the index rejection
        // escape would fail a merge that had already moved reviews and
        // consumers, which is the half-applied merge the preflight exists to
        // prevent, arriving from the other direction.
        //
        // What the rejection *means* is that the collision case below is now
        // the true one, so this re-reads and takes it: the row the other merge
        // repointed is the same admission by identity, and folding into it is
        // what this pair would have done had it read a moment later.
        kept = await readCohortByIdentity(db, winnerId, cohort);
        // Not this index, then. A violation with no matching row under the
        // winner is not the race, and swallowing it would hide it.
        if (!kept) throw err;
        taken.set(key, kept);
      }
    }
    {
      // Against the row this is actually about to fold into, which the
      // preflight cannot have seen if another merge put it there. Nothing has
      // been destroyed for this cohort yet — the repoint was rejected, not
      // applied — so the refusal still leaves both admissions on disk.
      assertFoldable(kept, cohort);
      // And the atlas rows under both, for the same reason: the fold below
      // deletes the redundant row and §18.2's chain cascades from it.
      const populated = await cohortsCarryingAtlasRows(db, [kept.id, cohort.id]);
      assertFoldableAtlas(kept, cohort, populated);
      // One side populated moves rather than being deleted. The rows are the
      // only transcription of a dataset the surviving admission is identical
      // to, so the answer is not ambiguous — and the fold statement below
      // refuses to delete a cohort that still has any, which is what keeps a
      // move that failed halfway from becoming a cascade.
      // Identity equality is equality of *dataset*, not of description: the
      // two rows can disagree about cohort type, time origin, evidence tier or
      // the prose around them, and the surviving row is whichever citation won
      // on handle rank — nothing to do with which cohort was better recorded.
      // So what the merge folds away is written down on the survivor before the
      // duplicate goes, in the field that exists for a human to read.
      // Written unconditionally, not only where the descriptions differ. The
      // folded row's own notes are the one field no comparison can summarise —
      // they are prose somebody wrote about this admission — so silence here
      // would delete the only copy of them, and a fold that left no trace at
      // all would be indistinguishable from a cohort that was never admitted.
      const differences = describeCohortDifferences(kept, cohort);
      // The trailing text matters: `cohort 12` is a prefix of `cohort 123`, so
      // a bare id would read one cohort's record as another's and skip the
      // audit line for a fold that really happened.
      const marker = `Citation merge folded cohort ${cohort.id} (`;
      // Everything the snapshot can answer. The folded row's own notes are
      // not on this list — they are read by the statement below, from the row
      // itself, at the moment it writes.
      const preamble = [
        `${marker}same dataset identity) and kept this row.`,
        // Who admitted the row that is about to be deleted, and when. Left out
        // of `describeCohortDifferences` because two admissions of one dataset
        // differ there by construction and listing it would bury the fields
        // that bear on how a band is read — but the deleted row is the only
        // record that this admin admitted this dataset at all, so the fold has
        // to carry it or invariant 31 stops being auditable for that
        // admission. Stated unconditionally: "the same admin, twice" is itself
        // the answer to the question somebody reading this will be asking.
        `It was admitted by user ${cohort.authorizedBy} at ` +
          `${cohort.authorizedAt?.toISOString() ?? 'an unrecorded time'}.`,
        differences.length > 0
          ? `The folded row differed in: ${differences.join('; ')}.`
          : 'The folded row described the admission identically.',
      ]
        .filter(Boolean)
        .join(' ');
      // One statement: the atlas rows move, the record is written, and the row
      // it is about is deleted — one commit boundary for all three.
      //
      // The moves were a separate statement until a review pointed out what
      // that costs: they committed, and then the fold could still refuse, so a
      // merge reported as failed had already relocated a study's cases. Worse,
      // a concurrent withdrawal of the survivor could cascade over rows that
      // had just moved onto it while the admission they came from was still
      // there.
      //
      // The moves are guarded on the destination being empty and the delete on
      // the moves having taken everything, by id — their effects are not in
      // this statement's snapshot, so the leftovers are excluded rather than
      // re-read.
      //
      // **No explicit lock.** An earlier version opened with a `FOR UPDATE`
      // over both cohorts, on the reasoning that an inserting importer takes
      // `FOR KEY SHARE` on its cohort and the two conflict. Combined with the
      // data-modifying CTEs below, that locking scan returns fewer rows than
      // it selects — measured, not assumed — so gating on it silently stopped
      // the fold. A lock that does not survive the statement it is written in
      // is worse than none, because the comment beside it keeps promising.
      //
      // Four properties have to hold together, and only together.
      //
      // The record must carry the folded row's notes *as they are when the row
      // goes*. They are the one field another merge can still be writing —
      // folding a third cohort into this one appends to exactly this column —
      // and reading them a statement earlier means copying the old prose
      // onward and then deleting the row holding the new. Even a read inside a
      // separate write is a statement earlier: a commit landing after that
      // statement's snapshot is invisible to it, and the delete that follows
      // takes the row anyway, newer record and all.
      //
      // So the delete is guarded on the notes it recorded. If another merge
      // appended between the snapshot and the delete, the guard fails against
      // the updated row — Postgres re-checks it there — and the row survives
      // with its record intact. Nothing is lost; the merge stops and says so.
      //
      // And it must be repeatable, because the http driver has no transaction
      // and a lost response leaves a retry to find the same pair. The guard is
      // the whole record rather than a marker for the cohort: a retry composes
      // the same text, finds it already there, appends nothing and deletes.
      // Where the notes did change, the text differs, so the retry records the
      // newer prose beside the older rather than deleting a row whose current
      // state was never written down.
      const folded = await db.execute(sql`
        WITH destination_empty AS (
          SELECT
            NOT EXISTS (
              SELECT 1 FROM pattern_reference_cases WHERE cohort_id = ${kept.id}
            ) AND NOT EXISTS (
              SELECT 1 FROM pattern_reference_aggregates WHERE cohort_id = ${kept.id}
            ) AS ok
        ),
        moved_cases AS (
          UPDATE pattern_reference_cases
          SET cohort_id = ${kept.id}
          WHERE cohort_id = ${cohort.id}
            AND (SELECT ok FROM destination_empty)
          RETURNING id
        ),
        moved_aggregates AS (
          UPDATE pattern_reference_aggregates
          SET cohort_id = ${kept.id}
          WHERE cohort_id = ${cohort.id}
            AND (SELECT ok FROM destination_empty)
          RETURNING id
        ),
        candidate AS (
          SELECT
            id,
            transformation_notes AS notes,
            ${preamble}::text || CASE
              WHEN coalesce(transformation_notes, '') = '' THEN ''
              ELSE ${' Its transformation notes read: '}::text || transformation_notes
            END AS record
          FROM pattern_reference_cohorts
          WHERE id = ${cohort.id}
        ),
        recorded AS (
          UPDATE pattern_reference_cohorts AS keeper
          SET transformation_notes = CASE
                WHEN coalesce(keeper.transformation_notes, '') = '' THEN candidate.record
                ELSE keeper.transformation_notes || ${'\n\n'}::text || candidate.record
              END
          FROM candidate
          WHERE keeper.id = ${kept.id}
            AND position(candidate.record IN coalesce(keeper.transformation_notes, '')) = 0
          RETURNING keeper.id
        ),
        already AS (
          SELECT keeper.id
          FROM pattern_reference_cohorts AS keeper, candidate
          WHERE keeper.id = ${kept.id}
            AND position(candidate.record IN coalesce(keeper.transformation_notes, '')) > 0
        ),
        deleted AS (
          DELETE FROM pattern_reference_cohorts AS victim
          USING candidate
          WHERE victim.id = candidate.id
            AND victim.transformation_notes IS NOT DISTINCT FROM candidate.notes
            AND (EXISTS (SELECT 1 FROM recorded) OR EXISTS (SELECT 1 FROM already))
            -- §18.2's chain cascades from this row. The moves above are in
            -- this same statement, so their effects are not in this snapshot —
            -- rows they took are excluded by id rather than by re-reading. Any
            -- row left over is one the move did not take, and the cascade
            -- would carry off a transcription nobody agreed to withdraw.
            AND NOT EXISTS (
              SELECT 1 FROM pattern_reference_cases
              WHERE cohort_id = victim.id AND id NOT IN (SELECT id FROM moved_cases)
            )
            AND NOT EXISTS (
              SELECT 1 FROM pattern_reference_aggregates
              WHERE cohort_id = victim.id AND id NOT IN (SELECT id FROM moved_aggregates)
            )
          RETURNING victim.id
        )
        SELECT
          (SELECT count(*) FROM deleted) AS folded,
          (SELECT count(*) FROM moved_cases) + (SELECT count(*) FROM moved_aggregates) AS moved,
          -- The statement fails rather than the caller. Every data-modifying
          -- CTE above runs whether or not this query consumes it, so a delete
          -- refused by its own guard would otherwise leave the move and the
          -- record committed while the merge reported failure — and there is
          -- no transaction here to undo that afterwards. Raising inside the
          -- statement rolls all of it back together.
          --
          -- Only when the folded row is still there: a retry that finds it
          -- already gone has nothing to do and nothing to undo.
          CASE
            WHEN (SELECT count(*) FROM candidate) > 0
             AND (SELECT count(*) FROM deleted) = 0
            THEN pattern_reference_fold_refused(
              ${`Citation merge could not fold reference cohort ${cohort.id} into ${kept.id}: ` +
                `either that row was deleted while this merge was running, or the folded row ` +
                `changed while its record was being written. Nothing was moved or dropped — ` +
                `re-run the merge, which will find whichever row now carries the admission.`}
            )
            ELSE 0
          END AS refused
      `);
      // Nothing deleted has two causes worth telling apart. The row is already
      // gone — another merge folded it, or a retry is repeating a fold that
      // finished — and there is nothing left to do. Or it is still there,
      // which means the record could not be placed: the row it was folding
      // into was deleted by a merge folding *that* one onward, or the notes
      // moved under the statement. Either way this admission's actor,
      // timestamp, description and notes are still on disk, and the merge says
      // so rather than deleting on top of it. Nothing else has moved yet —
      // the cohorts run first for exactly this reason.
      const outcome = folded.rows[0] as { moved?: number | string } | undefined;
      // Counted in the receipt the CLI prints: a merge that moved a study's
      // cases and reported "0 row(s)" tells the operator nothing happened to
      // the atlas. A refusal never reaches here — the statement raises.
      moved += Number(outcome?.moved ?? 0);
    }
  }
  return moved;
}

/**
 * The winner's row carrying this dataset identity, if it has one.
 *
 * Read by the five identity columns rather than by the key string, because the
 * caller reaching this has just been told by the database that such a row
 * exists.
 */
async function readCohortByIdentity(
  db: Db,
  citationId: number,
  like: ReferenceCohortRow,
): Promise<ReferenceCohortRow | undefined> {
  const [row] = await db
    .select()
    .from(patternReferenceCohorts)
    .where(
      and(
        eq(patternReferenceCohorts.citationId, citationId),
        eq(patternReferenceCohorts.sourceDatasetHash, like.sourceDatasetHash),
        eq(patternReferenceCohorts.importerVersion, like.importerVersion),
        eq(patternReferenceCohorts.transformationVersion, like.transformationVersion),
        eq(patternReferenceCohorts.subgroupKey, like.subgroupKey),
      ),
    )
    .limit(1);
  return row;
}


/**
 * Merge `loserId` into `winnerId`. Idempotent per pair (a second run finds
 * nothing left to move); a no-op when the two ids are the same.
 *
 * Runs a series of statements rather than one transaction of its own — wrap the
 * call when atomicity matters. The backfill CLI deliberately does not: it runs
 * over the neon-http driver, which has no transaction to offer, so every step
 * is written to be repeatable instead.
 *
 * `actorUserId` attributes the parameter-summary recompute a merge can trigger.
 * Without one the recompute cannot stamp its revisions, so it is skipped and
 * reported as such in the returned stats.
 */
export async function mergeCitations(
  db: Db,
  winnerId: number,
  loserId: number,
  opts?: { actorUserId?: number | null },
): Promise<CitationMergeStats> {
  const stats: CitationMergeStats = {
    winnerId,
    loserId,
    reviewsDropped: 0,
    reviewRevisionsMoved: 0,
    rowsRepointed: 0,
    jsonDocumentsRewritten: 0,
    summaryRecompute: 'not-needed',
  };
  if (winnerId === loserId) return stats;

  // Before the reads that decide anything, so two merges converging on this
  // winner take their turns rather than both finding it empty. A merge that
  // cannot take the lock leaves this fold to the holder.
  if (!(await tryLockMergeWinner(db, winnerId))) {
    stats.deferred = true;
    return stats;
  }

  // Before the first write: the CLI has no transaction, so a refusal after any
  // mutation is a half-applied merge reported as a refused one. A caller
  // merging a group of three or more must call this itself over the whole
  // group first — see the note on the function.
  await assertNoConflictingCohortBaselines(db, [winnerId, loserId]);

  const rows = await db
    .select({
      id: citations.id,
      type: citations.type,
      identifier: citations.identifier,
      metadata: citations.metadata,
      workKindHandles: citations.workKindHandles,
      workKindVerdicts: citations.workKindVerdicts,
      workKindResolvedAt: citations.workKindResolvedAt,
    })
    .from(citations)
    .where(inArray(citations.id, [winnerId, loserId]));
  const winner = rows.find((r) => r.id === winnerId);
  const loser = rows.find((r) => r.id === loserId);
  if (!winner) {
    throw new Error(`mergeCitations: citation ${winnerId} does not exist`);
  }
  // A loser that is already gone is this merge having already happened, which
  // is what "idempotent per pair" in the doc above means — and with the lock
  // above it is now the ordinary outcome rather than a rarity. Two requests
  // resolving the same paper build their duplicate lists before either takes
  // the lock; the one that waits wakes to find the row it meant to fold
  // already folded. Throwing there would fail a submission *because*
  // serialization worked.
  if (!loser) return stats;

  // The cohorts move first, ahead of every other consumer.
  //
  // This is the one step that can still refuse: the preflight reads before any
  // write, and a merge that starts a moment later can put a conflicting
  // admission under the winner in between, which `repointReferenceCohorts`
  // meets when the identity index rejects its repoint. There is no transaction
  // over the http driver to roll that back with, so the refusal has to come
  // before the writes rather than after them — otherwise a request that
  // reports a merge as refused has already dropped a review and repointed
  // unrelated consumers, and the operator cannot undo it by declining to
  // re-admit the dataset.
  //
  // Nothing below depends on the cohorts having moved, and the cohorts do not
  // depend on anything below; the only ordering the merge really requires is
  // that everything precede the citation delete.
  stats.rowsRepointed += await repointReferenceCohorts(db, winnerId, loserId);

  // Before any paper-review row: see the note on the function.
  await lockPendingEditsCitingCitation(db, loserId);

  const reviewResult = await mergePaperReviews(db, winnerId, loserId);
  stats.reviewsDropped = reviewResult.dropped;
  stats.reviewRevisionsMoved = reviewResult.revisionsMoved;

  const scalarUpdates = await Promise.all([
    db
      .update(learningUnits)
      .set({ citationId: winnerId })
      .where(eq(learningUnits.citationId, loserId))
      .returning({ id: learningUnits.id }),
    db
      .update(parameterEntries)
      .set({ citationId: winnerId })
      .where(eq(parameterEntries.citationId, loserId))
      .returning({ id: parameterEntries.id }),
    db
      .update(drugParameterRevisions)
      .set({ referenceId: winnerId })
      .where(eq(drugParameterRevisions.referenceId, loserId))
      .returning({ id: drugParameterRevisions.id }),
    db
      .update(pendingEdits)
      .set({ referenceId: winnerId })
      .where(eq(pendingEdits.referenceId, loserId))
      .returning({ id: pendingEdits.id }),
    // `pending_edits.target_id` is polymorphic — it means whatever `edit_type`
    // says. For `paper_review` it is the citation being reviewed, which is how
    // `applyApprovedPaperReview` reads it, so a queued review of the loser row
    // would otherwise keep pointing at an id that is deleted below and fail on
    // approval. Reviews auto-publish now, so this only reaches rows queued
    // before that change, but those are exactly the ones nobody is watching.
    db
      .update(pendingEdits)
      .set({ targetId: winnerId })
      .where(
        and(
          eq(pendingEdits.editType, 'paper_review'),
          eq(pendingEdits.targetId, loserId),
        ),
      )
      .returning({ id: pendingEdits.id }),
  ]);
  stats.rowsRepointed += scalarUpdates.reduce(
    (sum, rowsUpdated) => sum + rowsUpdated.length,
    0,
  );

  stats.rowsRepointed += await repointUniquePerCitation(
    db,
    pdfRequests,
    winnerId,
    loserId,
  );
  stats.rowsRepointed += await repointUniquePerCitation(
    db,
    citationPdfs,
    winnerId,
    loserId,
  );
  stats.rowsRepointed += await repointInboxItems(db, winnerId, loserId);

  stats.rowsRepointed += await repointReferenceIdArrays(db, winnerId, loserId);
  stats.jsonDocumentsRewritten = await rewriteJsonDocuments(
    db,
    winnerId,
    loserId,
  );

  // The loser's handle is the whole point of the merge: keep it on the winner
  // so a future write declaring it resolves here instead of re-splitting.
  const loserMetadata = normalizeReferenceMetadata(loser.metadata);
  const winnerMetadata = normalizeReferenceMetadata(winner.metadata) ?? {};
  const altIds = mergeAltIds(winnerMetadata.altIds, {
    ...(loserMetadata?.altIds ?? {}),
    [loser.type]: loser.identifier,
  } as CitationAltIds);
  delete altIds[winner.type as keyof CitationAltIds];
  // The work-kind classification folds with the handles, for the same reason:
  // the loser is about to be deleted, and its verdict is evidence about a paper
  // the winner now answers for. Dropping it would leave the merged row
  // unclassified with a stronger handle to re-resolve through — which is how a
  // DOI Crossref called a dataset gets replaced by PubMed's "journal article"
  // on the promoted PMID (§13.3).
  const foldedWorkKind = mergeStoredClassifications(
    {
      handles: winner.workKindHandles ?? null,
      verdicts: workKindVerdictsOf(winner.workKindVerdicts),
    },
    {
      handles: loser.workKindHandles ?? null,
      verdicts: workKindVerdictsOf(loser.workKindVerdicts),
    },
  );
  const foldedResolvedAt = [winner.workKindResolvedAt, loser.workKindResolvedAt]
    .filter((at): at is Date => at instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  await db
    .update(citations)
    .set({
      metadata: {
        // The winner's own cached metadata wins; the loser fills gaps only.
        ...(loserMetadata ?? {}),
        ...winnerMetadata,
        ...(Object.keys(altIds).length > 0 ? { altIds } : {}),
      },
      workKind: foldedWorkKind.kind,
      workKindStatus: foldedWorkKind.status,
      workKindHandles:
        foldedWorkKind.handles.length > 0 ? foldedWorkKind.handles : null,
      workKindVerdicts:
        foldedWorkKind.verdicts.length > 0 ? foldedWorkKind.verdicts : null,
      // Not `now()`: nothing was asked here. The date is when the surviving
      // answer was obtained, which is the newer of the two the fold kept.
      workKindResolvedAt:
        foldedWorkKind.status === 'unresolved'
          ? null
          : (foldedResolvedAt ?? new Date()),
    })
    .where(eq(citations.id, winnerId));

  await db.delete(citations).where(eq(citations.id, loserId));

  // Source-weighted aggregation joins each entry's citation to its paper review
  // and weights the entry by that review's `overall_score`. Two things here move
  // that input: entries changing hands (they are now weighted by the winner's
  // review, not the loser's), and the winner ending up under a different review
  // than it started with. Neither goes through the entry-mutation path that
  // normally triggers a recompute, so without this the cached
  // `drug_parameters.value` keeps a weighted median and IQR computed from
  // weights that no longer exist — until some unrelated edit happens to refresh
  // it. Run last, so the recompute reads the merged state rather than a
  // half-repointed one.
  const summaryInputsMoved =
    scalarUpdates[1]!.length > 0 || reviewResult.winnerReviewChanged;
  if (summaryInputsMoved) {
    if (opts?.actorUserId != null) {
      await recomputeSummariesCitingCitation(winnerId, opts.actorUserId);
      stats.summaryRecompute = 'ran';
    } else {
      stats.summaryRecompute = 'skipped';
    }
  }
  return stats;
}

/**
 * Citation ids that still point at `citationId` anywhere. Used by the backfill
 * to report what a merge would move before it moves it.
 */
export async function countCitationUsage(
  db: Db,
  citationId: number,
): Promise<number> {
  const result = await db.execute<{ count: number }>(sql`
    SELECT (
      (SELECT count(*) FROM paper_reviews WHERE citation_id = ${citationId}) +
      (SELECT count(*) FROM learning_units WHERE citation_id = ${citationId}) +
      (SELECT count(*) FROM parameter_entries WHERE citation_id = ${citationId}) +
      (SELECT count(*) FROM drug_parameter_revisions
        WHERE reference_id = ${citationId} OR ${citationId} = ANY(reference_ids)) +
      (SELECT count(*) FROM pending_edits
        WHERE reference_id = ${citationId} OR ${citationId} = ANY(reference_ids)) +
      (SELECT count(*) FROM drug_receptor_targets WHERE ${citationId} = ANY(reference_ids)) +
      (SELECT count(*) FROM drug_ionization_constants WHERE ${citationId} = ANY(reference_ids)) +
      -- Admitted cohorts, because the merge acts on them: repointed, or deleted
      -- where the winner already carries the same admission. An operator
      -- reading "0 usages" before --apply would be told nothing about atlas
      -- data the run is about to move or remove.
      (SELECT count(*) FROM pattern_reference_cohorts WHERE citation_id = ${citationId})
    )::int AS count
  `);
  return result.rows?.[0]?.count ?? 0;
}

/**
 * The stored verdict list, as verdicts. `work_kind_verdicts` is `jsonb`, so its
 * shape is guaranteed by a check constraint rather than by the type system;
 * anything that fails the shape here is dropped rather than folded, since a
 * malformed entry cannot be evidence for or against a kind.
 */
function workKindVerdictsOf(value: unknown): CitationWorkKindVerdict[] | null {
  if (!Array.isArray(value)) return null;
  const verdicts = value.filter(
    (entry): entry is CitationWorkKindVerdict =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as { handle?: unknown }).handle === 'string' &&
      isCitationWorkKind((entry as { kind?: unknown }).kind),
  );
  return verdicts.length > 0 ? verdicts : null;
}
