import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, beforeEach, vi } from 'vitest';

const { getDbMock, listBioEntitiesByFunctionMock, searchBioEntitiesMock } =
  vi.hoisted(() => ({
    getDbMock: vi.fn(),
    listBioEntitiesByFunctionMock: vi.fn(),
    searchBioEntitiesMock: vi.fn(),
  }));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
}));

vi.mock('../../api/_lib/bioEntityStore.js', () => ({
  listBioEntitiesByFunction: listBioEntitiesByFunctionMock,
  searchBioEntities: searchBioEntitiesMock,
}));

import handler from '../../api/enzymes.ts';

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

describe('GET /api/enzymes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbMock.mockReturnValue({ marker: 'db' });
    listBioEntitiesByFunctionMock.mockResolvedValue([
      {
        id: 1,
        slug: 'cyp3a4',
        symbol: 'CYP3A4',
        name: 'Cytochrome P450 3A4',
        nameEn: 'Cytochrome P450 3A4',
        organism: 'Homo sapiens',
        rank: 'gene',
        parentId: null,
        entityClass: 'CYP',
        externalIds: {},
        functions: ['metabolic_enzyme'],
      },
    ]);
    searchBioEntitiesMock.mockResolvedValue([]);
  });

  it('lists only metabolic enzymes through the function-filtered catalog helper', async () => {
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'GET',
        url: '/api/enzymes?view=all',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(listBioEntitiesByFunctionMock).toHaveBeenCalledWith(
      { marker: 'db' },
      'metabolic_enzyme',
    );
    expect(searchBioEntitiesMock).not.toHaveBeenCalled();
    expect(JSON.parse(state.body)).toEqual({
      enzymes: [
        {
          id: 1,
          slug: 'cyp3a4',
          symbol: 'CYP3A4',
          name: 'Cytochrome P450 3A4',
          nameEn: 'Cytochrome P450 3A4',
          enzymeClass: 'CYP',
          rank: 'gene',
        },
      ],
    });
  });

  it('keeps typeahead on the bounded search helper', async () => {
    const { res, state } = createMockResponse();

    await handler(
      {
        method: 'GET',
        url: '/api/enzymes?q=cyp&limit=5',
        headers: { host: 'localhost' },
      } as IncomingMessage,
      res,
    );

    expect(state.statusCode).toBe(200);
    expect(searchBioEntitiesMock).toHaveBeenCalledWith(
      { marker: 'db' },
      'cyp',
      {
        function: 'metabolic_enzyme',
        includeFunctionAncestors: true,
        limit: 5,
      },
    );
    expect(listBioEntitiesByFunctionMock).not.toHaveBeenCalled();
  });
});
