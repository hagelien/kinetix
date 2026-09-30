import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drugEliminationRoutes, drugMetabolites } from '../../db/schema.js';
import { getDb, runInPoolTransaction } from '../../api/_lib/db.js';
import {
  getDrugMetabolism,
  listEntityMetabolismDrugs,
  replaceDrugMetabolism,
} from '../../api/_lib/metabolismStore.js';
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

describe('metabolism store — bio_entity resolution over real SQL (#791)', () => {
  it('writes an enzyme route against bio_entities and reads it back from the unified registry', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db, {
      slug: 'midazolam',
      names: { nb: 'Midazolam' },
    });
    const entityId = await seedBioEntity(
      db,
      { slug: 'cyp3a4', symbol: 'CYP3A4', name: 'Cytokrom P450 3A4' },
      ['metabolic_enzyme'],
    );

    // Mirror the production write path exactly: a pool transaction whose nested
    // getDb() resolves to the transaction client (here the harness seam).
    await runInPoolTransaction(() =>
      replaceDrugMetabolism(
        getDb(),
        drugId,
        {
          profile: {},
          routes: [
            { kind: 'enzyme', enzymeId: entityId, fraction: { median: 0.6 } },
          ],
          metabolites: [],
          precursors: [],
        },
        userId,
      ),
    );

    // Phase 7 stores the unified id in bio_entity_id (the legacy enzyme_id
    // column was dropped in #791 Part B step 4).
    const [routeRow] = await db
      .select()
      .from(drugEliminationRoutes)
      .where(eq(drugEliminationRoutes.drugId, drugId));
    expect(routeRow?.bioEntityId).toBe(entityId);

    const metabolism = await getDrugMetabolism(getDb(), drugId);
    expect(metabolism).not.toBeNull();
    expect(metabolism!.routes).toHaveLength(1);
    const route = metabolism!.routes[0]!;
    // The serialized catalog id and label come from bio_entities, not enzymes.
    expect(route.enzyme?.id).toBe(entityId);
    expect(route.enzyme?.symbol).toBe('CYP3A4');
    expect(route.enzyme?.name).toBe('Cytokrom P450 3A4');
  });
});

describe('metabolism store — entity-side drug lookup', () => {
  it('lists every drug routed through an entity, largest dose share first', async () => {
    const userId = await seedUser(db);
    const entityId = await seedBioEntity(
      db,
      { slug: 'cyp2c19', symbol: 'CYP2C19', name: 'Cytokrom P450 2C19' },
      ['metabolic_enzyme'],
    );
    const otherEntityId = await seedBioEntity(
      db,
      { slug: 'cyp2d6', symbol: 'CYP2D6', name: 'Cytokrom P450 2D6' },
      ['metabolic_enzyme'],
    );

    const diazepam = await seedDrug(db, {
      slug: 'diazepam',
      names: { nb: 'Diazepam' },
    });
    const omeprazole = await seedDrug(db, {
      slug: 'omeprazol',
      names: { nb: 'Omeprazol' },
    });
    const unknownShare = await seedDrug(db, {
      slug: 'citalopram',
      names: { nb: 'Citalopram' },
    });
    // Routed through a different entity — must not surface in the lookup.
    const codeine = await seedDrug(db, {
      slug: 'kodein',
      names: { nb: 'Kodein' },
    });

    for (const [drugId, enzymeId, fraction] of [
      [diazepam, entityId, { median: 0.33 }],
      [omeprazole, entityId, { median: 0.8 }],
      [unknownShare, entityId, null],
      [codeine, otherEntityId, { median: 0.9 }],
    ] as const) {
      await runInPoolTransaction(() =>
        replaceDrugMetabolism(
          getDb(),
          drugId,
          {
            profile: {},
            routes: [{ kind: 'enzyme', enzymeId, fraction }],
            metabolites: [],
            precursors: [],
          },
          userId,
        ),
      );
    }

    const linked = await listEntityMetabolismDrugs(getDb(), entityId);

    expect(linked.map((row) => row.drug.slug)).toEqual([
      'omeprazol', // 80%
      'diazepam', // 33%
      'citalopram', // share unknown — sorts last
    ]);
    expect(linked[0]?.drug.names).toEqual({ nb: 'Omeprazol' });
    expect(linked[1]?.fraction).toEqual({ min: null, median: 0.33, max: null });
    expect(linked[2]?.fraction).toBeNull();
  });

  it('returns nothing for an entity no drug routes through', async () => {
    const entityId = await seedBioEntity(db, {
      slug: 'ugt2b7',
      symbol: 'UGT2B7',
      name: 'UDP-glukuronosyltransferase 2B7',
    });
    await expect(listEntityMetabolismDrugs(getDb(), entityId)).resolves.toEqual(
      [],
    );
  });
});

/**
 * A metabolite link is identified by the substance it points at, not by the
 * string naming it. Cocaine's monograph listed "benzoylecgonin · inaktiv"
 * twice because the two rows spelled it differently, passed the name-keyed
 * unique index, and then both rendered as the linked drug's Norwegian name.
 */
describe('metabolism store — one link per substance (#1057)', () => {
  /**
   * The index a rejected write collided with. drizzle re-throws driver errors
   * wrapped in a "Failed query: …" Error whose `cause` carries the original,
   * so the constraint name is one link down the chain.
   */
  function violatedConstraint(err: unknown): string | null {
    for (let e: unknown = err; e != null; e = (e as { cause?: unknown }).cause) {
      const name = (e as { constraint?: unknown }).constraint;
      if (typeof name === 'string') return name;
    }
    return null;
  }

  async function seedCocaine(): Promise<{ cocaine: number; be: number }> {
    const cocaine = await seedDrug(db, {
      slug: 'kokain',
      names: { nb: 'Kokain', en: 'Cocaine' },
      pubchemCid: 446220,
    });
    const be = await seedDrug(db, {
      slug: 'benzoylecgonin',
      names: { nb: 'benzoylecgonin', en: 'Benzoylecgonine' },
      pubchemCid: 2337,
    });
    return { cocaine, be };
  }

  it('rejects a second row for a metabolite already linked under another spelling', async () => {
    const { cocaine, be } = await seedCocaine();
    await db.insert(drugMetabolites).values({
      parentDrugId: cocaine,
      metaboliteDrugId: be,
      metaboliteName: 'Benzoylecgonine',
      sortOrder: 0,
    });

    // Distinct names, so the pre-existing (parent, name) index waves it
    // through; the substance index added in 0099 is what stops it. Asserted on
    // the constraint name rather than the message — drizzle wraps the driver
    // error in its own "Failed query:" text, so a message match would pass on
    // any failure at all, including the insert simply being malformed.
    await expect(
      db.insert(drugMetabolites).values({
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'benzoylecgonin',
        sortOrder: 1,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        violatedConstraint(err) ===
        'drug_metabolites_parent_metabolite_drug_idx',
    );

    const rows = await db
      .select()
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, cocaine));
    expect(rows).toHaveLength(1);
  });

  it('still allows two different substances, and the same metabolite under two parents', async () => {
    const { cocaine, be } = await seedCocaine();
    const cocaethylene = await seedDrug(db, {
      slug: 'kokaetylen',
      names: { nb: 'kokaetylen', en: 'Cocaethylene' },
      pubchemCid: 6720,
    });

    await db.insert(drugMetabolites).values([
      {
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'benzoylecgonin',
        sortOrder: 0,
      },
      {
        parentDrugId: cocaine,
        metaboliteDrugId: cocaethylene,
        metaboliteName: 'kokaetylen',
        sortOrder: 1,
      },
      // Benzoylecgonine is a metabolite of cocaethylene too — a second row for
      // the same metabolite under a different parent, which the partial index
      // must not touch.
      {
        parentDrugId: cocaethylene,
        metaboliteDrugId: be,
        metaboliteName: 'benzoylecgonin',
        sortOrder: 0,
      },
    ]);

    const metabolism = await getDrugMetabolism(getDb(), be);
    expect(metabolism!.precursors.map((p) => p.drug?.slug)).toEqual([
      'kokain',
      'kokaetylen',
    ]);
  });

  it('leaves unresolved free-text links free to differ', async () => {
    const { cocaine } = await seedCocaine();
    // Two unlinked rows: nothing to key on, so only the name index applies and
    // both are kept — a substance with no monograph yet is still a real entry.
    await db.insert(drugMetabolites).values([
      { parentDrugId: cocaine, metaboliteName: 'Ecgonine', sortOrder: 0 },
      {
        parentDrugId: cocaine,
        metaboliteName: 'Ecgonine methyl ester',
        sortOrder: 1,
      },
    ]);
    const metabolism = await getDrugMetabolism(getDb(), cocaine);
    expect(metabolism!.metabolites).toHaveLength(2);
  });

  it('serves one entry for a legacy free-text duplicate of a linked metabolite', async () => {
    const { cocaine, be } = await seedCocaine();
    // The row shape 0099 cannot index away: one link resolved, one free-text
    // row spelling the same substance in another locale. Rows written before
    // the write-path check still look like this, so the read collapses them.
    await db.insert(drugMetabolites).values([
      {
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'Benzoylecgonine',
        activity: 'unknown',
        sortOrder: 0,
      },
      {
        parentDrugId: cocaine,
        metaboliteName: 'benzoylecgonin',
        activity: 'inactive',
        referenceIds: [],
        sortOrder: 1,
      },
    ]);

    const metabolism = await getDrugMetabolism(getDb(), cocaine);
    expect(metabolism!.metabolites).toHaveLength(1);
    expect(metabolism!.metabolites[0]!.drug?.id).toBe(be);
    expect(metabolism!.metabolites[0]!.activity).toBe('inactive');
  });

  it('serves a contradictory legacy pair as two entries, not a silent merge', async () => {
    const { cocaine, be } = await seedCocaine();
    await db.insert(drugMetabolites).values([
      {
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'Benzoylecgonine',
        activity: 'inactive',
        sortOrder: 0,
      },
      {
        parentDrugId: cocaine,
        metaboliteName: 'benzoylecgonin',
        activity: 'active',
        sortOrder: 1,
      },
    ]);

    // This payload is also what MetabolismEditForm loads, and a save from it
    // replaces the drug's links wholesale — so a merge that picked one of the
    // two activities would make the other's loss permanent the next time
    // anyone edited the box, with nothing having shown the disagreement.
    const metabolism = await getDrugMetabolism(getDb(), cocaine);
    expect(metabolism!.metabolites.map((m) => m.activity)).toEqual([
      'inactive',
      'active',
    ]);
  });

  it('refuses a write listing one metabolite twice, however it is spelled', async () => {
    const { cocaine, be } = await seedCocaine();
    const userId = await seedUser(db);

    await expect(
      runInPoolTransaction(() =>
        replaceDrugMetabolism(
          getDb(),
          cocaine,
          {
            profile: {},
            routes: [],
            metabolites: [
              {
                metaboliteName: 'Benzoylecgonine',
                metaboliteDrugId: be,
                activity: 'inactive',
              },
              {
                metaboliteName: 'benzoylecgonin',
                metaboliteDrugId: be,
                activity: 'inactive',
              },
            ],
            precursors: [],
          },
          userId,
        ),
      ),
    ).rejects.toThrow(/same substance/);

    // A free-text row spelling a linked row's drug is the same collision.
    await expect(
      runInPoolTransaction(() =>
        replaceDrugMetabolism(
          getDb(),
          cocaine,
          {
            profile: {},
            routes: [],
            metabolites: [
              {
                metaboliteName: 'Benzoylecgonine',
                metaboliteDrugId: be,
                activity: 'inactive',
              },
              { metaboliteName: 'benzoylecgonin', activity: 'inactive' },
            ],
            precursors: [],
          },
          userId,
        ),
      ),
    ).rejects.toThrow(/same substance/);

    const rows = await db
      .select()
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, cocaine));
    expect(rows).toEqual([]);
  });

  it('accepts a free-text row whose name two linked substances both answer to', async () => {
    const { cocaine, be } = await seedCocaine();
    // `drugs.names` has no cross-drug uniqueness: this drug's Norwegian name
    // is the other's English one. A free-text row spelling it names neither in
    // particular, so it must not be rejected as a duplicate of whichever the
    // index happened to see first.
    const other = await seedDrug(db, {
      slug: 'annet-stoff',
      names: { nb: 'Benzoylecgonine', en: 'Something else' },
      pubchemCid: 999,
    });
    const userId = await seedUser(db);

    await runInPoolTransaction(() =>
      replaceDrugMetabolism(
        getDb(),
        cocaine,
        {
          profile: {},
          routes: [],
          metabolites: [
            {
              metaboliteName: 'benzoylecgonin',
              metaboliteDrugId: be,
              activity: 'inactive',
            },
            {
              metaboliteName: 'Noe annet',
              metaboliteDrugId: other,
              activity: 'unknown',
            },
            { metaboliteName: 'Benzoylecgonine', activity: 'unknown' },
          ],
          precursors: [],
        },
        userId,
      ),
    );

    const rows = await db
      .select()
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, cocaine));
    expect(rows).toHaveLength(3);
  });

  it('refuses two different substances sharing one label, rather than 500ing', async () => {
    const { cocaine, be } = await seedCocaine();
    const other = await seedDrug(db, {
      slug: 'annet-stoff',
      names: { nb: 'Benzoylecgonine', en: 'Something else' },
      pubchemCid: 999,
    });
    const userId = await seedUser(db);

    // Two distinct substances, one label. They are not the same metabolite, so
    // the identity check passes them — but `metabolite_name` is unique per
    // drug, so storing both is impossible and the insert would 500.
    await expect(
      runInPoolTransaction(() =>
        replaceDrugMetabolism(
          getDb(),
          cocaine,
          {
            profile: {},
            routes: [],
            metabolites: [
              {
                metaboliteName: 'Benzoylecgonine',
                metaboliteDrugId: be,
                activity: 'inactive',
              },
              {
                metaboliteName: 'Benzoylecgonine',
                metaboliteDrugId: other,
                activity: 'unknown',
              },
            ],
            precursors: [],
          },
          userId,
        ),
      ),
    ).rejects.toThrow(/cannot share the name/);

    const rows = await db
      .select()
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, cocaine));
    expect(rows).toEqual([]);
  });

  it('refuses a write listing one precursor twice', async () => {
    const { cocaine, be } = await seedCocaine();
    const userId = await seedUser(db);

    await expect(
      runInPoolTransaction(() =>
        replaceDrugMetabolism(
          getDb(),
          be,
          {
            profile: {},
            routes: [],
            metabolites: [],
            precursors: [
              { precursorDrugId: cocaine, activity: 'inactive' },
              { precursorDrugId: cocaine, activity: 'unknown' },
            ],
          },
          userId,
        ),
      ),
    ).rejects.toThrow(/precursor may be listed once/);
  });
});
