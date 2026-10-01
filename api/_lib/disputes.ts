/**
 * Helpers for the `disputes` table — the unified, human- AND agent-authored
 * record that a target (fact / parameter / revision / pending edit) is
 * contested.
 *
 * Bridge model (see docs/superpowers/specs/2026-06-23-unified-disputes.md):
 * agent dispute *verdicts* still live in `agent_verifications` and still drive
 * consensus auto-apply unchanged. The agent-verifications POST handler
 * additionally mirrors each agent dispute into a row here (source='agent'),
 * and withdraws that mirror when the same agent later flips to approve/abstain.
 * So `disputes` is the single source of truth for "what is currently
 * contested" — the deterministic feed agents poll, the consensus block for
 * human disputes, and the trigger for notifications.
 */

import { and, asc, desc, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { getDb, inTransaction } from './db.js';
import {
  agentVerdictReconsiderations,
  agentVerifications,
  agents,
  disputes,
  users,
  type AgentVerificationEvidenceRef,
  type DisputeResolution,
  type DisputeSource,
  type DisputeTargetType,
} from '../../db/schema.js';
import {
  lockVerificationSourceRow,
  verificationTargetVersion,
} from './verification-targets.js';
import { DISCLOSED } from './verdict-reconsideration.js';

/**
 * The target moved between the caller's version check and the dispute write.
 *
 * Thrown rather than returned so a caller that forgets to look cannot open
 * the dispute anyway; the route maps it to the same 409 its own pre-check
 * raises.
 */
export class StaleDisputeTargetError extends Error {
  constructor(readonly expected: string, readonly actual: string | null) {
    super(`target moved since it was read: '${expected}' -> '${actual ?? 'gone'}'`);
    this.name = 'StaleDisputeTargetError';
  }
}

/**
 * The agent verdict a mirror write was meant to represent is no longer a live
 * explicit `dispute` (deleted by a revision, or flipped to approve/abstain by
 * a concurrent request). Thrown from {@link upsertOpenDispute} so the mirror
 * is skipped rather than recreating a dispute the agent already withdrew.
 */
export class DisputeVerdictGoneError extends Error {
  constructor(readonly verificationId: number) {
    super(`agent verdict ${verificationId} is no longer a live dispute`);
    this.name = 'DisputeVerdictGoneError';
  }
}

export interface DisputeFeedItem {
  id: number;
  targetType: DisputeTargetType;
  targetId: number;
  source: DisputeSource;
  reasonMd: string;
  evidenceRefs: AgentVerificationEvidenceRef[];
  status: string;
  createdAt: string;
  updatedAt: string;
  /** When the digest escalated it for being overdue (#1233); null if not. */
  escalatedAt: string | null;
  createdBy: number;
  author: {
    id: number;
    name: string | null;
    role: string | null;
    agentSlug: string | null;
  } | null;
}

/**
 * Upsert one OPEN dispute per (author, target). Re-disputing the same target
 * updates the existing open row (refreshing reason/evidence) rather than
 * stacking duplicates — matching the partial unique index. Returns the row id
 * and whether it was a fresh insert (so callers can fan out a notification only
 * on the first raise, not on every edit).
 *
 * `targetVersion` is the caller's belief about the target's current
 * `verificationTargetVersion` (what they read before writing the objection).
 * Re-checked here, inside a transaction that holds the source row, the same
 * way `recordVerification`'s `expectTargetVersion` closes the check-then-act
 * window between a route's pre-check and its write (#1321): without it, a
 * revision landing in that window would be admitted, and the row would carry
 * `created_at` as its only anchor — insensitive to exactly the revision it
 * should have caught. A mismatch throws {@link StaleDisputeTargetError}
 * rather than silently opening the dispute against content its author never
 * described.
 */
export async function upsertOpenDispute(args: {
  targetType: DisputeTargetType;
  targetId: number;
  createdBy: number;
  /** Plain `string`, like `targetType` above: the column is an unparameterized
   *  varchar, so narrowing it here would be a cast, not a check. */
  source: string;
  reasonMd: string;
  evidenceRefs?: AgentVerificationEvidenceRef[];
  targetVersion: string;
  /**
   * An agent verdict row this write mirrors. When set, that row is locked
   * (`FOR UPDATE`, after the source row) and must still be an explicit
   * `dispute`, else {@link DisputeVerdictGoneError} is thrown — so a concurrent
   * approve/abstain that already withdrew the dispute cannot be undone by a
   * stale mirror (issue 1401).
   */
  requireLiveDisputeVerdictId?: number;
}): Promise<{ id: number; inserted: boolean }> {
  return inTransaction(async () => {
    const tx = getDb();
    // Source row first, matching every other writer that re-checks a target
    // version under lock (recordVerification, the upheld-return path).
    await lockVerificationSourceRow(tx, args.targetType, args.targetId);
    if (args.requireLiveDisputeVerdictId !== undefined) {
      const [live] = await tx
        .select({ id: agentVerifications.id })
        .from(agentVerifications)
        .where(
          and(
            eq(agentVerifications.id, args.requireLiveDisputeVerdictId),
            eq(agentVerifications.verdict, 'dispute'),
            eq(agentVerifications.isImplicit, false),
          ),
        )
        .for('update');
      if (!live) throw new DisputeVerdictGoneError(args.requireLiveDisputeVerdictId);
    }
    const actual = await verificationTargetVersion(
      { targetType: args.targetType, targetId: args.targetId },
      tx,
    );
    if (actual !== args.targetVersion) {
      throw new StaleDisputeTargetError(args.targetVersion, actual);
    }

    const now = new Date();
    const [row] = await tx
      .insert(disputes)
      .values({
        targetType: args.targetType,
        targetId: args.targetId,
        createdBy: args.createdBy,
        source: args.source,
        reasonMd: args.reasonMd,
        evidenceRefs: (args.evidenceRefs ?? []) as never,
        targetVersion: args.targetVersion,
        status: 'open',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [disputes.targetType, disputes.targetId, disputes.createdBy],
        targetWhere: sql`${disputes.status} = 'open'`,
        set: {
          reasonMd: args.reasonMd,
          evidenceRefs: (args.evidenceRefs ?? []) as never,
          targetVersion: args.targetVersion,
          source: args.source,
          updatedAt: now,
        },
      })
      .returning({ id: disputes.id, createdAt: disputes.createdAt });
    const inserted = row?.createdAt
      ? Math.abs(row.createdAt.getTime() - now.getTime()) < 1000
      : false;
    return { id: row?.id ?? 0, inserted };
  });
}

/**
 * Resolve an author's open dispute on a target without a moderator action —
 * used by the agent bridge when an agent flips its verdict away from dispute.
 * No-op when there is no open row. Returns the number of rows closed.
 */
export async function withdrawOpenDispute(args: {
  targetType: DisputeTargetType;
  targetId: number;
  createdBy: number;
}): Promise<number> {
  const db = getDb();
  const closed = await db
    .update(disputes)
    .set({
      status: 'resolved',
      resolution: 'withdrawn',
      resolvedBy: args.createdBy,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(disputes.targetType, args.targetType),
        eq(disputes.targetId, args.targetId),
        eq(disputes.createdBy, args.createdBy),
        eq(disputes.status, 'open'),
      ),
    )
    .returning({ id: disputes.id });
  return closed.length;
}

/**
 * Retract every **agent-sourced** open dispute on a target because the content
 * they contest no longer exists — the submitter revised the payload, so the
 * mirrored verdicts were wiped (`clearVerificationsForTarget`).
 *
 * Without this, a revision left the state inconsistent and the edit stuck: the
 * dispute *verdict* was gone (so the verifier could re-judge the new content)
 * while the mirrored `disputes` row stayed open forever, and an open dispute
 * blocks consensus auto-apply and floats the row to the top of /review no
 * matter how good the revision was. Only a moderator could clear it, which is
 * exactly the wait the "revise in place" loop exists to avoid.
 *
 * Human disputes are deliberately left open: a person contested this target on
 * purpose and a moderator closes that, not a submitter's edit.
 *
 * Each row is attributed to its own author (`resolved_by = created_by`),
 * matching the withdrawal the agent would have posted itself. Returns the
 * number of rows closed.
 */
export async function withdrawAgentDisputesForTarget(args: {
  targetType: DisputeTargetType;
  targetId: number;
}): Promise<number> {
  const db = getDb();
  const closed = await db
    .update(disputes)
    .set({
      status: 'resolved',
      resolution: 'withdrawn',
      resolvedBy: sql`${disputes.createdBy}`,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(disputes.targetType, args.targetType),
        eq(disputes.targetId, args.targetId),
        eq(disputes.source, 'agent'),
        eq(disputes.status, 'open'),
      ),
    )
    .returning({ id: disputes.id });
  return closed.length;
}

/**
 * Close one dispute by id with an explicit resolution. Returns the row, or null.
 *
 * The row carries its `reasonMd` / `evidenceRefs` / `source` back to the
 * caller because an `upheld` ruling now acts on them: the objection's own
 * words become the return note on the pending edit it was ruled against
 * (`returnPendingEditForUpheldDispute`), so the resolution and the text it
 * sustains come out of the same statement rather than a second read that
 * could see a different row. `createdAt` comes back with them because the
 * return also has to know *when* the objection was raised, to refuse a
 * payload revised after it — and `targetVersion` (#1327), which the return
 * path now prefers for that check since, unlike `createdAt`, it moves when
 * the dispute's own author refreshes it against a later revision.
 */
export async function resolveDisputeById(args: {
  id: number;
  resolution: DisputeResolution;
  resolvedBy: number;
}): Promise<{
  id: number;
  targetType: string;
  targetId: number;
  createdBy: number;
  /**
   * Plain `string`, like `targetType` above: the column is an unparameterized
   * varchar, so narrowing it here would be a cast rather than a check.
   */
  source: string;
  reasonMd: string;
  evidenceRefs: AgentVerificationEvidenceRef[];
  /** When the objection was raised — untouched by the resolution. */
  createdAt: Date | null;
  /**
   * The dispute row's own captured version (#1321/#1327), refreshed when its
   * author re-disputes; null for a row written before that column existed.
   */
  targetVersion: string | null;
} | null> {
  return inTransaction(async () => {
    const db = getDb();
    // Lock the target's source row before touching the dispute row itself.
    // `recordVerification`, `upsertOpenDispute` and the reconsideration path
    // (`lockOpenDispute`) all lock the source row first and the dispute row
    // second; this was the one writer still taking the opposite order, which
    // let an upheld ruling here (which goes on to lock the same pending
    // edit's source row in `returnPendingEditForUpheldDispute`, inside the
    // same caller transaction) deadlock against a concurrent reconsideration
    // on the same target (#1385). `targetType`/`targetId` never change on an
    // existing dispute row, so reading them unlocked first is safe — the
    // lookup can go stale only by the row no longer being `open`, which the
    // update below still re-checks. `inTransaction` joins the caller's
    // transaction when there is one (the upheld path) and opens its own
    // otherwise, so the lock is always meaningful.
    const [target] = await db
      .select({ targetType: disputes.targetType, targetId: disputes.targetId })
      .from(disputes)
      .where(eq(disputes.id, args.id))
      .limit(1);
    if (target) {
      await lockVerificationSourceRow(db, target.targetType, target.targetId);
    }
    const [row] = await db
      .update(disputes)
      .set({
        status: 'resolved',
        resolution: args.resolution,
        resolvedBy: args.resolvedBy,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(disputes.id, args.id), eq(disputes.status, 'open')))
      .returning({
        id: disputes.id,
        targetType: disputes.targetType,
        targetId: disputes.targetId,
        createdBy: disputes.createdBy,
        source: disputes.source,
        reasonMd: disputes.reasonMd,
        evidenceRefs: disputes.evidenceRefs,
        createdAt: disputes.createdAt,
        targetVersion: disputes.targetVersion,
      });
    return row ?? null;
  });
}

/**
 * Which of `targetIds` (of one type) currently carry at least one OPEN dispute.
 * This is the consensus block + /review boost lookup, mirroring
 * `disputedTargetIdsForType` for agent_verifications but reading the unified
 * table so HUMAN disputes count too.
 */
export async function openDisputeTargetIds(args: {
  targetType: DisputeTargetType;
  targetIds: number[];
}): Promise<Set<number>> {
  if (args.targetIds.length === 0) return new Set();
  const db = getDb();
  const rows = await db
    .selectDistinct({ targetId: disputes.targetId })
    .from(disputes)
    .where(
      and(
        eq(disputes.targetType, args.targetType),
        eq(disputes.status, 'open'),
        inArray(disputes.targetId, args.targetIds),
      ),
    );
  return new Set(rows.map((r) => r.targetId));
}

/** True when the single target currently has any open dispute. */
export async function hasOpenDispute(args: {
  targetType: DisputeTargetType;
  targetId: number;
}): Promise<boolean> {
  const set = await openDisputeTargetIds({
    targetType: args.targetType,
    targetIds: [args.targetId],
  });
  return set.has(args.targetId);
}

/**
 * Deterministic dispute feed: every dispute in the given `status` (default
 * `open`), oldest-first (created_at ASC, id ASC as a stable tiebreaker),
 * optionally narrowed to one target type. The `open` feed is what agents poll
 * each cycle as their "notification" of what needs re-checking — ordering is
 * total and stable so successive polls walk the backlog deterministically.
 * The `resolved` feed exists only for a single target (see `targetId` below):
 * it lets an author recover the full row — reason and evidence — behind a
 * ruling that already closed it, since `resolved` disputes drop out of the
 * `open` feed entirely and would otherwise be unreachable once acted on.
 * Joined with author identity (human name or agent slug) for display.
 */
export async function listOpenDisputes(args: {
  status?: 'open' | 'resolved';
  targetType?: DisputeTargetType;
  /**
   * Narrow to a single target. This is what the /review card reads: a
   * moderator looking at one blocked edit needs the objection standing against
   * *that* edit — its reason, its author, its evidence — not the whole
   * backlog. Requires `targetType`, since target ids are per-type.
   */
  targetId?: number;
  limit: number;
  offset?: number;
}): Promise<DisputeFeedItem[]> {
  const db = getDb();
  const clauses = [eq(disputes.status, args.status ?? 'open')];
  if (args.targetType) clauses.push(eq(disputes.targetType, args.targetType));
  if (args.targetId !== undefined) {
    clauses.push(eq(disputes.targetId, args.targetId));
  }
  const where = clauses.length === 1 ? clauses[0] : and(...clauses);
  const rows = await db
    .select({
      id: disputes.id,
      targetType: disputes.targetType,
      targetId: disputes.targetId,
      source: disputes.source,
      reasonMd: disputes.reasonMd,
      evidenceRefs: disputes.evidenceRefs,
      status: disputes.status,
      createdAt: disputes.createdAt,
      updatedAt: disputes.updatedAt,
      escalatedAt: disputes.escalatedAt,
      createdBy: disputes.createdBy,
      authorName: users.displayName,
      authorRole: users.role,
      agentSlug: agents.slug,
    })
    .from(disputes)
    .leftJoin(users, eq(users.id, disputes.createdBy))
    .leftJoin(agents, eq(agents.userId, disputes.createdBy))
    .where(where)
    .orderBy(asc(disputes.createdAt), asc(disputes.id))
    .limit(args.limit)
    .offset(args.offset ?? 0);

  return rows.map((r) => ({
    id: r.id,
    targetType: r.targetType as DisputeTargetType,
    targetId: r.targetId,
    source: r.source as DisputeSource,
    reasonMd: r.reasonMd,
    evidenceRefs: (r.evidenceRefs ?? []) as AgentVerificationEvidenceRef[],
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    escalatedAt: r.escalatedAt ? r.escalatedAt.toISOString() : null,
    createdBy: r.createdBy,
    author: r.createdBy
      ? {
          id: r.createdBy,
          name: r.authorName ?? null,
          role: r.authorRole ?? null,
          agentSlug: r.agentSlug ?? null,
        }
      : null,
  }));
}

/**
 * Claim every open dispute created at or before `overdueBefore` that has not
 * been escalated yet, stamping `escalated_at = now`, and return the claimed
 * disputes oldest first (#1233).
 *
 * One conditional UPDATE is the claim: `escalated_at IS NULL` in the WHERE
 * makes it exclusive, so two overlapping runs split the overdue set between
 * them instead of both escalating it. The caller must record the escalation
 * (the admins' in-app rows) in the SAME transaction: `escalated_at` is both
 * the claim and the record that the admins were told, so it must never
 * commit alone.
 */
export async function claimOverdueDisputesForEscalation(args: {
  overdueBefore: Date;
  now: Date;
}): Promise<{ id: number; targetType: DisputeTargetType; targetId: number }[]> {
  const db = getDb();
  const rows = await db
    .update(disputes)
    .set({ escalatedAt: args.now })
    .where(
      and(
        eq(disputes.status, 'open'),
        isNull(disputes.escalatedAt),
        lte(disputes.createdAt, args.overdueBefore),
      ),
    )
    .returning({
      id: disputes.id,
      targetType: disputes.targetType,
      targetId: disputes.targetId,
      createdAt: disputes.createdAt,
    });
  return rows
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id)
    .map((r) => ({
      id: r.id,
      targetType: r.targetType as DisputeTargetType,
      targetId: r.targetId,
    }));
}

/**
 * Every dispute (open or resolved) across many targets of one type, grouped
 * by target id. `listOpenDisputes` answers "what's the backlog" or "what's
 * standing against this one target"; this answers "what was ever contested
 * here" for a batch — the edit-history dialog wants every human/agent
 * objection a revision drew, not just what's currently unresolved (#1358).
 */
export async function listDisputesForTargets(args: {
  targetType: DisputeTargetType;
  targetIds: number[];
}): Promise<Map<number, DisputeFeedItem[]>> {
  const ids = [...new Set(args.targetIds.filter(Number.isInteger))];
  if (ids.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({
      id: disputes.id,
      targetType: disputes.targetType,
      targetId: disputes.targetId,
      source: disputes.source,
      reasonMd: disputes.reasonMd,
      evidenceRefs: disputes.evidenceRefs,
      status: disputes.status,
      createdAt: disputes.createdAt,
      updatedAt: disputes.updatedAt,
      escalatedAt: disputes.escalatedAt,
      createdBy: disputes.createdBy,
      authorName: users.displayName,
      authorRole: users.role,
      agentSlug: agents.slug,
    })
    .from(disputes)
    .leftJoin(users, eq(users.id, disputes.createdBy))
    .leftJoin(agents, eq(agents.userId, disputes.createdBy))
    .where(
      and(
        eq(disputes.targetType, args.targetType),
        inArray(disputes.targetId, ids),
      ),
    )
    .orderBy(asc(disputes.createdAt), asc(disputes.id));

  const byTarget = new Map<number, DisputeFeedItem[]>();
  for (const r of rows) {
    const item: DisputeFeedItem = {
      id: r.id,
      targetType: r.targetType as DisputeTargetType,
      targetId: r.targetId,
      source: r.source as DisputeSource,
      reasonMd: r.reasonMd,
      evidenceRefs: (r.evidenceRefs ?? []) as AgentVerificationEvidenceRef[],
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    escalatedAt: r.escalatedAt ? r.escalatedAt.toISOString() : null,
      createdBy: r.createdBy,
      author: r.createdBy
        ? {
            id: r.createdBy,
            name: r.authorName ?? null,
            role: r.authorRole ?? null,
            agentSlug: r.agentSlug ?? null,
          }
        : null,
    };
    const list = byTarget.get(r.targetId);
    if (list) list.push(item);
    else byTarget.set(r.targetId, [item]);
  }
  return byTarget;
}

/**
 * How many agent `dispute` verdicts still stand *unanswered* on a target.
 *
 * A dispute verdict and its mirrored `disputes` row are two records of one
 * objection, and only the row can be closed — `agent_verifications` has no
 * status column, by design: a verdict is the agent's permanent testimony, not
 * a ticket. So a moderator who rules on the objection leaves the verdict
 * behind, and any check reading the raw verdict tally keeps blocking on an
 * objection that has already been decided, with nothing left in the UI to act
 * against. That dead end is what this counter exists to end.
 *
 * A verdict counts as answered when a moderator resolved a dispute the same
 * author raised on the same target *after* the verdict was recorded
 * (`resolved_at >= updated_at`). Ordering — not mere existence — is what makes
 * the answer specific: an agent that disputes again after a resolution opens a
 * fresh dispute row and bumps its verdict's `updated_at` past the old
 * resolution, so the new objection blocks again and is ruled on in its own
 * right.
 *
 * Authorship joins through `agents.user_id`: `disputes.created_by` is the
 * agent's backing user, while `agent_verifications.agent_id` is the agent row.
 */
export async function unresolvedDisputeVerdictCount(args: {
  targetType: DisputeTargetType;
  targetId: number;
}): Promise<number> {
  const counts = await unresolvedDisputeVerdictCounts({
    targetType: args.targetType,
    targetIds: [args.targetId],
  });
  return counts.get(args.targetId) ?? 0;
}

/**
 * Batch form of {@link unresolvedDisputeVerdictCount}, for list endpoints.
 *
 * The /review queue reads it for the same reason the block does: the raw
 * verdict tally never falls, so ranking and badging off it left an edit
 * pinned to the top of the queue under a red "Bestridt" long after a
 * moderator had overruled the objection — with no way to ever clear it,
 * since the verdict itself cannot be closed.
 */
export async function unresolvedDisputeVerdictCounts(args: {
  targetType: DisputeTargetType;
  targetIds: number[];
}): Promise<Map<number, number>> {
  const ids = args.targetIds.filter(Number.isInteger);
  if (ids.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({
      targetId: agentVerifications.targetId,
      count: sql<number>`count(*)::int`,
    })
    .from(agentVerifications)
    .leftJoin(agents, eq(agents.id, agentVerifications.agentId))
    .where(
      and(
        eq(agentVerifications.targetType, args.targetType),
        inArray(agentVerifications.targetId, ids),
        eq(agentVerifications.verdict, 'dispute'),
        eq(agentVerifications.isImplicit, false),
        sql`not exists (
          select 1 from ${disputes}
          where ${disputes.targetType} = ${agentVerifications.targetType}
            and ${disputes.targetId} = ${agentVerifications.targetId}
            and ${disputes.createdBy} = ${agents.userId}
            and ${disputes.status} = 'resolved'
            and ${disputes.resolvedAt} is not null
            and ${disputes.resolvedAt} >= ${agentVerifications.updatedAt}
        )`,
      ),
    )
    .groupBy(agentVerifications.targetId);

  const out = new Map<number, number>();
  for (const row of rows) out.set(row.targetId, row.count);
  return out;
}

/** What {@link upheldDisputeResolvedAt} reports for one target. */
export interface UpheldDisputeRuling {
  resolvedAt: Date;
  /**
   * The `target_version` captured on the upheld dispute row (#1321/#1324),
   * null for a row written before that column existed. See
   * {@link upheldRulingStands} for how this anchors the ruling to the
   * payload the objection actually described.
   */
  targetVersion: string | null;
}

/**
 * Every resolved `upheld` ruling per target, for targets that have one.
 *
 * Upholding is not the same act as overruling, and the difference has to
 * survive the resolution: `rejected` says the objection did not hold and the
 * proposal may proceed, while `upheld` says it did — the proposal is meant to
 * be returned, rejected or revised, not approved. Both close the row, so
 * "there is no open dispute" cannot tell them apart, and without this lookup
 * an author holding `review.edit.decideOwn` could sustain the objection
 * against their own edit and then approve it anyway.
 *
 * All rows, not just the latest-resolved one: a target can carry more than
 * one *independent* open dispute at a time — one per author, per the partial
 * unique index — and a moderator can resolve them in any order relative to
 * revisions. Picking only the most-recently-resolved row (via `DISTINCT ON`
 * or `MAX(resolved_at)`) can discard a ruling that still covers the current
 * payload in favor of a later-resolved one that describes an older version:
 * author B's dispute on V2 upheld first, author A's older dispute on V1
 * upheld afterward, and the V1 row — resolved later but stale — would hide
 * the still-standing V2 ruling (Codex security review on PR #1323). Every
 * upheld row has to be checked; {@link anyUpheldRulingStands} is what ORs
 * across them.
 */
export async function upheldDisputeResolvedAt(args: {
  targetType: DisputeTargetType;
  targetIds: number[];
}): Promise<Map<number, UpheldDisputeRuling[]>> {
  const ids = args.targetIds.filter(Number.isInteger);
  if (ids.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({
      targetId: disputes.targetId,
      resolvedAt: disputes.resolvedAt,
      targetVersion: disputes.targetVersion,
    })
    .from(disputes)
    .where(
      and(
        eq(disputes.targetType, args.targetType),
        inArray(disputes.targetId, ids),
        eq(disputes.status, 'resolved'),
        eq(disputes.resolution, 'upheld'),
      ),
    )
    .orderBy(disputes.targetId, desc(disputes.resolvedAt));

  const out = new Map<number, UpheldDisputeRuling[]>();
  for (const row of rows) {
    if (!row.resolvedAt) continue;
    const ruling: UpheldDisputeRuling = {
      resolvedAt:
        row.resolvedAt instanceof Date ? row.resolvedAt : new Date(row.resolvedAt),
      targetVersion: row.targetVersion,
    };
    const existing = out.get(row.targetId);
    if (existing) existing.push(ruling);
    else out.set(row.targetId, [ruling]);
  }
  return out;
}

/**
 * The `submittedAt` half of a `pending_edit`'s `verificationTargetVersion`
 * token (`<submittedAt ISO>|<status>` — see `verificationTargetVersion` in
 * verification-targets.ts). Exported for {@link upheldRulingStands} and for
 * `upheld-dispute-return.ts`'s own staleness check (#1327) — both need "was
 * the dispute's captured version from before or after the target's last
 * MATERIAL revision", and `submittedAt` moves on every resubmit (#592) while
 * `revisedAt` moves only on an actual content change, so this pulls out just
 * the half that lines up with `revisedAt`.
 */
export function pendingEditTargetVersionSubmittedAt(
  targetVersion: string | null | undefined,
): Date | null {
  if (!targetVersion) return null;
  const iso = targetVersion.split('|', 1)[0] ?? targetVersion;
  const parsed = new Date(iso);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Rebind every open dispute on a target to a fresh `targetVersion`, after a
 * request that left the payload byte-for-byte as it was.
 *
 * Exists for one caller: a pending edit's payload-identical resubmit
 * (`{status:'pending'}` with nothing else changed). That PATCH re-stamps
 * `submittedAt` — and so `verificationTargetVersion`, the `pending_edit`
 * token's `submittedAt` half — without revising a byte (#592). Left alone,
 * every open dispute on the edit falls out of sync with that token:
 * `listReconsiderationCandidates` reads the mismatch as "the target moved"
 * and drops the candidate, and the ordinary verification queue excludes it
 * too, since nothing cleared its verdict row. The dispute becomes reachable
 * only by a moderator, for a resubmit that never touched what it objects to
 * (#1388).
 *
 * A dispute already anchored before the target's last MATERIAL revision
 * (`revisedAt`) is left exactly as stale as it was: advancing it here would
 * silently clear the staleness `returnPendingEditForUpheldDispute`'s
 * `revised_since` check exists to catch (#1327) — the payload it objects to
 * would then read as current though nothing about it was actually revised.
 * Since the caller only ever reaches this from a request that left the
 * payload untouched, `revisedAt` cannot itself have moved this time: a
 * dispute already bound to current content stays bound to current content,
 * one already behind a revision stays behind it.
 *
 * A dispute with no parseable anchor of its own (a legacy row from before
 * migration 0126 added `targetVersion`, deliberately left nullable) is left
 * untouched too whenever `revisedAt` is set: its relationship to that
 * revision was never recorded, and defaulting a null anchor to "current" is
 * exactly the same silent-clear #1327 exists to catch, just for a row this
 * function cannot itself tell apart from one that predates the revision.
 *
 * A dispute whose author already completed a reconsideration
 * (`agent_verdict_reconsiderations`, outcome `maintained` — `withdrawn`
 * already closed the dispute row itself, so it is not in `open` at all)
 * bound to its CURRENT `targetVersion` is left untouched too: rebinding it
 * would desynchronize it from that completed row, and
 * `listReconsiderationCandidates`'s own exclusion (which matches on that
 * same equality) would then read the already-decided dispute as never
 * reconsidered and offer it again — an unbounded number of "one sanctioned
 * second look" rounds on content that never actually changed, each one
 * appending another addendum to the live rationale.
 */
export async function rebindOpenDisputesForUnrevisedResubmit(args: {
  targetType: DisputeTargetType;
  targetId: number;
  targetVersion: string;
  revisedAt: Date | null;
}): Promise<void> {
  const db = getDb();
  const open = await db
    .select({
      id: disputes.id,
      targetVersion: disputes.targetVersion,
      createdBy: disputes.createdBy,
    })
    .from(disputes)
    .where(
      and(
        eq(disputes.targetType, args.targetType),
        eq(disputes.targetId, args.targetId),
        eq(disputes.status, 'open'),
      ),
    );
  if (open.length === 0) return;
  const completed = await db
    .select({
      userId: agents.userId,
      targetVersion: agentVerdictReconsiderations.targetVersion,
    })
    .from(agentVerdictReconsiderations)
    .innerJoin(agents, eq(agents.id, agentVerdictReconsiderations.agentId))
    .where(
      and(
        eq(agentVerdictReconsiderations.targetType, args.targetType),
        eq(agentVerdictReconsiderations.targetId, args.targetId),
        ne(agentVerdictReconsiderations.outcome, DISCLOSED),
      ),
    );
  const alreadyReconsidered = new Set(
    completed.map((row) => `${row.userId}|${row.targetVersion}`),
  );
  const ids = open
    .filter((row) => {
      if (alreadyReconsidered.has(`${row.createdBy}|${row.targetVersion}`)) {
        return false;
      }
      if (!args.revisedAt) return true;
      const anchor = pendingEditTargetVersionSubmittedAt(row.targetVersion);
      return anchor !== null && anchor.getTime() >= args.revisedAt.getTime();
    })
    .map((row) => row.id);
  if (ids.length === 0) return;
  await db
    .update(disputes)
    .set({ targetVersion: args.targetVersion })
    .where(inArray(disputes.id, ids));
}

/**
 * True when an `upheld` ruling stands against the target's current payload —
 * i.e. a moderator sustained an objection to it and the payload has not been
 * revised since. `revisedAt` is the target's revision marker (for a pending
 * edit, `proposed_meta.revisedAt`); absent or unparseable, the ruling stands,
 * which is the safe direction — a missing marker means no revision is on
 * record, not that one happened.
 *
 * A revision can land on either side of the ruling, and only one of those is
 * safe to read off `resolvedAt` alone: if it lands AFTER the ruling,
 * `resolvedAt < revisedAt` already catches it. But a **human** dispute stays
 * open across a revision by design (`withdrawAgentDisputesForTarget`'s
 * docstring) — an objection raised against an earlier payload can sit
 * unrefreshed while the target moves on, and a moderator who later upholds
 * that same objection resolves AFTER the revision either way, so
 * `resolvedAt >= revisedAt` alone reads that as covering current content when
 * it never described it (#1321 review, PR #1323).
 *
 * `targetVersion` — the dispute row's own captured version, refreshed only
 * when its author re-disputes — answers this directly: it is at least as
 * recent as `resolvedAt` (a dispute cannot be resolved before it exists), so
 * comparing IT to `revisedAt` covers both directions in one check and
 * replaces the `resolvedAt` comparison rather than supplementing it. Rows
 * written before that column existed have no `targetVersion` to read and fall
 * back to the previous `resolvedAt`-based check.
 */
export function upheldRulingStands(args: {
  resolvedAt: Date | null | undefined;
  revisedAt: Date | string | null | undefined;
  targetVersion?: string | null;
}): boolean {
  if (!args.resolvedAt) return false;
  if (!args.revisedAt) return true;
  const revised = new Date(args.revisedAt);
  if (!Number.isFinite(revised.getTime())) return true;
  const disputeAnchor = pendingEditTargetVersionSubmittedAt(args.targetVersion);
  if (disputeAnchor) return disputeAnchor >= revised;
  return args.resolvedAt >= revised;
}

/**
 * True when ANY of a target's upheld rulings still stands against its
 * current payload. A target can carry more than one resolved-upheld row
 * (one per author who disputed it), and each is judged independently — a
 * later-resolved ruling that no longer applies must not hide an
 * earlier-resolved one that still does (Codex security review on #1323).
 */
export function anyUpheldRulingStands(args: {
  rulings: UpheldDisputeRuling[] | undefined;
  revisedAt: Date | string | null | undefined;
}): boolean {
  if (!args.rulings || args.rulings.length === 0) return false;
  return args.rulings.some((ruling) =>
    upheldRulingStands({
      resolvedAt: ruling.resolvedAt,
      revisedAt: args.revisedAt,
      targetVersion: ruling.targetVersion,
    }),
  );
}

/**
 * True when an upheld ruling still stands against this pending edit's current
 * payload — the edit has not been revised (`proposedMeta.revisedAt`, the
 * server-owned marker) since the objection it was ruled on.
 *
 * Agent consensus must refuse to publish such an edit (issue #1357). An uphold
 * returns the edit without clearing its verdicts, and a bare
 * `{status:'pending'}` resubmit keeps them; without this gate the retry sweep
 * would publish the exact payload a moderator just ruled against.
 */
export async function pendingEditUpheldRulingStands(
  pendingEditId: number,
  proposedMeta: unknown,
): Promise<boolean> {
  const raw =
    proposedMeta && typeof proposedMeta === 'object'
      ? (proposedMeta as Record<string, unknown>).revisedAt
      : undefined;
  return upheldDisputeStands({
    targetType: 'pending_edit',
    targetId: pendingEditId,
    revisedAt: typeof raw === 'string' ? raw : null,
  });
}

/** The single-target form of {@link anyUpheldRulingStands}. */
export async function upheldDisputeStands(args: {
  targetType: DisputeTargetType;
  targetId: number;
  revisedAt: Date | string | null | undefined;
}): Promise<boolean> {
  const map = await upheldDisputeResolvedAt({
    targetType: args.targetType,
    targetIds: [args.targetId],
  });
  return anyUpheldRulingStands({
    rulings: map.get(args.targetId),
    revisedAt: args.revisedAt,
  });
}
