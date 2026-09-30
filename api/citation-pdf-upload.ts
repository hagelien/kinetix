/**
 * Vercel Blob client-upload token route. The browser uploads the PDF bytes
 * directly to Blob (bypassing this function's body), using a short-lived token
 * minted here. Two event types hit this route:
 *   - blob.generate-client-token: carries the user cookie — gated to
 *     contributors; restricts type/size and stamps citationId + userId.
 *   - blob.upload-completed: signed callback from Vercel (no cookie) — records
 *     the citation_pdfs row and closes the open request.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { del, get } from '@vercel/blob';
import { and, eq, sql } from 'drizzle-orm';
import { json, error, withErrorHandling } from './_lib/response.js';
import { readBody } from './_lib/validate.js';
import { getUserFromRequest } from './_lib/auth.js';
import { getDb } from './_lib/db.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import { citationPdfs, citations, pdfRequests } from '../db/schema.js';
import {
  MAX_PDF_BYTES,
  PDF_CONTENT_TYPE,
  STORAGE_PROBE_EVENT,
  PdfReplacementForbiddenError,
  PdfReplacementInFlightError,
  PdfRequestNotOpenError,
  assertNoOpenExtractionJob,
  assertBlobStoreReachable,
  blobPathForCitation,
  hasPdfMagic,
  recordCitationPdf,
  sha256Hex,
} from './_lib/pdf-storage.js';

interface UploadTokenPayload {
  citationId: number;
  pdfRequestId: number;
  pdfRequestCreatedAt: string;
  userId: number;
}

async function readStreamBytesWithLimit(
  stream: ReadableStream<Uint8Array>,
  declaredLength: number,
): Promise<Uint8Array> {
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_BYTES) {
    throw new Error('Uploaded PDF exceeds size limit');
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PDF_BYTES) {
      await reader.cancel();
      throw new Error('Uploaded PDF exceeds size limit');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    error(res, 405, 'Method not allowed');
    return;
  }

  const raw = await readBody(req);
  let body: HandleUploadBody;
  try {
    body = JSON.parse(raw) as HandleUploadBody;
  } catch {
    error(res, 400, 'Invalid JSON body');
    return;
  }

  // Storage-health probe: the client calls this before a client-direct upload
  // so a misconfigured Blob store surfaces as a clear, localized error rather
  // than an opaque browser 400/CORS failure on the direct PUT to Vercel Blob.
  if ((body as { type?: string }).type === STORAGE_PROBE_EVENT) {
    const auth = await getUserFromRequest(req);
    if (!auth) {
      error(res, 401, 'Authentication required');
      return;
    }
    if (!(await callerCan(auth.role, CAP['citation.pdf.access']))) {
      error(res, 403, 'Contributor role required');
      return;
    }
    try {
      await assertBlobStoreReachable();
    } catch (err) {
      // Log with the KINETIX_ERROR marker so the log drain files an auto-fix
      // issue; the real cause (store deleted, token rotated, etc.) lands here
      // rather than being swallowed by the browser's CORS report.
      console.error(
        'KINETIX_ERROR ' +
          JSON.stringify({
            level: 'error',
            route: req.url ?? null,
            method: req.method ?? null,
            status: 503,
            message:
              'Vercel Blob store unreachable: ' +
              (err instanceof Error ? err.message : String(err)),
            code: 'pdf_storage_unavailable',
            ts: new Date().toISOString(),
          }),
      );
      error(
        res,
        503,
        'PDF storage is not reachable',
        'pdf_storage_unavailable',
      );
      return;
    }
    json(res, 200, { ok: true });
    return;
  }

  // Only the token-generation event carries the user's cookie; the
  // upload-completed callback is signature-verified by handleUpload.
  if (body.type === 'blob.generate-client-token') {
    const auth = await getUserFromRequest(req);
    if (!auth) {
      error(res, 401, 'Authentication required');
      return;
    }
    if (!(await callerCan(auth.role, CAP['citation.pdf.access']))) {
      error(res, 403, 'Contributor role required');
      return;
    }

    let result: Awaited<ReturnType<typeof handleUpload>>;
    try {
      result = await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: async (pathname, clientPayload) => {
          const citationId = Number(clientPayload);
          if (!citationId || !Number.isInteger(citationId) || citationId <= 0) {
            throw new Error('Missing or invalid citationId');
          }
          const expectedPathname = blobPathForCitation(citationId);
          if (pathname.replace(/^\/+/, '') !== expectedPathname) {
            throw new Error('Invalid upload pathname');
          }
          const db = getDb();
          const [[citation], [openRequest]] = await Promise.all([
            db
              .select({ id: citations.id, type: citations.type })
              .from(citations)
              .where(eq(citations.id, citationId))
              .limit(1),
            db
              .select({
                id: pdfRequests.id,
                createdAt: sql<string>`${pdfRequests.createdAt}::text`,
                isReplacement: pdfRequests.isReplacement,
              })
              .from(pdfRequests)
              .where(
                and(
                  eq(pdfRequests.citationId, citationId),
                  eq(pdfRequests.status, 'open'),
                ),
              )
              .limit(1),
          ]);
          if (!citation || citation.type === 'freetext') {
            throw new Error('Citation not found or not resolvable');
          }
          if (!openRequest) {
            throw new PdfRequestNotOpenError(citationId);
          }
          // Opening a replacement request is editor-gated because swapping
          // discards the stored asset; fulfilling one must be too, or the
          // invariant lasts only until the row exists. An interrupted upload
          // leaves the request open and the open-queue listing hides it (the
          // citation already has a PDF), so without this a contributor could
          // overwrite that paper's full text via an invisible grant.
          if (
            openRequest.isReplacement &&
            !(await callerCan(auth.role, CAP['citation.pdf.replace']))
          ) {
            throw new PdfReplacementForbiddenError(citationId);
          }
          // The create-time guard cannot cover the gap between opening the
          // request and completing the upload; a job can be enqueued in it.
          if (openRequest.isReplacement) {
            await assertNoOpenExtractionJob(citationId);
          }
          const payload: UploadTokenPayload = {
            citationId,
            pdfRequestId: openRequest.id,
            pdfRequestCreatedAt: openRequest.createdAt,
            userId: auth.userId,
          };
          return {
            allowedContentTypes: [PDF_CONTENT_TYPE],
            maximumSizeInBytes: MAX_PDF_BYTES,
            // Random suffix makes the stored path unguessable even though the
            // base name ({citationId}.pdf) is predictable. The actual blob URL
            // is never returned to clients — the server always proxies — so
            // enumerating citation IDs against the store is insufficient.
            addRandomSuffix: true,
            allowOverwrite: false,
            tokenPayload: JSON.stringify(payload),
          };
        },
        onUploadCompleted: async () => {
          // Unreachable for token-generation events; completion is handled below.
        },
      });
    } catch (err) {
      if (err instanceof PdfReplacementInFlightError) {
        error(
          res,
          409,
          'An extraction job for this paper is still open',
          'pdf_replace_extraction_in_flight',
        );
        return;
      }
      if (err instanceof PdfReplacementForbiddenError) {
        error(
          res,
          403,
          'Replacing stored full text requires the editor role',
          'pdf_replace_requires_editor',
        );
        return;
      }
      if (err instanceof PdfRequestNotOpenError) {
        error(
          res,
          409,
          'No open PDF request exists for this citation',
          'pdf_request_not_open',
        );
        return;
      }
      throw err;
    }
    json(res, 200, result);
    return;
  }

  const result = await handleUpload({
    body,
    request: req,
    onBeforeGenerateToken: async () => {
      throw new Error('Unexpected token generation on completion callback');
    },
    onUploadCompleted: async ({ blob, tokenPayload }) => {
      let recorded = false;
      try {
        if (!tokenPayload) throw new Error('Missing token payload');
        const { citationId, pdfRequestId, pdfRequestCreatedAt, userId } =
          JSON.parse(tokenPayload) as UploadTokenPayload;

        // Read the stored bytes once to verify size/type and capture a
        // content hash — PutBlobResult carries no size/checksum. The blob is
        // private, so read it with an authenticated SDK call rather than a
        // plain fetch (the raw URL is not publicly accessible).
        const stored = await get(blob.url, { access: 'private' });
        if (!stored || !stored.stream) {
          throw new Error('Stored blob is not readable');
        }
        const bytes = await readStreamBytesWithLimit(
          stored.stream,
          stored.blob.size,
        );
        if (!hasPdfMagic(bytes)) {
          throw new Error('Uploaded file is not a PDF');
        }

        const db = getDb();
        const [existingPdf] = await db
          .select({ blobUrl: citationPdfs.blobUrl })
          .from(citationPdfs)
          .where(eq(citationPdfs.citationId, citationId))
          .limit(1);

        await recordCitationPdf({
          citationId,
          pdfRequestId,
          pdfRequestCreatedAt,
          blobPathname: blob.pathname,
          blobUrl: blob.url,
          sizeBytes: bytes.byteLength,
          sha256: sha256Hex(bytes),
          contentType: blob.contentType || PDF_CONTENT_TYPE,
          source: 'upload',
          sourceUrl: null,
          uploadedBy: userId,
        });
        recorded = true;

        if (existingPdf?.blobUrl && existingPdf.blobUrl !== blob.url) {
          del(existingPdf.blobUrl).catch(() => undefined);
        }
      } catch (err) {
        if (!recorded) {
          await del(blob.url).catch(() => undefined);
        }
        if (err instanceof PdfRequestNotOpenError) {
          return;
        }
        throw err;
      }
    },
  });
  json(res, 200, result);
});
