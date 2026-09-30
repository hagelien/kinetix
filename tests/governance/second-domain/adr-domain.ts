/**
 * A second knowledge domain, for Phase 13 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md.
 *
 * **Architecture Decision Records.** Chosen from the plan's own list of
 * examples because it is as far from pharmacology as that list gets while
 * still meeting every requirement §13 sets:
 *
 *   - a different target schema (a decision, its status and its consequences —
 *     no numeric values, no units, no drugs);
 *   - different evidence types (a passing test, a benchmark run, a superseded
 *     ADR — none of them citations);
 *   - different risk rules (risk comes from blast radius and reversibility, not
 *     from whether a value feeds a calculation);
 *   - human and agent contributions;
 *   - some content that auto-publishes and some that needs stronger review.
 *
 * ## The constraint this file exists to test
 *
 * §13: *"The second domain should implement only adapters and policy
 * definitions. If it must modify core code for domain vocabulary, that is
 * evidence the abstraction is still Kinetix-shaped."*
 *
 * So this file imports from `assurance-core` and from the
 * adapter contract, and **nothing else**. No Kinetix module, no Drizzle, no
 * `pending_edits`. If something here had needed a core change to express
 * itself, that would be the finding — and the accompanying test asserts the
 * core is untouched.
 *
 * It is also deliberately backed by a plain `Map` rather than a database. The
 * adapter contract says nothing about SQL, and a second domain that could only
 * work against Postgres would be a weaker result than one that works against
 * anything.
 */

import {
  policy,
  riskProfile,
  approvalWithCapability,
  evidenceRequirementsSatisfied,
  humanApproval,
  independentApprovals,
  noDisputingAssessments,
  noOpenDisputes,
  fingerprint,
  type PolicySet,
  type RiskProfile,
  type TargetRef,
} from 'assurance-core';
import {
  sealReviewPacket,
  type ReviewPacket,
} from 'assurance-core';
import {
  validationFailed,
  validationOk,
  type AppliedRevisionRef,
  type EvidenceRequirement,
  type KnowledgeTargetAdapter,
  type ProposalVersion,
  type QueueCandidate,
  type ValidationResult,
} from '../../../api/_lib/knowledge-governance/target-adapter.js';

export const ADR_SPACE = 'architecture';
export const ADR_TARGET_TYPE = 'decision_record';

/** What an ADR is, in this domain's own vocabulary. */
export interface DecisionRecord {
  readonly id: string;
  readonly title: string;
  readonly status: 'proposed' | 'accepted' | 'superseded';
  readonly context: string;
  readonly decision: string;
  readonly consequences: readonly string[];
  /** Systems this decision constrains. More systems, more blast radius. */
  readonly affects: readonly string[];
  /** Whether backing it out later is cheap. */
  readonly reversible: boolean;
  /** The ADR this one replaces, if any. */
  readonly supersedes?: string | null;
  readonly evidence: readonly AdrEvidence[];
  readonly authorRef: string;
  readonly createdAt: string;
}

export interface AdrEvidence {
  /** Not a citation. This domain's evidence is executable or organisational. */
  readonly kind: 'passing_test' | 'benchmark' | 'superseded_adr' | 'incident_report';
  readonly ref: string;
  readonly summary?: string;
}

/** Capability standing for "may sign off a decision that is hard to reverse". */
export const ARCHITECT_CAPABILITY = 'architecture_signoff';

/** Risk tags this domain attaches. Neither means anything to the core. */
export const IRREVERSIBLE_TAG = 'irreversible';
export const WIDE_BLAST_RADIUS_TAG = 'wide_blast_radius';

/**
 * An in-memory store, standing in for whatever a real second domain would use.
 *
 * The point is that the adapter contract does not require a database — nothing
 * in `KnowledgeTargetAdapter` mentions one.
 */
export class AdrStore {
  private readonly records = new Map<string, DecisionRecord>();
  readonly applied: string[] = [];

  put(record: DecisionRecord): void {
    this.records.set(record.id, record);
  }
  get(id: string): DecisionRecord | null {
    return this.records.get(id) ?? null;
  }
  all(): DecisionRecord[] {
    return [...this.records.values()];
  }
  clear(): void {
    this.records.clear();
    this.applied.length = 0;
  }
}

/**
 * The domain's policy, written entirely from core primitives.
 *
 * Note what it does *not* need: no new requirement type, no new matcher field,
 * no change to how risk is compared. The rules are different from Kinetix's in
 * every particular and are expressible in the same vocabulary.
 */
export function adrPolicy(): PolicySet {
  return policy('architecture-decisions', 'v1')
    .rule({
      id: 'base',
      require: [noDisputingAssessments(), noOpenDisputes(), independentApprovals(1)],
    })
    .rule({
      id: 'evidence-backed',
      require: [evidenceRequirementsSatisfied()],
    })
    .rule({
      // Blast radius, not a calculation. A decision touching many systems needs
      // a second reviewer regardless of how confident the first was.
      id: 'wide-blast-radius',
      when: { riskTags: [WIDE_BLAST_RADIUS_TAG] },
      require: [independentApprovals(2)],
    })
    .rule({
      // Irreversibility is this domain's version of "high risk", and it wants a
      // named human, not more reviewers.
      id: 'irreversible',
      when: { riskTags: [IRREVERSIBLE_TAG] },
      require: [humanApproval(), approvalWithCapability(ARCHITECT_CAPABILITY)],
    })
    .build();
}

/** How many systems make a decision wide enough to need a second reviewer. */
const WIDE_BLAST_RADIUS_THRESHOLD = 3;

export function adrAdapter(
  store: AdrStore,
): KnowledgeTargetAdapter<DecisionRecord, DecisionRecord> {
  const load = (target: TargetRef) => store.get(target.id);

  return {
    space: ADR_SPACE,
    type: ADR_TARGET_TYPE,

    async loadCurrent(target) {
      const record = load(target);
      // A superseded ADR is history, not a current baseline.
      return record && record.status !== 'superseded' ? record : null;
    },

    async loadVersion(target, opts = {}) {
      const record = load(target);
      if (!record) return null;
      // This domain's visibility rule: a superseded record is not offered for
      // review, but history reads see it — the same shape as Kinetix's
      // `includeHidden`, arrived at independently.
      if (record.status === 'superseded' && !opts.includeHidden) return null;
      return {
        ref: {
          proposalId: `${ADR_TARGET_TYPE}:${record.id}`,
          versionId: `${ADR_TARGET_TYPE}:${record.id}@${record.createdAt}`,
        },
        target: { space: ADR_SPACE, type: ADR_TARGET_TYPE, id: record.id },
        payload: record,
        targetVersion: record.createdAt,
        createdAt: record.createdAt,
        authorRef: record.authorRef,
      };
    },

    async validateProposal({ proposal }): Promise<ValidationResult> {
      const issues = [];
      if (!proposal.decision?.trim()) {
        issues.push({
          code: 'decision_empty',
          message: 'A decision record must state a decision.',
          path: 'decision',
        });
      }
      if (proposal.consequences.length === 0) {
        issues.push({
          code: 'consequences_missing',
          message: 'A decision record must state at least one consequence.',
          path: 'consequences',
        });
      }
      if (proposal.status === 'superseded' && !proposal.supersedes) {
        issues.push({
          code: 'supersedes_missing',
          message: 'A superseded record must name what replaced it.',
          path: 'supersedes',
        });
      }
      return issues.length === 0 ? validationOk() : validationFailed(issues);
    },

    fingerprint({ proposal, current }) {
      return fingerprint({ proposal, current: current ?? null });
    },

    async buildReviewPacket({ version }): Promise<ReviewPacket> {
      const record = version.payload as DecisionRecord;
      const previous = record.supersedes ? store.get(record.supersedes) : null;
      return sealReviewPacket({
        version,
        proposed: {
          title: record.title,
          status: record.status,
          context: record.context,
          decision: record.decision,
          consequences: [...record.consequences],
          affects: [...record.affects],
          reversible: record.reversible,
        },
        current: previous
          ? { supersededTitle: previous.title, supersededDecision: previous.decision }
          : {},
        evidence: record.evidence.map((e) => ({
          kind: e.kind,
          id: e.ref,
          ...(e.summary ? { summary: { note: e.summary } } : {}),
        })),
        evidenceRequirements: [...requirementsFor(record)],
        context: {
          affectedSystems: record.affects.length,
          reversible: record.reversible,
        },
      });
    },

    async classifyRisk({ version }): Promise<RiskProfile> {
      const record = version.payload as DecisionRecord;
      const tags: string[] = [];
      if (!record.reversible) tags.push(IRREVERSIBLE_TAG);
      if (record.affects.length >= WIDE_BLAST_RADIUS_THRESHOLD) {
        tags.push(WIDE_BLAST_RADIUS_TAG);
      }
      // Risk here is about reversibility and reach — a different rule from
      // Kinetix's, expressed on the same three-level scale.
      const level = !record.reversible ? 'high' : tags.length > 0 ? 'medium' : 'low';
      return riskProfile(level, tags);
    },

    async evidenceRequirements({ version }): Promise<readonly EvidenceRequirement[]> {
      return requirementsFor(version.payload as DecisionRecord);
    },

    async listQueueCandidates({ olderThan }): Promise<readonly QueueCandidate[]> {
      return store
        .all()
        .filter((r) => r.status === 'proposed')
        .filter((r) => new Date(r.createdAt) < olderThan)
        .map((r) => ({
          targetType: ADR_TARGET_TYPE,
          targetId: Number(r.id.replace(/\D/g, '')) || 0,
          createdAt: r.createdAt,
          authorUserId: null,
        }));
    },

    async apply({ version }): Promise<AppliedRevisionRef> {
      const record = version.payload as DecisionRecord;
      store.put({ ...record, status: 'accepted' });
      store.applied.push(record.id);
      return {
        target: version.target,
        revisionId: record.id,
        appliedAt: record.createdAt,
      };
    },
  };
}

/**
 * The evidence this domain requires, which is not a citation in any case.
 *
 * An irreversible decision must be backed by something executable; a
 * superseding one must name what it replaces.
 */
function requirementsFor(record: DecisionRecord): EvidenceRequirement[] {
  const out: EvidenceRequirement[] = [];
  if (!record.reversible) {
    out.push({
      id: 'adr.executableEvidence',
      kind: 'passing_test',
      description:
        'An irreversible decision must be backed by a passing test or a benchmark.',
      blocking: true,
    });
  }
  if (record.supersedes) {
    out.push({
      id: 'adr.supersededRecord',
      kind: 'superseded_adr',
      description: 'A superseding decision must reference the record it replaces.',
      blocking: true,
    });
  }
  return out;
}
