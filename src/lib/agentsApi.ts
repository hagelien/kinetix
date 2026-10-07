/**
 * Client for the #319 admin agent endpoints.
 */

import type { AgentStatus } from './agentStatus';
import type { AssignableModelTier } from './modelTiers';

// ─── Admin CRUD helpers (#319) ─────────────────────────────────────────────
// Backed by /api/admin?resource=agents. Admin-only — calls 403 for other
// roles. Used by AgentsAdminSection on /admin.

/** Embedded status-history entry returned on the admin agents listing. */
export interface AgentStatusHistoryEntry {
  id: number;
  fromStatus: AgentStatus | null;
  toStatus: AgentStatus;
  changedBy: number | null;
  changedAt: string;
  reason: string | null;
}

/** Admin-view row: includes non-active agents and linked user metadata. */
export interface AgentAdminRow {
  id: number;
  userId: number;
  name: string;
  nameEn: string | null;
  slug: string;
  description: string | null;
  descriptionEn: string | null;
  maintainerUserId: number | null;
  status: AgentStatus;
  statusChangedBy: number | null;
  statusChangedAt: string | null;
  statusChangeReason: string | null;
  /** Role stashed while suspended; restored on reactivation. */
  preSuspensionRole: string | null;
  hooksEnabled: boolean;
  /** Admin opt-in: this agent may review its own work in the review queue. */
  selfReviewEnabled: boolean;
  /**
   * Server-owned capability tier: 'flagship' | 'mid' | 'light' | null. Only a
   * flagship verifier can clear the high-risk consensus gate; null = unclassified.
   * Typed loosely because the value comes from the database, which may hold a
   * tier this build's registry no longer knows about.
   */
  modelTier: string | null;
  /** Admin grant: may sit on a T3 adjudication panel (flagship tier required too). */
  adjudicator: boolean;
  /** Model family for the T3 panel-diversity audit; null = unknown. */
  modelFamily: string | null;
  createdAt: string;
  username: string | null;
  email: string | null;
  userRole: string | null;
  history: AgentStatusHistoryEntry[];
}

/** Token metadata (never the secret) returned by the admin token APIs. */
export interface AgentTokenMeta {
  id: number;
  agentId: number;
  prefix: string;
  label: string | null;
  createdBy: number | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreateAgentInput {
  email: string;
  username: string;
  name: string;
  nameEn?: string;
  slug?: string;
  description?: string;
  descriptionEn?: string;
  maintainerUserId?: number;
  role?: 'contributor' | 'editor';
  /**
   * Capability tier for the consensus gate. Omit to create the agent
   * unclassified — which never satisfies the flagship requirement.
   */
  modelTier?: AssignableModelTier;
}

export interface PatchAgentInput {
  name?: string;
  nameEn?: string | null;
  slug?: string;
  description?: string | null;
  descriptionEn?: string | null;
  maintainerUserId?: number | null;
  hooksEnabled?: boolean;
  selfReviewEnabled?: boolean;
  /** Capability tier; `null` clears it back to unclassified. */
  modelTier?: AssignableModelTier | null;
  adjudicator?: boolean;
  /** `null` clears it back to unknown. */
  modelFamily?: string | null;
}

export interface TransitionAgentInput {
  status: AgentStatus;
  reason?: string;
}

async function adminApi<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      (data?.error as string) ?? `Request failed (${res.status})`,
    );
  }
  return data as T;
}

export async function fetchAdminAgents(): Promise<{ agents: AgentAdminRow[] }> {
  return adminApi('/api/admin?resource=agents');
}

export async function createAgent(
  input: CreateAgentInput,
): Promise<{ agent: AgentAdminRow; user: { id: number } }> {
  return adminApi('/api/admin?resource=agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function patchAgent(
  id: number,
  input: PatchAgentInput,
): Promise<{ agent: AgentAdminRow }> {
  return adminApi(`/api/admin?resource=agents&id=${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/**
 * Audited lifecycle transition (active ↔ suspended → deactivated).
 * Returns the updated agent row plus the freshly inserted history
 * entry so the caller can prepend it to the local timeline without
 * refetching.
 */
export async function transitionAgent(
  id: number,
  input: TransitionAgentInput,
): Promise<{ agent: AgentAdminRow; history: AgentStatusHistoryEntry }> {
  return adminApi(`/api/admin?resource=agents&id=${id}&action=transition`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function deactivateAgent(id: number): Promise<void> {
  await adminApi(`/api/admin?resource=agents&id=${id}`, { method: 'DELETE' });
}

// ─── Tokens & permissions (admin) ──────────────────────────────────────────

export async function listAgentTokens(
  agentId: number,
): Promise<{ tokens: AgentTokenMeta[] }> {
  return adminApi(`/api/admin?resource=agents&sub=tokens&id=${agentId}`);
}

/**
 * Issue a new token. The plaintext `token` is returned exactly once —
 * the caller must surface it immediately; it can never be retrieved
 * again.
 */
export async function issueAgentToken(
  agentId: number,
  input: { label?: string; expiresInDays: number },
): Promise<{ token: string; tokenMeta: AgentTokenMeta }> {
  return adminApi(
    `/api/admin?resource=agents&id=${agentId}&action=issue-token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
}

export async function revokeAgentToken(
  agentId: number,
  tokenId: number,
): Promise<{ tokenMeta: AgentTokenMeta }> {
  return adminApi(
    `/api/admin?resource=agents&id=${agentId}&action=revoke-token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokenId }),
    },
  );
}

export async function setAgentRole(
  agentId: number,
  role: 'contributor' | 'editor',
): Promise<{ agent: AgentAdminRow; role: string }> {
  return adminApi(`/api/admin?resource=agents&id=${agentId}&action=set-role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
}

// ─── Hook runs (#345) ──────────────────────────────────────────────────────

export type HookRunOutcome = 'success' | 'failed' | 'skipped';

export interface AgentHookRun {
  id: number;
  event: string;
  targetType: string | null;
  targetId: number | null;
  outcome: HookRunOutcome;
  httpStatus: number | null;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface FetchHookRunsParams {
  outcome?: HookRunOutcome;
  event?: string;
  limit?: number;
}

export async function fetchAgentHookRuns(
  params: FetchHookRunsParams = {},
): Promise<{ runs: AgentHookRun[] }> {
  const search = new URLSearchParams({ resource: 'agent-hook-runs' });
  if (params.outcome) search.set('outcome', params.outcome);
  if (params.event) search.set('event', params.event);
  if (params.limit) search.set('limit', String(params.limit));
  return adminApi(`/api/admin?${search.toString()}`);
}
