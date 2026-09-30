import { eq, sql } from 'drizzle-orm';
import { getConfigDb, getDb, inTransaction, withDbRetry } from './db.js';
import { siteSettings, users } from '../../db/schema.js';
import {
  NAV_ITEM_IDS,
  isNavItemId,
  type NavItemId,
} from '../../src/lib/navItems.js';

/**
 * Server-side access to which header nav links are hidden from the average
 * (non-admin) user (#1240).
 *
 * Piggybacks on the `site_settings` table the boolean runtime switches
 * (`src/lib/siteSettings.ts`) already use, under its own key — no migration
 * needed, since `site_settings.value` is `jsonb`. It stays a sibling store
 * rather than an entry in that registry because a hidden-item list is a
 * string array, not a boolean, and `SiteSettings`/`sanitizeSiteSettings` are
 * strictly boolean by design.
 *
 * Mirrors `site-settings-store.ts`'s caching and fail-open shape, but this is
 * presentation only — nothing security-sensitive is gated on it, so an
 * unreadable store resolves to "hide nothing" (every link shows) rather than
 * the stricter direction that store's boolean switches use.
 */

const NAV_VISIBILITY_KEY = 'nav.hiddenMenuItems';

/** Short enough that an admin's change propagates across instances quickly. */
const CACHE_TTL_MS = 5_000;

let cached: { value: readonly NavItemId[]; expiresAt: number } | null = null;
let warnedAboutLoadFailure = false;

/** Drop the cached list after a write, so the next read sees the change. */
export function invalidateHiddenNavItemsCache(): void {
  cached = null;
}

/** Test seam: forget the cache and the one-shot warning. */
export function resetHiddenNavItemsForTests(): void {
  cached = null;
  warnedAboutLoadFailure = false;
}

/**
 * The store's accessors, or null when this module was loaded against a
 * `db.js` that doesn't provide them — mirrors `site-settings-store.ts`'s seam
 * for the unit suite, which mocks `db.js` with `getDb` alone.
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
 * Postgres `undefined_table` (42P01) — the database is reachable, it just
 * predates migration 0096 (the `site_settings` table). Drivers wrap their
 * errors, so walk the cause chain rather than trusting the outermost shape.
 */
function isMissingSettingsTable(err: unknown): boolean {
  for (let cursor: unknown = err, depth = 0; cursor && depth < 5; depth++) {
    const candidate = cursor as { code?: unknown; cause?: unknown };
    if (candidate.code === '42P01') return true;
    cursor = candidate.cause;
  }
  return false;
}

/** `getDb()`'s "no DATABASE_URL" guard, as opposed to a connection failure. */
function isUnconfiguredDatabaseError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('DATABASE_URL');
}

/**
 * Known ids only, deduped, in the registry's own display order — so a stored
 * row a later release partly obsoletes degrades to "hide the ids that still
 * exist" instead of being rejected wholesale, and rendering never has to
 * re-sort what the store hands back.
 */
function sanitizeHiddenNavItems(raw: unknown): readonly NavItemId[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set(raw.filter(isNavItemId));
  return NAV_ITEM_IDS.filter((id) => known.has(id));
}

/**
 * Every hidden nav item id. Never throws: a missing table, a missing
 * `DATABASE_URL`, or an unreachable database all resolve to `[]` — the
 * shipped behaviour of "hide nothing".
 */
export async function loadHiddenNavItems(): Promise<readonly NavItemId[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  const store = resolveStoreAccessors();
  if (!store) return [];

  try {
    const rows = await store.retry(() =>
      store
        .db()
        .select({ value: siteSettings.value })
        .from(siteSettings)
        .where(eq(siteSettings.key, NAV_VISIBILITY_KEY)),
    );
    const value = sanitizeHiddenNavItems(rows[0]?.value);
    cached = { value, expiresAt: now + CACHE_TTL_MS };
    warnedAboutLoadFailure = false;
    return value;
  } catch (err) {
    if (isUnconfiguredDatabaseError(err) || isMissingSettingsTable(err)) {
      return [];
    }
    if (!warnedAboutLoadFailure) {
      warnedAboutLoadFailure = true;
      console.warn(
        '[nav-visibility] could not read site_settings; showing every nav item',
        err,
      );
    }
    return [];
  }
}

export interface HiddenNavItemsState {
  hiddenItems: readonly NavItemId[];
  updatedAt: string | null;
  updatedBy: { id: number; username: string } | null;
}

/** The hidden list plus provenance, for the admin panel. */
export async function getHiddenNavItemsState(): Promise<HiddenNavItemsState> {
  const db = getDb();
  const [row] = await db
    .select({
      value: siteSettings.value,
      updatedAt: siteSettings.updatedAt,
      updatedById: users.id,
      updatedByName: users.username,
    })
    .from(siteSettings)
    .leftJoin(users, eq(users.id, siteSettings.updatedBy))
    .where(eq(siteSettings.key, NAV_VISIBILITY_KEY));

  return {
    hiddenItems: sanitizeHiddenNavItems(row?.value),
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    updatedBy:
      row?.updatedById != null && row.updatedByName != null
        ? { id: row.updatedById, username: row.updatedByName }
        : null,
  };
}

export class UnknownNavItemError extends Error {
  readonly code = 'unknown_nav_item';

  constructor(public readonly id: string) {
    super(`"${id}" is not a known nav item`);
    this.name = 'UnknownNavItemError';
  }
}

/**
 * Hide or unhide a single item, atomically against whatever the list
 * currently holds (#1316).
 *
 * Two managers toggling *different* items from independently loaded
 * snapshots must both land — a whole-list replace built from a stale
 * snapshot would silently drop the other's change. So this reads and writes
 * under a transaction-scoped advisory lock keyed on the settings key
 * (`pg_advisory_xact_lock`, not `SELECT ... FOR UPDATE`: an all-visible list
 * stores no row at all, so there is nothing to row-lock on the first hide).
 * Two managers toggling the *same* item concurrently still get last-write-
 * wins, which is the correct, unavoidable outcome for that case.
 *
 * An unrecognised id throws rather than being silently dropped, so a stale
 * admin client naming an item this release removed finds out rather than
 * believing it hid something it did not.
 */
export async function setHiddenNavItem(
  id: string,
  hidden: boolean,
  actorUserId: number,
): Promise<HiddenNavItemsState> {
  if (!isNavItemId(id)) throw new UnknownNavItemError(id);

  await inTransaction(async () => {
    const db = getDb();
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${NAV_VISIBILITY_KEY}))`,
    );

    const [row] = await db
      .select({ value: siteSettings.value })
      .from(siteSettings)
      .where(eq(siteSettings.key, NAV_VISIBILITY_KEY));

    const current = new Set(sanitizeHiddenNavItems(row?.value));
    if (hidden) current.add(id);
    else current.delete(id);
    const next = NAV_ITEM_IDS.filter((itemId) => current.has(itemId));

    const now = new Date();
    if (next.length === 0) {
      await db.delete(siteSettings).where(eq(siteSettings.key, NAV_VISIBILITY_KEY));
    } else {
      await db
        .insert(siteSettings)
        .values({
          key: NAV_VISIBILITY_KEY,
          value: next as never,
          updatedBy: actorUserId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: siteSettings.key,
          set: { value: next as never, updatedBy: actorUserId, updatedAt: now },
        });
    }
  });

  invalidateHiddenNavItemsCache();
  return getHiddenNavItemsState();
}
