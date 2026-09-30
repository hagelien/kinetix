import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  collectParameterCitationUsageForDrugMock,
  getUserFromRequestMock,
  collectUsedCitationIdsForDrugMock,
  collectReferenceUsageMock,
  filterUsedCitationIdsMock,
  fetchCrossRefMetadataMock,
  fetchPubMedMetadataMock,
  findCitationsNeedingFullReviewMock,
  consumeRateLimitMock,
  getClientAddressKeyMock,
  resolveOneCrosswalkMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  collectParameterCitationUsageForDrugMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
  collectUsedCitationIdsForDrugMock: vi.fn(),
  collectReferenceUsageMock: vi.fn(),
  filterUsedCitationIdsMock: vi.fn(),
  fetchCrossRefMetadataMock: vi.fn(),
  fetchPubMedMetadataMock: vi.fn(),
  findCitationsNeedingFullReviewMock: vi.fn(),
  consumeRateLimitMock: vi.fn(),
  getClientAddressKeyMock: vi.fn(),
  resolveOneCrosswalkMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

vi.mock('../../api/_lib/citation-usage.js', () => ({
  collectParameterCitationUsageForDrug:
    collectParameterCitationUsageForDrugMock,
  collectUsedCitationIdsForDrug: collectUsedCitationIdsForDrugMock,
  collectReferenceUsage: collectReferenceUsageMock,
  filterUsedCitationIds: filterUsedCitationIdsMock,
}));

vi.mock('../../api/_lib/reference-review-status.js', () => ({
  findCitationsNeedingFullReview: findCitationsNeedingFullReviewMock,
}));

vi.mock('../../api/_lib/crossref.js', () => ({
  fetchCrossRefMetadata: fetchCrossRefMetadataMock,
}));

vi.mock('../../api/_lib/pubmed.js', () => ({
  fetchPubMedMetadata: fetchPubMedMetadataMock,
}));

// The PMID↔DOI crosswalk is a live NCBI lookup; stub it so the route tests
// stay hermetic. It is best-effort in production too — an empty answer just
// means the row is filed under the handle the caller declared.
vi.mock('../../api/_lib/citation-crosswalk.js', () => ({
  resolveOneCrosswalk: resolveOneCrosswalkMock,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
  consumeRateLimit: consumeRateLimitMock,
  getClientAddressKey: getClientAddressKeyMock,
}));

import handler from '../../api/references.ts';

function createResponse(): {
  res: ServerResponse;
  state: {
    statusCode: number;
    body: string;
    headers: Record<string, unknown>;
  };
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
        state.headers = { ...state.headers, ...(headers ?? {}) };
        return res;
      },
    ),
    setHeader: vi.fn((name: string, value: unknown) => {
      state.headers[name] = value;
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse;

  return { res, state };
}

function createRequest(url: string): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: { host: 'localhost' },
  } as IncomingMessage;
}

function createJsonRequest(url: string, body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'POST';
  req.url = url;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(raw),
  };
  return req;
}

function createJsonRequestWithMethod(
  method: string,
  url: string,
  body: unknown,
): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(raw),
  };
  return req;
}

function mockUpdateReferenceDb(options: {
  existing?: unknown;
  updated?: unknown;
}) {
  const limit = vi
    .fn()
    .mockResolvedValue(options.existing ? [options.existing] : []);
  const selectWhere = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where: selectWhere });
  const select = vi.fn().mockReturnValue({ from });

  const returning = vi
    .fn()
    .mockResolvedValue(options.updated ? [options.updated] : []);
  const updateWhere = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });

  getDbMock.mockReturnValue({ select, update });
  return { select, set, update };
}

function mockReferencesQuery(rows: unknown[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  getDbMock.mockReturnValue({ select });
  return { select, where };
}

function mockCreateReferenceDb(options: {
  existing?: unknown[];
  inserted?: unknown;
}) {
  const existing = options.existing ?? [];
  const insertedRow = options.inserted ?? {
    id: 7,
    drugId: null,
    type: 'doi',
    identifier: '10.1000/test',
    metadata: null,
    createdBy: 123,
    createdAt: '2026-05-20T00:00:00.000Z',
  };

  // The route creates rows through `resolveCitation` (#1018), which looks the
  // paper up under every handle it knows before inserting and re-reads the row
  // afterwards. So the fake has to answer a bare `.where(...)` as well as
  // `.where(...).limit(...)`, and has to start returning the new row once the
  // insert has happened.
  let insertedYet = false;
  const rowsNow = () => (insertedYet ? [insertedRow] : existing);
  const whereResult = () => {
    const promise = Promise.resolve(rowsNow()) as Promise<unknown[]> & {
      limit: ReturnType<typeof vi.fn>;
    };
    promise.limit = vi.fn().mockImplementation(async () => rowsNow());
    return promise;
  };
  const where = vi.fn().mockImplementation(whereResult);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  const returning = vi.fn().mockImplementation(async () => {
    insertedYet = true;
    return [insertedRow];
  });
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ returning, onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values });
  const update = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
  });
  getDbMock.mockReturnValue({ select, insert, update });
  return { values };
}

describe('GET /api/references', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({ userId: 123, role: 'editor' });
    collectParameterCitationUsageForDrugMock.mockResolvedValue(new Map());
    filterUsedCitationIdsMock.mockImplementation(
      async (_db: unknown, ids: number[]) => new Set(ids),
    );
    findCitationsNeedingFullReviewMock.mockResolvedValue(new Set());
    fetchCrossRefMetadataMock.mockResolvedValue(null);
    fetchPubMedMetadataMock.mockResolvedValue(null);
    consumeRateLimitMock.mockReturnValue({
      limited: false,
      retryAfterSeconds: 0,
    });
    getClientAddressKeyMock.mockReturnValue('ip:127.0.0.1');
    resolveOneCrosswalkMock.mockResolvedValue({});
  });

  it('includes globally deduplicated citations used by a drug parameter revision', async () => {
    collectUsedCitationIdsForDrugMock.mockResolvedValue(new Set([7]));
    mockReferencesQuery([
      {
        id: 7,
        drugId: null,
        type: 'url',
        identifier: 'https://www.diakonhjemmetsykehus.no/legemiddelanalyser/',
        metadata: { title: ' Diakonhjemmet SFP ' },
        createdAt: '2026-05-12T00:00:00.000Z',
      },
    ]);
    const { res, state } = createResponse();

    await handler(createRequest('/api/references?drugId=42'), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      references: [
        {
          id: 7,
          drugId: null,
          type: 'url',
          identifier: 'https://www.diakonhjemmetsykehus.no/legemiddelanalyser/',
          metadata: { title: 'Diakonhjemmet SFP' },
          createdAt: '2026-05-12T00:00:00.000Z',
          needsFullReview: false,
        },
      ],
    });
    expect(collectParameterCitationUsageForDrugMock).not.toHaveBeenCalled();
  });

  it('optionally includes parameter usage for reference placement', async () => {
    collectUsedCitationIdsForDrugMock.mockResolvedValue(new Set([7, 8]));
    collectParameterCitationUsageForDrugMock.mockResolvedValue(
      new Map([
        [7, new Set(['tmax', 'halfLife'])],
        [8, new Set(['proteinBinding'])],
      ]),
    );
    mockReferencesQuery([
      {
        id: 7,
        drugId: null,
        type: 'doi',
        identifier: '10.1000/test',
        metadata: { title: ' Parameter citation ' },
        createdAt: '2026-05-12T00:00:00.000Z',
      },
      {
        id: 8,
        drugId: null,
        type: 'pmid',
        identifier: '37931468',
        metadata: { title: ' Secondary citation ' },
        createdAt: '2026-05-13T00:00:00.000Z',
      },
    ]);
    const { res, state } = createResponse();

    await handler(
      createRequest('/api/references?drugId=42&includeUsage=1'),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      references: [
        {
          id: 7,
          drugId: null,
          type: 'doi',
          identifier: '10.1000/test',
          metadata: { title: 'Parameter citation' },
          createdAt: '2026-05-12T00:00:00.000Z',
          needsFullReview: false,
          usage: { parameters: ['halfLife', 'tmax'] },
        },
        {
          id: 8,
          drugId: null,
          type: 'pmid',
          identifier: '37931468',
          metadata: { title: 'Secondary citation' },
          createdAt: '2026-05-13T00:00:00.000Z',
          needsFullReview: false,
          usage: { parameters: ['proteinBinding'] },
        },
      ],
    });
    expect(collectParameterCitationUsageForDrugMock).toHaveBeenCalledWith(
      expect.anything(),
      42,
    );
  });

  it('returns an empty list without querying citations when the drug has no used references', async () => {
    collectUsedCitationIdsForDrugMock.mockResolvedValue(new Set());
    const { res, state } = createResponse();
    const db = { select: vi.fn() };
    getDbMock.mockReturnValue(db);

    await handler(createRequest('/api/references?drugId=42'), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ references: [] });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('fetches multiple references by id in one request and preserves requested order', async () => {
    mockReferencesQuery([
      {
        id: 8,
        drugId: null,
        type: 'pmid',
        identifier: '37931468',
        metadata: { title: ' Second citation ' },
        createdAt: '2026-05-13T00:00:00.000Z',
      },
      {
        id: 7,
        drugId: null,
        type: 'url',
        identifier: 'https://example.com/source',
        metadata: { title: ' First citation ' },
        createdAt: '2026-05-12T00:00:00.000Z',
      },
    ]);
    const { res, state } = createResponse();

    await handler(createRequest('/api/references?ids=7,8,7,bad'), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      references: [
        {
          id: 7,
          drugId: null,
          type: 'url',
          identifier: 'https://example.com/source',
          metadata: { title: 'First citation' },
          createdAt: '2026-05-12T00:00:00.000Z',
          needsFullReview: false,
        },
        {
          id: 8,
          drugId: null,
          type: 'pmid',
          identifier: '37931468',
          metadata: { title: 'Second citation' },
          createdAt: '2026-05-13T00:00:00.000Z',
          needsFullReview: false,
        },
      ],
    });
    expect(collectUsedCitationIdsForDrugMock).not.toHaveBeenCalled();
    expect(filterUsedCitationIdsMock).toHaveBeenCalledWith(
      expect.anything(),
      [7, 8],
    );
  });

  it('returns 404 for a direct reference id that is not anchored anywhere', async () => {
    filterUsedCitationIdsMock.mockResolvedValue(new Set());
    const db = { select: vi.fn() };
    getDbMock.mockReturnValue(db);
    const { res, state } = createResponse();

    await handler(createRequest('/api/references?id=7'), res);

    expect(state.statusCode).toBe(404);
    expect(JSON.parse(state.body)).toEqual({ error: 'Reference not found' });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('drops orphaned ids from batch reference lookups without leaking existence', async () => {
    filterUsedCitationIdsMock.mockResolvedValue(new Set([8]));
    mockReferencesQuery([
      {
        id: 8,
        drugId: null,
        type: 'pmid',
        identifier: '37931468',
        metadata: { title: ' Kept citation ' },
        createdAt: '2026-05-13T00:00:00.000Z',
      },
    ]);
    const { res, state } = createResponse();

    await handler(createRequest('/api/references?ids=7,8'), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      references: [
        {
          id: 8,
          drugId: null,
          type: 'pmid',
          identifier: '37931468',
          metadata: { title: 'Kept citation' },
          createdAt: '2026-05-13T00:00:00.000Z',
          needsFullReview: false,
        },
      ],
    });
    expect(filterUsedCitationIdsMock).toHaveBeenCalledWith(
      expect.anything(),
      [7, 8],
    );
  });
});

describe('GET /api/references?view=index', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // handleIndex runs db.execute for the page-anchor scan (and, when `q` is
  // set, for the search) plus a fixed sequence of db.select() calls. Model
  // each select as a thenable that also answers `.where(...)`, so the same
  // builder serves the with-where and without-where queries. Datasets are
  // returned in call order.
  function mockIndexDb(options: {
    pages: unknown[];
    paramRevisions: unknown[];
    concentrations: unknown[];
    ionizationConstants?: unknown[];
    directCitations: unknown[];
    citations: unknown[];
    drugs: unknown[];
    /** Citation ids the search matched; only read when the request sets `q`. */
    searchMatches?: number[];
  }) {
    const datasets = [
      options.paramRevisions,
      options.concentrations,
      options.ionizationConstants ?? [],
      options.directCitations,
      options.citations,
      options.drugs,
    ];
    let call = 0;
    const makeQuery = (rows: unknown[]) => {
      const p = Promise.resolve(rows) as Promise<unknown[]> & {
        where: ReturnType<typeof vi.fn>;
      };
      p.where = vi.fn().mockResolvedValue(rows);
      return p;
    };
    const select = vi.fn(() => ({
      from: vi.fn(() => makeQuery(datasets[call++] ?? [])),
    }));
    let executeCall = 0;
    const execute = vi.fn(async () =>
      executeCall++ === 0
        ? { rows: options.pages }
        : { rows: (options.searchMatches ?? []).map((id) => ({ id })) },
    );
    getDbMock.mockReturnValue({ select, execute });
  }

  function citationFixture(id: number, extra: Record<string, unknown> = {}) {
    return {
      id,
      drugId: null,
      type: 'doi',
      identifier: `10.1000/${id}`,
      metadata: { title: `Source ${id}` },
      createdAt: '2026-05-12T00:00:00.000Z',
      ...extra,
    };
  }

  it('groups citations by drug monograph and wiki page', async () => {
    mockIndexDb({
      pages: [
        {
          page_id: 10,
          slug: 'diazepam-monograph',
          title: 'Diazepam',
          page_type: 'drug_monograph',
          drug_cid: 1,
          citation_id: 100,
        },
        {
          page_id: 20,
          slug: 'half-life',
          title: 'Half-life',
          page_type: 'topic',
          drug_cid: null,
          citation_id: 200,
        },
      ],
      paramRevisions: [{ drugId: 1, referenceId: 101, referenceIds: null }],
      concentrations: [{ drugId: 1, citationId: 102 }],
      // A source anchored only by an ionization constant is grouped under its drug.
      ionizationConstants: [{ drugId: 1, referenceIds: [104] }],
      directCitations: [{ id: 103, drugId: 1 }],
      drugs: [
        { id: 1, slug: 'diazepam', names: { nb: 'Diazepam', en: 'Diazepam' } },
      ],
      citations: [100, 101, 102, 103, 104, 200].map((id) => ({
        id,
        drugId: id === 103 ? 1 : null,
        type: 'doi',
        identifier: `10.1000/${id}`,
        metadata: { title: `Source ${id}` },
        createdAt: '2026-05-12T00:00:00.000Z',
      })),
    });
    const { res, state } = createResponse();

    await handler(createRequest('/api/references?view=index'), res);

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    expect(body.totalReferences).toBe(6);

    const drugGroup = body.groups.find(
      (g: { kind: string }) => g.kind === 'drug',
    );
    expect(drugGroup.id).toBe(1);
    expect(drugGroup.href).toBe('/wiki/drug/1');
    expect(drugGroup.references.map((r: { id: number }) => r.id)).toEqual([
      100, 101, 102, 103, 104,
    ]);

    const wikiGroup = body.groups.find(
      (g: { kind: string }) => g.kind === 'wiki',
    );
    expect(wikiGroup.id).toBe(20);
    expect(wikiGroup.href).toBe('/wiki/half-life');
    expect(wikiGroup.title).toBe('Half-life');
    expect(wikiGroup.references.map((r: { id: number }) => r.id)).toEqual([
      200,
    ]);
  });

  it('returns an empty index when nothing is cited', async () => {
    mockIndexDb({
      pages: [],
      paramRevisions: [],
      concentrations: [],
      directCitations: [],
      drugs: [],
      citations: [],
    });
    const { res, state } = createResponse();

    await handler(createRequest('/api/references?view=index'), res);

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    expect(body.groups).toEqual([]);
    expect(body.buckets).toEqual([]);
    expect(body.totalReferences).toBe(0);
    expect(body.totalPages).toBe(1);
  });

  it('narrows the index to the citations a query matched', async () => {
    mockIndexDb({
      pages: [],
      paramRevisions: [],
      concentrations: [],
      directCitations: [
        { id: 100, drugId: 1 },
        { id: 101, drugId: 1 },
      ],
      drugs: [
        { id: 1, slug: 'diazepam', names: { nb: 'Diazepam', en: 'Diazepam' } },
      ],
      citations: [citationFixture(101)],
      searchMatches: [101, 999],
    });
    const { res, state } = createResponse();

    await handler(
      createRequest('/api/references?view=index&q=doi:10.1000/101'),
      res,
    );

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    // Both citations are anchored, but only the matched one is returned —
    // and the header total still describes the whole corpus.
    expect(body.totalReferences).toBe(2);
    expect(body.matchedReferences).toBe(1);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].references.map((r: { id: number }) => r.id)).toEqual([
      101,
    ]);
  });

  it('returns an empty page when the query matches nothing', async () => {
    mockIndexDb({
      pages: [],
      paramRevisions: [],
      concentrations: [],
      directCitations: [{ id: 100, drugId: 1 }],
      drugs: [{ id: 1, slug: 'diazepam', names: { nb: 'Diazepam' } }],
      citations: [citationFixture(100)],
      searchMatches: [],
    });
    const { res, state } = createResponse();

    await handler(createRequest('/api/references?view=index&q=nothing'), res);

    const body = JSON.parse(state.body);
    expect(body.groups).toEqual([]);
    expect(body.matchedReferences).toBe(0);
    expect(body.totalReferences).toBe(1);
  });

  it('treats a query that strips to nothing as zero matches', async () => {
    // `q=doi:` is a non-empty search with no searchable term left. Falling
    // through to the unfiltered bibliography would show the whole corpus while
    // the UI reports an active search.
    mockIndexDb({
      pages: [],
      paramRevisions: [],
      concentrations: [],
      directCitations: [{ id: 100, drugId: 1 }],
      drugs: [{ id: 1, slug: 'diazepam', names: { nb: 'Diazepam' } }],
      citations: [citationFixture(100)],
    });
    const { res, state } = createResponse();

    await handler(createRequest('/api/references?view=index&q=doi%3A'), res);

    const body = JSON.parse(state.body);
    expect(body.groups).toEqual([]);
    expect(body.matchedReferences).toBe(0);
    expect(body.totalReferences).toBe(1);
  });

  it('groups alphabetically by title and lists the letter buckets', async () => {
    mockIndexDb({
      pages: [],
      paramRevisions: [],
      concentrations: [],
      directCitations: [
        { id: 1, drugId: 1 },
        { id: 2, drugId: 1 },
        { id: 3, drugId: 1 },
      ],
      drugs: [{ id: 1, slug: 'diazepam', names: { nb: 'Diazepam' } }],
      citations: [
        citationFixture(1, { metadata: { title: 'Absorption of ethanol' } }),
        citationFixture(2, { metadata: { title: 'Åreknuter og alkohol' } }),
        citationFixture(3, { metadata: { title: '5-HT2A binding' } }),
      ],
    });
    const { res, state } = createResponse();

    await handler(
      createRequest('/api/references?view=index&groupBy=alpha'),
      res,
    );

    const body = JSON.parse(state.body);
    expect(body.groups.map((g: { key: string }) => g.key)).toEqual([
      'A',
      'Å',
      '#',
    ]);
    expect(body.buckets).toEqual([
      { key: 'A', label: 'A', count: 1 },
      { key: 'Å', label: 'Å', count: 1 },
      { key: '#', label: '#', count: 1 },
    ]);
    expect(body.groups[0].kind).toBe('alpha');
  });

  it('groups by year, newest first, with undated sources last', async () => {
    mockIndexDb({
      pages: [],
      paramRevisions: [],
      concentrations: [],
      directCitations: [
        { id: 1, drugId: 1 },
        { id: 2, drugId: 1 },
        { id: 3, drugId: 1 },
      ],
      drugs: [{ id: 1, slug: 'diazepam', names: { nb: 'Diazepam' } }],
      citations: [
        citationFixture(1, { metadata: { title: 'Older', year: 1999 } }),
        citationFixture(2, { metadata: { title: 'Newer', year: 2021 } }),
        citationFixture(3, { metadata: { title: 'Undated' } }),
      ],
    });
    const { res, state } = createResponse();

    await handler(createRequest('/api/references?view=index&groupBy=year'), res);

    const body = JSON.parse(state.body);
    expect(body.groups.map((g: { key: string }) => g.key)).toEqual([
      '2021',
      '1999',
      'unknown',
    ]);
    expect(body.groups[2].label).toBeNull();
  });

  it('paginates and reports the visible range', async () => {
    const ids = [1, 2, 3, 4, 5];
    mockIndexDb({
      pages: [],
      paramRevisions: [],
      concentrations: [],
      directCitations: ids.map((id) => ({ id, drugId: 1 })),
      drugs: [{ id: 1, slug: 'diazepam', names: { nb: 'Diazepam' } }],
      citations: ids.map((id) =>
        citationFixture(id, { metadata: { title: `Title ${id}` } }),
      ),
    });
    const { res, state } = createResponse();

    await handler(
      createRequest('/api/references?view=index&pageSize=2&page=2'),
      res,
    );

    const body = JSON.parse(state.body);
    expect(body.page).toBe(2);
    expect(body.totalPages).toBe(3);
    expect(body.rangeStart).toBe(3);
    expect(body.rangeEnd).toBe(4);
    expect(
      body.groups.flatMap((g: { references: Array<{ id: number }> }) =>
        g.references.map((r) => r.id),
      ),
    ).toEqual([3, 4]);
    // The group keeps its full count so the heading reads the same on
    // every page it spans.
    expect(body.groups[0].totalReferences).toBe(5);
  });

  it('restricts the page to a single bucket', async () => {
    mockIndexDb({
      pages: [],
      paramRevisions: [],
      concentrations: [],
      directCitations: [
        { id: 1, drugId: 1 },
        { id: 2, drugId: 1 },
      ],
      drugs: [{ id: 1, slug: 'diazepam', names: { nb: 'Diazepam' } }],
      citations: [
        citationFixture(1, { metadata: { title: 'Absorption' } }),
        citationFixture(2, { metadata: { title: 'Binding' } }),
      ],
    });
    const { res, state } = createResponse();

    await handler(
      createRequest('/api/references?view=index&groupBy=alpha&bucket=B'),
      res,
    );

    const body = JSON.parse(state.body);
    expect(body.bucket).toBe('B');
    expect(body.totalRows).toBe(1);
    expect(body.groups[0].references[0].id).toBe(2);
    // The jump index still lists every letter, so the user can leave B.
    expect(body.buckets.map((b: { key: string }) => b.key)).toEqual(['A', 'B']);
  });
});

describe('GET /api/references?view=search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Honours the LIMIT the handler actually asked for, the way Postgres would.
   * The search escalates through widening batches until enough hits survive
   * the visibility filter, so truncating per call is what makes that logic —
   * and a batch size of zero — observable.
   */
  function mockSearchDb(rows: unknown[]) {
    const execute = vi.fn(async (query: unknown) => {
      // drizzle serializes `LIMIT ${n}` as the literal "LIMIT " chunk followed
      // by the bare numeric parameter.
      const serialized = JSON.stringify(
        (query as { queryChunks?: unknown[] }).queryChunks ?? [],
      );
      const limit = /\{"value":\["LIMIT "\]\},(\d+)/.exec(serialized)?.[1];
      return {
        rows: limit == null ? rows : rows.slice(0, Number(limit)),
      };
    });
    getDbMock.mockReturnValue({ execute });
    return execute;
  }

  const hit = {
    id: 42,
    drug_id: null,
    type: 'doi',
    identifier: '10.1093/jat/bkaa107',
    metadata: { title: 'Postmortem drug redistribution', year: 2021 },
    created_at: '2026-05-12T00:00:00.000Z',
    match_rank: 0,
    match_source: 'identifier',
    review_snippet: null,
  };

  it('returns matching, anchored citations', async () => {
    mockSearchDb([hit]);
    filterUsedCitationIdsMock.mockResolvedValue(new Set([42]));
    const { res, state } = createResponse();

    await handler(
      createRequest('/api/references?view=search&q=doi:10.1093/jat/bkaa107'),
      res,
    );

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    expect(body.references).toHaveLength(1);
    expect(body.references[0]).toMatchObject({
      id: 42,
      identifier: '10.1093/jat/bkaa107',
      matchSource: 'identifier',
    });
    expect(body.references[0].metadata.title).toBe(
      'Postmortem drug redistribution',
    );
  });

  it('drops hits that are not anchored to any page', async () => {
    mockSearchDb([hit]);
    filterUsedCitationIdsMock.mockResolvedValue(new Set());
    const { res, state } = createResponse();

    await handler(createRequest('/api/references?view=search&q=redistribution'), res);

    expect(JSON.parse(state.body).references).toEqual([]);
  });

  it('surfaces the review excerpt for a paper-review match', async () => {
    mockSearchDb([
      {
        ...hit,
        match_rank: 5,
        match_source: 'review',
        review_snippet: '  …kohorten er liten, men funnene er konsistente…  ',
      },
    ]);
    filterUsedCitationIdsMock.mockResolvedValue(new Set([42]));
    const { res, state } = createResponse();

    await handler(createRequest('/api/references?view=search&q=kohorten'), res);

    const body = JSON.parse(state.body);
    expect(body.references[0].matchSource).toBe('review');
    expect(body.references[0].reviewSnippet).toBe(
      '…kohorten er liten, men funnene er konsistente…',
    );
  });

  it('widens the candidate scan past a run of orphaned drafts', async () => {
    // 25 higher-ranked matches are all abandoned drafts; the one anchored
    // source sits behind them. A fixed 4x over-fetch would drop it silently.
    const orphans = Array.from({ length: 25 }, (_, i) => ({
      ...hit,
      id: 100 + i,
      identifier: `10.1000/orphan-${i}`,
      match_rank: 3,
    }));
    // limit=5 → the handler's first batch is 20 rows (all orphans); only the
    // widened second batch reaches the anchored source.
    mockSearchDb([...orphans, { ...hit, id: 999, match_rank: 4 }]);
    filterUsedCitationIdsMock.mockImplementation(
      async (_db: unknown, ids: number[]) =>
        new Set(ids.filter((id) => id === 999)),
    );
    const { res, state } = createResponse();

    await handler(
      createRequest('/api/references?view=search&q=redistribution&limit=5'),
      res,
    );

    const body = JSON.parse(state.body);
    expect(body.references.map((r: { id: number }) => r.id)).toEqual([999]);
  });

  it('exposes the server match rank so the palette can rank consistently', async () => {
    mockSearchDb([{ ...hit, match_rank: 2 }]);
    filterUsedCitationIdsMock.mockResolvedValue(new Set([42]));
    const { res, state } = createResponse();

    await handler(createRequest('/api/references?view=search&q=10.1093'), res);

    expect(JSON.parse(state.body).references[0].matchRank).toBe(2);
  });

  it('does not let a fractional limit collapse the search to nothing', async () => {
    mockSearchDb([hit]);
    filterUsedCitationIdsMock.mockResolvedValue(new Set([42]));
    const { res, state } = createResponse();

    // limit=0.5 clears the `> 0` guard and truncates to 0 — a LIMIT 0 scan.
    await handler(
      createRequest('/api/references?view=search&q=redistribution&limit=0.5'),
      res,
    );

    expect(JSON.parse(state.body).references).toHaveLength(1);
  });

  it('rejects an empty query', async () => {
    getDbMock.mockReturnValue({ execute: vi.fn() });
    const { res, state } = createResponse();

    await handler(createRequest('/api/references?view=search&q=%20'), res);

    expect(state.statusCode).toBe(400);
  });
});

describe('POST /api/references', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({ userId: 123, role: 'editor' });
    fetchCrossRefMetadataMock.mockResolvedValue({
      title:
        'A footwear marks database in Western Switzerland: A forensic intelligence success',
      authors: ['Pasquier E'],
      journal: 'Forensic Science International',
      year: 2023,
      volume: '348',
      pages: '111726',
    });
    fetchPubMedMetadataMock.mockResolvedValue({
      title:
        'Postmortem redistribution of amphetamines and benzodiazepines in humans',
      authors: ['de Groot ADE'],
      journal: 'Forensic Science International',
      year: 2023,
      volume: '353',
      pages: '111876',
    });
  });

  it('returns an existing DOI row without calling CrossRef', async () => {
    fetchCrossRefMetadataMock.mockRejectedValue(new Error('upstream timeout'));
    const existing = {
      id: 9,
      drugId: null,
      type: 'doi',
      identifier: '10.1016/j.forsciint.2023.111726',
      metadata: {
        title:
          'A footwear marks database in Western Switzerland: A forensic intelligence success',
      },
      createdBy: 123,
      createdAt: '2026-05-20T00:00:00.000Z',
    };
    mockCreateReferenceDb({ existing: [existing] });
    const { res, state } = createResponse();

    await handler(
      createJsonRequest('/api/references', {
        type: 'doi',
        identifier: '10.1016/j.forsciint.2023.111726',
        metadata: { title: 'Sparse local entry' },
      }),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(fetchCrossRefMetadataMock).not.toHaveBeenCalled();
    expect(JSON.parse(state.body)).toMatchObject({
      reference: {
        id: 9,
        metadata: {
          title:
            'A footwear marks database in Western Switzerland: A forensic intelligence success',
        },
      },
    });
  });

  it('rejects DOI metadata when the submitted title does not match the resolved DOI', async () => {
    mockCreateReferenceDb({});
    const { res, state } = createResponse();

    await handler(
      createJsonRequest('/api/references', {
        type: 'doi',
        identifier: '10.1016/j.forsciint.2023.111726',
        metadata: {
          title:
            'Postmortem redistribution of amphetamines and benzodiazepines in humans',
        },
      }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'reference_metadata_mismatch',
    });
  });

  it('stores supplied DOI metadata when CrossRef has no record for the DOI agency', async () => {
    fetchCrossRefMetadataMock.mockResolvedValue(null);
    const inserted = {
      id: 10,
      drugId: null,
      type: 'doi',
      identifier: '10.5281/zenodo.12345',
      metadata: {
        title: 'Forensic toxicology reference dataset',
      },
      createdBy: 123,
      createdAt: '2026-05-20T00:00:00.000Z',
    };
    const db = mockCreateReferenceDb({ inserted });
    const { res, state } = createResponse();

    await handler(
      createJsonRequest('/api/references', {
        type: 'doi',
        identifier: '10.5281/zenodo.12345',
        metadata: {
          title: 'Forensic toxicology reference dataset',
        },
      }),
      res,
    );

    expect(state.statusCode).toBe(201);
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          title: 'Forensic toxicology reference dataset',
        }),
      }),
    );
  });

  it('rejects mismatched DOI titles written with non-Latin characters', async () => {
    fetchCrossRefMetadataMock.mockResolvedValue({
      title: '安非他明中毒的法医学分析',
      authors: ['Zhang Y'],
      journal: 'Forensic Medicine',
      year: 2024,
    });
    mockCreateReferenceDb({});
    const { res, state } = createResponse();

    await handler(
      createJsonRequest('/api/references', {
        type: 'doi',
        identifier: '10.1000/nonlatin',
        metadata: {
          title: '苯二氮卓中毒的法医学分析',
        },
      }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'reference_metadata_mismatch',
    });
  });

  it('returns a retryable error when CrossRef lookup fails upstream', async () => {
    fetchCrossRefMetadataMock.mockRejectedValue(new Error('upstream timeout'));
    const db = mockCreateReferenceDb({});
    const { res, state } = createResponse();

    await handler(
      createJsonRequest('/api/references', {
        type: 'doi',
        identifier: '10.1016/j.forsciint.2023.111726',
        metadata: {
          title:
            'Postmortem redistribution of amphetamines and benzodiazepines in humans',
        },
      }),
      res,
    );

    expect(state.statusCode).toBe(502);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'reference_resolver_unavailable',
    });
    expect(db.values).not.toHaveBeenCalled();
  });

  it('rate-limits new DOI metadata resolution before calling CrossRef', async () => {
    consumeRateLimitMock.mockReturnValueOnce({
      limited: true,
      retryAfterSeconds: 37,
    });
    const db = mockCreateReferenceDb({});
    const { res, state } = createResponse();

    await handler(
      createJsonRequest('/api/references', {
        type: 'doi',
        identifier: '10.1016/j.forsciint.2023.111726',
        metadata: {
          title:
            'Postmortem redistribution of amphetamines and benzodiazepines in humans',
        },
      }),
      res,
    );

    expect(state.statusCode).toBe(429);
    expect(state.headers['Retry-After']).toBe('37');
    expect(fetchCrossRefMetadataMock).not.toHaveBeenCalled();
    expect(db.values).not.toHaveBeenCalled();
  });

  it('stores resolved DOI metadata instead of trusting sparse submitted metadata', async () => {
    const inserted = {
      id: 7,
      drugId: null,
      type: 'doi',
      identifier: '10.1016/j.forsciint.2023.111726',
      metadata: {
        title:
          'A footwear marks database in Western Switzerland: A forensic intelligence success',
      },
      createdBy: 123,
      createdAt: '2026-05-20T00:00:00.000Z',
    };
    const db = mockCreateReferenceDb({ inserted });
    const { res, state } = createResponse();

    await handler(
      createJsonRequest('/api/references', {
        type: 'doi',
        identifier: '10.1016/j.forsciint.2023.111726',
        metadata: { title: 'A footwear marks database in Western Switzerland' },
      }),
      res,
    );

    expect(state.statusCode).toBe(201);
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          title:
            'A footwear marks database in Western Switzerland: A forensic intelligence success',
          journal: 'Forensic Science International',
        }),
      }),
    );
  });

  it('preserves supplied metadata fields when DOI resolver metadata is incomplete', async () => {
    fetchCrossRefMetadataMock.mockResolvedValue({
      title: '',
      authors: [],
      journal: '',
      year: null,
      volume: null,
      pages: null,
    });
    const inserted = {
      id: 11,
      drugId: null,
      type: 'doi',
      identifier: '10.1000/partial',
      metadata: {
        title: 'Forensic toxicology reference dataset',
        authors: ['Doe J'],
        journal: 'Journal of Forensic Toxicology',
        year: 2024,
      },
      createdBy: 123,
      createdAt: '2026-05-20T00:00:00.000Z',
    };
    const db = mockCreateReferenceDb({ inserted });
    const { res, state } = createResponse();

    await handler(
      createJsonRequest('/api/references', {
        type: 'doi',
        identifier: '10.1000/partial',
        metadata: {
          title: 'Forensic toxicology reference dataset',
          authors: ['Doe J'],
          journal: 'Journal of Forensic Toxicology',
          year: 2024,
        },
      }),
      res,
    );

    expect(state.statusCode).toBe(201);
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          title: 'Forensic toxicology reference dataset',
          authors: ['Doe J'],
          journal: 'Journal of Forensic Toxicology',
          year: 2024,
        },
      }),
    );
  });

  it('returns a stable code when PubMed cannot resolve an identifier', async () => {
    fetchPubMedMetadataMock.mockResolvedValue(null);
    const db = mockCreateReferenceDb({});
    const { res, state } = createResponse();

    await handler(
      createJsonRequest('/api/references', {
        type: 'pmid',
        identifier: '99999999',
        metadata: {
          title: 'Unknown PubMed paper',
        },
      }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'reference_identifier_unresolved',
    });
    expect(db.values).not.toHaveBeenCalled();
  });

  it('returns a retryable error when PubMed lookup fails upstream', async () => {
    fetchPubMedMetadataMock.mockRejectedValue(new Error('upstream timeout'));
    const db = mockCreateReferenceDb({});
    const { res, state } = createResponse();

    await handler(
      createJsonRequest('/api/references', {
        type: 'pmid',
        identifier: '37931468',
        metadata: {
          title:
            'Postmortem redistribution of amphetamines and benzodiazepines in humans',
        },
      }),
      res,
    );

    expect(state.statusCode).toBe(502);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'reference_resolver_unavailable',
    });
    expect(db.values).not.toHaveBeenCalled();
  });

  it('resolves PubMed identifiers before storing reference rows', async () => {
    const inserted = {
      id: 8,
      drugId: null,
      type: 'pmid',
      identifier: '37931468',
      metadata: {
        title:
          'Postmortem redistribution of amphetamines and benzodiazepines in humans',
      },
      createdBy: 123,
      createdAt: '2026-05-20T00:00:00.000Z',
    };
    const db = mockCreateReferenceDb({ inserted });
    const { res, state } = createResponse();

    await handler(
      createJsonRequest('/api/references', {
        type: 'pmid',
        identifier: '37931468',
        metadata: {
          title:
            'Postmortem redistribution of amphetamines and benzodiazepines in humans',
        },
      }),
      res,
    );

    expect(state.statusCode).toBe(201);
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          title:
            'Postmortem redistribution of amphetamines and benzodiazepines in humans',
          pages: '111876',
        }),
      }),
    );
  });
});

describe('PATCH /api/references', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 123,
      role: 'contributor',
    });
    fetchPubMedMetadataMock.mockResolvedValue(null);
    fetchCrossRefMetadataMock.mockResolvedValue(null);
    consumeRateLimitMock.mockReturnValue({
      limited: false,
      retryAfterSeconds: 0,
    });
    getClientAddressKeyMock.mockReturnValue('ip:127.0.0.1');
    resolveOneCrosswalkMock.mockResolvedValue({});
  });

  it('refreshes a pmid row from PubMed, authoritative fields winning over the stale cache', async () => {
    fetchPubMedMetadataMock.mockResolvedValue({
      title: 'Bioavailability and Pharmacokinetics of Oral Cocaine in Humans',
      authors: ['Coe MA', 'Jufer Phipps RA', 'Cone EJ', 'Walsh SL'],
      journal: 'Journal of Analytical Toxicology',
      year: 2018,
      volume: '42',
      pages: '285-292',
    });
    const db = mockUpdateReferenceDb({
      existing: {
        id: 9,
        drugId: null,
        type: 'pmid',
        identifier: '29462364',
        metadata: {
          title:
            'Bioavailability and Pharmacokinetics of Oral Cocaine in Humans',
          authors: ['Evans SM', 'Cone EJ', 'Henningfield JE'],
          journal: 'J Pharmacol Exp Ther',
          year: 2018,
          volume: '366',
          pages: '250-260',
        },
        createdBy: 1,
        createdAt: '2026-05-20T00:00:00.000Z',
      },
      updated: {
        id: 9,
        drugId: null,
        type: 'pmid',
        identifier: '29462364',
        metadata: {
          title:
            'Bioavailability and Pharmacokinetics of Oral Cocaine in Humans',
          authors: ['Coe MA', 'Jufer Phipps RA', 'Cone EJ', 'Walsh SL'],
          journal: 'Journal of Analytical Toxicology',
          year: 2018,
          volume: '42',
          pages: '285-292',
        },
        createdBy: 1,
        createdAt: '2026-05-20T00:00:00.000Z',
      },
    });
    const { res, state } = createResponse();

    await handler(
      createJsonRequestWithMethod('PATCH', '/api/references?id=9', {
        refresh: true,
      }),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(fetchPubMedMetadataMock).toHaveBeenCalledWith('29462364');
    expect(db.set).toHaveBeenCalledWith({
      metadata: expect.objectContaining({
        authors: ['Coe MA', 'Jufer Phipps RA', 'Cone EJ', 'Walsh SL'],
        journal: 'Journal of Analytical Toxicology',
        volume: '42',
        pages: '285-292',
      }),
    });
  });

  it('stores an explicit metadata override without calling any resolver', async () => {
    const db = mockUpdateReferenceDb({
      existing: {
        id: 20,
        drugId: null,
        type: 'url',
        identifier: 'https://dailymed.nlm.nih.gov/dailymed/x',
        metadata: { title: 'Old label title' },
        createdBy: 1,
        createdAt: '2026-05-20T00:00:00.000Z',
      },
      updated: {
        id: 20,
        drugId: null,
        type: 'url',
        identifier: 'https://dailymed.nlm.nih.gov/dailymed/x',
        metadata: { title: 'Corrected label title', authors: ['FDA'] },
        createdBy: 1,
        createdAt: '2026-05-20T00:00:00.000Z',
      },
    });
    const { res, state } = createResponse();

    await handler(
      createJsonRequestWithMethod('PATCH', '/api/references?id=20', {
        metadata: { title: 'Corrected label title', authors: ['FDA'] },
      }),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(fetchPubMedMetadataMock).not.toHaveBeenCalled();
    expect(fetchCrossRefMetadataMock).not.toHaveBeenCalled();
    expect(db.set).toHaveBeenCalledWith({
      metadata: { title: 'Corrected label title', authors: ['FDA'] },
    });
  });

  it('refuses to refresh a url row that has no authoritative source', async () => {
    mockUpdateReferenceDb({
      existing: {
        id: 20,
        drugId: null,
        type: 'url',
        identifier: 'https://dailymed.nlm.nih.gov/dailymed/x',
        metadata: { title: 'Label' },
        createdBy: 1,
        createdAt: '2026-05-20T00:00:00.000Z',
      },
    });
    const { res, state } = createResponse();

    await handler(
      createJsonRequestWithMethod('PATCH', '/api/references?id=20', {
        refresh: true,
      }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'reference_not_refreshable',
    });
  });

  it('returns a retryable error when the resolver is unavailable during refresh', async () => {
    fetchPubMedMetadataMock.mockRejectedValue(new Error('upstream timeout'));
    const db = mockUpdateReferenceDb({
      existing: {
        id: 9,
        drugId: null,
        type: 'pmid',
        identifier: '29462364',
        metadata: { title: 'x' },
        createdBy: 1,
        createdAt: '2026-05-20T00:00:00.000Z',
      },
    });
    const { res, state } = createResponse();

    await handler(
      createJsonRequestWithMethod('PATCH', '/api/references?id=9', {
        refresh: true,
      }),
      res,
    );

    expect(state.statusCode).toBe(502);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'reference_resolver_unavailable',
    });
    expect(db.set).not.toHaveBeenCalled();
  });

  it('rate-limits refresh metadata resolution before calling PubMed', async () => {
    consumeRateLimitMock.mockReturnValueOnce({
      limited: false,
      retryAfterSeconds: 0,
    });
    consumeRateLimitMock.mockReturnValueOnce({
      limited: true,
      retryAfterSeconds: 24,
    });
    const db = mockUpdateReferenceDb({
      existing: {
        id: 9,
        drugId: null,
        type: 'pmid',
        identifier: '29462364',
        metadata: { title: 'x' },
        createdBy: 1,
        createdAt: '2026-05-20T00:00:00.000Z',
      },
    });
    const { res, state } = createResponse();

    await handler(
      createJsonRequestWithMethod('PATCH', '/api/references?id=9', {
        refresh: true,
      }),
      res,
    );

    expect(state.statusCode).toBe(429);
    expect(state.headers['Retry-After']).toBe('24');
    expect(fetchPubMedMetadataMock).not.toHaveBeenCalled();
    expect(db.set).not.toHaveBeenCalled();
  });

  it('rejects a refresh whose supplied title conflicts with the resolved record', async () => {
    fetchPubMedMetadataMock.mockResolvedValue({
      title: 'Bioavailability and Pharmacokinetics of Oral Cocaine in Humans',
      authors: ['Coe MA'],
      journal: 'Journal of Analytical Toxicology',
      year: 2018,
    });
    const db = mockUpdateReferenceDb({
      existing: {
        id: 9,
        drugId: null,
        type: 'pmid',
        identifier: '29462364',
        metadata: { title: 'x' },
        createdBy: 1,
        createdAt: '2026-05-20T00:00:00.000Z',
      },
    });
    const { res, state } = createResponse();

    await handler(
      createJsonRequestWithMethod('PATCH', '/api/references?id=9', {
        refresh: true,
        metadata: {
          title: 'A completely unrelated paper about something else',
        },
      }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'reference_metadata_mismatch',
    });
    expect(db.set).not.toHaveBeenCalled();
  });

  it('keeps the paper\'s other handles when a patch overrides its metadata', async () => {
    // The override replaces the description, not the identity. `altIds` is what
    // keeps one paper in one row — a write arriving under the DOI finds the
    // PMID row instead of minting a second one — and it is also the handle set
    // the work-kind classification is made over (§13.3). Storing the supplied
    // record wholesale dropped it, so editing a title re-split the paper.
    const db = mockUpdateReferenceDb({
      existing: {
        id: 9,
        drugId: null,
        type: 'pmid',
        identifier: '29462364',
        metadata: { title: 'x', altIds: { doi: '10.1234/abc' } },
        createdBy: 1,
        createdAt: '2026-05-20T00:00:00.000Z',
      },
      updated: {
        id: 9,
        drugId: null,
        type: 'pmid',
        identifier: '29462364',
        metadata: { title: 'A corrected title', altIds: { doi: '10.1234/abc' } },
        createdBy: 1,
        createdAt: '2026-05-20T00:00:00.000Z',
      },
    });
    const { res, state } = createResponse();

    await handler(
      createJsonRequestWithMethod('PATCH', '/api/references?id=9', {
        metadata: { title: 'A corrected title' },
      }),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(db.set).toHaveBeenCalledWith({
      metadata: {
        title: 'A corrected title',
        altIds: { doi: '10.1234/abc' },
      },
    });
  });

  it('replaces the handles when the patch names them', async () => {
    // The other side of the same rule. Preserving handles a patch never
    // mentioned is right; refusing the correction an editor did supply is not,
    // and a fill-the-gaps merge does exactly that — leaving a wrong DOI
    // immutable, still conflating two papers through `resolveCitation`.
    const db = mockUpdateReferenceDb({
      existing: {
        id: 9,
        drugId: null,
        type: 'pmid',
        identifier: '29462364',
        metadata: { title: 'x', altIds: { doi: '10.1234/wrong' } },
        createdBy: 1,
        createdAt: '2026-05-20T00:00:00.000Z',
      },
      updated: {
        id: 9,
        drugId: null,
        type: 'pmid',
        identifier: '29462364',
        metadata: { title: 'x', altIds: { doi: '10.1234/right' } },
        createdBy: 1,
        createdAt: '2026-05-20T00:00:00.000Z',
      },
    });
    const { res, state } = createResponse();

    await handler(
      createJsonRequestWithMethod('PATCH', '/api/references?id=9', {
        metadata: { title: 'x', altIds: { doi: '10.1234/right' } },
      }),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(db.set).toHaveBeenCalledWith({
      metadata: { title: 'x', altIds: { doi: '10.1234/right' } },
    });
  });

  it('drops a handle when the patch names an empty set', async () => {
    // Removal stays possible, as an operation rather than as a side effect of
    // editing a title.
    const db = mockUpdateReferenceDb({
      existing: {
        id: 9,
        drugId: null,
        type: 'pmid',
        identifier: '29462364',
        metadata: { title: 'x', altIds: { doi: '10.1234/wrong' } },
        createdBy: 1,
        createdAt: '2026-05-20T00:00:00.000Z',
      },
      updated: {
        id: 9,
        drugId: null,
        type: 'pmid',
        identifier: '29462364',
        metadata: { title: 'x' },
        createdBy: 1,
        createdAt: '2026-05-20T00:00:00.000Z',
      },
    });
    const { res, state } = createResponse();

    await handler(
      createJsonRequestWithMethod('PATCH', '/api/references?id=9', {
        metadata: { title: 'x', altIds: {} },
      }),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(db.set).toHaveBeenCalledWith({ metadata: { title: 'x' } });
  });

  it('carries the stored handles through a refresh that does not mention them', async () => {
    fetchPubMedMetadataMock.mockResolvedValue({
      title: 'Bioavailability and Pharmacokinetics of Oral Cocaine in Humans',
      authors: ['Coe MA'],
      journal: 'Journal of Analytical Toxicology',
      year: 2018,
    });
    const db = mockUpdateReferenceDb({
      existing: {
        id: 9,
        drugId: null,
        type: 'pmid',
        identifier: '29462364',
        metadata: { title: 'x', altIds: { doi: '10.1234/abc' } },
        createdBy: 1,
        createdAt: '2026-05-20T00:00:00.000Z',
      },
      updated: {
        id: 9,
        drugId: null,
        type: 'pmid',
        identifier: '29462364',
        metadata: { title: 'x' },
        createdBy: 1,
        createdAt: '2026-05-20T00:00:00.000Z',
      },
    });
    const { res, state } = createResponse();

    await handler(
      createJsonRequestWithMethod('PATCH', '/api/references?id=9', {
        refresh: true,
      }),
      res,
    );

    expect(state.statusCode).toBe(200);
    // PubMed answered about the PMID and knows nothing about the row's other
    // handles; letting its silence blank them would lose the crosswalk.
    expect(db.set).toHaveBeenCalledWith({
      metadata: expect.objectContaining({ altIds: { doi: '10.1234/abc' } }),
    });
  });

  it('returns 404 when the citation does not exist', async () => {
    mockUpdateReferenceDb({ existing: undefined });
    const { res, state } = createResponse();

    await handler(
      createJsonRequestWithMethod('PATCH', '/api/references?id=999', {
        refresh: true,
      }),
      res,
    );

    expect(state.statusCode).toBe(404);
    expect(JSON.parse(state.body)).toEqual({ error: 'Reference not found' });
  });

  it('requires a contributor role', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 5,
      role: 'authenticated',
    });
    const { res, state } = createResponse();

    await handler(
      createJsonRequestWithMethod('PATCH', '/api/references?id=9', {
        refresh: true,
      }),
      res,
    );

    expect(state.statusCode).toBe(403);
  });

  it('rejects a body that neither refreshes nor supplies metadata', async () => {
    const { res, state } = createResponse();

    await handler(
      createJsonRequestWithMethod('PATCH', '/api/references?id=9', {}),
      res,
    );

    expect(state.statusCode).toBe(400);
  });

  it('requires a positive id query parameter', async () => {
    const { res, state } = createResponse();

    await handler(
      createJsonRequestWithMethod('PATCH', '/api/references', {
        refresh: true,
      }),
      res,
    );

    expect(state.statusCode).toBe(400);
  });
});

describe('GET /api/references?view=usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbMock.mockReturnValue({});
    filterUsedCitationIdsMock.mockResolvedValue(new Set([12]));
  });

  it('returns the drug and wiki locations that cite the reference', async () => {
    const locations = [
      {
        kind: 'drug',
        id: 5,
        slug: 'diazepam',
        names: { nb: 'Diazepam', en: 'Diazepam' },
        href: '/wiki/drug/5',
      },
      {
        kind: 'wiki',
        id: 9,
        slug: 'half-life',
        title: 'Half-life',
        pageType: 'topic',
        href: '/wiki/half-life',
      },
    ];
    collectReferenceUsageMock.mockResolvedValue(locations);
    const { res, state } = createResponse();

    await handler(createRequest('/api/references?view=usage&id=12'), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ usage: locations });
    expect(collectReferenceUsageMock).toHaveBeenCalledWith(
      expect.anything(),
      12,
    );
  });

  it('returns an empty list without querying usage for hidden citations', async () => {
    filterUsedCitationIdsMock.mockResolvedValue(new Set());
    const { res, state } = createResponse();

    await handler(createRequest('/api/references?view=usage&id=12'), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ usage: [] });
    expect(collectReferenceUsageMock).not.toHaveBeenCalled();
  });

  it('rejects a missing or invalid id', async () => {
    const { res, state } = createResponse();

    await handler(createRequest('/api/references?view=usage'), res);

    expect(state.statusCode).toBe(400);
    expect(collectReferenceUsageMock).not.toHaveBeenCalled();
  });
});
