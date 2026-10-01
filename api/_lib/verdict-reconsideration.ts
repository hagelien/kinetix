/**
 * The control phase after a blind dispute (issue #1357).
 *
 * Peer verification is blind: the queue hides every other verdict so each one
 * is an independent measurement, and that stays. The cost is that a plain
 * misreading — a dispute of something the proposal never claimed — used to be
 * correctable only by a moderator, because the disputer never saw the peers
 * who had already explained the point. A dispute blocks consensus on its own,
 * so every such misreading parked a correct edit for a human.
 *
 * This module adds one sanctioned second look, AFTER the blind verdict is on
 * record:
 *
 *   1. The blind verdict is recorded as before (POST /api/agent-verifications).
 *   2. Once that dispute stands against at least one explicit peer approval,
 *      its author may read the other reviewers' rationales
 *      ({@link discloseForReconsideration}). That read is recorded, with a
 *      snapshot of the blind verdict, and freezes the agent's verdict.
 *   3. It then either maintains the dispute with an addendum, or withdraws it
 *      ({@link reconsiderDispute}). The original blind verdict is copied,
 *      unchanged, into `agent_verdict_reconsiderations`.
 *   4. A maintained dispute keeps blocking and goes on to T3/the moderator
 *      exactly as before, now carrying the addendum.
 *
 * A withdrawal turns the live verdict into `abstain`, never `approve`: an
 * agent that has read its peers is no longer an independent measurement, so
 * it may stop objecting but may not add to the tally. Consensus then rests on
 * the independent approvals that were already there. For the same reason the
 * agent cannot post a fresh verdict on the same target version afterwards
 * ({@link frozenLiveVerdictId}); a revision of the target starts
 * a clean, blind round.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, gt, ne, or, sql } from "drizzle-orm";
import { getDb, inTransaction } from "./db.js";
import {
  lockVerificationSourceRow,
  verificationTargetVersion,
} from "./verification-targets.js";
import {
  agents,
  agentVerdictReconsiderations,
  agentVerifications,
  disputes,
  type AgentVerificationEvidenceRef,
  type AgentVerificationTargetType,
} from "../../db/schema.js";

export const RECONSIDERATION_OUTCOMES = ["maintain", "withdraw"] as const;
export type ReconsiderationOutcome = (typeof RECONSIDERATION_OUTCOMES)[number];

/** Most items one GET returns; each needs a version read and a hydration. */
export const RECONSIDERATION_LIST_LIMIT = 20;

export interface PeerVerdict {
  id: number;
  verdict: string;
  rationaleMd: string;
  evidenceRefs: AgentVerificationEvidenceRef[];
  verifierTier: string | null;
  recordedAt: string;
}

/**
 * What the audit row keeps about each peer verdict: what was shown, plus who
 * produced it. The live peer rows can be deleted (a revision clears every
 * verdict on a pending edit), so the identity has to be copied, not linked.
 * The identity is stored only — the agent is shown the verdicts, not whose.
 */
export interface PeerVerdictSnapshot extends PeerVerdict {
  agentId: number;
  model: string | null;
}

/** The shown part of a snapshot. */
function shownPeerVerdict({ agentId: _a, model: _m, ...shown }: PeerVerdictSnapshot): PeerVerdict {
  return shown;
}

export interface ReconsiderationCandidate {
  verificationId: number;
  targetType: AgentVerificationTargetType;
  targetId: number;
  targetVersion: string;
  yourVerdict: {
    rationaleMd: string;
    evidenceRefs: AgentVerificationEvidenceRef[];
    recordedAt: string;
  };
  peerVerdicts: PeerVerdict[];
  /** Echo on POST: binds the decision to exactly these peer verdicts. */
  peerDigest: string;
}

/**
 * A fingerprint of the peer verdicts as served. The POST must echo it, and the
 * write recomputes it under the source-row lock: a peer that re-verdicted in
 * between (or a caller that never fetched the list) is refused rather than
 * recorded as having read something it did not.
 */
export function peerVerdictDigest(peers: PeerVerdict[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        peers.map((p) => [
          p.id,
          p.verdict,
          p.rationaleMd,
          p.evidenceRefs,
          p.verifierTier,
          p.recordedAt,
        ]),
      ),
    )
    .digest("hex");
}

/** Why a reconsideration was refused; the route maps each to an HTTP answer. */
export type ReconsiderationRefusal =
  | "stale"
  | "not_disputed"
  | "no_conflict"
  | "peers_changed"
  | "not_listed"
  | "already_reconsidered";

export class ReconsiderationRefusedError extends Error {
  constructor(readonly reason: ReconsiderationRefusal) {
    super(`reconsideration refused: ${reason}`);
    this.name = "ReconsiderationRefusedError";
  }
}

type Db = ReturnType<typeof getDb>;

/** Every other agent's explicit verdict on the target, oldest first. */
async function peerVerdictsFor(
  db: Db,
  args: { agentId: number; targetType: string; targetId: number },
): Promise<PeerVerdictSnapshot[]> {
  const rows = await db
    .select({
      id: agentVerifications.id,
      agentId: agentVerifications.agentId,
      model: agentVerifications.model,
      verdict: agentVerifications.verdict,
      rationaleMd: agentVerifications.rationaleMd,
      evidenceRefs: agentVerifications.evidenceRefs,
      verifierTier: agentVerifications.verifierTier,
      updatedAt: agentVerifications.updatedAt,
    })
    .from(agentVerifications)
    .where(
      and(
        eq(agentVerifications.targetType, args.targetType),
        eq(agentVerifications.targetId, args.targetId),
        ne(agentVerifications.agentId, args.agentId),
        eq(agentVerifications.isImplicit, false),
      ),
    )
    .orderBy(asc(agentVerifications.updatedAt), asc(agentVerifications.id));
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    model: r.model,
    verdict: r.verdict,
    rationaleMd: r.rationaleMd,
    evidenceRefs: r.evidenceRefs ?? [],
    verifierTier: r.verifierTier,
    recordedAt: r.updatedAt.toISOString(),
  }));
}

/**
 * Candidate rows scanned across every page of one call, at most. A dispute
 * whose target has become unreadable (its version moved, or the payload is no
 * longer visible) is filtered out only after this query runs — see #1386 —
 * so a single starved row must not make a call scan without bound. Ten times
 * the page size clears a realistic run of starved rows while keeping one call
 * a handful of round trips.
 */
const RECONSIDERATION_SCAN_PAGE_SIZE = RECONSIDERATION_LIST_LIMIT;
const RECONSIDERATION_SCAN_LIMIT = RECONSIDERATION_LIST_LIMIT * 10;

interface ReconsiderationCandidateRow {
  targetType: string;
  targetId: number;
  disputeVersion: string | null;
  updatedAt: Date;
  id: number;
}

/** One page of {@link listReconsiderationCandidates}'s query, oldest first. */
async function reconsiderationCandidateRows(
  db: Db,
  args: { agentId: number; agentUserId: number; limit: number },
  after: { updatedAt: Date; id: number } | null,
): Promise<ReconsiderationCandidateRow[]> {
  return db
    .select({
      targetType: agentVerifications.targetType,
      targetId: agentVerifications.targetId,
      disputeVersion: disputes.targetVersion,
      updatedAt: agentVerifications.updatedAt,
      id: agentVerifications.id,
    })
    .from(agentVerifications)
    .innerJoin(
      disputes,
      and(
        eq(disputes.targetType, agentVerifications.targetType),
        eq(disputes.targetId, agentVerifications.targetId),
        eq(disputes.createdBy, args.agentUserId),
        eq(disputes.status, "open"),
      ),
    )
    .where(
      and(
        eq(agentVerifications.agentId, args.agentId),
        eq(agentVerifications.verdict, "dispute"),
        eq(agentVerifications.isImplicit, false),
        sql`exists (
          select 1 from ${agentVerifications} peer
          where peer.target_type = ${agentVerifications.targetType}
            and peer.target_id = ${agentVerifications.targetId}
            and peer.agent_id <> ${args.agentId}
            and peer.verdict = 'approve'
            and peer.is_implicit = false
        )`,
        sql`not exists (
          select 1 from ${agentVerdictReconsiderations} r
          where r.agent_id = ${args.agentId}
            and r.target_type = ${agentVerifications.targetType}
            and r.target_id = ${agentVerifications.targetId}
            and r.target_version = ${disputes.targetVersion}
            and r.outcome <> ${DISCLOSED}
        )`,
        after
          ? or(
              gt(agentVerifications.updatedAt, after.updatedAt),
              and(
                eq(agentVerifications.updatedAt, after.updatedAt),
                gt(agentVerifications.id, after.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(asc(agentVerifications.updatedAt), asc(agentVerifications.id))
    .limit(args.limit);
}

/**
 * The caller's disputes that may be opened for a second look: its explicit
 * `dispute` verdict still stands, the mirrored dispute is still open and bound
 * to the target's current version, at least one other agent has explicitly
 * approved, and the caller has not already decided on this version. Keys only
 * — nothing about the peers is read here; {@link discloseForReconsideration}
 * does that, and records that it did.
 *
 * Paginates past rows the current-version check below rejects (#1386):
 * selecting only `limit` rows and then filtering, as a single query did
 * before, let the oldest starved candidate occupy that slot on every request
 * forever — with the default `limit=20` every later, still-valid candidate
 * was then starved out of the list permanently. This keeps fetching
 * subsequent pages, oldest-first, until `limit` valid candidates are
 * collected or {@link RECONSIDERATION_SCAN_LIMIT} rows have been scanned.
 *
 * `accept` is a caller-side visibility check (the payload must still be
 * servable). A candidate it rejects does not count toward `limit` either: the
 * scan pages past it exactly as it does a stale version, so one invisible row
 * whose version is still current — say a disputed wiki revision whose page
 * went back to draft — cannot starve the live candidates behind it (issue
 * 1395).
 */
export async function listReconsiderationCandidates(args: {
  agentId: number;
  agentUserId: number;
  limit?: number;
  accept?: (candidate: {
    targetType: AgentVerificationTargetType;
    targetId: number;
    targetVersion: string;
  }) => Promise<boolean>;
}): Promise<
  Array<{
    targetType: AgentVerificationTargetType;
    targetId: number;
    targetVersion: string;
  }>
> {
  const db = getDb();
  const limit = Math.min(
    args.limit ?? RECONSIDERATION_LIST_LIMIT,
    RECONSIDERATION_LIST_LIMIT,
  );

  const out: Array<{
    targetType: AgentVerificationTargetType;
    targetId: number;
    targetVersion: string;
  }> = [];
  // Keyset cursor on the same (updatedAt, id) order the query returns,
  // advanced past every row read so far — valid or not — so a starved row is
  // never reselected by a later page within this call.
  let cursor: { updatedAt: Date; id: number } | null = null;
  let scanned = 0;

  while (out.length < limit && scanned < RECONSIDERATION_SCAN_LIMIT) {
    const rows = await reconsiderationCandidateRows(
      db,
      {
        agentId: args.agentId,
        agentUserId: args.agentUserId,
        // Fixed scan batch, not the response limit (#1396): `?limit=1` must
        // not turn a long run of stale rows into one round trip per row.
        limit: RECONSIDERATION_SCAN_PAGE_SIZE,
      },
      cursor,
    );

    if (rows.length === 0) break;
    scanned += rows.length;
    const last = rows[rows.length - 1]!;
    cursor = { updatedAt: last.updatedAt, id: last.id };

    for (const row of rows) {
      if (out.length >= limit) break;
      const targetType = row.targetType as AgentVerificationTargetType;
      const current = await verificationTargetVersion({
        targetType,
        targetId: row.targetId,
      });
      // A dispute bound to an older payload is not reconsidered — the target
      // moved, so the verdict is due a fresh blind round, not a second look.
      if (!current || current !== row.disputeVersion) continue;
      const candidate = {
        targetType,
        targetId: row.targetId,
        targetVersion: current,
      };
      if (args.accept && !(await args.accept(candidate))) continue;
      out.push(candidate);
    }
  }
  return out;
}

/** Outcome of a row whose peers were shown but no decision was made yet. */
export const DISCLOSED = "disclosed";

/** Shared pre-conditions, re-checked under the source-row lock. */
async function lockOpenDispute(
  tx: Db,
  args: {
    agentId: number;
    agentUserId: number;
    targetType: AgentVerificationTargetType;
    targetId: number;
    targetVersion: string;
  },
) {
  // Source row first — the order every writer of these tables takes.
  await lockVerificationSourceRow(tx, args.targetType, args.targetId);
  const current = await verificationTargetVersion(
    { targetType: args.targetType, targetId: args.targetId },
    tx,
  );
  if (current !== args.targetVersion) {
    throw new ReconsiderationRefusedError("stale");
  }
  const [own] = await tx
    .select({
      id: agentVerifications.id,
      verdict: agentVerifications.verdict,
      rationaleMd: agentVerifications.rationaleMd,
      evidenceRefs: agentVerifications.evidenceRefs,
      verifierTier: agentVerifications.verifierTier,
      recordedVerifierTier: agentVerifications.recordedVerifierTier,
      model: agentVerifications.model,
      isImplicit: agentVerifications.isImplicit,
      updatedAt: agentVerifications.updatedAt,
    })
    .from(agentVerifications)
    .where(
      and(
        eq(agentVerifications.agentId, args.agentId),
        eq(agentVerifications.targetType, args.targetType),
        eq(agentVerifications.targetId, args.targetId),
      ),
    )
    .limit(1)
    .for("update");
  if (!own || own.verdict !== "dispute" || own.isImplicit) {
    throw new ReconsiderationRefusedError("not_disputed");
  }
  const [openDispute] = await tx
    .select({ id: disputes.id, targetVersion: disputes.targetVersion })
    .from(disputes)
    .where(
      and(
        eq(disputes.targetType, args.targetType),
        eq(disputes.targetId, args.targetId),
        eq(disputes.createdBy, args.agentUserId),
        eq(disputes.status, "open"),
      ),
    )
    .limit(1)
    .for("update");
  // No open dispute means a moderator already ruled (or it was withdrawn);
  // one bound to another version objects to content that is gone.
  if (!openDispute || openDispute.targetVersion !== current) {
    throw new ReconsiderationRefusedError("not_disputed");
  }
  const peers = await peerVerdictsFor(tx, {
    agentId: args.agentId,
    targetType: args.targetType,
    targetId: args.targetId,
  });
  if (!peers.some((p) => p.verdict === "approve")) {
    throw new ReconsiderationRefusedError("no_conflict");
  }
  return { own, openDispute, peers };
}

/**
 * Show the caller its peers on one disputed target, and record that it was
 * shown. The disclosure row is written in the same transaction that reads the
 * peers, under the source-row lock, and it snapshots the caller's own verdict
 * as it stood at that instant: that snapshot — not whatever the live row says
 * later — is the original blind verdict. From this point the agent is no
 * longer blind on this version, so POST /api/agent-verifications refuses any
 * new verdict from it ({@link frozenLiveVerdictId}); its only way
 * forward is the reconsideration POST.
 *
 * Disclosing again before deciding refreshes the peer set the decision is
 * bound to (peers may have moved) but never the caller's own verdict; every
 * set shown is appended to `peer_disclosures`, so none of it is lost. Throws
 * {@link ReconsiderationRefusedError} when the item is not open (it moved,
 * was ruled on, has no peer approval, or was already decided).
 */
export async function discloseForReconsideration(args: {
  agentId: number;
  agentUserId: number;
  targetType: AgentVerificationTargetType;
  targetId: number;
  targetVersion: string;
}): Promise<ReconsiderationCandidate> {
  return inTransaction(async () => {
    const tx = getDb();
    const { own, peers } = await lockOpenDispute(tx, args);
    const disclosure = { disclosedAt: new Date().toISOString(), peerVerdicts: peers };
    const [row] = await tx
      .insert(agentVerdictReconsiderations)
      .values({
        verificationId: own.id,
        agentId: args.agentId,
        targetType: args.targetType,
        targetId: args.targetId,
        targetVersion: args.targetVersion,
        originalVerdict: own.verdict,
        originalRationaleMd: own.rationaleMd,
        originalEvidenceRefs: (own.evidenceRefs ?? []) as never,
        // The tier the blind verdict was written under, not the effective
        // tier a later demotion may have restamped it to.
        originalVerifierTier: own.recordedVerifierTier ?? own.verifierTier,
        originalModel: own.model,
        originalRecordedAt: own.updatedAt,
        outcome: DISCLOSED,
        addendumMd: "",
        peerVerdicts: peers as never,
        peerDisclosures: [disclosure] as never,
      })
      .onConflictDoUpdate({
        target: [
          agentVerdictReconsiderations.agentId,
          agentVerdictReconsiderations.targetType,
          agentVerdictReconsiderations.targetId,
          agentVerdictReconsiderations.targetVersion,
        ],
        // The latest set is what the decision is bound to; every set shown
        // is appended, never replaced, since the agent read them all.
        set: {
          peerVerdicts: peers as never,
          peerDisclosures: sql`${agentVerdictReconsiderations.peerDisclosures} || ${JSON.stringify([disclosure])}::jsonb`,
        },
        setWhere: sql`${agentVerdictReconsiderations.outcome} = ${DISCLOSED}`,
      })
      .returning();
    if (!row) throw new ReconsiderationRefusedError("already_reconsidered");
    return {
      verificationId: own.id,
      targetType: args.targetType,
      targetId: args.targetId,
      targetVersion: args.targetVersion,
      yourVerdict: {
        rationaleMd: row.originalRationaleMd,
        evidenceRefs: row.originalEvidenceRefs ?? [],
        recordedAt: row.originalRecordedAt.toISOString(),
      },
      peerVerdicts: peers.map(shownPeerVerdict),
      peerDigest: peerVerdictDigest(peers),
    };
  });
}

/** Live rationale after a withdrawal: the addendum first, the blind text kept below. */
export function withdrawnRationale(original: string, addendum: string): string {
  return [
    "**Innsigelsen er trukket etter kontrollfasen.**",
    addendum.trim(),
    "---",
    "**Opprinnelig blind innsigelse:**",
    original.trim(),
  ].join("\n\n");
}

/** Live rationale after a maintained dispute: the blind text, then the addendum. */
export function maintainedRationale(
  original: string,
  addendum: string,
): string {
  return [
    original.trim(),
    "---",
    "**Tillegg etter kontrollfasen (innsigelsen opprettholdes):**",
    addendum.trim(),
  ].join("\n\n");
}

/**
 * Record the caller's second look at one of its disputes. Everything is
 * re-checked under the source-row lock, so a revision, a moderator ruling or a
 * peer withdrawal that lands after the GET cannot be reconsidered against.
 */
export async function reconsiderDispute(args: {
  agentId: number;
  agentUserId: number;
  targetType: AgentVerificationTargetType;
  targetId: number;
  targetVersion: string;
  outcome: ReconsiderationOutcome;
  addendumMd: string;
  /** The `peerDigest` of the list the caller read (see peerVerdictDigest). */
  peerDigest: string;
  /** Model id the agent decided under; may differ from the blind verdict's. */
  model: string;
}): Promise<{
  reconsiderationId: number;
  verificationId: number;
  model: string | null;
  outcome: "maintained" | "withdrawn";
  rationaleMd: string;
}> {
  return inTransaction(async () => {
    const tx = getDb();
    const { own, openDispute, peers } = await lockOpenDispute(tx, args);

    const [disclosure] = await tx
      .select()
      .from(agentVerdictReconsiderations)
      .where(
        and(
          eq(agentVerdictReconsiderations.agentId, args.agentId),
          eq(agentVerdictReconsiderations.targetType, args.targetType),
          eq(agentVerdictReconsiderations.targetId, args.targetId),
          eq(agentVerdictReconsiderations.targetVersion, args.targetVersion),
        ),
      )
      .limit(1)
      .for("update");
    // A decision must follow a disclosure: without one the server never
    // recorded what the agent was shown, or what its blind verdict was.
    if (!disclosure) throw new ReconsiderationRefusedError("not_listed");
    if (disclosure.outcome !== DISCLOSED) {
      throw new ReconsiderationRefusedError("already_reconsidered");
    }
    // The decision is bound to the peers the agent was last shown, and those
    // must still be the peers now.
    if (
      peerVerdictDigest(disclosure.peerVerdicts as PeerVerdict[]) !==
        args.peerDigest ||
      peerVerdictDigest(peers) !== args.peerDigest
    ) {
      throw new ReconsiderationRefusedError("peers_changed");
    }

    // The server-owned tier the decision is made under. Read without a row
    // lock on purpose: `agents` is locked before `agent_verifications` by the
    // tier-restamp path, and this transaction already holds the verdict row,
    // so a FOR UPDATE here could deadlock with it. A concurrent demotion still
    // wins on the live row — its restamp waits for this commit, then rewrites
    // the tier — and this snapshot records the tier as it was when decided.
    const [agentRow] = await tx
      .select({ tier: agents.modelTier })
      .from(agents)
      .where(eq(agents.id, args.agentId))
      .limit(1);
    const decisionTier = agentRow?.tier ?? null;

    const decidedAt = new Date();
    await tx
      .update(agentVerdictReconsiderations)
      .set({
        outcome: args.outcome === "withdraw" ? "withdrawn" : "maintained",
        addendumMd: args.addendumMd.trim(),
        decisionModel: args.model,
        decisionVerifierTier: decisionTier,
        decidedAt,
      })
      .where(eq(agentVerdictReconsiderations.id, disclosure.id));
    const inserted = { id: disclosure.id };

    const now = new Date();
    const recorded = {
      reconsiderationId: inserted.id,
      verificationId: own.id,
      // The live row now carries the decision, so it is attributed to the
      // model that made it (the blind verdict's stays in original_model).
      model: args.model,
    };
    if (args.outcome === "withdraw") {
      const rationale = withdrawnRationale(
        disclosure.originalRationaleMd,
        args.addendumMd,
      );
      await tx
        .update(agentVerifications)
        .set({
          verdict: "abstain",
          rationaleMd: rationale,
          model: args.model,
          verifierTier: decisionTier,
          updatedAt: now,
        })
        .where(eq(agentVerifications.id, own.id));
      await tx
        .update(disputes)
        .set({
          status: "resolved",
          resolution: "withdrawn",
          resolvedBy: args.agentUserId,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(disputes.id, openDispute.id));
      return {
        ...recorded,
        outcome: "withdrawn" as const,
        rationaleMd: rationale,
      };
    }

    const rationale = maintainedRationale(
      disclosure.originalRationaleMd,
      args.addendumMd,
    );
    await tx
      .update(agentVerifications)
      .set({
        rationaleMd: rationale,
        model: args.model,
        verifierTier: decisionTier,
        updatedAt: now,
      })
      .where(eq(agentVerifications.id, own.id));
    await tx
      .update(disputes)
      .set({ reasonMd: rationale, updatedAt: now })
      .where(eq(disputes.id, openDispute.id));
    return {
      ...recorded,
      outcome: "maintained" as const,
      rationaleMd: rationale,
    };
  });
}

/**
 * The agent's live verdict on this target, if it has been frozen by a
 * disclosure — i.e. the agent has been shown its peers while holding it.
 *
 * Keyed on the verdict row, not the target version. A status-only resubmit
 * (`{status: 'pending'}`) bumps the version but keeps every verdict and the
 * payload, so a version key would hand an agent that has read its peers a
 * fresh, non-blind vote on unchanged content. A real revision instead deletes
 * the verdict rows (`clearVerificationsForTarget`), which lifts the freeze by
 * construction: the agent's next verdict is a new row, judged blind.
 */
export async function frozenLiveVerdictId(args: {
  agentId: number;
  targetType: string;
  targetId: number;
}): Promise<number | null> {
  const db = getDb();
  const [row] = await db
    .select({ id: agentVerifications.id })
    .from(agentVerifications)
    .innerJoin(
      agentVerdictReconsiderations,
      eq(agentVerdictReconsiderations.verificationId, agentVerifications.id),
    )
    .where(
      and(
        eq(agentVerifications.agentId, args.agentId),
        eq(agentVerifications.targetType, args.targetType),
        eq(agentVerifications.targetId, args.targetId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}
