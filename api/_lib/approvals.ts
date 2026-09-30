/**
 * Helpers for the polymorphic approval-stamp table (#344).
 *
 * Used by the pending-edit approval path to auto-stamp the reviewer
 * on the resulting revision row, and by the public /api/approvals
 * endpoint for voluntary additional stamps.
 *
 * Design note: the count returned here is purely a display signal.
 * Agentic evaluations of facts must NOT consume it. The wiki page
 * content payload — which agents fetch when forming their views —
 * never carries approval data; only the history / review surfaces
 * do.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { approvals, users, agents, type ApprovalTargetType } from '../../db/schema.js';

const approverSelect = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  role: users.role,
  isAgent: sql<boolean>`${agents.id} is not null`,
};

export interface ApproverRef {
  id: number;
  username: string;
  displayName: string | null;
  role: string;
  isAgent: boolean;
}

export interface ApprovalRow {
  id: number;
  approvedBy: number;
  createdAt: string;
  approver: ApproverRef | null;
}

export interface ApprovalSummary {
  count: number;
  approvers: ApproverRef[];
  /** Set when a request includes auth context and the caller has stamped this target. */
  approvedByMe?: boolean;
}

/**
 * Insert an approval row, ignoring the unique-violation that fires
 * when the same user has already stamped this target. Returns true if
 * a new row was inserted, false if it was a duplicate.
 */
export async function recordApproval(args: {
  targetType: ApprovalTargetType;
  targetId: number;
  approvedBy: number;
}): Promise<boolean> {
  const db = getDb();
  const result = await db
    .insert(approvals)
    .values({
      targetType: args.targetType,
      targetId: args.targetId,
      approvedBy: args.approvedBy,
    })
    .onConflictDoNothing({
      target: [approvals.targetType, approvals.targetId, approvals.approvedBy],
    })
    .returning({ id: approvals.id });
  return result.length > 0;
}

/** Remove the caller's approval on a target, if any. Returns true on delete. */
export async function withdrawApproval(args: {
  targetType: ApprovalTargetType;
  targetId: number;
  approvedBy: number;
}): Promise<boolean> {
  const db = getDb();
  const deleted = await db
    .delete(approvals)
    .where(
      and(
        eq(approvals.targetType, args.targetType),
        eq(approvals.targetId, args.targetId),
        eq(approvals.approvedBy, args.approvedBy),
      ),
    )
    .returning({ id: approvals.id });
  return deleted.length > 0;
}

/**
 * Fetch the approver list for a single target. Used by detail
 * endpoints that surface the full tooltip content (avatar list).
 */
export async function listApprovers(args: {
  targetType: ApprovalTargetType;
  targetId: number;
}): Promise<ApprovalRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: approvals.id,
      approvedBy: approvals.approvedBy,
      createdAt: approvals.createdAt,
      approver: approverSelect,
    })
    .from(approvals)
    .leftJoin(users, eq(users.id, approvals.approvedBy))
    .leftJoin(agents, eq(agents.userId, users.id))
    .where(
      and(
        eq(approvals.targetType, args.targetType),
        eq(approvals.targetId, args.targetId),
      ),
    )
    .orderBy(approvals.createdAt);
  return rows.map((r) => ({
    id: r.id,
    approvedBy: r.approvedBy,
    createdAt: r.createdAt.toISOString(),
    approver: r.approver?.id ? (r.approver as ApproverRef) : null,
  }));
}

/**
 * Batch lookup of approvals for many targets of the same type. Used
 * by list endpoints (wiki history, comment thread) so a single SELECT
 * supplies counts + approver previews for every row in the response.
 *
 * Returns a Map keyed by targetId → summary. Targets with no approvals
 * are absent from the map; callers should treat missing keys as count
 * 0.
 */
export async function summariseApprovalsForTargets(args: {
  targetType: ApprovalTargetType;
  targetIds: number[];
  callerUserId?: number;
}): Promise<Map<number, ApprovalSummary>> {
  const ids = args.targetIds.filter(Number.isInteger);
  if (ids.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({
      targetId: approvals.targetId,
      approvedBy: approvals.approvedBy,
      approver: approverSelect,
    })
    .from(approvals)
    .leftJoin(users, eq(users.id, approvals.approvedBy))
    .leftJoin(agents, eq(agents.userId, users.id))
    .where(
      and(
        eq(approvals.targetType, args.targetType),
        inArray(approvals.targetId, ids),
      ),
    )
    .orderBy(approvals.createdAt);

  const out = new Map<number, ApprovalSummary>();
  for (const row of rows) {
    let summary = out.get(row.targetId);
    if (!summary) {
      summary = { count: 0, approvers: [] };
      if (args.callerUserId !== undefined) summary.approvedByMe = false;
      out.set(row.targetId, summary);
    }
    summary.count += 1;
    if (row.approver?.id) summary.approvers.push(row.approver as ApproverRef);
    if (
      args.callerUserId !== undefined &&
      row.approvedBy === args.callerUserId
    ) {
      summary.approvedByMe = true;
    }
  }
  return out;
}

