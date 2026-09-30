import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, getUserFromRequestMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import handler from '../../api/methods.ts';

function createRequest(url = '/api/methods'): IncomingMessage {
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
  } as unknown as ServerResponse & { headersSent: boolean };
  return { res, state };
}

function mockMethodList(rows: unknown[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const groupBy = vi.fn().mockReturnValue({ orderBy });
  const joined = { leftJoin: vi.fn(), groupBy };
  joined.leftJoin.mockReturnValue(joined);
  const from = vi.fn().mockReturnValue(joined);
  const select = vi.fn().mockReturnValue({ from });
  getDbMock.mockReturnValue({ select });
}

describe('GET /api/methods cache policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks gated responses no-store', async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ methods: [], gated: true });
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it('marks privileged method lists no-store', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 7, role: 'admin' });
    mockMethodList([
      {
        id: 9001,
        code: '9001',
        name: 'Synthetic screening panel A',
        description: null,
        matrices: ['blood'],
        volumeMl: null,
        methodType: 'confirmatory',
        componentCount: 2,
        drugIds: [1, 2],
        pubchemCids: [111, 222],
      },
    ]);
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body).methods).toHaveLength(1);
    expect(state.headers['Cache-Control']).toBe('no-store');
  });
});
