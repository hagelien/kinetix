import type { IncomingMessage, ServerResponse } from 'node:http';
import { getUserFromRequest } from './auth.js';
import { error } from './response.js';
import { callerCan } from './permissions-store.js';
import { CAP } from '../../src/lib/permissions.js';

/**
 * Guard an admin-tier route. `capability` names which admin capability is
 * being exercised so an admin can delegate it in Admin → Permissions; the
 * default is the locked `admin.users.manage`, i.e. strictly admin, so a
 * caller that has not opted into a capability keeps the old behavior.
 */
export async function requireAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  capability: string = CAP['admin.users.manage'],
): Promise<{ userId: number; role: string } | null> {
  const auth = await getUserFromRequest(req);
  if (!auth || !(await callerCan(auth.role, capability))) {
    error(res, 403, 'Admin role required');
    return null;
  }

  return auth;
}
