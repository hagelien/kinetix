import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bioEntities, wikiPages } from '../../db/schema.js';
import {
  ENTITY_HUB_SLUG,
  ensureAllEntityMonographs,
  ensureEntityMonograph,
} from '../../api/_lib/monograph-helpers.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedBioEntity, seedUser } from './setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
});

async function hubPages() {
  return db
    .select({ id: wikiPages.id, title: wikiPages.title })
    .from(wikiPages)
    .where(eq(wikiPages.slug, ENTITY_HUB_SLUG));
}

describe('entity monographs hang under the Bioentiteter hub', () => {
  it('creates the hub once and files new monographs under it', async () => {
    const user = await seedUser(db);
    const a = await seedBioEntity(db, { slug: 'cyp2d6', symbol: 'CYP2D6' });
    const b = await seedBioEntity(db, { slug: 'oprm1', symbol: 'OPRM1' });

    const { page: pa } = await ensureEntityMonograph(
      db,
      { id: a, symbol: 'CYP2D6', name: 'Cytokrom P450 2D6' },
      user,
    );
    const { page: pb } = await ensureEntityMonograph(
      db,
      { id: b, symbol: 'OPRM1', name: 'My-opioidreseptor' },
      user,
    );

    const hubs = await hubPages();
    expect(hubs).toHaveLength(1);
    expect(hubs[0]!.title).toBe('Bioentiteter');

    const children = await db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(eq(wikiPages.parentId, hubs[0]!.id));
    expect(children.map((c) => c.id).sort()).toEqual([pa.id, pb.id].sort());
  });

  it('reuses a hand-made hub and leaves deliberately placed pages alone', async () => {
    const user = await seedUser(db);
    const [hub] = await db
      .insert(wikiPages)
      .values({
        slug: ENTITY_HUB_SLUG,
        title: 'Bioentiteter',
        pageType: 'topic',
        createdBy: user,
        updatedBy: user,
      })
      .returning({ id: wikiPages.id });
    const [elsewhere] = await db
      .insert(wikiPages)
      .values({
        slug: 'cyp-enzymer',
        title: 'CYP-enzymer',
        pageType: 'topic',
        createdBy: user,
        updatedBy: user,
      })
      .returning({ id: wikiPages.id });

    const stray = await seedBioEntity(db, { slug: 'cyp2c18', symbol: 'CYP2C18' });
    const placed = await seedBioEntity(db, { slug: 'cyp2c9', symbol: 'CYP2C9' });
    const missing = await seedBioEntity(db, { slug: 'abcb1', symbol: 'ABCB1' });
    await db.insert(wikiPages).values([
      {
        slug: 'cytochrome-p450-2c18',
        title: 'Cytochrome P450 2C18',
        pageType: 'entity_monograph',
        entityId: stray,
        createdBy: user,
        updatedBy: user,
      },
      {
        slug: 'cyp2c9',
        title: 'CYP2C9',
        pageType: 'entity_monograph',
        entityId: placed,
        parentId: elsewhere!.id,
        createdBy: user,
        updatedBy: user,
      },
    ]);

    const result = await ensureAllEntityMonographs(db, user);
    expect(await hubPages()).toHaveLength(1);

    const pages = await db
      .select({ entityId: wikiPages.entityId, parentId: wikiPages.parentId })
      .from(wikiPages)
      .where(eq(wikiPages.pageType, 'entity_monograph'));
    const parentOf = new Map(pages.map((p) => [p.entityId, p.parentId]));
    expect(parentOf.get(stray)).toBe(hub!.id);
    expect(parentOf.get(missing)).toBe(hub!.id);
    expect(parentOf.get(placed)).toBe(elsewhere!.id);

    // Every entity in the catalog now has a monograph.
    const entities = await db.select({ id: bioEntities.id }).from(bioEntities);
    expect(pages).toHaveLength(entities.length);
    expect(result.adopted).toBe(1);
    expect(result.created).toBe(entities.length - 2);

    // A second sweep has nothing left to do.
    expect(await ensureAllEntityMonographs(db, user)).toEqual({
      created: 0,
      adopted: 0,
    });
  });
});
