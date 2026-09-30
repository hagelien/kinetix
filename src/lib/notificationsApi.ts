/**
 * Client for the in-app notification inbox (`api/notifications.ts`).
 *
 *   GET   /api/notifications[?unread=1&limit=N]  → { notifications, unreadCount }
 *   PATCH /api/notifications { ids?, all? }       → { updated }
 *
 * Rows are written server-side on dispute events (see
 * `api/_lib/notifications.ts` / docs/superpowers/specs/2026-06-23-unified-disputes.md).
 * The bell in the header polls the unread count and lists rows on open.
 */

/** One inbox row, mirroring `NotificationRow` in `api/_lib/notifications.ts`. */
export interface NotificationRow {
  id: number;
  type: string;
  targetType: string | null;
  targetId: number | null;
  disputeId: number | null;
  title: string;
  bodyMd: string | null;
  url: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsResponse {
  notifications: NotificationRow[];
  unreadCount: number;
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

/** The caller's notifications, newest first, plus the unread count. */
export async function fetchNotifications(params?: {
  unreadOnly?: boolean;
  limit?: number;
}): Promise<NotificationsResponse> {
  const sp = new URLSearchParams();
  if (params?.unreadOnly) sp.set('unread', '1');
  if (params?.limit) sp.set('limit', String(params.limit));
  const query = sp.toString();
  return apiFetch(`/api/notifications${query ? `?${query}` : ''}`);
}

/** Just the unread count — the cheap poll the header bell badge runs. */
export async function fetchUnreadNotificationCount(): Promise<number> {
  const { unreadCount } = await fetchNotifications({ unreadOnly: true, limit: 1 });
  return unreadCount;
}

/**
 * Mark the caller's own rows read. Pass explicit `ids`, or `all: true` to
 * clear the whole inbox. The server enforces same-origin and own-rows-only.
 */
export async function markNotificationsRead(
  args: { ids: number[]; all?: false } | { all: true; ids?: never },
): Promise<{ updated: number }> {
  return apiFetch('/api/notifications', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
}
