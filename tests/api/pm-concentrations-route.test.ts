import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, getUserFromRequestMock, loadPermissionOverridesMock } =
  vi.hoisted(() => ({
    getDbMock: vi.fn(),
    getUserFromRequestMock: vi.fn(),
    loadPermissionOverridesMock: vi.fn(),
  }));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));
vi.mock('../../api/_lib/permissions-store.js', () => ({
  loadPermissionOverrides: loadPermissionOverridesMock,
}));

import handler from '../../api/pm-concentrations.ts';

function createRequest(url = '/api/pm-concentrations?drugIds=1'): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: { host: 'localhost' },
  } as IncomingMessage;
}

function createResponse() {
  const state = {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, unknown>,
  };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number, headers?: Record<string, unknown>) => {
      state.statusCode = statusCode;
      state.headers = headers ?? {};
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

/** A synthetic joined row: invented cohort, analyte and values. */
const DISTRIBUTION_ROW = {
  sourceKey: 'synthetic-test-cohort',
  sourceCitation: 'Syntetisk testkohort, oppdiktede tall (kun for tester)',
  sourceShortLabel: 'Syntetisk',
  sourceHeading: 'Syntetiske postmortale testdata',
  sourceMatrix: 'postmortem_femoral_blood',
  sourceUnit: 'mg/L',
  sourceDescription: 'beskrivelse',
  sourceCaveats: ['en advarsel'],
  drugId: 1,
  pubchemCid: 990001,
  analyte: 'Fictazepam',
  n: 1200,
  loq: '0.050000',
  mean: '0.300000',
  median: '0.125000',
  p90: '0.500000',
  p95: '0.750000',
  p975: '1.000000',
  tcPlasma: '1.500000',
  medianOverTc: '0.080000',
  anomaly: null,
  undrawable: [],
  reviewNote: null,
  printed: { p95: '0.750' },
};

/**
 * The route runs ONE select for the payload (distributions joined to their
 * cohort), plus a lookup select only when `cids=` is used. Queue the answers in
 * call order.
 */
function mockQueries(...results: unknown[][]) {
  let call = 0;
  const select = vi.fn(() => {
    const result = results[call++] ?? [];
    const chain: Record<string, unknown> = {};
    const thenable = {
      then: (resolve: (value: unknown) => unknown) => resolve(result),
    };
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => thenable);
    return chain;
  });
  getDbMock.mockReturnValue({ select });
  return select;
}

describe('GET /api/pm-concentrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadPermissionOverridesMock.mockResolvedValue({});
  });

  it('withholds the data from an anonymous caller', async () => {
    // Unpublished forensic material: an anonymous caller gets the empty,
    // flagged payload, never the numbers.
    getUserFromRequestMock.mockResolvedValue(null);
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      sources: [],
      distributions: [],
      gated: true,
    });
    expect(state.headers['Cache-Control']).toBe('no-store');
  });

  it('withholds the data from a signed-in caller without the capability', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'contributor',
      groups: [],
    });
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    expect(JSON.parse(state.body).gated).toBe(true);
  });

  it('serves a granted member', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'authenticated',
      groups: [{ slug: 'lab', grants: ['methods.read', 'pmConcentrations.read', 'refsDetectionTimes.read', 'patternProfile.view'] }],
    });
    mockQueries([DISTRIBUTION_ROW]);
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    const body = JSON.parse(state.body);
    expect(body.gated).toBeUndefined();
    expect(body.distributions).toHaveLength(1);
    // `numeric` columns arrive as strings and must reach the client as numbers.
    expect(body.distributions[0].median).toBe(0.125);
    expect(body.distributions[0].n).toBe(1200);
    expect(body.sources[0].citation).toBe(
      'Syntetisk testkohort, oppdiktede tall (kun for tester)',
    );
  });

  it('serves an admin', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    mockQueries([DISTRIBUTION_ROW]);
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    expect(JSON.parse(state.body).distributions).toHaveLength(1);
  });

  it('reads the numbers and their cohort in one statement', async () => {
    // Two reads could pair pre-update numbers with post-update metadata during
    // a re-seed, and `source.unit` is what the client converts BY — so the
    // reader would see a misconverted forensic value with nothing amiss on the
    // face of it. One select, one snapshot.
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const select = mockQueries([DISTRIBUTION_ROW]);
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    expect(select).toHaveBeenCalledTimes(1);
    const body = JSON.parse(state.body);
    expect(body.sources[0].unit).toBe('mg/L');
    expect(body.sources[0].caveats).toEqual(['en advarsel']);
  });

  it('reports each cohort once however many rows carry it', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    mockQueries([
      DISTRIBUTION_ROW,
      { ...DISTRIBUTION_ROW, drugId: 2, analyte: 'Placebolol' },
    ]);
    const { res, state } = createResponse();

    await handler(createRequest('/api/pm-concentrations?drugIds=1,2'), res);

    const body = JSON.parse(state.body);
    expect(body.distributions).toHaveLength(2);
    expect(body.sources).toHaveLength(1);
  });

  it('drops an undrawable id the registry does not know', async () => {
    // Stored as free-form JSON: a stale id would otherwise reach the client
    // and silently stop suppressing the line it was written to suppress.
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    mockQueries([{ ...DISTRIBUTION_ROW, undrawable: ['p90', 'p99', 42] }]);
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    expect(JSON.parse(state.body).distributions[0].undrawable).toEqual(['p90']);
  });

  it('requires an id list', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const { res, state } = createResponse();

    await handler(createRequest('/api/pm-concentrations'), res);

    expect(state.statusCode).toBe(400);
  });

  it('rejects a non-numeric id rather than scanning the table', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const { res, state } = createResponse();

    await handler(createRequest('/api/pm-concentrations?drugIds=1,abc'), res);

    expect(state.statusCode).toBe(400);
  });

  it('caps the id list', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const ids = Array.from({ length: 201 }, (_, i) => i + 1).join(',');
    const { res, state } = createResponse();

    await handler(createRequest(`/api/pm-concentrations?drugIds=${ids}`), res);

    expect(state.statusCode).toBe(400);
  });

  it('refuses a write', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const { res, state } = createResponse();
    const req = { ...createRequest(), method: 'POST' } as IncomingMessage;

    await handler(req, res);

    expect(state.statusCode).toBe(405);
  });
});
