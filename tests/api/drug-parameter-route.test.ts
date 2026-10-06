import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  getDrugParameterMapMock,
  getUserFromRequestMock,
  recordImplicitAgentApprovalMock,
  isAgentUserMock,
  agentProposalLacksSourceQuoteMock,
} = vi.hoisted(() => ({
  agentProposalLacksSourceQuoteMock: vi.fn(async () => false),
  getDbMock: vi.fn(),
  getDrugParameterMapMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
  recordImplicitAgentApprovalMock: vi.fn(),
  isAgentUserMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
  // `inTransaction` joins the caller's transaction when there is one and opens a
  // fresh one otherwise. These tests exercise route logic against a mocked query
  // builder, so there is no transaction to join and none to open — the honest stub
  // is the join branch, which runs `fn` directly. Stubbing it as a no-op that never
  // calls `fn` would silently skip the work the assertions are about.
  inTransaction: (fn: () => unknown) => fn(),
  // Reported as true to match the `inTransaction` stub above: the route's advisory
  // lock helper THROWS when it is not in a transaction ("a lock that quietly
  // serializes nothing is how the first attempt at this failed review"), so a
  // `false` here would make every write path fail for a reason the production
  // path never hits.
  isInPoolTransaction: () => true,
}));

// The reference gate is now actor-aware: it runs the read-in-full check only
// for agent actors. These tests submit references and want the gate exercised,
// so treat the submitter as an agent (the human path skips the gate entirely).
vi.mock('../../api/_lib/agentHooks.js', () => ({
  isAgentUser: isAgentUserMock,
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

vi.mock('../../api/_lib/agent-verifications.js', () => ({
  recordImplicitAgentApproval: recordImplicitAgentApprovalMock,
}));

vi.mock('../../api/_lib/source-quote-gate.js', () => ({
  agentProposalLacksSourceQuote: agentProposalLacksSourceQuoteMock,
  SOURCE_QUOTE_REQUIRED_MESSAGE: 'quote required',
}));

vi.mock('../../api/_lib/drugParameterStore.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../api/_lib/drugParameterStore.js')
    >();
  return {
    ...actual,
    getDrugParameterMap: getDrugParameterMapMock,
  };
});

import handler from '../../api/drug-parameter.ts';
import {
  drugs,
  drugParameterRevisions,
  pendingEdits,
} from '../../db/schema.ts';

function createRequest(url: string): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: {
      host: 'localhost',
    },
  } as IncomingMessage;
}

function createPutRequest(url: string, body: unknown): IncomingMessage {
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  req.method = 'PUT';
  req.url = url;
  req.headers = { host: 'localhost', 'content-type': 'application/json' };
  return req;
}

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

/**
 * The applicability guard (`parameterWriteBlockedBy`) joins `drugs` to
 * `drug_parameter_applicability` on every parameter write, to refuse a value
 * for a quantity that is undefined for the substance. It is not what these
 * tests are about, so every mocked chain answers its join with no row — which
 * the guard reads as "nothing blocks this write".
 */
function notBlockedByApplicability() {
  const limit = vi.fn().mockResolvedValue([]);
  return { where: vi.fn(() => ({ limit })) };
}

function mockDrugLookup(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({
    where,
    leftJoin: vi.fn(() => notBlockedByApplicability()),
  }));
  const select = vi.fn(() => ({ from }));

  getDbMock.mockReturnValue({ select, execute: advisoryLockExecute() });

  return { limit, select };
}

// Every parameter write path now takes the per-drug applicability advisory lock
// (`SELECT pg_advisory_xact_lock(...)`) before its check-then-write, so each db
// mock below has to answer `execute`. The lock's result is discarded by
// `lockDrugForApplicability`, so an empty row set is enough — what matters is that
// the call does not throw, because a throw here surfaces as a route 500 and hides
// whatever the test was actually asserting.
const advisoryLockExecute = () => vi.fn().mockResolvedValue({ rows: [] });

// db mock for the non-admin "create pending edit" branch: a select() pre-check
// for an existing open pending edit, followed by an insert().returning().
//
// Routed BY TABLE rather than answering every select alike, because the submit
// path now re-verifies the drug row inside the transaction, under the same
// per-drug advisory lock the merge admin takes — that closes the race where a
// merge deletes the drug between the pre-checks and the insert, filing a pending
// edit that can never be approved. A single blanket chain answered that re-check
// with the (empty) open-edit result, so the route concluded the drug was gone and
// returned 404 to tests that are about something else entirely.
function mockPendingDb({
  openEdit = [] as unknown[],
  insertResult = [{ id: 99 }] as unknown[],
  insertRejects = null as unknown,
  drugRow = { id: 42 } as unknown,
} = {}) {
  const makeChain = (result: unknown[]) => {
    const limit = vi.fn().mockResolvedValue(result);
    return {
      where: vi.fn(() => ({ limit })),
      limit,
      leftJoin: vi.fn(() => notBlockedByApplicability()),
    };
  };
  const from = vi.fn((table: unknown) =>
    table === drugs ? makeChain(drugRow ? [drugRow] : []) : makeChain(openEdit),
  );
  const select = vi.fn(() => ({ from }));

  const returning =
    insertRejects != null
      ? vi.fn().mockRejectedValue(insertRejects)
      : vi.fn().mockResolvedValue(insertResult);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));

  getDbMock.mockReturnValue({ select, insert, execute: advisoryLockExecute() });

  return { select, insert, values, returning };
}

// db mock that routes each select() by the table passed to from(), so a single
// PUT can resolve the drug row, the parameter's latest revision (current refs),
// and the open-edit pre-check independently, plus capture the insert values.
function mockUnionDb({
  drugRow = { id: 42 } as unknown,
  latestRefs = [] as unknown[],
  openEdit = [] as unknown[],
  insertResult = [{ id: 88 }] as unknown[],
} = {}) {
  const makeChain = (result: unknown[]) => {
    const limit = vi.fn().mockResolvedValue(result);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ limit, orderBy }));
    return {
      where,
      limit,
      orderBy,
      leftJoin: vi.fn(() => notBlockedByApplicability()),
    };
  };
  const from = vi.fn((table: unknown) => {
    if (table === drugs) return makeChain(drugRow ? [drugRow] : []);
    if (table === drugParameterRevisions) return makeChain(latestRefs);
    if (table === pendingEdits) return makeChain(openEdit);
    return makeChain([]);
  });
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn().mockResolvedValue(insertResult);
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));

  getDbMock.mockReturnValue({ select, insert, execute: advisoryLockExecute() });
  return { select, insert, values };
}

describe('PUT /api/drug-parameter references-refresh union', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordImplicitAgentApprovalMock.mockResolvedValue(undefined);
    // Human submitter → the read-in-full gate is skipped, keeping these tests
    // focused on the union behaviour rather than the gate.
    isAgentUserMock.mockResolvedValue(false);
    getUserFromRequestMock.mockResolvedValue({ userId: 5, role: 'contributor' });
  });

  it('merges submitted references with the current set on a value-unchanged refresh', async () => {
    // Live value 0.7–1.7 h backed by citations 10 (primary) + 11.
    getDrugParameterMapMock.mockResolvedValue(
      new Map([['analyteStability', { min: 0.7, max: 1.7, unit: 'h' }]]),
    );
    const { values } = mockUnionDb({
      latestRefs: [{ referenceId: 10, referenceIds: [10, 11] }],
      insertResult: [{ id: 88 }],
    });

    const { res, state } = createResponse();
    await handler(
      createPutRequest('/api/drug-parameter?drugId=42&parameter=analyteStability', {
        // Same value, two newly-found primary sources (20, 21).
        value: { min: 0.7, max: 1.7, unit: 'h' },
        referenceIds: [20, 21],
      }),
      res,
    );

    expect(state.statusCode).toBe(201);
    // The refresh is additive: the older citations survive instead of being
    // dropped, and the submitted primary stays first.
    expect(values.mock.calls[0][0]).toMatchObject({
      parameter: 'analyteStability',
      referenceId: 20,
      referenceIds: [20, 21, 10, 11],
    });
  });

  it('does not duplicate a reference already backing the value', async () => {
    getDrugParameterMapMock.mockResolvedValue(
      new Map([['analyteStability', { min: 0.7, max: 1.7, unit: 'h' }]]),
    );
    const { values } = mockUnionDb({
      latestRefs: [{ referenceId: 10, referenceIds: [10, 11] }],
      insertResult: [{ id: 90 }],
    });

    const { res, state } = createResponse();
    await handler(
      createPutRequest('/api/drug-parameter?drugId=42&parameter=analyteStability', {
        value: { min: 0.7, max: 1.7, unit: 'h' },
        // 11 is already live; only 20 is genuinely new.
        referenceIds: [20, 11],
      }),
      res,
    );

    expect(state.statusCode).toBe(201);
    expect(values.mock.calls[0][0]).toMatchObject({
      referenceId: 20,
      referenceIds: [20, 11, 10],
    });
  });

  it('replaces references when the value actually changes', async () => {
    getDrugParameterMapMock.mockResolvedValue(
      new Map([['analyteStability', { min: 0.7, max: 1.7, unit: 'h' }]]),
    );
    const { values } = mockUnionDb({
      latestRefs: [{ referenceId: 10, referenceIds: [10, 11] }],
      insertResult: [{ id: 89 }],
    });

    const { res, state } = createResponse();
    await handler(
      createPutRequest('/api/drug-parameter?drugId=42&parameter=analyteStability', {
        // Value changed → the old sources backed the old value, so the
        // submitted set replaces rather than unions.
        value: { min: 1.0, max: 2.0, unit: 'h' },
        referenceIds: [20, 21],
      }),
      res,
    );

    expect(state.statusCode).toBe(201);
    expect(values.mock.calls[0][0]).toMatchObject({
      referenceId: 20,
      referenceIds: [20, 21],
    });
  });
});

describe('GET /api/drug-parameter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDrugParameterMapMock.mockResolvedValue(new Map());
  });

  it('returns 404 for a missing drug even if the parameter map read fails', async () => {
    mockDrugLookup([]);
    getDrugParameterMapMock.mockRejectedValue(
      new Error('parameter read failed'),
    );
    const { res, state } = createResponse();

    await handler(
      createRequest('/api/drug-parameter?drugId=999&parameter=analyteStability'),
      res,
    );

    expect(state.statusCode).toBe(404);
    expect(JSON.parse(state.body)).toMatchObject({ error: 'Drug not found' });
  });
});

describe('PUT /api/drug-parameter reference gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDrugParameterMapMock.mockResolvedValue(new Map());
    recordImplicitAgentApprovalMock.mockResolvedValue(undefined);
    isAgentUserMock.mockResolvedValue(true);
  });

  it('rejects a pharmacokinetic edit with no references', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'editor' });
    const { res, state } = createResponse();

    await handler(
      createPutRequest('/api/drug-parameter?drugId=42&parameter=analyteStability', {
        value: { min: 1, max: 2, unit: 'h' },
      }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      error: 'At least one reference is required for this parameter',
    });
    // Guard short-circuits before any drug-row writes.
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it('lets a human submit an unreviewed reference (gate is agent-only)', async () => {
    // A human contributor cites a resolvable reference that has no read-in-full
    // review. The gate is skipped for humans, so the pending edit is created
    // rather than rejected with reference_not_judged.
    getUserFromRequestMock.mockResolvedValue({ userId: 5, role: 'contributor' });
    isAgentUserMock.mockResolvedValue(false);
    const { values } = mockPendingDb({ insertResult: [{ id: 77 }] });

    const { res, state } = createResponse();

    await handler(
      createPutRequest('/api/drug-parameter?drugId=42&parameter=analyteStability', {
        value: { min: 1, max: 2, unit: 'h' },
        referenceIds: [750],
      }),
      res,
    );

    expect(state.statusCode).toBe(201);
    expect(JSON.parse(state.body)).toMatchObject({
      pending: true,
      pendingEditId: 77,
    });
    expect(values.mock.calls[0][0]).toMatchObject({
      parameter: 'analyteStability',
      referenceId: 750,
      referenceIds: [750],
    });
  });

  it('still rejects an unreviewed reference for an agent submitter', async () => {
    // Same submission from an agent: the read-in-full gate runs and rejects the
    // resolvable, unreviewed citation with reference_not_judged.
    getUserFromRequestMock.mockResolvedValue({ userId: 9, role: 'contributor' });
    isAgentUserMock.mockResolvedValue(true);
    // assertReferencesJudged reads the citation/review state via three
    // sequential queries, not db.batch() — a neon-http-only method the
    // pool-transaction client does not implement (#1356). Citation 750 is
    // resolvable (doi) with no review → gate rejects.
    const results = [[{ id: 750, type: 'doi' }], [], []];
    const where = vi.fn(() => Promise.resolve(results.shift() ?? []));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    getDbMock.mockReturnValue({ select, execute: advisoryLockExecute() });

    const { res, state } = createResponse();

    await handler(
      createPutRequest('/api/drug-parameter?drugId=42&parameter=analyteStability', {
        value: { min: 1, max: 2, unit: 'h' },
        referenceIds: [750],
      }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'reference_not_judged',
    });
  });

  it('accepts a metadata edit (molecular mass) with no references', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'editor' });

    const { values } = mockPendingDb({ insertResult: [{ id: 99 }] });

    const { res, state } = createResponse();

    await handler(
      createPutRequest(
        '/api/drug-parameter?drugId=42&parameter=molecularWeight',
        { value: 180.16 },
      ),
      res,
    );

    expect(state.statusCode).toBe(201);
    expect(JSON.parse(state.body)).toMatchObject({
      pending: true,
      pendingEditId: 99,
    });
    // No reference columns are written for an exempt metadata edit.
    expect(values).toHaveBeenCalledTimes(1);
    expect(values.mock.calls[0][0]).toMatchObject({
      parameter: 'molecularWeight',
      referenceId: null,
      referenceIds: null,
    });
  });
});

/**
 * A summarizable parameter's displayed value is the aggregate of its
 * `parameter_entries`, so there is no authored value for this endpoint to
 * accept. The refusal is unconditional — it does NOT wait for the pair to have
 * entries, because an empty parameter is exactly where a typed-in number used
 * to slip past and end up sitting outside the source-value system.
 */
describe('PUT /api/drug-parameter source-value-backed refusal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDrugParameterMapMock.mockResolvedValue(new Map());
    recordImplicitAgentApprovalMock.mockResolvedValue(undefined);
    isAgentUserMock.mockResolvedValue(false);
    getUserFromRequestMock.mockResolvedValue({ userId: 5, role: 'contributor' });
  });

  it.each([
    ['halfLife', { min: 1, max: 2, unit: 'h' }],
    ['therapeuticConcentration', { min: 10, max: 20, unit: 'h' }],
    ['logP', { median: 2.1 }],
  ] as const)('refuses an authored value for %s', async (parameter, value) => {
    mockPendingDb({ insertResult: [{ id: 1 }] });
    const { res, state } = createResponse();

    await handler(
      createPutRequest(
        `/api/drug-parameter?drugId=42&parameter=${parameter}`,
        { value, referenceIds: [10] },
      ),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'parameter_entry_backed',
    });
    // Refused before any database work — nothing is queued for review either.
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it('refuses an admin direct write too, not just a queued proposal', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    mockUnionDb({ drugRow: { id: 42 } });
    const { res, state } = createResponse();

    await handler(
      createPutRequest('/api/drug-parameter?drugId=42&parameter=halfLife', {
        value: { min: 1, max: 2, unit: 'h' },
        referenceIds: [10],
      }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'parameter_entry_backed',
    });
  });

  it('still accepts analyte stability, which is not pooled', async () => {
    // Analyte stability is matrix-specific — a degradation half-life in urine
    // and one in whole blood are different quantities with no valid
    // cross-matrix pool — so it is not summarizable and stays hand-authored.
    const { values } = mockPendingDb({ insertResult: [{ id: 55 }] });
    const { res, state } = createResponse();

    await handler(
      createPutRequest(
        '/api/drug-parameter?drugId=42&parameter=analyteStability',
        { value: { min: 1, max: 2, unit: 'h' }, referenceIds: [10] },
      ),
      res,
    );

    expect(state.statusCode).toBe(201);
    expect(values.mock.calls[0][0]).toMatchObject({
      parameter: 'analyteStability',
    });
  });
});

describe('PUT /api/drug-parameter duplicate guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDrugParameterMapMock.mockResolvedValue(new Map());
    recordImplicitAgentApprovalMock.mockResolvedValue(undefined);
    isAgentUserMock.mockResolvedValue(true);
  });

  it('refuses an agent proposal the consensus gate could never publish for want of a quote', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 7, role: 'contributor' });
    agentProposalLacksSourceQuoteMock.mockResolvedValueOnce(true);
    const { insert } = mockPendingDb({ openEdit: [] });

    const { res, state } = createResponse();
    await handler(
      createPutRequest('/api/drug-parameter?drugId=42&parameter=molecularWeight', { value: 180.16 }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({ code: 'source_quote_required' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('refuses it on the direct-write path too, before anything is written', async () => {
    // An agent granted direct writes (here: the admin role's capability) would
    // otherwise publish the unquoted value at once.
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    agentProposalLacksSourceQuoteMock.mockResolvedValueOnce(true);
    const { insert } = mockPendingDb({ openEdit: [] });

    const { res, state } = createResponse();
    await handler(
      createPutRequest('/api/drug-parameter?drugId=42&parameter=molecularWeight', { value: 180.16 }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({ code: 'source_quote_required' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('returns 409 with the existing pendingEditId when an open edit already exists', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 7, role: 'contributor' });
    // Pre-check finds an open pending edit (submitted by anyone) for this field.
    const { insert } = mockPendingDb({ openEdit: [{ id: 314 }] });

    const { res, state } = createResponse();

    await handler(
      createPutRequest(
        '/api/drug-parameter?drugId=42&parameter=molecularWeight',
        { value: 180.16 },
      ),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'parameter_pending_conflict',
      pendingEditId: 314,
    });
    // Never reaches the insert when a duplicate is detected up front.
    expect(insert).not.toHaveBeenCalled();
  });

  it('returns 409 when the insert loses the race and hits the unique index', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 7, role: 'contributor' });
    // Pre-check sees nothing, but a concurrent submit wins and the unique index
    // (pending_edits_open_parameter_idx) fires on insert.
    mockPendingDb({
      openEdit: [],
      insertRejects: Object.assign(new Error('duplicate key value'), {
        code: '23505',
      }),
    });

    const { res, state } = createResponse();

    await handler(
      createPutRequest(
        '/api/drug-parameter?drugId=42&parameter=molecularWeight',
        { value: 180.16 },
      ),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'parameter_pending_conflict',
    });
  });
});
