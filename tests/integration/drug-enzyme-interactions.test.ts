import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bioEntities, drugEnzymeInteractions, drugs } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedBioEntity, seedDrug } from './setup/seed.js';

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

// drug_enzyme_interactions (#785 Phase 6) is the newest edge table and the one
// the mocked unit suite can't cover — its unique index and FK cascades only
// exist in real SQL.
describe('drug_enzyme_interactions — constraints over real SQL (#791)', () => {
  it('enforces the (drug_id, bio_entity_id, role) unique index', async () => {
    const drugId = await seedDrug(db, { slug: 'ritonavir' });
    const entityId = await seedBioEntity(
      db,
      { slug: 'cyp3a4-ddi', symbol: 'CYP3A4' },
      ['metabolic_enzyme'],
    );

    await db
      .insert(drugEnzymeInteractions)
      .values({ drugId, bioEntityId: entityId, role: 'inhibitor' });

    // Same (drug, entity, role) → unique violation.
    await expect(
      db
        .insert(drugEnzymeInteractions)
        .values({ drugId, bioEntityId: entityId, role: 'inhibitor' }),
    ).rejects.toThrow();

    // A different role for the same pair is allowed.
    await db
      .insert(drugEnzymeInteractions)
      .values({ drugId, bioEntityId: entityId, role: 'inducer' });

    const rows = await db
      .select()
      .from(drugEnzymeInteractions)
      .where(eq(drugEnzymeInteractions.drugId, drugId));
    expect(rows).toHaveLength(2);
  });

  it('rejects an interaction whose bio_entity_id has no catalog row (FK)', async () => {
    const drugId = await seedDrug(db, { slug: 'orphan-fk' });
    await expect(
      db
        .insert(drugEnzymeInteractions)
        .values({ drugId, bioEntityId: 9999, role: 'substrate' }),
    ).rejects.toThrow();
  });

  it('cascades the interaction away when its bio_entity is deleted', async () => {
    const drugId = await seedDrug(db, { slug: 'cascade-entity' });
    const entityId = await seedBioEntity(db, { slug: 'ent-cascade', symbol: 'ENT' });
    await db
      .insert(drugEnzymeInteractions)
      .values({ drugId, bioEntityId: entityId, role: 'inhibitor' });

    await db.delete(bioEntities).where(eq(bioEntities.id, entityId));

    const remaining = await db.select().from(drugEnzymeInteractions);
    expect(remaining).toHaveLength(0);
  });

  it('cascades the interaction away when its drug is deleted', async () => {
    const drugId = await seedDrug(db, { slug: 'cascade-drug' });
    const entityId = await seedBioEntity(db, { slug: 'ent-drug', symbol: 'ENT2' });
    await db
      .insert(drugEnzymeInteractions)
      .values({ drugId, bioEntityId: entityId, role: 'substrate' });

    await db.delete(drugs).where(eq(drugs.id, drugId));

    const remaining = await db.select().from(drugEnzymeInteractions);
    expect(remaining).toHaveLength(0);
  });
});
