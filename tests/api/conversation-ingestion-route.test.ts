import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  getUserFromRequestMock,
  planIngestionMock,
  applyIngestionMock,
  resolveIngestionCrosswalkMock,
  planWikiArticleMock,
  applyWikiArticleMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
  planIngestionMock: vi.fn(),
  applyIngestionMock: vi.fn(),
  resolveIngestionCrosswalkMock: vi.fn(),
  planWikiArticleMock: vi.fn(),
  applyWikiArticleMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));
vi.mock('../../api/_lib/conversationIngestionStore.js', async (importOriginal) => {
  // Only the two DB-backed entry points are stubbed. `sourceKeysOf` is pure and
  // decides which sources the route must have a review snapshot for, so the
  // route test exercises the real one rather than a copy that could drift.
  const actual = await importOriginal<
    typeof import('../../api/_lib/conversationIngestionStore.js')
  >();
  return {
    ...actual,
    planIngestion: planIngestionMock,
    applyIngestion: applyIngestionMock,
  };
});
// The ID-converter lookup is a live NCBI call; stub it so the route test stays
// hermetic.
vi.mock('../../api/_lib/citation-crosswalk.js', () => ({
  resolveIngestionCrosswalk: resolveIngestionCrosswalkMock,
}));

vi.mock("../../api/_lib/wikiArticleImportStore.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../api/_lib/wikiArticleImportStore.js")
    >();
  return {
    ...actual,
    planWikiArticle: planWikiArticleMock,
    applyWikiArticle: applyWikiArticleMock,
  };
});

import handler from '../../api/conversation-ingestion.ts';

function createRequest(body: unknown, method = 'POST'): IncomingMessage {
  const req = Readable.from([
    typeof body === 'string' ? body : JSON.stringify(body),
  ]) as unknown as IncomingMessage & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = method;
  req.url = '/api/conversation-ingestion';
  req.headers = { host: 'localhost', 'content-type': 'application/json' };
  return req;
}

function createResponse(): {
  res: ServerResponse;
  state: { statusCode: number; body: string };
} {
  const state = { statusCode: 200, body: '' };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      res.headersSent = true;
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse & { headersSent: boolean };
  return { res, state };
}

const SOURCE = {
  key: 'S1',
  type: 'pmid',
  identifier: '2719903',
  verification: {
    readInFull: true,
    locator: 'Table 2',
    evidenceSummary: 'Bioavailability was 23.9%.',
    reviewMarkdown: 'Crossover study with an intravenous reference arm.',
  },
};

const VALID_BUNDLE = {
  schemaVersion: 'kinetix-conversation-ingestion-v1',
  idempotencyKey: 'conv-route-01',
  mode: 'auto',
  conversationDigest: 'b'.repeat(64),
  createdAt: '2026-08-06T09:12:00Z',
  sources: [SOURCE],
  items: [
    {
      type: 'parameter_observation',
      target: { drugName: 'Morphine', pubchemCid: 5288826 },
      parameter: 'bioavailability',
      low: 0.215,
      high: 0.263,
      median: 0.239,
      unit: 'fraction',
      sourceKey: 'S1',
      context: { route: 'oral' },
      editSummary: 'Oral bioavailability.',
    },
  ],
};

const PLAN = {
  idempotencyKey: 'conv-route-01',
  mode: 'auto',
  createdAt: '2026-08-06T09:12:00Z',
  sources: [],
  items: [],
  blockedCandidates: [],
  counts: { ready: 1, duplicate: 0, blocked: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  getUserFromRequestMock.mockResolvedValue({ userId: 7, role: 'admin' });
  resolveIngestionCrosswalkMock.mockResolvedValue(new Map());
  planIngestionMock.mockResolvedValue(PLAN);
  applyIngestionMock.mockResolvedValue({
    citationsCreated: 1,
    reviewsRecorded: 1,
    items: [{ index: 0, status: 'applied', reason: null, detail: null, createdId: 3 }],
    counts: { applied: 1, skipped: 0, failed: 0 },
  });
});

describe('POST /api/conversation-ingestion', () => {
  const article = {
    schemaVersion: "kinetix-wiki-article-v1",
    idempotencyKey: "test",
    articleDigest: "a".repeat(64),
    createdAt: "2026-10-09T00:00:00Z",
    page: { slug: "test" },
    sources: [{ key: "S1", type: "pmid", identifier: "2719903" }],
    sections: [
      {
        key: "s1",
        heading: "Bakgrunn",
        level: 2,
        facts: [{ key: "f1", statement: "Testpåstand.", sourceKeys: ["S1"] }],
      },
    ],
  };
  it("advertises supported formats without authentication or DB access", async () => {
    const req = createRequest({}, "GET");
    req.url += "?action=formats";
    const { res, state } = createResponse();
    await handler(req, res);
    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body).schemaVersions).toContain(
      "kinetix-wiki-article-v1",
    );
    expect(getUserFromRequestMock).not.toHaveBeenCalled();
    expect(getDbMock).not.toHaveBeenCalled();
  });
  it("plans article bundles through the queue-only store", async () => {
    planWikiArticleMock.mockResolvedValue({
      fingerprint: "a".repeat(64),
      factCount: 1,
    });
    const { res, state } = createResponse();
    await handler(createRequest({ document: article }), res);
    expect(state.statusCode).toBe(200);
    expect(planWikiArticleMock).toHaveBeenCalledOnce();
    expect(planIngestionMock).not.toHaveBeenCalled();
    expect(resolveIngestionCrosswalkMock).not.toHaveBeenCalled();
  });
  it("requires a preview fingerprint to queue article facts", async () => {
    const { res, state } = createResponse();
    await handler(createRequest({ document: article, action: "apply" }), res);
    expect(state.statusCode).toBe(400);
    expect(applyWikiArticleMock).not.toHaveBeenCalled();
  });
  it("queues an article with the authenticated actor and snapshot", async () => {
    applyWikiArticleMock.mockResolvedValue({
      queued: 1,
      skipped: 0,
      newSections: 0,
    });
    const { res, state } = createResponse();
    await handler(
      createRequest({
        document: article,
        action: "apply",
        expectedFingerprint: "a".repeat(64),
      }),
      res,
    );
    expect(state.statusCode).toBe(200);
    expect(applyWikiArticleMock).toHaveBeenCalledWith(
      article,
      7,
      "a".repeat(64),
    );
    expect(applyIngestionMock).not.toHaveBeenCalled();
  });
  it('rejects a non-admin', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 2, role: 'contributor' });
    const { res, state } = createResponse();
    await handler(createRequest({ document: VALID_BUNDLE }), res);
    expect(state.statusCode).toBe(403);
    expect(planIngestionMock).not.toHaveBeenCalled();
  });

  it('plans by default and writes nothing', async () => {
    const { res, state } = createResponse();
    await handler(createRequest({ document: VALID_BUNDLE }), res);

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    expect(body.applied).toBe(false);
    expect(body.plan.counts.ready).toBe(1);
    expect(applyIngestionMock).not.toHaveBeenCalled();
  });

  it('returns the validator errors for a bundle that does not parse', async () => {
    const { res, state } = createResponse();
    await handler(
      createRequest({ document: { ...VALID_BUNDLE, schemaVersion: 'nope' } }),
      res,
    );

    expect(state.statusCode).toBe(400);
    const body = JSON.parse(state.body);
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(planIngestionMock).not.toHaveBeenCalled();
  });

  it('applies only the accepted indices', async () => {
    const { res, state } = createResponse();
    await handler(
      createRequest({
        document: VALID_BUNDLE,
        action: 'apply',
        accept: [0],
        expectedReviewActions: { S1: 'record' },
        expectedFingerprints: { 0: 'fp-0' },
      }),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(applyIngestionMock).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'conv-route-01' }),
      expect.objectContaining({ userId: 7, accept: [0] }),
    );
    // Alternate handles are resolved from the ID converter, never taken from
    // the bundle — a merge on an invented alias joins two different papers.
    expect(resolveIngestionCrosswalkMock).toHaveBeenCalled();
    const body = JSON.parse(state.body);
    expect(body.applied).toBe(true);
    expect(body.result.counts.applied).toBe(1);
  });

  it('drops accept indices that are not items in the bundle', async () => {
    const { res } = createResponse();
    await handler(
      createRequest({
        document: VALID_BUNDLE,
        action: 'apply',
        accept: [0, 0, 5, -1, 'x'],
        expectedReviewActions: { S1: 'keep' },
        expectedFingerprints: { 0: 'fp-0' },
      }),
      res,
    );

    expect(applyIngestionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 7, accept: [0] }),
    );
  });

  it('still returns the receipt when the post-write plan refresh fails', async () => {
    // The writes have already committed. Failing the response here would tell
    // the admin the apply failed while the facts are live, and they would
    // re-run it.
    // The apply branch plans exactly once, after the writes commit.
    planIngestionMock.mockRejectedValueOnce(new Error('db went away'));

    const { res, state } = createResponse();
    await handler(
      createRequest({
        document: VALID_BUNDLE,
        action: 'apply',
        accept: [0],
        expectedReviewActions: { S1: 'record' },
        expectedFingerprints: { 0: 'fp-0' },
      }),
      res,
    );

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    expect(body.applied).toBe(true);
    expect(body.result.counts.applied).toBe(1);
    expect(body.plan).toBeNull();
  });

  it('refuses an apply that omits the reviewed source-action snapshot', async () => {
    // An optional guard is no guard against the case it exists for: without the
    // snapshot, a review withdrawn since Analyse would be re-published under an
    // acceptance that predates the withdrawal.
    const { res, state } = createResponse();
    await handler(
      createRequest({ document: VALID_BUNDLE, action: 'apply', accept: [0] }),
      res,
    );

    expect(state.statusCode).toBe(400);
    const body = JSON.parse(state.body);
    expect(body.code).toBe('ingestion_review_snapshot_required');
    expect(body.missingSourceKeys).toEqual(['S1']);
    expect(applyIngestionMock).not.toHaveBeenCalled();
  });

  it('refuses an apply whose snapshot omits one cited source', async () => {
    const { res, state } = createResponse();
    await handler(
      createRequest({
        document: VALID_BUNDLE,
        action: 'apply',
        accept: [0],
        // Present, but not for the source this item cites.
        expectedReviewActions: { S9: 'keep' },
      }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body).missingSourceKeys).toEqual(['S1']);
    expect(applyIngestionMock).not.toHaveBeenCalled();
  });

  it('refuses an apply that omits the reviewed item fingerprints', async () => {
    const { res, state } = createResponse();
    await handler(
      createRequest({
        document: VALID_BUNDLE,
        action: 'apply',
        accept: [0],
        expectedReviewActions: { S1: 'record' },
      }),
      res,
    );

    expect(state.statusCode).toBe(400);
    const body = JSON.parse(state.body);
    expect(body.code).toBe('ingestion_fingerprints_required');
    expect(body.missingItems).toEqual([0]);
    expect(applyIngestionMock).not.toHaveBeenCalled();
  });

  it('refuses an apply that accepts nothing', async () => {
    const { res, state } = createResponse();
    await handler(
      createRequest({ document: VALID_BUNDLE, action: 'apply', accept: [] }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body).code).toBe('ingestion_nothing_accepted');
    expect(applyIngestionMock).not.toHaveBeenCalled();
  });

  it('answers a primitive JSON root with a validation error, not a crash', async () => {
    const { res, state } = createResponse();
    await handler(createRequest(42), res);

    // `'document' in 42` throws; the bundle is malformed, which is a 400 with
    // the validator's reasons, not a 500.
    expect(state.statusCode).toBe(400);
    const body = JSON.parse(state.body);
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  it('rejects non-POST', async () => {
    const { res, state } = createResponse();
    await handler(createRequest({}, 'GET'), res);
    expect(state.statusCode).toBe(405);
  });
});
