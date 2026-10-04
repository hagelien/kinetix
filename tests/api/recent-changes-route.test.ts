import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
}));

import handler from '../../api/recent-changes.ts';

function createRequest(url: string): IncomingMessage {
  return {
    method: 'GET',
    url,
    headers: { host: 'localhost' },
  } as IncomingMessage;
}

function createResponse(): {
  res: ServerResponse;
  state: {
    statusCode: number;
    body: string;
    headers: Record<string, unknown>;
  };
} {
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
      },
    ),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
    }),
  } as unknown as ServerResponse;

  return { res, state };
}

// All three queries the handler runs (drug-parameter revisions, wiki
// revisions, approved source values) share the same join/order/limit shape, so one self-referential chain
// stub — resolving on `.limit()` — covers either.
function createChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function mockDb(
  parameterRows: unknown[],
  wikiRows: unknown[],
  sourceValueRows: unknown[] = [],
) {
  const select = vi
    .fn()
    .mockReturnValueOnce(createChain(parameterRows))
    .mockReturnValueOnce(createChain(wikiRows))
    .mockReturnValueOnce(createChain(sourceValueRows));

  getDbMock.mockReturnValue({ select } as unknown as ReturnType<
    typeof getDbMock
  >);

  return { select };
}

const author = {
  username: 'alice',
  displayName: 'Alice',
  role: 'editor',
  isAgent: false,
};

describe('GET /api/recent-changes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects non-GET methods', async () => {
    mockDb([], []);
    const req = { method: 'POST', url: '/api/recent-changes', headers: {} } as IncomingMessage;
    const { res, state } = createResponse();
    await handler(req, res);
    expect(state.statusCode).toBe(405);
  });

  it('merges drug-parameter and wiki changes, sorted by recency', async () => {
    const parameterRows = [
      {
        id: 1,
        parameter: 'halfLife',
        editSummary: null,
        createdAt: new Date('2026-09-18T10:00:00Z'),
        drug: { id: 1, slug: 'diazepam', names: { en: 'Diazepam' }, nameShort: null },
        author,
      },
      {
        id: 2,
        parameter: 'tmax',
        editSummary: null,
        createdAt: new Date('2026-09-18T08:00:00Z'),
        drug: { id: 2, slug: 'morphine', names: { en: 'Morphine' }, nameShort: null },
        author,
      },
    ];
    const wikiRows = [
      {
        id: 10,
        editSummary: 'Clarify metabolism',
        createdAt: new Date('2026-09-18T09:00:00Z'),
        page: { slug: 'diazepam-metabolism', title: 'Diazepam metabolism' },
        author,
      },
    ];
    mockDb(parameterRows, wikiRows);

    const req = createRequest('/api/recent-changes');
    const { res, state } = createResponse();
    await handler(req, res);

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body) as { changes: Array<{ type: string; id: number }> };
    expect(body.changes.map((c) => `${c.type}:${c.id}`)).toEqual([
      'drug_parameter:1',
      'wiki:10',
      'drug_parameter:2',
    ]);
    expect(state.headers['Cache-Control']).toContain('public');
  });

  it('includes approved source values on revisionless parameters, tagged by origin', async () => {
    const parameterRows = [
      {
        id: 5,
        parameter: 'volumeOfDistribution',
        editSummary: null,
        createdAt: new Date('2026-10-01T06:00:00Z'),
        drug: { id: 1, slug: 'amphetamine', names: { en: 'Amphetamine' }, nameShort: null },
        author,
      },
    ];
    const sourceValueRows = [
      {
        id: 5,
        parameter: 'dispositionModel',
        editSummary: null,
        createdAt: new Date('2026-10-04T08:44:00Z'),
        drug: { id: 2, slug: 'clonazepam', names: { en: 'Clonazepam' }, nameShort: null },
        author,
      },
    ];
    const { select } = mockDb(parameterRows, [], sourceValueRows);

    const req = createRequest('/api/recent-changes');
    const { res, state } = createResponse();
    await handler(req, res);

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body) as {
      changes: Array<{ type: string; origin: string; id: number; parameter: string }>;
    };
    expect(
      body.changes.map((c) => `${c.type}:${c.origin}:${c.id}:${c.parameter}`),
    ).toEqual([
      'drug_parameter:source_value:5:dispositionModel',
      'drug_parameter:revision:5:volumeOfDistribution',
    ]);
    const sourceValueChain = select.mock.results[2]!.value as {
      where: ReturnType<typeof vi.fn>;
      limit: ReturnType<typeof vi.fn>;
    };
    expect(sourceValueChain.where).toHaveBeenCalledTimes(1);
    expect(sourceValueChain.limit).toHaveBeenCalledWith(20);
  });

  it('caps the limit query param at the maximum', async () => {
    const { select } = mockDb([], []);
    const req = createRequest('/api/recent-changes?limit=500');
    const { res } = createResponse();
    await handler(req, res);

    const parameterChain = select.mock.results[0]!.value as {
      limit: ReturnType<typeof vi.fn>;
    };
    expect(parameterChain.limit).toHaveBeenCalledWith(50);
  });

  it('only returns wiki revisions from published pages', async () => {
    const { select } = mockDb([], []);
    const req = createRequest('/api/recent-changes');
    const { res } = createResponse();
    await handler(req, res);

    const wikiChain = select.mock.results[1]!.value as {
      where: ReturnType<typeof vi.fn>;
    };
    expect(wikiChain.where).toHaveBeenCalledTimes(1);
  });
});
