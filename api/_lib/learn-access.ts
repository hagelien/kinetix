import type { IncomingMessage, ServerResponse } from 'node:http';
import { canAccessKinetixLearn } from '../../src/lib/featureAccess.js';
import { loadPermissionOverrides } from './permissions-store.js';
import { getUserFromRequest, type AuthContext } from './auth.js';
import { error } from './response.js';

export async function requireKinetixLearnAccess(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<AuthContext | null> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Not authenticated', 'not_authenticated');
    return null;
  }
  if (!canAccessKinetixLearn(auth, await loadPermissionOverrides())) {
    error(
      res,
      403,
      'Kinetix Learn access required',
      'kinetix_learn_access_required',
    );
    return null;
  }
  return auth;
}
