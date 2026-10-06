/**
 * Adapter for `agent_verifications.target_type = 'pending_edit'`.
 *
 * The widest of the six: a `pending_edits` row can propose a drug parameter, a
 * parameter entry, a whole wiki page, one atomic fact, a section, a metabolism
 * profile, a bio-entity, a learning unit or a clinical case — thirteen live
 * `edit_type` values (Phase 0 doc §1). One adapter covers all of them because
 * they share a target *table*, a status lifecycle and a version token; the
 * per-`edit_type` differences are all in which baseline a reviewer needs.
 *
 * It is also the only type whose verification can publish content outright,
 * through `applyOnAgentConsensus`. That path is untouched here — this adapter
 * only reads.
 */

import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { getDb } from '../../../db.js';
import { citations, drugs, pendingEdits, wikiPages } from '../../../../../db/schema.js';
import { pendingEditPageHydrationFor } from '../../../../agent-verifications-queue.js';
import {
  approverCountsForConsensus,
  lockPendingEditTargetPage,
  lockPendingEditSourceReviews,
  isHighRiskPendingEdit,
  lockConsensusEligibility,
} from '../../../agent-verifications.js';
import { collectConsensusFacts, evaluateShadowPolicy } from '../../policy-shadow.js';
import { applyApprovedEdit } from '../../../pending-edits-helpers.js';
import { userIdFromActorRef } from '../../actor-context.js';
import { getDrugParametersByDrugIds } from '../../../drugParameterStore.js';
import { readParameterValue } from '../../../drugs-helpers.js';
import { isDrugParameterId } from '../../../drugParameterIds.js';
import { resolveDrugName } from '../../../../../src/lib/drugNames.js';
import { riskProfile } from 'assurance-core';
import type { RiskProfile, TargetRef } from 'assurance-core';
import { KINETIX_CLINICAL_CASE_TAG } from '../../../../../src/lib/assurance/policy.js';
import { sealReviewPacket, type ReviewPacket } from 'assurance-core';
import {
  validationOk,
  type AppliedRevisionRef,
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

export const PENDING_EDIT_TYPE = 'pending_edit';

/** The baseline a reviewer compares a pending edit against, by edit type. */
export interface PendingEditBaseline {
  readonly drugName?: string;
  readonly currentValue?: unknown;
  readonly pageTitle?: string;
  readonly currentContent?: unknown;
  readonly currentContentHtml?: string | null;
  readonly citation?: {
    id: number;
    type: string;
    identifier: string;
    metadata: unknown;
  };
}

export interface PendingEditProposal {
  readonly editType: string;
  readonly targetId: number | null;
  readonly parameter: string | null;
  readonly proposedValue: unknown;
  readonly proposedMeta: unknown;
  readonly referenceIds: number[];
  readonly status: string;
  readonly sectionId: string | null;
  readonly fieldId: string | null;
  readonly factStatement: string | null;
  readonly factOperation: string | null;
  readonly factTargetAnchor: unknown;
}

/**
 * SQL predicate for "a reviewer may see this pending edit at all".
 *
 * The same rule `pendingEditWikiVisibility()` applies in the live queue:
 * `wiki_new` is always pre-publication, and a wiki_page/wiki_fact/wiki_section
 * edit against a draft page would leak the draft through `proposedValue`.
 * Verifying agents are contributor-level, so neither may reach them.
 */
function reviewerVisiblePendingEdit() {
  return sql`(
    ${pendingEdits.editType} not in ('wiki_new','wiki_page','wiki_fact','wiki_section')
    or (
      ${pendingEdits.editType} in ('wiki_page','wiki_fact','wiki_section')
      and exists (
        select 1 from ${wikiPages}
        where ${wikiPages.id} = ${pendingEdits.targetId}
          and ${wikiPages.status} = 'published'
      )
    )
  )`;
}

async function loadRow(id: number, opts: { includeHidden?: boolean } = {}) {
  const db = getDb();
  const [row] = await db
    .select({
      id: pendingEdits.id,
      editType: pendingEdits.editType,
      targetId: pendingEdits.targetId,
      parameter: pendingEdits.parameter,
      proposedValue: pendingEdits.proposedValue,
      proposedMeta: pendingEdits.proposedMeta,
      referenceId: pendingEdits.referenceId,
      referenceIds: pendingEdits.referenceIds,
      submittedBy: pendingEdits.submittedBy,
      submittedAt: pendingEdits.submittedAt,
      status: pendingEdits.status,
      sectionId: pendingEdits.sectionId,
      fieldId: pendingEdits.fieldId,
      factStatement: pendingEdits.factStatement,
      factOperation: pendingEdits.factOperation,
      factTargetAnchor: pendingEdits.factTargetAnchor,
    })
    .from(pendingEdits)
    .where(
      opts.includeHidden
        ? eq(pendingEdits.id, id)
        : and(eq(pendingEdits.id, id), reviewerVisiblePendingEdit()),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Hydrate the baseline for one row.
 *
 * The wiki branches read published pages only, and the legacy queue enforces
 * the same rule twice — once in SQL (`pendingEditWikiVisibility`) and once when
 * building its page map. Verifying agents are contributor-level, so draft
 * monograph content must not reach them through a proposal's baseline any more
 * than through the page read path.
 */
async function loadBaseline(row: {
  editType: string;
  targetId: number | null;
  parameter: string | null;
}): Promise<PendingEditBaseline> {
  const db = getDb();
  if (!row.targetId) return {};

  if (row.editType === 'paper_review') {
    const [citation] = await db
      .select({
        id: citations.id,
        type: citations.type,
        identifier: citations.identifier,
        metadata: citations.metadata,
      })
      .from(citations)
      .where(eq(citations.id, row.targetId))
      .limit(1);
    // targetId points at `citations`, not `paper_reviews`: the row IS a
    // proposal to create or replace the review for that citation.
    return citation ? { citation } : {};
  }

  if (row.editType === 'parameter') {
    const [drug] = await db
      .select()
      .from(drugs)
      .where(eq(drugs.id, row.targetId))
      .limit(1);
    if (!drug) return {};
    const paramsByDrug = await getDrugParametersByDrugIds(db, [drug.id]);
    // Site primary language is Norwegian; 'nb' falls back to English when
    // absent. Mirrors /api/pending-edits and activeLangCode()'s default.
    const drugName = resolveDrugName(drug.names, 'nb');
    const parameter = row.parameter;
    if (parameter && isDrugParameterId(parameter)) {
      return {
        drugName,
        currentValue: readParameterValue(
          drug as Record<string, unknown>,
          parameter,
          paramsByDrug.get(drug.id),
        ),
      };
    }
    return { drugName };
  }

  const hydration = pendingEditPageHydrationFor(row.editType);
  if (hydration === 'none') return {};

  const [page] = await db
    .select({
      id: wikiPages.id,
      title: wikiPages.title,
      content: wikiPages.content,
      contentHtml: wikiPages.contentHtml,
      status: wikiPages.status,
    })
    .from(wikiPages)
    .where(and(eq(wikiPages.id, row.targetId), eq(wikiPages.status, 'published')))
    .limit(1);
  if (!page) return {};
  return {
    pageTitle: page.title,
    currentContent: page.content,
    // 'content' hydration deliberately withholds the rendered HTML: a
    // fact/section edit is judged against the structured document, and
    // `pendingEditPageHydrationFor` states exactly that rule.
    //
    // Known divergence from the live queue, and an intentional one. That queue
    // batches its page reads and drops any page already in the full-hydration
    // set from the content-only set, so a `wiki_fact` edit served in the same
    // batch as a `wiki_page` edit on the same page receives the HTML after all
    // — what a reviewer gets depends on which other rows shared its batch. It
    // is benign (the page is published either way) but it is not a rule, and an
    // adapter reproducing it would have to be batch-aware to be wrong in the
    // same way. Phase 2 changes no production path (§1.3), so the queue keeps
    // its behaviour and this divergence is recorded instead:
    // tests/governance/adapters/queue-hydration-parity.test.ts pins both sides.
    currentContentHtml: hydration === 'full' ? page.contentHtml : null,
  };
}

export const pendingEditAdapter: KnowledgeTargetAdapter<
  PendingEditProposal,
  PendingEditBaseline
> = {
  space: KINETIX_SPACE,
  type: PENDING_EDIT_TYPE,

  async loadCurrent(target: TargetRef): Promise<PendingEditBaseline | null> {
    const row = await loadRow(Number(target.id));
    if (!row) return null;
    return loadBaseline(row);
  },

  async loadVersion(
    target: TargetRef,
    opts: { includeHidden?: boolean } = {},
  ): Promise<ProposalVersion | null> {
    const row = await loadRow(Number(target.id), opts);
    if (!row) return null;
    const submittedAt = row.submittedAt.toISOString();
    const payload: PendingEditProposal = {
      editType: row.editType,
      targetId: row.targetId,
      parameter: row.parameter,
      proposedValue: row.proposedValue,
      proposedMeta: row.proposedMeta,
      referenceIds: referenceIdList(row.referenceIds, row.referenceId),
      status: row.status,
      sectionId: row.sectionId,
      fieldId: row.fieldId,
      factStatement: row.factStatement,
      factOperation: row.factOperation,
      factTargetAnchor: row.factTargetAnchor,
    };
    return {
      ref: kinetixVersionRef(
        PENDING_EDIT_TYPE,
        row.id,
        `${submittedAt}|${row.status}`,
      ),
      target: kinetixTarget(PENDING_EDIT_TYPE, row.id),
      payload,
      // Status is folded into the token so any moderation transition —
      // approve, reject, return, withdraw — invalidates a verdict an agent
      // queued while the row was still pending. Matches
      // `verificationTargetVersion`, and a mismatch is the existing 409.
      targetVersion: `${submittedAt}|${row.status}`,
      createdAt: submittedAt,
      authorRef: authorRefOf(row.submittedBy),
    };
  },

  async listQueueCandidates({ olderThan, limit }): Promise<QueueCandidate[]> {
    // Two visibility rules, both in SQL so the LIMIT stays honest.
    //
    // Only `status='pending'` rows are reviewable at all — a moderated row has
    // already been decided.
    //
    // And wiki content that is not published must not reach a
    // contributor-level agent: `wiki_new` is always pre-publication, and a
    // wiki_page/wiki_fact/wiki_section edit against a draft page would leak the
    // draft through the proposal's own baseline.
    const db = getDb();
    const rows = await db
      .select({
        id: pendingEdits.id,
        submittedAt: pendingEdits.submittedAt,
        submittedBy: pendingEdits.submittedBy,
      })
      .from(pendingEdits)
      .where(
        and(
          eq(pendingEdits.status, 'pending'),
          lt(pendingEdits.submittedAt, olderThan),
          reviewerVisiblePendingEdit(),
        ),
      )
      .orderBy(asc(pendingEdits.submittedAt), asc(pendingEdits.id))
      .limit(limit);
    return rows.map((r) => ({
      targetType: PENDING_EDIT_TYPE,
      targetId: r.id,
      createdAt: r.submittedAt.toISOString(),
      authorUserId: r.submittedBy,
      visible: true,
    }));
  },

  async validateProposal(): Promise<ValidationResult> {
    // The submit endpoint validated this row against `pendingEditSchema` and
    // the per-editType superRefine before it existed, and the apply path
    // re-checks applicability at approval time. Both stay authoritative (§1.3).
    return validationOk();
  },

  fingerprint({ proposal, current }) {
    return payloadFingerprint(proposal, current);
  },

  async buildReviewPacket({ version }): Promise<ReviewPacket> {
    const proposal = version.payload as PendingEditProposal;
    const current = (await this.loadCurrent(version.target)) ?? {};
    const risk = await this.classifyRisk({ version, current: null });
    return sealReviewPacket({
      version,
      proposed: {
        editType: proposal.editType,
        targetId: proposal.targetId,
        parameter: proposal.parameter,
        proposedValue: proposal.proposedValue,
        proposedMeta: proposal.proposedMeta,
        status: proposal.status,
        sectionId: proposal.sectionId,
        fieldId: proposal.fieldId,
        factStatement: proposal.factStatement,
        factOperation: proposal.factOperation,
        factTargetAnchor: proposal.factTargetAnchor,
      },
      current: { ...current },
      evidence: citationEvidence(proposal.referenceIds),
      evidenceRequirements: [
        citationEvidenceRequirement({ blocking: risk.level === 'high' }),
      ],
      // Risk framing is review-task context (§8.1) — it tells a reviewer how
      // much care the change deserves. It is not assurance state, and carries
      // nothing about what other reviewers concluded.
      context: {
        editType: proposal.editType,
        riskLevel: risk.level,
        riskTags: risk.tags,
      },
    });
  },

  async classifyRisk({ version }): Promise<RiskProfile> {
    const proposal = version.payload as PendingEditProposal;
    // Phase 11: the host supplies the risk tag, and the core's `clinical-case`
    // rule matches on it. Before this the invariant lived only as a hardcoded
    // `editType === 'clinical_case'` refusal in `applyOnAgentConsensus` — safe,
    // and unable to say *why* it refused in terms any other knowledge space
    // could reuse. Tagging it here lets the policy state the actual rule: this
    // needs a human with clinical standing, not more agents.
    //
    // High risk, not medium: a clinical case is the one content type Kinetix
    // will not publish on consensus at any tally.
    if (proposal.editType === 'clinical_case') {
      return riskProfile('high', [KINETIX_CLINICAL_CASE_TAG]);
    }
    // Exactly the predicate the live consensus gate uses — an entry-backed
    // `parameter`/`param_entry` edit is calculation-driving, and only those
    // face the full-quorum + flagship requirement. Deriving risk any other way
    // here would state a policy Kinetix does not enforce.
    return isHighRiskPendingEdit({
      editType: proposal.editType,
      parameter: proposal.parameter,
    })
      ? riskProfile('high', ['calculation_driving'])
      : riskProfile('medium');
  },

  async evidenceRequirements({ risk }): Promise<readonly EvidenceRequirement[]> {
    return [citationEvidenceRequirement({ blocking: risk.level === 'high' })];
  },

  /**
   * Write the accepted change (§4.4).
   *
   * The generic core decides *whether* this version may publish; Kinetix
   * decides what publishing means and does it — that is the plan's
   * one-sentence principle (§28), and it is why this delegates to
   * `applyApprovedEdit` rather than reimplementing a single line of the apply
   * path. The whole thirteen-edit-type dispatch, the applicability re-checks,
   * the revision inserts, the conflict marking and the status stamp are the
   * proven implementation, and Phase 8's goal is explicitly that "existing
   * Kinetix apply code remains the mutation mechanism".
   *
   * That also keeps the compatibility requirement satisfied for free: the
   * legacy `pending_edits` row is still stamped `approved` by the same code as
   * before, so the moderator UI, the admin tooling and an older deployment
   * instance mid-rolling-deploy all read exactly what they read today, and a
   * force-legacy rollback lands on a row it recognises.
   *
   * The caller opens the unit of work. `applyApprovedEdit` uses
   * `inTransaction()` (the Phase 8 prerequisite), so it joins that ambient
   * transaction rather than opening a second Pool connection — which is what
   * lets the mutation and its publication event commit or roll back together.
   */
  async apply({ version, actor }): Promise<AppliedRevisionRef> {
    const pendingEditId = Number(version.target.id);
    const reviewerId = userIdFromActorRef(actor.actorRef);
    if (reviewerId === null) {
      // Every apply is attributed to a Kinetix user in `pending_edits`
      // (`reviewed_by`) and in the approval record. A system or service actor
      // has no user id to record, and inventing one would put a fabricated
      // reviewer in the audit trail — so refuse rather than guess.
      throw new Error(
        `knowledge-governance: cannot apply pending edit ${pendingEditId} as ` +
          `'${actor.actorRef}' — the Kinetix apply path requires a user actor`,
      );
    }
    // NOT bound to `version.targetVersion`. The legacy gate binds its apply to
    // the token it computed from the row it just read (see
    // `applyOnAgentConsensus`), which closes the window where an author edits
    // their own proposal between the decision and the write. The same binding
    // belongs here — but the mirrored `targetVersion` is not the live token:
    // passing it refuses every authoritative publication, because the row moves
    // between mirroring and apply in ways the token covers. Closing it on this
    // path needs the decision-time token threaded through the publication, which
    // is more than a call-site change; tracked rather than guessed at.
    // Re-decide under the pending-edit row lock, as the legacy gate does. The
    // publication evaluated facts gathered without locks; an approver
    // suspended or downgraded since (or a revision that wiped the verdicts)
    // must not publish on that stale read. Every agent and backing user row is
    // held FOR SHARE so a concurrent eligibility change serializes with it.
    await applyApprovedEdit(pendingEditId, reviewerId, undefined, {
      revalidate: async () => {
        await lockConsensusEligibility();
        const [target] = await getDb()
          .select({
            editType: pendingEdits.editType,
            targetId: pendingEdits.targetId,
            proposedMeta: pendingEdits.proposedMeta,
          })
          .from(pendingEdits)
          .where(eq(pendingEdits.id, pendingEditId))
          .limit(1);
        if (target) {
          await lockPendingEditTargetPage(target);
          await lockPendingEditSourceReviews(target);
        }
        const facts = await collectConsensusFacts(pendingEditId);
        const recheck = facts ? evaluateShadowPolicy(facts) : null;
        if (!recheck || recheck.outcome !== 'apply') {
          throw new Error(
            `knowledge-governance: consensus for pending edit ${pendingEditId} ` +
              `no longer holds under the apply lock`,
          );
        }
        if (!(await approverCountsForConsensus(pendingEditId, reviewerId))) {
          throw new Error(
            `knowledge-governance: user ${reviewerId} no longer casts a ` +
              `counted approval on pending edit ${pendingEditId}`,
          );
        }
      },
    });
    return {
      target: version.target,
      revisionId: String(pendingEditId),
      appliedAt: new Date().toISOString(),
    };
  },
};
