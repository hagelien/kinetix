/**
 * Phase 2: adapter-level behaviour that does not need a database.
 *
 * Risk classification and fingerprinting are the two places where an adapter
 * makes a judgment rather than copying a column, so they get direct tests. Risk
 * in particular must agree with the gate Kinetix already enforces — a layer
 * that states a stricter policy than the live path enforces is describing a
 * system that does not exist (§1.7).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  KINETIX_ADAPTERS,
  registerKinetixAdapters,
} from '../../../api/_lib/knowledge-governance/adapters/kinetix/index.js';
import { drugParameterRevisionAdapter } from '../../../api/_lib/knowledge-governance/adapters/kinetix/drug-parameter-revision.js';
import { pendingEditAdapter } from '../../../api/_lib/knowledge-governance/adapters/kinetix/pending-edit.js';
import { drugDiscussionAdapter } from '../../../api/_lib/knowledge-governance/adapters/kinetix/drug-discussion.js';
import { referenceIdList } from '../../../api/_lib/knowledge-governance/adapters/kinetix/support.js';
import {
  registeredTargetTypes,
  resetKnowledgeTargetAdaptersForTests,
} from '../../../api/_lib/knowledge-governance/registry.js';
import { isHighRiskPendingEdit } from '../../../api/_lib/agent-verifications.js';
import {
  AGENT_VERIFICATION_TARGET_TYPES,
  APPROVAL_TARGET_TYPES,
} from '../../../api/_lib/schemas.js';
import type { ProposalVersion } from '../../../api/_lib/knowledge-governance/target-adapter.js';

function version(type: string, payload: unknown): ProposalVersion {
  return {
    ref: { proposalId: `${type}:1`, versionId: `${type}:1@v` },
    target: { space: 'kinetix', type, id: '1' },
    payload,
    targetVersion: 'v',
    createdAt: '2026-01-01T00:00:00.000Z',
    authorRef: 'user:1',
  };
}

beforeEach(() => {
  resetKnowledgeTargetAdaptersForTests();
});

describe('registerKinetixAdapters', () => {
  it('registers every adapter in the set', () => {
    registerKinetixAdapters();
    expect(registeredTargetTypes('kinetix')).toHaveLength(KINETIX_ADAPTERS.length);
  });

  it('is a no-op when called twice, rather than throwing or replacing', () => {
    registerKinetixAdapters();
    expect(() => registerKinetixAdapters()).not.toThrow();
    expect(registeredTargetTypes('kinetix')).toHaveLength(KINETIX_ADAPTERS.length);
  });

  it('still raises when a DIFFERENT adapter holds one of its types', async () => {
    // Codex P2: skipping by type name defeated the check the registry exists
    // for — a foreign adapter holding `pending_edit` would be left in place,
    // DuplicateAdapterError would never fire, and the wrong code would go on
    // deciding what a drug parameter means. Idempotence has to be by identity.
    const { DuplicateAdapterError, registerKnowledgeTargetAdapter } =
      await import('../../../api/_lib/knowledge-governance/registry.js');
    registerKnowledgeTargetAdapter({
      ...pendingEditAdapter,
      // A different object with the same (space, type).
      fingerprint: () => 'impostor',
    });
    expect(() => registerKinetixAdapters()).toThrow(DuplicateAdapterError);
  });

  it('covers every target type an agent verdict may name', () => {
    // Phase 2's exit gate, executable against the enum the POST route
    // validates against rather than a list kept in step by hand: a seventh
    // verification target added later fails here until it has an adapter.
    registerKinetixAdapters();
    const registered = new Set(registeredTargetTypes('kinetix'));
    for (const type of AGENT_VERIFICATION_TARGET_TYPES) {
      expect(registered.has(type)).toBe(true);
    }
  });

  it('covers every approval target type too, served or not', () => {
    // `learning_unit_revision` is in the approvals taxonomy but deliberately
    // excluded from the queue's interleaved set (Phase 0 doc §5.2). It is
    // represented anyway — "every currently supported verification target"
    // means supported, not served.
    registerKinetixAdapters();
    const registered = new Set(registeredTargetTypes('kinetix'));
    for (const type of [...APPROVAL_TARGET_TYPES, 'learning_unit_revision']) {
      expect(registered.has(type)).toBe(true);
    }
  });

  it('gives every adapter the Kinetix space and a distinct type', () => {
    const types = KINETIX_ADAPTERS.map((a) => a.type);
    expect(new Set(types).size).toBe(types.length);
    expect(KINETIX_ADAPTERS.every((a) => a.space === 'kinetix')).toBe(true);
  });
});

describe('risk classification agrees with the live consensus gate', () => {
  it.each([
    ['parameter', 'halfLife', 'high'],
    ['param_entry', 'clearance', 'high'],
    ['parameter', 'analyteStability', 'medium'],
    ['parameter', 'notAParam', 'medium'],
    ['wiki_fact', null, 'medium'],
    ['param_entry', null, 'medium'],
  ])(
    'classifies a %s edit on %s as %s risk',
    async (editType, parameter, expected) => {
      const risk = await pendingEditAdapter.classifyRisk({
        version: version('pending_edit', { editType, parameter }),
        current: null,
      });
      expect(risk.level).toBe(expected);
      // The predicate is not re-derived here — it IS `isHighRiskPendingEdit`,
      // so the two cannot drift into disagreeing about what is calc-driving.
      expect(risk.level === 'high').toBe(
        isHighRiskPendingEdit({ editType, parameter }),
      );
    },
  );

  it('tags a high-risk edit as calculation-driving', async () => {
    const risk = await pendingEditAdapter.classifyRisk({
      version: version('pending_edit', {
        editType: 'parameter',
        parameter: 'halfLife',
      }),
      current: null,
    });
    expect(risk.tags).toContain('calculation_driving');
  });

  it('applies the same rule to an already-applied parameter revision', async () => {
    const high = await drugParameterRevisionAdapter.classifyRisk({
      version: version('drug_parameter_revision', { parameter: 'halfLife' }),
      current: null,
    });
    const low = await drugParameterRevisionAdapter.classifyRisk({
      version: version('drug_parameter_revision', { parameter: 'analyteStability' }),
      current: null,
    });
    expect(high.level).toBe('high');
    expect(low.level).toBe('medium');
  });

  it('never classifies a discussion comment above low', async () => {
    // Nothing about a comment publishes knowledge.
    const risk = await drugDiscussionAdapter.classifyRisk({
      version: version('drug_discussion', { body: 'hei' }),
      current: null,
    });
    expect(risk.level).toBe('low');
  });
});

describe('evidence requirements', () => {
  it('marks the citation requirement blocking only for high-risk edits', async () => {
    const high = await pendingEditAdapter.evidenceRequirements({
      version: version('pending_edit', { editType: 'parameter', parameter: 'halfLife' }),
      actor: { actorRef: 'user:1', kind: 'agent', capabilities: [] },
      risk: { level: 'high', tags: [] },
    });
    const medium = await pendingEditAdapter.evidenceRequirements({
      version: version('pending_edit', { editType: 'wiki_fact', parameter: null }),
      actor: { actorRef: 'user:1', kind: 'agent', capabilities: [] },
      risk: { level: 'medium', tags: [] },
    });
    expect(high[0]!.blocking).toBe(true);
    // Not a softening: the submit endpoint already refuses an unreferenced
    // edit, so marking it blocking here would claim this layer is the gate.
    expect(medium[0]!.blocking).toBe(false);
  });
});

describe('the citations a review packet carries', () => {
  it('falls back to the singular id when the plural column is empty', () => {
    // `reference_ids = '{}'` is a row that never set the plural column, not one
    // citing nothing — the same rule the review card and the approval's
    // citation gate read. A packet that fell back only on null showed a
    // verifier no citation at all for a legacy row, so a peer verdict could be
    // formed without the evidence the moderator is looking at.
    expect(referenceIdList([], 7)).toEqual([7]);
    expect(referenceIdList(null, 7)).toEqual([7]);
    expect(referenceIdList([9, 11], 7)).toEqual([9, 11]);
    expect(referenceIdList([], null)).toEqual([]);
  });
});

describe('fingerprints', () => {
  const proposal = { parameter: 'halfLife', newValue: { value: 30 } };
  const current = { value: { value: 20 } };

  it('is stable for identical inputs', () => {
    expect(drugParameterRevisionAdapter.fingerprint({ proposal, current })).toBe(
      drugParameterRevisionAdapter.fingerprint({ proposal, current }),
    );
  });

  it('changes when the proposal changes', () => {
    expect(drugParameterRevisionAdapter.fingerprint({ proposal, current })).not.toBe(
      drugParameterRevisionAdapter.fingerprint({
        proposal: { ...proposal, newValue: { value: 31 } },
        current,
      }),
    );
  });

  it('changes when the baseline changes, not only the proposal', () => {
    // The fingerprint identifies "this change against this baseline". Hashing
    // the proposal alone would call two different edits the same edit.
    expect(drugParameterRevisionAdapter.fingerprint({ proposal, current })).not.toBe(
      drugParameterRevisionAdapter.fingerprint({
        proposal,
        current: { value: { value: 25 } },
      }),
    );
  });

  it('is insensitive to key ordering within the payload', () => {
    expect(
      drugParameterRevisionAdapter.fingerprint({
        proposal: { parameter: 'halfLife', newValue: { value: 30 } },
        current,
      }),
    ).toBe(
      drugParameterRevisionAdapter.fingerprint({
        proposal: { newValue: { value: 30 }, parameter: 'halfLife' },
        current,
      }),
    );
  });
});
