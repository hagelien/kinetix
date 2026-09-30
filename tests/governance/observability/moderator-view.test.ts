/**
 * §8.2: the moderator/auditor read model.
 *
 * §8.2 requires two read models, and only the reviewer's has existed. Its
 * defining property is that it withholds peer judgment; this one's is the exact
 * inverse — a moderator is supposed to see everything, and a view that scrubbed
 * verdicts would be useless for the job it exists for.
 *
 * The tests worth having are the ones about what it must *not* lose: superseded
 * assessments, dispute rationales, and the requirement state as recorded rather
 * than as re-evaluated.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  moderatorView,
  moderatorViewForLegacy,
} from '../../../api/_lib/knowledge-governance/moderator-view.js';
import {
  appendVersion,
  createProposal,
  ensureSpace,
  ensureTarget,
  linkLegacyRecord,
  openDispute,
  recordPolicyDecision,
  recordPublicationEvent,
  recordRuling,
  reviseAssessment,
  setProposalState,
} from '../../../api/_lib/knowledge-governance/store/postgres.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';

let db: IntegrationDb;
let spaceId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  const space = await ensureSpace(db, { slug: 'kinetix', name: 'Kinetix' });
  spaceId = space.id;
});

async function seedProposal() {
  const target = await ensureTarget(db, {
    spaceId,
    targetType: 'pending_edit',
    targetKey: 'pending_edit:1',
  });
  const proposal = await createProposal(db, {
    spaceId,
    targetId: target.id,
    authorActorRef: 'user:1',
    authorKind: 'agent',
    state: 'pending',
  });
  const version = await appendVersion(db, {
    proposalId: proposal.id,
    payload: { statement: 'Halveringstiden er 30 timer.' },
    payloadFingerprint: 'aaaa',
    authorActorRef: 'user:1',
    actorKind: 'agent',
  });
  return { proposal, version };
}

describe('it returns §8.2’s five sections', () => {
  it('assembles all of them for a live proposal', async () => {
    const { proposal, version } = await seedProposal();
    await reviseAssessment(db, {
      spaceId,
      subjectType: 'proposal_version',
      subjectId: version.id,
      actorRef: 'user:2',
      actorKind: 'agent',
      verdict: 'approve',
    });
    await recordPublicationEvent(db, {
      proposalVersionId: version.id,
      action: 'submitted',
      actorRef: 'user:1',
    });

    const view = (await moderatorView(proposal.id, { db }))!;
    expect(view.proposal!.id).toBe(proposal.id);
    expect(view.versions).toHaveLength(1);
    expect(view.assessments).toHaveLength(1);
    expect(view.disputes).toEqual([]);
    expect(view.publicationEvents.map((e) => e.action)).toEqual(['submitted']);
  });

  it('returns empty sections rather than nothing for an unreviewed proposal', async () => {
    // "No reviews yet" is information a moderator wants; an absent view is not.
    const { proposal } = await seedProposal();
    const view = (await moderatorView(proposal.id, { db }))!;
    expect(view.assessments).toEqual([]);
    expect(view.requirementState.decision).toBeNull();
    expect(view.requirementState.unmet).toEqual([]);
  });

  it('returns null only when the proposal does not exist', async () => {
    expect(await moderatorView(999_999, { db })).toBeNull();
  });
});

describe('it keeps what the reviewer view withholds', () => {
  it('shows superseded assessments, not just effective ones', async () => {
    // The most valuable half of "all assessments": "this reviewer disputed it
    // in March and approved it in May" is a fact about the review, and it is
    // exactly what agent_verifications destroys.
    const { proposal, version } = await seedProposal();
    for (const verdict of ['dispute', 'approve'] as const) {
      await reviseAssessment(db, {
        spaceId,
        subjectType: 'proposal_version',
        subjectId: version.id,
        actorRef: 'user:2',
        actorKind: 'agent',
        verdict,
        rationaleMd: verdict === 'dispute' ? 'Referansen dekker ikke dette.' : null,
      });
    }

    const view = (await moderatorView(proposal.id, { db }))!;
    expect(view.assessments).toHaveLength(2);
    expect(view.effectiveAssessments).toHaveLength(1);
    expect(view.effectiveAssessments[0]!.verdict).toBe('approve');
    // The rationale of the withdrawn dispute survives, which is the point.
    expect(view.assessments[0]!.rationaleMd).toBe('Referansen dekker ikke dette.');
  });

  it('shows dispute rationales and their rulings', async () => {
    const { proposal, version } = await seedProposal();
    const dispute = await openDispute(db, {
      spaceId,
      subjectType: 'proposal_version',
      subjectId: version.id,
      openedByActorRef: 'user:3',
      openedByKind: 'human',
      reasonMd: 'Verdien stemmer ikke med kilden.',
    });
    await recordRuling(db, {
      disputeId: dispute.id,
      ruling: 'superseded',
      actorRef: 'user:4',
      rationaleMd: 'Erstattet av en ny sak.',
    });

    const view = (await moderatorView(proposal.id, { db }))!;
    expect(view.disputes).toHaveLength(1);
    expect(view.disputes[0]!.rulings.map((r) => r.rationaleMd)).toEqual([
      'Erstattet av en ny sak.',
    ]);
  });

  it('carries verdicts, which the reviewer packet refuses to', async () => {
    // The defining property, asserted as the exact inverse of the reviewer
    // test: `sealReviewPacket` throws on a payload containing a verdict, and
    // this view must contain one. The leak guard is deliberately not applied
    // here — a moderator view that scrubbed verdicts would be useless for the
    // job it exists for, and applying the mechanism past its reason would be
    // cargo-culting it.
    const { proposal, version } = await seedProposal();
    await reviseAssessment(db, {
      spaceId,
      subjectType: 'proposal_version',
      subjectId: version.id,
      actorRef: 'user:2',
      actorKind: 'agent',
      verdict: 'dispute',
      rationaleMd: 'Kilden sier noe annet.',
    });

    const view = (await moderatorView(proposal.id, { db }))!;
    const serialised = JSON.stringify(view);
    expect(serialised).toContain('dispute');
    expect(serialised).toContain('Kilden sier noe annet.');

    // And the same content would be refused on the reviewer path.
    const { sealReviewPacket, ReviewPacketLeakError } = await import(
      'assurance-core'
    );
    expect(() =>
      sealReviewPacket({
        version: {
          ref: { proposalId: 'p', versionId: 'v' },
          target: { space: 'kinetix', type: 'pending_edit', id: '1' },
          payload: {},
          targetVersion: 'v',
          createdAt: '2026-01-01T00:00:00.000Z',
          authorRef: 'user:1',
        },
        proposed: { verdict: 'dispute' },
      }),
    ).toThrow(ReviewPacketLeakError);
  });
});

describe('requirement state comes from the record, not a re-evaluation', () => {
  it('reports the unmet requirement ids the decision stored', async () => {
    const { proposal, version } = await seedProposal();
    await recordPolicyDecision(db, {
      spaceId,
      proposalVersionId: version.id,
      policyId: 'kinetix-consensus',
      policyVersion: 'v1',
      decision: 'hold',
      inputFingerprint: 'ffff',
      requirements: [
        { requirementId: 'assurance.noDisputingAssessments', met: true },
        { requirementId: 'assurance.independentApprovals', met: false },
      ],
      unsatisfiedRequirements: [
        { requirementId: 'assurance.independentApprovals', met: false },
      ],
    });

    const view = (await moderatorView(proposal.id, { db }))!;
    expect(view.requirementState.decision!.decision).toBe('hold');
    expect(view.requirementState.unmet).toEqual([
      'assurance.independentApprovals',
    ]);
    expect(view.requirementState.requirements).toHaveLength(2);
  });

  it('reports the policy version the decision was made under', async () => {
    // §7.4: a later policy change must not retroactively re-explain an older
    // decision, so the version travels with the record.
    const { proposal, version } = await seedProposal();
    await recordPolicyDecision(db, {
      spaceId,
      proposalVersionId: version.id,
      policyId: 'kinetix-consensus',
      policyVersion: 'v1',
      decision: 'apply',
      inputFingerprint: 'ffff',
    });
    const view = (await moderatorView(proposal.id, { db }))!;
    expect(view.requirementState.decision!.policyVersion).toBe('v1');
  });
});

describe('the complete history survives a revision', () => {
  it('keeps every version and binds assessments to the one they judged', async () => {
    const { proposal, version } = await seedProposal();
    await reviseAssessment(db, {
      spaceId,
      subjectType: 'proposal_version',
      subjectId: version.id,
      actorRef: 'user:2',
      actorKind: 'agent',
      verdict: 'approve',
    });
    const revised = await appendVersion(db, {
      proposalId: proposal.id,
      payload: { statement: 'Halveringstiden er 36 timer.' },
      payloadFingerprint: 'bbbb',
      authorActorRef: 'user:1',
      actorKind: 'agent',
    });

    const view = (await moderatorView(proposal.id, { db }))!;
    expect(view.versions).toHaveLength(2);
    expect(view.currentVersion!.id).toBe(revised.id);
    // The old approval is still in the history and is no longer effective —
    // §8.3 made structural.
    expect(view.assessments).toHaveLength(1);
    expect(view.effectiveAssessments).toEqual([]);
  });

  it('follows a closed proposal', async () => {
    const { proposal } = await seedProposal();
    await setProposalState(db, proposal.id, 'applied');
    const view = (await moderatorView(proposal.id, { db }))!;
    expect(view.proposal!.state).toBe('applied');
    expect(view.proposal!.closedAt).not.toBeNull();
  });
});

describe('lookup by the Kinetix row', () => {
  it('resolves through the legacy link', async () => {
    const { proposal } = await seedProposal();
    await linkLegacyRecord(db, {
      genericType: 'proposal',
      genericId: proposal.id,
      legacyType: 'pending_edit',
      legacyId: 77,
    });
    const view = await moderatorViewForLegacy('pending_edit', 77, { db });
    expect(view!.proposal!.id).toBe(proposal.id);
  });

  it('returns null for a row nothing mirrors', async () => {
    expect(await moderatorViewForLegacy('pending_edit', 4242, { db })).toBeNull();
  });
});
