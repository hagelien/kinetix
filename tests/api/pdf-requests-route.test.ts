import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, getUserFromRequestMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import handler from '../../api/pdf-requests.ts';

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
  req.url = '/api/pdf-requests?citationId=12';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(raw),
  };
  return req;
}

function createGetRequest(
  path = '/api/pdf-requests?citationId=12',
): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = 'GET';
  req.url = path;
  req.headers = { host: 'localhost' };
  return req;
}

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

  const returning = vi
    .fn()
    .mockResolvedValue([
      { id: 7, citationId: 12, status: 'open', reason: 'paywalled' },
    ]);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });

  const db = { select, insert };
  getDbMock.mockReturnValue(db);
  return { db, values, onConflictDoUpdate };
}

describe('POST /api/pdf-requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'contributor',
    });
  });

  it('rejects users below the contributor tier', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'authenticated',
    });
    const { db } = mockDb([[]]);
    const { res, state } = createResponse();

    await handler(createJsonRequest({ reason: 'paywalled' }), res);

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toEqual({
      error: 'Contributor role required',
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects freetext citations before writing a request', async () => {
    const { db } = mockDb([[{ id: 12, type: 'freetext' }]]);
    const { res, state } = createResponse();

    await handler(createJsonRequest({ reason: 'paywalled' }), res);

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_request_unresolvable_citation',
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('lets a contributor upsert an open request (idempotent)', async () => {
    const { values } = mockDb([[{ id: 12, type: 'doi' }]]);
    const { res, state } = createResponse();

    await handler(createJsonRequest({ reason: 'paywalled' }), res);

    expect(state.statusCode).toBe(201);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        citationId: 12,
        status: 'open',
        reason: 'paywalled',
        requestedBy: 42,
      }),
    );
  });

  it('self-provisions a request with no reason for direct uploads', async () => {
    const { values } = mockDb([[{ id: 12, type: 'doi' }]]);
    const { res, state } = createResponse();

    await handler(createJsonRequest({}), res);

    expect(state.statusCode).toBe(201);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        citationId: 12,
        status: 'open',
        reason: null,
        requestedBy: 42,
      }),
    );
  });

  it('does not reopen a request when full text is already stored', async () => {
    // citation lookup, existing-pdf lookup, existing-request lookup
    let selectCall = 0;
    const selectResults: unknown[][] = [
      [{ id: 12, type: 'doi' }],
      [{ id: 99 }], // a citation_pdfs row exists
      [{ id: 7, citationId: 12, status: 'open', reason: 'paywalled' }],
    ];
    const limit = vi.fn(() =>
      Promise.resolve(selectResults[selectCall++] ?? []),
    );
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });

    const returning = vi
      .fn()
      .mockResolvedValue([
        { id: 7, citationId: 12, status: 'fulfilled', reason: 'paywalled' },
      ]);
    const updateWhere = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where: updateWhere });
    const update = vi.fn().mockReturnValue({ set });
    const insert = vi.fn();

    getDbMock.mockReturnValue({ select, update, insert });
    const { res, state } = createResponse();

    await handler(createJsonRequest({ reason: 'paywalled' }), res);

    // The lingering open request is reconciled to fulfilled, not reopened, and
    // no new request row is inserted.
    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(state.body)).toMatchObject({
      request: { id: 7, status: 'fulfilled' },
      hasPdf: true,
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'fulfilled' }),
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it('leaves an open replacement request alone on an ordinary re-file', async () => {
    // The review agent re-files a request on every paywalled pass, with no
    // `replace` flag. Before this guard that hit the reconciliation branch and
    // marked the editor's open replacement request `fulfilled` — closing the
    // only authorization that lets the bad PDF be swapped, without a single
    // byte having been uploaded, and putting the paper into the agent's
    // awaiting-review queue as though full text had just arrived.
    let selectCall = 0;
    const selectResults: unknown[][] = [
      [{ id: 12, type: 'doi' }],
      [{ id: 99 }], // a citation_pdfs row exists
      [{ id: 7, citationId: 12, status: 'open', isReplacement: true }],
    ];
    const limit = vi.fn(() =>
      Promise.resolve(selectResults[selectCall++] ?? []),
    );
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const update = vi.fn();
    const insert = vi.fn();

    getDbMock.mockReturnValue({ select, update, insert });
    const { res, state } = createResponse();

    await handler(createJsonRequest({ reason: 'paywalled' }), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({
      request: { id: 7, status: 'open' },
      hasPdf: true,
    });
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('reports a stored PDF without inserting when no request row exists', async () => {
    let selectCall = 0;
    const selectResults: unknown[][] = [
      [{ id: 12, type: 'doi' }],
      [{ id: 99 }], // a citation_pdfs row exists
      [], // no pdf_requests row at all
    ];
    const limit = vi.fn(() =>
      Promise.resolve(selectResults[selectCall++] ?? []),
    );
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const update = vi.fn();
    const insert = vi.fn();

    getDbMock.mockReturnValue({ select, update, insert });
    const { res, state } = createResponse();

    await handler(createJsonRequest({}), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(state.body)).toMatchObject({
      request: null,
      hasPdf: true,
    });
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('reopens a request for an editor replacing an unusable stored PDF', async () => {
    // Every other path treats an existing citation_pdfs row as "settled", so
    // before `replace` there was no way to swap a scan with no text layer or
    // an upload of the wrong paper: the upload token needs an open request,
    // and no open request could be created.
    getUserFromRequestMock.mockResolvedValue({ userId: 42, role: 'editor' });
    // citation, stored-pdf, open-extraction-job (none) lookups
    const { values } = mockDb([
      [{ id: 12, type: 'doi' }],
      [{ id: 99 }],
      [],
    ]);
    const { res, state } = createResponse();

    await handler(createJsonRequest({ replace: true }), res);

    expect(state.statusCode).toBe(201);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        citationId: 12,
        status: 'open',
        // Flagged so both fulfilment routes can re-check the editor tier —
        // otherwise the gate lasts only until the row is written.
        isReplacement: true,
      }),
    );
  });

  it('marks an ordinary request as not a replacement', async () => {
    // Set explicitly rather than left to the column default: this row may be
    // an upsert over one that previously carried a replacement, and a stale
    // flag would keep an editor-only gate on a request that is no longer one.
    const { values } = mockDb([[{ id: 12, type: 'doi' }]]);
    const { res, state } = createResponse();

    await handler(createJsonRequest({}), res);

    expect(state.statusCode).toBe(201);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ isReplacement: false }),
    );
  });

  it('clears a stale replacement flag when the row is re-requested', async () => {
    // The upsert branch is the one that matters here: this row may already
    // exist carrying isReplacement=true from an abandoned replacement. If the
    // conflict clause omitted the field, an ordinary contributor request would
    // inherit an editor-only fulfilment gate it never asked for.
    const { onConflictDoUpdate } = mockDb([[{ id: 12, type: 'doi' }]]);
    const { res } = createResponse();

    await handler(createJsonRequest({}), res);

    expect(onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ isReplacement: false }),
      }),
    );
  });

  it('refuses replacement while an extraction job for the paper is open', async () => {
    // The stored PDF belongs to the citation, not to a job, so swapping it
    // under a queued job changes what that job was queued with — and under a
    // claimed one, the bytes a run is mid-read of. Enforced here rather than
    // only in the UI, which can only hide a button.
    getUserFromRequestMock.mockResolvedValue({ userId: 42, role: 'editor' });
    let selectCall = 0;
    const selectResults: unknown[][] = [
      [{ id: 12, type: 'doi' }],
      [{ id: 99 }], // stored PDF exists
      [{ id: 3 }], // an open paper_extraction_jobs row
    ];
    const limit = vi.fn(() =>
      Promise.resolve(selectResults[selectCall++] ?? []),
    );
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const insert = vi.fn();
    getDbMock.mockReturnValue({ select, update: vi.fn(), insert });
    const { res, state } = createResponse();

    await handler(createJsonRequest({ replace: true }), res);

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_replace_extraction_in_flight',
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('keeps replacement at the editor tier', async () => {
    // Replacing discards the previous asset, so it is not a contributor action
    // even though supplying a first PDF is.
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'contributor',
    });
    const { db } = mockDb([[{ id: 12, type: 'doi' }], [{ id: 99 }]]);
    const { res, state } = createResponse();

    await handler(createJsonRequest({ replace: true }), res);

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_replace_requires_editor',
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('leaves the satisfied-request guard intact when replace is absent', async () => {
    // The guard exists because the review agent re-files on every paywalled
    // pass; only an explicit `replace` may bypass it.
    getUserFromRequestMock.mockResolvedValue({ userId: 42, role: 'editor' });
    let selectCall = 0;
    const selectResults: unknown[][] = [
      [{ id: 12, type: 'doi' }],
      [{ id: 99 }],
      [],
    ];
    const limit = vi.fn(() =>
      Promise.resolve(selectResults[selectCall++] ?? []),
    );
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const insert = vi.fn();
    getDbMock.mockReturnValue({ select, update: vi.fn(), insert });
    const { res, state } = createResponse();

    await handler(createJsonRequest({}), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({ hasPdf: true });
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('GET /api/pdf-requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'authenticated',
    });
  });

  it('rejects anonymous reads before querying the queue', async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const db = { select: vi.fn() };
    getDbMock.mockReturnValue(db);

    const { res, state } = createResponse();
    await handler(createGetRequest('/api/pdf-requests'), res);

    expect(state.statusCode).toBe(401);
    expect(JSON.parse(state.body)).toEqual({
      error: 'Authentication required',
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  /**
   * Queue read: the open-request join, the gap query's `db.execute`, and the
   * inbox lookup that tells each row whether a bulk-dropped PDF for that paper
   * is already waiting to be linked.
   *
   * The two reads take different shapes off `from()` — the request join
   * continues into `innerJoin`, the inbox lookup resolves straight off
   * `where` — so both hang off the same stub rather than a call-order array.
   */
  function mockQueueDb(
    requestRows: unknown[],
    gapRows: Record<string, unknown>[] = [],
    inboxRows: Array<{ citationId: number | null }> = [],
  ) {
    const limit = vi.fn().mockResolvedValue(requestRows);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const innerJoin = vi.fn().mockReturnValue({ where });
    const inboxWhere = vi.fn().mockResolvedValue(inboxRows);
    const from = vi.fn().mockReturnValue({ innerJoin, where: inboxWhere });
    const select = vi.fn().mockReturnValue({ from });
    const execute = vi.fn().mockResolvedValue({ rows: gapRows });
    getDbMock.mockReturnValue({ select, execute });
    return { select, innerJoin, execute, inboxWhere };
  }

  it('lists open requests joined with their citation', async () => {
    const rows = [
      {
        id: 7,
        citationId: 12,
        status: 'open',
        reason: 'paywalled',
        citationType: 'doi',
        citationIdentifier: '10.1/x',
        citationMetadata: { title: 'A paper' },
      },
    ];
    const { innerJoin } = mockQueueDb(rows);

    const { res, state } = createResponse();
    await handler(createGetRequest('/api/pdf-requests'), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(state.body)).toEqual({
      // Each row carries whether a bulk-dropped PDF for it is already waiting
      // in the inbox, so the queue never sends somebody to a library proxy
      // for a copy that is already on the premises.
      requests: [{ ...rows[0], pdfInInbox: false }],
      gaps: [],
      gapTotal: 0,
    });
    expect(innerJoin).toHaveBeenCalled();
  });

  it('lists unrequested full-text gaps alongside the open requests', async () => {
    // The reference page advertises "full text missing" for these from
    // client-side state alone; without them the queue contradicts the page.
    const { execute } = mockQueueDb(
      [],
      [
        {
          citation_id: 83,
          type: 'pmid',
          identifier: '8513649',
          metadata: { title: 'Clinical pharmacokinetics of alprazolam' },
          created_at: new Date('2026-01-05T10:00:00.000Z'),
          previously_requested: false,
          total_count: 41,
        },
      ],
    );

    const { res, state } = createResponse();
    await handler(createGetRequest('/api/pdf-requests'), res);

    expect(state.statusCode).toBe(200);
    expect(execute).toHaveBeenCalled();
    expect(JSON.parse(state.body)).toEqual({
      requests: [],
      // `gapTotal` is the pre-limit count, so a truncated page can say so.
      gapTotal: 41,
      gaps: [
        {
          citationId: 83,
          citationType: 'pmid',
          citationIdentifier: '8513649',
          citationMetadata: {
            title: 'Clinical pharmacokinetics of alprazolam',
          },
          citationCreatedAt: '2026-01-05T10:00:00.000Z',
          previouslyRequested: false,
          pdfInInbox: false,
        },
      ],
    });
  });

  it('flags a paper whose PDF is already waiting in the bulk inbox', async () => {
    // Somebody dropped this paper in and nobody has confirmed the link yet.
    // The row stays — the citation genuinely still lacks full text — but it
    // must say the copy is already here, or a contributor goes and fetches a
    // second one, which is exactly the wasted effort the inbox removes.
    mockQueueDb(
      [
        {
          id: 7,
          citationId: 12,
          status: 'open',
          reason: null,
          citationType: 'doi',
          citationIdentifier: '10.1/x',
          citationMetadata: { title: 'A paper' },
        },
      ],
      [],
      [{ citationId: 12 }],
    );

    const { res, state } = createResponse();
    await handler(createGetRequest('/api/pdf-requests'), res);

    const body = JSON.parse(state.body);
    expect(body.requests[0].pdfInInbox).toBe(true);
  });

  it('keeps the two classes disjoint when a request lands mid-read', async () => {
    // The two reads are independent snapshots (neon-http sends each statement
    // as its own transaction) and requests are created concurrently, so the
    // gap query can still be holding a citation the request query already
    // returns. Listing it twice, under contradictory framing, is the visible
    // failure — so the overlap is dropped against the requests this response
    // actually carries.
    mockQueueDb(
      [
        {
          id: 7,
          citationId: 83,
          status: 'open',
          reason: null,
          citationType: 'pmid',
          citationIdentifier: '8513649',
          citationMetadata: { title: 'A paper' },
        },
      ],
      [
        {
          citation_id: 83,
          type: 'pmid',
          identifier: '8513649',
          metadata: { title: 'A paper' },
          created_at: new Date('2026-01-05T10:00:00.000Z'),
          previously_requested: false,
          total_count: 3,
        },
      ],
    );

    const { res, state } = createResponse();
    await handler(createGetRequest('/api/pdf-requests'), res);

    const body = JSON.parse(state.body);
    expect(body.requests).toHaveLength(1);
    expect(body.gaps).toEqual([]);
    // The discarded row is discounted, so "showing N of M" stays truthful.
    expect(body.gapTotal).toBe(2);
  });

  it('reports no gaps when every cited paper has full text or a review', async () => {
    mockQueueDb([]);

    const { res, state } = createResponse();
    await handler(createGetRequest('/api/pdf-requests'), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      requests: [],
      gaps: [],
      gapTotal: 0,
    });
  });

  it('lists fulfilled-but-unreviewed requests for the follow-up queue', async () => {
    const rows = [
      {
        id: 80,
        citationId: 581,
        status: 'fulfilled',
        reason: 'paywalled',
        citationType: 'url',
        citationIdentifier: 'https://example.org/label.pdf',
        citationMetadata: { title: 'FDA label' },
      },
    ];
    const limit = vi.fn().mockResolvedValue(rows);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const leftJoin = vi.fn().mockReturnValue({ where });
    const innerJoin = vi.fn().mockReturnValue({ leftJoin });
    const from = vi.fn().mockReturnValue({ innerJoin });
    const select = vi.fn().mockReturnValue({ from });
    getDbMock.mockReturnValue({ select });

    const { res, state } = createResponse();
    await handler(createGetRequest('/api/pdf-requests?awaitingReview=1'), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(state.body)).toEqual({ requests: rows });
    expect(leftJoin).toHaveBeenCalled();
  });

  it('returns the open-queue count for the header badge', async () => {
    const where = vi.fn().mockResolvedValue([{ count: 5 }]);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const execute = vi.fn();
    getDbMock.mockReturnValue({ select, execute });

    const { res, state } = createResponse();
    await handler(createGetRequest('/api/pdf-requests?countOnly=true'), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(state.body)).toEqual({ count: 5 });
    // The badge means "needs attention now" — agent-confirmed requests only.
    // Folding in every unreviewed citation would make it a permanent big
    // number, so the gap query must not run on this path.
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires authentication for the open-queue count', async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const db = { select: vi.fn() };
    getDbMock.mockReturnValue(db);

    const { res, state } = createResponse();
    await handler(createGetRequest('/api/pdf-requests?countOnly=true'), res);

    expect(state.statusCode).toBe(401);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('projects public request fields for per-citation reads', async () => {
    const { db } = mockDb([
      [{ id: 7, citationId: 12, status: 'open', reason: 'paywalled' }],
      [],
    ]);
    const { res, state } = createResponse();

    await handler(createGetRequest(), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(state.body)).toMatchObject({
      request: { id: 7, citationId: 12, status: 'open' },
      hasPdf: false,
    });
    expect(db.select).toHaveBeenCalledWith(
      expect.not.objectContaining({
        requestedBy: expect.anything(),
        fulfilledBy: expect.anything(),
      }),
    );
  });
});
