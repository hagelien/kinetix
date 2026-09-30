import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, beforeEach, vi } from 'vitest';

const {
  buildSearchKeyMock,
  getDbMock,
  getUserFromRequestMock,
  parseAndValidateMock,
  insertDrugMock,
  isUniqueViolationMock,
  ensureDrugMonographMock,
  getDrugParameterMapMock,
  getDrugParametersByDrugIdsMock,
  upsertDrugParameterMock,
  getDrugMetabolismMock,
  getDrugReceptorTargetsMock,
  lockDrugForEntryApplicabilityMock,
} = vi.hoisted(() => ({
  buildSearchKeyMock: vi.fn(),
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
  parseAndValidateMock: vi.fn(),
  insertDrugMock: vi.fn(),
  isUniqueViolationMock: vi.fn(),
  ensureDrugMonographMock: vi.fn(),
  getDrugParameterMapMock: vi.fn(),
  getDrugParametersByDrugIdsMock: vi.fn(),
  upsertDrugParameterMock: vi.fn(),
  getDrugMetabolismMock: vi.fn(),
  getDrugReceptorTargetsMock: vi.fn(),
  lockDrugForEntryApplicabilityMock: vi.fn(async () => {}),
}));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
  // The DELETE and PATCH paths wrap writes in a pool transaction; run the
  // callback inline against the same mocked getDb() so the chained
  // read+derive+update pipeline PATCH now performs is observable in tests.
  runInPoolTransaction: (fn: () => Promise<unknown>) => fn(),
  // `lockDrugForEntryApplicability` short-circuits when it detects it's
  // NOT running inside a pool transaction; the inline runInPoolTransaction
  // above makes that guard true, so stub the probe accordingly.
  isInPoolTransaction: () => true,
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
  // Mirror the real cookie-presence check so cache-header assertions match
  // production behaviour: anonymous (no cookie) requests stay CDN-cacheable.
  requestHasAuthCookie: (req: IncomingMessage) => Boolean(req.headers?.cookie),
}));

vi.mock('../../api/_lib/validate.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/_lib/validate.js')>();
  return {
    ...actual,
    parseAndValidate: parseAndValidateMock,
  };
});

vi.mock('../../api/_lib/drugs-helpers.js', () => ({
  buildSearchKey: buildSearchKeyMock,
  insertDrug: insertDrugMock,
  isUniqueViolation: isUniqueViolationMock,
}));

// Keep the real monograph-helpers (the DELETE path uses resolveMonographDrugCids
// against the mocked getDb) but stub the heavyweight ensureDrugMonograph.
vi.mock('../../api/_lib/monograph-helpers.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../api/_lib/monograph-helpers.js')
    >();
  return {
    ...actual,
    ensureDrugMonograph: ensureDrugMonographMock,
  };
});

const MIGRATED_PARAM_IDS = [
  'halfLife',
  'volumeOfDistribution',
  'bioavailability',
  'proteinBinding',
  'bloodPlasmaRatio',
  'tmax',
  'pKa',
  'molecularWeight',
] as const;

vi.mock('../../api/_lib/drugParameterStore.js', () => ({
  getDrugParameterMap: getDrugParameterMapMock,
  getDrugParametersByDrugIds: getDrugParametersByDrugIdsMock,
  upsertDrugParameter: upsertDrugParameterMock,
  // mergeDrugParametersIntoRow is a pure helper imported by the
  // production module; provide the real implementation (including
  // null-fill for migrated parameters) so tests assert the same
  // response contract clients see.
  mergeDrugParametersIntoRow: <T extends { id: number }>(
    row: T,
    paramMap: Map<string, unknown> | undefined,
  ) => {
    const out: Record<string, unknown> = {
      ...(row as Record<string, unknown>),
    };
    for (const id of MIGRATED_PARAM_IDS) {
      if (!(id in out)) out[id] = null;
    }
    if (paramMap) for (const [k, v] of paramMap) out[k] = v;
    return out as T & Record<string, unknown>;
  },
}));

vi.mock('../../api/_lib/metabolismStore.js', () => ({
  getDrugMetabolism: getDrugMetabolismMock,
}));

vi.mock('../../api/_lib/receptorTargetStore.js', () => ({
  getDrugReceptorTargets: getDrugReceptorTargetsMock,
}));

vi.mock('../../api/_lib/ionizationConstantsStore.js', () => ({
  getIonizationConstantsForDrug: vi.fn(async () => []),
}));

vi.mock('../../api/_lib/parameterApplicabilityStore.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../api/_lib/parameterApplicabilityStore.js')
  >();
  // PATCH and DELETE both run under lockDrugForEntryApplicability, which
  // issues `SELECT pg_advisory_xact_lock(...)` through the mocked getDb()
  // chain. The unit test's mock only exposes select/update/delete, so stub
  // the lock helper to a no-op — the concurrency behavior it enforces lives
  // in the drug-merge integration tests instead. It's a `vi.fn()` so tests
  // can assert it was actually taken (i.e. that the write path is wired to
  // the lock at all), not just that it wouldn't crash.
  return {
    ...actual,
    lockDrugForEntryApplicability: lockDrugForEntryApplicabilityMock,
  };
});

vi.mock('../../api/_lib/parameter-entries-store.js', () => ({
  getParameterSummariesWithRoutes: vi.fn(async () => ({
    summaries: {},
    routeSummaries: {},
  })),
  recomputeSummariesForDrug: vi.fn(async () => undefined),
}));

import handler, {
  escapeDrugSearchLikePattern,
  parseExactPubchemCidQuery,
} from '../../api/drugs.ts';
import {
  monographDrugCidCandidates,
  resolveMonographDrugCids,
} from '../../api/_lib/monograph-helpers.js';
import { drugs, parameterEntries } from '../../db/schema.js';

function createMockResponse() {
  const state = {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, unknown>,
  };

  const res = {
    headersSent: false,
    writeHead: vi.fn(
      (statusCode: number, headers?: Record<string, unknown>) => {
        state.statusCode = statusCode;
        state.headers = headers ?? {};
        res.headersSent = true;
        return res;
      },
    ),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse & {
    headersSent: boolean;
    writeHead: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };

  return { res, state };
}

function mockListQuery(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const groupBy = vi.fn().mockReturnValue({ orderBy });
  // search view: from().where().orderBy().limit()
  // full view:   from().leftJoin().leftJoin().where().groupBy().orderBy().limit()
  const where = vi.fn().mockReturnValue({ orderBy, groupBy });
  const joined = { leftJoin: vi.fn(), where };
  const leftJoin = joined.leftJoin.mockReturnValue(joined);
  const from = vi.fn().mockReturnValue({ where, leftJoin });
  const select = vi.fn().mockReturnValue({ from });
  getDbMock.mockReturnValue({ select });
  return { select, leftJoin, orderBy };
}

function mockSingleDrugQuery(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  getDbMock.mockReturnValue({ select });
  return { select, where };
}

function mockUpdateQuery(existingRow: unknown, updatedRow: unknown) {
  const selectLimit = vi
    .fn()
    .mockResolvedValue(existingRow ? [existingRow] : []);
  const selectWhere = vi.fn().mockReturnValue({ limit: selectLimit });
  const from = vi.fn().mockReturnValue({ where: selectWhere });
  const select = vi.fn().mockReturnValue({ from });

  const returning = vi.fn().mockResolvedValue(updatedRow ? [updatedRow] : []);
  const updateWhere = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });

  getDbMock.mockReturnValue({ select, update });
  return { set };
}

function mockDeleteQuery(existingRow: unknown, atlasCount = 0) {
  const selectLimit = vi
    .fn()
    .mockResolvedValue(existingRow ? [existingRow] : []);
  // Three `.where(...)` calls in order: the existence check (which then awaits
  // `.limit(1)`), the atlas preflight (awaited directly, one row carrying a
  // count), and the monograph-page-id lookup (awaited directly, no rows). The
  // returned array carries `.limit` so the first can chain.
  let wheres = 0;
  const selectWhere = vi.fn().mockImplementation(() => {
    wheres += 1;
    const rows: unknown[] = wheres === 2 ? [{ count: atlasCount }] : [];
    const result: unknown[] & { limit?: typeof selectLimit } = rows as never;
    result.limit = selectLimit;
    return result;
  });
  // `DELETE` now also asks `isActiveAgentUser` whether the caller is an agent,
  // before the teardown, for the admin agent-focus gate on the monograph this
  // delete would take with it. That query joins `agents` to `users`; the joined
  // chain answers "no agent", which is what these human-admin scenarios are, so
  // the gate stays inert and the teardown below is still what the tests
  // measure. The plain chain answers the three lookups exactly as before.
  const innerJoin = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
  });
  const from = vi.fn().mockReturnValue({ where: selectWhere, innerJoin });
  const select = vi.fn().mockReturnValue({ from });

  const deleteWhere = vi.fn().mockResolvedValue(undefined);
  const del = vi.fn().mockReturnValue({ where: deleteWhere });

  // The teardown's in-transaction count of open proposals naming this drug in
  // their dose context (Cmax release B): none in these scenarios.
  const execute = vi.fn().mockResolvedValue({ rows: [{ n: 0 }] });

  getDbMock.mockReturnValue({ select, delete: del, execute });
  return { select, delete: del, deleteWhere, execute };
}

interface SearchKeyInput {
  names?: Record<string, string> | null;
  nameShort?: string | null;
  aliases?: string[] | null;
}

function flatNamesAndAliases(input: SearchKeyInput): string {
  const parts: string[] = [];
  if (input.names) {
    for (const v of Object.values(input.names)) {
      if (typeof v === 'string' && v) parts.push(v);
    }
  }
  if (Array.isArray(input.aliases)) {
    for (const a of input.aliases) {
      if (typeof a === 'string' && a) parts.push(a);
    }
  }
  if (input.nameShort) parts.push(input.nameShort);
  return parts.join('\t').toLowerCase();
}

describe('GET /api/drugs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildSearchKeyMock.mockImplementation(flatNamesAndAliases);
    // Default: no drug_parameters rows exist for the mocked drugs. Tests
    // that need values can override these per-case.
    getDrugParameterMapMock.mockResolvedValue(new Map());
    getDrugParametersByDrugIdsMock.mockResolvedValue(new Map());
    getDrugMetabolismMock.mockResolvedValue(null);
    getDrugReceptorTargetsMock.mockResolvedValue([]);
  });

  it('escapes SQL LIKE wildcards in catalog search terms', () => {
    expect(escapeDrugSearchLikePattern('100%_match\\trial')).toBe(
      '100\\%\\_match\\\\trial',
    );
  });

  it('parses only safe positive integer queries as exact PubChem CID lookups', () => {
    expect(parseExactPubchemCidQuery('2118')).toBe(2118);
    expect(parseExactPubchemCidQuery('alprazolam')).toBeNull();
    expect(parseExactPubchemCidQuery('0')).toBeNull();
    expect(parseExactPubchemCidQuery('2147483648')).toBeNull();
  });

  it('resolves a wiki drug id with one query across internal id and PubChem CID', async () => {
    const row = {
      id: 42,
      slug: 'alprazolam',
      names: { nb: 'Alprazolam', en: 'Alprazolam' },
      nameShort: null,
      aliases: ['Xanax'],
      pubchemCid: 2118,
      popularityScore: 10,
      searchKey: 'alprazolam\txanax',
      monographSlug: 'alprazolam',
      createdAt: '2026-04-21T00:00:00.000Z',
      updatedAt: '2026-04-21T00:00:00.000Z',
    };
    const { select } = mockSingleDrugQuery([row]);
    getDrugParameterMapMock.mockResolvedValue(
      new Map<string, unknown>([['molecularWeight', 308.8]]),
    );
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'GET',
        url: '/api/drugs?wikiDrugId=2118',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(select).toHaveBeenCalledOnce();
    expect(getDrugParameterMapMock).toHaveBeenCalledWith(expect.anything(), 42);
    expect(JSON.parse(state.body)).toEqual({
      drug: {
        ...row,
        molecularWeight: 308.8,
        halfLife: null,
        volumeOfDistribution: null,
        bioavailability: null,
        proteinBinding: null,
        bloodPlasmaRatio: null,
        tmax: null,
        pKa: null,
        metabolism: null,
        receptorTargets: [],
        parameterSummaries: {},
        parameterRouteSummaries: {},
        ionizationConstants: [],
      },
    });
  });

  it('prefers the drugs.id match when a wiki drug id collides with another drug PubChem CID', async () => {
    // wikiDrugId=2118 matches two rows: drug id=2118 (modern drugs.id link)
    // and drug id=42 whose pubchem_cid=2118 (a number collision). The id
    // interpretation must win so a correctly-linked monograph still resolves.
    mockSingleDrugQuery([
      { id: 42, pubchemCid: 2118 },
      { id: 2118, pubchemCid: 99999 },
    ]);
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'GET',
        url: '/api/drugs?wikiDrugId=2118',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(getDrugParameterMapMock).toHaveBeenCalledWith(
      expect.anything(),
      2118,
    );
    expect(JSON.parse(state.body).drug.id).toBe(2118);
  });

  it('falls back to the PubChem CID match for legacy links with no id collision', async () => {
    // Legacy drug_cid stored a PubChem CID; no drug carries that internal id,
    // so the lone pubchem_cid match resolves.
    mockSingleDrugQuery([{ id: 42, pubchemCid: 2118 }]);
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'GET',
        url: '/api/drugs?wikiDrugId=2118',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(getDrugParameterMapMock).toHaveBeenCalledWith(expect.anything(), 42);
    expect(JSON.parse(state.body).drug.id).toBe(42);
  });

  it('returns a slim projection for search view', async () => {
    const rows = [
      {
        id: 42,
        slug: 'alprazolam',
        names: { nb: 'Alprazolam', en: 'Alprazolam' },
        nameShort: null,
        aliases: ['Xanax'],
        pubchemCid: 2118,
      },
    ];
    const { select } = mockListQuery(rows);
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'GET',
        url: '/api/drugs?view=search&q=alp&limit=5',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ drugs: rows });

    const projection = select.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(projection)).toEqual([
      'id',
      'slug',
      'names',
      'nameShort',
      'aliases',
      'pubchemCid',
    ]);
    expect(state.headers['Cache-Control']).toBe(
      'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    );
  });

  it('serves no-store (not the shared CDN cache) to logged-in requests so an admin direct edit is visible immediately', async () => {
    mockListQuery([]);
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'GET',
        url: '/api/drugs?view=search&q=alp&limit=5',
        headers: { host: 'localhost', cookie: '__Host-kinetix-auth=token' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
  });

  it('serves method-filtered drug lists no-store because analytical methods are gated', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'admin',
      groups: [],
    });
    mockListQuery([]);
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'GET',
        url: '/api/drugs?methodId=9001&limit=5',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
  });

  it('prepends a term-prefix relevance order when search view has a query', async () => {
    const { orderBy } = mockListQuery([]);
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'GET',
        url: '/api/drugs?view=search&q=fentanyl&limit=10',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(200);
    // Relevance expression is prepended ahead of the popularity order so an
    // exact parent like "Fentanyl" outranks substring-only analog matches.
    expect(orderBy).toHaveBeenCalledOnce();
    expect(orderBy.mock.calls[0]).toHaveLength(2);
  });

  it('omits the relevance order when search view has no query', async () => {
    const { orderBy } = mockListQuery([]);
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'GET',
        url: '/api/drugs?view=search&limit=10',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(orderBy).toHaveBeenCalledOnce();
    expect(orderBy.mock.calls[0]).toHaveLength(1);
  });

  it('rejects malformed batched id lookups before querying', async () => {
    const select = vi.fn();
    getDbMock.mockReturnValue({ select });
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'GET',
        url: '/api/drugs?ids=42,bad',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toEqual({ error: 'Invalid ids' });
    expect(select).not.toHaveBeenCalled();
  });

  it('supports batched full-row lookups by internal drug ids', async () => {
    const rows = [
      {
        id: 42,
        slug: 'alprazolam',
        names: { nb: 'Alprazolam', en: 'Alprazolam' },
        nameShort: null,
        aliases: ['Xanax'],
        pubchemCid: 2118,
        popularityScore: 10,
        searchKey: 'alprazolam\txanax',
        createdAt: '2026-04-21T00:00:00.000Z',
        updatedAt: '2026-04-21T00:00:00.000Z',
        _params: { molecularWeight: 308.8 },
      },
      {
        id: 43,
        slug: 'diazepam',
        names: { nb: 'Diazepam', en: 'Diazepam' },
        nameShort: null,
        aliases: [],
        pubchemCid: 3016,
        popularityScore: 9,
        searchKey: 'diazepam',
        createdAt: '2026-04-21T00:00:00.000Z',
        updatedAt: '2026-04-21T00:00:00.000Z',
        _params: { molecularWeight: 284.7 },
      },
    ];
    mockListQuery(rows);
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'GET',
        url: '/api/drugs?ids=42,43&limit=2',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      drugs: [
        expect.objectContaining({ id: 42, molecularWeight: 308.8 }),
        expect.objectContaining({ id: 43, molecularWeight: 284.7 }),
      ],
    });
  });

  it('uses a LEFT JOIN (not a correlated subquery) when search view sorts by molecularWeight', async () => {
    const rows = [
      {
        id: 7,
        slug: 'caffeine',
        names: { en: 'Caffeine' },
        nameShort: null,
        aliases: [],
        pubchemCid: 2519,
      },
    ];
    const { leftJoin } = mockListQuery(rows);
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'GET',
        url: '/api/drugs?view=search&sort=molecularWeight',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ drugs: rows });
    // Must use LEFT JOIN instead of a correlated subquery in ORDER BY.
    expect(leftJoin).toHaveBeenCalledOnce();
  });

  it('keeps the full projection by default and merges drug_parameters into the response', async () => {
    // After #302 P2, halfLife/Vd/F/Fb/B/P/Tmax/pKa/MW are no longer
    // columns on `drugs`; the single-query path fetches them via LEFT JOIN
    // and jsonb_object_agg, which the DB mock returns as `_params`.
    const drugData = {
      id: 42,
      slug: 'alprazolam',
      names: { nb: 'Alprazolam', en: 'Alprazolam' },
      nameShort: null,
      aliases: ['Xanax'],
      pubchemCid: 2118,
      retiredPeakConcentration: null,
      popularityScore: 10,
      searchKey: 'alprazolam\txanax',
      createdAt: '2026-04-21T00:00:00.000Z',
      updatedAt: '2026-04-21T00:00:00.000Z',
    };
    const rows = [{ ...drugData, _params: { molecularWeight: 308.8 } }];
    const { select, leftJoin } = mockListQuery(rows);
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'GET',
        url: '/api/drugs?q=alp&limit=5',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      drugs: [
        {
          ...drugData,
          molecularWeight: 308.8,
          // The serializer null-fills migrated parameters that don't
          // have a drug_parameters row, so the response shape stays
          // stable for clients typing them as required nullable fields.
          halfLife: null,
          volumeOfDistribution: null,
          bioavailability: null,
          proteinBinding: null,
          bloodPlasmaRatio: null,
          tmax: null,
          pKa: null,
        },
      ],
    });
    // Full view calls select() with a projection object (drug cols + _params)
    expect(select.mock.calls[0]).toHaveLength(1);
    // Full view uses LEFT JOINs to fetch drug_parameters and monograph slugs
    // in the same query.
    expect(leftJoin).toHaveBeenCalledTimes(2);
    expect(state.headers['Cache-Control']).toBe(
      'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    );
  });
});

describe('POST /api/drugs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({ userId: 7, role: 'admin' });
    getDrugParameterMapMock.mockResolvedValue(new Map());
    getDbMock.mockReturnValue({});
    ensureDrugMonographMock.mockResolvedValue({
      page: { id: 1, slug: 'alprazolam' },
      created: true,
    });
  });

  it('auto-creates a monograph for the new drug', async () => {
    parseAndValidateMock.mockResolvedValue({
      data: { names: { nb: 'Alprazolam', en: 'Alprazolam' } },
    });
    const row = {
      id: 42,
      slug: 'alprazolam',
      names: { nb: 'Alprazolam', en: 'Alprazolam' },
      nameShort: null,
      aliases: [],
      pubchemCid: 2118,
    };
    insertDrugMock.mockResolvedValue(row);
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'POST',
        url: '/api/drugs',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(201);
    expect(ensureDrugMonographMock).toHaveBeenCalledWith(
      expect.anything(),
      row,
      7,
    );
  });

  it('still returns the created drug when monograph creation fails', async () => {
    parseAndValidateMock.mockResolvedValue({
      data: { names: { nb: 'Alprazolam', en: 'Alprazolam' } },
    });
    const row = {
      id: 42,
      slug: 'alprazolam',
      names: { nb: 'Alprazolam', en: 'Alprazolam' },
      nameShort: null,
      aliases: [],
      pubchemCid: 2118,
    };
    insertDrugMock.mockResolvedValue(row);
    ensureDrugMonographMock.mockRejectedValue(new Error('boom'));
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'POST',
        url: '/api/drugs',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(201);
    expect(JSON.parse(state.body)).toEqual({
      drug: expect.objectContaining({ id: 42 }),
    });
  });
});

describe('PATCH /api/drugs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildSearchKeyMock.mockImplementation(flatNamesAndAliases);
    getUserFromRequestMock.mockResolvedValue({ userId: 7, role: 'admin' });
    getDrugParameterMapMock.mockResolvedValue(new Map());
    getDrugParametersByDrugIdsMock.mockResolvedValue(new Map());
  });

  it('recomputes the normalized search key when searchable fields change', async () => {
    parseAndValidateMock.mockResolvedValue({
      data: {
        names: { nb: 'Updated Alprazolam', en: 'Alprazolam' },
        nameShort: 'Alpraz',
      },
    });

    const existingRow = {
      id: 42,
      names: { nb: 'Alprazolam', en: 'Alprazolam' },
      nameShort: 'Xanax',
      aliases: ['Helex'],
    };
    const updatedRow = {
      ...existingRow,
      names: { nb: 'Updated Alprazolam', en: 'Alprazolam' },
      nameShort: 'Alpraz',
      searchKey: 'updated alprazolam\talprazolam\thelex\talpraz',
    };
    const { set } = mockUpdateQuery(existingRow, updatedRow);
    // The PATCH response merges drug_parameters into the row (#302 P2);
    // simulate an existing molecular weight value living in the store.
    getDrugParameterMapMock.mockResolvedValue(
      new Map<string, unknown>([['molecularWeight', 308.8]]),
    );
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'PATCH',
        url: '/api/drugs?id=42',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(buildSearchKeyMock).toHaveBeenCalledWith({
      names: { nb: 'Updated Alprazolam', en: 'Alprazolam' },
      nameShort: 'Alpraz',
      aliases: ['Helex'],
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        names: { nb: 'Updated Alprazolam', en: 'Alprazolam' },
        nameShort: 'Alpraz',
      }),
    );
    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      drug: {
        ...updatedRow,
        molecularWeight: 308.8,
        halfLife: null,
        volumeOfDistribution: null,
        bioavailability: null,
        proteinBinding: null,
        bloodPlasmaRatio: null,
        tmax: null,
        pKa: null,
      },
    });
  });
});

describe('DELETE /api/drugs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({ userId: 7, role: 'admin' });
  });

  it('rejects non-admins', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 9,
      role: 'contributor',
    });
    const { delete: del } = mockDeleteQuery({ id: 42, pubchemCid: 2118 });
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'DELETE',
        url: '/api/drugs?id=42',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(del).not.toHaveBeenCalled();
  });

  it('rejects a missing/invalid id', async () => {
    mockDeleteQuery({ id: 42, pubchemCid: 2118 });
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'DELETE',
        url: '/api/drugs',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(400);
  });

  it('returns 404 when the drug does not exist', async () => {
    const { delete: del } = mockDeleteQuery(null);
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'DELETE',
        url: '/api/drugs?id=99',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(404);
    expect(del).not.toHaveBeenCalled();
  });

  it('refuses with a conflict when admitted atlas rows name the substance', async () => {
    // `pattern_reference_*` name drugs with RESTRICT keys: those rows are a
    // published transcription a named admin admitted, and deleting a catalog
    // entry is not a decision to withdraw an admission. Without the preflight
    // the teardown reaches the foreign key and reports a 500, which tells the
    // operator nothing about what is holding the substance.
    const { delete: del } = mockDeleteQuery({ id: 42, pubchemCid: 2118 }, 3);
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'DELETE',
        url: '/api/drugs?id=42',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(String(state.body)).toContain('3');
    expect(del).not.toHaveBeenCalled();
  });

  it('deletes the drug, its monograph, and orphaned pending edits', async () => {
    const { delete: del } = mockDeleteQuery({ id: 42, pubchemCid: 2118 });
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'DELETE',
        url: '/api/drugs?id=42',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ ok: true, id: 42 });
    // monograph wiki page + drug-scoped pending edits + param_entry pending
    // edits + the drug's own parameter_entries rows + the drug row
    expect(del).toHaveBeenCalledTimes(5);
    // Direct delete must take the same per-drug advisory lock the merge
    // script and the monograph write paths do — without it, a concurrent
    // monograph create/relink can read this drug as existing between its
    // own lock acquisition and this teardown's DELETE, and commit a page
    // pointing at a substance that no longer exists (#1076, item 3's
    // existence recheck only protects against a locked writer; this locks
    // the delete side of that same race).
    expect(lockDrugForEntryApplicabilityMock).toHaveBeenCalledWith(42);
  });

  it("deletes the drug's own parameter_entries rows explicitly, before the drug row (#1339)", async () => {
    // Not left to the drug_id cascade: the Cmax dose-context release adds a
    // self-referential administered_drug_id FK with ON DELETE RESTRICT, which
    // would otherwise let a drug's own evidence block its own deletion.
    const { delete: del } = mockDeleteQuery({ id: 42, pubchemCid: 2118 });
    const { res } = createMockResponse();

    await handler(
      {
        method: 'DELETE',
        url: '/api/drugs?id=42',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    const tables = del.mock.calls.map((call) => call[0]);
    const entriesDeleteIndex = tables.indexOf(parameterEntries);
    const drugsDeleteIndex = tables.indexOf(drugs);
    expect(entriesDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(drugsDeleteIndex).toBeGreaterThan(entriesDeleteIndex);
  });
});

describe('monographDrugCidCandidates', () => {
  it('always includes the internal id', () => {
    expect(monographDrugCidCandidates(281, null, false)).toEqual([281]);
  });

  it('adds the PubChem CID for a modern row with no id collision', () => {
    expect(monographDrugCidCandidates(281, 46856354, false)).toEqual([
      281, 46856354,
    ]);
  });

  it('drops the PubChem CID when it is another drug internal id', () => {
    // 25C-NBOMe id=281; some other drug owns id=702 — its CID must not become
    // a candidate, or that drug's monograph gets mis-linked / deleted.
    expect(monographDrugCidCandidates(37, 702, true)).toEqual([37]);
  });

  it('does not duplicate when the CID equals the id', () => {
    expect(monographDrugCidCandidates(500, 500, false)).toEqual([500]);
  });
});

describe('resolveMonographDrugCids', () => {
  function fakeDb(hitRows: unknown[]) {
    const limit = vi.fn().mockResolvedValue(hitRows);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    return { db: { select } as never, select };
  }

  it('keeps the CID when no drug claims it as an id', async () => {
    const { db } = fakeDb([]);
    await expect(
      resolveMonographDrugCids(db, { id: 281, pubchemCid: 46856354 }),
    ).resolves.toEqual([281, 46856354]);
  });

  it('excludes the CID when it collides with another drug id', async () => {
    const { db } = fakeDb([{ id: 702 }]);
    await expect(
      resolveMonographDrugCids(db, { id: 37, pubchemCid: 702 }),
    ).resolves.toEqual([37]);
  });

  it('skips the collision query entirely when there is no distinct CID', async () => {
    const { db, select } = fakeDb([]);
    await expect(
      resolveMonographDrugCids(db, { id: 42, pubchemCid: null }),
    ).resolves.toEqual([42]);
    expect(select).not.toHaveBeenCalled();
  });
});
