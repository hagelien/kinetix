import { afterEach, describe, expect, it } from "vitest";
import {
  compareMagicLinkCode,
  hashMagicLinkCode,
  hasMagicLinkExpired,
  isMagicLinkLockedOut,
  MAX_MAGIC_LINK_FAILURES,
  registerMagicLinkFailure,
} from "../../api/_lib/magic-link.ts";

describe("magic-link security helpers", () => {
  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it("accepts only the correct one-time code hash", () => {
    process.env.JWT_SECRET = "test-secret-for-magic-link";
    const storedHash = hashMagicLinkCode("123456");

    expect(storedHash).toMatch(/^v2:[a-f0-9]{64}$/);
    expect(compareMagicLinkCode(storedHash, "123456")).toBe(true);
    expect(compareMagicLinkCode(storedHash, "654321")).toBe(false);
  });

  it("rejects legacy plain-SHA-256 hashes after the migration window", () => {
    process.env.JWT_SECRET = "test-secret-for-magic-link";
    // SHA-256("123456") — a valid hash under the old scheme that must now be
    // rejected; all codes from before the v2 migration have long expired.
    const legacyHash =
      "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92";

    expect(compareMagicLinkCode(legacyHash, "123456")).toBe(false);
    expect(compareMagicLinkCode(legacyHash, "654321")).toBe(false);
  });

  it("treats missing or past expirations as expired", () => {
    const now = new Date("2026-04-16T10:00:00Z");

    expect(hasMagicLinkExpired(undefined, now.getTime())).toBe(true);
    expect(hasMagicLinkExpired(null, now.getTime())).toBe(true);
    expect(
      hasMagicLinkExpired(new Date("2026-04-16T09:59:59Z"), now.getTime()),
    ).toBe(true);
    expect(
      hasMagicLinkExpired(new Date("2026-04-16T10:00:01Z"), now.getTime()),
    ).toBe(false);
  });

  it("invalidates the active code after too many failed guesses", () => {
    expect(isMagicLinkLockedOut(MAX_MAGIC_LINK_FAILURES - 1)).toBe(false);
    expect(isMagicLinkLockedOut(MAX_MAGIC_LINK_FAILURES)).toBe(true);

    expect(registerMagicLinkFailure(0)).toEqual({
      failedAttemptsToStore: 1,
      invalidateCode: false,
    });

    expect(registerMagicLinkFailure(MAX_MAGIC_LINK_FAILURES - 1)).toEqual({
      failedAttemptsToStore: 0,
      invalidateCode: true,
    });
  });
});
