/**
 * Helpers for the agent_verifications table.
 *
 * Mirrors the polymorphic target_type pattern used by `approvals`, but the
 * row carries a verdict + rationale + evidence rather than a soft endorsement.
 *
 * Independence guardrail: the queue endpoint and the POST handler must never
 * include other agents' verdicts when an agent fetches the target it is about
 * to verify. The summarise* helpers below are only for the human-facing /review
 * surface (and tests). Agents call the queue endpoint, which scrubs verdicts.
 */

import { and, asc, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { getDb, inTransaction } from './db.js';
import { frozenLiveVerdictId } from './verdict-reconsideration.js';
import {
  agentVerdictReconsiderations,
  agentVerifications,
  agents,
  disputes,
  drugParameterDiscussions,
  drugParameterRevisions,
  learningUnitRevisions,
  paperReviews,
  pendingEdits,
  users,
  verificationLog,
  wikiPages,
  wikiRevisions,
  type AgentVerificationEvidenceRef,
  type AgentVerificationTargetType,
  type AgentVerificationVerdict,
  type DisputeTargetType,
} from '../../db/schema.js';
import {
  DisputeVerdictGoneError,
  StaleDisputeTargetError,
  upsertOpenDispute,
  withdrawAgentDisputesForTarget,
} from './disputes.js';
import {
  lockVerificationSourceRow,
  StaleVerificationTargetError,
  verificationTargetVersion,
  VERIFICATION_SOURCE_TABLES,
  type GovernanceLikeDb,
} from './verification-targets.js';
// Re-exported: other modules (governance importer/mirror, queue/escalation
// routes, tests) import these target-version primitives from this file's
// public surface; see verification-targets.ts for the implementation.
export {
  lockVerificationSourceRow,
  StaleVerificationTargetError,
  verificationTargetVersion,
  VERIFICATION_SOURCE_TABLES,
  type GovernanceLikeDb,
};
import { ROLES } from '../../src/lib/roles.js';
import { CAP } from '../../src/lib/permissions.js';
import { callerCan } from './permissions-store.js';
import {
  isDrugParameterId,
  parameterIsEntryBacked,
} from '../../src/lib/drugParameters.js';
import { FLAGSHIP_TIER } from '../../src/lib/modelTiers.js';
import {
  AGENT_POOL_LOCK_KEY,
  AGENT_POOL_LOCK_NAMESPACE,
} from '../../src/lib/agentPoolLock.js';
import { canonicalSourceQuote } from '../../src/lib/parameterEntries.js';
import {
  governanceConsensusHoldReason,
  governanceEffectiveConsensusQuorum,
  type LegacyConsensusHoldReason,
} from '../../src/lib/assurance/projection.js';

export const ACTIVE_AGENT_ROLES: readonly string[] = [
  ROLES.contributor,
  ROLES.editor,
  ROLES.admin,
];

export interface VerificationRow {
  id: number;
  agentId: number;
  targetType: AgentVerificationTargetType;
  targetId: number;
  verdict: AgentVerificationVerdict;
  rationaleMd: string;
  evidenceRefs: AgentVerificationEvidenceRef[];
  model: string | null;
  /** Server-owned tier snapshotted at verdict time; what the gate reads. */
  verifierTier: string | null;
  isImplicit: boolean;
  createdAt: string;
  updatedAt: string;
  agent: {
    id: number;
    slug: string;
    name: string;
    /** Server-owned capability tier (agents.model_tier); null = unknown. */
    modelTier: string | null;
  } | null;
}

export interface VerificationSummary {
  approveCount: number; // explicit only (excludes is_implicit)
  disputeCount: number;
  abstainCount: number;
  implicitApproveCount: number;
  // Explicit (non-implicit) approvals cast by a flagship-tier model. Drives the
  // capability-aware consensus gate for high-risk edits: two mid-tier agents
  // agreeing must not auto-publish a calculation-driving parameter, since they
  // can share a blind spot. Non-consensus callers (UI badges) may leave it 0.
  approveTier2Count: number;
}

interface AgentVisiblePendingEditRow {
  id: number;
  editType: string;
  status: string;
  pageStatus: string | null;
}

const ZERO_SUMMARY: VerificationSummary = {
  approveCount: 0,
  disputeCount: 0,
  abstainCount: 0,
  implicitApproveCount: 0,
  approveTier2Count: 0,
};

/**
 * The agent has been shown its peers on this target version (see
 * api/_lib/verdict-reconsideration.ts); a fresh verdict from it is not blind.
 */
export class PeersSeenError extends Error {
  constructor() {
    super('agent has seen its peers on this target version');
    this.name = 'PeersSeenError';
  }
}

/** Upsert a verdict; the unique constraint keeps "one verdict per (agent, target)". */
export async function recordVerification(args: {
  agentId: number;
  targetType: AgentVerificationTargetType;
  targetId: number;
  verdict: AgentVerificationVerdict;
  rationaleMd: string;
  evidenceRefs: AgentVerificationEvidenceRef[];
  model?: string | null;
  isImplicit?: boolean;
  /**
   * The target version the caller validated, re-checked inside this write.
   *
   * The route's own 409 is a check-then-act: it reads
   * `verificationTargetVersion`, then does several more queries (author lookup,
   * self-review rules, citation resolution) before getting here. A revision
   * landing in that window is admitted, and nothing on the row records which
   * revision was actually validated — `agent_verifications` has no version
   * column, only `(agent_id, target_type, target_id)`. The verdict then reads
   * as a judgment of a payload its author never saw, by every consumer that
   * infers the binding from the write time, the governance mirror included.
   *
   * Exactly the TOCTOU the tier snapshot below already closes, on the other
   * field the write has to get right, so it is closed the same way: the source
   * row is held, the version is re-read under that lock, and a target that
   * moved rejects the write instead of recording it. Optional because the
   * implicit approve stamped at submit time has no queued version to check —
   * it is not a review.
   */
  expectTargetVersion?: string;
}): Promise<{ id: number; inserted: boolean }> {
  if (args.expectTargetVersion !== undefined) {
    const expected = args.expectTargetVersion;
    return inTransaction(async () => {
      const tx = getDb();
      // Source row first, then the agents row inside the upsert — the order
      // every other writer of these tables takes. Reversed, this would deadlock
      // against the governance importer rather than queue behind it.
      await lockVerificationSourceRow(tx, args.targetType, args.targetId);
      const actual = await verificationTargetVersion(
        { targetType: args.targetType, targetId: args.targetId },
        tx,
      );
      if (actual !== expected) throw new StaleVerificationTargetError(expected, actual);
      // Re-checked under the same lock the disclosure takes, so a verdict
      // admitted before the agent was shown its peers cannot land after it and
      // overwrite the snapshotted blind verdict with a non-blind one.
      if (
        (await frozenLiveVerdictId({
          agentId: args.agentId,
          targetType: args.targetType,
          targetId: args.targetId,
        })) !== null
      ) {
        throw new PeersSeenError();
      }
      return upsertVerification(tx, args);
    });
  }
  // The versionless path is the implicit approve stamped when a submitter
  // (re)submits. A self-review author that disputed its own edit and was then
  // shown its peers holds a frozen dispute; a bare resubmit must not overwrite
  // it with an implicit approval. The frozen verdict stands, and is returned
  // as the row this write would have produced.
  return inTransaction(async () => {
    const tx = getDb();
    await lockVerificationSourceRow(tx, args.targetType, args.targetId);
    const frozen = await frozenLiveVerdictId({
      agentId: args.agentId,
      targetType: args.targetType,
      targetId: args.targetId,
    });
    if (frozen !== null) return { id: frozen, inserted: false };
    return upsertVerification(tx, args);
  });
}

async function upsertVerification(
  db: GovernanceLikeDb & Pick<ReturnType<typeof getDb>, 'insert'>,
  args: {
    agentId: number;
    targetType: AgentVerificationTargetType;
    targetId: number;
    verdict: AgentVerificationVerdict;
    rationaleMd: string;
    evidenceRefs: AgentVerificationEvidenceRef[];
    model?: string | null;
    isImplicit?: boolean;
  },
): Promise<{ id: number; inserted: boolean }> {
  const now = new Date();
  // Snapshot the verifier's SERVER-OWNED tier as a correlated subquery INSIDE
  // the write, not a separate SELECT, and take a row lock (`FOR UPDATE`) on the
  // agents row while doing so. Reading it separately is a TOCTOU: an admin could
  // downgrade/clear agents.model_tier between a prior SELECT and this upsert, and
  // the write would persist a stale `flagship` snapshot that then clears the
  // high-risk gate under a revoked grant. A plain correlated subquery narrows but
  // does not close the window: under READ COMMITTED it reads the row's
  // last-committed value and does NOT block on an in-flight downgrade, so a
  // downgrade that holds the row lock at read time yet commits before this write
  // commits still leaves a stale `flagship` stamp. `FOR UPDATE` serializes the
  // two: the read blocks on the downgrade's lock and re-reads the committed tier,
  // so a verdict admitted after a revocation can never carry the revoked tier.
  // Server-owned (agents.model_tier), never from the caller; a re-verdict
  // re-snapshots under the same rule.
  const verifierTierSql = sql`(select ${agents.modelTier} from ${agents} where ${agents.id} = ${args.agentId} for update)`;
  const [row] = await db
    .insert(agentVerifications)
    .values({
      agentId: args.agentId,
      targetType: args.targetType,
      targetId: args.targetId,
      verdict: args.verdict,
      rationaleMd: args.rationaleMd,
      evidenceRefs: args.evidenceRefs as never,
      model: args.model ?? null,
      verifierTier: verifierTierSql,
      recordedVerifierTier: verifierTierSql,
      isImplicit: args.isImplicit ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        agentVerifications.agentId,
        agentVerifications.targetType,
        agentVerifications.targetId,
      ],
      set: {
        verdict: args.verdict,
        rationaleMd: args.rationaleMd,
        evidenceRefs: args.evidenceRefs as never,
        model: args.model ?? null,
        verifierTier: verifierTierSql,
        recordedVerifierTier: verifierTierSql,
        isImplicit: args.isImplicit ?? false,
        updatedAt: now,
      },
    })
    .returning({
      id: agentVerifications.id,
      createdAt: agentVerifications.createdAt,
    });
  // `inserted` is best-effort — we treat "createdAt within a few ms of now" as
  // a fresh insert. Routes that need exactness can pre-check existence.
  const inserted = row?.createdAt
    ? Math.abs(row.createdAt.getTime() - now.getTime()) < 1000
    : false;
  return { id: row?.id ?? 0, inserted };
}

export async function recordPeerVerificationLog(args: {
  userId: number;
  targetType: AgentVerificationTargetType;
  targetId: number;
  verdict: AgentVerificationVerdict;
  rationaleMd: string;
  evidenceRefCount: number;
}): Promise<void> {
  const db = getDb();
  await db.insert(verificationLog).values({
    targetType: 'peer_verification',
    targetId: args.targetId,
    parameter: args.targetType,
    agentNotes: args.rationaleMd || null,
    sourcesConsultedCount: args.evidenceRefCount,
    outcome: `peer_${args.verdict}`,
    createdBy: args.userId,
  });
}

/**
 * Idempotent shortcut for the implicit-approve row written when an agent
 * submits content. Resolves the agent id from the submitting user id; returns
 * `null` if the user is not an active agent (nothing to write).
 */
export async function recordImplicitAgentApproval(args: {
  userId: number;
  targetType: AgentVerificationTargetType;
  targetId: number;
}): Promise<{ id: number } | null> {
  const db = getDb();
  const [agentRow] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.userId, args.userId), eq(agents.status, 'active')))
    .limit(1);
  if (!agentRow) return null;
  const { id } = await recordVerification({
    agentId: agentRow.id,
    targetType: args.targetType,
    targetId: args.targetId,
    verdict: 'approve',
    rationaleMd: '',
    evidenceRefs: [],
    isImplicit: true,
  });
  return { id };
}

/**
 * Batch variant of recordImplicitAgentApproval. Resolves the agent once and
 * bulk-upserts all implicit-approve rows in a single INSERT … ON CONFLICT DO
 * UPDATE, replacing N sequential round-trips with 2 (one agent lookup + one
 * bulk upsert). Returns null when the user is not an active agent.
 */
export async function recordImplicitAgentApprovals(args: {
  userId: number;
  targetType: AgentVerificationTargetType;
  targetIds: number[];
}): Promise<{ count: number } | null> {
  if (args.targetIds.length === 0) return { count: 0 };
  const db = getDb();
  const [agentRow] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.userId, args.userId), eq(agents.status, 'active')))
    .limit(1);
  if (!agentRow) return null;
  const now = new Date();
  await db
    .insert(agentVerifications)
    .values(
      args.targetIds.map((targetId) => ({
        agentId: agentRow.id,
        targetType: args.targetType,
        targetId,
        verdict: 'approve' as const,
        rationaleMd: '',
        evidenceRefs: [] as never,
        model: null,
        isImplicit: true,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [
        agentVerifications.agentId,
        agentVerifications.targetType,
        agentVerifications.targetId,
      ],
      set: {
        verdict: 'approve',
        rationaleMd: '',
        evidenceRefs: [] as never,
        model: null,
        isImplicit: true,
        updatedAt: now,
      },
      // Never over a verdict frozen by a control-phase disclosure (see
      // frozenLiveVerdictId): the agent has read its peers while holding it.
      setWhere: sql`not exists (
        select 1 from ${agentVerdictReconsiderations} r
        where r.verification_id = ${agentVerifications.id}
      )`,
    });
  return { count: args.targetIds.length };
}

/**
 * Resolve the `users.id` who authored a verification target, so the POST
 * handler can refuse self-verification. Returns null if the target row does
 * not exist.
 */
export async function targetAuthorUserId(args: {
  targetType: AgentVerificationTargetType;
  targetId: number;
}): Promise<number | null> {
  const db = getDb();
  switch (args.targetType) {
    case 'wiki_revision': {
      const [row] = await db
        .select({ createdBy: wikiRevisions.createdBy })
        .from(wikiRevisions)
        .where(eq(wikiRevisions.id, args.targetId))
        .limit(1);
      return row?.createdBy ?? null;
    }
    case 'drug_parameter_revision': {
      const [row] = await db
        .select({ createdBy: drugParameterRevisions.createdBy })
        .from(drugParameterRevisions)
        .where(eq(drugParameterRevisions.id, args.targetId))
        .limit(1);
      return row?.createdBy ?? null;
    }
    case 'drug_discussion': {
      const [row] = await db
        .select({ createdBy: drugParameterDiscussions.createdBy })
        .from(drugParameterDiscussions)
        .where(eq(drugParameterDiscussions.id, args.targetId))
        .limit(1);
      return row?.createdBy ?? null;
    }
    case 'paper_review': {
      const [row] = await db
        .select({ createdBy: paperReviews.createdBy })
        .from(paperReviews)
        .where(eq(paperReviews.id, args.targetId))
        .limit(1);
      return row?.createdBy ?? null;
    }
    case 'learning_unit_revision': {
      const [row] = await db
        .select({ createdBy: learningUnitRevisions.createdBy })
        .from(learningUnitRevisions)
        .where(eq(learningUnitRevisions.id, args.targetId))
        .limit(1);
      return row?.createdBy ?? null;
    }
    case 'pending_edit': {
      const [row] = await db
        .select({ submittedBy: pendingEdits.submittedBy })
        .from(pendingEdits)
        .where(eq(pendingEdits.id, args.targetId))
        .limit(1);
      return row?.submittedBy ?? null;
    }
  }
}

/**
 * Deep link a dispute notification to where its target is actually inspected,
 * so a recipient lands on the contested item instead of the generic /review
 * queue — which only renders pending edits and cannot locate the other target
 * types. The dispute row carries only `targetType`/`targetId`, and for every
 * type except `pending_edit` that id is a revision/child-row id, so each needs
 * one lookup to reach the parent page's routing key.
 *
 * Falls back to `/review` whenever the target row is missing or its parent key
 * is null, so the link is never worse than the previous hardcoded `/review`.
 * (The drug monograph and wiki pages have no per-parameter/thread anchor yet,
 * so those links reach the right page but not the exact row.)
 */
export async function disputeTargetUrl(args: {
  targetType: AgentVerificationTargetType;
  targetId: number;
}): Promise<string> {
  // Pure, no lookup — return before touching the DB so this stays callable
  // (and mockable) without a database client.
  if (args.targetType === 'pending_edit') {
    return `/review?id=${args.targetId}`;
  }
  const db = getDb();
  const fallback = '/review';
  switch (args.targetType) {
    case 'wiki_revision': {
      const [row] = await db
        .select({ slug: wikiPages.slug })
        .from(wikiRevisions)
        .innerJoin(wikiPages, eq(wikiPages.id, wikiRevisions.pageId))
        .where(eq(wikiRevisions.id, args.targetId))
        .limit(1);
      return row?.slug
        ? `/wiki/${encodeURIComponent(row.slug)}/history`
        : fallback;
    }
    case 'drug_parameter_revision': {
      // Straight to the parameter's change log with this revision in view
      // (DrugMonographSidebar reads `param`/`view`/`revision`), not just the
      // drug's page: the revision, and any dispute on it, live in that log.
      const [row] = await db
        .select({
          drugId: drugParameterRevisions.drugId,
          parameter: drugParameterRevisions.parameter,
        })
        .from(drugParameterRevisions)
        .where(eq(drugParameterRevisions.id, args.targetId))
        .limit(1);
      if (row?.drugId == null) return fallback;
      return `/wiki/drug/${row.drugId}?${new URLSearchParams({
        param: row.parameter,
        view: 'history',
        revision: String(args.targetId),
      })}`;
    }
    case 'drug_discussion': {
      // A discussion is either drug-scoped or topic-page-scoped (drugId XOR
      // wikiPageId); route to whichever the row carries. A comment on one
      // drug parameter opens that parameter's discussion at the comment.
      const [row] = await db
        .select({
          drugId: drugParameterDiscussions.drugId,
          wikiPageId: drugParameterDiscussions.wikiPageId,
          parameter: drugParameterDiscussions.parameter,
        })
        .from(drugParameterDiscussions)
        .where(eq(drugParameterDiscussions.id, args.targetId))
        .limit(1);
      if (row?.drugId != null) {
        if (row.parameter && !row.parameter.startsWith('fact:')) {
          return `/wiki/drug/${row.drugId}?${new URLSearchParams({
            param: row.parameter,
            view: 'discussion',
            comment: String(args.targetId),
          })}`;
        }
        return `/wiki/drug/${row.drugId}`;
      }
      if (row?.wikiPageId != null) {
        const [page] = await db
          .select({ slug: wikiPages.slug })
          .from(wikiPages)
          .where(eq(wikiPages.id, row.wikiPageId))
          .limit(1);
        if (page?.slug) return `/wiki/${encodeURIComponent(page.slug)}`;
      }
      return fallback;
    }
    case 'paper_review': {
      const [row] = await db
        .select({ citationId: paperReviews.citationId })
        .from(paperReviews)
        .where(eq(paperReviews.id, args.targetId))
        .limit(1);
      return row?.citationId != null
        ? `/references/${row.citationId}`
        : fallback;
    }
    case 'learning_unit_revision': {
      const [row] = await db
        .select({ unitId: learningUnitRevisions.unitId })
        .from(learningUnitRevisions)
        .where(eq(learningUnitRevisions.id, args.targetId))
        .limit(1);
      return row?.unitId != null ? `/learn/unit/${row.unitId}` : fallback;
    }
  }
}

/**
 * Filter target IDs down to ones the caller may read. Mirrors
 * `visibleTargetIds` in api/approvals.ts and extends it for `pending_edit`
 * (pending edits have three audiences: reviewers see all rows, submitters see
 * their own rows, and verifier agents see only queue-eligible rows from other
 * active agents).
 */
export async function visibleVerificationTargetIds(args: {
  targetType: AgentVerificationTargetType;
  targetIds: number[];
  callerUserId: number | null;
  callerRole: string | null;
  callerAgentId?: number | null;
  /**
   * The caller's `agents.self_review_enabled`. Lifts the own-submission
   * exclusion in the agent branch below so the POST handler's self-review
   * path can actually be reached — this helper runs first, and hiding the
   * row here would 404 the verdict before any of that logic is consulted.
   */
  callerSelfReviews?: boolean;
  /**
   * Read-only widening for `pending_edit`: also include a target the caller
   * agent has an explicit (non-implicit) verdict on, regardless of the
   * target's current status. Without this, an agent's own rationale on a
   * pending edit it reviewed becomes unreadable the moment the edit is
   * decided — the open-queue rule below exists to hand out undecided work,
   * not to gate revisiting a debate the caller already took part in. Off by
   * default so it never changes what POST (verdict submission) authorizes —
   * only a GET caller that wants "can this agent read it" should opt in.
   */
  includeCallerVerdicts?: boolean;
}): Promise<number[]> {
  if (args.targetIds.length === 0) return [];
  if (args.targetType === 'pending_edit' && args.callerUserId === null) {
    return [];
  }
  const db = getDb();

  if (args.targetType === 'wiki_revision') {
    const rows = await db
      .select({ id: wikiRevisions.id, status: wikiPages.status })
      .from(wikiRevisions)
      .innerJoin(wikiPages, eq(wikiPages.id, wikiRevisions.pageId))
      .where(inArray(wikiRevisions.id, args.targetIds));
    // Resolve the draft question once for this caller, fail-closed like every
    // other authorization check, then apply it per row.
    const canSeeDrafts = await callerCan(
      args.callerRole,
      CAP['wiki.draft.read'],
    );
    return rows
      .filter(
        (r) =>
          r.status === 'published' || (r.status === 'draft' && canSeeDrafts),
      )
      .map((r) => r.id);
  }
  if (args.targetType === 'drug_parameter_revision') {
    const rows = await db
      .select({ id: drugParameterRevisions.id })
      .from(drugParameterRevisions)
      .where(inArray(drugParameterRevisions.id, args.targetIds));
    return rows.map((r) => r.id);
  }
  if (args.targetType === 'paper_review') {
    const rows = await db
      .select({ id: paperReviews.id })
      .from(paperReviews)
      .where(inArray(paperReviews.id, args.targetIds));
    return rows.map((r) => r.id);
  }
  if (args.targetType === 'drug_discussion') {
    const rows = await db
      .select({ id: drugParameterDiscussions.id })
      .from(drugParameterDiscussions)
      .where(inArray(drugParameterDiscussions.id, args.targetIds));
    return rows.map((r) => r.id);
  }
  // pending_edit mirrors /api/pending-edits visibility: reviewers can see
  // all rows, non-reviewers can only see their own submissions, and
  // anonymous callers see none. Active agents additionally may verify any
  // other contributor's open pending edit — agent- or human-submitted, the
  // same set agent-verifications-queue.ts serves. This must stay in step with
  // that queue: a row the queue hands out and this helper hides comes back
  // every cycle as `agent_verification_target_not_found`, unverifiable and
  // undrainable. Unpublished moderator-queue content is still withheld, by
  // content status rather than by submitter — see
  // isPendingEditVisibleToVerifierAgent.
  if (await callerCan(args.callerRole, CAP['review.queue.readAll'])) {
    const rows = await db
      .select({ id: pendingEdits.id })
      .from(pendingEdits)
      .where(inArray(pendingEdits.id, args.targetIds));
    return rows.map((r) => r.id);
  }
  if (args.callerAgentId && args.callerUserId !== null) {
    const callerUserId = args.callerUserId;
    const rows = await db
      .select({
        id: pendingEdits.id,
        editType: pendingEdits.editType,
        status: pendingEdits.status,
        pageStatus: wikiPages.status,
      })
      .from(pendingEdits)
      .leftJoin(wikiPages, eq(wikiPages.id, pendingEdits.targetId))
      .where(
        and(
          inArray(pendingEdits.id, args.targetIds),
          // Same rule, same exception as the queue: an agent cleared for
          // self-review sees its own rows here too, or the queue would hand
          // out a target this helper then hides — the exact "unverifiable and
          // undrainable" loop the comment above warns about, only reached by
          // enabling the flag rather than by a filter drifting out of step.
          args.callerSelfReviews
            ? undefined
            : ne(pendingEdits.submittedBy, callerUserId),
        ),
      );
    const openQueueIds = rows
      .filter(isPendingEditVisibleToVerifierAgent)
      .map((r) => r.id);
    if (!args.includeCallerVerdicts) return openQueueIds;
    const ownVerdictTargetIds = new Set(
      (
        await db
          .selectDistinct({ targetId: agentVerifications.targetId })
          .from(agentVerifications)
          .where(
            and(
              eq(agentVerifications.agentId, args.callerAgentId),
              eq(agentVerifications.targetType, 'pending_edit'),
              eq(agentVerifications.isImplicit, false),
              inArray(agentVerifications.targetId, args.targetIds),
            ),
          )
      ).map((r) => r.targetId),
    );
    // Relaxes only the "must still be pending" half of the open-queue rule —
    // the content gate stays: a wiki edit's own-verdict row is still withheld
    // once its page is unpublished/reverted to draft, same as it would be for
    // still-open queue eligibility. Reusing `rows` (already scoped to "not
    // the caller's own submission") rather than trusting the verdict alone
    // keeps that gate from being bypassable by an old rationale (review
    // finding on #1361).
    const ownVerdictIds = rows
      .filter(
        (r) => ownVerdictTargetIds.has(r.id) && isPendingEditContentVisible(r),
      )
      .map((r) => r.id);
    return [...new Set([...openQueueIds, ...ownVerdictIds])];
  }
  const rows = await db
    .select({ id: pendingEdits.id, submittedBy: pendingEdits.submittedBy })
    .from(pendingEdits)
    .where(inArray(pendingEdits.id, args.targetIds));
  return rows
    .filter((r) => r.submittedBy === args.callerUserId)
    .map((r) => r.id);
}

/**
 * The content-status half of queue eligibility: a wiki edit is withheld from
 * a non-reviewer agent unless its page is published, independent of the
 * edit's own pending/decided status. Split out from
 * `isPendingEditVisibleToVerifierAgent` so `includeCallerVerdicts` can relax
 * the "still pending" requirement for an edit the agent already verified
 * without also reopening access to unpublished draft content (#1361).
 */
function isPendingEditContentVisible(
  row: Pick<AgentVisiblePendingEditRow, 'editType' | 'pageStatus'>,
): boolean {
  if (
    row.editType === 'wiki_new' ||
    row.editType === 'wiki_page' ||
    row.editType === 'wiki_fact' ||
    row.editType === 'wiki_section'
  ) {
    return row.pageStatus === 'published';
  }
  return true;
}

function isPendingEditVisibleToVerifierAgent(
  row: AgentVisiblePendingEditRow,
): boolean {
  if (row.status !== 'pending') return false;
  return isPendingEditContentVisible(row);
}

/**
 * Full verdict list for one target, joined with the agent profile. Powers the
 * single-target read endpoint and tests. NOT for queue consumption by agents.
 */
export async function listVerifications(args: {
  targetType: AgentVerificationTargetType;
  targetId: number;
}): Promise<VerificationRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: agentVerifications.id,
      agentId: agentVerifications.agentId,
      targetType: agentVerifications.targetType,
      targetId: agentVerifications.targetId,
      verdict: agentVerifications.verdict,
      rationaleMd: agentVerifications.rationaleMd,
      evidenceRefs: agentVerifications.evidenceRefs,
      model: agentVerifications.model,
      verifierTier: agentVerifications.verifierTier,
      isImplicit: agentVerifications.isImplicit,
      createdAt: agentVerifications.createdAt,
      updatedAt: agentVerifications.updatedAt,
      agentSlug: agents.slug,
      agentName: agents.name,
      agentRowId: agents.id,
      agentModelTier: agents.modelTier,
    })
    .from(agentVerifications)
    .leftJoin(agents, eq(agents.id, agentVerifications.agentId))
    .where(
      and(
        eq(agentVerifications.targetType, args.targetType),
        eq(agentVerifications.targetId, args.targetId),
      ),
    )
    .orderBy(agentVerifications.createdAt);

  return rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    targetType: r.targetType as AgentVerificationTargetType,
    targetId: r.targetId,
    verdict: r.verdict as AgentVerificationVerdict,
    rationaleMd: r.rationaleMd,
    evidenceRefs: (r.evidenceRefs ?? []) as AgentVerificationEvidenceRef[],
    model: r.model ?? null,
    verifierTier: r.verifierTier ?? null,
    isImplicit: r.isImplicit,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    agent: r.agentRowId
      ? {
          id: r.agentRowId,
          slug: r.agentSlug ?? '',
          name: r.agentName ?? '',
          modelTier: r.agentModelTier ?? null,
        }
      : null,
  }));
}

/**
 * Full verdict rows for many targets of the same type, grouped by target id.
 * Unlike `summariseVerificationsForTargets` (counts only) this carries the
 * rationale, so a caller that shows the actual review text — the parameter
 * edit-history dialog, surfacing the verdicts behind a recompute (#1358) —
 * doesn't call `listVerifications` once per target.
 */
export async function listVerificationsForTargets(args: {
  targetType: AgentVerificationTargetType;
  targetIds: number[];
}): Promise<Map<number, VerificationRow[]>> {
  const ids = [...new Set(args.targetIds.filter(Number.isInteger))];
  if (ids.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({
      id: agentVerifications.id,
      agentId: agentVerifications.agentId,
      targetType: agentVerifications.targetType,
      targetId: agentVerifications.targetId,
      verdict: agentVerifications.verdict,
      rationaleMd: agentVerifications.rationaleMd,
      evidenceRefs: agentVerifications.evidenceRefs,
      model: agentVerifications.model,
      verifierTier: agentVerifications.verifierTier,
      isImplicit: agentVerifications.isImplicit,
      createdAt: agentVerifications.createdAt,
      updatedAt: agentVerifications.updatedAt,
      agentSlug: agents.slug,
      agentName: agents.name,
      agentRowId: agents.id,
      agentModelTier: agents.modelTier,
    })
    .from(agentVerifications)
    .leftJoin(agents, eq(agents.id, agentVerifications.agentId))
    .where(
      and(
        eq(agentVerifications.targetType, args.targetType),
        inArray(agentVerifications.targetId, ids),
      ),
    )
    .orderBy(agentVerifications.createdAt);

  const byTarget = new Map<number, VerificationRow[]>();
  for (const r of rows) {
    const row: VerificationRow = {
      id: r.id,
      agentId: r.agentId,
      targetType: r.targetType as AgentVerificationTargetType,
      targetId: r.targetId,
      verdict: r.verdict as AgentVerificationVerdict,
      rationaleMd: r.rationaleMd,
      evidenceRefs: (r.evidenceRefs ?? []) as AgentVerificationEvidenceRef[],
      model: r.model ?? null,
      verifierTier: r.verifierTier ?? null,
      isImplicit: r.isImplicit,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      agent: r.agentRowId
        ? {
            id: r.agentRowId,
            slug: r.agentSlug ?? '',
            name: r.agentName ?? '',
            modelTier: r.agentModelTier ?? null,
          }
        : null,
    };
    const list = byTarget.get(r.targetId);
    if (list) list.push(row);
    else byTarget.set(r.targetId, [row]);
  }
  return byTarget;
}

/**
 * Batch summary for many targets of the same type. Used by list endpoints
 * (notably the moderator queue on /review) so a single SELECT supplies the
 * decoration counts.
 */
export async function summariseVerificationsForTargets(args: {
  targetType: AgentVerificationTargetType;
  targetIds: number[];
  /**
   * Leave out every verdict cast by the agent behind this user. Consensus
   * passes the author when it is not a self-review agent: its own approval
   * is not an independent verifier's and must not fill the quorum.
   */
  excludeAgentUserId?: number;
  /**
   * Count only verdicts from agents that are eligible to verify NOW (status
   * `active`, contributor+ role — `resolveActiveAgent`'s test). Consensus sets
   * it: a suspended or deactivated agent's standing is revoked, and a retry
   * after the revocation must not publish on its earlier approval.
   */
  onlyActiveVerifiers?: boolean;
  /**
   * Leave out a `dispute` verdict that has been answered: a dispute its author
   * raised on the target was resolved after the verdict was recorded
   * (`disputes.resolved_at >= agent_verifications.updated_at` — the same rule
   * as `unresolvedDisputeVerdictCount`). Consensus sets it: an objection a
   * moderator or the T3 panel has overruled no longer holds the proposal, and
   * one that was upheld holds it through its own gate
   * (`pendingEditUpheldRulingStands`). A new dispute bumps the verdict past
   * the old resolution, so it counts again.
   */
  excludeAnsweredDisputes?: boolean;
}): Promise<Map<number, VerificationSummary>> {
  const ids = args.targetIds.filter(Number.isInteger);
  if (ids.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({
      targetId: agentVerifications.targetId,
      verdict: agentVerifications.verdict,
      isImplicit: agentVerifications.isImplicit,
      // Server-owned tier SNAPSHOTTED at verdict time (not the caller-supplied
      // model, and not the mutable current agent row).
      verifierTier: agentVerifications.verifierTier,
      answered: args.excludeAnsweredDisputes
        ? answeredDisputeVerdictSql()
        : sql<boolean>`false`,
    })
    .from(agentVerifications)
    .where(
      and(
        eq(agentVerifications.targetType, args.targetType),
        inArray(agentVerifications.targetId, ids),
        args.excludeAgentUserId === undefined
          ? undefined
          : notInArray(
              agentVerifications.agentId,
              db
                .select({ id: agents.id })
                .from(agents)
                .where(eq(agents.userId, args.excludeAgentUserId)),
            ),
        args.onlyActiveVerifiers
          ? inArray(
              agentVerifications.agentId,
              db
                .select({ id: agents.id })
                .from(agents)
                .innerJoin(users, eq(users.id, agents.userId))
                .where(
                  and(
                    eq(agents.status, 'active'),
                    inArray(users.role, ACTIVE_AGENT_ROLES),
                  ),
                ),
            )
          : undefined,
      ),
    );

  const out = new Map<number, VerificationSummary>();
  for (const row of rows) {
    let summary = out.get(row.targetId);
    if (!summary) {
      summary = { ...ZERO_SUMMARY };
      out.set(row.targetId, summary);
    }
    if (row.isImplicit) {
      summary.implicitApproveCount += 1;
      continue;
    }
    if (row.verdict === 'approve') {
      summary.approveCount += 1;
      // Only an explicit peer approval whose verifier was flagship-tier at
      // verdict time counts toward the high-risk gate. Implicit rows are
      // excluded above; an unclassified (NULL) tier never counts (fail-safe).
      if (row.verifierTier === FLAGSHIP_TIER) summary.approveTier2Count += 1;
    } else if (row.verdict === 'dispute') {
      if (!row.answered) summary.disputeCount += 1;
    } else if (row.verdict === 'abstain') summary.abstainCount += 1;
  }
  return out;
}

/**
 * True for an `agent_verifications` row whose objection has been answered
 * (columns are table-qualified: a single-table query renders bare names,
 * which the joined `disputes` would make ambiguous): a
 * dispute its author raised on the same target was resolved after the verdict
 * was recorded. Authorship joins through `agents.user_id`, since
 * `disputes.created_by` is the agent's backing user. Kept in step with
 * `unresolvedDisputeVerdictCounts` (./disputes.ts), which applies the same
 * rule to the review queue.
 */
export function answeredDisputeVerdictSql() {
  return sql<boolean>`exists (
    select 1 from ${disputes} ad
    join ${agents} aa on aa.user_id = ad.created_by
    where aa.id = ${agentVerifications}.agent_id
      and ad.target_type = ${agentVerifications}.target_type
      and ad.target_id = ${agentVerifications}.target_id
      and ad.status = 'resolved'
      and ad.resolved_at is not null
      and ad.resolved_at >= ${agentVerifications}.updated_at
  )`;
}

/** Convenience for callers (UI badge) that want the zero summary as a default. */
export function emptyVerificationSummary(): VerificationSummary {
  return { ...ZERO_SUMMARY };
}

/**
 * Quorum of independent agent peer-reviews that, with no outstanding dispute,
 * lets agent consensus stand in for a human moderator's approval (see
 * agents/peer-verification-protocol.md). Two distinct agents must explicitly
 * `approve`: agent_verifications is unique per (agent, target) and an agent
 * cannot verify its own submission, so `approveCount === 2` already means two
 * independent non-author agents. Mirrors the ">=2 well-verified" tier that
 * verificationSortRank uses to demote multi-approved rows on /review.
 */
export const AGENT_CONSENSUS_APPROVE_QUORUM = 2;

/**
 * True when a pending edit's verdict tally clears the consensus bar for an
 * automatic apply: at least the quorum of explicit (non-implicit) approvals and
 * not a single explicit dispute. A dispute always blocks — one well-reasoned
 * contradiction holds the edit for a human, however many approvals it carries.
 * Implicit-approve rows (the submitter's own stake) never count toward quorum.
 */
export function meetsConsensusApprovalQuorum(
  summary: VerificationSummary,
  quorum: number = AGENT_CONSENSUS_APPROVE_QUORUM,
): boolean {
  return summary.disputeCount === 0 && summary.approveCount >= quorum;
}

/**
 * True when a pending edit is high-risk for consensus auto-apply — i.e. it
 * writes a **calculation-driving** drug parameter (an entry-backed parameter:
 * the summarizable PK/PD measurements plus the model-structure axes). Those
 * values feed every calculation and simulation in the app, so a confident-but-
 * wrong value that no downstream check catches is the most costly error class.
 * Identity metadata (names, molecular weight, CID) and per-matrix
 * `analyteStability` are not entry-backed and are not high-risk here.
 *
 * Pure function of the edit's own fields, so it adds no DB read to the apply
 * path. `weak`-concordance escalation is handled at the producer/verifier
 * routing layer (it lives on `verification_log`, not the edit) — see
 * docs/superpowers/specs/2026-08-24-tiered-agent-cost-architecture.md §B/§C.
 */
export function isHighRiskPendingEdit(edit: {
  editType: string | null | undefined;
  parameter: string | null | undefined;
}): boolean {
  if (edit.editType !== 'parameter' && edit.editType !== 'param_entry') {
    return false;
  }
  const { parameter } = edit;
  if (typeof parameter !== 'string' || !isDrugParameterId(parameter)) {
    return false;
  }
  return parameterIsEntryBacked(parameter);
}

/**
 * The verbatim source quote a pending edit carries, or `null` when it carries
 * none.
 *
 * Where the quote lives depends on the edit kind, because the two kinds store
 * their payloads differently and neither shape is worth bending:
 *
 *  - `param_entry` create/update — on the entry payload itself
 *    (`proposed_value.input.quote` / `proposed_value.patch.quote`), because for
 *    an entry the quote is durable provenance: it is written to
 *    `parameter_entries.source_quote` on apply and outlives the proposal.
 *  - `parameter` — in `proposed_meta.sourceQuote`, because a direct
 *    drug-parameter value is a bare `NumericRange` with nowhere to put one.
 *    It is review evidence rather than stored provenance, and stays with the
 *    proposal.
 *
 * A blank or whitespace-only string is `null`: an empty quote is the absence of
 * a quote wearing a coat, and must not satisfy a gate that exists to make
 * somebody write down a sentence.
 */
export function pendingEditSourceQuote(edit: {
  editType: string | null | undefined;
  proposedValue?: unknown;
  proposedMeta?: unknown;
}): string | null {
  const read = (holder: unknown, key: string): string | null => {
    if (holder == null || typeof holder !== 'object') return null;
    const raw = (holder as Record<string, unknown>)[key];
    if (typeof raw !== 'string') return null;
    // Canonicalized the way the write will store it. A pending edit's payload
    // is validated on submission but kept as sent, so a whitespace-only quote
    // is still a non-empty string here and becomes `null` only when the apply
    // re-parses it. Reading it raw would let it satisfy this gate and then
    // publish a calculation-driving value with no provenance at all.
    return canonicalSourceQuote(raw) ?? null;
  };

  if (edit.editType === 'parameter') {
    return read(edit.proposedMeta, 'sourceQuote');
  }
  if (edit.editType !== 'param_entry') return null;
  const value = edit.proposedValue;
  if (value == null || typeof value !== 'object') return null;
  const op = (value as Record<string, unknown>).op;
  if (op === 'create') {
    return read((value as Record<string, unknown>).input, 'quote');
  }
  if (op === 'update') {
    return read((value as Record<string, unknown>).patch, 'quote');
  }
  return null;
}

/**
 * True when a pending edit asserts a value that a source could be quoted for.
 *
 * A `param_entry` DELETE does not: it proposes removing a row, and the case for
 * removal is an argument (wrong drug, superseded, duplicate) rather than a
 * sentence in a document. Requiring a quote there would be asking for evidence
 * of an absence. Create and update both put a number on the record and are
 * therefore quotable, as is a direct `parameter` write.
 */
function pendingEditAssertsQuotableValue(edit: {
  editType: string | null | undefined;
  proposedValue?: unknown;
}): boolean {
  if (edit.editType === 'parameter') return true;
  if (edit.editType !== 'param_entry') return false;
  const value = edit.proposedValue;
  if (value == null || typeof value !== 'object') return false;
  const op = (value as Record<string, unknown>).op;
  return op === 'create' || op === 'update';
}

/**
 * True when agent consensus must NOT auto-apply this edit because it asserts a
 * calculation-driving value with no verbatim source quote behind it.
 *
 * ## Why this guard exists
 *
 * Peer verification was observed approving a median Tmax wrong by a factor of
 * two, twice, independently. The cited label was the right document; the number
 * had been read out of the wrong sentence. Catching that meant re-deriving the
 * value from a 30-page PDF, which is the expensive judgement the review
 * protocol asks for and demonstrably does not always get.
 *
 * A stored quote converts that expensive judgement into a cheap mechanical one.
 * "Re-read the label and work out the fasted single-dose median" is work only a
 * strong reviewer reliably does; "does this quoted sentence say *median*, and
 * does it say *this number*?" is work any reviewer can do, and an auditor can
 * do afterwards. The gate does not make anyone do it — it refuses to publish
 * unattended when nobody has been given the chance to.
 *
 * ## Why it is not a rule in the governance policy
 *
 * `src/lib/assurance/policy.ts` reasons about a proposal's ASSESSMENTS — who
 * approved, at what tier, with what standing. This is a fact about the
 * proposal's own PAYLOAD, known before any verdict is cast, and it is not a
 * thing reviewers can supply by approving harder. Modelling it as a policy rule
 * would also mean versioning `kinetix-consensus` to v2 and rewriting the parity
 * pin, spending the policy's version contract on a precondition that is not
 * about consensus at all.
 *
 * ## What it deliberately does not do
 *
 * It does not block submission, does not invalidate stored entries, and does
 * not touch the human review path. A person with the standing to approve may
 * still approve an unquoted proposal — they are accountable for that in a way
 * an unattended tally is not. So nothing in flight is stranded, and the whole
 * effect of the change is that the automated path publishes a little less and
 * hands a little more to people.
 */
export function highRiskEditLacksSourceQuote(edit: {
  editType: string | null | undefined;
  parameter: string | null | undefined;
  proposedValue?: unknown;
  proposedMeta?: unknown;
}): boolean {
  if (!highRiskEditNeedsSourceQuote(edit)) return false;
  return pendingEditSourceQuote(edit) == null;
}

/**
 * Whether this proposal is one the quote requirement applies to at all —
 * a calculation-driving parameter putting a value on the record — said once,
 * separately from whether it satisfies the requirement.
 *
 * The two questions came apart the moment a caller needed to answer the second
 * one from somewhere other than the payload. A `param_entry` UPDATE's effective
 * quote is decided by the write, not by what the payload carries, so the gate
 * has to ask the store; but it must only ask for proposals in scope. Folding
 * scope and satisfaction into a single boolean forced the caller to infer scope
 * from a `false`, which conflates "no quote needed here" with "quote present" —
 * and that conflation is exactly how an echoed quote walked through the gate.
 */
export function highRiskEditNeedsSourceQuote(edit: {
  editType: string | null | undefined;
  parameter: string | null | undefined;
  proposedValue?: unknown;
}): boolean {
  if (!isHighRiskPendingEdit(edit)) return false;
  return pendingEditAssertsQuotableValue(edit);
}

/**
 * Why a consensus auto-apply was withheld, for observability. `null` means the
 * edit clears the gate and should apply.
 *
 * Now an alias of the generic core's projection type (Phase 1 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md); the string
 * values are unchanged and remain this module's public vocabulary.
 */
export type ConsensusHoldReason = LegacyConsensusHoldReason;

/**
 * Capability-aware consensus decision. Base rule is unchanged
 * (`meetsConsensusApprovalQuorum`): no explicit dispute and the pool-adapted
 * quorum of explicit approvals. On top of that, a **high-risk** edit
 * additionally requires (a) the full design-target quorum — it never rides the
 * degraded single-approval path — and (b) at least one approval from a
 * flagship-tier verifier, so two mid-tier agents sharing a blind spot cannot
 * auto-publish a calculation-driving parameter. The change only ever tightens
 * auto-apply; a non-high-risk edit behaves exactly as before.
 *
 * Returns the hold reason (or `null` to apply) so the caller can log which
 * guard fired without re-deriving it. `approveTier2Count` may be absent on a
 * hand-built summary (older callers/tests); it is treated as 0.
 *
 * The rules now live in the generic governance policy
 * (src/lib/assurance/policy.ts) and this is the projection
 * onto it — Phase 1 of the extraction plan. Behaviour is unchanged and pinned
 * exhaustively against a frozen copy of the previous algorithm by
 * tests/governance/policy/kinetix-consensus-parity.test.ts. Rolling back is
 * reverting this import.
 */
export function consensusApprovalHoldReason(
  summary: VerificationSummary,
  quorum: number,
  opts: { highRisk: boolean },
): ConsensusHoldReason | null {
  return governanceConsensusHoldReason(summary, quorum, opts);
}

/**
 * The consensus quorum the active-agent pool can actually satisfy.
 *
 * The design target is two independent non-author approvals
 * (AGENT_CONSENSUS_APPROVE_QUORUM). But because an agent cannot verify its own
 * submission, the verifiers available to an agent-authored pending edit number
 * `activeAgents - 1`. With only two active agents that leaves a single eligible
 * verifier, so a fixed quorum of 2 is mathematically unreachable and every
 * agent-authored edit silently piles up in the human review queue forever —
 * the failure mode this guards against. We therefore clamp the quorum down to
 * what the pool can supply (`activeAgents - 1`), capped at the design target
 * and floored at 1:
 *
 *   0–2 agents -> 1   (degraded single-reviewer mode)
 *   >=3 agents -> 2   (full two-independent-reviewer integrity)
 *
 * When the author is a self-review agent (`agents.self_review_enabled`) it is
 * itself an eligible verifier, so the pool is `activeAgents` rather than
 * `activeAgents - 1`. Note which way that cuts: the flag adds a reviewer to the
 * pool, it does not lower the bar. With two active agents and self-review on,
 * the quorum RISES from 1 to the design target of 2 — the author's own verdict
 * plus one independent one. The flag only produces a solo self-approval in the
 * one deployment where nothing else is possible: a single active agent.
 *
 * Pure function of the pool size so it can be unit-tested directly.
 *
 * The clamping now lives in the generic core (`reviewerPoolState` in
 * the `assurance-core` package) and this is the projection onto
 * it — Phase 1 of the extraction plan. Same arithmetic, same results; the
 * equivalence is pinned by tests/governance/policy/kinetix-consensus-parity.test.ts.
 */
export function effectiveConsensusQuorum(
  activeAgentCount: number,
  opts: { authorSelfReviews?: boolean } = {},
): number {
  return governanceEffectiveConsensusQuorum(activeAgentCount, opts);
}

/**
 * True when the active-agent pool is too small to reach the design-target
 * quorum, so consensus runs in a degraded single-reviewer mode. Operators
 * should add a third active agent to restore two-independent-reviewer review;
 * the apply path logs this so the degradation is never silent.
 */
export function isConsensusQuorumDegraded(
  activeAgentCount: number,
  opts: { authorSelfReviews?: boolean } = {},
): boolean {
  return (
    effectiveConsensusQuorum(activeAgentCount, opts) <
    AGENT_CONSENSUS_APPROVE_QUORUM
  );
}

/**
 * Count the agents eligible to cast consensus-bearing peer verdicts: status
 * `active` with a contributor+ backing-user role (the same gate
 * `resolveActiveAgent` enforces). This is the pool size the adaptive quorum is
 * derived from. The set is tiny (a handful of rows), so we count in-process
 * rather than push a COUNT down to the DB.
 */
export async function countActiveVerifierAgents(): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .where(
      and(
        eq(agents.status, 'active'),
        inArray(users.role, ACTIVE_AGENT_ROLES),
      ),
    );
  return rows.length;
}

/**
 * True when `userId` backs an agent that is currently eligible to act (status
 * `active`, contributor+ backing-user role — the same gate
 * `resolveActiveAgent` and `countActiveVerifierAgents` apply).
 *
 * Used by the consensus path to size the quorum: an active agent author holds
 * a seat in the pool (counted only under self-review), while a person holds
 * none, so every active agent is an eligible verifier on their proposal. Both
 * publish on agent consensus under the same bar (kinetix-consensus@v2).
 */
export async function isActiveAgentUser(userId: number): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .where(
      and(
        eq(agents.userId, userId),
        eq(agents.status, 'active'),
        inArray(users.role, ACTIVE_AGENT_ROLES),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * True when `userId` backs an active agent an admin has cleared to review its
 * own work (`agents.self_review_enabled`, Admin → Agents).
 *
 * The default answer is false, and false is the standing rule: an agent's own
 * submission carries only its implicit-approve stake and waits for a second
 * reader. The flag exists for the deployment shape the unconditional rule
 * strands — a single specialised agent whose output nothing else is qualified
 * (or present) to verify, so every row it files sits in the human queue until
 * a person gets to it.
 *
 * Three paths consult this, and they are the three ways "review its own work"
 * can mean something: the verification queue stops hiding the agent's own
 * rows, POST /api/agent-verifications accepts a verdict on them, and — only
 * for an agent whose backing user already holds review.edit.decide — the
 * moderator path accepts an approve/return of its own pending edit. What the
 * flag never does is let an agent moderate a HUMAN contributor's edit; that
 * check is independent and stays in force.
 */
export async function isSelfReviewAgentUser(userId: number): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: agents.id })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .where(
      and(
        eq(agents.userId, userId),
        eq(agents.status, 'active'),
        eq(agents.selfReviewEnabled, true),
        inArray(users.role, ACTIVE_AGENT_ROLES),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Wipe every verification attached to a target. Used by submission paths
 * that replace a pending-edit row in place (e.g. paper-reviews upsert): the
 * proposedValue is overwritten, so prior verdicts — including the previous
 * submitter's implicit-approve — no longer apply to the new content.
 *
 * The agent disputes mirrored into the unified `disputes` table are retracted
 * with the verdicts that spawned them: they contest content that no longer
 * exists, and an open dispute row blocks consensus auto-apply and pins the row
 * to the top of /review indefinitely (see withdrawAgentDisputesForTarget).
 * Human disputes survive — a moderator closes those.
 *
 * Returns the number of verification rows deleted.
 */
export async function clearVerificationsForTarget(args: {
  targetType: AgentVerificationTargetType;
  targetId: number;
}): Promise<number> {
  const db = getDb();
  const deleted = await db
    .delete(agentVerifications)
    .where(
      and(
        eq(agentVerifications.targetType, args.targetType),
        eq(agentVerifications.targetId, args.targetId),
      ),
    )
    .returning({ id: agentVerifications.id });
  await withdrawAgentDisputesForTarget({
    targetType: args.targetType,
    targetId: args.targetId,
  });
  return deleted.length;
}

/**
 * Mirror an agent's `dispute` verdict into the unified `disputes` table
 * (`upsertOpenDispute`), retrying once when the target moved between the
 * verdict's own commit (`recordVerification`, whose row id is `verificationId`
 * here) and this mirror write.
 *
 * Two different things can cause that race, and only one of them should skip
 * the mirror (#1324):
 *  - a payload revision: `clearVerificationsForTarget` already deleted the
 *    verdict row `verificationId` refers to, along with every other verdict
 *    on this target, so there is nothing left to mirror — the "revise in
 *    place" reconciliation (`withdrawAgentDisputesForTarget`) handles it,
 *    exactly as before this fix.
 *  - a status-only change, such as a moderator's bare `pending -> returned`
 *    with no payload edit: the verdict row is untouched and still blocks
 *    consensus (`unresolvedDisputeVerdictCount`), but skipping the mirror
 *    would leave it with no `disputes` row for a moderator to see or resolve.
 *
 * `StaleDisputeTargetError.actual` is the version `upsertOpenDispute` just
 * observed inside its own locked re-check, so retrying with it targets the
 * target's true current state rather than racing it again. One retry only:
 * if it has moved again by then, the next verdict write or the periodic
 * sweep will catch it. Returns `null` when the mirror could not be written
 * (nothing to notify on), otherwise the same shape `upsertOpenDispute` does.
 */
export async function mirrorAgentDisputeVerdict(args: {
  targetType: DisputeTargetType;
  targetId: number;
  createdBy: number;
  reasonMd: string;
  evidenceRefs?: AgentVerificationEvidenceRef[];
  targetVersion: string;
  verificationId: number;
}): Promise<{ id: number; inserted: boolean } | null> {
  const mirrorArgs = {
    targetType: args.targetType,
    targetId: args.targetId,
    createdBy: args.createdBy,
    source: 'agent',
    reasonMd: args.reasonMd,
    evidenceRefs: args.evidenceRefs,
  };
  // Each attempt re-checks, under lock and in the same transaction as the
  // mirror write, that this exact verdict row is still an explicit dispute
  // (issue 1401): a bare existence check in a separate query would pass for a
  // concurrent approve/abstain that upserted the row in place and already
  // withdrew the dispute.
  try {
    return await upsertOpenDispute({
      ...mirrorArgs,
      targetVersion: args.targetVersion,
      requireLiveDisputeVerdictId: args.verificationId,
    });
  } catch (err) {
    if (err instanceof DisputeVerdictGoneError) return null;
    if (!(err instanceof StaleDisputeTargetError)) throw err;
    if (err.actual === null) return null;
    try {
      return await upsertOpenDispute({
        ...mirrorArgs,
        targetVersion: err.actual,
        requireLiveDisputeVerdictId: args.verificationId,
      });
    } catch (retryErr) {
      if (
        retryErr instanceof StaleDisputeTargetError ||
        retryErr instanceof DisputeVerdictGoneError
      ) {
        return null;
      }
      throw retryErr;
    }
  }
}

/**
 * Return the set of target ids of the given type that currently carry at
 * least one explicit dispute verdict (implicit-approve rows do not count).
 * Lets the moderator queue surface disputed items independent of the usual
 * recency-based row cap.
 */
export async function disputedTargetIdsForType(args: {
  targetType: AgentVerificationTargetType;
}): Promise<Set<number>> {
  const db = getDb();
  const rows = await db
    .select({ targetId: agentVerifications.targetId })
    .from(agentVerifications)
    .where(
      and(
        eq(agentVerifications.targetType, args.targetType),
        eq(agentVerifications.verdict, 'dispute'),
        eq(agentVerifications.isImplicit, false),
      ),
    );
  return new Set(rows.map((r) => r.targetId));
}

/**
 * Find which of `targetIds` the given agent has already verified, so the
 * queue endpoint can exclude them. Returns the set of target ids the agent
 * has touched (implicit-approve rows count — the agent already weighed in by
 * authoring the content).
 */
export async function verifiedByAgentIds(args: {
  agentId: number;
  targetType: AgentVerificationTargetType;
  targetIds: number[];
}): Promise<Set<number>> {
  if (args.targetIds.length === 0) return new Set();
  const db = getDb();
  const rows = await db
    .select({ targetId: agentVerifications.targetId })
    .from(agentVerifications)
    .where(
      and(
        eq(agentVerifications.agentId, args.agentId),
        eq(agentVerifications.targetType, args.targetType),
        inArray(agentVerifications.targetId, args.targetIds),
      ),
    );
  return new Set(rows.map((r) => r.targetId));
}

/**
 * Resolve the caller's active agent row from a `users.id`, or null when the
 * user is not an active agent. Centralised so every endpoint enforces the
 * same active-agent gate.
 */
export async function resolveActiveAgent(userId: number): Promise<{
  id: number;
  userId: number;
  slug: string;
  selfReviewEnabled: boolean;
} | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: agents.id,
      userId: agents.userId,
      slug: agents.slug,
      selfReviewEnabled: agents.selfReviewEnabled,
    })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .where(
      and(
        eq(agents.userId, userId),
        eq(agents.status, 'active'),
        inArray(users.role, ACTIVE_AGENT_ROLES),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Audience filter used by the public read endpoint. Anonymous + authenticated
 * callers can see explicit verdicts; only the owning agent sees its own
 * implicit-approve row (it's noise everywhere else).
 */
export function filterVerificationsForAudience(args: {
  rows: VerificationRow[];
  callerAgentId: number | null;
}): VerificationRow[] {
  return args.rows.filter((r) => {
    if (!r.isImplicit) return true;
    return args.callerAgentId !== null && r.agentId === args.callerAgentId;
  });
}

// re-export to keep the symbol available without forcing callers to drill
// into the helper file's internals.
export { sql };

/**
 * Revoke the flagship standing of an agent's verdicts on still-pending edits
 * when an admin takes the agent's flagship tier away; return the edits touched.
 *
 * A verdict snapshots the verifier's tier when it is written, and that
 * snapshot is deliberately NOT raised by a later promotion: a judgment made
 * while the agent ran a weaker model must never come to satisfy the flagship
 * gate on a calculation-driving value just because the agent was promoted
 * afterwards. Only newer verdicts carry a new flagship tier. A demotion is
 * the opposite case — the admin withdrawing authority — and it takes effect
 * on the verdicts still in play, so a pending high-risk edit does not publish
 * on flagship standing the admin has just revoked (issue #1357). Decided
 * edits keep the tier they were decided under.
 *
 * The re-stamp itself touches every matching verdict regardless of its kind —
 * an implicit approval, an abstain or a dispute all need their tier snapshot
 * corrected too. But only an explicit, non-implicit approval can ever flip a
 * held edit to publish, so the returned list — which the caller re-runs
 * consensus against — is narrowed to those; re-running consensus for a
 * dispute or abstain row would just be a wasted read (issue #1369).
 */
export async function restampPendingVerdictTiers(
  agentId: number,
  modelTier: string | null,
): Promise<number[]> {
  if (modelTier === FLAGSHIP_TIER) return [];
  const rows = await getDb()
    .update(agentVerifications)
    .set({ verifierTier: modelTier })
    .where(
      and(
        eq(agentVerifications.agentId, agentId),
        eq(agentVerifications.targetType, 'pending_edit'),
        eq(agentVerifications.verifierTier, FLAGSHIP_TIER),
        inArray(
          agentVerifications.targetId,
          getDb()
            .select({ id: pendingEdits.id })
            .from(pendingEdits)
            .where(eq(pendingEdits.status, 'pending')),
        ),
      ),
    )
    .returning({
      targetId: agentVerifications.targetId,
      verdict: agentVerifications.verdict,
      isImplicit: agentVerifications.isImplicit,
    });
  return rows
    .filter((r) => r.verdict === 'approve' && !r.isImplicit)
    .map((r) => r.targetId);
}

/**
 * Apply an admin's edit to an agent row and, when it changes the tier,
 * re-stamp that agent's verdicts on pending edits — in ONE transaction.
 *
 * Committing the tier first and re-stamping after left a window in which the
 * agent was already downgraded but its pending verdicts still carried the old
 * `flagship` snapshot, so a concurrent approval or sweep could publish a
 * high-risk edit under authority the admin had just revoked. Inside one
 * transaction a concurrent consensus read sees either the old tier and the old
 * snapshots, or the new tier and the new snapshots, never the mix.
 *
 * Locks the agent row, re-stamps, then updates the agent; a failing agent
 * update (a slug conflict, say) rolls the re-stamp back with it.
 */
export async function updateAgentWithTierRestamp(
  agentId: number,
  update: Record<string, unknown>,
): Promise<{ updated: typeof agents.$inferSelect | undefined; touched: number[] }> {
  return inTransaction(async () => {
    // Lock the agent row FIRST. The verdict upsert (`recordVerification`)
    // takes `agents … FOR UPDATE` for its tier snapshot and only then writes
    // the verdict row; re-stamping verdicts before touching `agents` would
    // take the two locks in the opposite order and let a concurrent verdict
    // POST and this PATCH deadlock each other. One lock order, agent first.
    await getDb()
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .for('update');
    const tierChanged = 'modelTier' in update;
    const touched = tierChanged
      ? await restampPendingVerdictTiers(
          agentId,
          (update.modelTier as string | null | undefined) ?? null,
        )
      : [];
    const [updated] = await getDb()
      .update(agents)
      .set(update as never)
      .where(eq(agents.id, agentId))
      .returning();
    if (!updated) return { updated: undefined, touched: [] };
    return { updated, touched };
  });
}

/**
 * Lock a wiki edit's target page for the rest of the apply transaction, so the
 * visibility re-check (`pendingEditTargetOpenToAgents`) serializes with an
 * editor moving the page to draft. A plain read could see the old `published`
 * row while that update is in flight, and the apply would then write into the
 * page the moment it became a draft.
 *
 * FOR NO KEY UPDATE, not FOR SHARE: the apply goes on to update this same row,
 * and two applies each holding a share lock and then upgrading would deadlock.
 * This mode conflicts with the status update and with another apply, which
 * therefore queue behind it. Taken after the pending-edit row and the agent
 * rows (the order both revalidate hooks use); no-op for non-wiki edits.
 */
export async function lockPendingEditTargetPage(pending: {
  editType: string;
  targetId: number | null;
}): Promise<void> {
  if (
    pending.targetId == null ||
    (pending.editType !== 'wiki_page' &&
      pending.editType !== 'wiki_fact' &&
      pending.editType !== 'wiki_section')
  ) {
    return;
  }
  await getDb()
    .select({ id: wikiPages.id })
    .from(wikiPages)
    .where(eq(wikiPages.id, pending.targetId))
    .for('no key update');
}

/**
 * True when agent consensus may act on this pending edit's target: a wiki
 * edit only against a PUBLISHED page (`wiki_new` never), anything else always
 * — the same content gate the verifier queue applies
 * (`pendingEditWikiVisibility`, `isPendingEditContentVisible`).
 *
 * Contributor-level agents cannot read a draft page, so approvals gathered
 * while it was published say nothing about it once an editor moves it back
 * to draft; publishing into it on those approvals could also cascade into
 * draft-only facts (issue #1357). Checked by both engines, and re-checked
 * inside the apply transaction.
 */
export async function pendingEditTargetOpenToAgents(pending: {
  editType: string;
  targetId: number | null;
}): Promise<boolean> {
  if (pending.editType === 'wiki_new') return false;
  if (
    pending.editType !== 'wiki_page' &&
    pending.editType !== 'wiki_fact' &&
    pending.editType !== 'wiki_section'
  ) {
    return true;
  }
  if (pending.targetId == null) return false;
  const [page] = await getDb()
    .select({ status: wikiPages.status })
    .from(wikiPages)
    .where(eq(wikiPages.id, pending.targetId))
    .limit(1);
  return page?.status === 'published';
}

export interface SourceCheckedPendingEdit {
  proposedMeta: unknown;
  proposedValue: unknown;
  referenceIds: number[] | null;
  referenceId: number | null;
}

/**
 * What an ingested fact's unread-sources hold has to examine. Null for any
 * edit conversation ingestion did not stage for a full-text check — the
 * `proposedMeta.unverifiedReferenceIds` marker is what says it did. For one
 * that carries it, every reference the edit cites NOW: its reference columns
 * and the fact node's own `referenceIds`. Not the frozen marker alone — a
 * source reviewed at ingestion can lose its read-in-full attestation since,
 * and a revision can add one nobody has read — and not a marked paper a
 * revision has since dropped, which no longer backs the claim (the review
 * card names the same set: `WikiFactDiff` intersects the marker with the
 * references still on the proposal).
 */
function sourceCheckSetOf(pending: SourceCheckedPendingEdit): number[] | null {
  const listed = (pending.proposedMeta as { unverifiedReferenceIds?: unknown } | null)
    ?.unverifiedReferenceIds;
  if (!Array.isArray(listed)) return null;
  const nodeIds = (pending.proposedValue as { attrs?: { referenceIds?: unknown } } | null)
    ?.attrs?.referenceIds;
  const candidates: unknown[] = [
    ...(pending.referenceIds ?? []),
    pending.referenceId,
    ...(Array.isArray(nodeIds) ? nodeIds : []),
  ];
  return [
    ...new Set(
      candidates.filter((n): n is number => Number.isInteger(n) && (n as number) > 0),
    ),
  ].sort((a, b) => a - b);
}

/**
 * Lock the review evidence {@link pendingEditCitesUnreadSources} reads, for
 * the rest of the apply transaction, so its re-check serializes with that
 * evidence going away: a pending `paper_review` being withdrawn or rejected,
 * or a live review losing its read-in-full attestation (the PDF-replacement
 * path flips it off). A plain read could see the old qualifying state while
 * that change is in flight, and the fact would then publish on a paper nobody
 * has read by the time it commits.
 *
 * FOR SHARE: the apply never writes these rows, and the changes that matter
 * are updates, which this mode blocks. Pending review rows before
 * `paper_reviews`, the order a review approval writes them, so the two cannot
 * deadlock. A review that appears meanwhile only adds evidence. No-op for an
 * edit ingestion did not mark.
 */
export async function lockPendingEditSourceReviews(
  pending: SourceCheckedPendingEdit,
): Promise<void> {
  const ids = sourceCheckSetOf(pending);
  if (!ids || ids.length === 0) return;
  const db = getDb();
  await db
    .select({ id: pendingEdits.id })
    .from(pendingEdits)
    .where(
      and(
        eq(pendingEdits.editType, 'paper_review'),
        eq(pendingEdits.status, 'pending'),
        inArray(pendingEdits.targetId, ids),
      ),
    )
    .orderBy(asc(pendingEdits.id))
    .for('share');
  await db
    .select({ id: paperReviews.id })
    .from(paperReviews)
    .where(inArray(paperReviews.citationId, ids))
    .orderBy(asc(paperReviews.id))
    .for('share');
}

/**
 * True when a conversation-ingestion proposal cites a paper nobody has read
 * in full. Ingestion stages such a fact as `pending` precisely so someone does
 * the full-text check the assistant could not, marking it with
 * `proposedMeta.unverifiedReferenceIds`. Agent verifiers judge the claim, not
 * whether the paper was read, so their approvals alone must not publish it.
 * The hold lifts once every paper the edit cites now (see
 * `sourceCheckSetOf`) carries a read-in-full review — a live one, or a
 * pending submission that attests it, the same evidence the agent reference
 * gate accepts — or when a moderator approves the edit. A reference that
 * cannot be reviewed at all (a missing or `freetext` citation) keeps the
 * hold: only a person can clear it. Checked by both engines.
 */
export async function pendingEditCitesUnreadSources(
  pending: SourceCheckedPendingEdit,
): Promise<boolean> {
  const ids = sourceCheckSetOf(pending);
  if (!ids || ids.length === 0) return false;

  const db = getDb();
  const live = await db
    .select({ citationId: paperReviews.citationId })
    .from(paperReviews)
    .where(and(inArray(paperReviews.citationId, ids), eq(paperReviews.readInFull, true)));
  const pendingReviews = await db
    .select({ targetId: pendingEdits.targetId, proposedValue: pendingEdits.proposedValue })
    .from(pendingEdits)
    .where(
      and(
        eq(pendingEdits.editType, 'paper_review'),
        eq(pendingEdits.status, 'pending'),
        inArray(pendingEdits.targetId, ids),
      ),
    );
  const read = new Set<number>(live.map((r) => r.citationId));
  for (const row of pendingReviews) {
    const pv = row.proposedValue as { readInFull?: unknown } | null;
    if (row.targetId != null && pv?.readInFull === true) read.add(row.targetId);
  }
  return ids.some((id) => !read.has(id));
}

/**
 * True when `approverUserId` still casts an approval consensus counts on this
 * pending edit: an active agent (active status, contributor+ backing role)
 * with a current `approve` verdict on it, and — when it is the edit's author —
 * the self-review grant.
 *
 * The publishing actor is chosen before the eligibility lock is taken (the
 * caller whose verdict just landed, or the latest approver a retry picks). The
 * under-lock tally can still pass on other approvals after that actor was
 * suspended or lost its grant, and the apply would then stamp `reviewed_by`
 * with an identity whose standing was revoked. Called under
 * `lockConsensusEligibility`, so the answer holds until the apply commits.
 */
export async function approverCountsForConsensus(
  pendingEditId: number,
  approverUserId: number,
): Promise<boolean> {
  const agent = await resolveActiveAgent(approverUserId);
  if (!agent) return false;
  const db = getDb();
  const [pending] = await db
    .select({ submittedBy: pendingEdits.submittedBy })
    .from(pendingEdits)
    .where(eq(pendingEdits.id, pendingEditId))
    .limit(1);
  if (!pending) return false;
  if (pending.submittedBy === approverUserId && !agent.selfReviewEnabled) {
    return false;
  }
  const [verdict] = await db
    .select({ id: agentVerifications.id })
    .from(agentVerifications)
    .where(
      and(
        eq(agentVerifications.agentId, agent.id),
        eq(agentVerifications.targetType, 'pending_edit'),
        eq(agentVerifications.targetId, pendingEditId),
        eq(agentVerifications.verdict, 'approve'),
        // Explicit only, as the tally and the retry's actor selection count
        // it: an author's implicit approval (re-recorded by a bare resubmit)
        // is not an approval anyone cast.
        eq(agentVerifications.isImplicit, false),
      ),
    )
    .limit(1);
  return verdict !== undefined;
}

/**
 * Run `fn` — the insert of a new agent — in a transaction holding the agent
 * pool lock exclusively, so no consensus re-check (`lockConsensusEligibility`)
 * can count the pool while the new agent is being added.
 */
export function withAgentPoolGrowthLock<T>(fn: () => Promise<T>): Promise<T> {
  return inTransaction(async () => {
    await getDb().execute(
      sql`SELECT pg_advisory_xact_lock(${AGENT_POOL_LOCK_NAMESPACE}::int, ${AGENT_POOL_LOCK_KEY}::int)`,
    );
    return fn();
  });
}

/**
 * Share-lock every row consensus eligibility is derived from: all `agents`
 * rows and their backing `users` rows.
 *
 * Used by both consensus engines inside the approval transaction, after the
 * pending-edit row lock (source row, then agents — the order a verdict write
 * takes). The re-check under this lock reads the approvers' status and tier,
 * the author's status and self-review grant, the size of the active pool and
 * every backing role; each of those is changed by an UPDATE on one of these
 * rows (tier PATCH, suspension, user-role demotion), which therefore either
 * commits before the re-check reads it or waits until the approval commits.
 * The agent set is a handful of rows, so locking all of them is cheap and
 * leaves no eligibility input unguarded.
 */
export async function lockConsensusEligibility(): Promise<void> {
  // Row locks guard rows that exist; a new agent is an INSERT, which no row
  // lock can block. Without this, an agent created while a two-agent pool is
  // being re-checked would commit after the pool was counted, and one approval
  // could publish under a degraded quorum the three-agent pool no longer
  // allows. Agent creation takes the same key exclusively
  // (`withAgentPoolGrowthLock`), so it waits for the approval or the approval
  // waits for it.
  await getDb().execute(
    sql`SELECT pg_advisory_xact_lock_shared(${AGENT_POOL_LOCK_NAMESPACE}::int, ${AGENT_POOL_LOCK_KEY}::int)`,
  );
  await getDb()
    .select({ agentId: agents.id, userId: users.id })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .orderBy(asc(agents.id))
    .for('share');
}
