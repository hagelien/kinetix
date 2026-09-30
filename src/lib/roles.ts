/**
 * Canonical user-role taxonomy for #310. Shared between the API layer and
 * the frontend so role names and ordering stay in sync.
 *
 * Tier semantics:
 *   - authenticated: logged in via magic link; read-only beyond what
 *     anonymous can do; may comment but cannot submit pending edits.
 *   - contributor:  authenticated + may submit pending edits (formerly
 *     'viewer'). The maintenance agent runs at this tier.
 *   - editor:       contributor + may review (approve/reject) pending edits
 *     submitted by other users.
 *   - admin:        full access, including direct writes that bypass the
 *     pending-edit queue and user/allowlist management.
 *
 * Anonymous (no session) is intentionally not a value here — call sites
 * pass `null`/`undefined` when no user is present.
 */

export const ROLES = {
  authenticated: "authenticated",
  contributor: "contributor",
  editor: "editor",
  admin: "admin",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

const RANK: Record<string, number> = {
  authenticated: 0,
  contributor: 1,
  editor: 2,
  admin: 3,
};

export const ROLE_VALUES = [
  ROLES.authenticated,
  ROLES.contributor,
  ROLES.editor,
  ROLES.admin,
] as const satisfies readonly Role[];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && value in RANK;
}

/** True when `actual` is at least as privileged as `min`. */
export function roleAtLeast(
  actual: string | null | undefined,
  min: Role,
): boolean {
  if (!actual) return false;
  const a = RANK[actual];
  const m = RANK[min];
  if (a === undefined || m === undefined) return false;
  return a >= m;
}

/** True for roles that can review (approve/reject) pending edits. */
export function isReviewer(role: string | null | undefined): boolean {
  return roleAtLeast(role, ROLES.editor);
}

/** True for roles that can submit content (pending edits). */
export function canContribute(role: string | null | undefined): boolean {
  return roleAtLeast(role, ROLES.contributor);
}

/** Role assigned to brand-new accounts created via magic-link login. */
export const DEFAULT_NEW_USER_ROLE: Role = ROLES.authenticated;
