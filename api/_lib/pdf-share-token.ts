/**
 * Short-lived, bearer-style download tokens for stored citation PDFs.
 *
 * `GET /api/citation-pdf` streams the bytes to the extraction agents, and to
 * nobody else — a person is never served a stored publisher PDF through it.
 * This module mints the one deliberate exception to that: a URL that carries
 * its own authorization, works for anyone who has it, and stops working
 * shortly after, so an admin can hand a paper to a co-author, a laboratory
 * contact or a reviewer with no account without that becoming a standing
 * download for every contributor.
 *
 * The token is stateless and signed, so there is no table to migrate and no
 * row to clean up. Three properties make that safe enough for the ten-minute
 * window it is meant to cover:
 *
 *  - **Domain-separated key.** The HMAC key is derived from `JWT_SECRET`
 *    through a fixed label, so a share token is not a session token with a
 *    different payload and neither can ever be verified as the other.
 *  - **Bound to the bytes.** The payload carries a prefix of the stored PDF's
 *    SHA-256. Replacing a citation's full text (`citation.pdf.replace`)
 *    therefore invalidates every outstanding link for it — which is also the
 *    only revocation lever there is, and the reason the TTL is minutes rather
 *    than days.
 *  - **Bound to one citation.** A token minted for one paper cannot be
 *    replayed against another; the citation id is inside the signed payload
 *    rather than in a query parameter beside it.
 *
 * `issuedBy` is not used for authorization on redemption — the whole point is
 * that the redeemer has no session — but it travels in the payload so the
 * download can be logged against the person who published the link.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Default lifetime of a share link. Deliberately short: see above. */
export const PDF_SHARE_TTL_SECONDS = 10 * 60;

/**
 * Version prefix. Bumping it retires every outstanding token at once, which
 * is the escape hatch if the payload shape ever has to change.
 */
const TOKEN_VERSION = 'k1';

/** Fixed label mixed into the key derivation — see the module note. */
const KEY_LABEL = 'kinetix:pdf-share:v1';

/**
 * How much of the stored SHA-256 the payload carries. This is an integrity
 * *binding*, not a secret: the signature is what makes the token
 * unforgeable, so a prefix long enough to make an accidental collision
 * impossible is all that is needed, and it keeps the URL short.
 */
const SHA_PREFIX_LENGTH = 16;

export interface PdfShareTokenPayload {
  /** Citation the token authorizes, and only that citation. */
  citationId: number;
  /** Prefix of the stored PDF's SHA-256 at mint time. */
  shaPrefix: string;
  /** User id that published the link, for logging. */
  issuedBy: number;
  /** Expiry, as epoch seconds. */
  expiresAtSeconds: number;
}

export type PdfShareTokenFailure =
  | 'malformed'
  | 'bad_signature'
  | 'expired';

export type PdfShareTokenResult =
  | { ok: true; payload: PdfShareTokenPayload }
  | { ok: false; reason: PdfShareTokenFailure };

function signingKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return createHmac('sha256', secret).update(KEY_LABEL).digest();
}

function sign(signedPart: string): string {
  return createHmac('sha256', signingKey()).update(signedPart).digest('base64url');
}

export function shaPrefixOf(sha256: string): string {
  return sha256.slice(0, SHA_PREFIX_LENGTH);
}

/**
 * Mint a token for a citation whose stored PDF hashes to `sha256`.
 * `ttlSeconds` is clamped to a sane band so a caller cannot mint a link that
 * outlives the review of the decision to share it.
 */
export function mintPdfShareToken(args: {
  citationId: number;
  sha256: string;
  issuedBy: number;
  ttlSeconds?: number;
  now?: number;
}): { token: string; expiresAt: Date } {
  const now = args.now ?? Date.now();
  const ttl = Math.min(
    Math.max(args.ttlSeconds ?? PDF_SHARE_TTL_SECONDS, 60),
    60 * 60,
  );
  const expiresAtSeconds = Math.floor(now / 1000) + ttl;
  const payload: PdfShareTokenPayload = {
    citationId: args.citationId,
    shaPrefix: shaPrefixOf(args.sha256),
    issuedBy: args.issuedBy,
    expiresAtSeconds,
  };
  // Short keys: the token lands in a URL people paste into chat windows.
  const encoded = Buffer.from(
    JSON.stringify({
      c: payload.citationId,
      s: payload.shaPrefix,
      u: payload.issuedBy,
      e: payload.expiresAtSeconds,
    }),
  ).toString('base64url');
  const signedPart = `${TOKEN_VERSION}.${encoded}`;
  return {
    token: `${signedPart}.${sign(signedPart)}`,
    expiresAt: new Date(expiresAtSeconds * 1000),
  };
}

function signaturesMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  // timingSafeEqual throws on a length mismatch, which is itself a leak-free
  // answer: a wrong-length signature cannot be a valid one.
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Verify and decode a token. Never throws on attacker-controlled input. */
export function verifyPdfShareToken(
  token: string,
  now: number = Date.now(),
): PdfShareTokenResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [version, encoded, signature] = parts as [string, string, string];
  if (version !== TOKEN_VERSION || !encoded || !signature) {
    return { ok: false, reason: 'malformed' };
  }
  if (!signaturesMatch(sign(`${version}.${encoded}`), signature)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Only decode AFTER the signature holds, so the JSON parser is never
  // exercised on bytes an outsider chose.
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const claims = raw as Record<string, unknown>;
  const citationId = claims.c;
  const shaPrefix = claims.s;
  const issuedBy = claims.u;
  const expiresAtSeconds = claims.e;
  if (
    typeof citationId !== 'number' ||
    !Number.isInteger(citationId) ||
    citationId <= 0 ||
    typeof shaPrefix !== 'string' ||
    !shaPrefix ||
    typeof issuedBy !== 'number' ||
    typeof expiresAtSeconds !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (expiresAtSeconds * 1000 <= now) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    payload: { citationId, shaPrefix, issuedBy, expiresAtSeconds },
  };
}
