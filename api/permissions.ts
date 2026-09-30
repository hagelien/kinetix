import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  error,
  json,
  noStoreHeaders,
  withErrorHandling,
} from './_lib/response.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { getUserFromRequest } from './_lib/auth.js';
import { permissionMatrixPatchSchema } from './_lib/schemas.js';
import {
  applyPermissionChanges,
  getPermissionMatrix,
  listPermissionHistory,
  loadPermissionOverrides,
} from './_lib/permissions-store.js';
import { CAP, can } from '../src/lib/permissions.js';

/**
 * The adjustable capability matrix.
 *
 * `GET` is public: the capability *registry* ships in the client bundle, and
 * the overrides are what the UI needs in order to show the same affordances
 * the API will actually accept. Nothing here is secret — the matrix says
 * which tier may act, not who holds which tier — and an anonymous visitor
 * needs it too (the header, the monograph edit buttons, the review link all
 * gate on it before any session exists).
 *
 * `PATCH` is admin-only, guarded by the `admin.permissions.manage`
 * capability, which the registry marks `locked` precisely so this endpoint
 * can never be delegated through itself.
 */
export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  );

  switch (req.method) {
    case 'GET':
      return handleGet(req, res, url);
    case 'PATCH':
      assertSameOrigin(req);
      return handlePatch(req, res);
    default:
      error(res, 405, 'Method not allowed');
  }
});

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (url.searchParams.get('view') !== 'admin') {
    const overrides = await loadPermissionOverrides();
    json(res, 200, { overrides }, { headers: noStoreHeaders() });
    return;
  }

  const auth = await requireMatrixAdmin(req, res);
  if (!auth) return;

  const [{ rows, overrides }, history] = await Promise.all([
    getPermissionMatrix(),
    listPermissionHistory(Number(url.searchParams.get('historyLimit') ?? 25)),
  ]);
  json(res, 200, { overrides, rows, history }, { headers: noStoreHeaders() });
}

async function handlePatch(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await requireMatrixAdmin(req, res);
  if (!auth) return;

  const parsed = await parseAndValidate(req, permissionMatrixPatchSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  // All or nothing: the store validates every row before writing any, and
  // writes the batch in one transaction. A stale client that names a
  // capability which has since been locked gets the save rejected outright
  // rather than half-applied.
  const result = await applyPermissionChanges({
    changes: parsed.data.changes.map((change) => ({
      capability: change.capability,
      tier: change.minTier,
    })),
    actorId: auth.userId,
  });

  if (!result.ok) {
    // `code` + `capability` are the locale-independent parts the client maps
    // to a translated message; the prose is a debug fallback.
    json(
      res,
      400,
      {
        error: `Cannot change "${result.capability}": ${result.reason}`,
        code: result.reason,
        capability: result.capability,
      },
      { headers: noStoreHeaders() },
    );
    return;
  }

  const { rows, overrides } = await getPermissionMatrix();
  json(
    res,
    200,
    {
      applied: result.applied.map((change) => change.capability),
      overrides,
      rows,
    },
    { headers: noStoreHeaders() },
  );
}

/**
 * `admin.permissions.manage` is locked to the admin tier in the registry, so
 * this resolves to a plain admin check today — expressed as a capability so
 * the guard reads like every other one and so unlocking it later is a
 * registry change rather than a route change.
 */
async function requireMatrixAdmin(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ userId: number; role: string } | null> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return null;
  }
  if (!can(auth.role, CAP['admin.permissions.manage'])) {
    error(res, 403, 'Admin role required');
    return null;
  }
  return auth;
}
