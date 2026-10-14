/**
 * #223: a paper-extraction fact filed on a topic page, racing a citation
 * merge, on two real connections.
 *
 * The fact's insert transaction (`POST /api/pending-edits`, the topic-page
 * branch) holds two row locks: the wiki page's (`lockWikiPageShared`, so a
 * page delete cannot sweep around the insert) and the extraction job's
 * (`liveClaimCitationId({ forShare: true })`, so a cancel or takeover cannot
 * land between the claim check and the insert). It used to take them page
 * first, job second.
 *
 * `mergeCitations` takes the other order. It locks the loser's open
 * extraction jobs (`lockLoserExtractionJobs`, `FOR NO KEY UPDATE`) before it
 * rewrites the wiki pages that cite the loser (`rewriteJsonDocuments`), and
 * every caller that folds a duplicate group runs the whole group in one
 * transaction — so a fold that defers because a run holds the loser's job
 * keeps that job locked while the next fold rewrites pages. A fact submitted
 * from that run onto one of those pages then holds the page and waits for the
 * job, while the merge holds the job and waits for the page: a cycle Postgres
 * breaks by aborting one side with `deadlock_detected` (40P01), failing either
 * the run's fact or an unrelated citation resolution for no reason a retry
 * would explain.
 *
 * The fix takes the job lock first on that branch, so both paths order job
 * before page. The first test drives the real route and asserts both sides
 * finish; the second is the negative control — the pre-fix order, by hand,
 * against the same merge — so a green first test cannot be read as "nothing
 * was contended".
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
import { liveClaimCitationId } from '../../../api/_lib/paper-extraction-store.js';
import { lockWikiPageShared } from '../../../api/_lib/wiki-page-lock.js';
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

const TOKEN = 'a'.repeat(32);

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
  'paper-extraction fact on a topic page vs. a citation merge (#223)',
  () => {
    let db: RealPostgresDb;
    let authorId: number;
    let agentId: number;
    /** The surviving citation of the duplicate group. */
    let winner: number;
    /** A duplicate the extraction run holds a job on: its fold defers. */
    let heldLoser: number;
    /** A duplicate the topic page cites: its fold rewrites the page. */
    let citedLoser: number;
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
      for (const hold of held) hold.release();
      await Promise.allSettled(held.map((hold) => hold.done));
      held = [];
    });
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

      // One paper under three handles. The PMID row survives; the DOI row is
      // the one the run was handed, and is admissible (read in full) so the
      // fact citing it passes the citation gate.
      const [w] = await db
        .insert(citations)
        .values({ type: 'pmid', identifier: '24500275' })
        .returning({ id: citations.id });
      winner = w!.id;
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
      const [c] = await db
        .insert(citations)
        .values({ type: 'url', identifier: 'https://example.org/split-paper' })
        .returning({ id: citations.id });
      citedLoser = c!.id;

      // A topic page (no drug, so the route's page-lock branch) that already
      // cites the third handle: folding it rewrites this row.
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
              { type: 'fact', attrs: { referenceIds: [citedLoser] } },
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

    /**
     * Fold the group the way `resolveCitation` and the admin merge route do —
     * every duplicate into the survivor, one transaction — paused between the
     * two folds. The first fold defers (the run holds the job) but keeps the
     * job locked until commit; the pause stands in for the ordinary gap
     * between loop iterations, widened so the other side can be placed in it.
     */
    function mergeGroupPausedBetweenFolds() {
      const firstFolded = gate();
      const resume = gate();
      const done = runInPoolTransaction(async () => {
        const tx = getDb();
        const first = await mergeCitations(tx, winner, heldLoser, { actorUserId: authorId });
        firstFolded.open();
        await resume.wait;
        const second = await mergeCitations(tx, winner, citedLoser, { actorUserId: authorId });
        return [first, second] as CitationMergeStats[];
      });
      held.push({ release: resume.open, done });
      return { firstFolded: firstFolded.wait, resume: resume.open, done };
    }

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
      'files the fact and finishes the merge, instead of deadlocking on page vs. job',
      async () => {
        const merge = mergeGroupPausedBetweenFolds();
        await merge.firstFolded;

        // The merge now holds the run's job row. The submission must wait for
        // it holding nothing — in particular not the page the merge is about
        // to rewrite.
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

        const [first, second] = mergeOutcome.value;
        expect(first).toMatchObject({
          deferred: true,
          deferredReason: 'extraction_in_flight',
          inFlightExtractionJobId: jobId,
        });
        expect(second!.deferred).toBeUndefined();
        expect(second!.jsonDocumentsRewritten).toBeGreaterThan(0);

        const [page] = await db
          .select({ content: wikiPages.content })
          .from(wikiPages)
          .where(eq(wikiPages.id, pageId));
        expect(JSON.stringify(page!.content)).toContain(`"referenceIds":[${winner}]`);
        const filed = await db
          .select({ targetId: pendingEdits.targetId, referenceId: pendingEdits.referenceId })
          .from(pendingEdits);
        expect(filed).toEqual([{ targetId: pageId, referenceId: heldLoser }]);
      },
      LOCK_TIMEOUT_MS * 3,
    );

    it(
      'the pre-#223 order (page first, then job) really does deadlock against the merge',
      async () => {
        const merge = mergeGroupPausedBetweenFolds();
        await merge.firstFolded;

        // The route's old topic-page sequence, by hand: page share lock, then
        // the claim re-check that share-locks the job row.
        const pageLocked = gate();
        const oldOrder = runInPoolTransaction(async () => {
          expect(await lockWikiPageShared(pageId)).toBe(true);
          pageLocked.open();
          return liveClaimCitationId({
            jobId,
            claimToken: TOKEN,
            userId: agentId,
            forShare: true,
          });
        });
        await pageLocked.wait;
        await blockedOn('paper_extraction_jobs');
        merge.resume();

        const outcomes = await Promise.allSettled([merge.done, oldOrder]);
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
        step.includes('tests/governance/transaction/real-postgres-extraction-fact-lock-order.test.ts'),
      ),
    ).toBe(true);
  });
});
