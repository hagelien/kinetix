import { createHmac, timingSafeEqual } from "node:crypto";

export const MAGIC_LINK_CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_MAGIC_LINK_FAILURES = 5;
const MAGIC_LINK_HASH_PREFIX = "v2:";

export function hashMagicLinkCode(code: string): string {
  return `${MAGIC_LINK_HASH_PREFIX}${hmacMagicLinkCode(code)}`;
}

export function hasMagicLinkExpired(
  expiresAt: Date | null | undefined,
  now = Date.now(),
): boolean {
  return !expiresAt || expiresAt.getTime() < now;
}

export function isMagicLinkLockedOut(
  failedAttempts: number | null | undefined,
): boolean {
  return (failedAttempts ?? 0) >= MAX_MAGIC_LINK_FAILURES;
}

export function registerMagicLinkFailure(
  failedAttempts: number | null | undefined,
): { failedAttemptsToStore: number; invalidateCode: boolean } {
  const nextAttempts = (failedAttempts ?? 0) + 1;

  if (nextAttempts >= MAX_MAGIC_LINK_FAILURES) {
    return {
      failedAttemptsToStore: 0,
      invalidateCode: true,
    };
  }

  return {
    failedAttemptsToStore: nextAttempts,
    invalidateCode: false,
  };
}

export function compareMagicLinkCode(
  storedHash: string,
  code: string,
): boolean {
  if (!storedHash.startsWith(MAGIC_LINK_HASH_PREFIX)) {
    // Reject hashes that were stored without the HMAC prefix. The legacy
    // plain-SHA-256 path was removed after the 15-minute OTP window
    // following the v2 migration; any remaining bare hashes in the DB are
    // expired and must not be accepted.
    return false;
  }
  return constantTimeHexEquals(
    storedHash.slice(MAGIC_LINK_HASH_PREFIX.length),
    hmacMagicLinkCode(code),
  );
}

function hmacMagicLinkCode(code: string): string {
  // Prefer MAGIC_LINK_HMAC_SECRET so a JWT_SECRET compromise does not also
  // expose the OTP path (and vice versa). Falls back to JWT_SECRET for
  // deployments that haven't yet added the dedicated variable.
  const secret =
    process.env.MAGIC_LINK_HMAC_SECRET ?? process.env.JWT_SECRET;
  if (!secret)
    throw new Error("MAGIC_LINK_HMAC_SECRET (or JWT_SECRET) is not set");
  return createHmac("sha256", secret).update(code).digest("hex");
}

function constantTimeHexEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");

  if (
    leftBytes.length === 0 ||
    rightBytes.length === 0 ||
    leftBytes.length !== rightBytes.length
  ) {
    return false;
  }

  return timingSafeEqual(leftBytes, rightBytes);
}
