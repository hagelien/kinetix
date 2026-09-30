/**
 * The shadow generic review queue (Phase 5 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * Phase 2 deliberately did *not* build this. It built a reconciler instead, on
 * the grounds that two copies of an eligibility rule is how one audience starts
 * seeing rows the other thinks are hidden. Phase 5 is where the second selector
 * is built on purpose, precisely so the two can be compared: the goal is to
 * prove an independent implementation reaches the same inclusion/exclusion
 * decisions, not to serve it.
 *
 * **Nothing serves this.** `api/agent-verifications-queue.ts` remains the
 * endpoint; this runs from tests and diagnostics only.
 *
 * ## The structural difference from the legacy queue
 *
 * The legacy queue answers "who may review this?" inside each per-type branch,
 * so the author-exclusion predicate, the already-verified `NOT EXISTS` and the
 * age cutoff are written out five times. They agree today because someone kept
 * them in step by hand.
 *
 * Here a target type supplies only what is genuinely domain knowledge — which
 * rows exist, when, whose they are, and its own visibility rule — through
 * `listQueueCandidates`. Every rule that is the *same* for every type is
 * applied once, in `filterEligible` below. That is the change Phase 5 is
 * actually testing: not a faster query, but the same decisions reached from one
 * statement of the rules instead of five.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db.js';
import {
  agentVerifications,
  type AgentVerificationTargetType,
} from '../../../../db/schema.js';
import { KINETIX_SPACE } from '../actor-context.js';
import { registerKinetixAdapters } from '../adapters/kinetix/index.js';
import { findKnowledgeTargetAdapter } from '../registry.js';
import type { QueueCandidate } from '../target-adapter.js';

/**
 * The target types the queue interleaves.
 *
 * Mirrors `ALL_TYPES` in the legacy queue, `learning_unit_revision` excluded
 * for the same reason: the verdict schema does not accept it and its table is
 * not migrated everywhere (Phase 0 doc §5.2). A generic queue that served it
 * would diverge from the legacy one by *including* something, which is the
 * direction that matters least to fix and most to notice.
 */
export const GENERIC_QUEUE_TYPES: readonly AgentVerificationTargetType[] = [
  'drug_parameter_revision',
  'wiki_revision',
  'paper_review',
  'drug_discussion',
  'pending_edit',
];

/**
 * Reserved shares, mirroring `RESERVED_TYPE_FRACTIONS` in the legacy queue.
 *
 * Kept because the plan says to preserve per-type reserve behaviour, and
 * because the reserves exist for a reason that has not gone away: a pure
 * oldest-first merge buries `pending_edit` (the only type whose verification
 * can publish content) and `paper_review` (low-volume, single-author) behind a
 * months-deep wiki/discussion backlog.
 */
const RESERVED_TYPE_FRACTIONS: ReadonlyArray<{
  type: AgentVerificationTargetType;
  fraction: number;
}> = [
  { type: 'pending_edit', fraction: 0.5 },
  { type: 'paper_review', fraction: 0.25 },
];

export interface GenericQueueRequest {
  /** The reviewing agent's `agents.id`. */
  readonly agentId: number;
  /** The reviewing agent's backing `users.id`, for author exclusion. */
  readonly agentUserId: number;
  /** `agents.self_review_enabled` — an admin grant, never a request assertion. */
  readonly selfReviewEnabled: boolean;
  readonly limit: number;
  readonly minAgeMinutes: number;
  /** Restrict to one type, as the endpoint's `?targetType=` does. */
  readonly targetType?: AgentVerificationTargetType;
  readonly now?: Date;
  readonly space?: string;
  /**
   * Override the candidate cap (see `MAX_CANDIDATE_WINDOW`).
   *
   * Lowering it bounds an expensive diagnostic, and makes the truncation path
   * reachable from a test without the sixteen thousand rows the real cap
   * needs. It never reduces the first read below `limit`: serving a batch of
   * `limit` requires reading at least that many, and a cap below it can only
   * mean the answer is truncated.
   */
  readonly maxCandidateWindow?: number;
}

export type ExclusionReason =
  | 'not_visible'
  | 'authored_by_caller'
  | 'already_judged';

export interface GenericQueueResult {
  readonly items: readonly QueueCandidate[];
  /** Every candidate that was considered and dropped, with why. */
  readonly excluded: ReadonlyArray<{
    readonly candidate: QueueCandidate;
    readonly reason: ExclusionReason;
  }>;
  readonly examined: number;
  /**
   * Target types whose candidate window hit `MAX_CANDIDATE_WINDOW` before
   * `limit` eligible rows were found and before the type ran out. For such a
   * type the batch is a lower bound on what the legacy queue would serve, and
   * a comparison must say so rather than report the shortfall as a finding.
   */
  readonly truncated: readonly AgentVerificationTargetType[];
  readonly latencyMs: number;
}

/**
 * The most rows of one type the selector will read looking for `limit`
 * eligible ones.
 *
 * The legacy queue has no such bound because its eligibility rules run inside
 * the SQL, before the LIMIT. Here they run afterwards, so the selector has to
 * keep reading until it has found enough — and a reviewer who has judged an
 * entire backlog would otherwise make it read the whole table. Sixteen
 * thousand is comfortably past every served table on the day this was
 * written, so hitting it is reported (`truncated`) rather than treated as
 * "nothing left".
 */
export const MAX_CANDIDATE_WINDOW = 16_384;

/**
 * Which of these targets the agent has already formed a judgment on.
 *
 * One query across every type instead of a correlated `NOT EXISTS` per branch.
 *
 * `ignoreImplicit` is the self-review subtlety, and getting it wrong makes the
 * grant useless: a self-reviewing agent has an implicit-approve row on
 * everything it submitted, written at submit time, so asking "has this agent a
 * row for this target?" hides exactly the work the flag exists to surface. The
 * question the queue actually means is "has this agent formed a *judgment*
 * yet?", so implicit rows are ignored. For an agent that does not self-review
 * the two readings coincide — implicit rows are only ever written for the
 * submitter, and the submitter is excluded by authorship anyway.
 */
async function alreadyJudged(args: {
  agentId: number;
  candidates: readonly QueueCandidate[];
  ignoreImplicit: boolean;
}): Promise<Set<string>> {
  if (args.candidates.length === 0) return new Set();
  const db = getDb();
  const byType = new Map<string, number[]>();
  for (const candidate of args.candidates) {
    const bucket = byType.get(candidate.targetType) ?? [];
    bucket.push(candidate.targetId);
    byType.set(candidate.targetType, bucket);
  }

  const judged = new Set<string>();
  for (const [targetType, ids] of byType) {
    const rows = await db
      .select({
        targetType: agentVerifications.targetType,
        targetId: agentVerifications.targetId,
      })
      .from(agentVerifications)
      .where(
        and(
          eq(agentVerifications.agentId, args.agentId),
          eq(agentVerifications.targetType, targetType),
          inArray(agentVerifications.targetId, ids),
          args.ignoreImplicit
            ? eq(agentVerifications.isImplicit, false)
            : sql`true`,
        ),
      );
    for (const row of rows) judged.add(`${row.targetType}:${row.targetId}`);
  }
  return judged;
}

/**
 * Apply every rule that is the same for every target type.
 *
 * Order is deliberate and is the order the reasons are reported in: a row an
 * agent may not see at all is not "their own work", and a row they wrote is not
 * "already judged". Reporting the first applicable reason rather than all of
 * them keeps a divergence report saying *why* a candidate was dropped rather
 * than listing everything that would also have dropped it.
 */
export function filterEligible(args: {
  candidates: readonly QueueCandidate[];
  agentUserId: number;
  selfReviewEnabled: boolean;
  judged: ReadonlySet<string>;
}): {
  eligible: QueueCandidate[];
  excluded: Array<{ candidate: QueueCandidate; reason: ExclusionReason }>;
} {
  const eligible: QueueCandidate[] = [];
  const excluded: Array<{ candidate: QueueCandidate; reason: ExclusionReason }> = [];

  for (const candidate of args.candidates) {
    if (!candidate.visible) {
      excluded.push({ candidate, reason: 'not_visible' });
      continue;
    }
    // An agent does not review what it wrote — unless an admin has granted
    // self-review, which withholds this filter and nothing else. The write
    // path re-checks the same flag, so a stale queue listing cannot be turned
    // into a verdict on its own. A null author can never be the caller.
    if (
      !args.selfReviewEnabled &&
      candidate.authorUserId !== null &&
      candidate.authorUserId === args.agentUserId
    ) {
      excluded.push({ candidate, reason: 'authored_by_caller' });
      continue;
    }
    if (args.judged.has(`${candidate.targetType}:${candidate.targetId}`)) {
      excluded.push({ candidate, reason: 'already_judged' });
      continue;
    }
    eligible.push(candidate);
  }
  return { eligible, excluded };
}

/**
 * Merge eligible candidates into the served batch, honouring the reserves.
 *
 * Structurally identical to the legacy `selectQueueBatch`, and re-derived here
 * rather than imported for one reason: importing it would make the ordering
 * comparison in the differ trivially true, and a comparison that cannot fail
 * proves nothing. Ordering is explicitly *not* what Phase 5's exit gate is
 * about — the plan says inclusion/exclusion semantics must match first — but a
 * reserve implemented differently would change *which* rows are served at a
 * small limit, and that is an inclusion difference wearing an ordering
 * disguise.
 */
export function selectGenericBatch(
  items: readonly QueueCandidate[],
  limit: number,
): QueueCandidate[] {
  if (limit <= 0) return [];
  const byAge = (a: QueueCandidate, b: QueueCandidate) =>
    a.createdAt.localeCompare(b.createdAt);

  const head: QueueCandidate[] = [];
  const reserved = new Set<QueueCandidate>();
  for (const { type, fraction } of RESERVED_TYPE_FRACTIONS) {
    const remaining = limit - head.length;
    if (remaining <= 0) break;
    const pool = items.filter((i) => i.targetType === type).sort(byAge);
    const take = Math.min(pool.length, Math.ceil(limit * fraction), remaining);
    for (const item of pool.slice(0, take)) {
      head.push(item);
      reserved.add(item);
    }
  }

  const backfill = items
    .filter((i) => !reserved.has(i))
    .sort(byAge)
    .slice(0, limit - head.length);
  return [...head, ...backfill].sort(byAge);
}

/**
 * Every eligible row of one type, oldest first, up to `limit` of them.
 *
 * The rules are applied *after* the adapter's read, and that ordering is the
 * whole reason this loop exists. The first version of this selector read each
 * type's oldest `limit` rows and filtered those — which is what the legacy
 * queue does too, except that the legacy queue's author-exclusion and
 * already-judged predicates sit inside the SQL, ahead of its LIMIT. Against a
 * real backlog the difference is not subtle: the first production comparison
 * found an agent for whom the oldest hundred wiki revisions were all rows it
 * had already judged, so the legacy queue served a hundred items and this
 * selector served none. Two selectors that agree on an empty test database
 * and disagree on the production one are not in parity.
 *
 * So the window grows — doubling, re-read from the start — until either
 * `limit` eligible rows are in hand or the type has run out (a page shorter
 * than asked for). Re-reading the prefix costs at most one extra full read of
 * the type, which is cheap on tables this size and keeps the adapter contract
 * exactly as it was: an oldest-first listing with no knowledge of the caller.
 * A cursor would avoid the re-read, but a cursor is a second thing every
 * adapter would have to get right, and one of those already agrees with the
 * legacy queue only because someone kept it in step by hand.
 *
 * Adapters order on `(ordering key, id)`, so a growing prefix is stable: a
 * row at position n of the small window is at position n of the large one.
 */
async function eligibleOfType(args: {
  type: AgentVerificationTargetType;
  space: string;
  olderThan: Date;
  request: GenericQueueRequest;
}): Promise<{
  eligible: QueueCandidate[];
  excluded: Array<{ candidate: QueueCandidate; reason: ExclusionReason }>;
  examined: number;
  truncated: boolean;
}> {
  const adapter = findKnowledgeTargetAdapter(args.space, args.type);
  if (!adapter?.listQueueCandidates) {
    return { eligible: [], excluded: [], examined: 0, truncated: false };
  }
  const { request } = args;
  const cap = request.maxCandidateWindow ?? MAX_CANDIDATE_WINDOW;
  let window = request.limit;
  for (;;) {
    const candidates = [
      ...(await adapter.listQueueCandidates({ olderThan: args.olderThan, limit: window })),
    ];
    const judged = await alreadyJudged({
      agentId: request.agentId,
      candidates,
      ignoreImplicit: request.selfReviewEnabled,
    });
    const { eligible, excluded } = filterEligible({
      candidates,
      agentUserId: request.agentUserId,
      selfReviewEnabled: request.selfReviewEnabled,
      judged,
    });
    const exhausted = candidates.length < window;
    // At most `limit` of them, as the legacy queue's per-type LIMIT yields:
    // the window may have read further, and the batch merge only ever wants
    // a type's oldest `limit` anyway.
    const page = eligible.slice(0, request.limit);
    if (eligible.length >= request.limit || exhausted) {
      return { eligible: page, excluded, examined: candidates.length, truncated: false };
    }
    if (window >= cap) {
      return { eligible: page, excluded, examined: candidates.length, truncated: true };
    }
    window = Math.min(window * 2, cap);
  }
}

/**
 * Select the generic queue for one agent.
 *
 * Each type contributes at most its first `limit` *eligible* rows, for the
 * same reason the legacy queue fetches each type's first `limit`: if the
 * global top `limit` all came from one type, that type's first `limit` are
 * sufficient, and otherwise every type needs fewer.
 *
 * A per-type failure is tolerated and the type is dropped with a warning,
 * rather than rejecting the whole batch. A single unmigrated table must not be
 * able to starve every other type — most importantly `pending_edit`, the only
 * one whose verification can publish content.
 */
export async function selectGenericQueue(
  request: GenericQueueRequest,
): Promise<GenericQueueResult> {
  registerKinetixAdapters();
  const startedAt = Date.now();
  const space = request.space ?? KINETIX_SPACE;
  const now = request.now ?? new Date();
  const olderThan = new Date(now.getTime() - request.minAgeMinutes * 60_000);
  const types = request.targetType ? [request.targetType] : GENERIC_QUEUE_TYPES;

  const perType = await Promise.all(
    types.map(async (type) => {
      try {
        return await eligibleOfType({ type, space, olderThan, request });
      } catch (err) {
        console.error(
          `[kg-queue] dropping target type "${type}": ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        return { eligible: [], excluded: [], examined: 0, truncated: false };
      }
    }),
  );

  const eligible = perType.flatMap((t) => t.eligible);
  return {
    items: selectGenericBatch(eligible, request.limit),
    excluded: perType.flatMap((t) => t.excluded),
    examined: perType.reduce((n, t) => n + t.examined, 0),
    truncated: types.filter((_, i) => perType[i]!.truncated),
    latencyMs: Date.now() - startedAt,
  };
}
