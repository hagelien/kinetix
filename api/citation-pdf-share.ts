/**
 * Temporary share links for stored citation PDFs.
 *
 *   POST ?citationId=N  — mint a link. Requires a session holding BOTH
 *       `citation.pdf.share` (admin by default; delegable down to contributor
 *       from Admin → Permissions) and `citation.pdf.access`, so a delegated
 *       share grant can never outrun the configured read tier. Returns a
 *       relative path plus the token's
 *       expiry; the client makes it absolute against its own origin, so no
 *       part of the shareable URL is taken from a client-controlled Host
 *       header.
 *   GET  ?token=...     — redeem a link. Deliberately UNAUTHENTICATED: the
 *       point of the feature is to hand full text to someone with no Kinetix
 *       account. The token is the credential, it is signed, it names exactly
 *       one citation, it dies after ten minutes, and it stops working the
 *       moment that citation's stored bytes are replaced.
 *
 * Redemption SERVES THE BYTES from kinetix.no whenever the paper fits in a
 * function response (`PROXYABLE_PDF_MAX_BYTES`), and only falls back to a
 * redirect when it does not.
 *
 * Proxying is what makes the link usable by the recipients it exists for. A
 * 302 to `private.blob.vercel-storage.com` is refused by a long tail of link
 * readers — LLM browsing tools, corporate link scanners, mail gateways — none
 * of which will follow a redirect off the domain the link named. They see a
 * dead link, not a paper. A same-origin `application/pdf` body is read by all
 * of them, and by every browser.
 *
 * The redirect is still there for the papers that need it: a function response
 * body is capped at 4.5 MB while stored PDFs run to 50 MB, so large papers
 * cannot pass through here at all. On that path the durable Blob URL is still
 * never handed out — the target is scoped to one object, allows only `get`,
 * expires in a minute, and downloads as an attachment. See
 * `presignStoredPdfUrl`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin } from './_lib/validate.js';
import { consumeRateLimit, getClientAddressKey } from './_lib/rate-limit.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import { citationPdfs } from '../db/schema.js';
import {
  PDF_CONTENT_TYPE,
  PROXYABLE_PDF_MAX_BYTES,
  presignStoredPdfUrl,
  readStoredPdfBytes,
} from './_lib/pdf-storage.js';
import {
  PDF_SHARE_TTL_SECONDS,
  mintPdfShareToken,
  shaPrefixOf,
  verifyPdfShareToken,
} from './_lib/pdf-share-token.js';

/** Path the token is redeemed at. Relative — the client adds its origin. */
export const SHARE_LINK_PATH = '/api/citation-pdf-share';

/**
 * Minting throttles are per user, not per IP: publishing links is the thing
 * being bounded, and the people who may do it are few and identified. Generous
 * enough that nobody hits it while sharing a reading list, tight enough that a
 * stolen session cannot enumerate the corpus into public URLs.
 */
const MINT_LIMIT = 30;
const MINT_WINDOW_MS = 10 * 60 * 1000;

/**
 * Redemption is throttled per IP. The signature already makes guessing
 * hopeless; this only stops a valid link from being turned into a bulk egress
 * tap by whoever it was forwarded to.
 */
const REDEEM_LIMIT = 60;
const REDEEM_WINDOW_MS = 10 * 60 * 1000;

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  );

  switch (req.method) {
    // HEAD is answered exactly like GET — Node drops the body for us. Link
    // readers and mail gateways routinely probe a URL with HEAD before
    // fetching it, and a 405 there is enough for some of them to give up on
    // the link entirely.
    case 'GET':
    case 'HEAD':
      return handleRedeem(req, res, url.searchParams.get('token'));
    case 'POST':
      assertSameOrigin(req);
      // The mint takes no body — everything it needs is the query parameter
      // and the session. Drain anyway so a client that sent one doesn't leave
      // the request stream unread.
      req.resume();
      return handleMint(req, res, Number(url.searchParams.get('citationId')));
    default:
      error(res, 405, 'Method not allowed');
  }
});

async function handleMint(
  req: IncomingMessage,
  res: ServerResponse,
  citationId: number,
): Promise<void> {
  if (!citationId || !Number.isInteger(citationId) || citationId <= 0) {
    error(res, 400, 'Missing or invalid citationId');
    return;
  }

  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  // BOTH capabilities, not just the share one. The two carry independent
  // runtime overrides, and their adjustable ranges overlap: an admin may raise
  // `citation.pdf.access` to admin while delegating `citation.pdf.share` down
  // to contributor. Checking only the latter would let a contributor mint a
  // link and read through it the very bytes the configured read tier denies
  // them — a link that needs no account is a superset of reading, never a way
  // around it. Requiring the conjunction costs nothing under the defaults
  // (`access` contributor, `share` admin: an admin holds both) and is the same
  // shape as the other pairs in docs/permissions.md.
  if (
    !(await callerCan(auth.role, CAP['citation.pdf.share'])) ||
    !(await callerCan(auth.role, CAP['citation.pdf.access']))
  ) {
    error(
      res,
      403,
      'Sharing stored full text requires the admin role',
      'pdf_share_forbidden',
    );
    return;
  }

  const throttle = consumeRateLimit(
    'pdf-share-mint',
    `user:${auth.userId}`,
    MINT_LIMIT,
    MINT_WINDOW_MS,
  );
  if (throttle.limited) {
    error(
      res,
      429,
      'Too many share links requested; try again shortly',
      'pdf_share_rate_limited',
    );
    return;
  }

  const [stored] = await getDb()
    .select({ sha256: citationPdfs.sha256 })
    .from(citationPdfs)
    .where(eq(citationPdfs.citationId, citationId))
    .limit(1);
  if (!stored) {
    error(
      res,
      404,
      'No PDF stored for this citation',
      'pdf_share_no_pdf',
    );
    return;
  }

  const { token, expiresAt } = mintPdfShareToken({
    citationId,
    sha256: stored.sha256,
    issuedBy: auth.userId,
  });

  // Who published a link to which paper is worth having in the function log:
  // the link itself carries no session, so this is the only record of who
  // authorized the downloads that follow.
  console.info(
    'KINETIX_PDF_SHARE ' +
      JSON.stringify({
        event: 'minted',
        citationId,
        userId: auth.userId,
        expiresAt: expiresAt.toISOString(),
      }),
  );

  json(
    res,
    201,
    {
      path: `${SHARE_LINK_PATH}?token=${encodeURIComponent(token)}`,
      expiresAt: expiresAt.toISOString(),
      expiresInSeconds: PDF_SHARE_TTL_SECONDS,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

async function handleRedeem(
  req: IncomingMessage,
  res: ServerResponse,
  token: string | null,
): Promise<void> {
  if (!token) {
    error(res, 400, 'Missing share token', 'pdf_share_token_missing');
    return;
  }

  const throttle = consumeRateLimit(
    'pdf-share-redeem',
    getClientAddressKey(req),
    REDEEM_LIMIT,
    REDEEM_WINDOW_MS,
  );
  if (throttle.limited) {
    error(
      res,
      429,
      'Too many download attempts; try again shortly',
      'pdf_share_rate_limited',
    );
    return;
  }

  const verified = verifyPdfShareToken(token);
  if (!verified.ok) {
    if (verified.reason === 'expired') {
      error(res, 410, 'This download link has expired', 'pdf_share_expired');
      return;
    }
    error(res, 403, 'Invalid download link', 'pdf_share_invalid');
    return;
  }

  const { citationId, shaPrefix } = verified.payload;
  const [stored] = await getDb()
    .select({
      blobPathname: citationPdfs.blobPathname,
      blobUrl: citationPdfs.blobUrl,
      sizeBytes: citationPdfs.sizeBytes,
      contentType: citationPdfs.contentType,
      sha256: citationPdfs.sha256,
    })
    .from(citationPdfs)
    .where(eq(citationPdfs.citationId, citationId))
    .limit(1);
  // A link outlives neither the asset nor the *version* of the asset it was
  // minted for. Both cases read as "this link is no longer good" rather than
  // "no such paper", which is also all an outsider should learn.
  if (!stored || shaPrefixOf(stored.sha256) !== shaPrefix) {
    error(res, 410, 'This download link is no longer valid', 'pdf_share_stale');
    return;
  }

  // Serve the bytes from this origin when the paper fits. `sizeBytes` is the
  // recorded length of the stored object, so the decision is made before
  // anything is read — a 40 MB paper is never pulled into the function only to
  // discover it cannot be sent.
  if (stored.sizeBytes > 0 && stored.sizeBytes <= PROXYABLE_PDF_MAX_BYTES) {
    // A HEAD probe is answered from the stored row alone. Node discards a body
    // written to a HEAD response, so reading the object would buy nothing and
    // cost a full Blob download — paid again moments later by the GET the
    // probe precedes, and slow enough that some readers give up before it
    // arrives. `size_bytes` is the recorded length of exactly these bytes, so
    // the Content-Length is the same number the GET reports.
    if (req.method === 'HEAD') {
      res.writeHead(
        200,
        proxyHeaders(citationId, stored.contentType, stored.sizeBytes),
      );
      res.end();
      return;
    }

    const bytes = await readStoredPdfBytes(stored.blobUrl).catch(
      (err: unknown) => {
        console.error('KINETIX_PDF_SHARE proxy read failed', err);
        return null;
      },
    );
    // A read that fails here is not fatal: the redirect below reaches the same
    // object by a different route, so fall through rather than 502 on a link
    // that can still be honoured.
    if (bytes) {
      res.writeHead(
        200,
        proxyHeaders(citationId, stored.contentType, bytes.byteLength),
      );
      res.end(bytes);
      return;
    }
  }

  let downloadUrl: string;
  try {
    downloadUrl = await presignStoredPdfUrl(stored.blobPathname);
  } catch (err) {
    console.error('KINETIX_PDF_SHARE presign failed', err);
    error(res, 502, 'Stored PDF is currently unavailable');
    return;
  }

  res.writeHead(302, {
    Location: downloadUrl,
    // Never cached anywhere: the redirect carries a signed URL, and a copy of
    // it sitting in a proxy cache would outlive the link's own expiry.
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  res.end();
}

/**
 * Headers for a PDF served from this origin. Shared by the GET body and the
 * HEAD probe so a reader that checks before it fetches cannot be told one
 * thing and handed another.
 */
function proxyHeaders(
  citationId: number,
  contentType: string,
  sizeBytes: number,
): Record<string, string> {
  return {
    'Content-Type': contentType || PDF_CONTENT_TYPE,
    'Content-Length': String(sizeBytes),
    // Attachment, not inline — the same defence the agent read takes, so a
    // hostile PDF's JavaScript never runs in the recipient's browser viewer.
    // Fetchers that read the link programmatically are unaffected; they take
    // the body and the content type.
    'Content-Disposition': `attachment; filename="citation-${citationId}.pdf"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow',
  };
}
