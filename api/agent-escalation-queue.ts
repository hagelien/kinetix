/**
 * Blind, identifier-only escalation feed for the T2 flagship verifier.
 *
 *   GET ?limit=
 *
 * Implements the "identifier-only T2 escalation feed" that
 * `agents/remote-routine-setup.md` (Escalation chain / Backend prerequisites
 * §1) and `agents/drug-db-escalation.md` ("Not yet available") both name as
 * missing: T2 currently has no way to learn that a target needs its blind
 * judgment without reading the very rationale (`GET /api/disputes`
 * `reasonMd`/`evidenceRefs`, a moderator's `parameter_priority_flags.note`, a
 * rejection's `rejectionComment`, a `verification_log.agent_notes`) that
 * would contaminate the independent verdict
 * (`agents/peer-verification-protocol.md` §1). This route answers only
 * *that a target needs attention and why in one word*, never *what anyone
 * else concluded about it*.
 *
 * Covers four of the §7 T1→T2 triggers that are recorded in the schema
 * today: an open peer dispute, an editor/admin priority flag, a resubmission
 * after a prior return/rejection on the same target, and a `weak`/`absent`
 * concordance from the last exhaustive search. Deliberately does NOT cover:
 *
 *   - a proposed replacement of a calculation-driving parameter — this is
 *     already visible from the *content* the standard queue hands out
 *     (`payload.parameter`), which is exactly what `agents/drug-db-
 *     escalation.md` §1 already tells T2 to prioritise by; adding it here
 *     would duplicate a signal T2 can already read without contaminating
 *     anything;
 *   - "materially conflicting primary studies" and the "paper-review deeper-
 *     pass triggers" — neither has a schema representation anywhere in the
 *     codebase today (confirmed against `db/schema.ts`), so deriving them is
 *     new modelling work, not a query over an existing signal. ("Conflicting
 *     studies" is in practice already caught by `weak_concordance`, whose
 *     own definition covers "conflicting or sparse sources" — the column has
 *     no sub-code separating the two.)
 *   - the CORRECTION/RETRACTION half of the citation trigger — no column
 *     records a retraction, correction or expression of concern. The
 *     identifier-INCONSISTENCY half is covered: see
 *     `citation_identifier_inconsistency` below.
 *
 * Auth: any active agent (same gate as `agent-verifications-queue.ts`).
 */

import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  lt,
  ne,
  or,
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
import {
  resolveActiveAgent,
  verificationTargetVersion,
} from "./_lib/agent-verifications.js";
import {
  notAuthoredByCaller,
  pendingEditWikiVisibility,
  unverifiedByAgent,
} from "./agent-verifications-queue.js";
import { agentVerificationTargetTypeSchema } from "./_lib/schemas.js";
import {
  agentVerifications,
  citations,
  disputes,
  drugParameterRevisions,
  drugParameterDiscussions,
  paperReviews,
  parameterPriorityFlags,
  pendingEdits,
  verificationLog,
  wikiPages,
  wikiRevisions,
  type AgentVerificationTargetType,
} from "../db/schema.js";

const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
const PRIVATE_ESCALATION_HEADERS = noStoreHeaders();

// Generous upper bounds on how many raw rows each trigger scans before the
// eligibility filters and risk-ranking run. The signals themselves are all
// documented elsewhere in this codebase as small (a "handful of rows" for
// disputes and priority flags); these caps exist to bound worst-case cost,
// not because the normal case is expected to approach them.
// Exported so a regression test can seed exactly this many rows rather than
// a magic number that would silently stop matching the real cap.
export const DISPUTE_SCAN_CAP = 200;
export const FLAG_REVISION_SCAN_CAP = 200;
const CONCORDANCE_REVISION_SCAN_CAP = 200;
const REJECTION_HISTORY_SCAN_CAP = 200;
export const CONFLICTED_CITATION_SCAN_CAP = 200;

/**
 * The escalation reasons this feed can report, ordered most- to
 * least-urgent. The array order IS the risk rank — see
 * `ESCALATION_REASON_RANK` below — so reordering this list changes serving
 * order.
 *
 *   1. open_dispute — a live contestation already blocks consensus
 *      auto-apply; it is the case #1231 itself names as "a lottery ticket,
 *      not a control" when nothing routes it to T2.
 *   2. admin_flag — a human editor/admin explicitly asked for eyes on this
 *      drug/parameter now.
 *   3. absent_concordance — the last exhaustive search found nothing on a
 *      parameter that is supposed to have coverage; either a real gap or a
 *      missed source, and either way a mid-tier "no result" is the case most
 *      likely to hide a search-miss.
 *   4. reviewer_rejection_history — this exact target was already sent back
 *      once; the resubmission deserves a fresh, expert look rather than
 *      trusting the same reviewer path that missed it (or was wrong) before.
 *   5. citation_identifier_inconsistency — a cited reference's own
 *      identifier registries disagree about what work it names
 *      (`citations.work_kind_status = 'conflicted'`, §13.3). The value may
 *      be sound and still be attributed to the wrong paper, which is a
 *      provenance defect a blind re-verification is exactly the right tool
 *      for. Ranked below a resubmission because the disagreement is about
 *      the source's identity rather than the datum, and above
 *      weak_concordance because it is a definite recorded conflict rather
 *      than a judgement that the evidence is thin.
 *   6. weak_concordance — sources exist but disagree or are thin; lower
 *      urgency than a full miss, still above the baseline queue.
 */
export const ESCALATION_REASON_CODES = [
  "open_dispute",
  "admin_flag",
  "absent_concordance",
  "reviewer_rejection_history",
  "citation_identifier_inconsistency",
  "weak_concordance",
] as const;

export type EscalationReasonCode = (typeof ESCALATION_REASON_CODES)[number];

export const ESCALATION_REASON_RANK: Readonly<
  Record<EscalationReasonCode, number>
> = Object.fromEntries(
  ESCALATION_REASON_CODES.map((code, i) => [code, i]),
) as Record<EscalationReasonCode, number>;

export interface EscalationItem {
  targetType: AgentVerificationTargetType;
  targetId: number;
  targetVersion: string;
  reasonCodes: EscalationReasonCode[];
}

interface RawCandidate {
  targetType: AgentVerificationTargetType;
  targetId: number;
  reasonCode: EscalationReasonCode;
}

interface MergedCandidate {
  targetType: AgentVerificationTargetType;
  targetId: number;
  reasonCodes: EscalationReasonCode[];
}

interface EscalationQueryArgs {
  agentId: number;
  agentUserId: number;
  selfReviewEnabled: boolean;
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

  const items = await buildEscalationFeed({
    agentId: agent.id,
    agentUserId: auth.userId,
    selfReviewEnabled: agent.selfReviewEnabled,
    limit,
  });

  json(
    res,
    200,
    {
      items,
      agent: {
        id: agent.id,
        slug: agent.slug,
        selfReviewEnabled: agent.selfReviewEnabled,
      },
    },
    { headers: PRIVATE_ESCALATION_HEADERS },
  );
});

/**
 * Fetch, merge, rank and hydrate the served escalation batch end to end.
 * Exported so a diagnostic (or a future caller) can obtain the batch a given
 * agent would be served without going through HTTP.
 */
export async function buildEscalationFeed(
  args: EscalationQueryArgs & { limit: number },
): Promise<EscalationItem[]> {
  const [
    disputed,
    adminFlagged,
    concordanceGap,
    rejectionHistory,
    conflictedCitations,
  ] = await Promise.all([
    fetchEligibleDisputedTargets(args),
    fetchAdminFlagCandidates(args),
    fetchConcordanceGapCandidates(args),
    fetchRejectionHistoryCandidates(args),
    fetchConflictedCitationCandidates(args),
  ]);

  const raw: RawCandidate[] = [
    ...disputed.map((c) => ({ ...c, reasonCode: "open_dispute" as const })),
    ...adminFlagged.map((c) => ({ ...c, reasonCode: "admin_flag" as const })),
    ...concordanceGap,
    ...rejectionHistory.map((c) => ({
      ...c,
      reasonCode: "reviewer_rejection_history" as const,
    })),
    ...conflictedCitations.map((c) => ({
      ...c,
      reasonCode: "citation_identifier_inconsistency" as const,
    })),
  ];

  const batch = selectEscalationBatch(mergeEscalationCandidates(raw), args.limit);
  return hydrateEscalationBatch(batch);
}

/**
 * Collapse raw (target, single reason) rows into one entry per target,
 * carrying every reason it triggered. Pure — no DB — so it is unit-tested
 * directly.
 */
export function mergeEscalationCandidates(
  raw: RawCandidate[],
): MergedCandidate[] {
  const byKey = new Map<
    string,
    { targetType: AgentVerificationTargetType; targetId: number; reasonCodes: Set<EscalationReasonCode> }
  >();
  for (const c of raw) {
    const key = `${c.targetType}:${c.targetId}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { targetType: c.targetType, targetId: c.targetId, reasonCodes: new Set() };
      byKey.set(key, entry);
    }
    entry.reasonCodes.add(c.reasonCode);
  }
  return [...byKey.values()].map((e) => ({
    targetType: e.targetType,
    targetId: e.targetId,
    reasonCodes: [...e.reasonCodes].sort(
      (a, b) => ESCALATION_REASON_RANK[a] - ESCALATION_REASON_RANK[b],
    ),
  }));
}

/**
 * Rank by the most severe reason each target carries, tie-broken by target
 * id for a stable, reproducible order. Pure — no DB — so it is unit-tested
 * directly, mirroring `selectQueueBatch` in the sibling queue route.
 */
export function selectEscalationBatch(
  items: MergedCandidate[],
  limit: number,
): MergedCandidate[] {
  if (limit <= 0) return [];
  const rankOf = (item: MergedCandidate) =>
    Math.min(...item.reasonCodes.map((c) => ESCALATION_REASON_RANK[c]));
  return [...items]
    .sort((a, b) => rankOf(a) - rankOf(b) || a.targetId - b.targetId)
    .slice(0, limit);
}

/**
 * Attach the current `targetVersion` to each item the served batch settled
 * on, dropping any target that vanished between the scan and this read (e.g.
 * a pending edit that was moderated in the interim) rather than handing the
 * agent a target it can no longer act on.
 */
async function hydrateEscalationBatch(
  batch: MergedCandidate[],
): Promise<EscalationItem[]> {
  const versions = await Promise.all(
    batch.map((item) =>
      verificationTargetVersion({
        targetType: item.targetType,
        targetId: item.targetId,
      }),
    ),
  );
  const out: EscalationItem[] = [];
  batch.forEach((item, i) => {
    const targetVersion = versions[i];
    if (targetVersion == null) return;
    out.push({
      targetType: item.targetType,
      targetId: item.targetId,
      targetVersion,
      reasonCodes: item.reasonCodes,
    });
  });
  return out;
}

// ─── Trigger 1: open peer dispute (any target type) ─────────────────────────

async function fetchEligibleDisputedTargets(
  args: EscalationQueryArgs,
): Promise<Array<{ targetType: AgentVerificationTargetType; targetId: number }>> {
  const db = getDb();
  // Excludes targets this agent already verified directly in the scan,
  // before DISPUTE_SCAN_CAP applies — not just downstream in
  // fetchEligibleIdsOfType. An open dispute stays open until a moderator
  // resolves it, so without this a target this agent already judged would
  // occupy a cap slot on every future call, permanently displacing any open
  // dispute past the cap. Ordered oldest-first (by each target's earliest
  // open dispute) using the same index disputes_status_created_idx exists
  // for, so once the growing "already verified" exclusion above retires a
  // target from the scan, the next-oldest one is served deterministically —
  // no target beyond the cap waits longer than it takes to work through the
  // ones ahead of it.
  const disputedRows = await db
    .select({
      targetType: disputes.targetType,
      targetId: disputes.targetId,
      firstDisputedAt: sql<Date>`min(${disputes.createdAt})`,
    })
    .from(disputes)
    .where(
      and(
        eq(disputes.status, "open"),
        sql`not exists (
          select 1 from ${agentVerifications}
          where ${agentVerifications.agentId} = ${args.agentId}
            and ${agentVerifications.targetType} = ${disputes.targetType}
            and ${agentVerifications.targetId} = ${disputes.targetId}
        )`,
      ),
    )
    .groupBy(disputes.targetType, disputes.targetId)
    .orderBy(asc(sql`min(${disputes.createdAt})`))
    .limit(DISPUTE_SCAN_CAP);

  const idsByType = new Map<AgentVerificationTargetType, number[]>();
  for (const row of disputedRows) {
    // disputes.target_type is an unconstrained varchar (shared taxonomy, no
    // SQL FK); validate rather than trust it before using it as a discriminator.
    const parsed = agentVerificationTargetTypeSchema.safeParse(row.targetType);
    if (!parsed.success) continue;
    const list = idsByType.get(parsed.data) ?? [];
    list.push(row.targetId);
    idsByType.set(parsed.data, list);
  }

  const results: Array<{ targetType: AgentVerificationTargetType; targetId: number }> = [];
  for (const [type, ids] of idsByType) {
    if (ids.length === 0) continue;
    results.push(...(await fetchEligibleIdsOfType(type, ids, args)));
  }
  return results;
}

/**
 * Given a candidate id list for one target type, apply exactly the same
 * author-exclusion, already-verified, and (for pending edits and wiki
 * revisions) visibility predicates the standard peer-verification queue
 * applies — reused from `agent-verifications-queue.ts` rather than
 * re-derived, so the two feeds can never disagree about who may see what.
 *
 * `learning_unit_revision` is deliberately absent: the standard queue keeps
 * it out of its interleaved set too (half-wired schema; see that file's
 * `ALL_TYPES` comment), so it falls through here to the empty default.
 */
async function fetchEligibleIdsOfType(
  type: AgentVerificationTargetType,
  ids: number[],
  args: EscalationQueryArgs,
): Promise<Array<{ targetType: AgentVerificationTargetType; targetId: number }>> {
  const db = getDb();
  switch (type) {
    case "pending_edit": {
      const rows = await db
        .select({ id: pendingEdits.id })
        .from(pendingEdits)
        .where(
          and(
            inArray(pendingEdits.id, ids),
            eq(pendingEdits.status, "pending"),
            notAuthoredByCaller(pendingEdits.submittedBy, args),
            unverifiedByAgent("pending_edit", pendingEdits.id, args.agentId, {
              ignoreImplicit: args.selfReviewEnabled,
            }),
            pendingEditWikiVisibility(),
          ),
        );
      return rows.map((r) => ({ targetType: "pending_edit" as const, targetId: r.id }));
    }
    case "drug_parameter_revision": {
      const rows = await db
        .select({ id: drugParameterRevisions.id })
        .from(drugParameterRevisions)
        .where(
          and(
            inArray(drugParameterRevisions.id, ids),
            notAuthoredByCaller(drugParameterRevisions.createdBy, args),
            unverifiedByAgent(
              "drug_parameter_revision",
              drugParameterRevisions.id,
              args.agentId,
              { ignoreImplicit: args.selfReviewEnabled },
            ),
          ),
        );
      return rows.map((r) => ({ targetType: "drug_parameter_revision" as const, targetId: r.id }));
    }
    case "wiki_revision": {
      const rows = await db
        .select({ id: wikiRevisions.id })
        .from(wikiRevisions)
        .innerJoin(wikiPages, eq(wikiPages.id, wikiRevisions.pageId))
        .where(
          and(
            inArray(wikiRevisions.id, ids),
            eq(wikiPages.status, "published"),
            notAuthoredByCaller(wikiRevisions.createdBy, args),
            unverifiedByAgent("wiki_revision", wikiRevisions.id, args.agentId, {
              ignoreImplicit: args.selfReviewEnabled,
            }),
          ),
        );
      return rows.map((r) => ({ targetType: "wiki_revision" as const, targetId: r.id }));
    }
    case "paper_review": {
      const rows = await db
        .select({ id: paperReviews.id })
        .from(paperReviews)
        .where(
          and(
            inArray(paperReviews.id, ids),
            notAuthoredByCaller(paperReviews.createdBy, args, { nullable: true }),
            unverifiedByAgent("paper_review", paperReviews.id, args.agentId, {
              ignoreImplicit: args.selfReviewEnabled,
            }),
          ),
        );
      return rows.map((r) => ({ targetType: "paper_review" as const, targetId: r.id }));
    }
    case "drug_discussion": {
      const rows = await db
        .select({ id: drugParameterDiscussions.id })
        .from(drugParameterDiscussions)
        .where(
          and(
            inArray(drugParameterDiscussions.id, ids),
            isNotNull(drugParameterDiscussions.drugId),
            notAuthoredByCaller(drugParameterDiscussions.createdBy, args),
            unverifiedByAgent(
              "drug_discussion",
              drugParameterDiscussions.id,
              args.agentId,
              { ignoreImplicit: args.selfReviewEnabled },
            ),
          ),
        );
      return rows.map((r) => ({ targetType: "drug_discussion" as const, targetId: r.id }));
    }
    default:
      return [];
  }
}

// ─── Triggers 2–4: drug/parameter-scoped signals ────────────────────────────
//
// Editor/admin flags, concordance history and rejection history are all
// concepts that only apply to a (drug, parameter) pair today — there is no
// schema equivalent for a wiki page, a paper review or a discussion thread —
// so these three triggers only ever produce `pending_edit` and
// `drug_parameter_revision` candidates.

/**
 * The same (drug, parameter) scope as `buildDrugParameterMatcher`, but as a
 * where-clause fragment so the bounded revision scans below cap MATCHING rows
 * rather than every row of a flagged drug.
 *
 * Filtering on the drug alone and matching the parameter afterwards in JS is
 * lossy once a drug has more revisions than the scan cap: a flag naming one
 * parameter would spend the whole cap on that drug's other parameters and
 * lose the flagged revision it exists to surface. A row-wise
 * `(drug_id, parameter) IN ((…))` keeps the parameter identity in SQL; a flag
 * with a NULL parameter still means the whole drug.
 */
function drugParameterScope(
  drugColumn: PgColumn,
  parameterColumn: PgColumn,
  pairs: Array<{ drugId: number; parameter: string | null }>,
): SQL | undefined {
  const wholeDrugIds = [
    ...new Set(pairs.filter((p) => p.parameter == null).map((p) => p.drugId)),
  ];
  const scoped = [...
    new Map(
      pairs
        .filter((p): p is { drugId: number; parameter: string } => p.parameter != null)
        .map((p) => [`${p.drugId}:${p.parameter}`, p]),
    ).values(),
  ];
  const parts: SQL[] = [];
  if (wholeDrugIds.length) parts.push(inArray(drugColumn, wholeDrugIds));
  if (scoped.length) {
    const list = sql.join(
      scoped.map((p) => sql`(${p.drugId}, ${p.parameter})`),
      sql`, `,
    );
    parts.push(sql`(${drugColumn}, ${parameterColumn}) in (${list})`);
  }
  if (!parts.length) return undefined;
  return parts.length === 1 ? parts[0] : or(...parts);
}

/** Matches a (drugId, parameter) pair against a set of active priority flags. */
function buildDrugParameterMatcher(
  flags: Array<{ drugId: number; parameter: string | null }>,
): (drugId: number, parameter: string | null) => boolean {
  const wholeDrugIds = new Set(
    flags.filter((f) => f.parameter == null).map((f) => f.drugId),
  );
  const scoped = new Set(
    flags.filter((f) => f.parameter != null).map((f) => `${f.drugId}:${f.parameter}`),
  );
  return (drugId, parameter) =>
    wholeDrugIds.has(drugId) ||
    (parameter != null && scoped.has(`${drugId}:${parameter}`));
}

async function fetchAdminFlagCandidates(
  args: EscalationQueryArgs,
): Promise<Array<{ targetType: "pending_edit" | "drug_parameter_revision"; targetId: number }>> {
  const db = getDb();
  const flags = await db
    .select({ drugId: parameterPriorityFlags.drugId, parameter: parameterPriorityFlags.parameter })
    .from(parameterPriorityFlags)
    .where(eq(parameterPriorityFlags.status, "active"));
  if (flags.length === 0) return [];

  const drugIds = [...new Set(flags.map((f) => f.drugId))];
  const matches = buildDrugParameterMatcher(flags);
  const revisionScope = drugParameterScope(
    drugParameterRevisions.drugId,
    drugParameterRevisions.parameter,
    flags,
  );

  const [peRows, revRows] = await Promise.all([
    db
      .select({ id: pendingEdits.id, targetId: pendingEdits.targetId, parameter: pendingEdits.parameter })
      .from(pendingEdits)
      .where(
        and(
          eq(pendingEdits.status, "pending"),
          inArray(pendingEdits.editType, ["parameter", "param_entry"]),
          inArray(pendingEdits.targetId, drugIds),
          notAuthoredByCaller(pendingEdits.submittedBy, args),
          unverifiedByAgent("pending_edit", pendingEdits.id, args.agentId, {
            ignoreImplicit: args.selfReviewEnabled,
          }),
        ),
      ),
    db
      .select({
        id: drugParameterRevisions.id,
        drugId: drugParameterRevisions.drugId,
        parameter: drugParameterRevisions.parameter,
      })
      .from(drugParameterRevisions)
      .where(
        and(
          revisionScope,
          notAuthoredByCaller(drugParameterRevisions.createdBy, args),
          unverifiedByAgent(
            "drug_parameter_revision",
            drugParameterRevisions.id,
            args.agentId,
            { ignoreImplicit: args.selfReviewEnabled },
          ),
        ),
      )
      .orderBy(desc(drugParameterRevisions.createdAt))
      .limit(FLAG_REVISION_SCAN_CAP),
  ]);

  const out: Array<{ targetType: "pending_edit" | "drug_parameter_revision"; targetId: number }> = [];
  for (const r of peRows) {
    if (r.targetId != null && matches(r.targetId, r.parameter)) {
      out.push({ targetType: "pending_edit", targetId: r.id });
    }
  }
  for (const r of revRows) {
    if (matches(r.drugId, r.parameter)) {
      out.push({ targetType: "drug_parameter_revision", targetId: r.id });
    }
  }
  return out;
}

async function fetchConcordanceGapCandidates(
  args: EscalationQueryArgs,
): Promise<
  Array<{
    targetType: "pending_edit" | "drug_parameter_revision";
    targetId: number;
    reasonCode: "weak_concordance" | "absent_concordance";
  }>
> {
  const db = getDb();
  // Latest verification_log row per (drug, parameter): a later 'strong'
  // supersedes an earlier 'weak'/'absent', so only the most recent outcome
  // should ever drive an escalation. Indexed by verification_log_target_
  // param_idx (target_type, target_id, parameter, verified_at).
  const latest = await db
    .selectDistinctOn(
      [verificationLog.targetId, verificationLog.parameter],
      {
        targetId: verificationLog.targetId,
        parameter: verificationLog.parameter,
        concordance: verificationLog.concordance,
      },
    )
    .from(verificationLog)
    .where(
      and(
        eq(verificationLog.targetType, "parameter"),
        isNotNull(verificationLog.targetId),
        isNotNull(verificationLog.parameter),
      ),
    )
    .orderBy(
      verificationLog.targetId,
      verificationLog.parameter,
      desc(verificationLog.verifiedAt),
    );

  const weakKeys = new Set<string>();
  const absentKeys = new Set<string>();
  for (const row of latest) {
    if (row.targetId == null || row.parameter == null) continue;
    const key = `${row.targetId}:${row.parameter}`;
    if (row.concordance === "weak") weakKeys.add(key);
    else if (row.concordance === "absent") absentKeys.add(key);
  }
  if (weakKeys.size === 0 && absentKeys.size === 0) return [];

  const drugIds = [
    ...new Set([...weakKeys, ...absentKeys].map((k) => Number(k.split(":")[0]))),
  ];
  // Same reason as the flag scan: cap MATCHING rows, not every revision of a
  // drug that has one weak parameter.
  const concordancePairs = [...weakKeys, ...absentKeys].map((k) => {
    const sep = k.indexOf(":");
    return { drugId: Number(k.slice(0, sep)), parameter: k.slice(sep + 1) };
  });
  const revisionScope = drugParameterScope(
    drugParameterRevisions.drugId,
    drugParameterRevisions.parameter,
    concordancePairs,
  );
  const classify = (
    drugId: number,
    parameter: string | null,
  ): "weak_concordance" | "absent_concordance" | null => {
    if (parameter == null) return null;
    const key = `${drugId}:${parameter}`;
    if (absentKeys.has(key)) return "absent_concordance";
    if (weakKeys.has(key)) return "weak_concordance";
    return null;
  };

  const [peRows, revRows] = await Promise.all([
    db
      .select({ id: pendingEdits.id, targetId: pendingEdits.targetId, parameter: pendingEdits.parameter })
      .from(pendingEdits)
      .where(
        and(
          eq(pendingEdits.status, "pending"),
          inArray(pendingEdits.editType, ["parameter", "param_entry"]),
          inArray(pendingEdits.targetId, drugIds),
          notAuthoredByCaller(pendingEdits.submittedBy, args),
          unverifiedByAgent("pending_edit", pendingEdits.id, args.agentId, {
            ignoreImplicit: args.selfReviewEnabled,
          }),
        ),
      ),
    db
      .select({
        id: drugParameterRevisions.id,
        drugId: drugParameterRevisions.drugId,
        parameter: drugParameterRevisions.parameter,
      })
      .from(drugParameterRevisions)
      .where(
        and(
          revisionScope,
          notAuthoredByCaller(drugParameterRevisions.createdBy, args),
          unverifiedByAgent(
            "drug_parameter_revision",
            drugParameterRevisions.id,
            args.agentId,
            { ignoreImplicit: args.selfReviewEnabled },
          ),
        ),
      )
      .orderBy(desc(drugParameterRevisions.createdAt))
      .limit(CONCORDANCE_REVISION_SCAN_CAP),
  ]);

  const out: Array<{
    targetType: "pending_edit" | "drug_parameter_revision";
    targetId: number;
    reasonCode: "weak_concordance" | "absent_concordance";
  }> = [];
  for (const r of peRows) {
    if (r.targetId == null) continue;
    const reason = classify(r.targetId, r.parameter);
    if (reason) out.push({ targetType: "pending_edit", targetId: r.id, reasonCode: reason });
  }
  for (const r of revRows) {
    const reason = classify(r.drugId, r.parameter);
    if (reason) out.push({ targetType: "drug_parameter_revision", targetId: r.id, reasonCode: reason });
  }
  return out;
}

/**
 * A pending edit whose (editType, targetId, parameter) identity was
 * previously submitted and returned/rejected, then resubmitted. NULL
 * targetId/parameter (e.g. a `wiki_new` page-creation proposal) never
 * matches its own kind here: those edit types have no stable identity across
 * submissions, so "resubmission of the same target" is not a meaningful
 * question to ask of them — this is a conservative gap, never a false
 * escalation.
 *
 * Two narrowing conditions keep this a true "resubmission" signal:
 *
 *  - the prior rejection/return must have been reviewed strictly before the
 *    candidate was submitted. Without this, a proposal submitted before some
 *    sibling proposal on the same identity was later rejected still matches
 *    — it was never a reaction to that rejection.
 *  - `param_entry` **creates** are excluded from the EXISTS match entirely.
 *    `(editType, targetId, parameter)` is a true 1:1 identity for direct
 *    `parameter` edits and for `param_entry` update/delete ops (`targetId` is
 *    the entry's own PK there — see `pending_edits_open_parameter_idx` /
 *    `pending_edits_open_entry_idx`'s non-create half), but concurrent
 *    `param_entry` creates on the same (drug, parameter) are explicitly
 *    allowed and share that identity (`pending_edits_open_entry_idx` excludes
 *    `create` for exactly this reason). Matching on it there would attach one
 *    create's rejection history to an unrelated sibling create that was never
 *    resubmitted.
 */
async function fetchRejectionHistoryCandidates(
  args: EscalationQueryArgs,
): Promise<Array<{ targetType: "pending_edit"; targetId: number }>> {
  const db = getDb();
  const priorEdits = alias(pendingEdits, "prior_pending_edits");
  const rows = await db
    .select({ id: pendingEdits.id })
    .from(pendingEdits)
    .where(
      and(
        eq(pendingEdits.status, "pending"),
        notAuthoredByCaller(pendingEdits.submittedBy, args),
        unverifiedByAgent("pending_edit", pendingEdits.id, args.agentId, {
          ignoreImplicit: args.selfReviewEnabled,
        }),
        pendingEditWikiVisibility(),
        sql`not (${pendingEdits.editType} = 'param_entry' and (${pendingEdits.proposedValue} ->> 'op') = 'create')`,
        exists(
          db
            .select({ one: sql`1` })
            .from(priorEdits)
            .where(
              and(
                eq(priorEdits.editType, pendingEdits.editType),
                eq(priorEdits.targetId, pendingEdits.targetId),
                eq(priorEdits.parameter, pendingEdits.parameter),
                inArray(priorEdits.status, ["rejected", "returned"]),
                ne(priorEdits.id, pendingEdits.id),
                lt(priorEdits.reviewedAt, pendingEdits.submittedAt),
              ),
            ),
        ),
      ),
    )
    .limit(REJECTION_HISTORY_SCAN_CAP);
  return rows.map((r) => ({ targetType: "pending_edit" as const, targetId: r.id }));
}

// ─── Trigger 5: citation identifier inconsistency ───────────────────────────

/**
 * Targets whose cited reference has identifier registries that disagree about
 * which work it names (`citations.work_kind_status = 'conflicted'`, §13.3).
 *
 * Unlike triggers 2–4 this one is NOT drug/parameter-scoped: a contested
 * citation is a provenance defect wherever it is cited, so every
 * citation-bearing target type the standard queue serves is in scope — a
 * `wiki_fact`/`wiki_section` proposal citing it, a `paper_review` proposal
 * whose `targetId` IS that citation, and the `paper_review` row itself —
 * not only parameter edits.
 *
 * The conflicted-citation set is matched inside SQL rather than pre-selected
 * and capped: capping citations first means a fixed set of them occupies
 * every slot forever once their targets are verified or gone, so a target
 * citing the next conflicted citation could never become visible as the
 * backlog drains. Each per-type scan instead applies the author and
 * already-verified exclusions BEFORE its own cap, exactly as the dispute
 * scan does, so a capped-out target is one genuinely ahead in the queue.
 *
 * Both `reference_ids` and the legacy singular `reference_id` are matched:
 * an empty array beside a populated singular id is a row that never set the
 * array (the effective-reference rule in `src/lib/parameterEntries.ts`), so
 * matching only the array would miss exactly the legacy rows whose one
 * citation is the contested one.
 */
function citesConflictedCitation(
  referenceId: PgColumn,
  referenceIds: PgColumn,
): SQL {
  // Array precedence, not a plain OR: a non-empty `reference_ids` is
  // authoritative and the singular `reference_id` beside it is stale, which
  // is exactly what `effectiveProposalReferenceIds` encodes and what the
  // queue hydrates. Matching the stale id anyway would escalate a target for
  // a conflict its own payload does not expose, leaving T2 with a reason and
  // nothing to inspect.
  return sql`exists (
    select 1 from ${citations}
    where ${citations.workKindStatus} = 'conflicted'
      and case
        when coalesce(cardinality(${referenceIds}), 0) > 0
          then ${citations.id} = any(${referenceIds})
        else ${citations.id} = ${referenceId}
      end
  )`;
}

/**
 * The same question asked of a stored JSON document: does it cite a
 * conflicted citation anywhere inside it?
 *
 * Whole-page wiki proposals and `wiki_revisions.content` carry their
 * citations recursively inside TipTap JSON rather than in the row's
 * top-level reference columns (those are optional for a page edit), so a
 * column-only predicate misses exactly the monograph content a contested
 * source was cited in. The three shapes and the `$.**` recursion are the
 * ones `api/_lib/citation-usage.ts` already established for this data — kept
 * identical on purpose, so "which rows cite this citation" cannot mean two
 * different things in two places.
 */
function jsonCitesConflictedCitation(jsonColumn: PgColumn): SQL {
  const conflictedIds = sql`select ${citations.id} from ${citations}
    where ${citations.workKindStatus} = 'conflicted'`;
  const cites = (path: string): SQL => sql`exists (
    select 1 from jsonb_path_query(${jsonColumn}, ${path}) t(v)
    where jsonb_typeof(t.v) = 'number'
      and (t.v #>> '{}')::int in (${conflictedIds})
  )`;
  return sql`(${cites("$.**.referenceIds[*]")}
    or ${cites("$.**.referenceId")}
    or ${cites("$.**.refs[*]")})`;
}

/** The column itself holds a citation id (a paper_review's target). */
function isConflictedCitation(idColumn: PgColumn): SQL {
  return sql`exists (
    select 1 from ${citations}
    where ${citations.id} = ${idColumn}
      and ${citations.workKindStatus} = 'conflicted'
  )`;
}

async function fetchConflictedCitationCandidates(
  args: EscalationQueryArgs,
): Promise<
  Array<{ targetType: AgentVerificationTargetType; targetId: number }>
> {
  const db = getDb();
  const [peRows, revRows, wikiRows, prRows] = await Promise.all([
    db
      .select({ id: pendingEdits.id })
      .from(pendingEdits)
      .where(
        and(
          eq(pendingEdits.status, "pending"),
          or(
            citesConflictedCitation(
              pendingEdits.referenceId,
              pendingEdits.referenceIds,
            ),
            // A whole-page proposal's citations live inside its payload.
            jsonCitesConflictedCitation(pendingEdits.proposedValue),
            // A paper_review proposal's targetId IS the citation id.
            and(
              eq(pendingEdits.editType, "paper_review"),
              isNotNull(pendingEdits.targetId),
              isConflictedCitation(pendingEdits.targetId),
            ),
          ),
          notAuthoredByCaller(pendingEdits.submittedBy, args),
          unverifiedByAgent("pending_edit", pendingEdits.id, args.agentId, {
            ignoreImplicit: args.selfReviewEnabled,
          }),
          // Inside the scan, not only downstream in `fetchEligibleIdsOfType`:
          // a cap applied before the visibility gate can fill itself entirely
          // with rows that gate then drops (a `wiki_new` proposal, or one
          // against a draft page), leaving every later eligible target
          // permanently outside the scan.
          pendingEditWikiVisibility(),
        ),
      )
      .orderBy(asc(pendingEdits.submittedAt), asc(pendingEdits.id))
      .limit(CONFLICTED_CITATION_SCAN_CAP),
    db
      .select({ id: drugParameterRevisions.id })
      .from(drugParameterRevisions)
      .where(
        and(
          citesConflictedCitation(
            drugParameterRevisions.referenceId,
            drugParameterRevisions.referenceIds,
          ),
          notAuthoredByCaller(drugParameterRevisions.createdBy, args),
          unverifiedByAgent(
            "drug_parameter_revision",
            drugParameterRevisions.id,
            args.agentId,
            { ignoreImplicit: args.selfReviewEnabled },
          ),
        ),
      )
      .orderBy(
        asc(drugParameterRevisions.createdAt),
        asc(drugParameterRevisions.id),
      )
      .limit(CONFLICTED_CITATION_SCAN_CAP),
    db
      .select({ id: wikiRevisions.id })
      .from(wikiRevisions)
      // Published-page visibility inside the scan, not only downstream in
      // `fetchEligibleIdsOfType`: a cap ahead of that gate fills with draft-page
      // revisions the gate then drops, leaving later revisions on published
      // pages permanently outside it. Same join the standard queue uses.
      .innerJoin(wikiPages, eq(wikiPages.id, wikiRevisions.pageId))
      .where(
        and(
          eq(wikiPages.status, "published"),
          jsonCitesConflictedCitation(wikiRevisions.content),
          notAuthoredByCaller(wikiRevisions.createdBy, args),
          unverifiedByAgent("wiki_revision", wikiRevisions.id, args.agentId, {
            ignoreImplicit: args.selfReviewEnabled,
          }),
        ),
      )
      .orderBy(asc(wikiRevisions.createdAt), asc(wikiRevisions.id))
      .limit(CONFLICTED_CITATION_SCAN_CAP),
    db
      .select({ id: paperReviews.id })
      .from(paperReviews)
      .where(
        and(
          isConflictedCitation(paperReviews.citationId),
          notAuthoredByCaller(paperReviews.createdBy, args, { nullable: true }),
          unverifiedByAgent("paper_review", paperReviews.id, args.agentId, {
            ignoreImplicit: args.selfReviewEnabled,
          }),
        ),
      )
      .orderBy(asc(paperReviews.updatedAt), asc(paperReviews.id))
      .limit(CONFLICTED_CITATION_SCAN_CAP),
  ]);

  // Through the shared per-type eligibility gate, so the visibility rules
  // (unpublished wiki content, paper-review PDF access) are the standard
  // queue's and cannot drift from it.
  const perType = await Promise.all([
    fetchEligibleIdsOfType("pending_edit", peRows.map((r) => r.id), args),
    fetchEligibleIdsOfType(
      "drug_parameter_revision",
      revRows.map((r) => r.id),
      args,
    ),
    fetchEligibleIdsOfType("wiki_revision", wikiRows.map((r) => r.id), args),
    fetchEligibleIdsOfType("paper_review", prRows.map((r) => r.id), args),
  ]);
  return perType.flat();
}
