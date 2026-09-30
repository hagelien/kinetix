import type { NavItemId } from './navItems';

export interface HiddenNavItemsResponse {
  hiddenItems: NavItemId[];
  updatedAt: string | null;
  updatedBy: { id: number; username: string } | null;
}

/**
 * A failed nav-visibility request, carrying the server's stable `code` rather
 * than its English prose (AGENTS.md i18n rule: server strings that reach the
 * UI are codes translated at the React boundary).
 */
export class NavVisibilityApiError extends Error {
  constructor(
    readonly code: string | null,
    readonly status: number,
    readonly detail: string | null,
  ) {
    super(detail ?? code ?? `Request failed (${status})`);
    this.name = 'NavVisibilityApiError';
  }
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new NavVisibilityApiError(
      typeof data.code === 'string' ? data.code : null,
      res.status,
      typeof data.error === 'string' ? data.error : null,
    );
  }
  return data as T;
}

/** Public — every visitor's header calls this to decide what to render. */
export async function fetchHiddenNavItems(): Promise<HiddenNavItemsResponse> {
  return apiFetch('/api/admin?resource=nav-visibility');
}

/**
 * Hides or unhides one item, atomically against whatever the server's list
 * currently holds (#1316) — not a whole-list replace built from this
 * client's own stale snapshot. Admin-gated (`admin.navVisibility.manage`).
 */
export async function updateHiddenNavItem(
  id: NavItemId,
  hidden: boolean,
): Promise<HiddenNavItemsResponse> {
  return apiFetch('/api/admin?resource=nav-visibility', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, hidden }),
  });
}
