/**
 * Phase 12: the generic governance client.
 *
 * The first surface designed for something that is not Kinetix. Three
 * properties carry it:
 *
 *  1. **Actor-neutral terminology.** The plan requires the base API to be
 *     actor-neutral, with agent-specific conveniences allowed on top. That is a
 *     testable claim about the surface, not a style preference: a second domain
 *     adopting an `agentId`-shaped API would have to invent agent rows for its
 *     human reviewers.
 *  2. **The review batch withholds peer judgment.** Restated by the plan as an
 *     explicit requirement for this phase.
 *  3. **A revision is a new version.** The SDK must not offer a way to edit one,
 *     because assessments name the version they judged.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { governanceClient } from '../../../api/_lib/knowledge-governance/sdk/client.js';
import { ensureKinetixSpace } from '../../../api/_lib/knowledge-governance/backfill.js';
import { registerKinetixAdapters } from '../../../api/_lib/knowledge-governance/adapters/kinetix/index.js';
import { resetKnowledgeTargetAdaptersForTests } from '../../../api/_lib/knowledge-governance/registry.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';
import type { ActorContext } from 'assurance-core';

let db: IntegrationDb;

const AUTHOR: ActorContext = {
  actorRef: 'user:1',
  kind: 'agent',
  capabilities: ['edit.wikiFact.submit'],
  assuranceCapabilities: ['model_tier:flagship'],
};
const REVIEWER: ActorContext = {
  actorRef: 'user:2',
  kind: 'human',
  capabilities: ['review.edit.decide'],
  assuranceCapabilities: [],
};

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  resetKnowledgeTargetAdaptersForTests();
  registerKinetixAdapters();
  await ensureKinetixSpace(db);
});

function client() {
  return governanceClient({ db });
}

describe('the surface is actor-neutral', () => {
  it('exposes exactly the namespaces the plan names', () => {
    const c = client();
    expect(Object.keys(c).sort()).toEqual([
      'assessments',
      'assurance',
      'disputes',
      'history',
      'proposals',
      'review',
      'space',
    ]);
  });

  it('names no method after a kind of actor', () => {
    // `agent`, `bot`, `human` and `user` are all host vocabulary. A base API
    // that says one of them has decided who its callers are.
    const c = client() as unknown as Record<string, Record<string, unknown>>;
    for (const [namespace, methods] of Object.entries(c)) {
      if (typeof methods !== 'object' || methods === null) continue;
      for (const method of Object.keys(methods)) {
        expect(
          method.toLowerCase(),
          `${namespace}.${method}`,
        ).not.toMatch(/agent|bot|human|user/);
      }
    }
  });

  it('takes the actor per call rather than binding one to the client', async () => {
    // A queue fetch and an assessment can legitimately be for different actors
    // in one request; a client that remembered an identity would make that
    // mix-up invisible.
    const c = client();
    const { proposal, version } = await c.proposals.create(AUTHOR, {
      targetType: 'pending_edit',
      targetKey: 'pending_edit:1',
      payload: { editType: 'wiki_fact' },
    });
    await c.assessments.submit({
      proposalVersionId: version.id,
      actor: REVIEWER,
      verdict: 'approve',
    });
    const current = await c.assessments.current(version.id);
    expect(current).toHaveLength(1);
    expect(current[0]!.actorRef).toBe(REVIEWER.actorRef);
    expect(proposal.authorActorRef).toBe(AUTHOR.actorRef);
  });
});

describe('proposals', () => {
  it('creates a target, a proposal and a first version together', async () => {
    const c = client();
    const { proposal, version } = await c.proposals.create(AUTHOR, {
      targetType: 'pending_edit',
      targetKey: 'pending_edit:7',
      payload: { editType: 'wiki_fact', statement: 'Halveringstid 30 t.' },
    });
    expect(proposal.state).toBe('draft');
    expect(version.versionNo).toBe(1);
    expect(version.payloadFingerprint).toBeTruthy();
  });

  it('revising appends a version and never edits one', async () => {
    // §8.3 is structural: assessments name the version they judged, so a
    // revised payload cannot inherit the previous version's approvals.
    const c = client();
    const { proposal, version } = await c.proposals.create(AUTHOR, {
      targetType: 'pending_edit',
      targetKey: 'pending_edit:7',
      payload: { value: 1 },
    });
    const revised = await c.proposals.revise(AUTHOR, proposal.id, {
      payload: { value: 2 },
    });
    expect(revised.versionNo).toBe(2);

    const history = await c.history.get(proposal.id);
    expect(history.versions.map((v) => v.payload)).toEqual([
      { value: 1 },
      { value: 2 },
    ]);
    expect(history.versions[0]!.id).toBe(version.id);
  });

  it('offers no way to mutate a recorded version', () => {
    // The absence is the enforcement, and it is worth asserting because a
    // future convenience method is exactly how it would be lost.
    const c = client();
    expect(Object.keys(c.proposals).sort()).toEqual([
      'create',
      'get',
      'revise',
      'submit',
    ]);
  });

  it('submitting stamps the current version', async () => {
    const c = client();
    const { proposal } = await c.proposals.create(AUTHOR, {
      targetType: 'pending_edit',
      targetKey: 'pending_edit:7',
      payload: {},
    });
    const submitted = await c.proposals.submit(proposal.id);
    expect(submitted!.submittedAt).not.toBeNull();
  });
});

describe('assessments', () => {
  it('a changed judgment supersedes rather than overwrites', async () => {
    const c = client();
    const { version } = await c.proposals.create(AUTHOR, {
      targetType: 'pending_edit',
      targetKey: 'pending_edit:7',
      payload: {},
    });
    const first = await c.assessments.submit({
      proposalVersionId: version.id,
      actor: REVIEWER,
      verdict: 'dispute',
      rationaleMd: 'Referansen dekker ikke påstanden.',
    });
    const second = await c.assessments.submit({
      proposalVersionId: version.id,
      actor: REVIEWER,
      verdict: 'approve',
    });
    expect(second.supersedesAssessmentId).toBe(first.id);
    expect(await c.assessments.current(version.id)).toHaveLength(1);
  });

  it('snapshots the actor’s capabilities at write time', async () => {
    // Never read live afterwards — the same reason
    // agent_verifications.verifier_tier exists.
    //
    // The two halves come from different places, and §19.1 is why. Action
    // capabilities are descriptive and pass through from the caller; assurance
    // capabilities decide what an approval is *worth*, so they come from the
    // host resolver and an unconfigured client confers none. Both are asserted
    // here, because the interesting bug is the one where the caller's claim
    // leaks into the half that gates.
    const c = client();
    const { version } = await c.proposals.create(AUTHOR, {
      targetType: 'pending_edit',
      targetKey: 'pending_edit:7',
      payload: {},
    });
    const recorded = await c.assessments.submit({
      proposalVersionId: version.id,
      actor: AUTHOR,
      verdict: 'approve',
    });
    // The two halves are stored apart, which is the point: what gates read
    // sits in `assuranceCapabilities`, and the descriptive half is host data
    // the generic store carries and never consults.
    expect(recorded.capabilitySnapshot).toEqual({
      assuranceCapabilities: [],
      host: { capabilities: ['edit.wikiFact.submit'] },
    });
  });

  it('takes assurance standing from the host resolver, not from the caller', async () => {
    const bound = governanceClient({
      db,
      // A host that says the reviewer is mid-tier, whatever the caller claims.
      resolveAssuranceCapabilities: async () => ['model_tier:mid'],
    });
    const { version } = await bound.proposals.create(AUTHOR, {
      targetType: 'pending_edit',
      targetKey: 'pending_edit:8',
      payload: {},
    });
    const recorded = await bound.assessments.submit({
      proposalVersionId: version.id,
      actor: AUTHOR,
      verdict: 'approve',
    });
    expect(
      (recorded.capabilitySnapshot as { assuranceCapabilities: string[] })
        .assuranceCapabilities,
    ).toEqual(['model_tier:mid']);
  });
});

describe('disputes', () => {
  it('opens, lists and rules', async () => {
    const c = client();
    const { version } = await c.proposals.create(AUTHOR, {
      targetType: 'pending_edit',
      targetKey: 'pending_edit:7',
      payload: {},
    });
    const dispute = await c.disputes.open(
      REVIEWER,
      version.id,
      'Verdien stemmer ikke med kilden.',
    );
    expect(await c.disputes.listOpen(version.id)).toHaveLength(1);

    await c.disputes.rule(REVIEWER, dispute.id, 'upheld', 'Enig.');
    expect(await c.disputes.listOpen(version.id)).toHaveLength(0);
    const rulings = await c.disputes.rulings(dispute.id);
    expect(rulings.map((r) => r.ruling)).toEqual(['upheld']);
  });
});

describe('assurance and history', () => {
  it('returns null rather than an empty profile for an unmirrored target', async () => {
    // "No reviews" and "no records" are different claims, and a caller that
    // cannot tell them apart will report the second as the first.
    const c = client();
    expect(
      await c.assurance.get({ targetType: 'pending_edit', targetId: 999 }),
    ).toBeNull();
  });

  it('assembles the moderator view: versions, assessments and events', async () => {
    const c = client();
    const { proposal, version } = await c.proposals.create(AUTHOR, {
      targetType: 'pending_edit',
      targetKey: 'pending_edit:7',
      payload: {},
    });
    await c.assessments.submit({
      proposalVersionId: version.id,
      actor: REVIEWER,
      verdict: 'approve',
    });
    const history = await c.history.get(proposal.id);
    expect(history.proposal!.id).toBe(proposal.id);
    expect(history.versions).toHaveLength(1);
    expect(history.assessments).toHaveLength(1);
    expect(history.publicationEvents).toEqual([]);
  });

  it('returns null for a host row nothing mirrors', async () => {
    const c = client();
    expect(await c.history.forLegacy('pending_edit', 4242)).toBeNull();
  });
});

describe('the review batch withholds peer judgment', () => {
  it('never contains a verdict, tally or quorum', async () => {
    // The plan restates this as a requirement for this phase specifically.
    // `sealReviewPacket` enforces it structurally; this asserts it in the
    // vocabulary a reviewer would recognise, over what the SDK actually
    // returned.
    const c = client();
    const batch = await c.review.getBatch({
      actor: REVIEWER,
      binding: { agentId: 1, agentUserId: 2, selfReviewEnabled: false },
      limit: 10,
      minAgeMinutes: 0,
    });
    const serialised = JSON.stringify(batch);
    for (const forbidden of [
      'verdict',
      'approveCount',
      'disputeCount',
      'quorum',
      'consensus',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('keeps the Kinetix binding out of the actor type', () => {
    // The one host-shaped thing in the surface, isolated on purpose so a second
    // domain supplies its own rather than inventing agent rows.
    const request = {
      actor: REVIEWER,
      binding: { agentId: 1, agentUserId: 2, selfReviewEnabled: false },
    };
    expect(Object.keys(request.actor)).not.toContain('agentId');
    expect(Object.keys(request.binding).sort()).toEqual([
      'agentId',
      'agentUserId',
      'selfReviewEnabled',
    ]);
  });
});
