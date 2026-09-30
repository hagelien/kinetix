import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NAV_ITEM_IDS } from '../../src/lib/navItems';

/**
 * Loaded fresh per test through `vi.resetModules()` so the module-level
 * cache never leaks between cases — mirrors `tests/api/site-settings-store.test.ts`.
 */
async function loadStore(dbModule: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock('../../api/_lib/db.js', () => dbModule);
  return import('../../api/_lib/nav-visibility-store.js');
}

/** A db.js mock whose `select().from().where()` resolves to `rows`. */
function selectingDb(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select }, from, select, where };
}

afterEach(() => {
  vi.doUnmock('../../api/_lib/db.js');
  vi.resetModules();
});

describe('loadHiddenNavItems', () => {
  it('returns nothing hidden when db.js exposes no config accessors', async () => {
    const store = await loadStore({ getDb: vi.fn() });
    await expect(store.loadHiddenNavItems()).resolves.toEqual([]);
  });

  it('reads a stored list, filtered to known ids and in registry order', async () => {
    const { db } = selectingDb([
      { value: [NAV_ITEM_IDS[2], 'gone.away', NAV_ITEM_IDS[0]] },
    ]);
    const store = await loadStore({
      getDb: vi.fn(),
      getConfigDb: () => db,
      withDbRetry: (fn: () => unknown) => fn(),
    });
    await expect(store.loadHiddenNavItems()).resolves.toEqual([
      NAV_ITEM_IDS[0],
      NAV_ITEM_IDS[2],
    ]);
  });

  it('treats a non-array stored value as nothing hidden', async () => {
    const { db } = selectingDb([{ value: 'not-an-array' }]);
    const store = await loadStore({
      getDb: vi.fn(),
      getConfigDb: () => db,
      withDbRetry: (fn: () => unknown) => fn(),
    });
    await expect(store.loadHiddenNavItems()).resolves.toEqual([]);
  });

  it('caches the read, then re-reads after an invalidation', async () => {
    const { db, select } = selectingDb([{ value: [NAV_ITEM_IDS[0]] }]);
    const store = await loadStore({
      getDb: vi.fn(),
      getConfigDb: () => db,
      withDbRetry: (fn: () => unknown) => fn(),
    });

    await store.loadHiddenNavItems();
    await store.loadHiddenNavItems();
    expect(select).toHaveBeenCalledTimes(1);

    store.invalidateHiddenNavItemsCache();
    await store.loadHiddenNavItems();
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('falls back to "nothing hidden" when the table predates the migration', async () => {
    const err = Object.assign(new Error('relation does not exist'), {
      cause: { code: '42P01' },
    });
    const store = await loadStore({
      getDb: vi.fn(),
      getConfigDb: () => ({
        select: () => ({ from: () => ({ where: () => Promise.reject(err) }) }),
      }),
      withDbRetry: (fn: () => unknown) => fn(),
    });
    await expect(store.loadHiddenNavItems()).resolves.toEqual([]);
  });

  it('fails open (shows every item) when the database is unreachable', async () => {
    // The opposite direction from the boolean site settings on purpose: this
    // is presentation only, so an outage must not hide a link nobody chose
    // to hide.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = await loadStore({
      getDb: vi.fn(),
      getConfigDb: () => ({
        select: () => ({
          from: () => ({ where: () => Promise.reject(new Error('ECONNRESET')) }),
        }),
      }),
      withDbRetry: (fn: () => unknown) => fn(),
    });
    await expect(store.loadHiddenNavItems()).resolves.toEqual([]);
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
    await expect(store.loadHiddenNavItems()).resolves.toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * A db.js mock supporting every shape the store issues against it: the plain
 * `select().from().where()` `loadHiddenNavItems` uses (also the read inside
 * `setHiddenNavItem`'s own transaction), the joined
 * `select().from().leftJoin().where()` `getHiddenNavItemsState` uses (also
 * `setHiddenNavItem`'s post-write re-read), the `insert()`/`delete()`
 * writes, and `execute()` for the advisory-lock statement.
 */
function combinedDb(readBackRows: unknown[] = []) {
  const writes: {
    inserted: Array<Record<string, unknown>>;
    deletedKeys: unknown[];
  } = { inserted: [], deletedKeys: [] };
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn((row: Record<string, unknown>) => {
    writes.inserted.push(row);
    return { onConflictDoUpdate };
  });
  const deleteWhere = vi.fn((cond: unknown) => {
    writes.deletedKeys.push(cond);
    return Promise.resolve(undefined);
  });
  const leftJoin = vi
    .fn()
    .mockReturnValue({ where: vi.fn().mockResolvedValue(readBackRows) });
  const from = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(readBackRows),
    leftJoin,
  });
  const select = vi.fn().mockReturnValue({ from });
  const db = {
    select,
    insert: vi.fn().mockReturnValue({ values }),
    delete: vi.fn().mockReturnValue({ where: deleteWhere }),
    execute: vi.fn().mockResolvedValue(undefined),
  };
  return { db, writes };
}

describe('setHiddenNavItem', () => {
  beforeEach(() => vi.resetModules());

  function storeFrom(db: unknown) {
    return loadStore({
      getDb: () => db,
      getConfigDb: () => db,
      inTransaction: (fn: () => unknown) => fn(),
    });
  }

  it('rejects an id the registry does not know, naming it, writing nothing', async () => {
    const { db } = combinedDb();
    const store = await storeFrom(db);
    await expect(
      store.setHiddenNavItem('gone.away', true, 1),
    ).rejects.toBeInstanceOf(store.UnknownNavItemError);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('adds an item to whatever the list currently holds, in registry order', async () => {
    const { db, writes } = combinedDb([
      { value: [NAV_ITEM_IDS[0]], updatedAt: null },
    ]);
    const store = await storeFrom(db);
    await store.setHiddenNavItem(NAV_ITEM_IDS[1], true, 42);
    expect(writes.inserted).toEqual([
      expect.objectContaining({
        key: 'nav.hiddenMenuItems',
        value: [NAV_ITEM_IDS[0], NAV_ITEM_IDS[1]],
        updatedBy: 42,
      }),
    ]);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('removes an item, deleting the row when nothing is left hidden', async () => {
    const { db } = combinedDb([{ value: [NAV_ITEM_IDS[0]], updatedAt: null }]);
    const store = await storeFrom(db);
    await store.setHiddenNavItem(NAV_ITEM_IDS[0], false, 42);
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.delete).toHaveBeenCalledTimes(1);
  });

  it('leaves other hidden items untouched when removing one', async () => {
    const { db, writes } = combinedDb([
      { value: [NAV_ITEM_IDS[0], NAV_ITEM_IDS[1]], updatedAt: null },
    ]);
    const store = await storeFrom(db);
    await store.setHiddenNavItem(NAV_ITEM_IDS[0], false, 42);
    expect(writes.inserted).toEqual([
      expect.objectContaining({ value: [NAV_ITEM_IDS[1]] }),
    ]);
  });

  it('takes the advisory lock before reading the current list', async () => {
    const { db } = combinedDb([{ value: [], updatedAt: null }]);
    const store = await storeFrom(db);
    await store.setHiddenNavItem(NAV_ITEM_IDS[0], true, 42);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('invalidates the cached read so the next load sees the change', async () => {
    const { db } = combinedDb([{ value: [NAV_ITEM_IDS[0]], updatedAt: null }]);
    const store = await loadStore({
      getDb: () => db,
      getConfigDb: () => db,
      withDbRetry: (fn: () => unknown) => fn(),
      inTransaction: (fn: () => unknown) => fn(),
    });

    await store.loadHiddenNavItems();
    const callsAfterFirstLoad = db.select.mock.calls.length;

    await store.loadHiddenNavItems();
    // Second load is served from cache — no further `select` call.
    expect(db.select.mock.calls.length).toBe(callsAfterFirstLoad);

    await store.setHiddenNavItem(NAV_ITEM_IDS[0], true, 42);
    const callsAfterWrite = db.select.mock.calls.length;
    expect(callsAfterWrite).toBeGreaterThan(callsAfterFirstLoad);

    await store.loadHiddenNavItems();
    // The write invalidated the cache, so this reaches the store again.
    expect(db.select.mock.calls.length).toBeGreaterThan(callsAfterWrite);
  });
});

describe('getHiddenNavItemsState', () => {
  beforeEach(() => vi.resetModules());

  it('reports nothing hidden and no provenance for an empty table', async () => {
    const leftJoin = vi.fn().mockReturnValue({ where: () => [] });
    const db = { select: vi.fn().mockReturnValue({ from: () => ({ leftJoin }) }) };
    const store = await loadStore({ getDb: () => db, getConfigDb: () => db });
    await expect(store.getHiddenNavItemsState()).resolves.toEqual({
      hiddenItems: [],
      updatedAt: null,
      updatedBy: null,
    });
  });

  it('carries provenance for a row that exists', async () => {
    const row = {
      value: [NAV_ITEM_IDS[0]],
      updatedAt: new Date('2026-08-01T10:00:00Z'),
      updatedById: 7,
      updatedByName: 'ada',
    };
    const leftJoin = vi.fn().mockReturnValue({ where: () => [row] });
    const db = { select: vi.fn().mockReturnValue({ from: () => ({ leftJoin }) }) };
    const store = await loadStore({ getDb: () => db, getConfigDb: () => db });
    const state = await store.getHiddenNavItemsState();
    expect(state).toMatchObject({
      hiddenItems: [NAV_ITEM_IDS[0]],
      updatedBy: { id: 7, username: 'ada' },
    });
    expect(state.updatedAt).toBe('2026-08-01T10:00:00.000Z');
  });
});
