import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  getUserFromRequestMock,
  recordPaperReviewMock,
  listPaperReviewHistoryMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
  recordPaperReviewMock: vi.fn(),
  listPaperReviewHistoryMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
  // The auto-publish path wraps recordPaperReview in a pool transaction; run the
  // callback inline against the same mocked getDb() so the writes still hit it.
  runInPoolTransaction: (fn: () => unknown) => fn(),
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

vi.mock('../../api/_lib/paper-review-store.js', () => ({
  recordPaperReview: recordPaperReviewMock,
  listPaperReviewHistory: listPaperReviewHistoryMock,
}));

import handler from '../../api/paper-reviews.ts';

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
    writeHead: vi.fn(
      (statusCode: number, headers?: Record<string, unknown>) => {
        state.statusCode = statusCode;
        state.headers = headers ?? {};
        return res;
      },
    ),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

function createJsonRequest(body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'POST';
  req.url = '/api/paper-reviews?citationId=12';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(raw),
  };
  return req;
}

function createGetRequest(url: string): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = 'GET';
  req.url = url;
  req.headers = { host: 'localhost' };
  return req;
}

// Chainable select mock; each `.limit()` resolves the next queued result set.
function mockDb(selectResults: unknown[][]) {
  let selectCall = 0;
  const limit = vi.fn(() => {
    const result = selectResults[selectCall] ?? [];
    selectCall += 1;
    return Promise.resolve(result);
  });
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const db = { select };
  getDbMock.mockReturnValue(db);
  return { db };
}

const validBody = {
  reviewMarkdown: 'Review',
  readInFull: true,
  overallScore: 80,
  conclusionSupport: 'supported',
  reviewConfidence: 'high',
  editSummary: 'Oppdatert etter ny fulltekst',
};

describe('POST /api/paper-reviews (auto-publish)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'contributor',
    });
    recordPaperReviewMock.mockResolvedValue({
      id: 5,
      citationId: 12,
      revisionId: 7,
    });
  });

  it('rejects contributor accounts that are not an active agent', async () => {
    mockDb([[]]); // agents lookup returns none
    const { res, state } = createResponse();

    await handler(createJsonRequest(validBody), res);

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toEqual({ error: 'Active agent required' });
    expect(recordPaperReviewMock).not.toHaveBeenCalled();
  });

  it('rejects freetext citations before writing a review', async () => {
    mockDb([[{ id: 9 }], [{ id: 12, type: 'freetext' }]]);
    const { res, state } = createResponse();

    await handler(createJsonRequest(validBody), res);

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'paper_review_unresolvable_citation',
    });
    expect(recordPaperReviewMock).not.toHaveBeenCalled();
  });

  it('auto-publishes the review and returns the live row (no pending edit)', async () => {
    const liveReview = {
      id: 5,
      citationId: 12,
      reviewMarkdown: 'Review',
      overallScore: 80,
      conclusionSupport: 'supported',
      reviewConfidence: 'high',
      readInFull: true,
    };
    mockDb([[{ id: 9 }], [{ id: 12, type: 'doi' }], [liveReview]]);
    const { res, state } = createResponse();

    await handler(createJsonRequest(validBody), res);

    expect(state.statusCode).toBe(201);
    expect(recordPaperReviewMock).toHaveBeenCalledWith({
      citationId: 12,
      authorUserId: 42,
      input: {
        reviewMarkdown: 'Review',
        overallScore: 80,
        conclusionSupport: 'supported',
        reviewConfidence: 'high',
        readInFull: true,
        editSummary: 'Oppdatert etter ny fulltekst',
      },
    });
    const parsed = JSON.parse(state.body);
    expect(parsed).toMatchObject({ review: liveReview, revisionId: 7 });
    // No pending edit is ever created.
    expect(parsed.pendingEdit).toBeUndefined();
  });

  it('passes editSummary null through when omitted', async () => {
    mockDb([[{ id: 9 }], [{ id: 12, type: 'doi' }], [{ id: 5 }]]);
    const { res, state } = createResponse();

    await handler(
      createJsonRequest({ reviewMarkdown: 'Bare tekst', readInFull: true }),
      res,
    );

    expect(state.statusCode).toBe(201);
    expect(recordPaperReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          reviewMarkdown: 'Bare tekst',
          readInFull: true,
          editSummary: null,
        }),
      }),
    );
  });

  it('rejects a review missing the read-in-full attestation', async () => {
    mockDb([[{ id: 9 }]]);
    const { res, state } = createResponse();

    await handler(createJsonRequest({ reviewMarkdown: 'Bare tekst' }), res);

    expect(state.statusCode).toBe(400);
    expect(recordPaperReviewMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/paper-reviews?view=history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue(null);
  });

  it('returns the revision history for the citation', async () => {
    const revisions = [
      {
        id: 3,
        reviewMarkdown: 'Nyeste',
        overallScore: 90,
        conclusionSupport: 'supported',
        reviewConfidence: 'high',
        readInFull: true,
        editSummary: 'Justert score',
        createdAt: '2026-07-01T00:00:00.000Z',
        author: {
          id: 42,
          username: 'agent',
          displayName: 'Agent',
          role: 'contributor',
          isAgent: true,
        },
      },
    ];
    listPaperReviewHistoryMock.mockResolvedValue(revisions);
    const { res, state } = createResponse();

    await handler(
      createGetRequest('/api/paper-reviews?citationId=12&view=history'),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(listPaperReviewHistoryMock).toHaveBeenCalledWith(12);
    expect(JSON.parse(state.body)).toEqual({ revisions });
  });
});
