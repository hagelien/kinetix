import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: vi.fn(),
}));

import adminHandler from '../../api/admin.js';
import { getUserFromRequest } from '../../api/_lib/auth.js';

function request(): IncomingMessage {
  return {
    method: 'PATCH',
    url: '/api/admin?resource=users',
    headers: {
      host: 'kinetix.no',
      origin: 'https://evil.example',
    },
  } as IncomingMessage;
}

function response(): {
  res: ServerResponse;
  status: () => number | undefined;
  json: () => Record<string, unknown>;
} {
  let statusCode: number | undefined;
  let body = '';

  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    writeHead: vi.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    end: vi.fn((chunk?: string) => {
      body = chunk ?? '';
      return res;
    }),
  } as unknown as ServerResponse;

  return {
    res,
    status: () => statusCode,
    json: () => JSON.parse(body),
  };
}

describe('admin API security', () => {
  it('rejects cross-origin mutations before auth or database work', async () => {
    const res = response();

    await adminHandler(request(), res.res);

    expect(res.status()).toBe(403);
    expect(res.json()).toEqual({
      error: 'Cross-origin API request rejected',
      code: 'cross_origin_request_rejected',
    });
    expect(getUserFromRequest).not.toHaveBeenCalled();
  });
});
