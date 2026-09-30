/**
 * Adapter for `agent_verifications.target_type = 'wiki_revision'`.
 *
 * The unit of review is one `wiki_revisions` row; the baseline is the previous
 * revision of the same page, which is what makes the change legible as a diff.
 *
 * Visibility is part of the contract, not an optimisation: the legacy queue
 * joins `wiki_pages` on `status = 'published'`, because verifying agents are
 * contributor-level and unpublished monograph content must not reach them. This
 * adapter applies the same filter, so a draft page's revision resolves to
 * `null` here exactly as it is absent there.
 */

import { and, asc, desc, eq, lt } from 'drizzle-orm';
import { getDb } from '../../../db.js';
import { wikiPages, wikiRevisions } from '../../../../../db/schema.js';
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

export const WIKI_REVISION_TYPE = 'wiki_revision';

interface WikiBaseline {
  readonly page: {
    id: number;
    slug: string;
    title: string;
    status: string;
  };
  readonly content: unknown;
  readonly contentHtml: string | null;
  readonly createdAt: string | null;
}

interface WikiProposal {
  readonly content: unknown;
  readonly contentHtml: string | null;
  readonly editSummary: string | null;
  readonly pageId: number;
}

async function loadRow(id: number) {
  const db = getDb();
  const [row] = await db
    .select({
      id: wikiRevisions.id,
      pageId: wikiRevisions.pageId,
      editSummary: wikiRevisions.editSummary,
      createdBy: wikiRevisions.createdBy,
      createdAt: wikiRevisions.createdAt,
      content: wikiRevisions.content,
      contentHtml: wikiRevisions.contentHtml,
      pageSlug: wikiPages.slug,
      pageTitle: wikiPages.title,
      pageStatus: wikiPages.status,
    })
    .from(wikiRevisions)
    .innerJoin(wikiPages, eq(wikiPages.id, wikiRevisions.pageId))
    .where(and(eq(wikiRevisions.id, id), eq(wikiPages.status, 'published')))
    .limit(1);
  return row ?? null;
}

export const wikiRevisionAdapter: KnowledgeTargetAdapter<
  WikiProposal,
  WikiBaseline
> = {
  space: KINETIX_SPACE,
  type: WIKI_REVISION_TYPE,

  async loadCurrent(target: TargetRef): Promise<WikiBaseline | null> {
    const row = await loadRow(Number(target.id));
    if (!row) return null;
    const db = getDb();
    // The most recent revision strictly older than this one, on the same page.
    // The legacy queue does this for a whole page of candidates in one
    // DISTINCT ON self-join; a single-target read wants the plain form.
    const [prior] = await db
      .select({
        content: wikiRevisions.content,
        contentHtml: wikiRevisions.contentHtml,
        createdAt: wikiRevisions.createdAt,
      })
      .from(wikiRevisions)
      .where(
        and(
          eq(wikiRevisions.pageId, row.pageId),
          lt(wikiRevisions.createdAt, row.createdAt),
        ),
      )
      .orderBy(desc(wikiRevisions.createdAt))
      .limit(1);
    return {
      page: {
        id: row.pageId,
        slug: row.pageSlug,
        title: row.pageTitle,
        status: row.pageStatus,
      },
      content: prior?.content ?? null,
      contentHtml: prior?.contentHtml ?? null,
      createdAt: prior?.createdAt.toISOString() ?? null,
    };
  },

  async loadVersion(target: TargetRef): Promise<ProposalVersion | null> {
    const row = await loadRow(Number(target.id));
    if (!row) return null;
    const createdAt = row.createdAt.toISOString();
    const payload: WikiProposal = {
      content: row.content,
      contentHtml: row.contentHtml,
      editSummary: row.editSummary,
      pageId: row.pageId,
    };
    return {
      ref: kinetixVersionRef(WIKI_REVISION_TYPE, row.id, createdAt),
      target: kinetixTarget(WIKI_REVISION_TYPE, row.id),
      payload,
      targetVersion: createdAt,
      createdAt,
      authorRef: authorRefOf(row.createdBy),
    };
  },

  async listQueueCandidates({ olderThan, limit }): Promise<QueueCandidate[]> {
    // The visibility rule that matters for this type: verifying agents are
    // contributor-level, so a revision of an unpublished page must not reach
    // them. Applied in SQL rather than by marking rows invisible afterwards —
    // filtering after the LIMIT would let a page of draft revisions starve the
    // eligible work below the cap, which is the same reason the legacy queue
    // does it in SQL.
    const db = getDb();
    const rows = await db
      .select({
        id: wikiRevisions.id,
        createdAt: wikiRevisions.createdAt,
        createdBy: wikiRevisions.createdBy,
      })
      .from(wikiRevisions)
      .innerJoin(wikiPages, eq(wikiPages.id, wikiRevisions.pageId))
      .where(
        and(
          lt(wikiRevisions.createdAt, olderThan),
          eq(wikiPages.status, 'published'),
        ),
      )
      .orderBy(asc(wikiRevisions.createdAt), asc(wikiRevisions.id))
      .limit(limit);
    return rows.map((r) => ({
      targetType: WIKI_REVISION_TYPE,
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
    const proposal = version.payload as WikiProposal;
    const current = await this.loadCurrent(version.target);
    return sealReviewPacket({
      version,
      proposed: {
        content: proposal.content,
        contentHtml: proposal.contentHtml,
        editSummary: proposal.editSummary,
      },
      current: current
        ? {
            page: current.page,
            content: current.content,
            contentHtml: current.contentHtml,
            createdAt: current.createdAt,
          }
        : {},
      evidence: [],
      evidenceRequirements: [],
      // A first revision has no baseline to diff against; say so rather than
      // letting a reviewer read two nulls as "nothing changed".
      context: { isFirstRevision: current?.createdAt == null },
    });
  },

  async classifyRisk(): Promise<RiskProfile> {
    // Prose, not a computed input. Kinetix's consensus gate has never treated a
    // wiki revision as high risk, and inventing a stricter classification here
    // would breach §1.7 in the other direction — a policy this layer states but
    // the live path does not enforce is a lie about the system.
    return riskProfile('medium', ['narrative']);
  },

  async evidenceRequirements(): Promise<readonly EvidenceRequirement[]> {
    return [];
  },
};
