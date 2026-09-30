/**
 * Phase 2: Kinetix → generic `ActorContext` (§4.2).
 *
 * These cover the pure projection. The two properties worth pinning are the
 * ones a later refactor could quietly break without failing anything else:
 * `kind` is derived from a server-owned agent row, and the model tier reaches
 * *assurance* capabilities only — never the action capability list, and never
 * from anything the caller said about itself.
 */
import { describe, expect, it } from 'vitest';
import {
  actorContextFrom,
  systemActorContext,
  userActorRef,
  userIdFromActorRef,
} from '../../../api/_lib/knowledge-governance/actor-context.js';
import { modelTierCapability } from 'assurance-core';

const AGENT = {
  agentId: 3,
  slug: 'kinetix-agent',
  selfReviewEnabled: false,
  modelTier: 'flagship' as string | null,
};

describe('actorContextFrom', () => {
  it('marks a caller with no active agent row as human', () => {
    const actor = actorContextFrom({
      userId: 9,
      role: 'contributor',
      capabilities: ['edit.parameter.submit'],
      agent: null,
    });
    expect(actor.kind).toBe('human');
    expect(actor.actorRef).toBe('user:9');
    expect(actor.assuranceCapabilities).toEqual([]);
  });

  it('marks a caller backed by an active agent row as an agent', () => {
    const actor = actorContextFrom({
      userId: 9,
      role: 'contributor',
      capabilities: [],
      agent: AGENT,
    });
    expect(actor.kind).toBe('agent');
  });

  it('puts the server-owned model tier in assurance capabilities only', () => {
    const actor = actorContextFrom({
      userId: 9,
      role: 'contributor',
      capabilities: ['edit.parameter.submit'],
      agent: AGENT,
    });
    expect(actor.assuranceCapabilities).toEqual([
      modelTierCapability('flagship'),
    ]);
    // The tier says what an approval is *worth*, not what the actor may do.
    // Folding it into `capabilities` would make it an action gate as well.
    expect(actor.capabilities).toEqual(['edit.parameter.submit']);
  });

  it('leaves assurance capabilities empty when no tier is stored', () => {
    // NULL model_tier is the absence of a claim, not `model_tier:unknown` —
    // an explicit "unknown" capability is one more string to accidentally
    // accept at the flagship gate.
    const actor = actorContextFrom({
      userId: 9,
      role: 'contributor',
      capabilities: [],
      agent: { ...AGENT, modelTier: null },
    });
    expect(actor.assuranceCapabilities).toEqual([]);
  });

  it('sorts capabilities so two equal actors fingerprint identically', () => {
    const a = actorContextFrom({
      userId: 1,
      role: 'editor',
      capabilities: ['b.cap', 'a.cap'],
      agent: null,
    });
    expect(a.capabilities).toEqual(['a.cap', 'b.cap']);
  });

  it('records self-review as audit metadata, never as a capability', () => {
    // Self-review does not lower a bar — it enlarges the reviewer pool, which
    // raises the quorum (Phase 0 doc §5.1). A capability would read as a grant.
    const actor = actorContextFrom({
      userId: 9,
      role: 'contributor',
      capabilities: [],
      agent: { ...AGENT, selfReviewEnabled: true },
    });
    expect(actor.metadata?.selfReviewEnabled).toBe(true);
    expect(actor.capabilities).not.toContain('selfReview');
    expect(actor.assuranceCapabilities).not.toContain('selfReview');
  });
});

describe('actor references', () => {
  it('round-trips a user id', () => {
    expect(userIdFromActorRef(userActorRef(42))).toBe(42);
  });

  it.each([['system:sweep'], ['agent:3'], [''], ['user:abc'], ['user:0']])(
    'refuses to read %s as a user id',
    (ref) => {
      expect(userIdFromActorRef(ref)).toBeNull();
    },
  );
});

describe('systemActorContext', () => {
  it('is neither a human nor an agent, and holds no capabilities', () => {
    // A sweep's own approval must never be able to count as peer review.
    const actor = systemActorContext('agent-sweep');
    expect(actor.kind).toBe('system');
    expect(actor.capabilities).toEqual([]);
    expect(actor.assuranceCapabilities).toEqual([]);
  });
});
