import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  delMock,
  putMock,
  getBlobMock,
  getDbMock,
  getUserFromRequestMock,
  getNeonClientMock,
  handleUploadMock,
  recordCitationPdfMock,
} = vi.hoisted(() => ({
  delMock: vi.fn(),
  putMock: vi.fn(),
  getBlobMock: vi.fn(),
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
  getNeonClientMock: vi.fn(),
  handleUploadMock: vi.fn(),
  recordCitationPdfMock: vi.fn(),
}));

vi.mock('@vercel/blob', () => ({
  del: delMock,
  put: putMock,
  get: getBlobMock,
}));
vi.mock('@vercel/blob/client', () => ({ handleUpload: handleUploadMock }));
vi.mock('../../api/_lib/db.js', () => ({
  getDb: getDbMock,
  getNeonClient: getNeonClientMock,
}));
vi.mock('../../api/_lib/pdf-storage.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/_lib/pdf-storage.js')>();
  return { ...actual, recordCitationPdf: recordCitationPdfMock };
});
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));

import handler from '../../api/citation-pdf-upload.ts';
import { PdfRequestNotOpenError } from '../../api/_lib/pdf-storage.js';

const openRequestCreatedAt = '2026-06-03 02:00:00.123456';

// Mirror the @vercel/blob `get()` shape the route reads from: a web
// ReadableStream of the stored bytes plus a blob descriptor carrying the size.
function storedPdf(text: string): {
  stream: ReadableStream<Uint8Array>;
  blob: { size: number };
} {
  const bytes = new TextEncoder().encode(text);
  return {
    stream: new Response(bytes).body as ReadableStream<Uint8Array>,
    blob: { size: bytes.byteLength },
  };
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
  req.url = '/api/citation-pdf-upload';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(raw),
  };
  return req;
}

function mockExistingPdf(blobUrl: string | null) {
  const limit = vi.fn().mockResolvedValue(blobUrl ? [{ blobUrl }] : []);
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

describe('POST /api/citation-pdf-upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserFromRequestMock.mockResolvedValue({
      userId: 42,
      role: 'contributor',
    });
    delMock.mockResolvedValue(undefined);
    putMock.mockResolvedValue({
      url: 'https://blob.example/citation-pdfs/.storage-probe.pdf',
    });
    getBlobMock.mockResolvedValue(storedPdf('%PDF-1.7 body'));
    recordCitationPdfMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('acknowledges the storage probe after a successful write round-trip', async () => {
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ type: 'kinetix.storage-probe' }),
      res,
    );

    expect(putMock).toHaveBeenCalledWith(
      'citation-pdfs/.storage-probe.pdf',
      expect.any(Buffer),
      expect.objectContaining({
        access: 'private',
        allowOverwrite: true,
        contentType: 'application/pdf',
      }),
    );
    expect(delMock).toHaveBeenCalledWith(
      'https://blob.example/citation-pdfs/.storage-probe.pdf',
    );
    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({ ok: true });
    expect(handleUploadMock).not.toHaveBeenCalled();
  });

  it('reports pdf_storage_unavailable when the Blob store rejects writes', async () => {
    putMock.mockRejectedValueOnce(
      new Error('Vercel Blob: store not found'),
    );
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ type: 'kinetix.storage-probe' }),
      res,
    );

    expect(state.statusCode).toBe(503);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_storage_unavailable',
    });
  });

  it('rejects the storage probe without contributor role', async () => {
    getUserFromRequestMock.mockResolvedValueOnce({ userId: 9, role: 'viewer' });
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ type: 'kinetix.storage-probe' }),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(putMock).not.toHaveBeenCalled();
  });

  it('mints upload tokens only when an open PDF request exists', async () => {
    mockSelectSequence([
      [{ id: 12, type: 'doi' }],
      [{ id: 7, createdAt: openRequestCreatedAt }],
    ]);
    handleUploadMock.mockImplementationOnce(
      async ({ onBeforeGenerateToken }) => {
        const tokenOptions = await onBeforeGenerateToken(
          'citation-pdfs/12.pdf',
          '12',
        );
        expect(tokenOptions).toMatchObject({
          allowedContentTypes: ['application/pdf'],
          maximumSizeInBytes: 50 * 1024 * 1024,
          allowOverwrite: false,
          tokenPayload: JSON.stringify({
            citationId: 12,
            pdfRequestId: 7,
            pdfRequestCreatedAt: openRequestCreatedAt,
            userId: 42,
          }),
        });
        return { ok: true };
      },
    );
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ type: 'blob.generate-client-token' }),
      res,
    );

    expect(state.statusCode).toBe(200);
  });

  it('rejects upload tokens when no PDF request is open', async () => {
    mockSelectSequence([[{ id: 12, type: 'doi' }], []]);
    handleUploadMock.mockImplementationOnce(
      async ({ onBeforeGenerateToken }) => {
        await onBeforeGenerateToken('citation-pdfs/12.pdf', '12');
        return { ok: true };
      },
    );
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ type: 'blob.generate-client-token' }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_request_not_open',
    });
    expect(recordCitationPdfMock).not.toHaveBeenCalled();
  });

  it('refuses a contributor upload against a replacement request', async () => {
    // Opening a replacement request is editor-gated because it discards the
    // stored asset. Gating only the open would make the invariant last exactly
    // as long as the row takes to write: an interrupted upload leaves the
    // request open, and the open-queue listing hides citations that already
    // have a PDF, so it becomes an invisible standing grant to overwrite that
    // paper's full text.
    mockSelectSequence([
      [{ id: 12, type: 'doi' }],
      [{ id: 7, createdAt: openRequestCreatedAt, isReplacement: true }],
    ]);
    handleUploadMock.mockImplementationOnce(
      async ({ onBeforeGenerateToken }) => {
        await onBeforeGenerateToken('citation-pdfs/12.pdf', '12');
        return { ok: true };
      },
    );
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ type: 'blob.generate-client-token' }),
      res,
    );

    expect(state.statusCode).toBe(403);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_replace_requires_editor',
    });
    expect(recordCitationPdfMock).not.toHaveBeenCalled();
  });

  it('refuses a replacement upload while an extraction job is open', async () => {
    // The create-time guard on POST /api/pdf-requests cannot cover the gap
    // between opening the request and completing the upload — the editor picks
    // a file, the browser uploads — and a job can be enqueued anywhere in it.
    getUserFromRequestMock.mockResolvedValue({ userId: 42, role: 'editor' });
    mockSelectSequence([
      [{ id: 12, type: 'doi' }],
      [{ id: 7, createdAt: openRequestCreatedAt, isReplacement: true }],
      [{ id: 3 }], // an open paper_extraction_jobs row
    ]);
    handleUploadMock.mockImplementationOnce(
      async ({ onBeforeGenerateToken }) => {
        await onBeforeGenerateToken('citation-pdfs/12.pdf', '12');
        return { ok: true };
      },
    );
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ type: 'blob.generate-client-token' }),
      res,
    );

    expect(state.statusCode).toBe(409);
    expect(JSON.parse(state.body)).toMatchObject({
      code: 'pdf_replace_extraction_in_flight',
    });
    expect(recordCitationPdfMock).not.toHaveBeenCalled();
  });

  it('lets an editor upload against a replacement request', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 42, role: 'editor' });
    mockSelectSequence([
      [{ id: 12, type: 'doi' }],
      [{ id: 7, createdAt: openRequestCreatedAt, isReplacement: true }],
      [], // no open extraction job
    ]);
    handleUploadMock.mockImplementationOnce(
      async ({ onBeforeGenerateToken }) => {
        await onBeforeGenerateToken('citation-pdfs/12.pdf', '12');
        return { ok: true };
      },
    );
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ type: 'blob.generate-client-token' }),
      res,
    );

    expect(state.statusCode).toBe(200);
  });

  it('still lets a contributor fulfil an ordinary request', async () => {
    // The gate must be narrow: supplying missing full text stays contributor
    // work, which is the whole point of the PDF-request queue.
    mockSelectSequence([
      [{ id: 12, type: 'doi' }],
      [{ id: 7, createdAt: openRequestCreatedAt, isReplacement: false }],
    ]);
    handleUploadMock.mockImplementationOnce(
      async ({ onBeforeGenerateToken }) => {
        await onBeforeGenerateToken('citation-pdfs/12.pdf', '12');
        return { ok: true };
      },
    );
    const { res, state } = createResponse();

    await handler(
      createPostRequest({ type: 'blob.generate-client-token' }),
      res,
    );

    expect(state.statusCode).toBe(200);
  });

  it('deletes the previous blob after a replacement upload is recorded', async () => {
    mockExistingPdf('https://blob.example/citation-pdfs/12-old.pdf');
    handleUploadMock.mockImplementationOnce(async ({ onUploadCompleted }) => {
      await onUploadCompleted({
        blob: {
          pathname: 'citation-pdfs/12-random.pdf',
          url: 'https://blob.example/citation-pdfs/12-random.pdf',
          contentType: 'application/pdf',
        },
        tokenPayload: JSON.stringify({
          citationId: 12,
          pdfRequestId: 7,
          pdfRequestCreatedAt: openRequestCreatedAt,
          userId: 42,
        }),
      });
      return { ok: true };
    });
    const { res, state } = createResponse();

    await handler(createPostRequest({ type: 'blob.upload-completed' }), res);

    expect(state.statusCode).toBe(200);
    expect(recordCitationPdfMock).toHaveBeenCalledWith(
      expect.objectContaining({
        citationId: 12,
        pdfRequestId: 7,
        pdfRequestCreatedAt: openRequestCreatedAt,
        blobUrl: 'https://blob.example/citation-pdfs/12-random.pdf',
        source: 'upload',
        uploadedBy: 42,
      }),
    );
    expect(delMock).toHaveBeenCalledWith(
      'https://blob.example/citation-pdfs/12-old.pdf',
    );
  });

  it('deletes the new blob when validation rejects the uploaded bytes', async () => {
    getBlobMock.mockResolvedValueOnce(storedPdf('not a pdf'));
    handleUploadMock.mockImplementationOnce(async ({ onUploadCompleted }) => {
      await onUploadCompleted({
        blob: {
          pathname: 'citation-pdfs/12-random.pdf',
          url: 'https://blob.example/citation-pdfs/12-random.pdf',
          contentType: 'application/pdf',
        },
        tokenPayload: JSON.stringify({
          citationId: 12,
          pdfRequestId: 7,
          pdfRequestCreatedAt: openRequestCreatedAt,
          userId: 42,
        }),
      });
      return { ok: true };
    });
    const { res, state } = createResponse();

    await handler(createPostRequest({ type: 'blob.upload-completed' }), res);

    expect(state.statusCode).toBe(500);
    expect(recordCitationPdfMock).not.toHaveBeenCalled();
    expect(delMock).toHaveBeenCalledWith(
      'https://blob.example/citation-pdfs/12-random.pdf',
    );
  });

  it('deletes the new blob and acknowledges when the request closes during upload completion', async () => {
    mockExistingPdf(null);
    recordCitationPdfMock.mockRejectedValue(new PdfRequestNotOpenError(12));
    handleUploadMock.mockImplementationOnce(async ({ onUploadCompleted }) => {
      await onUploadCompleted({
        blob: {
          pathname: 'citation-pdfs/12-random.pdf',
          url: 'https://blob.example/citation-pdfs/12-random.pdf',
          contentType: 'application/pdf',
        },
        tokenPayload: JSON.stringify({
          citationId: 12,
          pdfRequestId: 7,
          pdfRequestCreatedAt: openRequestCreatedAt,
          userId: 42,
        }),
      });
      return { ok: true };
    });
    const { res, state } = createResponse();

    await handler(createPostRequest({ type: 'blob.upload-completed' }), res);

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({ ok: true });
    expect(delMock).toHaveBeenCalledWith(
      'https://blob.example/citation-pdfs/12-random.pdf',
    );
  });
});
