/**
 * `kg_policy_decisions` and `kg_publication_events` (§5.10, §5.11).
 *
 * A decision record is audit evidence, not a transient return value. It stores
 * the policy version it was made under, so a later policy change cannot
 * retroactively imply that older content was published under the new rule
 * (§7.4), and it stores `evaluationMode`, so a reader can tell whether the
 * decision actually governed anything. During the migration almost every row is
 * `shadow`: evaluated, recorded, and acted on by nobody (§11.2). A parity
 * report that could not tell a shadow decision from an authoritative one would
 * be claiming the new engine already runs Kinetix.
 *
 * Both tables are append-only. There is no update and no delete here.
 */

import { and, asc, desc, eq } from 'drizzle-orm';
import {
  kgPolicyDecisions,
  kgPublicationEvents,
  type KgEvaluationMode,
  type KgPolicyDecisionOutcome,
  type KgProposalState,
  type KgPublicationAction,
} from '../../../../db/governance-schema.js';
import type { PolicyDecision } from 'assurance-core';
import type {
  GovernanceDb,
  PolicyDecisionRecord,
  PublicationEventRecord,
} from './interface.js';

const DECISION_COLUMNS = {
  id: kgPolicyDecisions.id,
  spaceId: kgPolicyDecisions.spaceId,
  proposalVersionId: kgPolicyDecisions.proposalVersionId,
  policyId: kgPolicyDecisions.policyId,
  policyVersion: kgPolicyDecisions.policyVersion,
  decision: kgPolicyDecisions.decision,
  inputFingerprint: kgPolicyDecisions.inputFingerprint,
  evaluationMode: kgPolicyDecisions.evaluationMode,
  evaluatedAt: kgPolicyDecisions.evaluatedAt,
} as const;

const PUBLICATION_COLUMNS = {
  id: kgPublicationEvents.id,
  proposalVersionId: kgPublicationEvents.proposalVersionId,
  action: kgPublicationEvents.action,
  actorRef: kgPublicationEvents.actorRef,
  appliedRevisionRef: kgPublicationEvents.appliedRevisionRef,
  createdAt: kgPublicationEvents.createdAt,
} as const;

export async function recordPolicyDecision(
  db: GovernanceDb,
  args: {
    spaceId: number;
    proposalVersionId: number;
    policyId: string;
    policyVersion: string;
    decision: KgPolicyDecisionOutcome;
    inputFingerprint: string;
    evaluationMode?: KgEvaluationMode;
    requirements?: unknown;
    satisfiedRequirements?: unknown;
    unsatisfiedRequirements?: unknown;
    /** When the policy was evaluated, for a caller replaying history. */
    at?: Date;
  },
): Promise<PolicyDecisionRecord> {
  const [row] = await db
    .insert(kgPolicyDecisions)
    .values({
      ...(args.at ? { evaluatedAt: args.at } : {}),
      spaceId: args.spaceId,
      proposalVersionId: args.proposalVersionId,
      policyId: args.policyId,
      policyVersion: args.policyVersion,
      decision: args.decision,
      inputFingerprint: args.inputFingerprint,
      // Defaulting to `shadow` rather than requiring the argument is the
      // fail-safe direction: a caller that forgets to say records a decision
      // that governs nothing, not one that governs everything.
      evaluationMode: args.evaluationMode ?? 'shadow',
      requirements: args.requirements ?? null,
      satisfiedRequirements: args.satisfiedRequirements ?? null,
      unsatisfiedRequirements: args.unsatisfiedRequirements ?? null,
    })
    .returning(DECISION_COLUMNS);
  return row as PolicyDecisionRecord;
}

/**
 * Persist a `PolicyDecision` produced by the pure core.
 *
 * The mapping the core cannot make itself: it knows whether every requirement
 * was met, and the host knows what to *do* about that. `allowed` becomes
 * `apply` and anything else becomes `hold` by default — never `reject`, because
 * an unmet requirement means "not yet", and a policy engine that turned a
 * missing second approval into a rejection would be discarding work the author
 * could still finish. A caller that genuinely means `return` or `reject` says
 * so explicitly.
 */
export async function recordCoreDecision(
  db: GovernanceDb,
  args: {
    spaceId: number;
    proposalVersionId: number;
    decision: PolicyDecision;
    evaluationMode?: KgEvaluationMode;
    outcome?: KgPolicyDecisionOutcome;
  },
): Promise<PolicyDecisionRecord> {
  const { decision } = args;
  return recordPolicyDecision(db, {
    spaceId: args.spaceId,
    proposalVersionId: args.proposalVersionId,
    policyId: decision.policyId,
    policyVersion: decision.policyVersion,
    decision: args.outcome ?? (decision.allowed ? 'apply' : 'hold'),
    inputFingerprint: decision.inputFingerprint,
    evaluationMode: args.evaluationMode,
    requirements: decision.outcomes,
    satisfiedRequirements: decision.outcomes.filter((o) => o.met),
    unsatisfiedRequirements: decision.unmet,
  });
}

/**
 * The full requirement breakdown recorded with one decision.
 *
 * Kept off `PolicyDecisionRecord` — which every list and latest-decision read
 * returns — because these three columns are JSONB holding one entry per
 * evaluated requirement, and a queue rendering fifty decisions does not want
 * fifty breakdowns. The moderator view asks for one at a time.
 *
 * Read back rather than re-evaluated: re-evaluating would show what the policy
 * says *now* against a decision made under what it said *then*, and §7.4 exists
 * precisely so those cannot be confused.
 */
export async function decisionRequirements(
  db: GovernanceDb,
  decisionId: number,
): Promise<{
  requirements: unknown;
  satisfied: unknown;
  unsatisfied: unknown;
} | null> {
  const [row] = await db
    .select({
      requirements: kgPolicyDecisions.requirements,
      satisfied: kgPolicyDecisions.satisfiedRequirements,
      unsatisfied: kgPolicyDecisions.unsatisfiedRequirements,
    })
    .from(kgPolicyDecisions)
    .where(eq(kgPolicyDecisions.id, decisionId))
    .limit(1);
  return row ?? null;
}

/** Decisions on one version, newest first. */
export async function listDecisionsForVersion(
  db: GovernanceDb,
  proposalVersionId: number,
): Promise<PolicyDecisionRecord[]> {
  const rows = await db
    .select(DECISION_COLUMNS)
    .from(kgPolicyDecisions)
    .where(eq(kgPolicyDecisions.proposalVersionId, proposalVersionId))
    .orderBy(desc(kgPolicyDecisions.evaluatedAt), desc(kgPolicyDecisions.id));
  return rows as PolicyDecisionRecord[];
}

/**
 * The most recent decision on a version, optionally restricted to one mode.
 *
 * The `mode` filter is what makes "what would the new engine have done?" and
 * "what actually governed this?" two different questions with two different
 * answers, which during the migration they are.
 */
export async function latestDecisionForVersion(
  db: GovernanceDb,
  proposalVersionId: number,
  mode?: KgEvaluationMode,
): Promise<PolicyDecisionRecord | null> {
  const [row] = await db
    .select(DECISION_COLUMNS)
    .from(kgPolicyDecisions)
    .where(
      mode
        ? and(
            eq(kgPolicyDecisions.proposalVersionId, proposalVersionId),
            eq(kgPolicyDecisions.evaluationMode, mode),
          )
        : eq(kgPolicyDecisions.proposalVersionId, proposalVersionId),
    )
    .orderBy(desc(kgPolicyDecisions.evaluatedAt), desc(kgPolicyDecisions.id))
    .limit(1);
  return (row as PolicyDecisionRecord | undefined) ?? null;
}

export async function recordPublicationEvent(
  db: GovernanceDb,
  args: {
    proposalVersionId: number;
    action: KgPublicationAction;
    actorRef: string;
    policyDecisionId?: number | null;
    appliedRevisionRef?: string | null;
  },
): Promise<PublicationEventRecord> {
  const [row] = await db
    .insert(kgPublicationEvents)
    .values({
      proposalVersionId: args.proposalVersionId,
      action: args.action,
      actorRef: args.actorRef,
      policyDecisionId: args.policyDecisionId ?? null,
      appliedRevisionRef: args.appliedRevisionRef ?? null,
    })
    .returning(PUBLICATION_COLUMNS);
  return row as PublicationEventRecord;
}

/** What happened to a version, oldest first. */
/**
 * The proposal state each publication outcome leaves behind.
 *
 * The event is the history; the proposal's state is the summary of it, and they
 * have to move together. Recording the event without moving the projection
 * would leave every applied edit permanently reported as a `state_mismatch` by
 * the reconciliation scanner — the projection saying `pending` forever while
 * legacy said `approved` — and the Phase 4 exit gate ("unexplained mirror loss
 * = 0 after reconciliation") could then never be met.
 *
 * It lives beside the events rather than in either reader, because there are
 * two: the live mirror, which moves the state as each event arrives, and the
 * projection rebuild, which replays the log to the same endpoint. Two copies
 * would be two answers to "what does this event mean", and the rebuild's whole
 * job is to agree with the path that wrote the events.
 */
export const STATE_AFTER_PUBLICATION: Readonly<
  Record<KgPublicationAction, KgProposalState>
> = {
  submitted: 'pending',
  applied: 'applied',
  returned: 'returned',
  rejected: 'rejected',
  withdrawn: 'withdrawn',
};

export async function listPublicationEvents(
  db: GovernanceDb,
  proposalVersionId: number,
): Promise<PublicationEventRecord[]> {
  const rows = await db
    .select(PUBLICATION_COLUMNS)
    .from(kgPublicationEvents)
    .where(eq(kgPublicationEvents.proposalVersionId, proposalVersionId))
    .orderBy(asc(kgPublicationEvents.createdAt), asc(kgPublicationEvents.id));
  return rows as PublicationEventRecord[];
}
