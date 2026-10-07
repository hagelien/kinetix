/**
 * T3 opinions: the panel's write path, sealing, convergence and the T4
 * handoff (docs/plans/2026-09-18-t3-adjudication-backend.md §3.4–§3.7,
 * agents/drug-db-adjudication.md §6–§7).
 *
 * A seated adjudicator appends opinions for its own seat; `final: true` makes
 * the latest one immutable. Every write is re-checked under the locks the rest
 * of the tier takes — the target's source row, then the case row — so a target
 * that moved invalidates the case instead of accepting an opinion about a
 * payload that no longer exists, and an adjudicator whose grant or tier was
 * revoked a moment earlier cannot write.
 *
 * When both seats are final the case is sealed and the two opinions are
 * compared in code (./convergence.ts). Nothing here resolves a dispute: a
 * converged agent-only case records a recommendation; anything else — a
 * divergence, a panelist asking for a human, a person's dispute in the case —
 * produces the T4 handoff and tells the reviewers.
 */

import { and, desc, eq, isNotNull, inArray } from 'drizzle-orm';
import { getDb, inTransaction } from '../db.js';
import {
  adjudicationCaseSeats,
  adjudicationCases,
  adjudicationOpinions,
  agents,
  users,
  type AdjudicationCaseState,
  type AdjudicationHandoff,
  type AdjudicationHandoffOpinion,
  type AdjudicationResolution,
  type AdjudicationSeat,
  type AgentVerificationTargetType,
} from '../../../db/schema.js';
import {
  lockVerificationSourceRow,
  verificationTargetVersion,
} from '../verification-targets.js';
import { ACTIVE_AGENT_ROLES, disputeTargetUrl } from '../agent-verifications.js';
import { bindPanelTarget } from './snapshot.js';
import {
  contributionAuthorUserId,
  fanOutDisputeNotification,
} from '../notifications.js';
import { FLAGSHIP_TIER } from '../../../src/lib/modelTiers.js';
import {
  convertParameterValue,
  entryUnitsForParameter,
} from '../../../src/lib/parameterUnits.js';
import { getRangeSpec, type DrugParameterId } from '../../../src/lib/drugParameters.js';
import {
  compareOpinions,
  VALUE_ENDORSING_RESOLUTIONS,
  type ConvergenceResult,
} from './convergence.js';
import { adjudicationTargetParameter } from './target.js';
import { disputeOriginOf } from './detector.js';
import {
  liveConflictedAgentIds,
  mergeOpenDisputes,
  openDisputesOnVersion,
  type InvalidatedReason,
} from './cases.js';

export interface OpinionInput {
  caseId: number;
  targetVersion: string;
  resolution: AdjudicationResolution;
  proposition: string;
  scopeKey: Record<string, string>;
  resolvedValue?: number | null;
  resolvedLow?: number | null;
  resolvedHigh?: number | null;
  resolvedUnit?: string | null;
  reasoningMd: string;
  evidenceRefs: unknown[];
  confidence: 'high' | 'medium' | 'low';
  humanRequired: boolean;
  humanReason?: string | null;
  model?: string | null;
  /** Make this the seat's final, immutable opinion. */
  final: boolean;
}

export type OpinionWriteResult =
  | {
      ok: true;
      opinionId: number;
      seat: AdjudicationSeat;
      revisionNo: number;
      final: boolean;
      /** Set when this write sealed the case. */
      outcome: {
        state: AdjudicationCaseState;
        converged: boolean;
        t4Required: boolean;
      } | null;
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409;
      code:
        | 'case_not_found'
        | 'not_seated'
        | 'not_eligible'
        | 'case_not_open'
        | 'target_version_stale'
        | 'target_version_moved'
        | 'target_unavailable'
        | 'target_drifted'
        | 'seat_final'
        | 'conflicted'
        | 'value_required'
        | 'value_not_allowed'
        | 'unit_not_allowed'
        | 'range_required'
        | 'value_out_of_bounds'
        | 'human_reason_required';
      message: string;
    };

const PANEL_TARGET_REFUSALS = {
  target_unavailable: 'The target can no longer be served to the panel; this case has been closed',
  target_drifted:
    'What the target is compared against changed under the panel; this case has been closed',
  target_version_moved: 'The target changed; this case has been closed',
} as const;

function refuse(
  status: 400 | 403 | 404 | 409,
  code: Extract<OpinionWriteResult, { ok: false }>['code'],
  message: string,
): OpinionWriteResult {
  return { ok: false, status, code, message };
}

/**
 * The value fields an opinion may carry. An endorsing resolution on a numeric
 * parameter must carry a scalar or a range with one of the parameter's units;
 * anything else carries none — so `abstain` and `human` stay reachable exactly
 * where the decisive evidence is missing (§3.2).
 */
async function checkValueShape(
  input: OpinionInput,
  target: { targetType: string; targetId: number },
  /** The molecular weight the panel is bound to (./snapshot.ts), for the bounds. */
  molecularWeight: number | null,
): Promise<OpinionWriteResult | null> {
  const hasScalar = input.resolvedValue != null;
  const hasRange = input.resolvedLow != null || input.resolvedHigh != null;
  const hasAny = hasScalar || hasRange || input.resolvedUnit != null;
  const parameter = await adjudicationTargetParameter(target.targetType, target.targetId);
  const endorses = VALUE_ENDORSING_RESOLUTIONS.includes(input.resolution);
  if (!endorses || !parameter) {
    return hasAny
      ? refuse(
          400,
          'value_not_allowed',
          endorses
            ? 'This target carries no value to endorse; state the resolution in the proposition and scope'
            : `A ${input.resolution} opinion endorses no value; leave the value fields out`,
        )
      : null;
  }
  const scalarOk = hasScalar && input.resolvedLow == null && input.resolvedHigh == null;
  const rangeOk =
    !hasScalar &&
    input.resolvedLow != null &&
    input.resolvedHigh != null &&
    input.resolvedLow <= input.resolvedHigh;
  // `''` is the dimensionless unit (pKa, logP, logD), so only an absent unit
  // is missing.
  if ((!scalarOk && !rangeOk) || input.resolvedUnit == null) {
    return refuse(
      400,
      'value_required',
      `An ${input.resolution} opinion on ${parameter.parameter} must endorse a value: resolvedValue, or resolvedLow <= resolvedHigh, with resolvedUnit`,
    );
  }
  const units = entryUnitsForParameter(parameter.parameter as DrugParameterId);
  if (units.length > 0 && !units.includes(input.resolvedUnit)) {
    return refuse(
      400,
      'unit_not_allowed',
      `"${input.resolvedUnit}" is not a unit of ${parameter.parameter}; use one of ${units.map((u) => `"${u}"`).join(', ')}`,
    );
  }
  // The parameter's own contract, as every other write path applies it
  // (validateEntryForParameter): a recommendation is a value the database
  // would accept, never one it would refuse.
  const spec = getRangeSpec(parameter.parameter as DrugParameterId);
  if (spec.requiresMinMax && !rangeOk) {
    return refuse(
      400,
      'range_required',
      `${parameter.parameter} takes a range: endorse resolvedLow and resolvedHigh, not a single value`,
    );
  }
  const values = scalarOk ? [input.resolvedValue!] : [input.resolvedLow!, input.resolvedHigh!];
  for (const raw of values) {
    // Bounds are stated in the canonical unit; an unconvertible value keeps
    // the raw check, as on the entry write path.
    const canonical =
      convertParameterValue(raw, input.resolvedUnit, spec.canonicalUnit, molecularWeight) ?? raw;
    if (canonical < spec.bounds.min || canonical > spec.bounds.max) {
      return refuse(
        400,
        'value_out_of_bounds',
        `${raw}${input.resolvedUnit ? ` ${input.resolvedUnit}` : ''} is outside the allowed range for ${parameter.parameter} (${spec.bounds.min}–${spec.bounds.max} ${spec.canonicalUnit || 'dimensionless'})`,
      );
    }
  }
  return null;
}

/**
 * Append an opinion for the caller's seat. With `final`, the seat is sealed,
 * and the second seat to seal seals the case.
 */
export async function submitAdjudicationOpinion(args: {
  agentId: number;
  input: OpinionInput;
}): Promise<OpinionWriteResult> {
  const { input } = args;
  if ((input.resolution === 'human' || input.humanRequired) && !input.humanReason?.trim()) {
    return refuse(400, 'human_reason_required', 'Say why a person is needed (humanReason)');
  }
  const db = getDb();
  const [peek] = await db
    .select({ targetType: adjudicationCases.targetType, targetId: adjudicationCases.targetId })
    .from(adjudicationCases)
    .where(eq(adjudicationCases.id, input.caseId));
  if (!peek) return refuse(404, 'case_not_found', 'No such case');

  return inTransaction(async () => {
    const tx = getDb();
    // The order every T3 writer takes: the target's source row, then the case.
    await lockVerificationSourceRow(tx, peek.targetType, peek.targetId);
    const [kase] = await tx
      .select()
      .from(adjudicationCases)
      .where(eq(adjudicationCases.id, input.caseId))
      .for('update');
    if (!kase) return refuse(404, 'case_not_found', 'No such case');

    const [seat] = await tx
      .select({ seat: adjudicationCaseSeats.seat, sealedAt: adjudicationCaseSeats.sealedAt })
      .from(adjudicationCaseSeats)
      .where(
        and(
          eq(adjudicationCaseSeats.caseId, input.caseId),
          eq(adjudicationCaseSeats.agentId, args.agentId),
        ),
      );
    if (!seat) return refuse(403, 'not_seated', 'You hold no seat on this case; claim one first');

    // Authority at write time, not at claim time: a grant or tier revoked
    // since the claim stops the write.
    const [agent] = await tx
      .select({ id: agents.id, userId: agents.userId, modelTier: agents.modelTier })
      .from(agents)
      .innerJoin(users, eq(users.id, agents.userId))
      .where(
        and(
          eq(agents.id, args.agentId),
          eq(agents.status, 'active'),
          eq(agents.adjudicator, true),
          eq(agents.modelTier, FLAGSHIP_TIER),
          inArray(users.role, ACTIVE_AGENT_ROLES),
        ),
      )
      .for('share', { of: agents });
    if (!agent) {
      return refuse(403, 'not_eligible', 'An active flagship-tier adjudicator is required');
    }

    if (kase.state !== 'open') {
      return refuse(409, 'case_not_open', `This case is ${kase.state}`);
    }
    if (input.targetVersion !== kase.targetVersion) {
      return refuse(409, 'target_version_stale', 'targetVersion is not the version this case adjudicates');
    }
    const current = await verificationTargetVersion(
      { targetType: kase.targetType as AgentVerificationTargetType, targetId: kase.targetId },
      tx,
    );
    if (current !== kase.targetVersion) {
      // The payload moved under the panel: the case is over, never migrated.
      await tx
        .update(adjudicationCases)
        .set({
          state: 'invalidated',
          closedAt: new Date(),
          invalidatedReason: 'target_version_moved' satisfies InvalidatedReason,
        })
        .where(eq(adjudicationCases.id, kase.id));
      return refuse(409, 'target_version_moved', 'The target changed; this case has been closed');
    }
    // The hydrated target both seats were served (./snapshot.ts). A target
    // that can no longer be served, or whose baselines moved under the panel,
    // closes the case: no opinion may stand on a packet the panel did not
    // share.
    const bound = await bindPanelTarget(kase, { agentId: agent.id, agentUserId: agent.userId });
    if (!bound.ok) return refuse(409, bound.reason, PANEL_TARGET_REFUSALS[bound.reason]);
    if (seat.sealedAt) return refuse(409, 'seat_final', 'Your opinion on this case is final');
    // A part taken since the claim — a verdict on the target, a dispute on
    // this version — disqualifies the panelist before its opinion counts.
    if ((await liveConflictedAgentIds(kase)).has(agent.id)) {
      return refuse(
        403,
        'conflicted',
        'You have taken a part in this case since claiming your seat (a verdict or a dispute), so your opinion cannot count',
      );
    }
    // Checked under the locks against the basis the panel is bound to, so the
    // bounds convert with the same molecular weight the seal compares with.
    const shapeError = await checkValueShape(
      input,
      kase,
      bound.snapshot.comparison.molecularWeight,
    );
    if (shapeError) return shapeError;

    const [previous] = await tx
      .select({ id: adjudicationOpinions.id, revisionNo: adjudicationOpinions.revisionNo })
      .from(adjudicationOpinions)
      .where(
        and(
          eq(adjudicationOpinions.caseId, kase.id),
          eq(adjudicationOpinions.seat, seat.seat),
        ),
      )
      .orderBy(desc(adjudicationOpinions.revisionNo))
      .limit(1);
    const now = new Date();
    const [written] = await tx
      .insert(adjudicationOpinions)
      .values({
        caseId: kase.id,
        seat: seat.seat,
        revisionNo: (previous?.revisionNo ?? 0) + 1,
        supersedesOpinionId: previous?.id ?? null,
        adjudicatorTier: agent.modelTier,
        model: input.model ?? null,
        resolution: input.resolution,
        proposition: input.proposition,
        scopeKey: input.scopeKey,
        resolvedValue: input.resolvedValue ?? null,
        resolvedLow: input.resolvedLow ?? null,
        resolvedHigh: input.resolvedHigh ?? null,
        resolvedUnit: input.resolvedUnit ?? null,
        reasoningMd: input.reasoningMd,
        evidenceRefs: input.evidenceRefs,
        confidence: input.confidence,
        humanRequired: input.humanRequired || input.resolution === 'human',
        humanReason: input.humanReason?.trim() || null,
        finalizedAt: input.final ? now : null,
      })
      .returning({ id: adjudicationOpinions.id, revisionNo: adjudicationOpinions.revisionNo });

    let outcome: Extract<OpinionWriteResult, { ok: true }>['outcome'] = null;
    if (input.final) {
      await tx
        .update(adjudicationCaseSeats)
        .set({ sealedAt: now })
        .where(
          and(
            eq(adjudicationCaseSeats.caseId, kase.id),
            eq(adjudicationCaseSeats.seat, seat.seat),
          ),
        );
      outcome = await sealIfComplete(kase.id, now);
    }
    return {
      ok: true,
      opinionId: written!.id,
      seat: seat.seat,
      revisionNo: written!.revisionNo,
      final: input.final,
      outcome,
    };
  });
}

/** Each seat's final opinion, oldest seat first. */
async function finalOpinions(caseId: number) {
  return getDb()
    .select({
      id: adjudicationOpinions.id,
      seat: adjudicationOpinions.seat,
      agentId: adjudicationCaseSeats.agentId,
      modelFamily: agents.modelFamily,
      adjudicatorTier: adjudicationOpinions.adjudicatorTier,
      model: adjudicationOpinions.model,
      resolution: adjudicationOpinions.resolution,
      proposition: adjudicationOpinions.proposition,
      scopeKey: adjudicationOpinions.scopeKey,
      resolvedValue: adjudicationOpinions.resolvedValue,
      resolvedLow: adjudicationOpinions.resolvedLow,
      resolvedHigh: adjudicationOpinions.resolvedHigh,
      resolvedUnit: adjudicationOpinions.resolvedUnit,
      reasoningMd: adjudicationOpinions.reasoningMd,
      evidenceRefs: adjudicationOpinions.evidenceRefs,
      confidence: adjudicationOpinions.confidence,
      humanRequired: adjudicationOpinions.humanRequired,
      humanReason: adjudicationOpinions.humanReason,
      finalizedAt: adjudicationOpinions.finalizedAt,
    })
    .from(adjudicationOpinions)
    .innerJoin(
      adjudicationCaseSeats,
      and(
        eq(adjudicationCaseSeats.caseId, adjudicationOpinions.caseId),
        eq(adjudicationCaseSeats.seat, adjudicationOpinions.seat),
      ),
    )
    .innerJoin(agents, eq(agents.id, adjudicationCaseSeats.agentId))
    .where(
      and(eq(adjudicationOpinions.caseId, caseId), isNotNull(adjudicationOpinions.finalizedAt)),
    )
    .orderBy(adjudicationOpinions.seat);
}

type FinalOpinion = Awaited<ReturnType<typeof finalOpinions>>[number];

function handoffOpinion(o: FinalOpinion): AdjudicationHandoffOpinion {
  return {
    opinionId: o.id,
    seat: o.seat,
    agentId: o.agentId,
    adjudicatorTier: o.adjudicatorTier,
    model: o.model,
    resolution: o.resolution,
    proposition: o.proposition,
    scopeKey: o.scopeKey,
    resolvedValue: o.resolvedValue,
    resolvedLow: o.resolvedLow,
    resolvedHigh: o.resolvedHigh,
    resolvedUnit: o.resolvedUnit,
    reasoningMd: o.reasoningMd,
    evidenceRefs: o.evidenceRefs,
    confidence: o.confidence,
    humanRequired: o.humanRequired,
    humanReason: o.humanReason,
    finalizedAt: (o.finalizedAt ?? new Date()).toISOString(),
  };
}

function valueText(o: FinalOpinion): string {
  if (o.resolvedValue !== null) return ` ${o.resolvedValue} ${o.resolvedUnit ?? ''}`.trimEnd();
  if (o.resolvedLow !== null) return ` ${o.resolvedLow}–${o.resolvedHigh} ${o.resolvedUnit ?? ''}`.trimEnd();
  return '';
}

const DIVERGENCE_TEXT: Record<string, string> = {
  resolution_differs: 'the panelists reached different resolutions',
  scope_differs: 'the panelists agreed on a resolution but for different scopes',
  value_shape_differs: 'one panelist endorsed a single value and the other a range',
  value_differs: 'the panelists endorsed different values',
  unit_family_differs: 'the panelists endorsed values in different unit families, so they disagree about what was measured',
  unit_not_convertible: 'the endorsed values could not be converted to the parameter’s unit (a molecular weight may be missing)',
};

/** The one paragraph a person reads first: what remains disputed and why it is theirs. */
function handoffSummary(
  reasons: AdjudicationHandoff['reasons'],
  opinions: FinalOpinion[],
  result: ConvergenceResult,
): string {
  const parts: string[] = [];
  if (reasons.includes('panel_diverged') && result.convergence.reason) {
    parts.push(`The T3 panel did not converge: ${DIVERGENCE_TEXT[result.convergence.reason]}.`);
  } else if (reasons.includes('panel_diverged')) {
    parts.push('The T3 panel did not converge.');
  }
  for (const o of opinions) {
    parts.push(
      `Seat ${o.seat.toUpperCase()} (${o.resolution}${valueText(o)}): “${o.proposition}”.`,
    );
  }
  const asked = opinions.filter((o) => o.humanRequired && o.humanReason);
  for (const o of asked) {
    parts.push(`Seat ${o.seat.toUpperCase()} asked for a person: ${o.humanReason}`);
  }
  if (reasons.includes('panel_conflicted')) {
    parts.push(
      'A panelist took a part in this case after finalizing (a verdict or a dispute on the target), so the panel was not independent and nothing is recommended.',
    );
  }
  if (reasons.includes('panel_abstained')) {
    parts.push(
      'Both panelists abstained: the decisive evidence is missing or out of reach, so nothing was resolved.',
    );
  }
  if (reasons.includes('human_dispute')) {
    parts.push(
      result.recommendation
        ? 'The panel converged, but a person’s dispute is part of this case, so the closing act is a person’s; the panel’s recommendation is attached.'
        : 'A person’s dispute is part of this case, so the closing act is a person’s.',
    );
  }
  return parts.join(' ');
}

/**
 * Seal the case once both seats are final: compare the two opinions, record
 * the outcome, and hand the case to a person where one is needed.
 */
async function sealIfComplete(
  caseId: number,
  now: Date,
): Promise<Extract<OpinionWriteResult, { ok: true }>['outcome']> {
  const tx = getDb();
  const opinions = await finalOpinions(caseId);
  if (opinions.length < 2) return null;
  const [a, b] = opinions as [FinalOpinion, FinalOpinion];
  const [kase] = await tx
    .select()
    .from(adjudicationCases)
    .where(eq(adjudicationCases.id, caseId));
  if (!kase) return null;

  // The basis pinned when the panel was bound (./snapshot.ts): a molecular
  // weight edited between the two seats cannot flip the comparison.
  let comparison = kase.adjudicatedTarget?.comparison;
  if (!comparison) {
    const parameter = await adjudicationTargetParameter(kase.targetType, kase.targetId);
    comparison = {
      canonicalUnit: parameter?.canonicalUnit ?? null,
      molecularWeight: parameter?.molecularWeight ?? null,
    };
  }
  const result = compareOpinions(a, b, comparison, now);
  const converged = result.convergence.converged && !result.convergence.humanRequested;
  const state: AdjudicationCaseState = converged ? 'converged' : 'diverged';

  // Who raised the disputes the case rests on, read again now, under the
  // source-row lock this write holds: a person's dispute on this version that
  // landed after the detector last refreshed the case still makes the closing
  // act theirs. Merged into the case's record, never narrowed.
  const openNow = await openDisputesOnVersion(kase);
  const openDisputes = mergeOpenDisputes(kase.t1Snapshot.openDisputes, openNow);
  const t1Snapshot = { ...kase.t1Snapshot, openDisputes };
  const disputeOrigin = disputeOriginOf(openDisputes);

  const reasons: AdjudicationHandoff['reasons'] = [];
  if (!result.convergence.converged) reasons.push('panel_diverged');
  if (result.convergence.humanRequested) reasons.push('human_requested');
  // Both panelists abstained: they agree only that the decisive evidence is
  // missing. Nothing was resolved, and this version cannot open another case,
  // so a person takes it.
  if (converged && a.resolution === 'abstain') reasons.push('panel_abstained');
  if (disputeOrigin !== 'agent') reasons.push('human_dispute');
  // A seat that finalized and then took a part in the case (a verdict, a
  // dispute): its opinion cannot stand for an independent panel, so nothing
  // is recommended and a person takes the case.
  const conflicted = await liveConflictedAgentIds({ ...kase, t1Snapshot });
  const panelConflicted = conflicted.has(a.agentId) || conflicted.has(b.agentId);
  if (panelConflicted) reasons.push('panel_conflicted');
  const t4Required = reasons.length > 0;
  if (panelConflicted) result.recommendation = null;

  const families = [a.modelFamily, b.modelFamily];
  const panelFamilyDiversity =
    families.some((f) => !f) ? 'unknown' : families[0] === families[1] ? 'same' : 'distinct';

  const decisiveSources: unknown[] = [];
  const seenSources = new Set<string>();
  for (const o of opinions) {
    for (const ref of Array.isArray(o.evidenceRefs) ? o.evidenceRefs : []) {
      const key = JSON.stringify(ref);
      if (!seenSources.has(key)) {
        seenSources.add(key);
        decisiveSources.push(ref);
      }
    }
  }
  const handoff: AdjudicationHandoff | null = t4Required
    ? {
        caseId: kase.id,
        targetType: kase.targetType,
        targetId: kase.targetId,
        targetVersion: kase.targetVersion,
        disputeOrigin,
        triggers: kase.triggers,
        reasons,
        summary: handoffSummary(reasons, opinions, result),
        opinions: opinions.map(handoffOpinion),
        t2Snapshot: kase.t2Snapshot,
        t1Snapshot,
        decisiveSources,
        convergence: result.convergence,
        recommendation: result.recommendation,
        createdAt: now.toISOString(),
      }
    : null;

  await tx
    .update(adjudicationCases)
    .set({
      state,
      sealedAt: now,
      closedAt: now,
      convergence: result.convergence,
      recommendation: result.recommendation,
      t4Required,
      handoff,
      panelFamilyDiversity,
      disputeOrigin,
      t1Snapshot,
    })
    .where(eq(adjudicationCases.id, caseId));

  if (handoff) {
    const humanDispute = openDisputes.find((d) => d.source !== 'agent');
    await fanOutDisputeNotification({
      type: 'adjudication_handoff',
      disputeId: humanDispute?.disputeId ?? null,
      targetType: kase.targetType,
      targetId: kase.targetId,
      // No person acted: the panel did. Nobody is excluded as the actor.
      actorUserId: 0,
      targetAuthorUserId: await contributionAuthorUserId({
        targetType: kase.targetType,
        targetId: kase.targetId,
      }),
      title: 'A T3 panel left a case for a person',
      // No body: the bell and the email show user-written text as is, and the
      // summary is generated English. The localised title says what happened;
      // the case file carries the reasons, typed.
      bodyMd: null,
      // The target, where the person decides; the full package is served by
      // GET /api/agent-adjudication-queue?caseId=N.
      url: await disputeTargetUrl({
        targetType: kase.targetType as AgentVerificationTargetType,
        targetId: kase.targetId,
      }),
    });
  }
  return { state, converged, t4Required };
}
