/**
 * The one target a T3 panel adjudicates.
 *
 * The case file serves a target hydrated the way the verification queue
 * serves it: the source row plus the baselines it is compared against (the
 * current value, entry or content). Those baselines can move without the
 * target's version moving, so the version alone cannot bind two panelists to
 * the same packet. The first seat claim therefore copies the hydrated target
 * onto the case (`adjudicated_target`); both seats are served that copy, every
 * opinion write re-checks the live target against it, and a target that has
 * drifted closes the case. What a sealed case records as adjudicated is the
 * packet both panelists were served.
 *
 * The binding also freezes what else the panel is served or compared
 * through: why the case opened and whose objection it rests on, the
 * lower-tier record (copied verdicts and the open disputes on the version),
 * the decided disputes on the target, and the canonical unit and
 * molecular weight the two opinions are converted with — so a dispute
 * resolved, or a molecular weight edited, between the two seats changes
 * neither what they read nor how their values compare.
 */

import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../db.js';
import {
  adjudicationCases,
  disputes,
  type AdjudicatedTarget,
  type AdjudicationDecidedDispute,
  type AgentVerificationTargetType,
} from '../../../db/schema.js';

type AdjudicationCase = typeof adjudicationCases.$inferSelect;
import { fetchSingleCandidate, type QueueItem } from '../../agent-verifications-queue.js';
import { adjudicationTargetParameter, readTargetRow } from './target.js';
import { disputeOriginOf } from './detector.js';
import {
  mergeOpenDisputes,
  openDisputesOnVersion,
  type InvalidatedReason,
} from './cases.js';

/** The target as the case file serves it now, or null when it cannot be served. */
export function liveHydratedTarget(
  kase: { targetType: string; targetId: number },
  viewer: { agentId: number; agentUserId: number },
): Promise<QueueItem | null> {
  return fetchSingleCandidate({
    type: kase.targetType as AgentVerificationTargetType,
    targetId: kase.targetId,
    agentId: viewer.agentId,
    agentUserId: viewer.agentUserId,
    selfReviewEnabled: false,
    includeJudged: true,
  });
}

/** The decided disputes on a target, oldest first. */
export async function decidedDisputesOn(
  targetType: string,
  targetId: number,
): Promise<AdjudicationDecidedDispute[]> {
  const rows = await getDb()
    .select({
      disputeId: disputes.id,
      source: disputes.source,
      targetVersion: disputes.targetVersion,
      reasonMd: disputes.reasonMd,
      resolution: disputes.resolution,
      createdAt: disputes.createdAt,
      resolvedAt: disputes.resolvedAt,
    })
    .from(disputes)
    .where(
      and(
        eq(disputes.targetType, targetType),
        eq(disputes.targetId, targetId),
        eq(disputes.status, 'resolved'),
      ),
    )
    .orderBy(asc(disputes.id));
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
  }));
}

/** Key-order-independent JSON, as the value round-trips through jsonb. */
export function canonicalJson(value: unknown): string {
  const normalised = JSON.parse(JSON.stringify(value ?? null)) as unknown;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, walk((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(walk(normalised));
}

/** Whether two hydrated targets are the same packet: same version, same payload. */
export function sameServedTarget(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return (
    a.targetVersion === b.targetVersion && canonicalJson(a.payload) === canonicalJson(b.payload)
  );
}

export type PanelTargetCheck =
  | { ok: true; snapshot: AdjudicatedTarget }
  | { ok: false; reason: PanelTargetRefusal };

type PanelTargetRefusal = Extract<
  InvalidatedReason,
  'target_unavailable' | 'target_drifted' | 'target_version_moved'
>;

/**
 * Bind the case to its hydrated target, or check the live target against the
 * binding. Called under the source-row lock and the case lock — by the first
 * seat claim, which binds, and by every opinion write, which checks. On a
 * refusal the case is closed here, as invalidated.
 */
export async function bindPanelTarget(
  kase: {
    id: number;
    targetType: string;
    targetId: number;
    targetVersion: string;
    adjudicatedTarget: AdjudicatedTarget | null;
    t1Snapshot: AdjudicationCase['t1Snapshot'];
    t2Snapshot: AdjudicationCase['t2Snapshot'];
    triggers: AdjudicationCase['triggers'];
    triggerDetail: AdjudicationCase['triggerDetail'];
  },
  viewer: { agentId: number; agentUserId: number },
): Promise<PanelTargetCheck> {
  const tx = getDb();
  const close = async (reason: PanelTargetRefusal) => {
    await tx
      .update(adjudicationCases)
      .set({
        state: 'invalidated',
        closedAt: new Date(),
        invalidatedReason: reason satisfies InvalidatedReason,
      })
      .where(eq(adjudicationCases.id, kase.id));
    return { ok: false as const, reason };
  };

  // Nobody may adjudicate a proposition they cannot read: a target out of a
  // panelist's reach (its wiki page unpublished, say) closes the case.
  const live = await liveHydratedTarget(kase, viewer);
  if (!live) return close('target_unavailable');
  // The payload moved under the case: it is over, never migrated.
  if (live.targetVersion !== kase.targetVersion) return close('target_version_moved');
  const served = live as unknown as Record<string, unknown>;

  if (kase.adjudicatedTarget) {
    // A baseline moved under the panel: the seats may have read different
    // packets, so neither opinion can stand for the other.
    return sameServedTarget(kase.adjudicatedTarget.served, served)
      ? { ok: true, snapshot: kase.adjudicatedTarget }
      : close('target_drifted');
  }
  const parameter = await adjudicationTargetParameter(kase.targetType, kase.targetId);
  const openDisputes = mergeOpenDisputes(
    kase.t1Snapshot.openDisputes,
    await openDisputesOnVersion(kase),
  );
  const snapshot: AdjudicatedTarget = {
    served,
    sourceRow: await readTargetRow(kase.targetType, kase.targetId),
    comparison: {
      canonicalUnit: parameter?.canonicalUnit ?? null,
      molecularWeight: parameter?.molecularWeight ?? null,
    },
    decidedDisputes: await decidedDisputesOn(kase.targetType, kase.targetId),
    lowerTier: {
      t2Verdicts: kase.t2Snapshot,
      t1Verdicts: kase.t1Snapshot.verdicts,
      openDisputes,
    },
    context: {
      triggers: kase.triggers,
      triggerDetail: kase.triggerDetail as Record<string, unknown>,
      disputeOrigin: disputeOriginOf(openDisputes),
    },
  };
  await tx
    .update(adjudicationCases)
    .set({ adjudicatedTarget: snapshot })
    .where(eq(adjudicationCases.id, kase.id));
  return { ok: true, snapshot };
}
