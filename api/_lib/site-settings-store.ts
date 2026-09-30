import { eq, inArray } from 'drizzle-orm';
import {
  getConfigDb,
  getDb,
  runInPoolTransaction,
  withDbRetry,
} from './db.js';
import { siteSettings, users } from '../../db/schema.js';
import {
  SITE_SETTING_DEFAULTS,
  SITE_SETTING_LIST,
  SETTING,
  isSiteSettingId,
  sanitizeSiteSettings,
  type SiteSettingId,
  type SiteSettings,
} from '../../src/lib/siteSettings.js';

/**
 * Server-side access to the runtime policy switches (`site_settings`).
 *
 * Mirrors `permissions-store.ts`: the stored rows are tiny (usually zero, since
 * only deviations from the shipped defaults are persisted), so they are cached
 * per warm serverless instance for a few seconds rather than read on every
 * request. The read sits on write paths — the reference gate runs on every fact
 * and parameter submission — so an uncached round-trip per call would be paid
 * on the hottest path in the review pipeline.
 *
 * Failure direction is deliberate and the opposite of a feature flag's: an
 * unreadable table resolves to the **defaults**, which is the *stricter*
 * behaviour (every switch here ships ON). A transient database blip must never
 * quietly drop a guard.
 */

/** Short enough that an admin's change propagates across instances quickly. */
const CACHE_TTL_MS = 5_000;

let cached: { value: SiteSettings; expiresAt: number } | null = null;
let warnedAboutLoadFailure = false;

/** Drop the cached settings after a write, so the next read sees the change. */
export function invalidateSiteSettingsCache(): void {
  cached = null;
}

/** Test seam: forget the cache and the one-shot warning. */
export function resetSiteSettingsForTests(): void {
  cached = null;
  warnedAboutLoadFailure = false;
}

/**
 * The store's accessors, or null when this module was loaded against a `db.js`
 * that doesn't provide them — the unit suite mocks `db.js` with `getDb` alone.
 * Reading an export a mock factory never defined throws rather than yielding
 * undefined, and that throw is the signal: "no store is wired up here", which
 * is a different thing from "the store is unreachable".
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
 * predates migration 0096. Drivers wrap their errors, so walk the cause chain
 * rather than trusting the outermost shape.
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
 * Every switch's effective value, defaults folded in.
 *
 * Never throws and never returns a partial map: a missing table, a missing
 * `DATABASE_URL`, or an unreachable database all resolve to the shipped
 * defaults, so a switch that ships ON stays ON when the store is unavailable.
 */
export async function loadSiteSettings(): Promise<SiteSettings> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  const store = resolveStoreAccessors();
  // No store to read: there is no configuration, so the defaults are policy.
  if (!store) return SITE_SETTING_DEFAULTS;

  try {
    // Retry the transient neon-http blips before falling back — a single
    // dropped request should not silently change a policy switch.
    const rows = await store.retry(() =>
      store
        .db()
        .select({ key: siteSettings.key, value: siteSettings.value })
        .from(siteSettings),
    );

    const raw: Record<string, unknown> = {};
    for (const row of rows) raw[row.key] = row.value;
    const value = sanitizeSiteSettings(raw);
    cached = { value, expiresAt: now + CACHE_TTL_MS };
    warnedAboutLoadFailure = false;
    return value;
  } catch (err) {
    // "There is no configuration" — no database in this environment, or the
    // table predates migration 0096. Both mean the defaults ARE the policy;
    // neither is worth a warning on every request.
    if (isUnconfiguredDatabaseError(err) || isMissingSettingsTable(err)) {
      return SITE_SETTING_DEFAULTS;
    }
    if (!warnedAboutLoadFailure) {
      warnedAboutLoadFailure = true;
      console.warn(
        '[site-settings] could not read site_settings; using shipped defaults',
        err,
      );
    }
    return SITE_SETTING_DEFAULTS;
  }
}

/** One switch's effective value. */
export async function getSiteSettingValue(
  id: SiteSettingId,
): Promise<boolean> {
  return (await loadSiteSettings())[id];
}

/**
 * Whether the read-in-full reference gate is currently blocking writes.
 *
 * Consulted by `assertReferencesJudgedForActor` — the agent gate. When an admin
 * turns it off, an agent's fact or parameter citing an unreviewed resolvable
 * source is accepted; the citation still joins the follow-up review queues, it
 * just no longer blocks the write. The bare `assertReferencesJudged` (the
 * learning-unit path, which gates humans too) does not consult this.
 */
export async function isReferenceGateEnabled(): Promise<boolean> {
  return getSiteSettingValue(SETTING['referenceGate.blockUnreviewedCitations']);
}

export interface SiteSettingRow {
  id: SiteSettingId;
  value: boolean;
  defaultValue: boolean;
  isDefault: boolean;
  group: string;
  enforcedAt: readonly string[];
  updatedAt: string | null;
  updatedBy: { id: number; username: string } | null;
}

/** The full switch list plus provenance, for the admin panel. */
export async function getSiteSettingsMatrix(): Promise<{
  settings: SiteSettings;
  rows: SiteSettingRow[];
}> {
  const db = getDb();
  const stored = await db
    .select({
      key: siteSettings.key,
      value: siteSettings.value,
      updatedAt: siteSettings.updatedAt,
      updatedById: users.id,
      updatedByName: users.username,
    })
    .from(siteSettings)
    .leftJoin(users, eq(users.id, siteSettings.updatedBy));

  const raw: Record<string, unknown> = {};
  for (const row of stored) raw[row.key] = row.value;
  const settings = sanitizeSiteSettings(raw);
  const byKey = new Map(stored.map((row) => [row.key, row]));

  const rows: SiteSettingRow[] = SITE_SETTING_LIST.map((def) => {
    const row = byKey.get(def.id);
    const value = settings[def.id];
    const isDefault = value === def.defaultValue;
    return {
      id: def.id,
      value,
      defaultValue: def.defaultValue,
      isDefault,
      group: def.group,
      enforcedAt: def.enforcedAt,
      // A row pruned back to its default carries no provenance to show.
      updatedAt: isDefault ? null : (row?.updatedAt?.toISOString() ?? null),
      updatedBy:
        !isDefault && row?.updatedById != null && row.updatedByName != null
          ? { id: row.updatedById, username: row.updatedByName }
          : null,
    };
  });

  return { settings, rows };
}

export class UnknownSiteSettingError extends Error {
  readonly code = 'unknown_site_setting';

  constructor(public readonly id: string) {
    super(`"${id}" is not a known site setting`);
    this.name = 'UnknownSiteSettingError';
  }
}

/**
 * Apply a batch of switch changes as one unit.
 *
 * The whole batch is validated before anything is written and the writes run in
 * a single transaction, so a stale admin client naming a switch this release
 * dropped gets its save rejected outright rather than half-applied. Rejecting
 * beats silently ignoring: an ignored id would leave the client believing it
 * had turned a guard off.
 *
 * A value equal to the shipped default deletes its row rather than storing it,
 * so the table only ever holds real deviations and a default that moves in a
 * later release is picked up instead of being pinned by a stale row.
 */
export async function applySiteSettings(
  changes: Readonly<Record<string, boolean>>,
  actorUserId: number,
): Promise<SiteSettings> {
  const entries = Object.entries(changes);
  for (const [id, value] of entries) {
    if (!isSiteSettingId(id)) throw new UnknownSiteSettingError(id);
    if (typeof value !== 'boolean') throw new UnknownSiteSettingError(id);
  }
  if (entries.length === 0) return loadSiteSettings();

  const toStore = entries.filter(
    ([id, value]) => value !== SITE_SETTING_DEFAULTS[id as SiteSettingId],
  );
  const toClear = entries
    .filter(
      ([id, value]) => value === SITE_SETTING_DEFAULTS[id as SiteSettingId],
    )
    .map(([id]) => id);

  await runInPoolTransaction(async () => {
    // Nested getDb() resolves to the transaction client, so the whole batch
    // commits or rolls back together.
    const db = getDb();
    const now = new Date();

    for (const [id, value] of toStore) {
      await db
        .insert(siteSettings)
        .values({
          key: id,
          value: value as never,
          updatedBy: actorUserId,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: siteSettings.key,
          set: { value: value as never, updatedBy: actorUserId, updatedAt: now },
        });
    }

    if (toClear.length > 0) {
      await db.delete(siteSettings).where(inArray(siteSettings.key, toClear));
    }
  });

  invalidateSiteSettingsCache();

  // The return value must never contradict what just committed.
  // `loadSiteSettings` deliberately swallows a read failure and answers with
  // the shipped defaults — the right call for a *gate check*, where the strict
  // default is the safe one, but exactly wrong here: it would report a
  // just-committed `false` as `true`, and the admin UI would show the gate on
  // while it is really off. So the re-read only supplies the switches this call
  // did NOT touch (which may briefly read stale); the ones it wrote are
  // reported from the write itself.
  const reread = await loadSiteSettings();
  return sanitizeSiteSettings({ ...reread, ...changes });
}
