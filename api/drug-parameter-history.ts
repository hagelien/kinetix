/**
 * Drug parameter revision history.
 *   GET ?drugId=&parameter=
 */
import { desc, eq, and, sql } from 'drizzle-orm';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { drugParameterRevisions, users, agents } from '../db/schema.js';
import { isDrugParameterId } from './_lib/drugParameterIds.js';
import { getUserFromRequest } from './_lib/auth.js';
import { summariseApprovalsForTargets } from './_lib/approvals.js';
import {
  filterVerificationsForAudience,
  listVerificationsForTargets,
  resolveActiveAgent,
  summariseVerificationsForTargets,
  visibleVerificationTargetIds,
} from './_lib/agent-verifications.js';
import { listDisputesForTargets } from './_lib/disputes.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';

export default withErrorHandling(async function handler(req, res): Promise<void> {
  if (req.method !== 'GET') {
    error(res, 405, 'Method not allowed');
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const drugId = Number(url.searchParams.get('drugId'));
  const parameter = url.searchParams.get('parameter');

  if (!drugId || Number.isNaN(drugId)) {
    error(res, 400, 'Missing or invalid drugId');
    return;
  }
  if (!parameter || !isDrugParameterId(parameter)) {
    error(res, 400, 'Missing or invalid parameter');
    return;
  }

  const db = getDb();
  try {
    // Revisions data and auth are independent — run in parallel to save one
    // Neon HTTP round-trip on authenticated requests.
    const [rows, auth] = await Promise.all([
      db
        .select({
          id: drugParameterRevisions.id,
          oldValue: drugParameterRevisions.oldValue,
          newValue: drugParameterRevisions.newValue,
          editSummary: drugParameterRevisions.editSummary,
          referenceIds: drugParameterRevisions.referenceIds,
          sourceDiff: drugParameterRevisions.sourceDiff,
          pendingEditId: drugParameterRevisions.pendingEditId,
          createdAt: drugParameterRevisions.createdAt,
          author: {
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            // Email intentionally NOT exposed — this endpoint has no auth
            // gate, so revision authors' addresses would otherwise be
            // scrapeable from public drug pages. Role + isAgent are fine
            // (already public via /api/agents); UserBadge degrades to a
            // plain span when email is absent.
            role: users.role,
            isAgent: sql<boolean>`${agents.id} is not null`,
          },
        })
        .from(drugParameterRevisions)
        .leftJoin(users, eq(drugParameterRevisions.createdBy, users.id))
        .leftJoin(agents, eq(agents.userId, users.id))
        .where(
          and(
            eq(drugParameterRevisions.drugId, drugId),
            eq(drugParameterRevisions.parameter, parameter),
          ),
        )
        .orderBy(desc(drugParameterRevisions.createdAt))
        .limit(100),
      getUserFromRequest(req),
    ]);

    const revisionIds = rows.map((r) => r.id);
    // Batch-load approval summaries so each revision row carries its
    // own stamp count + approver preview without N+1 queries (#344, #361).
    // The endpoint is unauthenticated; if there's a session cookie we
    // use it to set `approvedByMe`, otherwise that field is omitted.
    //
    // Also batch-load the review "round" recorded directly against each
    // revision — post-publication agent verdicts and disputes — so the
    // dialog can show why a revision's contributing sources changed, not
    // just that they did (#1358).
    //
    // Unlike agent_verifications (already public for this target type),
    // GET /api/disputes gates a dispute's reasonMd + author identity to an
    // active agent, a reviewer, or the target's own author — this endpoint
    // has no auth gate at all, so disputes are only attached per-row when
    // the caller clears that same bar; every other caller sees none.
    const callerAgent = auth ? await resolveActiveAgent(auth.userId) : null;
    const mayReadDisputeQueue =
      Boolean(callerAgent) ||
      (auth ? await callerCan(auth.role, CAP['dispute.queue.read']) : false);
    // Some revisions are also the applied result of a reviewed `param_entry`
    // pending edit (`pendingEditId` set) — agents may have recorded
    // approve/dispute/abstain verdicts against that edit BEFORE it was
    // applied, distinct from the post-publication round above. Surface a
    // summary so the dialog can offer to load the full rationale, but only
    // for pending edits this caller may actually see — the same visibility
    // `pending_edit` verdicts have everywhere else (reviewers, the edit's
    // own agent verifiers; never an anonymous caller).
    const pendingEditIds = [
      ...new Set(
        rows
          .map((r) => r.pendingEditId)
          .filter((id): id is number => id != null),
      ),
    ];
    const visiblePendingEditIds =
      pendingEditIds.length > 0
        ? await visibleVerificationTargetIds({
            targetType: 'pending_edit',
            targetIds: pendingEditIds,
            callerUserId: auth?.userId ?? null,
            callerRole: auth?.role ?? null,
            callerAgentId: callerAgent?.id ?? null,
            callerSelfReviews: callerAgent?.selfReviewEnabled,
            // An agent that cast an explicit verdict on the pending edit
            // behind a revision keeps read access to it after the edit is
            // decided — the open-queue rule alone only covers a still-pending
            // target, so without this the agent that argued the debate could
            // not revisit its own rationale once the edit resolved (review
            // finding on #1361).
            includeCallerVerdicts: true,
          })
        : [];
    const [approvalsMap, reviewVerdictsMap, disputesMap, pendingEditVerdictsMap] =
      await Promise.all([
        summariseApprovalsForTargets({
          targetType: 'drug_parameter_revision',
          targetIds: revisionIds,
          callerUserId: auth?.userId,
        }),
        listVerificationsForTargets({
          targetType: 'drug_parameter_revision',
          targetIds: revisionIds,
        }),
        listDisputesForTargets({
          targetType: 'drug_parameter_revision',
          targetIds: revisionIds,
        }),
        visiblePendingEditIds.length > 0
          ? summariseVerificationsForTargets({
              targetType: 'pending_edit',
              targetIds: visiblePendingEditIds,
            })
          : Promise.resolve(new Map()),
      ]);
    const enriched = rows.map((r) => ({
      ...r,
      approvals: approvalsMap.get(r.id) ?? {
        count: 0,
        approvers: [],
        ...(auth ? { approvedByMe: false } : {}),
      },
      verifications:
        r.pendingEditId != null
          ? (pendingEditVerdictsMap.get(r.pendingEditId) ?? undefined)
          : undefined,
      reviewVerdicts: filterVerificationsForAudience({
        rows: reviewVerdictsMap.get(r.id) ?? [],
        callerAgentId: callerAgent?.id ?? null,
      }),
      disputes:
        mayReadDisputeQueue || (auth != null && r.author?.id === auth.userId)
          ? (disputesMap.get(r.id) ?? [])
          : [],
    }));

    json(res, 200, { revisions: enriched });
  } catch {
    error(res, 500, 'Failed to fetch parameter history');
  }
});
