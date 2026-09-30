import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NAV_ITEM_IDS } from '../../src/lib/navItems';

const {
  getDbMock,
  getUserFromRequestMock,
  getNeonClientMock,
  getStateMock,
  setMock,
  loadMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
  getNeonClientMock: vi.fn(),
  getStateMock: vi.fn(),
  setMock: vi.fn(),
  loadMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
  getNeonClient: getNeonClientMock,
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

// The store has its own tests; here we only care that the route reaches it
// with the caller's id and translates its errors.
vi.mock('../../api/_lib/nav-visibility-store.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/_lib/nav-visibility-store.js')
  >('../../api/_lib/nav-visibility-store.js');
  return {
    getHiddenNavItemsState: getStateMock,
    loadHiddenNavItems: loadMock,
    setHiddenNavItem: setMock,
    UnknownNavItemError: actual.UnknownNavItemError,
  };
});

import handler from '../../api/admin.ts';
import { UnknownNavItemError } from '../../api/_lib/nav-visibility-store.js';

function createRequest(
  method: string,
  body?: unknown,
  origin = 'http://localhost',
): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [raw] : []) as IncomingMessage;
  req.method = method;
  req.url = '/api/admin?resource=nav-visibility';
  req.headers = {
    host: 'localhost',
    origin,
    ...(raw
      ? {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(raw)),
        }
      : {}),
  };
  return req;
}

function createResponse() {
  const state = { statusCode: 200, body: '' };
  const res = {
    headersSent: false,
    setHeader: vi.fn(() => res),
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

function body(state: { body: string }): Record<string, unknown> {
  return state.body ? JSON.parse(state.body) : {};
}

describe('/api/admin?resource=nav-visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStateMock.mockResolvedValue({
      hiddenItems: [NAV_ITEM_IDS[0]],
      updatedAt: '2026-09-21T00:00:00.000Z',
      updatedBy: { id: 1, username: 'admin' },
    });
    loadMock.mockResolvedValue([]);
    setMock.mockResolvedValue({
      hiddenItems: [NAV_ITEM_IDS[0]],
      updatedAt: '2026-09-21T00:00:00.000Z',
      updatedBy: { id: 1, username: 'admin' },
    });
  });

  it('answers GET publicly, with no session at all, through the cached fail-open accessor', async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const { res, state } = createResponse();
    await handler(createRequest('GET'), res);
    expect(state.statusCode).toBe(200);
    expect(body(state)).toEqual({
      hiddenItems: [],
      updatedAt: null,
      updatedBy: null,
    });
    expect(loadMock).toHaveBeenCalled();
    expect(getStateMock).not.toHaveBeenCalled();
  });

  it('answers an authenticated non-privileged GET the same fail-open way, with no provenance', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 5, role: 'contributor' });
    const { res, state } = createResponse();
    await handler(createRequest('GET'), res);
    expect(state.statusCode).toBe(200);
    expect(body(state)).toEqual({
      hiddenItems: [],
      updatedAt: null,
      updatedBy: null,
    });
    expect(loadMock).toHaveBeenCalled();
    expect(getStateMock).not.toHaveBeenCalled();
  });

  it('falls back to the cached fail-open payload when resolving the caller fails (e.g. DB outage)', async () => {
    getUserFromRequestMock.mockRejectedValue(new Error('connection refused'));
    const { res, state } = createResponse();
    await handler(createRequest('GET'), res);
    expect(state.statusCode).toBe(200);
    expect(body(state)).toEqual({
      hiddenItems: [],
      updatedAt: null,
      updatedBy: null,
    });
    expect(loadMock).toHaveBeenCalled();
    expect(getStateMock).not.toHaveBeenCalled();
  });

  it('serves the provenance-carrying GET only to a caller holding admin.navVisibility.manage', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const { res, state } = createResponse();
    await handler(createRequest('GET'), res);
    expect(state.statusCode).toBe(200);
    expect(body(state)).toEqual({
      hiddenItems: [NAV_ITEM_IDS[0]],
      updatedAt: '2026-09-21T00:00:00.000Z',
      updatedBy: { id: 1, username: 'admin' },
    });
    expect(getStateMock).toHaveBeenCalled();
    expect(loadMock).not.toHaveBeenCalled();
  });

  it('falls back to the fail-open payload when the provenance query itself fails (e.g. pre-0096 database)', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    getStateMock.mockRejectedValue(new Error('relation "site_settings" does not exist'));
    const { res, state } = createResponse();
    await handler(createRequest('GET'), res);
    expect(state.statusCode).toBe(200);
    expect(body(state)).toEqual({
      hiddenItems: [],
      updatedAt: null,
      updatedBy: null,
    });
    expect(getStateMock).toHaveBeenCalled();
    expect(loadMock).toHaveBeenCalled();
  });

  it('rejects an anonymous PATCH', async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const { res, state } = createResponse();
    await handler(
      createRequest('PATCH', { id: NAV_ITEM_IDS[0], hidden: true }),
      res,
    );
    expect(state.statusCode).toBe(401);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('rejects a contributor — hiding a link is an admin-delegable change, not a contributor one', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 5, role: 'contributor' });
    const { res, state } = createResponse();
    await handler(
      createRequest('PATCH', { id: NAV_ITEM_IDS[0], hidden: true }),
      res,
    );
    expect(state.statusCode).toBe(403);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('applies a patch on behalf of the caller', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 9, role: 'admin' });
    const { res, state } = createResponse();
    await handler(
      createRequest('PATCH', { id: NAV_ITEM_IDS[0], hidden: true }),
      res,
    );
    expect(state.statusCode).toBe(200);
    expect(setMock).toHaveBeenCalledWith(NAV_ITEM_IDS[0], true, 9);
    expect(body(state)).toMatchObject({ hiddenItems: [NAV_ITEM_IDS[0]] });
  });

  it('translates an unknown id into a 400 with a stable code', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    setMock.mockRejectedValue(new UnknownNavItemError('gone.away'));
    const { res, state } = createResponse();
    await handler(
      createRequest('PATCH', { id: 'gone.away', hidden: true }),
      res,
    );
    expect(state.statusCode).toBe(400);
    expect(body(state)).toMatchObject({ code: 'unknown_nav_item' });
  });

  it('rejects a malformed payload before it reaches the store', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const { res, state } = createResponse();
    await handler(
      createRequest('PATCH', { id: NAV_ITEM_IDS[0], hidden: 'nope' }),
      res,
    );
    expect(state.statusCode).toBe(400);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin write', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const { res, state } = createResponse();
    await handler(
      createRequest(
        'PATCH',
        { id: NAV_ITEM_IDS[0], hidden: true },
        'http://evil.example',
      ),
      res,
    );
    expect(state.statusCode).toBeGreaterThanOrEqual(400);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('refuses an unsupported method', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const { res, state } = createResponse();
    await handler(createRequest('PUT'), res);
    expect(state.statusCode).toBe(405);
  });
});
