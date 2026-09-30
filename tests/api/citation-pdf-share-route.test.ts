import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  getUserFromRequestMock,
  presignStoredPdfUrlMock,
  readStoredPdfBytesMock,
  callerCanMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
  presignStoredPdfUrlMock: vi.fn(),
  readStoredPdfBytesMock: vi.fn(),
  callerCanMock: vi.fn(),
}));

vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));
vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/permissions-store.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/_lib/permissions-store.js')>();
  return { ...actual, callerCan: callerCanMock };
});
vi.mock('../../api/_lib/pdf-storage.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/_lib/pdf-storage.js')>();
  return {
    ...actual,
    presignStoredPdfUrl: presignStoredPdfUrlMock,
    readStoredPdfBytes: readStoredPdfBytesMock,
  };
});

import handler from '../../api/citation-pdf-share.ts';
import { mintPdfShareToken } from '../../api/_lib/pdf-share-token.js';
import { clearRateLimitState } from '../../api/_lib/rate-limit.js';
import { can } from '../../src/lib/permissions.js';

/**
 * Default the capability check to the shipped matrix with no overrides —
 * exactly what the real `callerCan` resolves to when no override store is
 * wired up, so the tier assertions below stay faithful. Individual tests
 * override it to express a configuration an admin could actually save.
 */
function useDefaultMatrix(): void {
  callerCanMock.mockImplementation((role: string | null | undefined, cap: string) =>
    Promise.resolve(can(role, cap)),
  );
}

const SHA =
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER_SHA =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

function createResponse() {
  const state = {
    statusCode: 200,
    body: '',
    headers: {} as Record<string, unknown>,
  };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number, headers?: Record<string, unknown>) => {
      state.statusCode = statusCode;
      state.headers = headers ?? {};
      return res;
    }),
    end: vi.fn((body?: string | Buffer) => {
      state.body = body?.toString() ?? '';
      return res;
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

function mintRequest(citationId = 12): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = 'POST';
  req.url = `/api/citation-pdf-share?citationId=${citationId}`;
  req.headers = { host: 'kinetix.no' };
  req.socket = { remoteAddress: '127.0.0.1' } as IncomingMessage['socket'];
  return req;
}

function redeemRequest(token: string): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = 'GET';
  req.url = `/api/citation-pdf-share?token=${encodeURIComponent(token)}`;
  req.headers = { host: 'kinetix.no' };
  req.socket = { remoteAddress: '127.0.0.1' } as IncomingMessage['socket'];
  return req;
}

const PRESIGNED =
  'https://store.public.blob.vercel-storage.com/citation-pdfs/12-abc.pdf' +
  '?vercel-blob-valid-until=1&download=1';

const PDF_BYTES = Buffer.from('%PDF-1.7 stored full text');

/** A stored row for a paper small enough to be served from kinetix.no. */
function smallStoredRow(overrides: Record<string, unknown> = {}) {
  return {
    blobPathname: 'citation-pdfs/12-abc.pdf',
    blobUrl: 'https://store.private.blob.vercel-storage.com/citation-pdfs/12-abc.pdf',
    sizeBytes: PDF_BYTES.byteLength,
    contentType: 'application/pdf',
    sha256: SHA,
    ...overrides,
  };
}

/** A stored row for a paper too large for a function response body. */
function largeStoredRow(overrides: Record<string, unknown> = {}) {
  return smallStoredRow({ sizeBytes: 12 * 1024 * 1024, ...overrides });
}

/** One-row `select().from().where().limit()` chain, or no row at all. */
function mockStoredPdfRow(row: Record<string, unknown> | null) {
  const limit = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  getDbMock.mockReturnValue({ select: vi.fn().mockReturnValue({ from }) });
}

describe('POST /api/citation-pdf-share (minting)', () => {
  const previousSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    clearRateLimitState();
    useDefaultMatrix();
    process.env.JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  it('requires a session', async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const { res, state } = createResponse();

    await handler(mintRequest(), res);

    expect(state.statusCode).toBe(401);
  });

  it('refuses a contributor — sharing defaults to admin', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 5, role: 'contributor' });
    const { res, state } = createResponse();

    await handler(mintRequest(), res);

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body).code).toBe('pdf_share_forbidden');
    // Denied before any lookup of the asset itself.
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it('refuses an editor — the capability sits above the read tier', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 5, role: 'editor' });
    const { res, state } = createResponse();

    await handler(mintRequest(), res);

    expect(state.statusCode).toBe(403);
  });

  it('404s when the citation has no stored PDF', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    mockStoredPdfRow(null);
    const { res, state } = createResponse();

    await handler(mintRequest(), res);

    expect(state.statusCode).toBe(404);
    expect(JSON.parse(state.body).code).toBe('pdf_share_no_pdf');
  });

  it('mints a relative, uncacheable link with an expiry for an admin', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    mockStoredPdfRow({ sha256: SHA });
    const { res, state } = createResponse();

    await handler(mintRequest(), res);

    expect(state.statusCode).toBe(201);
    expect(state.headers['Cache-Control']).toBe('no-store');
    const body = JSON.parse(state.body) as {
      path: string;
      expiresAt: string;
      expiresInSeconds: number;
    };
    expect(body.path.startsWith('/api/citation-pdf-share?token=')).toBe(true);
    expect(body.expiresInSeconds).toBe(600);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    // The raw Blob URL never leaves the server.
    expect(state.body).not.toContain('blob');
  });

  it('refuses a share grant that outruns the configured read tier', async () => {
    // A configuration an admin can genuinely save: `citation.pdf.access`
    // raised to admin, `citation.pdf.share` delegated down to contributor.
    // Both moves are inside their allowed ranges, and checking only the share
    // grant would let this contributor mint a link and read the very bytes
    // the read tier denies them.
    getUserFromRequestMock.mockResolvedValue({ userId: 5, role: 'contributor' });
    callerCanMock.mockImplementation((_role: unknown, cap: string) =>
      Promise.resolve(cap === 'citation.pdf.share'),
    );
    const { res, state } = createResponse();

    await handler(mintRequest(), res);

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body).code).toBe('pdf_share_forbidden');
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it('mints for a delegated tier that holds both capabilities', async () => {
    // The same delegation, but with read access left where it defaults. The
    // conjunction must not block a configuration that is actually coherent.
    getUserFromRequestMock.mockResolvedValue({ userId: 5, role: 'contributor' });
    callerCanMock.mockImplementation((_role: unknown, cap: string) =>
      Promise.resolve(
        cap === 'citation.pdf.share' || cap === 'citation.pdf.access',
      ),
    );
    mockStoredPdfRow({ sha256: SHA });
    const { res, state } = createResponse();

    await handler(mintRequest(), res);

    expect(state.statusCode).toBe(201);
  });

  it('rejects a cross-origin mint before touching auth', async () => {
    const req = mintRequest();
    req.headers.origin = 'https://evil.example';
    const { res, state } = createResponse();

    await handler(req, res);

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body).code).toBe('cross_origin_request_rejected');
    expect(getUserFromRequestMock).not.toHaveBeenCalled();
  });

  it('throttles a caller who mints links in bulk', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    mockStoredPdfRow({ sha256: SHA });

    for (let i = 0; i < 30; i += 1) {
      const { res } = createResponse();
      await handler(mintRequest(), res);
    }
    const { res, state } = createResponse();
    await handler(mintRequest(), res);

    expect(state.statusCode).toBe(429);
    expect(JSON.parse(state.body).code).toBe('pdf_share_rate_limited');
  });
});

describe('GET /api/citation-pdf-share (redemption)', () => {
  const previousSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    vi.clearAllMocks();
    clearRateLimitState();
    useDefaultMatrix();
    process.env.JWT_SECRET = 'test-secret';
    // No session at all: the whole point is that the token is the credential.
    getUserFromRequestMock.mockResolvedValue(null);
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  it('serves the PDF from kinetix.no for a paper that fits a function response', async () => {
    mockStoredPdfRow(smallStoredRow());
    readStoredPdfBytesMock.mockResolvedValue(PDF_BYTES);
    const { token } = mintPdfShareToken({
      citationId: 12,
      sha256: SHA,
      issuedBy: 1,
    });
    const { res, state } = createResponse();

    await handler(redeemRequest(token), res);

    // Same-origin bytes, not a hop to the Blob host: a redirect off kinetix.no
    // is refused by the link readers this feature exists to serve.
    expect(state.statusCode).toBe(200);
    expect(state.headers['Content-Type']).toBe('application/pdf');
    expect(state.headers['Content-Length']).toBe(String(PDF_BYTES.byteLength));
    expect(state.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(state.headers['Cache-Control']).toBe('private, no-store');
    expect(state.headers['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(state.body).toBe(PDF_BYTES.toString());
    expect(presignStoredPdfUrlMock).not.toHaveBeenCalled();
    // The session lookup is never even attempted on this path.
    expect(getUserFromRequestMock).not.toHaveBeenCalled();
  });

  it('serves the proxied PDF as an attachment, never inline', async () => {
    mockStoredPdfRow(smallStoredRow());
    readStoredPdfBytesMock.mockResolvedValue(PDF_BYTES);
    const { token } = mintPdfShareToken({
      citationId: 12,
      sha256: SHA,
      issuedBy: 1,
    });
    const { res, state } = createResponse();

    await handler(redeemRequest(token), res);

    // Keeps the agent read's defence: a hostile PDF's JavaScript must not run
    // in the recipient's browser viewer.
    expect(String(state.headers['Content-Disposition'])).toMatch(
      /^attachment;/,
    );
  });

  it('answers a HEAD probe from the stored row without downloading the object', async () => {
    mockStoredPdfRow(smallStoredRow());
    const { token } = mintPdfShareToken({
      citationId: 12,
      sha256: SHA,
      issuedBy: 1,
    });
    const req = redeemRequest(token);
    req.method = 'HEAD';
    const { res, state } = createResponse();

    await handler(req, res);

    // A probe must not cost a full Blob download — Node discards the body on a
    // HEAD response, so reading the object would be paid for twice and buy
    // nothing. `size_bytes` describes exactly the bytes the GET would send.
    expect(readStoredPdfBytesMock).not.toHaveBeenCalled();
    expect(state.statusCode).toBe(200);
    expect(state.headers['Content-Type']).toBe('application/pdf');
    expect(state.headers['Content-Length']).toBe(String(PDF_BYTES.byteLength));
    expect(state.headers['Content-Disposition']).toBe(
      'attachment; filename="citation-12.pdf"',
    );
  });

  it('redirects to a presigned URL for a paper too large to proxy', async () => {
    mockStoredPdfRow(largeStoredRow());
    presignStoredPdfUrlMock.mockResolvedValue(PRESIGNED);
    const { token } = mintPdfShareToken({
      citationId: 12,
      sha256: SHA,
      issuedBy: 1,
    });
    const { res, state } = createResponse();

    await handler(redeemRequest(token), res);

    // A function response is capped at 4.5 MB while stored PDFs run to 50 MB,
    // so an oversized paper must not be pulled through the function at all.
    expect(readStoredPdfBytesMock).not.toHaveBeenCalled();
    expect(state.statusCode).toBe(302);
    expect(state.headers.Location).toBe(PRESIGNED);
    expect(state.body).toBe('');
    expect(presignStoredPdfUrlMock).toHaveBeenCalledWith(
      'citation-pdfs/12-abc.pdf',
    );
    expect(state.headers['Cache-Control']).toBe('private, no-store');
    expect(state.headers['X-Robots-Tag']).toBe('noindex, nofollow');
  });

  it('never redirects to the durable Blob URL the database stores', async () => {
    mockStoredPdfRow(largeStoredRow());
    presignStoredPdfUrlMock.mockResolvedValue(PRESIGNED);
    const { token } = mintPdfShareToken({
      citationId: 12,
      sha256: SHA,
      issuedBy: 1,
    });
    const { res, state } = createResponse();

    await handler(redeemRequest(token), res);

    // The row's `blob_url` is read server-side to proxy small papers, but it is
    // never sent: the redirect target is the scoped, expiring URL and nothing
    // else.
    const location = String(state.headers.Location);
    expect(location).toBe(PRESIGNED);
    expect(location).toContain('download=1');
    expect(location).not.toContain('private.blob.vercel-storage.com');
  });

  it('falls back to the redirect when the proxied read fails', async () => {
    mockStoredPdfRow(smallStoredRow());
    readStoredPdfBytesMock.mockRejectedValue(new Error('blob store down'));
    presignStoredPdfUrlMock.mockResolvedValue(PRESIGNED);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { token } = mintPdfShareToken({
      citationId: 12,
      sha256: SHA,
      issuedBy: 1,
    });
    const { res, state } = createResponse();

    await handler(redeemRequest(token), res);

    // The redirect reaches the same object by another route, so a link that
    // can still be honoured is honoured.
    expect(state.statusCode).toBe(302);
    expect(state.headers.Location).toBe(PRESIGNED);
  });

  it('410s once the token has expired', async () => {
    const { token } = mintPdfShareToken({
      citationId: 12,
      sha256: SHA,
      issuedBy: 1,
      now: Date.now() - 11 * 60 * 1000,
    });
    const { res, state } = createResponse();

    await handler(redeemRequest(token), res);

    expect(state.statusCode).toBe(410);
    expect(JSON.parse(state.body).code).toBe('pdf_share_expired');
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it('410s once the stored bytes have been replaced', async () => {
    mockStoredPdfRow(
      smallStoredRow({
        blobPathname: 'citation-pdfs/12-new.pdf',
        sha256: OTHER_SHA,
      }),
    );
    const { token } = mintPdfShareToken({
      citationId: 12,
      sha256: SHA,
      issuedBy: 1,
    });
    const { res, state } = createResponse();

    await handler(redeemRequest(token), res);

    expect(state.statusCode).toBe(410);
    expect(JSON.parse(state.body).code).toBe('pdf_share_stale');
    expect(presignStoredPdfUrlMock).not.toHaveBeenCalled();
  });

  it('410s when the stored PDF row is gone entirely', async () => {
    mockStoredPdfRow(null);
    const { token } = mintPdfShareToken({
      citationId: 12,
      sha256: SHA,
      issuedBy: 1,
    });
    const { res, state } = createResponse();

    await handler(redeemRequest(token), res);

    expect(state.statusCode).toBe(410);
    expect(JSON.parse(state.body).code).toBe('pdf_share_stale');
  });

  it('refuses a tampered token without reading the database', async () => {
    const { token } = mintPdfShareToken({
      citationId: 12,
      sha256: SHA,
      issuedBy: 1,
    });
    const [version, encoded] = token.split('.') as [string, string];
    const { res, state } = createResponse();

    await handler(redeemRequest(`${version}.${encoded}.forged`), res);

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body).code).toBe('pdf_share_invalid');
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it('400s when no token is supplied', async () => {
    const req = Readable.from([]) as IncomingMessage;
    req.method = 'GET';
    req.url = '/api/citation-pdf-share';
    req.headers = { host: 'kinetix.no' };
    req.socket = { remoteAddress: '127.0.0.1' } as IncomingMessage['socket'];
    const { res, state } = createResponse();

    await handler(req, res);

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body).code).toBe('pdf_share_token_missing');
  });

  it('502s when a large object cannot be presigned', async () => {
    mockStoredPdfRow(largeStoredRow());
    presignStoredPdfUrlMock.mockRejectedValue(new Error('blob store down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { token } = mintPdfShareToken({
      citationId: 12,
      sha256: SHA,
      issuedBy: 1,
    });
    const { res, state } = createResponse();

    await handler(redeemRequest(token), res);

    expect(state.statusCode).toBe(502);
  });
});
