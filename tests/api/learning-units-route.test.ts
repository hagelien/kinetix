import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, authMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  authMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
}));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: authMock,
}));

import handler from '../../api/learning-units.ts';

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

function createGetRequest(url: string): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = 'GET';
  req.url = url;
  req.headers = { host: 'localhost' };
  return req;
}

function mockDb(selectResults: unknown[][]) {
  let selectCall = 0;
  const limit = vi.fn(() => {
    const result = selectResults[selectCall] ?? [];
    selectCall += 1;
    return Promise.resolve(result);
  });
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  const db = { select };
  getDbMock.mockReturnValue(db);
  return db;
}

// A published learning unit row (mirrors learningUnits schema columns)
const unitRow = {
  id: 1,
  citationId: 10,
  slug: 'pk-volume-of-distribution',
  title: 'Volume of Distribution',
  content: { sections: [] },
  difficulty: 'foundational',
  domains: ['pharmacokinetics'],
  status: 'published',
  createdBy: 2,
  updatedBy: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

// The matching citation row — type + identifier is the link-out shape (no doi/pmid/url columns).
// `metadata` is the citation's bibliographic jsonb, surfaced for the source card.
const citationRow = {
  id: 10,
  type: 'doi',
  identifier: '10.1000/xyz123',
  metadata: {
    title: 'A study of volume of distribution',
    authors: ['Smith J', 'Doe A'],
    journal: 'J Clin Pharmacol',
    year: 2024,
  },
};

describe('GET /api/learning-units', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({
      userId: 7,
      role: 'authenticated',
      groups: [{ id: 1, slug: 'kinetix-learn', name: 'Kinetix Learn' }],
    });
  });

  it('returns a single published unit with a link-out source block', async () => {
    // First select: learning unit; second select: citation for link-out
    mockDb([[unitRow], [citationRow]]);
    const { res, state } = createResponse();

    await handler(createGetRequest('/api/learning-units?id=1'), res);

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    // Core unit fields
    expect(body.id).toBe(1);
    expect(body.slug).toBe('pk-volume-of-distribution');
    expect(body.title).toBe('Volume of Distribution');
    expect(body.difficulty).toBe('foundational');
    expect(body.domains).toEqual(['pharmacokinetics']);
    expect(body.content).toBeDefined();
    // source block: link-out identifiers + resolved URL + bibliographic
    // metadata for the source card, never PDF/full-text
    expect(body.source).toEqual({
      citationId: 10,
      type: 'doi',
      identifier: '10.1000/xyz123',
      url: 'https://doi.org/10.1000/xyz123',
      metadata: {
        title: 'A study of volume of distribution',
        authors: ['Smith J', 'Doe A'],
        journal: 'J Clin Pharmacol',
        year: 2024,
      },
    });
    expect(body.source.url).toBe('https://doi.org/10.1000/xyz123');
    expect(body.source.metadata.title).toBe(
      'A study of volume of distribution',
    );
    expect(state.headers['Cache-Control']).toBe('no-store');
    // Must NOT expose any PDF/full-text fields
    expect(body.source).not.toHaveProperty('pdf');
    expect(body.source).not.toHaveProperty('fullText');
    expect(body.source).not.toHaveProperty('blobPathname');
    expect(body.source).not.toHaveProperty('blobUrl');
    expect(body).not.toHaveProperty('blobPathname');
    expect(body).not.toHaveProperty('blobUrl');
    // Must NOT expose internal DB columns at the top level
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('citationId');
  });

  it('does not expose unsafe URL citations as source links', async () => {
    mockDb([
      [unitRow],
      [
        {
          ...citationRow,
          type: 'url',
          identifier: 'javascript:alert(1)',
        },
      ],
    ]);
    const { res, state } = createResponse();

    await handler(createGetRequest('/api/learning-units?id=1'), res);

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    expect(body.source).toMatchObject({
      type: 'url',
      identifier: 'javascript:alert(1)',
      url: null,
    });
  });

  it('404s an unknown id', async () => {
    mockDb([
      [
        /* no rows */
      ],
    ]);
    const { res, state } = createResponse();

    await handler(createGetRequest('/api/learning-units?id=9999'), res);

    expect(state.statusCode).toBe(404);
    const body = JSON.parse(state.body);
    expect(body).toHaveProperty('error');
  });

  it('returns 400 for a non-integer id', async () => {
    mockDb([]);
    const { res, state } = createResponse();

    await handler(createGetRequest('/api/learning-units?id=abc'), res);

    expect(state.statusCode).toBe(400);
    const body = JSON.parse(state.body);
    expect(body).toHaveProperty('error');
    expect(body.code).toBe('invalid_id');
  });

  it('lists published units without their content payload', async () => {
    const listRow = {
      id: 1,
      slug: 'pk-volume-of-distribution',
      title: 'Volume of Distribution',
      difficulty: 'foundational',
      domains: ['pharmacokinetics'],
    };
    mockDb([[listRow]]);
    const { res, state } = createResponse();

    await handler(createGetRequest('/api/learning-units'), res);

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    expect(body.units).toHaveLength(1);
    // List items must NOT include content
    expect(body.units[0]).not.toHaveProperty('content');
    // List items must have expected fields
    expect(body.units[0]).toMatchObject({
      id: 1,
      slug: 'pk-volume-of-distribution',
      title: 'Volume of Distribution',
      difficulty: 'foundational',
      domains: ['pharmacokinetics'],
    });
    expect(state.headers['Cache-Control']).toBe('no-store');
  });

  it('lists published units filtered by citationId without content payload', async () => {
    const listRow = {
      id: 1,
      slug: 'pk-volume-of-distribution',
      title: 'Volume of Distribution',
      difficulty: 'foundational',
      domains: ['pharmacokinetics'],
    };
    mockDb([[listRow]]);
    const { res, state } = createResponse();

    await handler(createGetRequest('/api/learning-units?citationId=10'), res);

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    expect(body.units).toHaveLength(1);
    expect(body.units[0]).not.toHaveProperty('content');
  });

  it('the single-unit payload includes kind', async () => {
    mockDb([[{ ...unitRow, kind: 'clinical_case' }], [citationRow]]);
    const { res, state } = createResponse();

    await handler(createGetRequest('/api/learning-units?id=1'), res);

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    expect(body.kind).toBe('clinical_case');
  });

  it('lists clinical cases when ?kind=clinical_case', async () => {
    const caseRow = {
      id: 5,
      slug: 'klinisk-case',
      title: 'Klinisk case',
      difficulty: 'advanced_lis',
      domains: ['pharmacokinetics'],
      kind: 'clinical_case',
    };
    mockDb([[caseRow]]);
    const { res, state } = createResponse();

    await handler(
      createGetRequest('/api/learning-units?kind=clinical_case'),
      res,
    );

    expect(state.statusCode).toBe(200);
    const body = JSON.parse(state.body);
    expect(body.units).toHaveLength(1);
    expect(body.units[0]).toMatchObject({ id: 5, kind: 'clinical_case' });
    expect(body.units[0]).not.toHaveProperty('content');
  });

  it('rejects an unknown kind value with 400 invalid_kind', async () => {
    mockDb([]);
    const { res, state } = createResponse();

    await handler(createGetRequest('/api/learning-units?kind=bogus'), res);

    expect(state.statusCode).toBe(400);
    const body = JSON.parse(state.body);
    expect(body.code).toBe('invalid_kind');
  });

  it('returns 405 for non-GET methods', async () => {
    const { res, state } = createResponse();
    const req = Readable.from([]) as IncomingMessage;
    req.method = 'POST';
    req.url = '/api/learning-units';
    req.headers = { host: 'localhost' };

    await handler(req, res);

    expect(state.statusCode).toBe(405);
    const body = JSON.parse(state.body);
    expect(body).toHaveProperty('error');
  });

  it('returns 401 before DB access when not authenticated', async () => {
    authMock.mockResolvedValue(null);
    const { res, state } = createResponse();

    await handler(createGetRequest('/api/learning-units'), res);

    expect(state.statusCode).toBe(401);
    expect(JSON.parse(state.body).code).toBe('not_authenticated');
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it('returns 403 before DB access for signed-in users outside the Learn group', async () => {
    authMock.mockResolvedValue({
      userId: 8,
      role: 'authenticated',
      groups: [],
    });
    const { res, state } = createResponse();

    await handler(createGetRequest('/api/learning-units'), res);

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body).code).toBe('kinetix_learn_access_required');
    expect(getDbMock).not.toHaveBeenCalled();
  });
});
