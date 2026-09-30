/**
 * Compute the 0–3 verification level (see src/lib/verificationLevel.ts) for the
 * live drug parameters of a drug, or the live facts of a wiki page.
 *
 * The level of a *live* value is read off its current revision target:
 *   - parameters → the latest `drug_parameter_revision` for that (drug, param)
 *   - wiki facts → the latest `wiki_revision` produced by a `wiki_fact` edit
 *     that touched that factId
 *
 * On that revision target we count, via the same summaries the /review surface
 * uses:
 *   - agent approvers = implicit (the submitter's self-approval, stamped on the
 *     revision at apply time) + explicit peer `approve` verdicts that agents
 *     post on the live revision afterwards;
 *   - whether any human (non-agent) has an approval stamp on the revision;
 *   - whether any agent currently disputes it (surfaced as a separate marker).
 *
 * Values with no revision at all (imported / inherited before the verification
 * system) simply have no entry in the returned map; the UI treats a missing
 * key as level 0.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { getDb, getNeonClient } from './db.js';
import { summariseVerificationsForTargets } from './agent-verifications.js';
import { summariseApprovalsForTargets } from './approvals.js';
import {
  agentVerifications,
  agents,
  drugParameterRevisions,
  users,
  wikiRevisions,
} from '../../db/schema.js';
import { ROLES } from '../../src/lib/roles.js';
import {
  computeVerificationLevel,
  type VerificationLevelInfo,
} from '../../src/lib/verificationLevel.js';
import { genericLevelsForTargets } from './knowledge-governance/assurance-service.js';

type RevisionTargetType = 'drug_parameter_revision' | 'wiki_revision';

// Same tier list the agent gates use (api/_lib/agent-verifications.ts,
// api/agents.ts), rebuilt from ROLES rather than imported so this module does
// not depend on another's private const — the pattern api/agents.ts already
// follows. It exists because `agents.status` alone does not answer "is this
// agent still trusted": the kill switch demotes the backing user instead.
const ACTIVE_AGENT_ROLES: readonly string[] = [
  ROLES.contributor,
  ROLES.editor,
  ROLES.admin,
];

/**
 * Revisions whose own author re-verified them: an explicit (non-implicit)
 * `approve` verdict posted by the active, admin-trusted self-review agent
 * whose user created the revision.
 *
 * Every clause is load-bearing. `is_implicit = false` excludes the submit-time
 * stake — that is the act this is meant to be *distinct from*, and counting it
 * would hand every agent submission a free second verification. The join back
 * to the revision's `created_by` confines the bonus to the author's own work,
 * since a trusted agent verifying a peer's revision already counts as an
 * ordinary second row. And `self_review_enabled` means an operator vouched for
 * this agent by hand; without it the query matches nothing and levels compute
 * exactly as they did before this existed.
 *
 * Exported so the integration suite can exercise the join against real SQL:
 * the functions below reach for `getNeonClient()`, which the PGlite harness
 * does not inject, and a join that matched too much here would quietly inflate
 * the evidence level of every agent-authored value in the database.
 */
export async function authorSelfVerifiedRevisionIds(args: {
  targetType: RevisionTargetType;
  revisionIds: number[];
}): Promise<Set<number>> {
  if (args.revisionIds.length === 0) return new Set();
  const db = getDb();
  const trustedAuthorVerdict = (revisionCreatedBy: PgColumn) =>
    and(
      eq(agentVerifications.targetType, args.targetType),
      inArray(agentVerifications.targetId, args.revisionIds),
      eq(agentVerifications.isImplicit, false),
      eq(agentVerifications.verdict, 'approve'),
      eq(agents.status, 'active'),
      // The documented kill switch (agents/remote-routine-setup.md) demotes the
      // backing user to `authenticated` and does NOT touch agents.status, so
      // status alone is not "is this agent still trusted". Every sibling gate
      // — resolveActiveAgent, isActiveAgentUser, isSelfReviewAgentUser,
      // countActiveVerifierAgents — joins users for exactly this reason.
      // Without it, pulling the switch stops the agent acting but leaves the
      // level-2 bonus its own verdict earned still showing on the page.
      inArray(users.role, ACTIVE_AGENT_ROLES),
      eq(agents.selfReviewEnabled, true),
      eq(agents.userId, revisionCreatedBy),
    );

  const rows =
    args.targetType === 'drug_parameter_revision'
      ? await db
          .select({ id: agentVerifications.targetId })
          .from(agentVerifications)
          .innerJoin(agents, eq(agents.id, agentVerifications.agentId))
          .innerJoin(users, eq(users.id, agents.userId))
          .innerJoin(
            drugParameterRevisions,
            eq(drugParameterRevisions.id, agentVerifications.targetId),
          )
          .where(trustedAuthorVerdict(drugParameterRevisions.createdBy))
      : await db
          .select({ id: agentVerifications.targetId })
          .from(agentVerifications)
          .innerJoin(agents, eq(agents.id, agentVerifications.agentId))
          .innerJoin(users, eq(users.id, agents.userId))
          .innerJoin(
            wikiRevisions,
            eq(wikiRevisions.id, agentVerifications.targetId),
          )
          .where(trustedAuthorVerdict(wikiRevisions.createdBy));

  return new Set(rows.map((r) => r.id));
}

/** Level + dispute state keyed by the revision id of each live value. */
async function levelsByRevisionId(args: {
  targetType: RevisionTargetType;
  revisionIds: number[];
}): Promise<Map<number, VerificationLevelInfo>> {
  const out = new Map<number, VerificationLevelInfo>();
  if (args.revisionIds.length === 0) return out;

  const [verifications, approvals, authorSelfVerified] = await Promise.all([
    summariseVerificationsForTargets({
      targetType: args.targetType,
      targetIds: args.revisionIds,
    }),
    summariseApprovalsForTargets({
      targetType: args.targetType,
      targetIds: args.revisionIds,
    }),
    authorSelfVerifiedRevisionIds({
      targetType: args.targetType,
      revisionIds: args.revisionIds,
    }),
  ]);

  for (const revisionId of args.revisionIds) {
    const v = verifications.get(revisionId);
    const a = approvals.get(revisionId);
    const agentApprovers =
      (v?.approveCount ?? 0) + (v?.implicitApproveCount ?? 0);
    const hasHumanApprover = (a?.approvers ?? []).some((ap) => !ap.isAgent);
    out.set(revisionId, {
      level: computeVerificationLevel({
        agentApprovers,
        hasHumanApprover,
        authorSelfVerified: authorSelfVerified.has(revisionId),
      }),
      disputed: (v?.disputeCount ?? 0) > 0,
    });
  }

  // Phase 7 read cutover. `genericLevelsForTargets` short-circuits to null
  // unless this target type has been advanced to `generic_read` or beyond in
  // kg_migration_state — which nothing ships as — so in the mode everything
  // runs in today this adds no query and the map above is returned unchanged.
  //
  // When it is advanced, only the rows the generic path could answer
  // *completely* are substituted; anything unmirrored or partially mirrored
  // keeps the legacy value computed above. A partial mirror is therefore a
  // non-event rather than a page of zeroes, which matters because a badge that
  // under-reports review tells a reader a verified value is unverified.
  const generic = await genericLevelsForTargets({
    targetType: args.targetType,
    targetIds: args.revisionIds,
    authorSelfVerified,
  });
  if (generic) {
    for (const [revisionId, info] of generic) out.set(revisionId, info);
  }
  return out;
}

/** Per-parameter verification level for one drug, keyed by parameter id. */
export async function parameterVerificationLevels(
  drugId: number,
): Promise<Record<string, VerificationLevelInfo>> {
  const sql = getNeonClient();
  const latest = (await sql`
    SELECT DISTINCT ON (parameter) parameter, id
    FROM drug_parameter_revisions
    WHERE drug_id = ${drugId}
    ORDER BY parameter, created_at DESC
  `) as Array<{ parameter: string; id: number }>;

  const levels = await levelsByRevisionId({
    targetType: 'drug_parameter_revision',
    revisionIds: latest.map((r) => r.id),
  });

  const out: Record<string, VerificationLevelInfo> = {};
  for (const row of latest) {
    const info = levels.get(row.id);
    if (info) out[row.parameter] = info;
  }
  return out;
}

/** Per-fact verification level for one wiki page, keyed by factId. */
export async function factVerificationLevels(
  wikiPageId: number,
): Promise<Record<string, VerificationLevelInfo>> {
  const sql = getNeonClient();
  // Resolve each factId to the most recent wiki_revision whose originating
  // wiki_fact edit targeted it. `add` ops carry the factId on the proposed
  // node (proposed_value.attrs.factId); replace/remove/reorder carry it on
  // fact_target_anchor.factId — COALESCE picks whichever is present.
  const latest = (await sql`
    SELECT DISTINCT ON (fact_id) fact_id, revision_id
    FROM (
      SELECT
        COALESCE(
          pe.fact_target_anchor->>'factId',
          pe.proposed_value->'attrs'->>'factId'
        ) AS fact_id,
        wr.id AS revision_id,
        wr.created_at AS created_at
      FROM wiki_revisions wr
      JOIN pending_edits pe ON pe.id = wr.pending_edit_id
      WHERE wr.page_id = ${wikiPageId}
        AND pe.edit_type = 'wiki_fact'
    ) t
    WHERE fact_id IS NOT NULL
    ORDER BY fact_id, created_at DESC
  `) as Array<{ fact_id: string; revision_id: number }>;

  const levels = await levelsByRevisionId({
    targetType: 'wiki_revision',
    revisionIds: latest.map((r) => r.revision_id),
  });

  const out: Record<string, VerificationLevelInfo> = {};
  for (const row of latest) {
    const info = levels.get(row.revision_id);
    if (info) out[row.fact_id] = info;
  }
  return out;
}
