import { describe, expect, it } from 'vitest';
import {
  partitionAgentTokens,
  type TokenRow,
} from '../../scripts/revoke-agent-tokens';

const NOW = new Date('2026-06-23T00:00:00.000Z');
const FUTURE = new Date('2027-06-23T00:00:00.000Z');
const PAST = new Date('2026-06-01T00:00:00.000Z');

function tok(over: Partial<TokenRow> & { id: number }): TokenRow {
  return {
    prefix: `kxat_${String(over.id).padStart(4, '0')}`,
    label: 'kinetix-agent scheduler',
    lastUsedAt: null,
    expiresAt: FUTURE,
    revokedAt: null,
    ...over,
  };
}

const baseOpts = {
  now: NOW,
  keepIds: new Set<number>(),
  keepPrefixes: [] as string[],
  keepLastUsed: false,
  includeExpired: false,
};

describe('partitionAgentTokens', () => {
  it('revokes active tokens but keeps ones matched by id', () => {
    const p = partitionAgentTokens([tok({ id: 1 }), tok({ id: 2 })], {
      ...baseOpts,
      keepIds: new Set([2]),
    });
    expect(p.revoke.map((t) => t.id)).toEqual([1]);
    expect(p.keep.map((t) => t.id)).toEqual([2]);
  });

  it('keeps a token matched by prefix (tolerating the UI ellipsis)', () => {
    const live = tok({ id: 9, prefix: 'kxat_eiSisy' });
    const p = partitionAgentTokens([live, tok({ id: 1 })], {
      ...baseOpts,
      keepPrefixes: ['kxat_eiSisy…'],
    });
    expect(p.keep.map((t) => t.id)).toEqual([9]);
    expect(p.revoke.map((t) => t.id)).toEqual([1]);
  });

  it('never touches already-revoked tokens', () => {
    const p = partitionAgentTokens(
      [tok({ id: 1, revokedAt: PAST }), tok({ id: 2 })],
      { ...baseOpts, keepIds: new Set([2]) },
    );
    expect(p.alreadyRevoked.map((t) => t.id)).toEqual([1]);
    expect(p.revoke).toEqual([]);
  });

  it('skips expired tokens by default and revokes them with --include-expired', () => {
    const expired = tok({ id: 1, expiresAt: PAST });
    const skip = partitionAgentTokens([expired, tok({ id: 2 })], {
      ...baseOpts,
      keepIds: new Set([2]),
    });
    expect(skip.skippedExpired.map((t) => t.id)).toEqual([1]);
    expect(skip.revoke).toEqual([]);

    const incl = partitionAgentTokens([expired, tok({ id: 2 })], {
      ...baseOpts,
      keepIds: new Set([2]),
      includeExpired: true,
    });
    expect(incl.revoke.map((t) => t.id)).toEqual([1]);
  });

  it('keep-last-used preserves the most-recently-used active token', () => {
    const tokens = [
      tok({ id: 1, lastUsedAt: new Date('2026-06-02T00:00:00Z') }),
      tok({ id: 2, lastUsedAt: new Date('2026-06-20T00:00:00Z') }), // newest
      tok({ id: 3, lastUsedAt: new Date('2026-06-10T00:00:00Z') }),
    ];
    const p = partitionAgentTokens(tokens, { ...baseOpts, keepLastUsed: true });
    expect(p.keep.map((t) => t.id)).toEqual([2]);
    expect(p.revoke.map((t) => t.id).sort()).toEqual([1, 3]);
  });

  it('keep-last-used ignores expired/revoked when picking the live token', () => {
    const tokens = [
      // most-recent timestamp but EXPIRED → not eligible as "live"
      tok({ id: 1, lastUsedAt: new Date('2026-06-22T00:00:00Z'), expiresAt: PAST }),
      tok({ id: 2, lastUsedAt: new Date('2026-06-10T00:00:00Z') }),
    ];
    const p = partitionAgentTokens(tokens, {
      ...baseOpts,
      keepLastUsed: true,
    });
    // id=1 is expired (skipped), id=2 is the most-recent *active* → kept
    expect(p.keep.map((t) => t.id)).toEqual([2]);
    expect(p.skippedExpired.map((t) => t.id)).toEqual([1]);
    expect(p.revoke).toEqual([]);
  });
});
