import { describe, expect, it } from 'vitest';
import {
  issueAgentTokenSchema,
  revokeAgentTokenSchema,
  setAgentRoleSchema,
  patchAgentSchema,
} from '../../api/_lib/schemas';
import {
  AGENT_TOKEN_PREFIX,
  generateAgentToken,
  hashAgentToken,
} from '../../api/_lib/auth';

describe('issueAgentTokenSchema', () => {
  it('accepts a label and a bounded expiry', () => {
    const r = issueAgentTokenSchema.safeParse({
      label: 'ci-runner',
      expiresInDays: 90,
    });
    expect(r.success).toBe(true);
  });

  it('allows omitting the label', () => {
    const r = issueAgentTokenSchema.safeParse({ expiresInDays: 30 });
    expect(r.success).toBe(true);
  });

  it('requires an expiry (no infinite tokens)', () => {
    const r = issueAgentTokenSchema.safeParse({ label: 'x' });
    expect(r.success).toBe(false);
  });

  it('rejects a non-positive or over-cap expiry', () => {
    expect(issueAgentTokenSchema.safeParse({ expiresInDays: 0 }).success).toBe(
      false,
    );
    expect(
      issueAgentTokenSchema.safeParse({ expiresInDays: 366 }).success,
    ).toBe(false);
  });

  it('rejects unknown fields (strict)', () => {
    const r = issueAgentTokenSchema.safeParse({
      expiresInDays: 30,
      // @ts-expect-error intentional extra field
      foo: 'bar',
    });
    expect(r.success).toBe(false);
  });
});

describe('revokeAgentTokenSchema', () => {
  it('accepts a positive token id', () => {
    expect(revokeAgentTokenSchema.safeParse({ tokenId: 5 }).success).toBe(true);
  });

  it('rejects a missing or non-positive id', () => {
    expect(revokeAgentTokenSchema.safeParse({}).success).toBe(false);
    expect(revokeAgentTokenSchema.safeParse({ tokenId: 0 }).success).toBe(
      false,
    );
  });
});

describe('setAgentRoleSchema', () => {
  it('accepts contributor and editor', () => {
    expect(setAgentRoleSchema.safeParse({ role: 'contributor' }).success).toBe(
      true,
    );
    expect(setAgentRoleSchema.safeParse({ role: 'editor' }).success).toBe(true);
  });

  it('rejects admin and authenticated (agents never carry admin)', () => {
    expect(setAgentRoleSchema.safeParse({ role: 'admin' }).success).toBe(false);
    expect(
      setAgentRoleSchema.safeParse({ role: 'authenticated' }).success,
    ).toBe(false);
  });
});

describe('patchAgentSchema hooksEnabled', () => {
  it('accepts a boolean hooksEnabled', () => {
    const r = patchAgentSchema.safeParse({ hooksEnabled: true });
    expect(r.success).toBe(true);
  });

  it('rejects a non-boolean hooksEnabled', () => {
    const r = patchAgentSchema.safeParse({ hooksEnabled: 'yes' });
    expect(r.success).toBe(false);
  });
});

describe('patchAgentSchema selfReviewEnabled', () => {
  it('accepts a boolean selfReviewEnabled', () => {
    const r = patchAgentSchema.safeParse({ selfReviewEnabled: true });
    expect(r.success && r.data.selfReviewEnabled).toBe(true);
  });

  it('rejects a non-boolean selfReviewEnabled', () => {
    expect(
      patchAgentSchema.safeParse({ selfReviewEnabled: 'yes' }).success,
    ).toBe(false);
  });

  // .strict() means a typo'd key is a 400, not a silently ignored no-op —
  // which for a permission grant is the difference between "not enabled" and
  // "assumed enabled".
  it('rejects a near-miss key rather than ignoring it', () => {
    expect(patchAgentSchema.safeParse({ selfReview: true }).success).toBe(false);
  });
});

describe('agent token crypto', () => {
  it('mints a prefixed token whose stored hash matches', () => {
    const { token, hash, prefix } = generateAgentToken();
    expect(token.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(hash).toBe(hashAgentToken(token));
    // sha256 hex is 64 chars — matches the token_hash column width.
    expect(hash).toHaveLength(64);
    // Prefix is the first 12 chars plus an ellipsis, never the secret.
    expect(prefix.startsWith(AGENT_TOKEN_PREFIX)).toBe(true);
    expect(token.includes(prefix.replace('…', ''))).toBe(true);
    expect(prefix).not.toBe(token);
  });

  it('produces unique tokens', () => {
    const a = generateAgentToken();
    const b = generateAgentToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });
});
