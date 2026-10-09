import { describe, expect, it } from 'vitest';
import {
  formatModelName,
  groupAgentsByReviewLevel,
  reviewLevelOf,
  type RosterAgent,
} from './agentRoles';

function agent(overrides: Partial<RosterAgent>): RosterAgent {
  return {
    id: 1,
    name: 'Agent',
    nameEn: null,
    modelTier: null,
    adjudicator: false,
    recentModel: null,
    ...overrides,
  };
}

describe('reviewLevelOf', () => {
  it('maps mid to T1, flagship to T2 and flagship adjudicators to T3', () => {
    expect(reviewLevelOf(agent({ modelTier: 'mid' }))).toBe('T1');
    expect(reviewLevelOf(agent({ modelTier: 'flagship' }))).toBe('T2');
    expect(
      reviewLevelOf(agent({ modelTier: 'flagship', adjudicator: true })),
    ).toBe('T3');
  });

  it('gives light-tier and unclassified agents no review level', () => {
    expect(reviewLevelOf(agent({ modelTier: 'light' }))).toBeNull();
    expect(reviewLevelOf(agent({ modelTier: null }))).toBeNull();
    // The adjudicator grant alone does not seat a non-flagship identity.
    expect(
      reviewLevelOf(agent({ modelTier: 'mid', adjudicator: true })),
    ).toBe('T1');
  });
});

describe('groupAgentsByReviewLevel', () => {
  it('groups agents and drops the ones without a level', () => {
    const groups = groupAgentsByReviewLevel([
      agent({ id: 1, modelTier: 'mid' }),
      agent({ id: 2, modelTier: 'flagship' }),
      agent({ id: 3, modelTier: 'flagship', adjudicator: true }),
      agent({ id: 4, modelTier: 'light' }),
      agent({ id: 5, modelTier: 'mid' }),
    ]);
    expect(groups.T1.map((a) => a.id)).toEqual([1, 5]);
    expect(groups.T2.map((a) => a.id)).toEqual([2]);
    expect(groups.T3.map((a) => a.id)).toEqual([3]);
  });
});

describe('formatModelName', () => {
  it.each([
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
    ['claude-opus-4-7', 'Claude Opus 4.7'],
    ['claude-opus-5-5[1m]', 'Claude Opus 5.5'],
    ['claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet'],
    ['gpt-5.6-sol', 'GPT-5.6 Sol'],
    ['GPT-5.6-Terra', 'GPT-5.6 Terra'],
  ])('formats %s as %s', (id, expected) => {
    expect(formatModelName(id)).toBe(expected);
  });

  it('leaves ids from unknown vendors unchanged', () => {
    expect(formatModelName('o3-mini')).toBe('o3-mini');
    expect(formatModelName('  custom-model ')).toBe('custom-model');
  });
});
