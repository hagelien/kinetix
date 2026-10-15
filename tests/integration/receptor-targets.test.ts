import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drugReceptorTargets, wikiPages } from '../../db/schema.js';
import { getDb } from '../../api/_lib/db.js';
import {
  getDrugReceptorTargets,
  listEntityTargetLigands,
} from '../../api/_lib/receptorTargetStore.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedBioEntity, seedDrug, seedUser } from './setup/seed.js';

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

describe('receptor-target store — entity-side ligand lookup', () => {
  it('returns every relationship pointing at the entity, exactly as stored', async () => {
    const userId = await seedUser(db);
    const target = await seedBioEntity(
      db,
      { slug: 'oprm1', symbol: 'OPRM1', name: 'My-opioidreseptor' },
      ['drug_target'],
    );
    const unrelated = await seedBioEntity(db, {
      slug: 'oprk1',
      symbol: 'OPRK1',
      name: 'Kappa-opioidreseptor',
    });
    const morphine = await seedDrug(db, {
      slug: 'morfin',
      names: { nb: 'Morfin', en: 'Morphine' },
    });
    const buprenorphine = await seedDrug(db, {
      slug: 'buprenorfin',
      names: { nb: 'Buprenorfin' },
    });
    const naloxone = await seedDrug(db, {
      slug: 'nalokson',
      names: { nb: 'Nalokson' },
    });

    await db.insert(drugReceptorTargets).values([
      {
        drugId: naloxone,
        bioEntityId: target,
        interactionType: 'antagonist',
        // Qualitative only: no measurement, no species, no references.
      },
      {
        drugId: morphine,
        bioEntityId: target,
        interactionType: 'agonist',
        tier: 'primary',
        ki: { min: 1, max: 3, unit: 'nM', note: 'marsvinileum' },
        ec50: { median: 40, unit: 'nM' },
        assaySpecies: 'Homo sapiens',
        referenceIds: [101, 102],
        evidenceNote: 'Oppsummert fra to bindingsstudier.',
      },
      {
        drugId: buprenorphine,
        bioEntityId: target,
        interactionType: 'partial_agonist',
        ki: { median: 0.2, unit: 'nM' },
        ic50: { median: 1.1, unit: 'nM' },
        assaySpecies: 'Rattus norvegicus',
      },
      {
        // The same drug at a second target — must not surface.
        drugId: buprenorphine,
        bioEntityId: unrelated,
        interactionType: 'antagonist',
      },
    ]);

    // A published monograph is linked by slug; a draft one is not exposed by
    // this public read.
    await db.insert(wikiPages).values([
      {
        slug: 'morfin',
        title: 'Morfin',
        pageType: 'drug_monograph',
        drugCid: morphine,
        createdBy: userId,
        updatedBy: userId,
      },
      {
        slug: 'nalokson-utkast',
        title: 'Nalokson',
        pageType: 'drug_monograph',
        drugCid: naloxone,
        status: 'draft',
        createdBy: userId,
        updatedBy: userId,
      },
    ]);

    const ligands = await listEntityTargetLigands(getDb(), target);

    // Stable order: normalised interaction type, then drug slug. One row per
    // relationship — the monograph join adds none.
    expect(ligands.map((l) => [l.interactionType, l.drugSlug])).toEqual([
      ['agonist', 'morfin'],
      ['antagonist', 'nalokson'],
      ['partial_agonist', 'buprenorfin'],
    ]);

    const [morphineRow, naloxoneRow, buprenorphineRow] = ligands;
    expect(morphineRow).toMatchObject({
      drugId: morphine,
      drugNames: { nb: 'Morfin', en: 'Morphine' },
      drugMonographSlug: 'morfin',
      tier: 'primary',
      ki: { min: 1, max: 3, unit: 'nM', note: 'marsvinileum' },
      ec50: { median: 40, unit: 'nM' },
      ic50: null,
      assaySpecies: 'Homo sapiens',
      referenceIds: [101, 102],
      evidenceNote: 'Oppsummert fra to bindingsstudier.',
    });
    expect(naloxoneRow).toMatchObject({
      drugMonographSlug: null,
      ki: null,
      assaySpecies: null,
      referenceIds: [],
      evidenceNote: null,
      tier: null,
    });
    expect(buprenorphineRow).toMatchObject({
      ki: { median: 0.2, unit: 'nM' },
      ic50: { median: 1.1, unit: 'nM' },
      assaySpecies: 'Rattus norvegicus',
    });
    expect(new Set(ligands.map((l) => l.relationshipId)).size).toBe(3);
  });

  it('returns nothing for an entity no drug acts on', async () => {
    const entityId = await seedBioEntity(db, {
      slug: 'gpr55',
      symbol: 'GPR55',
      name: 'GPR55',
    });
    await expect(listEntityTargetLigands(getDb(), entityId)).resolves.toEqual([]);
  });
});
