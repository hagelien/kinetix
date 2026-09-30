import { useAuthStore } from '@/stores/authStore';
import {
  can,
  canAnyInGroup,
  type CapabilityGroup,
  type CapabilityId,
  type PermissionOverrides,
} from '@/lib/permissions';

/**
 * React binding for the capability matrix (#310 follow-up).
 *
 * Components ask `useCan('review.edit.decide')` rather than comparing
 * `user.role` to a literal, so an admin who moves a capability in
 * Admin → Permissions changes the UI and the API together — the affordance
 * disappears (or appears) in the same breath as the endpoint that backs it.
 */
export function useCan(capability: CapabilityId): boolean {
  return useAuthStore((state) =>
    can(state.user?.role, capability, state.permissionOverrides),
  );
}

/** True when the caller holds any capability in `group`. */
export function useCanAnyInGroup(group: CapabilityGroup): boolean {
  return useAuthStore((state) =>
    canAnyInGroup(state.user?.role, group, state.permissionOverrides),
  );
}

/** The matrix itself, for helpers that take it as an argument. */
export function usePermissionOverrides(): PermissionOverrides {
  return useAuthStore((state) => state.permissionOverrides);
}

/** Same check outside React (event handlers, loaders, stores). */
export function currentUserCan(capability: CapabilityId): boolean {
  const { user, permissionOverrides } = useAuthStore.getState();
  return can(user?.role, capability, permissionOverrides);
}
