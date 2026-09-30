/**
 * Lifecycle states for the `agents` table (#319 P3).
 *
 * - active:      operational. Backing user role is `contributor` (or
 *                higher, e.g. `editor` if the admin elevated it). Row
 *                surfaces in the public /api/agents listing.
 * - suspended:   reversibly disabled. Backing user demoted to
 *                `authenticated`; hidden from the listing. An admin
 *                can transition back to `active`.
 * - deactivated: terminal soft-delete. Row retained so revisions /
 *                pending_edits keep their FK targets, but no further
 *                transitions are allowed and the backing user stays
 *                at `authenticated`.
 */

export const AGENT_STATUSES = ['active', 'suspended', 'deactivated'] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

export function isAgentStatus(value: unknown): value is AgentStatus {
  return (
    typeof value === 'string' && (AGENT_STATUSES as readonly string[]).includes(value)
  );
}

const TRANSITIONS: Record<AgentStatus, readonly AgentStatus[]> = {
  active: ['suspended', 'deactivated'],
  suspended: ['active', 'deactivated'],
  deactivated: [],
};

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  if (from === to) return false;
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: AgentStatus): readonly AgentStatus[] {
  return TRANSITIONS[from];
}
