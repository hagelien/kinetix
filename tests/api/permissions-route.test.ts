import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getUserFromRequestMock,
  loadPermissionOverridesMock,
  getPermissionMatrixMock,
  listPermissionHistoryMock,
  applyPermissionChangesMock,
} = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
  loadPermissionOverridesMock: vi.fn(),
  getPermissionMatrixMock: vi.fn(),
  listPermissionHistoryMock: vi.fn(),
  applyPermissionChangesMock: vi.fn(),
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));
vi.mock('../../api/_lib/permissions-store.js', () => ({
  loadPermissionOverrides: loadPermissionOverridesMock,
  getPermissionMatrix: getPermissionMatrixMock,
  listPermissionHistory: listPermissionHistoryMock,
  applyPermissionChanges: applyPermissionChangesMock,
}));

import handler from '../../api/permissions.ts';

function createRequest(
  method: string,
  url: string,
  body?: unknown,
): IncomingMessage {
  const req = (
    body === undefined
      ? (Readable.from([]) as unknown)
      : (Readable.from([JSON.stringify(body)]) as unknown)
  ) as IncomingMessage & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost', 'content-type': 'application/json' };
  return req;
}

function createResponse(): {
  res: ServerResponse;
  state: { statusCode: number; body: string };
} {
  const state = { statusCode: 200, body: '' };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
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

beforeEach(() => {
  vi.resetAllMocks();
  loadPermissionOverridesMock.mockResolvedValue({
    'review.edit.decide': 'contributor',
  });
  getPermissionMatrixMock.mockResolvedValue({
    overrides: { 'review.edit.decide': 'contributor' },
    rows: [
      {
        capability: 'review.edit.decide',
        minTier: 'contributor',
        isDefault: false,
        updatedAt: '2026-01-01T00:00:00.000Z',
        updatedBy: { id: 1, username: 'root' },
      },
    ],
  });
  listPermissionHistoryMock.mockResolvedValue([]);
  applyPermissionChangesMock.mockImplementation(
    async ({
      changes,
    }: {
      changes: Array<{ capability: string; tier: string | null }>;
    }) => ({
      ok: true,
      applied: changes.map((change) => ({
        capability: change.capability,
        minTier: change.tier ?? 'editor',
        isDefault: change.tier === null,
      })),
    }),
  );
});

describe('GET /api/permissions', () => {
  it('serves the override map to anonymous callers', async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const { res, state } = createResponse();

    await handler(createRequest('GET', '/api/permissions'), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      overrides: { 'review.edit.decide': 'contributor' },
    });
    // The public view must not leak provenance or the audit trail.
    expect(getPermissionMatrixMock).not.toHaveBeenCalled();
    expect(listPermissionHistoryMock).not.toHaveBeenCalled();
  });

  it('requires admin for the provenance view', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 4, role: 'editor' });
    const { res, state } = createResponse();

    await handler(createRequest('GET', '/api/permissions?view=admin'), res);

    expect(state.statusCode).toBe(403);
    expect(getPermissionMatrixMock).not.toHaveBeenCalled();
  });

  it('returns rows and history for an admin', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const { res, state } = createResponse();

    await handler(createRequest('GET', '/api/permissions?view=admin'), res);

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    expect(body.rows).toHaveLength(1);
    expect(body.history).toEqual([]);
  });
});

describe('PATCH /api/permissions', () => {
  it('rejects anonymous callers with 401', async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const { res, state } = createResponse();

    await handler(
      createRequest('PATCH', '/api/permissions', {
        changes: [{ capability: 'methods.write', minTier: 'contributor' }],
      }),
      res,
    );

    expect(state.statusCode).toBe(401);
    expect(applyPermissionChangesMock).not.toHaveBeenCalled();
  });

  it('rejects an editor — the matrix is not delegable', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 4, role: 'editor' });
    const { res, state } = createResponse();

    await handler(
      createRequest('PATCH', '/api/permissions', {
        changes: [{ capability: 'methods.write', minTier: 'contributor' }],
      }),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(applyPermissionChangesMock).not.toHaveBeenCalled();
  });

  it('applies a batch for an admin and returns the refreshed matrix', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const { res, state } = createResponse();

    await handler(
      createRequest('PATCH', '/api/permissions', {
        changes: [
          { capability: 'methods.write', minTier: 'contributor' },
          { capability: 'dispute.resolve', minTier: null },
        ],
      }),
      res,
    );

    expect(state.statusCode).toBe(200);
    // One batched call, so the store can validate everything before writing
    // and commit the writes together.
    expect(applyPermissionChangesMock).toHaveBeenCalledTimes(1);
    expect(applyPermissionChangesMock).toHaveBeenCalledWith({
      actorId: 1,
      changes: [
        { capability: 'methods.write', tier: 'contributor' },
        { capability: 'dispute.resolve', tier: null },
      ],
    });
    expect(JSON.parse(state.body).applied).toEqual([
      'methods.write',
      'dispute.resolve',
    ]);
  });

  it('rejects the whole batch when the store refuses a row', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    applyPermissionChangesMock.mockResolvedValueOnce({
      ok: false,
      reason: 'locked_capability',
      capability: 'admin.users.manage',
    });
    const { res, state } = createResponse();

    await handler(
      createRequest('PATCH', '/api/permissions', {
        changes: [
          { capability: 'admin.users.manage', minTier: 'editor' },
          { capability: 'methods.write', minTier: 'contributor' },
        ],
      }),
      res,
    );

    expect(state.statusCode).toBe(400);
    const body = JSON.parse(state.body);
    expect(body.code).toBe('locked_capability');
    expect(body.error).toContain('admin.users.manage');
  });

  it('rejects a malformed tier before touching the store', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const { res, state } = createResponse();

    await handler(
      createRequest('PATCH', '/api/permissions', {
        changes: [{ capability: 'methods.write', minTier: 'wizard' }],
      }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(applyPermissionChangesMock).not.toHaveBeenCalled();
  });
});

describe('other methods', () => {
  it('rejects DELETE with 405', async () => {
    const { res, state } = createResponse();
    await handler(createRequest('DELETE', '/api/permissions'), res);
    expect(state.statusCode).toBe(405);
  });
});
