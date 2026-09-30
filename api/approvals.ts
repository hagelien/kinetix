/**
 * Approval-stamp endpoints (#344).
 *
 *   GET    ?targetType=&targetId=         → full approver list
 *   GET    ?targetType=&targetIds=1,2,3   → batch summary keyed by id
 *   POST   { targetType, targetId }       → add my stamp (contributor+)
 *   DELETE ?targetType=&targetId=         → withdraw my stamp
 *
 * The base stamp on a freshly-approved revision is created
 * automatically by applyApprovedEdit; this endpoint is for voluntary
 * additional stamps from other reviewers.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq, inArray } from 'drizzle-orm';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import {
  approvalTargetTypeSchema,
  createApprovalSchema,
} from './_lib/schemas.js';
import {
  listApprovers,
  recordApproval,
  summariseApprovalsForTargets,
  withdrawApproval,
} from './_lib/approvals.js';
import {
  drugParameterDiscussions,
  drugParameterRevisions,
  wikiPages,
  wikiRevisions,
  paperReviews,
} from '../db/schema.js';
import { callerCan } from './_lib/permissions-store.js';
import { notifyContributionFeedback } from './_lib/notifications.js';
import { disputeTargetUrl } from './_lib/agent-verifications.js';
import { CAP } from '../src/lib/permissions.js';
import type { ApprovalTargetType } from '../db/schema.js';

export async function canAddApprovalStamp(role: string): Promise<boolean> {
  return callerCan(role, CAP['approval.stamp.add']);
}

export function isSelfApproval(args: {
  actorUserId: number;
  ownerUserId: number | null;
}): boolean {
  return args.ownerUserId === args.actorUserId;
}

export default withErrorHandling(async function handler(req, res): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  switch (req.method) {
    case 'GET':
      return handleGet(req, res, url);
    case 'POST':
      assertSameOrigin(req);
      return handlePost(req, res);
    case 'DELETE':
      assertSameOrigin(req);
      return handleDelete(req, res, url);
    default:
      error(res, 405, 'Method not allowed');
  }
});

/**
 * Filter a list of targetIds down to ones the caller is allowed to
 * see. For wiki_revision targets we re-apply the same visibility
 * rule /api/wiki/history enforces (published pages are public, the
 * rest require editor+). For other target types every authenticated
 * caller may already see the target row through its primary
 * endpoint, so no extra filtering is needed here.
 *
 * Returns the subset of `targetIds` the caller may read AND a Set of
 * the IDs that map to a real row at all — orphan ids are dropped so
 * the response can't be used to enumerate missing/deleted revisions.
 */
async function visibleTargetIds(args: {
  targetType: ApprovalTargetType;
  targetIds: number[];
  callerRole: string | null;
}): Promise<number[]> {
  if (args.targetIds.length === 0) return [];
  const db = getDb();

  if (args.targetType === 'wiki_revision') {
    // Resolve to wiki_pages so canReadWikiPageStatus can apply the
    // same rule the history endpoint uses.
    const rows = await db
      .select({
        id: wikiRevisions.id,
        status: wikiPages.status,
      })
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
    // Approved paper reviews are public (GET /api/paper-reviews has no
    // auth gate), so any existing row is visible to every caller.
    const rows = await db
      .select({ id: paperReviews.id })
      .from(paperReviews)
      .where(inArray(paperReviews.id, args.targetIds));
    return rows.map((r) => r.id);
  }
  // drug_discussion
  const rows = await db
    .select({ id: drugParameterDiscussions.id })
    .from(drugParameterDiscussions)
    .where(inArray(drugParameterDiscussions.id, args.targetIds));
  return rows.map((r) => r.id);
}

async function targetOwnerUserId(args: {
  targetType: ApprovalTargetType;
  targetId: number;
}): Promise<number | null> {
  const db = getDb();
  if (args.targetType === 'wiki_revision') {
    const [row] = await db
      .select({ createdBy: wikiRevisions.createdBy })
      .from(wikiRevisions)
      .where(eq(wikiRevisions.id, args.targetId))
      .limit(1);
    return row?.createdBy ?? null;
  }
  if (args.targetType === 'drug_parameter_revision') {
    const [row] = await db
      .select({ createdBy: drugParameterRevisions.createdBy })
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.id, args.targetId))
      .limit(1);
    return row?.createdBy ?? null;
  }
  if (args.targetType === 'paper_review') {
    const [row] = await db
      .select({ createdBy: paperReviews.createdBy })
      .from(paperReviews)
      .where(eq(paperReviews.id, args.targetId))
      .limit(1);
    return row?.createdBy ?? null;
  }
  const [row] = await db
    .select({ createdBy: drugParameterDiscussions.createdBy })
    .from(drugParameterDiscussions)
    .where(eq(drugParameterDiscussions.id, args.targetId))
    .limit(1);
  return row?.createdBy ?? null;
}

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
  const targetTypeParsed = approvalTargetTypeSchema.safeParse(targetTypeRaw);
  if (!targetTypeParsed.success) {
    error(res, 400, `Unknown targetType "${targetTypeRaw}"`);
    return;
  }
  const targetType = targetTypeParsed.data;

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
    const visibleIds = await visibleTargetIds({
      targetType,
      targetIds: ids,
      callerRole: auth?.role ?? null,
    });
    const visibleSet = new Set(visibleIds);
    const map = visibleIds.length > 0
      ? await summariseApprovalsForTargets({
          targetType,
          targetIds: visibleIds,
          callerUserId: auth?.userId,
        })
      : new Map();
    const summaries: Record<
      string,
      { count: number; approvers: unknown[]; approvedByMe?: boolean }
    > = {};
    for (const id of ids) {
      // Targets the caller can't see (or that don't exist) are
      // returned as count-0 rather than an explicit 404 — that way
      // the stamp UI degrades to "no approvals yet" without leaking
      // existence info about hidden / missing rows.
      if (!visibleSet.has(id)) {
        summaries[String(id)] = {
          count: 0,
          approvers: [],
          ...(auth ? { approvedByMe: false } : {}),
        };
        continue;
      }
      const summary = map.get(id);
      summaries[String(id)] = summary ?? {
        count: 0,
        approvers: [],
        ...(auth ? { approvedByMe: false } : {}),
      };
    }
    json(res, 200, { summaries });
    return;
  }

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
  const visible = await visibleTargetIds({
    targetType,
    targetIds: [targetId],
    callerRole: auth?.role ?? null,
  });
  if (visible.length === 0) {
    // Match the wiki-history 404 behavior — don't disclose which
    // unpublished or missing rows exist.
    error(res, 404, 'Target not found', 'approval_target_not_found');
    return;
  }
  const rows = await listApprovers({ targetType, targetId });
  json(res, 200, {
    approvals: rows,
    count: rows.length,
    approvedByMe: auth ? rows.some((r) => r.approvedBy === auth.userId) : false,
  });
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
  // Voluntary stamps are contributor+ and cannot be applied to the
  // caller's own content. The base stamp on a fresh revision still
  // comes from the reviewer who applied the pending edit.
  if (!(await canAddApprovalStamp(auth.role))) {
    error(
      res,
      403,
      'Contributor or higher role required to add approval stamps',
      'approval_reviewer_required',
    );
    return;
  }
  const parsed = await parseAndValidate(req, createApprovalSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }
  // approvals.target_id has no SQL FK (the target table varies by
  // targetType), so we have to validate existence + visibility here.
  // Without this, a typo'd or pre-seeded id would write an orphan
  // approval row that the count endpoints would later surface as a
  // ghost stamp once a row with that id eventually exists.
  const visible = await visibleTargetIds({
    targetType: parsed.data.targetType as ApprovalTargetType,
    targetIds: [parsed.data.targetId],
    callerRole: auth.role,
  });
  if (visible.length === 0) {
    error(res, 404, 'Target not found', 'approval_target_not_found');
    return;
  }
  const ownerUserId = await targetOwnerUserId({
    targetType: parsed.data.targetType as ApprovalTargetType,
    targetId: parsed.data.targetId,
  });
  if (isSelfApproval({ actorUserId: auth.userId, ownerUserId })) {
    error(
      res,
      403,
      'Users cannot add approval stamps to their own content',
      'approval_self_not_allowed',
    );
    return;
  }
  const inserted = await recordApproval({
    targetType: parsed.data.targetType as ApprovalTargetType,
    targetId: parsed.data.targetId,
    approvedBy: auth.userId,
  });
  if (inserted) {
    // A stamp on someone's revision, comment or review is feedback on it.
    // The stamp is already recorded, so a notice failure is only logged.
    try {
      await notifyContributionFeedback({
        recipientUserId: ownerUserId,
        actorUserId: auth.userId,
        type: 'contribution_endorsed',
        targetType: parsed.data.targetType,
        targetId: parsed.data.targetId,
        title: 'Your contribution received an approval stamp',
        url: await disputeTargetUrl({
          targetType: parsed.data.targetType as ApprovalTargetType,
          targetId: parsed.data.targetId,
        }),
      });
    } catch (err) {
      console.error('[approvals] contribution notification failed:', err);
    }
  }
  json(res, inserted ? 201 : 200, { approved: true, inserted });
}

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  const targetTypeRaw = url.searchParams.get('targetType');
  const targetIdRaw = url.searchParams.get('targetId');
  const targetTypeParsed = approvalTargetTypeSchema.safeParse(targetTypeRaw);
  if (!targetTypeRaw || !targetTypeParsed.success) {
    error(res, 400, 'targetType is required');
    return;
  }
  const targetId = Number(targetIdRaw);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    error(res, 400, 'targetId must be a positive integer');
    return;
  }
  const removed = await withdrawApproval({
    targetType: targetTypeParsed.data,
    targetId,
    approvedBy: auth.userId,
  });
  json(res, 200, { withdrew: removed });
}
