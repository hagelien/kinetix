import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drugReceptorTargets } from '../../db/schema.js';
import { getDb } from '../../api/_lib/db.js';
import { getDrugReceptorTargets } from '../../api/_lib/receptorTargetStore.js';
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

describe('receptor-target store — bio_entity resolution over real SQL (#791)', () => {
  it('prefers the bio_entities identity when the edge row carries a bio_entity_id', async () => {
    const drugId = await seedDrug(db, {
      slug: 'haloperidol',
      names: { nb: 'Haloperidol' },
    });
    // The edge row references the catalog solely through bio_entity_id (the
    // legacy receptor_target_id column was dropped in #791 Part B step 4).
    const entityId = await seedBioEntity(
      db,
      { slug: 'drd2-bio', symbol: 'DRD2', name: 'Dopamin D2 (unified)' },
      ['drug_target'],
    );

    await db.insert(drugReceptorTargets).values({
      drugId,
      bioEntityId: entityId,
      interactionType: 'antagonist',
    });

    const targets = await getDrugReceptorTargets(getDb(), drugId);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.target.id).toBe(entityId);
    expect(targets[0]!.target.symbol).toBe('DRD2');
    expect(targets[0]!.target.name).toBe('Dopamin D2 (unified)');
    // The serialized catalog id follows the unified identity.
    expect(targets[0]!.receptorTargetId).toBe(entityId);
  });

  // #1017: a write path carrying a non-human assay species keeps the catalog
  // entity human and surfaces the species on the read model, so the monograph
  // can say "Ki 12 nM · Species: Rattus norvegicus" instead of presenting rat
  // data as human.
  it('round-trips the assay species without touching the catalog entity', async () => {
    const drugId = await seedDrug(db, {
      slug: 'kokain',
      names: { nb: 'Kokain' },
    });
    const entityId = await seedBioEntity(
      db,
      { slug: 'slc6a3-bio', symbol: 'SLC6A3', name: 'Dopamintransportør' },
      ['drug_target'],
    );

    await db.insert(drugReceptorTargets).values({
      drugId,
      bioEntityId: entityId,
      interactionType: 'inhibitor',
      assaySpecies: 'Rattus norvegicus',
    });

    const targets = await getDrugReceptorTargets(getDb(), drugId);
    expect(targets[0]!.assaySpecies).toBe('Rattus norvegicus');
    expect(targets[0]!.target.organism).toBe('Homo sapiens');
  });

  it('leaves the assay species null when nobody stated one', async () => {
    const drugId = await seedDrug(db, {
      slug: 'diazepam',
      names: { nb: 'Diazepam' },
    });
    const entityId = await seedBioEntity(
      db,
      { slug: 'gabra1-bio', symbol: 'GABRA1', name: 'GABA-A α1' },
      ['drug_target'],
    );

    await db.insert(drugReceptorTargets).values({
      drugId,
      bioEntityId: entityId,
      interactionType: 'positive_allosteric_modulator',
    });

    const targets = await getDrugReceptorTargets(getDb(), drugId);
    expect(targets[0]!.assaySpecies).toBeNull();
  });

  // The legacy-only (bio_entity_id null) shape is no longer reachable: #791 Part
  // B step 2 made drug_receptor_targets.bio_entity_id NOT NULL. See
  // bio-entity-invariant.test.ts for the constraint coverage.
});
