/**
 * Bulk drop-off for full-text PDFs — the upload half.
 *
 * Same client-direct Blob mechanism as `citation-pdf-upload.ts` (the browser
 * PUTs to Blob with a short-lived token; the bytes never pass through this
 * function's body), with one deliberate difference: **no citation is named**.
 * That is the entire point. The existing route cannot accept a file until an
 * open `pdf_requests` row exists for the paper it belongs to, which forces the
 * human to identify each download before uploading it — the slow half of
 * answering a queue of agent requests, and the half a machine can do from the
 * file itself.
 *
 * So the token here authorizes "put a PDF in the inbox", full stop. Identity
 * is worked out afterwards, in the completion callback: the file is scanned
 * for its own DOI / PMID / PMCID / title (`pdf-identifiers.ts`), those are
 * resolved against `citations` (`pdf-inbox-match.ts`), and only an identifier
 * that lands on exactly one citation with no full text already on file is
 * attached without a person (`mayAutoAttach`). Everything else waits in the
 * inbox for a human or an agent to confirm.
 *
 * Two events hit this route, as with the single-file path:
 *   - `blob.generate-client-token` — carries the user cookie; gated on
 *     `pdfInbox.upload`, and bounded so a runaway client cannot fill the store.
 *   - `blob.upload-completed` — signed callback from Vercel, no cookie;
 *     verifies the bytes, files the row, and attempts the match.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { del, get } from '@vercel/blob';
import { eq, sql } from 'drizzle-orm';
import { json, error, withErrorHandling } from './_lib/response.js';
import { readBody } from './_lib/validate.js';
import { getUserFromRequest } from './_lib/auth.js';
import { getDb } from './_lib/db.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import { pdfInboxItems } from '../db/schema.js';
import {
  MAX_PDF_BYTES,
  PDF_CONTENT_TYPE,
  STORAGE_PROBE_EVENT,
  assertBlobStoreReachable,
  hasPdfMagic,
  sha256Hex,
} from './_lib/pdf-storage.js';
import { extractPdfIdentifiers } from './_lib/pdf-identifiers.js';
import { mayAutoAttach, matchInboxItem } from './_lib/pdf-inbox-match.js';
import { attachInboxItem } from './_lib/pdf-inbox-store.js';

/**
 * Everything dropped in lands under one prefix, and the client never gets to
 * choose the rest of the path.
 *
 * The single-file route derives its pathname from the citation id and checks
 * the client's proposed path against it. There is no citation here to derive
 * one from, so rather than sanitizing a user-supplied filename into a storage
 * key — which is the shape of problem that produces traversal and overwrite
 * bugs — the key is a constant plus the SDK's random suffix, and the human's
 * filename travels in the payload to be stored as data in `original_filename`.
 */
export const INBOX_BLOB_PATH = 'pdf-inbox/dropped.pdf';

/**
 * Ceiling on unlinked items.
 *
 * The inbox is a staging area, not storage: items are meant to be linked or
 * discarded within a session or two. A cap turns "the matcher stopped working
 * and nobody noticed" into a visible refusal rather than an unbounded Blob
 * bill, and it is high enough that no realistic drop — a library session's
 * worth of downloads — ever meets it.
 */
export const MAX_PENDING_INBOX_ITEMS = 500;

/** Longest original filename kept. Well past any real one; stops a silly payload. */
const MAX_FILENAME_LENGTH = 255;

interface InboxTokenPayload {
  userId: number;
  filename: string;
  /**
   * Whether the uploader also held `pdfInbox.resolve` when the token was
   * minted.
   *
   * The two capabilities are separate on purpose — uploading hands over bytes,
   * resolving says which paper they are — and an admin may raise `resolve`
   * above `upload` in the runtime matrix. The completion callback carries no
   * session (it is Vercel's signed callback, not the user's request), so
   * without this it would auto-attach under the uploader's identity having
   * checked only the upload grant, making `pdfInbox.upload` alone sufficient
   * to create `citation_pdfs` rows and fulfil requests — exactly the
   * separation the split exists to enforce.
   *
   * Decided where the session is, carried in the token Vercel signs, so a
   * client cannot forge it. A role changed in the seconds between minting and
   * completion is not covered, which matches how the single-file route already
   * carries its authorization decision.
   */
  mayResolve: boolean;
}

/**
 * A duplicate drop is an expected event, not an error: the commonest way to
 * use this feature is to drag a download folder in, fetch a few more papers,
 * and drag the whole folder in again.
 */
class DuplicateInboxItemError extends Error {
  constructor() {
    super('These bytes are already in the inbox');
    this.name = 'DuplicateInboxItemError';
  }
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

function readFilename(clientPayload: string | null): string {
  if (!clientPayload) return 'untitled.pdf';
  try {
    const parsed = JSON.parse(clientPayload) as { filename?: unknown };
    const name = typeof parsed.filename === 'string' ? parsed.filename.trim() : '';
    // Strip any path the browser volunteered: it is display text and a match
    // hint, never a storage key, and carrying directories into it would only
    // invite a later reader to treat it as one.
    const base = name.split(/[\\/]/).pop() ?? '';
    return base.slice(0, MAX_FILENAME_LENGTH) || 'untitled.pdf';
  } catch {
    return 'untitled.pdf';
  }
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

  // Same storage-health probe the single-file path uses: the Vercel SDK
  // swallows a token-route error into an opaque browser CORS/400 failure, and
  // a bulk drop would surface that once per file.
  if ((body as { type?: string }).type === STORAGE_PROBE_EVENT) {
    const auth = await getUserFromRequest(req);
    if (!auth) {
      error(res, 401, 'Authentication required');
      return;
    }
    if (!(await callerCan(auth.role, CAP['pdfInbox.upload']))) {
      error(res, 403, 'Contributor role required');
      return;
    }
    try {
      await assertBlobStoreReachable();
    } catch (err) {
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
      error(res, 503, 'PDF storage is not reachable', 'pdf_storage_unavailable');
      return;
    }
    json(res, 200, { ok: true });
    return;
  }

  if (body.type === 'blob.generate-client-token') {
    const auth = await getUserFromRequest(req);
    if (!auth) {
      error(res, 401, 'Authentication required');
      return;
    }
    if (!(await callerCan(auth.role, CAP['pdfInbox.upload']))) {
      error(res, 403, 'Contributor role required');
      return;
    }

    let result: Awaited<ReturnType<typeof handleUpload>>;
    try {
      result = await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: async (pathname, clientPayload) => {
          if (pathname.replace(/^\/+/, '') !== INBOX_BLOB_PATH) {
            throw new Error('Invalid upload pathname');
          }
          const [pending] = await getDb()
            .select({ count: sql<number>`count(*)::int` })
            .from(pdfInboxItems)
            .where(eq(pdfInboxItems.status, 'pending'));
          if ((pending?.count ?? 0) >= MAX_PENDING_INBOX_ITEMS) {
            throw new InboxFullError();
          }
          const payload: InboxTokenPayload = {
            userId: auth.userId,
            filename: readFilename(clientPayload),
            mayResolve: await callerCan(auth.role, CAP['pdfInbox.resolve']),
          };
          return {
            allowedContentTypes: [PDF_CONTENT_TYPE],
            maximumSizeInBytes: MAX_PDF_BYTES,
            addRandomSuffix: true,
            allowOverwrite: false,
            tokenPayload: JSON.stringify(payload),
          };
        },
        onUploadCompleted: async () => {
          // Unreachable for token-generation events.
        },
      });
    } catch (err) {
      if (err instanceof InboxFullError) {
        error(
          res,
          409,
          'The PDF inbox is full; link or discard what is waiting first',
          'pdf_inbox_full',
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
      let filed = false;
      try {
        if (!tokenPayload) throw new Error('Missing token payload');
        const { userId, filename, mayResolve } = JSON.parse(
          tokenPayload,
        ) as InboxTokenPayload;

        // Read the bytes back once: PutBlobResult carries no size or checksum,
        // and the same pass serves the magic check, the content hash and the
        // identifier scan.
        const stored = await get(blob.url, { access: 'private' });
        if (!stored || !stored.stream) throw new Error('Stored blob is not readable');
        const bytes = await readStreamBytesWithLimit(stored.stream, stored.blob.size);
        if (!hasPdfMagic(bytes)) throw new Error('Uploaded file is not a PDF');

        const sha256 = sha256Hex(bytes);
        const extracted = extractPdfIdentifiers(bytes, filename);

        const db = getDb();
        const [item] = await db
          .insert(pdfInboxItems)
          .values({
            blobPathname: blob.pathname,
            blobUrl: blob.url,
            sizeBytes: bytes.byteLength,
            sha256,
            contentType: blob.contentType || PDF_CONTENT_TYPE,
            originalFilename: filename,
            status: 'pending',
            extracted,
            candidates: [],
            matchConfidence: 'none',
            uploadedBy: userId,
          })
          // The partial unique index on `sha256` (excluding discarded rows) is
          // what makes re-dropping the same folder idempotent. Naming the same
          // predicate here is required for Postgres to infer that index.
          .onConflictDoNothing({
            target: pdfInboxItems.sha256,
            where: sql`status <> 'discarded'`,
          })
          .returning({ id: pdfInboxItems.id });
        if (!item) throw new DuplicateInboxItemError();
        filed = true;

        // Matching failing must not undo a successful upload: the item is
        // already in the inbox and a human can link it by hand, which is
        // strictly better than losing the bytes and asking them to fetch the
        // paper again.
        try {
          const match = await matchInboxItem(db, extracted);
          await db
            .update(pdfInboxItems)
            .set({
              candidates: match.candidates,
              matchConfidence: match.confidence,
              matchedCitationId: match.citationId,
            })
            .where(eq(pdfInboxItems.id, item.id));

          // Uploading is not authority to say which paper the bytes are. An
          // uploader without `pdfInbox.resolve` leaves the item matched and
          // waiting, which is the same place an ambiguous match lands and is
          // visible to anyone who does hold it.
          if (mayResolve && mayAutoAttach(match) && match.citationId !== null) {
            await attachInboxItem({
              itemId: item.id,
              citationId: match.citationId,
              userId,
              // An automatic attach may never replace stored full text —
              // `mayAutoAttach` already refuses a citation that has any, and
              // this makes the refusal structural rather than a second
              // reading of the same rule.
              mayReplace: false,
              auto: true,
            });
          }
        } catch (matchErr) {
          await db
            .update(pdfInboxItems)
            .set({
              lastError:
                matchErr instanceof Error ? matchErr.message : String(matchErr),
            })
            .where(eq(pdfInboxItems.id, item.id));
        }
      } catch (err) {
        // Nothing references these bytes yet, so an unfiled blob is pure waste
        // — drop it rather than leaving it to age out of a store nobody lists.
        if (!filed) {
          await del(blob.url).catch(() => undefined);
        }
        // A duplicate is the expected outcome of re-dropping a folder, not a
        // failure to report: the original row is still there and still
        // linkable.
        if (err instanceof DuplicateInboxItemError) return;
        throw err;
      }
    },
  });
  json(res, 200, result);
});

/** The inbox has more unlinked items than {@link MAX_PENDING_INBOX_ITEMS}. */
class InboxFullError extends Error {
  constructor() {
    super('PDF inbox is full');
    this.name = 'InboxFullError';
  }
}
