/**
 * Phase 1 core: assurance tallying and reviewer-pool arithmetic.
 *
 * Counting is the whole job of this module, so the tests are mostly about the
 * things that must NOT be counted: an implicit submit-time stake, a reviewer's
 * superseded earlier verdict, an author's own approval when the caller has said
 * who the author is.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_ASSURANCE_PROFILE,
  assessmentFromActor,
  effectiveIndependentQuorum,
  modelTierCapability,
  poolStateFromEffectiveQuorum,
  reviewerPoolState,
  tallyAssurance,
} from 'assurance-core';
import type { Assessment } from 'assurance-core';

function approval(
  ref: string,
  overrides: Partial<Assessment> = {},
): Assessment {
  return {
    assessorRef: ref,
    assessorKind: 'agent',
    verdict: 'approve',
    implicit: false,
    ...overrides,
  };
}

describe('tallyAssurance', () => {
  it('returns an all-zero profile for no assessments', () => {
    expect(tallyAssurance([])).toEqual(EMPTY_ASSURANCE_PROFILE);
  });

  it('counts explicit approvals and ignores implicit stakes for quorum', () => {
    const profile = tallyAssurance([
      approval('agent:1', { implicit: true }),
      approval('agent:2'),
    ]);
    // The author's submit-time stake is evidence of authorship, not of review.
    expect(profile.implicitApprovals).toBe(1);
    expect(profile.explicitApprovals).toBe(1);
    expect(profile.independentApprovers).toBe(1);
  });

  it('collapses a reviewer’s revised verdict to its latest position', () => {
    const profile = tallyAssurance([
      approval('agent:1'),
      { ...approval('agent:1'), verdict: 'dispute' },
    ]);
    // One reviewer holds one position, not two.
    expect(profile.explicitApprovals).toBe(0);
    expect(profile.disputingAssessors).toBe(1);
  });

  it('does not net disputes off against approvals', () => {
    const profile = tallyAssurance([
      approval('agent:1'),
      approval('agent:2'),
      { ...approval('agent:3'), verdict: 'dispute' },
    ]);
    expect(profile.explicitApprovals).toBe(2);
    expect(profile.disputingAssessors).toBe(1);
  });

  it('counts abstentions separately from both', () => {
    const profile = tallyAssurance([
      { ...approval('agent:1'), verdict: 'abstain' },
    ]);
    expect(profile.abstentions).toBe(1);
    expect(profile.explicitApprovals).toBe(0);
    expect(profile.disputingAssessors).toBe(0);
  });

  it('excludes the author from independentApprovers only when told who it is', () => {
    const assessments = [approval('agent:1'), approval('agent:2')];
    const anonymous = tallyAssurance(assessments);
    expect(anonymous.explicitApprovals).toBe(2);
    expect(anonymous.independentApprovers).toBe(2);

    const attributed = tallyAssurance(assessments, { authorRef: 'agent:1' });
    expect(attributed.explicitApprovals).toBe(2);
    expect(attributed.independentApprovers).toBe(1);
  });

  it('splits approver kinds and keeps human capabilities separate', () => {
    const profile = tallyAssurance([
      approval('agent:1', {
        assuranceCapabilities: [modelTierCapability('flagship')],
      }),
      approval('user:5', {
        assessorKind: 'human',
        assuranceCapabilities: ['clinical_expert'],
      }),
    ]);
    expect(profile.agentApprovals).toBe(1);
    expect(profile.humanApprovals).toBe(1);
    expect(profile.approvalCapabilities).toEqual([
      'clinical_expert',
      'model_tier:flagship',
    ]);
    // The agent's tier must not leak into the human-held set — otherwise
    // "a human expert approved this" becomes satisfiable by two actors.
    expect(profile.humanApprovalCapabilities).toEqual(['clinical_expert']);
  });

  it('takes capabilities only from explicit approvals', () => {
    const profile = tallyAssurance([
      approval('agent:1', {
        implicit: true,
        assuranceCapabilities: [modelTierCapability('flagship')],
      }),
      { ...approval('agent:2'), verdict: 'dispute', assuranceCapabilities: ['x'] },
    ]);
    // An author's own stake and a dissenting verdict are not approvals; neither
    // may hand the proposal a capability it has not actually earned.
    expect(profile.approvalCapabilities).toEqual([]);
  });

  it('sorts capabilities so equal inputs fingerprint equally', () => {
    const a = tallyAssurance([approval('agent:1', { assuranceCapabilities: ['b', 'a'] })]);
    const b = tallyAssurance([approval('agent:1', { assuranceCapabilities: ['a', 'b'] })]);
    expect(a.approvalCapabilities).toEqual(['a', 'b']);
    expect(a).toEqual(b);
  });

  it('counts only open disputes', () => {
    const profile = tallyAssurance([], {
      disputes: [
        { disputeId: 'd1', openedByRef: 'user:3', openedByKind: 'human', open: true },
        { disputeId: 'd2', openedByRef: 'user:4', openedByKind: 'human', open: false },
      ],
    });
    expect(profile.disputesOpen).toBe(1);
  });

  it('carries evidence requirement state through unchanged', () => {
    const profile = tallyAssurance([], {
      evidenceRequirementState: [{ requirementId: 'citation', satisfied: false }],
    });
    expect(profile.evidenceRequirementState).toEqual([
      { requirementId: 'citation', satisfied: false },
    ]);
  });
});

describe('assessmentFromActor', () => {
  it('snapshots the actor’s assurance capabilities onto the assessment', () => {
    const assessment = assessmentFromActor(
      {
        actorRef: 'agent:1',
        kind: 'agent',
        capabilities: ['review.verify'],
        assuranceCapabilities: [modelTierCapability('flagship')],
      },
      'approve',
    );
    expect(assessment).toEqual({
      assessorRef: 'agent:1',
      assessorKind: 'agent',
      verdict: 'approve',
      implicit: false,
      assuranceCapabilities: ['model_tier:flagship'],
    });
    // Action capabilities are not assurance capabilities and must not ride along.
    expect(assessment.assuranceCapabilities).not.toContain('review.verify');
  });
});

describe('effectiveIndependentQuorum', () => {
  it('clamps the design target down to what the pool can supply', () => {
    expect(effectiveIndependentQuorum(3, 2)).toBe(2);
    expect(effectiveIndependentQuorum(2, 2)).toBe(2);
    expect(effectiveIndependentQuorum(1, 2)).toBe(1);
  });

  it('never returns zero, however empty the pool', () => {
    // A quorum of zero would mean "publishes with no review at all" — never the
    // safe direction to fail in.
    expect(effectiveIndependentQuorum(0, 2)).toBe(1);
    expect(effectiveIndependentQuorum(-5, 2)).toBe(1);
  });
});

describe('reviewerPoolState', () => {
  it('excludes the author from the eligible pool by default', () => {
    const state = reviewerPoolState({ poolSize: 3, designTargetQuorum: 2 });
    expect(state).toEqual({
      size: 3,
      eligibleVerifiers: 2,
      designTargetQuorum: 2,
      effectiveQuorum: 2,
      degraded: false,
    });
  });

  it('reports degradation when the pool cannot reach the design target', () => {
    const state = reviewerPoolState({ poolSize: 2, designTargetQuorum: 2 });
    expect(state.eligibleVerifiers).toBe(1);
    expect(state.effectiveQuorum).toBe(1);
    expect(state.degraded).toBe(true);
  });

  it('raises rather than lowers the bar when the author may review its own work', () => {
    // The flag adds a reviewer to the pool; it is not an escape hatch. With two
    // reviewers the quorum goes UP from 1 to 2.
    const without = reviewerPoolState({ poolSize: 2, designTargetQuorum: 2 });
    const with_ = reviewerPoolState({
      poolSize: 2,
      designTargetQuorum: 2,
      authorIsEligibleVerifier: true,
    });
    expect(without.effectiveQuorum).toBe(1);
    expect(with_.effectiveQuorum).toBe(2);
    expect(with_.degraded).toBe(false);
  });

  it('still degrades for a lone self-reviewing author', () => {
    const state = reviewerPoolState({
      poolSize: 1,
      designTargetQuorum: 2,
      authorIsEligibleVerifier: true,
    });
    expect(state.effectiveQuorum).toBe(1);
    expect(state.degraded).toBe(true);
  });
});

describe('poolStateFromEffectiveQuorum', () => {
  it('leaves the pool size unknown rather than back-deriving one', () => {
    const state = poolStateFromEffectiveQuorum({
      effectiveQuorum: 1,
      designTargetQuorum: 2,
    });
    // Several pools produce the same clamped quorum, and this state is
    // fingerprinted into decision records — a guess would be recorded as fact.
    expect(state.size).toBeNull();
    expect(state.eligibleVerifiers).toBeNull();
    expect(state.effectiveQuorum).toBe(1);
    expect(state.degraded).toBe(true);
  });
});
