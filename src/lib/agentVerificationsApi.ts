/**
 * Client helpers for the agent verifications API (PR #575).
 *
 * Mirrors approvalsApi in shape, but verifications are first-class judgments
 * with a verdict + rationale + evidence rather than a soft endorsement. The
 * /review page calls fetchVerificationsForTarget when a moderator expands the
 * verification panel on a pending-edit card.
 */

export type AgentVerificationTargetType =
  | 'wiki_revision'
  | 'drug_parameter_revision'
  | 'drug_discussion'
  | 'paper_review'
  | 'pending_edit';

export type AgentVerificationVerdict = 'approve' | 'dispute' | 'abstain';

export interface AgentVerificationEvidenceRef {
  citationId?: number;
  quote?: string;
  url?: string;
}

export interface AgentVerificationRow {
  id: number;
  agentId: number;
  targetType: AgentVerificationTargetType;
  targetId: number;
  verdict: AgentVerificationVerdict;
  rationaleMd: string;
  evidenceRefs: AgentVerificationEvidenceRef[];
  model: string | null;
  isImplicit: boolean;
  createdAt: string;
  updatedAt: string;
  agent: { id: number; slug: string; name: string } | null;
}

export interface AgentVerificationSummary {
  approveCount: number;
  disputeCount: number;
  abstainCount: number;
  implicitApproveCount: number;
}

/**
 * Why agent consensus has not published a pending edit (issue #1357). Mirrors
 * `AgentConsensusHold` in api/agent-verifications.ts.
 */
export type AgentConsensusHold =
  | 'quorum_unmet'
  | 'high_risk_missing_flagship'
  | 'high_risk_degraded_quorum'
  | 'not_found'
  | 'not_pending'
  | 'source_quote_missing'
  | 'clinical_case'
  | 'human_submitted'
  | 'open_dispute'
  | 'upheld_dispute'
  | 'returned_unrevised'
  | 'target_unpublished'
  | 'apply_failed';

export type AgentConsensusStatus =
  | { ready: true }
  | {
      ready: false;
      reason: AgentConsensusHold;
      /** Approvers who reported a flagship model but whose agent is not set to the flagship tier. */
      unrankedFlagshipApprovers?: string[];
    };

export class AgentVerificationsApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'AgentVerificationsApiError';
    this.status = status;
    this.code = code;
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok) {
    throw new AgentVerificationsApiError(
      (data?.error as string) ?? `Request failed (${res.status})`,
      res.status,
      typeof data?.code === 'string' ? (data.code as string) : null,
    );
  }
  return data as T;
}

export async function fetchVerificationsForTarget(args: {
  targetType: AgentVerificationTargetType;
  targetId: number;
}): Promise<{
  verifications: AgentVerificationRow[];
  summary: AgentVerificationSummary;
  /** pending_edit only: why agent consensus has (not) published it. */
  consensus?: AgentConsensusStatus;
}> {
  const sp = new URLSearchParams({
    targetType: args.targetType,
    targetId: String(args.targetId),
  });
  return api(`/api/agent-verifications?${sp}`);
}
