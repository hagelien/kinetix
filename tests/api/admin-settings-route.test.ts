import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  getUserFromRequestMock,
  getNeonClientMock,
  getMatrixMock,
  applyMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
  getNeonClientMock: vi.fn(),
  getMatrixMock: vi.fn(),
  applyMock: vi.fn(),
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
vi.mock('../../api/_lib/site-settings-store.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/_lib/site-settings-store.js')
  >('../../api/_lib/site-settings-store.js');
  return {
    getSiteSettingsMatrix: getMatrixMock,
    applySiteSettings: applyMock,
    UnknownSiteSettingError: actual.UnknownSiteSettingError,
  };
});

import handler from '../../api/admin.ts';
import { UnknownSiteSettingError } from '../../api/_lib/site-settings-store.js';
import { SETTING } from '../../src/lib/siteSettings';

const GATE = SETTING['referenceGate.blockUnreviewedCitations'];

function createRequest(
  method: string,
  body?: unknown,
  origin = 'http://localhost',
): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [raw] : []) as IncomingMessage;
  req.method = method;
  req.url = '/api/admin?resource=settings';
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

describe('/api/admin?resource=settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMatrixMock.mockResolvedValue({ settings: { [GATE]: true }, rows: [] });
    applyMock.mockResolvedValue({ [GATE]: false });
  });

  it('answers a save with the whole matrix, so no follow-up read is needed', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    getMatrixMock.mockResolvedValue({
      settings: { [GATE]: false },
      rows: [{ id: GATE, value: false, isDefault: false }],
    });
    const { res, state } = createResponse();
    await handler(createRequest('PATCH', { settings: { [GATE]: false } }), res);
    expect(state.statusCode).toBe(200);
    expect(body(state)).toMatchObject({
      settings: { [GATE]: false },
      rows: [{ id: GATE, isDefault: false }],
    });
  });

  it('still reports success when the post-commit provenance read fails', async () => {
    // The write already committed. A 500 here would make the client revert its
    // toggle and show the gate as enabled while it is really off — the exact
    // dangerous direction. `settings` comes from the committed write, and
    // `rows: null` says only that provenance could not be refreshed.
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    applyMock.mockResolvedValue({ [GATE]: false });
    getMatrixMock.mockRejectedValue(new Error('ECONNRESET'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { res, state } = createResponse();
    await handler(createRequest('PATCH', { settings: { [GATE]: false } }), res);

    expect(state.statusCode).toBe(200);
    expect(body(state)).toEqual({ settings: { [GATE]: false }, rows: null });
    warn.mockRestore();
  });

  it('prefers the matrix read for settings when it succeeds', async () => {
    // The matrix is a real read, so it is accurate for every switch — including
    // one a concurrent admin changed. `applySiteSettings`'s answer is only the
    // fallback for when that read fails.
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    applyMock.mockResolvedValue({ [GATE]: false, 'other.switch': true });
    getMatrixMock.mockResolvedValue({
      settings: { [GATE]: false, 'other.switch': false },
      rows: [],
    });

    const { res, state } = createResponse();
    await handler(createRequest('PATCH', { settings: { [GATE]: false } }), res);

    expect(body(state)).toMatchObject({
      settings: { [GATE]: false, 'other.switch': false },
    });
  });

  it('rejects an anonymous caller', async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const { res, state } = createResponse();
    await handler(createRequest('GET'), res);
    expect(state.statusCode).toBe(401);
    expect(getMatrixMock).not.toHaveBeenCalled();
  });

  it('rejects a contributor — the switch relaxes a site-wide guard', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 5, role: 'contributor' });
    const { res, state } = createResponse();
    await handler(createRequest('PATCH', { settings: { [GATE]: false } }), res);
    expect(state.statusCode).toBe(403);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('returns the matrix to an admin', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const { res, state } = createResponse();
    await handler(createRequest('GET'), res);
    expect(state.statusCode).toBe(200);
    expect(body(state)).toMatchObject({ settings: { [GATE]: true } });
  });

  it('applies a patch on behalf of the caller', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 9, role: 'admin' });
    const { res, state } = createResponse();
    await handler(createRequest('PATCH', { settings: { [GATE]: false } }), res);
    expect(state.statusCode).toBe(200);
    expect(applyMock).toHaveBeenCalledWith({ [GATE]: false }, 9);
  });

  it('translates an unknown id into a 400 with a stable code', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    applyMock.mockRejectedValue(new UnknownSiteSettingError('gone.away'));
    const { res, state } = createResponse();
    await handler(
      createRequest('PATCH', { settings: { 'gone.away': false } }),
      res,
    );
    expect(state.statusCode).toBe(400);
    expect(body(state)).toMatchObject({ code: 'unknown_site_setting' });
  });

  it('rejects a non-boolean value before it reaches the store', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const { res, state } = createResponse();
    await handler(createRequest('PATCH', { settings: { [GATE]: 'no' } }), res);
    expect(state.statusCode).toBe(400);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin write', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const { res, state } = createResponse();
    await handler(
      createRequest('PATCH', { settings: { [GATE]: false } }, 'http://evil.example'),
      res,
    );
    expect(state.statusCode).toBeGreaterThanOrEqual(400);
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('refuses an unsupported method', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const { res, state } = createResponse();
    await handler(createRequest('PUT'), res);
    expect(state.statusCode).toBe(405);
  });
});
