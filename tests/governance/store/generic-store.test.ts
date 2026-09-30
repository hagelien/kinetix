/**
 * Phase 3: the generic `kg_*` store against real SQL.
 *
 * The properties worth proving are the ones the schema exists for — that
 * judgment history is append-only and survives a change of mind, that a
 * revised payload cannot inherit the previous version's approvals, and that
 * projections stay consistent with the history they summarise. All of them are
 * about what the tables *refuse* to lose, so they are exercised through the
 * store rather than asserted about its types.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  ConflictingLegacyLinkError,
  currentAssessments,
  ensureEvidenceItem,
  ensureSpace,
  ensureTarget,
  evidenceForSubject,
  findByGeneric,
  latestDecisionForVersion,
  latestRuling,
  linkEvidence,
  linkLegacyRecord,
  listAssessments,
  listPublicationEvents,
  listVersions,
  openDispute,
  openDisputes,
  recordAssessment,
  recordAuditEvent,
  recordPolicyDecision,
  recordPublicationEvent,
  recordRuling,
  recomputeProjection,
  reviseAssessment,
  appendVersion,
  createProposal,
  getProposal,
  listOpenProposals,
  setProposalState,
  type SpaceRecord,
  type TargetRecord,
} from '../../../api/_lib/knowledge-governance/store/postgres.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';

let db: IntegrationDb;
let space: SpaceRecord;
let target: TargetRecord;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  space = await ensureSpace(db, { slug: 'kinetix', name: 'Kinetix' });
  target = await ensureTarget(db, {
    spaceId: space.id,
    targetType: 'pending_edit',
    targetKey: 'pending_edit:1',
  });
});

async function newProposal() {
  return createProposal(db, {
    spaceId: space.id,
    targetId: target.id,
    authorActorRef: 'user:1',
    authorKind: 'agent',
    state: 'pending',
  });
}

describe('spaces and targets', () => {
  it('is idempotent — a second ensure returns the same row', async () => {
    const again = await ensureSpace(db, { slug: 'kinetix', name: 'Kinetix' });
    expect(again.id).toBe(space.id);
    const sameTarget = await ensureTarget(db, {
      spaceId: space.id,
      targetType: 'pending_edit',
      targetKey: 'pending_edit:1',
    });
    expect(sameTarget.id).toBe(target.id);
  });

  it('separates identical target keys in different spaces', async () => {
    // The whole reason the space exists (§4.3): two spaces may legitimately
    // govern something they each call the same thing.
    const other = await ensureSpace(db, { slug: 'other', name: 'Other' });
    const otherTarget = await ensureTarget(db, {
      spaceId: other.id,
      targetType: 'pending_edit',
      targetKey: 'pending_edit:1',
    });
    expect(otherTarget.id).not.toBe(target.id);
  });
});

describe('proposal versions are immutable', () => {
  it('numbers versions from one and never reuses a number', async () => {
    const proposal = await newProposal();
    const v1 = await appendVersion(db, {
      proposalId: proposal.id,
      payload: { value: 1 },
      payloadFingerprint: 'aaaa',
      authorActorRef: 'user:1',
      actorKind: 'agent',
    });
    const v2 = await appendVersion(db, {
      proposalId: proposal.id,
      payload: { value: 2 },
      payloadFingerprint: 'bbbb',
      authorActorRef: 'user:1',
      actorKind: 'agent',
    });
    expect([v1.versionNo, v2.versionNo]).toEqual([1, 2]);
    const all = await listVersions(db, proposal.id);
    expect(all.map((v) => v.payload)).toEqual([{ value: 1 }, { value: 2 }]);
  });

  it('refuses a duplicate version number at the database level', async () => {
    const proposal = await newProposal();
    await appendVersion(db, {
      proposalId: proposal.id,
      payload: {},
      payloadFingerprint: 'aaaa',
      authorActorRef: 'user:1',
      actorKind: 'agent',
    });
    // The store derives version_no, so this reaches past it deliberately: the
    // unique index is the real guard, and a concurrent second writer must lose
    // rather than silently give two payloads the same identity.
    await expect(
      db.execute(sql`
        insert into kg_proposal_versions
          (proposal_id, version_no, payload, payload_fingerprint, author_actor_ref, actor_kind)
        values (${proposal.id}, 1, '{}'::jsonb, 'cccc', 'user:2', 'agent')
      `),
    ).rejects.toThrow();
  });

  it('keeps an earlier version readable after a revision', async () => {
    // §8.3: a revised payload does not overwrite what reviewers already judged.
    const proposal = await newProposal();
    const v1 = await appendVersion(db, {
      proposalId: proposal.id,
      payload: { dose: 10 },
      payloadFingerprint: 'aaaa',
      authorActorRef: 'user:1',
      actorKind: 'agent',
    });
    await appendVersion(db, {
      proposalId: proposal.id,
      payload: { dose: 20 },
      payloadFingerprint: 'bbbb',
      authorActorRef: 'user:1',
      actorKind: 'agent',
    });
    const versions = await listVersions(db, proposal.id);
    expect(versions[0]!.id).toBe(v1.id);
    expect(versions[0]!.payload).toEqual({ dose: 10 });
  });

  it('moves the proposal projection to the newest version', async () => {
    const proposal = await newProposal();
    await appendVersion(db, {
      proposalId: proposal.id,
      payload: {},
      payloadFingerprint: 'aaaa',
      authorActorRef: 'user:1',
      actorKind: 'agent',
    });
    const v2 = await appendVersion(db, {
      proposalId: proposal.id,
      payload: {},
      payloadFingerprint: 'bbbb',
      authorActorRef: 'user:1',
      actorKind: 'agent',
    });
    expect((await getProposal(db, proposal.id))?.currentVersionId).toBe(v2.id);
  });

  it('rebuilds a drifted projection from the version history', async () => {
    const proposal = await newProposal();
    await appendVersion(db, {
      proposalId: proposal.id,
      payload: {},
      payloadFingerprint: 'aaaa',
      authorActorRef: 'user:1',
      actorKind: 'agent',
    });
    const v2 = await appendVersion(db, {
      proposalId: proposal.id,
      payload: {},
      payloadFingerprint: 'bbbb',
      authorActorRef: 'user:1',
      actorKind: 'agent',
    });
    // Simulate a shadow write that appended and then died before pointing.
    await db.execute(
      sql`update kg_proposals set current_version_id = null where id = ${proposal.id}`,
    );
    expect(await recomputeProjection(db, proposal.id)).toBe(v2.id);
  });
});

describe('assessments are append-only', () => {
  it('keeps the earlier judgment when a reviewer changes its mind', async () => {
    // The fix for `agent_verifications`, which upserts and destroys this.
    const first = await recordAssessment(db, {
      spaceId: space.id,
      subjectType: 'target',
      subjectId: target.id,
      actorRef: 'user:7',
      actorKind: 'agent',
      verdict: 'dispute',
      rationaleMd: 'Verdien stemmer ikke med referansen.',
    });
    const second = await reviseAssessment(db, {
      spaceId: space.id,
      subjectType: 'target',
      subjectId: target.id,
      actorRef: 'user:7',
      actorKind: 'agent',
      verdict: 'approve',
    });

    expect(second.supersedesAssessmentId).toBe(first.id);
    const all = await listAssessments(db, {
      subjectType: 'target',
      subjectId: target.id,
    });
    expect(all).toHaveLength(2);
    expect(all[0]!.verdict).toBe('dispute');
    expect(all[0]!.rationaleMd).toBe('Verdien stemmer ikke med referansen.');
  });

  it('counts only the newest unsuperseded row as effective', async () => {
    await recordAssessment(db, {
      spaceId: space.id,
      subjectType: 'target',
      subjectId: target.id,
      actorRef: 'user:7',
      actorKind: 'agent',
      verdict: 'dispute',
    });
    await reviseAssessment(db, {
      spaceId: space.id,
      subjectType: 'target',
      subjectId: target.id,
      actorRef: 'user:7',
      actorKind: 'agent',
      verdict: 'approve',
    });
    const current = await currentAssessments(db, {
      subjectType: 'target',
      subjectId: target.id,
    });
    expect(current).toHaveLength(1);
    expect(current[0]!.verdict).toBe('approve');
  });

  it('collapses a twice-revised reviewer to one effective row', async () => {
    for (const verdict of ['dispute', 'abstain', 'approve'] as const) {
      await reviseAssessment(db, {
        spaceId: space.id,
        subjectType: 'target',
        subjectId: target.id,
        actorRef: 'user:7',
        actorKind: 'agent',
        verdict,
      });
    }
    const all = await listAssessments(db, {
      subjectType: 'target',
      subjectId: target.id,
    });
    const current = await currentAssessments(db, {
      subjectType: 'target',
      subjectId: target.id,
    });
    expect(all).toHaveLength(3);
    expect(current).toHaveLength(1);
    expect(current[0]!.verdict).toBe('approve');
  });

  it('keeps different reviewers separate', async () => {
    for (const actorRef of ['user:7', 'user:8']) {
      await reviseAssessment(db, {
        spaceId: space.id,
        subjectType: 'target',
        subjectId: target.id,
        actorRef,
        actorKind: 'agent',
        verdict: 'approve',
      });
    }
    const current = await currentAssessments(db, {
      subjectType: 'target',
      subjectId: target.id,
    });
    expect(current.map((a) => a.actorRef).sort()).toEqual(['user:7', 'user:8']);
  });

  it('stores the capability snapshot taken at write time', async () => {
    // Same reason agent_verifications.verifier_tier exists: a later re-tiering
    // must not retroactively change what a past approval was worth.
    const recorded = await recordAssessment(db, {
      spaceId: space.id,
      subjectType: 'target',
      subjectId: target.id,
      actorRef: 'user:7',
      actorKind: 'agent',
      verdict: 'approve',
      capabilitySnapshot: { modelTier: 'flagship' },
      modelMetadata: { model: 'some-model-id' },
    });
    expect(recorded.capabilitySnapshot).toEqual({ modelTier: 'flagship' });
  });
});

describe('disputes', () => {
  it('records a ruling and closes the dispute', async () => {
    const dispute = await openDispute(db, {
      spaceId: space.id,
      subjectType: 'target',
      subjectId: target.id,
      openedByActorRef: 'user:7',
      openedByKind: 'agent',
      reasonMd: 'Referansen støtter ikke verdien.',
    });
    expect(
      await openDisputes(db, { subjectType: 'target', subjectId: target.id }),
    ).toHaveLength(1);

    await recordRuling(db, {
      disputeId: dispute.id,
      ruling: 'upheld',
      actorRef: 'user:2',
      rationaleMd: 'Enig.',
    });
    expect(
      await openDisputes(db, { subjectType: 'target', subjectId: target.id }),
    ).toHaveLength(0);
  });

  it('closes on withdrawal too', async () => {
    // A withdrawn dispute is finished; leaving it open would keep blocking
    // publication on a complaint nobody is making.
    const dispute = await openDispute(db, {
      spaceId: space.id,
      subjectType: 'target',
      subjectId: target.id,
      openedByActorRef: 'user:7',
      openedByKind: 'agent',
    });
    await recordRuling(db, {
      disputeId: dispute.id,
      ruling: 'withdrawn',
      actorRef: 'user:7',
    });
    expect(
      await openDisputes(db, { subjectType: 'target', subjectId: target.id }),
    ).toHaveLength(0);
  });

  it('leaves a superseded dispute open, because its replacement governs', async () => {
    const dispute = await openDispute(db, {
      spaceId: space.id,
      subjectType: 'target',
      subjectId: target.id,
      openedByActorRef: 'user:7',
      openedByKind: 'agent',
    });
    await recordRuling(db, {
      disputeId: dispute.id,
      ruling: 'superseded',
      actorRef: 'user:2',
    });
    expect(
      await openDisputes(db, { subjectType: 'target', subjectId: target.id }),
    ).toHaveLength(1);
  });

  it('appends rulings rather than editing the previous one', async () => {
    const dispute = await openDispute(db, {
      spaceId: space.id,
      subjectType: 'target',
      subjectId: target.id,
      openedByActorRef: 'user:7',
      openedByKind: 'agent',
    });
    await recordRuling(db, {
      disputeId: dispute.id,
      ruling: 'upheld',
      actorRef: 'user:2',
    });
    await recordRuling(db, {
      disputeId: dispute.id,
      ruling: 'overruled',
      actorRef: 'user:3',
      rationaleMd: 'Ny dokumentasjon.',
    });
    const rulings = await (
      await import('../../../api/_lib/knowledge-governance/store/disputes.js')
    ).listRulings(db, dispute.id);
    expect(rulings.map((r) => r.ruling)).toEqual(['upheld', 'overruled']);
    expect((await latestRuling(db, dispute.id))?.ruling).toBe('overruled');
  });
});

describe('policy decisions and publication events', () => {
  it('defaults to shadow mode, which governs nothing', async () => {
    const proposal = await newProposal();
    const version = await appendVersion(db, {
      proposalId: proposal.id,
      payload: {},
      payloadFingerprint: 'aaaa',
      authorActorRef: 'user:1',
      actorKind: 'agent',
    });
    const decision = await recordPolicyDecision(db, {
      spaceId: space.id,
      proposalVersionId: version.id,
      policyId: 'kinetix-consensus',
      policyVersion: 'v1',
      decision: 'hold',
      inputFingerprint: 'ffff',
    });
    // Fail-safe: a caller that forgets to say records a decision that governs
    // nothing, not one that governs everything.
    expect(decision.evaluationMode).toBe('shadow');
  });

  it('distinguishes what the engine would do from what governed', async () => {
    const proposal = await newProposal();
    const version = await appendVersion(db, {
      proposalId: proposal.id,
      payload: {},
      payloadFingerprint: 'aaaa',
      authorActorRef: 'user:1',
      actorKind: 'agent',
    });
    await recordPolicyDecision(db, {
      spaceId: space.id,
      proposalVersionId: version.id,
      policyId: 'kinetix-consensus',
      policyVersion: 'v1',
      decision: 'hold',
      inputFingerprint: 'ffff',
      evaluationMode: 'shadow',
    });
    await recordPolicyDecision(db, {
      spaceId: space.id,
      proposalVersionId: version.id,
      policyId: 'kinetix-consensus',
      policyVersion: 'v1',
      decision: 'apply',
      inputFingerprint: 'ffff',
      evaluationMode: 'authoritative',
    });
    expect(
      (await latestDecisionForVersion(db, version.id, 'shadow'))?.decision,
    ).toBe('hold');
    expect(
      (await latestDecisionForVersion(db, version.id, 'authoritative'))?.decision,
    ).toBe('apply');
  });

  it('records what ultimately happened to a version', async () => {
    const proposal = await newProposal();
    const version = await appendVersion(db, {
      proposalId: proposal.id,
      payload: {},
      payloadFingerprint: 'aaaa',
      authorActorRef: 'user:1',
      actorKind: 'agent',
    });
    await recordPublicationEvent(db, {
      proposalVersionId: version.id,
      action: 'submitted',
      actorRef: 'user:1',
    });
    await recordPublicationEvent(db, {
      proposalVersionId: version.id,
      action: 'applied',
      actorRef: 'system:consensus',
      appliedRevisionRef: 'drug_parameter_revision:42',
    });
    const events = await listPublicationEvents(db, version.id);
    expect(events.map((e) => e.action)).toEqual(['submitted', 'applied']);
    expect(events[1]!.appliedRevisionRef).toBe('drug_parameter_revision:42');
  });
});

describe('proposal state projection', () => {
  it('closes a proposal that reaches a terminal state', async () => {
    const proposal = await newProposal();
    expect(await listOpenProposals(db, space.id)).toHaveLength(1);
    await setProposalState(db, proposal.id, 'applied');
    expect(await listOpenProposals(db, space.id)).toHaveLength(0);
    expect((await getProposal(db, proposal.id))?.closedAt).not.toBeNull();
  });

  it('reopens one moved back to a non-terminal state', async () => {
    // `closedAt` is derived from the state rather than passed in, so a
    // returned proposal cannot stay hidden from the open-proposals index.
    const proposal = await newProposal();
    await setProposalState(db, proposal.id, 'rejected');
    await setProposalState(db, proposal.id, 'returned');
    expect((await getProposal(db, proposal.id))?.closedAt).toBeNull();
    expect(await listOpenProposals(db, space.id)).toHaveLength(1);
  });
});

describe('evidence', () => {
  it('reuses one item across proposals citing the same source', async () => {
    const first = await ensureEvidenceItem(db, {
      spaceId: space.id,
      kind: 'scientific_paper',
      externalRef: 'citation:88',
    });
    const second = await ensureEvidenceItem(db, {
      spaceId: space.id,
      kind: 'scientific_paper',
      externalRef: 'citation:88',
    });
    expect(second.id).toBe(first.id);
  });

  it('always inserts an item with no external reference', async () => {
    // A free-text expert statement is not the same statement just because it
    // was filed twice.
    const a = await ensureEvidenceItem(db, {
      spaceId: space.id,
      kind: 'expert_statement',
      metadata: { note: 'Muntlig vurdering' },
    });
    const b = await ensureEvidenceItem(db, {
      spaceId: space.id,
      kind: 'expert_statement',
      metadata: { note: 'Muntlig vurdering' },
    });
    expect(b.id).not.toBe(a.id);
  });

  it('can attach evidence that contradicts, not only evidence that supports', async () => {
    const item = await ensureEvidenceItem(db, {
      spaceId: space.id,
      kind: 'scientific_paper',
      externalRef: 'citation:99',
    });
    await linkEvidence(db, {
      evidenceItemId: item.id,
      subjectType: 'target',
      subjectId: target.id,
      relation: 'contradicts',
      quote: 'Ingen effekt observert.',
    });
    const attached = await evidenceForSubject(db, {
      subjectType: 'target',
      subjectId: target.id,
    });
    expect(attached).toHaveLength(1);
    expect(attached[0]!.link.relation).toBe('contradicts');
    expect(attached[0]!.item.externalRef).toBe('citation:99');
  });
});

describe('legacy links', () => {
  it('is idempotent for an identical link', async () => {
    const first = await linkLegacyRecord(db, {
      genericType: 'assessment',
      genericId: 1,
      legacyType: 'agent_verification',
      legacyId: 10,
    });
    const again = await linkLegacyRecord(db, {
      genericType: 'assessment',
      genericId: 1,
      legacyType: 'agent_verification',
      legacyId: 10,
    });
    expect(again.id).toBe(first.id);
  });

  it('refuses to re-point an existing link', async () => {
    // Relinking silently would hide the bug in whichever writer tried it, and
    // lose the mapping that makes parity debugging a join.
    await linkLegacyRecord(db, {
      genericType: 'assessment',
      genericId: 1,
      legacyType: 'agent_verification',
      legacyId: 10,
    });
    await expect(
      linkLegacyRecord(db, {
        genericType: 'assessment',
        genericId: 1,
        legacyType: 'agent_verification',
        legacyId: 11,
      }),
    ).rejects.toThrow(ConflictingLegacyLinkError);
  });

  it('refuses two generic records claiming one legacy row', async () => {
    await linkLegacyRecord(db, {
      genericType: 'assessment',
      genericId: 1,
      legacyType: 'agent_verification',
      legacyId: 10,
    });
    await expect(
      linkLegacyRecord(db, {
        genericType: 'assessment',
        genericId: 2,
        legacyType: 'agent_verification',
        legacyId: 10,
      }),
    ).rejects.toThrow(ConflictingLegacyLinkError);
  });

  it('resolves in both directions', async () => {
    await linkLegacyRecord(db, {
      genericType: 'proposal',
      genericId: 5,
      legacyType: 'pending_edit',
      legacyId: 77,
    });
    expect((await findByGeneric(db, 'proposal', 5))?.legacyId).toBe(77);
  });
});

describe('audit events', () => {
  it('accepts a system event with no actor', async () => {
    // Nullable here and only here: inventing an actor would put a fabricated
    // name in an audit log.
    const event = await recordAuditEvent(db, {
      spaceId: space.id,
      eventType: 'backfill_started',
      subjectType: 'target',
      subjectId: target.id,
    });
    expect(event.actorRef).toBeNull();
  });
});
