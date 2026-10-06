/**
 * Compatibility projections between Kinetix's legacy governance vocabulary and
 * the generic core.
 *
 * This is the "example compatibility approach" Phase 1 of the extraction plan
 * calls for: legacy exported functions stay exported and keep their signatures,
 * and their bodies become projections onto the generic policy. Two things
 * follow, and both are the point:
 *
 *  - the generic layer is exercised by production traffic from day one, so it
 *    cannot quietly drift out of agreement with the code that matters;
 *  - rollback is reverting imports, not unpicking a rewrite.
 *
 * Behaviour is unchanged. `tests/governance/policy/kinetix-consensus-parity.test.ts`
 * pins that exhaustively against a frozen copy of the pre-Phase-1 algorithm.
 *
 * Kept free of Drizzle/HTTP so it stays unit-testable and so `src/` never
 * imports from `api/`; the legacy helpers in `api/_lib/agent-verifications.ts`
 * import *this*, which is the direction the repo already uses for
 * `src/lib/permissions.ts` and `src/lib/modelTiers.ts`.
 */

import {
  REQUIREMENT_IDS,
  poolStateFromEffectiveQuorum,
  reviewerPoolState,
  riskProfile,
} from 'assurance-core';
import type {
  AssuranceProfile,
  PolicyContext,
  PolicyDecision,
} from 'assurance-core';
import {
  KINETIX_DESIGN_TARGET_QUORUM,
  KINETIX_FLAGSHIP_CAPABILITY,
  KINETIX_POLICY,
  KINETIX_RULE_IDS,
} from './policy.js';
import {
  computeVerificationLevel,
  type VerificationLevelInfo,
} from '../verificationLevel.js';

/** The one space Kinetix runs. */
export const KINETIX_SPACE = 'kinetix';

/**
 * Structural copy of `VerificationSummary` from `api/_lib/agent-verifications.ts`.
 *
 * Redeclared rather than imported because `src/` must not depend on `api/`.
 * The shapes are checked against each other at the call site: the legacy helper
 * passes its own `VerificationSummary` straight into these functions, so a
 * field added there and not here is a compile error, not a silent divergence.
 */
export interface LegacyVerificationSummary {
  approveCount: number;
  disputeCount: number;
  abstainCount: number;
  implicitApproveCount: number;
  /** May be absent on a hand-built summary; treated as 0, which never satisfies the flagship gate. */
  approveTier2Count?: number;
}

/** Structural copy of `ConsensusHoldReason` from `api/_lib/agent-verifications.ts`. */
export type LegacyConsensusHoldReason =
  | 'quorum_unmet'
  | 'high_risk_degraded_quorum'
  | 'high_risk_missing_flagship';

/**
 * Turn a legacy verdict tally into a generic assurance profile.
 *
 * Two mappings deserve their reasons stated:
 *
 * **`independentApprovers === approveCount`.** The generic tally can subtract
 * the author from the approver count when told who the author is. Here it is
 * not told, because Kinetix's admission rules have already done that job
 * upstream: an author's own explicit verdict can exist only under an admin's
 * `agents.self_review_enabled` grant, and that same grant enlarges the reviewer
 * pool (raising the quorum rather than lowering it). Every explicit approve row
 * that reaches this function is therefore one the gate is entitled to count.
 *
 * **`disputesOpen === 0`.** The legacy `consensusApprovalHoldReason` knows only
 * about agent dispute *verdicts*; human disputes live in a separate table and
 * are checked by its caller. Modelling them as zero here is what keeps the
 * projection exactly equivalent — the human-dispute check has not moved.
 */
export function assuranceFromLegacySummary(
  summary: LegacyVerificationSummary,
): AssuranceProfile {
  const flagshipApproval = (summary.approveTier2Count ?? 0) >= 1;
  return {
    explicitApprovals: summary.approveCount,
    independentApprovers: summary.approveCount,
    // agent_verifications only ever holds agent rows.
    humanApprovals: 0,
    agentApprovals: summary.approveCount,
    approvalCapabilities: flagshipApproval ? [KINETIX_FLAGSHIP_CAPABILITY] : [],
    humanApprovalCapabilities: [],
    disputingAssessors: summary.disputeCount,
    disputesOpen: 0,
    abstentions: summary.abstainCount,
    implicitApprovals: summary.implicitApproveCount,
    evidenceRequirementState: [],
  };
}

/**
 * Build the policy context the legacy consensus gate implies.
 *
 * `authorKind` is `'agent'` unconditionally. The tally this stands in for
 * (`consensusApprovalHoldReason`) never considered authorship, and since
 * `kinetix-consensus@v2` no rule but `unattributed` does either — and an
 * unattributed proposal is refused before any tally is computed.
 */
export function projectLegacyConsensusContext(args: {
  summary: LegacyVerificationSummary;
  quorum: number;
  highRisk: boolean;
  /** The pending edit's id, when the caller has it. Audit correlation only. */
  proposalVersionId?: string;
}): PolicyContext {
  return {
    space: KINETIX_SPACE,
    targetType: 'pending_edit',
    proposalVersionId: args.proposalVersionId ?? '',
    author: {
      actorRef: '',
      kind: 'agent',
      capabilities: [],
      assuranceCapabilities: [],
    },
    risk: riskProfile(args.highRisk ? 'high' : 'low'),
    assurance: assuranceFromLegacySummary(args.summary),
    pool: poolStateFromEffectiveQuorum({
      effectiveQuorum: args.quorum,
      designTargetQuorum: KINETIX_DESIGN_TARGET_QUORUM,
    }),
    flags: [],
  };
}

/**
 * Collapse a policy decision back onto the legacy three-valued hold reason.
 *
 * The generic layer distinguishes more cases than the legacy string does — an
 * unmet quorum and a standing dispute are separate requirements there, and both
 * collapse to `quorum_unmet` here. That is a loss of resolution in the *legacy*
 * vocabulary, not in the decision: `PolicyDecision.unmet` still carries every
 * reason with its own id, so a caller that wants the finer answer can read it
 * without this function's help.
 */
export function consensusHoldReasonFromDecision(
  decision: PolicyDecision,
): LegacyConsensusHoldReason | null {
  const first = decision.unmet[0];
  if (!first) return null;
  if (first.ruleId === KINETIX_RULE_IDS.highRisk) {
    return first.requirementId === REQUIREMENT_IDS.approvalWithCapability
      ? 'high_risk_missing_flagship'
      : 'high_risk_degraded_quorum';
  }
  return 'quorum_unmet';
}

/**
 * The same first-unmet-requirement projection as
 * {@link consensusHoldReasonFromDecision}, but for `kinetix-consensus-apply`
 * (the whole `applyOnAgentConsensus` gate) rather than the base-quorum-only
 * `kinetix-consensus` policy. That policy's extra rules — a human author, a
 * missing source quote, a clinical case, an open dispute — each need their own
 * word instead of collapsing into `quorum_unmet`, so a maintainer reading
 * `POST /api/agent-consensus-sweep`'s response can tell a held edit needing a
 * flagship approval from one that can never clear the generic gate at all
 * (issue #1375).
 */
export type GenericConsensusHoldReason =
  | 'quorum_unmet'
  | 'open_dispute'
  | 'upheld_dispute'
  | 'returned_unrevised'
  | 'target_unpublished'
  | 'human_submitted'
  | 'high_risk_missing_flagship'
  | 'high_risk_degraded_quorum'
  | 'source_quote_missing'
  | 'clinical_case';

/**
 * Why the generic policy's `noOpenDisputes` requirement is unmet. That
 * requirement is one boolean fact (`ConsensusFacts.hasOpenHumanDispute`) that
 * folds four legacy conditions together, so the decision alone cannot say which
 * one held the edit. The facts collector names the first that applies, in the
 * legacy gate's own order, and {@link genericConsensusHoldReason} reports it
 * instead of calling every one of them an `open_dispute` (issue 1404).
 */
export type ConsensusDisputeHoldCause =
  | 'open_dispute'
  | 'upheld_dispute'
  | 'returned_unrevised'
  | 'target_unpublished';

export function genericConsensusHoldReason(
  decision: PolicyDecision,
  disputeHoldCause?: ConsensusDisputeHoldCause | null,
): GenericConsensusHoldReason {
  const unmet = decision.unmet;
  const has = (ruleId: string) => unmet.some((u) => u.ruleId === ruleId);

  // Priority follows `runAgentConsensus`'s real end-to-end check order, not
  // this policy's rule-declaration order — the two disagree whenever more
  // than one rule is unmet at once, and declaration order then picks
  // whichever rule merely happened to be declared first.
  //
  // The source-quote gate (`highRiskProposalWouldPublishUnquoted`) runs before
  // the generic engine is even consulted, so it outranks everything below.
  // `legacyConsensusHold` then refuses a clinical case, then a human author,
  // before it ever computes a tally.
  //
  // The tally itself (`consensusApprovalHoldReason`/`frozenHoldReason`) checks
  // the pool-adjusted base quorum FIRST — `disputeCount === 0 && approveCount
  // >= quorum` — and only inspects the high-risk-specific requirements (the
  // fixed design-target quorum, a flagship approval) once that base condition
  // already holds. A high-risk edit with, say, zero approvals is short of the
  // *pool-adjusted* quorum too, and reports the ordinary `quorum_unmet`, not a
  // high-risk reason: "degraded" describes an edit that cleared a relaxed bar
  // with too few approvals, not one that never cleared any bar at all. So the
  // base rule's quorum-ish requirements outrank `highRisk`, which in turn
  // outranks `noOpenDisputes` (the whole tally, high-risk included, is checked
  // and returned before `hasOpenDispute` ever runs).
  //
  // Getting this wrong sends an operator toward a remedy (more approvals,
  // resolving a dispute) that can never actually clear the edit.
  if (has(KINETIX_RULE_IDS.unquoted)) return 'source_quote_missing';
  if (has(KINETIX_RULE_IDS.clinicalCase)) return 'clinical_case';
  // `human_submitted` is the legacy name for "needs a person because of who
  // wrote it"; since v2 that is only a proposal with no recorded author.
  if (has(KINETIX_RULE_IDS.unattributed) || has(KINETIX_RULE_IDS.humanAuthored)) {
    return 'human_submitted';
  }
  // `legacyConsensusHold` checks `pendingEditTargetOpenToAgents` right after the
  // human-author refusal and before it computes any tally, so an unpublished
  // page outranks a short quorum or a missing flagship approval.
  if (disputeHoldCause === 'target_unpublished') return 'target_unpublished';
  if (
    unmet.some(
      (u) =>
        u.requirementId === REQUIREMENT_IDS.independentApprovalsFromPool ||
        u.requirementId === REQUIREMENT_IDS.noDisputingAssessments,
    )
  ) {
    return 'quorum_unmet';
  }

  const highRisk = unmet.find((u) => u.ruleId === KINETIX_RULE_IDS.highRisk);
  if (highRisk) {
    return highRisk.requirementId === REQUIREMENT_IDS.approvalWithCapability
      ? 'high_risk_missing_flagship'
      : 'high_risk_degraded_quorum';
  }
  if (unmet.some((u) => u.requirementId === REQUIREMENT_IDS.noOpenDisputes)) {
    return disputeHoldCause ?? 'open_dispute';
  }
  return 'quorum_unmet';
}

/**
 * Drop-in replacement for the legacy `consensusApprovalHoldReason`. Returns the
 * hold reason, or `null` when the proposal clears the gate.
 */
export function governanceConsensusHoldReason(
  summary: LegacyVerificationSummary,
  quorum: number,
  opts: { highRisk: boolean; proposalVersionId?: string },
): LegacyConsensusHoldReason | null {
  const decision = KINETIX_POLICY.evaluate(
    projectLegacyConsensusContext({
      summary,
      quorum,
      highRisk: opts.highRisk,
      proposalVersionId: opts.proposalVersionId,
    }),
  );
  return consensusHoldReasonFromDecision(decision);
}

/**
 * Drop-in replacement for the legacy `effectiveConsensusQuorum`: the quorum the
 * active-agent pool can actually satisfy.
 *
 * `authorSelfReviews` adds the author to the eligible pool rather than lowering
 * the bar — with two active agents and the grant on, the quorum goes *up* from
 * 1 to 2. Only a lone active agent can carry its own proposal alone, and that
 * still reports as degraded.
 */
export function governanceEffectiveConsensusQuorum(
  activeAgentCount: number,
  opts: { authorSelfReviews?: boolean } = {},
): number {
  return reviewerPoolState({
    poolSize: activeAgentCount,
    designTargetQuorum: KINETIX_DESIGN_TARGET_QUORUM,
    authorIsEligibleVerifier: opts.authorSelfReviews ?? false,
  }).effectiveQuorum;
}

/**
 * Project a generic assurance profile onto Kinetix's 0–3 verification level
 * plus its orthogonal disputed flag (§7.3 of the extraction plan).
 *
 * The core deliberately has no universal score; this is the host deciding how
 * to summarise the profile for its own UI, and it is a projection *out of* the
 * generic state, not a second source of truth. `computeVerificationLevel` stays
 * the one place the 0–3 thresholds live.
 *
 * `implicitApprovals` counts toward the agent tally because in Kinetix the
 * submit-time stake is itself an agent's endorsement of its own work — level 1
 * means "its author only", not "nobody".
 */
export function projectKinetixVerificationLevel(
  profile: AssuranceProfile,
  opts: { authorSelfVerified?: boolean } = {},
): VerificationLevelInfo {
  return {
    level: computeVerificationLevel({
      agentApprovers: profile.agentApprovals + profile.implicitApprovals,
      hasHumanApprover: profile.humanApprovals >= 1,
      authorSelfVerified: opts.authorSelfVerified ?? false,
    }),
    // Disputes never lower the level; they are surfaced beside it, so a
    // contested value shows both how much review it has and that it is
    // contested.
    disputed: profile.disputingAssessors > 0,
  };
}
