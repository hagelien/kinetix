/**
 * #246: conversation ingestion's review write against the extraction-job row
 * lock, on two real connections.
 *
 * `commitSourcesFor` resolves each source of an item and records its review in
 * one transaction. A resolution can fold duplicates, and a fold locks the
 * loser's open extraction jobs (`lockLoserExtractionJobs`) — a claimed one is
 * held even when the fold then defers as `extraction_in_flight`. The review
 * write that follows re-scores the paper, and its recompute takes the per-drug
 * lock of every drug whose entries cite it. It used to *wait* for those
 * (`recordPaperReview` → `lockDrugsCitingCitation`), which put this
 * transaction on job-then-drug: the order #243 removed from `mergeCitations`.
 * A drug-first writer — the drug-scoped branch of a paper-extraction fact
 * submission takes the drug lock and then share-locks the run's job row — that
 * holds the drug and waits for the job closes the cycle, and Postgres aborts
 * one side with `deadlock_detected` (40P01).
 *
 * The fix takes the drugs every row the item's sources can resolve to before
 * anything else (waiting is safe there: nothing is held yet), and lets the
 * review write only try them afterwards. The second race covers that
 * fallback: a drug whose entry lands after the up-front scan is not waited
 * for — the source commit refuses instead, and a re-run records it.
 *
 * Each race has a negative control (the pre-fix composition, by hand, against
 * the same holder), so a green fix test cannot be read as "nothing was
 * contended".
 *
 * PGlite has one connection and cannot deadlock with itself; this suite skips
 * without `KINETIX_TEST_PG_URL` and never falls back to it. The `migrations`
 * workflow runs it against a service container (asserted below).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';

/**
 * Pauses the ingestion right before its review write — after the source's
 * resolution has folded (and locked the job row) — when a test arms it.
 */
const pause = vi.hoisted(() => ({
  armed: null as null | { reached: () => void; resume: Promise<void> },
}));

vi.mock('../../../api/_lib/paper-review-store.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../api/_lib/paper-review-store.js')
  >();
  return {
    ...actual,
    recordPaperReview: async (args: Parameters<typeof actual.recordPaperReview>[0]) => {
      const armed = pause.armed;
      if (armed) {
        pause.armed = null;
        armed.reached();
        await armed.resume;
      }
      return actual.recordPaperReview(args);
    },
  };
});

import { getDb, runInPoolTransaction } from '../../../api/_lib/db.js';
import {
  applyIngestion,
  type IngestionApplyResult,
} from '../../../api/_lib/conversationIngestionStore.js';
import { resolveCitation } from '../../../api/_lib/citation-store.js';
import { ensureDrugMonograph } from '../../../api/_lib/monograph-helpers.js';
import { liveClaimCitationId } from '../../../api/_lib/paper-extraction-store.js';
import { recordPaperReview } from '../../../api/_lib/paper-review-store.js';
import { lockDrugForEntryApplicability } from '../../../api/_lib/parameterApplicabilityStore.js';
import { parseConversationIngestion } from '../../../src/lib/conversationIngestion.js';
import {
  agents,
  citations,
  drugs,
  paperExtractionJobs,
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

/** SQLSTATE Postgres uses for a cycle its own deadlock detector breaks. */
const DEADLOCK_DETECTED = '40P01';

const hasRealPostgres = realPostgresUrl() !== null;

const TOKEN = 'c'.repeat(32);
const WINNER_PMID = '24500275';
const HELD_DOI = '10.1000/held';

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

/**
 * One fact on the drug's monograph, citing one paper. The source names the
 * winner's PMID; the ID converter says its DOI is the held duplicate's, so the
 * resolution folds that duplicate into the winner.
 */
function ingestionBundle() {
  const parsed = parseConversationIngestion({
    schemaVersion: 'kinetix-conversation-ingestion-v1',
    idempotencyKey: 'conv-246',
    mode: 'auto',
    conversationDigest: 'd'.repeat(64),
    createdAt: '2026-10-14T09:00:00Z',
    sources: [
      {
        key: 'S1',
        type: 'pmid',
        identifier: WINNER_PMID,
        metadata: { title: 'Morphine pharmacokinetics', year: 2014 },
        verification: {
          readInFull: true,
          locator: 'Tabell 2',
          evidenceSummary: 'Halveringstiden var 2–4 timer hos voksne.',
          reviewMarkdown: 'Overkrysningsstudie med intravenøs referansearm.',
          reviewConfidence: 'medium',
          overallScore: 60,
        },
        pdfRequestNeeded: false,
      },
    ],
    items: [
      {
        type: 'wiki_fact',
        target: {
          pageType: 'monograph',
          drug: { drugName: 'Morphine', pubchemCid: 5288826 },
          sectionId: 'forensic',
        },
        operation: 'add',
        statement: 'Halveringstiden for morfin er 2–4 timer hos voksne.',
        sourceKeys: ['S1'],
        editSummary: 'Ny setning om halveringstid.',
      },
    ],
  });
  if (!parsed.ok) throw new Error(`bundle did not validate: ${parsed.errors.join('; ')}`);
  return parsed.data;
}

const CROSSWALK = new Map([['S1', { pmid: WINNER_PMID, doi: HELD_DOI }]]);

describe.skipIf(!hasRealPostgres)(
  'conversation ingestion review write vs. extraction-job row lock (#246)',
  () => {
    let db: RealPostgresDb;
    let adminId: number;
    let agentId: number;
    /** The monograph drug; the winner's entry is on it, so the re-score recomputes it. */
    let drugId: number;
    /** The surviving citation — the source's own PMID. */
    let winner: number;
    /** The duplicate the extraction run holds a claimed job on: its fold defers holding the job. */
    let heldLoser: number;
    let jobId: number;

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
      pause.armed = null;
      for (const hold of held) hold.release();
      await Promise.allSettled(held.map((hold) => hold.done));
      held = [];
    });

    async function seedDrug(slug: string, pubchemCid: number | null = null): Promise<number> {
      const [row] = await db
        .insert(drugs)
        .values({
          slug,
          names: { nb: slug, en: slug },
          ...(pubchemCid != null ? { pubchemCid } : {}),
        })
        .returning({ id: drugs.id });
      return row!.id;
    }

    async function seedEntry(drug: number, citationId: number): Promise<void> {
      await db.insert(parameterEntries).values({
        drugId: drug,
        parameter: 'halfLife',
        citationId,
        unit: 'h',
        low: '2',
        high: '4',
      });
    }

    beforeEach(async () => {
      await resetRealPostgresDb(db);
      pause.armed = null;

      const [admin] = await db
        .insert(users)
        .values({ email: 'admin@example.com', username: 'admin', role: 'admin' })
        .returning({ id: users.id });
      adminId = admin!.id;
      const [agent] = await db
        .insert(users)
        .values({ email: 'extractor@example.com', username: 'extractor', role: 'contributor' })
        .returning({ id: users.id });
      agentId = agent!.id;
      await db
        .insert(agents)
        .values({ userId: agentId, name: 'extractor', slug: 'extractor', status: 'active' });

      const [drug] = await db
        .insert(drugs)
        .values({
          slug: 'morfin',
          names: { nb: 'Morfin', en: 'Morphine' },
          pubchemCid: 5288826,
          searchKey: 'morfin\tmorphine',
        })
        .returning({ id: drugs.id });
      drugId = drug!.id;
      await ensureDrugMonograph(
        getDb() as never,
        { id: drugId, names: { nb: 'Morfin', en: 'Morphine' } },
        adminId,
      );

      const [w] = await db
        .insert(citations)
        .values({ type: 'pmid', identifier: WINNER_PMID })
        .returning({ id: citations.id });
      winner = w!.id;
      await seedEntry(drugId, winner);
      // An unread appraisal with another score: the ingestion's read-in-full
      // one replaces it and re-scores the paper, so the review write recomputes
      // the drug.
      await db.insert(paperReviews).values({
        citationId: winner,
        reviewMarkdown: 'Bare sammendraget er lest.',
        overallScore: 50,
        readInFull: false,
        createdBy: adminId,
      });

      // Bare: no entry and no review, so its fold needs no drug lock and goes
      // straight to the job scan.
      const [h] = await db
        .insert(citations)
        .values({ type: 'doi', identifier: HELD_DOI })
        .returning({ id: citations.id });
      heldLoser = h!.id;
      const [job] = await db
        .insert(paperExtractionJobs)
        .values({
          citationId: heldLoser,
          status: 'claimed',
          claimedBy: agentId,
          claimedAt: new Date(),
          claimToken: TOKEN,
          attempts: 1,
          requestedBy: adminId,
        })
        .returning({ id: paperExtractionJobs.id });
      jobId = job!.id;
    });

    /** Resolve once another backend is blocked on a lock, its query naming `text`. */
    async function blockedOn(text: string): Promise<void> {
      const deadline = Date.now() + LOCK_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const result = await db.execute<{ n: number }>(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query ILIKE ${`%${text}%`}
        `);
        if ((result.rows[0]?.n ?? 0) > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`no backend blocked on ${text} within ${LOCK_TIMEOUT_MS}ms`);
    }

    /**
     * The drug-scoped branch of a paper-extraction fact submission, by hand so
     * the test can hold it between its two locks: the drug's advisory lock,
     * then the claim re-check that share-locks the run's job row.
     */
    function drugFirstWriter(lockedDrug: number) {
      const drugLocked = gate();
      const proceed = gate();
      const done = runInPoolTransaction(async () => {
        await lockDrugForEntryApplicability(lockedDrug);
        drugLocked.open();
        await proceed.wait;
        return liveClaimCitationId({
          jobId,
          claimToken: TOKEN,
          userId: agentId,
          forShare: true,
        });
      });
      held.push({ release: proceed.open, done });
      return { drugLocked: drugLocked.wait, proceed: proceed.open, done };
    }

    function ingest(): Promise<IngestionApplyResult> {
      return applyIngestion(ingestionBundle(), {
        userId: adminId,
        accept: [0],
        crosswalk: CROSSWALK as never,
      });
    }

    async function reviewOfWinner() {
      const [review] = await db
        .select({ overallScore: paperReviews.overallScore, readInFull: paperReviews.readInFull })
        .from(paperReviews)
        .where(sql`${paperReviews.citationId} = ${winner}`);
      return review;
    }

    describe('a drug-first writer holding the drug the re-score recomputes', () => {
      it(
        'records the review after the writer, instead of deadlocking on drug vs. job',
        async () => {
          const writer = drugFirstWriter(drugId);
          await writer.drugLocked;

          const ingesting = ingest();
          // The ingestion waits for the drug. Fixed, it does so before its
          // fold has locked anything; pre-fix, only at the review write, with
          // the fold's job row already held.
          await blockedOn('pg_advisory_xact_lock');
          writer.proceed();

          const [ingestOutcome, writerOutcome] = await Promise.allSettled([
            ingesting,
            writer.done,
          ]);
          if (writerOutcome.status === 'rejected') {
            expect(sqlState(writerOutcome.reason)).not.toBe(DEADLOCK_DETECTED);
            throw writerOutcome.reason;
          }
          // The claim check found the run's job, unblocked.
          expect(writerOutcome.value).toBe(heldLoser);

          if (ingestOutcome.status === 'rejected') throw ingestOutcome.reason;
          // A deadlock victim here surfaces as a failed item whose detail is
          // the aborted drug-lock query, not as a rejection.
          const [item] = ingestOutcome.value.items;
          expect(item, item?.detail ?? undefined).toMatchObject({ status: 'applied' });
          expect(ingestOutcome.value.reviewsRecorded).toBe(1);

          // The fold stood aside for the run's job, and the review landed on
          // the surviving row.
          const jobs = await db
            .select({ citationId: paperExtractionJobs.citationId })
            .from(paperExtractionJobs);
          expect(jobs).toEqual([{ citationId: heldLoser }]);
          expect(await reviewOfWinner()).toEqual({ overallScore: 60, readInFull: true });
        },
        LOCK_TIMEOUT_MS * 3,
      );

      it(
        'the pre-#246 order (fold, then a review write waiting for the drug) really does deadlock against it',
        async () => {
          const writer = drugFirstWriter(drugId);
          await writer.drugLocked;

          // The pre-fix `commitSourcesFor` body: resolve (folding, which locks
          // the held job), then a review write that waits for its drugs.
          const ingesting = runInPoolTransaction(async () => {
            const resolved = await resolveCitation(
              getDb(),
              {
                type: 'pmid',
                identifier: WINNER_PMID,
                metadata: { altIds: { doi: HELD_DOI } },
                crosswalk: { pmid: WINNER_PMID, doi: HELD_DOI },
              },
              adminId,
            );
            return recordPaperReview({
              citationId: resolved.id,
              authorUserId: adminId,
              input: {
                reviewMarkdown: 'Lest i sin helhet.',
                overallScore: 60,
                conclusionSupport: null,
                reviewConfidence: null,
                readInFull: true,
              },
            });
          });
          await blockedOn('pg_advisory_xact_lock');
          writer.proceed();

          const outcomes = await Promise.allSettled([ingesting, writer.done]);
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

    // The up-front scan can only see entries that exist when it runs. One that
    // lands between it and the review write brings a drug this transaction
    // does not hold — and by then it holds the fold's job row, so the review
    // write must not wait for it.
    describe('a drug whose entry lands after the up-front lock scan', () => {
      /** A second drug, cited by an entry added while the ingestion is paused. */
      let lateDrug: number;

      beforeEach(async () => {
        lateDrug = await seedDrug('kodein');
      });

      /** Pause the ingestion after its fold, add the late entry, then park the writer on the job. */
      async function raceLateDrug() {
        const reached = gate();
        const resume = gate();
        pause.armed = { reached: reached.open, resume: resume.wait };
        const ingesting = ingest();
        held.push({ release: resume.open, done: ingesting });
        await reached.wait;

        await seedEntry(lateDrug, winner);
        const writer = drugFirstWriter(lateDrug);
        await writer.drugLocked;
        writer.proceed();
        // The writer holds the late drug and waits for the job the paused
        // fold holds.
        await blockedOn('paper_extraction_jobs');
        resume.open();
        return { ingesting, writer };
      }

      it(
        'refuses the source commit instead of waiting, and records it on a re-run',
        async () => {
          const { ingesting, writer } = await raceLateDrug();

          const [ingestOutcome, writerOutcome] = await Promise.allSettled([
            ingesting,
            writer.done,
          ]);
          if (writerOutcome.status === 'rejected') {
            expect(sqlState(writerOutcome.reason)).not.toBe(DEADLOCK_DETECTED);
            throw writerOutcome.reason;
          }
          expect(writerOutcome.value).toBe(heldLoser);

          if (ingestOutcome.status === 'rejected') throw ingestOutcome.reason;
          const [item] = ingestOutcome.value.items;
          expect(item).toMatchObject({ status: 'failed', reason: 'write_failed' });
          expect(item?.detail).toContain(`drug ${lateDrug}`);
          expect(item?.detail).toContain('locked by another write');
          // Refused before the review row: the commit rolled back whole.
          expect(await reviewOfWinner()).toEqual({ overallScore: 50, readInFull: false });

          // With the writer gone, a re-run takes both drugs up front and lands.
          const rerun = await ingest();
          expect(rerun.items[0]).toMatchObject({ status: 'applied' });
          expect(await reviewOfWinner()).toEqual({ overallScore: 60, readInFull: true });
        },
        LOCK_TIMEOUT_MS * 3,
      );

      it(
        'the pre-#246 review write (waiting for the late drug) really does deadlock against it',
        async () => {
          // The same race with the review write's drug locks taken the old way.
          const reached = gate();
          const resume = gate();
          const ingesting = runInPoolTransaction(async () => {
            await resolveCitation(
              getDb(),
              {
                type: 'pmid',
                identifier: WINNER_PMID,
                metadata: { altIds: { doi: HELD_DOI } },
                crosswalk: { pmid: WINNER_PMID, doi: HELD_DOI },
              },
              adminId,
            );
            reached.open();
            await resume.wait;
            return recordPaperReview({
              citationId: winner,
              authorUserId: adminId,
              input: {
                reviewMarkdown: 'Lest i sin helhet.',
                overallScore: 60,
                conclusionSupport: null,
                reviewConfidence: null,
                readInFull: true,
              },
              drugLocks: 'wait',
            });
          });
          held.push({ release: resume.open, done: ingesting });
          await reached.wait;

          await seedEntry(lateDrug, winner);
          const writer = drugFirstWriter(lateDrug);
          await writer.drugLocked;
          writer.proceed();
          await blockedOn('paper_extraction_jobs');
          resume.open();

          const outcomes = await Promise.allSettled([ingesting, writer.done]);
          const rejected = outcomes.filter(
            (o): o is PromiseRejectedResult => o.status === 'rejected',
          );
          expect(rejected).toHaveLength(1);
          expect(sqlState(rejected[0]!.reason)).toBe(DEADLOCK_DETECTED);
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
        step.includes(
          'tests/governance/transaction/real-postgres-ingestion-review-drug-lock-order.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
