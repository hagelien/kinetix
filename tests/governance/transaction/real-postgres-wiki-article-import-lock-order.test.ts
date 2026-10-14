/**
 * #247: a wiki article import racing a paper-extraction fact on the same
 * topic page, on two real connections.
 *
 * `applyWikiArticle` resolves the article's sources with `resolveCitation`,
 * which folds a split pair it finds — and a fold locks the loser's open
 * extraction jobs (`lockLoserExtractionJobs`, `FOR NO KEY UPDATE`; it used to
 * wait for a held one). The import used to do that *after* locking the page
 * `FOR UPDATE`: page, then job.
 *
 * #223 settled the other order. The topic-page branch of a paper-extraction
 * fact submission (`POST /api/pending-edits`) re-checks the run's claim with
 * its job row `FOR SHARE` and then share-locks the page. So a run filing a
 * fact on the page an article import is writing, citing the paper the import
 * folds, held the job and waited for the page, while the import held the page
 * and waited for the job: a cycle Postgres breaks by aborting one side with
 * `deadlock_detected` (40P01).
 *
 * The fix resolves the sources before the page lock, so the import is job
 * before page as well. And because a fold can still hold a page by then — an
 * earlier fold in the same transaction rewrites every page citing its loser
 * (`rewriteJsonDocuments`) — the fold's job lock is a try: a held job defers
 * the fold as in flight instead of being waited for. The tests drive the real
 * route (paused between its two locks, which is where the cycle closes)
 * against the real import, and against a transaction folding two pairs;
 * each has a negative control — the old wait, by hand, against the same
 * paused route — so a green test cannot be read as "nothing was contended".
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

/**
 * Pauses the route's page share lock — after its claim re-check has locked
 * the job row — when a test arms it. The import never calls this (it locks
 * the page `FOR UPDATE` itself), so only the route stops here.
 */
const pause = vi.hoisted(() => ({
  armed: null as null | { reached: () => void; resume: Promise<void> },
}));
vi.mock('../../../api/_lib/wiki-page-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/_lib/wiki-page-lock.js')>();
  return {
    ...actual,
    lockWikiPageShared: async (pageId: number) => {
      const armed = pause.armed;
      if (armed) {
        pause.armed = null;
        armed.reached();
        await armed.resume;
      }
      return actual.lockWikiPageShared(pageId);
    },
  };
});

import handler from '../../../api/pending-edits.js';
import { getDb, runInPoolTransaction } from '../../../api/_lib/db.js';
import { mergeCitations } from '../../../api/_lib/citation-merge.js';
import {
  applyWikiArticle,
  planWikiArticle,
} from '../../../api/_lib/wikiArticleImportStore.js';
import { wikiArticleSchema } from '../../../src/lib/wikiArticleImport.js';
import {
  agents,
  citations,
  paperExtractionJobs,
  paperReviews,
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

const TOKEN = 'e'.repeat(32);
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

/** One fact for the page's existing section, citing the winner's PMID. */
function articleBundle(pageId: number) {
  return wikiArticleSchema.parse({
    schemaVersion: 'kinetix-wiki-article-v1',
    idempotencyKey: 'article-247',
    articleDigest: 'f'.repeat(64),
    createdAt: '2026-10-14T09:00:00Z',
    page: { slug: 'et-tema', id: pageId },
    sources: [{ key: 'S1', type: 'pmid', identifier: WINNER_PMID }],
    sections: [
      {
        key: 'pk',
        sectionId: 'pk',
        heading: 'Farmakokinetikk',
        level: 2,
        facts: [
          {
            key: 'F1',
            statement: 'Biotilgjengeligheten er om lag 30 % etter peroral dosering.',
            sourceKeys: ['S1'],
          },
        ],
      },
    ],
  });
}

describe.skipIf(!hasRealPostgres)(
  'wiki article import vs. a paper-extraction fact on the same topic page (#247)',
  () => {
    let db: RealPostgresDb;
    let authorId: number;
    let agentId: number;
    /** The surviving citation — the article source's own PMID. */
    let winner: number;
    /** The duplicate the run holds a claimed job on: the import's fold of it waits for that job. */
    let heldLoser: number;
    let pageId: number;
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
    beforeEach(async () => {
      await resetRealPostgresDb(db);
      authMock.mockReset();

      const [author] = await db
        .insert(users)
        .values({ email: 'author@example.com', username: 'author', role: 'admin' })
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

      // One paper split across two rows. The PMID row survives; the DOI row
      // knows the PMID as an alt id, so resolving the PMID finds both and
      // folds the DOI row. It is the row the run was handed, and is admissible
      // (read in full) so the run's fact passes the citation gate.
      const [w] = await db
        .insert(citations)
        .values({ type: 'pmid', identifier: WINNER_PMID })
        .returning({ id: citations.id });
      winner = w!.id;
      const heldHandle = `doi:${HELD_DOI}`;
      const [h] = await db
        .insert(citations)
        .values({
          type: 'doi',
          identifier: HELD_DOI,
          metadata: { altIds: { pmid: WINNER_PMID } },
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

      // A topic page (no drug, so the route's page-lock branch).
      const [page] = await db
        .insert(wikiPages)
        .values({
          slug: 'et-tema',
          title: 'Et tema',
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
          pageType: 'topic',
          status: 'published',
          createdBy: authorId,
          updatedBy: authorId,
        })
        .returning({ id: wikiPages.id });
      pageId = page!.id;

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

    /** Resolve once another backend is blocked on a row lock of `table`. */
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
     * File the run's fact on the page through the real route, paused between
     * its claim re-check (job row `FOR SHARE`, held) and its page share lock.
     */
    function submitFactPausedBeforePageLock() {
      const jobLocked = gate();
      const resume = gate();
      pause.armed = { reached: jobLocked.open, resume: resume.wait };
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
      const done = handler(req, res).then(() => state);
      held.push({ release: resume.open, done });
      return { jobLocked: jobLocked.wait, resume: resume.open, done };
    }

    it(
      'queues the article and files the fact, instead of deadlocking on page vs. job',
      async () => {
        const bundle = articleBundle(pageId);
        const plan = await planWikiArticle(bundle);

        const submit = submitFactPausedBeforePageLock();
        await submit.jobLocked;

        // The route now holds the run's job row. The import's fold finds it
        // held and stands aside, so the import finishes without waiting on
        // the route at all — before the route even reaches the page.
        const [importOutcome] = await Promise.allSettled([
          applyWikiArticle(bundle, authorId, plan.fingerprint),
        ]);
        submit.resume();
        const [submitOutcome] = await Promise.allSettled([submit.done]);

        if (importOutcome.status === 'rejected') {
          expect(sqlState(importOutcome.reason)).not.toBe(DEADLOCK_DETECTED);
          throw importOutcome.reason;
        }
        expect(submitOutcome.status).toBe('fulfilled');
        const response = (submitOutcome as PromiseFulfilledResult<{
          statusCode: number;
          body: string;
        }>).value;
        expect(response.body).not.toContain('deadlock');
        expect(response.statusCode).toBe(201);

        expect(importOutcome.value).toMatchObject({ queued: 1, skipped: 0, newSections: 0 });

        // The fold deferred on the run's claimed job: both rows remain, the
        // article's fact cites the survivor, the run's fact the row it was handed.
        const left = await db.select({ id: citations.id }).from(citations);
        expect(left.map((row) => row.id).sort((a, b) => a - b)).toEqual(
          [winner, heldLoser].sort((a, b) => a - b),
        );
        const filed = await db
          .select({
            targetId: pendingEdits.targetId,
            referenceId: pendingEdits.referenceId,
            submittedBy: pendingEdits.submittedBy,
          })
          .from(pendingEdits)
          .orderBy(pendingEdits.id);
        // The import, not waiting on the route, filed first.
        expect(filed).toEqual([
          { targetId: pageId, referenceId: winner, submittedBy: authorId },
          { targetId: pageId, referenceId: heldLoser, submittedBy: agentId },
        ]);
        const [job] = await db
          .select({ status: paperExtractionJobs.status, citationId: paperExtractionJobs.citationId })
          .from(paperExtractionJobs)
          .where(eq(paperExtractionJobs.id, jobId));
        expect(job).toEqual({ status: 'claimed', citationId: heldLoser });
      },
      LOCK_TIMEOUT_MS * 3,
    );

    it(
      'the pre-#247 import order (page first, then the fold) really does deadlock against the route',
      async () => {
        // The route logs the error behind its 500; that is where its 40P01 shows.
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        const submit = submitFactPausedBeforePageLock();
        await submit.jobLocked;

        // The import's old sequence, by hand: the page `FOR UPDATE`, then the
        // fold's old wait for the loser's jobs.
        const pageLocked = gate();
        const oldOrder = runInPoolTransaction(async () => {
          const tx = getDb();
          const [page] = await tx
            .select({ id: wikiPages.id })
            .from(wikiPages)
            .where(eq(wikiPages.id, pageId))
            .for('update');
          expect(page).toBeDefined();
          pageLocked.open();
          await tx.execute(
            sql`SELECT id FROM paper_extraction_jobs WHERE id = ${jobId} FOR NO KEY UPDATE`,
          );
        });
        await pageLocked.wait;
        await blockedOn('paper_extraction_jobs');
        submit.resume();

        const [importOutcome, submitOutcome] = await Promise.allSettled([
          oldOrder,
          submit.done,
        ]);
        const routeLog = logged.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
        logged.mockRestore();
        // Exactly one side is Postgres's chosen victim; the other completes
        // once the victim's transaction aborts and releases its locks. The
        // route turns its own abort into a logged 500.
        expect(submitOutcome.status).toBe('fulfilled');
        const { statusCode } = (submitOutcome as PromiseFulfilledResult<{ statusCode: number }>)
          .value;
        if (importOutcome.status === 'rejected') {
          expect(sqlState(importOutcome.reason)).toBe(DEADLOCK_DETECTED);
          expect(statusCode).toBe(201);
        } else {
          expect(statusCode).toBe(500);
          expect(routeLog).toContain('deadlock detected');
        }
      },
      LOCK_TIMEOUT_MS * 3,
    );

    // Codex on #257: a transaction folding two pairs. The first fold rewrites
    // every page citing its loser, and holds that page row to commit; the
    // second reaches the job a run holds while filing a fact on that page.
    describe('a second fold in the transaction, after the first rewrote the page', () => {
      /** A split pair whose loser the page already cites: folding it rewrites the page. */
      let pageWinner: number;
      let pageLoser: number;

      beforeEach(async () => {
        const [w] = await db
          .insert(citations)
          .values({ type: 'pmid', identifier: '11111111' })
          .returning({ id: citations.id });
        pageWinner = w!.id;
        const [l] = await db
          .insert(citations)
          .values({ type: 'doi', identifier: '10.1000/page-cited' })
          .returning({ id: citations.id });
        pageLoser = l!.id;
        await db
          .update(wikiPages)
          .set({
            content: {
              type: 'doc',
              content: [
                {
                  type: 'heading',
                  attrs: { sectionId: 'pk', level: 2 },
                  content: [{ type: 'text', text: 'Farmakokinetikk' }],
                },
                {
                  type: 'fact',
                  attrs: { factId: 'f0', referenceIds: [pageLoser] },
                  content: [{ type: 'text', text: 'Absorberes raskt.' }],
                },
              ],
            },
          })
          .where(eq(wikiPages.id, pageId));
      });

      /** Fold the page's pair, hold the transaction, then run `then` in it. */
      function foldPagePairThen<T>(then: () => Promise<T>) {
        const folded = gate();
        const resume = gate();
        const done = runInPoolTransaction(async () => {
          const first = await mergeCitations(getDb(), pageWinner, pageLoser, {
            actorUserId: authorId,
          });
          folded.open();
          await resume.wait;
          return { first, second: await then() };
        });
        held.push({ release: resume.open, done });
        return { folded: folded.wait, resume: resume.open, done };
      }

      it(
        'defers the second fold on the held job, instead of deadlocking on page vs. job',
        async () => {
          const submit = submitFactPausedBeforePageLock();
          await submit.jobLocked;

          const merge = foldPagePairThen(() =>
            mergeCitations(getDb(), winner, heldLoser, { actorUserId: authorId }),
          );
          await merge.folded;
          // The route now waits for the page the first fold rewrote.
          submit.resume();
          await blockedOn('wiki_pages');
          merge.resume();

          const [mergeOutcome, submitOutcome] = await Promise.allSettled([
            merge.done,
            submit.done,
          ]);
          if (mergeOutcome.status === 'rejected') {
            expect(sqlState(mergeOutcome.reason)).not.toBe(DEADLOCK_DETECTED);
            throw mergeOutcome.reason;
          }
          const { first, second } = mergeOutcome.value;
          expect(first.deferred).toBeUndefined();
          expect(first.jsonDocumentsRewritten).toBeGreaterThan(0);
          expect(second).toMatchObject({
            deferred: true,
            deferredReason: 'extraction_in_flight',
            inFlightExtractionJobId: jobId,
          });
          expect(submitOutcome.status).toBe('fulfilled');
          expect(
            (submitOutcome as PromiseFulfilledResult<{ statusCode: number }>).value.statusCode,
          ).toBe(201);
        },
        LOCK_TIMEOUT_MS * 3,
      );

      it(
        'the old wait for the job in the second fold really does deadlock against the route',
        async () => {
          const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
          const submit = submitFactPausedBeforePageLock();
          await submit.jobLocked;

          const merge = foldPagePairThen(() =>
            getDb().execute(
              sql`SELECT id FROM paper_extraction_jobs WHERE id = ${jobId} FOR NO KEY UPDATE`,
            ),
          );
          await merge.folded;
          submit.resume();
          await blockedOn('wiki_pages');
          merge.resume();

          const [mergeOutcome, submitOutcome] = await Promise.allSettled([
            merge.done,
            submit.done,
          ]);
          const routeLog = logged.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
          logged.mockRestore();
          expect(submitOutcome.status).toBe('fulfilled');
          const { statusCode } = (submitOutcome as PromiseFulfilledResult<{ statusCode: number }>)
            .value;
          if (mergeOutcome.status === 'rejected') {
            expect(sqlState(mergeOutcome.reason)).toBe(DEADLOCK_DETECTED);
            expect(statusCode).toBe(201);
          } else {
            expect(statusCode).toBe(500);
            expect(routeLog).toContain('deadlock detected');
          }
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
          'tests/governance/transaction/real-postgres-wiki-article-import-lock-order.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
