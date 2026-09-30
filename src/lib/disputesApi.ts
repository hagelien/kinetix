/**
 * Client helpers for the unified disputes API (`api/disputes.ts`).
 *
 * An open dispute is not decoration: it blocks consensus auto-apply and it
 * blocks the author of a disputed edit from deciding on their own submission.
 * Until this module existed the endpoint had no browser caller at all, so a
 * moderator met the block with nothing on the page to act against — the whole
 * point of these two calls is that the objection can be read and ruled on
 * where it is blocking, on the /review card.
 */

import { ApiError } from './pendingEditsApi';

export type DisputeTargetType =
  | 'wiki_revision'
  | 'drug_parameter_revision'
  | 'drug_discussion'
  | 'paper_review'
  | 'pending_edit';

/** How an open dispute closes. Mirrors `resolveDisputeSchema` server-side. */
export type DisputeResolution = 'upheld' | 'rejected' | 'withdrawn';

export interface DisputeEvidenceRef {
  citationId?: number;
  quote?: string;
  url?: string;
}

export interface DisputeRow {
  id: number;
  targetType: DisputeTargetType;
  targetId: number;
  source: 'human' | 'agent';
  reasonMd: string;
  evidenceRefs: DisputeEvidenceRef[];
  status: string;
  createdAt: string;
  updatedAt: string;
  /** Set once the scheduled digest escalated it to the admins (#1233). */
  escalatedAt?: string | null;
  createdBy: number;
  author: {
    id: number;
    name: string | null;
    role: string | null;
    agentSlug: string | null;
  } | null;
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(
      (data?.error as string) ?? `Request failed (${res.status})`,
      res.status,
      typeof data?.code === 'string' ? (data.code as string) : null,
    );
  }
  return data as T;
}

/** Open disputes standing against one target, oldest first. */
export async function fetchDisputesForTarget(args: {
  targetType: DisputeTargetType;
  targetId: number;
}): Promise<{ disputes: DisputeRow[] }> {
  const sp = new URLSearchParams({
    targetType: args.targetType,
    targetId: String(args.targetId),
  });
  return apiFetch(`/api/disputes?${sp}`);
}

export interface ResolveDisputeResult {
  id: number;
  resolution: DisputeResolution;
  /**
   * Only present for `upheld` on a `pending_edit`: whether the server also
   * returned that proposal to its author, carrying the objection over as the
   * return note. `false` (with `pendingEditReturnSkipped` saying why — the
   * edit was already decided, or it is the moderator's own submission and they
   * lack `review.edit.decideOwn`) means the proposal is still sitting there
   * and needs a disposition by hand, which the card has to say out loud: a
   * moderator who believes the edit went back would otherwise never look at it
   * again.
   */
  pendingEditReturned?: boolean;
  pendingEditReturnSkipped?:
    | 'not_found'
    | 'not_open'
    | 'own_edit_not_allowed'
    | 'decide_not_allowed'
    | 'agent_moderation_not_allowed'
    | 'model_structure_not_allowed'
    | 'revised_since';
}

/** Close one open dispute. Requires `dispute.resolve` (editor+ by default). */
export async function resolveDispute(
  id: number,
  resolution: DisputeResolution,
): Promise<ResolveDisputeResult> {
  return apiFetch(`/api/disputes?id=${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolution }),
  });
}

/**
 * The global open-dispute queue (#1233), oldest-first — the same feed agents
 * poll, narrowed to nothing (no `targetType`/`targetId`). Requires
 * `dispute.queue.read` (editor+ by default) or an active-agent token, exactly
 * what `GET /api/disputes` itself gates on; a caller without it gets the same
 * 403 `disputesApi.fetchDisputesForTarget` documents above.
 */
export async function fetchOpenDisputes(
  args: { limit?: number; offset?: number } = {},
): Promise<{ disputes: DisputeRow[] }> {
  const sp = new URLSearchParams();
  if (args.limit !== undefined) sp.set('limit', String(args.limit));
  if (args.offset !== undefined) sp.set('offset', String(args.offset));
  const qs = sp.toString();
  return apiFetch(`/api/disputes${qs ? `?${qs}` : ''}`);
}

/**
 * Where to send a moderator to act on a dispute's target, reusing the one
 * branch of the server's `disputeTargetUrl` that needs no database lookup
 * (`api/_lib/agent-verifications.ts`). The other target types (wiki
 * revisions, parameter revisions, discussions, paper reviews) resolve their
 * URL from data this client doesn't have loaded (a slug, a drug id, …), and
 * `DisputePanel` never had to link to them either — it already renders
 * inline on the target's own card. So this stays a link for `pending_edit`
 * only; other rows show their target type/id as plain text instead of a
 * broken or wrong link.
 */
export function disputeTargetHref(
  row: Pick<DisputeRow, 'targetType' | 'targetId'>,
): string | null {
  return row.targetType === 'pending_edit' ? `/review?id=${row.targetId}` : null;
}
