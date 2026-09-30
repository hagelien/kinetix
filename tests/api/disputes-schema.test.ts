import { describe, expect, it } from 'vitest';
import {
  createDisputeSchema,
  resolveDisputeSchema,
  markNotificationsReadSchema,
  DISPUTE_RESOLUTIONS,
} from '../../api/_lib/schemas';
import { disputeNotificationRecipients } from '../../api/_lib/notifications';

describe('createDisputeSchema', () => {
  const base = {
    targetType: 'pending_edit' as const,
    targetId: 42,
    targetVersion: '2026-07-29T00:00:00.000Z|pending',
    reasonMd: 'This value contradicts Karch (2008) Table 3.2.',
  };

  it('accepts a minimal valid dispute', () => {
    expect(createDisputeSchema.safeParse(base).success).toBe(true);
  });

  it('accepts evidence refs', () => {
    const r = createDisputeSchema.safeParse({
      ...base,
      evidenceRefs: [{ citationId: 9876, quote: 'half-life 12-16h' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects a reason shorter than 20 chars (after trim)', () => {
    expect(
      createDisputeSchema.safeParse({ ...base, reasonMd: 'too short' }).success,
    ).toBe(false);
    expect(
      createDisputeSchema.safeParse({ ...base, reasonMd: '   spaces   ' })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown target type', () => {
    expect(
      createDisputeSchema.safeParse({ ...base, targetType: 'drug' }).success,
    ).toBe(false);
  });

  it('rejects a non-positive target id', () => {
    expect(
      createDisputeSchema.safeParse({ ...base, targetId: 0 }).success,
    ).toBe(false);
  });

  it('rejects unknown extra keys (strict)', () => {
    expect(
      createDisputeSchema.safeParse({ ...base, foo: 'bar' }).success,
    ).toBe(false);
  });

  it('requires a targetVersion', () => {
    const { targetVersion: _targetVersion, ...withoutVersion } = base;
    expect(createDisputeSchema.safeParse(withoutVersion).success).toBe(false);
  });

  it('rejects an empty targetVersion', () => {
    expect(
      createDisputeSchema.safeParse({ ...base, targetVersion: '' }).success,
    ).toBe(false);
  });
});

describe('resolveDisputeSchema', () => {
  it('accepts each known resolution', () => {
    for (const resolution of DISPUTE_RESOLUTIONS) {
      expect(resolveDisputeSchema.safeParse({ resolution }).success).toBe(true);
    }
  });

  it('rejects an unknown resolution', () => {
    expect(
      resolveDisputeSchema.safeParse({ resolution: 'maybe' }).success,
    ).toBe(false);
  });
});

describe('markNotificationsReadSchema', () => {
  it('accepts an id list', () => {
    expect(
      markNotificationsReadSchema.safeParse({ ids: [1, 2, 3] }).success,
    ).toBe(true);
  });

  it('accepts all=true', () => {
    expect(markNotificationsReadSchema.safeParse({ all: true }).success).toBe(
      true,
    );
  });

  it('rejects an empty payload', () => {
    expect(markNotificationsReadSchema.safeParse({}).success).toBe(false);
  });

  it('rejects all=false with no ids', () => {
    expect(
      markNotificationsReadSchema.safeParse({ all: false }).success,
    ).toBe(false);
  });
});

describe('disputeNotificationRecipients', () => {
  it('unions reviewers with the target author', () => {
    const r = disputeNotificationRecipients({
      reviewerIds: [1, 2],
      targetAuthorUserId: 9,
      actorUserId: 5,
    });
    expect(new Set(r)).toEqual(new Set([1, 2, 9]));
  });

  it('excludes the actor (no self-notification)', () => {
    const r = disputeNotificationRecipients({
      reviewerIds: [1, 2, 5],
      targetAuthorUserId: 9,
      actorUserId: 5,
    });
    expect(r).not.toContain(5);
    expect(new Set(r)).toEqual(new Set([1, 2, 9]));
  });

  it('de-duplicates when the author is also a reviewer', () => {
    const r = disputeNotificationRecipients({
      reviewerIds: [1, 2],
      targetAuthorUserId: 2,
      actorUserId: 7,
    });
    expect(r.filter((x) => x === 2)).toHaveLength(1);
  });

  it('tolerates a null author', () => {
    const r = disputeNotificationRecipients({
      reviewerIds: [1, 2],
      targetAuthorUserId: null,
      actorUserId: 1,
    });
    expect(new Set(r)).toEqual(new Set([2]));
  });
});
