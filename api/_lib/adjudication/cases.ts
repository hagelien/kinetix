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

import { and, asc, desc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { getDb, inTransaction } from '../db.js';
import {
  adjudicationCaseSeats,
  adjudicationCases,
  agentVerifications,
  agents,
  disputes,
  users,
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
import { FLAGSHIP_TIER } from '../../../src/lib/modelTiers.js';
import { classifyAdjudicationCase } from './detector.js';

/** States a case can still act in; the rest are terminal. */
export const LIVE_CASE_STATES = ['open', 'sealed'] as const;

export type DetectOutcome = {
  /** Live cases on this target closed because the target moved under them. */
  invalidated: number;
  /** What happened to the current version's case, if any. */
  caseId: number | null;
  result: 'opened' | 'joined' | 'unchanged' | 'terminal' | 'none';
};

/**
 * Re-evaluate one target: invalidate any live case pinned to a version the
 * target has moved past, then open (or join) the case for its current version
 * when the detector says one exists.
 */
export async function detectAdjudicationCase(args: {
  targetType: AgentVerificationTargetType;
  targetId: number;
}): Promise<DetectOutcome> {
  return inTransaction(async () => {
    const tx = getDb();
    await lockVerificationSourceRow(tx, args.targetType, args.targetId);
    const version = await verificationTargetVersion(args, tx);

    // A moved (or vanished) target ends every live case pinned elsewhere. The
    // case is never carried to the new version: the panel adjudicated that
    // payload, and a different one is a different case.
    const invalidatedRows = await tx
      .update(adjudicationCases)
      .set({
        state: 'invalidated',
        closedAt: new Date(),
        invalidatedReason: 'target_version_moved',
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
    if (version === null) return { invalidated, caseId: null, result: 'none' };

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
    const openDisputes = await tx
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
        ),
      )
      .orderBy(asc(disputes.id));
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
    if (!detected) return { invalidated, caseId: null, result: 'none' };

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
      })
      .onConflictDoNothing({
        target: [
          adjudicationCases.targetType,
          adjudicationCases.targetId,
          adjudicationCases.targetVersion,
        ],
      })
      .returning({ id: adjudicationCases.id });
    if (opened) return { invalidated, caseId: opened.id, result: 'opened' };

    // This version already has its case. A later trigger joins a live one —
    // the snapshots stay those the case opened on — and does nothing to a
    // terminal one: that version has been adjudicated.
    const [existing] = await tx
      .select({
        id: adjudicationCases.id,
        state: adjudicationCases.state,
        triggers: adjudicationCases.triggers,
        triggerDetail: adjudicationCases.triggerDetail,
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
    if (!existing) return { invalidated, caseId: null, result: 'none' };
    if (!(LIVE_CASE_STATES as readonly string[]).includes(existing.state)) {
      return { invalidated, caseId: existing.id, result: 'terminal' };
    }
    const known = new Set<AdjudicationTrigger>(existing.triggers ?? []);
    const added = detected.triggers.filter((t) => !known.has(t));
    if (added.length === 0) {
      return { invalidated, caseId: existing.id, result: 'unchanged' };
    }
    const triggerDetail = { ...(existing.triggerDetail ?? {}) };
    for (const t of added) {
      if (t in detected.triggerDetail) triggerDetail[t] = detected.triggerDetail[t];
    }
    await tx
      .update(adjudicationCases)
      .set({ triggers: [...(existing.triggers ?? []), ...added], triggerDetail })
      .where(eq(adjudicationCases.id, existing.id));
    return { invalidated, caseId: existing.id, result: 'joined' };
  });
}

export interface AdjudicationSweepResult {
  checked: number;
  opened: number[];
  joined: number[];
  invalidated: number;
}

/**
 * The backstop for the verdict-time detector: re-check every live case (so a
 * moved target invalidates even when nobody verdicts it again) and every
 * target where blind T2 has spoken and a disagreement is on record, newest
 * first. Idempotent — the permanent case key makes a re-read a no-op.
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
    .orderBy(asc(adjudicationCases.openedAt))
    .limit(limit);

  const disputeVerdict = db
    .select({ one: sql`1` })
    .from(sql`${agentVerifications} as dv`)
    .where(
      sql`dv.target_type = ${agentVerifications.targetType}
        and dv.target_id = ${agentVerifications.targetId}
        and dv.is_implicit = false
        and dv.verdict = 'dispute'`,
    );
  const openDispute = db
    .select({ one: sql`1` })
    .from(disputes)
    .where(
      and(
        eq(disputes.targetType, agentVerifications.targetType),
        eq(disputes.targetId, agentVerifications.targetId),
        eq(disputes.status, 'open'),
      ),
    );
  const candidates = await db
    .select({
      targetType: agentVerifications.targetType,
      targetId: agentVerifications.targetId,
    })
    .from(agentVerifications)
    .where(
      and(
        eq(agentVerifications.isImplicit, false),
        eq(agentVerifications.verifierTier, FLAGSHIP_TIER),
        or(sql`exists ${disputeVerdict}`, sql`exists ${openDispute}`),
      ),
    )
    .groupBy(agentVerifications.targetType, agentVerifications.targetId)
    .orderBy(desc(sql`max(${agentVerifications.updatedAt})`))
    .limit(limit);

  const seen = new Set<string>();
  const result: AdjudicationSweepResult = {
    checked: 0,
    opened: [],
    joined: [],
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
      if (outcome.result === 'opened' && outcome.caseId !== null) {
        result.opened.push(outcome.caseId);
      } else if (outcome.result === 'joined' && outcome.caseId !== null) {
        result.joined.push(outcome.caseId);
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
        | 'panel_full';
    };

/**
 * Take a free seat on an open case, before any case content is served (§3.2).
 *
 * Eligible: an active agent whose backing user holds an active role, with the
 * server-owned `adjudicator` grant AND the flagship tier — being flagship
 * alone grants nothing. An agent whose verdict the case rests on is
 * conflicted: the panel reviews the lower tiers, so it cannot include them.
 *
 * The case row is locked for the claim, so two adjudicators racing take turns;
 * the unique indexes on (case, seat) and (case, agent) are the backstop. The
 * agent row is held FOR SHARE so an admin revoking the grant serializes with
 * it. Re-claiming returns the caller's existing seat.
 */
export async function claimAdjudicationSeat(args: {
  caseId: number;
  agentId: number;
}): Promise<ClaimSeatResult> {
  return inTransaction(async () => {
    const tx = getDb();
    const [kase] = await tx
      .select({
        id: adjudicationCases.id,
        state: adjudicationCases.state,
        t1Snapshot: adjudicationCases.t1Snapshot,
        t2Snapshot: adjudicationCases.t2Snapshot,
      })
      .from(adjudicationCases)
      .where(eq(adjudicationCases.id, args.caseId))
      .for('update');
    if (!kase) return { ok: false, reason: 'case_not_found' };

    const [agent] = await tx
      .select({ id: agents.id })
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

    const lowerTierAgents = new Set<number>([
      ...kase.t2Snapshot.map((v) => v.agentId),
      ...kase.t1Snapshot.verdicts.map((v) => v.agentId),
    ]);
    if (lowerTierAgents.has(args.agentId)) return { ok: false, reason: 'conflicted' };

    const taken = await tx
      .select({ seat: adjudicationCaseSeats.seat })
      .from(adjudicationCaseSeats)
      .where(eq(adjudicationCaseSeats.caseId, args.caseId));
    const takenSeats = new Set(taken.map((s) => s.seat));
    const free = (['a', 'b'] as const).find((s) => !takenSeats.has(s));
    if (!free) return { ok: false, reason: 'panel_full' };

    const [inserted] = await tx
      .insert(adjudicationCaseSeats)
      .values({ caseId: args.caseId, seat: free, agentId: args.agentId })
      .onConflictDoNothing()
      .returning({ seat: adjudicationCaseSeats.seat });
    if (!inserted) return { ok: false, reason: 'panel_full' };
    return { ok: true, seat: inserted.seat, alreadySeated: false };
  });
}
