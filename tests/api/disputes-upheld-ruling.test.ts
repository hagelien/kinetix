import { describe, expect, it } from 'vitest';
import {
  anyUpheldRulingStands,
  upheldRulingStands,
  type UpheldDisputeRuling,
} from '../../api/_lib/disputes.ts';

// Upholding an objection closes the dispute row without clearing the proposal:
// its author may return, reject or revise it, but not approve it. That refusal
// has to expire on the one event that answers the objection — a real revision —
// and on nothing else, or it becomes either a permanent block or a formality.
describe('upheldRulingStands', () => {
  const ruledAt = new Date('2026-08-11T07:00:00Z');

  it('does not stand when no objection was ever upheld', () => {
    expect(upheldRulingStands({ resolvedAt: undefined, revisedAt: null })).toBe(
      false,
    );
  });

  it('stands while the payload carries no revision at all', () => {
    // The safe direction: a missing marker means no revision is on record, not
    // that one happened. Every pre-existing row is in this state.
    expect(upheldRulingStands({ resolvedAt: ruledAt, revisedAt: null })).toBe(
      true,
    );
  });

  it('stands over a revision that predates the ruling', () => {
    expect(
      upheldRulingStands({
        resolvedAt: ruledAt,
        revisedAt: '2026-08-11T06:00:00Z',
      }),
    ).toBe(true);
  });

  it('lifts once the payload is revised after the ruling', () => {
    expect(
      upheldRulingStands({
        resolvedAt: ruledAt,
        revisedAt: '2026-08-11T08:00:00Z',
      }),
    ).toBe(false);
  });

  it('stands when the marker is unparseable rather than trusting it', () => {
    expect(
      upheldRulingStands({ resolvedAt: ruledAt, revisedAt: 'not a date' }),
    ).toBe(true);
  });

  // #1321 review on PR #1323: a HUMAN dispute stays open across a revision by
  // design, so a dispute raised against an earlier payload can sit unrefreshed
  // while the submitter revises — and the moderator who later upholds that
  // same (now-stale) objection always resolves AFTER the revision, so
  // `resolvedAt >= revisedAt` alone misread that as a ruling on current
  // content. `targetVersion` (captured when the dispute was opened or last
  // refreshed) is the fix: it proves what the objection actually described.
  describe('with the dispute\'s own captured targetVersion', () => {
    it('does not stand when the dispute predates a later revision, however late the ruling lands', () => {
      // Dispute opened (and never refreshed) against a payload submitted at
      // 05:00. The payload is revised at 06:00 — after the objection was
      // raised, before it was ruled on. The moderator doesn't uphold until
      // 07:00 (ruledAt), well after both.
      expect(
        upheldRulingStands({
          resolvedAt: ruledAt, // 07:00
          revisedAt: '2026-08-11T06:00:00Z',
          targetVersion: '2026-08-11T05:00:00.000Z|pending',
        }),
      ).toBe(false);
    });

    it('stands when the dispute was raised against the current, already-revised payload', () => {
      // The payload was revised at 06:00, and the dispute was opened (or
      // refreshed) afterwards, at 06:30 — so it describes current content.
      expect(
        upheldRulingStands({
          resolvedAt: ruledAt, // 07:00
          revisedAt: '2026-08-11T06:00:00Z',
          targetVersion: '2026-08-11T06:30:00.000Z|pending',
        }),
      ).toBe(true);
    });

    it('is not fooled by a content-identical resubmit bumping submittedAt without touching revisedAt', () => {
      // A resubmit always re-stamps submittedAt (#592) even with no content
      // change, which would move the CURRENT target's version — but this
      // check reads only the dispute's own captured version against
      // `revisedAt`, which a no-op resubmit never touches. An author must not
      // be able to clear a still-valid ruling just by resubmitting unchanged
      // content (docs/REVIEW_POLICY.md's authorisation escalation rule).
      expect(
        upheldRulingStands({
          resolvedAt: ruledAt,
          revisedAt: '2026-08-11T05:00:00Z',
          targetVersion: '2026-08-11T05:00:00.000Z|pending',
        }),
      ).toBe(true);
    });

    it('falls back to the resolvedAt comparison for a row with no captured version', () => {
      expect(
        upheldRulingStands({
          resolvedAt: ruledAt, // 07:00
          revisedAt: '2026-08-11T06:00:00Z',
          targetVersion: null,
        }),
      ).toBe(true);
      expect(
        upheldRulingStands({
          resolvedAt: ruledAt, // 07:00
          revisedAt: '2026-08-11T08:00:00Z',
          targetVersion: null,
        }),
      ).toBe(false);
    });
  });
});

// Codex security review on PR #1323 (P1, discussion_r4070051339): a target
// can carry more than one resolved-upheld row — one per author who disputed
// it, per the partial unique index on (targetType, targetId, createdBy). A
// moderator can resolve them in any order relative to revisions, so picking
// only the most-recently-resolved row can discard a ruling that still covers
// the current payload in favor of a later-resolved one that describes an
// older version. `anyUpheldRulingStands` has to check every upheld row.
describe('anyUpheldRulingStands', () => {
  function ruling(
    resolvedAtIso: string,
    targetVersion: string | null,
  ): UpheldDisputeRuling {
    return { resolvedAt: new Date(resolvedAtIso), targetVersion };
  }

  it('does not stand with no rulings at all', () => {
    expect(
      anyUpheldRulingStands({ rulings: undefined, revisedAt: null }),
    ).toBe(false);
    expect(anyUpheldRulingStands({ rulings: [], revisedAt: null })).toBe(
      false,
    );
  });

  it('stands on a still-covering ruling even when a later-resolved one is stale', () => {
    // Author B disputes V2 (submitted 06:30) and it is upheld first, at
    // 07:00. Author A's older dispute against V1 (submitted 05:00) is upheld
    // later, at 09:00 — resolved-later, but describing stale content. The
    // payload is currently V2 (revisedAt 06:00): author A's ruling doesn't
    // cover it, but author B's does, and must not be hidden by A's later
    // resolution time.
    const rulings = [
      ruling('2026-08-11T09:00:00Z', '2026-08-11T05:00:00.000Z|pending'), // author A, stale, resolved last
      ruling('2026-08-11T07:00:00Z', '2026-08-11T06:30:00.000Z|pending'), // author B, current, resolved first
    ];
    expect(
      anyUpheldRulingStands({
        rulings,
        revisedAt: '2026-08-11T06:00:00Z',
      }),
    ).toBe(true);
  });

  it('does not stand when every ruling is stale relative to the current payload', () => {
    const rulings = [
      ruling('2026-08-11T09:00:00Z', '2026-08-11T05:00:00.000Z|pending'),
      ruling('2026-08-11T07:00:00Z', '2026-08-11T05:30:00.000Z|pending'),
    ];
    expect(
      anyUpheldRulingStands({
        rulings,
        revisedAt: '2026-08-11T06:00:00Z',
      }),
    ).toBe(false);
  });
});
