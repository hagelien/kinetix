/**
 * Session info / logout endpoint.
 *   GET  ?action=me     — current user
 *   POST ?action=logout — clear session cookie
 *
 * Registration and password login have been replaced by the magic-link
 * flow in api/auth-request.ts and api/auth-verify.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import {
  json,
  error,
  noStoreHeaders,
  withErrorHandling,
} from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { clearAuthCookie, getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin } from './_lib/validate.js';
import { users } from '../db/schema.js';

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  );
  const action = url.searchParams.get('action');

  if (action === 'me' && req.method === 'GET') {
    return handleMe(req, res);
  }
  if (action === 'logout' && req.method === 'POST') {
    assertSameOrigin(req);
    clearAuthCookie(res);
    json(res, 200, { message: 'Logged out' }, { headers: noStoreHeaders() });
    return;
  }

  error(res, 400, 'Invalid action. Use ?action=me|logout');
});

async function handleMe(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Not authenticated');
    return;
  }

  const db = getDb();
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      username: users.username,
      role: users.role,
      sessionMaxDays: users.sessionMaxDays,
      displayName: users.displayName,
      enabledConcentrationUnits: users.enabledConcentrationUnits,
      ethanolConcentrationUnit: users.ethanolConcentrationUnit,
      notificationSettings: users.notificationSettings,
      favoriteParameters: users.favoriteParameters,
    })
    .from(users)
    .where(eq(users.id, auth.userId))
    .limit(1);

  if (!user) {
    error(res, 401, 'User not found');
    return;
  }

  json(
    res,
    200,
    { user: { ...user, role: auth.role, groups: auth.groups } },
    { headers: noStoreHeaders() },
  );
}
