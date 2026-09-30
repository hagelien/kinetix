/**
 * Shared builder for `PolicyContext` fixtures.
 *
 * A context has eight fields and most tests care about one of them. Spelling
 * all eight out at every call site buries the field under test in noise and
 * makes it easy to change a second field by accident while editing a fixture,
 * so tests here start from one explicit baseline and override exactly what they
 * are exercising.
 */

import {
  EMPTY_ASSURANCE_PROFILE,
  reviewerPoolState,
  riskProfile,
} from 'assurance-core';
import type {
  ActorSnapshot,
  AssuranceProfile,
  PolicyContext,
  ReviewerPoolState,
  RiskProfile,
} from 'assurance-core';

export const AGENT_AUTHOR: ActorSnapshot = {
  actorRef: 'user:1',
  kind: 'agent',
  capabilities: ['edit.parameter.submit'],
  assuranceCapabilities: [],
};

export const HUMAN_AUTHOR: ActorSnapshot = {
  actorRef: 'user:2',
  kind: 'human',
  capabilities: ['edit.parameter.submit'],
  assuranceCapabilities: [],
};

/** A three-agent pool: large enough to supply the full design target of 2. */
export const HEALTHY_POOL: ReviewerPoolState = reviewerPoolState({
  poolSize: 3,
  designTargetQuorum: 2,
});

/** A two-agent pool: one eligible verifier, so the quorum relaxes to 1. */
export const DEGRADED_POOL: ReviewerPoolState = reviewerPoolState({
  poolSize: 2,
  designTargetQuorum: 2,
});

export function makeContext(
  overrides: {
    space?: string;
    targetType?: string;
    proposalVersionId?: string;
    author?: ActorSnapshot;
    risk?: RiskProfile;
    assurance?: Partial<AssuranceProfile>;
    pool?: ReviewerPoolState;
    flags?: readonly string[];
  } = {},
): PolicyContext {
  return {
    space: overrides.space ?? 'kinetix',
    targetType: overrides.targetType ?? 'pending_edit',
    proposalVersionId: overrides.proposalVersionId ?? 'pe:1',
    author: overrides.author ?? AGENT_AUTHOR,
    risk: overrides.risk ?? riskProfile('low'),
    assurance: { ...EMPTY_ASSURANCE_PROFILE, ...(overrides.assurance ?? {}) },
    pool: overrides.pool ?? HEALTHY_POOL,
    flags: overrides.flags ?? [],
  };
}
