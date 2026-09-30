/**
 * Client helpers for the polymorphic approvals API (#344). The
 * approval count is purely a display signal — never gate agentic
 * evaluation logic on it.
 */
import type { UserBadgeData } from '@/components/ui/UserBadge';

export type ApprovalTargetType =
  | 'wiki_revision'
  | 'drug_parameter_revision'
  | 'drug_discussion';

export type ApproverRef = { id: number } & UserBadgeData;

export interface ApprovalSummary {
  count: number;
  approvers: ApproverRef[];
  /** Present when the request carried auth context. */
  approvedByMe?: boolean;
}

export interface ApprovalRow {
  id: number;
  approvedBy: number;
  createdAt: string;
  approver: ApproverRef | null;
}

/**
 * Thrown by the approvals client on non-2xx responses. `code` is a
 * stable identifier the React boundary maps to a localized string;
 * `message` is the server's English prose that surfaces only as a
 * fallback when the client doesn't recognize the code. Mirrors the
 * pattern used by pendingEditsApi (AGENTS.md i18n rule).
 */
export class ApprovalsApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'ApprovalsApiError';
    this.status = status;
    this.code = code;
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok) {
    throw new ApprovalsApiError(
      (data?.error as string) ?? `Request failed (${res.status})`,
      res.status,
      typeof data?.code === 'string' ? (data.code as string) : null,
    );
  }
  return data as T;
}

export async function fetchApprovals(args: {
  targetType: ApprovalTargetType;
  targetId: number;
}): Promise<{ approvals: ApprovalRow[]; count: number; approvedByMe: boolean }> {
  const sp = new URLSearchParams({
    targetType: args.targetType,
    targetId: String(args.targetId),
  });
  return api(`/api/approvals?${sp}`);
}

/** Returns a summary keyed by stringified id (server response shape). */
export async function fetchApprovalSummaries(args: {
  targetType: ApprovalTargetType;
  targetIds: number[];
}): Promise<Record<string, ApprovalSummary>> {
  if (args.targetIds.length === 0) return {};
  const sp = new URLSearchParams({
    targetType: args.targetType,
    targetIds: args.targetIds.join(','),
  });
  const res = await api<{ summaries: Record<string, ApprovalSummary> }>(
    `/api/approvals?${sp}`,
  );
  return res.summaries;
}

export async function addApproval(args: {
  targetType: ApprovalTargetType;
  targetId: number;
}): Promise<{ approved: boolean; inserted: boolean }> {
  return api('/api/approvals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}

export async function withdrawApproval(args: {
  targetType: ApprovalTargetType;
  targetId: number;
}): Promise<{ withdrew: boolean }> {
  const sp = new URLSearchParams({
    targetType: args.targetType,
    targetId: String(args.targetId),
  });
  return api(`/api/approvals?${sp}`, { method: 'DELETE' });
}
