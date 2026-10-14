/**
 * #127, Codex review on #234: a citation merge racing the paper-extraction
 * queue, on two (and three) real connections.
 *
 * `mergeCitations` refuses to fold a loser that a run is extracting: it locks
 * the loser's extraction jobs, defers if one is claimed, and otherwise repoints
 * them. A row lock only covers rows that exist, though. Without more, a job
 * enqueued for the loser after that scan — or a settled one requeued after it —
 * is unlocked, so `claimNextJob` can hand it to a run before the repoint, and
 * the merge then moves a claimed job and deletes the citation id the run was
 * given. The outcomes asserted are the ones the protocol promises:
 *
 *   - merge first   → the enqueue (or requeue) waits for the merge, and then
 *                      refuses (the citation is gone) or lands on the
 *                      survivor; nothing is claimable under the loser while
 *                      the merge is in flight;
 *   - enqueue first → the merge stands aside while the enqueue is in flight,
 *                      and once it has committed, moves the queued job (or
 *                      defers, if a run has claimed it).
 *
 * PGlite has one connection, so it can neither block nor show the window; this
 * suite skips without `KINETIX_TEST_PG_URL` and never falls back to it. The
 * `migrations` workflow runs it against a service container (asserted below).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getDb, runInPoolTransaction } from '../../../api/_lib/db.js';
import { mergeCitations, type CitationMergeStats } from '../../../api/_lib/citation-merge.js';
import {
  applyJobAction,
  claimNextJob,
  enqueueJob,
} from '../../../api/_lib/paper-extraction-store.js';
import { citationPdfs, citations, paperExtractionJobs, users } from '../../../db/schema.js';
import {
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

/** Resolves true if `p` has not settled within `ms`. */
async function stillPending(p: Promise<unknown>, ms = 400): Promise<boolean> {
  const marker = Symbol('pending');
  const winner = await Promise.race([
    p.then(
      () => null,
      () => null,
    ),
    new Promise((resolve) => setTimeout(() => resolve(marker), ms)),
  ]);
  return winner === marker;
}

describe.skipIf(!hasRealPostgres)('citation merge vs. the extraction queue under real concurrency', () => {
  let db: RealPostgresDb;
  let editorId: number;
  let agentId: number;

  beforeAll(async () => {
    db = await setupRealPostgresDb();
  }, 120_000);
  afterAll(async () => {
    await teardownRealPostgresDb();
  });
  // Transactions a test holds open. Released after each test whatever its
  // outcome, so one failing assertion cannot leave a lock behind that turns
  // every later test's reset into a lock timeout.
  let held: Array<{ release: () => void; done: Promise<unknown> }> = [];
  afterEach(async () => {
    for (const hold of held) hold.release();
    await Promise.allSettled(held.map((hold) => hold.done));
    held = [];
  });
  beforeEach(async () => {
    await resetRealPostgresDb(db);
    const [editor] = await db
      .insert(users)
      .values({ email: 'editor@example.com', username: 'editor', role: 'editor' })
      .returning({ id: users.id });
    editorId = editor!.id;
    const [agent] = await db
      .insert(users)
      .values({ email: 'agent@example.com', username: 'kinetix-agent', role: 'contributor' })
      .returning({ id: users.id });
    agentId = agent!.id;
  });

  /** The split pair: the PMID row survives, the DOI row (with the PDF) folds. */
  async function seedPair(): Promise<{ winner: number; loser: number }> {
    const [winner] = await db
      .insert(citations)
      .values({ type: 'pmid', identifier: '12345678' })
      .returning({ id: citations.id });
    const [loser] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1000/split' })
      .returning({ id: citations.id });
    // Full text on file for the loser only, so it is what enqueueing needs and
    // what the merge moves onto the winner.
    await db.insert(citationPdfs).values({
      citationId: loser!.id,
      blobPathname: `citation-pdfs/${loser!.id}.pdf`,
      blobUrl: `https://blob.example/${loser!.id}`,
      sizeBytes: 1024,
      sha256: 'a'.repeat(64),
      contentType: 'application/pdf',
      source: 'upload',
      uploadedBy: editorId,
    });
    return { winner: winner!.id, loser: loser!.id };
  }

  /**
   * Hold the loser's PDF row locked on a third connection. The merge reaches
   * it (repointing `citation_pdfs`) after its extraction-job scan and before
   * it repoints the jobs, so this parks the merge in exactly the window the
   * review named.
   */
  function blockPdfRepoint(loser: number) {
    const release = gate();
    const locked = gate();
    const done = runInPoolTransaction(async () => {
      await getDb().execute(
        sql`SELECT 1 FROM citation_pdfs WHERE citation_id = ${loser} FOR UPDATE`,
      );
      locked.open();
      await release.wait;
    });
    held.push({ release: release.open, done });
    return { locked: locked.wait, release: release.open, done };
  }

  function merge(winner: number, loser: number): Promise<CitationMergeStats> {
    return runInPoolTransaction(() => mergeCitations(getDb(), winner, loser));
  }

  function enqueue(citationId: number) {
    return enqueueJob({ citationId, requestedBy: editorId });
  }

  async function jobs() {
    return db
      .select({
        id: paperExtractionJobs.id,
        citationId: paperExtractionJobs.citationId,
        status: paperExtractionJobs.status,
      })
      .from(paperExtractionJobs)
      .orderBy(paperExtractionJobs.id);
  }

  async function citationExists(id: number): Promise<boolean> {
    return (await db.select({ id: citations.id }).from(citations).where(eq(citations.id, id)))
      .length > 0;
  }

  it('merge first: an enqueue for the loser waits for the merge, then refuses', async () => {
    const { winner, loser } = await seedPair();
    const blocker = blockPdfRepoint(loser);
    await blocker.locked;

    // The merge has scanned the loser's (empty) job list and is parked before
    // the repoint.
    const merging = merge(winner, loser);
    expect(await stillPending(merging)).toBe(true);

    // Without the citation lock this commits a queued job for the loser that
    // the scan never saw, and the claim below hands it to a run.
    const enqueueing = enqueue(loser);
    expect(await stillPending(enqueueing)).toBe(true);
    expect(await claimNextJob(agentId)).toBeNull();

    blocker.release();
    await blocker.done;
    const stats = await merging;
    expect(stats.deferred).toBeUndefined();

    await expect(enqueueing).rejects.toMatchObject({
      code: 'paper_extraction_citation_not_found',
      status: 404,
    });
    expect(await citationExists(loser)).toBe(false);
    expect(await jobs()).toEqual([]);
  });

  it('merge first: a requeue of the loser\'s settled job waits, then lands on the survivor', async () => {
    const { winner, loser } = await seedPair();
    const [settled] = await db
      .insert(paperExtractionJobs)
      .values({ citationId: loser, status: 'completed', requestedBy: editorId })
      .returning({ id: paperExtractionJobs.id });
    const blocker = blockPdfRepoint(loser);
    await blocker.locked;

    const merging = merge(winner, loser);
    expect(await stillPending(merging)).toBe(true);

    // The same hole through the other door: a settled job reopened after the
    // scan is as claimable as a new one.
    const requeueing = applyJobAction({
      id: settled!.id,
      expectedStatuses: ['completed', 'failed', 'cancelled'],
      nextStatus: 'queued',
      clearClaim: true,
      resetAttempts: true,
      clearResult: true,
    });
    expect(await stillPending(requeueing)).toBe(true);
    expect(await claimNextJob(agentId)).toBeNull();

    blocker.release();
    await blocker.done;
    expect((await merging).deferred).toBeUndefined();

    const requeued = await requeueing;
    expect(requeued).toMatchObject({ id: settled!.id, citationId: winner, status: 'queued' });
    const claimed = await claimNextJob(agentId);
    expect(claimed).toMatchObject({ id: settled!.id, citationId: winner });
    expect(await citationExists(winner)).toBe(true);
  });

  it('enqueue first: the merge stands aside while the enqueue is in flight, then moves the job', async () => {
    const { winner, loser } = await seedPair();
    const release = gate();
    const locked = gate();
    const enqueueing = runInPoolTransaction(async () => {
      const job = await enqueue(loser);
      locked.open();
      await release.wait;
      return job;
    });
    held.push({ release: release.open, done: enqueueing });
    await locked.wait;

    // Neither waits on the other: the merge's lock is a bounded try, so it
    // defers rather than queueing behind an unrelated transaction.
    const stats = await merge(winner, loser);
    expect(stats).toMatchObject({ deferred: true, deferredReason: 'loser_locked', rowsRepointed: 0 });

    release.open();
    const job = await enqueueing;
    expect(await jobs()).toEqual([{ id: job.id, citationId: loser, status: 'queued' }]);

    const second = await merge(winner, loser);
    expect(second.deferred).toBeUndefined();
    expect(await jobs()).toEqual([{ id: job.id, citationId: winner, status: 'queued' }]);
    expect(await citationExists(loser)).toBe(false);
  });

  it('enqueue first, then claimed: the merge defers for the run', async () => {
    const { winner, loser } = await seedPair();
    const job = await enqueue(loser);
    const claimed = await claimNextJob(agentId);
    expect(claimed).toMatchObject({ id: job.id, citationId: loser });

    const stats = await merge(winner, loser);

    expect(stats).toMatchObject({
      deferred: true,
      deferredReason: 'extraction_in_flight',
      inFlightExtractionJobId: job.id,
    });
    expect(await citationExists(loser)).toBe(true);
    expect(await jobs()).toEqual([{ id: job.id, citationId: loser, status: 'claimed' }]);
  });
});

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
        step.includes('tests/governance/transaction/real-postgres-citation-merge-enqueue.test.ts'),
      ),
    ).toBe(true);
  });
});
