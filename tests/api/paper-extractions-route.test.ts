/**
 * Route-level guards on the paper fact-extraction queue.
 *
 * The interesting surface here is the two-tier permission split — filling the
 * queue is editor+, draining it is contributor+ — and the claim-holder check
 * that stops a run whose claim already expired from overwriting its
 * successor's result. Both are pure route logic, so they are exercised against
 * a mocked store; the SQL (atomic claim, stale reclaim, attempt cap) is
 * covered by tests/integration/paper-extraction-queue.test.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getUserFromRequestMock,
  applyJobActionMock,
  claimNextJobMock,
  countOpenJobsMock,
  enqueueJobMock,
  getJobMock,
  listJobsMock,
  listJobsClaimedByMock,
} = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
  applyJobActionMock: vi.fn(),
  claimNextJobMock: vi.fn(),
  countOpenJobsMock: vi.fn(),
  enqueueJobMock: vi.fn(),
  getJobMock: vi.fn(),
  listJobsMock: vi.fn(),
  listJobsClaimedByMock: vi.fn(),
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

vi.mock('../../api/_lib/paper-extraction-store.js', async () => {
  // PaperExtractionError is a real class the route instanceof-checks, so the
  // mock must keep the genuine one rather than a stub.
  const actual = await vi.importActual<
    typeof import('../../api/_lib/paper-extraction-store.js')
  >('../../api/_lib/paper-extraction-store.js');
  return {
    PaperExtractionError: actual.PaperExtractionError,
    applyJobAction: applyJobActionMock,
    claimNextJob: claimNextJobMock,
    countOpenJobs: countOpenJobsMock,
    enqueueJob: enqueueJobMock,
    getJob: getJobMock,
    listJobs: listJobsMock,
    listJobsClaimedBy: listJobsClaimedByMock,
  };
});

import handler from '../../api/paper-extractions.ts';
import { PaperExtractionError } from '../../api/_lib/paper-extraction-store.ts';

function createResponse(): {
  res: ServerResponse;
  state: { statusCode: number; body: string; headers: Record<string, unknown> };
} {
  const state = {
    statusCode: 200,
    body: '',
    headers: {} as Record<string, unknown>,
  };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number, headers?: Record<string, unknown>) => {
      state.statusCode = statusCode;
      state.headers = headers ?? {};
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

function request(
  method: string,
  url: string,
  body?: unknown,
): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [raw] : []) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    host: 'localhost',
    ...(raw
      ? {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(raw)),
        }
      : {}),
  };
  return req;
}

const CLAIM_TOKEN = 'a'.repeat(32);

const JOB = {
  id: 5,
  citationId: 12,
  status: 'claimed',
  scopeNote: null,
  targetDrugIds: null,
  requestedBy: 1,
  claimedBy: 42,
  claimedAt: new Date('2026-08-01T10:00:00Z'),
  claimToken: CLAIM_TOKEN,
  attempts: 1,
  lastError: null,
  resultSummary: null,
  factsSubmitted: null,
  pendingEditIds: null,
  completedAt: null,
  createdAt: new Date('2026-08-01T09:00:00Z'),
  updatedAt: new Date('2026-08-01T10:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  getUserFromRequestMock.mockResolvedValue({ userId: 42, role: 'editor' });
});

describe('POST /api/paper-extractions (enqueue)', () => {
  it('refuses a contributor — filling the queue is editorial', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'contributor',
    });
    const { res, state } = createResponse();

    await handler(
      request('POST', '/api/paper-extractions?citationId=12', {}),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });

  it('queues a paper for an editor and stamps the requester', async () => {
    enqueueJobMock.mockResolvedValue({ ...JOB, status: 'queued' });
    const { res, state } = createResponse();

    await handler(
      request('POST', '/api/paper-extractions?citationId=12', {
        scopeNote: 'kun postmortem-kohorten',
      }),
      res,
    );

    expect(state.statusCode).toBe(201);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(enqueueJobMock).toHaveBeenCalledWith({
      citationId: 12,
      scopeNote: 'kun postmortem-kohorten',
      targetDrugIds: null,
      requestedBy: 42,
    });
  });

  it('surfaces the store error code for a paper with no stored full text', async () => {
    enqueueJobMock.mockRejectedValue(
      new PaperExtractionError(
        'paper_extraction_missing_pdf',
        'Upload the full text first',
      ),
    );
    const { res, state } = createResponse();

    await handler(
      request('POST', '/api/paper-extractions?citationId=12', {}),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'paper_extraction_missing_pdf',
    });
  });

  it('rejects an unknown body field rather than silently dropping it', async () => {
    const { res, state } = createResponse();

    await handler(
      request('POST', '/api/paper-extractions?citationId=12', {
        // A steer the schema does not know about must not be accepted and
        // then ignored — the editor would think it took effect.
        priority: 'urgent',
      }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/paper-extractions?action=claim', () => {
  it('lets the contributor-tier agent claim', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'contributor',
    });
    claimNextJobMock.mockResolvedValue(JOB);
    const { res, state } = createResponse();

    await handler(request('POST', '/api/paper-extractions?action=claim'), res);

    expect(state.statusCode).toBe(200);
    expect(claimNextJobMock).toHaveBeenCalledWith(7);
    expect(JSON.parse(state.body).job.id).toBe(5);
  });

  it('returns 200 with a null job on an empty queue, not an error', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'contributor',
    });
    claimNextJobMock.mockResolvedValue(null);
    const { res, state } = createResponse();

    await handler(request('POST', '/api/paper-extractions?action=claim'), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ job: null });
  });

  it('refuses an authenticated user below contributor', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'authenticated',
    });
    const { res, state } = createResponse();

    await handler(request('POST', '/api/paper-extractions?action=claim'), res);

    expect(state.statusCode).toBe(403);
    expect(claimNextJobMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/paper-extractions (run outcomes)', () => {
  it('lets the claim holder complete its own job', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'contributor',
    });
    getJobMock.mockResolvedValue(JOB);
    applyJobActionMock.mockResolvedValue({ ...JOB, status: 'completed' });
    const { res, state } = createResponse();

    await handler(
      request('PATCH', '/api/paper-extractions?id=5', {
        action: 'complete',
        claimToken: CLAIM_TOKEN,
        resultSummary: 'Leste artikkelen i sin helhet.',
        factsSubmitted: 2,
        pendingEditIds: [901, 902],
      }),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(applyJobActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 5,
        nextStatus: 'completed',
        claimHolder: 42,
        claimToken: CLAIM_TOKEN,
        factsSubmitted: 2,
        pendingEditIds: [901, 902],
      }),
    );
  });

  it('refuses a run that no longer holds the claim', async () => {
    // The claim expired and a later cycle took the job over; this run must not
    // be able to write its stale result over the new holder's work.
    getUserFromRequestMock.mockResolvedValue({
      userId: 99,
      role: 'contributor',
    });
    getJobMock.mockResolvedValue(JOB);
    const { res, state } = createResponse();

    await handler(
      request('PATCH', '/api/paper-extractions?id=5', {
        action: 'complete',
        claimToken: CLAIM_TOKEN,
        resultSummary: 'stale',
        factsSubmitted: 0,
      }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'paper_extraction_not_claim_holder',
    });
    expect(applyJobActionMock).not.toHaveBeenCalled();
  });

  it('refuses a stale run of the SAME agent whose claim was reissued', async () => {
    // The expected deployment runs one agent identity on a schedule, so a run
    // that died and the run that reclaimed its job share a user id. Only the
    // per-claim token separates them — without this check the stale run would
    // pass the owner check and overwrite its successor's result.
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'contributor',
    });
    getJobMock.mockResolvedValue({ ...JOB, claimToken: 'b'.repeat(32) });
    const { res, state } = createResponse();

    await handler(
      request('PATCH', '/api/paper-extractions?id=5', {
        action: 'complete',
        claimToken: CLAIM_TOKEN, // the token from the superseded claim
        resultSummary: 'stale',
        factsSubmitted: 3,
      }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'paper_extraction_not_claim_holder',
    });
    expect(applyJobActionMock).not.toHaveBeenCalled();
  });

  it('requires a claim token on every run outcome', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'contributor',
    });
    getJobMock.mockResolvedValue(JOB);

    for (const payload of [
      { action: 'complete', resultSummary: 'x', factsSubmitted: 0 },
      { action: 'fail', error: 'x' },
      { action: 'release' },
    ]) {
      const { res, state } = createResponse();
      await handler(
        request('PATCH', '/api/paper-extractions?id=5', payload),
        res,
      );
      expect(state.statusCode).toBe(400);
    }
    expect(applyJobActionMock).not.toHaveBeenCalled();
  });

  it('refuses an action illegal from the job’s current state', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'contributor',
    });
    getJobMock.mockResolvedValue({ ...JOB, status: 'completed' });
    const { res, state } = createResponse();

    await handler(
      request('PATCH', '/api/paper-extractions?id=5', {
        action: 'complete',
        claimToken: CLAIM_TOKEN,
        resultSummary: 'again',
        factsSubmitted: 1,
      }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'paper_extraction_illegal_transition',
    });
    expect(applyJobActionMock).not.toHaveBeenCalled();
  });

  it('reports a conflict when the row moved between read and write', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'contributor',
    });
    getJobMock.mockResolvedValue(JOB);
    applyJobActionMock.mockResolvedValue(null);
    const { res, state } = createResponse();

    await handler(
      request('PATCH', '/api/paper-extractions?id=5', {
        action: 'fail',
        claimToken: CLAIM_TOKEN,
        error: 'stored_pdf_unreadable_or_image_only',
      }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'paper_extraction_conflict',
    });
  });

  it('keeps cancel and requeue at the editor tier', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'contributor',
    });
    const { res, state } = createResponse();

    await handler(
      request('PATCH', '/api/paper-extractions?id=5', { action: 'cancel' }),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(getJobMock).not.toHaveBeenCalled();
  });

  it('reports a requeue that collides with a newer open job as a conflict', async () => {
    // The paper was re-enqueued after this job settled, so reopening the old
    // card asks for a second open row. That must read as "already queued",
    // not as a server error.
    getJobMock.mockResolvedValue({ ...JOB, status: 'completed' });
    applyJobActionMock.mockRejectedValue(
      new PaperExtractionError(
        'paper_extraction_already_queued',
        'This paper is already back in the extraction queue',
        409,
      ),
    );
    const { res, state } = createResponse();

    await handler(
      request('PATCH', '/api/paper-extractions?id=5', { action: 'requeue' }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'paper_extraction_already_queued',
    });
  });

  it('clears the claim and resets the retry budget on an editor requeue', async () => {
    getJobMock.mockResolvedValue({ ...JOB, status: 'failed', attempts: 3 });
    applyJobActionMock.mockResolvedValue({ ...JOB, status: 'queued' });
    const { res, state } = createResponse();

    await handler(
      request('PATCH', '/api/paper-extractions?id=5', { action: 'requeue' }),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(applyJobActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        nextStatus: 'queued',
        clearClaim: true,
        resetAttempts: true,
        clearResult: true,
        lastError: null,
        claimHolder: undefined,
      }),
    );
  });
});

describe('GET /api/paper-extractions', () => {
  it('hides the queue from contributors but shows them their own claims', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'contributor',
    });

    const denied = createResponse();
    await handler(request('GET', '/api/paper-extractions'), denied.res);
    expect(denied.state.statusCode).toBe(403);
    expect(listJobsMock).not.toHaveBeenCalled();

    listJobsClaimedByMock.mockResolvedValue([JOB]);
    const mine = createResponse();
    await handler(request('GET', '/api/paper-extractions?view=mine'), mine.res);
    expect(mine.state.statusCode).toBe(200);
    expect(listJobsClaimedByMock).toHaveBeenCalledWith(7);
  });

  it('rejects an unknown status filter', async () => {
    const { res, state } = createResponse();

    await handler(
      request('GET', '/api/paper-extractions?status=bogus'),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(listJobsMock).not.toHaveBeenCalled();
  });

  it('accepts the open pseudo-status', async () => {
    listJobsMock.mockResolvedValue([]);
    const { res, state } = createResponse();

    await handler(request('GET', '/api/paper-extractions?status=open'), res);

    expect(state.statusCode).toBe(200);
    expect(listJobsMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'open' }),
    );
  });

  it('rejects an unauthenticated caller', async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const { res, state } = createResponse();

    await handler(request('GET', '/api/paper-extractions'), res);

    expect(state.statusCode).toBe(401);
  });
});
