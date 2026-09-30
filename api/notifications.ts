/**
 * In-app notification inbox.
 *
 *   GET   /api/notifications[?unread=1&limit=N]
 *         The caller's notifications, newest first, plus the unread count for
 *         the bell badge.
 *
 *   PATCH /api/notifications   { ids?: number[], all?: boolean }
 *         Mark the caller's notifications read (own rows only).
 *
 * Any authenticated user has an inbox. Agents have no use for this (they pull
 * GET /api/disputes), but the endpoint doesn't special-case them out — an agent
 * token simply sees an empty inbox.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getUserFromRequest } from './_lib/auth.js';
import {
  error,
  json,
  noStoreHeaders,
  withErrorHandling,
} from './_lib/response.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { markNotificationsReadSchema } from './_lib/schemas.js';
import {
  listNotifications,
  markNotificationsRead,
  unreadNotificationCount,
} from './_lib/notifications.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'PATCH') {
    assertSameOrigin(req);
  }

  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }

  if (req.method === 'GET') {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    const unreadOnly = url.searchParams.get('unread') === '1';
    const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number.isInteger(limitRaw) ? limitRaw : DEFAULT_LIMIT),
    );
    const [items, unreadCount] = await Promise.all([
      listNotifications({ userId: auth.userId, role: auth.role, unreadOnly, limit }),
      unreadNotificationCount(auth.userId),
    ]);
    json(
      res,
      200,
      { notifications: items, unreadCount },
      { headers: noStoreHeaders() },
    );
    return;
  }

  if (req.method === 'PATCH') {
    const parsed = await parseAndValidate(req, markNotificationsReadSchema);
    if ('error' in parsed) {
      error(res, 400, parsed.error);
      return;
    }
    const updated = await markNotificationsRead({
      userId: auth.userId,
      ids: parsed.data.ids,
      all: parsed.data.all,
    });
    json(res, 200, { updated }, { headers: noStoreHeaders() });
    return;
  }

  error(res, 405, 'Method not allowed');
});
