/**
 * Auth code request endpoint.
 *
 *   POST /api/auth-request   body: { email, stayLoggedIn? }
 *
 * Validates that the email is in allowed_emails or its domain is in
 * allowed_email_domains, then generates a 6-digit OTP code, stores its
 * sha256 on the user row, resets the failed-attempt counter, and emails
 * the code to the user.
 *
 * Returns a generic success body for allowlist misses, but rate-limits abusive
 * request bursts with a 429 before any DB writes or email delivery.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomInt, randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, lte, or } from 'drizzle-orm';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import {
  MAGIC_LINK_CODE_TTL_MS,
  hasMagicLinkExpired,
  hashMagicLinkCode,
} from './_lib/magic-link.js';
import { consumeRateLimit, getClientAddressKey } from './_lib/rate-limit.js';
import { parseAndValidate } from './_lib/validate.js';
import { requestMagicLinkSchema } from './_lib/schemas.js';
import { users, allowedEmails, allowedEmailDomains } from '../db/schema.js';
import { sendLoginCode } from './_lib/email.js';
import { DEFAULT_NEW_USER_ROLE } from '../src/lib/roles.js';

const STAY_LOGGED_IN_DAYS = 60;
const DEFAULT_SESSION_DAYS = 30;
const REQUEST_EMAIL_LIMIT = 3;
const REQUEST_IP_LIMIT = 10;
// Minimum interval between issuing two OTP codes for the same email address.
// Enforced at the DB level (checked against magicLinkExpires) so it holds
// across all serverless instances, unlike the in-memory rate limiter above.
const ISSUE_COOLDOWN_MS = 60_000;

function generateCode(): string {
  return String(randomInt(100_000, 1_000_000));
}

async function isEmailAllowed(email: string): Promise<boolean> {
  const db = getDb();
  const lower = email.toLowerCase();
  const [allowed] = await db
    .select({ id: allowedEmails.id })
    .from(allowedEmails)
    .where(eq(allowedEmails.email, lower))
    .limit(1);
  if (allowed) return true;

  const at = lower.indexOf('@');
  if (at === -1) return false;
  const domain = lower.slice(at + 1);
  const [domainAllowed] = await db
    .select({ id: allowedEmailDomains.id })
    .from(allowedEmailDomains)
    .where(eq(allowedEmailDomains.domain, domain))
    .limit(1);
  return !!domainAllowed;
}

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    error(res, 405, 'Method not allowed');
    return;
  }

  const parsed = await parseAndValidate(req, requestMagicLinkSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const email = parsed.data.email.toLowerCase();
  const sessionMaxDays = parsed.data.stayLoggedIn
    ? STAY_LOGGED_IN_DAYS
    : DEFAULT_SESSION_DAYS;
  const clientAddressKey = getClientAddressKey(req);

  const genericReply = () =>
    json(
      res,
      200,
      {
        message:
          'If that email is on the allowlist, a sign-in code has been sent. Check your inbox.',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );

  const requestIpLimit = consumeRateLimit(
    'auth-request-ip',
    clientAddressKey,
    REQUEST_IP_LIMIT,
    MAGIC_LINK_CODE_TTL_MS,
  );
  if (requestIpLimit.limited) {
    res.setHeader('Retry-After', String(requestIpLimit.retryAfterSeconds));
    error(
      res,
      429,
      'Too many sign-in requests. Please wait before requesting another code.',
    );
    return;
  }

  const requestEmailLimit = consumeRateLimit(
    'auth-request-email',
    email,
    REQUEST_EMAIL_LIMIT,
    MAGIC_LINK_CODE_TTL_MS,
  );
  if (requestEmailLimit.limited) {
    res.setHeader('Retry-After', String(requestEmailLimit.retryAfterSeconds));
    error(
      res,
      429,
      'Too many sign-in requests. Please wait before requesting another code.',
    );
    return;
  }

  if (!(await isEmailAllowed(email))) {
    // Pretend to succeed to avoid email enumeration.
    return genericReply();
  }

  const db = getDb();

  // Look up or create the user row
  let [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) {
    const defaultUsername =
      email.split('@')[0]?.slice(0, 100) ?? email.slice(0, 100);
    // Avoid unique collisions on username by appending random suffix on failure
    try {
      [user] = await db
        .insert(users)
        .values({
          email,
          username: defaultUsername,
          role: DEFAULT_NEW_USER_ROLE,
          sessionMaxDays,
        })
        .returning();
    } catch {
      const suffix = randomBytes(3).toString('hex');
      [user] = await db
        .insert(users)
        .values({
          email,
          username: `${defaultUsername.slice(0, 90)}-${suffix}`,
          role: DEFAULT_NEW_USER_ROLE,
          sessionMaxDays,
        })
        .returning();
    }
  }

  if (!user) {
    error(res, 500, 'Failed to create user');
    return;
  }

  // Read-side guard: fast-path return when we can already see the cooldown
  // hasn't elapsed. Not a security gate — the atomic write below is the
  // authoritative check. magicLinkExpires is keyed on issue time, not on
  // whether the hash is still active, so it survives both successful auth
  // (cleared) and lockout (preserved intentionally in auth-verify.ts).
  if (
    user.magicLinkExpires &&
    !hasMagicLinkExpired(user.magicLinkExpires) &&
    Date.now() - (user.magicLinkExpires.getTime() - MAGIC_LINK_CODE_TTL_MS) <
      ISSUE_COOLDOWN_MS
  ) {
    return genericReply();
  }

  const code = generateCode();
  const codeHash = hashMagicLinkCode(code);
  const expires = new Date(Date.now() + MAGIC_LINK_CODE_TTL_MS);
  // The largest magicLinkExpires value that satisfies "cooldown has elapsed":
  // issuedAt = expiresAt - TTL  ≤  now - COOLDOWN_MS
  //   ↔  expiresAt  ≤  now - COOLDOWN_MS + TTL
  const cooldownGate = new Date(
    Date.now() - ISSUE_COOLDOWN_MS + MAGIC_LINK_CODE_TTL_MS,
  );

  // Atomic write: include the cooldown predicate in the WHERE clause so that
  // concurrent requests on different serverless instances cannot both slip
  // past the read-side check above and each send a separate email. Only the
  // first request whose update matches will proceed; the rest get no rows
  // back and return the generic success silently.
  //
  // Do NOT update sessionMaxDays here for existing users — see comment in
  // the original auth-request flow; sessionMaxDays is applied in auth-verify.
  const [updated] = await db
    .update(users)
    .set({
      magicLinkHash: codeHash,
      magicLinkExpires: expires,
      magicLinkFailedAttempts: 0,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(users.id, user.id),
        or(
          isNull(users.magicLinkExpires),          // no code ever issued
          lt(users.magicLinkExpires, new Date()),   // previous code expired
          lte(users.magicLinkExpires, cooldownGate), // cooldown has elapsed
        ),
      ),
    )
    .returning({ id: users.id });

  if (!updated) {
    // A concurrent request already issued a fresh code within the cooldown
    // window. Return the generic success without sending another email.
    return genericReply();
  }

  try {
    await sendLoginCode(email, code);
  } catch (err) {
    console.error('Failed to send login code email:', err);
  }

  return genericReply();
});
