import { createHash } from 'node:crypto';
import {
  put,
  del,
  get,
  getDownloadUrl,
  issueSignedToken,
  presignUrl,
} from '@vercel/blob';
import { getNeonClient } from './db.js';

/**
 * Custom upload-route event our client sends to probe storage health before
 * starting a client-direct upload. Kept distinct from the SDK's
 * `blob.*` event types. Mirrored in src/lib/referencesApi.ts.
 */
export const STORAGE_PROBE_EVENT = 'kinetix.storage-probe';

/**
 * Hard cap on stored PDFs. Keeps server-side URL fetches well under the
 * serverless function timeout and bounds Blob storage growth. Client-direct
 * uploads enforce the same cap via the upload token.
 */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

export const PDF_CONTENT_TYPE = 'application/pdf';

/**
 * Largest stored PDF this deployment will stream back through a function
 * response rather than redirect to.
 *
 * Vercel caps a function response body at 4.5 MB. Staying a little under that
 * leaves room for headers and for the base64 framing the platform applies to
 * binary bodies, so a paper at the threshold cannot fail with a platform error
 * that looks like a Kinetix bug. Anything larger still has to be redirected
 * (`presignStoredPdfUrl`) — there is no way to hand 50 MB through a function.
 *
 * The point of proxying at all is reach: a redirect to
 * `private.blob.vercel-storage.com` is refused outright by several link
 * readers (LLM browsing tools, corporate link scanners, mail gateways), which
 * makes a share link useless for the exact recipients it exists to serve. A
 * same-origin `application/pdf` response is read by all of them. Most papers
 * sit far below this line, so the common case gets the better behaviour and
 * the rare large one keeps working as before.
 */
export const PROXYABLE_PDF_MAX_BYTES = 4 * 1024 * 1024;

export const PDF_MAGIC = '%PDF-';

export class PdfRequestNotOpenError extends Error {
  constructor(citationId: number) {
    super(`No open PDF request exists for citation ${citationId}`);
    this.name = 'PdfRequestNotOpenError';
  }
}

/**
 * A contributor tried to fulfil a request that exists to REPLACE stored full
 * text. Opening one is editor-gated because it discards the previous asset;
 * fulfilling one carries the same consequence, so it carries the same tier.
 */
export class PdfReplacementForbiddenError extends Error {
  constructor(citationId: number) {
    super(`Replacing stored full text for citation ${citationId} requires the editor role`);
    this.name = 'PdfReplacementForbiddenError';
  }
}

/**
 * A replacement upload reached fulfilment while an extraction job for the same
 * citation was queued or claimed.
 */
export class PdfReplacementInFlightError extends Error {
  constructor(citationId: number) {
    super(
      `An extraction job for citation ${citationId} is still open; cancel it before replacing the full text`,
    );
    this.name = 'PdfReplacementInFlightError';
  }
}

/**
 * Guard both fulfilment routes against swapping a citation's PDF out from
 * under a live extraction job.
 *
 * The create-time check on `POST /api/pdf-requests {replace:true}` is not
 * enough on its own: opening the request and completing the upload are
 * separate steps with an unbounded gap between them (the editor picks a file,
 * the browser uploads to Blob), and a job can be enqueued anywhere in that
 * gap. Re-checking here narrows the window to the upload itself.
 *
 * Deliberately not claiming to close it completely — a job enqueued after this
 * check but before `recordCitationPdf` commits still slips through. Closing
 * that fully means moving the predicate into the write CTE, which trades a
 * clear 409 for an opaque failure at the end of an upload. Since enqueueing is
 * editor-only and the queue page hides replacement while a job is open, the
 * residual window needs two editors racing on one paper within seconds.
 */
export async function assertNoOpenExtractionJob(
  citationId: number,
): Promise<void> {
  const { getDb } = await import('./db.js');
  const { paperExtractionJobs } = await import('../../db/schema.js');
  const { and, eq, inArray } = await import('drizzle-orm');

  const [openJob] = await getDb()
    .select({ id: paperExtractionJobs.id })
    .from(paperExtractionJobs)
    .where(
      and(
        eq(paperExtractionJobs.citationId, citationId),
        inArray(paperExtractionJobs.status, ['queued', 'claimed']),
      ),
    )
    .limit(1);
  if (openJob) throw new PdfReplacementInFlightError(citationId);
}

export function blobPathForCitation(citationId: number): string {
  return `citation-pdfs/${citationId}.pdf`;
}

/**
 * Tiny PDF-magic payload ("%PDF-1.4") written by the storage health probe.
 * Kept minimal so the probe round-trip is cheap.
 */
const STORAGE_PROBE_BODY = Buffer.from('%PDF-1.4', 'latin1');

/**
 * Verify the Blob store can actually accept an upload with the configured
 * BLOB_READ_WRITE_TOKEN. Client-token minting only *signs* a payload locally
 * (it never contacts Vercel), so a deleted/disconnected store, a stale/rotated
 * token, or a token without write scope still mints a token that the browser's
 * direct upload then rejects with an opaque 400/CORS error.
 *
 * Crucially this performs a real WRITE (`put`), not just a read: a read-only or
 * mis-scoped token, or a store that rejects writes, passes a `list()` probe but
 * still fails the actual upload — and Vercel's Blob API returns that rejection
 * without CORS headers, which the browser surfaces as the opaque
 * "No 'Access-Control-Allow-Origin'" 400. Exercising the write path here makes
 * the real Vercel Blob error readable server-side (logged + shown as a clear
 * message) instead of hiding behind the browser CORS failure.
 *
 * The probe writes to a single fixed path with `allowOverwrite` (no random
 * suffix), so a failed cleanup leaves at most one stale probe blob, overwritten
 * by the next probe rather than accumulating.
 */
export async function assertBlobStoreReachable(): Promise<void> {
  const probe = await put('citation-pdfs/.storage-probe.pdf', STORAGE_PROBE_BODY, {
    access: 'private',
    allowOverwrite: true,
    contentType: PDF_CONTENT_TYPE,
  });
  // Best-effort cleanup — the write already proved reachability, and the fixed
  // path means a lingering blob (if delete fails) is overwritten next time.
  await del(probe.url).catch(() => undefined);
}

/**
 * Read a stored citation PDF back out of Blob storage.
 *
 * Stored PDFs are written with `access: 'private'`, so the Blob URL is not
 * publicly fetchable: reading it takes an authenticated SDK call carrying
 * BLOB_READ_WRITE_TOKEN. The agent read (`GET /api/citation-pdf`) and
 * share-link redemption both go through here for papers at or under
 * `PROXYABLE_PDF_MAX_BYTES`. A paper too large for a function response body
 * falls back to a presigned redirect (`presignStoredPdfUrl`) on either path.
 * Returns null when the object is gone or unreadable; both download routes may
 * then try that same presigned handoff before returning a 502.
 */
export async function readStoredPdfBytes(
  blobUrl: string,
): Promise<Buffer | null> {
  const stored = await get(blobUrl, { access: 'private' });
  if (!stored || !stored.stream) return null;
  return Buffer.from(await new Response(stored.stream).arrayBuffer());
}

/**
 * How long a presigned download URL stays valid. Short and fixed: the URL is a
 * one-time handoff to a browser that is already mid-redirect, so it needs
 * enough time to *start* a transfer and no more. Deliberately not tied to the
 * share token's remaining life — a link with nine minutes left would otherwise
 * hand out a nine-minute URL, and one with two seconds left would hand out a
 * URL that expires before the browser follows it.
 */
export const PRESIGNED_PDF_TTL_MS = 60_000;

/**
 * Mint a short-lived, signed URL that serves a stored PDF straight from Blob
 * storage, as an attachment.
 *
 * Vercel caps a function's response body at 4.5 MB, and stored PDFs may be up
 * to `MAX_PDF_BYTES` (50 MB) — so proxying the bytes through the function, as
 * `readStoredPdfBytes` does, cannot deliver a large paper at all. Redirecting
 * to the object means the transfer never passes through the function.
 *
 * What the caller receives is NOT the durable Blob URL the database stores: it
 * is scoped to this one pathname, allows only `get`, and expires in a minute.
 * `getDownloadUrl` appends `download=1` so the CDN serves it as an attachment
 * rather than inline, preserving the "PDF JavaScript never runs in the
 * browser's viewer" defence the proxy gets from `Content-Disposition`. That
 * parameter is not one of the presign signing keys, so adding it leaves the
 * signature intact.
 */
export async function presignStoredPdfUrl(
  blobPathname: string,
  now = Date.now(),
): Promise<string> {
  const validUntil = now + PRESIGNED_PDF_TTL_MS;
  const signedToken = await issueSignedToken({
    pathname: blobPathname,
    operations: ['get'],
    validUntil,
  });
  const { presignedUrl } = await presignUrl(signedToken, {
    operation: 'get',
    pathname: blobPathname,
    access: 'private',
    validUntil,
  });
  return getDownloadUrl(presignedUrl);
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hasPdfMagic(data: Uint8Array): boolean {
  return (
    Buffer.from(data.slice(0, PDF_MAGIC.length)).toString('latin1') ===
    PDF_MAGIC
  );
}

interface StoredPdf {
  citationId: number;
  pdfRequestId: number;
  pdfRequestCreatedAt: string;
  blobPathname: string;
  blobUrl: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
  source: 'upload' | 'url';
  sourceUrl: string | null;
  uploadedBy: number | null;
}

/**
 * Persist the asset pointer and close the exact request that authorized the
 * upload. The created_at text token preserves PostgreSQL timestamp precision
 * so a stale token cannot match a later reopened lifecycle of the same row.
 */
export async function recordCitationPdf(pdf: StoredPdf): Promise<void> {
  const neonSql = getNeonClient();
  const now = new Date();
  const rows = (await neonSql`WITH open_request AS (
        UPDATE pdf_requests
        SET status = 'fulfilled',
          fulfilled_by = ${pdf.uploadedBy},
          fulfilled_at = ${now}
        WHERE citation_id = ${pdf.citationId}
          AND id = ${pdf.pdfRequestId}
          AND created_at::text = ${pdf.pdfRequestCreatedAt}
          AND status = 'open'
        RETURNING id, is_replacement
      ),
      -- Replacing the bytes invalidates any appraisal of the bytes that were
      -- there before. paper_reviews is keyed by CITATION, and the read-in-full
      -- gate (assertReferencesJudged) resolves on that key alone -- so a review
      -- written about a wrong-paper or unreadable upload would keep authorizing
      -- facts against a document nobody has read. Flip it to not-read-in-full
      -- so the citation must be re-reviewed; the review text and its revision
      -- history are preserved. Same statement as the swap, so the two cannot
      -- diverge: a review left valid beside replaced bytes is the failure mode.
      expired_review AS (
        UPDATE paper_reviews
        SET read_in_full = false,
          updated_at = ${now}
        WHERE citation_id = ${pdf.citationId}
          AND read_in_full = true
          AND EXISTS (
            SELECT 1 FROM open_request WHERE is_replacement
          )
        RETURNING id
      ),
      upserted AS (
        INSERT INTO citation_pdfs (
          citation_id,
          blob_pathname,
          blob_url,
          size_bytes,
          sha256,
          content_type,
          source,
          source_url,
          uploaded_by
        )
        SELECT
          ${pdf.citationId},
          ${pdf.blobPathname},
          ${pdf.blobUrl},
          ${pdf.sizeBytes},
          ${pdf.sha256},
          ${pdf.contentType},
          ${pdf.source},
          ${pdf.sourceUrl},
          ${pdf.uploadedBy}
        WHERE EXISTS (SELECT 1 FROM open_request)
        ON CONFLICT (citation_id) DO UPDATE SET
          blob_pathname = EXCLUDED.blob_pathname,
          blob_url = EXCLUDED.blob_url,
          size_bytes = EXCLUDED.size_bytes,
          sha256 = EXCLUDED.sha256,
          content_type = EXCLUDED.content_type,
          source = EXCLUDED.source,
          source_url = EXCLUDED.source_url,
          uploaded_by = EXCLUDED.uploaded_by,
          created_at = ${now}
        RETURNING id
      )
      SELECT id FROM upserted`) as Array<{ id: number }>;

  if (rows.length === 0) {
    throw new PdfRequestNotOpenError(pdf.citationId);
  }
}
