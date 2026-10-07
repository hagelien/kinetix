/**
 * Phase 1: Kinetix's policy set and its verification-level projection.
 *
 * The consensus half of this policy is pinned against the frozen legacy
 * algorithm in `kinetix-consensus-parity.test.ts`. This file covers the rest:
 * the rules that state invariants Kinetix enforces elsewhere in the request
 * path (an unattributed proposal never publishes on agent consensus; a clinical case
 * needs a qualified person), and the 0–3 projection §7.3 of the extraction plan
 * requires the host to keep owning.
 */
import { describe, expect, it } from 'vitest';
import {
  buildKinetixPolicy,
  KINETIX_CLINICAL_CASE_TAG,
  KINETIX_CLINICAL_EXPERT_CAPABILITY,
  KINETIX_DESIGN_TARGET_QUORUM,
  KINETIX_FLAGSHIP_CAPABILITY,
  KINETIX_POLICY,
  KINETIX_POLICY_ID,
  KINETIX_POLICY_VERSION,
  KINETIX_RULE_IDS,
} from '../../../src/lib/assurance/policy.js';
import {
  governanceEffectiveConsensusQuorum,
  projectKinetixVerificationLevel,
  KINETIX_SPACE,
} from '../../../src/lib/assurance/projection.js';
import { EMPTY_ASSURANCE_PROFILE, riskProfile } from 'assurance-core';
import { computeVerificationLevel } from '../../../src/lib/verificationLevel.js';
import {
  AGENT_AUTHOR,
  DEGRADED_POOL,
  HEALTHY_POOL,
  HUMAN_AUTHOR,
  makeContext,
} from '../support/policy-context.js';

describe('the Kinetix policy set', () => {
  it('is identified and versioned', () => {
    expect(KINETIX_POLICY.id).toBe(KINETIX_POLICY_ID);
    expect(KINETIX_POLICY.version).toBe(KINETIX_POLICY_VERSION);
    expect(KINETIX_SPACE).toBe('kinetix');
  });

  it('declares its four rules in the order the projection depends on', () => {
    // `consensusHoldReasonFromDecision` maps the FIRST unmet requirement onto a
    // legacy hold reason, so reordering these silently changes what a held
    // proposal reports.
    expect(KINETIX_POLICY.rules.map((r) => r.id)).toEqual([
      KINETIX_RULE_IDS.base,
      KINETIX_RULE_IDS.unattributed,
      KINETIX_RULE_IDS.highRisk,
      KINETIX_RULE_IDS.clinicalCase,
    ]);
  });

  it('states the base rule as no-disputes plus the pool-adapted quorum', () => {
    const base = KINETIX_POLICY.describe()[0]!;
    expect(base.when).toBeNull();
    expect(base.requirements.map((r) => r.id)).toEqual([
      'assurance.noDisputingAssessments',
      'assurance.independentApprovals.pool',
    ]);
  });

  it('builds an independent instance each time, sharing no mutable state', () => {
    const a = buildKinetixPolicy();
    const b = buildKinetixPolicy();
    expect(a).not.toBe(b);
    expect(a.describe()).toEqual(b.describe());
  });

  describe('base rule', () => {
    it('holds a proposal on a single dispute, however many approvals it has', () => {
      const decision = KINETIX_POLICY.evaluate(
        makeContext({
          assurance: { independentApprovers: 5, disputingAssessors: 1 },
        }),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.unmet.map((o) => o.requirementId)).toEqual([
        'assurance.noDisputingAssessments',
      ]);
    });

    it('adapts to a degraded pool rather than stranding the proposal', () => {
      const assurance = { independentApprovers: 1 };
      expect(
        KINETIX_POLICY.evaluate(makeContext({ pool: HEALTHY_POOL, assurance })).allowed,
      ).toBe(false);
      expect(
        KINETIX_POLICY.evaluate(makeContext({ pool: DEGRADED_POOL, assurance })).allowed,
      ).toBe(true);
    });
  });

  describe('authorship', () => {
    it('publishes a person\u2019s proposal on agent approvals, like an agent\u2019s', () => {
      const decision = KINETIX_POLICY.evaluate(
        makeContext({
          author: HUMAN_AUTHOR,
          assurance: { independentApprovers: 2, agentApprovals: 2 },
        }),
      );
      expect(decision.matchedRuleIds).not.toContain(KINETIX_RULE_IDS.humanAuthored);
      expect(decision.allowed).toBe(true);
    });

    it('requires a human approval for a proposal with no recorded author', () => {
      const decision = KINETIX_POLICY.evaluate(
        makeContext({
          author: { ...HUMAN_AUTHOR, kind: 'system' },
          assurance: { independentApprovers: 4, agentApprovals: 4 },
        }),
      );
      expect(decision.matchedRuleIds).toContain(KINETIX_RULE_IDS.unattributed);
      expect(decision.allowed).toBe(false);
      expect(decision.unmet.map((o) => o.requirementId)).toEqual([
        'assurance.humanApproval',
      ]);
    });

    it('does not apply the unattributed rule to an agent-authored proposal', () => {
      const decision = KINETIX_POLICY.evaluate(
        makeContext({
          author: AGENT_AUTHOR,
          assurance: { independentApprovers: 2, agentApprovals: 2 },
        }),
      );
      expect(decision.matchedRuleIds).not.toContain(KINETIX_RULE_IDS.unattributed);
      expect(decision.allowed).toBe(true);
    });
  });

  describe('high-risk rule', () => {
    const highRisk = riskProfile('high');

    it('refuses the degraded single-approval path', () => {
      const decision = KINETIX_POLICY.evaluate(
        makeContext({
          risk: highRisk,
          pool: DEGRADED_POOL,
          assurance: {
            independentApprovers: 1,
            approvalCapabilities: [KINETIX_FLAGSHIP_CAPABILITY],
          },
        }),
      );
      // The pool quorum is satisfied — but a calculation-driving value waits for
      // the full design target rather than publishing under a relaxed one.
      expect(decision.allowed).toBe(false);
      expect(decision.unmet.map((o) => o.requirementId)).toEqual([
        'assurance.independentApprovals',
      ]);
      expect(KINETIX_DESIGN_TARGET_QUORUM).toBe(2);
    });

    it('refuses two mid-tier approvals with no flagship among them', () => {
      const decision = KINETIX_POLICY.evaluate(
        makeContext({
          risk: highRisk,
          assurance: {
            independentApprovers: 2,
            approvalCapabilities: ['model_tier:mid'],
          },
        }),
      );
      expect(decision.allowed).toBe(false);
      expect(decision.unmet.map((o) => o.requirementId)).toEqual([
        'assurance.approvalWithCapability',
      ]);
    });

    it('fails safe when no approver tier was recorded at all', () => {
      const decision = KINETIX_POLICY.evaluate(
        makeContext({ risk: highRisk, assurance: { independentApprovers: 2 } }),
      );
      expect(decision.allowed).toBe(false);
    });

    it('allows two independent approvals including a flagship one', () => {
      const decision = KINETIX_POLICY.evaluate(
        makeContext({
          risk: highRisk,
          assurance: {
            independentApprovers: 2,
            approvalCapabilities: [KINETIX_FLAGSHIP_CAPABILITY],
          },
        }),
      );
      expect(decision.allowed).toBe(true);
    });

    it('applies to medium risk only if the host classified it high', () => {
      // The rule's floor is `high`; medium-risk content is governed by the base
      // rule alone.
      const decision = KINETIX_POLICY.evaluate(
        makeContext({
          risk: riskProfile('medium'),
          assurance: { independentApprovers: 2 },
        }),
      );
      expect(decision.matchedRuleIds).not.toContain(KINETIX_RULE_IDS.highRisk);
      expect(decision.allowed).toBe(true);
    });
  });

  describe('clinical-case rule', () => {
    const clinical = riskProfile('low', [KINETIX_CLINICAL_CASE_TAG]);

    it('is not satisfied by a qualified agent standing in for a clinician', () => {
      const decision = KINETIX_POLICY.evaluate(
        makeContext({
          risk: clinical,
          assurance: {
            independentApprovers: 2,
            humanApprovals: 1,
            approvalCapabilities: [KINETIX_CLINICAL_EXPERT_CAPABILITY],
            humanApprovalCapabilities: [],
          },
        }),
      );
      expect(decision.matchedRuleIds).toContain(KINETIX_RULE_IDS.clinicalCase);
      expect(decision.allowed).toBe(false);
      expect(decision.unmet.map((o) => o.requirementId)).toEqual([
        'assurance.humanApprovalWithCapability',
      ]);
    });

    it('is satisfied by one human who holds clinical standing', () => {
      const decision = KINETIX_POLICY.evaluate(
        makeContext({
          risk: clinical,
          assurance: {
            independentApprovers: 2,
            humanApprovals: 1,
            approvalCapabilities: [KINETIX_CLINICAL_EXPERT_CAPABILITY],
            humanApprovalCapabilities: [KINETIX_CLINICAL_EXPERT_CAPABILITY],
          },
        }),
      );
      expect(decision.allowed).toBe(true);
    });

    it('does not apply to untagged content', () => {
      const decision = KINETIX_POLICY.evaluate(
        makeContext({ assurance: { independentApprovers: 2 } }),
      );
      expect(decision.matchedRuleIds).not.toContain(KINETIX_RULE_IDS.clinicalCase);
    });
  });

  it('stacks every applicable rule for an unattributed high-risk clinical case', () => {
    const decision = KINETIX_POLICY.evaluate(
      makeContext({
        author: { ...HUMAN_AUTHOR, kind: 'system' },
        risk: riskProfile('high', [KINETIX_CLINICAL_CASE_TAG]),
        assurance: { disputingAssessors: 1 },
      }),
    );
    expect(decision.matchedRuleIds).toEqual([
      KINETIX_RULE_IDS.base,
      KINETIX_RULE_IDS.unattributed,
      KINETIX_RULE_IDS.highRisk,
      KINETIX_RULE_IDS.clinicalCase,
    ]);
    // Every reason at once, so an author can fix them in one pass.
    expect(decision.unmet.map((o) => o.requirementId)).toEqual([
      'assurance.noDisputingAssessments',
      'assurance.independentApprovals.pool',
      'assurance.humanApproval',
      'assurance.independentApprovals',
      'assurance.approvalWithCapability',
      'assurance.humanApprovalWithCapability',
    ]);
  });
});

describe('governanceEffectiveConsensusQuorum', () => {
  it('uses the policy’s design target', () => {
    expect(governanceEffectiveConsensusQuorum(10)).toBe(KINETIX_DESIGN_TARGET_QUORUM);
  });
});

describe('projectKinetixVerificationLevel', () => {
  const AGENT_APPROVALS = [0, 1, 2, 3];
  const IMPLICIT_APPROVALS = [0, 1, 2];

  it('matches computeVerificationLevel across the whole input space', () => {
    // §7.3: the 0–3 scale stays a projection out of the generic profile, with
    // computeVerificationLevel remaining the single place its thresholds live.
    const mismatches: string[] = [];
    for (const agentApprovals of AGENT_APPROVALS) {
      for (const implicitApprovals of IMPLICIT_APPROVALS) {
        for (const humanApprovals of [0, 1, 2]) {
          for (const authorSelfVerified of [false, true]) {
            const projected = projectKinetixVerificationLevel(
              {
                ...EMPTY_ASSURANCE_PROFILE,
                agentApprovals,
                implicitApprovals,
                humanApprovals,
              },
              { authorSelfVerified },
            );
            const expected = computeVerificationLevel({
              agentApprovers: agentApprovals + implicitApprovals,
              hasHumanApprover: humanApprovals >= 1,
              authorSelfVerified,
            });
            if (projected.level !== expected) {
              mismatches.push(
                `agent=${agentApprovals} implicit=${implicitApprovals} ` +
                  `human=${humanApprovals} selfVerified=${authorSelfVerified}: ` +
                  `expected ${expected}, got ${projected.level}`,
              );
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('reaches all four levels somewhere in that space', () => {
    const levels = new Set<number>();
    for (const agentApprovals of AGENT_APPROVALS) {
      for (const humanApprovals of [0, 1]) {
        levels.add(
          projectKinetixVerificationLevel({
            ...EMPTY_ASSURANCE_PROFILE,
            agentApprovals,
            humanApprovals,
          }).level,
        );
      }
    }
    expect(levels).toEqual(new Set([0, 1, 2, 3]));
  });

  it('counts the submit-time stake toward the agent tally', () => {
    // Level 1 means "its author only", not "nobody".
    const profile = { ...EMPTY_ASSURANCE_PROFILE, implicitApprovals: 1 };
    expect(projectKinetixVerificationLevel(profile).level).toBe(1);
  });

  it('surfaces disputes beside the level rather than lowering it', () => {
    const profile = {
      ...EMPTY_ASSURANCE_PROFILE,
      agentApprovals: 2,
      humanApprovals: 1,
      disputingAssessors: 1,
    };
    const info = projectKinetixVerificationLevel(profile);
    expect(info).toEqual({ level: 3, disputed: true });
  });

  it('defaults authorSelfVerified to false', () => {
    const profile = { ...EMPTY_ASSURANCE_PROFILE, agentApprovals: 1 };
    expect(projectKinetixVerificationLevel(profile).level).toBe(1);
    expect(
      projectKinetixVerificationLevel(profile, { authorSelfVerified: true }).level,
    ).toBe(2);
  });
});
