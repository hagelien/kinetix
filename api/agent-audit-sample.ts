/**
 * GET /api/agent-audit-sample
 *
 *   GET ?limit=&rate=&since=
 *
 * The "recent-applied-work sampler" that `agents/drug-db-escalation.md` ("Not
 * yet available") and `agents/remote-routine-setup.md` §7 ("Backend
 * prerequisites" #2) name as missing: a stable, random 5–10% cohort of
 * already-applied drug-parameter revisions for the flagship (T2) verifier to
 * independently re-derive from primary sources, blind to whatever value was
 * actually published.
 *
 * ## Why this endpoint, and why now
 *
 * `scripts/benchmark-agent-tiers.ts` measures verifier accuracy against human
 * ground truth, and it deliberately excludes consensus-applied edits from
 * that accounting: an edit published via agent consensus is stamped
 * `status='approved'` with `reviewed_by` set to the tipping AGENT, so
 * counting it as ground-truth-approved would let the very approvals that
 * caused publication validate themselves. That exclusion is correct, but it
 * leaves the one class of edit that ships with zero human involvement scored
 * by nothing (issue #1232). A blind independent redo is the only sound way
 * to measure that class's error rate — "a summary check cannot catch
 * omission or search-miss errors, only a genuine independent re-derivation
 * can" (docs/superpowers/specs/2026-08-24-tiered-agent-cost-architecture.md,
 * "Shadow audit"). This endpoint supplies the population for that redo; it
 * does not itself compute the false-negative rate — that needs a durable
 * per-target-version decision history (`agents/remote-routine-setup.md` §7
 * item 3, still open), so the shadow-audit verdicts this endpoint feeds are
 * read the same way any other peer verdict is today, via
 * `GET /api/agent-verifications` and the existing benchmark.
 *
 * ## Source table
 *
 * `drug_parameter_revisions` is the one genuinely append-only "applied work"
 * record in the schema: `applyApprovedEditEffects`
 * (`api/_lib/pending-edits-helpers.ts`) inserts exactly one row per apply and
 * nothing ever updates it afterwards. `pending_edits` is NOT append-only (a
 * verifier changing its verdict upserts its row, a returned-then-resubmitted
 * edit overwrites its own row — the same known limitation
 * `benchmark-agent-tiers.ts` documents), so it cannot serve as the
 * "immutable applied revisions" the issue asks for. Every row here already
 * represents applied, calculation-relevant data — `parameter`/`param_entry`
 * edits are the only editTypes that write to this table.
 *
 * ## Self-excluding and blind to the redo, unconditionally
 *
 * Never serves a revision the caller produced, and never re-serves one the
 * caller has already formed a verdict on, whether as producer, ordinary peer
 * reviewer, or the tipping consensus approval — the second predicate is what
 * keeps the redo blind, since an agent that already judged a target isn't an
 * independent check on it anymore. Unlike the ordinary review queue, this
 * holds even for an agent with `agents.self_review_enabled` — that flag is a
 * shorthanded-pool escape hatch for *ordinary* peer review
 * (`AGENTS.md` "Self-review"), and it means the opposite of what this
 * endpoint measures: letting a producer redo-audit its own applied work
 * would launder exactly the error class the audit exists to catch. Both
 * predicates below always run with `selfReviewEnabled: false` regardless of
 * the caller's actual grant.
 *
 * ## What is NOT in the response — the redo must be blind to the answer
 *
 * The payload deliberately omits `newValue` and `editSummary`: showing the
 * published conclusion before the verifier has independently derived one
 * anchors the redo on the very answer it exists to check, exactly the
 * "summary check" the shadow audit is supposed to be better than. The
 * verifier researches `payload.parameter` for `payload.drug` from primary
 * sources — `payload.referenceIds` names the citations the original edit
 * used, `payload.oldValue` is the pre-existing value being replaced (context,
 * not the answer under audit) — and only AFTER recording its own independent
 * conclusion does it reveal the published value, via the ordinary queue's
 * single-target lookup (`GET /api/agent-verifications-queue
 * ?targetType=drug_parameter_revision&targetId=<id>`), to compare and cast
 * its verdict. See `agents/drug-db-escalation.md` §2 for the exact sequence.
 *
 * `isEntryBacked` (calculation-driving, for prioritisation) and `appliedVia`
 * (`agent_applied` | `human_reviewed` | `direct` — which path published it)
 * are metadata about the publication path, not the conclusion, so they carry
 * no anchoring risk; `appliedVia` is a one-word classification of the same
 * kind the escalation feed's reason codes already are.
 *
 * ## Sampling: a stable cohort, not a fresh resample every call
 *
 * Membership is a deterministic hash of the row's own immutable `id`
 * (`abs(hashtext(id::text)) % 10000 < rate * 10000`), not `ORDER BY
 * random()` over the shrinking "not yet audited" remainder. A resample-the-
 * remainder design converges to auditing the *entire* backlog given enough
 * calls (every unaudited row keeps a nonzero chance every cycle, and nothing
 * ever re-enters the pool), which defeats the whole point of bounding cost to
 * 5–10%. Hashing the id instead carves out a fixed ~`rate` fraction of the
 * table once, and each call only ever serves not-yet-audited members of that
 * same fraction — so the audited total converges to ~`rate` of history, not
 * to all of it, however many times the endpoint runs. `rate` (default 0.07,
 * clamped to [0.05, 0.10] — the shadow-audit spec's 5–10%) sets the cohort's
 * size, not a per-call resampling multiplier. Within the still-eligible
 * cohort, `agent_applied` rows are prioritised — the class this audit exists
 * to cover — with `limit` (default 20, max 100) applied after that ordering,
 * so a `human_reviewed`/`direct`-heavy cohort cannot crowd out the rows the
 * endpoint was built for. `since` (ISO 8601) optionally bounds the cohort to
 * "recent" work; omitted, the whole history is eligible. An empty result is a
 * correct, cheap outcome — the endpoint never forces a nonzero batch out of a
 * cohort that currently has none left to serve.
 *
 * Auth: any active agent (same gate as the sibling feeds). Restricting
 * consumption to flagship identities is an operational discipline enforced
 * by which Routine calls this endpoint (`agents/drug-db-escalation.md`), not
 * an API-level check — matching how `agent-escalation-queue.ts` and
 * `agent-verifications-queue.ts` already work.
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  json,
  error,
  withErrorHandling,
  noStoreHeaders,
} from "./_lib/response.js";
import { getDb } from "./_lib/db.js";
import { getUserFromRequest } from "./_lib/auth.js";
import { resolveActiveAgent } from "./_lib/agent-verifications.js";
import {
  notAuthoredByCaller,
  unverifiedByAgent,
} from "./agent-verifications-queue.js";
import { agents, drugParameterRevisions, drugs, pendingEdits } from "../db/schema.js";
import {
  isDrugParameterId,
  parameterIsEntryBacked,
} from "../src/lib/drugParameters.js";
import { effectiveProposalReferenceIds } from "../src/lib/parameterEntries.js";

const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const DEFAULT_RATE = 0.07;
export const MIN_RATE = 0.05;
export const MAX_RATE = 0.1;
/** Resolution of the hash-bucket cohort test — see `cohortPredicate`. */
export const COHORT_BUCKETS = 10_000;
const PRIVATE_AUDIT_SAMPLE_HEADERS = noStoreHeaders();

const reviewerAgents = alias(agents, "reviewer_agents");

export type AppliedVia = "agent_applied" | "human_reviewed" | "direct";

export interface AuditSampleItem {
  targetType: "drug_parameter_revision";
  targetId: number;
  targetVersion: string;
  createdAt: string;
  authorUserId: number;
  payload: {
    drug: { id: number; slug: string | null; names: unknown };
    parameter: string;
    oldValue: unknown;
    referenceIds: number[];
    isEntryBacked: boolean;
    appliedVia: AppliedVia;
  };
}

export default withErrorHandling(async function handler(req, res): Promise<void> {
  if (req.method !== "GET") {
    error(res, 405, "Method not allowed");
    return;
  }
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, "Authentication required");
    return;
  }
  const agent = await resolveActiveAgent(auth.userId);
  if (!agent) {
    error(
      res,
      403,
      "Active agent required",
      "agent_verification_agent_required",
    );
    return;
  }

  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number.isInteger(limitRaw) ? limitRaw : DEFAULT_LIMIT),
  );
  const rateRaw = Number(url.searchParams.get("rate") ?? DEFAULT_RATE);
  const rate = Math.min(
    MAX_RATE,
    Math.max(MIN_RATE, Number.isFinite(rateRaw) ? rateRaw : DEFAULT_RATE),
  );
  const sinceRaw = url.searchParams.get("since");
  let since: Date | null = null;
  if (sinceRaw) {
    const parsed = new Date(sinceRaw);
    if (Number.isNaN(parsed.getTime())) {
      error(res, 400, "Invalid since date (expected ISO 8601)");
      return;
    }
    since = parsed;
  }

  const { items, cohortSize } = await drawAuditSample({
    agentId: agent.id,
    agentUserId: auth.userId,
    limit,
    rate,
    since,
  });

  json(
    res,
    200,
    {
      items,
      sample: { cohortSize, rate, returned: items.length },
      agent: {
        id: agent.id,
        slug: agent.slug,
        selfReviewEnabled: agent.selfReviewEnabled,
      },
    },
    { headers: PRIVATE_AUDIT_SAMPLE_HEADERS },
  );
});

/**
 * Classify how a `drug_parameter_revisions` row reached the database, from
 * fields already on the row/its (possibly absent) originating pending edit.
 * Pure so the three-way branch is unit-tested without a database.
 */
export function resolveAppliedVia(
  pendingEditId: number | null,
  reviewerAgentId: number | null,
): AppliedVia {
  if (pendingEditId == null) return "direct";
  return reviewerAgentId != null ? "agent_applied" : "human_reviewed";
}

/**
 * Sort priority for `appliedVia` — lower sorts first. `agent_applied` is the
 * class this endpoint exists to cover (issue #1232), so it is served before
 * `human_reviewed`/`direct` whenever `limit` would otherwise truncate them
 * out. Pure and unit-tested; mirrored exactly by the SQL `case` expression in
 * `appliedViaPriorityExpr` below — keep the two in sync.
 */
export function appliedViaPriority(appliedVia: AppliedVia): number {
  if (appliedVia === "agent_applied") return 0;
  if (appliedVia === "human_reviewed") return 1;
  return 2;
}

/** SQL mirror of `appliedViaPriority`, computed from the same join columns
 * `resolveAppliedVia` reads. */
function appliedViaPriorityExpr() {
  return sql<number>`case
    when ${drugParameterRevisions.pendingEditId} is null then 2
    when ${reviewerAgents.id} is not null then 0
    else 1
  end`;
}

/**
 * Deterministic cohort-membership test: a fixed ~`rate` fraction of ALL
 * `drug_parameter_revisions` rows, keyed only by each row's own immutable
 * `id` — never re-rolled, never shrinking. See the module docstring
 * ("Sampling: a stable cohort") for why this replaces `ORDER BY random()`
 * over the eligible remainder.
 */
function cohortPredicate(rate: number) {
  const threshold = Math.round(rate * COHORT_BUCKETS);
  return sql`abs(hashtext(${drugParameterRevisions.id}::text)) % ${COHORT_BUCKETS} < ${threshold}`;
}

/**
 * Fetch, size and hydrate the served audit sample end to end. Exported so a
 * diagnostic (or a future caller) can obtain the batch a given agent would
 * be served without going through HTTP.
 */
export async function drawAuditSample(args: {
  agentId: number;
  agentUserId: number;
  limit: number;
  rate: number;
  since: Date | null;
}): Promise<{ items: AuditSampleItem[]; cohortSize: number }> {
  const db = getDb();

  // Unconditionally strict — never relaxed by the caller's own
  // `self_review_enabled` grant. See the module docstring ("Self-excluding
  // and blind to the redo, unconditionally").
  const eligibility = and(
    args.since ? gte(drugParameterRevisions.createdAt, args.since) : undefined,
    notAuthoredByCaller(drugParameterRevisions.createdBy, {
      agentUserId: args.agentUserId,
      selfReviewEnabled: false,
    }),
    unverifiedByAgent(
      "drug_parameter_revision",
      drugParameterRevisions.id,
      args.agentId,
      { ignoreImplicit: false },
    ),
    cohortPredicate(args.rate),
  );

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(drugParameterRevisions)
    .where(eligibility);
  const cohortSize = countRow?.count ?? 0;

  if (cohortSize === 0) {
    return { items: [], cohortSize };
  }

  const rows = await db
    .select({
      id: drugParameterRevisions.id,
      drugId: drugParameterRevisions.drugId,
      parameter: drugParameterRevisions.parameter,
      oldValue: drugParameterRevisions.oldValue,
      referenceId: drugParameterRevisions.referenceId,
      referenceIds: drugParameterRevisions.referenceIds,
      createdBy: drugParameterRevisions.createdBy,
      createdAt: drugParameterRevisions.createdAt,
      pendingEditId: drugParameterRevisions.pendingEditId,
      drugSlug: drugs.slug,
      drugNames: drugs.names,
      reviewerAgentId: reviewerAgents.id,
    })
    .from(drugParameterRevisions)
    .leftJoin(drugs, eq(drugs.id, drugParameterRevisions.drugId))
    .leftJoin(
      pendingEdits,
      eq(pendingEdits.id, drugParameterRevisions.pendingEditId),
    )
    .leftJoin(reviewerAgents, eq(reviewerAgents.userId, pendingEdits.reviewedBy))
    .where(eligibility)
    .orderBy(appliedViaPriorityExpr(), sql`random()`)
    .limit(args.limit);

  const items: AuditSampleItem[] = rows.map((r) => ({
    targetType: "drug_parameter_revision",
    targetId: r.id,
    targetVersion: r.createdAt.toISOString(),
    createdAt: r.createdAt.toISOString(),
    authorUserId: r.createdBy,
    payload: {
      drug: { id: r.drugId, slug: r.drugSlug, names: r.drugNames },
      parameter: r.parameter,
      oldValue: r.oldValue,
      referenceIds: effectiveProposalReferenceIds(r),
      isEntryBacked:
        isDrugParameterId(r.parameter) && parameterIsEntryBacked(r.parameter),
      appliedVia: resolveAppliedVia(r.pendingEditId, r.reviewerAgentId),
    },
  }));

  return { items, cohortSize };
}
