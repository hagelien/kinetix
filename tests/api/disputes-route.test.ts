import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  callerCanMock,
  disputeTargetUrlMock,
  fanOutDisputeNotificationMock,
  getUserFromRequestMock,
  listOpenDisputesMock,
  parseAndValidateMock,
  resolveActiveAgentMock,
  resolveDisputeByIdMock,
  returnPendingEditForUpheldDisputeMock,
  runInPoolTransactionMock,
  targetAuthorUserIdMock,
  upsertOpenDisputeMock,
  verificationTargetVersionMock,
  visibleVerificationTargetIdsMock,
} = vi.hoisted(() => ({
  callerCanMock: vi.fn(),
  disputeTargetUrlMock: vi.fn(),
  fanOutDisputeNotificationMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
  listOpenDisputesMock: vi.fn(),
  parseAndValidateMock: vi.fn(),
  resolveActiveAgentMock: vi.fn(),
  resolveDisputeByIdMock: vi.fn(),
  returnPendingEditForUpheldDisputeMock: vi.fn(),
  runInPoolTransactionMock: vi.fn(),
  targetAuthorUserIdMock: vi.fn(),
  upsertOpenDisputeMock: vi.fn(),
  verificationTargetVersionMock: vi.fn(),
  visibleVerificationTargetIdsMock: vi.fn(),
}));

vi.mock('../../api/_lib/auth.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/_lib/auth.js')>();
  return { ...actual, getUserFromRequest: getUserFromRequestMock };
});

vi.mock('../../api/_lib/agent-verifications.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../api/_lib/agent-verifications.js')
    >();
  return {
    ...actual,
    // The route builds a deep link for the notification; every target type but
    // `pending_edit` resolves it from the database, which no route test has.
    disputeTargetUrl: disputeTargetUrlMock,
    resolveActiveAgent: resolveActiveAgentMock,
    targetAuthorUserId: targetAuthorUserIdMock,
    visibleVerificationTargetIds: visibleVerificationTargetIdsMock,
  };
});

vi.mock('../../api/_lib/disputes.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/_lib/disputes.js')>();
  return {
    ...actual,
    listOpenDisputes: listOpenDisputesMock,
    resolveDisputeById: resolveDisputeByIdMock,
    upsertOpenDispute: upsertOpenDisputeMock,
  };
});

vi.mock('../../api/_lib/verification-targets.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../api/_lib/verification-targets.js')
    >();
  return { ...actual, verificationTargetVersion: verificationTargetVersionMock };
});

vi.mock('../../api/_lib/notifications.js', () => ({
  fanOutDisputeNotification: fanOutDisputeNotificationMock,
}));

vi.mock('../../api/_lib/upheld-dispute-return.js', () => ({
  returnPendingEditForUpheldDispute: returnPendingEditForUpheldDisputeMock,
}));

// The route wraps an uphold in a pool transaction so the ruling and the return
// it authorizes commit together. The tests run the unit of work inline and
// assert on the wrapping itself.
vi.mock('../../api/_lib/db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/_lib/db.js')>();
  return { ...actual, runInPoolTransaction: runInPoolTransactionMock };
});

// The real `callerCan` reads `permission_overrides` from whatever database the
// environment points at, so an installation that has lowered a tier would
// decide these cases instead of the test. Mock it to the shipped defaults for
// the three capabilities this route gates on.
vi.mock('../../api/_lib/permissions-store.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../api/_lib/permissions-store.js')
    >();
  return { ...actual, callerCan: callerCanMock };
});

function shippedDefaults(role: string | null | undefined, capability: string) {
  if (role === 'admin') return Promise.resolve(true);
  if (role === 'editor') return Promise.resolve(true);
  // contributor: may open a dispute, may not read the queue or resolve one.
  return Promise.resolve(
    role === 'contributor' && capability === 'dispute.open',
  );
}

vi.mock('../../api/_lib/validate.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/_lib/validate.js')>();
  return { ...actual, parseAndValidate: parseAndValidateMock };
});

import handler from '../../api/disputes.ts';

function createRequest(method: string, url = '/api/disputes'): IncomingMessage {
  const req = {} as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost' };
  return req;
}

function createResponse() {
  const state: {
    body: string;
    headers: OutgoingHttpHeaders;
    statusCode: number;
  } = {
    body: '',
    headers: {},
    statusCode: 0,
  };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number, headers: OutgoingHttpHeaders) => {
      state.statusCode = statusCode;
      state.headers = headers;
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

describe('/api/disputes cache policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveActiveAgentMock.mockResolvedValue(null);
    targetAuthorUserIdMock.mockResolvedValue(42);
    fanOutDisputeNotificationMock.mockResolvedValue({ recipients: 1 });
    callerCanMock.mockImplementation(shippedDefaults);
    runInPoolTransactionMock.mockImplementation(
      (fn: (tx: unknown) => unknown) => fn(undefined),
    );
  });

  it('returns no-store on the private open-dispute feed', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'editor' });
    listOpenDisputesMock.mockResolvedValue([
      {
        id: 5,
        targetType: 'pending_edit',
        targetId: 10,
        source: 'human',
        reasonMd: 'Needs another look',
        evidenceRefs: [],
        status: 'open',
        createdAt: new Date('2026-07-29T00:00:00Z'),
        updatedAt: new Date('2026-07-29T00:00:00Z'),
        createdBy: 1,
      },
    ]);

    const { res, state } = createResponse();
    await handler(createRequest('GET'), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(state.body).disputes).toHaveLength(1);
  });

  it('returns no-store when opening a dispute', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'contributor',
    });
    parseAndValidateMock.mockResolvedValue({
      data: {
        targetType: 'pending_edit',
        targetId: 10,
        targetVersion: '2026-07-29T00:00:00.000Z|pending',
        reasonMd: 'Conflicting source',
        evidenceRefs: [],
      },
    });
    visibleVerificationTargetIdsMock.mockResolvedValue([10]);
    verificationTargetVersionMock.mockResolvedValue(
      '2026-07-29T00:00:00.000Z|pending',
    );
    upsertOpenDisputeMock.mockResolvedValue({ id: 12, inserted: true });

    const { res, state } = createResponse();
    await handler(createRequest('POST'), res);

    expect(state.statusCode).toBe(201);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(state.body)).toEqual({
      id: 12,
      inserted: true,
      recipients: 1,
    });
    expect(upsertOpenDisputeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetVersion: '2026-07-29T00:00:00.000Z|pending',
      }),
    );
  });

  it('rejects opening a dispute against a target that moved', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'contributor',
    });
    parseAndValidateMock.mockResolvedValue({
      data: {
        targetType: 'pending_edit',
        targetId: 10,
        targetVersion: '2026-07-29T00:00:00.000Z|pending',
        reasonMd: 'Conflicting source',
        evidenceRefs: [],
      },
    });
    visibleVerificationTargetIdsMock.mockResolvedValue([10]);
    verificationTargetVersionMock.mockResolvedValue(
      '2026-07-30T00:00:00.000Z|pending',
    );

    const { res, state } = createResponse();
    await handler(createRequest('POST'), res);

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body).code).toBe('dispute_target_version_stale');
    expect(upsertOpenDisputeMock).not.toHaveBeenCalled();
  });

  it('maps a race lost inside the write to the same stale-version 409', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'contributor',
    });
    parseAndValidateMock.mockResolvedValue({
      data: {
        targetType: 'pending_edit',
        targetId: 10,
        targetVersion: '2026-07-29T00:00:00.000Z|pending',
        reasonMd: 'Conflicting source',
        evidenceRefs: [],
      },
    });
    visibleVerificationTargetIdsMock.mockResolvedValue([10]);
    verificationTargetVersionMock.mockResolvedValue(
      '2026-07-29T00:00:00.000Z|pending',
    );
    const { StaleDisputeTargetError } = await import(
      '../../api/_lib/disputes.js'
    );
    upsertOpenDisputeMock.mockRejectedValue(
      new StaleDisputeTargetError(
        '2026-07-29T00:00:00.000Z|pending',
        '2026-07-30T00:00:00.000Z|pending',
      ),
    );

    const { res, state } = createResponse();
    await handler(createRequest('POST'), res);

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body).code).toBe('dispute_target_version_stale');
  });

  it('returns no-store when resolving a dispute', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    parseAndValidateMock.mockResolvedValue({ data: { resolution: 'upheld' } });
    resolveDisputeByIdMock.mockResolvedValue({
      id: 12,
      targetType: 'pending_edit',
      targetId: 10,
      createdBy: 7,
      source: 'agent',
      reasonMd: 'The citation does not report this value',
      evidenceRefs: [],
    });
    returnPendingEditForUpheldDisputeMock.mockResolvedValue({ returned: true });
    runInPoolTransactionMock.mockImplementation(
      (fn: (tx: unknown) => unknown) => fn(undefined),
    );

    const { res, state } = createResponse();
    await handler(createRequest('PATCH', '/api/disputes?id=12'), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(state.body)).toEqual({
      id: 12,
      resolution: 'upheld',
      pendingEditReturned: true,
    });
  });
});

// The single-target read is what the /review card calls: an open dispute
// blocks approval, so the moderator (and the blocked author) must be able to
// read the objection where it is blocking, not only in the global backlog.
describe('/api/disputes single-target read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveActiveAgentMock.mockResolvedValue(null);
    listOpenDisputesMock.mockResolvedValue([]);
    callerCanMock.mockImplementation(shippedDefaults);
  });

  it('narrows the feed to one target', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'editor' });

    const { res, state } = createResponse();
    await handler(
      createRequest('GET', '/api/disputes?targetType=pending_edit&targetId=10'),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(listOpenDisputesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'open',
        targetType: 'pending_edit',
        targetId: 10,
      }),
    );
  });

  it('rejects a targetId without a targetType', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'editor' });

    const { res, state } = createResponse();
    await handler(createRequest('GET', '/api/disputes?targetId=10'), res);

    expect(state.statusCode).toBe(400);
    expect(listOpenDisputesMock).not.toHaveBeenCalled();
  });

  // The author of the blocked edit is entitled to read what is blocking it —
  // the dispute notification already carried the reason to them — even though
  // they cannot see the global queue.
  it("lets the target's author read the dispute against their own edit", async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'contributor',
    });
    targetAuthorUserIdMock.mockResolvedValue(42);

    const { res, state } = createResponse();
    await handler(
      createRequest('GET', '/api/disputes?targetType=pending_edit&targetId=10'),
      res,
    );

    expect(state.statusCode).toBe(200);
  });

  it('still refuses a contributor who is not the target author', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'contributor',
    });
    targetAuthorUserIdMock.mockResolvedValue(42);

    const { res, state } = createResponse();
    await handler(
      createRequest('GET', '/api/disputes?targetType=pending_edit&targetId=10'),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(listOpenDisputesMock).not.toHaveBeenCalled();
  });

  it('still refuses a contributor asking for the whole queue', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'contributor',
    });
    targetAuthorUserIdMock.mockResolvedValue(42);

    const { res, state } = createResponse();
    await handler(createRequest('GET'), res);

    expect(state.statusCode).toBe(403);
    expect(listOpenDisputesMock).not.toHaveBeenCalled();
  });
});

// An upheld or overruled objection closes and drops out of the open feed
// entirely, but the row — its reason, its evidence — is the recovery path an
// author needs to act on the ruling (or a reviewer needs to re-check it). It
// stays scoped to one target: there is no resolved-backlog equivalent of the
// open queue.
describe('/api/disputes resolved-dispute read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveActiveAgentMock.mockResolvedValue(null);
    listOpenDisputesMock.mockResolvedValue([]);
    callerCanMock.mockImplementation(shippedDefaults);
  });

  it('rejects an unknown status', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'editor' });

    const { res, state } = createResponse();
    await handler(createRequest('GET', '/api/disputes?status=closed'), res);

    expect(state.statusCode).toBe(400);
    expect(listOpenDisputesMock).not.toHaveBeenCalled();
  });

  it('rejects status=resolved without a target', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'editor' });

    const { res, state } = createResponse();
    await handler(createRequest('GET', '/api/disputes?status=resolved'), res);

    expect(state.statusCode).toBe(400);
    expect(listOpenDisputesMock).not.toHaveBeenCalled();
  });

  it('rejects status=resolved with a targetType but no targetId', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'editor' });

    const { res, state } = createResponse();
    await handler(
      createRequest(
        'GET',
        '/api/disputes?status=resolved&targetType=pending_edit',
      ),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(listOpenDisputesMock).not.toHaveBeenCalled();
  });

  it('lets a reviewer read the resolved dispute against one target', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'editor' });

    const { res, state } = createResponse();
    await handler(
      createRequest(
        'GET',
        '/api/disputes?status=resolved&targetType=pending_edit&targetId=10',
      ),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(listOpenDisputesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resolved',
        targetType: 'pending_edit',
        targetId: 10,
      }),
    );
  });

  // The resolved row is what the author needs to recover a truncated reason
  // or omitted evidence after an uphold — the same entitlement they already
  // have for the open feed against their own target.
  it("lets the target's author read the resolved dispute against their own edit", async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'contributor',
    });
    targetAuthorUserIdMock.mockResolvedValue(42);

    const { res, state } = createResponse();
    await handler(
      createRequest(
        'GET',
        '/api/disputes?status=resolved&targetType=pending_edit&targetId=10',
      ),
      res,
    );

    expect(state.statusCode).toBe(200);
  });

  it('still refuses a contributor who is not the target author', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'contributor',
    });
    targetAuthorUserIdMock.mockResolvedValue(42);

    const { res, state } = createResponse();
    await handler(
      createRequest(
        'GET',
        '/api/disputes?status=resolved&targetType=pending_edit&targetId=10',
      ),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(listOpenDisputesMock).not.toHaveBeenCalled();
  });
});


// Upholding an objection is a ruling with a disposition attached: the proposal
// it was ruled against goes back to its author, carrying the objection itself
// as the return note. Before this, the ruling closed the row and stopped —
// leaving a human-raised dispute with no path at all to the submitting agent,
// whose reconciliation sweeps watch for dispute *verdicts* and for *returns*,
// never for rulings.
describe('/api/disputes upheld ruling returns the proposal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveActiveAgentMock.mockResolvedValue(null);
    targetAuthorUserIdMock.mockResolvedValue(42);
    fanOutDisputeNotificationMock.mockResolvedValue({ recipients: 1 });
    callerCanMock.mockImplementation(shippedDefaults);
    disputeTargetUrlMock.mockResolvedValue('/review?id=10');
    returnPendingEditForUpheldDisputeMock.mockResolvedValue({ returned: true });
    runInPoolTransactionMock.mockImplementation(
      (fn: (tx: unknown) => unknown) => fn(undefined),
    );
  });

  function resolvedRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 12,
      targetType: 'pending_edit',
      targetId: 10,
      createdBy: 7,
      source: 'agent',
      reasonMd: 'The quoted sentence does not state 3.95 at all',
      evidenceRefs: [{ citationId: 3371 }],
      createdAt: new Date('2026-09-21T11:00:00.000Z'),
      ...overrides,
    };
  }

  it('hands the objection verbatim to the return', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    parseAndValidateMock.mockResolvedValue({ data: { resolution: 'upheld' } });
    resolveDisputeByIdMock.mockResolvedValue(resolvedRow());

    const { res, state } = createResponse();
    await handler(createRequest('PATCH', '/api/disputes?id=12'), res);

    expect(state.statusCode).toBe(200);
    expect(returnPendingEditForUpheldDisputeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingEditId: 10,
        disputeId: 12,
        source: 'agent',
        reasonMd: 'The quoted sentence does not state 3.95 at all',
        evidenceRefs: [{ citationId: 3371 }],
        resolvedBy: 1,
      }),
    );
  });

  // Overruling frees the proposal for approval; returning it would be the
  // opposite of the ruling.
  it('leaves the proposal alone when the objection is overruled', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    parseAndValidateMock.mockResolvedValue({
      data: { resolution: 'rejected' },
    });
    resolveDisputeByIdMock.mockResolvedValue(resolvedRow());

    const { res, state } = createResponse();
    await handler(createRequest('PATCH', '/api/disputes?id=12'), res);

    expect(state.statusCode).toBe(200);
    expect(returnPendingEditForUpheldDisputeMock).not.toHaveBeenCalled();
    expect(JSON.parse(state.body)).toEqual({ id: 12, resolution: 'rejected' });
  });

  // Only a pending edit has a return to give. A disputed live revision or
  // paper review is a different disposition entirely.
  it('does not try to return a target that is not a pending edit', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    parseAndValidateMock.mockResolvedValue({ data: { resolution: 'upheld' } });
    resolveDisputeByIdMock.mockResolvedValue(
      resolvedRow({ targetType: 'paper_review' }),
    );

    const { res, state } = createResponse();
    await handler(createRequest('PATCH', '/api/disputes?id=12'), res);

    expect(state.statusCode).toBe(200);
    expect(returnPendingEditForUpheldDisputeMock).not.toHaveBeenCalled();
  });

  // A skipped return has to reach the moderator: the badge disappears either
  // way, so silence would read as "handled" on a proposal still sitting there.
  it('reports a return the server could not make', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    parseAndValidateMock.mockResolvedValue({ data: { resolution: 'upheld' } });
    resolveDisputeByIdMock.mockResolvedValue(resolvedRow());
    returnPendingEditForUpheldDisputeMock.mockResolvedValue({
      returned: false,
      reason: 'not_open',
    });

    const { res, state } = createResponse();
    await handler(createRequest('PATCH', '/api/disputes?id=12'), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      id: 12,
      resolution: 'upheld',
      pendingEditReturned: false,
      pendingEditReturnSkipped: 'not_open',
    });
  });

  // The ruling is still recorded and still notified when the proposal cannot
  // be returned — the two acts are separate.
  it('still notifies on a ruling whose return was skipped', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    parseAndValidateMock.mockResolvedValue({ data: { resolution: 'upheld' } });
    resolveDisputeByIdMock.mockResolvedValue(resolvedRow());
    returnPendingEditForUpheldDisputeMock.mockResolvedValue({
      returned: false,
      reason: 'own_edit_not_allowed',
    });

    const { res } = createResponse();
    await handler(createRequest('PATCH', '/api/disputes?id=12'), res);

    expect(fanOutDisputeNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'dispute_resolved' }),
    );
  });
});

// Codex P1 (review comment 4064265331): the ruling used to commit on its own
// connection before the return was attempted, so a failure in between left a
// resolved dispute over a still-pending edit that no retry could finish — the
// next PATCH answers `disputes_not_found` on the row it just closed.
describe('/api/disputes upheld ruling commits with its return', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveActiveAgentMock.mockResolvedValue(null);
    targetAuthorUserIdMock.mockResolvedValue(42);
    fanOutDisputeNotificationMock.mockResolvedValue({ recipients: 1 });
    callerCanMock.mockImplementation(shippedDefaults);
    disputeTargetUrlMock.mockResolvedValue('/review?id=10');
    returnPendingEditForUpheldDisputeMock.mockResolvedValue({ returned: true });
    runInPoolTransactionMock.mockImplementation(
      (fn: (tx: unknown) => unknown) => fn(undefined),
    );
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    resolveDisputeByIdMock.mockResolvedValue({
      id: 12,
      targetType: 'pending_edit',
      targetId: 10,
      createdBy: 7,
      source: 'agent',
      reasonMd: 'The quoted sentence does not state the value',
      evidenceRefs: [],
      createdAt: new Date('2026-09-21T11:00:00.000Z'),
    });
  });

  it('runs the ruling and the return as one unit of work', async () => {
    parseAndValidateMock.mockResolvedValue({ data: { resolution: 'upheld' } });

    const { res, state } = createResponse();
    await handler(createRequest('PATCH', '/api/disputes?id=12'), res);

    expect(state.statusCode).toBe(200);
    expect(runInPoolTransactionMock).toHaveBeenCalledTimes(1);
    expect(resolveDisputeByIdMock).toHaveBeenCalledTimes(1);
    expect(returnPendingEditForUpheldDisputeMock).toHaveBeenCalledTimes(1);
  });

  // A failing return must take the ruling down with it, so the moderator can
  // simply click again.
  it('lets a failing return abort the ruling instead of committing it', async () => {
    parseAndValidateMock.mockResolvedValue({ data: { resolution: 'upheld' } });
    returnPendingEditForUpheldDisputeMock.mockRejectedValue(
      new Error('connection reset'),
    );

    const { res, state } = createResponse();
    await handler(createRequest('PATCH', '/api/disputes?id=12'), res);

    // The unit of work rejected inside the transaction wrapper, so the ruling
    // rolls back with it; the caller sees a failure, not a half-done uphold.
    expect(state.statusCode).toBe(500);
    const rejection = runInPoolTransactionMock.mock.results[0]
      ?.value as Promise<unknown>;
    await expect(rejection).rejects.toThrow('connection reset');
    expect(fanOutDisputeNotificationMock).not.toHaveBeenCalled();
  });

  // Overruling and withdrawal touch one row; they keep the plain http path.
  it('does not open a transaction for an overrule', async () => {
    parseAndValidateMock.mockResolvedValue({
      data: { resolution: 'rejected' },
    });

    const { res, state } = createResponse();
    await handler(createRequest('PATCH', '/api/disputes?id=12'), res);

    expect(state.statusCode).toBe(200);
    expect(runInPoolTransactionMock).not.toHaveBeenCalled();
    expect(resolveDisputeByIdMock).toHaveBeenCalledTimes(1);
  });

  // Codex P1 (review comment 4064265324): both decision capabilities reach the
  // helper, so it can apply the manual path's guards.
  it('passes the review capabilities through to the return', async () => {
    parseAndValidateMock.mockResolvedValue({ data: { resolution: 'upheld' } });

    const { res } = createResponse();
    await handler(createRequest('PATCH', '/api/disputes?id=12'), res);

    expect(returnPendingEditForUpheldDisputeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mayDecide: true,
        mayDecideOwn: true,
        mayDecideModelStructure: true,
        // The return refuses a payload revised after the objection was raised,
        // so it needs to know when that was.
        disputeRaisedAt: new Date('2026-09-21T11:00:00.000Z'),
      }),
    );
  });
});
