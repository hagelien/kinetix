/**
 * Agent-to-agent verifications.
 *
 *   GET  ?targetType=&targetId=    — public read of all verdicts on a target
 *   GET  ?targetType=&targetIds=…  — batch summary (count tally) per id
 *   POST                           — active agent records a verdict
 *
 * Independence guardrail: POST 200 body never includes other agents' verdicts
 * for the same target. Agents that want to verify use the queue endpoint
 * (api/agent-verifications-queue.ts), which strips verdict data entirely.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, asc, desc, eq, exists, inArray, ne, not, or, sql } from 'drizzle-orm';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb, inTransaction } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import {
  agentVerificationTargetTypeSchema,
  createAgentVerificationSchema,
} from './_lib/schemas.js';
import {
  ACTIVE_AGENT_ROLES,
  AGENT_CONSENSUS_APPROVE_QUORUM,
  approverCountsForConsensus,
  lockPendingEditTargetPage,
  pendingEditTargetOpenToAgents,
  lockConsensusEligibility,
  consensusApprovalHoldReason,
  countActiveVerifierAgents,
  effectiveConsensusQuorum,
  emptyVerificationSummary,
  filterVerificationsForAudience,
  isActiveAgentUser,
  isConsensusQuorumDegraded,
  isHighRiskPendingEdit,
  isSelfReviewAgentUser,
  listVerifications,
  listVerificationsForTargets,
  recordPeerVerificationLog,
  StaleVerificationTargetError,
  PeersSeenError,
  recordVerification,
  disputeTargetUrl,
  resolveActiveAgent,
  summariseVerificationsForTargets,
  mirrorAgentDisputeVerdict,
  targetAuthorUserId,
  verificationTargetVersion,
  visibleVerificationTargetIds,
  type ConsensusHoldReason,
  type VerificationSummary,
} from './_lib/agent-verifications.js';
import { FLAGSHIP_TIER, isFlagshipTier } from '../src/lib/modelTiers.js';
import {
  applyApprovedEdit,
  PendingEditReviewTokenMismatchError,
  WikiFactApprovalError,
} from './_lib/pending-edits-helpers.js';
import {
  pendingEditReviewToken,
  returnStandsUnrevised,
} from './_lib/pending-edit-review-token.js';
import { ParameterApplyError } from './_lib/drugs-helpers.js';
import {
  hasOpenDispute,
  pendingEditUpheldRulingStands,
  withdrawOpenDispute,
} from './_lib/disputes.js';
import {
  contributionAuthorUserId,
  fanOutDisputeNotification,
} from './_lib/notifications.js';
import {
  disputedClaimAppearsInTarget,
  rationaleWithDisputedClaim,
} from './_lib/disputed-claim.js';
import {
  fireAndForgetMirror,
  mirrorAssessment,
  mirrorPublicationOutcome,
} from './_lib/knowledge-governance/mirror.js';
import { publishOnAgentConsensus } from './_lib/knowledge-governance/publication.js';
import { pendingEditWikiVisibility } from './agent-verifications-queue.js';
import { frozenLiveVerdictId } from './_lib/verdict-reconsideration.js';
import { highRiskProposalWouldPublishUnquoted } from './_lib/source-quote-gate.js';
import {
  agents,
  agentVerifications,
  citations,
  disputes,
  pendingEdits,
  users,
  type AgentVerificationTargetType,
} from '../db/schema.js';

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    switch (req.method) {
      case 'GET':
        return handleGet(req, res, url);
      case 'POST':
        assertSameOrigin(req);
        return handlePost(req, res);
      default:
        error(res, 405, 'Method not allowed');
    }
  },
);

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  const targetTypeRaw = url.searchParams.get('targetType');
  if (!targetTypeRaw) {
    error(res, 400, 'targetType is required');
    return;
  }
  const targetTypeParsed =
    agentVerificationTargetTypeSchema.safeParse(targetTypeRaw);
  if (!targetTypeParsed.success) {
    error(res, 400, `Unknown targetType "${targetTypeRaw}"`);
    return;
  }
  const targetType = targetTypeParsed.data;
  // Resolved once and reused by both paths below: an agent keeps read access
  // to a `pending_edit` target it cast an explicit verdict on even after the
  // edit is decided, which the open-queue visibility rule alone does not
  // cover (see `includeCallerVerdicts` on `visibleVerificationTargetIds`).
  const callerAgent = auth ? await resolveActiveAgent(auth.userId) : null;

  // Batch summary path (?targetIds=1,2,3).
  const targetIdsRaw = url.searchParams.get('targetIds');
  if (targetIdsRaw) {
    const ids = targetIdsRaw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length === 0) {
      json(res, 200, { summaries: {} });
      return;
    }
    if (ids.length > 200) {
      error(res, 400, 'targetIds is capped at 200 entries per request');
      return;
    }
    const visibleIds = await visibleVerificationTargetIds({
      targetType,
      targetIds: ids,
      callerUserId: auth?.userId ?? null,
      callerRole: auth?.role ?? null,
      callerAgentId: callerAgent?.id ?? null,
      callerSelfReviews: callerAgent?.selfReviewEnabled,
      includeCallerVerdicts: true,
    });
    const visibleSet = new Set(visibleIds);
    const map =
      visibleIds.length > 0
        ? await summariseVerificationsForTargets({
            targetType,
            targetIds: visibleIds,
          })
        : new Map<number, VerificationSummary>();
    const summaries: Record<string, VerificationSummary> = {};
    for (const id of ids) {
      if (!visibleSet.has(id)) {
        summaries[String(id)] = emptyVerificationSummary();
        continue;
      }
      summaries[String(id)] = map.get(id) ?? emptyVerificationSummary();
    }
    json(res, 200, { summaries });
    return;
  }

  // Single-target detail path.
  const targetIdRaw = url.searchParams.get('targetId');
  if (!targetIdRaw) {
    error(res, 400, 'targetId or targetIds is required');
    return;
  }
  const targetId = Number(targetIdRaw);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    error(res, 400, 'targetId must be a positive integer');
    return;
  }
  const visible = await visibleVerificationTargetIds({
    targetType,
    targetIds: [targetId],
    callerUserId: auth?.userId ?? null,
    callerRole: auth?.role ?? null,
    callerAgentId: callerAgent?.id ?? null,
    callerSelfReviews: callerAgent?.selfReviewEnabled,
    includeCallerVerdicts: true,
  });
  if (visible.length === 0) {
    error(res, 404, 'Target not found', 'agent_verification_target_not_found');
    return;
  }

  const rows = await listVerifications({ targetType, targetId });
  const filtered = filterVerificationsForAudience({
    rows,
    callerAgentId: callerAgent?.id ?? null,
  });
  json(res, 200, {
    verifications: filtered,
    summary: rows.reduce<VerificationSummary>((s, r) => {
      if (r.isImplicit) {
        s.implicitApproveCount += 1;
      } else if (r.verdict === 'approve') {
        s.approveCount += 1;
        // Snapshotted server-owned tier, matching the consensus gate.
        if (r.verifierTier === FLAGSHIP_TIER) s.approveTier2Count += 1;
      } else if (r.verdict === 'dispute') s.disputeCount += 1;
      else if (r.verdict === 'abstain') s.abstainCount += 1;
      return s;
    }, emptyVerificationSummary()),
    ...(targetType === 'pending_edit'
      ? { consensus: await consensusExplanation(targetId, rows) }
      : {}),
  });
}

/**
 * Why agent consensus has not published this edit, for the /review card
 * (issue #1357). When the hold is a missing flagship approval, also names the
 * approvers who REPORTED a flagship model but whose agent is not set to the
 * flagship tier — the usual cause, and one only an admin can fix. The reported
 * model is never trusted for the gate itself (any caller can claim one); it is
 * only a hint about which setting to check.
 */
export async function consensusExplanation(
  pendingEditId: number,
  rows: Awaited<ReturnType<typeof listVerifications>>,
): Promise<
  | { ready: true }
  | { ready: false; reason: AgentConsensusHold; unrankedFlagshipApprovers?: string[] }
> {
  const status = await agentConsensusStatus(pendingEditId);
  if (status.ready || status.reason !== 'high_risk_missing_flagship') {
    return status;
  }
  const unrankedFlagshipApprovers = rows
    .filter(
      (r) =>
        !r.isImplicit &&
        r.verdict === 'approve' &&
        r.verifierTier !== FLAGSHIP_TIER &&
        isFlagshipTier(r.model),
    )
    .map((r) => r.agent?.name ?? r.agent?.slug ?? `agent #${r.agentId}`);
  return { ...status, unrankedFlagshipApprovers };
}

/**
 * {@link consensusExplanation} for many pending edits at once (issue #1374).
 * The /review moderator queue can render up to ~100 cards, each of which
 * used to call GET ?targetId= on its own mount — up to 100 HTTP requests,
 * each re-running the same verdict lookup. This does the one batchable read
 * (`listVerificationsForTargets`) up front and fans the rest out with
 * `Promise.all` inside a single request instead of one per card.
 */
export async function consensusStatusForTargets(
  pendingEditIds: number[],
): Promise<Map<number, Awaited<ReturnType<typeof consensusExplanation>>>> {
  const ids = [...new Set(pendingEditIds.filter(Number.isInteger))];
  if (ids.length === 0) return new Map();
  const rowsByTarget = await listVerificationsForTargets({
    targetType: 'pending_edit',
    targetIds: ids,
  });
  const entries = await Promise.all(
    ids.map(
      async (id) =>
        [id, await consensusExplanation(id, rowsByTarget.get(id) ?? [])] as const,
    ),
  );
  return new Map(entries);
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  const agent = await resolveActiveAgent(auth.userId);
  if (!agent) {
    error(
      res,
      403,
      'Active agent required',
      'agent_verification_agent_required',
    );
    return;
  }

  const parsed = await parseAndValidate(req, createAgentVerificationSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }
  const targetType = parsed.data.targetType as AgentVerificationTargetType;

  // Target must exist + be visible to the agent's role.
  const visible = await visibleVerificationTargetIds({
    targetType,
    targetIds: [parsed.data.targetId],
    callerUserId: auth.userId,
    callerRole: auth.role,
    callerAgentId: agent.id,
    callerSelfReviews: agent.selfReviewEnabled,
  });
  if (visible.length === 0) {
    error(res, 404, 'Target not found', 'agent_verification_target_not_found');
    return;
  }

  const currentVersion = await verificationTargetVersion({
    targetType,
    targetId: parsed.data.targetId,
  });
  if (!currentVersion) {
    error(res, 404, 'Target not found', 'agent_verification_target_not_found');
    return;
  }
  if (currentVersion !== parsed.data.targetVersion) {
    error(
      res,
      409,
      'Target changed since it was queued',
      'agent_verification_target_version_stale',
    );
    return;
  }

  // An agent that has been shown its peers while holding its verdict (the
  // control phase, api/_lib/verdict-reconsideration.ts) is no longer blind, so
  // a new verdict from it would not be an independent measurement. Its dispute
  // stands, to be maintained or withdrawn through the control phase, until a
  // revision of the target clears the verdicts.
  if (
    (await frozenLiveVerdictId({
      agentId: agent.id,
      targetType,
      targetId: parsed.data.targetId,
    })) !== null
  ) {
    error(
      res,
      409,
      'You have been shown your peers\' verdicts on this version of the target, so a new verdict from you would not be blind; use the reconsideration step, or wait for the target to be revised',
      'agent_verification_peers_seen',
    );
    return;
  }

  // Block self-verification — including against rows the agent's own submission
  // produced (the implicit-approve row is written by the API at submit time;
  // additional verdicts on the same target by the same agent are not allowed).
  //
  // …unless an admin has cleared THIS agent to review its own work
  // (`agents.self_review_enabled`, Admin → Agents). The explicit verdict then
  // upserts over the implicit-approve row on the same (agent, target) slot, so
  // the agent's stake is counted once either way: as an implicit stake before
  // it reviewed, as a reasoned verdict after. That is also why a self-review
  // agent can still dispute its own row — reconsidering a submission is the
  // useful half of the feature, and the upsert makes it a correction rather
  // than a second vote.
  const ownerId = await targetAuthorUserId({
    targetType,
    targetId: parsed.data.targetId,
  });
  const isSelfVerification = ownerId !== null && ownerId === auth.userId;
  if (isSelfVerification && !agent.selfReviewEnabled) {
    error(
      res,
      403,
      'Agents cannot verify their own content',
      'agent_verification_self_not_allowed',
    );
    return;
  }

  // A self-approval must say why. Everything the grant buys — satisfying
  // consensus alone in a one-agent pool, and the level-2 evidence bonus on a
  // revision — rests on the claim that the verdict is a SECOND act: a reasoned
  // re-check, distinct from the stake stamped at submit time. An empty
  // `approve` is not that. It is the implicit row again, wearing the explicit
  // row's weight, and the schema lets it through because it only demands a
  // rationale for `dispute`/`abstain` (where the author would be arguing
  // against itself, so the bar was already high).
  //
  // ≥20 chars matches that existing bar rather than inventing a second one.
  // Peer verdicts are untouched: an agent approving someone else's work adds
  // an independent identity to the tally, which is its own evidence.
  if (
    isSelfVerification &&
    parsed.data.verdict === 'approve' &&
    (parsed.data.rationaleMd ?? '').trim().length < 20
  ) {
    error(
      res,
      400,
      'A self-approval requires a rationale of at least 20 characters saying what was re-checked',
      'agent_verification_self_approval_needs_rationale',
    );
    return;
  }

  // A dispute must quote the passage it says is wrong, and the passage must
  // really be in the target (issue #1357). A reviewer that cannot point at the
  // sentence it objects to has misread the proposal — often by carrying a
  // pattern over from the previous item in its batch — and a dispute blocks
  // consensus alone, so the misreading would otherwise land on a moderator.
  if (
    parsed.data.verdict === 'dispute' &&
    !(await disputedClaimAppearsInTarget({
      targetType,
      targetId: parsed.data.targetId,
      claim: parsed.data.disputedClaim ?? '',
    }))
  ) {
    error(
      res,
      400,
      'disputedClaim does not occur in the target. Quote verbatim the passage you say is wrong; if you cannot find it, re-read the proposal — the flaw may not be there',
      'agent_verification_disputed_claim_not_found',
    );
    return;
  }
  // Stored with the verdict (and mirrored into the dispute) so the moderator
  // sees exactly which passage is contested.
  const rationaleMd =
    parsed.data.verdict === 'dispute'
      ? rationaleWithDisputedClaim(
          parsed.data.disputedClaim ?? '',
          parsed.data.rationaleMd ?? '',
        )
      : (parsed.data.rationaleMd ?? '');

  // Evidence citation IDs must resolve to real rows.
  const evidenceRefs = parsed.data.evidenceRefs ?? [];
  const citationIds = evidenceRefs
    .map((r) => r.citationId)
    .filter((v): v is number => typeof v === 'number');
  if (citationIds.length > 0) {
    const db = getDb();
    const found = await db
      .select({ id: citations.id })
      .from(citations)
      .where(inArray(citations.id, citationIds));
    if (found.length !== new Set(citationIds).size) {
      error(
        res,
        400,
        'One or more evidenceRefs[].citationId values do not resolve to a citation',
        'agent_verification_unknown_citation',
      );
      return;
    }
  }

  // The pre-check above is a read; this is the one that decides. A revision can
  // land between the two — the author lookup, the self-review rules and the
  // citation resolution all sit in that window — and nothing on
  // `agent_verifications` records which revision was validated, so an admitted
  // verdict would read as a judgment of a payload its author never saw.
  let recorded: { id: number; inserted: boolean };
  try {
    recorded = await recordVerification({
      expectTargetVersion: parsed.data.targetVersion,
      agentId: agent.id,
      targetType,
      targetId: parsed.data.targetId,
      verdict: parsed.data.verdict,
      rationaleMd,
      evidenceRefs,
      model: parsed.data.model ?? null,
      isImplicit: false,
    });
  } catch (err) {
    if (err instanceof StaleVerificationTargetError) {
      // The same answer the pre-check gives, for the same reason — the agent
      // reviewed a revision that is no longer current and should re-queue.
      error(
        res,
        409,
        'Target changed since it was queued',
        'agent_verification_target_version_stale',
      );
      return;
    }
    if (err instanceof PeersSeenError) {
      error(
        res,
        409,
        'You have been shown your peers\' verdicts on this version of the target, so a new verdict from you would not be blind; use the reconsideration step, or wait for the target to be revised',
        'agent_verification_peers_seen',
      );
      return;
    }
    throw err;
  }
  const { id, inserted } = recorded;
  await recordPeerVerificationLog({
    userId: auth.userId,
    targetType,
    targetId: parsed.data.targetId,
    verdict: parsed.data.verdict,
    rationaleMd,
    evidenceRefCount: evidenceRefs.length,
  });

  // Shadow mirror (§12.1, Phase 4 of the knowledge-governance extraction).
  // Strictly observational and strictly after the legacy write: the verdict
  // above is already recorded and authoritative, and a mirror failure must
  // never reject it (§12.4). `mirrorAssessment` cannot throw or reject, and
  // returns immediately unless this target type has been advanced past
  // `legacy_only` in kg_migration_state — which nothing ships as. Deliberately
  // not awaited, so it cannot add latency to the response either.
  fireAndForgetMirror(
    mirrorAssessment({
      targetType,
      targetId: parsed.data.targetId,
      legacyVerificationId: id,
      actorRef: `user:${auth.userId}`,
      verdict: parsed.data.verdict,
      rationaleMd,
      model: parsed.data.model ?? null,
      isImplicit: false,
    }),
  );

  // Bridge to the unified disputes table (see api/_lib/disputes.ts). The
  // verdict above is unchanged and still drives consensus; here we mirror it so
  // an agent contestation shows up in the same feed/inbox a human dispute does.
  // A `dispute` opens (or refreshes) an agent-sourced dispute and notifies on
  // first raise; flipping to approve/abstain retracts this agent's open dispute.
  if (parsed.data.verdict === 'dispute') {
    // The verdict above already committed under the same expectTargetVersion,
    // so a mismatch inside the mirror write only fires if the target moved in
    // the (tiny) window between that commit and this one.
    // `mirrorAgentDisputeVerdict` (#1324) tells apart a payload revision
    // (nothing left to mirror; the "revise in place" reconciliation handles
    // it) from a status-only change such as a moderator's bare
    // `pending -> returned`, which still needs the mirror so the verdict it
    // already blocks consensus on gets a `disputes` row a moderator can act
    // on — retrying once against the version it observes, rather than
    // silently leaving that case unmirrored.
    const mirrored = await mirrorAgentDisputeVerdict({
      targetType,
      targetId: parsed.data.targetId,
      createdBy: auth.userId,
      reasonMd: rationaleMd,
      evidenceRefs,
      targetVersion: parsed.data.targetVersion,
      verificationId: id,
    });
    if (mirrored?.inserted) {
      const authorUserId = await contributionAuthorUserId({
        targetType,
        targetId: parsed.data.targetId,
      });
      await fanOutDisputeNotification({
        type: 'dispute_opened',
        disputeId: mirrored.id,
        targetType,
        targetId: parsed.data.targetId,
        actorUserId: auth.userId,
        targetAuthorUserId: authorUserId,
        title: 'An agent disputed a fact or parameter',
        bodyMd: rationaleMd,
        url: await disputeTargetUrl({ targetType, targetId: parsed.data.targetId }),
      });
    }
  } else {
    await withdrawOpenDispute({
      targetType,
      targetId: parsed.data.targetId,
      createdBy: auth.userId,
    });
  }

  // Agent consensus stands in for a human moderator's approval: once a pending
  // edit collects the required quorum of independent agent approvals with no
  // open dispute, apply it through the same path the /review PATCH uses. Only
  // an `approve` can newly clear the bar, and only pending_edit targets are
  // appliable, so other verdicts/target types skip this entirely.
  let autoApplied = false;
  if (targetType === 'pending_edit' && parsed.data.verdict === 'approve') {
    autoApplied = await applyOnAgentConsensus({
      pendingEditId: parsed.data.targetId,
      approverUserId: auth.userId,
      // Pass the grant this request was ADMITTED under rather than letting the
      // apply path re-read it. Re-reading inverts the meaning of revoking the
      // flag: an admin who turns self-review off between the verdict landing
      // and the tally running would drop `authorSelfReviews` to false, shrink
      // the quorum from 2 to 1, and thereby cause the author's just-recorded
      // self-approval to publish — the opposite of what revoking it should do.
      // The snapshot is only used when the caller IS the author; a peer's
      // verdict says nothing about the author's grant, so that case still
      // resolves from the row.
      authorSelfReviews:
        ownerId !== null && ownerId === auth.userId
          ? agent.selfReviewEnabled
          : undefined,
    });
    // Shadow mirror of the publication outcome (§12.1, Phase 4 work item 6).
    // Only on an actual apply: recording an event for every verdict that
    // failed to reach quorum would turn "what happened to this proposal" into
    // a log of things that did not happen.
    if (autoApplied) {
      fireAndForgetMirror(
        mirrorPublicationOutcome({
          targetType: 'pending_edit',
          targetId: parsed.data.targetId,
          action: 'applied',
          actorRef: 'system:agent-consensus',
        }),
      );
    }
  }

  json(res, inserted ? 201 : 200, {
    id,
    inserted,
    autoApplied,
    agent: { id: agent.id, slug: agent.slug },
  });
}

// Operator alert: consensus has degraded below the two-reviewer design target
// because too few agents are active. Throttled to at most once per window per
// warm instance so a steady stream of approvals doesn't flood the logs — the
// signal we want is "this deploy is running short-handed", not one line per
// verdict.
let _lastDegradedQuorumWarnAt = 0;
const DEGRADED_QUORUM_WARN_THROTTLE_MS = 10 * 60_000;

function warnDegradedConsensusQuorum(
  activeAgents: number,
  quorum: number,
  authorSelfReviews = false,
): void {
  const now = Date.now();
  if (now - _lastDegradedQuorumWarnAt < DEGRADED_QUORUM_WARN_THROTTLE_MS) {
    return;
  }
  _lastDegradedQuorumWarnAt = now;
  // Two different situations reach quorum 1, and telling an operator the wrong
  // one sends them to fix the wrong thing. Without self-review the lone
  // approval came from an independent peer and the pool needs a THIRD agent to
  // restore the design target. With it, the lone approval is the author's own
  // and a SECOND agent is already enough — the author counts itself, so the
  // pool reaches quorum 2 one agent sooner.
  const detail = authorSelfReviews
    ? `The author reviews its own work (agents.self_review_enabled), so this ` +
      `edit can be carried by its own verdict alone; adding a second active ` +
      `agent restores two-reviewer consensus.`
    : `Agent-authored edits now auto-apply on a single independent peer ` +
      `approval; add a third active agent to restore ` +
      `two-independent-reviewer consensus.`;
  console.warn(
    `[agent-consensus] degraded quorum: ${activeAgents} active agent(s) ` +
      `support a quorum of only ${quorum} (design target ` +
      `${AGENT_CONSENSUS_APPROVE_QUORUM}). ${detail}`,
  );
}

// A high-risk (calculation-driving parameter) edit met the base quorum but was
// held for want of the extra capability guard. Unthrottled: these are rare (a
// high-risk edit that already collected enough approvals) and each is an
// operator-actionable signal — the pool needs a flagship-tier verifier, or is
// running short-handed on high-risk work — so we do not want to drop any.
function warnHighRiskConsensusHold(
  pendingEditId: number,
  reason: ConsensusHoldReason,
  summary: VerificationSummary,
): void {
  const detail =
    reason === 'high_risk_missing_flagship'
      ? `${summary.approveCount} approval(s) but none from a flagship-tier ` +
        `verifier; a calculation-driving parameter needs at least one. Add a ` +
        `flagship-tier agent to the pool or leave it for a human moderator.`
      : `only ${summary.approveCount} approval(s) in a degraded (single- ` +
        `reviewer) pool; a calculation-driving parameter never auto-applies ` +
        `on the relaxed quorum. Add a third active agent, or a human approves.`;
  console.warn(
    `[agent-consensus] high-risk edit ${pendingEditId} held (${reason}): ${detail}`,
  );
}

/**
 * Surface a consensus hold caused by a missing source quote.
 *
 * Worth a log line for the same reason the high-risk holds are: it is
 * actionable. The proposal is not wrong and not disputed — it is simply
 * unquoted, and the fix is for the submitting routine to resubmit with the
 * sentence it read the value off. A silent hold would look identical to an
 * edit nobody had got round to reviewing.
 */
function warnMissingSourceQuoteHold(
  pendingEditId: number,
  parameter: string | null,
): void {
  console.warn(
    `[agent-consensus] high-risk edit ${pendingEditId} held ` +
      `(source_quote_missing): the proposal for ${parameter ?? 'a parameter'} ` +
      `records no verbatim source quote, so peer consensus cannot publish a ` +
      `calculation-driving value unattended. Resubmit with the sentence the ` +
      `value was read off, or let a human moderator approve it.`,
  );
}

/**
 * Apply a pending edit once agent peer-review reaches consensus — the
 * human-equivalent-review path. Re-tallies the target's verdicts and, if the
 * quorum is met with no open dispute, runs the same applyApprovedEdit the
 * moderator approval uses, attributing the approval to the agent whose verdict
 * tipped it over. Returns whether the edit was actually applied.
 *
 * Failure is never fatal to the verdict write: the verdict is the agent's
 * primary action and is already persisted. If the edit is no longer pending (a
 * human or an earlier consensus already moderated it) or an invariant blocks an
 * automatic apply (parameter collision, moved wiki-fact target, a conflict with
 * a newer approved change), we leave the row in the human queue and report
 * autoApplied=false rather than failing the request.
 */
/** The consensus gate no longer held when re-checked under the apply lock. */
class ConsensusRevalidationError extends Error {
  constructor(readonly reason: AgentConsensusHold) {
    super(`agent consensus no longer holds under lock: ${reason}`);
    this.name = 'ConsensusRevalidationError';
  }
}


/**
 * Why agent consensus has not published a pending edit. `quorum_unmet`,
 * `high_risk_*` are the tally-policy holds (`consensusApprovalHoldReason`);
 * the rest are the gates around it. `apply_failed` means every gate passed but
 * the write itself refused (a parameter collision, a moved target, a payload
 * that changed under the decision).
 */
export type AgentConsensusHold =
  | ConsensusHoldReason
  | 'not_found'
  | 'not_pending'
  | 'source_quote_missing'
  | 'clinical_case'
  | 'human_submitted'
  | 'open_dispute'
  | 'apply_failed'
  // The actor the apply would be attributed to lost its standing before the
  // eligibility lock; only runAgentConsensus reports it, never the read-only
  // status the review card shows. The next sweep picks a current approver.
  | 'approver_ineligible'
  // An upheld dispute still stands against the current payload.
  | 'upheld_dispute'
  // A reviewer returned this version with a note; it must be revised first.
  | 'returned_unrevised'
  // A wiki edit whose page is not (or no longer) published.
  | 'target_unpublished';

export type AgentConsensusOutcome =
  | { outcome: 'applied' }
  | { outcome: 'already_applied' }
  | { outcome: 'held'; reason: AgentConsensusHold; detail?: string };

type ConsensusPendingRow = NonNullable<
  Awaited<ReturnType<typeof readConsensusPendingRow>>
>;

async function readConsensusPendingRow(pendingEditId: number) {
  const db = getDb();
  const [row] = await db
    .select({
      editType: pendingEdits.editType,
      submittedBy: pendingEdits.submittedBy,
      parameter: pendingEdits.parameter,
      // The entry id for a `param_entry` update, needed to resolve the quote
      // the write would preserve.
      targetId: pendingEdits.targetId,
      proposedValue: pendingEdits.proposedValue,
      proposedMeta: pendingEdits.proposedMeta,
      // Everything the review token is computed from, so the apply can be bound
      // to the version this gate actually examined.
      id: pendingEdits.id,
      referenceId: pendingEdits.referenceId,
      referenceIds: pendingEdits.referenceIds,
      status: pendingEdits.status,
      submittedAt: pendingEdits.submittedAt,
      lastConsensusApplyFailure: pendingEdits.lastConsensusApplyFailure,
    })
    .from(pendingEdits)
    .where(eq(pendingEdits.id, pendingEditId))
    .limit(1);
  return row ?? null;
}

/** The shape stored in `pending_edits.last_consensus_apply_failure`. */
type ConsensusApplyFailure = {
  /** `pendingEditReviewToken` at the moment the apply was attempted. */
  token: string;
  detail?: string;
  at: string;
};

function isConsensusApplyFailure(value: unknown): value is ConsensusApplyFailure {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as { token?: unknown }).token === 'string' &&
    typeof (value as { at?: unknown }).at === 'string'
  );
}

/**
 * Record a deterministic apply refusal so the read-only status stops
 * reporting `ready: true` for a proposal that has already failed to apply
 * under these exact contents (issue #1364). Best-effort: a write failure here
 * must not turn an already-decided verdict into a thrown request, so callers
 * fire this and ignore its outcome.
 *
 * Two attempts can overlap when the proposal is revised between them — an
 * older attempt (still holding the pre-revision token) recording after a
 * newer one would overwrite that newer attempt's own failure with a token
 * `agentConsensusStatus` no longer matches, silently reporting `ready: true`
 * for a current proposal that already failed. Re-reading the row under
 * `FOR UPDATE` and re-deriving its token right before the write closes that
 * window: whichever attempt commits last recomputes the token from what the
 * row actually holds at that moment, and skips the write if it no longer
 * matches — a stale attempt can never clobber a fresher one (or the fresher
 * one's own not-yet-written failure).
 */
export async function persistConsensusApplyFailure(
  pendingEditId: number,
  token: string,
  detail: string | undefined,
): Promise<void> {
  try {
    await inTransaction(async () => {
      const db = getDb();
      const [row] = await db
        .select({
          editType: pendingEdits.editType,
          submittedBy: pendingEdits.submittedBy,
          parameter: pendingEdits.parameter,
          targetId: pendingEdits.targetId,
          proposedValue: pendingEdits.proposedValue,
          proposedMeta: pendingEdits.proposedMeta,
          id: pendingEdits.id,
          referenceId: pendingEdits.referenceId,
          referenceIds: pendingEdits.referenceIds,
          status: pendingEdits.status,
          submittedAt: pendingEdits.submittedAt,
        })
        .from(pendingEdits)
        .where(eq(pendingEdits.id, pendingEditId))
        .for('update');
      if (!row || pendingEditReviewToken(row as never) !== token) return;
      const failure: ConsensusApplyFailure = {
        token,
        at: new Date().toISOString(),
        ...(detail ? { detail } : {}),
      };
      await db
        .update(pendingEdits)
        .set({ lastConsensusApplyFailure: failure })
        .where(eq(pendingEdits.id, pendingEditId));
    });
  } catch (err) {
    console.error(
      `[agent-consensus] could not persist the apply failure for pending ` +
        `edit ${pendingEditId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The gates between the generic engine and the write: clinical cases, human
 * submissions, the capability-aware tally and open disputes. Shared by the
 * apply path and the read-only {@link agentConsensusStatus} so the reason the
 * review card shows is the reason the apply path acts on.
 */
async function legacyConsensusHold(
  pendingEditId: number,
  pending: ConsensusPendingRow,
  opts: { authorSelfReviews?: boolean; log: boolean },
): Promise<{ reason: AgentConsensusHold } | null> {
  // SAFETY-CRITICAL (spec §12 Stage 12 + agents/clinical-case-builder.md):
  // a clinical case is NEVER published on agent consensus alone — it always
  // requires a human expert moderator. Agent verdicts still record and surface
  // in the queue to inform that human, but this auto-apply path must refuse to
  // act on a clinical_case even at full quorum with no dispute. The human
  // /review approval path (applyApprovedEdit) is unaffected and still publishes.
  if (pending.editType === 'clinical_case') return { reason: 'clinical_case' };

  // Human-submitted edits are peer-verified but never auto-applied. Agents see
  // every pending edit in their queue (api/agent-verifications-queue.ts) so a
  // human proposal gets the same scrutiny — a dispute floats it, approvals
  // corroborate it — but consensus stands in for a moderator only on the
  // agents' own output. A human contributor's change stays a human decision.
  if (
    pending.submittedBy == null ||
    !(await isActiveAgentUser(pending.submittedBy))
  ) {
    return { reason: 'human_submitted' };
  }
  const submittedBy = pending.submittedBy;

  // A wiki edit whose page is no longer published is out of the agents'
  // reach: they cannot read a draft, so their approvals no longer vouch for
  // publishing into it (issue #1357).
  if (!(await pendingEditTargetOpenToAgents(pending))) {
    return { reason: 'target_unpublished' };
  }


  // Adapt the quorum to the active-agent pool. A fixed quorum of 2 is
  // unreachable for agent-authored edits whenever fewer than three agents are
  // active (the lone non-author verifier can only ever cast one approval), so
  // those edits would silently pile up in the human queue. effectiveConsensusQuorum
  // relaxes the bar to what the pool can satisfy; we warn when it degrades below
  // the design target so the shrunken pool is visible rather than failing mute.
  //
  // A self-review author (agents.self_review_enabled) is itself an eligible
  // verifier, so it enlarges the pool rather than lowering the bar: with two
  // active agents the quorum goes UP from 1 to 2 (the author's own verdict
  // plus one independent one), and only a lone active agent can carry its own
  // edit alone — which is exactly the deployment the flag is for, and it still
  // logs as degraded.
  const activeAgents = await countActiveVerifierAgents();
  const quorumOpts = {
    authorSelfReviews:
      opts.authorSelfReviews ??
      (await isSelfReviewAgentUser(submittedBy)),
  };
  const quorum = effectiveConsensusQuorum(activeAgents, quorumOpts);
  // An author without the self-review grant is not a verifier, so its own
  // explicit approval must not count — whether it was cast under a grant that
  // has since been revoked or never had one. Otherwise revoking the grant
  // shrinks the quorum (above) while the author's verdict still fills it, and
  // with two active agents the author could publish its own edit alone by
  // triggering a retry (issue #1357 sweep).
  const summary = (
    await summariseVerificationsForTargets({
      targetType: 'pending_edit',
      targetIds: [pendingEditId],
      excludeAgentUserId: quorumOpts.authorSelfReviews ? undefined : submittedBy,
      // Only agents eligible to verify now; a suspended agent's approval no
      // longer carries standing (re-checked under the apply lock too).
      onlyActiveVerifiers: true,
    })
  ).get(pendingEditId);
  if (!summary) return { reason: 'quorum_unmet' };
  if (opts.log && isConsensusQuorumDegraded(activeAgents, quorumOpts)) {
    warnDegradedConsensusQuorum(
      activeAgents,
      quorum,
      quorumOpts.authorSelfReviews,
    );
  }

  // Capability-aware gate. A high-risk edit (a calculation-driving parameter)
  // never rides the degraded single-approval path and needs at least one
  // flagship-tier approval, so two mid-tier agents that share a blind spot
  // cannot auto-publish a value that feeds every calculation. Non-high-risk
  // edits fall through the base quorum check exactly as before.
  const highRisk = isHighRiskPendingEdit({
    editType: pending.editType,
    parameter: pending.parameter,
  });
  const holdReason = consensusApprovalHoldReason(summary, quorum, { highRisk });
  if (holdReason) {
    // 'quorum_unmet' is the ordinary "not enough approvals yet" case and is not
    // worth a line; the high-risk holds are the ones an operator may need to
    // act on (add a flagship-tier verifier to the pool), so surface those.
    if (holdReason !== 'quorum_unmet' && opts.log) {
      warnHighRiskConsensusHold(pendingEditId, holdReason, summary);
    }
    return { reason: holdReason };
  }

  // An open dispute holds the edit for a human no matter the approval tally.
  // The quorum check above already accounts for agent dispute *verdicts*; this
  // additionally blocks on HUMAN disputes, which live only in the unified
  // disputes table and so don't show up in the agent_verifications summary.
  if (
    await hasOpenDispute({
      targetType: 'pending_edit',
      targetId: pendingEditId,
    })
  ) {
    return { reason: 'open_dispute' };
  }
  // A resolved dispute that was UPHELD still binds the payload it was ruled
  // against. The uphold returns the edit but leaves its verdicts, so a bare
  // resubmit would otherwise let the old approvals publish exactly what the
  // moderator ruled against. Only a real revision clears it.
  if (await pendingEditUpheldRulingStands(pendingEditId, pending.proposedMeta)) {
    return { reason: 'upheld_dispute' };
  }
  // Likewise a reviewer's comment-only return: it kept the verdicts, and a
  // bare resubmit must not let them publish what the reviewer sent back.
  if (returnStandsUnrevised(pending.proposedMeta)) {
    return { reason: 'returned_unrevised' };
  }
  return null;
}

/**
 * Read-only: would agent consensus publish this edit right now, and if not,
 * why? Runs the same gates as {@link applyOnAgentConsensus} without writing.
 * The generic engine (only authoritative for cut-over edit types) is not
 * consulted; its rules are pinned to these by the parity tests.
 */
export async function agentConsensusStatus(
  pendingEditId: number,
): Promise<{ ready: true } | { ready: false; reason: AgentConsensusHold }> {
  const pending = await readConsensusPendingRow(pendingEditId);
  if (!pending) return { ready: false, reason: 'not_found' };
  if (pending.status !== 'pending') return { ready: false, reason: 'not_pending' };
  if (await highRiskProposalWouldPublishUnquoted(pending, () => {})) {
    return { ready: false, reason: 'source_quote_missing' };
  }
  const hold = await legacyConsensusHold(pendingEditId, pending, { log: false });
  if (hold) return { ready: false, reason: hold.reason };
  // Every gate above passes, but a prior attempt at exactly this content may
  // already have failed to apply (a parameter collision, a moved wiki-fact
  // target) — a deterministic refusal a re-run of these read-only gates
  // cannot see, because it is the write itself that refuses, not the tally.
  // Report that instead of `ready: true` for a retry that has already failed
  // once and cannot succeed again without a new proposal (issue #1364).
  const failure = pending.lastConsensusApplyFailure;
  if (
    isConsensusApplyFailure(failure) &&
    failure.token === pendingEditReviewToken(pending as never)
  ) {
    return { ready: false, reason: 'apply_failed' };
  }
  return { ready: true };
}

export async function applyOnAgentConsensus(args: {
  pendingEditId: number;
  approverUserId: number;
  /**
   * The author's `self_review_enabled` as the calling request observed it, so
   * the quorum is sized by the grant that admitted the verdict rather than by
   * whatever the row says a moment later. Omit when the caller is not the
   * author (or has no snapshot); the flag is then read from the agent row.
   */
  authorSelfReviews?: boolean;
}): Promise<boolean> {
  return (await runAgentConsensus(args)).outcome === 'applied';
}

/**
 * {@link applyOnAgentConsensus} with the reason it did or did not publish, for
 * the retry sweep and the operator log.
 */
export async function runAgentConsensus(args: {
  pendingEditId: number;
  approverUserId: number;
  authorSelfReviews?: boolean;
}): Promise<AgentConsensusOutcome> {
  // Read the row first. The payload precondition below has to be settled
  // BEFORE the generic engine is consulted: for an edit type advanced to
  // `generic_authoritative` that call publishes and returns, so a guard placed
  // after it would be unreachable for exactly the types it most needs to cover.
  // The precondition is also represented in the generic policy
  // (`unquoted-calculation-driving`) and in the migration dossier, so the two
  // engines agree about it rather than one of them merely being ordered first;
  // this check is what makes that agreement unnecessary for safety.
  const pending = await readConsensusPendingRow(args.pendingEditId);

  /**
   * The version every check below is about.
   *
   * The quote gate, the tally and the dispute check all read the proposal as it
   * is now; `applyApprovedEdit` then re-reads it under a row lock and applies
   * whatever it finds. Between those two moments the AUTHOR can PATCH their own
   * proposal — an agent with self-review enabled needs only one other approval
   * — and clear the quote. The payload that publishes is then not the payload
   * anything approved, and no lock helps: the race is between the decision and
   * the write, not inside either.
   *
   * Binding the apply to this token closes it. A payload that moved produces a
   * different token and `applyApprovedEdit` refuses, which the caller reports as
   * "not applied" — the edit stays pending for the verdicts its new content
   * deserves. Every direct-writer race in this review had the same shape and the
   * same answer: say which version you decided about.
   */
  const decidedVersion = pending
    ? pendingEditReviewToken(pending as never)
    : null;

  // Evidence-completeness guard. A calculation-driving parameter does not
  // publish unattended unless the proposal records the verbatim sentence its
  // value was read off. Checking the citation alone cannot distinguish "the
  // right number from the cited document" from "a number that appears in the
  // cited document", and the second is what got two independent approvals on a
  // median Tmax that was wrong by a factor of two.
  //
  // It is not a rule in `kinetix-consensus` (the tally policy) because it is a
  // fact about the payload, settled before any verdict exists and not
  // suppliable by approving harder. It IS a rule in `kinetix-consensus-apply`,
  // which models the whole gate — see that policy's `unquoted` rule.
  //
  // A human reviewer is deliberately still free to approve without one: the
  // guard withholds automation, not publication.
  //
  // What the proposal ends up attested by is not always what its payload
  // carries — for an entry update the write decides — so the question is put
  // once, to whichever source can answer it. See
  // `highRiskProposalWouldPublishUnquoted`.
  if (
    pending &&
    (await highRiskProposalWouldPublishUnquoted(pending, (err) => {
      console.error(
        `[agent-consensus] could not resolve the effective source quote for ` +
          `pending edit ${args.pendingEditId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }))
  ) {
    warnMissingSourceQuoteHold(args.pendingEditId, pending.parameter);
    return { outcome: 'held', reason: 'source_quote_missing' };
  }

  // Authoritative generic cutover (§ Phase 8 of the knowledge-governance
  // extraction). For an edit type that has been deliberately advanced to
  // `generic_authoritative`, the generic engine owns this decision and the rest
  // of this function does not run. Everything else — every other edit type,
  // every unadvanced one, and the kill switch — falls through unchanged, and
  // `resolveApplyAuthority` costs no query for a type that is not eligible in
  // this build.
  //
  // `fell_back` is the only outcome that continues into the legacy gate below,
  // and every condition that produces it is checked before anything is written.
  // A `held` result is a decision, not an abstention: re-running the legacy
  // gate after the generic engine refused could publish what it just refused,
  // which §1.7 forbids in that direction specifically.
  //
  // The try/catch falls back to legacy, and that is safe for the same reason:
  // the only code that can throw out of `publishOnAgentConsensus` runs before
  // any mutation. Once its transaction is open the service handles its own
  // faults and reports `failed` rather than throwing, so a fault there can
  // never be replayed through this path.
  try {
    const generic = await publishOnAgentConsensus({
      pendingEditId: args.pendingEditId,
      approverUserId: args.approverUserId,
    });
    if (generic.outcome !== 'fell_back') {
      // `already_applied` returns false deliberately: this verdict did not
      // cause the publication, and the caller reports `autoApplied` for the
      // request it is answering.
      if (generic.outcome === 'applied') return { outcome: 'applied' };
      if (generic.outcome === 'already_applied') {
        return { outcome: 'already_applied' };
      }
      // `failed` means the generic engine tried the write and refused it (it
      // does not fall back to legacy); `held` is its policy saying not yet.
      const genericDetail =
        'reason' in generic && typeof generic.reason === 'string'
          ? generic.reason
          : generic.outcome;
      if (generic.outcome === 'failed') {
        if (decidedVersion) {
          await persistConsensusApplyFailure(
            args.pendingEditId,
            decidedVersion,
            genericDetail,
          );
        }
        return { outcome: 'held', reason: 'apply_failed', detail: genericDetail };
      }
      // `holdReason` names the specific unmet requirement (a missing flagship
      // approval, an open dispute, …); `quorum_unmet` is only the fallback for
      // a requirement the legacy vocabulary has no finer word for (issue
      // #1375 — this used to collapse every generic hold to `quorum_unmet`
      // unconditionally, so `/api/agent-consensus-sweep` could not tell a
      // stuck degraded-quorum hold from one waiting on ordinary review).
      return {
        outcome: 'held',
        reason: generic.holdReason ?? 'quorum_unmet',
        detail: generic.unmet.length > 0 ? generic.unmet.join(', ') : generic.reason,
      };
    }
  } catch (err) {
    console.error(
      `[knowledge-governance] generic publication path errored for pending ` +
        `edit ${args.pendingEditId}; using the legacy gate: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!pending) return { outcome: 'held', reason: 'not_found' };
  const hold = await legacyConsensusHold(args.pendingEditId, pending, {
    authorSelfReviews: args.authorSelfReviews,
    log: true,
  });
  if (hold) return { outcome: 'held', reason: hold.reason };

  try {
    await applyApprovedEdit(
      args.pendingEditId,
      args.approverUserId,
      decidedVersion ?? undefined,
      {
        // The gate above read the tally without locks. Re-check it inside the
        // approval transaction, after the pending-edit row lock (the same
        // source-row-then-agent order a verdict write takes), holding every
        // agent and backing user row FOR SHARE. A tier change, suspension or
        // role demotion updates one of those rows, so it either commits first
        // (and this re-check sees it) or waits until this approval commits.
        revalidate: async () => {
          await lockConsensusEligibility();
          await lockPendingEditTargetPage(pending);
          const recheck = await legacyConsensusHold(args.pendingEditId, pending, {
            authorSelfReviews: args.authorSelfReviews,
            log: false,
          });
          if (recheck) throw new ConsensusRevalidationError(recheck.reason);
          // The tally can pass on other approvals after the actor this apply
          // is attributed to lost its standing; never audit a publication as
          // that identity's approval.
          if (!(await approverCountsForConsensus(args.pendingEditId, args.approverUserId))) {
            throw new ConsensusRevalidationError('approver_ineligible');
          }
        },
      },
    );
    return { outcome: 'applied' };
  } catch (err) {
    if (err instanceof ConsensusRevalidationError) {
      return { outcome: 'held', reason: err.reason };
    }
    const detail = err instanceof Error ? err.message : String(err);
    if (
      err instanceof PendingEditReviewTokenMismatchError ||
      err instanceof ParameterApplyError ||
      err instanceof WikiFactApprovalError
    ) {
      // Expected refusals, but never silent: an edit that met consensus and
      // still sits in the queue needs its reason on record (issue #1357).
      console.warn(
        `[agent-consensus] pending edit ${args.pendingEditId} met consensus ` +
          `but the apply refused (${err.name}): ${detail}`,
      );
      if (decidedVersion) {
        await persistConsensusApplyFailure(
          args.pendingEditId,
          decidedVersion,
          detail,
        );
      }
      return { outcome: 'held', reason: 'apply_failed', detail };
    }
    // applyApprovedEdit throws a plain Error for the conflict-meta guard, and
    // any unexpected fault must still not break the recorded verdict.
    console.error(
      `agent-consensus auto-apply failed for pending edit ${args.pendingEditId}`,
      err,
    );
    if (decidedVersion) {
      await persistConsensusApplyFailure(
        args.pendingEditId,
        decidedVersion,
        detail,
      );
    }
    return { outcome: 'held', reason: 'apply_failed', detail };
  }
}

/**
 * Re-run agent consensus for one pending edit outside a verdict POST.
 *
 * Consensus used to be evaluated only at the instant an `approve` landed, so
 * an edit held at that moment stayed held forever even after the hold went
 * away: a dispute overruled by a moderator, an agent's tier corrected by an
 * admin, a transient apply refusal (issue #1357). This is the second attempt.
 * The approval is attributed to the most recent explicit approver, the agent
 * whose verdict would have tipped it over had the hold not been there.
 */
export async function retryAgentConsensus(
  pendingEditId: number,
): Promise<AgentConsensusOutcome> {
  const db = getDb();
  const [latest] = await db
    .select({ userId: agents.userId })
    .from(agentVerifications)
    .innerJoin(agents, eq(agents.id, agentVerifications.agentId))
    .innerJoin(users, eq(users.id, agents.userId))
    .innerJoin(pendingEdits, eq(pendingEdits.id, agentVerifications.targetId))
    .where(
      and(
        eq(agentVerifications.targetType, 'pending_edit'),
        eq(agentVerifications.targetId, pendingEditId),
        eq(agentVerifications.verdict, 'approve'),
        eq(agentVerifications.isImplicit, false),
        // Attributed only to an approval the gate actually counts: an agent
        // that still has standing, and never the author unless it currently
        // holds the self-review grant (the same rule `legacyConsensusHold`
        // applies to the tally). Otherwise `reviewedBy` could record a
        // self-approval the author is no longer permitted to make.
        eq(agents.status, 'active'),
        inArray(users.role, ACTIVE_AGENT_ROLES),
        or(
          ne(agents.userId, pendingEdits.submittedBy),
          eq(agents.selfReviewEnabled, true),
        ),
      ),
    )
    .orderBy(desc(agentVerifications.updatedAt))
    .limit(1);
  if (!latest) return { outcome: 'held', reason: 'quorum_unmet' };
  const result = await runAgentConsensus({
    pendingEditId,
    approverUserId: latest.userId,
  });
  if (result.outcome === 'applied') {
    fireAndForgetMirror(
      mirrorPublicationOutcome({
        targetType: 'pending_edit',
        targetId: pendingEditId,
        action: 'applied',
        actorRef: 'system:agent-consensus',
      }),
    );
  }
  return result;
}

/** Most edits one sweep call retries; each can cost a full apply. */
export const CONSENSUS_SWEEP_LIMIT = 25;

/**
 * The retry sweep: every pending edit with enough explicit approvals to
 * plausibly clear the active pool's quorum and no dispute verdict, oldest
 * first, re-run through consensus. Cheap to call often — an edit still short
 * of quorum is a read and a no-op.
 */
export async function sweepAgentConsensus(
  limit = CONSENSUS_SWEEP_LIMIT,
): Promise<Array<{ pendingEditId: number } & AgentConsensusOutcome>> {
  const db = getDb();
  const verdictOn = (verdict: 'approve' | 'dispute') =>
    db
      .select({ one: sql`1` })
      .from(agentVerifications)
      .where(
        and(
          eq(agentVerifications.targetType, 'pending_edit'),
          eq(agentVerifications.targetId, pendingEdits.id),
          eq(agentVerifications.verdict, verdict),
          eq(agentVerifications.isImplicit, false),
        ),
      );
  // The floor of `effectiveConsensusQuorum` across this sweep's candidates: the
  // lowest bar any of them could be held to (a self-review author only ever
  // raises its own quorum, never lowers it, so this is a safe under-estimate
  // for every row). A candidate with fewer explicit approvals than this can
  // never clear consensus without a new verdict landing — and a new verdict
  // retries consensus directly (the primary trigger), so the periodic sweep
  // has nothing to gain by holding a slot for it.
  const quorumFloor = effectiveConsensusQuorum(await countActiveVerifierAgents(), {
    authorSelfReviews: false,
  });
  // Edits that consensus can never publish are filtered out here, before the
  // LIMIT, not left to `legacyConsensusHold`: otherwise 25 old human-submitted
  // or clinical rows would fill every sweep and starve the agent-authored edits
  // behind them whose hold actually cleared. The same reasoning covers a
  // permanently sub-quorum tally (issue #1367): without it, 25+ edits stuck at
  // one approval in a two-approval pool would occupy the oldest-first window on
  // every cycle and starve out newer edits whose tally already clears the bar.
  //
  // Only approvals the real gate would count are tallied (issue 1398): an
  // agent that still has standing, and never the author unless it currently
  // holds the self-review grant. Otherwise a revoked self-approval plus one
  // peer approval reaches the raw floor of two while `legacyConsensusHold`
  // sees one, and 25 such rows refill the window with `quorum_unmet`.
  const approvalsAtLeastQuorumFloor = db
    .select({ one: sql`1` })
    .from(agentVerifications)
    .innerJoin(agents, eq(agents.id, agentVerifications.agentId))
    .innerJoin(users, eq(users.id, agents.userId))
    .where(
      and(
        eq(agentVerifications.targetType, 'pending_edit'),
        eq(agentVerifications.targetId, pendingEdits.id),
        eq(agentVerifications.verdict, 'approve'),
        eq(agentVerifications.isImplicit, false),
        eq(agents.status, 'active'),
        inArray(users.role, ACTIVE_AGENT_ROLES),
        or(
          ne(agents.userId, pendingEdits.submittedBy),
          eq(agents.selfReviewEnabled, true),
        ),
      ),
    )
    .groupBy(sql`1`)
    .having(sql`count(*) >= ${quorumFloor}`);
  const authorIsActiveAgent = db
    .select({ one: sql`1` })
    .from(agents)
    .innerJoin(users, eq(users.id, agents.userId))
    .where(
      and(
        eq(agents.userId, pendingEdits.submittedBy),
        eq(agents.status, 'active'),
        inArray(users.role, ACTIVE_AGENT_ROLES),
      ),
    );
  const openHumanDispute = db
    .select({ one: sql`1` })
    .from(disputes)
    .where(
      and(
        eq(disputes.targetType, 'pending_edit'),
        eq(disputes.targetId, pendingEdits.id),
        eq(disputes.status, 'open'),
      ),
    );
  const candidates = await db
    .select({ id: pendingEdits.id })
    .from(pendingEdits)
    .where(
      and(
        eq(pendingEdits.status, 'pending'),
        ne(pendingEdits.editType, 'clinical_case'),
        exists(authorIsActiveAgent),
        exists(approvalsAtLeastQuorumFloor),
        not(exists(verdictOn('dispute'))),
        not(exists(openHumanDispute)),
        // Same content gate as the verifier queue: a wiki edit only while its
        // page is published, so draft-backed rows neither publish nor fill
        // the window.
        pendingEditWikiVisibility(),
      ),
    )
    .orderBy(asc(pendingEdits.submittedAt))
    .limit(limit);
  const results: Array<{ pendingEditId: number } & AgentConsensusOutcome> = [];
  for (const { id } of candidates) {
    try {
      results.push({ pendingEditId: id, ...(await retryAgentConsensus(id)) });
    } catch (err) {
      // One bad row must not stop the sweep.
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[agent-consensus] sweep retry failed for ${id}: ${detail}`);
      results.push({
        pendingEditId: id,
        outcome: 'held',
        reason: 'apply_failed',
        detail,
      });
    }
  }
  return results;
}

