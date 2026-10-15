import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, listLigandsMock, searchMock, getUserFromRequestMock } =
  vi.hoisted(() => ({
    getDbMock: vi.fn(() => ({})),
    listLigandsMock: vi.fn(),
    searchMock: vi.fn(),
    getUserFromRequestMock: vi.fn(),
  }));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
  runInPoolTransaction: vi.fn(),
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

vi.mock('../../api/_lib/receptorTargetStore.js', () => ({
  listEntityTargetLigands: listLigandsMock,
}));

vi.mock('../../api/_lib/bioEntityStore.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../api/_lib/bioEntityStore.js')
  >('../../api/_lib/bioEntityStore.js');
  return { ...actual, searchBioEntities: searchMock };
});

import handler from '../../api/bio-entities.ts';

function createRequest(url: string): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = 'GET';
  req.url = url;
  req.headers = { host: 'localhost' };
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

describe('GET /api/bio-entities?targetLigands=', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchMock.mockResolvedValue([]);
  });

  it('serves the reverse lookup publicly, without a session', async () => {
    const ligands = [
      {
        relationshipId: 4,
        drugId: 9,
        drugSlug: 'morfin',
        drugNames: { nb: 'Morfin' },
        drugMonographSlug: 'morfin',
        interactionType: 'agonist',
        tier: 'primary',
        affinity: null,
        potency: null,
        efficacy: null,
        ki: { min: 1, max: 3, unit: 'nM' },
        ic50: null,
        ec50: null,
        emax: null,
        selectivityRatio: null,
        assaySpecies: null,
        referenceIds: [12],
        evidenceNote: null,
      },
    ];
    listLigandsMock.mockResolvedValue(ligands);
    const { res, state } = createResponse();

    await handler(createRequest('/api/bio-entities?targetLigands=42'), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ ligands });
    expect(listLigandsMock).toHaveBeenCalledWith(expect.anything(), 42);
    expect(getUserFromRequestMock).not.toHaveBeenCalled();
  });

  it('returns an empty array for an entity with no target relationships', async () => {
    listLigandsMock.mockResolvedValue([]);
    const { res, state } = createResponse();

    await handler(createRequest('/api/bio-entities?targetLigands=5'), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({ ligands: [] });
  });

  it.each(['0', '-3', '1.5', 'abc', ''])(
    'does not run the reverse lookup for targetLigands=%j',
    async (value) => {
      const { res, state } = createResponse();

      await handler(
        createRequest(`/api/bio-entities?targetLigands=${value}`),
        res,
      );

      expect(listLigandsMock).not.toHaveBeenCalled();
      // Falls through to the ordinary typeahead response.
      expect(state.statusCode).toBe(200);
      expect(JSON.parse(state.body)).toEqual({ entities: [] });
    },
  );
});
