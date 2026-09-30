/**
 * Adapter for `agent_verifications.target_type = 'paper_review'`.
 *
 * The object under review is itself a review — an agent's structured appraisal
 * of one citation. Two consequences shape this adapter:
 *
 *  - The version token is `updated_at`, not `created_at`. A `paper_reviews` row
 *    is upserted in place on re-review (its target is the citation, not the
 *    review id), so `created_at` stays frozen while the content rolls forward.
 *    The legacy queue orders and ages on `updated_at` for the same reason.
 *  - The read-in-full attestation is self-reported, and the queue surfaces
 *    whether the full text was ever actually on file. That signal is review
 *    context, so it rides in the packet's `context`, not in the proposal.
 */

import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { getDb } from '../../../db.js';
import {
  citationPdfs,
  citations,
  paperReviews,
  pdfRequests,
} from '../../../../../db/schema.js';
import { isReadInFullUnverified } from '../../../pending-edits-helpers.js';
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
  citationEvidenceRequirement,
  kinetixTarget,
  kinetixVersionRef,
  payloadFingerprint,
  KINETIX_SPACE,
} from './support.js';

export const PAPER_REVIEW_TYPE = 'paper_review';

interface CitationBaseline {
  readonly citation: {
    id: number;
    type: string | null;
    identifier: string | null;
    metadata: unknown;
  };
}

interface PaperReviewProposal {
  readonly reviewMarkdown: string | null;
  readonly overallScore: number | null;
  readonly conclusionSupport: string | null;
  readonly reviewConfidence: string | null;
  readonly readInFull: boolean;
  readonly citationId: number;
}

async function loadRow(id: number) {
  const db = getDb();
  const [row] = await db
    .select({
      id: paperReviews.id,
      citationId: paperReviews.citationId,
      reviewMarkdown: paperReviews.reviewMarkdown,
      overallScore: paperReviews.overallScore,
      conclusionSupport: paperReviews.conclusionSupport,
      reviewConfidence: paperReviews.reviewConfidence,
      readInFull: paperReviews.readInFull,
      createdBy: paperReviews.createdBy,
      updatedAt: paperReviews.updatedAt,
      citationType: citations.type,
      citationIdentifier: citations.identifier,
      citationMetadata: citations.metadata,
    })
    .from(paperReviews)
    .leftJoin(citations, eq(citations.id, paperReviews.citationId))
    .where(eq(paperReviews.id, id))
    .limit(1);
  return row ?? null;
}

/** Whether the citation's full text is genuinely on file (§ queue's two probes). */
async function fullTextEvidence(citationId: number): Promise<{
  hasOpenPdfRequest: boolean;
  hasStoredPdf: boolean;
}> {
  const db = getDb();
  const [openRows, storedRows] = await Promise.all([
    db
      .select({ citationId: pdfRequests.citationId })
      .from(pdfRequests)
      .where(
        and(
          inArray(pdfRequests.citationId, [citationId]),
          eq(pdfRequests.status, 'open'),
        ),
      ),
    db
      .select({ citationId: citationPdfs.citationId })
      .from(citationPdfs)
      .where(inArray(citationPdfs.citationId, [citationId])),
  ]);
  return {
    hasOpenPdfRequest: openRows.length > 0,
    hasStoredPdf: storedRows.length > 0,
  };
}

export const paperReviewAdapter: KnowledgeTargetAdapter<
  PaperReviewProposal,
  CitationBaseline
> = {
  space: KINETIX_SPACE,
  type: PAPER_REVIEW_TYPE,

  async loadCurrent(target: TargetRef): Promise<CitationBaseline | null> {
    const row = await loadRow(Number(target.id));
    if (!row) return null;
    return {
      citation: {
        id: row.citationId,
        type: row.citationType,
        identifier: row.citationIdentifier,
        metadata: row.citationMetadata,
      },
    };
  },

  async loadVersion(target: TargetRef): Promise<ProposalVersion | null> {
    const row = await loadRow(Number(target.id));
    if (!row) return null;
    const updatedAt = row.updatedAt.toISOString();
    const payload: PaperReviewProposal = {
      reviewMarkdown: row.reviewMarkdown,
      overallScore: row.overallScore,
      conclusionSupport: row.conclusionSupport,
      reviewConfidence: row.reviewConfidence,
      readInFull: row.readInFull,
      citationId: row.citationId,
    };
    return {
      ref: kinetixVersionRef(PAPER_REVIEW_TYPE, row.id, updatedAt),
      target: kinetixTarget(PAPER_REVIEW_TYPE, row.id),
      payload,
      targetVersion: updatedAt,
      // The queue sorts this type by updatedAt so a re-review is treated as
      // fresh work rather than sinking to its original submission date.
      createdAt: updatedAt,
      authorRef: authorRefOf(row.createdBy),
    };
  },

  async listQueueCandidates({ olderThan, limit }): Promise<QueueCandidate[]> {
    // Aged and ordered on `updated_at`, not `created_at`. A paper_reviews row
    // is upserted in place on re-review, so created_at stays frozen while the
    // content rolls forward: ageing on it would let a re-review be served
    // before the new implicit-approve row had landed, and ordering on it would
    // bury a fresh re-review behind its own original submission date.
    const db = getDb();
    const rows = await db
      .select({
        id: paperReviews.id,
        updatedAt: paperReviews.updatedAt,
        createdBy: paperReviews.createdBy,
      })
      .from(paperReviews)
      .where(lt(paperReviews.updatedAt, olderThan))
      .orderBy(asc(paperReviews.updatedAt), asc(paperReviews.id))
      .limit(limit);
    return rows.map((r) => ({
      targetType: PAPER_REVIEW_TYPE,
      targetId: r.id,
      createdAt: r.updatedAt.toISOString(),
      // Nullable, and a null author is a real value that must still be
      // reviewable — nobody can be the author of it.
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
    const proposal = version.payload as PaperReviewProposal;
    const current = await this.loadCurrent(version.target);
    const { hasOpenPdfRequest, hasStoredPdf } = await fullTextEvidence(
      proposal.citationId,
    );
    return sealReviewPacket({
      version,
      proposed: {
        reviewMarkdown: proposal.reviewMarkdown,
        overallScore: proposal.overallScore,
        conclusionSupport: proposal.conclusionSupport,
        reviewConfidence: proposal.reviewConfidence,
        readInFull: proposal.readInFull,
      },
      current: current ? { citation: current.citation } : {},
      evidence: [
        {
          kind: 'citation',
          id: String(proposal.citationId),
          ...(current
            ? {
                summary: {
                  type: current.citation.type,
                  identifier: current.citation.identifier,
                },
              }
            : {}),
        },
      ],
      evidenceRequirements: [
        citationEvidenceRequirement(),
        {
          id: 'kinetix.fullText',
          kind: 'full_text',
          description:
            'Full text on file when the review attests it was read in full.',
          blocking: false,
        },
      ],
      context: {
        readInFullUnverified: isReadInFullUnverified(
          proposal.readInFull,
          hasOpenPdfRequest,
          hasStoredPdf,
        ),
      },
    });
  },

  async classifyRisk({ version }): Promise<RiskProfile> {
    const proposal = version.payload as PaperReviewProposal;
    // A review is an appraisal, not a published fact — medium by default. The
    // one thing that raises it is an attestation the record cannot support,
    // which is the failure mode `isReadInFullUnverified` exists to surface.
    const { hasOpenPdfRequest, hasStoredPdf } = await fullTextEvidence(
      proposal.citationId,
    );
    const unverified = isReadInFullUnverified(
      proposal.readInFull,
      hasOpenPdfRequest,
      hasStoredPdf,
    );
    return unverified
      ? riskProfile('medium', ['unverified_attestation'])
      : riskProfile('medium');
  },

  async evidenceRequirements(): Promise<readonly EvidenceRequirement[]> {
    return [citationEvidenceRequirement()];
  },
};
