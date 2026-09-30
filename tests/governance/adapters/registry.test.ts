/**
 * Phase 2: the target-adapter registry (§4.5).
 *
 * The registry's job is to replace `switch (targetType)` with a lookup. Its
 * value therefore rests on two properties that are easy to lose: a lookup is
 * scoped to a knowledge space, and a registration cannot be silently replaced.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DuplicateAdapterError,
  UnknownTargetTypeError,
  findKnowledgeTargetAdapter,
  getKnowledgeTargetAdapter,
  registerKnowledgeTargetAdapter,
  registeredTargetTypes,
  resetKnowledgeTargetAdaptersForTests,
} from '../../../api/_lib/knowledge-governance/registry.js';
import { validationOk, type KnowledgeTargetAdapter } from '../../../api/_lib/knowledge-governance/target-adapter.js';
import { riskProfile } from 'assurance-core';

function stubAdapter(space: string, type: string): KnowledgeTargetAdapter {
  return {
    space,
    type,
    loadCurrent: async () => null,
    loadVersion: async () => null,
    validateProposal: async () => validationOk(),
    fingerprint: () => 'stub',
    buildReviewPacket: async () => {
      throw new Error('not used');
    },
    classifyRisk: async () => riskProfile('low'),
    evidenceRequirements: async () => [],
  };
}

beforeEach(() => {
  resetKnowledgeTargetAdaptersForTests();
});

describe('adapter registry', () => {
  it('returns the adapter registered for a type', () => {
    const adapter = stubAdapter('kinetix', 'wiki_revision');
    registerKnowledgeTargetAdapter(adapter);
    expect(getKnowledgeTargetAdapter('kinetix', 'wiki_revision')).toBe(adapter);
  });

  it('keys on (space, type), so two spaces can both govern a type name', () => {
    const kinetix = stubAdapter('kinetix', 'wiki_fact');
    const other = stubAdapter('other-space', 'wiki_fact');
    registerKnowledgeTargetAdapter(kinetix);
    registerKnowledgeTargetAdapter(other);
    expect(getKnowledgeTargetAdapter('kinetix', 'wiki_fact')).toBe(kinetix);
    expect(getKnowledgeTargetAdapter('other-space', 'wiki_fact')).toBe(other);
  });

  it('refuses to overwrite an existing registration', () => {
    registerKnowledgeTargetAdapter(stubAdapter('kinetix', 'pending_edit'));
    expect(() =>
      registerKnowledgeTargetAdapter(stubAdapter('kinetix', 'pending_edit')),
    ).toThrow(DuplicateAdapterError);
  });

  it('throws for an unregistered type rather than returning nothing', () => {
    // Fail-safe direction (§1.6): a caller routing a real proposal must not be
    // able to skip the governance check by naming a type nobody registered.
    expect(() => getKnowledgeTargetAdapter('kinetix', 'nope')).toThrow(
      UnknownTargetTypeError,
    );
  });

  it('offers a non-throwing lookup for callers that are probing', () => {
    expect(findKnowledgeTargetAdapter('kinetix', 'nope')).toBeNull();
  });

  it('lists a space’s registered types, sorted, without the other space’s', () => {
    registerKnowledgeTargetAdapter(stubAdapter('kinetix', 'wiki_revision'));
    registerKnowledgeTargetAdapter(stubAdapter('kinetix', 'paper_review'));
    registerKnowledgeTargetAdapter(stubAdapter('other-space', 'wiki_revision'));
    expect(registeredTargetTypes('kinetix')).toEqual([
      'paper_review',
      'wiki_revision',
    ]);
    expect(registeredTargetTypes('other-space')).toEqual(['wiki_revision']);
  });
});
