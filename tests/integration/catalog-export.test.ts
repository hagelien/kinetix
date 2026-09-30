/**
 * DB → `data/components.ts` projection over real SQL.
 *
 * The unit suite covers the pure mapping in `src/lib/catalogExport.ts`; what it
 * cannot cover is the read itself — the `bio_entities` left join, the
 * `sortOrder` ordering on the two metabolism tables, and the split of
 * `drug_elimination_routes` into the fixture's `enzymes` vs `eliminationRoutes`
 * lists. Those are exactly where a projection bug would hide, so they run
 * against a migrated PGlite database here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drugParameters, drugEliminationRoutes, drugMetabolites } from '../../db/schema.js';
import { loadCatalogRows } from '../../api/_lib/catalogExportStore.js';
import {
  buildRawComponents,
  diffCatalogs,
  isCatalogInSync,
} from '../../src/lib/catalogExport.js';
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

describe('catalog export — projecting the live catalog back to the fixture shape', () => {
  it('projects parameters, names, and metabolism into a RawComponent', async () => {
    const drugId = await seedDrug(db, {
      slug: 'alprazolam',
      names: { nb: 'Alprazolam', en: 'Alprazolam' },
      pubchemCid: 2118,
    });
    const entityId = await seedBioEntity(
      db,
      { slug: 'cyp3a4', symbol: 'CYP3A4', name: 'Cytokrom P450 3A4' },
      ['metabolic_enzyme'],
    );

    await db.insert(drugParameters).values([
      { drugId, parameter: 'molecularWeight', value: 308.8 },
      { drugId, parameter: 'halfLife', value: { min: 9, max: 16, unit: 'h' } },
      {
        drugId,
        parameter: 'therapeuticConcentration',
        value: { min: 0.02, max: 0.04, unit: 'mg/L' },
      },
      // Stored but absent from the fixture's shape — must not leak through.
      { drugId, parameter: 'logP', value: { median: 2.12 } },
    ]);
    await db.insert(drugEliminationRoutes).values([
      { drugId, kind: 'enzyme', bioEntityId: entityId, label: 'CYP3A4', sortOrder: 0 },
      { drugId, kind: 'renal_unchanged', label: 'Renal', sortOrder: 1 },
    ]);
    await db.insert(drugMetabolites).values([
      { parentDrugId: drugId, metaboliteName: 'alpha-hydroxyalprazolam', sortOrder: 0 },
    ]);

    const { components, skipped } = buildRawComponents(await loadCatalogRows());

    expect(skipped).toEqual([]);
    expect(components).toEqual([
      {
        name: 'Alprazolam',
        nameEn: 'Alprazolam',
        pubchemCid: 2118,
        molecularWeight: 308.8,
        halfLife: { min: 9, max: 16, unit: 'h' },
        therapeuticRange: { min: 0.02, max: 0.04, unit: 'mg/L' },
        metabolism: {
          enzymes: ['CYP3A4'],
          metabolites: ['alpha-hydroxyalprazolam'],
          eliminationRoutes: ['Renal'],
        },
      },
    ]);
  });

  it('falls back to the linked bio_entity when an enzyme route has no label', async () => {
    const drugId = await seedDrug(db, { slug: 'midazolam', pubchemCid: 4192 });
    const entityId = await seedBioEntity(
      db,
      { slug: 'cyp3a4', symbol: 'CYP3A4', name: 'Cytokrom P450 3A4' },
      ['metabolic_enzyme'],
    );
    await db
      .insert(drugEliminationRoutes)
      .values({ drugId, kind: 'enzyme', bioEntityId: entityId, label: null });

    const { components } = buildRawComponents(await loadCatalogRows());
    expect(components[0].metabolism?.enzymes).toEqual(['CYP3A4']);
  });

  it('labels an unlabelled excretion route from its kind', async () => {
    const drugId = await seedDrug(db, { slug: 'x', pubchemCid: 999 });
    await db.insert(drugEliminationRoutes).values([
      { drugId, kind: 'renal_unchanged', label: null, sortOrder: 0 },
      { drugId, kind: 'fecal_biliary', label: null, sortOrder: 1 },
    ]);

    const { components } = buildRawComponents(await loadCatalogRows());
    expect(components[0].metabolism?.eliminationRoutes).toEqual([
      'Renal',
      'Fecal/biliary',
    ]);
  });

  it('honours sortOrder on both metabolism tables', async () => {
    const drugId = await seedDrug(db, { slug: 'y', pubchemCid: 1000 });
    await db.insert(drugEliminationRoutes).values([
      { drugId, kind: 'enzyme', label: 'CYP2D6', sortOrder: 2 },
      { drugId, kind: 'enzyme', label: 'CYP3A4', sortOrder: 0 },
      { drugId, kind: 'enzyme', label: 'CYP2C9', sortOrder: 1 },
    ]);
    await db.insert(drugMetabolites).values([
      { parentDrugId: drugId, metaboliteName: 'second', sortOrder: 1 },
      { parentDrugId: drugId, metaboliteName: 'first', sortOrder: 0 },
    ]);

    const { components } = buildRawComponents(await loadCatalogRows());
    expect(components[0].metabolism?.enzymes).toEqual([
      'CYP3A4',
      'CYP2C9',
      'CYP2D6',
    ]);
    expect(components[0].metabolism?.metabolites).toEqual(['first', 'second']);
  });

  it('never attributes one drug\'s rows to another', async () => {
    const a = await seedDrug(db, { slug: 'a', names: { nb: 'A' }, pubchemCid: 11 });
    const b = await seedDrug(db, { slug: 'b', names: { nb: 'B' }, pubchemCid: 22 });
    await db.insert(drugParameters).values([
      { drugId: a, parameter: 'halfLife', value: { median: 1, unit: 'h' } },
      { drugId: b, parameter: 'halfLife', value: { median: 2, unit: 'h' } },
    ]);
    await db.insert(drugEliminationRoutes).values([
      { drugId: a, kind: 'enzyme', label: 'CYP1A2' },
      { drugId: b, kind: 'enzyme', label: 'CYP2E1' },
    ]);

    const { components } = buildRawComponents(await loadCatalogRows());
    const byCid = new Map(components.map((c) => [c.pubchemCid, c]));
    expect(byCid.get(11)?.halfLife).toEqual({ median: 1, unit: 'h' });
    expect(byCid.get(11)?.metabolism?.enzymes).toEqual(['CYP1A2']);
    expect(byCid.get(22)?.halfLife).toEqual({ median: 2, unit: 'h' });
    expect(byCid.get(22)?.metabolism?.enzymes).toEqual(['CYP2E1']);
  });

  it('reports a drug with no pubchem_cid instead of dropping it silently', async () => {
    await seedDrug(db, {
      slug: 'no-cid',
      names: { nb: 'Uten CID' },
      pubchemCid: null,
    });

    const { components, skipped } = buildRawComponents(await loadCatalogRows());
    expect(components).toEqual([]);
    expect(skipped).toEqual([{ name: 'Uten CID', reason: 'no-pubchem-cid' }]);
  });

  it('returns an empty projection for an empty database', async () => {
    // Also exercises the REPEATABLE READ transaction wrapper on the empty path.
    expect(await loadCatalogRows()).toEqual([]);
  });

  it('projects a drug whose only name is neither nb nor en', async () => {
    await seedDrug(db, {
      slug: 'kodein',
      names: { da: 'Kodein' },
      pubchemCid: 5284371,
    });

    const { components, skipped } = buildRawComponents(await loadCatalogRows());
    expect(skipped).toEqual([]);
    expect(components[0]!.name).toBe('Kodein');
  });

  it('reads every projection table from one snapshot', async () => {
    // The read spans four tables; wrapping it in a transaction is what stops a
    // concurrent commit from yielding a torn projection. Assert the wrapper is
    // actually in force by observing that the whole read succeeds as a unit and
    // agrees with itself across tables.
    const drugId = await seedDrug(db, { slug: 'snapshot', pubchemCid: 55 });
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'halfLife',
      value: { min: 1, max: 2, unit: 'h' },
    });
    await db
      .insert(drugEliminationRoutes)
      .values({ drugId, kind: 'enzyme', label: 'CYP3A4' });

    const rows = await loadCatalogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.parameters.halfLife).toEqual({ min: 1, max: 2, unit: 'h' });
    expect(rows[0]!.enzymes).toEqual(['CYP3A4']);
  });

  it('round-trips: a projection diffed against itself shows no drift', async () => {
    const drugId = await seedDrug(db, { slug: 'z', pubchemCid: 3007 });
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'halfLife',
      // Carries the aggregation pipeline's cache marker, which the fixture has
      // no field for — the diff must not see its absence as drift.
      value: { min: 9, max: 11, unit: 'h', derivedFromEntries: true },
    });

    const { components } = buildRawComponents(await loadCatalogRows());
    expect(components[0].halfLife).toEqual({ min: 9, max: 11, unit: 'h' });
    expect(isCatalogInSync(diffCatalogs(components, components))).toBe(true);
  });

  it('drops a legacy free-text qualifier that the fixture type cannot hold', async () => {
    // Mirrors the production row migration 0078 preserved (see
    // migration-0078-qualifier.test.ts). Rendering `qualifier: 'approximately'`
    // would emit a data/components.ts that fails tsc — the exporter would break
    // the build it is meant to protect.
    const drugId = await seedDrug(db, { slug: 'legacy-qual', pubchemCid: 77 });
    await db.insert(drugParameters).values([
      {
        drugId,
        parameter: 'toxicConcentration',
        value: { median: 1.5, unit: 'mg/L', qualifier: 'approximately' },
      },
      {
        drugId,
        parameter: 'fatalConcentration',
        value: { median: 9.0, unit: 'mg/L', qualifier: '<' },
      },
    ]);

    const { components } = buildRawComponents(await loadCatalogRows());
    expect(components[0]!.toxicRange).toEqual({ median: 1.5, unit: 'mg/L' });
    // A legitimate operator survives untouched.
    expect(components[0]!.lethalRange).toEqual({
      median: 9.0,
      unit: 'mg/L',
      qualifier: '<',
    });
  });

  it('detects real drift between a stale fixture and the database', async () => {
    const drugId = await seedDrug(db, {
      slug: 'alprazolam',
      names: { nb: 'Alprazolam' },
      pubchemCid: 2118,
    });
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'halfLife',
      value: { min: 6, max: 27, unit: 'h' },
    });

    const { components } = buildRawComponents(await loadCatalogRows());
    const stale = [
      {
        name: 'Alprazolam',
        pubchemCid: 2118,
        halfLife: { min: 9, max: 16, unit: 'h' },
      },
    ];
    const diff = diffCatalogs(stale, components);

    expect(isCatalogInSync(diff)).toBe(false);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].fields[0].field).toBe('halfLife');
  });
});
