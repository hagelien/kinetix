/**
 * The generic governance store contract (Phase 3 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * Phase 3's goal is *durable generic records that are not authoritative*. This
 * layer can write the whole governance history of a knowledge space, and during
 * the migration nothing in Kinetix's request path calls it: the tables exist,
 * they can be written by the shadow path, and Kinetix behaves identically
 * whether they are full or empty (§1.3).
 *
 * Every function takes its database handle as the first argument, the
 * convention the rest of `api/_lib/*Store.ts` uses. That is not decoration: a
 * caller can pass a transaction instead of the pooled handle, which is what
 * §12.3.1's `inTransaction()` will need when shadow writes have to join the
 * host's ambient transaction rather than opening their own.
 *
 * ## What is append-only, and what is a projection
 *
 * `kg_proposal_versions`, `kg_assessments`, `kg_dispute_rulings`,
 * `kg_policy_decisions`, `kg_publication_events` and `kg_audit_events` are
 * append-only: this module offers no update or delete for any of them, and that
 * absence is the enforcement. `kg_proposals.state` /
 * `kg_proposals.current_version_id` and `kg_disputes.state` are materialized
 * projections that *are* updated — cheap reads over the history, never the
 * source of truth. Where the two disagree, the history wins.
 */

import type { getDb } from '../../db.js';
import type {
  KgDisputeRulingKind,
  KgEvaluationMode,
  KgEvidenceRelation,
  KgPolicyDecisionOutcome,
  KgProposalState,
  KgPublicationAction,
  KgVerdict,
} from '../../../../db/governance-schema.js';

/**
 * A Drizzle handle, or a transaction opened from one.
 *
 * Typed as the return of `getDb()` and co-located here for the reason
 * `drugParameterStore.ts` gives: typing against the `db/index.ts` re-export
 * causes cross-file generic widening when an api caller passes its handle in.
 */
export type GovernanceDb = ReturnType<typeof getDb>;

/** The host's name for whatever a subject id points at. */
export type SubjectType =
  | 'proposal'
  | 'proposal_version'
  | 'target'
  | 'assessment'
  | 'dispute';

export interface SpaceRecord {
  readonly id: number;
  readonly slug: string;
  readonly name: string;
  readonly activePolicyVersion: string | null;
}

export interface TargetRecord {
  readonly id: number;
  readonly spaceId: number;
  readonly targetType: string;
  readonly targetKey: string;
}

export interface ProposalRecord {
  readonly id: number;
  readonly spaceId: number;
  readonly targetId: number;
  readonly authorActorRef: string;
  readonly authorKind: string;
  readonly state: KgProposalState;
  readonly currentVersionId: number | null;
  readonly legacyPendingEditId: number | null;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
}

export interface ProposalVersionRecord {
  readonly id: number;
  readonly proposalId: number;
  readonly versionNo: number;
  readonly payload: unknown;
  readonly payloadFingerprint: string;
  readonly authorActorRef: string;
  readonly actorKind: string;
  readonly riskProfile: unknown;
  readonly baseRevisionRef: string | null;
  readonly legacyReviewToken: string | null;
  readonly createdAt: Date;
  readonly submittedAt: Date | null;
}

export interface AssessmentRecord {
  readonly id: number;
  readonly spaceId: number;
  readonly subjectType: string;
  readonly subjectId: number;
  readonly actorRef: string;
  readonly actorKind: string;
  readonly verdict: KgVerdict;
  readonly rationaleMd: string | null;
  readonly capabilitySnapshot: unknown;
  readonly independenceGroup: string | null;
  readonly supersedesAssessmentId: number | null;
  readonly createdAt: Date;
}

export interface DisputeRecord {
  readonly id: number;
  readonly spaceId: number;
  readonly subjectType: string;
  readonly subjectId: number;
  readonly openedByActorRef: string;
  readonly state: string;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
}

export interface DisputeRulingRecord {
  readonly id: number;
  readonly disputeId: number;
  readonly ruling: KgDisputeRulingKind;
  readonly actorRef: string;
  readonly rationaleMd: string | null;
  readonly createdAt: Date;
}

export interface PolicyDecisionRecord {
  readonly id: number;
  readonly spaceId: number;
  readonly proposalVersionId: number;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly decision: KgPolicyDecisionOutcome;
  readonly inputFingerprint: string;
  readonly evaluationMode: KgEvaluationMode;
  readonly evaluatedAt: Date;
}

export interface PublicationEventRecord {
  readonly id: number;
  readonly proposalVersionId: number;
  readonly action: KgPublicationAction;
  readonly actorRef: string;
  readonly appliedRevisionRef: string | null;
  readonly createdAt: Date;
}

export interface AuditEventRecord {
  readonly id: number;
  readonly spaceId: number;
  readonly eventType: string;
  readonly actorRef: string | null;
  readonly subjectType: string;
  readonly subjectId: number;
  readonly payload: unknown;
  readonly createdAt: Date;
}

export interface LegacyLinkRecord {
  readonly id: number;
  readonly genericType: string;
  readonly genericId: number;
  readonly legacyType: string;
  readonly legacyId: number;
}

export interface EvidenceLinkInput {
  readonly evidenceItemId: number;
  readonly subjectType: SubjectType;
  readonly subjectId: number;
  readonly relation: KgEvidenceRelation;
  readonly quote?: string | null;
  readonly locator?: unknown;
}

/**
 * Provenance stamped on anything imported from the legacy tables rather than
 * observed natively (§6).
 *
 * The plan is emphatic that the migration must not pretend to reconstruct an
 * append-only history that no longer exists: `agent_verifications` upserts, so
 * a reviewer's earlier judgment is simply gone. Imported rows therefore say so
 * on their face, and reporting code can separate reconstructed state from
 * native history without guessing at a timestamp.
 */
export interface LegacyProvenance {
  readonly origin: 'legacy_snapshot';
  readonly capturedAt: string;
  readonly historicalCompleteness: 'current_state_only';
  readonly legacyType?: string;
  readonly legacyId?: number;
}

export function legacyProvenance(
  capturedAt: Date,
  legacy?: { type: string; id: number },
): LegacyProvenance {
  return {
    origin: 'legacy_snapshot',
    capturedAt: capturedAt.toISOString(),
    historicalCompleteness: 'current_state_only',
    ...(legacy ? { legacyType: legacy.type, legacyId: legacy.id } : {}),
  };
}

/** True for a record whose history was imported rather than observed. */
export function isLegacySnapshot(provenance: unknown): boolean {
  return (
    typeof provenance === 'object' &&
    provenance !== null &&
    (provenance as { origin?: unknown }).origin === 'legacy_snapshot'
  );
}
