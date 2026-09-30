/**
 * `pdfInbox.upload` is not authority to say which paper the bytes are.
 *
 * The two capabilities are split on purpose, and an admin may raise `resolve`
 * above `upload` in the runtime matrix. But the completion callback carries no
 * session — it is Vercel's signed callback, not the user's request — so if the
 * auto-attach decision is made there without an authorization carried from
 * where the session *was*, holding `pdfInbox.upload` alone becomes sufficient
 * to create `citation_pdfs` rows and fulfil PDF requests under the uploader's
 * identity.
 *
 * These tests pin both halves: the grant is checked while the cookie is in
 * hand and stamped into the signed token, and the callback refuses to attach
 * without it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  handleUploadMock,
  getBlobMock,
  delMock,
  getDbMock,
  getUserFromRequestMock,
  callerCanMock,
  attachInboxItemMock,
  matchInboxItemMock,
} = vi.hoisted(() => ({
  handleUploadMock: vi.fn(),
  getBlobMock: vi.fn(),
  delMock: vi.fn(async () => undefined),
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
  callerCanMock: vi.fn(),
  attachInboxItemMock: vi.fn(),
  matchInboxItemMock: vi.fn(),
}));

vi.mock('@vercel/blob/client', () => ({ handleUpload: handleUploadMock }));
vi.mock('@vercel/blob', () => ({ get: getBlobMock, del: delMock, put: vi.fn() }));
vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/auth.js', () => ({
  getUserFromRequest: getUserFromRequestMock,
}));
vi.mock('../../api/_lib/permissions-store.js', () => ({
  callerCan: callerCanMock,
}));
vi.mock('../../api/_lib/pdf-inbox-store.js', () => ({
  attachInboxItem: attachInboxItemMock,
}));
vi.mock('../../api/_lib/pdf-inbox-match.js', async () => {
  // The real `mayAutoAttach` — whether a match is attachable at all is not
  // what these tests are about, and stubbing it would let the gate pass for
  // the wrong reason.
  const actual = await vi.importActual<
    typeof import('../../api/_lib/pdf-inbox-match.js')
  >('../../api/_lib/pdf-inbox-match.js');
  return { ...actual, matchInboxItem: matchInboxItemMock };
});

import handler from '../../api/pdf-inbox-upload.ts';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\nnothing to read here\n');

function createResponse(): {
  res: ServerResponse;
  state: { statusCode: number; body: string };
} {
  const state = { statusCode: 200, body: '' };
  const res = {
    headersSent: false,
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

function request(body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = 'POST';
  req.url = '/api/pdf-inbox-upload';
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

/** A drizzle stub for the count read and the inbox insert/update. */
function mockDb(pendingCount = 0, insertedId: number | null = 5) {
  const where = vi.fn(() => Promise.resolve([{ count: pendingCount }]));
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({ where }),
  });
  const insert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn(() =>
          Promise.resolve(insertedId === null ? [] : [{ id: insertedId }]),
        ),
      }),
    }),
  });
  const update = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn(() => Promise.resolve([])) }),
  });
  getDbMock.mockReturnValue({ select, insert, update });
}

const EXACT_MATCH = {
  candidates: [
    {
      citationId: 12,
      via: 'doi' as const,
      score: 1,
      citationType: 'doi',
      citationIdentifier: '10.1/x',
      citationMetadata: null,
      hasPdf: false,
    },
  ],
  confidence: 'exact' as const,
  citationId: 12,
};

/** Drive the token-minting branch and return the payload it stamped. */
async function mintToken(): Promise<Record<string, unknown>> {
  let stamped: Record<string, unknown> = {};
  handleUploadMock.mockImplementation(
    async (config: {
      onBeforeGenerateToken: (
        pathname: string,
        clientPayload: string | null,
      ) => Promise<{ tokenPayload?: string }>;
    }) => {
      const result = await config.onBeforeGenerateToken(
        'pdf-inbox/dropped.pdf',
        JSON.stringify({ filename: 'paper.pdf' }),
      );
      stamped = JSON.parse(result.tokenPayload ?? '{}') as Record<string, unknown>;
      return { ok: true };
    },
  );
  const { res } = createResponse();
  await handler(request({ type: 'blob.generate-client-token' }), res);
  return stamped;
}

/** Drive the signed completion callback with a chosen token payload. */
async function completeUpload(tokenPayload: Record<string, unknown>): Promise<void> {
  handleUploadMock.mockImplementation(
    async (config: {
      onUploadCompleted: (args: {
        blob: { url: string; pathname: string; contentType: string };
        tokenPayload: string;
      }) => Promise<void>;
    }) => {
      await config.onUploadCompleted({
        blob: {
          url: 'https://blob.example/pdf-inbox/dropped-abc.pdf',
          pathname: 'pdf-inbox/dropped-abc.pdf',
          contentType: 'application/pdf',
        },
        tokenPayload: JSON.stringify(tokenPayload),
      });
      return { ok: true };
    },
  );
  const { res } = createResponse();
  await handler(request({ type: 'blob.upload-completed' }), res);
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserFromRequestMock.mockResolvedValue({ userId: 3, role: 'contributor' });
  callerCanMock.mockResolvedValue(true);
  matchInboxItemMock.mockResolvedValue(EXACT_MATCH);
  attachInboxItemMock.mockResolvedValue({ citationId: 12, replaced: false });
  getBlobMock.mockResolvedValue({
    blob: { size: PDF_BYTES.byteLength },
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PDF_BYTES);
        controller.close();
      },
    }),
  });
  mockDb();
});

describe('minting the upload token', () => {
  it('stamps the resolve grant it checked while the session was in hand', async () => {
    const stamped = await mintToken();
    expect(stamped.mayResolve).toBe(true);
    expect(callerCanMock).toHaveBeenCalledWith(
      'contributor',
      expect.stringContaining('pdfInbox.resolve'),
    );
  });

  it('stamps it false when the uploader does not hold resolve', async () => {
    // The matrix is admin-adjustable, so `upload` can sit below `resolve`.
    callerCanMock.mockImplementation(async (_role: string, cap: string) =>
      cap !== 'pdfInbox.resolve',
    );
    const stamped = await mintToken();
    expect(stamped.mayResolve).toBe(false);
  });
});

describe('the signed completion callback', () => {
  it('attaches an unambiguous match when the uploader may resolve', async () => {
    await completeUpload({ userId: 3, filename: 'paper.pdf', mayResolve: true });
    expect(attachInboxItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ citationId: 12, auto: true, mayReplace: false }),
    );
  });

  it('refuses to attach without the resolve grant', async () => {
    // The bytes are still filed — the upload succeeded and the item waits in
    // the inbox for somebody who does hold the capability. What must not
    // happen is `citation_pdfs` being written on an upload grant alone.
    await completeUpload({ userId: 3, filename: 'paper.pdf', mayResolve: false });
    expect(attachInboxItemMock).not.toHaveBeenCalled();
    expect(delMock).not.toHaveBeenCalled();
  });

  it('treats a token minted without the field as no grant', async () => {
    // A token issued by the previous release carries no `mayResolve`. Reading
    // that absence as permission would reopen the hole for the length of a
    // deploy window.
    await completeUpload({ userId: 3, filename: 'paper.pdf' });
    expect(attachInboxItemMock).not.toHaveBeenCalled();
  });
});
