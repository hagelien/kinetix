/**
 * #243: the per-drug advisory lock against the extraction-job row lock, on two
 * real connections.
 *
 * Three paths take both locks:
 *
 * - **A paper-extraction fact filed on a drug monograph** (`POST
 *   /api/pending-edits`, the drug-scoped branch) takes the drug's advisory lock
 *   (`lockDrugForEntryApplicability`) and then re-checks the run's claim, which
 *   share-locks the job row (`liveClaimCitationId({ forShare: true })`).
 * - **A drug merge** (`mergeDrugs`) takes both drugs' advisory locks first and
 *   later rewrites `paper_extraction_jobs.target_drug_ids`.
 * - **A citation merge** (`mergeCitations`) locks the loser's open jobs
 *   (`lockLoserExtractionJobs`) and, at the end of the fold, recomputes the
 *   cached summaries of every drug whose entries cite the paper — which takes
 *   that drug's advisory lock. Every caller folds a whole duplicate group in
 *   one transaction, so the job rows an earlier fold locked (a deferred
 *   in-flight one included) are still held when a later fold reaches a drug.
 *
 * The first two order drug before job; the citation merge ordered job before
 * drug, and each pairing closed a wait-for cycle Postgres broke by aborting
 * one side with `deadlock_detected` (40P01). The fix puts the citation merge
 * on the same order: it tries the drug locks its recompute will need before it
 * locks any job row, and stands the fold aside (`drug_locked`) rather than
 * wait for one, since it may hold job rows from an earlier fold.
 *
 * Each race has a negative control — the pre-fix order, by hand, against the
 * same holder — so a green fix test cannot be read as "nothing was contended".
 *
 * PGlite has one connection and cannot deadlock with itself; this suite skips
 * without `KINETIX_TEST_PG_URL` and never falls back to it. The `migrations`
 * workflow runs it against a service container (asserted below).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
vi.mock('../../../api/_lib/auth.js', () => ({ getUserFromRequest: authMock }));

import handler from '../../../api/pending-edits.js';
import { getDb, runInPoolTransaction } from '../../../api/_lib/db.js';
import { mergeCitations, type CitationMergeStats } from '../../../api/_lib/citation-merge.js';
import { mergeDrugs } from '../../../api/_lib/drug-merge.js';
import { liveClaimCitationId } from '../../../api/_lib/paper-extraction-store.js';
import { recordPaperReview } from '../../../api/_lib/paper-review-store.js';
import { lockDrugForEntryApplicability } from '../../../api/_lib/parameterApplicabilityStore.js';
import {
  agents,
  citations,
  drugParameterRevisions,
  drugParameters,
  drugs,
  paperExtractionJobs,
  paperReviews,
  parameterEntries,
  pendingEdits,
  users,
  wikiPages,
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

/** SQLSTATE Postgres uses for a cycle its own deadlock detector breaks. */
const DEADLOCK_DETECTED = '40P01';

const hasRealPostgres = realPostgresUrl() !== null;

const TOKEN = 'b'.repeat(32);

/** A promise plus the function that settles it — a gate one side waits on. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** The SQLSTATE behind a rejection, through drizzle's query-error wrapper. */
function sqlState(reason: unknown): string | undefined {
  const err = reason as { code?: string; cause?: { code?: string } } | undefined;
  return err?.cause?.code ?? err?.code;
}

describe.skipIf(!hasRealPostgres)(
  'per-drug advisory lock vs. extraction-job row lock (#243)',
  () => {
    let db: RealPostgresDb;
    let authorId: number;
    let agentId: number;
    /** The drug whose monograph the fact lands on and whose entry cites the paper. */
    let drugId: number;
    let pageId: number;
    /** The surviving citation of the duplicate group. */
    let winner: number;

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

    /** A source entry on `drug` citing `citationId`: folding it moves a summary input. */
    async function seedEntry(drug: number, citationId: number): Promise<void> {
      await db.insert(parameterEntries).values({
        drugId: drug,
        parameter: 'halfLife',
        citationId,
        unit: 'h',
        low: '3',
        high: '5',
      });
    }

    beforeEach(async () => {
      await resetRealPostgresDb(db);
      authMock.mockReset();

      const [author] = await db
        .insert(users)
        .values({ email: 'author@example.com', username: 'author', role: 'editor' })
        .returning({ id: users.id });
      authorId = author!.id;
      const [agent] = await db
        .insert(users)
        .values({ email: 'extractor@example.com', username: 'extractor', role: 'contributor' })
        .returning({ id: users.id });
      agentId = agent!.id;
      await db
        .insert(agents)
        .values({ userId: agentId, name: 'extractor', slug: 'extractor', status: 'active' });

      drugId = await seedDrug('legemiddel');
      const [page] = await db
        .insert(wikiPages)
        .values({
          slug: 'legemiddel',
          title: 'Legemiddel',
          content: {
            type: 'doc',
            content: [
              {
                type: 'heading',
                attrs: { sectionId: 'pk', level: 2 },
                content: [{ type: 'text', text: 'Farmakokinetikk' }],
              },
            ],
          },
          pageType: 'drug_monograph',
          drugCid: drugId,
          status: 'published',
          createdBy: authorId,
          updatedBy: authorId,
        })
        .returning({ id: wikiPages.id });
      pageId = page!.id;

      winner = await seedCitation('pmid', '24500275');
    });

    /** Resolve once another backend is blocked on a lock, its query naming `table`. */
    async function blockedOn(table: string): Promise<void> {
      const deadline = Date.now() + LOCK_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const result = await db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query ILIKE ${`%${table}%`}
        `);
        if ((result.rows[0]?.n ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`no backend blocked on ${table} within ${LOCK_TIMEOUT_MS}ms`);
    }

    /**
     * Fold a duplicate group the way `resolveCitation` and the admin merge
     * route do — every duplicate into the survivor, one transaction — paused
     * after the first fold. The pause stands in for the ordinary gap between
     * loop iterations, widened so the other side can be placed in it. `then`
     * is what the transaction does after the pause: the real second fold, or
     * a hand-written stand-in for the pre-fix one.
     */
    function mergeGroupPausedAfterFirstFold<T>(
      firstLoser: number,
      then: () => Promise<T>,
    ) {
      const firstFolded = gate();
      const resume = gate();
      const done = runInPoolTransaction(async () => {
        const first = await mergeCitations(getDb(), winner, firstLoser, {
          actorUserId: authorId,
        });
        firstFolded.open();
        await resume.wait;
        return { first, second: await then() };
      });
      held.push({ release: resume.open, done });
      return { firstFolded: firstFolded.wait, resume: resume.open, done };
    }

    /** What the pre-fix second fold did on reaching its recompute: wait for the drug. */
    async function preFixRecomputeLock(): Promise<void> {
      await getDb().execute(sql`SELECT pg_advisory_xact_lock(${drugId}::bigint)`);
    }

    describe('a fact filed on the drug monograph by the run holding the job', () => {
      /** A duplicate the extraction run holds a claimed job on: its fold defers. */
      let heldLoser: number;
      /** A duplicate a source entry on the drug cites: its fold recomputes the drug. */
      let entryLoser: number;
      let jobId: number;

      beforeEach(async () => {
        const heldHandle = 'doi:10.1000/held';
        const [h] = await db
          .insert(citations)
          .values({
            type: 'doi',
            identifier: '10.1000/held',
            workKind: 'journal_article',
            workKindStatus: 'resolved',
            workKindHandles: [heldHandle],
            workKindVerdicts: [{ handle: heldHandle, kind: 'journal_article' }],
            workKindResolvedAt: new Date(),
          })
          .returning({ id: citations.id });
        heldLoser = h!.id;
        await db.insert(paperReviews).values({
          citationId: heldLoser,
          reviewMarkdown: 'Lest i sin helhet for faktauttrekket.',
          readInFull: true,
          createdBy: authorId,
        });
        entryLoser = await seedCitation('url', 'https://example.org/split-paper');
        await seedEntry(drugId, entryLoser);

        const [job] = await db
          .insert(paperExtractionJobs)
          .values({
            citationId: heldLoser,
            status: 'claimed',
            claimedBy: agentId,
            claimedAt: new Date(),
            claimToken: TOKEN,
            attempts: 1,
            requestedBy: authorId,
          })
          .returning({ id: paperExtractionJobs.id });
        jobId = job!.id;
      });

      async function submitFact(): Promise<{ statusCode: number; body: string }> {
        authMock.mockResolvedValue({ userId: agentId, role: 'contributor' });
        const state = { statusCode: 200, body: '' };
        const res = {
          headersSent: false,
          setHeader: vi.fn(),
          writeHead: vi.fn((statusCode: number) => {
            state.statusCode = statusCode;
            return res;
          }),
          end: vi.fn((body?: string) => {
            state.body = body ?? '';
            return res;
          }),
        } as unknown as ServerResponse;
        const raw = JSON.stringify({
          editType: 'wiki_fact',
          targetId: pageId,
          sectionId: 'pk',
          factOperation: 'add',
          factStatement: 'Halveringstiden er 30–56 timer hos voksne etter peroral dosering.',
          referenceIds: [heldLoser],
          paperExtraction: { jobId, claimToken: TOKEN },
        });
        const req = Readable.from([raw]) as IncomingMessage;
        req.method = 'POST';
        req.url = '/api/pending-edits';
        req.headers = {
          host: 'localhost',
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(raw)),
        };
        await handler(req, res);
        return state;
      }

      it(
        'files the fact and settles the merge, instead of deadlocking on drug vs. job',
        async () => {
          const merge = mergeGroupPausedAfterFirstFold(heldLoser, () =>
            mergeCitations(getDb(), winner, entryLoser, { actorUserId: authorId }),
          );
          await merge.firstFolded;

          // The merge holds the run's job row. The submission takes the drug
          // lock and waits for the job behind it.
          const submitting = submitFact();
          await blockedOn('paper_extraction_jobs');
          merge.resume();

          const [mergeOutcome, submitOutcome] = await Promise.allSettled([
            merge.done,
            submitting,
          ]);

          if (mergeOutcome.status === 'rejected') {
            expect(sqlState(mergeOutcome.reason)).not.toBe(DEADLOCK_DETECTED);
            throw mergeOutcome.reason;
          }
          expect(submitOutcome.status).toBe('fulfilled');
          const response = (submitOutcome as PromiseFulfilledResult<{
            statusCode: number;
            body: string;
          }>).value;
          expect(response.body).not.toContain('deadlock');
          expect(response.statusCode).toBe(201);

          const { first, second } = mergeOutcome.value as {
            first: CitationMergeStats;
            second: CitationMergeStats;
          };
          expect(first).toMatchObject({
            deferred: true,
            deferredReason: 'extraction_in_flight',
            inFlightExtractionJobId: jobId,
          });
          // The second fold needed the drug the submission held. It stood
          // aside before writing anything rather than waiting while the group
          // holds the job the submission is waiting for.
          expect(second).toMatchObject({
            deferred: true,
            deferredReason: 'drug_locked',
            lockedDrugId: drugId,
            rowsRepointed: 0,
          });

          const filed = await db
            .select({ targetId: pendingEdits.targetId, referenceId: pendingEdits.referenceId })
            .from(pendingEdits);
          expect(filed).toEqual([{ targetId: pageId, referenceId: heldLoser }]);

          // Nothing was half-applied: the entry still cites its own row, and
          // the pair folds cleanly once the drug is free.
          const refold = await runInPoolTransaction(() =>
            mergeCitations(getDb(), winner, entryLoser, { actorUserId: authorId }),
          );
          expect(refold.deferred).toBeUndefined();
          expect(refold.summaryRecompute).toBe('ran');
          const entries = await db
            .select({ citationId: parameterEntries.citationId })
            .from(parameterEntries);
          expect(entries).toEqual([{ citationId: winner }]);
        },
        LOCK_TIMEOUT_MS * 3,
      );

      it(
        'the pre-#243 merge order (job, then a waiting drug lock) really does deadlock against it',
        async () => {
          const merge = mergeGroupPausedAfterFirstFold(heldLoser, preFixRecomputeLock);
          await merge.firstFolded;

          // The drug-scoped branch's sequence, by hand: drug lock, then the
          // claim re-check that share-locks the job row.
          const drugLocked = gate();
          const fact = runInPoolTransaction(async () => {
            await lockDrugForEntryApplicability(drugId);
            drugLocked.open();
            return liveClaimCitationId({
              jobId,
              claimToken: TOKEN,
              userId: agentId,
              forShare: true,
            });
          });
          await drugLocked.wait;
          await blockedOn('paper_extraction_jobs');
          merge.resume();

          const outcomes = await Promise.allSettled([merge.done, fact]);
          const rejected = outcomes.filter(
            (o): o is PromiseRejectedResult => o.status === 'rejected',
          );
          // Exactly one side is Postgres's chosen victim; the other completes
          // once the victim's transaction aborts and releases its locks.
          expect(rejected).toHaveLength(1);
          expect(sqlState(rejected[0]!.reason)).toBe(DEADLOCK_DETECTED);
        },
        LOCK_TIMEOUT_MS * 3,
      );
    });

    describe('a drug merge rewriting the job the citation merge holds', () => {
      /** The drug being merged into `drugId`. Its entry and the job name it. */
      let mergedDrug: number;
      /** A duplicate with a queued job targeting `mergedDrug`: its fold moves the job. */
      let jobLoser: number;
      /** A duplicate a source entry on `mergedDrug` cites: its fold recomputes that drug. */
      let entryLoser: number;
      let jobId: number;

      beforeEach(async () => {
        mergedDrug = await seedDrug('legemiddel-duplikat');
        jobLoser = await seedCitation('doi', '10.1000/queued');
        entryLoser = await seedCitation('url', 'https://example.org/split-paper');
        await seedEntry(mergedDrug, entryLoser);
        const [job] = await db
          .insert(paperExtractionJobs)
          .values({
            citationId: jobLoser,
            status: 'queued',
            targetDrugIds: [mergedDrug],
            requestedBy: authorId,
          })
          .returning({ id: paperExtractionJobs.id });
        jobId = job!.id;
      });

      /**
       * Merge `mergedDrug` into `drugId` while the citation merge is paused.
       * It takes both drug locks up front and blocks when it reaches the job
       * row the first fold moved.
       */
      function startDrugMerge(): Promise<unknown> {
        return runInPoolTransaction(() =>
          mergeDrugs(getDb(), {
            winnerId: drugId,
            loserId: mergedDrug,
            resolutions: {},
            actorUserId: authorId,
            approvedPlanFingerprint: null,
          }),
        );
      }

      it(
        'finishes both merges, instead of deadlocking on drug vs. job',
        async () => {
          const merge = mergeGroupPausedAfterFirstFold(jobLoser, () =>
            mergeCitations(getDb(), winner, entryLoser, { actorUserId: authorId }),
          );
          await merge.firstFolded;

          const drugMerge = startDrugMerge();
          await blockedOn('paper_extraction_jobs');
          merge.resume();

          const [citationOutcome, drugOutcome] = await Promise.allSettled([
            merge.done,
            drugMerge,
          ]);
          for (const outcome of [citationOutcome, drugOutcome]) {
            if (outcome.status === 'rejected') {
              expect(sqlState(outcome.reason)).not.toBe(DEADLOCK_DETECTED);
              throw outcome.reason;
            }
          }

          const { first, second } = (citationOutcome as PromiseFulfilledResult<{
            first: CitationMergeStats;
            second: CitationMergeStats;
          }>).value;
          expect(first.deferred).toBeUndefined();
          expect(second).toMatchObject({
            deferred: true,
            deferredReason: 'drug_locked',
            lockedDrugId: mergedDrug,
          });

          const [job] = await db
            .select({
              citationId: paperExtractionJobs.citationId,
              targetDrugIds: paperExtractionJobs.targetDrugIds,
            })
            .from(paperExtractionJobs)
            .where(eq(paperExtractionJobs.id, jobId));
          expect(job).toEqual({ citationId: winner, targetDrugIds: [drugId] });
          const entries = await db
            .select({ drugId: parameterEntries.drugId, citationId: parameterEntries.citationId })
            .from(parameterEntries);
          expect(entries).toEqual([{ drugId, citationId: entryLoser }]);
        },
        LOCK_TIMEOUT_MS * 3,
      );

      it(
        'the pre-#243 merge order (job, then a waiting drug lock) really does deadlock against it',
        async () => {
          const merge = mergeGroupPausedAfterFirstFold(jobLoser, async () => {
            await getDb().execute(
              sql`SELECT pg_advisory_xact_lock(${mergedDrug}::bigint)`,
            );
          });
          await merge.firstFolded;

          const drugMerge = startDrugMerge();
          await blockedOn('paper_extraction_jobs');
          merge.resume();

          const outcomes = await Promise.allSettled([merge.done, drugMerge]);
          const rejected = outcomes.filter(
            (o): o is PromiseRejectedResult => o.status === 'rejected',
          );
          expect(rejected).toHaveLength(1);
          expect(sqlState(rejected[0]!.reason)).toBe(DEADLOCK_DETECTED);
        },
        LOCK_TIMEOUT_MS * 3,
      );
    });

    // Taking the drug locks at the start of a fold means the merge now holds
    // them while it rewrites review rows. A re-score that wrote its review row
    // first and reached the drug only at its recompute would turn that into a
    // new cycle, so `recordPaperReview` takes the drugs first too.
    describe('a re-score of the surviving paper racing a later fold', () => {
      /** A duplicate a source entry on the drug cites: its fold takes the drug lock. */
      let entryLoser: number;
      /** A duplicate whose read-in-full review displaces the winner's. */
      let reviewLoser: number;

      beforeEach(async () => {
        // The winner's own entry is what makes the re-score recompute the drug.
        await seedEntry(drugId, winner);
        entryLoser = await seedCitation('url', 'https://example.org/split-paper');
        await seedEntry(drugId, entryLoser);
        reviewLoser = await seedCitation('doi', '10.1000/reviewed');
        await db.insert(paperReviews).values([
          { citationId: winner, reviewMarkdown: 'Sammendrag.', overallScore: 50, createdBy: authorId },
          {
            citationId: reviewLoser,
            reviewMarkdown: 'Lest i sin helhet.',
            overallScore: 70,
            readInFull: true,
            createdBy: authorId,
          },
        ]);
      });

      it(
        'records the re-score after the merge, instead of deadlocking on drug vs. review',
        async () => {
          const merge = mergeGroupPausedAfterFirstFold(entryLoser, () =>
            mergeCitations(getDb(), winner, reviewLoser, { actorUserId: authorId }),
          );
          await merge.firstFolded;

          // The route's transaction around the review write.
          const rescore = runInPoolTransaction(() =>
            recordPaperReview({
              citationId: winner,
              authorUserId: authorId,
              input: {
                reviewMarkdown: 'Sammendrag, vurdert på nytt.',
                overallScore: 60,
                conclusionSupport: null,
                reviewConfidence: null,
                readInFull: false,
              },
            }),
          );
          // Waiting for the drug the first fold took, holding no review row.
          await blockedOn('pg_advisory_xact_lock');
          merge.resume();

          const [mergeOutcome, rescoreOutcome] = await Promise.allSettled([
            merge.done,
            rescore,
          ]);
          for (const outcome of [mergeOutcome, rescoreOutcome]) {
            if (outcome.status === 'rejected') {
              expect(sqlState(outcome.reason)).not.toBe(DEADLOCK_DETECTED);
              throw outcome.reason;
            }
          }
          const { first, second } = (mergeOutcome as PromiseFulfilledResult<{
            first: CitationMergeStats;
            second: CitationMergeStats;
          }>).value;
          expect(first).toMatchObject({ summaryRecompute: 'ran' });
          expect(first.deferred).toBeUndefined();
          expect(second).toMatchObject({ reviewsDropped: 1, summaryRecompute: 'ran' });
          expect(second.deferred).toBeUndefined();

          // The re-score landed on the review the winner kept.
          const reviews = await db
            .select({ citationId: paperReviews.citationId, overallScore: paperReviews.overallScore })
            .from(paperReviews);
          expect(reviews).toEqual([{ citationId: winner, overallScore: 60 }]);
        },
        LOCK_TIMEOUT_MS * 3,
      );

      it(
        'the pre-#243 re-score order (review row, then a waiting drug lock) really does deadlock against it',
        async () => {
          const merge = mergeGroupPausedAfterFirstFold(entryLoser, () =>
            mergeCitations(getDb(), winner, reviewLoser, { actorUserId: authorId }),
          );
          await merge.firstFolded;

          const rescore = runInPoolTransaction(async () => {
            await getDb()
              .update(paperReviews)
              .set({ overallScore: 60 })
              .where(eq(paperReviews.citationId, winner));
            await getDb().execute(sql`SELECT pg_advisory_xact_lock(${drugId}::bigint)`);
          });
          await blockedOn('pg_advisory_xact_lock');
          merge.resume();

          const outcomes = await Promise.allSettled([merge.done, rescore]);
          const rejected = outcomes.filter(
            (o): o is PromiseRejectedResult => o.status === 'rejected',
          );
          expect(rejected).toHaveLength(1);
          expect(sqlState(rejected[0]!.reason)).toBe(DEADLOCK_DETECTED);
        },
        LOCK_TIMEOUT_MS * 3,
      );
    });

    // The up-front scan covers the entries citing the pair when the fold
    // starts. An entry on another drug can cite the winner by the recompute,
    // and the fold only tries that drug's lock then too (it may hold job rows).
    // If another writer holds it, committing the fold would leave that drug's
    // summary pooled from weights the fold moved, with nothing due to refresh
    // it — so the fold's writes are rolled back to their savepoint instead.
    describe('a drug whose first entry citing the winner lands mid-fold', () => {
      /** A duplicate with an entry on `drugId` and the review the winner inherits. */
      let loser: number;
      /** The drug whose entry lands mid-fold. */
      let lateDrug: number;
      /** A proposal citing the loser: holding it pauses the fold after its lock scan. */
      let proposalId: number;

      beforeEach(async () => {
        loser = await seedCitation('doi', '10.1000/split-review');
        await seedEntry(drugId, loser);
        await db.insert(paperReviews).values({
          citationId: loser,
          reviewMarkdown: 'Lest i sin helhet.',
          overallScore: 70,
          readInFull: true,
          createdBy: authorId,
        });
        lateDrug = await seedDrug('legemiddel-sent');
        const [proposal] = await db
          .insert(pendingEdits)
          .values({
            editType: 'wiki_fact',
            targetId: pageId,
            referenceId: loser,
            proposedValue: { factStatement: 'Halveringstiden er 3–5 timer.' },
            submittedBy: authorId,
          })
          .returning({ id: pendingEdits.id });
        proposalId = proposal!.id;
      });

      /** Run `take` in a transaction of its own and hold it open until released. */
      function holdInTransaction(take: () => Promise<unknown>) {
        const taken = gate();
        const release = gate();
        const done = runInPoolTransaction(async () => {
          await take();
          taken.open();
          await release.wait;
        });
        held.push({ release: release.open, done });
        return { taken: taken.wait, release: release.open, done };
      }

      async function snapshot() {
        const cits = await db.select({ id: citations.id }).from(citations);
        const entries = await db
          .select({ drugId: parameterEntries.drugId, citationId: parameterEntries.citationId })
          .from(parameterEntries);
        const reviews = await db
          .select({ citationId: paperReviews.citationId })
          .from(paperReviews);
        const proposals = await db
          .select({ id: pendingEdits.id, referenceId: pendingEdits.referenceId })
          .from(pendingEdits);
        const summaries = await db
          .select({ drugId: drugParameters.drugId, parameter: drugParameters.parameter })
          .from(drugParameters);
        const revisions = await db
          .select({ id: drugParameterRevisions.id })
          .from(drugParameterRevisions);
        return {
          citations: cits.map((r) => r.id).sort((a, b) => a - b),
          entries: entries.map((r) => `${r.drugId}:${r.citationId}`).sort(),
          reviews: reviews.map((r) => r.citationId),
          proposals,
          summaries: summaries.map((r) => `${r.drugId}:${r.parameter}`).sort(),
          revisions: revisions.length,
        };
      }

      it(
        'defers with nothing of the fold written while that drug stays locked, then folds',
        async () => {
          // Pauses the fold at its proposal lock: after the up-front drug scan
          // (which finds only `drugId`), before any row the fold rewrites.
          const proposalHold = holdInTransaction(() =>
            getDb().execute(
              sql`SELECT id FROM pending_edits WHERE id = ${proposalId} FOR UPDATE`,
            ),
          );
          await proposalHold.taken;

          const folding = runInPoolTransaction(() =>
            mergeCitations(getDb(), winner, loser, { actorUserId: authorId }),
          );
          await blockedOn('pending_edits');

          // Meanwhile another writer's entry on the late drug, citing the
          // winner, commits; and some write on that drug holds its lock.
          await seedEntry(lateDrug, winner);
          const drugHold = holdInTransaction(() =>
            getDb().execute(sql`SELECT pg_advisory_xact_lock(${lateDrug}::bigint)`),
          );
          await drugHold.taken;
          const before = await snapshot();

          proposalHold.release();
          const stats = await folding;

          expect(stats).toMatchObject({
            deferred: true,
            deferredReason: 'drug_locked',
            lockedDrugId: lateDrug,
            rowsRepointed: 0,
            reviewsDropped: 0,
            summaryRecompute: 'not-needed',
          });
          // The fold got as far as its recompute — every write made — and
          // rolled all of it back: nothing moved, nothing recomputed.
          expect(await snapshot()).toEqual(before);
          expect(before.citations).toEqual([winner, loser].sort((a, b) => a - b));
          expect(before.reviews).toEqual([loser]);
          expect(before.proposals).toEqual([{ id: proposalId, referenceId: loser }]);

          // Once the drug is free the pair folds, and the recompute covers the
          // late drug as well as the one locked up front.
          drugHold.release();
          await drugHold.done;
          const refold = await runInPoolTransaction(() =>
            mergeCitations(getDb(), winner, loser, { actorUserId: authorId }),
          );
          expect(refold.deferred).toBeUndefined();
          expect(refold.summaryRecompute).toBe('ran');
          const after = await snapshot();
          expect(after.citations).toEqual([winner]);
          expect(after.entries).toEqual(
            [`${drugId}:${winner}`, `${lateDrug}:${winner}`].sort(),
          );
          expect(after.reviews).toEqual([winner]);
          expect(after.proposals).toEqual([{ id: proposalId, referenceId: winner }]);
          expect(after.summaries).toEqual(
            [`${drugId}:halfLife`, `${lateDrug}:halfLife`].sort(),
          );
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
        step.includes('tests/governance/transaction/real-postgres-extraction-drug-lock-order.test.ts'),
      ),
    ).toBe(true);
  });
});
