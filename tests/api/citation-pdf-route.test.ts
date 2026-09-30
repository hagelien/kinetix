import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  getNeonClientMock,
  getUserFromRequestMock,
  delMock,
  getMock,
  lookupMock,
  putMock,
  isActiveAgentUserMock,
  presignStoredPdfUrlMock,
  recordCitationPdfMock,
  requestMock,
} = vi.hoisted(() => ({
  isActiveAgentUserMock: vi.fn(),
  getDbMock: vi.fn(),
  getNeonClientMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
  delMock: vi.fn(),
  getMock: vi.fn(),
  lookupMock: vi.fn(),
  putMock: vi.fn(),
  presignStoredPdfUrlMock: vi.fn(),
  recordCitationPdfMock: vi.fn(),
  requestMock: vi.fn(),
}));

vi.mock('node:http', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:http')>()),
  request: requestMock,
}));
vi.mock('node:https', () => ({
  default: { request: requestMock },
  request: requestMock,
}));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));
vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
  getNeonClient: getNeonClientMock,
}));
vi.mock('../../api/_lib/agent-verifications.js', () => ({
  isActiveAgentUser: isActiveAgentUserMock,
}));
vi.mock('node:dns/promises', () => ({
  default: { lookup: lookupMock },
  lookup: lookupMock,
}));
vi.mock('@vercel/blob', () => ({ del: delMock, get: getMock, put: putMock }));
vi.mock('../../api/_lib/pdf-storage.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/_lib/pdf-storage.js')>();
  return {
    ...actual,
    presignStoredPdfUrl: presignStoredPdfUrlMock,
    recordCitationPdf: recordCitationPdfMock,
  };
});

import handler from '../../api/citation-pdf.ts';
import { PdfRequestNotOpenError } from '../../api/_lib/pdf-storage.js';

const openRequestCreatedAt = '2026-06-03 02:00:00.123456';

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
    end: vi.fn((body?: string | Buffer) => {
      state.body = body?.toString() ?? '';
      return res;
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

function createPostRequest(body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'POST';
  req.url = '/api/citation-pdf?citationId=12';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(raw),
  };
  return req;
}

function createGetRequest(citationId = 12): IncomingMessage {
  const req = Readable.from([]) as IncomingMessage;
  req.method = 'GET';
  req.url = `/api/citation-pdf?citationId=${citationId}`;
  req.headers = { host: 'localhost' };
  return req;
}

function mockStoredPdf(
  pdfBytes = Buffer.from('%PDF-1.7 test'),
  sizeBytes = pdfBytes.byteLength,
) {
  const limit = vi
    .fn()
    .mockResolvedValue([
      {
        blobPathname: 'citation-pdfs/12-abc.pdf',
        blobUrl: 'https://blob.example/citation-pdfs/12.pdf',
        sizeBytes,
        contentType: 'application/pdf',
      },
    ]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  getDbMock.mockReturnValue({ select });

  getMock.mockResolvedValue({
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(pdfBytes);
        controller.close();
      },
    }),
    blob: { size: pdfBytes.byteLength },
  });
}

function mockNoPdfStored() {
  const limit = vi.fn().mockResolvedValue([]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  getDbMock.mockReturnValue({ select });
}

function mockCitationExists() {
  const limit = vi
    .fn()
    .mockResolvedValue([
      { id: 12, type: 'doi', createdAt: openRequestCreatedAt },
    ]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  getDbMock.mockReturnValue({ select });
}

function mockCitationType(type: string) {
  const limit = vi.fn().mockResolvedValue([{ id: 12, type }]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  getDbMock.mockReturnValue({ select });
}

function mockSelectSequence(results: unknown[][]) {
  let index = 0;
  const limit = vi.fn(() => {
    const result = results[index] ?? [];
    index += 1;
    return Promise.resolve(result);
  });
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  getDbMock.mockReturnValue({ select });
}

function mockPinnedResponse({
  status = 200,
  headers = {},
  body = ['%PDF-1.7 body'],
  assertPinnedAddress,
}: {
  status?: number;
  headers?: Record<string, string>;
  body?: Array<string | Uint8Array>;
  assertPinnedAddress?: string;
} = {}) {
  requestMock.mockImplementationOnce((_url, options, callback) => {
    if (assertPinnedAddress) {
      options.lookup('example.org', {}, (_err: unknown, address: string) => {
        expect(address).toBe(assertPinnedAddress);
      });
    }
    const req = new EventEmitter() as EventEmitter & {
      destroy: (err?: Error) => void;
      end: () => void;
      setTimeout: (ms: number, cb: () => void) => void;
    };
    req.setTimeout = vi.fn();
    req.destroy = vi.fn((err?: Error) => {
      if (err) req.emit('error', err);
    });
    req.end = vi.fn(() => {
      const response = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
        resume: () => void;
        destroy: (err?: Error) => void;
      };
      response.statusCode = status;
      response.headers = headers;
      response.resume = vi.fn();
      response.destroy = vi.fn((err?: Error) => {
        if (err) response.emit('error', err);
      });
      callback(response);
      queueMicrotask(() => {
        for (const chunk of body) response.emit('data', chunk);
        response.emit('end');
      });
    });
    return req;
  });
}

function mockPinnedTimeout() {
  requestMock.mockImplementationOnce((_url, _options, _callback) => {
    const req = new EventEmitter() as EventEmitter & {
      destroy: (err?: Error) => void;
      end: () => void;
      setTimeout: (ms: number, cb: () => void) => void;
    };
    let timeout: (() => void) | null = null;
    req.setTimeout = vi.fn((_ms: number, cb: () => void) => {
      timeout = cb;
    });
    req.destroy = vi.fn((err?: Error) => {
      if (err) req.emit('error', err);
    });
    req.end = vi.fn(() => {
      timeout?.();
    });
    return req;
  });
}

describe('POST /api/citation-pdf (URL fulfilment)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'contributor',
    });
    delMock.mockResolvedValue(undefined);
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockCitationExists();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a URL that does not point to a PDF', async () => {
    mockPinnedResponse({
      headers: { 'content-type': 'text/html' },
      body: ['<html></html>'],
    });
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/not-a-pdf' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({ code: 'pdf_not_a_pdf' });
    expect(putMock).not.toHaveBeenCalled();
    expect(recordCitationPdfMock).not.toHaveBeenCalled();
  });

  it('requires PDF magic bytes even when content-type claims PDF', async () => {
    mockPinnedResponse({
      headers: { 'content-type': 'application/pdf' },
      body: ['not a pdf'],
    });
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/fake.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({ code: 'pdf_not_a_pdf' });
    expect(putMock).not.toHaveBeenCalled();
  });

  it('blocks private-address redirect destinations', async () => {
    mockPinnedResponse({
      status: 302,
      headers: { location: 'http://127.0.0.1/private.pdf' },
      body: [],
    });
    const { res, state } = createResponse();

    await handler(createPostRequest({ url: 'https://example.org/start' }), res);

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_fetch_forbidden_host',
    });
    expect(requestMock).toHaveBeenCalledOnce();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('maps fetch timeouts to a controlled error code', async () => {
    mockPinnedTimeout();
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/slow.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(408);
    expect(JSON.parse(state.body)).toMatchObject({ code: 'pdf_fetch_timeout' });
    expect(putMock).not.toHaveBeenCalled();
  });

  it('rejects IPv4-mapped IPv6 private addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }]);
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/mapped.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_fetch_forbidden_host',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects hex-encoded IPv4-mapped IPv6 private addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '::ffff:7f00:1', family: 6 }]);
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/mapped-hex.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_fetch_forbidden_host',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects IPv4-compatible IPv6 private addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '::127.0.0.1', family: 6 }]);
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/compatible.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_fetch_forbidden_host',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects hex-encoded IPv4-compatible IPv6 private addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '::7f00:1', family: 6 }]);
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/compatible-hex.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_fetch_forbidden_host',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects Teredo IPv6 addresses', async () => {
    lookupMock.mockResolvedValue([
      { address: '2001:0000:4136:e378::', family: 6 },
    ]);
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/teredo.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_fetch_forbidden_host',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects 6to4 addresses that encode a private IPv4 (10.x)', async () => {
    // 2002:0a00:0001:: = 6to4 encoding of 10.0.0.1
    lookupMock.mockResolvedValue([{ address: '2002:0a00:0001::', family: 6 }]);
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/6to4-private.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_fetch_forbidden_host',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects compressed 6to4 addresses that encode a private IPv4', async () => {
    // 2002:0a00:: = 6to4 encoding of 10.0.0.0
    lookupMock.mockResolvedValue([{ address: '2002:0a00::', family: 6 }]);
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/6to4-compressed.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_fetch_forbidden_host',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects 6to4 addresses with dotted IPv4 tails', async () => {
    // 2002:0a00::192.0.2.1 still encodes 10.0.0.0 in the 6to4 prefix.
    lookupMock.mockResolvedValue([
      { address: '2002:0a00::192.0.2.1', family: 6 },
    ]);
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/6to4-dotted-tail.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_fetch_forbidden_host',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects NAT64 well-known prefix addresses (64:ff9b::/96)', async () => {
    // 64:ff9b::10.0.0.1 is the NAT64 encoding of the private IPv4 address
    // 10.0.0.1. Without the 64:ff9b: check, a NAT64 gateway on the network
    // would forward the request to the internal host.
    lookupMock.mockResolvedValue([{ address: '64:ff9b::a00:1', family: 6 }]);
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/nat64.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_fetch_forbidden_host',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects 6to4 addresses that encode a private IPv4 (192.168.x)', async () => {
    // 2002:c0a8:0101:: = 6to4 encoding of 192.168.1.1
    lookupMock.mockResolvedValue([{ address: '2002:c0a8:0101::', family: 6 }]);
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/6to4-private2.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_fetch_forbidden_host',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects NAT64 dotted-decimal form (64:ff9b::192.168.1.1)', async () => {
    lookupMock.mockResolvedValue([
      { address: '64:ff9b::192.168.1.1', family: 6 },
    ]);
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/nat64-rfc1918.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_fetch_forbidden_host',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects the IPv6 unspecified address in canonical form (::)', async () => {
    // :: is 0:0:0:0:0:0:0:0 — the IPv6 unspecified address, equivalent to
    // 0.0.0.0. A URL like http://[::]/path should be blocked the same as
    // http://0.0.0.0/path is on IPv4.
    lookupMock.mockResolvedValue([{ address: '::', family: 6 }]);
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/unspecified.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_fetch_forbidden_host',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects non-canonical all-zeros IPv6 address (::0)', async () => {
    // ::0 is a non-canonical spelling of the unspecified address ::.
    // The isPrivateIPv6 string check only matched '::' exactly; this test
    // guards the expandIPv6Hextets-based all-zeros check that was added to
    // catch these alternative representations.
    lookupMock.mockResolvedValue([{ address: '::0', family: 6 }]);
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/unspecified-alt.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_fetch_forbidden_host',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('does not block public neighbors of reserved documentation ranges', async () => {
    lookupMock.mockResolvedValue([{ address: '203.0.114.10', family: 4 }]);
    mockPinnedResponse({
      headers: { 'content-type': 'application/pdf' },
      body: ['%PDF-1.7 body'],
    });
    putMock.mockResolvedValue({
      pathname: 'citation-pdfs/12.pdf',
      url: 'https://blob.example/citation-pdfs/12.pdf',
    });
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/public-neighbor.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(201);
    expect(putMock).toHaveBeenCalledOnce();
  });

  it('still blocks reserved IPv4 documentation ranges', async () => {
    lookupMock.mockResolvedValue([{ address: '203.0.113.10', family: 4 }]);
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/reserved.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_fetch_forbidden_host',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects freetext citations for URL fulfillment', async () => {
    mockCitationType('freetext');
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/paper.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_request_unresolvable_citation',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects URL fulfillment when no PDF request is open', async () => {
    mockSelectSequence([[{ id: 12, type: 'doi' }], []]);
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/paper.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_request_not_open',
    });
    expect(requestMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('refuses contributor URL fulfilment of a replacement request', async () => {
    // The URL route is the second door to the same act. Gating only the
    // client-upload path would leave this one open, and a paste-a-URL
    // overwrite is no less destructive than an upload.
    mockSelectSequence([
      [{ id: 12, type: 'doi' }],
      [{ id: 7, createdAt: '2026-06-03 02:00:00.123456', isReplacement: true }],
    ]);
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/paper.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_replace_requires_editor',
    });
    expect(requestMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
  });

  it('refuses URL fulfilment of a replacement while a job is open', async () => {
    // The URL route is the second door to the same swap, so it carries the
    // same in-flight guard as the client-upload path.
    getUserFromRequestMock.mockResolvedValue({ userId: 42, role: 'editor' });
    mockSelectSequence([
      [{ id: 12, type: 'doi' }],
      [
        {
          id: 7,
          createdAt: '2026-06-03 02:00:00.123456',
          isReplacement: true,
        },
      ],
      [{ id: 3 }], // an open paper_extraction_jobs row
    ]);
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/paper.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_replace_extraction_in_flight',
    });
    expect(putMock).not.toHaveBeenCalled();
  });

  it('rejects oversized responses before buffering the body', async () => {
    mockPinnedResponse({
      headers: { 'content-length': String(50 * 1024 * 1024 + 1) },
      body: [],
    });
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/huge.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(413);
    expect(JSON.parse(state.body)).toMatchObject({ code: 'pdf_too_large' });
    expect(putMock).not.toHaveBeenCalled();
  });

  it('rejects non-contributors', async () => {
    getUserFromRequestMock.mockResolvedValue({
      userId: 1,
      role: 'authenticated',
    });
    const { res, state } = createResponse();

    await handler(createPostRequest({ url: 'https://example.org/x.pdf' }), res);

    expect(state.statusCode).toBe(403);
    expect(putMock).not.toHaveBeenCalled();
  });

  it('persists a fetched PDF and records the asset', async () => {
    const pdfBytes = new TextEncoder().encode('%PDF-1.7 body');
    mockPinnedResponse({
      headers: { 'content-type': 'application/pdf' },
      body: [pdfBytes],
      assertPinnedAddress: '93.184.216.34',
    });
    putMock.mockResolvedValue({
      pathname: 'citation-pdfs/12.pdf',
      url: 'https://blob.example/citation-pdfs/12.pdf',
    });
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/paper.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(201);
    expect(putMock).toHaveBeenCalledOnce();
    expect(recordCitationPdfMock).toHaveBeenCalledWith(
      expect.objectContaining({
        citationId: 12,
        pdfRequestId: 12,
        pdfRequestCreatedAt: openRequestCreatedAt,
        source: 'url',
        sourceUrl: 'https://example.org/paper.pdf',
        uploadedBy: 42,
      }),
    );
  });

  it('deletes the blob if database persistence fails after URL upload', async () => {
    mockPinnedResponse({
      headers: { 'content-type': 'application/pdf' },
      body: ['%PDF-1.7 body'],
    });
    putMock.mockResolvedValue({
      pathname: 'citation-pdfs/12.pdf',
      url: 'https://blob.example/citation-pdfs/12.pdf',
    });
    recordCitationPdfMock.mockRejectedValue(new Error('db unavailable'));
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/paper.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(500);
    expect(delMock).toHaveBeenCalledWith(
      'https://blob.example/citation-pdfs/12.pdf',
    );
  });

  it('deletes the blob and returns 409 if the request closes during URL upload', async () => {
    mockPinnedResponse({
      headers: { 'content-type': 'application/pdf' },
      body: ['%PDF-1.7 body'],
    });
    putMock.mockResolvedValue({
      pathname: 'citation-pdfs/12.pdf',
      url: 'https://blob.example/citation-pdfs/12.pdf',
    });
    recordCitationPdfMock.mockRejectedValue(new PdfRequestNotOpenError(12));
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ url: 'https://example.org/paper.pdf' }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_request_not_open',
    });
    expect(delMock).toHaveBeenCalledWith(
      'https://blob.example/citation-pdfs/12.pdf',
    );
  });
});

describe('GET /api/citation-pdf (agent-only read)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The default caller is an agent: everything past the gate is only
    // reachable for one, so the non-gate cases would otherwise all be
    // testing the 403.
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'contributor',
    });
    isActiveAgentUserMock.mockResolvedValue(true);
  });

  it('returns 401 when the request is not authenticated', async () => {
    getUserFromRequestMock.mockResolvedValue(null);
    const { res, state } = createResponse();

    await handler(createGetRequest(), res);

    expect(state.statusCode).toBe(401);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('returns 403 for authenticated users below contributor role', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'authenticated' });
    const { res, state } = createResponse();

    await handler(createGetRequest(), res);

    expect(state.statusCode).toBe(403);
    expect(getMock).not.toHaveBeenCalled();
  });

  // The download this route used to offer is gone: serving a stored publisher
  // PDF to a person is redistribution, and the reference page links the
  // paper's own source instead. A contributor holding `citation.pdf.access`
  // is exactly the caller that used to be served, so it is the case worth
  // pinning.
  it('refuses a human contributor even though the capability is held', async () => {
    isActiveAgentUserMock.mockResolvedValue(false);
    mockStoredPdf();
    const { res, state } = createResponse();

    await handler(createGetRequest(), res);

    expect(state.statusCode).toBe(403);
    expect(state.body).toContain('pdf_download_removed');
    expect(getMock).not.toHaveBeenCalled();
  });

  it('refuses an admin as well — the gate is not a tier', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 9, role: 'admin' });
    isActiveAgentUserMock.mockResolvedValue(false);
    mockStoredPdf();
    const { res, state } = createResponse();

    await handler(createGetRequest(), res);

    expect(state.statusCode).toBe(403);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('returns 404 when no PDF is stored for the citation', async () => {
    mockNoPdfStored();
    const { res, state } = createResponse();

    await handler(createGetRequest(), res);

    expect(state.statusCode).toBe(404);
    expect(getMock).not.toHaveBeenCalled();
  });

  it('streams the PDF bytes to an agent, as an attachment to prevent inline rendering', async () => {
    const pdfBytes = Buffer.from('%PDF-1.7 unit test');
    mockStoredPdf(pdfBytes);
    const { res, state } = createResponse();

    await handler(createGetRequest(), res);

    expect(state.statusCode).toBe(200);
    expect(state.headers['Content-Type']).toBe('application/pdf');
    expect(state.headers['Content-Disposition']).toBe('attachment; filename="paper.pdf"');
    expect(state.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(state.headers['Cache-Control']).toBe('private, no-store');
    expect(state.body).toBe(pdfBytes.toString());
  });

  it('redirects an agent to a short-lived presigned URL when the PDF is too large to proxy', async () => {
    const presigned =
      'https://store.public.blob.vercel-storage.com/citation-pdfs/12-abc.pdf' +
      '?vercel-blob-valid-until=1&download=1';
    mockStoredPdf(Buffer.from('%PDF-1.7 not read through function'), 12 * 1024 * 1024);
    presignStoredPdfUrlMock.mockResolvedValue(presigned);
    const { res, state } = createResponse();

    await handler(createGetRequest(), res);

    expect(state.statusCode).toBe(302);
    expect(state.headers.Location).toBe(presigned);
    expect(state.headers['Cache-Control']).toBe('private, no-store');
    expect(state.headers['X-Robots-Tag']).toBe('noindex, nofollow');
    expect(state.body).toBe('');
    expect(getMock).not.toHaveBeenCalled();
    expect(presignStoredPdfUrlMock).toHaveBeenCalledWith(
      'citation-pdfs/12-abc.pdf',
    );
  });

  it('falls back to the presigned URL if proxying a small PDF fails', async () => {
    const presigned =
      'https://store.public.blob.vercel-storage.com/citation-pdfs/12-abc.pdf' +
      '?vercel-blob-valid-until=1&download=1';
    mockStoredPdf(Buffer.from('%PDF-1.7 unit test'));
    getMock.mockRejectedValue(new Error('blob SDK read failed'));
    presignStoredPdfUrlMock.mockResolvedValue(presigned);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { res, state } = createResponse();

    await handler(createGetRequest(), res);

    expect(state.statusCode).toBe(302);
    expect(state.headers.Location).toBe(presigned);
  });
});
