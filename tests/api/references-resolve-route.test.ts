import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getUserFromRequestMock,
  consumeRateLimitMock,
  getDbMock,
  fetchPubMedMetadataMock,
  fetchCrossRefMetadataMock,
} = vi.hoisted(() => ({
  getUserFromRequestMock: vi.fn(),
  consumeRateLimitMock: vi.fn(),
  getDbMock: vi.fn(),
  fetchPubMedMetadataMock: vi.fn(),
  fetchCrossRefMetadataMock: vi.fn(),
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

vi.mock('../../api/_lib/rate-limit.js', () => ({
  consumeRateLimit: consumeRateLimitMock,
  getClientAddressKey: vi.fn().mockReturnValue('ip:127.0.0.1'),
}));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));

vi.mock('../../api/_lib/pubmed.js', () => ({
  fetchPubMedMetadata: fetchPubMedMetadataMock,
}));

vi.mock('../../api/_lib/crossref.js', () => ({
  fetchCrossRefMetadata: fetchCrossRefMetadataMock,
}));

import handler from '../../api/references-resolve.ts';
import { createReferenceSchema } from '../../api/_lib/schemas.ts';

function makeReq(body: unknown): IncomingMessage {
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  req.method = 'POST';
  req.url = '/api/references-resolve';
  req.headers = { host: 'localhost', 'content-type': 'application/json' };
  return req;
}

function makeRes() {
  const state = {
    statusCode: 200,
    body: '',
    headers: {} as Record<string, unknown>,
  };
  const res = {
    headersSent: false,
    writeHead: vi.fn((code: number, hdrs?: Record<string, unknown>) => {
      state.statusCode = code;
      if (hdrs) Object.assign(state.headers, hdrs);
      return res;
    }),
    setHeader: vi.fn((name: string, value: unknown) => {
      state.headers[name] = value;
    }),
    end: vi.fn((b?: string) => {
      state.body = b ?? '';
      return res;
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

describe('POST /api/references-resolve – rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 1,
      role: 'contributor',
      groups: [],
    });
    consumeRateLimitMock.mockReturnValue({
      limited: false,
      retryAfterSeconds: 0,
    });
    getDbMock.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) })),
        })),
      })),
    });
  });

  it('returns 429 with Retry-After when IP rate limit is exceeded', async () => {
    consumeRateLimitMock.mockReturnValue({
      limited: true,
      retryAfterSeconds: 42,
    });

    const { res, state } = makeRes();
    await handler(makeReq({ type: 'pmid', identifier: '12345' }), res);

    expect(state.statusCode).toBe(429);
    expect(state.headers['Retry-After']).toBe('42');
  });

  it('proceeds past rate limit when not limited', async () => {
    consumeRateLimitMock.mockReturnValue({
      limited: false,
      retryAfterSeconds: 0,
    });

    // db mock: citations lookup returns no cached row so it would call the
    // external resolver — but we don't need to mock further since we only
    // care that we got past the rate-limit gate (no 429).
    const { res, state } = makeRes();
    await handler(makeReq({ type: 'pmid', identifier: '12345' }), res);

    expect(state.statusCode).not.toBe(429);
  });

  it.each([
    {
      type: 'pmid',
      identifier: '12345',
      providerOnlyField: 'publicationTypes',
      resolver: fetchPubMedMetadataMock,
      metadata: {
        title: 'A PubMed paper',
        // Empty is a valid provider result and must remain an array because
        // ReferenceInput renders `preview.metadata.authors.slice(...)`.
        authors: [],
        journal: 'Journal',
        year: 2025,
        volume: '1',
        pages: '1-2',
        publicationTypes: ['Journal Article'],
      },
    },
    {
      type: 'doi',
      identifier: '10.1000/example',
      providerOnlyField: 'workType',
      resolver: fetchCrossRefMetadataMock,
      metadata: {
        title: 'A Crossref paper',
        authors: ['Author B'],
        journal: 'Journal',
        year: 2025,
        volume: '2',
        pages: '3-4',
        workType: 'journal-article',
      },
    },
  ])(
    'returns $type metadata that the create endpoint accepts',
    async ({ type, identifier, providerOnlyField, resolver, metadata }) => {
      resolver.mockResolvedValue(metadata);

      const { res, state } = makeRes();
      await handler(makeReq({ type, identifier }), res);

      expect(state.statusCode).toBe(200);
      const body = JSON.parse(state.body);
      expect(body.metadata).not.toHaveProperty(providerOnlyField);
      expect(body.metadata).toEqual(
        Object.fromEntries(
          Object.entries(metadata).filter(([key]) => key !== providerOnlyField),
        ),
      );
      expect(
        createReferenceSchema.safeParse({
          type,
          identifier,
          metadata: body.metadata,
        }).success,
      ).toBe(true);
    },
  );
});
