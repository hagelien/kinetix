/**
 * The gate on the laboratory's guideline table.
 *
 * This route is the only thing standing between a restricted controlled
 * document and every reader of Kinetix: the table is kept out of the client
 * bundle and served from the database, so there is no second check further
 * down. These cases pin the answers it may give, that the gated one never
 * touches the stored table, and that a malformed stored table is refused
 * whole. The stored table here is the SYNTHETIC fixture.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getUserFromRequestMock,
  loadPermissionOverridesMock,
  getDbMock,
  storedRows,
} = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
  loadPermissionOverridesMock: vi.fn(),
  getDbMock: vi.fn(),
  storedRows: { value: [] as unknown[] },
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));
vi.mock('../../api/_lib/permissions-store.js', () => ({
  loadPermissionOverrides: loadPermissionOverridesMock,
}));
vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
  withDbRetry: <T>(fn: () => Promise<T>) => fn(),
}));

/** A query builder whose `.limit()` resolves to whatever is stored. */
function storedTable(rows: unknown[]) {
  storedRows.value = rows;
  const chain = {
    select: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => storedRows.value),
  };
  getDbMock.mockReturnValue(chain);
  return chain;
}

import handler from '../../api/refs-detection-times.ts';
import {
  SYNTHETIC_REFS_PREAMBLE,
  SYNTHETIC_REFS_ROWS,
  SYNTHETIC_REFS_SOURCE,
} from '../../src/lib/__tests__/fixtures/refsSyntheticGuideline.ts';

const STORED = {
  source: SYNTHETIC_REFS_SOURCE,
  preamble: SYNTHETIC_REFS_PREAMBLE,
  rows: SYNTHETIC_REFS_ROWS,
};

function createRequest(method = 'GET'): IncomingMessage {
  return {
    method,
    url: '/api/refs-detection-times',
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
    writeHead: vi.fn((statusCode: number, headers?: Record<string, unknown>) => {
      state.statusCode = statusCode;
      state.headers = headers ?? {};
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

describe('GET /api/refs-detection-times', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadPermissionOverridesMock.mockResolvedValue({});
    storedTable([STORED]);
  });

  it('withholds the guideline from an anonymous caller', async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    const payload = JSON.parse(state.body);
    expect(state.statusCode).toBe(200);
    expect(payload.gated).toBe(true);
    expect(payload.rows).toEqual([]);
    // Nothing stored reaches a caller outside the gate — not even the
    // document's identity — because the gated branch never reads the table.
    expect(payload.source.documentId).toBe('');
    expect(getDbMock).not.toHaveBeenCalled();
    expect(state.headers['Cache-Control']).toBe('no-store');
  });

  it('withholds the guideline from a signed-in caller outside the group', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'contributor',
      groups: [],
    });
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    const payload = JSON.parse(state.body);
    expect(payload.gated).toBe(true);
    expect(payload.rows).toEqual([]);
    // Not one row leaks through the gated branch.
    expect(state.body).not.toContain('Diazepam');
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it('serves a granted member the whole table', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 7,
      role: 'authenticated',
      groups: [{ slug: 'lab', grants: ['methods.read', 'pmConcentrations.read', 'refsDetectionTimes.read', 'patternProfile.view'] }],
    });
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    const payload = JSON.parse(state.body);
    expect(payload.gated).toBe(false);
    expect(payload.rows).toEqual(SYNTHETIC_REFS_ROWS);
    expect(payload.preamble).toBe(SYNTHETIC_REFS_PREAMBLE);
    expect(payload.source).toEqual(SYNTHETIC_REFS_SOURCE);
  });

  it('serves an admin, who holds the capability by default', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 1,
      role: 'admin',
      groups: [],
    });
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    expect(JSON.parse(state.body).gated).toBe(false);
  });

  it('answers 503 to an entitled caller when no table has been loaded', async () => {
    storedTable([]);
    getUserFromRequestMock.mockResolvedValue({
      userId: 1,
      role: 'admin',
      groups: [],
    });
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    // Not an empty 200: that would read as "the guideline names none of
    // these substances".
    expect(state.statusCode).toBe(503);
    expect(state.headers['Cache-Control']).toBe('no-store');
  });

  it('refuses a stored table with a malformed row whole, never a shortened one', async () => {
    storedTable([
      {
        ...STORED,
        rows: [...SYNTHETIC_REFS_ROWS, { key: 'broken', parent: 'X' }],
      },
    ]);
    getUserFromRequestMock.mockResolvedValue({
      userId: 1,
      role: 'admin',
      groups: [],
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res, state } = createResponse();

    await handler(createRequest(), res);

    expect(state.statusCode).toBe(500);
    expect(state.body).not.toContain('Diazepam');
    errorSpy.mockRestore();
  });

  it('rejects anything but GET', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 1,
      role: 'admin',
      groups: [],
    });
    const { res, state } = createResponse();

    await handler(createRequest('POST'), res);

    expect(state.statusCode).toBe(405);
  });
});
