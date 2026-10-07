/**
 * Shadow policy evaluation (Phase 6 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * Phase 6's goal is to prove the new policy engine reaches the same
 * publication decision as the current code. Nothing here decides anything: the
 * decision is evaluated in `shadow` mode, persisted to `kg_policy_decisions`,
 * and compared. `applyOnAgentConsensus` remains the only thing that publishes.
 *
 * ## What is being compared, and why it is not circular
 *
 * Phase 1 made `consensusApprovalHoldReason` delegate to the generic policy, so
 * comparing that helper against the engine would compare the engine to itself.
 * Phase 6 compares something wider and genuinely independent: the whole
 * `applyOnAgentConsensus` gate. That gate refuses a clinical case before any
 * counting happens, refuses a proposal with no recorded author whatever the
 * count, holds a fact citing a paper nobody has read in full, and blocks on
 * human disputes that live in a table the tally never reads. Most of its
 * checks are outside the delegated function entirely.
 *
 * The legacy side of the comparison is a **frozen pure reference** of that gate
 * (in the parity test, deliberately not imported), for the same reason Phase 1
 * froze one: a reference that changes when production changes cannot detect
 * that production changed.
 *
 * ## Divergence severity
 *
 * Per the plan: a generic decision **more permissive** than legacy is severity 1
 * and blocks cutover — it means the engine would publish something Kinetix
 * holds. More conservative is survivable but must be explained, because it
 * creates review backlog.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../db.js';
import { pendingEdits } from '../../../db/schema.js';
import {
  countActiveVerifierAgents,
  effectiveConsensusQuorum,
  isHighRiskPendingEdit,
  pendingEditTargetOpenToAgents,
  pendingEditCitesUnreadSources,
  type SourceCheckedPendingEdit,
  isSelfReviewAgentUser,
  summariseVerificationsForTargets,
  type VerificationSummary,
} from '../agent-verifications.js';
import { hasOpenDispute, pendingEditUpheldRulingStands } from '../disputes.js';
import { returnStandsUnrevised } from '../pending-edit-review-token.js';
import { isActiveAgentSubmitter } from './actor-context.js';
import {
  assuranceFromLegacySummary,
  KINETIX_SPACE,
  type ConsensusDisputeHoldCause,
} from '../../../src/lib/assurance/projection.js';
import {
  KINETIX_APPLY_POLICY,
  KINETIX_CLINICAL_CASE_TAG,
  KINETIX_UNQUOTED_TAG,
  KINETIX_DESIGN_TARGET_QUORUM,
} from '../../../src/lib/assurance/policy.js';
import {
  describeDecision,
  poolStateFromEffectiveQuorum,
  riskProfile,
  snapshotActor,
  type PolicyContext,
  type PolicyDecision,
} from 'assurance-core';
import { highRiskProposalWouldPublishUnquoted } from '../source-quote-gate.js';
import { ensureKinetixSpace } from './backfill.js';
import { recordCoreDecision } from './store/decisions.js';
import { findByLegacy } from './store/legacy-links.js';
import { latestVersion } from './store/versions.js';
import type { GovernanceDb } from './store/interface.js';

/** Everything the gate reasons about, gathered once. */
export interface ConsensusFacts {
  readonly pendingEditId: number;
  readonly editType: string;
  readonly parameter: string | null;
  readonly submittedBy: number | null;
  /** True when the submitter is an active registered agent. */
  readonly submitterIsAgent: boolean;
  readonly summary: VerificationSummary;
  readonly activeAgents: number;
  readonly authorSelfReviews: boolean;
  readonly quorum: number;
  readonly highRisk: boolean;
  /**
   * True when this edit would put a calculation-driving value on the record
   * with no verbatim source quote behind it — the precondition the legacy gate
   * applies (`highRiskProposalWouldPublishUnquoted`). For an entry update that
   * is a question for the write, not for the payload.
   *
   * It has to be a gathered FACT rather than something the gate checks on the
   * side, because the dossier re-derives the legacy outcome from these facts to
   * decide whether the generic engine may take over. A precondition the facts
   * do not carry is a precondition the comparison cannot see, and the dossier
   * would report agreement on exactly the edits where the engine is looser.
   */
  readonly lacksSourceQuote: boolean;
  readonly hasOpenHumanDispute: boolean;
  /**
   * Which of the four conditions behind `hasOpenHumanDispute` applies, first
   * match in the legacy gate's order. Diagnostic only — the hold decision reads
   * the boolean. Unset on facts built without it, which then report a generic
   * `open_dispute`.
   */
  readonly disputeHoldCause?: ConsensusDisputeHoldCause | null;
}

/**
 * Gather the live facts for one pending edit.
 *
 * Reads exactly the same sources `applyOnAgentConsensus` reads, in the same
 * way, so a divergence in the comparison is a difference in *reasoning* rather
 * than a difference in what the two sides were looking at.
 */
export async function collectConsensusFacts(
  pendingEditId: number,
): Promise<ConsensusFacts | null> {
  const db = getDb();
  const [pending] = await db
    .select({
      editType: pendingEdits.editType,
      submittedBy: pendingEdits.submittedBy,
      parameter: pendingEdits.parameter,
      targetId: pendingEdits.targetId,
      proposedValue: pendingEdits.proposedValue,
      proposedMeta: pendingEdits.proposedMeta,
      referenceIds: pendingEdits.referenceIds,
      referenceId: pendingEdits.referenceId,
    })
    .from(pendingEdits)
    .where(eq(pendingEdits.id, pendingEditId))
    .limit(1);
  if (!pending) return null;

  const submitterIsAgent =
    pending.submittedBy !== null &&
    (await isActiveAgentSubmitter(db, pending.submittedBy));

  const authorSelfReviews =
    pending.submittedBy !== null
      ? await isSelfReviewAgentUser(pending.submittedBy)
      : false;

  // Same tally the legacy gate uses (`legacyConsensusHold`): an author without
  // the self-review grant is not a verifier, so its own verdicts are left out.
  // Counting them would let a self-approval cast under a since-revoked grant
  // fill the quorum that revoking the grant just lowered (issue #1357).
  const summary =
    (
      await summariseVerificationsForTargets({
        targetType: 'pending_edit',
        targetIds: [pendingEditId],
        excludeAgentUserId:
          pending.submittedBy !== null && !authorSelfReviews
            ? pending.submittedBy
            : undefined,
        onlyActiveVerifiers: true,
        // As the legacy gate: an overruled objection no longer holds.
        excludeAnsweredDisputes: true,
      })
    ).get(pendingEditId) ?? null;

  const activeAgents = await countActiveVerifierAgents();

  // An upheld ruling that still stands against this payload holds the edit
  // exactly as an open dispute does — the legacy gate refuses it too
  // (`legacyConsensusHold`), and a bare resubmit keeps the old approvals, so
  // without this the generic engine would publish what the ruling rejected.
  // So does a wiki edit whose page is no longer published (out of the agents'
  // reach) and a reviewer's comment-only return the author has not yet answered
  // with a revision. Each keeps its own name, checked in the legacy order.
  const disputeHoldCause = await collectDisputeHoldCause(pending, pendingEditId);

  return {
    pendingEditId,
    editType: pending.editType,
    parameter: pending.parameter,
    submittedBy: pending.submittedBy,
    submitterIsAgent,
    summary: summary ?? {
      approveCount: 0,
      disputeCount: 0,
      abstainCount: 0,
      implicitApproveCount: 0,
      approveTier2Count: 0,
    },
    activeAgents,
    authorSelfReviews,
    // A person is not in the agent pool, so every active agent is eligible to
    // verify their proposal: the arithmetic of an author whose seat counts.
    quorum: effectiveConsensusQuorum(activeAgents, {
      authorSelfReviews: authorSelfReviews || !submitterIsAgent,
    }),
    highRisk: isHighRiskPendingEdit({
      editType: pending.editType,
      parameter: pending.parameter,
    }),
    // The LIVE gate's own predicate, called rather than reproduced. An entry
    // update's effective quote is decided by the write — it may inherit one the
    // payload omits, or lose one the payload echoes — and this fact feeds BOTH
    // the generic policy and the dossier's reconstruction of the legacy
    // outcome. A cheaper local approximation would make the two agree on a
    // value neither engine actually produces, and false parity is the one thing
    // the dossier must never report.
    lacksSourceQuote: await highRiskProposalWouldPublishUnquoted(pending),
    hasOpenHumanDispute: disputeHoldCause !== null,
    disputeHoldCause,
  };
}

/**
 * Project the gathered facts into the normalized `PolicyContext` (§7.2).
 *
 * Two mappings carry the weight:
 *
 *  - **`authorKind`** is `agent` only when the submitter is an *active*
 *    registered agent; a person's proposal (or one by an agent whose status was
 *    revoked) is `human`, and publishes on agent consensus under the same bar.
 *    A proposal with no recorded author is `system`, and the `unattributed`
 *    rule requires a human approval for it, as the legacy gate does.
 *  - **`clinical_case`** is a risk tag rather than a special case. Legacy
 *    refuses it in the first three lines of the function; here the risk profile
 *    carries the tag, the `clinical-case` rule matches on it, and the
 *    requirement it imposes — a human approval from someone with clinical
 *    standing — is one Kinetix has no way to satisfy through agent consensus.
 *    Same refusal, stated as the reason for it.
 */
export function projectConsensusContext(facts: ConsensusFacts): PolicyContext {
  const tags: string[] = [];
  if (facts.highRisk) tags.push('calculation_driving');
  // Same move as `clinical_case` below: a precondition the legacy gate applies
  // as an early return becomes a risk tag here, so the generic policy can state
  // the requirement rather than the engine having to special-case it. See the
  // `unquoted-calculation-driving` rule for what it then requires.
  if (facts.lacksSourceQuote) tags.push(KINETIX_UNQUOTED_TAG);
  if (facts.editType === 'clinical_case') tags.push(KINETIX_CLINICAL_CASE_TAG);

  const assurance = assuranceFromLegacySummary(facts.summary);
  return {
    space: KINETIX_SPACE,
    targetType: 'pending_edit',
    proposalVersionId: `pending_edit:${facts.pendingEditId}`,
    author: snapshotActor({
      actorRef:
        facts.submittedBy === null ? 'unknown' : `user:${facts.submittedBy}`,
      // `system` for a proposal with no recorded author: the `unattributed`
      // rule's subject, the one authorship that still needs a person.
      kind:
        facts.submittedBy === null
          ? 'system'
          : facts.submitterIsAgent
            ? 'agent'
            : 'human',
      capabilities: [],
    }),
    risk: riskProfile(facts.highRisk ? 'high' : 'medium', tags),
    assurance: {
      ...assurance,
      // The one fact `assuranceFromLegacySummary` cannot know: human disputes
      // live in the unified disputes table, which the agent tally never reads.
      // Phase 1's projection hardcodes 0 here because the function it feeds had
      // never heard of them; the whole gate has, so the whole gate says so.
      disputesOpen: facts.hasOpenHumanDispute ? 1 : 0,
    },
    pool: poolStateFromEffectiveQuorum({
      effectiveQuorum: facts.quorum,
      designTargetQuorum: KINETIX_DESIGN_TARGET_QUORUM,
    }),
    flags: [],
  };
}

export type ShadowOutcome = 'apply' | 'hold';

export interface ShadowEvaluation {
  readonly outcome: ShadowOutcome;
  readonly decision: PolicyDecision;
  readonly context: PolicyContext;
  readonly facts: ConsensusFacts;
  /** Unmet requirement ids, in evaluation order. */
  readonly reasons: readonly string[];
}

/** Evaluate the whole gate generically for one pending edit. */
export function evaluateShadowPolicy(facts: ConsensusFacts): ShadowEvaluation {
  const context = projectConsensusContext(facts);
  const decision = KINETIX_APPLY_POLICY.evaluate(context);
  return {
    outcome: decision.allowed ? 'apply' : 'hold',
    decision,
    context,
    facts,
    reasons: decision.unmet.map((o) => o.requirementId),
  };
}

export type DivergenceSeverity = 'none' | 'severity_1' | 'conservative';

export interface PolicyDivergence {
  readonly severity: DivergenceSeverity;
  readonly legacyOutcome: ShadowOutcome;
  readonly genericOutcome: ShadowOutcome;
  readonly reasons: readonly string[];
  readonly explanation: string;
}

/**
 * Classify a generic decision against the legacy one.
 *
 * The asymmetry is the whole point and comes straight from the plan: generic
 * publishing something legacy holds is severity 1 and blocks cutover, because
 * it means the migration would loosen a gate. Generic holding something legacy
 * publishes is survivable — nothing gets published that should not — but it
 * creates review backlog and so has to be explained rather than tolerated
 * silently.
 */
export function classifyDivergence(args: {
  legacyOutcome: ShadowOutcome;
  evaluation: ShadowEvaluation;
}): PolicyDivergence {
  const { legacyOutcome, evaluation } = args;
  const genericOutcome = evaluation.outcome;
  const reasons = evaluation.reasons;

  if (legacyOutcome === genericOutcome) {
    return {
      severity: 'none',
      legacyOutcome,
      genericOutcome,
      reasons,
      explanation: describeDecision(evaluation.decision),
    };
  }
  if (genericOutcome === 'apply') {
    return {
      severity: 'severity_1',
      legacyOutcome,
      genericOutcome,
      reasons,
      explanation:
        'the generic policy would publish a proposal the legacy gate holds; ' +
        'this blocks cutover (§1.7: the engine may tighten Kinetix, never relax it)',
    };
  }
  return {
    severity: 'conservative',
    legacyOutcome,
    genericOutcome,
    reasons,
    explanation:
      `the generic policy holds (${reasons.join(', ') || 'no reason recorded'}) ` +
      'where the legacy gate applies; safe, but it creates review backlog and ' +
      'must be explained before cutover',
  };
}

/**
 * Evaluate and persist a shadow decision for one pending edit.
 *
 * Recorded against the mirrored proposal version, so the decision names the
 * exact payload it was made about (§7.4). When no version has been mirrored —
 * the target type is still `legacy_only`, or the mirror was lost — nothing is
 * written: a decision record pointing at no version explains nothing, and
 * inventing a version to hang it on would be worse.
 *
 * Always `shadow` mode. This function has no parameter for anything else; a
 * later phase that wants an advisory or authoritative decision will say so
 * where that decision is actually acted on.
 */
export async function recordShadowDecision(
  db: GovernanceDb,
  pendingEditId: number,
): Promise<{ evaluation: ShadowEvaluation; recorded: boolean } | null> {
  const facts = await collectConsensusFacts(pendingEditId);
  if (!facts) return null;
  const evaluation = evaluateShadowPolicy(facts);

  const link = await findByLegacy(db, 'pending_edit', pendingEditId);
  if (!link) return { evaluation, recorded: false };
  const version = await latestVersion(db, link.genericId);
  if (!version) return { evaluation, recorded: false };

  const space = await ensureKinetixSpace(db);
  await recordCoreDecision(db, {
    spaceId: space.id,
    proposalVersionId: version.id,
    decision: evaluation.decision,
    evaluationMode: 'shadow',
    outcome: evaluation.outcome,
  });
  return { evaluation, recorded: true };
}

async function collectDisputeHoldCause(
  pending: Parameters<typeof pendingEditTargetOpenToAgents>[0] &
    SourceCheckedPendingEdit,
  pendingEditId: number,
): Promise<ConsensusDisputeHoldCause | null> {
  if (!(await pendingEditTargetOpenToAgents(pending))) return 'target_unpublished';
  if (await pendingEditCitesUnreadSources(pending)) return 'unverified_sources';
  if (await hasOpenDispute({ targetType: 'pending_edit', targetId: pendingEditId })) {
    return 'open_dispute';
  }
  if (await pendingEditUpheldRulingStands(pendingEditId, pending.proposedMeta)) {
    return 'upheld_dispute';
  }
  if (returnStandsUnrevised(pending.proposedMeta)) return 'returned_unrevised';
  return null;
}
