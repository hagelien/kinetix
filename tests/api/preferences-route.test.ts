import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, getUserFromRequestMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import handler from '../../api/preferences.ts';

function createRequest(
  method = 'GET',
  body?: Record<string, unknown>,
): IncomingMessage {
  const raw = body ? JSON.stringify(body) : '';
  const req = Readable.from(raw ? [raw] : []) as IncomingMessage;
  req.method = method;
  req.url = '/api/preferences';
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

function mockDbPreferences(row: Record<string, unknown>) {
  const limit = vi.fn().mockResolvedValue([row]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });
  getDbMock.mockReturnValue({ select, update });
}

describe('/api/preferences private response caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'authenticated',
    });
    mockDbPreferences({
      displayName: 'Max',
      enabledConcentrationUnits: ['µmol/L', 'mg/L'],
      notificationSettings: null,
      favoriteParameters: [],
    });
  });

  it('marks GET responses no-store', async () => {
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(state.body).preferences).toMatchObject({
      displayName: 'Max',
    });
  });

  it('marks PATCH responses no-store', async () => {
    const { res, state } = createResponse();

    await handler(createRequest('PATCH', { displayName: 'Max H' }), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
  });
});

describe('/api/preferences ethanol display unit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'authenticated',
    });
  });

  it('defaults to per mille when the column holds nothing usable', async () => {
    mockDbPreferences({
      displayName: null,
      enabledConcentrationUnits: ['µmol/L', 'mg/L'],
      ethanolConcentrationUnit: null,
      notificationSettings: null,
      favoriteParameters: [],
    });
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    expect(JSON.parse(state.body).preferences.ethanolConcentrationUnit).toBe('‰');
  });

  it('accepts ‰, % and any concentration unit', async () => {
    for (const unit of ['‰', '%', 'mg/L', 'µmol/L']) {
      mockDbPreferences({
        displayName: null,
        enabledConcentrationUnits: ['µmol/L', 'mg/L'],
        ethanolConcentrationUnit: unit,
        notificationSettings: null,
        favoriteParameters: [],
      });
      const { res, state } = createResponse();

      await handler(
        createRequest('PATCH', { ethanolConcentrationUnit: unit }),
        res,
      );

      expect(state.statusCode).toBe(200);
      const db = getDbMock.mock.results.at(-1)!.value;
      expect(db.update().set).toHaveBeenCalledWith(
        expect.objectContaining({ ethanolConcentrationUnit: unit }),
      );
      expect(JSON.parse(state.body).preferences.ethanolConcentrationUnit).toBe(
        unit,
      );
    }
  });

  it('rejects an unknown unit', async () => {
    mockDbPreferences({
      displayName: null,
      enabledConcentrationUnits: ['µmol/L', 'mg/L'],
      ethanolConcentrationUnit: '‰',
      notificationSettings: null,
      favoriteParameters: [],
    });
    const { res, state } = createResponse();

    await handler(
      createRequest('PATCH', { ethanolConcentrationUnit: 'mg/kg' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(state.body).toContain('errors.unknownConcentrationUnit');
  });
});
