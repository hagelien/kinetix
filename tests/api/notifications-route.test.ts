import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getUserFromRequestMock,
  listNotificationsMock,
  markNotificationsReadMock,
  unreadNotificationCountMock,
} = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
  listNotificationsMock: vi.fn(),
  markNotificationsReadMock: vi.fn(),
  unreadNotificationCountMock: vi.fn(),
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

vi.mock('../../api/_lib/notifications.js', () => ({
  listNotifications: listNotificationsMock,
  markNotificationsRead: markNotificationsReadMock,
  unreadNotificationCount: unreadNotificationCountMock,
}));

import handler from '../../api/notifications.ts';

function createRequest(
  method = 'GET',
  body?: Record<string, unknown>,
): IncomingMessage {
  const raw = body ? JSON.stringify(body) : '';
  const req = Readable.from(raw ? [raw] : []) as IncomingMessage;
  req.method = method;
  req.url = '/api/notifications';
  req.headers = {
    host: 'localhost',
    ...(raw
      ? {
          'content-type': 'application/json',
          'content-length': String(raw.length),
        }
      : {}),
  };
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

describe('/api/notifications private response caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'authenticated',
    });
    listNotificationsMock.mockResolvedValue([
      {
        id: 7,
        type: 'dispute_created',
        targetType: 'wiki_page',
        targetId: 12,
        disputeId: 4,
        title: 'Review needed',
        bodyMd: null,
        url: '/review',
        readAt: null,
        createdAt: '2026-07-17T01:00:00.000Z',
      },
    ]);
    unreadNotificationCountMock.mockResolvedValue(3);
    markNotificationsReadMock.mockResolvedValue(1);
  });

  it('marks GET responses no-store', async () => {
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(state.body)).toMatchObject({
      unreadCount: 3,
      notifications: [{ id: 7 }],
    });
  });

  it('marks PATCH responses no-store', async () => {
    const { res, state } = createResponse();

    await handler(createRequest('PATCH', { ids: [7] }), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(state.body)).toEqual({ updated: 1 });
  });
});
