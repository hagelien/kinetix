import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PDF_SHARE_TTL_SECONDS,
  mintPdfShareToken,
  shaPrefixOf,
  verifyPdfShareToken,
} from '../../api/_lib/pdf-share-token.js';

const SHA =
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('pdf share tokens', () => {
  const previousSecret = process.env.JWT_SECRET;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret';
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  it('round-trips the citation, byte binding and issuer', () => {
    const now = Date.UTC(2026, 5, 1, 12, 0, 0);
    const { token, expiresAt } = mintPdfShareToken({
      citationId: 42,
      sha256: SHA,
      issuedBy: 7,
      now,
    });

    expect(expiresAt.getTime()).toBe(now + PDF_SHARE_TTL_SECONDS * 1000);

    const result = verifyPdfShareToken(token, now);
    expect(result).toMatchObject({
      ok: true,
      payload: {
        citationId: 42,
        shaPrefix: shaPrefixOf(SHA),
        issuedBy: 7,
      },
    });
  });

  it('rejects a token past its expiry', () => {
    const now = Date.UTC(2026, 5, 1, 12, 0, 0);
    const { token } = mintPdfShareToken({
      citationId: 42,
      sha256: SHA,
      issuedBy: 7,
      now,
    });

    expect(
      verifyPdfShareToken(token, now + PDF_SHARE_TTL_SECONDS * 1000 + 1),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a payload edited to name a different citation', () => {
    const now = Date.now();
    const { token } = mintPdfShareToken({
      citationId: 42,
      sha256: SHA,
      issuedBy: 7,
      now,
    });
    const [version, encoded, signature] = token.split('.') as [
      string,
      string,
      string,
    ];
    const claims = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    claims.c = 43;
    const forged = Buffer.from(JSON.stringify(claims)).toString('base64url');

    expect(verifyPdfShareToken(`${version}.${forged}.${signature}`, now)).toEqual(
      { ok: false, reason: 'bad_signature' },
    );
  });

  it('rejects a payload edited to extend its own expiry', () => {
    const now = Date.now();
    const { token } = mintPdfShareToken({
      citationId: 42,
      sha256: SHA,
      issuedBy: 7,
      now,
    });
    const [version, encoded, signature] = token.split('.') as [
      string,
      string,
      string,
    ];
    const claims = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    claims.e = Math.floor(now / 1000) + 86_400;
    const forged = Buffer.from(JSON.stringify(claims)).toString('base64url');

    expect(verifyPdfShareToken(`${version}.${forged}.${signature}`, now)).toEqual(
      { ok: false, reason: 'bad_signature' },
    );
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = mintPdfShareToken({
      citationId: 42,
      sha256: SHA,
      issuedBy: 7,
    });
    process.env.JWT_SECRET = 'rotated-secret';

    expect(verifyPdfShareToken(token)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects malformed input without throwing', () => {
    for (const junk of ['', 'nope', 'a.b', 'k1..sig', 'k2.abc.def']) {
      expect(verifyPdfShareToken(junk).ok).toBe(false);
    }
  });

  it('clamps a caller-supplied lifetime to at most an hour', () => {
    const now = Date.UTC(2026, 5, 1, 12, 0, 0);
    const { expiresAt } = mintPdfShareToken({
      citationId: 42,
      sha256: SHA,
      issuedBy: 7,
      ttlSeconds: 60 * 60 * 24 * 30,
      now,
    });
    expect(expiresAt.getTime()).toBe(now + 60 * 60 * 1000);
  });
});
