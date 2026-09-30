import {
  CAP,
  NO_OVERRIDES,
  can,
  type PermissionOverrides,
} from './permissions.js';
import { ROLES } from './roles.js';

export const RETTSTOKS_GROUP_SLUG = 'rettstoks';
export const KINETIX_LEARN_GROUP_SLUG = 'kinetix-learn';

export interface FeatureAccessGroup {
  slug: string;
}

export interface FeatureAccessUser {
  role?: string | null;
  groups?: readonly (FeatureAccessGroup | string)[] | null;
}

export function hasGroup(
  user: FeatureAccessUser | null | undefined,
  slug: string,
): boolean {
  return (
    user?.groups?.some((group) =>
      typeof group === 'string' ? group === slug : group.slug === slug,
    ) ?? false
  );
}

/**
 * Analytical method data is reachable two ways: membership in the
 * admin-managed `rettstoks` group, or holding the `methods.read` capability
 * — which defaults to the admin tier, so this behaves exactly as before
 * until an admin lowers it in Admin → Permissions.
 */
export function canAccessAnalyticalMethods(
  user: FeatureAccessUser | null | undefined,
  overrides: PermissionOverrides = NO_OVERRIDES,
): boolean {
  return (
    hasGroup(user, RETTSTOKS_GROUP_SLUG) ||
    can(user?.role, CAP['methods.read'], overrides)
  );
}

/**
 * Postmortem concentration distributions reach the same audience as the
 * analytical methods: the `rettstoks` group, or whoever holds
 * `pmConcentrations.read` (admin by default).
 *
 * The shipped cohort is unpublished material, and its percentiles describe
 * postmortem findings with no link to cause of death — a distinction a forensic
 * toxicologist reads correctly and a casual reader does not. The API route
 * enforces this too, so a direct URL cannot bypass the UI check.
 */
export function canAccessPmConcentrations(
  user: FeatureAccessUser | null | undefined,
  overrides: PermissionOverrides = NO_OVERRIDES,
): boolean {
  return (
    hasGroup(user, RETTSTOKS_GROUP_SLUG) ||
    can(user?.role, CAP['pmConcentrations.read'], overrides)
  );
}

/**
 * Rettstoksikologi's own urine detection times, from the section's approved,
 * restricted urine-interpretation guideline. Same audience as the analytical
 * methods and the postmortem cohort: the `rettstoks` group, or whoever holds
 * `refsDetectionTimes.read` (admin by default).
 *
 * These bands are what one laboratory has agreed to state for its own cut-offs
 * and its own case categories, from an internal document with restricted
 * distribution. Read by someone outside the section they would also look like
 * Kinetix's answer to "how long is this detectable", which is what the pooled,
 * cited windows on the same page are for. `api/refs-detection-times.ts`
 * enforces this — the table lives in the database and is never bundled into
 * the client, so a direct URL is the only other way in and it is refused there.
 */
export function canAccessRefsDetectionTimes(
  user: FeatureAccessUser | null | undefined,
  overrides: PermissionOverrides = NO_OVERRIDES,
): boolean {
  return (
    hasGroup(user, RETTSTOKS_GROUP_SLUG) ||
    can(user?.role, CAP['refsDetectionTimes.read'], overrides)
  );
}

/**
 * The metabolite ratio profile ("pattern" engine) is forensic casework
 * material: before Phase 3 (atlas binding) it renders provisional registry
 * bands without the cohort-provenance and matching gates
 * (docs/plans/2026-08-11-metabolite-ratio-profile.md §10 keeps it out of the
 * primary nav until then). So the nav entry is shown only to the forensic
 * audience — the `rettstoks` group, plus the admin tier — the same containment
 * the postmortem cohort and REFS tables use. The route itself stays reachable
 * by URL, exactly as it was before it was surfaced.
 *
 * Deliberately keyed on the admin *role*, not a capability: `admin.panel.access`
 * is runtime-configurable down to an editor floor, so gating on it would leak
 * the provisional profile to every editor once an admin lowered it. The role
 * is the stable containment the forensic audience needs.
 */
export function canAccessPatternProfile(
  user: FeatureAccessUser | null | undefined,
): boolean {
  return hasGroup(user, RETTSTOKS_GROUP_SLUG) || user?.role === ROLES.admin;
}

/**
 * Kinetix Learn (Phase B) is gated to admins and members of the
 * admin-managed `kinetix-learn` group. API routes enforce the same gate so
 * direct URLs do not bypass the navigation-level check.
 */
export function canAccessKinetixLearn(
  user: FeatureAccessUser | null | undefined,
  overrides: PermissionOverrides = NO_OVERRIDES,
): boolean {
  return (
    hasGroup(user, KINETIX_LEARN_GROUP_SLUG) ||
    can(user?.role, CAP['learn.read'], overrides)
  );
}
