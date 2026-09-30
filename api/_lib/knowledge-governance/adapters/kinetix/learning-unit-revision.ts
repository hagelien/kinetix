/**
 * Adapter for `agent_verifications.target_type = 'learning_unit_revision'`.
 *
 * This type is half-wired in Kinetix and deliberately left that way (Phase 0
 * doc §5.2): the verdict schema does not accept it, and the queue's interleaved
 * set excludes it because `learning_unit_revisions` is not migrated in every
 * environment. An adapter still exists for it because Phase 2's exit gate is
 * that *every currently supported verification target* can be represented — and
 * `learning_unit_revision` is in `ApprovalTargetType`, so it is supported in the
 * approvals taxonomy even though the agent queue does not serve it.
 *
 * Representing it here is free and honest; serving it is a decision for the
 * phase that finishes wiring it, not for this one.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../../../db.js';
import { learningUnitRevisions } from '../../../../../db/schema.js';
import { riskProfile } from 'assurance-core';
import type { RiskProfile, TargetRef } from 'assurance-core';
import { sealReviewPacket, type ReviewPacket } from 'assurance-core';
import {
  validationOk,
  type EvidenceRequirement,
  type KnowledgeTargetAdapter,
  type ProposalVersion,
  type ValidationResult,
} from '../../target-adapter.js';
import {
  authorRefOf,
  kinetixTarget,
  kinetixVersionRef,
  payloadFingerprint,
  KINETIX_SPACE,
} from './support.js';

export const LEARNING_UNIT_REVISION_TYPE = 'learning_unit_revision';

interface LearningUnitBaseline {
  readonly unitId: number;
}

interface LearningUnitProposal {
  readonly unitId: number;
  readonly content: unknown;
  readonly editSummary: string | null;
}

async function loadRow(id: number) {
  const db = getDb();
  const [row] = await db
    .select({
      id: learningUnitRevisions.id,
      unitId: learningUnitRevisions.unitId,
      content: learningUnitRevisions.content,
      editSummary: learningUnitRevisions.editSummary,
      createdBy: learningUnitRevisions.createdBy,
      createdAt: learningUnitRevisions.createdAt,
    })
    .from(learningUnitRevisions)
    .where(eq(learningUnitRevisions.id, id))
    .limit(1);
  return row ?? null;
}

export const learningUnitRevisionAdapter: KnowledgeTargetAdapter<
  LearningUnitProposal,
  LearningUnitBaseline
> = {
  space: KINETIX_SPACE,
  type: LEARNING_UNIT_REVISION_TYPE,

  async loadCurrent(target: TargetRef): Promise<LearningUnitBaseline | null> {
    const row = await loadRow(Number(target.id));
    return row ? { unitId: row.unitId } : null;
  },

  async loadVersion(target: TargetRef): Promise<ProposalVersion | null> {
    const row = await loadRow(Number(target.id));
    if (!row) return null;
    const createdAt = row.createdAt.toISOString();
    const payload: LearningUnitProposal = {
      unitId: row.unitId,
      content: row.content,
      editSummary: row.editSummary,
    };
    return {
      ref: kinetixVersionRef(LEARNING_UNIT_REVISION_TYPE, row.id, createdAt),
      target: kinetixTarget(LEARNING_UNIT_REVISION_TYPE, row.id),
      payload,
      targetVersion: createdAt,
      createdAt,
      authorRef: authorRefOf(row.createdBy),
    };
  },

  async validateProposal(): Promise<ValidationResult> {
    return validationOk();
  },

  fingerprint({ proposal, current }) {
    return payloadFingerprint(proposal, current);
  },

  async buildReviewPacket({ version }): Promise<ReviewPacket> {
    const proposal = version.payload as LearningUnitProposal;
    return sealReviewPacket({
      version,
      proposed: {
        content: proposal.content,
        editSummary: proposal.editSummary,
      },
      current: { unitId: proposal.unitId },
      evidence: [],
      evidenceRequirements: [],
      context: {},
    });
  },

  async classifyRisk(): Promise<RiskProfile> {
    return riskProfile('medium', ['teaching_material']);
  },

  async evidenceRequirements(): Promise<readonly EvidenceRequirement[]> {
    return [];
  },
};
