/**
 * Adapter for `agent_verifications.target_type = 'drug_discussion'`.
 *
 * The unit of review is one comment on a drug parameter thread. Nothing about
 * a comment publishes knowledge — verifying it is how the comment evaluator
 * marks a claim as corroborated or contested — so it carries no evidence
 * requirement and the lowest risk classification of the six types.
 *
 * The legacy queue serves only drug-scoped comments: a topic-page fact comment
 * has a null `drug_id`, and the evaluator on the other end hydrates a drug from
 * the payload. This adapter mirrors that, so a topic comment resolves to `null`
 * here as it is absent there.
 */

import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';
import { getDb } from '../../../db.js';
import { drugParameterDiscussions } from '../../../../../db/schema.js';
import { riskProfile } from 'assurance-core';
import type { RiskProfile, TargetRef } from 'assurance-core';
import { sealReviewPacket, type ReviewPacket } from 'assurance-core';
import {
  validationOk,
  type EvidenceRequirement,
  type KnowledgeTargetAdapter,
  type ProposalVersion,
  type QueueCandidate,
  type ValidationResult,
} from '../../target-adapter.js';
import {
  authorRefOf,
  kinetixTarget,
  kinetixVersionRef,
  payloadFingerprint,
  KINETIX_SPACE,
} from './support.js';

export const DRUG_DISCUSSION_TYPE = 'drug_discussion';

interface DiscussionBaseline {
  readonly drugId: number;
  readonly parameter: string | null;
}

interface DiscussionProposal {
  readonly body: string;
  readonly parameter: string | null;
  readonly parentId: number | null;
  readonly drugId: number;
}

async function loadRow(id: number) {
  const db = getDb();
  const [row] = await db
    .select({
      id: drugParameterDiscussions.id,
      drugId: drugParameterDiscussions.drugId,
      parameter: drugParameterDiscussions.parameter,
      parentId: drugParameterDiscussions.parentId,
      body: drugParameterDiscussions.body,
      createdBy: drugParameterDiscussions.createdBy,
      createdAt: drugParameterDiscussions.createdAt,
    })
    .from(drugParameterDiscussions)
    .where(
      and(
        eq(drugParameterDiscussions.id, id),
        isNotNull(drugParameterDiscussions.drugId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export const drugDiscussionAdapter: KnowledgeTargetAdapter<
  DiscussionProposal,
  DiscussionBaseline
> = {
  space: KINETIX_SPACE,
  type: DRUG_DISCUSSION_TYPE,

  async loadCurrent(target: TargetRef): Promise<DiscussionBaseline | null> {
    const row = await loadRow(Number(target.id));
    if (!row || row.drugId === null) return null;
    return { drugId: row.drugId, parameter: row.parameter };
  },

  async loadVersion(target: TargetRef): Promise<ProposalVersion | null> {
    const row = await loadRow(Number(target.id));
    if (!row || row.drugId === null) return null;
    const createdAt = row.createdAt.toISOString();
    const payload: DiscussionProposal = {
      body: row.body,
      parameter: row.parameter,
      parentId: row.parentId,
      drugId: row.drugId,
    };
    return {
      ref: kinetixVersionRef(DRUG_DISCUSSION_TYPE, row.id, createdAt),
      target: kinetixTarget(DRUG_DISCUSSION_TYPE, row.id),
      payload,
      targetVersion: createdAt,
      createdAt,
      authorRef: authorRefOf(row.createdBy),
    };
  },

  async listQueueCandidates({ olderThan, limit }): Promise<QueueCandidate[]> {
    // Drug-scoped comments only. A topic-page fact comment has a null drugId
    // and the evaluator on the other end hydrates a drug from the payload, so
    // queuing one hands an agent a target it cannot work on.
    const db = getDb();
    const rows = await db
      .select({
        id: drugParameterDiscussions.id,
        createdAt: drugParameterDiscussions.createdAt,
        createdBy: drugParameterDiscussions.createdBy,
      })
      .from(drugParameterDiscussions)
      .where(
        and(
          isNotNull(drugParameterDiscussions.drugId),
          lt(drugParameterDiscussions.createdAt, olderThan),
        ),
      )
      .orderBy(asc(drugParameterDiscussions.createdAt), asc(drugParameterDiscussions.id))
      .limit(limit);
    return rows.map((r) => ({
      targetType: DRUG_DISCUSSION_TYPE,
      targetId: r.id,
      createdAt: r.createdAt.toISOString(),
      authorUserId: r.createdBy,
      visible: true,
    }));
  },

  async validateProposal(): Promise<ValidationResult> {
    return validationOk();
  },

  fingerprint({ proposal, current }) {
    return payloadFingerprint(proposal, current);
  },

  async buildReviewPacket({ version }): Promise<ReviewPacket> {
    const proposal = version.payload as DiscussionProposal;
    return sealReviewPacket({
      version,
      proposed: {
        body: proposal.body,
        parameter: proposal.parameter,
        parentId: proposal.parentId,
      },
      current: { drugId: proposal.drugId },
      evidence: [],
      evidenceRequirements: [],
      context: { isReply: proposal.parentId !== null },
    });
  },

  async classifyRisk(): Promise<RiskProfile> {
    return riskProfile('low', ['discussion']);
  },

  async evidenceRequirements(): Promise<readonly EvidenceRequirement[]> {
    return [];
  },
};
