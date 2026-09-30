import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { bioEntities, drugReceptorTargets } from '../../db/schema.js';
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

// #791 Part B: the constraints that make the legacy enzymes / receptor_targets
// registries unreachable from the edge tables — bio_entity_id is mandatory on
// the PD edge table (step 2, 0074) and the legacy FK columns are gone (step 4,
// 0076). Exercised over real SQL so the DDL — not just the ORM types — is
// verified.
describe('bio_entities invariant constraints (#791 Part B)', () => {
  describe('drug_receptor_targets.bio_entity_id NOT NULL', () => {
    it('rejects a mechanism row without a bio_entity_id', async () => {
      const drugId = await seedDrug(db, { slug: 'rt-notnull' });
      // Raw insert to bypass the (now non-null) ORM insert type and hit the
      // database constraint directly.
      await expect(
        db.execute(sql`
          INSERT INTO drug_receptor_targets (drug_id, bio_entity_id, interaction_type)
          VALUES (${drugId}, NULL, 'agonist')
        `),
      ).rejects.toThrow();
    });

    it('accepts a mechanism row that carries a bio_entity_id', async () => {
      const drugId = await seedDrug(db, { slug: 'rt-ok' });
      const entityId = await seedBioEntity(db, { slug: 'rt-ok-entity' }, [
        'drug_target',
      ]);
      await db.insert(drugReceptorTargets).values({
        drugId,
        bioEntityId: entityId,
        interactionType: 'antagonist',
      });
      const rows = await db.select().from(drugReceptorTargets);
      expect(rows).toHaveLength(1);
    });
  });

  describe('drug_receptor_targets.bio_entity_id FK ON DELETE RESTRICT', () => {
    it('blocks deleting a bio_entity that a mechanism references', async () => {
      const drugId = await seedDrug(db, { slug: 'fk-restrict' });
      const entityId = await seedBioEntity(db, { slug: 'fk-restrict-entity' }, [
        'drug_target',
      ]);
      await db.insert(drugReceptorTargets).values({
        drugId,
        bioEntityId: entityId,
        interactionType: 'antagonist',
      });

      await expect(
        db.delete(bioEntities).where(eq(bioEntities.id, entityId)),
      ).rejects.toThrow();

      // The entity survives the blocked delete.
      const remaining = await db
        .select()
        .from(bioEntities)
        .where(eq(bioEntities.id, entityId));
      expect(remaining).toHaveLength(1);
    });

    it('allows deleting an unreferenced bio_entity', async () => {
      const entityId = await seedBioEntity(db, { slug: 'fk-free-entity' });
      await db.delete(bioEntities).where(eq(bioEntities.id, entityId));
      const remaining = await db.select().from(bioEntities);
      expect(remaining).toHaveLength(0);
    });
  });

  describe('legacy edge FK columns dropped (#791 Part B step 4)', () => {
    it('drug_elimination_routes no longer has enzyme_id', async () => {
      const r = await db.execute<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'drug_elimination_routes' AND column_name = 'enzyme_id'
      `);
      expect(r.rows).toHaveLength(0);
    });

    it('drug_receptor_targets no longer has receptor_target_id', async () => {
      const r = await db.execute<{ column_name: string }>(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'drug_receptor_targets' AND column_name = 'receptor_target_id'
      `);
      expect(r.rows).toHaveLength(0);
    });
  });
});
