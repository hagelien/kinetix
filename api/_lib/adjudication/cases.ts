/**
 * T3 adjudication cases: opening, invalidating and seating
 * (docs/plans/2026-09-18-t3-adjudication-backend.md §3.1–§3.3, §3.6).
 *
 * A case is a durable, version-pinned record. It opens through the detector
 * (./detector.ts) only, at verdict time and from the sweep, and is never
 * edited to a new version: a target that moves invalidates its live case and
 * re-enters detection as a different (target, version) key. The key is
 * permanent, so a version is adjudicated at most once however often the sweep
 * re-reads a standing trigger.
 *
 * Everything that reads the lower-tier verdicts does so under
 * `lockVerificationSourceRow`, the lock every verdict write takes first, so a
 * case's snapshots are one consistent cut of the appeal record.
 */

import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { getDb, inTransaction } from '../db.js';
import {
  adjudicationCaseSeats,
  adjudicationCases,
  adjudicationDetectorChecks,
  adjudicationOpinions,
  agentVerifications,
  agents,
  disputes,
  users,
  type AdjudicationDisputeSnapshot,
  type AdjudicationSeat,
  type AdjudicationTrigger,
  type AgentVerificationEvidenceRef,
  type AgentVerificationTargetType,
} from '../../../db/schema.js';
import {
  lockVerificationSourceRow,
  verificationTargetVersion,
} from '../verification-targets.js';
import { ACTIVE_AGENT_ROLES } from '../agent-verifications.js';
import { contributionAuthorUserId } from '../notifications.js';
import { FLAGSHIP_TIER } from '../../../src/lib/modelTiers.js';
import { classifyAdjudicationCase, disputeOriginOf } from './detector.js';
import { bindPanelTarget } from './snapshot.js';

/**
 * The open disputes about one version of a target. A person's dispute
 * survives an in-place revision bound to the version it was raised against; it
 * says nothing about the revised payload a case on the new version
 * adjudicates. A legacy dispute with no recorded version cannot be placed, so
 * it is kept: the safe reading where a person's authority is at stake.
 *
 * Read under the target's source-row lock by every T3 writer that acts on
 * them — the detector, a seat claim and the seal — so a dispute filed a
 * moment earlier is never missed.
 */
export async function openDisputesOnVersion(args: {
  targetType: string;
  targetId: number;
  targetVersion: string;
}) {
  return getDb()
    .select({
      id: disputes.id,
      source: disputes.source,
      createdBy: disputes.createdBy,
      reasonMd: disputes.reasonMd,
      evidenceRefs: disputes.evidenceRefs,
      createdAt: disputes.createdAt,
    })
    .from(disputes)
    .where(
      and(
        eq(disputes.targetType, args.targetType),
        eq(disputes.targetId, args.targetId),
        eq(disputes.status, 'open'),
        or(eq(disputes.targetVersion, args.targetVersion), isNull(disputes.targetVersion)),
      ),
    )
    .orderBy(asc(disputes.id));
}

/** States a case can still act in; the rest are terminal. */
export const LIVE_CASE_STATES = ['open', 'sealed'] as const;

/**
 * Why a case was closed without a decision. `target_version_moved`: the
 * payload changed under it. `disagreement_withdrawn`: before the panel
 * finished, the disagreement it rested on went away on the same version (a
 * dispute withdrawn in the control phase, a verdict changed) — the case
 * opened on a disagreement that did not survive, so the panel must not get it.
 */
export type InvalidatedReason =
  | 'target_version_moved'
  | 'disagreement_withdrawn'
  // The version is unchanged but the target can no longer be served to a
  // panelist (a wiki page unpublished under it, say): nobody may adjudicate
  // a proposition they cannot read.
  | 'target_unavailable'
  // The version is unchanged but what the target is compared against (a
  // current value, entry or content served beside it) moved under the panel,
  // so its seats may have read different packets (./snapshot.ts).
  | 'target_drifted';

export type DetectOutcome = {
  /** Live cases on this target closed because the target moved under them. */
  invalidated: number;
  /** The current version's case, if any. */
  caseId: number | null;
  result:
    | 'opened'
    | 'reopened'
    | 'joined'
    | 'unchanged'
    | 'retired'
    | 'terminal'
    | 'none';
};

/** Merge disputes by id, keeping the case's own copies and adding new ones. */
function mergeDisputes(
  kept: readonly AdjudicationDisputeSnapshot[],
  seen: readonly AdjudicationDisputeSnapshot[],
): AdjudicationDisputeSnapshot[] {
  const ids = new Set(kept.map((d) => d.disputeId));
  return [...kept, ...seen.filter((d) => !ids.has(d.disputeId))];
}

/**
 * Re-evaluate one target: invalidate any live case pinned to a version the
 * target has moved past, then open, update or retire the case for its
 * current version as the detector now reads it.
 */
export async function detectAdjudicationCase(args: {
  targetType: AgentVerificationTargetType;
  targetId: number;
}): Promise<DetectOutcome> {
  return inTransaction(async () => {
    const tx = getDb();
    await lockVerificationSourceRow(tx, args.targetType, args.targetId);
    const version = await verificationTargetVersion(args, tx);
    const now = new Date();

    // A moved (or vanished) target ends every live case pinned elsewhere. The
    // case is never carried to the new version: the panel adjudicated that
    // payload, and a different one is a different case.
    const invalidatedRows = await tx
      .update(adjudicationCases)
      .set({
        state: 'invalidated',
        closedAt: now,
        invalidatedReason: 'target_version_moved' satisfies InvalidatedReason,
        lastCheckedAt: now,
      })
      .where(
        and(
          eq(adjudicationCases.targetType, args.targetType),
          eq(adjudicationCases.targetId, args.targetId),
          inArray(adjudicationCases.state, [...LIVE_CASE_STATES]),
          version === null
            ? sql`true`
            : ne(adjudicationCases.targetVersion, version),
        ),
      )
      .returning({ id: adjudicationCases.id });
    const invalidated = invalidatedRows.length;

    const activity = await tx.execute<{ at: string | Date | null }>(sql`
      select greatest(
        (select max(updated_at) from agent_verifications
          where target_type = ${args.targetType} and target_id = ${args.targetId}),
        (select max(updated_at) from disputes
          where target_type = ${args.targetType} and target_id = ${args.targetId})
      ) as at
    `);
    const at = activity.rows[0]?.at ?? null;
    const activityAt = at === null ? null : new Date(at);
    const recordCheck = () =>
      tx
        .insert(adjudicationDetectorChecks)
        .values({ ...args, checkedAt: now, activityAt })
        .onConflictDoUpdate({
          target: [adjudicationDetectorChecks.targetType, adjudicationDetectorChecks.targetId],
          set: { checkedAt: now, activityAt },
        });

    if (version === null) {
      await recordCheck();
      return { invalidated, caseId: null, result: 'none' };
    }

    const verdicts = await tx
      .select({
        id: agentVerifications.id,
        agentId: agentVerifications.agentId,
        verdict: agentVerifications.verdict,
        rationaleMd: agentVerifications.rationaleMd,
        evidenceRefs: agentVerifications.evidenceRefs,
        verifierTier: agentVerifications.verifierTier,
        model: agentVerifications.model,
        isImplicit: agentVerifications.isImplicit,
        recordedAt: agentVerifications.updatedAt,
      })
      .from(agentVerifications)
      .where(
        and(
          eq(agentVerifications.targetType, args.targetType),
          eq(agentVerifications.targetId, args.targetId),
        ),
      )
      .orderBy(asc(agentVerifications.id));
    const openDisputes = await openDisputesOnVersion({
      targetType: args.targetType,
      targetId: args.targetId,
      targetVersion: version,
    });
    // Decided disputes across every version: the correction loop is exactly
    // the cycles a proposition went through on its way to this version.
    const [decided] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(disputes)
      .where(
        and(
          eq(disputes.targetType, args.targetType),
          eq(disputes.targetId, args.targetId),
          eq(disputes.status, 'resolved'),
          inArray(disputes.resolution, ['upheld', 'rejected']),
        ),
      );

    const detected = classifyAdjudicationCase({
      verdicts: verdicts.map((v) => ({
        ...v,
        evidenceRefs: (v.evidenceRefs ?? []) as AgentVerificationEvidenceRef[],
      })),
      openDisputes,
      decidedDisputeCount: Number(decided?.n ?? 0),
    });

    const [existing] = await tx
      .select({
        id: adjudicationCases.id,
        state: adjudicationCases.state,
        invalidatedReason: adjudicationCases.invalidatedReason,
        triggers: adjudicationCases.triggers,
        triggerDetail: adjudicationCases.triggerDetail,
        t1Snapshot: adjudicationCases.t1Snapshot,
      })
      .from(adjudicationCases)
      .where(
        and(
          eq(adjudicationCases.targetType, args.targetType),
          eq(adjudicationCases.targetId, args.targetId),
          eq(adjudicationCases.targetVersion, version),
        ),
      )
      .for('update');

    let outcome: DetectOutcome;
    if (!detected) {
      // The disagreement is gone on this version. A case the panel has not
      // finished retires; a sealed one keeps its record.
      if (existing && existing.state === 'open') {
        await tx
          .update(adjudicationCases)
          .set({
            state: 'invalidated',
            closedAt: now,
            invalidatedReason: 'disagreement_withdrawn' satisfies InvalidatedReason,
            lastCheckedAt: now,
          })
          .where(eq(adjudicationCases.id, existing.id));
        outcome = { invalidated, caseId: existing.id, result: 'retired' };
      } else {
        outcome = { invalidated, caseId: existing?.id ?? null, result: 'none' };
      }
    } else if (!existing) {
      const [opened] = await tx
        .insert(adjudicationCases)
        .values({
          targetType: args.targetType,
          targetId: args.targetId,
          targetVersion: version,
          triggers: detected.triggers,
          triggerDetail: detected.triggerDetail,
          disputeOrigin: detected.disputeOrigin,
          t2VerificationId: detected.t2VerificationId,
          t2Snapshot: detected.t2Snapshot,
          t1Snapshot: detected.t1Snapshot,
          lastCheckedAt: now,
        })
        .onConflictDoNothing({
          target: [
            adjudicationCases.targetType,
            adjudicationCases.targetId,
            adjudicationCases.targetVersion,
          ],
        })
        .returning({ id: adjudicationCases.id });
      outcome = opened
        ? { invalidated, caseId: opened.id, result: 'opened' }
        : { invalidated, caseId: null, result: 'none' };
    } else if ((LIVE_CASE_STATES as readonly string[]).includes(existing.state)) {
      // A live case takes on what has appeared since: a new trigger code, and
      // any dispute raised on this version since it opened. The origin is
      // recomputed over every dispute the case has seen, so a person's later
      // dispute makes the case theirs to close — it never narrows back to
      // `agent`. The verdict snapshots stay those the case opened on.
      const known = new Set<AdjudicationTrigger>(existing.triggers ?? []);
      const added = detected.triggers.filter((t) => !known.has(t));
      const openDisputesSeen = mergeDisputes(
        existing.t1Snapshot.openDisputes,
        detected.t1Snapshot.openDisputes,
      );
      const newDisputes =
        openDisputesSeen.length > existing.t1Snapshot.openDisputes.length;
      const triggerDetail = { ...(existing.triggerDetail ?? {}) };
      for (const t of added) {
        if (t in detected.triggerDetail) triggerDetail[t] = detected.triggerDetail[t];
      }
      await tx
        .update(adjudicationCases)
        .set({
          lastCheckedAt: now,
          ...(added.length > 0
            ? { triggers: [...(existing.triggers ?? []), ...added], triggerDetail }
            : {}),
          ...(newDisputes
            ? {
                t1Snapshot: { ...existing.t1Snapshot, openDisputes: openDisputesSeen },
                disputeOrigin: disputeOriginOf(openDisputesSeen),
              }
            : {}),
        })
        .where(eq(adjudicationCases.id, existing.id));
      outcome = {
        invalidated,
        caseId: existing.id,
        result: added.length > 0 || newDisputes ? 'joined' : 'unchanged',
      };
    } else if (
      existing.state === 'invalidated' &&
      existing.invalidatedReason === ('disagreement_withdrawn' satisfies InvalidatedReason) &&
      !(await caseHasOpinions(existing.id))
    ) {
      // The disagreement came back on the same version before anyone
      // adjudicated it. Nothing was decided, so this is the same case again,
      // on a fresh cut of the record; its seats are released because the
      // conflict set may have changed.
      await tx.delete(adjudicationCaseSeats).where(eq(adjudicationCaseSeats.caseId, existing.id));
      await tx
        .update(adjudicationCases)
        .set({
          state: 'open',
          closedAt: null,
          invalidatedReason: null,
          triggers: detected.triggers,
          triggerDetail: detected.triggerDetail,
          disputeOrigin: detected.disputeOrigin,
          t2VerificationId: detected.t2VerificationId,
          t2Snapshot: detected.t2Snapshot,
          t1Snapshot: detected.t1Snapshot,
          lastCheckedAt: now,
        })
        .where(eq(adjudicationCases.id, existing.id));
      outcome = { invalidated, caseId: existing.id, result: 'reopened' };
    } else {
      // That version has been adjudicated (or abandoned mid-panel): never again.
      outcome = { invalidated, caseId: existing.id, result: 'terminal' };
    }
    await recordCheck();
    return outcome;
  });
}

async function caseHasOpinions(caseId: number): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: adjudicationOpinions.id })
    .from(adjudicationOpinions)
    .where(eq(adjudicationOpinions.caseId, caseId))
    .limit(1);
  return row !== undefined;
}

export interface AdjudicationSweepResult {
  checked: number;
  opened: number[];
  joined: number[];
  retired: number[];
  invalidated: number;
}

/**
 * The backstop for the verdict-time detector. Two windows, each of which
 * drains rather than re-reading one prefix:
 *
 * - live cases, least recently checked first — so a target that moved is
 *   eventually reached even when nobody verdicts it again;
 * - targets where blind T2 has spoken and a disagreement is on record, whose
 *   verdict/dispute activity is newer than the detector last saw (or that it
 *   never checked), oldest first.
 *
 * Idempotent: the permanent case key makes a re-read a no-op.
 */
export async function sweepAdjudicationCases(
  limit = 50,
): Promise<AdjudicationSweepResult> {
  const db = getDb();
  const live = await db
    .select({
      targetType: adjudicationCases.targetType,
      targetId: adjudicationCases.targetId,
    })
    .from(adjudicationCases)
    .where(inArray(adjudicationCases.state, [...LIVE_CASE_STATES]))
    .orderBy(sql`${adjudicationCases.lastCheckedAt} asc nulls first`, asc(adjudicationCases.id))
    .limit(limit);

  const candidates = (
    await db.execute<{ target_type: string; target_id: number }>(sql`
      with activity as (
        select av.target_type, av.target_id,
          greatest(
            max(av.updated_at),
            (select max(d.updated_at) from disputes d
              where d.target_type = av.target_type and d.target_id = av.target_id)
          ) as activity_at
        from agent_verifications av
        where exists (
            select 1 from agent_verifications f
            where f.target_type = av.target_type and f.target_id = av.target_id
              and f.is_implicit = false and f.verifier_tier = ${FLAGSHIP_TIER}
          )
          and (
            exists (
              select 1 from agent_verifications dv
              where dv.target_type = av.target_type and dv.target_id = av.target_id
                and dv.is_implicit = false and dv.verdict = 'dispute'
            )
            or exists (
              select 1 from disputes od
              where od.target_type = av.target_type and od.target_id = av.target_id
                and od.status = 'open'
            )
          )
        group by av.target_type, av.target_id
      )
      select a.target_type, a.target_id
      from activity a
      left join adjudication_detector_checks c
        on c.target_type = a.target_type and c.target_id = a.target_id
      where c.target_id is null
        or c.activity_at is null
        or a.activity_at > c.activity_at
      order by a.activity_at asc
      limit ${limit}
    `)
  ).rows.map((r) => ({ targetType: r.target_type, targetId: Number(r.target_id) }));

  const seen = new Set<string>();
  const result: AdjudicationSweepResult = {
    checked: 0,
    opened: [],
    joined: [],
    retired: [],
    invalidated: 0,
  };
  for (const t of [...live, ...candidates]) {
    const key = `${t.targetType}:${t.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const outcome = await detectAdjudicationCase({
        targetType: t.targetType as AgentVerificationTargetType,
        targetId: t.targetId,
      });
      result.checked += 1;
      result.invalidated += outcome.invalidated;
      if (outcome.caseId === null) continue;
      if (outcome.result === 'opened' || outcome.result === 'reopened') {
        result.opened.push(outcome.caseId);
      } else if (outcome.result === 'joined') {
        result.joined.push(outcome.caseId);
      } else if (outcome.result === 'retired') {
        result.retired.push(outcome.caseId);
      }
    } catch (err) {
      // One bad target must not stop the sweep.
      console.error(
        `[adjudication] detection failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}

export type ClaimSeatResult =
  | { ok: true; seat: AdjudicationSeat; alreadySeated: boolean }
  | {
      ok: false;
      reason:
        | 'case_not_found'
        | 'case_not_open'
        | 'not_eligible'
        | 'conflicted'
        | 'target_unavailable'
        | 'target_drifted'
        | 'target_version_moved'
        | 'panel_full';
    };

/**
 * Agents who cannot sit on this case's panel: everyone whose verdict it rests
 * on, every agent identity behind a dispute it rests on (a dispute can be
 * opened without a verdict), and the agent that authored the target — the
 * panel reviews their work, so it cannot include them.
 */
export async function conflictedAgentIds(kase: {
  targetType: string;
  targetId: number;
  t1Snapshot: { verdicts: { agentId: number }[]; openDisputes: { createdBy: number }[] };
  t2Snapshot: { agentId: number }[];
}): Promise<Set<number>> {
  const conflicted = new Set<number>([
    ...kase.t2Snapshot.map((v) => v.agentId),
    ...kase.t1Snapshot.verdicts.map((v) => v.agentId),
  ]);
  const userIds = new Set<number>(kase.t1Snapshot.openDisputes.map((d) => d.createdBy));
  const author = await contributionAuthorUserId({
    targetType: kase.targetType,
    targetId: kase.targetId,
  });
  if (author !== null) userIds.add(author);
  if (userIds.size > 0) {
    const rows = await getDb()
      .select({ id: agents.id })
      .from(agents)
      .where(inArray(agents.userId, [...userIds]));
    for (const r of rows) conflicted.add(r.id);
  }
  return conflicted;
}

/**
 * Take a free seat on an open case, before any case content is served (§3.2).
 *
 * Eligible: an active agent whose backing user holds an active role, with the
 * server-owned `adjudicator` grant AND the flagship tier — being flagship
 * alone grants nothing — and no part in the case (`conflictedAgentIds`).
 *
 * The claim takes the tier's lock order — the target's source row, then the
 * case row — so two adjudicators racing take turns, and a dispute filed on the
 * target serializes with it: the conflict check re-reads the version's open
 * disputes under that lock, not only the case's snapshot, so an agent that
 * disputed the target after the detector last refreshed the case cannot sit
 * on its own appeal. The unique indexes on (case, seat) and (case, agent) are
 * the backstop. The agent row is held FOR SHARE so an admin revoking the grant
 * serializes with it. Re-claiming returns the caller's existing seat. The
 * claim also binds the panel to one hydrated target (./snapshot.ts): the first
 * copies it onto the case, and a target that cannot be served or has drifted
 * since closes the case instead of seating anyone.
 */
export async function claimAdjudicationSeat(args: {
  caseId: number;
  agentId: number;
}): Promise<ClaimSeatResult> {
  const [peek] = await getDb()
    .select({ targetType: adjudicationCases.targetType, targetId: adjudicationCases.targetId })
    .from(adjudicationCases)
    .where(eq(adjudicationCases.id, args.caseId));
  if (!peek) return { ok: false, reason: 'case_not_found' };

  return inTransaction(async () => {
    const tx = getDb();
    await lockVerificationSourceRow(tx, peek.targetType, peek.targetId);
    const [kase] = await tx
      .select({
        id: adjudicationCases.id,
        targetType: adjudicationCases.targetType,
        targetId: adjudicationCases.targetId,
        targetVersion: adjudicationCases.targetVersion,
        state: adjudicationCases.state,
        t1Snapshot: adjudicationCases.t1Snapshot,
        t2Snapshot: adjudicationCases.t2Snapshot,
        adjudicatedTarget: adjudicationCases.adjudicatedTarget,
      })
      .from(adjudicationCases)
      .where(eq(adjudicationCases.id, args.caseId))
      .for('update');
    if (!kase) return { ok: false, reason: 'case_not_found' };

    const [agent] = await tx
      .select({ id: agents.id, userId: agents.userId })
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
    if (!agent) return { ok: false, reason: 'not_eligible' };

    const [mine] = await tx
      .select({ seat: adjudicationCaseSeats.seat })
      .from(adjudicationCaseSeats)
      .where(
        and(
          eq(adjudicationCaseSeats.caseId, args.caseId),
          eq(adjudicationCaseSeats.agentId, args.agentId),
        ),
      );
    if (mine) return { ok: true, seat: mine.seat, alreadySeated: true };
    if (kase.state !== 'open') return { ok: false, reason: 'case_not_open' };

    const openNow = await openDisputesOnVersion(kase);
    const conflicted = await conflictedAgentIds({
      ...kase,
      t1Snapshot: {
        ...kase.t1Snapshot,
        openDisputes: [...kase.t1Snapshot.openDisputes, ...openNow],
      },
    });
    if (conflicted.has(args.agentId)) return { ok: false, reason: 'conflicted' };

    const taken = await tx
      .select({ seat: adjudicationCaseSeats.seat })
      .from(adjudicationCaseSeats)
      .where(eq(adjudicationCaseSeats.caseId, args.caseId));
    const takenSeats = new Set(taken.map((s) => s.seat));
    const free = (['a', 'b'] as const).find((s) => !takenSeats.has(s));
    if (!free) return { ok: false, reason: 'panel_full' };

    // Bind the panel to one hydrated target before any content is served:
    // the first claim copies it onto the case, a later one checks it still
    // holds (./snapshot.ts).
    const bound = await bindPanelTarget(kase, { agentId: agent.id, agentUserId: agent.userId });
    if (!bound.ok) return { ok: false, reason: bound.reason };

    const [inserted] = await tx
      .insert(adjudicationCaseSeats)
      .values({ caseId: args.caseId, seat: free, agentId: args.agentId })
      .onConflictDoNothing()
      .returning({ seat: adjudicationCaseSeats.seat });
    if (!inserted) return { ok: false, reason: 'panel_full' };
    return { ok: true, seat: inserted.seat, alreadySeated: false };
  });
}

/**
 * The calling agent, when it may act as an adjudicator now: active, its
 * backing user in an active role, the `adjudicator` grant AND the flagship
 * tier. `null` for a user who backs no agent at all (a person), and
 * `not_eligible` for an agent that lacks any of it.
 */
export async function resolveAdjudicator(
  userId: number,
): Promise<{ agentId: number; userId: number } | 'not_eligible' | null> {
  const [row] = await getDb()
    .select({
      agentId: agents.id,
      status: agents.status,
      adjudicator: agents.adjudicator,
      modelTier: agents.modelTier,
      role: users.role,
    })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .where(eq(agents.userId, userId));
  if (!row) return null;
  const eligible =
    row.status === 'active' &&
    row.adjudicator &&
    row.modelTier === FLAGSHIP_TIER &&
    ACTIVE_AGENT_ROLES.includes(row.role);
  return eligible ? { agentId: row.agentId, userId } : 'not_eligible';
}
