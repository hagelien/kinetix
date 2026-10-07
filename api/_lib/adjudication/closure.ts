/**
 * Automatic closure of a converged agent-only T3 case (the owner's governance
 * decision; docs/plans/2026-09-18-t3-adjudication-backend.md, PR 3).
 *
 * When both panelists converge on a case that rests on agent disputes alone,
 * the backend acts on the recommendation rather than leaving it for a person:
 *
 * - both seats `approve` the proposition: the objection was wrong. Every open
 *   agent dispute on the version resolves `rejected`, and the proposal no
 *   longer held by it can publish on agent consensus (kinetix-consensus@v3);
 * - both seats `dispute` or `return` it: the objection was right. The agent
 *   disputes resolve `upheld`, and a pending edit goes back to its author
 *   with the objection as the return note, as a moderator's uphold does.
 *
 * Anything else is a person's: `split_scope` (a decision about
 * representation), a clinical case, a categorical axis that changes the
 * model family, and an approval of a value other than the proposal's own (or
 * one that cannot be read off it). Those hand the case to T4 instead.
 *
 * A person's dispute is never closed here: a case resting on one is
 * `t4_required` before this runs, and this closes `source = 'agent'` rows
 * only. No identity decides — `resolved_by` is null and the case records the
 * ruling — so no model gains the capability to resolve disputes.
 *
 * Runs inside the opinion write that sealed the case, under the target's
 * source-row lock and the case lock, after that write checked the live
 * hydrated target against the packet the panel was bound to
 * (./snapshot.ts): what is closed is what the panel adjudicated.
 */

import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../db.js';
import {
  disputes,
  type AdjudicatedTarget,
  type AdjudicationClosure,
  type AdjudicationClosureDeclined,
  type AdjudicationRecommendation,
  type AgentVerificationEvidenceRef,
  type DisputeTargetType,
} from '../../../db/schema.js';
import { resolveDisputeById, unresolvedDisputeVerdictCount } from '../disputes.js';
import { returnPendingEditForUpheldDispute } from '../upheld-dispute-return.js';
import { contributionAuthorUserId, fanOutDisputeNotification } from '../notifications.js';
import { disputeTargetUrl } from '../agent-verifications.js';
import { convertParameterValue } from '../../../src/lib/parameterUnits.js';
import { isModelStructureParameter } from '../../../src/lib/drugParameters.js';
import { sameNumber } from './convergence.js';
import { canonicalJson } from './snapshot.js';

/** Resolutions that mean "the proposition stands; the objection was wrong". */
const OVERRULING = new Set(['approve']);
/** Resolutions that mean "the objection was right". */
const UPHOLDING = new Set(['dispute', 'return']);

type NumericClaim = {
  low: number | null;
  high: number | null;
  point: number | null;
  unit: string | null;
};

/** A number, or a numeric string as a Postgres `numeric` column reads back (#108). */
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * The numbers the proposal itself asserts, read off the packet the panel was
 * served: a parameter entry's create input or its update patch over the
 * current entry, or a drug-level parameter value. Null when the packet is
 * none of those.
 */
function proposalClaim(served: Record<string, unknown>): NumericClaim | null {
  if (served.targetType !== 'pending_edit') return null;
  const payload = (served.payload ?? {}) as Record<string, unknown>;
  const proposed = (payload.proposedValue ?? {}) as Record<string, unknown>;
  let source: Record<string, unknown> | null = null;
  if (payload.editType === 'param_entry') {
    if (proposed.op === 'create') source = (proposed.input ?? null) as Record<string, unknown> | null;
    if (proposed.op === 'update') {
      source = {
        ...((payload.currentEntry ?? {}) as Record<string, unknown>),
        ...((proposed.patch ?? {}) as Record<string, unknown>),
      };
    }
  } else if (payload.editType === 'parameter') {
    source = proposed;
  }
  if (!source) return null;
  return {
    low: num(source.low) ?? num(source.min),
    high: num(source.high) ?? num(source.max),
    point: num(source.median) ?? num(source.centralValue) ?? num(source.mean) ?? num(source.value),
    unit: typeof source.unit === 'string' ? source.unit : null,
  };
}

/** Whether an approval endorses the proposal's own value, in the canonical unit. */
function approvesProposalValue(
  value: NonNullable<AdjudicationRecommendation['value']>,
  claim: NumericClaim,
  comparison: AdjudicatedTarget['comparison'],
): boolean {
  const canonical = comparison.canonicalUnit ?? '';
  const unit = claim.unit ?? canonical;
  const convert = (v: number | null) =>
    v === null ? null : convertParameterValue(v, unit, canonical, comparison.molecularWeight);
  const low = convert(claim.low);
  const high = convert(claim.high);
  const point = convert(claim.point);
  if (value.kind === 'range') {
    return low !== null && high !== null && sameNumber(low, value.low) && sameNumber(high, value.high);
  }
  // A proposal that states bounds is approved only as a range: a scalar
  // endorsement of its centre says nothing about the endpoints that would
  // publish with it. A degenerate range (low = high) is the scalar itself.
  if (low !== null || high !== null) {
    return (
      low !== null &&
      high !== null &&
      sameNumber(low, high) &&
      sameNumber(low, value.value) &&
      (point === null || sameNumber(point, value.value))
    );
  }
  return point !== null && sameNumber(point, value.value);
}

/** Why the closure will not act on this recommendation, or null when it will. Exported for tests. */
export function closureDeclineReason(
  recommendation: AdjudicationRecommendation,
  bound: AdjudicatedTarget | null,
  targetType: string,
): AdjudicationClosureDeclined | null {
  if (!OVERRULING.has(recommendation.resolution) && !UPHOLDING.has(recommendation.resolution)) {
    return 'split_scope';
  }
  // Sustaining an objection is acted on by returning the proposal it was
  // raised against. Any other target — a published revision, a paper review,
  // a discussion — has no such disposition; closing its disputes would leave
  // the record uncorrected with nothing left to flag it, so a person takes it.
  if (UPHOLDING.has(recommendation.resolution) && targetType !== 'pending_edit') {
    return 'no_disposition';
  }
  const payload = ((bound?.served.payload ?? {}) as Record<string, unknown>);
  if (bound?.served.targetType === 'pending_edit') {
    if (payload.editType === 'clinical_case') return 'clinical';
    if (
      payload.editType === 'param_entry' &&
      typeof payload.parameter === 'string' &&
      isModelStructureParameter(payload.parameter)
    ) {
      return 'model_structure';
    }
  }
  if (OVERRULING.has(recommendation.resolution) && recommendation.value) {
    const claim = bound ? proposalClaim(bound.served) : null;
    if (!claim || !bound) return 'value_unverifiable';
    if (!approvesProposalValue(recommendation.value, claim, bound.comparison)) {
      return 'value_differs';
    }
  }
  return null;
}

export interface ClosureResult {
  closure: AdjudicationClosure;
  /** A pending edit whose agent disputes were overruled: retry consensus on it after commit. */
  retryConsensusFor: number | null;
}

/**
 * Act on a converged agent-only case's recommendation. The caller has already
 * established that the case converged, needs no person, and carries a
 * recommendation.
 */
export async function closeConvergedAgentCase(args: {
  caseId: number;
  targetType: string;
  targetId: number;
  targetVersion: string;
  recommendation: AdjudicationRecommendation;
  bound: AdjudicatedTarget | null;
  now: Date;
}): Promise<ClosureResult> {
  const at = args.now.toISOString();
  const declined = closureDeclineReason(args.recommendation, args.bound, args.targetType);
  if (declined) {
    return {
      closure: {
        action: 'declined',
        declined,
        disputeIds: [],
        pendingEditReturned: null,
        returnSkipped: null,
        at,
      },
      retryConsensusFor: null,
    };
  }

  const db = getDb();
  // The agent disputes the case rests on: open, on this version (a legacy row
  // with no recorded version is kept, as the detector keeps it). Never a
  // person's.
  const open = await db
    .select({
      id: disputes.id,
      targetVersion: disputes.targetVersion,
      reasonMd: disputes.reasonMd,
      evidenceRefs: disputes.evidenceRefs,
    })
    .from(disputes)
    .where(
      and(
        eq(disputes.targetType, args.targetType),
        eq(disputes.targetId, args.targetId),
        eq(disputes.status, 'open'),
        eq(disputes.source, 'agent'),
      ),
    )
    .orderBy(asc(disputes.id));
  const onVersion = open.filter(
    (d) => d.targetVersion === null || d.targetVersion === args.targetVersion,
  );
  const upholding = UPHOLDING.has(args.recommendation.resolution);
  const declineWith = (declined: AdjudicationClosureDeclined): ClosureResult => ({
    closure: {
      action: 'declined',
      declined,
      disputeIds: [],
      pendingEditReturned: null,
      returnSkipped: null,
      at,
    },
    retryConsensusFor: null,
  });
  // Only the objections the panel was served, as it was served them: one
  // opened after the binding — or restated since, which keeps its row and
  // replaces its text and evidence — reached neither seat, so the panel's
  // agreement says nothing about it.
  const bound = new Map(
    (args.bound?.lowerTier.openDisputes ?? [])
      .filter((d) => d.source === 'agent')
      .map((d) => [d.disputeId, d] as const),
  );
  const asServed = (d: (typeof onVersion)[number]) => {
    const seen = bound.get(d.id);
    return (
      seen !== undefined &&
      seen.reasonMd === d.reasonMd &&
      canonicalJson(seen.evidenceRefs ?? []) === canonicalJson(d.evidenceRefs ?? [])
    );
  };
  if (!onVersion.every(asServed)) return declineWith('unseen_dispute');
  const ids = onVersion.map((d) => d.id);
  if (ids.length === 0) {
    // Nothing to close — unless an agent's dispute verdict still stands with
    // no row behind it (recorded before the dispute table mirrored
    // verdicts). Closing nothing would leave it holding the proposal, and
    // this version can open no other case: a person takes it.
    const unanswered = await unresolvedDisputeVerdictCount({
      targetType: args.targetType as DisputeTargetType,
      targetId: args.targetId,
    });
    if (unanswered > 0) return declineWith('unmirrored_dispute');
    return {
      closure: {
        action: 'none',
        declined: null,
        disputeIds: [],
        pendingEditReturned: null,
        returnSkipped: null,
        at,
      },
      retryConsensusFor: args.targetType === 'pending_edit' ? args.targetId : null,
    };
  }

  const resolution = upholding ? 'upheld' : 'rejected';
  const resolved: Array<NonNullable<Awaited<ReturnType<typeof resolveDisputeById>>>> = [];
  for (const id of ids) {
    const row = await resolveDisputeById({ id, resolution, resolvedBy: null });
    if (row) resolved.push(row);
  }

  // An upheld objection sends a pending edit back to its author, carrying the
  // oldest sustained objection as the return note, as a moderator's would.
  let pendingEditReturned: boolean | null = null;
  let returnSkipped: string | null = null;
  const first = resolved[0];
  if (upholding && args.targetType === 'pending_edit' && first) {
    const outcome = await returnPendingEditForUpheldDispute({
      pendingEditId: args.targetId,
      disputeId: first.id,
      source: first.source,
      reasonMd: first.reasonMd,
      evidenceRefs: first.evidenceRefs as AgentVerificationEvidenceRef[],
      disputeRaisedAt: first.createdAt,
      targetVersion: first.targetVersion,
      resolvedBy: null,
      mayDecide: true,
      mayDecideOwn: true,
      // A model-structure axis was declined above; this keeps the guard.
      mayDecideModelStructure: false,
      byAdjudicationPanel: true,
    });
    pendingEditReturned = outcome.returned;
    returnSkipped = outcome.returned ? null : outcome.reason;
  }

  if (resolved.length > 0) {
    const url = await disputeTargetUrl({
      targetType: args.targetType as DisputeTargetType,
      targetId: args.targetId,
    });
    const targetAuthorUserId = await contributionAuthorUserId({
      targetType: args.targetType,
      targetId: args.targetId,
    });
    for (const row of resolved) {
      await fanOutDisputeNotification({
        type: 'dispute_resolved',
        disputeId: row.id,
        targetType: row.targetType,
        targetId: row.targetId,
        // No person ruled: the panel did. Nobody is excluded as the actor.
        actorUserId: 0,
        targetAuthorUserId,
        raisedByUserId: row.createdBy,
        // The outcome token the bell recovers (`Dispute upheld|rejected`).
        title: `Dispute ${resolution}`,
        url,
      });
    }
  }

  return {
    closure: {
      action: upholding ? 'upheld' : 'overruled',
      declined: null,
      disputeIds: resolved.map((r) => r.id),
      pendingEditReturned,
      returnSkipped,
      at,
    },
    retryConsensusFor: !upholding && args.targetType === 'pending_edit' ? args.targetId : null,
  };
}
