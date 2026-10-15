/**
 * #254: the citation-membership key, on real connections.
 *
 * A paper-review re-score (`recordPaperReview`) and a citation fold
 * (`mergeCitations`) both move the weight every entry citing a paper is pooled
 * with — the paper's review score — and then recompute the cached summary of
 * every drug they found citing it. They find those drugs by scanning
 * `parameter_entries`, and lock exactly those. A source value filed on ANOTHER
 * drug while one of them is uncommitted never meets their drug locks: it
 * inserts its row, recomputes its own drug against the review score as it
 * stood before, and — landing after their last scan — keeps that pooled value
 * once both commit. Nothing refreshes it until some unrelated write does.
 *
 * The fix is a key per paper, `(1089, citationId)`: entry writers take it
 * shared and wait (`lockCitationMembershipShared`), folds and re-scores take it
 * exclusively and only try (`tryLockCitationMembership`). These tests pin both
 * halves:
 *
 * - a source value filed mid-re-score waits for the re-score to commit and
 *   then pools the new score (with a negative control: the same race, written
 *   by hand without the key, leaves the cached value stale — so the fix test
 *   cannot pass because nothing was racing);
 * - the re-score holds the key before its first write;
 * - a re-score refuses (`paper_review_drug_locked`, no drug) rather than wait
 *   for a source value in flight, writing nothing;
 * - a fold defers (`entry_in_flight`) rather than wait for one, writing
 *   nothing, and folds cleanly once it has committed.
 *
 * PGlite has one connection and cannot contend a lock with itself; this suite
 * skips without `KINETIX_TEST_PG_URL` and never falls back to it. The
 * `migrations` workflow runs it against a service container (asserted below).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import { getDb, runInPoolTransaction } from '../../../api/_lib/db.js';
import { mergeCitations, type CitationMergeStats } from '../../../api/_lib/citation-merge.js';
import {
  PaperReviewDrugLockedError,
  recordPaperReview,
} from '../../../api/_lib/paper-review-store.js';
import {
  insertParameterEntry,
  recomputeAndCacheParameterSummary,
} from '../../../api/_lib/parameter-entries-store.js';
import { lockDrugForEntryApplicability } from '../../../api/_lib/parameterApplicabilityStore.js';
import {
  citations,
  drugParameters,
  drugs,
  paperReviewRevisions,
  paperReviews,
  parameterEntries,
  users,
} from '../../../db/schema.js';
import {
  LOCK_TIMEOUT_MS,
  REAL_PG_URL_ENV,
  realPostgresUrl,
  resetRealPostgresDb,
  setupRealPostgresDb,
  teardownRealPostgresDb,
  type RealPostgresDb,
} from '../../integration/setup/real-postgres.js';

const hasRealPostgres = realPostgresUrl() !== null;

/** A promise plus the function that settles it — a gate one side waits on. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * The weights are chosen so the re-score moves the pooled value. On the late
 * drug, one entry reads 10 h from a paper scored 50 (weight 0.75) and the new
 * one 20 h from the paper being re-scored. At the old score (50, weight 0.75)
 * the two weigh the same and the weighted median resolves downward to 10; at
 * the new one (90, weight 0.95) the 20 h entry outweighs it and the median is
 * 20 (`entryWeight`, `weightedPercentile`).
 */
const OLD_SCORE = 50;
const NEW_SCORE = 90;
const STALE_MEDIAN = 10;
const FRESH_MEDIAN = 20;

describe.skipIf(!hasRealPostgres)(
  'citation-membership key: entry writers vs. folds and re-scores (#254)',
  () => {
    let db: RealPostgresDb;
    let authorId: number;
    /** Cites the re-scored paper from the start: the re-score's scan finds it. */
    let scannedDrug: number;
    /** Gains its first entry citing the paper mid-re-score. */
    let lateDrug: number;
    /** The paper being re-scored (or the fold's survivor). */
    let paper: number;
    /** Another paper the late drug already cites, at a fixed score. */
    let otherPaper: number;

    beforeAll(async () => {
      db = await setupRealPostgresDb();
    }, 120_000);
    afterAll(async () => {
      await teardownRealPostgresDb();
    });
    // Transactions a test holds open, released whatever the outcome so one
    // failing assertion cannot leave a lock behind for the next reset.
    let held: Array<{ release: () => void; done: Promise<unknown> }> = [];
    afterEach(async () => {
      for (const hold of held) hold.release();
      await Promise.allSettled(held.map((hold) => hold.done));
      held = [];
    });

    async function seedDrug(slug: string): Promise<number> {
      const [row] = await db
        .insert(drugs)
        .values({ slug, names: { nb: slug, en: slug } })
        .returning({ id: drugs.id });
      return row!.id;
    }

    async function seedCitation(type: string, identifier: string): Promise<number> {
      const [row] = await db
        .insert(citations)
        .values({ type, identifier })
        .returning({ id: citations.id });
      return row!.id;
    }

    async function seedEntry(drug: number, citationId: number, median: number): Promise<void> {
      await db.insert(parameterEntries).values({
        drugId: drug,
        parameter: 'halfLife',
        citationId,
        unit: 'h',
        low: String(median - 2),
        high: String(median + 2),
        median: String(median),
      });
    }

    beforeEach(async () => {
      await resetRealPostgresDb(db);
      const [author] = await db
        .insert(users)
        .values({ email: 'author@example.com', username: 'author', role: 'editor' })
        .returning({ id: users.id });
      authorId = author!.id;

      scannedDrug = await seedDrug('legemiddel-skannet');
      lateDrug = await seedDrug('legemiddel-sent');
      paper = await seedCitation('pmid', '24500275');
      otherPaper = await seedCitation('pmid', '18000001');
      await db.insert(paperReviews).values([
        { citationId: paper, reviewMarkdown: 'Sammendrag.', overallScore: OLD_SCORE, createdBy: authorId },
        { citationId: otherPaper, reviewMarkdown: 'Sammendrag.', overallScore: OLD_SCORE, createdBy: authorId },
      ]);
      await seedEntry(scannedDrug, paper, 30);
      await seedEntry(lateDrug, otherPaper, STALE_MEDIAN);
      // Publish both drugs' caches as they stand, so a later no-op recompute
      // means "already current" rather than "nothing to publish".
      await runInPoolTransaction(async () => {
        await recomputeAndCacheParameterSummary(scannedDrug, 'halfLife', authorId);
        await recomputeAndCacheParameterSummary(lateDrug, 'halfLife', authorId);
      });
    });

    /** Resolve once another backend is blocked on a lock, its query naming `fragment`. */
    async function blockedOn(fragment: string): Promise<void> {
      const deadline = Date.now() + LOCK_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const result = await db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query ILIKE ${`%${fragment}%`}
        `);
        if ((result.rows[0]?.n ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`no backend blocked on ${fragment} within ${LOCK_TIMEOUT_MS}ms`);
    }

    const RESCORED = 'Sammendrag, vurdert på nytt.';

    function rescoreReview() {
      return recordPaperReview({
        citationId: paper,
        authorUserId: authorId,
        input: {
          reviewMarkdown: RESCORED,
          overallScore: NEW_SCORE,
          conclusionSupport: null,
          reviewConfidence: null,
          readInFull: false,
        },
      });
    }

    /**
     * A re-score that has returned — scanned, written, recomputed — and is
     * paused before its commit: the window the bug lives in.
     */
    function rescorePausedBeforeCommit() {
      const rescored = gate();
      const commit = gate();
      const done = runInPoolTransaction(async () => {
        await rescoreReview();
        rescored.open();
        await commit.wait;
      });
      held.push({ release: commit.open, done });
      return { rescored: rescored.wait, commit: commit.open, done };
    }

    /**
     * A source value on the late drug citing the paper, filed the way the
     * entry route files one: drug lock, insert through the store, recompute.
     */
    function fileEntryThroughStore(citationId = paper) {
      return runInPoolTransaction(async () => {
        await lockDrugForEntryApplicability(lateDrug);
        await insertParameterEntry(
          {
            drugId: lateDrug,
            parameter: 'halfLife',
            unit: 'h',
            low: FRESH_MEDIAN - 2,
            high: FRESH_MEDIAN + 2,
            median: FRESH_MEDIAN,
            citationId,
          },
          authorId,
        );
        await recomputeAndCacheParameterSummary(lateDrug, 'halfLife', authorId);
      });
    }

    /** The late drug's cached pooled half-life. */
    async function cachedMedian(): Promise<number | undefined> {
      const [row] = await db
        .select({ value: drugParameters.value })
        .from(drugParameters)
        .where(and(eq(drugParameters.drugId, lateDrug), eq(drugParameters.parameter, 'halfLife')));
      return (row?.value as { median?: number } | null)?.median;
    }

    /** Recompute the late drug from scratch; a revision id means the cache was stale. */
    function recomputeFromScratch(): Promise<number | null> {
      return runInPoolTransaction(() =>
        recomputeAndCacheParameterSummary(lateDrug, 'halfLife', authorId),
      );
    }

    describe('a source value filed while a re-score of its paper is uncommitted', () => {
      it(
        'waits for the re-score to commit, then pools the new score',
        async () => {
          const rescore = rescorePausedBeforeCommit();
          await rescore.rescored;

          const filing = fileEntryThroughStore();
          await blockedOn('pg_advisory_xact_lock_shared');
          rescore.commit();
          await Promise.all([rescore.done, filing]);

          expect(await cachedMedian()).toBe(FRESH_MEDIAN);
          expect(await recomputeFromScratch()).toBeNull();
        },
        LOCK_TIMEOUT_MS * 3,
      );

      it(
        'without the key (by hand), the same race really does leave the cached value stale',
        async () => {
          const rescore = rescorePausedBeforeCommit();
          await rescore.rescored;

          // The pre-fix insert: drug lock, the row, the recompute — no key, so
          // nothing makes it wait, and it reads the score the re-score is
          // replacing. It commits after the re-score's last scan.
          await runInPoolTransaction(async () => {
            await lockDrugForEntryApplicability(lateDrug);
            await getDb().insert(parameterEntries).values({
              drugId: lateDrug,
              parameter: 'halfLife',
              citationId: paper,
              unit: 'h',
              low: String(FRESH_MEDIAN - 2),
              high: String(FRESH_MEDIAN + 2),
              median: String(FRESH_MEDIAN),
              createdBy: authorId,
            });
            await recomputeAndCacheParameterSummary(lateDrug, 'halfLife', authorId);
          });
          rescore.commit();
          await rescore.done;

          expect(await cachedMedian()).toBe(STALE_MEDIAN);
          expect(await recomputeFromScratch()).not.toBeNull();
          expect(await cachedMedian()).toBe(FRESH_MEDIAN);
        },
        LOCK_TIMEOUT_MS * 3,
      );

      it(
        'meets the key before the re-score has written anything',
        async () => {
          // Pause the re-score at its first write, the review upsert.
          const reviewTaken = gate();
          const reviewRelease = gate();
          const reviewHold = runInPoolTransaction(async () => {
            await getDb().execute(
              sql`SELECT id FROM paper_reviews WHERE citation_id = ${paper} FOR UPDATE`,
            );
            reviewTaken.open();
            await reviewRelease.wait;
          });
          held.push({ release: reviewRelease.open, done: reviewHold });
          await reviewTaken.wait;
          const rescoring = runInPoolTransaction(() => rescoreReview());
          await blockedOn('paper_reviews');

          // The re-score already holds the paper's key: the source value waits
          // for it rather than for the review row it has not reached.
          const filing = fileEntryThroughStore();
          await blockedOn('pg_advisory_xact_lock_shared');
          reviewRelease.open();
          await Promise.all([reviewHold, rescoring, filing]);

          expect(await cachedMedian()).toBe(FRESH_MEDIAN);
          expect(await recomputeFromScratch()).toBeNull();
        },
        LOCK_TIMEOUT_MS * 3,
      );
    });

    /** A source value citing `citationId`, filed through the store and paused before its commit. */
    function entryPausedBeforeCommit(citationId: number) {
      const inserted = gate();
      const commit = gate();
      const done = runInPoolTransaction(async () => {
        await lockDrugForEntryApplicability(lateDrug);
        await insertParameterEntry(
          {
            drugId: lateDrug,
            parameter: 'halfLife',
            unit: 'h',
            low: FRESH_MEDIAN - 2,
            high: FRESH_MEDIAN + 2,
            median: FRESH_MEDIAN,
            citationId,
          },
          authorId,
        );
        await recomputeAndCacheParameterSummary(lateDrug, 'halfLife', authorId);
        inserted.open();
        await commit.wait;
      });
      held.push({ release: commit.open, done });
      return { inserted: inserted.wait, commit: commit.open, done };
    }

    describe('a re-score while a source value citing the paper is in flight', () => {
      for (const drugLocks of ['wait', 'try'] as const) {
        it(
          `refuses with no drug named, writing nothing (drugLocks: '${drugLocks}')`,
          async () => {
            const entry = entryPausedBeforeCommit(paper);
            await entry.inserted;

            const outcome = await runInPoolTransaction(() =>
              recordPaperReview({
                citationId: paper,
                authorUserId: authorId,
                input: {
                  reviewMarkdown: RESCORED,
                  overallScore: NEW_SCORE,
                  conclusionSupport: null,
                  reviewConfidence: null,
                  readInFull: false,
                },
                drugLocks,
              }),
            ).then(
              () => null,
              (err: unknown) => err,
            );
            expect(outcome).toBeInstanceOf(PaperReviewDrugLockedError);
            expect(outcome).toMatchObject({
              citationId: paper,
              drugId: null,
              statusHint: 409,
              code: 'paper_review_drug_locked',
            });

            const reviews = await db
              .select({ overallScore: paperReviews.overallScore })
              .from(paperReviews)
              .where(eq(paperReviews.citationId, paper));
            expect(reviews).toEqual([{ overallScore: OLD_SCORE }]);
            const revisions = await db
              .select({ id: paperReviewRevisions.id })
              .from(paperReviewRevisions)
              .where(eq(paperReviewRevisions.reviewMarkdown, RESCORED));
            expect(revisions).toEqual([]);

            // Once the source value has committed, the re-score records and
            // reaches the late drug it now cites.
            entry.commit();
            await entry.done;
            await runInPoolTransaction(() => rescoreReview());
            expect(await cachedMedian()).toBe(FRESH_MEDIAN);
            expect(await recomputeFromScratch()).toBeNull();
          },
          LOCK_TIMEOUT_MS * 3,
        );
      }
    });

    describe('a fold while a source value citing the loser is in flight', () => {
      let loser: number;

      beforeEach(async () => {
        loser = await seedCitation('doi', '10.1000/split-paper');
        await db.insert(paperReviews).values({
          citationId: loser,
          reviewMarkdown: 'Lest i sin helhet.',
          overallScore: NEW_SCORE,
          readInFull: true,
          createdBy: authorId,
        });
      });

      it(
        "defers as 'entry_in_flight' with nothing written, and folds once it has committed",
        async () => {
          const entry = entryPausedBeforeCommit(loser);
          await entry.inserted;

          const fold = await runInPoolTransaction(() =>
            mergeCitations(getDb(), paper, loser, { actorUserId: authorId }),
          );
          expect(fold).toMatchObject<Partial<CitationMergeStats>>({
            deferred: true,
            deferredReason: 'entry_in_flight',
            rowsRepointed: 0,
            reviewsDropped: 0,
          });
          const rows = await db.select({ id: citations.id }).from(citations);
          expect(rows.map((row) => row.id)).toContain(loser);
          const reviews = await db
            .select({ citationId: paperReviews.citationId, overallScore: paperReviews.overallScore })
            .from(paperReviews)
            .where(eq(paperReviews.citationId, paper));
          expect(reviews).toEqual([{ citationId: paper, overallScore: OLD_SCORE }]);

          entry.commit();
          await entry.done;

          const refold = await runInPoolTransaction(() =>
            mergeCitations(getDb(), paper, loser, { actorUserId: authorId }),
          );
          expect(refold.deferred).toBeUndefined();
          expect(refold.summaryRecompute).toBe('ran');
          const cited = await db
            .select({ citationId: parameterEntries.citationId })
            .from(parameterEntries)
            .where(eq(parameterEntries.drugId, lateDrug));
          expect(cited.map((row) => row.citationId).sort()).toEqual(
            [paper, otherPaper].sort(),
          );
          // The winner now carries the loser's read-in-full review (score
          // 90), and the late drug's entry, filed under the loser, is pooled
          // with it.
          expect(await cachedMedian()).toBe(FRESH_MEDIAN);
          expect(await recomputeFromScratch()).toBeNull();
        },
        LOCK_TIMEOUT_MS * 3,
      );
    });
  },
);

describe('the migrations workflow runs this suite against real Postgres', () => {
  it('has a database-enabled step naming this file', () => {
    const workflow = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', '.github', 'workflows', 'migrations.yml'),
      'utf8',
    );
    const assignment = new RegExp(`^\\s*${REAL_PG_URL_ENV}:\\s*\\S`, 'm');
    const steps = workflow
      .split(/^ {6}- name: /m)
      .filter((step) => assignment.test(step));
    expect(
      steps.some((step) =>
        step.includes('tests/governance/transaction/real-postgres-citation-membership-lock.test.ts'),
      ),
    ).toBe(true);
  });
});
