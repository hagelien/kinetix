/**
 * Data access for the paper fact-extraction queue (`paper_extraction_jobs`).
 *
 * The queue connects two rails that already existed but never met: the PDF
 * store (an editor uploads full text through `pdf_requests` → `citation_pdfs`
 * → Vercel Blob) and the atomic-fact review queue (`pending_edits` with
 * `editType='wiki_fact'`, which distributes one claim at a time to the
 * monograph or wiki page it belongs on). A job is the work ticket in between:
 * "this paper has full text on file — read it and file its facts."
 *
 * Nothing here writes wiki content. The agent that drains the queue submits
 * ordinary `wiki_fact` pending edits under its own contributor identity, so
 * every extracted fact still passes a human reviewer.
 *
 * The state machine (queued → claimed → completed/failed, plus release,
 * cancel, requeue) lives in `src/lib/paperExtraction.ts` and is shared with
 * the React queue view.
 */
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getDb } from './db.js';
import {
  citationPdfs,
  citations,
  paperExtractionJobs,
  paperReviews,
  users,
} from '../../db/schema.js';
import {
  MAX_PAPER_EXTRACTION_ATTEMPTS,
  STALE_CLAIM_MS,
  type PaperExtractionStatus,
} from '../../src/lib/paperExtraction.js';

export class PaperExtractionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'PaperExtractionError';
  }
}

/**
 * Columns returned to the queue view and to editors.
 *
 * `claim_token` is deliberately absent: it is the credential that lets a run
 * report an outcome, and the queue listing is readable by every editor. Only
 * the two paths that hand a job to the run that owns it (`claimNextJob`,
 * `listJobsClaimedBy`) return it.
 */
const publicJobColumns = {
  id: paperExtractionJobs.id,
  citationId: paperExtractionJobs.citationId,
  status: paperExtractionJobs.status,
  scopeNote: paperExtractionJobs.scopeNote,
  targetDrugIds: paperExtractionJobs.targetDrugIds,
  requestedBy: paperExtractionJobs.requestedBy,
  claimedBy: paperExtractionJobs.claimedBy,
  claimedAt: paperExtractionJobs.claimedAt,
  attempts: paperExtractionJobs.attempts,
  lastError: paperExtractionJobs.lastError,
  resultSummary: paperExtractionJobs.resultSummary,
  factsSubmitted: paperExtractionJobs.factsSubmitted,
  pendingEditIds: paperExtractionJobs.pendingEditIds,
  completedAt: paperExtractionJobs.completedAt,
  createdAt: paperExtractionJobs.createdAt,
  updatedAt: paperExtractionJobs.updatedAt,
};

/** The claim holder's view — adds the token it must present to report. */
const claimHolderJobColumns = {
  ...publicJobColumns,
  claimToken: paperExtractionJobs.claimToken,
};

export interface PaperExtractionJobRow {
  id: number;
  citationId: number;
  status: string;
  scopeNote: string | null;
  targetDrugIds: number[] | null;
  requestedBy: number | null;
  claimedBy: number | null;
  claimedAt: Date | null;
  attempts: number;
  lastError: string | null;
  resultSummary: string | null;
  factsSubmitted: number | null;
  pendingEditIds: number[] | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A job as returned to the run holding its claim. */
export interface ClaimedPaperExtractionJobRow extends PaperExtractionJobRow {
  claimToken: string | null;
}

/** A job joined with the citation it points at, for the queue view. */
export interface PaperExtractionJobDetail extends PaperExtractionJobRow {
  citationType: string;
  citationIdentifier: string;
  citationMetadata: unknown;
  requestedByUsername: string | null;
  claimedByUsername: string | null;
  /** Whether the paper already carries a read-in-full agent review. */
  hasPaperReview: boolean;
}

/**
 * A paper with no stored full text is not extractable, so the enqueue path
 * refuses it and the claim path filters it out. The second check is not
 * redundant: a stored PDF can be replaced or (via the citation cascade)
 * removed between enqueue and claim, and an agent handed a job whose bytes are
 * gone would burn a whole cycle discovering that.
 */
const citationHasStoredPdf = sql`exists (
  select 1 from ${citationPdfs}
  where ${citationPdfs.citationId} = ${paperExtractionJobs.citationId}
)`;

export async function listJobs(options: {
  status?: PaperExtractionStatus | 'open';
  limit?: number;
}): Promise<PaperExtractionJobDetail[]> {
  const db = getDb();
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);

  // Both the editor who queued the paper and the agent that claimed it are
  // rows in `users`, so the listing self-joins under two aliases.
  const requester = alias(users, 'requester');
  const claimer = alias(users, 'claimer');

  const statusFilter =
    options.status === 'open'
      ? inArray(paperExtractionJobs.status, ['queued', 'claimed'])
      : options.status
        ? eq(paperExtractionJobs.status, options.status)
        : undefined;

  const rows = await db
    .select({
      ...publicJobColumns,
      citationType: citations.type,
      citationIdentifier: citations.identifier,
      citationMetadata: citations.metadata,
      requestedByUsername: requester.username,
      claimedByUsername: claimer.username,
      hasPaperReview: sql<boolean>`${paperReviews.id} is not null`,
    })
    .from(paperExtractionJobs)
    .innerJoin(citations, eq(citations.id, paperExtractionJobs.citationId))
    .leftJoin(requester, eq(requester.id, paperExtractionJobs.requestedBy))
    .leftJoin(claimer, eq(claimer.id, paperExtractionJobs.claimedBy))
    .leftJoin(
      paperReviews,
      eq(paperReviews.citationId, paperExtractionJobs.citationId),
    )
    .where(statusFilter)
    // Open work first, then history — each newest-first inside its group.
    //
    // Sorting purely by recency would let settled jobs bury live ones: the
    // queue page reads the unfiltered list with a `limit`, and it has neither
    // pagination nor a status filter, so once the history outgrows one page an
    // older `queued`/`claimed` job scrolls off the end and the editor can no
    // longer see — or cancel — work that is still stuck. Open jobs are bounded
    // (one per paper) and are the whole point of the page, so they lead
    // regardless of how much history accumulates behind them.
    .orderBy(
      sql`case when ${paperExtractionJobs.status} in ('queued', 'claimed') then 0 else 1 end`,
      desc(paperExtractionJobs.createdAt),
    )
    .limit(limit);

  return rows as PaperExtractionJobDetail[];
}

/**
 * Read one job, including its claim token — the route needs it to verify that
 * a reporting run still holds the claim it is reporting on.
 */
export async function getJob(
  id: number,
): Promise<ClaimedPaperExtractionJobRow | null> {
  const db = getDb();
  const [row] = await db
    .select(claimHolderJobColumns)
    .from(paperExtractionJobs)
    .where(eq(paperExtractionJobs.id, id))
    .limit(1);
  return (row as ClaimedPaperExtractionJobRow | undefined) ?? null;
}

/** Count of jobs still awaiting an extraction run — feeds the editor badge. */
export async function countOpenJobs(): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(paperExtractionJobs)
    .where(inArray(paperExtractionJobs.status, ['queued', 'claimed']));
  return row?.count ?? 0;
}

/**
 * Enqueue a paper for extraction.
 *
 * Rejects a citation with no stored full text: the whole point of the queue is
 * that the reading material is already in hand, and a job the agent can never
 * start would sit at the head of the queue forever. The `queued`/`claimed`
 * partial unique index makes a double-enqueue a clean 409 rather than two
 * agents racing to file the same facts.
 */
export async function enqueueJob(input: {
  citationId: number;
  scopeNote?: string | null;
  targetDrugIds?: number[] | null;
  requestedBy: number;
}): Promise<PaperExtractionJobRow> {
  const db = getDb();

  const [citation] = await db
    .select({ id: citations.id, type: citations.type })
    .from(citations)
    .where(eq(citations.id, input.citationId))
    .limit(1);
  if (!citation) {
    throw new PaperExtractionError(
      'paper_extraction_citation_not_found',
      'Citation not found',
      404,
    );
  }
  // A freetext citation names no retrievable paper, so there is nothing to
  // upload and nothing to read. Same rule the PDF-request queue applies.
  if (citation.type === 'freetext') {
    throw new PaperExtractionError(
      'paper_extraction_unresolvable_citation',
      'Fact extraction requires a resolvable citation',
    );
  }

  const [pdf] = await db
    .select({ id: citationPdfs.id })
    .from(citationPdfs)
    .where(eq(citationPdfs.citationId, input.citationId))
    .limit(1);
  if (!pdf) {
    throw new PaperExtractionError(
      'paper_extraction_missing_pdf',
      'Upload the full text before queueing the paper for extraction',
    );
  }

  const [existing] = await db
    .select({ id: paperExtractionJobs.id, status: paperExtractionJobs.status })
    .from(paperExtractionJobs)
    .where(
      and(
        eq(paperExtractionJobs.citationId, input.citationId),
        inArray(paperExtractionJobs.status, ['queued', 'claimed']),
      ),
    )
    .limit(1);
  if (existing) {
    throw new PaperExtractionError(
      'paper_extraction_already_queued',
      `Paper is already in the extraction queue (job ${existing.id})`,
      409,
    );
  }

  // The check above is a preflight, not a lock: two editors enqueueing the
  // same paper at once (or one double-click) both pass it, and the loser hits
  // the partial unique index. That collision is the *expected* answer —
  // "already queued" — so translate it rather than letting a 23505 escape as a
  // 500 on an ordinary double-click.
  try {
    const [row] = await db
      .insert(paperExtractionJobs)
      .values({
        citationId: input.citationId,
        status: 'queued',
        scopeNote: input.scopeNote ?? null,
        targetDrugIds: input.targetDrugIds?.length ? input.targetDrugIds : null,
        requestedBy: input.requestedBy,
      })
      .returning(publicJobColumns);

    return row as PaperExtractionJobRow;
  } catch (err) {
    if (isOpenJobUniqueViolation(err)) {
      throw new PaperExtractionError(
        'paper_extraction_already_queued',
        'Paper is already in the extraction queue',
        409,
      );
    }
    throw err;
  }
}

/** The partial unique index that allows at most one OPEN job per paper. */
const OPEN_JOB_INDEX = 'paper_extraction_jobs_open_citation_idx';

/**
 * True for the unique violation raised by `OPEN_JOB_INDEX`.
 *
 * Exported for direct testing: the drivers disagree about the error's shape in
 * ways that are easy to get wrong and hard to reach through the store (the
 * preflight check in `enqueueJob` swallows most collisions before the insert,
 * so an end-to-end test cannot reliably prove this path works).
 *
 * Drizzle wraps the driver error, so the SQLSTATE may sit on the error or on
 * its `cause`. The constraint name is reported as `constraint` by
 * node-postgres/neon and as `constraint_name` by PGlite, and some paths report
 * neither — hence the message fallback, which is reliable because Postgres's
 * standard 23505 text names the constraint. Narrow on the index name so an
 * unrelated 23505 (a concurrent citation insert, say) is never misreported as
 * "already queued".
 */
export function isOpenJobUniqueViolation(err: unknown): boolean {
  const candidates = [err, (err as { cause?: unknown } | null)?.cause];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    if (record.code !== '23505') continue;
    const constraint = record.constraint ?? record.constraint_name;
    if (typeof constraint === 'string') return constraint === OPEN_JOB_INDEX;
    return String(record.message ?? '').includes(OPEN_JOB_INDEX);
  }
  return err instanceof Error && err.message.includes(OPEN_JOB_INDEX);
}

/**
 * Park jobs that have burned their retry budget.
 *
 * A run that dies mid-cycle leaves its job `claimed`; the claim goes stale and
 * the job becomes claimable again, which is what we want for a transient
 * failure. Without a cap, though, a paper that reliably kills the agent (a
 * 400-page scan with no text layer, say) would be re-claimed every cycle and
 * every paper behind it would starve. Once a job has taken
 * MAX_PAPER_EXTRACTION_ATTEMPTS claims without reporting a result, it is moved
 * to `failed` so the queue keeps moving and an editor can see it needs a look.
 * They can `requeue` it after fixing the upload.
 */
async function parkExhaustedJobs(staleBefore: Date): Promise<void> {
  const db = getDb();
  await db
    .update(paperExtractionJobs)
    .set({
      status: 'failed',
      claimedBy: null,
      claimedAt: null,
      claimToken: null,
      lastError: 'paper_extraction_attempts_exhausted',
      updatedAt: new Date(),
    })
    .where(
      and(
        sql`${paperExtractionJobs.attempts} >= ${MAX_PAPER_EXTRACTION_ATTEMPTS}`,
        sql`(
          ${paperExtractionJobs.status} = 'queued'
          or (
            ${paperExtractionJobs.status} = 'claimed'
            and (
              ${paperExtractionJobs.claimedAt} is null
              or ${paperExtractionJobs.claimedAt} < ${staleBefore}
            )
          )
        )`,
      ),
    );
}

/**
 * Atomically claim the oldest extractable job for `userId`, or return null
 * when the queue is empty.
 *
 * One statement, so two agent runs firing on the same schedule cannot both
 * walk away with the same paper: `FOR UPDATE SKIP LOCKED` hands the second
 * caller the next row instead of blocking it. Reclaiming a stale `claimed` row
 * is deliberately part of the same query — a job orphaned by a crashed run is
 * indistinguishable from a queued one after the claim window, and treating it
 * separately would just mean a second round trip.
 */
export async function claimNextJob(
  userId: number,
  now: Date = new Date(),
): Promise<ClaimedPaperExtractionJobRow | null> {
  const db = getDb();
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);

  await parkExhaustedJobs(staleBefore);

  const [row] = await db
    .update(paperExtractionJobs)
    .set({
      status: 'claimed',
      claimedBy: userId,
      claimedAt: now,
      // A fresh token per claim. Reclaiming an orphaned job mints a new one,
      // which is what invalidates the dead run's: `claimed_by` cannot do that
      // job when both runs are the same agent identity.
      claimToken: randomBytes(16).toString('hex'),
      attempts: sql`${paperExtractionJobs.attempts} + 1`,
      updatedAt: now,
    })
    .where(
      sql`${paperExtractionJobs.id} = (
        select ${paperExtractionJobs.id}
        from ${paperExtractionJobs}
        where ${paperExtractionJobs.attempts} < ${MAX_PAPER_EXTRACTION_ATTEMPTS}
          and (
            ${paperExtractionJobs.status} = 'queued'
            or (
              ${paperExtractionJobs.status} = 'claimed'
              and (
                ${paperExtractionJobs.claimedAt} is null
                or ${paperExtractionJobs.claimedAt} < ${staleBefore}
              )
            )
          )
          and ${citationHasStoredPdf}
        order by ${paperExtractionJobs.createdAt} asc
        limit 1
        for update skip locked
      )`,
    )
    .returning(claimHolderJobColumns);

  return (row as ClaimedPaperExtractionJobRow | undefined) ?? null;
}

/**
 * Apply a terminal or releasing action to a job.
 *
 * The `expectedStatuses` guard and the claim checks are all applied in the
 * UPDATE's WHERE clause rather than after a read, so a job that changed
 * underneath the caller (an editor cancelling a run mid-flight, a stale claim
 * taken over by a later cycle) fails the write instead of silently
 * overwriting the newer state.
 */
export async function applyJobAction(input: {
  id: number;
  expectedStatuses: readonly PaperExtractionStatus[];
  nextStatus: PaperExtractionStatus;
  /** When set, the update only lands if this user still holds the claim. */
  claimHolder?: number;
  /**
   * When set, the update only lands if this is still the *current* claim.
   *
   * `claimHolder` alone is not enough. The expected deployment runs one agent
   * identity on a schedule, so a run that died and the run that later
   * reclaimed its job carry the same user id — an owner check would let the
   * dead run wake up late and overwrite its successor's live claim and result.
   * The token changes on every claim, so a stale run simply misses.
   */
  claimToken?: string;
  resultSummary?: string | null;
  factsSubmitted?: number | null;
  pendingEditIds?: number[] | null;
  lastError?: string | null;
  clearClaim?: boolean;
  /** Reset attempts — a requeue gives the paper a fresh retry budget. */
  resetAttempts?: boolean;
  /**
   * Wipe the previous run's output. A requeued job is a *new* extraction: left
   * in place, the old `resultSummary` / `factsSubmitted` / `pendingEditIds`
   * would render on the re-queued card as though this run had produced them.
   */
  clearResult?: boolean;
  now?: Date;
}): Promise<PaperExtractionJobRow | null> {
  const db = getDb();
  const now = input.now ?? new Date();

  const set: Record<string, unknown> = {
    status: input.nextStatus,
    updatedAt: now,
  };
  if (input.clearClaim) {
    set.claimedBy = null;
    set.claimedAt = null;
    // Retiring the claim retires its token; the next claim mints a fresh one.
    set.claimToken = null;
  }
  if (input.resetAttempts) set.attempts = 0;
  if (input.clearResult) {
    set.resultSummary = null;
    set.factsSubmitted = null;
    set.pendingEditIds = null;
  }
  if (input.resultSummary !== undefined) set.resultSummary = input.resultSummary;
  if (input.factsSubmitted !== undefined) {
    set.factsSubmitted = input.factsSubmitted;
  }
  if (input.pendingEditIds !== undefined) {
    set.pendingEditIds = input.pendingEditIds;
  }
  if (input.lastError !== undefined) set.lastError = input.lastError;
  set.completedAt = input.nextStatus === 'completed' ? now : null;

  const conditions = [
    eq(paperExtractionJobs.id, input.id),
    inArray(paperExtractionJobs.status, [...input.expectedStatuses]),
  ];
  if (input.claimHolder !== undefined) {
    conditions.push(eq(paperExtractionJobs.claimedBy, input.claimHolder));
  }
  if (input.claimToken !== undefined) {
    conditions.push(eq(paperExtractionJobs.claimToken, input.claimToken));
  }

  // Reopening a job can collide with the one-open-job-per-paper index just as
  // an enqueue can: a settled job and a newer open one for the same paper is a
  // normal state (the queue page shows "Queue again" on every settled card,
  // and the paper may have been re-enqueued since), so clicking it on the
  // older card asks for a second open row. The index is right to refuse; this
  // must read as the same "already queued" conflict as the enqueue path, not
  // as a server error.
  try {
    const [row] = await db
      .update(paperExtractionJobs)
      .set(set)
      .where(and(...conditions))
      .returning(publicJobColumns);

    return (row as PaperExtractionJobRow | undefined) ?? null;
  } catch (err) {
    if (isOpenJobUniqueViolation(err)) {
      throw new PaperExtractionError(
        'paper_extraction_already_queued',
        'This paper is already back in the extraction queue',
        409,
      );
    }
    throw err;
  }
}

/**
 * The live claims held by one agent **identity**.
 *
 * This is a verification endpoint, not a work-selection one. A run uses it to
 * confirm it still owns the job it is working — matching on the job id *and*
 * the claim token it holds — before each fact submission, so that an editor's
 * cancel takes effect mid-run.
 *
 * It deliberately cannot be used to pick up work: every invocation of a
 * scheduled routine shares one identity, so a row here may belong to a sibling
 * invocation running right now rather than to a dead predecessor, and a fresh
 * run has no way to tell those apart. An agent that "resumed" from this list
 * would sometimes duplicate a live run's paper — the exact failure the atomic
 * claim exists to prevent. Work is only ever taken through `claimNextJob`,
 * which also keeps the attempt accounting honest.
 *
 * The staleness filter is a second line of the same defence: an expired claim
 * is the residue of a dead run, not work in progress, and returning it would
 * additionally let a run bypass `claimNextJob`'s attempt counting.
 */
export async function listJobsClaimedBy(
  userId: number,
  now: Date = new Date(),
): Promise<ClaimedPaperExtractionJobRow[]> {
  const db = getDb();
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  const rows = await db
    .select(claimHolderJobColumns)
    .from(paperExtractionJobs)
    .where(
      and(
        eq(paperExtractionJobs.claimedBy, userId),
        eq(paperExtractionJobs.status, 'claimed'),
        gte(paperExtractionJobs.claimedAt, staleBefore),
      ),
    )
    .orderBy(asc(paperExtractionJobs.claimedAt))
    .limit(20);
  return rows as ClaimedPaperExtractionJobRow[];
}

/**
 * The paper a live claim covers, or `null` when the caller does not hold
 * that claim right now.
 *
 * `POST /api/pending-edits` uses this to recognise a `wiki_fact` filed on
 * behalf of a queued extraction job. Such a fact is exempt from the admin
 * agent-focus gate — an editor deliberately handed the agent this paper, which
 * is a narrower and more recent instruction than the standing focus — so the
 * exemption has to rest on proof, not on the agent's say-so: the same
 * identity, the same token, a claim that has not gone stale. The citation is
 * returned so the caller can also require the fact to cite the job's paper;
 * holding a claim on one paper must not unlock unscoped writes from another.
 */
export async function liveClaimCitationId(input: {
  jobId: number;
  claimToken: string;
  userId: number;
  now?: Date;
}): Promise<number | null> {
  const db = getDb();
  const now = input.now ?? new Date();
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  const [row] = await db
    .select({ citationId: paperExtractionJobs.citationId })
    .from(paperExtractionJobs)
    .where(
      and(
        eq(paperExtractionJobs.id, input.jobId),
        eq(paperExtractionJobs.claimedBy, input.userId),
        eq(paperExtractionJobs.claimToken, input.claimToken),
        eq(paperExtractionJobs.status, 'claimed'),
        gte(paperExtractionJobs.claimedAt, staleBefore),
      ),
    )
    .limit(1);
  return row?.citationId ?? null;
}
