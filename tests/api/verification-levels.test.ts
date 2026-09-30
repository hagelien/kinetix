import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeVerificationLevel,
  VERIFICATION_LEVEL_LABEL_KEYS,
} from '../../src/lib/verificationLevel';

// ─── pure level model ──────────────────────────────────────────────────────

describe('computeVerificationLevel', () => {
  it('level 0 when nobody has verified', () => {
    expect(
      computeVerificationLevel({ agentApprovers: 0, hasHumanApprover: false }),
    ).toBe(0);
  });

  it('level 1 for a single agent (self-verified submission)', () => {
    expect(
      computeVerificationLevel({ agentApprovers: 1, hasHumanApprover: false }),
    ).toBe(1);
  });

  it('level 1 for a human-only approval below the agent quorum', () => {
    expect(
      computeVerificationLevel({ agentApprovers: 0, hasHumanApprover: true }),
    ).toBe(1);
    expect(
      computeVerificationLevel({ agentApprovers: 1, hasHumanApprover: true }),
    ).toBe(1);
  });

  it('level 2 for two or more agents but no human', () => {
    expect(
      computeVerificationLevel({ agentApprovers: 2, hasHumanApprover: false }),
    ).toBe(2);
    expect(
      computeVerificationLevel({ agentApprovers: 5, hasHumanApprover: false }),
    ).toBe(2);
  });

  it('level 3 for two or more agents plus a human', () => {
    expect(
      computeVerificationLevel({ agentApprovers: 2, hasHumanApprover: true }),
    ).toBe(3);
  });

  // A trusted self-reviewing agent's re-verification is the second act its
  // single (agent, target) row collapsed. Without this a one-agent deployment
  // is pinned at level 1 forever — "verified by its author only" — no matter
  // how many times that agent goes back to the sources.
  it('lifts a trusted author self-verification to level 2', () => {
    expect(
      computeVerificationLevel({
        agentApprovers: 1,
        hasHumanApprover: false,
        authorSelfVerified: true,
      }),
    ).toBe(2);
  });

  it('reaches level 3 when a human also confirms the self-verified value', () => {
    expect(
      computeVerificationLevel({
        agentApprovers: 1,
        hasHumanApprover: true,
        authorSelfVerified: true,
      }),
    ).toBe(3);
  });

  it('does not invent a verification out of nothing', () => {
    // No approvers at all — the flag describes a verdict that was posted, so
    // it cannot be true here, but the level must not climb off it regardless.
    expect(
      computeVerificationLevel({
        agentApprovers: 0,
        hasHumanApprover: false,
        authorSelfVerified: false,
      }),
    ).toBe(0);
  });

  it('is absent-by-default, so existing callers are unaffected', () => {
    expect(
      computeVerificationLevel({ agentApprovers: 1, hasHumanApprover: false }),
    ).toBe(1);
  });

  it('exposes a distinct label key for every level', () => {
    const keys = [0, 1, 2, 3].map(
      (l) => VERIFICATION_LEVEL_LABEL_KEYS[l as 0 | 1 | 2 | 3],
    );
    expect(new Set(keys).size).toBe(4);
    keys.forEach((key) => expect(key).toMatch(/^verification\.level\./));
  });
});

// ─── aggregation over revision targets ─────────────────────────────────────

const { neonMock, verifMock, apprMock, selfVerifiedRowsMock } = vi.hoisted(
  () => ({
    neonMock: vi.fn(),
    verifMock: vi.fn(),
    apprMock: vi.fn(),
    // Rows returned by the trusted-author self-verification join. Empty by
    // default, which is what an install with no self-review agent produces —
    // so these cases assert the untouched pre-existing behaviour.
    selfVerifiedRowsMock: vi.fn(async () => [] as Array<{ id: number }>),
  }),
);

vi.mock('../../api/_lib/db.js', () => ({
  getNeonClient: () => neonMock,
  // The self-verification join chains select→from→innerJoin×3→where. Built as
  // a self-returning builder so adding or dropping a join in the query does
  // not silently turn these cases into a crash.
  getDb: () => {
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      from: () => builder,
      innerJoin: () => builder,
      where: () => selfVerifiedRowsMock(),
    });
    return { select: () => builder };
  },
}));
vi.mock('../../api/_lib/agent-verifications.js', () => ({
  summariseVerificationsForTargets: verifMock,
}));
vi.mock('../../api/_lib/approvals.js', () => ({
  summariseApprovalsForTargets: apprMock,
}));

import {
  parameterVerificationLevels,
  factVerificationLevels,
} from '../../api/_lib/verification-levels';

function summary(over: Partial<{
  approveCount: number;
  disputeCount: number;
  abstainCount: number;
  implicitApproveCount: number;
}>) {
  return {
    approveCount: 0,
    disputeCount: 0,
    abstainCount: 0,
    implicitApproveCount: 0,
    ...over,
  };
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) drains any leftover mockResolvedValueOnce
  // queue between tests — e.g. the empty-revisions path never consumes the
  // verif/appr summaries, so a stale once-value must not bleed forward.
  vi.resetAllMocks();
  selfVerifiedRowsMock.mockResolvedValue([]);
});

describe('parameterVerificationLevels', () => {
  it('maps each parameter to the level of its latest revision', async () => {
    // latest revision per parameter
    neonMock.mockResolvedValueOnce([
      { parameter: 'halfLife', id: 10 },
      { parameter: 'volumeOfDistribution', id: 20 },
      { parameter: 'proteinBinding', id: 30 },
    ]);
    // rev 10: submitter + 1 peer + human  -> level 3
    // rev 20: submitter + 1 peer, no human -> level 2
    // rev 30: submitter only -> level 1, and disputed
    verifMock.mockResolvedValueOnce(
      new Map([
        [10, summary({ implicitApproveCount: 1, approveCount: 1 })],
        [20, summary({ implicitApproveCount: 1, approveCount: 1 })],
        [30, summary({ implicitApproveCount: 1, disputeCount: 2 })],
      ]),
    );
    apprMock.mockResolvedValueOnce(
      new Map([
        [10, { count: 1, approvers: [{ isAgent: false }] }],
        [20, { count: 1, approvers: [{ isAgent: true }] }],
      ]),
    );

    const out = await parameterVerificationLevels(5);
    expect(out.halfLife).toEqual({ level: 3, disputed: false });
    expect(out.volumeOfDistribution).toEqual({ level: 2, disputed: false });
    expect(out.proteinBinding).toEqual({ level: 1, disputed: true });
  });

  it('returns an empty map when the drug has no revisions', async () => {
    neonMock.mockResolvedValueOnce([]);
    // verif/appr are never called on the empty-revisions path.
    expect(await parameterVerificationLevels(7)).toEqual({});
    expect(verifMock).not.toHaveBeenCalled();
  });
});

describe('factVerificationLevels', () => {
  it('maps each factId to the level of its latest touching revision', async () => {
    neonMock.mockResolvedValueOnce([
      { fact_id: 'fact-a', revision_id: 100 },
      { fact_id: 'fact-b', revision_id: 200 },
    ]);
    verifMock.mockResolvedValueOnce(
      new Map([
        [100, summary({ implicitApproveCount: 1, approveCount: 2 })],
        [200, summary({})],
      ]),
    );
    apprMock.mockResolvedValueOnce(new Map());

    const out = await factVerificationLevels(42);
    expect(out['fact-a']).toEqual({ level: 2, disputed: false });
    expect(out['fact-b']).toEqual({ level: 0, disputed: false });
  });
});
