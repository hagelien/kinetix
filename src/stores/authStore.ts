import { create } from 'zustand';
import { useDrugStore } from './drugStore';
import { useBasketStore } from './basketStore';
import { useSimulatorStore } from './simulatorStore';
import { useAppStore } from './appStore';
import { useModelAcknowledgementStore } from './modelAcknowledgementStore';
import { resetPatternCaseStore } from './patternCaseStore';
import { clearMethodsCache, loadMethods } from '@/data';
import { canAccessAnalyticalMethods } from '@/lib/featureAccess';
import {
  NO_OVERRIDES,
  sanitizeOverrides,
  type PermissionOverrides,
} from '@/lib/permissions';
import { fetchHiddenNavItems } from '@/lib/navVisibilityApi';
import type { NavItemId } from '@/lib/navItems';

export type ConcentrationUnitName = string;

/** Default unit set used as a fallback for legacy/anonymous sessions. */
export const DEFAULT_ENABLED_UNITS: ConcentrationUnitName[] = [
  'µmol/L',
  'mg/L',
];

export type { NotificationSettings } from '@/lib/emailNotificationPrefs';
import type { NotificationSettings } from '@/lib/emailNotificationPrefs';

export interface AuthGroup {
  id: number;
  slug: string;
  name: string;
}

export interface AuthUser {
  id: number;
  email: string;
  username: string;
  role: string;
  sessionMaxDays?: number;
  displayName: string | null;
  /**
   * Multi-select unit preference (#306). The first item is the user's
   * primary display unit; the rest are alternatives shown in tooltips
   * and converters. Always has at least one element.
   */
  enabledConcentrationUnits: ConcentrationUnitName[];
  notificationSettings: NotificationSettings | null;
  /**
   * Per-user favorite parameter ids (#321). When non-empty, the
   * monograph sidebar's collapsed mode shows only these; expanding
   * the box reveals every registered parameter regardless. Empty
   * list = no preference set, the sidebar shows all parameters by
   * default.
   */
  favoriteParameters: string[];
  groups?: AuthGroup[];
}

// Map a stable, locale-independent server error `code` to an i18n key that
// LoginPage resolves at the React boundary (AGENTS.md: server responses stay
// language-neutral, the client translates). Without this a DB outage would
// surface the server's English `error` prose ("Service temporarily
// unavailable") verbatim inside the otherwise-Norwegian login form.
const SERVER_ERROR_CODE_KEYS: Record<string, string> = {
  service_unavailable: 'auth.serviceUnavailable',
};

/**
 * Resolve the message an auth call should throw on a non-OK response. Prefers a
 * translated key for a recognised server `code`, then the server's `error`
 * prose, then a per-call fallback i18n key.
 */
function serverErrorMessage(
  data: Record<string, unknown>,
  fallbackKey: string,
): string {
  const code = typeof data.code === 'string' ? data.code : undefined;
  if (code && SERVER_ERROR_CODE_KEYS[code]) return SERVER_ERROR_CODE_KEYS[code];
  return (data.error as string) ?? fallbackKey;
}

/** Convenience accessor for the user's primary display unit. */
export function getPrimaryConcentrationUnit(
  user: AuthUser | null,
): ConcentrationUnitName {
  return user?.enabledConcentrationUnits?.[0] ?? DEFAULT_ENABLED_UNITS[0]!;
}

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /**
   * Admin-configured deviations from the capability defaults (#310
   * follow-up). Loaded alongside the session — anonymous visitors need it
   * too, since the header, edit affordances and review links all gate on
   * capabilities before any session exists. An empty map means "shipped
   * defaults", which is also what a failed fetch leaves in place.
   */
  permissionOverrides: PermissionOverrides;
  /**
   * Admin-configured header nav links to hide from the average user (#1240).
   * Loaded alongside the session, same reasoning as `permissionOverrides`:
   * the header has to decide what to render before any session exists. An
   * empty list means "hide nothing", which is also what a failed fetch
   * leaves in place.
   */
  hiddenNavItems: readonly NavItemId[];
  /**
   * Whether `hiddenNavItems` reflects a settled read (success or failure),
   * as opposed to its unloaded default. `checkAuth` resolves `/api/auth` and
   * this list concurrently and un-gates `isLoading` on the auth check alone,
   * so a returning signed-in user's header can otherwise render before this
   * list arrives — briefly showing a link the admin meant to hide (Codex,
   * review comment on PR #1306 round 3). The header withholds the
   * admin-configurable links until this is true, rather than risk showing
   * one that should be hidden.
   */
  hiddenNavItemsLoaded: boolean;
  checkAuth: () => Promise<void>;
  loadPermissions: () => Promise<void>;
  loadHiddenNavItems: () => Promise<void>;
  requestMagicLink: (email: string, stayLoggedIn: boolean) => Promise<string>;
  verifyCode: (
    email: string,
    code: string,
    stayLoggedIn?: boolean,
  ) => Promise<void>;
  logout: () => Promise<void>;
  // Mutate locally after a successful PATCH /api/preferences. Keeps the
  // header / app store in sync without re-fetching /api/auth?action=me.
  applyPreferences: (
    prefs: Pick<
      AuthUser,
      | 'displayName'
      | 'enabledConcentrationUnits'
      | 'notificationSettings'
      | 'favoriteParameters'
    >,
  ) => void;
  /**
   * Toggle a parameter id in the user's favorites and persist via
   * PATCH /api/preferences. Resolves once the server confirms the
   * change so callers can show error UI on rejection. No-op for
   * anonymous sessions (the sidebar still falls back to "show all").
   */
  toggleFavoriteParameter: (parameterId: string) => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  permissionOverrides: NO_OVERRIDES,
  hiddenNavItems: [],
  hiddenNavItemsLoaded: false,

  checkAuth: async () => {
    const permissions = useAuthStore.getState().loadPermissions();
    const navVisibility = useAuthStore.getState().loadHiddenNavItems();
    try {
      const res = await fetch('/api/auth?action=me');
      if (res.ok) {
        const { user } = await res.json();
        set({ user, isAuthenticated: true, isLoading: false });
      } else {
        set({ user: null, isAuthenticated: false, isLoading: false });
      }
    } catch {
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
    await Promise.all([permissions, navVisibility]);
  },

  loadPermissions: async () => {
    try {
      const res = await fetch('/api/permissions');
      if (!res.ok) return;
      const data = await res.json();
      // Sanitize client-side too: the payload is only as current as the
      // deploy that served it, and a bundle from a previous release may not
      // know every id in it.
      set({ permissionOverrides: sanitizeOverrides(data.overrides) });
    } catch {
      // Keep whatever we have; the defaults are a safe read of the world.
    }
  },

  loadHiddenNavItems: async () => {
    // Reset to "unsettled" before the fetch starts, not just on the first
    // ever call: `checkAuth` (and so this) reruns on login, and without
    // this the flag stays `true` from an earlier load (e.g. the anonymous
    // bootstrap) while the fresh request is in flight — so `Header` would
    // render the STALE list instead of withholding, reopening the same
    // window the round-3 fix closed for the unloaded case (Codex, review
    // comment 4062578610).
    set({ hiddenNavItemsLoaded: false });
    try {
      const { hiddenItems } = await fetchHiddenNavItems();
      set({ hiddenNavItems: hiddenItems, hiddenNavItemsLoaded: true });
    } catch {
      // Reset to "hide nothing" rather than keeping a stale list: this can
      // rerun after a successful load (`checkAuth` fires again on login, and
      // that first anonymous-session load may have set real hidden ids), so
      // a failure here must not leave a since-unhidden link stuck hidden for
      // the rest of the SPA session (Codex, review comment 4062497398).
      // Still mark this settled — a failed read must not withhold the
      // configurable nav links forever.
      set({ hiddenNavItems: [], hiddenNavItemsLoaded: true });
    }
  },

  requestMagicLink: async (email, stayLoggedIn) => {
    const res = await fetch('/api/auth-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, stayLoggedIn }),
    });
    let data: Record<string, unknown>;
    try {
      data = await res.json();
    } catch {
      // Fallbacks are i18n keys resolved at the React boundary (LoginPage);
      // a server-provided string passes through untranslated.
      throw new Error('auth.requestFailedServerError');
    }
    if (!res.ok) {
      throw new Error(serverErrorMessage(data, 'auth.failedToSendLink'));
    }
    return (data.message as string) ?? 'auth.checkInboxForCode';
  },

  verifyCode: async (email, code, stayLoggedIn) => {
    const res = await fetch('/api/auth-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        stayLoggedIn !== undefined
          ? { email, code, stayLoggedIn }
          : { email, code },
      ),
    });
    let data: Record<string, unknown>;
    try {
      data = await res.json();
    } catch {
      throw new Error('auth.verifyFailedServerError');
    }
    if (!res.ok) {
      throw new Error(serverErrorMessage(data, 'auth.invalidOrExpiredCode'));
    }
  },

  logout: async () => {
    await fetch('/api/auth?action=logout', { method: 'POST' });
    set({ user: null, isAuthenticated: false });
    // A §5.1 acknowledgement is an act by a named reviewer, and the records live in
    // browser storage this profile's next user would inherit. Keying them by user id
    // already stops one reviewer's decision from admitting another's curve; dropping
    // them on sign-out means the decision does not sit on a shared machine either.
    useModelAcknowledgementStore.getState().clear();
  },

  applyPreferences: (prefs) =>
    set((state) => {
      if (!state.user) return state;
      return {
        user: {
          ...state.user,
          displayName: prefs.displayName,
          enabledConcentrationUnits: prefs.enabledConcentrationUnits,
          notificationSettings: prefs.notificationSettings,
          favoriteParameters: prefs.favoriteParameters,
        },
      };
    }),

  toggleFavoriteParameter: async (parameterId) => {
    // Serialize concurrent toggles. If two stars are clicked before the
    // first PATCH resolves, both calls would otherwise read the same
    // stale snapshot (e.g. `[]`) and the second response would clobber
    // the first one's result. Chaining onto the previous promise makes
    // each toggle observe the freshly-applied state from the prior
    // call. Failures don't break the chain — `.catch` swallows the
    // rejection from the chain perspective so a single network blip
    // doesn't permanently freeze favorite updates; the original
    // promise is still returned to the caller for its own error
    // handling (toast, retry, etc.).
    const op = favoritePending.then(async () => {
      const current = useAuthStore.getState().user?.favoriteParameters ?? null;
      if (current === null) return; // anonymous; no-op
      const next = current.includes(parameterId)
        ? current.filter((id) => id !== parameterId)
        : [...current, parameterId];
      const res = await fetch('/api/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favoriteParameters: next }),
      });
      if (!res.ok) {
        throw new Error('Failed to update favorites');
      }
      const { preferences } = (await res.json()) as {
        preferences: Pick<
          AuthUser,
          | 'displayName'
          | 'enabledConcentrationUnits'
          | 'notificationSettings'
          | 'favoriteParameters'
        >;
      };
      useAuthStore.getState().applyPreferences(preferences);
    });
    favoritePending = op.catch(() => {});
    return op;
  },
}));

// Module-scoped chain head used by toggleFavoriteParameter to keep
// concurrent toggles from racing each other. Lives outside the
// zustand store because zustand's `set`/`get` API doesn't make a good
// home for a mutable in-flight reference; the closure is the simplest
// way to keep the serialization private to this module.
let favoritePending: Promise<void> = Promise.resolve();

// Track authenticated user identity so feature-scoped caches can be reset when
// a different user signs in on the same tab.
let lastAuthUserId: number | null = useAuthStore.getState().user?.id ?? null;
let wasAuthLoading = useAuthStore.getState().isLoading;
let lastMethodsAccess: boolean = canAccessAnalyticalMethods(
  useAuthStore.getState().user,
  useAuthStore.getState().permissionOverrides,
);
useAuthStore.subscribe((state) => {
  const currentId = state.user?.id ?? null;
  if (currentId !== lastAuthUserId) {
    const completedInitialBootstrap = wasAuthLoading && !state.isLoading;
    lastAuthUserId = currentId;
    if (!completedInitialBootstrap) {
      useBasketStore.getState().clear();
      useSimulatorStore.getState().reset();
      // A forensic case is the most user-scoped thing the app holds, and its
      // store is a singleton that outlives the session — including any load
      // still in flight.
      resetPatternCaseStore();
      // The postmortem overlay's line choice is a per-user preference living in
      // the localStorage-backed app store, so on a shared browser the next
      // account would otherwise inherit it — opening on someone else's chart
      // configuration, possibly with plasma-converted lines drawn and the
      // controls collapsed. Reset here rather than key the storage by user id:
      // the bootstrap guard above is what distinguishes "a different person
      // signed in" from "this person's session was restored", and only the
      // first should discard the preference.
      useAppStore.getState().resetPmLineSettings();
      // Same reasoning for the forensic postmortem overlay: it lives in the
      // same localStorage-backed store and is per-user, so the next account
      // must not inherit the previous user's enabled categories or
      // individual-reference mode.
      useAppStore.getState().resetForensicLineSettings();
    }
  }
  wasAuthLoading = state.isLoading;
  // /api/methods is admin/Rettstoks-gated, but loadMethods() memoizes the
  // response at module scope. Without invalidating on auth change, a gated
  // (or ungated) result outlives the session — the next user in the same
  // tab sees the previous user's filter set. Drop the data-layer cache and
  // drug-store snapshot on every access flip, then only re-fetch when the
  // new user can actually see methods. loadMethods() is epoch-aware, so an
  // anonymous fetch still in flight when an authorized fetch starts can't
  // overwrite the authenticated response.
  const currentAccess = canAccessAnalyticalMethods(
    state.user,
    state.permissionOverrides,
  );
  if (currentAccess !== lastMethodsAccess) {
    lastMethodsAccess = currentAccess;
    clearMethodsCache();
    useDrugStore.getState().setMethods([]);
    if (currentAccess) {
      void loadMethods().then((methods) => {
        useDrugStore.getState().setMethods(methods);
      });
    }
  }
});
