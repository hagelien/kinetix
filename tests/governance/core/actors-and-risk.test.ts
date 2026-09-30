/**
 * Phase 1 core: the actor and risk vocabularies.
 *
 * Small modules, but two of the invariants they encode are the ones an
 * extraction is most likely to lose in translation, so they get direct tests:
 * a self-reported property must never reach the gate, and a rule written for a
 * risk floor must keep applying to anything riskier.
 */
import { describe, expect, it } from 'vitest';
import {
  MODEL_TIER_CAPABILITY_PREFIX,
  RISK_LEVELS,
  atLeastRisk,
  hasAssuranceCapability,
  hasCapability,
  hasRiskTag,
  isAgentActor,
  isHumanActor,
  isRiskLevel,
  modelTierCapability,
  riskProfile,
  riskRank,
  snapshotActor,
} from 'assurance-core';
import type { ActorContext } from 'assurance-core';

describe('actors', () => {
  const actor: ActorContext = {
    actorRef: 'user:7',
    kind: 'agent',
    capabilities: ['review.edit.decide'],
    assuranceCapabilities: [modelTierCapability('flagship')],
    metadata: { selfReportedModel: 'claude-opus-5' },
  };

  it('drops audit metadata when snapshotting for policy evaluation', () => {
    const snapshot = snapshotActor(actor);
    // The gate must not be able to read a self-reported model even by accident.
    expect(snapshot).not.toHaveProperty('metadata');
    expect(Object.keys(snapshot).sort()).toEqual([
      'actorRef',
      'assuranceCapabilities',
      'capabilities',
      'kind',
    ]);
  });

  it('normalises absent assurance capabilities to an empty list', () => {
    const snapshot = snapshotActor({
      actorRef: 'user:8',
      kind: 'human',
      capabilities: [],
    });
    // Absent vs. empty must not fingerprint differently.
    expect(snapshot.assuranceCapabilities).toEqual([]);
  });

  it('copies capability arrays rather than aliasing the caller’s', () => {
    const capabilities = ['a'];
    const snapshot = snapshotActor({
      actorRef: 'user:9',
      kind: 'agent',
      capabilities,
    });
    capabilities.push('b');
    expect(snapshot.capabilities).toEqual(['a']);
  });

  it('separates action capabilities from server-owned assurance capabilities', () => {
    const snapshot = snapshotActor(actor);
    expect(hasCapability(snapshot, 'review.edit.decide')).toBe(true);
    expect(hasCapability(snapshot, 'model_tier:flagship')).toBe(false);
    expect(hasAssuranceCapability(snapshot, 'model_tier:flagship')).toBe(true);
    expect(hasAssuranceCapability(snapshot, 'review.edit.decide')).toBe(false);
  });

  it('builds the model-tier capability from the documented prefix', () => {
    expect(modelTierCapability('flagship')).toBe(
      `${MODEL_TIER_CAPABILITY_PREFIX}flagship`,
    );
    expect(modelTierCapability('mid')).toBe('model_tier:mid');
  });

  it.each([
    ['human', false, true],
    ['agent', true, false],
    // Neither: an automated pipeline must not satisfy a human-in-the-loop
    // requirement, and it is not an accountable agent identity either.
    ['service', false, false],
    ['system', false, false],
  ] as const)('classifies %s as agent=%s human=%s', (kind, agent, human) => {
    expect(isAgentActor({ kind })).toBe(agent);
    expect(isHumanActor({ kind })).toBe(human);
  });
});

describe('risk', () => {
  it('orders levels least- to most-consequential', () => {
    expect(RISK_LEVELS).toEqual(['low', 'medium', 'high']);
    expect(riskRank('low')).toBeLessThan(riskRank('medium'));
    expect(riskRank('medium')).toBeLessThan(riskRank('high'));
  });

  it('treats a level match as a floor, not an equality', () => {
    // The whole point: a rule guarding medium-risk changes must not stop
    // applying to a high-risk one.
    expect(atLeastRisk(riskProfile('high'), 'medium')).toBe(true);
    expect(atLeastRisk(riskProfile('high'), 'high')).toBe(true);
    expect(atLeastRisk(riskProfile('medium'), 'high')).toBe(false);
    expect(atLeastRisk(riskProfile('low'), 'low')).toBe(true);
  });

  it('rejects anything that is not a known level', () => {
    expect(isRiskLevel('high')).toBe(true);
    expect(isRiskLevel('critical')).toBe(false);
    expect(isRiskLevel(2)).toBe(false);
    expect(isRiskLevel(null)).toBe(false);
    expect(isRiskLevel(undefined)).toBe(false);
  });

  it('matches host tags exactly', () => {
    const profile = riskProfile('high', ['calculation_driving', 'entry_backed']);
    expect(hasRiskTag(profile, 'entry_backed')).toBe(true);
    expect(hasRiskTag(profile, 'entry')).toBe(false);
    expect(hasRiskTag(profile, 'clinical_case')).toBe(false);
  });

  it('copies the tag array rather than aliasing the caller’s', () => {
    const tags = ['a'];
    const profile = riskProfile('low', tags);
    tags.push('b');
    expect(profile.tags).toEqual(['a']);
  });
});
