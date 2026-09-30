import type { PermissionTier } from '@/lib/permissions';

/** One row of the admin matrix view: effective tier plus provenance. */
export interface PermissionMatrixRow {
  capability: string;
  minTier: PermissionTier;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: { id: number; username: string } | null;
}

export interface PermissionHistoryRow {
  id: number;
  capability: string;
  fromTier: string | null;
  toTier: string | null;
  changedAt: string;
  changedBy: { id: number; username: string } | null;
}

export interface PermissionMatrixResponse {
  overrides: Record<string, PermissionTier>;
  rows: PermissionMatrixRow[];
  history: PermissionHistoryRow[];
}

/** A single pending change; `minTier: null` restores the shipped default. */
export interface PermissionChange {
  capability: string;
  minTier: PermissionTier | null;
}

/**
 * Map the server's stable, locale-independent `code` to an i18n key, per the
 * repo's i18n rule: server responses stay language-neutral and the client
 * translates at the React boundary. The English `error` prose is a debug
 * fallback only — a Norwegian admin must not be shown it.
 */
const ERROR_CODE_KEYS: Record<string, string> = {
  unknown_capability: 'admin.permissions.errorUnknownCapability',
  locked_capability: 'admin.permissions.errorLockedCapability',
  invalid_tier: 'admin.permissions.errorInvalidTier',
  below_floor: 'admin.permissions.errorBelowFloor',
};

/**
 * Thrown with an i18n key rather than a message, so the caller resolves it
 * through `t()`. `capability` carries the row the server refused, for
 * interpolation.
 */
export class PermissionApiError extends Error {
  constructor(
    /** i18n key */
    message: string,
    readonly capability?: string,
  ) {
    super(message);
    this.name = 'PermissionApiError';
  }
}

async function readError(res: Response, fallbackKey: string): Promise<never> {
  let code: string | undefined;
  let capability: string | undefined;
  try {
    const data = (await res.json()) as { code?: string; capability?: string };
    code = typeof data?.code === 'string' ? data.code : undefined;
    capability =
      typeof data?.capability === 'string' ? data.capability : undefined;
  } catch {
    // keep the fallback
  }
  throw new PermissionApiError(
    (code && ERROR_CODE_KEYS[code]) ?? fallbackKey,
    capability,
  );
}

export async function fetchPermissionMatrix(): Promise<PermissionMatrixResponse> {
  const res = await fetch('/api/permissions?view=admin');
  if (!res.ok) await readError(res, 'admin.permissions.loadFailed');
  return (await res.json()) as PermissionMatrixResponse;
}

export async function savePermissionChanges(
  changes: PermissionChange[],
): Promise<Pick<PermissionMatrixResponse, 'overrides' | 'rows'>> {
  const res = await fetch('/api/permissions', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes }),
  });
  if (!res.ok) await readError(res, 'admin.permissions.saveFailed');
  return (await res.json()) as Pick<
    PermissionMatrixResponse,
    'overrides' | 'rows'
  >;
}
