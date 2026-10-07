/**
 * Pull-based discovery for agent peer verification.
 *
 *   GET ?targetType=&limit=&minAgeMinutes=
 *
 * Returns up to `limit` targets the calling agent has not yet verified and
 * did not author. The response carries the target payload the agent needs to
 * form a judgment (e.g. old/new value for a parameter revision); it does
 * NOT include other agents' verdicts or approval counts — same echo-chamber
 * guardrail the existing approvals helper documents.
 *
 * Implementation note: each candidate query excludes rows the caller's agent
 * already verified with a correlated NOT EXISTS. The unique index on
 * (agent_id, target_type, target_id) keeps that lookup O(1) per row.
 *
 * Auth: any active agent.
 */

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, type PgColumn } from "drizzle-orm/pg-core";
import {
  json,
  error,
  withErrorHandling,
  noStoreHeaders,
} from "./_lib/response.js";
import { getDb } from "./_lib/db.js";
import { getUserFromRequest } from "./_lib/auth.js";
import { agentVerificationTargetTypeSchema } from "./_lib/schemas.js";
import { resolveActiveAgent } from "./_lib/agent-verifications.js";
import {
  agentVerdictReconsiderations,
  agentVerifications,
  citations,
  citationPdfs,
  drugParameterDiscussions,
  drugParameterRevisions,
  drugs,
  learningUnitRevisions,
  paperReviews,
  parameterEntries,
  pdfRequests,
  pendingEdits,
  wikiPages,
  wikiRevisions,
  type AgentVerificationTargetType,
} from "../db/schema.js";
import { isReadInFullUnverified } from "./_lib/pending-edits-helpers.js";
import { readParameterValue } from "./_lib/drugs-helpers.js";
import { getDrugParametersByDrugIds } from "./_lib/drugParameterStore.js";
import { isDrugParameterId } from "./_lib/drugParameterIds.js";
import { resolveDrugName } from "../src/lib/drugNames.js";
import {
  effectiveProposalReferenceIds,
  paramEntryOp,
} from "../src/lib/parameterEntries.js";

const DEFAULT_LIMIT = 20;
const PRIVATE_AGENT_QUEUE_HEADERS = noStoreHeaders();
/**
 * The largest batch this endpoint will ever serve.
 *
 * Exported because a diagnostic that compares against "what the route serves"
 * has to clamp the same way; asking for more than this compares a batch no
 * agent can receive.
 */
export const MAX_LIMIT = 100;
const DEFAULT_MIN_AGE_MINUTES = 5;
export const ALL_TYPES: AgentVerificationTargetType[] = [
  "drug_parameter_revision",
  "wiki_revision",
  "paper_review",
  "drug_discussion",
  "pending_edit",
];
// NOTE: `learning_unit_revision` is intentionally NOT in the interleaved set.
// Its fetch branch exists, but the type is only half-wired: the verdict schema
// (AGENT_VERIFICATION_TARGET_TYPES) doesn't accept it, and the
// learning_unit_revisions table isn't present in every environment yet. Leaving
// it here made every interleaved pull fan a query at a missing relation, which
// rejected the whole Promise and 500'd the entire queue (starving pending_edit
// and the rest). Re-add it once the table is migrated everywhere and the verdict
// schema accepts it; the resilient fan-out below also guards against a recurrence.
// Shares of an interleaved batch guaranteed to specific target types so an
// oldest-first backlog of other types can't starve them. A pure oldest-first
// merge buries any lower-volume or newer type behind months-deep re-ranks of the
// high-volume ones (wiki_revision/drug_discussion), so at the small per-cycle
// `limit` it is never served:
//
//   - pending_edit is the only type whose verification can apply content outright
//     (agent-consensus auto-apply; see api/agent-verifications.ts). Without a
//     reserve, agent-authored edits piled up and consensus never fired.
//   - paper_review is low-volume and authored by a single agent, so its peers'
//     verdicts are the only quality gate. Once a ~1k-item older wiki/discussion
//     backlog formed (06-2026), every fresh paper_review sorted to the back of
//     the backfill and peer verification of paper reviews flatlined.
//
// Each reserve is capped by how many candidates of that type actually exist, so
// a drained backlog cedes its slots back to the other types. The reserves are
// applied in order and the cumulative head can never exceed `limit`.
const RESERVED_TYPE_FRACTIONS: ReadonlyArray<{
  type: AgentVerificationTargetType;
  fraction: number;
}> = [
  { type: "pending_edit", fraction: 0.5 },
  { type: "paper_review", fraction: 0.25 },
];

export interface QueueItem {
  targetType: AgentVerificationTargetType;
  targetId: number;
  targetVersion: string;
  createdAt: string;
  authorUserId: number | null;
  payload: Record<string, unknown>;
}

type PendingEditPageHydration = "full" | "content" | "none";

export function pendingEditPageHydrationFor(
  editType: string,
): PendingEditPageHydration {
  if (editType === "wiki_page") return "full";
  if (editType === "wiki_fact" || editType === "wiki_section") return "content";
  return "none";
}

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
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
    const minAgeMinutesRaw = Number(
      url.searchParams.get("minAgeMinutes") ?? DEFAULT_MIN_AGE_MINUTES,
    );
    const minAgeMinutes = Math.max(
      0,
      Number.isFinite(minAgeMinutesRaw)
        ? minAgeMinutesRaw
        : DEFAULT_MIN_AGE_MINUTES,
    );
    const ageCutoff = new Date(Date.now() - minAgeMinutes * 60_000);

    const targetTypeParam = url.searchParams.get("targetType");
    let types: AgentVerificationTargetType[];
    let singleType: AgentVerificationTargetType | undefined;
    if (targetTypeParam) {
      const parsed =
        agentVerificationTargetTypeSchema.safeParse(targetTypeParam);
      if (!parsed.success) {
        error(res, 400, `Unknown targetType "${targetTypeParam}"`);
        return;
      }
      singleType = parsed.data;
      types = [parsed.data];
    } else {
      types = ALL_TYPES;
    }

    // selfReviewEnabled is echoed so a routine can tell why its own rows are
    // in the batch — without it, an agent meeting its own submission in the
    // queue reads as a bug worth working around.
    const agentSummary = {
      id: agent.id,
      slug: agent.slug,
      selfReviewEnabled: agent.selfReviewEnabled,
    };

    // A direct (targetType, targetId) lookup — for a caller that already
    // knows which specific target it needs content for (the escalation feed,
    // api/agent-escalation-queue.ts, hands out identifiers only; this is how
    // that identifier becomes the payload an agent needs to form a verdict).
    // Requires a single targetType, since an id alone doesn't say which table
    // to look in.
    const targetIdParam = url.searchParams.get("targetId");
    if (targetIdParam != null) {
      if (!singleType) {
        error(res, 400, "targetId requires targetType");
        return;
      }
      const targetId = Number(targetIdParam);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        error(res, 400, `Invalid targetId "${targetIdParam}"`);
        return;
      }
      const item = await fetchSingleCandidate({
        type: singleType,
        targetId,
        agentId: agent.id,
        agentUserId: auth.userId,
        selfReviewEnabled: agent.selfReviewEnabled,
      });
      json(
        res,
        200,
        { items: item ? [item] : [], agent: agentSummary },
        { headers: PRIVATE_AGENT_QUEUE_HEADERS },
      );
      return;
    }

    // The abstention-recovery pass: the caller's own abstentions from before
    // a fixed cutoff, and nothing else. The cutoff is required and may not be
    // in the future — it is what makes the pass end (see
    // abstainedByAgentBefore).
    const revisitParam = url.searchParams.get("revisit");
    let revisitAbstainedBefore: Date | undefined;
    if (revisitParam != null) {
      if (revisitParam !== "abstained") {
        error(res, 400, `Unknown revisit "${revisitParam}"`);
        return;
      }
      const beforeParam = url.searchParams.get("abstainedBefore");
      const before = beforeParam ? new Date(beforeParam) : null;
      if (!before || Number.isNaN(before.getTime())) {
        error(
          res,
          400,
          "revisit=abstained requires abstainedBefore (an ISO timestamp)",
          "agent_verification_revisit_cutoff_required",
        );
        return;
      }
      if (before.getTime() > Date.now()) {
        error(
          res,
          400,
          "abstainedBefore may not be in the future",
          "agent_verification_revisit_cutoff_future",
        );
        return;
      }
      revisitAbstainedBefore = before;
    }

    const items = await selectLegacyQueue({
      types,
      ageCutoff,
      agentId: agent.id,
      agentUserId: auth.userId,
      selfReviewEnabled: agent.selfReviewEnabled,
      revisitAbstainedBefore,
      limit,
    });

    json(
      res,
      200,
      {
        items: revisitAbstainedBefore
          ? await withPriorAbstentions(items, agent.id)
          : items,
        agent: agentSummary,
      },
      { headers: PRIVATE_AGENT_QUEUE_HEADERS },
    );
  },
);

/**
 * Attach the caller's OWN earlier abstention to each revisited item, so the
 * re-read starts from what blocked it last time (which route failed, which
 * PDF request was filed). Only the caller's verdict — never a peer's — so the
 * queue stays blind.
 */
async function withPriorAbstentions(
  items: QueueItem[],
  agentId: number,
): Promise<Array<QueueItem & { priorAbstention: PriorAbstention | null }>> {
  if (items.length === 0) return [];
  const rows = await getDb()
    .select({
      targetType: agentVerifications.targetType,
      targetId: agentVerifications.targetId,
      rationaleMd: agentVerifications.rationaleMd,
      updatedAt: agentVerifications.updatedAt,
    })
    .from(agentVerifications)
    .where(
      and(
        eq(agentVerifications.agentId, agentId),
        eq(agentVerifications.verdict, "abstain"),
        inArray(
          agentVerifications.targetId,
          items.map((i) => i.targetId),
        ),
      ),
    );
  const byKey = new Map(
    rows.map((r) => [
      `${r.targetType}:${r.targetId}`,
      { rationaleMd: r.rationaleMd, recordedAt: r.updatedAt.toISOString() },
    ]),
  );
  return items.map((item) => ({
    ...item,
    priorAbstention: byKey.get(`${item.targetType}:${item.targetId}`) ?? null,
  }));
}

interface PriorAbstention {
  rationaleMd: string;
  recordedAt: string;
}

/**
 * Fan candidate fetches across the requested target types, tolerating a
 * per-type failure. A single type's fetch throwing — e.g. its backing table
 * isn't migrated in this environment — must not reject the whole interleaved
 * queue and starve every other type, most importantly `pending_edit` (the only
 * type whose verification applies content). The failing type is dropped with a
 * logged warning and the remaining types are served.
 *
 * Exported as a pure higher-order function (the fetch is injected) so the
 * resilience can be unit-tested without a DB.
 */
export async function collectQueueCandidates<T>(
  types: AgentVerificationTargetType[],
  fetchOne: (type: AgentVerificationTargetType) => Promise<T[]>,
): Promise<T[]> {
  const perType = await Promise.all(
    types.map(async (type) => {
      try {
        return await fetchOne(type);
      } catch (err) {
        console.error(
          `[verification-queue] dropping target type "${type}": ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        return [] as T[];
      }
    }),
  );
  return perType.flat();
}

/**
 * Merge per-type candidates into the served batch, guaranteeing each type in
 * RESERVED_TYPE_FRACTIONS a minimum share of the slots so an oldest-first
 * backlog of high-volume types (wiki_revision / drug_discussion) can't starve
 * them.
 *
 * Every candidate type is fetched oldest-first; the naive behaviour merged them
 * all and sliced the globally-oldest `limit`. Because the reserved types' rows
 * are uniformly newer than the months-deep wiki/discussion backlog, that slice
 * never reached them at the small per-cycle `limit` — so pending edits never hit
 * the apply-on-consensus path and paper reviews went un-peer-reviewed. For each
 * reserved type we take up to `ceil(limit * fraction)` of its OLDEST candidates
 * into the head (applied in declared order, never letting the head exceed
 * `limit`), then backfill the remaining slots oldest-first from everything else
 * — including any reserved-type rows beyond their reserve. Each reserve is
 * capped by how many candidates of that type exist, so when a backlog drains the
 * unused slots fall back to the other types with no further change.
 *
 * Pure function of the candidate list (no DB / request state) so it can be
 * unit-tested directly.
 */
export function selectQueueBatch<
  T extends { targetType: AgentVerificationTargetType; createdAt: string },
>(items: T[], limit: number): T[] {
  if (limit <= 0) return [];
  const byAge = (a: T, b: T) => a.createdAt.localeCompare(b.createdAt);

  const head: T[] = [];
  const reserved = new Set<T>();
  for (const { type, fraction } of RESERVED_TYPE_FRACTIONS) {
    const remaining = limit - head.length;
    if (remaining <= 0) break;
    const pool = items.filter((i) => i.targetType === type).sort(byAge);
    const take = Math.min(pool.length, Math.ceil(limit * fraction), remaining);
    for (const it of pool.slice(0, take)) {
      head.push(it);
      reserved.add(it);
    }
  }

  const backfill = items
    .filter((i) => !reserved.has(i))
    .sort(byAge)
    .slice(0, limit - head.length);
  return [...head, ...backfill].sort(byAge);
}

/**
 * The legacy selection end to end: fetch, interleave, serve.
 *
 * This is exactly what the handler serves, factored out so that a diagnostic
 * can obtain *the batch the route would serve* for an agent without going
 * through HTTP — the legacy side of the knowledge-governance queue-parity
 * comparison (`api/_lib/knowledge-governance/queue/compare.ts`) has to be the
 * real served batch, not a re-implementation of it, or the comparison reports
 * on something nobody is served. The handler resolves the caller and parses
 * the query; this does the rest.
 *
 * The merged queue only needs each type's first `limit` rows: if the global
 * top `limit` all come from one type, that type's first `limit` rows are
 * sufficient; otherwise every type needs fewer.
 */
/*
 * Each branch orders on its ordering key *and then on the row id*. Postgres
 * does not promise an order among rows tied on the key — and rows inserted in
 * one transaction share a `now()` default — so at the LIMIT boundary a tie
 * could be broken differently on two reads. That is invisible while one
 * selector exists and becomes a spurious finding the moment two are compared:
 * the generic adapters order the same way.
 */
export async function selectLegacyQueue(args: {
  types: AgentVerificationTargetType[];
  ageCutoff: Date;
  agentId: number;
  agentUserId: number;
  selfReviewEnabled: boolean;
  /** Serve the caller's own earlier abstentions instead (`?revisit=abstained`). */
  revisitAbstainedBefore?: Date;
  limit: number;
}): Promise<QueueItem[]> {
  const collected = await collectQueueCandidates(args.types, (type) =>
    fetchCandidates({
      type,
      ageCutoff: args.ageCutoff,
      agentId: args.agentId,
      agentUserId: args.agentUserId,
      selfReviewEnabled: args.selfReviewEnabled,
      revisitAbstainedBefore: args.revisitAbstainedBefore,
      limit: args.limit,
    }),
  );
  return selectQueueBatch(collected, args.limit);
}

/**
 * Fetch one target by (type, id) directly, applying the exact same
 * eligibility/visibility predicates and payload hydration as the batch
 * queue. Used by a caller that already knows which specific target it needs
 * content for. Returns null when the target does not exist, has already
 * left the eligible state (moderated, already verified, authored by the
 * caller), or is not visible to it — the same "vanished" outcome a target
 * that moves between scan and serve gets in the batch path.
 */
export async function fetchSingleCandidate(args: {
  type: AgentVerificationTargetType;
  targetId: number;
  agentId: number;
  agentUserId: number;
  selfReviewEnabled: boolean;
  includeJudged?: boolean;
}): Promise<QueueItem | null> {
  const items = await fetchCandidates({
    type: args.type,
    targetId: args.targetId,
    includeJudged: args.includeJudged,
    // Unused whenever targetId is set (every branch below prefers the id
    // filter); kept only so fetchCandidates has one argument shape.
    ageCutoff: new Date(0),
    agentId: args.agentId,
    agentUserId: args.agentUserId,
    selfReviewEnabled: args.selfReviewEnabled,
    limit: 1,
  });
  return items[0] ?? null;
}

/**
 * A target-id lookup and an age-cutoff scan are the same predicate shape —
 * "which row(s) qualify" — so every fetchCandidates branch below uses this to
 * pick one without duplicating its other four predicates (author exclusion,
 * already-verified exclusion, and wherever it applies, visibility). Passing
 * `targetId` narrows to exactly that row; omitting it keeps the normal
 * oldest-first batch scan.
 */
function idOrAgeFilter(
  idColumn: PgColumn,
  ageColumn: PgColumn,
  args: { targetId?: number; ageCutoff: Date },
): SQL {
  return args.targetId != null
    ? eq(idColumn, args.targetId)
    : lt(ageColumn, args.ageCutoff);
}

async function fetchCandidates(args: {
  type: AgentVerificationTargetType;
  targetId?: number;
  ageCutoff: Date;
  agentId: number;
  agentUserId: number;
  /** agents.self_review_enabled — admin opt-in to queue the agent's own rows. */
  selfReviewEnabled: boolean;
  /**
   * Serve the row even though the caller already holds a verdict on it. Only
   * the reconsideration phase sets this (api/agent-verifications/reconsider.ts):
   * an agent re-reading a target it disputed needs the same payload, under the
   * same visibility rules, that it judged the first time.
   */
  includeJudged?: boolean;
  /**
   * Serve ONLY rows the caller abstained on before this instant — the
   * abstention-recovery pass (`?revisit=abstained`). See
   * {@link abstainedByAgentBefore}.
   */
  revisitAbstainedBefore?: Date;
  limit: number;
}): Promise<QueueItem[]> {
  const db = getDb();

  switch (args.type) {
    case "drug_parameter_revision": {
      const rows = await db
        .select({
          id: drugParameterRevisions.id,
          drugId: drugParameterRevisions.drugId,
          parameter: drugParameterRevisions.parameter,
          oldValue: drugParameterRevisions.oldValue,
          newValue: drugParameterRevisions.newValue,
          editSummary: drugParameterRevisions.editSummary,
          referenceId: drugParameterRevisions.referenceId,
          referenceIds: drugParameterRevisions.referenceIds,
          createdBy: drugParameterRevisions.createdBy,
          createdAt: drugParameterRevisions.createdAt,
          drugSlug: drugs.slug,
          drugNames: drugs.names,
        })
        .from(drugParameterRevisions)
        .leftJoin(drugs, eq(drugs.id, drugParameterRevisions.drugId))
        .where(
          and(
            idOrAgeFilter(
              drugParameterRevisions.id,
              drugParameterRevisions.createdAt,
              args,
            ),
            notAuthoredByCaller(drugParameterRevisions.createdBy, args),
            unverifiedByAgent(
              "drug_parameter_revision",
              drugParameterRevisions.id,
              args.agentId,
              { ignoreImplicit: args.selfReviewEnabled,
              includeJudged: args.includeJudged,
              revisitAbstainedBefore: args.revisitAbstainedBefore },
            ),
          ),
        )
        .orderBy(asc(drugParameterRevisions.createdAt), asc(drugParameterRevisions.id))
        .limit(args.limit);
      return rows.map((r) => ({
        targetType: "drug_parameter_revision" as const,
        targetId: r.id,
        targetVersion: r.createdAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        authorUserId: r.createdBy,
        payload: {
          drug: { id: r.drugId, slug: r.drugSlug, names: r.drugNames },
          parameter: r.parameter,
          oldValue: r.oldValue,
          newValue: r.newValue,
          editSummary: r.editSummary,
          // The shared effective-reference rule, not
          // `referenceIds ?? [referenceId]`: a legacy revision can carry
          // `reference_ids = '{}'` beside a populated singular
          // `reference_id`, and nullish-coalescing keeps the empty array —
          // hiding the only source from a verifier sent here by the
          // escalation queue precisely because that citation is contested.
          referenceIds: effectiveProposalReferenceIds(r),
        },
      }));
    }
    case "wiki_revision": {
      const rows = await db
        .select({
          id: wikiRevisions.id,
          pageId: wikiRevisions.pageId,
          editSummary: wikiRevisions.editSummary,
          createdBy: wikiRevisions.createdBy,
          createdAt: wikiRevisions.createdAt,
          content: wikiRevisions.content,
          contentHtml: wikiRevisions.contentHtml,
          pageSlug: wikiPages.slug,
          pageTitle: wikiPages.title,
          pageStatus: wikiPages.status,
        })
        .from(wikiRevisions)
        .innerJoin(wikiPages, eq(wikiPages.id, wikiRevisions.pageId))
        .where(
          and(
            idOrAgeFilter(wikiRevisions.id, wikiRevisions.createdAt, args),
            eq(wikiPages.status, "published"),
            notAuthoredByCaller(wikiRevisions.createdBy, args),
            unverifiedByAgent("wiki_revision", wikiRevisions.id, args.agentId, {
              ignoreImplicit: args.selfReviewEnabled,
              includeJudged: args.includeJudged,
              revisitAbstainedBefore: args.revisitAbstainedBefore,
            }),
          ),
        )
        .orderBy(asc(wikiRevisions.createdAt), asc(wikiRevisions.id))
        .limit(args.limit);

      // Batch-fetch the prior revision for every candidate in one round-trip.
      // A self-join with DISTINCT ON (candidate id) returns the most-recent
      // predecessor per row using the (page_id, created_at) index; candidates
      // whose revision is the first for their page are absent from the result
      // and resolve to null below.
      const candRevs = alias(wikiRevisions, "cand");
      const prevRevs = alias(wikiRevisions, "prev");
      const candidateIds = rows.map((r) => r.id);
      const priorQueryRows = candidateIds.length
        ? await db
            .selectDistinctOn([candRevs.id], {
              candidateId: candRevs.id,
              content: prevRevs.content,
              contentHtml: prevRevs.contentHtml,
              createdAt: prevRevs.createdAt,
            })
            .from(candRevs)
            .innerJoin(
              prevRevs,
              and(
                eq(prevRevs.pageId, candRevs.pageId),
                lt(prevRevs.createdAt, candRevs.createdAt),
              ),
            )
            .where(inArray(candRevs.id, candidateIds))
            .orderBy(candRevs.id, desc(prevRevs.createdAt))
        : [];
      const priorByRevId = new Map(
        priorQueryRows.map((r) => [r.candidateId, r]),
      );
      const priorRows = rows.map((r) => {
        const p = priorByRevId.get(r.id);
        return p
          ? {
              content: p.content,
              contentHtml: p.contentHtml,
              createdAt: p.createdAt,
            }
          : null;
      });

      return rows.map((r, i) => {
        const prior = priorRows[i];
        return {
          targetType: "wiki_revision" as const,
          targetId: r.id,
          targetVersion: r.createdAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
          authorUserId: r.createdBy,
          payload: {
            page: {
              id: r.pageId,
              slug: r.pageSlug,
              title: r.pageTitle,
              status: r.pageStatus,
            },
            editSummary: r.editSummary,
            content: r.content,
            contentHtml: r.contentHtml,
            previousContent: prior?.content ?? null,
            previousContentHtml: prior?.contentHtml ?? null,
            previousCreatedAt: prior?.createdAt.toISOString() ?? null,
          },
        };
      });
    }
    case "paper_review": {
      const rows = await db
        .select({
          id: paperReviews.id,
          citationId: paperReviews.citationId,
          reviewMarkdown: paperReviews.reviewMarkdown,
          overallScore: paperReviews.overallScore,
          conclusionSupport: paperReviews.conclusionSupport,
          reviewConfidence: paperReviews.reviewConfidence,
          readInFull: paperReviews.readInFull,
          createdBy: paperReviews.createdBy,
          createdAt: paperReviews.createdAt,
          updatedAt: paperReviews.updatedAt,
          citationType: citations.type,
          citationIdentifier: citations.identifier,
          citationMetadata: citations.metadata,
        })
        .from(paperReviews)
        .leftJoin(citations, eq(citations.id, paperReviews.citationId))
        .where(
          and(
            // paper_review rows are upserted in place on re-review (target is
            // citationId, not the review id), so createdAt stays old while the
            // content rolls forward. Age + order by updatedAt instead — the
            // minAgeMinutes delay needs to give the *new* implicit-approve row
            // time to land after the re-review, and the cross-type sort
            // should treat re-reviewed rows as fresh.
            idOrAgeFilter(paperReviews.id, paperReviews.updatedAt, args),
            // createdBy is nullable; only block self when set
            notAuthoredByCaller(paperReviews.createdBy, args, {
              nullable: true,
            }),
            unverifiedByAgent("paper_review", paperReviews.id, args.agentId, {
              ignoreImplicit: args.selfReviewEnabled,
              includeJudged: args.includeJudged,
              revisitAbstainedBefore: args.revisitAbstainedBefore,
            }),
          ),
        )
        .orderBy(asc(paperReviews.updatedAt), asc(paperReviews.id))
        .limit(args.limit);

      // Surface whether the read-in-full attestation has full-text evidence on
      // file. A live review whose citation still has an open PDF request and no
      // stored PDF likely was not read in full — peer verifiers should weight
      // that. One batched lookup per signal across all citations in the page.
      const citationIds = [...new Set(rows.map((r) => r.citationId))];
      const [openRequestRows, storedPdfRows] =
        citationIds.length > 0
          ? await Promise.all([
              db
                .select({ citationId: pdfRequests.citationId })
                .from(pdfRequests)
                .where(
                  and(
                    inArray(pdfRequests.citationId, citationIds),
                    eq(pdfRequests.status, "open"),
                  ),
                ),
              db
                .select({ citationId: citationPdfs.citationId })
                .from(citationPdfs)
                .where(inArray(citationPdfs.citationId, citationIds)),
            ])
          : [[], []];
      const openRequestCitationIds = new Set(
        openRequestRows.map((r) => r.citationId),
      );
      const storedPdfCitationIds = new Set(
        storedPdfRows.map((r) => r.citationId),
      );

      return rows.map((r) => ({
        targetType: "paper_review" as const,
        targetId: r.id,
        targetVersion: r.updatedAt.toISOString(),
        // Use updatedAt for the cross-type "createdAt" sort key so a fresh
        // re-review doesn't jump ahead of older rows in the merged queue.
        createdAt: r.updatedAt.toISOString(),
        authorUserId: r.createdBy,
        payload: {
          citation: {
            id: r.citationId,
            type: r.citationType,
            identifier: r.citationIdentifier,
            metadata: r.citationMetadata,
          },
          reviewMarkdown: r.reviewMarkdown,
          overallScore: r.overallScore,
          conclusionSupport: r.conclusionSupport,
          reviewConfidence: r.reviewConfidence,
          readInFull: r.readInFull,
          readInFullUnverified: isReadInFullUnverified(
            r.readInFull,
            openRequestCitationIds.has(r.citationId),
            storedPdfCitationIds.has(r.citationId),
          ),
        },
      }));
    }
    case "drug_discussion": {
      const rows = await db
        .select({
          id: drugParameterDiscussions.id,
          drugId: drugParameterDiscussions.drugId,
          parameter: drugParameterDiscussions.parameter,
          parentId: drugParameterDiscussions.parentId,
          body: drugParameterDiscussions.body,
          createdBy: drugParameterDiscussions.createdBy,
          createdAt: drugParameterDiscussions.createdAt,
        })
        .from(drugParameterDiscussions)
        .where(
          and(
            // This queue feeds the drug-focused comment evaluator, which
            // hydrates a drug row from the payload. Topic-page fact comments
            // have a null drugId, so keep them out rather than handing the
            // agent an unworkable target.
            isNotNull(drugParameterDiscussions.drugId),
            idOrAgeFilter(
              drugParameterDiscussions.id,
              drugParameterDiscussions.createdAt,
              args,
            ),
            notAuthoredByCaller(drugParameterDiscussions.createdBy, args),
            unverifiedByAgent(
              "drug_discussion",
              drugParameterDiscussions.id,
              args.agentId,
              { ignoreImplicit: args.selfReviewEnabled,
              includeJudged: args.includeJudged,
              revisitAbstainedBefore: args.revisitAbstainedBefore },
            ),
          ),
        )
        .orderBy(asc(drugParameterDiscussions.createdAt), asc(drugParameterDiscussions.id))
        .limit(args.limit);
      return rows.map((r) => ({
        targetType: "drug_discussion" as const,
        targetId: r.id,
        targetVersion: r.createdAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        authorUserId: r.createdBy,
        payload: {
          drugId: r.drugId,
          parameter: r.parameter,
          parentId: r.parentId,
          body: r.body,
        },
      }));
    }
    case "learning_unit_revision": {
      const rows = await db
        .select({
          id: learningUnitRevisions.id,
          unitId: learningUnitRevisions.unitId,
          content: learningUnitRevisions.content,
          editSummary: learningUnitRevisions.editSummary,
          createdBy: learningUnitRevisions.createdBy,
          createdAt: learningUnitRevisions.createdAt,
        })
        .from(learningUnitRevisions)
        .where(
          and(
            idOrAgeFilter(
              learningUnitRevisions.id,
              learningUnitRevisions.createdAt,
              args,
            ),
            notAuthoredByCaller(learningUnitRevisions.createdBy, args),
            unverifiedByAgent(
              "learning_unit_revision",
              learningUnitRevisions.id,
              args.agentId,
              { ignoreImplicit: args.selfReviewEnabled,
              includeJudged: args.includeJudged,
              revisitAbstainedBefore: args.revisitAbstainedBefore },
            ),
          ),
        )
        .orderBy(asc(learningUnitRevisions.createdAt))
        .limit(args.limit);
      return rows.map((r) => ({
        targetType: "learning_unit_revision" as const,
        targetId: r.id,
        targetVersion: r.createdAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        authorUserId: r.createdBy,
        payload: {
          unitId: r.unitId,
          content: r.content,
          editSummary: r.editSummary,
        },
      }));
    }
    case "pending_edit": {
      const rows = await db
        .select({
          id: pendingEdits.id,
          editType: pendingEdits.editType,
          targetId: pendingEdits.targetId,
          parameter: pendingEdits.parameter,
          proposedValue: pendingEdits.proposedValue,
          proposedMeta: pendingEdits.proposedMeta,
          referenceId: pendingEdits.referenceId,
          referenceIds: pendingEdits.referenceIds,
          submittedBy: pendingEdits.submittedBy,
          submittedAt: pendingEdits.submittedAt,
          status: pendingEdits.status,
          // wiki_fact / wiki_section pending edits store the anchor outside
          // proposedValue. Without these, an agent verifying a replace /
          // remove / reorder op cannot tell which fact or section is being
          // changed, and can't distinguish add vs replace either.
          sectionId: pendingEdits.sectionId,
          fieldId: pendingEdits.fieldId,
          factStatement: pendingEdits.factStatement,
          factOperation: pendingEdits.factOperation,
          factTargetAnchor: pendingEdits.factTargetAnchor,
        })
        .from(pendingEdits)
        .where(
          and(
            eq(pendingEdits.status, "pending"),
            idOrAgeFilter(pendingEdits.id, pendingEdits.submittedAt, args),
            notAuthoredByCaller(pendingEdits.submittedBy, args),
            unverifiedByAgent("pending_edit", pendingEdits.id, args.agentId, {
              ignoreImplicit: args.selfReviewEnabled,
              includeJudged: args.includeJudged,
              revisitAbstainedBefore: args.revisitAbstainedBefore,
            }),
            // Wiki visibility: contributor-level agents can read published
            // monograph content only. wiki_new is always pre-publication;
            // wiki_page/wiki_fact/wiki_section against a draft page would
            // leak unpublished content via proposedValue. Filtering in SQL
            // (rather than in-process post-LIMIT) keeps the LIMIT clause
            // honest — otherwise a queue full of old draft edits could
            // starve later eligible work below the cap.
            pendingEditWikiVisibility(),
          ),
        )
        .orderBy(asc(pendingEdits.submittedAt), asc(pendingEdits.id))
        .limit(args.limit);

      // Baseline enrichment: an agent verifying a queued pending_edit needs
      // to compare proposed vs current to form a verdict. /api/pending-edits
      // computes this for human moderators; without it agents must guess
      // (or fetch private endpoints they may not see). Batch-fetch every
      // baseline drug + page in parallel so the queue still costs ~2 round
      // trips regardless of row count.
      // `param_entry` proposals resolve `targetId` by their own `op`: the
      // drug id for a create, the ENTRY id for an update or delete. Without
      // resolving that, an entry update or delete reaches the verifier as a
      // bare `{op: "delete"}` against a number with no drug, no parameter and
      // no current value — nothing an independent verdict can be formed from,
      // and the escalation queue routes exactly these to the flagship tier.
      const paramEntryTargets = rows
        .filter((r) => r.editType === "param_entry" && r.targetId)
        .map((r) => ({
          targetId: r.targetId as number,
          op: paramEntryOp(r.proposedValue),
        }));
      const entryIds = Array.from(
        new Set(
          paramEntryTargets
            .filter((t) => t.op !== "create")
            .map((t) => t.targetId),
        ),
      );
      const entryRows = entryIds.length
        ? await db
            .select()
            .from(parameterEntries)
            .where(inArray(parameterEntries.id, entryIds))
        : [];
      const entryMap = new Map(entryRows.map((e) => [e.id, e]));

      const drugIds = Array.from(
        new Set([
          ...rows
            .filter((r) => r.editType === "parameter" && r.targetId)
            .map((r) => r.targetId as number),
          // A create names its drug directly; an update/delete names it
          // through the entry just resolved.
          ...paramEntryTargets
            .filter((t) => t.op === "create")
            .map((t) => t.targetId),
          ...entryRows.map((e) => e.drugId),
        ]),
      );
      const fullPageIds = new Set<number>();
      const contentPageIds = new Set<number>();
      for (const row of rows) {
        if (!row.targetId) continue;
        const hydration = pendingEditPageHydrationFor(row.editType);
        if (hydration === "full") {
          fullPageIds.add(row.targetId);
        } else if (hydration === "content") {
          contentPageIds.add(row.targetId);
        }
      }
      for (const id of fullPageIds) contentPageIds.delete(id);
      // For pending_edit rows with editType='paper_review', targetId carries
      // the citation id (not a paper_reviews id) — the row IS a proposal to
      // create/replace the paper_reviews row for that citation. Without the
      // citation metadata, an agent can't tell what paper the review is of.
      const paperCitationIds = Array.from(
        new Set(
          rows
            .filter((r) => r.editType === "paper_review" && r.targetId)
            .map((r) => r.targetId as number),
        ),
      );
      const [
        drugRows,
        drugParamsMap,
        fullPageRows,
        contentOnlyPageRows,
        paperCiteRows,
      ] = await Promise.all([
        drugIds.length
          ? db.select().from(drugs).where(inArray(drugs.id, drugIds))
          : Promise.resolve([] as Array<typeof drugs.$inferSelect>),
        drugIds.length
          ? getDrugParametersByDrugIds(db, drugIds)
          : Promise.resolve(new Map<number, Map<string, unknown>>()),
        fullPageIds.size
          ? db
              .select({
                id: wikiPages.id,
                title: wikiPages.title,
                content: wikiPages.content,
                contentHtml: wikiPages.contentHtml,
                pageType: wikiPages.pageType,
                status: wikiPages.status,
              })
              .from(wikiPages)
              .where(inArray(wikiPages.id, [...fullPageIds]))
          : Promise.resolve(
              [] as Array<{
                id: number;
                title: string;
                content: unknown;
                contentHtml: string | null;
                pageType: string;
                status: string;
              }>,
            ),
        contentPageIds.size
          ? db
              .select({
                id: wikiPages.id,
                title: wikiPages.title,
                content: wikiPages.content,
                pageType: wikiPages.pageType,
                status: wikiPages.status,
              })
              .from(wikiPages)
              .where(inArray(wikiPages.id, [...contentPageIds]))
          : Promise.resolve(
              [] as Array<{
                id: number;
                title: string;
                content: unknown;
                pageType: string;
                status: string;
              }>,
            ),
        paperCitationIds.length
          ? db
              .select({
                id: citations.id,
                type: citations.type,
                identifier: citations.identifier,
                metadata: citations.metadata,
              })
              .from(citations)
              .where(inArray(citations.id, paperCitationIds))
          : Promise.resolve(
              [] as Array<{
                id: number;
                type: string;
                identifier: string;
                metadata: unknown;
              }>,
            ),
      ]);
      const drugMap = new Map(drugRows.map((d) => [d.id, d]));
      // Filter out unpublished pages — verifying agents are contributor-level
      // and must not see draft monograph content via the queue, even when an
      // editor/admin submitted a pending edit against it. /api/wiki/pages
      // applies the same canReadWikiPageStatus rule on the read path.
      const pageMap = new Map<
        number,
        {
          id: number;
          title: string;
          content: unknown;
          contentHtml: string | null;
          pageType: string;
          status: string;
        }
      >();
      for (const page of fullPageRows) {
        if (page.status === "published") pageMap.set(page.id, page);
      }
      for (const page of contentOnlyPageRows) {
        if (page.status === "published") {
          pageMap.set(page.id, { ...page, contentHtml: null });
        }
      }
      const paperCitationMap = new Map(paperCiteRows.map((c) => [c.id, c]));

      // The candidate query above already excludes wiki_new and draft-page
      // wiki edits in SQL via pendingEditWikiVisibility(); the pageMap built
      // from pageRows is consistent with that filter (only published pages).
      return rows.map((r) => {
        let drugName: string | undefined;
        let currentValue: unknown;
        let currentEntry: unknown;
        let pageTitle: string | undefined;
        let currentContent: unknown;
        let currentContentHtml: string | null | undefined;
        let citation:
          | {
              id: number;
              type: string;
              identifier: string;
              metadata: unknown;
            }
          | undefined;

        if (r.editType === "paper_review" && r.targetId) {
          citation = paperCitationMap.get(r.targetId) ?? undefined;
        } else if (
          (r.editType === "parameter" || r.editType === "param_entry") &&
          r.targetId
        ) {
          // For a `param_entry` update/delete the entry carries the drug and
          // the parameter; for everything else `targetId` is the drug id and
          // the row carries the parameter.
          //
          // Gated on the op, not on a bare `entryMap` hit: `drugs.id` and
          // `parameter_entries.id` are independent serial namespaces, so a
          // create for drug N in the same batch as an update for entry N
          // would otherwise be handed that entry's drug, parameter and
          // current value — a plausible-looking baseline for the wrong row.
          const expectsEntry =
            r.editType === "param_entry" &&
            paramEntryOp(r.proposedValue) !== "create";
          const entry = expectsEntry ? entryMap.get(r.targetId) : undefined;
          if (entry) currentEntry = entry;
          // A proposal that names an entry which no longer exists (a direct
          // delete can remove it while the proposal stays pending — see
          // `markEntryMutationsConflicted`) resolves to NO drug context.
          // Falling back to `r.targetId` would read an entry id as a drug id
          // and hydrate an unrelated drug's current value: a plausible
          // baseline for the wrong row, which is worse than none at all.
          const drugId = entry
            ? entry.drugId
            : expectsEntry
              ? null
              : r.targetId;
          const parameter = entry ? entry.parameter : r.parameter;
          const drug = drugId == null ? undefined : drugMap.get(drugId);
          if (drug) {
            // Site primary language is Norwegian; resolve 'nb' (falls back to
            // English when absent). Mirrors the /api/pending-edits queue and
            // activeLangCode()'s 'nb' default — keep the two queues in sync.
            drugName = resolveDrugName(drug.names, "nb");
            if (parameter && isDrugParameterId(parameter)) {
              currentValue = readParameterValue(
                drug as Record<string, unknown>,
                parameter,
                drugParamsMap.get(drug.id),
              );
            }
          }
        } else if (
          (r.editType === "wiki_page" ||
            r.editType === "wiki_fact" ||
            r.editType === "wiki_section") &&
          r.targetId
        ) {
          const page = pageMap.get(r.targetId);
          if (page) {
            pageTitle = page.title;
            currentContent = page.content;
            currentContentHtml = page.contentHtml;
          }
        }

        return {
          targetType: "pending_edit" as const,
          targetId: r.id,
          // Version stays in sync with verificationTargetVersion() — status is
          // folded in so a later approve/reject/return invalidates the agent's
          // queued verdict via the existing stale-version 409 path.
          targetVersion: `${r.submittedAt.toISOString()}|${r.status}`,
          createdAt: r.submittedAt.toISOString(),
          authorUserId: r.submittedBy,
          payload: {
            editType: r.editType,
            targetId: r.targetId,
            parameter: r.parameter,
            proposedValue: r.proposedValue,
            proposedMeta: r.proposedMeta,
            // Same rule as the review card and the approval gate: an empty
            // `reference_ids` is a row that never set one, so the packet must
            // fall back to the singular id or a verifier judges a legacy
            // proposal with no citation in front of it.
            referenceIds: effectiveProposalReferenceIds(r),
            status: r.status,
            sectionId: r.sectionId,
            fieldId: r.fieldId,
            factStatement: r.factStatement,
            factOperation: r.factOperation,
            factTargetAnchor: r.factTargetAnchor,
            // Baseline context — agents compare against these to form a
            // verdict. drugName/currentValue for parameter and param_entry
            // edits, plus currentEntry (the parameter_entries row itself) for
            // a param_entry update or delete, whose proposedValue names only
            // the operation; pageTitle/currentContent for wiki_* edits;
            // citation for paper_review edits (targetId points at citations,
            // not paper_reviews).
            drugName,
            currentValue,
            currentEntry,
            pageTitle,
            currentContent,
            currentContentHtml,
            citation,
          },
        };
      });
    }
  }
}

export function unverifiedByAgent(
  targetType: AgentVerificationTargetType,
  targetIdColumn: unknown,
  agentId: number,
  opts: {
    ignoreImplicit?: boolean;
    includeJudged?: boolean;
    revisitAbstainedBefore?: Date;
  } = {},
): SQL {
  if (opts.includeJudged) return sql`true`;
  if (opts.revisitAbstainedBefore) {
    return abstainedByAgentBefore(
      targetType,
      targetIdColumn,
      agentId,
      opts.revisitAbstainedBefore,
    );
  }
  // A self-review agent has an implicit-approve row on everything it
  // submitted (written by the API at submit time), so a NOT EXISTS over ALL
  // its rows would hide exactly the work the flag exists to surface — the
  // author-exclusion filter comes off and the row still never appears.
  // Ignoring implicit rows asks the question the queue actually means: has
  // this agent formed a *judgment* on the target yet? For an agent that does
  // not self-review the two readings coincide, since implicit rows are only
  // ever written for the submitter.
  const alreadyJudged = opts.ignoreImplicit
    ? sql` and ${agentVerifications.isImplicit} = false`
    : sql``;
  return sql`not exists (
    select 1
    from ${agentVerifications}
    where ${agentVerifications.agentId} = ${agentId}
      and ${agentVerifications.targetType} = ${targetType}
      and ${agentVerifications.targetId} = ${targetIdColumn as SQL}${alreadyJudged}
  )`;
}

/**
 * The abstention-recovery predicate (`?revisit=abstained`): the caller's live,
 * explicit `abstain` on this target, last written before `before`.
 *
 * The normal queue hides every target the agent has a verdict on, and an
 * `abstain` is a verdict — so a target abstained on for a reason that has
 * since gone away (a worker running a stale checkout without the full-text
 * helper, a missing tool) never comes back on its own. This is the deliberate
 * way back. A fresh verdict on the target upserts over the abstention.
 *
 * Excluded, because they are not the agent's own blind abstention:
 *   - implicit rows (the submitter's stake, never an `abstain` anyway);
 *   - an abstention produced by withdrawing a dispute after reading the peers
 *     (`agent_verdict_reconsiderations`) — that verdict is frozen, and the
 *     POST would refuse a new one (`frozenLiveVerdictId`).
 *
 * `before` is what keeps the pass finite: re-abstaining rewrites the row's
 * `updated_at` past the cutoff, so a target the agent still cannot judge
 * drops out instead of being served forever.
 */
export function abstainedByAgentBefore(
  targetType: AgentVerificationTargetType,
  targetIdColumn: unknown,
  agentId: number,
  before: Date,
): SQL {
  return sql`exists (
    select 1
    from ${agentVerifications}
    where ${agentVerifications.agentId} = ${agentId}
      and ${agentVerifications.targetType} = ${targetType}
      and ${agentVerifications.targetId} = ${targetIdColumn as SQL}
      and ${agentVerifications.verdict} = 'abstain'
      and ${agentVerifications.isImplicit} = false
      and ${lt(agentVerifications.updatedAt, before)}
      and not exists (
        select 1
        from ${agentVerdictReconsiderations}
        where ${agentVerdictReconsiderations.verificationId} = ${agentVerifications.id}
      )
  )`;
}

// NOTE: the pending_edit branch deliberately does NOT filter on who submitted
// the edit. It used to require an active-agent submitter, which meant a human
// contributor's proposal was invisible to every agent: no agent could read it,
// so no agent ever commented, disputed, or corroborated it, and it sat in the
// moderator queue untouched until a human moderator happened to look (#1006
// follow-up — two wiki_fact proposals sat a week with zero agent activity).
// Human-submitted edits are now queued for peer verification like any other.
// Since kinetix-consensus v2 there is no asymmetry left on the apply side
// either: agent verdicts on a person's proposal publish it at quorum exactly
// as they would an agent's, and a dispute holds it.
/**
 * SQL filter that drops pending_edit rows whose proposedValue references
 * unpublished wiki content: wiki_new (always pre-publication) and
 * wiki_page/wiki_fact/wiki_section against a draft page. /api/wiki/pages
 * applies the same canReadWikiPageStatus rule to the public read path; the
 * verification queue audience is contributor-level agents, so it must too.
 *
 * Done in SQL rather than in-process so the LIMIT clause stays honest — a
 * queue full of old draft submissions would otherwise starve later eligible
 * work under the cap.
 */
export function pendingEditWikiVisibility(): SQL {
  return sql`(
    ${pendingEdits.editType} not in ('wiki_new','wiki_page','wiki_fact','wiki_section')
    or (
      ${pendingEdits.editType} in ('wiki_page','wiki_fact','wiki_section')
      and exists (
        select 1 from ${wikiPages}
        where ${wikiPages.id} = ${pendingEdits.targetId}
          and ${wikiPages.status} = 'published'
      )
    )
  )`;
}

/**
 * `ne(col, x)` in Drizzle/Postgres returns false when `col IS NULL`, which
 * would silently filter out NULL-author rows. For paper_review.createdBy
 * (nullable), we want NULL authors to pass the filter — they can't be the
 * caller. Builds `col IS NULL OR col <> x`.
 */
function eqOrNullNotEqual(col: unknown, value: number): SQL {
  return sql`(${col as SQL} is null or ${col as SQL} <> ${value})`;
}

/**
 * The author-exclusion predicate every candidate query carries: an agent does
 * not review what it wrote.
 *
 * Returns `undefined` — i.e. no predicate at all, which `and()` drops — for an
 * agent an admin has cleared to review its own work
 * (`agents.self_review_enabled`). Withholding the filter is the whole of what
 * "see your own work in the queue" means on the read side; the write side
 * (POST /api/agent-verifications) re-checks the same flag, so a stale or
 * spoofed queue listing can't be turned into a verdict on its own.
 *
 * `nullable` picks the NULL-safe form for columns where a NULL author is a
 * real value that must still pass (see eqOrNullNotEqual).
 */
export function notAuthoredByCaller(
  col: PgColumn,
  args: { agentUserId: number; selfReviewEnabled: boolean },
  opts: { nullable?: boolean } = {},
): SQL | undefined {
  if (args.selfReviewEnabled) return undefined;
  return opts.nullable
    ? eqOrNullNotEqual(col, args.agentUserId)
    : ne(col, args.agentUserId);
}
