/**
 * The control phase after a blind dispute (issue #1357).
 *
 *   GET  ?limit=  — the caller's disputes that stand against a peer approval,
 *                   with the target payload. A pure read: no peer verdicts.
 *   POST { step: 'disclose', target… }
 *                 — show the other reviewers' verdicts on one of them. This
 *                   records the disclosure and freezes the caller's verdict.
 *   POST { outcome, addendumMd, peerDigest, target… }
 *                 — maintain (with an addendum) or withdraw it
 *
 * This is the only endpoint that shows an agent its peers' rationales on a
 * target it judged, and it does so only after that agent's own blind dispute
 * is on record. See api/_lib/verdict-reconsideration.ts for the rules.
 */
import { json, error, noStoreHeaders, withErrorHandling } from '../_lib/response.js';
import { getUserFromRequest } from '../_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from '../_lib/validate.js';
import { reconsiderRequestSchema } from '../_lib/schemas.js';
import {
  resolveActiveAgent,
  visibleVerificationTargetIds,
} from '../_lib/agent-verifications.js';
import {
  discloseForReconsideration,
  listReconsiderationCandidates,
  reconsiderDispute,
  ReconsiderationRefusedError,
  RECONSIDERATION_LIST_LIMIT,
} from '../_lib/verdict-reconsideration.js';
import { fetchSingleCandidate } from '../agent-verifications-queue.js';
import { retryAgentConsensus } from '../agent-verifications.js';
import { mirrorAssessment } from '../_lib/knowledge-governance/mirror.js';
import type { AgentVerificationTargetType } from '../../db/schema.js';

const REFUSALS = {
  stale: [409, 'Target changed since it was listed', 'reconsideration_target_version_stale'],
  not_disputed: [
    409,
    'You have no open dispute on this version of the target (it was ruled on, withdrawn, or revised)',
    'reconsideration_not_open',
  ],
  no_conflict: [
    409,
    'No other agent has approved this target; there is nothing to reconsider against',
    'reconsideration_no_conflict',
  ],
  peers_changed: [
    409,
    'The peer verdicts changed since you listed them; list again and reconsider against what is there now',
    'reconsideration_peers_changed',
  ],
  not_listed: [
    409,
    'Disclose the item first (POST with step "disclose"); the decision must follow the peer verdicts you were shown',
    'reconsideration_not_listed',
  ],
  already_reconsidered: [
    409,
    'You have already reconsidered this version of the target',
    'reconsideration_already_recorded',
  ],
} as const;

// Every answer here is private to the calling agent (its disputes, the target
// payloads it may read, its peers' verdicts): never cacheable by a proxy.
const PRIVATE_HEADERS = noStoreHeaders();

export default withErrorHandling(async function handler(req, res): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'POST') {
    error(res, 405, 'Method not allowed');
    return;
  }
  if (req.method === 'POST') assertSameOrigin(req);
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  const agent = await resolveActiveAgent(auth.userId);
  if (!agent) {
    error(res, 403, 'Active agent required', 'agent_verification_agent_required');
    return;
  }

  if (req.method === 'GET') {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const limitRaw = Number(url.searchParams.get('limit') ?? RECONSIDERATION_LIST_LIMIT);
    const limit = Math.max(
      1,
      Number.isInteger(limitRaw) ? limitRaw : RECONSIDERATION_LIST_LIMIT,
    );
    const items: Array<{
      targetType: AgentVerificationTargetType;
      targetId: number;
      targetVersion: string;
      payload: unknown;
    }> = [];
    await listReconsiderationCandidates({
      agentId: agent.id,
      agentUserId: auth.userId,
      limit,
      // Same payload, under the same visibility rules, the agent judged the
      // first time; a target it can no longer read is not served, and does
      // not use up a slot of `limit`.
      accept: async (c) => {
        const target = await fetchSingleCandidate({
          type: c.targetType,
          targetId: c.targetId,
          agentId: agent.id,
          agentUserId: auth.userId,
          selfReviewEnabled: agent.selfReviewEnabled,
          includeJudged: true,
        });
        if (!target || target.targetVersion !== c.targetVersion) return false;
        items.push({ ...c, payload: target.payload });
        return true;
      },
    });
    json(
      res,
      200,
      { agent: { id: agent.id, slug: agent.slug }, items },
      { headers: PRIVATE_HEADERS },
    );
    return;
  }

  const parsed = await parseAndValidate(req, reconsiderRequestSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }
  const targetType = parsed.data.targetType as AgentVerificationTargetType;
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

  // Step 1: show the peers. A POST, not part of the GET, because it is a
  // write with a lasting effect — it records the disclosure and freezes the
  // caller's verdict on this version — so it must carry the same-origin
  // guard every other mutation does. A cross-site navigation can issue a GET
  // with the session cookie; it cannot issue this.
  if ('step' in parsed.data) {
    try {
      const disclosed = await discloseForReconsideration({
        agentId: agent.id,
        agentUserId: auth.userId,
        targetType,
        targetId: parsed.data.targetId,
        targetVersion: parsed.data.targetVersion,
      });
      json(res, 200, disclosed, { headers: PRIVATE_HEADERS });
    } catch (err) {
      if (err instanceof ReconsiderationRefusedError) {
        const [status, message, code] = REFUSALS[err.reason];
        error(res, status, message, code);
        return;
      }
      throw err;
    }
    return;
  }

  // Step 2: decide.
  let result: Awaited<ReturnType<typeof reconsiderDispute>>;
  try {
    result = await reconsiderDispute({
      agentId: agent.id,
      agentUserId: auth.userId,
      targetType,
      targetId: parsed.data.targetId,
      targetVersion: parsed.data.targetVersion,
      outcome: parsed.data.outcome,
      addendumMd: parsed.data.addendumMd,
      peerDigest: parsed.data.peerDigest,
      model: parsed.data.model,
    });
  } catch (err) {
    if (err instanceof ReconsiderationRefusedError) {
      const [status, message, code] = REFUSALS[err.reason];
      error(res, status, message, code);
      return;
    }
    throw err;
  }

  // The rewrite above changed the live verdict row; mirror it the way every
  // other verdict write does, so a target type already reading the generic
  // store does not keep serving the pre-reconsideration dispute. Awaited, not
  // fire-and-forget: the consensus retry below can close the pending edit,
  // and a mirror that reached the source row after that would find nothing to
  // bind the abstention to. The mirror never rejects.
  await mirrorAssessment({
    targetType,
    targetId: parsed.data.targetId,
    legacyVerificationId: result.verificationId,
    actorRef: `user:${auth.userId}`,
    verdict: result.outcome === 'withdrawn' ? 'abstain' : 'dispute',
    rationaleMd: result.rationaleMd,
    model: result.model,
    isImplicit: false,
  });

  // A withdrawn dispute may have been the only thing holding a pending edit
  // that the independent approvals already carry. Retry now rather than wait
  // for the sweep; a hold that remains is reported, never an error.
  //
  // The reconsideration is already committed, so a failure here must not turn
  // into a 500: the caller would retry, get `reconsideration_already_recorded`,
  // and never learn that its withdrawal landed. The retry sweep picks the edit
  // up later; the response says consensus is still pending.
  let autoApplied = false;
  let consensusRetryFailed = false;
  if (result.outcome === 'withdrawn' && targetType === 'pending_edit') {
    try {
      const retried = await retryAgentConsensus(parsed.data.targetId);
      autoApplied = retried.outcome === 'applied';
    } catch (err) {
      consensusRetryFailed = true;
      console.error(
        `[reconsider] consensus retry failed after withdrawal on pending_edit ${parsed.data.targetId}; the sweep will retry`,
        err,
      );
    }
  }

  json(res, 200, {
    id: result.reconsiderationId,
    outcome: result.outcome,
    consensusRetryFailed,
    autoApplied,
  });
});
