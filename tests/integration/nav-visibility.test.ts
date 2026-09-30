import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { siteSettings } from '../../db/schema.js';
import {
  getHiddenNavItemsState,
  loadHiddenNavItems,
  resetHiddenNavItemsForTests,
  setHiddenNavItem,
  UnknownNavItemError,
} from '../../api/_lib/nav-visibility-store.js';
import { NAV_ITEM_IDS } from '../../src/lib/navItems.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  resetHiddenNavItemsForTests();
});

describe('nav visibility over real SQL', () => {
  it('starts with nothing hidden', async () => {
    expect(await db.select().from(siteSettings)).toHaveLength(0);
    expect(await loadHiddenNavItems()).toEqual([]);
  });

  it('hides an item and stores provenance', async () => {
    const actorId = await seedUser(db);

    const state = await setHiddenNavItem(NAV_ITEM_IDS[0]!, true, actorId);

    expect(state.hiddenItems).toEqual([NAV_ITEM_IDS[0]]);
    const [row] = await db
      .select()
      .from(siteSettings)
      .where(eq(siteSettings.key, 'nav.hiddenMenuItems'));
    expect(row).toMatchObject({
      value: [NAV_ITEM_IDS[0]],
      updatedBy: actorId,
    });
  });

  it('unhiding one item leaves another hidden item in place', async () => {
    const actorId = await seedUser(db);
    await setHiddenNavItem(NAV_ITEM_IDS[0]!, true, actorId);
    await setHiddenNavItem(NAV_ITEM_IDS[1]!, true, actorId);

    const state = await setHiddenNavItem(NAV_ITEM_IDS[0]!, false, actorId);

    expect(state.hiddenItems).toEqual([NAV_ITEM_IDS[1]]);
  });

  it('deletes the row once the last hidden item is unhidden', async () => {
    const actorId = await seedUser(db);
    await setHiddenNavItem(NAV_ITEM_IDS[0]!, true, actorId);

    await setHiddenNavItem(NAV_ITEM_IDS[0]!, false, actorId);

    expect(await db.select().from(siteSettings)).toHaveLength(0);
  });

  it('refuses an id the registry does not know and writes nothing', async () => {
    const actorId = await seedUser(db);
    await expect(
      setHiddenNavItem('gone.away', true, actorId),
    ).rejects.toBeInstanceOf(UnknownNavItemError);
    expect(await db.select().from(siteSettings)).toHaveLength(0);
  });

  it('invalidates the cache, so a read right after a write sees it', async () => {
    const actorId = await seedUser(db);
    expect(await loadHiddenNavItems()).toEqual([]);

    await setHiddenNavItem(NAV_ITEM_IDS[0]!, true, actorId);

    expect(await loadHiddenNavItems()).toEqual([NAV_ITEM_IDS[0]]);
  });

  /**
   * The regression #1316 exists for: two managers, each starting from an
   * independently loaded snapshot, hide *different* items at the same time.
   * A whole-list replace built from each manager's own stale snapshot would
   * have one PATCH silently overwrite the other's change. The single-item
   * toggle, serialized by the store's advisory lock, must apply both.
   */
  it('applies two concurrent toggles of different items from two managers', async () => {
    const managerA = await seedUser(db, {
      email: 'manager-a@example.com',
      username: 'manager-a',
    });
    const managerB = await seedUser(db, {
      email: 'manager-b@example.com',
      username: 'manager-b',
    });

    await Promise.all([
      setHiddenNavItem(NAV_ITEM_IDS[0]!, true, managerA),
      setHiddenNavItem(NAV_ITEM_IDS[1]!, true, managerB),
    ]);

    const state = await getHiddenNavItemsState();
    expect(state.hiddenItems).toEqual(
      [NAV_ITEM_IDS[0]!, NAV_ITEM_IDS[1]!].sort(
        (a, b) => NAV_ITEM_IDS.indexOf(a) - NAV_ITEM_IDS.indexOf(b),
      ),
    );
  });
});
