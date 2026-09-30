/**
 * Paper fact-extraction queue.
 *
 *   GET    /api/paper-extractions                 — the queue (editor+)
 *   GET    /api/paper-extractions?status=queued   — filtered; `open` = queued+claimed
 *   GET    /api/paper-extractions?countOnly=1     — open-queue size (editor+)
 *   GET    /api/paper-extractions?view=mine       — the caller's live claims (agent)
 *   POST   /api/paper-extractions?citationId=N    — enqueue a paper (editor+)
 *   POST   /api/paper-extractions?action=claim    — atomically claim the next
 *                                                   job (contributor+, i.e. the
 *                                                   scheduled agent)
 *   PATCH  /api/paper-extractions?id=N            — report a run outcome
 *                                                   (claim holder) or steer the
 *                                                   queue (editor+)
 *
 * Two audiences, two permission tiers. **Filling** the queue is an editorial
 * act — deciding a paper is worth an extraction run costs agent cycles and
 * puts facts in front of reviewers — so it needs editor+, matching the tier
 * that reviews the resulting `wiki_fact` edits. **Draining** it is contributor
 * work: the scheduled agent runs at contributor tier by design (see
 * agents/drug-db-maintainer.md §1), and everything it produces goes through
 * the same review queue as any other contributor edit. Nothing on this route
 * writes wiki content.
 *
 * `scopeNote` is editor-authored free text handed to an LLM agent. It is
 * stored and returned verbatim as *data*; the agent spec
 * (agents/paper-fact-extractor.md) is explicit that it is a steer to weigh,
 * never instructions to follow.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  json,
  error,
  noStoreHeaders,
  withErrorHandling,
} from './_lib/response.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import {
  createPaperExtractionSchema,
  updatePaperExtractionSchema,
} from './_lib/schemas.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import {
  canApplyPaperExtractionAction,
  isClaimHolderAction,
  isPaperExtractionStatus,
  paperExtractionActionResult,
  type PaperExtractionAction,
  type PaperExtractionStatus,
} from '../src/lib/paperExtraction.js';
import {
  PaperExtractionError,
  applyJobAction,
  claimNextJob,
  countOpenJobs,
  enqueueJob,
  getJob,
  listJobs,
  listJobsClaimedBy,
} from './_lib/paper-extraction-store.js';

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );

    switch (req.method) {
      case 'GET':
        return handleGet(req, res, url);
      case 'POST':
        assertSameOrigin(req);
        return handlePost(req, res, url);
      case 'PATCH':
        assertSameOrigin(req);
        return handlePatch(req, res, url);
      default:
        error(res, 405, 'Method not allowed');
    }
  },
);

function parsePositiveInt(value: string | null): number | null {
  const n = Number(value);
  if (!n || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }

  // The agent's own live claims. Contributor-tier because that is the tier the
  // scheduled agent runs at, and the response is scoped to the caller's own
  // rows — it exposes nothing about the wider queue.
  if (url.searchParams.get('view') === 'mine') {
    if (!(await callerCan(auth.role, CAP['paperExtraction.claim']))) {
      error(res, 403, 'Contributor role required');
      return;
    }
    const jobs = await listJobsClaimedBy(auth.userId);
    json(res, 200, { jobs }, { headers: noStoreHeaders() });
    return;
  }

  if (!(await callerCan(auth.role, CAP['paperExtraction.queue.read']))) {
    error(res, 403, 'Editor role required');
    return;
  }

  const countOnly = url.searchParams.get('countOnly');
  if (countOnly === '1' || countOnly === 'true') {
    const count = await countOpenJobs();
    json(res, 200, { count }, { headers: noStoreHeaders() });
    return;
  }

  const statusParam = url.searchParams.get('status');
  if (
    statusParam !== null &&
    statusParam !== 'open' &&
    !isPaperExtractionStatus(statusParam)
  ) {
    error(res, 400, 'Invalid status', 'paper_extraction_invalid_status');
    return;
  }

  const jobs = await listJobs({
    status: (statusParam as PaperExtractionStatus | 'open' | null) ?? undefined,
    limit: parsePositiveInt(url.searchParams.get('limit')) ?? undefined,
  });
  json(res, 200, { jobs }, { headers: noStoreHeaders() });
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }

  if (url.searchParams.get('action') === 'claim') {
    if (!(await callerCan(auth.role, CAP['paperExtraction.claim']))) {
      error(res, 403, 'Contributor role required');
      return;
    }
    const job = await claimNextJob(auth.userId);
    // An empty queue is a normal, frequent outcome for a scheduled run — not
    // an error. 200 with `job: null` keeps the agent's helper script from
    // treating "nothing to do" as a failed cycle.
    json(res, 200, { job }, { headers: noStoreHeaders() });
    return;
  }

  if (!(await callerCan(auth.role, CAP['paperExtraction.manage']))) {
    error(res, 403, 'Editor role required');
    return;
  }

  const citationId = parsePositiveInt(url.searchParams.get('citationId'));
  if (!citationId) {
    error(res, 400, 'Missing or invalid citationId');
    return;
  }

  const parsed = await parseAndValidate(req, createPaperExtractionSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  try {
    const job = await enqueueJob({
      citationId,
      scopeNote: parsed.data.scopeNote ?? null,
      targetDrugIds: parsed.data.targetDrugIds ?? null,
      requestedBy: auth.userId,
    });
    json(res, 201, { job }, { headers: noStoreHeaders() });
  } catch (err) {
    if (err instanceof PaperExtractionError) {
      error(res, err.status, err.message, err.code);
      return;
    }
    throw err;
  }
}

async function handlePatch(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  if (!(await callerCan(auth.role, CAP['paperExtraction.claim']))) {
    error(res, 403, 'Contributor role required');
    return;
  }

  const id = parsePositiveInt(url.searchParams.get('id'));
  if (!id) {
    error(res, 400, 'Missing or invalid id');
    return;
  }

  const parsed = await parseAndValidate(req, updatePaperExtractionSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }
  const payload = parsed.data;
  const action = payload.action as PaperExtractionAction;

  // Queue steering (cancel / requeue) is an editorial decision about which
  // papers get agent time, so it sits at the same tier as enqueueing.
  if (
    !isClaimHolderAction(action) &&
    !(await callerCan(auth.role, CAP['paperExtraction.manage']))
  ) {
    error(res, 403, 'Editor role required');
    return;
  }

  const job = await getJob(id);
  if (!job) {
    error(res, 404, 'Extraction job not found');
    return;
  }
  if (!isPaperExtractionStatus(job.status)) {
    error(
      res,
      409,
      'Extraction job is in an unknown state',
      'paper_extraction_invalid_status',
    );
    return;
  }
  if (!canApplyPaperExtractionAction(job.status, action)) {
    error(
      res,
      409,
      `Cannot ${action} a job in status '${job.status}'`,
      'paper_extraction_illegal_transition',
    );
    return;
  }

  // Only the run holding the claim may report its outcome — and "the run",
  // not merely "the agent": the expected deployment runs one identity on a
  // schedule, so a run that died and the run that later reclaimed its job
  // share a user id. The per-claim token is what separates them, so a stale
  // run waking up late cannot overwrite its successor's result.
  const claimHolder = isClaimHolderAction(action) ? auth.userId : undefined;
  const claimToken =
    payload.action === 'complete' ||
    payload.action === 'fail' ||
    payload.action === 'release'
      ? payload.claimToken
      : undefined;
  if (
    claimHolder !== undefined &&
    (job.claimedBy !== claimHolder ||
      !job.claimToken ||
      job.claimToken !== claimToken)
  ) {
    error(
      res,
      409,
      'Extraction job is claimed by another run',
      'paper_extraction_not_claim_holder',
    );
    return;
  }

  let updated: Awaited<ReturnType<typeof applyJobAction>>;
  try {
    updated = await applyJobAction({
      id,
      expectedStatuses: [job.status],
      nextStatus: paperExtractionActionResult(action),
      claimHolder,
      claimToken,
      resultSummary:
        payload.action === 'complete' ? payload.resultSummary : undefined,
      factsSubmitted:
        payload.action === 'complete' ? payload.factsSubmitted : undefined,
      pendingEditIds:
        payload.action === 'complete'
          ? (payload.pendingEditIds ?? [])
          : undefined,
      lastError:
        payload.action === 'fail'
          ? payload.error
          : payload.action === 'cancel'
            ? (payload.reason ?? null)
            : payload.action === 'requeue'
              ? null
              : undefined,
      // A released, cancelled or requeued job must not keep pointing at the
      // run that last held it — the next claim would otherwise inherit a
      // stale owner in the queue view.
      clearClaim: action !== 'complete' && action !== 'fail',
      resetAttempts: action === 'requeue',
      // A requeue starts a *new* extraction of the paper. Carrying the
      // previous run's summary and fact count onto the re-queued job would
      // show the editor last run's output as if this one had produced it.
      clearResult: action === 'requeue',
    });
  } catch (err) {
    // A requeue can collide with the one-open-job-per-paper index when the
    // paper was already queued again since this job settled.
    if (err instanceof PaperExtractionError) {
      error(res, err.status, err.message, err.code);
      return;
    }
    throw err;
  }

  if (!updated) {
    // The row moved between the read above and the write: another run took
    // over an expired claim, or an editor cancelled it mid-flight.
    error(
      res,
      409,
      'Extraction job changed while the update was in flight',
      'paper_extraction_conflict',
    );
    return;
  }

  json(res, 200, { job: updated }, { headers: noStoreHeaders() });
}
