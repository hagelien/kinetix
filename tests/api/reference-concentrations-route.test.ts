import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listReferenceConcentrationsForDrugIdsMock,
  listReferenceConcentrationsMock,
} = vi.hoisted(() => ({
  listReferenceConcentrationsForDrugIdsMock: vi.fn(),
  listReferenceConcentrationsMock: vi.fn(),
}));

vi.mock('../../api/_lib/reference-concentrations-helpers.js', () => ({
  deleteReferenceConcentration: vi.fn(),
  getReferenceConcentrationById: vi.fn(),
  insertReferenceConcentration: vi.fn(),
  listReferenceConcentrations: listReferenceConcentrationsMock,
  listReferenceConcentrationsForDrugIds:
    listReferenceConcentrationsForDrugIdsMock,
  serializeReferenceConcentration: vi.fn((row: unknown) => row),
  updateReferenceConcentration: vi.fn(),
}));

import handler from '../../api/reference-concentrations.ts';

function createRequest(url: string): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: { host: 'localhost' },
  } as IncomingMessage;
}

function createMockResponse() {
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
  } as unknown as ServerResponse & {
    headersSent: boolean;
    writeHead: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };

  return { res, state };
}

describe('GET /api/reference-concentrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    '/api/reference-concentrations?drugIds=42,bad',
    '/api/reference-concentrations?drugIds=',
  ])('rejects malformed drugIds query strings: %s', async (url) => {
    const { res, state } = createMockResponse();

    await handler(createRequest(url), res);

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toEqual({ error: 'Invalid drugIds' });
    expect(listReferenceConcentrationsForDrugIdsMock).not.toHaveBeenCalled();
  });

  it('caches successful batch lookups at the CDN edge', async () => {
    listReferenceConcentrationsForDrugIdsMock.mockResolvedValue([
      { id: 1, drugId: 42 },
    ]);
    const { res, state } = createMockResponse();

    await handler(
      createRequest('/api/reference-concentrations?drugIds=42'),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe(
      'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
    );
    expect(JSON.parse(state.body)).toEqual({
      itemsByDrugId: { '42': [{ id: 1, drugId: 42 }] },
    });
  });

  it('bypasses the CDN edge cache for fresh admin reloads', async () => {
    listReferenceConcentrationsMock.mockResolvedValue([{ id: 1, drugId: 42 }]);
    const { res, state } = createMockResponse();

    await handler(
      createRequest('/api/reference-concentrations?drugId=42&fresh=1'),
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(state.body)).toEqual({ items: [{ id: 1, drugId: 42 }] });
  });
});
