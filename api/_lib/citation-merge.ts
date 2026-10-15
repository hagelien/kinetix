import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  bioEntityFunctions,
  citationIdentifierAliases,
  citationPdfs,
  citations,
  drugBlockRevisions,
  drugEliminationRoutes,
  drugEnzymeInteractions,
  drugIonizationConstants,
  drugMetabolismProfiles,
  drugMetabolites,
  drugParameterRevisions,
  drugReceptorTargets,
  learningUnits,
  paperExtractionJobs,
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
  aliasIdentifier,
  mergeAltIds,
  normalizeAltIds,
  rewriteCitationIdsInJson,
  type CitationAltIds,
  type CitationHandleType,
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
import {
  CITATION_MEMBERSHIP_LOCK_NAMESPACE,
  findParametersCitingCitation,
  recomputeSummariesCitingCitation,
} from './parameter-entries-store.js';
import { isInPoolTransaction } from './db.js';
import { rewriteBlockSnapshotCitation } from './drugBlockRevisions.js';
import { BLOCK_REVISION_CITATION_VALUES } from './citation-usage.js';
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
  return tryAdvisoryXactLock(db, CITATION_MERGE_LOCK_NAMESPACE, winnerId);
}

/**
 * Serialize folding a citation away with opening an extraction job on it.
 *
 * {@link lockLoserExtractionJobs} locks the loser's open jobs, but a row lock
 * only covers rows that are open when it is taken. `enqueueJob` inserts a new
 * one, and nothing about the scan stops it: the insert commits after the scan
 * found nothing, `claimNextJob` hands the job to a run (its row was never
 * locked, so `SKIP LOCKED` does not skip it), and `repointExtractionJobs` then
 * moves a claimed job and the merge deletes the citation id the run was given
 * — the exact outcome the scan exists to refuse. A requeue (`applyJobAction`
 * reopening a settled job) is the same hole through another door. Both have to
 * take part in the same lock, keyed on the citation rather than on a job row
 * the scan could not see.
 *
 * **Why an advisory lock and not the loser's `citations` row.** The FK does
 * make an insert take `FOR KEY SHARE` on the referenced citation, and a
 * `FOR UPDATE` on the loser taken up front would serialize every enqueue with
 * no change to `enqueueJob` at all. But it would also be held, from the first
 * statement on, against every other writer that locks or references that row —
 * and some of them lock rows this merge touches later *first*.
 * `attachInboxItem` holds its inbox row and then takes the citation
 * `FOR UPDATE`; this merge would hold the citation and then reach that inbox
 * row in `repointInboxItems`. That is a wait-for cycle PostgreSQL breaks by
 * killing one side; the merge avoids it today only because it first locks the
 * loser's row at the delete, after the inbox repoint. Every row-lock mode
 * conflicts with the attach's `FOR UPDATE`, so no weaker one escapes that. An
 * advisory key in its own namespace conflicts with nothing but the two callers
 * that agree on it.
 *
 * The two sides take it differently, and both choices are about cycles:
 *
 * - The merge **tries**, with the same bounded retries as the winner's lock and
 *   for the same reason: it may already hold row locks from earlier folds in
 *   its transaction (`commitSources` runs a whole bundle in one), so waiting
 *   here could close a cycle. If the key stays held, the merge defers as
 *   `loser_locked` before writing anything; the holder is an enqueue or
 *   requeue that finishes in milliseconds, or another merge folding the same
 *   loser.
 * - `enqueueJob` and a requeue **wait** ({@link lockCitationAgainstFold}).
 *   Each takes the key before it writes or locks anything, so it holds nothing
 *   anyone else could be waiting for, and its wait cannot be part of a cycle.
 *   When the merge commits, the enqueue's next statement (a fresh snapshot
 *   under READ COMMITTED) finds the citation gone and refuses with a 404 —
 *   rather than inserting a job under a deleted id or racing the repoint — and
 *   the requeue lands on the job where the merge moved it, under the winner.
 *
 * Taken after the winner's lock and before the job scan, so an enqueue or
 * requeue that got in first has committed — and its open job is visible to the
 * scan — or has not started. Like the winner's lock, it serializes nothing
 * outside a transaction.
 */
const CITATION_FOLD_LOCK_NAMESPACE = 1088;

async function tryLockFoldedCitation(db: Db, loserId: number): Promise<boolean> {
  return tryAdvisoryXactLock(db, CITATION_FOLD_LOCK_NAMESPACE, loserId);
}

/**
 * The queue side of {@link CITATION_FOLD_LOCK_NAMESPACE}: wait until no merge
 * is folding `citationId` away, and keep any from starting until the caller's
 * transaction ends. Must come before the transaction writes or locks anything
 * — see the note on the namespace for why that is what keeps the wait out of
 * any cycle — and must run inside one, or it releases at once.
 */
export async function lockCitationAgainstFold(
  db: Db,
  citationId: number,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(${CITATION_FOLD_LOCK_NAMESPACE}::int, ${citationId}::int)`,
  );
}

/**
 * The exclusive side of the citation-membership key
 * ({@link CITATION_MEMBERSHIP_LOCK_NAMESPACE}, #254), with the merge's bounded
 * retries: while held, no new entry citing `citationId` can be written, so a
 * scan of the entries citing it is the whole membership until this
 * transaction ends. Taken by the two writes that move every citing entry's
 * aggregation weight and then recompute the drugs the scan found — a fold
 * ({@link mergeCitations}, on both rows) and a re-score (`recordPaperReview`).
 *
 * A try, never a wait: either may already hold rows an entry writer is queued
 * behind (a fold earlier folds' job rows and rewrites, an approval its
 * `pending_edits` row), and the entry writers wait for this key, so waiting
 * for them could close a cycle. The writer holding it shared is finishing one
 * insert or update under its own drug lock, so the retries usually outlast it;
 * one that does not stands the caller aside before it has written anything.
 * Succeeds outside a pool transaction, like the other tries, where it would
 * hold nothing.
 */
export async function tryLockCitationMembership(db: Db, citationId: number): Promise<boolean> {
  return tryAdvisoryXactLock(db, CITATION_MEMBERSHIP_LOCK_NAMESPACE, citationId);
}

/**
 * The per-drug lock every parameter-summary recompute takes
 * (`lockDrugForRecompute` in `parameter-entries-store`, the same key as
 * `lockDrugForEntryApplicability`): the single-argument form on the drug id.
 *
 * **One global order: a drug's advisory lock before any extraction-job row
 * lock (#243).** Three paths take both, and two already took them that way:
 *
 * - a paper-extraction fact filed on a drug monograph (`POST
 *   /api/pending-edits`, the drug-scoped branch) takes the drug lock, then
 *   re-checks the run's claim with the job row `FOR SHARE`;
 * - a drug merge (`mergeDrugs`) takes both drugs' locks first and later
 *   rewrites `paper_extraction_jobs.target_drug_ids`.
 *
 * This merge was the exception. It locks the loser's open jobs
 * ({@link lockLoserExtractionJobs}) first, and the recompute at the end of the
 * fold reached for the drug lock afterwards — and since every caller folds a
 * whole duplicate group in one transaction, a fold that deferred on a run's
 * claimed job, or moved a queued one, still held that row when a later fold's
 * recompute waited for a drug. Either path above holding that drug and waiting
 * for that job closed a cycle Postgres breaks by aborting one side (40P01).
 *
 * So a fold takes the drug locks its recompute will need *before* it locks any
 * job row ({@link lockDrugsForFold}), and *tries* them rather than waiting, for
 * the same reason as the winner's and the loser's keys: a later fold of a group
 * may already hold job rows (and every other row lock) from the earlier ones,
 * so a wait here could still close the cycle, and a try never registers a
 * wait. A drug that stays held defers the fold as `drug_locked` before it
 * writes anything. A drug whose first entry citing the pair lands after that
 * scan is tried again just before the recompute, and one that stays held then
 * defers the fold too — by rolling the fold's writes back to the savepoint
 * they ran under (see {@link mergeCitations}), so a fold never commits with a
 * summary it invalidated left unrecomputed. Taking them first also stops the
 * fold being the odd one out against every other writer that holds a drug and
 * then touches rows a fold rewrites (entry writers, the approvals that
 * preflight their drug locks, the drug merge's own entry repoint): the fold
 * queues behind those on rows rather than waiting on their drug while holding
 * rows they need. The writers that
 * took a drug lock only after such a row now take it up front as well —
 * `recordPaperReview` before its review row, and approval of a `parameter` or
 * `paper_review` edit before the edit's row (`drugAdvisoryLockIdsForEdit`).
 * Both meet the fold's late-drug problem from the other side — a drug whose
 * first entry lands after their scan — and handle it the same way
 * ({@link tryLockLateDrugsCitingCitation}): try, and undo rather than wait.
 *
 * Unchanged around it: job before wiki page (#223), and the winner's key
 * (namespace 1087) and the loser's fold key (1088) before the drug locks. Those
 * two are taken here only by tries, and waited on only by an enqueue or requeue
 * that holds nothing yet, so where they sit relative to a drug lock cannot form
 * a cycle. The two-argument keys and this single-argument one are distinct
 * lock spaces in Postgres, so a drug id never collides with a namespace pair.
 *
 * **The citation-membership key (1089, #254) sits between the two sides.**
 * Entry writers take it shared, waiting, after their drug locks and before any
 * row lock: drug locks → 1089 shared → the entry row (an approval takes it in
 * its preflight, before the `pending_edits` row; a research import before its
 * first seeded row). A fold takes it exclusively by try, on the winner and the
 * loser: 1087 → 1088 → 1089 → the drug tries → job rows → its writes. A
 * re-score takes the drug locks it needs (waiting, or trying under
 * `drugLocks: 'try'`), then tries 1089, then writes the review row. No cycle
 * can run through it: a writer waiting for it shared holds drug locks and no
 * row, and the exclusive holders never wait for it — and, having taken it,
 * never wait for a drug lock they do not hold either: the fold only tries, and
 * a re-score waits for drug locks only before it, and only under
 * `drugLocks: 'wait'`, where it holds nothing yet. The writer, for
 * its part, already holds every drug lock it will need when it waits, and
 * takes every key it needs before its first row lock, so once it holds a row
 * an exclusive holder could queue on, it never waits for this key again.
 * Holding the key also narrows the late-drug tries to what is left: an entry
 * that committed between a re-score's drug scan and its try of the key (the
 * fold tries the key before it scans), or one a drug merge moved to another
 * drug while the re-score was still waiting for the scanned drug's lock.
 *
 * **A transaction that folds and then writes a review (#246).** Conversation
 * ingestion (`commitSourcesFor`) resolves a source — which may fold, and so
 * lock job rows — and then records the source's review, whose recompute needs
 * the drugs citing the paper. `recordPaperReview` waiting for those after a
 * fold is the same job-then-drug cycle again. So that transaction takes the
 * drug locks of every row its sources' resolutions can reach as its first
 * statements, waiting while it still holds nothing (ascending, before the
 * 1087/1088 tries and before any job row), and the review write afterwards
 * only *tries* (`drugLocks: 'try'`, through this function) — taken already for
 * every drug the up-front scan saw, and refusing the whole source commit
 * rather than waiting for one it did not.
 */
export async function tryLockDrugForRecompute(db: Db, drugId: number): Promise<boolean> {
  return retryTryLock(db, sql`SELECT pg_try_advisory_xact_lock(${drugId}::bigint) AS locked`);
}

/**
 * The drug locks a recompute over `citationId` still lacks, tried just before
 * it runs: the drugs whose first entry citing the paper landed after the
 * caller's up-front lock scan (`alreadyLocked`, which this extends). Tried in
 * ascending order and never waited for — the caller by now holds rows a
 * drug-first writer may be queued on (a fold its job rows and rewrites, a
 * review its `paper_reviews` row) — so a drug that stays held is returned
 * for the caller to undo its writes over, and null means every drug is held.
 */
export async function tryLockLateDrugsCitingCitation(
  db: Db,
  citationId: number,
  alreadyLocked: Set<number>,
): Promise<number | null> {
  const lateDrugIds = [
    ...new Set((await findParametersCitingCitation(citationId)).map((row) => row.drugId)),
  ]
    .filter((drugId) => !alreadyLocked.has(drugId))
    .sort((a, b) => a - b);
  for (const drugId of lateDrugIds) {
    if (!(await tryLockDrugForRecompute(db, drugId))) return drugId;
    alreadyLocked.add(drugId);
  }
  return null;
}

/**
 * The drugs whose cached summaries this fold will recompute, ascending — none
 * when nothing that feeds a summary can move.
 *
 * The recompute runs when the loser's entries change hands or the winner ends
 * up under the loser's review, and then covers every entry citing the winner,
 * which by then includes the loser's. So: the drugs of entries citing either
 * row, when the loser has an entry or a review to bring.
 */
async function drugsToRecomputeForFold(
  db: Db,
  winnerId: number,
  loserId: number,
): Promise<number[]> {
  const result = await db.execute<{ drug_id: number }>(sql`
    SELECT DISTINCT drug_id FROM parameter_entries
    WHERE citation_id IN (${winnerId}, ${loserId})
      AND (
        EXISTS (SELECT 1 FROM parameter_entries WHERE citation_id = ${loserId})
        OR EXISTS (SELECT 1 FROM paper_reviews WHERE citation_id = ${loserId})
      )
    ORDER BY drug_id
  `);
  return (result.rows ?? []).map((row) => Number(row.drug_id));
}

/**
 * Try each drug lock this fold's recompute will need, ascending. Returns the
 * drugs taken, or the first one whose lock stayed held — the fold then defers.
 * Skipped without an actor (the recompute will not run) and outside a
 * transaction (the lock would hold nothing).
 */
async function lockDrugsForFold(
  db: Db,
  winnerId: number,
  loserId: number,
  actorUserId: number | null | undefined,
): Promise<{ locked: Set<number>; heldDrugId: number | null }> {
  const locked = new Set<number>();
  if (actorUserId == null || !isInPoolTransaction()) {
    return { locked, heldDrugId: null };
  }
  for (const drugId of await drugsToRecomputeForFold(db, winnerId, loserId)) {
    if (!(await tryLockDrugForRecompute(db, drugId))) return { locked, heldDrugId: drugId };
    locked.add(drugId);
  }
  return { locked, heldDrugId: null };
}

async function tryAdvisoryXactLock(
  db: Db,
  namespace: number,
  key: number,
): Promise<boolean> {
  return retryTryLock(
    db,
    sql`SELECT pg_try_advisory_xact_lock(${namespace}::int, ${key}::int) AS locked`,
  );
}

/** A `pg_try_advisory_xact_lock` query, with the merge's bounded retries. */
async function retryTryLock(db: Db, query: SQL): Promise<boolean> {
  if (!isInPoolTransaction()) return true;
  for (let attempt = 0; ; attempt += 1) {
    const result = await db.execute<{ locked: boolean }>(query);
    if ((result.rows[0] as { locked?: boolean } | undefined)?.locked === true) return true;
    if (attempt + 1 >= MERGE_LOCK_ATTEMPTS) return false;
    await new Promise((resolve) => {
      setTimeout(resolve, MERGE_LOCK_BACKOFF_MS * (attempt + 1));
    });
  }
}

/**
 * Why a merge stood aside, as the CLIs print it after "deferred #loser →
 * #winner: ". One wording for both scripts that fold, so the reasons cannot
 * drift apart between them.
 */
export function describeDeferredMerge(stats: CitationMergeStats): string {
  switch (stats.deferredReason) {
    case 'extraction_in_flight':
      return (
        `extraction job ${stats.inFlightExtractionJobId} is reading #${stats.loserId}.` +
        ' Re-run once it has finished or been cancelled.'
      );
    case 'loser_locked':
      return (
        `#${stats.loserId} was locked by an extraction (re)queue or another merge of it.` +
        ' Re-run to pick it up.'
      );
    case 'drug_locked':
      return (
        `drug ${stats.lockedDrugId}, whose parameter summaries the fold recomputes, was locked` +
        ' by another write. Re-run to pick it up.'
      );
    case 'entry_in_flight':
      return (
        `a source value citing #${stats.winnerId} or #${stats.loserId} was being written, or` +
        ' one of them re-scored or folded elsewhere. Re-run to pick it up.'
      );
    default:
      return 'another merge into this paper was running. Re-run to pick it up.';
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
   *
   * There is no partial outcome: with an actor, a fold either recomputes every
   * drug whose summary it moved or does not happen (`drug_locked`).
   */
  summaryRecompute: 'ran' | 'skipped' | 'not-needed';
  /**
   * True when this merge stood aside without writing anything; `deferredReason`
   * says why. Nothing was folded; the next write declaring the handle, or
   * `merge:split-citations`, does it once the cause has cleared.
   */
  deferred?: boolean;
  /**
   * `merge_in_progress`: another merge into this same winner held the lock, and
   * the holder may well fold this pair itself. `loser_locked`: the loser's own
   * lock was held — an extraction job being queued or requeued for it, or
   * another merge folding it — so its job list could not be settled (see
   * `CITATION_FOLD_LOCK_NAMESPACE`). `extraction_in_flight`: a run is
   * extracting the loser under its id right now (`inFlightExtractionJobId`),
   * or that job's row stayed locked by another write (see
   * `lockLoserExtractionJobs`), and the fold waits for that run to finish or
   * be cancelled. `drug_locked`:
   * a drug whose summaries the fold would recompute (`lockedDrugId`) was held
   * by another write, and the fold does not wait for a drug once it may hold
   * job rows (see `tryLockDrugForRecompute`) — whether found held at the
   * up-front scan, before any write, or at the recompute, where the fold's
   * writes are rolled back to their savepoint first. `entry_in_flight`: the
   * citation-membership key of the winner or the loser
   * (`CITATION_MEMBERSHIP_LOCK_NAMESPACE`) was held — a source value citing
   * one of them being written, a re-score of one of them, or another fold of
   * one — so the fold could not settle which drugs' summaries it moves (#254).
   */
  deferredReason?:
    | 'merge_in_progress'
    | 'loser_locked'
    | 'extraction_in_flight'
    | 'drug_locked'
    | 'entry_in_flight';
  /** The loser's claimed extraction job, when that is what deferred the merge. */
  inFlightExtractionJobId?: number;
  /** The drug whose held lock deferred the merge (`drug_locked`). */
  lockedDrugId?: number;
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

  // Whole-block revision snapshots (#37) name citations too: a declaration's
  // citationId, the referenceIds on routes, metabolite links and mechanisms.
  // Left on the loser they would show a deleted reference in the block's
  // history, and the model structure's next revision — which takes the newest
  // snapshot as its "before" — would differ from the live block by the
  // citation alone.
  const blockRevisions = await db
    .select({
      id: drugBlockRevisions.id,
      oldValue: drugBlockRevisions.oldValue,
      newValue: drugBlockRevisions.newValue,
    })
    .from(drugBlockRevisions)
    .where(
      sql`${drugBlockRevisions.oldValue}::text LIKE ${`%${loserId}%`}
        OR ${drugBlockRevisions.newValue}::text LIKE ${`%${loserId}%`}`,
    );
  for (const revision of blockRevisions) {
    const before =
      revision.oldValue == null
        ? { value: null, changed: false }
        : rewriteBlockSnapshotCitation(revision.oldValue, loserId, winnerId);
    const after = rewriteBlockSnapshotCitation(
      revision.newValue,
      loserId,
      winnerId,
    );
    if (!before.changed && !after.changed) continue;
    await db
      .update(drugBlockRevisions)
      .set({
        oldValue: before.value as never,
        newValue: after.value as never,
      })
      .where(eq(drugBlockRevisions.id, revision.id));
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
 * Lock the loser's open extraction jobs, and return the id of one that is
 * claimed — or null when none is, and the merge may go ahead.
 *
 * A claimed job is a run reading the paper under the loser's id right now. The
 * id was handed to the extractor with the claim, and every fact it files cites
 * it; folding the loser away deletes that id, so the run's later submissions
 * fail the live-claim citation check and the run is wasted. The admin route
 * refuses such a merge up front with a message an operator can act on, but
 * `resolveCitation` and `merge:split-citations` fold too, and neither should
 * fail because an unrelated run is in flight — so the refusal lives here, as a
 * deferral like the advisory lock's: nothing is written, and the pair folds on
 * the next write declaring its handle, or the next CLI run, once the run has
 * finished or been cancelled.
 *
 * Every open job is locked, not only the claimed ones, which is what makes the
 * check atomic: claiming is an UPDATE, so a queued job cannot become claimed
 * between this read and `repointExtractionJobs` moving it. `claimNextJob`
 * passes over a locked row (`SKIP LOCKED`) rather than waiting on it. `NO KEY
 * UPDATE` is enough to conflict with every UPDATE that touches the row.
 *
 * **Tried, never waited for.** Every caller folds a whole group — a bundle's
 * sources, or three or more rows of one paper — in one transaction, and an
 * earlier fold's `rewriteJsonDocuments` may already hold a wiki page row. The
 * job's holders are a claim under way and a run filing a fact (which holds its
 * job `FOR SHARE` and then share-locks the page, #223), so waiting here is
 * page-then-job against job-then-page — the cycle #247 removed from the wiki
 * article import, reopened one fold later. So the rows are locked with `SKIP
 * LOCKED` and compared with an unlocked read of the open set: an open job the
 * lock skipped is held, retried briefly like the merge's advisory keys, and
 * one that stays held defers the fold as in flight — which is what such a job
 * almost always turns out to be (a run's claim check, or a claim landing).
 *
 * Two ways for an open job to appear *after* this scan are not rows it can
 * lock: an enqueue inserting one, and a requeue reopening a settled one. Both
 * take the loser's fold lock instead (`CITATION_FOLD_LOCK_NAMESPACE`), which
 * the merge holds from before this scan. Settled jobs are deliberately not
 * locked here: `repointExtractionJobs` reaches them after the parameter-entry
 * and review writes, the same order a drug merge (entries, then
 * `target_drug_ids`) takes them in, and locking them first would invert it.
 *
 * Outside a transaction the lock releases with its own statement, as the
 * advisory lock's does, and the check is only as good as a plain read.
 */
async function lockLoserExtractionJobs(db: Db, loserId: number): Promise<number | null> {
  for (let attempt = 0; ; attempt += 1) {
    const open = await db
      .select({ id: paperExtractionJobs.id })
      .from(paperExtractionJobs)
      .where(
        and(
          eq(paperExtractionJobs.citationId, loserId),
          inArray(paperExtractionJobs.status, ['queued', 'claimed']),
        ),
      )
      .orderBy(paperExtractionJobs.id);
    if (open.length === 0) return null;
    // The rows' newest versions, where this transaction could lock them.
    const locked = await db
      .select({ id: paperExtractionJobs.id, status: paperExtractionJobs.status })
      .from(paperExtractionJobs)
      .where(
        inArray(
          paperExtractionJobs.id,
          open.map((job) => job.id),
        ),
      )
      .orderBy(paperExtractionJobs.id)
      .for('no key update', { skipLocked: true });
    const claimed = locked.find((job) => job.status === 'claimed');
    if (claimed) return claimed.id;
    const lockedIds = new Set(locked.map((job) => job.id));
    const held = open.find((job) => !lockedIds.has(job.id));
    if (!held) return null;
    if (!isInPoolTransaction() || attempt + 1 >= MERGE_LOCK_ATTEMPTS) return held.id;
    await new Promise((resolve) => {
      setTimeout(resolve, MERGE_LOCK_BACKOFF_MS * (attempt + 1));
    });
  }
}

/**
 * Repoint the paper fact-extraction queue at the surviving citation.
 *
 * `paper_extraction_jobs.citation_id` is `ON DELETE CASCADE`, so leaving a job
 * behind does not fail the merge — it deletes the job: a queued paper silently
 * drops out of the queue, a run mid-extraction loses its ticket, and a settled
 * job takes its result summary and the ids of the edits it filed with it.
 *
 * Settled jobs (`completed` / `failed` / `cancelled`) all move: they are the
 * paper's extraction history. A queued one moves too, unless the winner
 * already has an open job of its own — the partial unique index allows one
 * open job per paper, and two would be two runs filing the same facts. The
 * loser's is then cancelled with a reason naming the winner, and moved, so it
 * stays visible on the queue page instead of vanishing.
 *
 * A claimed one never reaches here: {@link lockLoserExtractionJobs} has
 * already deferred the whole merge, and holds the loser's queued jobs so none
 * can be claimed in between; the fold lock keeps a new one from being
 * enqueued, or a settled one requeued, behind its back.
 */
async function repointExtractionJobs(
  db: Db,
  winnerId: number,
  loserId: number,
): Promise<number> {
  const openStatuses = ['queued', 'claimed'];
  const [winnerOpen] = await db
    .select({ id: paperExtractionJobs.id })
    .from(paperExtractionJobs)
    .where(
      and(
        eq(paperExtractionJobs.citationId, winnerId),
        inArray(paperExtractionJobs.status, openStatuses),
      ),
    )
    .limit(1);
  if (winnerOpen) {
    await db
      .update(paperExtractionJobs)
      .set({
        status: 'cancelled',
        claimedBy: null,
        claimedAt: null,
        claimToken: null,
        completedAt: null,
        lastError: `citation_merged: folded into citation ${winnerId}, which already has open extraction job ${winnerOpen.id}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(paperExtractionJobs.citationId, loserId),
          inArray(paperExtractionJobs.status, openStatuses),
        ),
      );
  }
  const moved = await db
    .update(paperExtractionJobs)
    .set({ citationId: winnerId })
    .where(eq(paperExtractionJobs.citationId, loserId))
    .returning({ id: paperExtractionJobs.id });
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
 * Runs a series of statements rather than one transaction of its own, so the
 * caller wraps it — and every caller that folds must, atomicity aside: the
 * advisory locks and the extraction-job row locks above are transaction-scoped,
 * and on the auto-commit client each releases with its own statement and
 * serializes nothing. `resolveCitation`, the admin route and both CLIs open a
 * pool transaction around their merges for that reason. Every step is still
 * written to be repeatable, so a run that dies partway is finished by the next.
 * Inside a pool transaction, with an actor, a fold's writes also run under a
 * savepoint of their own, so one that defers or throws after its first write
 * leaves none of them in the caller's transaction (see the note in the body).
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
  const stats = emptyMergeStats(winnerId, loserId);
  if (winnerId === loserId) return stats;

  // Before the reads that decide anything, so two merges converging on this
  // winner take their turns rather than both finding it empty. A merge that
  // cannot take the lock leaves this fold to the holder.
  if (!(await tryLockMergeWinner(db, winnerId))) {
    stats.deferred = true;
    stats.deferredReason = 'merge_in_progress';
    return stats;
  }

  // Before the job scan, so no enqueue or requeue for the loser can commit
  // behind it; see the note on the namespace. A try, like the winner's: a merge that cannot
  // take it stands aside rather than waiting.
  if (!(await tryLockFoldedCitation(db, loserId))) {
    stats.deferred = true;
    stats.deferredReason = 'loser_locked';
    return stats;
  }

  // Before the drug scan below (#254): with both rows' citation-membership
  // keys held, no new entry citing either can be written until this
  // transaction commits, so the scan sees every drug whose summary the fold
  // moves. Without them, an entry filed on another drug and committed after
  // the fold's last scan would have recomputed that drug against the weights
  // from before the fold, and kept them once both commit. Tries, like the two
  // keys above: standing aside here writes nothing.
  if (
    !(await tryLockCitationMembership(db, winnerId)) ||
    !(await tryLockCitationMembership(db, loserId))
  ) {
    stats.deferred = true;
    stats.deferredReason = 'entry_in_flight';
    return stats;
  }

  // Before any job row (#243): the drug locks the recompute at the end will
  // need, tried in ascending order — see `tryLockDrugForRecompute` for the
  // global order this keeps and why it is a try. Before the first write too, so
  // standing aside here leaves nothing half-applied.
  const summaryDrugs = await lockDrugsForFold(db, winnerId, loserId, opts?.actorUserId);
  if (summaryDrugs.heldDrugId !== null) {
    stats.deferred = true;
    stats.deferredReason = 'drug_locked';
    stats.lockedDrugId = summaryDrugs.heldDrugId;
    return stats;
  }

  // Also before the first write, and for the same reason as the cohort check
  // below: a deferral after any mutation is a half-applied merge.
  const inFlightJobId = await lockLoserExtractionJobs(db, loserId);
  if (inFlightJobId !== null) {
    stats.deferred = true;
    stats.deferredReason = 'extraction_in_flight';
    stats.inFlightExtractionJobId = inFlightJobId;
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

  // From the first write through the recompute, the fold is one unit. The
  // recompute tries again for any drug whose first entry citing the pair
  // landed after the up-front scan, and only tries — this transaction holds job
  // rows by now — so a drug can still be found held there, after every write.
  // Committing the rest then would leave that drug's cached summary pooled
  // from weights the fold just moved, with nothing due to refresh it. So the
  // writes run under a savepoint, and a drug held at the recompute rolls them
  // back and defers the pair (`drug_locked`), exactly as a drug held at the
  // up-front scan does before any write: the next resolve or CLI run folds it.
  // A fold that throws is rolled back the same way, so a caller that catches
  // the error and commits its own work does not commit half a fold with it.
  //
  // Only with an actor and a pool transaction — the only case the late try can
  // fail in. Without an actor nothing is recomputed (`skipped`), and outside a
  // transaction (the http client, which has none to set a savepoint in) every
  // try succeeds, as the lock would hold nothing anyway.
  //
  // Rolling back to the savepoint also releases the locks taken under it — the
  // row locks of the writes, the pending edits', and the drug locks the late
  // try did take. Postgres releases a transaction-scoped advisory lock taken
  // after a savepoint when that savepoint is rolled back to, like any other
  // lock. Nothing is lost by that: the writes those locks guarded are gone with
  // them. The winner's, the loser's and the up-front drug locks, and the
  // loser's job rows, were taken before the savepoint and stay held to the end
  // of the transaction, as for every other deferral.
  const actorUserId = opts?.actorUserId ?? null;
  const atomic = actorUserId !== null && isInPoolTransaction();
  if (atomic) await db.execute(sql`SAVEPOINT citation_fold`);
  let lateHeldDrugId: number | null;
  try {
    lateHeldDrugId = await applyFold(
      db,
      winner,
      loser,
      stats,
      summaryDrugs.locked,
      actorUserId,
    );
  } catch (err) {
    if (atomic) {
      // The original error is the one worth surfacing; a rollback that fails
      // too leaves the transaction to the caller's own rollback.
      await rollBackFold(db).catch(() => undefined);
    }
    throw err;
  }
  if (lateHeldDrugId === null) {
    if (atomic) await db.execute(sql`RELEASE SAVEPOINT citation_fold`);
    return stats;
  }
  if (!atomic) {
    // Unreachable: outside a pool transaction every try succeeds. Fail loudly
    // rather than report as done a fold whose recompute did not run.
    throw new Error(
      `mergeCitations: drug ${lateHeldDrugId} held outside a transaction while folding ` +
        `#${loserId} into #${winnerId}`,
    );
  }
  await rollBackFold(db);
  return {
    ...emptyMergeStats(winnerId, loserId),
    deferred: true,
    deferredReason: 'drug_locked',
    lockedDrugId: lateHeldDrugId,
  };
}

function emptyMergeStats(winnerId: number, loserId: number): CitationMergeStats {
  return {
    winnerId,
    loserId,
    reviewsDropped: 0,
    reviewRevisionsMoved: 0,
    rowsRepointed: 0,
    jsonDocumentsRewritten: 0,
    summaryRecompute: 'not-needed',
  };
}

/** Undo everything since `SAVEPOINT citation_fold`, and drop the savepoint. */
async function rollBackFold(db: Db): Promise<void> {
  await db.execute(sql`ROLLBACK TO SAVEPOINT citation_fold`);
  await db.execute(sql`RELEASE SAVEPOINT citation_fold`);
}

/** The citation columns a fold reads from both rows. */
type FoldedCitation = Pick<
  typeof citations.$inferSelect,
  | 'id'
  | 'type'
  | 'identifier'
  | 'metadata'
  | 'workKindHandles'
  | 'workKindVerdicts'
  | 'workKindResolvedAt'
>;

/**
 * The writes of one fold, in order, ending with the summary recompute; see
 * {@link mergeCitations} for the locks taken before it and the savepoint
 * around it. Fills `stats` as it goes. Returns null once the fold is done, or
 * — before the recompute, with every write made — the drug whose lock stayed
 * held, for the caller to roll back on.
 */
async function applyFold(
  db: Db,
  winner: FoldedCitation,
  loser: FoldedCitation,
  stats: CitationMergeStats,
  lockedDrugs: Set<number>,
  actorUserId: number | null,
): Promise<number | null> {
  const winnerId = winner.id;
  const loserId = loser.id;

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
  stats.rowsRepointed += await repointExtractionJobs(db, winnerId, loserId);

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

  // `altIds` holds one handle per type and is fill-only, and it has no slot for
  // free text at all. So every handle the loser answered to — its own and each
  // of its alt ids — is also recorded as an alias of the winner: without that,
  // the second of two merged-away URLs (or any free-text spelling) matches
  // nothing on the next write and recreates the row this merge deletes. The
  // loser's own aliases move first — the cascade below would otherwise take
  // them with it.
  await db
    .update(citationIdentifierAliases)
    .set({ citationId: winnerId })
    .where(eq(citationIdentifierAliases.citationId, loserId));
  const loserAltIds = normalizeAltIds(loserMetadata?.altIds);
  const loserHandles: Array<{ type: CitationHandleType; identifier: string }> = [
    { type: loser.type as CitationHandleType, identifier: loser.identifier },
    ...(['pmid', 'doi', 'url'] as const).flatMap((key) =>
      loserAltIds[key] ? [{ type: key, identifier: loserAltIds[key]! }] : [],
    ),
  ];
  for (const handle of loserHandles) {
    await db
      .insert(citationIdentifierAliases)
      .values({
        citationId: winnerId,
        type: handle.type,
        identifier: aliasIdentifier(handle),
      })
      .onConflictDoUpdate({
        target: [citationIdentifierAliases.type, citationIdentifierAliases.identifier],
        set: { citationId: winnerId },
      });
  }

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
    if (actorUserId !== null) {
      // The drugs locked up front cover the entries that cited the pair at the
      // lock scan. One whose entry arrived since is tried like the rest, in
      // ascending order — never waited for, as this transaction now holds job
      // rows — and one that stays held hands the fold back to be undone.
      const heldDrugId = await tryLockLateDrugsCitingCitation(db, winnerId, lockedDrugs);
      if (heldDrugId !== null) return heldDrugId;
      await recomputeSummariesCitingCitation(winnerId, actorUserId);
      stats.summaryRecompute = 'ran';
    } else {
      stats.summaryRecompute = 'skipped';
    }
  }
  return null;
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
      -- Block-history snapshots (#37), which the merge rewrites too.
      (SELECT count(*) FROM drug_block_revisions b
        WHERE EXISTS (
          SELECT 1 FROM (${BLOCK_REVISION_CITATION_VALUES}) t(v)
          WHERE jsonb_typeof(t.v) = 'number'
            AND (t.v #>> '{}')::int = ${citationId}
        )) +
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
