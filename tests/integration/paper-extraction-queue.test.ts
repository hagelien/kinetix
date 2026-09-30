/**
 * The paper fact-extraction queue against real SQL.
 *
 * Everything worth testing here is SQL the unit suite's mocked query builder
 * cannot express: the single-statement atomic claim, the partial unique index
 * that keeps at most one open job per paper, the stale-claim takeover, and the
 * attempt cap that stops an unreadable paper from starving the queue.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { citationPdfs, citations, paperExtractionJobs } from '../../db/schema.js';
import {
  PaperExtractionError,
  applyJobAction,
  claimNextJob,
  countOpenJobs,
  enqueueJob,
  isOpenJobUniqueViolation,
  listJobs,
  listJobsClaimedBy,
} from '../../api/_lib/paper-extraction-store.js';
import { STALE_CLAIM_MS } from '../../src/lib/paperExtraction.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

let db: IntegrationDb;
let editorId: number;
let agentId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  editorId = await seedUser(db, {
    email: 'editor@example.com',
    username: 'editor',
    role: 'editor',
  });
  agentId = await seedUser(db, {
    email: 'agent@example.com',
    username: 'kinetix-agent',
    role: 'contributor',
  });
});

/** A resolvable citation, optionally with full text already stored. */
async function seedPaper(
  identifier: string,
  options: { withPdf?: boolean } = {},
): Promise<number> {
  const [citation] = await db
    .insert(citations)
    .values({ type: 'doi', identifier })
    .returning({ id: citations.id });
  const citationId = citation!.id;
  if (options.withPdf !== false) {
    await db.insert(citationPdfs).values({
      citationId,
      blobPathname: `citation-pdfs/${citationId}.pdf`,
      blobUrl: `https://blob.example/${citationId}`,
      sizeBytes: 1024,
      sha256: 'a'.repeat(64),
      contentType: 'application/pdf',
      source: 'upload',
      uploadedBy: editorId,
    });
  }
  return citationId;
}

/** Age a job's claim past the stale window, as a run that died mid-cycle would. */
async function expireClaim(jobId: number): Promise<void> {
  await db
    .update(paperExtractionJobs)
    .set({ claimedAt: new Date(Date.now() - STALE_CLAIM_MS - 60_000) })
    .where(eq(paperExtractionJobs.id, jobId));
}

async function enqueue(citationId: number, scopeNote?: string) {
  return enqueueJob({
    citationId,
    scopeNote: scopeNote ?? null,
    targetDrugIds: null,
    requestedBy: editorId,
  });
}

describe('enqueueing a paper', () => {
  it('refuses a paper whose full text is not on file', async () => {
    const citationId = await seedPaper('10.1000/no-pdf', { withPdf: false });
    // The queue's whole premise is that the reading material is in hand; a job
    // the agent can never start would sit at the head of the queue forever.
    await expect(enqueue(citationId)).rejects.toMatchObject({
      code: 'paper_extraction_missing_pdf',
    });
  });

  it('refuses a freetext citation, which names no retrievable paper', async () => {
    const [citation] = await db
      .insert(citations)
      .values({ type: 'freetext', identifier: 'Baselt, 12th ed.' })
      .returning({ id: citations.id });
    await expect(enqueue(citation!.id)).rejects.toBeInstanceOf(
      PaperExtractionError,
    );
  });

  it('refuses a second open job for the same paper', async () => {
    const citationId = await seedPaper('10.1000/dup');
    await enqueue(citationId);
    // Two open jobs means two runs reading the same PDF and filing the same
    // facts — duplicate wiki_fact rows a reviewer has to reconcile by hand.
    await expect(enqueue(citationId)).rejects.toMatchObject({
      code: 'paper_extraction_already_queued',
      status: 409,
    });
  });

  it('recognizes the real unique violation the index raises', async () => {
    // The insert-path translation is what turns a lost enqueue race into a
    // 409 instead of a 500, but `enqueueJob`'s preflight swallows most
    // collisions before the insert — so provoke the violation directly and
    // check the predicate against the driver's actual error shape rather than
    // trusting a race to reach the catch.
    const citationId = await seedPaper('10.1000/violation');
    await enqueue(citationId);

    let raised: unknown;
    try {
      await db.insert(paperExtractionJobs).values({
        citationId,
        status: 'queued',
        requestedBy: editorId,
      });
    } catch (err) {
      raised = err;
    }

    expect(raised).toBeDefined();
    expect(isOpenJobUniqueViolation(raised)).toBe(true);
    // An unrelated unique violation must not be mistaken for "already queued".
    expect(
      isOpenJobUniqueViolation({
        code: '23505',
        constraint: 'citations_type_identifier_idx',
      }),
    ).toBe(false);
  });

  it('turns a concurrent double-enqueue into 409, not a 500', async () => {
    const citationId = await seedPaper('10.1000/race');

    // Both calls clear the preflight check before either inserts, so the loser
    // hits the partial unique index. A double-click must not surface as a
    // server error.
    const results = await Promise.allSettled([
      enqueue(citationId),
      enqueue(citationId),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'paper_extraction_already_queued',
      status: 409,
    });

    const rows = await db.select().from(paperExtractionJobs);
    expect(rows).toHaveLength(1);
  });

  it('allows re-extraction once the earlier job has settled', async () => {
    const citationId = await seedPaper('10.1000/again');
    const first = await enqueue(citationId);
    await applyJobAction({
      id: first.id,
      expectedStatuses: ['queued'],
      nextStatus: 'cancelled',
      clearClaim: true,
    });

    const second = await enqueue(citationId);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('queued');
  });

  it('stores the editor’s scope note verbatim', async () => {
    const citationId = await seedPaper('10.1000/scope');
    const job = await enqueue(citationId, 'kun postmortem-kohorten');
    expect(job.scopeNote).toBe('kun postmortem-kohorten');
    expect(job.requestedBy).toBe(editorId);
    expect(job.attempts).toBe(0);
  });
});

describe('claiming a job', () => {
  it('takes the oldest queued job and stamps the holder', async () => {
    const older = await enqueue(await seedPaper('10.1000/older'));
    await db
      .update(paperExtractionJobs)
      .set({ createdAt: new Date('2026-01-01T00:00:00Z') })
      .where(eq(paperExtractionJobs.id, older.id));
    await enqueue(await seedPaper('10.1000/newer'));

    const claimed = await claimNextJob(agentId);

    expect(claimed?.id).toBe(older.id);
    expect(claimed?.status).toBe('claimed');
    expect(claimed?.claimedBy).toBe(agentId);
    expect(claimed?.attempts).toBe(1);
  });

  it('hands two concurrent runs different papers', async () => {
    await enqueue(await seedPaper('10.1000/a'));
    await enqueue(await seedPaper('10.1000/b'));
    const second = await seedUser(db, {
      email: 'agent2@example.com',
      username: 'codex-agent',
      role: 'contributor',
    });

    const first = await claimNextJob(agentId);
    const other = await claimNextJob(second);

    expect(first).not.toBeNull();
    expect(other).not.toBeNull();
    expect(first!.id).not.toBe(other!.id);
  });

  it('returns null on an empty queue rather than throwing', async () => {
    expect(await claimNextJob(agentId)).toBeNull();
  });

  it('skips a job whose stored full text disappeared', async () => {
    const citationId = await seedPaper('10.1000/gone');
    await enqueue(citationId);
    // A stored PDF can be replaced or removed after the enqueue; handing the
    // agent a job whose bytes are gone burns a whole cycle.
    await db.delete(citationPdfs).where(eq(citationPdfs.citationId, citationId));

    expect(await claimNextJob(agentId)).toBeNull();
  });

  it('does not re-claim a job a live run is still holding', async () => {
    await enqueue(await seedPaper('10.1000/held'));
    const held = await claimNextJob(agentId);
    expect(held).not.toBeNull();

    expect(await claimNextJob(agentId)).toBeNull();
  });

  it('takes over a claim that has gone stale', async () => {
    await enqueue(await seedPaper('10.1000/orphan'));
    const first = await claimNextJob(agentId);
    // Simulate a Routine that died mid-cycle: the claim is still on the row,
    // but nothing is working it.
    await expireClaim(first!.id);

    const reclaimed = await claimNextJob(agentId);

    expect(reclaimed?.id).toBe(first!.id);
    expect(reclaimed?.attempts).toBe(2);
    // Reclaiming mints a new token — that is what invalidates the dead run's,
    // since both runs share the same agent identity.
    expect(reclaimed?.claimToken).toEqual(expect.any(String));
    expect(reclaimed?.claimToken).not.toBe(first!.claimToken);
  });

  it('mints a distinct claim token per claim', async () => {
    await enqueue(await seedPaper('10.1000/tok-a'));
    await enqueue(await seedPaper('10.1000/tok-b'));

    const a = await claimNextJob(agentId);
    const b = await claimNextJob(agentId);

    expect(a?.claimToken).toHaveLength(32);
    expect(b?.claimToken).toHaveLength(32);
    expect(a?.claimToken).not.toBe(b?.claimToken);
  });

  it('parks a job as failed once it has burned its retry budget', async () => {
    await enqueue(await seedPaper('10.1000/cursed'));

    // Three claims, each abandoned by letting its claim go stale.
    for (let i = 0; i < 3; i += 1) {
      const claimed = await claimNextJob(agentId);
      expect(claimed).not.toBeNull();
      await expireClaim(claimed!.id);
    }

    // The fourth run finds nothing to do, and the cursed paper is parked for
    // an editor rather than re-claimed forever.
    expect(await claimNextJob(agentId)).toBeNull();
    const [row] = await db.select().from(paperExtractionJobs);
    expect(row!.status).toBe('failed');
    expect(row!.lastError).toBe('paper_extraction_attempts_exhausted');
    expect(row!.claimedBy).toBeNull();
  });
});

describe('resuming your own claim', () => {
  it('returns a live claim so an interrupted run picks its own work back up', async () => {
    await enqueue(await seedPaper('10.1000/resume'));
    const claimed = await claimNextJob(agentId);

    const mine = await listJobsClaimedBy(agentId);

    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).toBe(claimed!.id);
    // The resume path has to carry the token, or the resumed run could never
    // report its outcome.
    expect(mine[0]!.claimToken).toBe(claimed!.claimToken);
  });

  it('hides a claim that has gone stale, so it goes through reclaim accounting', async () => {
    // This is the hole that makes the retry cap real. If a dead run's leftover
    // claim came back through the resume path, the next run would work it
    // without ever calling claimNextJob — `attempts` would never increment and
    // an unreadable paper would be retried forever, starving the queue.
    await enqueue(await seedPaper('10.1000/abandoned'));
    const claimed = await claimNextJob(agentId);
    await expireClaim(claimed!.id);

    expect(await listJobsClaimedBy(agentId)).toHaveLength(0);

    const reclaimed = await claimNextJob(agentId);
    expect(reclaimed?.id).toBe(claimed!.id);
    expect(reclaimed?.attempts).toBe(2);
  });

  it('cannot be used to dodge the retry cap on a paper that kills the agent', async () => {
    // The end-to-end version of the above: a run that always dies on the same
    // paper must still exhaust its budget and park the job.
    await enqueue(await seedPaper('10.1000/killer'));

    for (let i = 0; i < 3; i += 1) {
      expect(await listJobsClaimedBy(agentId)).toHaveLength(0);
      const claimed = await claimNextJob(agentId);
      expect(claimed).not.toBeNull();
      await expireClaim(claimed!.id);
    }

    expect(await listJobsClaimedBy(agentId)).toHaveLength(0);
    expect(await claimNextJob(agentId)).toBeNull();
    const [row] = await db.select().from(paperExtractionJobs);
    expect(row!.status).toBe('failed');
  });
});

describe('reporting an outcome', () => {
  it('refuses a stale run of the same agent whose claim was reissued', async () => {
    // One agent identity on a schedule is the expected deployment, so the dead
    // run and the run that replaced it share a `claimed_by`. Only the token
    // separates them.
    await enqueue(await seedPaper('10.1000/reissued'));
    const dead = await claimNextJob(agentId);
    await expireClaim(dead!.id);
    const live = await claimNextJob(agentId);
    expect(live!.id).toBe(dead!.id);

    const stale = await applyJobAction({
      id: dead!.id,
      expectedStatuses: ['claimed'],
      nextStatus: 'completed',
      claimHolder: agentId,
      claimToken: dead!.claimToken!,
      resultSummary: 'output from the run that already died',
      factsSubmitted: 9,
    });
    expect(stale).toBeNull();

    // The live run's claim is untouched, and its own report lands.
    const done = await applyJobAction({
      id: live!.id,
      expectedStatuses: ['claimed'],
      nextStatus: 'completed',
      claimHolder: agentId,
      claimToken: live!.claimToken!,
      resultSummary: 'Leste artikkelen i sin helhet.',
      factsSubmitted: 1,
    });
    expect(done?.factsSubmitted).toBe(1);
  });

  it('records a completion only for the run still holding the claim', async () => {
    await enqueue(await seedPaper('10.1000/report'));
    const claimed = await claimNextJob(agentId);

    const stolen = await applyJobAction({
      id: claimed!.id,
      expectedStatuses: ['claimed'],
      nextStatus: 'completed',
      claimHolder: editorId, // not the holder
      claimToken: claimed!.claimToken!,
      resultSummary: 'stale',
      factsSubmitted: 0,
    });
    expect(stolen).toBeNull();

    const done = await applyJobAction({
      id: claimed!.id,
      expectedStatuses: ['claimed'],
      nextStatus: 'completed',
      claimHolder: agentId,
      claimToken: claimed!.claimToken!,
      resultSummary: 'Leste artikkelen i sin helhet; to fakta sendt inn.',
      factsSubmitted: 2,
      pendingEditIds: [11, 12],
    });
    expect(done?.status).toBe('completed');
    expect(done?.factsSubmitted).toBe(2);
    expect(done?.pendingEditIds).toEqual([11, 12]);
    expect(done?.completedAt).not.toBeNull();
  });

  it('gives a requeued job a fresh retry budget and no owner', async () => {
    await enqueue(await seedPaper('10.1000/retry'));
    const claimed = await claimNextJob(agentId);
    await applyJobAction({
      id: claimed!.id,
      expectedStatuses: ['claimed'],
      nextStatus: 'failed',
      claimHolder: agentId,
      claimToken: claimed!.claimToken!,
      lastError: 'stored_pdf_unreadable_or_image_only',
    });

    const requeued = await applyJobAction({
      id: claimed!.id,
      expectedStatuses: ['failed'],
      nextStatus: 'queued',
      clearClaim: true,
      resetAttempts: true,
      clearResult: true,
      lastError: null,
    });

    expect(requeued?.status).toBe('queued');
    expect(requeued?.attempts).toBe(0);
    expect(requeued?.claimedBy).toBeNull();
    expect(requeued?.lastError).toBeNull();
    // And it is claimable again.
    expect((await claimNextJob(agentId))?.id).toBe(claimed!.id);
  });

  it('wipes the previous run’s output when a completed job is requeued', async () => {
    await enqueue(await seedPaper('10.1000/re-extract'));
    const claimed = await claimNextJob(agentId);
    await applyJobAction({
      id: claimed!.id,
      expectedStatuses: ['claimed'],
      nextStatus: 'completed',
      claimHolder: agentId,
      claimToken: claimed!.claimToken!,
      resultSummary: 'Tre fakta sendt inn.',
      factsSubmitted: 3,
      pendingEditIds: [11, 12, 13],
    });

    const requeued = await applyJobAction({
      id: claimed!.id,
      expectedStatuses: ['completed'],
      nextStatus: 'queued',
      clearClaim: true,
      resetAttempts: true,
      clearResult: true,
      lastError: null,
    });

    // A requeue starts a NEW extraction. Left in place, the old summary and
    // fact count would render on the re-queued card as this run's output —
    // and the queue view shows `factsSubmitted` whenever it is set.
    expect(requeued?.resultSummary).toBeNull();
    expect(requeued?.factsSubmitted).toBeNull();
    expect(requeued?.pendingEditIds).toBeNull();
    expect(requeued?.completedAt).toBeNull();
  });

  it('refuses to act on a job that already left the expected state', async () => {
    const job = await enqueue(await seedPaper('10.1000/moved'));
    await applyJobAction({
      id: job.id,
      expectedStatuses: ['queued'],
      nextStatus: 'cancelled',
      clearClaim: true,
    });

    const late = await applyJobAction({
      id: job.id,
      expectedStatuses: ['queued'],
      nextStatus: 'claimed',
    });
    expect(late).toBeNull();
  });
});

describe('requeue collisions', () => {
  it('refuses to reopen a job whose paper is already queued again', async () => {
    // A settled card plus a newer open job for the same paper is a normal
    // state — the queue page offers "Queue again" on every settled card, and
    // the paper may have been re-enqueued since. Clicking the old one must
    // surface the conflict, not a 500.
    const citationId = await seedPaper('10.1000/double-requeue');
    const first = await enqueue(citationId);
    await applyJobAction({
      id: first.id,
      expectedStatuses: ['queued'],
      nextStatus: 'cancelled',
      clearClaim: true,
    });
    const second = await enqueue(citationId);
    expect(second.status).toBe('queued');

    await expect(
      applyJobAction({
        id: first.id,
        expectedStatuses: ['cancelled'],
        nextStatus: 'queued',
        clearClaim: true,
        resetAttempts: true,
        clearResult: true,
        lastError: null,
      }),
    ).rejects.toMatchObject({
      code: 'paper_extraction_already_queued',
      status: 409,
    });

    // The live job is untouched and still the only open one.
    const open = await listJobs({ status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(second.id);
  });
});

describe('the queue view', () => {
  it('keeps open jobs ahead of history so they cannot scroll off', async () => {
    // The page reads the unfiltered list with a limit and has no pagination or
    // status filter, so ordering by recency alone would let accumulated
    // history bury a job that is still stuck — leaving the editor unable to
    // see or cancel it.
    const openJob = await enqueue(await seedPaper('10.1000/still-open'));
    await db
      .update(paperExtractionJobs)
      .set({ createdAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(paperExtractionJobs.id, openJob.id));

    for (let i = 0; i < 3; i += 1) {
      const settled = await enqueue(await seedPaper(`10.1000/history-${i}`));
      await applyJobAction({
        id: settled.id,
        expectedStatuses: ['queued'],
        nextStatus: 'completed',
        resultSummary: 'ferdig',
        factsSubmitted: 1,
      });
    }

    const rows = await listJobs({});

    // The oldest row in the table leads the list because it is the only one
    // still open.
    expect(rows[0]!.id).toBe(openJob.id);
    expect(rows.slice(1).every((r) => r.status === 'completed')).toBe(true);
    // History stays newest-first within its own group.
    const historyDates = rows.slice(1).map((r) => new Date(r.createdAt).getTime());
    expect(historyDates).toEqual([...historyDates].sort((a, b) => b - a));
  });


  it('joins the citation and both user roles, and counts only open work', async () => {
    const citationId = await seedPaper('10.1000/view');
    await enqueue(citationId, 'se på metabolitten');
    await claimNextJob(agentId);

    const settledCitation = await seedPaper('10.1000/settled');
    const settled = await enqueue(settledCitation);
    await applyJobAction({
      id: settled.id,
      expectedStatuses: ['queued'],
      nextStatus: 'cancelled',
      clearClaim: true,
    });

    expect(await countOpenJobs()).toBe(1);

    const rows = await listJobs({ status: 'open' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      citationId,
      status: 'claimed',
      citationType: 'doi',
      citationIdentifier: '10.1000/view',
      requestedByUsername: 'editor',
      claimedByUsername: 'kinetix-agent',
      hasPaperReview: false,
      scopeNote: 'se på metabolitten',
    });

    expect(await listJobs({ status: 'cancelled' })).toHaveLength(1);
    expect(await listJobs({})).toHaveLength(2);
  });
});
