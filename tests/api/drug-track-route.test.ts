import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, getUserFromRequestMock, consumeRateLimitMock } = vi.hoisted(
  () => ({
    getDbMock: vi.fn(),
    getUserFromRequestMock: vi.fn(),
    consumeRateLimitMock: vi.fn(),
  }),
);

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
  consumeRateLimit: consumeRateLimitMock,
  getClientAddressKey: vi.fn().mockReturnValue('ip:127.0.0.1'),
}));

import handler from '../../api/drug-track.ts';

function createRequest(
  drugId: string | number = '1',
  body: Record<string, unknown> = { eventType: 'view' },
): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'POST';
  req.url = `/api/drug-track?drugId=${drugId}`;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(raw.length),
    'x-real-ip': '127.0.0.1',
  };
  return req;
}

function createResponse() {
  const state = { statusCode: 200, body: '' };
  const res = {
    headersSent: false,
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(v: number) {
      state.statusCode = v;
    },
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

function mockDbBatch() {
  getDbMock.mockReturnValue({
    batch: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({}) }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({}) }),
    }),
  });
}

describe('/api/drug-track', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue(null);
    consumeRateLimitMock.mockReturnValue({
      limited: false,
      retryAfterSeconds: 0,
    });
  });

  describe('drugId validation', () => {
    it('rejects missing drugId', async () => {
      const req = Readable.from(['{"eventType":"view"}']) as IncomingMessage;
      req.method = 'POST';
      req.url = '/api/drug-track';
      req.headers = { host: 'localhost', 'content-type': 'application/json' };
      const { res, state } = createResponse();
      await handler(req, res);
      expect(state.statusCode).toBe(400);
    });

    it('rejects fractional drugId', async () => {
      const { res, state } = createResponse();
      await handler(createRequest('1.5'), res);
      expect(state.statusCode).toBe(400);
    });

    it('rejects negative drugId', async () => {
      const { res, state } = createResponse();
      await handler(createRequest('-1'), res);
      expect(state.statusCode).toBe(400);
    });

    it('rejects zero drugId', async () => {
      const { res, state } = createResponse();
      await handler(createRequest('0'), res);
      expect(state.statusCode).toBe(400);
    });

    it('accepts positive integer drugId', async () => {
      mockDbBatch();
      const { res, state } = createResponse();
      await handler(createRequest('42'), res);
      expect(state.statusCode).toBe(204);
    });
  });

  describe('authenticated user rate limiting', () => {
    beforeEach(() => {
      getUserFromRequestMock.mockResolvedValue({
        userId: 7,
        role: 'authenticated',
      });
    });

    it('allows requests when under the rate limit', async () => {
      consumeRateLimitMock.mockReturnValue({
        limited: false,
        retryAfterSeconds: 0,
      });
      mockDbBatch();
      const { res, state } = createResponse();
      await handler(createRequest('1'), res);
      expect(state.statusCode).toBe(204);
      expect(consumeRateLimitMock).toHaveBeenCalledWith(
        'drug-track-user',
        '1:7',
        1,
        60_000,
      );
    });

    it('returns 200 with rate-limited reason when limit is hit', async () => {
      consumeRateLimitMock.mockReturnValue({
        limited: true,
        retryAfterSeconds: 45,
      });
      const { res, state } = createResponse();
      await handler(createRequest('1'), res);
      expect(state.statusCode).toBe(200);
      expect(JSON.parse(state.body)).toMatchObject({
        tracked: false,
        reason: 'rate-limited',
      });
      expect(getDbMock).not.toHaveBeenCalled();
    });

    it('keys the rate limit on drugId and userId', async () => {
      consumeRateLimitMock.mockReturnValue({
        limited: false,
        retryAfterSeconds: 0,
      });
      mockDbBatch();
      getUserFromRequestMock.mockResolvedValue({ userId: 99, role: 'editor' });
      const { res } = createResponse();
      await handler(createRequest('5'), res);
      expect(consumeRateLimitMock).toHaveBeenCalledWith(
        'drug-track-user',
        '5:99',
        expect.any(Number),
        expect.any(Number),
      );
    });
  });

  describe('unauthenticated user', () => {
    it('does not call consumeRateLimit (uses legacy shouldRateLimit instead)', async () => {
      mockDbBatch();
      const { res, state } = createResponse();
      await handler(createRequest('1'), res);
      expect(consumeRateLimitMock).not.toHaveBeenCalled();
      expect(state.statusCode).toBe(204);
    });

    it('requires auth for edit events', async () => {
      const { res, state } = createResponse();
      await handler(createRequest('1', { eventType: 'edit' }), res);
      expect(state.statusCode).toBe(401);
    });
  });
});
