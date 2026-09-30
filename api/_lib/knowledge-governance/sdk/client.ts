/**
 * The generic governance client (Phase 12 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * Everything up to Phase 11 was Kinetix migrating onto generic internals. This
 * is the first surface designed to be used by something that is *not* Kinetix:
 * the API a second knowledge space, or an agent SDK, would program against.
 *
 * ## Actor-neutral by construction
 *
 * The plan is specific: "the base API should use actor-neutral terminology",
 * with agent-specific conveniences allowed on top. So nothing in this surface
 * says `agent`. A reviewer is an `ActorContext`, a queue request carries an
 * actor and a limit, and whether that actor happens to be an LLM, a person or a
 * scheduled job is the host's business.
 *
 * This is not cosmetic. Kinetix's own queue takes `agentId`, `agentUserId` and
 * `selfReviewEnabled` — three parameters that only mean anything in a system
 * with an `agents` table. A second domain adopting that signature would have to
 * invent agent rows for its human reviewers. The adapter underneath still needs
 * those values; `KinetixActorBinding` is where they are supplied, and it is the
 * only Kinetix-shaped type in the file.
 *
 * ## The review batch still withholds peer judgment
 *
 * The plan restates it as an explicit requirement for this phase, and it is
 * enforced the same way as everywhere else: `review.getBatch` returns sealed
 * `ReviewPacket`s, and `sealReviewPacket` refuses to build one carrying a
 * verdict, a tally, a quorum or a peer rationale. The SDK adds no path around
 * that, and a test asserts the batch it returns contains none of those strings.
 *
 * ## What this is not
 *
 * Not an HTTP surface. §10.3 puts a generic HTTP API later, deliberately, and
 * shipping one now would mean choosing a wire format before a second domain has
 * said what it needs. This is the in-process contract those handlers would call.
 */

import { getDb } from '../../db.js';
import { canonicalSnapshot } from '../store/capability-snapshot.js';
import { KINETIX_SPACE } from '../actor-context.js';
import { registerKinetixAdapters } from '../adapters/kinetix/index.js';
import { getKnowledgeTargetAdapter } from '../registry.js';
import { selectGenericQueue } from '../queue/generic-queue.js';
import { genericAssuranceProfile } from '../assurance-service.js';
import {
  currentAssessments,
  listAssessments,
  listPublicationEvents,
  listRulings,
  listVersions,
  openDispute,
  openDisputes,
  recordRuling,
  reviseAssessment,
  appendVersion,
  createProposal,
  getProposal,
  latestVersion,
  markSubmitted,
  ensureTarget,
  findSpace,
  findByLegacy,
} from '../store/postgres.js';
import type {
  AssessmentRecord,
  DisputeRecord,
  DisputeRulingRecord,
  GovernanceDb,
  ProposalRecord,
  ProposalVersionRecord,
  PublicationEventRecord,
} from '../store/interface.js';
import type { ReviewPacket } from 'assurance-core';
import type {
  ActorContext,
  AssuranceProfile,
} from 'assurance-core';
import type {
  KgDisputeRulingKind,
  KgVerdict,
} from '../../../../db/schema.js';

/**
 * The host-specific facts Kinetix's queue selector needs.
 *
 * The one Kinetix-shaped type here, and it is isolated on purpose: a second
 * domain supplies its own binding rather than inventing agent rows.
 * `selfReviewEnabled` is an admin grant read from the `agents` row, never a
 * request assertion — the SDK passes it through and does not accept it from a
 * caller that is not the host.
 */
export interface KinetixActorBinding {
  readonly agentId: number;
  readonly agentUserId: number;
  readonly selfReviewEnabled: boolean;
}

export interface GovernanceClientOptions {
  readonly space?: string;
  readonly db?: GovernanceDb;
  /**
   * How the host resolves what an actor's approval is *worth* (§19.1).
   *
   * Required for an assessment to carry any assurance standing at all. The
   * client never takes `assuranceCapabilities` from the `ActorContext` it is
   * handed: that context arrives from the caller, and §19.1 forbids trusting a
   * request for verifier capability tier or human-expert designation. Those two
   * facts are the entire basis of the flagship high-risk gate and the clinical
   * sign-off rule, so accepting them from the caller would make both gates
   * self-attested.
   *
   * Omitting it is safe, not permissive: an assessment then snapshots an empty
   * assurance list and satisfies no capability requirement. A host that wants
   * standing to count must say where standing comes from. Kinetix's answer is
   * `resolveAssuranceCapabilities` in `../actor-context.js`.
   */
  readonly resolveAssuranceCapabilities?: (
    actor: ActorContext,
  ) => Promise<readonly string[]>;
}

export interface CreateProposalInput {
  readonly targetType: string;
  readonly targetKey: string;
  readonly payload: unknown;
  readonly payloadFingerprint?: string;
  readonly baseRevisionRef?: string | null;
  readonly riskProfile?: unknown;
}

export interface ReviewBatchRequest {
  readonly actor: ActorContext;
  readonly binding: KinetixActorBinding;
  readonly limit?: number;
  readonly minAgeMinutes?: number;
  readonly targetType?: string;
}

export interface ReviewBatchItem {
  readonly targetType: string;
  readonly targetId: number;
  readonly packet: ReviewPacket;
}

export interface AssessmentInput {
  readonly proposalVersionId: number;
  readonly actor: ActorContext;
  readonly verdict: KgVerdict;
  readonly rationaleMd?: string | null;
  readonly independenceGroup?: string | null;
}

export interface HistoryView {
  readonly proposal: ProposalRecord | null;
  readonly versions: readonly ProposalVersionRecord[];
  readonly assessments: readonly AssessmentRecord[];
  /**
   * Judgments recorded against the target rather than a version.
   *
   * Historical imports record a verdict here when the source cannot prove which
   * revision it judged. They are not version evidence and no version-specific
   * gate may read them — but a "full auditable record" that omits them is not
   * one, and nothing else surfaces them.
   */
  readonly targetAssessments: readonly AssessmentRecord[];
  readonly publicationEvents: readonly PublicationEventRecord[];
}

/**
 * Build a client bound to one knowledge space.
 *
 * Every method takes its actor explicitly rather than the client holding one:
 * a review queue and an assessment can legitimately be for different actors in
 * the same request (a service fetching on behalf of a reviewer), and a client
 * that remembered an identity would make that require two clients or, worse,
 * make the mix-up invisible.
 */
export function governanceClient(opts: GovernanceClientOptions = {}) {
  const space = opts.space ?? KINETIX_SPACE;
  const db = () => opts.db ?? getDb();
  const resolveAssurance = opts.resolveAssuranceCapabilities ?? (async () => []);

  async function spaceId(): Promise<number> {
    const row = await findSpace(db(), space);
    if (!row) {
      throw new Error(`knowledge-governance: no such space '${space}'`);
    }
    return row.id;
  }

  const proposals = {
    /** Open a proposal and write its first version. */
    async create(
      actor: ActorContext,
      input: CreateProposalInput,
    ): Promise<{ proposal: ProposalRecord; version: ProposalVersionRecord }> {
      const sid = await spaceId();
      const target = await ensureTarget(db(), {
        spaceId: sid,
        targetType: input.targetType,
        targetKey: input.targetKey,
      });
      const proposal = await createProposal(db(), {
        spaceId: sid,
        targetId: target.id,
        authorActorRef: actor.actorRef,
        authorKind: actor.kind,
        state: 'draft',
      });
      const version = await appendVersion(db(), {
        proposalId: proposal.id,
        payload: input.payload,
        payloadFingerprint:
          input.payloadFingerprint ??
          (await fingerprintFor(input.targetType, input.payload)),
        authorActorRef: actor.actorRef,
        actorKind: actor.kind,
        riskProfile: input.riskProfile ?? null,
        baseRevisionRef: input.baseRevisionRef ?? null,
      });
      return { proposal, version };
    },

    /**
     * Append a new version.
     *
     * Never an update. §8.3: a revised payload is a new version, so assessments
     * against the old one stay attached to it and cannot be inherited — which
     * is the whole reason the store offers no way to edit a version at all.
     */
    async revise(
      actor: ActorContext,
      proposalId: number,
      input: Omit<CreateProposalInput, 'targetType' | 'targetKey'> & {
        targetType?: string;
      },
    ): Promise<ProposalVersionRecord> {
      return appendVersion(db(), {
        proposalId,
        payload: input.payload,
        payloadFingerprint:
          input.payloadFingerprint ??
          (await fingerprintFor(input.targetType ?? 'unknown', input.payload)),
        authorActorRef: actor.actorRef,
        actorKind: actor.kind,
        riskProfile: input.riskProfile ?? null,
        baseRevisionRef: input.baseRevisionRef ?? null,
      });
    },

    /** Mark the current version as submitted for review. */
    async submit(proposalId: number): Promise<ProposalVersionRecord | null> {
      const version = await latestVersion(db(), proposalId);
      if (!version) return null;
      await markSubmitted(db(), version.id);
      return latestVersion(db(), proposalId);
    },

    get(proposalId: number): Promise<ProposalRecord | null> {
      return getProposal(db(), proposalId);
    },
  };

  const review = {
    /**
     * A batch of targets this actor may review, as sealed packets.
     *
     * Carries no peer judgment — not by omission but by construction: every
     * packet goes through `sealReviewPacket`, which throws rather than seal one
     * containing a verdict, tally, quorum or peer rationale.
     */
    async getBatch(request: ReviewBatchRequest): Promise<ReviewBatchItem[]> {
      registerKinetixAdapters();
      const result = await selectGenericQueue({
        agentId: request.binding.agentId,
        agentUserId: request.binding.agentUserId,
        selfReviewEnabled: request.binding.selfReviewEnabled,
        limit: request.limit ?? 20,
        minAgeMinutes: request.minAgeMinutes ?? 5,
        targetType: request.targetType as never,
        space,
      });

      const out: ReviewBatchItem[] = [];
      for (const candidate of result.items) {
        const adapter = getKnowledgeTargetAdapter(space, candidate.targetType);
        const version = await adapter.loadVersion({
          space,
          type: candidate.targetType,
          id: String(candidate.targetId),
        });
        if (!version) continue;
        out.push({
          targetType: candidate.targetType,
          targetId: candidate.targetId,
          packet: await adapter.buildReviewPacket({
            version,
            actor: request.actor,
          }),
        });
      }
      return out;
    },
  };

  const assessments = {
    /**
     * Record a judgment against one immutable version.
     *
     * `revise` rather than `record`: an actor changing its mind inserts a new
     * row naming the old one, and the caller does not have to know which case
     * it is in.
     */
    async submit(input: AssessmentInput): Promise<AssessmentRecord> {
      return reviseAssessment(db(), {
        spaceId: await spaceId(),
        subjectType: 'proposal_version',
        subjectId: input.proposalVersionId,
        actorRef: input.actor.actorRef,
        actorKind: input.actor.kind,
        verdict: input.verdict,
        rationaleMd: input.rationaleMd ?? null,
        // Snapshotted at write time, never read live afterwards — and the
        // assurance half is resolved server-side rather than copied off the
        // caller's context (§19.1). `capabilities` is passed through because it
        // is descriptive: it records what the actor could do, and no gate reads
        // it. `assuranceCapabilities` is what the gates read, so it is the host
        // that gets to say what it is.
        capabilitySnapshot: canonicalSnapshot({
          assuranceCapabilities: [...(await resolveAssurance(input.actor))],
          // Descriptive, and host-owned for that reason: it records what the
          // actor could do, and no gate consults it. Left beside the
          // qualifications it is not, a future reader eventually reads it.
          host: { capabilities: [...input.actor.capabilities].sort() },
        }),
        independenceGroup: input.independenceGroup ?? null,
      });
    },

    /** The current effective judgments — newest unsuperseded per actor. */
    current(proposalVersionId: number): Promise<AssessmentRecord[]> {
      return currentAssessments(db(), {
        subjectType: 'proposal_version',
        subjectId: proposalVersionId,
      });
    },
  };

  const disputes = {
    async open(
      actor: ActorContext,
      proposalVersionId: number,
      reasonMd: string,
    ): Promise<DisputeRecord> {
      return openDispute(db(), {
        spaceId: await spaceId(),
        subjectType: 'proposal_version',
        subjectId: proposalVersionId,
        openedByActorRef: actor.actorRef,
        openedByKind: actor.kind,
        reasonMd,
      });
    },

    async rule(
      actor: ActorContext,
      disputeId: number,
      ruling: KgDisputeRulingKind,
      rationaleMd?: string,
    ): Promise<DisputeRulingRecord> {
      return recordRuling(db(), {
        disputeId,
        ruling,
        actorRef: actor.actorRef,
        rationaleMd: rationaleMd ?? null,
      });
    },

    /** Open disputes on a version — the question that blocks publication. */
    listOpen(proposalVersionId: number): Promise<DisputeRecord[]> {
      return openDisputes(db(), {
        subjectType: 'proposal_version',
        subjectId: proposalVersionId,
      });
    },

    rulings(disputeId: number): Promise<DisputeRulingRecord[]> {
      return listRulings(db(), disputeId);
    },
  };

  const assurance = {
    /**
     * The assurance state of one target, or `null` when nothing generic backs
     * it yet. Deliberately nullable rather than defaulting to an empty profile:
     * "no reviews" and "no records" are different claims, and a caller that
     * cannot tell them apart will report the second as the first.
     */
    get(target: {
      targetType: string;
      targetId: number;
    }): Promise<AssuranceProfile | null> {
      return genericAssuranceProfile(db(), target);
    },
  };

  const history = {
    /** The full auditable record — the moderator view of §8.2. */
    async get(proposalId: number): Promise<HistoryView> {
      const proposal = await getProposal(db(), proposalId);
      const versions = await listVersions(db(), proposalId);
      const assessmentRows: AssessmentRecord[] = [];
      const events: PublicationEventRecord[] = [];
      for (const version of versions) {
        assessmentRows.push(
          ...(await listAssessments(db(), {
            subjectType: 'proposal_version',
            subjectId: version.id,
          })),
        );
        events.push(...(await listPublicationEvents(db(), version.id)));
      }
      const targetAssessments = proposal
        ? await listAssessments(db(), {
            subjectType: 'target',
            subjectId: proposal.targetId,
          })
        : [];
      return {
        proposal,
        versions,
        assessments: assessmentRows,
        targetAssessments,
        publicationEvents: events,
      };
    },

    /** The generic proposal mirroring a host row, if one exists. */
    async forLegacy(
      legacyType: string,
      legacyId: number,
    ): Promise<HistoryView | null> {
      const link = await findByLegacy(db(), legacyType, legacyId);
      return link ? this.get(link.genericId) : null;
    },
  };

  /** Ask the owning adapter to fingerprint a payload, when the caller did not. */
  async function fingerprintFor(targetType: string, payload: unknown): Promise<string> {
    registerKinetixAdapters();
    try {
      const adapter = getKnowledgeTargetAdapter(space, targetType);
      return await adapter.fingerprint({ proposal: payload, current: null });
    } catch {
      // An unregistered type is not a reason to refuse to record a proposal —
      // the fingerprint is for change detection, and the adapter boundary is
      // checked where it matters, at validation and apply.
      const { fingerprint } = await import(
        'assurance-core'
      );
      return fingerprint({ payload });
    }
  }

  return { space, proposals, review, assessments, disputes, assurance, history };
}

export type GovernanceClient = ReturnType<typeof governanceClient>;
