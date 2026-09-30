/**
 * Phase 11: clinical cases as a capability requirement.
 *
 * A clinical case's invariant is not quorum mathematics — a human with
 * clinical standing must sign it off. Kinetix has always enforced that, as a
 * hardcoded `editType === 'clinical_case'` refusal inside
 * `applyOnAgentConsensus`. That is safe and it is not *auditable*: nothing
 * recorded who was qualified to sign one off, so nothing could later show that
 * whoever did was.
 *
 * The plan asks for the rule to be expressed generically instead:
 *
 *     require human actor
 *     require capability clinical_case_expert
 *
 * with the Kinetix adapter supplying the risk tag and the capability. These
 * tests cover the three pieces that makes real — the capability existing and
 * being grantable, the host mapping it onto generic assurance standing, and the
 * adapter tagging the content — plus the one that must not change: nothing is
 * cut over, and the hardcoded refusal still stands.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_LIST,
  capabilitiesForTier,
  checkOverride,
  getCapability,
} from '../../../src/lib/permissions.js';
import { actorContextFrom } from '../../../api/_lib/knowledge-governance/actor-context.js';
import { CUTOVER_ELIGIBLE_EDIT_TYPES } from '../../../api/_lib/knowledge-governance/cutover.js';
import { pendingEditAdapter } from '../../../api/_lib/knowledge-governance/adapters/kinetix/pending-edit.js';
import {
  KINETIX_CLINICAL_CASE_TAG,
  KINETIX_CLINICAL_EXPERT_CAPABILITY,
  KINETIX_APPLY_POLICY,
} from '../../../src/lib/assurance/policy.js';
import type { ProposalVersion } from '../../../api/_lib/knowledge-governance/target-adapter.js';

const CAPABILITY_ID = 'review.clinicalCase.signoff';

function version(payload: unknown): ProposalVersion {
  return {
    ref: { proposalId: 'pending_edit:1', versionId: 'pending_edit:1@v' },
    target: { space: 'kinetix', type: 'pending_edit', id: '1' },
    payload,
    targetVersion: 'v',
    createdAt: '2026-01-01T00:00:00.000Z',
    authorRef: 'user:1',
  };
}

describe('the capability exists and is grantable', () => {
  it('is registered in the permission matrix', () => {
    const cap = getCapability(CAPABILITY_ID);
    expect(cap).toBeDefined();
    expect(cap!.group).toBe('review');
  });

  it('defaults to admin, which grants nothing that was not already granted', () => {
    // Before this row no tier could publish a clinical case through consensus
    // at all, and admins already approve them by hand through /review.
    expect(getCapability(CAPABILITY_ID)!.defaultTier).toBe('admin');
    expect(capabilitiesForTier('editor')).not.toContain(CAPABILITY_ID);
    expect(capabilitiesForTier('contributor')).not.toContain(CAPABILITY_ID);
    expect(capabilitiesForTier('admin')).toContain(CAPABILITY_ID);
  });

  it('cannot be lowered below editor', () => {
    // The point of the capability is that this is not an ordinary review.
    expect(checkOverride(CAPABILITY_ID, 'editor').ok).toBe(true);
    expect(checkOverride(CAPABILITY_ID, 'contributor')).toMatchObject({
      ok: false,
      reason: 'below_floor',
    });
    expect(checkOverride(CAPABILITY_ID, 'authenticated')).toMatchObject({
      ok: false,
      reason: 'below_floor',
    });
  });

  it('keeps every capability id unique', () => {
    const ids = CAPABILITY_LIST.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the host maps it onto generic assurance standing', () => {
  it('confers clinical_expert on a human who holds it', () => {
    const actor = actorContextFrom({
      userId: 5,
      role: 'admin',
      capabilities: [CAPABILITY_ID, 'review.edit.decide'],
      agent: null,
    });
    expect(actor.kind).toBe('human');
    expect(actor.assuranceCapabilities).toContain(
      KINETIX_CLINICAL_EXPERT_CAPABILITY,
    );
  });

  it('does not confer it on someone who merely reviews edits', () => {
    const actor = actorContextFrom({
      userId: 5,
      role: 'editor',
      capabilities: ['review.edit.decide'],
      agent: null,
    });
    expect(actor.assuranceCapabilities).toEqual([]);
  });

  it('keeps action capabilities and assurance capabilities separate', () => {
    // Holding it still means the actor *may act*; the assurance list is the
    // much stronger claim about what their approval is worth.
    const actor = actorContextFrom({
      userId: 5,
      role: 'admin',
      capabilities: [CAPABILITY_ID],
      agent: null,
    });
    expect(actor.capabilities).toEqual([CAPABILITY_ID]);
    expect(actor.assuranceCapabilities).toEqual([
      KINETIX_CLINICAL_EXPERT_CAPABILITY,
    ]);
  });

  it('carries both a model tier and a clinical grant when both apply', () => {
    const actor = actorContextFrom({
      userId: 5,
      role: 'admin',
      capabilities: [CAPABILITY_ID],
      agent: { agentId: 1, slug: 'a', selfReviewEnabled: false, modelTier: 'flagship' },
    });
    expect(actor.assuranceCapabilities).toEqual([
      KINETIX_CLINICAL_EXPERT_CAPABILITY,
      'model_tier:flagship',
    ]);
  });
});

describe('the adapter supplies the risk tag', () => {
  it('tags a clinical case, so the core matches on content rather than edit type', async () => {
    const risk = await pendingEditAdapter.classifyRisk({
      version: version({ editType: 'clinical_case', parameter: null }),
      current: null,
    });
    expect(risk.tags).toContain(KINETIX_CLINICAL_CASE_TAG);
    // High, not medium: it is the one content type Kinetix will not publish on
    // consensus at any tally.
    expect(risk.level).toBe('high');
  });

  it.each(['wiki_fact', 'parameter', 'learning_unit'])(
    'does not tag a %s edit',
    async (editType) => {
      const risk = await pendingEditAdapter.classifyRisk({
        version: version({ editType, parameter: editType === 'parameter' ? 'halfLife' : null }),
        current: null,
      });
      expect(risk.tags).not.toContain(KINETIX_CLINICAL_CASE_TAG);
    },
  );
});

describe('the policy states the rule the tag implies', () => {
  it('requires a human approval carrying the clinical capability', () => {
    const clinical = KINETIX_APPLY_POLICY.describe().find((r) =>
      r.requirements.some((req) =>
        JSON.stringify(req.params).includes(KINETIX_CLINICAL_EXPERT_CAPABILITY),
      ),
    );
    expect(clinical).toBeDefined();
    expect(JSON.stringify(clinical!.when)).toContain(KINETIX_CLINICAL_CASE_TAG);
  });
});

describe('nothing is cut over', () => {
  it('leaves clinical_case ineligible', () => {
    // §11: only cut over after moderator identity and capability snapshots are
    // reliable and auditable. Naming the capability is the first of those, not
    // the last.
    expect([...CUTOVER_ELIGIBLE_EDIT_TYPES]).toEqual(['wiki_fact']);
    expect(CUTOVER_ELIGIBLE_EDIT_TYPES).not.toContain('clinical_case');
  });
});
