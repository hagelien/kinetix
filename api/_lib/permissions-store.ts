import type { IncomingMessage, ServerResponse } from 'node:http';
import { desc, eq, sql } from 'drizzle-orm';
import {
  getConfigDb,
  getDb,
  runInPoolTransaction,
  withDbRetry,
} from './db.js';
import { getUserFromRequest, type AuthContext } from './auth.js';
import { error } from './response.js';
import {
  permissionOverrideHistory,
  permissionOverrides,
  users,
} from '../../db/schema.js';
import {
  CAP,
  CAPABILITY_LIST,
  NO_OVERRIDES,
  can as canWithOverrides,
  checkOverride,
  effectiveTier,
  getCapability,
  overridesCouldMatter,
  sanitizeOverrides,
  type PermissionOverrides,
  type PermissionTier,
} from '../../src/lib/permissions.js';

/**
 * Server-side access to the adjustable capability matrix.
 *
 * Every gated route asks `callerCan(role, capability)` instead of comparing
 * `auth.role` to a literal. The stored deviations are tiny (usually zero
 * rows), so they are cached per warm serverless instance for a few seconds
 * rather than read on every request.
 */

/** Short enough that an admin's change propagates across instances quickly. */
const CACHE_TTL_MS = 5_000;

let cached: { value: PermissionOverrides; expiresAt: number } | null = null;
let lastGood: PermissionOverrides | null = null;
let warnedAboutLoadFailure = false;

/**
 * Drop the cached matrix after a write.
 *
 * Clears the stale-fallback value too. "The last matrix this instance saw" is
 * by definition out of date once a save has committed, and serving it on a
 * later failed read could admit callers the just-saved policy was meant to
 * deny. With it cleared, a failed read denies instead — the same fail-closed
 * direction the rest of this module takes.
 */
export function invalidatePermissionOverridesCache(): void {
  cached = null;
  lastGood = null;
}

/** Test seam: forget both the cache and the stale-fallback value. */
export function resetPermissionOverridesForTests(): void {
  cached = null;
  lastGood = null;
  warnedAboutLoadFailure = false;
}

/**
 * The store's accessors, or null when this module was loaded against a
 * `db.js` that doesn't provide them.
 *
 * Reading an export a mock factory never defined throws rather than yielding
 * undefined, and that throw is the signal we want: it says "no store is wired
 * up here", which is a different thing from "the store is unreachable". Doing
 * the read in its own try/catch keeps the two apart.
 */
function resolveStoreAccessors(): {
  db: typeof getConfigDb;
  retry: typeof withDbRetry;
} | null {
  try {
    if (typeof getConfigDb !== 'function' || typeof withDbRetry !== 'function') {
      return null;
    }
    return { db: getConfigDb, retry: withDbRetry };
  } catch {
    return null;
  }
}

/**
 * Read the stored deviations, or null when the matrix is genuinely unknown.
 *
 * The distinction matters because an admin may have *raised* a capability, in
 * which case falling back to the shipped defaults would be more permissive
 * than the configured policy:
 *
 *  - **Nothing configured** — no store wired up, no DATABASE_URL, or the
 *    table predating migration 0089. There are no overrides to read, so the
 *    defaults are the policy. Returns `{}`.
 *  - **Read succeeded** — cache and return it.
 *  - **Store unreachable** after retries — return the last matrix this
 *    instance saw, or null if it never saw one. Callers that gate on the
 *    answer treat null as "deny"; callers that only display it fall back to
 *    the defaults.
 */
async function readPermissionOverrides(): Promise<PermissionOverrides | null> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  const store = resolveStoreAccessors();
  // No store to read: there is no configuration, so the shipped defaults are
  // the policy. This must not deny every capability in the unit suite.
  if (!store) return NO_OVERRIDES;

  try {
    // Retry the transient neon-http blips before concluding the policy is
    // unknown — a single dropped request should not deny a legitimate caller.
    const rows = await store.retry(() =>
      store
        .db()
        .select({
          capability: permissionOverrides.capability,
          minTier: permissionOverrides.minTier,
        })
        .from(permissionOverrides),
    );

    const raw: Record<string, string> = {};
    for (const row of rows) raw[row.capability] = row.minTier;
    const value = sanitizeOverrides(raw);
    cached = { value, expiresAt: now + CACHE_TTL_MS };
    lastGood = value;
    warnedAboutLoadFailure = false;
    return value;
  } catch (err) {
    // Two "there is no configuration" cases, both of which mean the shipped
    // defaults ARE the policy rather than that the policy is unknown:
    //   - no database in this environment at all (a local run or a test
    //     without DATABASE_URL);
    //   - the table doesn't exist yet, i.e. migration 0089 has not run on
    //     this database. No overrides can exist without it, and denying every
    //     middle-tier action until someone notices would be a far worse
    //     failure than serving the defaults the code shipped with.
    // Only a genuine reachability failure leaves the policy unknown.
    if (isUnconfiguredDatabaseError(err) || isMissingMatrixTable(err)) {
      return NO_OVERRIDES;
    }

    if (!warnedAboutLoadFailure) {
      warnedAboutLoadFailure = true;
      console.warn(
        '[permissions] could not read permission_overrides; %s',
        lastGood
          ? 'using the last known matrix'
          : 'capability checks will be denied until it loads',
        err,
      );
    }
    return lastGood;
  }
}

/** `getDb()`'s "no DATABASE_URL" guard, as opposed to a connection failure. */
function isUnconfiguredDatabaseError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('DATABASE_URL');
}

/**
 * Postgres `undefined_table` (42P01) for the override table — the database is
 * reachable, it just predates migration 0089. Drivers wrap their errors, so
 * walk the cause chain rather than trusting the outermost shape.
 */
function isMissingMatrixTable(err: unknown): boolean {
  for (let cursor: unknown = err, depth = 0; cursor && depth < 5; depth++) {
    const candidate = cursor as { code?: unknown; cause?: unknown };
    if (candidate.code === '42P01') return true;
    cursor = candidate.cause;
  }
  return false;
}

/**
 * The matrix for display and for helpers that take it as an argument. An
 * unreadable matrix resolves to the shipped defaults here — these callers
 * render affordances or filter already-authorized rows, and the authoritative
 * decision is made by {@link callerCan}, which denies instead.
 */
export async function loadPermissionOverrides(): Promise<PermissionOverrides> {
  return (await readPermissionOverrides()) ?? NO_OVERRIDES;
}

/**
 * True when a caller at `role` (null/undefined = anonymous) holds
 * `capability`.
 *
 * Skips the override read entirely when it could not change the answer —
 * an admin holds everything, and a caller below the capability's floor can
 * never be granted it — so the common paths keep rejecting (or admitting)
 * before any database work.
 */
export async function callerCan(
  role: string | null | undefined,
  capability: string,
): Promise<boolean> {
  if (!overridesCouldMatter(role, capability)) {
    return canWithOverrides(role, capability, NO_OVERRIDES);
  }
  const overrides = await readPermissionOverrides();
  // Unknown policy denies. An admin may have raised this capability above its
  // shipped default, so falling back to the default here could admit someone
  // the configured matrix excludes — and this branch only runs for callers
  // whose answer the matrix can actually change.
  if (overrides === null) return false;
  return canWithOverrides(role, capability, overrides);
}

/**
 * Whether the caller may see a wiki page in this state — the authorization
 * form of `canReadWikiPageStatus`.
 *
 * Published pages are public, so no policy read is needed. Anything else is a
 * real access decision about unpublished content, so it goes through
 * `callerCan`, which denies when the policy is unknown rather than falling
 * back to a default that may be more permissive than the configured one.
 */
export async function callerCanReadWikiPage(
  status: string | null | undefined,
  auth: { role: string } | null | undefined,
): Promise<boolean> {
  if (status === 'published') return true;
  if (status !== 'draft') return false;
  return callerCan(auth?.role, CAP['wiki.draft.read']);
}

/** The tier currently required for `capability`, overrides applied. */
export async function requiredTierFor(
  capability: string,
): Promise<PermissionTier> {
  return effectiveTier(capability, await loadPermissionOverrides());
}

export interface RequireCapabilityOptions {
  /** Message for the 403. Defaults to naming the required tier. */
  message?: string;
  /** Stable error `code` for the client, when the route already uses one. */
  code?: string;
  /** Message for the 401 when there is no session at all. */
  unauthenticatedMessage?: string;
}

/**
 * Resolve the caller and assert a capability, writing the 401/403 itself.
 * Returns null once a response has been sent.
 */
export async function requireCapability(
  req: IncomingMessage,
  res: ServerResponse,
  capability: string,
  options: RequireCapabilityOptions = {},
): Promise<AuthContext | null> {
  const auth = await getUserFromRequest(req);
  const overrides = await loadPermissionOverrides();
  if (!auth) {
    const required = effectiveTier(capability, overrides);
    if (required !== 'anonymous') {
      error(
        res,
        401,
        options.unauthenticatedMessage ?? 'Authentication required',
        options.code,
      );
      return null;
    }
    return null;
  }
  if (!canWithOverrides(auth.role, capability, overrides)) {
    const required = effectiveTier(capability, overrides);
    error(
      res,
      403,
      options.message ?? `${required} role or higher required`,
      options.code,
    );
    return null;
  }
  return auth;
}

export interface PermissionMatrixRow {
  capability: string;
  minTier: PermissionTier;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: { id: number; username: string } | null;
}

/** The full matrix plus provenance, for the admin panel. */
export async function getPermissionMatrix(): Promise<{
  overrides: PermissionOverrides;
  rows: PermissionMatrixRow[];
}> {
  const db = getDb();
  const stored = await db
    .select({
      capability: permissionOverrides.capability,
      minTier: permissionOverrides.minTier,
      updatedAt: permissionOverrides.updatedAt,
      updatedById: users.id,
      updatedByName: users.username,
    })
    .from(permissionOverrides)
    .leftJoin(users, eq(users.id, permissionOverrides.updatedBy));

  const raw: Record<string, string> = {};
  for (const row of stored) raw[row.capability] = row.minTier;
  const overrides = sanitizeOverrides(raw);
  const byCapability = new Map(stored.map((row) => [row.capability, row]));

  const rows: PermissionMatrixRow[] = CAPABILITY_LIST.map((cap) => {
    const stored = byCapability.get(cap.id);
    const minTier = effectiveTier(cap.id, overrides);
    return {
      capability: cap.id,
      minTier,
      isDefault: minTier === cap.defaultTier,
      updatedAt:
        minTier === cap.defaultTier
          ? null
          : (stored?.updatedAt?.toISOString() ?? null),
      updatedBy:
        stored?.updatedById != null && stored.updatedByName != null
          ? { id: stored.updatedById, username: stored.updatedByName }
          : null,
    };
  });

  return { overrides, rows };
}

export interface AppliedPermissionChange {
  capability: string;
  minTier: PermissionTier;
  isDefault: boolean;
}

export type PermissionChangeResult =
  | { ok: true; applied: AppliedPermissionChange[] }
  | { ok: false; reason: string; capability: string };

export interface PermissionChangeRequest {
  capability: string;
  /** Target tier, or null to restore the shipped default. */
  tier: PermissionTier | null;
}

/**
 * Apply a batch of matrix changes as one unit.
 *
 * Two properties the admin form depends on:
 *
 *  - **All or nothing.** The whole batch is validated before anything is
 *    written, and the writes themselves run in a single transaction. A stale
 *    client that includes a capability which has since been locked gets its
 *    save rejected outright rather than half-applied.
 *  - **A change and its audit row commit together.** They are two statements;
 *    outside a transaction a disconnect between them would leave the site's
 *    effective permissions changed with no record of who changed them, and a
 *    retry of the same save would be a no-op that never recreates the missing
 *    entry.
 *
 * Setting a capability to its shipped default clears the row rather than
 * storing it, so the table only holds real deviations and a default that
 * moves in a later release is picked up instead of being pinned by a stale
 * row.
 */
export async function applyPermissionChanges(args: {
  changes: PermissionChangeRequest[];
  actorId: number;
}): Promise<PermissionChangeResult> {
  // ─── Validate the whole batch first; no writes until every row passes ───
  const planned: Array<{
    capability: string;
    nextTier: PermissionTier | null;
    defaultTier: PermissionTier;
  }> = [];

  for (const change of args.changes) {
    const cap = getCapability(change.capability);
    if (!cap) {
      return {
        ok: false,
        reason: 'unknown_capability',
        capability: change.capability,
      };
    }
    if (cap.locked) {
      return {
        ok: false,
        reason: 'locked_capability',
        capability: change.capability,
      };
    }

    let nextTier: PermissionTier | null = null;
    if (change.tier !== null) {
      const checked = checkOverride(change.capability, change.tier);
      if (!checked.ok) {
        return {
          ok: false,
          reason: checked.reason,
          capability: change.capability,
        };
      }
      nextTier = checked.isDefault ? null : checked.tier;
    }

    planned.push({
      capability: change.capability,
      nextTier,
      defaultTier: cap.defaultTier,
    });
  }

  if (planned.length === 0) return { ok: true, applied: [] };

  // Take the per-capability locks in a stable order so two batches touching
  // the same pair can't each hold what the other wants.
  planned.sort((a, b) => a.capability.localeCompare(b.capability));

  await runInPoolTransaction(async () => {
    // Nested getDb() resolves to the transaction client, so every statement
    // below — including the audit rows — commits or rolls back as one.
    const db = getDb();

    for (const step of planned) {
      // Serialize concurrent saves of the SAME capability. Without it two
      // admins can both read the pre-change tier before either upsert
      // commits, and the second one's audit row then claims a transition
      // that never happened (null→contributor instead of editor→contributor).
      // An advisory lock rather than SELECT ... FOR UPDATE because the row
      // may not exist yet — there is nothing to lock on a first override.
      // Keyed on the capability id; held to the end of the transaction.
      await db.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${step.capability}))`,
      );

      const [existing] = await db
        .select({ minTier: permissionOverrides.minTier })
        .from(permissionOverrides)
        .where(eq(permissionOverrides.capability, step.capability))
        .limit(1);
      const fromTier = existing?.minTier ?? null;

      if (step.nextTier === null) {
        await db
          .delete(permissionOverrides)
          .where(eq(permissionOverrides.capability, step.capability));
      } else {
        await db
          .insert(permissionOverrides)
          .values({
            capability: step.capability,
            minTier: step.nextTier,
            updatedBy: args.actorId,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: permissionOverrides.capability,
            set: {
              minTier: step.nextTier,
              updatedBy: args.actorId,
              updatedAt: new Date(),
            },
          });
      }

      // Only record history when something actually moved, so a no-op save
      // from the admin form does not pad the audit trail.
      if (fromTier !== step.nextTier) {
        await db.insert(permissionOverrideHistory).values({
          capability: step.capability,
          fromTier,
          toTier: step.nextTier,
          changedBy: args.actorId,
        });
      }
    }
  });

  // Only drop the cache once the transaction has committed — a rolled-back
  // batch must not make this instance re-read a matrix that never changed.
  invalidatePermissionOverridesCache();

  return {
    ok: true,
    applied: planned.map((step) => ({
      capability: step.capability,
      minTier: step.nextTier ?? step.defaultTier,
      isDefault: step.nextTier === null,
    })),
  };
}

/** Single-change convenience wrapper over {@link applyPermissionChanges}. */
export async function applyPermissionChange(args: {
  capability: string;
  tier: PermissionTier | null;
  actorId: number;
}): Promise<
  | ({ ok: true } & AppliedPermissionChange)
  | { ok: false; reason: string; capability: string }
> {
  const result = await applyPermissionChanges({
    changes: [{ capability: args.capability, tier: args.tier }],
    actorId: args.actorId,
  });
  if (!result.ok) return result;
  return { ok: true, ...result.applied[0]! };
}

export interface PermissionHistoryRow {
  id: number;
  capability: string;
  fromTier: string | null;
  toTier: string | null;
  changedAt: string;
  changedBy: { id: number; username: string } | null;
}

export async function listPermissionHistory(
  limit = 25,
): Promise<PermissionHistoryRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: permissionOverrideHistory.id,
      capability: permissionOverrideHistory.capability,
      fromTier: permissionOverrideHistory.fromTier,
      toTier: permissionOverrideHistory.toTier,
      changedAt: permissionOverrideHistory.changedAt,
      changedById: users.id,
      changedByName: users.username,
    })
    .from(permissionOverrideHistory)
    .leftJoin(users, eq(users.id, permissionOverrideHistory.changedBy))
    .orderBy(desc(permissionOverrideHistory.changedAt))
    .limit(Math.min(Math.max(limit, 1), 100));

  return rows.map((row) => ({
    id: row.id,
    capability: row.capability,
    fromTier: row.fromTier,
    toTier: row.toTier,
    changedAt: row.changedAt.toISOString(),
    changedBy:
      row.changedById != null && row.changedByName != null
        ? { id: row.changedById, username: row.changedByName }
        : null,
  }));
}
