import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, getUserFromRequestMock, getNeonClientMock } = vi.hoisted(
  () => ({
    getDbMock: vi.fn(),
    getUserFromRequestMock: vi.fn(),
    getNeonClientMock: vi.fn(),
  }),
);

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
  getNeonClient: getNeonClientMock,
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import handler from '../../api/admin.ts';

function createJsonRequest(body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'PATCH';
  req.url = '/api/admin?resource=users';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(raw),
  };
  return req;
}

function createGetRequest(resource: string): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = 'GET';
  req.url = `/api/admin?resource=${resource}`;
  req.headers = { host: 'localhost' };
  return req;
}

function createResponse() {
  const state = {
    statusCode: 200,
    body: '',
    headers: {} as Record<string, unknown>,
  };
  const res = {
    headersSent: false,
    setHeader: vi.fn(
      (name: string, value: string | number | readonly string[]) => {
        state.headers[name] = value;
        return res;
      },
    ),
    writeHead: vi.fn(
      (statusCode: number, headers?: Record<string, unknown>) => {
        state.statusCode = statusCode;
        state.headers = { ...state.headers, ...(headers ?? {}) };
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

/**
 * Set up the Drizzle mock for the agent-check SELECT that runs before every
 * PATCH. The user-role UPDATE now runs through the raw Neon tagged-template
 * client (see mockNeonClientForUserPatch), so the Drizzle `update` chain is
 * no longer needed here.
 */
function mockDbForAgentCheck(agentRows: unknown[]) {
  const agentLimit = vi.fn().mockResolvedValue(agentRows);
  const agentWhere = vi.fn().mockReturnValue({ limit: agentLimit });
  const agentFrom = vi.fn().mockReturnValue({ where: agentWhere });
  const select = vi.fn().mockReturnValue({ from: agentFrom });
  getDbMock.mockReturnValue({ select });
  return { select };
}

/**
 * Return a mock tagged-template function for the raw Neon client used by the
 * atomic role-change CTE. The function resolves to `rows` which represents
 * the rows returned by the CTE's final SELECT (the updated user row).
 */
function mockNeonClientForUserPatch(rows: unknown[]) {
  const taggedFn = vi.fn().mockResolvedValue(rows);
  getNeonClientMock.mockReturnValue(taggedFn);
  return taggedFn;
}

describe('PATCH /api/admin?resource=users security boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
  });

  it('rejects assigning admin to a user that backs an agent token', async () => {
    const { select } = mockDbForAgentCheck([{ id: 99 }]);
    mockNeonClientForUserPatch([]);
    const { res, state } = createResponse();

    await handler(createJsonRequest({ userId: 42, role: 'admin' }), res);

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'agent_admin_role_forbidden',
    });
    // Agent-check SELECT ran; Neon client should NOT have been called since
    // the handler returns early after detecting the agent conflict.
    expect(select).toHaveBeenCalledOnce();
    expect(getNeonClientMock).not.toHaveBeenCalled();
  });

  it('still permits admin assignment for a normal human user', async () => {
    mockDbForAgentCheck([]);
    const neonFn = mockNeonClientForUserPatch([{ id: 42, role: 'admin' }]);
    const { res, state } = createResponse();

    await handler(createJsonRequest({ userId: 42, role: 'admin' }), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      user: { id: 42, role: 'admin' },
    });
    expect(neonFn).toHaveBeenCalledOnce();
    expect(state.headers['Cache-Control']).toBe('no-store');
  });

  it('returns 404 when the target user does not exist', async () => {
    mockDbForAgentCheck([]);
    const neonFn = mockNeonClientForUserPatch([]);
    const { res, state } = createResponse();

    await handler(createJsonRequest({ userId: 999, role: 'editor' }), res);

    expect(state.statusCode).toBe(404);
    expect(neonFn).toHaveBeenCalledOnce();
  });
});

describe('GET /api/admin cache policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
  });

  it('marks authenticated admin resources no-store', async () => {
    const orderBy = vi.fn().mockResolvedValue([]);
    const from = vi.fn().mockReturnValue({ orderBy });
    const select = vi.fn().mockReturnValue({ from });
    getDbMock.mockReturnValue({ select });
    const { res, state } = createResponse();

    await handler(createGetRequest('users'), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(state.body)).toEqual({ users: [] });
  });

  it('leaves the public category list cache-neutral', async () => {
    const orderBy = vi.fn().mockResolvedValue([]);
    const from = vi.fn().mockReturnValue({ orderBy });
    const select = vi.fn().mockReturnValue({ from });
    getDbMock.mockReturnValue({ select });
    const { res, state } = createResponse();

    await handler(createGetRequest('categories'), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBeUndefined();
    expect(JSON.parse(state.body)).toEqual({ categories: [] });
    expect(getUserFromRequestMock).not.toHaveBeenCalled();
  });
});
