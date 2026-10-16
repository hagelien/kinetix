/**
 * The T3 case detector, as a pure classifier over stored rows
 * (docs/plans/2026-09-18-t3-adjudication-backend.md §3.3,
 * agents/drug-db-adjudication.md §2).
 *
 * A case opens only on a signal the schema records — never on an agent's word
 * that something is hard — and only once blind T2 has spoken: a target with no
 * explicit flagship-tier verdict is not a T3 case, whatever else is true of it
 * (a T1 dispute alone routes to T2 first, contract §2).
 *
 * All five contract triggers are classified here, each from a persisted input:
 *
 *   t1_t2_disagreement       a live lower-tier dispute verdict, and a flagship
 *                            approval of the same target. A dispute its author
 *                            withdrew in the control phase is stored as
 *                            `abstain` (verdict-reconsideration.ts), so it is
 *                            not live; a maintained one stays `dispute`.
 *   competing_scope          an explicit flagship verdict carrying
 *                            `agent_verifications.competing_scope`: blind T2
 *                            found the disagreement turns on materially
 *                            different scope (migration 0156).
 *   flagship_disagreement    two flagship verdicts, one approving and one
 *                            disputing.
 *   repeated_correction_loop at least REPEATED_CORRECTION_LOOP_MIN decided
 *                            disputes (upheld or rejected) on the target and a
 *                            disagreement still live. Counted from `disputes`,
 *                            which keeps resolved rows per target across
 *                            revisions but not every return — so the count is
 *                            a LOWER BOUND and is recorded as one.
 *   human_request            a person's `adjudication_requests` row on the
 *                            version (migration 0156). Like every trigger it
 *                            waits for T2: a request made earlier opens the
 *                            case when the flagship verdict lands. The person
 *                            keeps the final authority, so the seal always
 *                            hands such a case to a person (./opinions.ts).
 */

import type {
  AdjudicationDisputeOrigin,
  AdjudicationDisputeSnapshot,
  AdjudicationTrigger,
  AdjudicationVerdictSnapshot,
  AgentVerificationEvidenceRef,
} from '../../../db/schema.js';
import { FLAGSHIP_TIER } from '../../../src/lib/modelTiers.js';

/** Contract §2 item 4: "at least two correction/return/dispute cycles". */
export const REPEATED_CORRECTION_LOOP_MIN = 2;

export interface DetectorVerdict {
  id: number;
  agentId: number;
  verdict: string;
  rationaleMd: string;
  evidenceRefs: AgentVerificationEvidenceRef[];
  /** The effective server-owned tier (agent_verifications.verifier_tier). */
  verifierTier: string | null;
  model: string | null;
  isImplicit: boolean;
  /** agent_verifications.competing_scope (T3 trigger 2). */
  competingScope: boolean;
  recordedAt: Date;
}

export interface DetectorDispute {
  id: number;
  source: string;
  createdBy: number;
  reasonMd: string;
  evidenceRefs: unknown;
  createdAt: Date;
}

/** A person's request for an agent adjudication of this version (T3 trigger 5). */
export interface DetectorHumanRequest {
  id: number;
  requestedBy: number;
  createdAt: Date;
}

export interface DetectorInput {
  verdicts: readonly DetectorVerdict[];
  openDisputes: readonly DetectorDispute[];
  /** Disputes on the target decided upheld or rejected (withdrawn ones excluded). */
  decidedDisputeCount: number;
  /** Requests bound to the version being classified; none when omitted. */
  humanRequests?: readonly DetectorHumanRequest[];
}

export interface DetectorResult {
  triggers: AdjudicationTrigger[];
  triggerDetail: Record<string, unknown>;
  disputeOrigin: AdjudicationDisputeOrigin;
  t2VerificationId: number;
  t2Snapshot: AdjudicationVerdictSnapshot[];
  t1Snapshot: {
    verdicts: AdjudicationVerdictSnapshot[];
    openDisputes: AdjudicationDisputeSnapshot[];
  };
}

function snapshotVerdict(v: DetectorVerdict): AdjudicationVerdictSnapshot {
  return {
    verificationId: v.id,
    agentId: v.agentId,
    verdict: v.verdict,
    rationaleMd: v.rationaleMd,
    evidenceRefs: v.evidenceRefs,
    verifierTier: v.verifierTier,
    model: v.model,
    recordedAt: v.recordedAt.toISOString(),
  };
}

function snapshotDispute(d: DetectorDispute): AdjudicationDisputeSnapshot {
  return {
    disputeId: d.id,
    source: d.source,
    createdBy: d.createdBy,
    reasonMd: d.reasonMd,
    evidenceRefs: d.evidenceRefs,
    createdAt: d.createdAt.toISOString(),
  };
}

/**
 * Who raised the open disputes the case rests on. A case with none open rests
 * on verdicts alone, which only agents cast, so it is `agent`. Any person's
 * dispute makes it `human` or `mixed`, and T3 then only prepares the record:
 * the closing act stays with a person (contract §1, §7).
 */
export function disputeOriginOf(
  openDisputes: readonly { source: string }[],
): AdjudicationDisputeOrigin {
  const human = openDisputes.some((d) => d.source !== 'agent');
  const agent = openDisputes.some((d) => d.source === 'agent');
  if (human && agent) return 'mixed';
  return human ? 'human' : 'agent';
}

/** Null when the target is not (yet) a T3 case. */
export function classifyAdjudicationCase(input: DetectorInput): DetectorResult | null {
  const explicit = input.verdicts.filter((v) => !v.isImplicit);
  const flagship = explicit.filter((v) => v.verifierTier === FLAGSHIP_TIER);
  // T2 has not spoken: not a T3 case, whatever the lower tiers say.
  if (flagship.length === 0) return null;
  const lower = explicit.filter((v) => v.verifierTier !== FLAGSHIP_TIER);

  const flagshipApproves = flagship.filter((v) => v.verdict === 'approve');
  const flagshipDisputes = flagship.filter((v) => v.verdict === 'dispute');
  const lowerDisputes = lower.filter((v) => v.verdict === 'dispute');

  const triggers: AdjudicationTrigger[] = [];
  const triggerDetail: Record<string, unknown> = {};
  if (flagshipApproves.length > 0 && lowerDisputes.length > 0) {
    triggers.push('t1_t2_disagreement');
  }
  const competingScope = flagship.filter((v) => v.competingScope);
  if (competingScope.length > 0) {
    triggers.push('competing_scope');
    triggerDetail.competing_scope = {
      verificationIds: competingScope.map((v) => v.id),
    };
  }
  if (flagshipApproves.length > 0 && flagshipDisputes.length > 0) {
    triggers.push('flagship_disagreement');
  }
  const liveDisagreement =
    lowerDisputes.length > 0 ||
    flagshipDisputes.length > 0 ||
    input.openDisputes.length > 0;
  if (
    input.decidedDisputeCount >= REPEATED_CORRECTION_LOOP_MIN &&
    liveDisagreement
  ) {
    triggers.push('repeated_correction_loop');
    triggerDetail.repeated_correction_loop = {
      decidedDisputes: input.decidedDisputeCount,
      lowerBound: true,
    };
  }
  const humanRequests = input.humanRequests ?? [];
  if (humanRequests.length > 0) {
    triggers.push('human_request');
    triggerDetail.human_request = {
      requestIds: humanRequests.map((r) => r.id),
      requestedBy: [...new Set(humanRequests.map((r) => r.requestedBy))],
    };
  }
  if (triggers.length === 0) return null;

  // The T2 verdict the case is traced to: the approval the disagreement is
  // with, when there is one.
  const t2 = flagshipApproves[0] ?? flagship[0]!;
  return {
    triggers,
    triggerDetail,
    disputeOrigin: disputeOriginOf(input.openDisputes),
    t2VerificationId: t2.id,
    t2Snapshot: flagship.map(snapshotVerdict),
    t1Snapshot: {
      verdicts: lower.map(snapshotVerdict),
      openDisputes: input.openDisputes.map(snapshotDispute),
    },
  };
}
