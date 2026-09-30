import type { DoseContextFields } from './entryDoseContext';
import type { ReferenceRow } from './referenceApi';
import type { RejectionReason } from './rejectionReasons';
import type { UserBadgeData } from '@/components/ui/UserBadge';
import type { AgentConsensusStatus } from './agentVerificationsApi';

export interface PendingEditRow {
  id: number;
  editType:
    | 'parameter'
    | 'param_entry'
    | 'metabolism'
    | 'receptor_targets'
    | 'enzyme_interaction'
    | 'wiki_page'
    | 'wiki_new'
    | 'wiki_fact'
    | 'wiki_section'
    | 'paper_review'
    | 'learning_unit'
    | 'clinical_case'
    | 'bio_entity';
  targetId: number | null;
  parameter: string | null;
  proposedValue: unknown;
  proposedMeta: Record<string, unknown> | null;
  referenceId: number | null;
  referenceIds: number[] | null;
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'returned';
  rejectionReason: RejectionReason | null;
  rejectionComment: string | null;
  submittedBy: number;
  reviewedBy: number | null;
  submittedAt: string;
  reviewedAt: string | null;
  reviewToken: string;
  // wiki_fact columns (issue #284); null for other editTypes.
  sectionId?: string | null;
  fieldId?: string | null;
  factStatement?: string | null;
  factOperation?: 'add' | 'replace' | 'remove' | 'reorder' | null;
  factTargetAnchor?: { factId: string } | null;
  submitter?: { id: number } & UserBadgeData;
  reviewer?: { id: number } & UserBadgeData;
  reference?: ReferenceRow | null;
  references?: ReferenceRow[];
  /**
   * Parameter edits only: the reference ids on the parameter's current
   * (latest-applied) revision, and their hydrated rows. Lets the review diff
   * flag a references-only change and mark added/removed citations (#857).
   */
  currentReferenceIds?: number[];
  currentReferences?: ReferenceRow[];
  drugName?: string;
  drugSlug?: string;
  /**
   * Molecular weight of the target drug (parameter edits only), surfaced so
   * the review diff can offer molar↔mass conversion tooltips on
   * concentration-valued parameters. Undefined when the drug has no MW.
   */
  drugMolecularWeight?: number | null;
  pageTitle?: string;
  pageSlug?: string;
  /**
   * bio_entity edits only: the target entity's symbol (from the live row for
   * updates, or proposedMeta for creates) and its slug for a monograph link.
   */
  entitySymbol?: string;
  entitySlug?: string;
  currentValue?: unknown;
  currentContent?: unknown;
  currentContentHtml?: string | null;
  /** Plaintext snippet of the fact targeted by replace/remove ops, populated server-side. */
  currentFactText?: string | null;
  /**
   * param_entry update/delete edits only: the live entry contents (value,
   * matrix, scenario, citation, observation context, comments) the reviewer is
   * about to change or remove, so a delete/update card can show what it
   * affects rather than a bare internal entry id. Populated server-side.
   */
  /**
   * param_entry edits only: the names (site language) of the substances the
   * proposed or live entry's dose context points at — the administered drug
   * and the interacting drug — keyed by drug id. A metabolite's Cmax is dosed
   * as its parent, and the card names that parent instead of an opaque id.
   * Absent when the entry names no other substance, or it no longer exists.
   */
  doseContextDrugNames?: Record<number, string>;
  currentEntry?: {
    id: number;
    parameter: string;
    low: number | null;
    high: number | null;
    median: number | null;
    qualifier: string | null;
    // The declared value for a model-structure axis (CV-1b); null for numeric entries.
    categoricalValue: string | null;
    unit: string;
    // The administration route (a RouteId) for a per-route absorption/F entry (CV-2c-4); null for a
    // drug-level entry.
    route: string | null;
    // Null for matrix-/scenario-independent parameters (half-life, logP, …).
    matrix: string | null;
    scenario: string | null;
    n: number | null;
    comments: string | null;
    // Facts about the reading itself (dose, fed/fasted state, population,
    // assay method), split out of `comments` by migration 0120; part of what a
    // stored source quote is evidence for, unlike `comments`.
    observationContext: string | null;
    // The verbatim text the live entry's value was read off; null for every
    // entry written before migration 0119, which is most of them.
    sourceQuote: string | null;
    // Structured dose context (migration 0127); null for every entry of a
    // parameter that does not declare it.
    doseContext?: DoseContextFields | null;
    origin: string;
    citationId: number | null;
    citation: {
      id: number;
      type: string;
      identifier: string;
      metadata: unknown;
    } | null;
  };
  /**
   * paper_review edits only: true when the review attests `readInFull` but the
   * citation still has an open PDF request and no stored PDF — i.e. the full
   * text was declared unavailable and never supplied, so the attestation may
   * have been made from the abstract. A warning for the reviewer, not a block.
   */
  readInFullUnverified?: boolean;
  /**
   * Per-edit agent-verification summary populated by the list endpoint
   * (see `summariseVerificationsForTargets` in api/_lib/agent-verifications.ts).
   * Drives the /review badges so moderators can spot disputed and
   * multi-approved edits at a glance.
   */
  verifications?: PendingEditVerificationSummary;
  /**
   * True when an open row in the unified `disputes` table contests this edit
   * (a human's dispute, or an agent verdict mirrored into it). Populated by
   * the moderator list view only. Distinct from `verifications.disputeCount`,
   * which counts agent verdicts and keeps counting them after a moderator has
   * ruled on the objection they raised.
   */
  hasOpenDispute?: boolean;
  /**
   * True when a moderator upheld an objection to this edit's current payload.
   * The dispute is closed, but upholding it is not a green light: the author
   * may return, reject or revise the proposal — approving their own is refused
   * with `self_approval_blocked_by_upheld_dispute`. Cleared by revising the
   * payload, which is what the ruling asked for.
   */
  disputeUpheld?: boolean;
  /**
   * Why agent consensus has (not) published this edit (issue #1357), batched
   * for the whole list response by the server (#1374) instead of one request
   * per card. Only populated for a pending edit with at least one approval
   * and no unresolved dispute — the only case the review card explains.
   */
  consensusStatus?: AgentConsensusStatus;
}

export interface PendingEditVerificationSummary {
  approveCount: number;
  disputeCount: number;
  abstainCount: number;
  implicitApproveCount: number;
  /**
   * Dispute verdicts no moderator has ruled on. `disputeCount` is the raw
   * tally and never falls — a verdict is an agent's testimony, and resolving
   * the dispute it raised cannot close it — so an overruled edit would sit
   * under a red "Disputed" badge forever if the UI read that instead.
   * Undefined on responses from before this field existed.
   */
  unresolvedDisputeCount?: number;
}

/**
 * Thrown by `apiFetch` when the API returns a non-2xx response. The
 * `code` field, when present, is a stable identifier callers can map
 * to a localised string at the React boundary (per AGENTS.md i18n
 * rule). The `message` is the server's English prose used as the
 * fallback when the client doesn't recognise the code.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) {
    throw new ApiError(
      data.error ?? `Request failed (${res.status})`,
      res.status,
      typeof data.code === 'string' ? data.code : null,
    );
  }
  return data as T;
}

export async function fetchPendingEdits(params?: {
  status?: string;
  editType?: string;
  submittedBy?: number;
  targetId?: number;
  id?: number;
}): Promise<{ pendingEdits: PendingEditRow[] }> {
  const sp = new URLSearchParams();
  if (params?.status) sp.set('status', params.status);
  if (params?.editType) sp.set('editType', params.editType);
  if (params?.submittedBy) sp.set('submittedBy', String(params.submittedBy));
  if (params?.targetId) sp.set('targetId', String(params.targetId));
  if (params?.id) sp.set('id', String(params.id));
  return apiFetch(`/api/pending-edits?${sp}`);
}

export async function fetchPendingEditCount(): Promise<{ count: number }> {
  return apiFetch('/api/pending-edits?status=pending&countOnly=true');
}

export async function createPendingEdit(data: {
  editType: string;
  targetId?: number | null;
  parameter?: string;
  proposedValue: unknown;
  proposedMeta?: Record<string, unknown>;
  referenceId?: number;
  referenceIds?: number[];
  status?: string;
  // wiki_fact / wiki_section anchor + payload fields. All optional so
  // the legacy editTypes (parameter, wiki_page, wiki_new) keep working.
  sectionId?: string;
  fieldId?: string;
  factStatement?: string;
  factOperation?: 'add' | 'replace' | 'remove' | 'reorder';
  factTargetAnchor?: { factId: string };
}): Promise<{ pendingEdit: PendingEditRow }> {
  return apiFetch('/api/pending-edits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function reviewPendingEdit(
  id: number,
  action: {
    status: 'approved' | 'rejected' | 'returned';
    rejectionReason?: RejectionReason;
    rejectionComment?: string;
    returnComment?: string;
    proposedValue?: unknown;
    proposedMeta?: Record<string, unknown>;
    referenceId?: number | null;
    referenceIds?: number[] | null;
    reviewToken?: string;
  },
): Promise<{ pendingEdit: PendingEditRow }> {
  return apiFetch(`/api/pending-edits?id=${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
  });
}

export async function updatePendingEdit(
  id: number,
  data: {
    status?: 'draft' | 'pending';
    proposedValue?: unknown;
    proposedMeta?: Record<string, unknown>;
    referenceId?: number | null;
    referenceIds?: number[] | null;
    /**
     * The `direct_admin_write` conflict marker's id, as shown to the actor
     * before they revised (#1258). Required for a revision to discharge that
     * marker — see `conflictMarkerAcknowledged` in api/pending-edits.ts.
     */
    acknowledgedConflictId?: string;
  },
): Promise<{ pendingEdit: PendingEditRow }> {
  return apiFetch(`/api/pending-edits?id=${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function cancelPendingEdit(id: number): Promise<void> {
  await apiFetch(`/api/pending-edits?id=${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'rejected', rejectionReason: 'other' }),
  });
}
