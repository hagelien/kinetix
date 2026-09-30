import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SETTING,
  SITE_SETTING_DEFAULTS,
} from '../../src/lib/siteSettings';

const GATE = SETTING['referenceGate.blockUnreviewedCitations'];

/**
 * The store is loaded fresh per test through `vi.resetModules()` so its
 * module-level cache never leaks between cases, and so the "db.js exposes no
 * config accessors" case can be built at all — that is a property of the
 * mocked module's shape, not of a runtime value.
 */
async function loadStore(dbModule: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock('../../api/_lib/db.js', () => dbModule);
  return import('../../api/_lib/site-settings-store.js');
}

/** A db.js mock whose `select().from()` resolves to `rows`. */
function selectingDb(rows: unknown[]) {
  const from = vi.fn().mockResolvedValue(rows);
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select }, from, select };
}

afterEach(() => {
  vi.doUnmock('../../api/_lib/db.js');
  vi.resetModules();
});

describe('loadSiteSettings', () => {
  it('returns the shipped defaults when db.js exposes no config accessors', async () => {
    // What the unit suite looks like: `vi.mock('db.js', () => ({ getDb }))`.
    // "No store is wired up" must mean "the defaults are the policy", not
    // "the policy is unknown" — otherwise every mocked test loses the gate.
    const store = await loadStore({ getDb: vi.fn() });
    await expect(store.loadSiteSettings()).resolves.toEqual(
      SITE_SETTING_DEFAULTS,
    );
  });

  it('applies a stored deviation', async () => {
    const { db } = selectingDb([{ key: GATE, value: false }]);
    const store = await loadStore({
      getDb: vi.fn(),
      getConfigDb: () => db,
      withDbRetry: (fn: () => unknown) => fn(),
    });
    await expect(store.isReferenceGateEnabled()).resolves.toBe(false);
  });

  it('caches the read, then re-reads after an invalidation', async () => {
    const { db, select } = selectingDb([{ key: GATE, value: false }]);
    const store = await loadStore({
      getDb: vi.fn(),
      getConfigDb: () => db,
      withDbRetry: (fn: () => unknown) => fn(),
    });

    await store.loadSiteSettings();
    await store.loadSiteSettings();
    expect(select).toHaveBeenCalledTimes(1);

    store.invalidateSiteSettingsCache();
    await store.loadSiteSettings();
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('falls back to the defaults when the table predates the migration', async () => {
    // Postgres undefined_table, wrapped by the driver as `cause`.
    const err = Object.assign(new Error('relation does not exist'), {
      cause: { code: '42P01' },
    });
    const store = await loadStore({
      getDb: vi.fn(),
      getConfigDb: () => ({
        select: () => ({ from: () => Promise.reject(err) }),
      }),
      withDbRetry: (fn: () => unknown) => fn(),
    });
    await expect(store.isReferenceGateEnabled()).resolves.toBe(true);
  });

  it('keeps the gate ON when the database is unreachable', async () => {
    // Fail *closed*: a transient blip must never quietly drop a guard.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = await loadStore({
      getDb: vi.fn(),
      getConfigDb: () => ({
        select: () => ({ from: () => Promise.reject(new Error('ECONNRESET')) }),
      }),
      withDbRetry: (fn: () => unknown) => fn(),
    });
    await expect(store.isReferenceGateEnabled()).resolves.toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back silently when there is no DATABASE_URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = await loadStore({
      getDb: vi.fn(),
      getConfigDb: () => {
        throw new Error('DATABASE_URL environment variable is not set');
      },
      withDbRetry: (fn: () => unknown) => fn(),
    });
    await expect(store.loadSiteSettings()).resolves.toEqual(
      SITE_SETTING_DEFAULTS,
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('applySiteSettings', () => {
  let writes: {
    inserted: Array<Record<string, unknown>>;
    deletedKeys: unknown[];
  };

  function writableDb(storedRows: unknown[] = []) {
    writes = { inserted: [], deletedKeys: [] };
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn((row: Record<string, unknown>) => {
      writes.inserted.push(row);
      return { onConflictDoUpdate };
    });
    const where = vi.fn((keys: unknown) => {
      writes.deletedKeys.push(keys);
      return Promise.resolve(undefined);
    });
    const db = {
      insert: vi.fn().mockReturnValue({ values }),
      delete: vi.fn().mockReturnValue({ where }),
      select: vi.fn().mockReturnValue({ from: () => storedRows }),
    };
    return db;
  }

  it('rejects an id the registry does not know, naming it', async () => {
    const db = writableDb();
    const store = await loadStore({
      getDb: () => db,
      getConfigDb: () => db,
      withDbRetry: (fn: () => unknown) => fn(),
      runInPoolTransaction: (fn: () => unknown) => fn(),
    });
    await expect(
      store.applySiteSettings({ 'gone.away': false }, 1),
    ).rejects.toBeInstanceOf(store.UnknownSiteSettingError);
    // Nothing written — the batch is validated before any write.
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('stores a deviation from the default', async () => {
    const db = writableDb([{ key: GATE, value: false }]);
    const store = await loadStore({
      getDb: () => db,
      getConfigDb: () => db,
      withDbRetry: (fn: () => unknown) => fn(),
      runInPoolTransaction: (fn: () => unknown) => fn(),
    });
    const result = await store.applySiteSettings({ [GATE]: false }, 42);
    expect(writes.inserted).toEqual([
      expect.objectContaining({ key: GATE, value: false, updatedBy: 42 }),
    ]);
    expect(db.delete).not.toHaveBeenCalled();
    expect(result[GATE]).toBe(false);
  });

  it('reports the committed value even when the post-commit read fails', async () => {
    // `loadSiteSettings` answers a failed read with the shipped defaults —
    // right for a gate check, wrong here: returning `true` for a switch that
    // just committed as `false` would make the admin UI show the gate on while
    // it is really off. The committed changes are overlaid on the re-read.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writes = { inserted: [], deletedKeys: [] };
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const db = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn((row: Record<string, unknown>) => {
          writes.inserted.push(row);
          return { onConflictDoUpdate };
        }),
      }),
      delete: vi.fn(),
      // The write commits; only the read-back is broken.
      select: vi.fn().mockReturnValue({
        from: () => Promise.reject(new Error('ECONNRESET')),
      }),
    };
    const store = await loadStore({
      getDb: () => db,
      getConfigDb: () => db,
      withDbRetry: (fn: () => unknown) => fn(),
      runInPoolTransaction: (fn: () => unknown) => fn(),
    });

    const result = await store.applySiteSettings({ [GATE]: false }, 42);

    expect(writes.inserted).toHaveLength(1);
    expect(result[GATE]).toBe(false);
    warn.mockRestore();
  });

  it('clears the row instead of storing a value equal to the default', async () => {
    // Otherwise a stored row pins the switch, and a default that moves in a
    // later release never reaches anyone who once toggled it back and forth.
    const db = writableDb([]);
    const store = await loadStore({
      getDb: () => db,
      getConfigDb: () => db,
      withDbRetry: (fn: () => unknown) => fn(),
      runInPoolTransaction: (fn: () => unknown) => fn(),
    });
    const result = await store.applySiteSettings({ [GATE]: true }, 42);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.delete).toHaveBeenCalledTimes(1);
    expect(result[GATE]).toBe(true);
  });
});

describe('getSiteSettingsMatrix', () => {
  beforeEach(() => vi.resetModules());

  it('lists every registry switch, marking untouched ones as default', async () => {
    const leftJoin = vi.fn().mockResolvedValue([]);
    const db = {
      select: vi.fn().mockReturnValue({ from: () => ({ leftJoin }) }),
    };
    const store = await loadStore({
      getDb: () => db,
      getConfigDb: () => db,
      withDbRetry: (fn: () => unknown) => fn(),
    });
    const { rows, settings } = await store.getSiteSettingsMatrix();
    expect(rows.map((r) => r.id)).toEqual(Object.keys(SITE_SETTING_DEFAULTS));
    expect(rows.every((r) => r.isDefault)).toBe(true);
    expect(rows.every((r) => r.updatedBy === null)).toBe(true);
    expect(settings).toEqual(SITE_SETTING_DEFAULTS);
  });

  it('carries provenance for a switch that was actually changed', async () => {
    const leftJoin = vi.fn().mockResolvedValue([
      {
        key: GATE,
        value: false,
        updatedAt: new Date('2026-08-01T10:00:00Z'),
        updatedById: 7,
        updatedByName: 'ada',
      },
    ]);
    const db = {
      select: vi.fn().mockReturnValue({ from: () => ({ leftJoin }) }),
    };
    const store = await loadStore({
      getDb: () => db,
      getConfigDb: () => db,
      withDbRetry: (fn: () => unknown) => fn(),
    });
    const { rows } = await store.getSiteSettingsMatrix();
    const gateRow = rows.find((r) => r.id === GATE);
    expect(gateRow).toMatchObject({
      value: false,
      defaultValue: true,
      isDefault: false,
      updatedBy: { id: 7, username: 'ada' },
    });
    expect(gateRow?.updatedAt).toBe('2026-08-01T10:00:00.000Z');
  });
});
