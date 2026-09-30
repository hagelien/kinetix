import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, getUserFromRequestMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
  getNeonClient: vi.fn(),
}));

vi.mock('../../api/_lib/auth.js', () => ({
  clearAuthCookie: vi.fn(),
  getUserFromRequest: getUserFromRequestMock,
}));

import handler from '../../api/auth.ts';

function createRequest(): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = 'GET';
  req.url = '/api/auth?action=me';
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

function mockDbUser(user: Record<string, unknown>) {
  const limit = vi.fn().mockResolvedValue([user]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  getDbMock.mockReturnValue({ select });
}

describe('GET /api/auth?action=me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the capped auth role instead of the raw user role', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'editor',
      groups: [],
    });
    mockDbUser({
      id: 42,
      email: 'agent@example.test',
      username: 'agent',
      role: 'admin',
      sessionMaxDays: 30,
      displayName: 'Agent',
      enabledConcentrationUnits: null,
      notificationSettings: null,
      favoriteParameters: null,
    });

    const { res, state } = createResponse();
    await handler(createRequest(), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(state.body).user).toMatchObject({
      id: 42,
      role: 'editor',
    });
  });
});
