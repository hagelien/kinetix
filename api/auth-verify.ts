/**
 * OTP code verification endpoint.
 *
 *   POST /api/auth-verify   body: { email, code, stayLoggedIn? }
 *
 * Validates a 6-digit login code, issues a signed JWT cookie scoped to the
 * user's sessionMaxDays, and clears the one-time code. Repeated bad guesses
 * invalidate the active code to make online brute-force attempts impractical,
 * and endpoint throttles cap repeated verification bursts before the DB work.
 * Returns JSON so the frontend can redirect after success.
 *
 * If stayLoggedIn is provided it updates users.sessionMaxDays at this point
 * (the only place the preference change takes effect). Auth-request deliberately
 * does NOT update sessionMaxDays so that an attacker who knows an allowlisted
 * email cannot invalidate a long "stay logged in" session by requesting a code
 * with stayLoggedIn: false.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, eq, sql } from 'drizzle-orm';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import {
  compareMagicLinkCode,
  MAGIC_LINK_CODE_TTL_MS,
  MAX_MAGIC_LINK_FAILURES,
  hasMagicLinkExpired,
  isMagicLinkLockedOut,
} from './_lib/magic-link.js';
import { consumeRateLimit, getClientAddressKey } from './_lib/rate-limit.js';
import { parseAndValidate } from './_lib/validate.js';
import { verifyCodeSchema } from './_lib/schemas.js';
import { signToken, setAuthCookie } from './_lib/auth.js';
import { users } from '../db/schema.js';

const VERIFY_WINDOW_MS = MAGIC_LINK_CODE_TTL_MS;
const VERIFY_EMAIL_LIMIT = 10;
const VERIFY_IP_LIMIT = 25;
const STAY_LOGGED_IN_DAYS = 60;
const DEFAULT_SESSION_DAYS = 30;

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    error(res, 405, 'Method not allowed');
    return;
  }

  const parsed = await parseAndValidate(req, verifyCodeSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const { email, code, stayLoggedIn } = parsed.data;
  const normalizedEmail = email.toLowerCase();
  const clientAddressKey = getClientAddressKey(req);

  const verifyIpLimit = consumeRateLimit(
    'auth-verify-ip',
    clientAddressKey,
    VERIFY_IP_LIMIT,
    VERIFY_WINDOW_MS,
  );
  if (verifyIpLimit.limited) {
    res.setHeader('Retry-After', String(verifyIpLimit.retryAfterSeconds));
    error(
      res,
      429,
      'Too many code verification attempts. Please wait before trying again.',
    );
    return;
  }

  const verifyEmailLimit = consumeRateLimit(
    'auth-verify-email',
    normalizedEmail,
    VERIFY_EMAIL_LIMIT,
    VERIFY_WINDOW_MS,
  );
  if (verifyEmailLimit.limited) {
    res.setHeader('Retry-After', String(verifyEmailLimit.retryAfterSeconds));
    error(
      res,
      429,
      'Too many code verification attempts. Please wait before trying again.',
    );
    return;
  }

  const db = getDb();

  const [user] = await db
    .select({
      id: users.id,
      role: users.role,
      emailVerifiedAt: users.emailVerifiedAt,
      lastAuthAt: users.lastAuthAt,
      updatedAt: users.updatedAt,
      sessionMaxDays: users.sessionMaxDays,
      magicLinkHash: users.magicLinkHash,
      magicLinkExpires: users.magicLinkExpires,
      magicLinkFailedAttempts: users.magicLinkFailedAttempts,
    })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (
    !user ||
    !user.magicLinkHash ||
    hasMagicLinkExpired(user.magicLinkExpires)
  ) {
    error(res, 401, 'Invalid or expired code');
    return;
  }

  if (isMagicLinkLockedOut(user.magicLinkFailedAttempts)) {
    error(res, 401, 'Invalid or expired code');
    return;
  }

  if (!compareMagicLinkCode(user.magicLinkHash, code)) {
    // Keep the failure counter update atomic. PostgreSQL evaluates these CASE
    // expressions against the locked row value, so parallel wrong guesses each
    // consume one slot. The hash predicate also prevents stale attempts for an
    // old code from mutating a newly issued code.
    await db
      .update(users)
      .set({
        magicLinkFailedAttempts: sql`CASE WHEN ${users.magicLinkFailedAttempts} + 1 >= ${MAX_MAGIC_LINK_FAILURES} THEN 0 ELSE ${users.magicLinkFailedAttempts} + 1 END`,
        magicLinkHash: sql`CASE WHEN ${users.magicLinkFailedAttempts} + 1 >= ${MAX_MAGIC_LINK_FAILURES} THEN NULL ELSE ${users.magicLinkHash} END`,
        // magicLinkExpires is intentionally NOT cleared on lockout so that
        // auth-request's cooldown check survives: the timestamp records when
        // the last code was issued regardless of lockout state, preventing an
        // attacker from resetting the cooldown by exhausting the attempt counter.
        // The successful-auth path below still clears it explicitly.
        updatedAt: new Date(),
      })
      .where(
        and(eq(users.id, user.id), eq(users.magicLinkHash, user.magicLinkHash)),
      );

    error(res, 401, 'Invalid or expired code');
    return;
  }

  // Apply the stayLoggedIn preference now — the only place it takes effect.
  // Auth-request deliberately does not update sessionMaxDays so an attacker
  // who knows an allowlisted email cannot downgrade a victim's "stay logged
  // in" session to the shorter duration by requesting a code with
  // stayLoggedIn: false.
  const nextSessionMaxDays =
    stayLoggedIn === true
      ? STAY_LOGGED_IN_DAYS
      : stayLoggedIn === false
        ? DEFAULT_SESSION_DAYS
        : user.sessionMaxDays;

  // Consume the one-time code with compare-and-swap semantics. If another
  // request has already cleared or replaced the hash, reject instead of
  // issuing a JWT from a stale pre-update snapshot.
  const [consumed] = await db
    .update(users)
    .set({
      magicLinkHash: null,
      magicLinkExpires: null,
      magicLinkFailedAttempts: 0,
      emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
      lastAuthAt: new Date(),
      sessionMaxDays: nextSessionMaxDays,
      updatedAt: new Date(),
    })
    .where(
      and(eq(users.id, user.id), eq(users.magicLinkHash, user.magicLinkHash)),
    )
    .returning({ id: users.id });

  if (!consumed) {
    error(res, 401, 'Invalid or expired code');
    return;
  }

  const maxAgeSeconds = nextSessionMaxDays * 24 * 60 * 60;
  const jwt = await signToken(user.id, user.role, maxAgeSeconds);
  setAuthCookie(res, jwt, maxAgeSeconds);

  json(
    res,
    200,
    { success: true },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
