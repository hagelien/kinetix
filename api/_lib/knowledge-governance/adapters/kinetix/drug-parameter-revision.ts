/**
 * Adapter for `agent_verifications.target_type = 'drug_parameter_revision'`.
 *
 * The unit of review is one `drug_parameter_revisions` row: an already-applied
 * change to a drug parameter that peers verify after the fact. The baseline a
 * reviewer compares against is therefore the row's own `old_value` plus the
 * drug it belongs to, exactly as the legacy queue serves it.
 */

import { asc, eq, lt } from 'drizzle-orm';
import { getDb } from '../../../db.js';
import { drugParameterRevisions, drugs } from '../../../../../db/schema.js';
import {
  isDrugParameterId,
  parameterIsEntryBacked,
} from '../../../../../src/lib/drugParameters.js';
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
  citationEvidence,
  citationEvidenceRequirement,
  kinetixTarget,
  kinetixVersionRef,
  payloadFingerprint,
  referenceIdList,
  KINETIX_SPACE,
} from './support.js';

export const DRUG_PARAMETER_REVISION_TYPE = 'drug_parameter_revision';

interface DrugBaseline {
  readonly drug: { id: number; slug: string | null; names: unknown };
  readonly parameter: string;
  readonly value: unknown;
}

interface RevisionProposal {
  readonly parameter: string;
  readonly newValue: unknown;
  readonly editSummary: string | null;
  readonly referenceIds: number[];
}

async function loadRow(id: number) {
  const db = getDb();
  const [row] = await db
    .select({
      id: drugParameterRevisions.id,
      drugId: drugParameterRevisions.drugId,
      parameter: drugParameterRevisions.parameter,
      oldValue: drugParameterRevisions.oldValue,
      newValue: drugParameterRevisions.newValue,
      editSummary: drugParameterRevisions.editSummary,
      referenceId: drugParameterRevisions.referenceId,
      referenceIds: drugParameterRevisions.referenceIds,
      createdBy: drugParameterRevisions.createdBy,
      createdAt: drugParameterRevisions.createdAt,
      drugSlug: drugs.slug,
      drugNames: drugs.names,
    })
    .from(drugParameterRevisions)
    // leftJoin, matching the legacy queue: a revision whose drug row was
    // removed still has to be explainable rather than vanish from review.
    .leftJoin(drugs, eq(drugs.id, drugParameterRevisions.drugId))
    .where(eq(drugParameterRevisions.id, id))
    .limit(1);
  return row ?? null;
}

export const drugParameterRevisionAdapter: KnowledgeTargetAdapter<
  RevisionProposal,
  DrugBaseline
> = {
  space: KINETIX_SPACE,
  type: DRUG_PARAMETER_REVISION_TYPE,

  async loadCurrent(target: TargetRef): Promise<DrugBaseline | null> {
    const row = await loadRow(Number(target.id));
    if (!row) return null;
    return {
      drug: { id: row.drugId, slug: row.drugSlug, names: row.drugNames },
      parameter: row.parameter,
      value: row.oldValue,
    };
  },

  async loadVersion(target: TargetRef): Promise<ProposalVersion | null> {
    const row = await loadRow(Number(target.id));
    if (!row) return null;
    const createdAt = row.createdAt.toISOString();
    const payload: RevisionProposal = {
      parameter: row.parameter,
      newValue: row.newValue,
      editSummary: row.editSummary,
      referenceIds: referenceIdList(row.referenceIds, row.referenceId),
    };
    return {
      ref: kinetixVersionRef(DRUG_PARAMETER_REVISION_TYPE, row.id, createdAt),
      target: kinetixTarget(DRUG_PARAMETER_REVISION_TYPE, row.id),
      payload,
      // `verificationTargetVersion` uses created_at for this type.
      targetVersion: createdAt,
      createdAt,
      authorRef: authorRefOf(row.createdBy),
    };
  },

  async listQueueCandidates({ olderThan, limit }): Promise<QueueCandidate[]> {
    // No visibility rule: a parameter revision is a record of a change already
    // applied to a published drug, so there is nothing here that a
    // contributor-level reviewer may not see.
    const db = getDb();
    const rows = await db
      .select({
        id: drugParameterRevisions.id,
        createdAt: drugParameterRevisions.createdAt,
        createdBy: drugParameterRevisions.createdBy,
      })
      .from(drugParameterRevisions)
      .where(lt(drugParameterRevisions.createdAt, olderThan))
      .orderBy(asc(drugParameterRevisions.createdAt), asc(drugParameterRevisions.id))
      .limit(limit);
    return rows.map((r) => ({
      targetType: DRUG_PARAMETER_REVISION_TYPE,
      targetId: r.id,
      createdAt: r.createdAt.toISOString(),
      authorUserId: r.createdBy,
      visible: true,
    }));
  },

  async validateProposal(): Promise<ValidationResult> {
    // Legacy stays authoritative (§1.3): the write path validated this row
    // before it existed, and re-deriving a verdict here would create a second
    // opinion nothing consults. Phase 2 adds no new gate.
    return validationOk();
  },

  fingerprint({ proposal, current }) {
    return payloadFingerprint(proposal, current);
  },

  async buildReviewPacket({ version }): Promise<ReviewPacket> {
    const proposal = version.payload as RevisionProposal;
    const current = await this.loadCurrent(version.target);
    return sealReviewPacket({
      version,
      proposed: {
        parameter: proposal.parameter,
        newValue: proposal.newValue,
        editSummary: proposal.editSummary,
      },
      current: current
        ? { drug: current.drug, value: current.value }
        : {},
      evidence: citationEvidence(proposal.referenceIds),
      evidenceRequirements: [citationEvidenceRequirement()],
      context: { parameter: proposal.parameter },
    });
  },

  async classifyRisk({ version }): Promise<RiskProfile> {
    const { parameter } = version.payload as RevisionProposal;
    // The same predicate the consensus gate uses for a high-risk pending edit
    // (`isHighRiskPendingEdit`): an entry-backed parameter is one the simulator
    // computes from, so a wrong value is a wrong dose rather than a wrong word.
    const entryBacked =
      isDrugParameterId(parameter) && parameterIsEntryBacked(parameter);
    return entryBacked
      ? riskProfile('high', ['calculation_driving'])
      : riskProfile('medium');
  },

  async evidenceRequirements(): Promise<readonly EvidenceRequirement[]> {
    return [citationEvidenceRequirement()];
  },
};
