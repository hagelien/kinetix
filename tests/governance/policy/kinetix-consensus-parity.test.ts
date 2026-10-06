/**
 * Phase 1 exit gate: "legacy and generic policy outcomes match on an exhaustive
 * fixture matrix" (docs/plans/2026-08-26-general-knowledge-governance-
 * extraction.md).
 *
 * `consensusApprovalHoldReason` and `effectiveConsensusQuorum` in
 * `api/_lib/agent-verifications.ts` now delegate to the generic governance
 * policy. That makes comparing them against the generic implementation
 * circular — both would be the same code — so the reference side of every
 * comparison here is a **frozen verbatim copy of the pre-Phase-1 algorithm**,
 * inlined below. It is deliberately not imported from anywhere: its whole value
 * is that it cannot change when the production code changes.
 *
 * If a future phase intends to change one of these decisions, the frozen copy
 * is what must be updated, in the same commit, with the behaviour change stated
 * — which is exactly the friction it exists to create.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The helper module reaches for a database client at import time for its other
// exports; the two functions under test are pure and never touch it.
vi.mock('../../../api/_lib/db.js', () => ({
  getDb: vi.fn(),
}));

import {
  consensusApprovalHoldReason,
  effectiveConsensusQuorum,
  isConsensusQuorumDegraded,
  type VerificationSummary,
} from '../../../api/_lib/agent-verifications.js';
import {
  governanceConsensusHoldReason,
  projectLegacyConsensusContext,
  type LegacyConsensusHoldReason,
} from '../../../src/lib/assurance/projection.js';
import { KINETIX_POLICY } from '../../../src/lib/assurance/policy.js';

// ---------------------------------------------------------------------------
// Frozen reference: the algorithm exactly as it stood before Phase 1.
// Copied verbatim from api/_lib/agent-verifications.ts as it stood before the harmonization.
// Do not refactor, deduplicate, or import these from the production module.
// ---------------------------------------------------------------------------

const FROZEN_AGENT_CONSENSUS_APPROVE_QUORUM = 2;

function frozenMeetsConsensusApprovalQuorum(
  summary: VerificationSummary,
  quorum: number = FROZEN_AGENT_CONSENSUS_APPROVE_QUORUM,
): boolean {
  return summary.disputeCount === 0 && summary.approveCount >= quorum;
}

function frozenConsensusApprovalHoldReason(
  summary: VerificationSummary,
  quorum: number,
  opts: { highRisk: boolean },
): LegacyConsensusHoldReason | null {
  if (!frozenMeetsConsensusApprovalQuorum(summary, quorum)) return 'quorum_unmet';
  if (opts.highRisk) {
    if (summary.approveCount < FROZEN_AGENT_CONSENSUS_APPROVE_QUORUM) {
      return 'high_risk_degraded_quorum';
    }
    if ((summary.approveTier2Count ?? 0) < 1) {
      return 'high_risk_missing_flagship';
    }
  }
  return null;
}

function frozenEffectiveConsensusQuorum(
  activeAgentCount: number,
  opts: { authorSelfReviews?: boolean } = {},
): number {
  const eligibleVerifiers = opts.authorSelfReviews
    ? activeAgentCount
    : activeAgentCount - 1;
  return Math.min(
    FROZEN_AGENT_CONSENSUS_APPROVE_QUORUM,
    Math.max(1, eligibleVerifiers),
  );
}

function frozenIsConsensusQuorumDegraded(
  activeAgentCount: number,
  opts: { authorSelfReviews?: boolean } = {},
): boolean {
  return (
    frozenEffectiveConsensusQuorum(activeAgentCount, opts) <
    FROZEN_AGENT_CONSENSUS_APPROVE_QUORUM
  );
}

// ---------------------------------------------------------------------------
// Exhaustive fixture matrix
// ---------------------------------------------------------------------------

const APPROVE_COUNTS = [0, 1, 2, 3, 4];
const DISPUTE_COUNTS = [0, 1, 2];
const ABSTAIN_COUNTS = [0, 1];
const IMPLICIT_COUNTS = [0, 1];
// `undefined` is a real case: older callers and hand-built summaries omit the
// tier count entirely, and it must be read as 0 rather than as "unknown, allow".
const TIER2_COUNTS: Array<number | undefined> = [undefined, 0, 1, 2];
const QUORA = [1, 2, 3];
const HIGH_RISK = [false, true];

interface Case {
  summary: VerificationSummary;
  quorum: number;
  highRisk: boolean;
}

function everyCase(): Case[] {
  const cases: Case[] = [];
  for (const approveCount of APPROVE_COUNTS) {
    for (const disputeCount of DISPUTE_COUNTS) {
      for (const abstainCount of ABSTAIN_COUNTS) {
        for (const implicitApproveCount of IMPLICIT_COUNTS) {
          for (const approveTier2Count of TIER2_COUNTS) {
            for (const quorum of QUORA) {
              for (const highRisk of HIGH_RISK) {
                cases.push({
                  summary: {
                    approveCount,
                    disputeCount,
                    abstainCount,
                    implicitApproveCount,
                    // Cast: the production type requires the field, but the
                    // function documents that a hand-built summary may omit it.
                    approveTier2Count: approveTier2Count as number,
                  },
                  quorum,
                  highRisk,
                });
              }
            }
          }
        }
      }
    }
  }
  return cases;
}

function label(c: Case): string {
  const { summary } = c;
  return (
    `approve=${summary.approveCount} dispute=${summary.disputeCount} ` +
    `abstain=${summary.abstainCount} implicit=${summary.implicitApproveCount} ` +
    `tier2=${String(summary.approveTier2Count)} quorum=${c.quorum} ` +
    `highRisk=${c.highRisk}`
  );
}

describe('consensus hold reason: generic policy vs frozen legacy algorithm', () => {
  const cases = everyCase();

  it('covers the whole cross-product', () => {
    expect(cases).toHaveLength(
      APPROVE_COUNTS.length *
        DISPUTE_COUNTS.length *
        ABSTAIN_COUNTS.length *
        IMPLICIT_COUNTS.length *
        TIER2_COUNTS.length *
        QUORA.length *
        HIGH_RISK.length,
    );
    expect(cases.length).toBeGreaterThan(1000);
  });

  it('agrees with the frozen algorithm on the live production helper', () => {
    // The important assertion: what api/_lib/agent-verifications.ts actually
    // returns today, against what it returned before Phase 1 rewired it.
    const mismatches: string[] = [];
    for (const c of cases) {
      const expected = frozenConsensusApprovalHoldReason(c.summary, c.quorum, {
        highRisk: c.highRisk,
      });
      const actual = consensusApprovalHoldReason(c.summary, c.quorum, {
        highRisk: c.highRisk,
      });
      if (actual !== expected) {
        mismatches.push(`${label(c)}: expected ${expected}, got ${actual}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('agrees with the frozen algorithm on the generic projection directly', () => {
    const mismatches: string[] = [];
    for (const c of cases) {
      const expected = frozenConsensusApprovalHoldReason(c.summary, c.quorum, {
        highRisk: c.highRisk,
      });
      const actual = governanceConsensusHoldReason(c.summary, c.quorum, {
        highRisk: c.highRisk,
      });
      if (actual !== expected) {
        mismatches.push(`${label(c)}: expected ${expected}, got ${actual}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('reaches every hold reason and the allow case somewhere in the matrix', () => {
    // Guards against a vacuous pass: agreement on 1440 cases proves nothing if
    // they all fall down the same branch.
    const seen = new Set(
      cases.map((c) =>
        String(
          consensusApprovalHoldReason(c.summary, c.quorum, { highRisk: c.highRisk }),
        ),
      ),
    );
    expect(seen).toEqual(
      new Set([
        'null',
        'quorum_unmet',
        'high_risk_degraded_quorum',
        'high_risk_missing_flagship',
      ]),
    );
  });
});

describe('effective quorum: generic pool arithmetic vs frozen legacy algorithm', () => {
  const POOL_SIZES = [-1, 0, 1, 2, 3, 4, 5, 10];

  it('agrees on every pool size, with and without a self-reviewing author', () => {
    const mismatches: string[] = [];
    for (const poolSize of POOL_SIZES) {
      for (const authorSelfReviews of [false, true]) {
        const expected = frozenEffectiveConsensusQuorum(poolSize, {
          authorSelfReviews,
        });
        const actual = effectiveConsensusQuorum(poolSize, { authorSelfReviews });
        if (actual !== expected) {
          mismatches.push(
            `pool=${poolSize} selfReview=${authorSelfReviews}: expected ${expected}, got ${actual}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('agrees with no options object at all', () => {
    for (const poolSize of POOL_SIZES) {
      expect(effectiveConsensusQuorum(poolSize)).toBe(
        frozenEffectiveConsensusQuorum(poolSize),
      );
    }
  });

  it('keeps the derived degradation flag in step', () => {
    for (const poolSize of POOL_SIZES) {
      for (const authorSelfReviews of [false, true]) {
        expect(isConsensusQuorumDegraded(poolSize, { authorSelfReviews })).toBe(
          frozenIsConsensusQuorumDegraded(poolSize, { authorSelfReviews }),
        );
      }
    }
  });
});

describe('the projected context the legacy gate implies', () => {
  const summary: VerificationSummary = {
    approveCount: 2,
    disputeCount: 1,
    abstainCount: 3,
    implicitApproveCount: 1,
    approveTier2Count: 1,
  };

  it('maps the legacy tally onto assurance state without inventing anything', () => {
    const context = projectLegacyConsensusContext({
      summary,
      quorum: 2,
      highRisk: true,
    });
    expect(context.assurance).toEqual({
      explicitApprovals: 2,
      independentApprovers: 2,
      humanApprovals: 0,
      agentApprovals: 2,
      approvalCapabilities: ['model_tier:flagship'],
      humanApprovalCapabilities: [],
      disputingAssessors: 1,
      // The legacy function knows nothing about human disputes — its caller
      // checks those separately — so modelling them as zero is what keeps the
      // projection exactly equivalent.
      disputesOpen: 0,
      abstentions: 3,
      implicitApprovals: 1,
      evidenceRequirementState: [],
    });
  });

  it('never claims a flagship approval the tally does not record', () => {
    for (const approveTier2Count of [undefined, 0]) {
      const context = projectLegacyConsensusContext({
        summary: { ...summary, approveTier2Count: approveTier2Count as number },
        quorum: 2,
        highRisk: true,
      });
      expect(context.assurance.approvalCapabilities).toEqual([]);
    }
  });

  it('classifies risk from the caller’s flag and nothing else', () => {
    expect(
      projectLegacyConsensusContext({ summary, quorum: 2, highRisk: true }).risk,
    ).toEqual({ level: 'high', tags: [] });
    expect(
      projectLegacyConsensusContext({ summary, quorum: 2, highRisk: false }).risk,
    ).toEqual({ level: 'low', tags: [] });
  });

  it('treats the author as an agent, so the human-authored rule never fires here', () => {
    // applyOnAgentConsensus returns early for a non-agent submitter, so this
    // gate is only ever reached for agent-authored proposals.
    const context = projectLegacyConsensusContext({
      summary,
      quorum: 2,
      highRisk: false,
    });
    expect(context.author.kind).toBe('agent');
    const decision = KINETIX_POLICY.evaluate(context);
    expect(decision.matchedRuleIds).not.toContain('human-authored');
  });

  it('leaves the pool size unknown rather than back-deriving one from the quorum', () => {
    const context = projectLegacyConsensusContext({
      summary,
      quorum: 1,
      highRisk: false,
    });
    expect(context.pool.size).toBeNull();
    expect(context.pool.effectiveQuorum).toBe(1);
    expect(context.pool.degraded).toBe(true);
  });
});

describe('decision records behind the legacy answer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('names the policy version every hold was decided under', () => {
    const decision = KINETIX_POLICY.evaluate(
      projectLegacyConsensusContext({
        summary: {
          approveCount: 0,
          disputeCount: 0,
          abstainCount: 0,
          implicitApproveCount: 0,
          approveTier2Count: 0,
        },
        quorum: 2,
        highRisk: false,
      }),
    );
    expect(decision.policyId).toBe('kinetix-consensus');
    // v2 retired `human-authored` and added `unattributed`.
    expect(decision.policyVersion).toBe('v2');
    expect(decision.allowed).toBe(false);
  });

  it('explains a high-risk hold more precisely than the legacy string can', () => {
    const decision = KINETIX_POLICY.evaluate(
      projectLegacyConsensusContext({
        summary: {
          approveCount: 2,
          disputeCount: 0,
          abstainCount: 0,
          implicitApproveCount: 0,
          approveTier2Count: 0,
        },
        quorum: 2,
        highRisk: true,
      }),
    );
    expect(decision.unmet).toHaveLength(1);
    expect(decision.unmet[0]).toMatchObject({
      requirementId: 'assurance.approvalWithCapability',
      ruleId: 'high-risk',
      met: false,
      detail: "no approval carries 'model_tier:flagship'",
    });
  });
});
