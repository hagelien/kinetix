/**
 * Citation PDFs — fulfil a request by URL, and serve the stored bytes to the
 * agents that read them.
 *   POST ?citationId=N  { url }  — contributor only; server fetches the URL
 *       once, validates it is a PDF within the size cap, persists a durable
 *       copy to Blob, and closes the open request.
 *   GET  ?citationId=N           — **active agents only**; streams the stored
 *       PDF when it fits in a function response, otherwise redirects to a
 *       short-lived, GET-only presigned Blob URL. The durable Blob URL is
 *       never exposed to clients.
 *
 * The GET used to serve any caller holding `citation.pdf.access`, which made
 * Kinetix a general download mirror for licensed full text: a contributor
 * could pull down the publisher's PDF for any paper anyone had uploaded. That
 * is redistribution, and nothing about the product needs it — a person who
 * wants to read the paper follows the citation's own source link
 * (`citationExternalHref`, rendered on every reference page). So the human
 * download is gone.
 *
 * What is left is the machine read: the review and extraction agents fetch
 * these bytes to derive facts from them (agents/drug-db-maintainer.md §11,
 * agents/paper-fact-extractor.md), which is the reason contributors are asked
 * to supply full text in the first place. That path never puts the file in a
 * person's hands, so it stays — restricted to callers that back an active
 * agent, which in practice means a `kxat_` agent token.
 *
 * The one deliberate exception for people is `POST /api/citation-pdf-share`:
 * an admin decision, logged, and expiring in ten minutes.
 */
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { del, put } from '@vercel/blob';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { submitPdfUrlSchema } from './_lib/schemas.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import { isActiveAgentUser } from './_lib/agent-verifications.js';
import { citationPdfs, citations, pdfRequests } from '../db/schema.js';
import {
  MAX_PDF_BYTES,
  PDF_CONTENT_TYPE,
  PROXYABLE_PDF_MAX_BYTES,
  PdfReplacementInFlightError,
  PdfRequestNotOpenError,
  assertNoOpenExtractionJob,
  hasPdfMagic,
  presignStoredPdfUrl,
  readStoredPdfBytes,
  recordCitationPdf,
  sha256Hex,
} from './_lib/pdf-storage.js';

const MAX_REDIRECTS = 5;
const PDF_FETCH_TIMEOUT_MS = 10_000;

interface ResolvedPublicUrl {
  url: URL;
  address: string;
  family: 4 | 6;
}

interface PinnedResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  bytes: Uint8Array;
}

interface PinnedRequestResult {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

class PdfFetchError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true;
  }
  const [a, b, c] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function mappedIPv4(address: string): string | null {
  const normalized = address.toLowerCase();
  const mappedDotted = normalized.match(
    /^(?:::ffff:|0:0:0:0:0:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/,
  )?.[1];
  if (mappedDotted) return mappedDotted;

  const mappedHex = normalized.match(
    /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );
  const compatibleDotted = normalized.match(
    /^(?:::|0:0:0:0:0:0:)(\d{1,3}(?:\.\d{1,3}){3})$/,
  )?.[1];
  if (compatibleDotted) return compatibleDotted;

  const compatibleHex = normalized.match(
    /^(?:::|0:0:0:0:0:0:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );

  const hex = mappedHex ?? compatibleHex;
  if (!hex) return null;

  const high = Number.parseInt(hex[1]!, 16);
  const low = Number.parseInt(hex[2]!, 16);
  if (high > 0xffff || low > 0xffff) return null;

  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(
    '.',
  );
}

/**
 * Extract the embedded IPv4 from a 6to4 address (RFC 3056, 2002::/16).
 * The 17th–48th bits encode a 32-bit IPv4 address: 2002:aabb:ccdd::/48
 * maps to a.b.c.d. Returns null for non-6to4 addresses.
 */
function expandIPv6Hextets(address: string): number[] | null {
  const parsePart = (part: string): number | null => {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    const value = Number.parseInt(part, 16);
    return value <= 0xffff ? value : null;
  };
  const expandIPv4Tail = (parts: string[]): string[] | null => {
    const dottedIndex = parts.findIndex((part) => part.includes('.'));
    if (dottedIndex === -1) return parts;
    if (dottedIndex !== parts.length - 1) return null;

    const bytes = parts[dottedIndex]!.split('.').map(Number);
    if (
      bytes.length !== 4 ||
      bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
    ) {
      return null;
    }

    const [a, b, c, d] = bytes as [number, number, number, number];
    return [
      ...parts.slice(0, -1),
      ((a << 8) | b).toString(16),
      ((c << 8) | d).toString(16),
    ];
  };

  const halves = address.split('::');
  if (halves.length > 2) return null;

  const rawLeft = halves[0] ? halves[0].split(':') : [];
  const rawRight = halves[1] ? halves[1].split(':') : [];
  if (rawLeft.some((part) => part.includes('.')) && rawRight.length > 0) {
    return null;
  }
  const left = expandIPv4Tail(rawLeft);
  const right = expandIPv4Tail(rawRight);
  if (!left || !right) return null;
  if (left.some((part) => part === '') || right.some((part) => part === '')) {
    return null;
  }

  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0) return null;
  const parts =
    halves.length === 2
      ? [...left, ...Array<string>(missing).fill('0'), ...right]
      : left;
  if (parts.length !== 8) return null;

  const parsed = parts.map(parsePart);
  return parsed.every((part): part is number => part !== null) ? parsed : null;
}

function embedded6to4IPv4(address: string): string | null {
  const hextets = expandIPv6Hextets(address);
  if (!hextets || hextets[0] !== 0x2002) return null;
  const high = hextets[1]!;
  const low = hextets[2]!;
  if (high > 0xffff || low > 0xffff) return null;
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(
    '.',
  );
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase();
  const mapped = mappedIPv4(normalized);
  if (mapped) return isPrivateIPv4(mapped);
  const v6to4 = embedded6to4IPv4(normalized);
  if (v6to4) return isPrivateIPv4(v6to4);
  const hextets = expandIPv6Hextets(normalized);
  if (hextets?.[0] === 0x2001 && hextets[1] === 0x0000) return true;
  // The all-zeros address (RFC 4291 §2.5.2) is the IPv6 unspecified address,
  // equivalent to 0.0.0.0.  The canonical form '::' is caught by the string
  // check below, but non-canonical spellings like '::0' or '0:0:0:0:0:0:0:0'
  // also expand to all zeros via expandIPv6Hextets and must be blocked.
  if (hextets?.every((h) => h === 0)) return true;
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff') ||
    normalized.startsWith('64:ff9b:') ||
    normalized.startsWith('2001:db8:')
  );
}

function hostnameForLookup(url: URL): string {
  return url.hostname.replace(/^\[/, '').replace(/\]$/, '');
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) return isPrivateIPv6(address);
  return true;
}

function isTimeoutError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    err.name === 'TimeoutError'
  );
}

function headersFromIncoming(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    } else if (value !== undefined) {
      result.set(key, String(value));
    }
  }
  return result;
}

async function resolvePublicHttpUrl(
  value: string | URL,
): Promise<ResolvedPublicUrl> {
  let parsed: URL;
  try {
    parsed = value instanceof URL ? value : new URL(value);
  } catch {
    throw new PdfFetchError(400, 'Invalid PDF URL', 'pdf_fetch_failed');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PdfFetchError(400, 'Invalid PDF URL', 'pdf_fetch_failed');
  }
  if (parsed.username || parsed.password) {
    throw new PdfFetchError(400, 'Invalid PDF URL', 'pdf_fetch_failed');
  }
  if (
    parsed.hostname === 'localhost' ||
    parsed.hostname.endsWith('.localhost') ||
    parsed.hostname.endsWith('.local')
  ) {
    throw new PdfFetchError(
      400,
      'URL host is not allowed',
      'pdf_fetch_forbidden_host',
    );
  }

  const hostname = hostnameForLookup(parsed);
  const literalVersion = isIP(hostname);
  let addresses: { address: string; family: number }[];
  try {
    addresses =
      literalVersion === 0
        ? await lookup(hostname, { all: true, verbatim: true })
        : [{ address: hostname, family: literalVersion }];
  } catch {
    throw new PdfFetchError(
      400,
      'Could not resolve the provided URL',
      'pdf_fetch_failed',
    );
  }
  if (
    addresses.length === 0 ||
    addresses.some((entry) => isPrivateAddress(entry.address))
  ) {
    throw new PdfFetchError(
      400,
      'URL host is not allowed',
      'pdf_fetch_forbidden_host',
    );
  }
  const first = addresses[0]!;
  return { url: parsed, address: first.address, family: first.family as 4 | 6 };
}

function requestPinnedUrl(
  resolved: ResolvedPublicUrl,
): Promise<PinnedRequestResult> {
  return new Promise((resolve, reject) => {
    const transport =
      resolved.url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const req = transport(
      resolved.url,
      {
        method: 'GET',
        lookup: (_hostname, _options, callback) => {
          callback(null, resolved.address, resolved.family);
        },
      },
      (response) => {
        const headers = headersFromIncoming(response.headers);
        const status = response.statusCode ?? 0;
        const declaredLength = Number(headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_BYTES) {
          response.resume();
          fail(
            new PdfFetchError(
              413,
              'PDF exceeds the size limit',
              'pdf_too_large',
            ),
          );
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.byteLength;
          if (total > MAX_PDF_BYTES) {
            response.destroy(
              new PdfFetchError(
                413,
                'PDF exceeds the size limit',
                'pdf_too_large',
              ),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on('error', fail);
        response.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            status,
            headers,
            bytes: Buffer.concat(chunks, total),
          });
        });
      },
    );
    req.setTimeout(PDF_FETCH_TIMEOUT_MS, () => {
      req.destroy(
        new PdfFetchError(
          408,
          'Timed out fetching the provided URL',
          'pdf_fetch_timeout',
        ),
      );
    });
    req.on('error', fail);
    req.end();
  });
}

async function fetchPublicUrl(url: string): Promise<PinnedResponse> {
  let current = await resolvePublicHttpUrl(url);
  for (
    let redirectCount = 0;
    redirectCount <= MAX_REDIRECTS;
    redirectCount += 1
  ) {
    let response: PinnedRequestResult;
    try {
      response = await requestPinnedUrl(current);
    } catch (err) {
      if (err instanceof PdfFetchError) {
        throw err;
      }
      if (isTimeoutError(err)) {
        throw new PdfFetchError(
          408,
          'Timed out fetching the provided URL',
          'pdf_fetch_timeout',
        );
      }
      throw new PdfFetchError(
        400,
        'Could not fetch the provided URL',
        'pdf_fetch_failed',
      );
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new PdfFetchError(
          400,
          'Could not fetch the provided URL',
          'pdf_fetch_failed',
        );
      }
      current = await resolvePublicHttpUrl(new URL(location, current.url));
      continue;
    }

    return {
      ...response,
      ok: response.status >= 200 && response.status < 300,
    };
  }

  throw new PdfFetchError(
    400,
    'Too many redirects fetching the provided URL',
    'pdf_fetch_failed',
  );
}

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  );
  const citationId = Number(url.searchParams.get('citationId'));
  if (!citationId || !Number.isInteger(citationId) || citationId <= 0) {
    error(res, 400, 'Missing or invalid citationId');
    return;
  }

  switch (req.method) {
    case 'GET':
      return handleGet(req, res, citationId);
    case 'POST':
      assertSameOrigin(req);
      return handleSubmitUrl(req, res, citationId);
    default:
      error(res, 405, 'Method not allowed');
  }
});

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  citationId: number,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  if (!(await callerCan(auth.role, CAP['citation.pdf.access']))) {
    error(res, 403, 'Contributor role required');
    return;
  }
  // Machine readers only — see the module note. The capability check above
  // still runs first so an admin who narrows `citation.pdf.access` shuts the
  // stored bytes off entirely, agents included; this narrows it further to
  // callers that actually extract from the paper rather than read it.
  if (!(await isActiveAgentUser(auth.userId))) {
    error(
      res,
      403,
      'Stored full text is not downloadable; open the paper from its source link',
      'pdf_download_removed',
    );
    return;
  }

  const db = getDb();
  const [row] = await db
    .select({
      blobPathname: citationPdfs.blobPathname,
      blobUrl: citationPdfs.blobUrl,
      sizeBytes: citationPdfs.sizeBytes,
      contentType: citationPdfs.contentType,
    })
    .from(citationPdfs)
    .where(eq(citationPdfs.citationId, citationId))
    .limit(1);
  if (!row) {
    error(res, 404, 'No PDF stored for this citation');
    return;
  }

  // Keep the common case on kinetix.no, but never pull a PDF through the
  // function when its recorded size exceeds the response-body ceiling.
  // This is the same split used by citation-pdf-share: small papers are
  // proxied; large papers get a one-object, GET-only, 60-second Blob URL.
  if (row.sizeBytes > 0 && row.sizeBytes <= PROXYABLE_PDF_MAX_BYTES) {
    const bytes = await readStoredPdfBytes(row.blobUrl).catch(
      (err: unknown) => {
        console.error('KINETIX_AGENT_PDF proxy read failed', err);
        return null;
      },
    );
    if (bytes) {
      res.writeHead(200, {
        'Content-Type': row.contentType || PDF_CONTENT_TYPE,
        'Content-Length': String(bytes.byteLength),
        // Force download rather than inline rendering to prevent PDF JavaScript
        // from executing in the browser's PDF renderer (defense-in-depth).
        'Content-Disposition': 'attachment; filename="paper.pdf"',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      });
      res.end(bytes);
      return;
    }
  }

  // A proxy read can fail independently of Blob download delivery, so the
  // presigned handoff is also a fallback for a small paper whose SDK read
  // failed. The durable blobUrl never leaves the server.
  let downloadUrl: string;
  try {
    downloadUrl = await presignStoredPdfUrl(row.blobPathname);
  } catch (err) {
    console.error('KINETIX_AGENT_PDF presign failed', err);
    error(res, 502, 'Stored PDF is currently unavailable');
    return;
  }

  res.writeHead(302, {
    Location: downloadUrl,
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  res.end();
}

async function handleSubmitUrl(
  req: IncomingMessage,
  res: ServerResponse,
  citationId: number,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  if (!(await callerCan(auth.role, CAP['citation.pdf.access']))) {
    error(res, 403, 'Contributor role required');
    return;
  }

  const parsed = await parseAndValidate(req, submitPdfUrlSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const db = getDb();
  const [citation] = await db
    .select({ id: citations.id, type: citations.type })
    .from(citations)
    .where(eq(citations.id, citationId))
    .limit(1);
  if (!citation) {
    error(res, 404, 'Citation not found');
    return;
  }
  if (citation.type === 'freetext') {
    error(
      res,
      400,
      'Citation is not resolvable',
      'pdf_request_unresolvable_citation',
    );
    return;
  }

  const [openRequest] = await db
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
    .limit(1);
  if (!openRequest) {
    error(
      res,
      409,
      'No open PDF request exists for this citation',
      'pdf_request_not_open',
    );
    return;
  }
  // Same tier to fulfil a replacement as to open one — see the client-upload
  // route and `pdf_requests.is_replacement`. Both fulfilment paths have to
  // carry this or the editor gate is decorative.
  if (
    openRequest.isReplacement &&
    !(await callerCan(auth.role, CAP['citation.pdf.replace']))
  ) {
    error(
      res,
      403,
      'Replacing stored full text requires the editor role',
      'pdf_replace_requires_editor',
    );
    return;
  }
  // Same reason as the client-upload route: the create-time guard cannot cover
  // the gap between opening the request and fulfilling it.
  if (openRequest.isReplacement) {
    try {
      await assertNoOpenExtractionJob(citationId);
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
      throw err;
    }
  }

  // Look up any existing blob URL so we can delete the old object after a
  // successful re-upload. Must run before the new put() so we have the old
  // URL even if the DB upsert races.
  const [existingPdf] = await db
    .select({ blobUrl: citationPdfs.blobUrl })
    .from(citationPdfs)
    .where(eq(citationPdfs.citationId, citationId))
    .limit(1);

  let upstream: PinnedResponse;
  try {
    upstream = await fetchPublicUrl(parsed.data.url);
  } catch (err) {
    if (err instanceof PdfFetchError) {
      error(res, err.status, err.message, err.code);
      return;
    }
    error(res, 400, 'Could not fetch the provided URL', 'pdf_fetch_failed');
    return;
  }
  if (!upstream.ok) {
    error(res, 400, 'Could not fetch the provided URL', 'pdf_fetch_failed');
    return;
  }

  const bytes = upstream.bytes;

  if (!hasPdfMagic(bytes)) {
    error(res, 400, 'The URL does not point to a PDF', 'pdf_not_a_pdf');
    return;
  }

  // Use a per-upload random nonce so the blob path is unguessable even when
  // the Blob store URL becomes known (e.g., from a client-direct upload).
  // Sequential citationId paths would let anyone enumerate all stored PDFs.
  const nonce = randomBytes(16).toString('hex');
  const blob = await put(
    `citation-pdfs/${citationId}-${nonce}.pdf`,
    Buffer.from(bytes),
    {
      access: 'private',
      contentType: PDF_CONTENT_TYPE,
    },
  );

  try {
    await recordCitationPdf({
      citationId,
      pdfRequestId: openRequest.id,
      pdfRequestCreatedAt: openRequest.createdAt,
      blobPathname: blob.pathname,
      blobUrl: blob.url,
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      contentType: PDF_CONTENT_TYPE,
      source: 'url',
      sourceUrl: parsed.data.url,
      uploadedBy: auth.userId,
    });
  } catch (err) {
    await del(blob.url).catch(() => undefined);
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

  // Best-effort cleanup: delete the previous blob now that the DB points to
  // the new one. A failure here only leaks storage, not security.
  if (existingPdf?.blobUrl && existingPdf.blobUrl !== blob.url) {
    del(existingPdf.blobUrl).catch(() => undefined);
  }

  json(res, 201, { ok: true });
}
