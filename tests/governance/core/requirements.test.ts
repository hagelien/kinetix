/**
 * Phase 1 core: the requirement primitives.
 *
 * Each primitive is a pure predicate that explains itself, so each gets both a
 * boundary test (does it flip at the right count?) and an explanation test (does
 * an unmet outcome say something a held author could act on?).
 */
import { describe, expect, it } from 'vitest';
import {
  REQUIREMENT_IDS,
  approvalWithCapability,
  evidenceRequirementsSatisfied,
  humanApproval,
  humanApprovalWithCapability,
  independentApprovals,
  independentApprovalsFromPool,
  modelTierCapability,
  noDisputingAssessments,
  noOpenDisputes,
} from 'assurance-core';
import {
  DEGRADED_POOL,
  HEALTHY_POOL,
  makeContext,
} from '../support/policy-context.js';

describe('independentApprovals', () => {
  const requirement = independentApprovals(2);

  it('exposes a stable id and its parameters', () => {
    expect(requirement.id).toBe(REQUIREMENT_IDS.independentApprovals);
    expect(requirement.params).toEqual({ count: 2 });
    expect(requirement.describe()).toBe('at least 2 independent approval(s)');
  });

  it.each([
    [0, false],
    [1, false],
    [2, true],
    [3, true],
  ])('with %i independent approver(s) → met=%s', (independentApprovers, met) => {
    const outcome = requirement.evaluate(
      makeContext({ assurance: { independentApprovers } }),
    );
    expect(outcome.met).toBe(met);
    expect(outcome.detail).toBe(`${independentApprovers} of 2 independent approval(s)`);
  });

  it('reads independentApprovers, not the raw approval count', () => {
    // A profile where the author approved its own work but the caller named the
    // author: the fixed target must not be satisfied by the author's own vote.
    const outcome = requirement.evaluate(
      makeContext({
        assurance: { explicitApprovals: 3, independentApprovers: 1 },
      }),
    );
    expect(outcome.met).toBe(false);
  });
});

describe('independentApprovalsFromPool', () => {
  const requirement = independentApprovalsFromPool();

  it('uses the pool’s effective quorum rather than a fixed number', () => {
    const healthy = requirement.evaluate(
      makeContext({ pool: HEALTHY_POOL, assurance: { independentApprovers: 1 } }),
    );
    const degraded = requirement.evaluate(
      makeContext({ pool: DEGRADED_POOL, assurance: { independentApprovers: 1 } }),
    );
    expect(healthy.met).toBe(false);
    expect(degraded.met).toBe(true);
  });

  it('says so in the explanation when the pool is degraded', () => {
    const outcome = requirement.evaluate(
      makeContext({ pool: DEGRADED_POOL, assurance: { independentApprovers: 0 } }),
    );
    // The relaxation must be visible, never silent.
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toContain('pool degraded from a design target of 2');
  });

  it('leaves the degradation note out when the pool is healthy', () => {
    const outcome = requirement.evaluate(
      makeContext({ pool: HEALTHY_POOL, assurance: { independentApprovers: 0 } }),
    );
    expect(outcome.detail).toBe('0 of 2 independent approval(s)');
  });
});

describe('noDisputingAssessments', () => {
  const requirement = noDisputingAssessments();

  it('holds the proposal on a single dispute, however many approvals it carries', () => {
    const outcome = requirement.evaluate(
      makeContext({
        assurance: { independentApprovers: 5, disputingAssessors: 1 },
      }),
    );
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toBe('1 disputing assessor(s)');
  });

  it('is met with no disputing assessors', () => {
    expect(requirement.evaluate(makeContext()).met).toBe(true);
  });
});

describe('noOpenDisputes', () => {
  const requirement = noOpenDisputes();

  it('is a different requirement from a dispute verdict', () => {
    // A formal dispute record can be raised by someone who never assessed.
    const outcome = requirement.evaluate(
      makeContext({ assurance: { disputingAssessors: 0, disputesOpen: 1 } }),
    );
    expect(requirement.id).toBe(REQUIREMENT_IDS.noOpenDisputes);
    expect(requirement.id).not.toBe(REQUIREMENT_IDS.noDisputingAssessments);
    expect(outcome.met).toBe(false);
  });

  it('is met with no open disputes', () => {
    expect(requirement.evaluate(makeContext()).met).toBe(true);
  });
});

describe('approvalWithCapability', () => {
  const requirement = approvalWithCapability(modelTierCapability('flagship'));

  it('is met when an approval carries the capability', () => {
    const outcome = requirement.evaluate(
      makeContext({
        assurance: { approvalCapabilities: ['model_tier:flagship'] },
      }),
    );
    expect(outcome.met).toBe(true);
    expect(outcome.detail).toBe("an approval carries 'model_tier:flagship'");
  });

  it('is unmet when no approval carries it', () => {
    const outcome = requirement.evaluate(
      makeContext({ assurance: { approvalCapabilities: ['model_tier:mid'] } }),
    );
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toBe("no approval carries 'model_tier:flagship'");
  });

  it('fails safe on an unclassified approver', () => {
    // No capability recorded is not the same as "probably fine".
    expect(requirement.evaluate(makeContext()).met).toBe(false);
  });
});

describe('humanApproval', () => {
  const requirement = humanApproval();

  it('is met by a human approver', () => {
    expect(
      requirement.evaluate(makeContext({ assurance: { humanApprovals: 1 } })).met,
    ).toBe(true);
  });

  it('is not met by agent approvals alone, however many', () => {
    const outcome = requirement.evaluate(
      makeContext({
        assurance: { agentApprovals: 9, explicitApprovals: 9, independentApprovers: 9 },
      }),
    );
    expect(outcome.met).toBe(false);
  });
});

describe('humanApprovalWithCapability', () => {
  const requirement = humanApprovalWithCapability('clinical_expert');

  it('is not satisfiable by an unqualified human plus a qualified agent', () => {
    // The exact split humanApprovalCapabilities exists to prevent.
    const outcome = requirement.evaluate(
      makeContext({
        assurance: {
          humanApprovals: 1,
          approvalCapabilities: ['clinical_expert'],
          humanApprovalCapabilities: [],
        },
      }),
    );
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toBe("no human approval carries 'clinical_expert'");
  });

  it('is met when one human approver holds the capability', () => {
    const outcome = requirement.evaluate(
      makeContext({
        assurance: {
          humanApprovals: 1,
          approvalCapabilities: ['clinical_expert'],
          humanApprovalCapabilities: ['clinical_expert'],
        },
      }),
    );
    expect(outcome.met).toBe(true);
  });
});

describe('evidenceRequirementsSatisfied', () => {
  const requirement = evidenceRequirementsSatisfied();

  it('is vacuously met when the host declared none', () => {
    expect(requirement.evaluate(makeContext()).met).toBe(true);
  });

  it('names the unsatisfied requirements so they can be fixed in one pass', () => {
    const outcome = requirement.evaluate(
      makeContext({
        assurance: {
          evidenceRequirementState: [
            { requirementId: 'primary_citation', satisfied: false },
            { requirementId: 'matrix_stated', satisfied: true },
            { requirementId: 'unit_stated', satisfied: false },
          ],
        },
      }),
    );
    expect(outcome.met).toBe(false);
    expect(outcome.detail).toBe('unsatisfied: primary_citation, unit_stated');
  });
});

describe('every primitive', () => {
  const all = [
    independentApprovals(1),
    independentApprovalsFromPool(),
    noDisputingAssessments(),
    noOpenDisputes(),
    approvalWithCapability('x'),
    humanApproval(),
    humanApprovalWithCapability('x'),
    evidenceRequirementsSatisfied(),
  ];

  it('uses a declared, unique requirement id', () => {
    const declared = new Set(Object.values(REQUIREMENT_IDS));
    for (const requirement of all) {
      expect(declared.has(requirement.id as never)).toBe(true);
    }
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
  });

  it('is deterministic and free of hidden state', () => {
    const context = makeContext({
      assurance: { independentApprovers: 1, humanApprovals: 1 },
    });
    for (const requirement of all) {
      expect(requirement.evaluate(context)).toEqual(requirement.evaluate(context));
    }
  });

  it('echoes its description into every outcome', () => {
    const context = makeContext();
    for (const requirement of all) {
      expect(requirement.evaluate(context).description).toBe(requirement.describe());
      expect(requirement.evaluate(context).requirementId).toBe(requirement.id);
    }
  });

  it('freezes its parameters against mutation by a caller', () => {
    const requirement = independentApprovals(2);
    expect(() => {
      (requirement.params as Record<string, unknown>).count = 1;
    }).toThrow();
    expect(requirement.params).toEqual({ count: 2 });
  });
});
