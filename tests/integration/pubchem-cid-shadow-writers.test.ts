/**
 * The PubChem CID shadow check on every writer that sets a CID on a drug
 * (#219, following #218).
 *
 * A saved simulator case keys a CID-less drug by its bare `drugs.id`, and
 * `hydrateComponentByRouteId` resolves a bare number CID-first — so a drug
 * that takes a CID equal to another CID-less drug's id makes that drug's
 * legacy cases load the newcomer. #218 refused that on PATCH /api/drugs and
 * the parameter edit; drug creation (`insertDrug`) and the research import
 * (new drug, and the first-CID backfill of a name-matched drug) still wrote
 * the number unchecked. These run the real SQL against PGlite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { citations, drugs, simulatorCases } from '../../db/schema.js';
import {
  assertPubchemCidWritable,
  findPubchemCidShadows,
  insertDrug,
  ParameterApplyError,
} from '../../api/_lib/drugs-helpers.js';
import { parseResearchOutput } from '../../src/lib/deepResearchImport.js';
import { runImport } from '../../api/_lib/researchImportStore.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let userId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  userId = await seedUser(db, {
    email: 'importer@example.com',
    username: 'importer',
    role: 'admin',
  });
});

/** A CID-less drug; ids restart at 1 per test, so the first one is drug 1. */
async function seedCidLess(slug: string, nb: string): Promise<number> {
  return seedDrug(db, { slug, names: { nb }, pubchemCid: null });
}

async function drugRow(id: number) {
  const [row] = await db
    .select({ pubchemCid: drugs.pubchemCid, source: drugs.source })
    .from(drugs)
    .where(eq(drugs.id, id));
  return row;
}

async function drugCount(): Promise<number> {
  return (await db.select({ id: drugs.id }).from(drugs)).length;
}

function researchDoc(pubchemCid: number) {
  const parsed = parseResearchOutput({
    schemaVersion: 'kinetix-deep-research-output-v1',
    drugIdentity: { names: { nb: 'Kokain', en: 'Cocaine' }, pubchemCid },
    kinetixParameterValues: [
      {
        parameter: 'halfLife',
        status: 'finalized',
        value: { min: 0.7, max: 1.7, unit: 'h' },
        sourceIds: ['S1'],
      },
    ],
    sources: [{ sourceId: 'S1', citationType: 'pmid', pmid: '29462364' }],
  });
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.data;
}

const SHADOW = { statusHint: 409, code: 'pubchem_cid_shadows_drug_id' };

describe('findPubchemCidShadows / assertPubchemCidWritable on real SQL', () => {
  it('names only CID-less drugs, and never the taker itself', async () => {
    const cidLess = await seedCidLess('annet-stoff', 'Annet stoff');
    const withCid = await seedDrug(db, {
      slug: 'med-cid',
      names: { nb: 'Med CID' },
      pubchemCid: 2118,
    });

    expect(await findPubchemCidShadows([cidLess, withCid, 999], null)).toEqual([
      cidLess,
    ]);
    // The drug taking its own id as a CID shadows nothing: its cases follow it.
    expect(await findPubchemCidShadows([cidLess], cidLess)).toEqual([]);
    await expect(assertPubchemCidWritable(cidLess, cidLess)).resolves.toBeUndefined();
  });

  it('refuses another drug a first CID equal to the CID-less drug\'s id, until that drug has its own', async () => {
    const shadowed = await seedCidLess('annet-stoff', 'Annet stoff');
    const taker = await seedCidLess('kokain', 'Kokain');

    await expect(assertPubchemCidWritable(taker, shadowed)).rejects.toMatchObject(
      SHADOW,
    );

    await db.update(drugs).set({ pubchemCid: 5555 }).where(eq(drugs.id, shadowed));
    await expect(assertPubchemCidWritable(taker, shadowed)).resolves.toBeUndefined();
  });

  it('keeps refusing it after the drug gets a CID, while cases saved under its bare id remain', async () => {
    // Codex on #261: a first CID does not rewrite the cases saved under the
    // drug's id before it, and those resolve CID-first — to whoever takes the
    // number next.
    const shadowed = await seedCidLess('annet-stoff', 'Annet stoff');
    const taker = await seedCidLess('kokain', 'Kokain');
    const [legacyCase] = await db
      .insert(simulatorCases)
      .values({
        name: 'Gammel sak',
        caseData: { drugs: [{ drugId: String(shadowed) }] },
        createdBy: userId,
      })
      .returning({ id: simulatorCases.id });
    await db.update(drugs).set({ pubchemCid: 5555 }).where(eq(drugs.id, shadowed));

    expect(await findPubchemCidShadows([shadowed], taker)).toEqual([shadowed]);
    await expect(assertPubchemCidWritable(taker, shadowed)).rejects.toMatchObject(SHADOW);
    await expect(
      insertDrug({ names: { nb: 'Ny' } as never, pubchemCid: shadowed }),
    ).rejects.toMatchObject(SHADOW);

    // A case keyed by the drug's new CID, or by `drug:<id>`, does not hold the id.
    await db
      .update(simulatorCases)
      .set({ caseData: { drugs: [{ drugId: '5555' }, { drugId: `drug:${shadowed}` }] } })
      .where(eq(simulatorCases.id, legacyCase!.id));
    expect(await findPubchemCidShadows([shadowed], taker)).toEqual([]);
    await expect(assertPubchemCidWritable(taker, shadowed)).resolves.toBeUndefined();
  });
});

describe('insertDrug', () => {
  it('refuses a CID equal to a CID-less drug\'s id and writes nothing', async () => {
    const shadowed = await seedCidLess('annet-stoff', 'Annet stoff');
    const before = await drugCount();

    const err = await insertDrug({
      names: { nb: 'Kokain' } as never,
      pubchemCid: shadowed,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ParameterApplyError);
    expect(err).toMatchObject(SHADOW);
    expect(await drugCount()).toBe(before);
  });

  it('inserts a CID that shadows nothing', async () => {
    await seedCidLess('annet-stoff', 'Annet stoff');
    const row = await insertDrug({
      names: { nb: 'Kokain' } as never,
      pubchemCid: 446220,
    });
    expect(row.pubchemCid).toBe(446220);
  });

  it('inserts a CID equal to a drug id once that drug carries its own CID', async () => {
    const other = await seedDrug(db, {
      slug: 'annet-stoff',
      names: { nb: 'Annet stoff' },
      pubchemCid: 5555,
    });
    const row = await insertDrug({
      names: { nb: 'Kokain' } as never,
      pubchemCid: other,
    });
    expect(row.pubchemCid).toBe(other);
  });
});

describe('research import', () => {
  it('refuses a new drug whose CID shadows a CID-less drug, before writing anything', async () => {
    const shadowed = await seedCidLess('annet-stoff', 'Annet stoff');
    const before = await drugCount();

    const err = await runImport(db, researchDoc(shadowed), {
      userId,
      overwrite: false,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ParameterApplyError);
    expect(err).toMatchObject(SHADOW);
    expect(await drugCount()).toBe(before);
    expect(await db.select({ id: citations.id }).from(citations)).toHaveLength(0);
  });

  it('refuses the first-CID backfill of a name-matched drug when it would shadow, leaving the drug untouched', async () => {
    const shadowed = await seedCidLess('annet-stoff', 'Annet stoff');
    const matched = await seedDrug(db, {
      slug: 'kokain',
      names: { nb: 'Kokain', en: 'Cocaine' },
      searchKey: 'kokain\tcocaine',
      pubchemCid: null,
    });

    const err = await runImport(db, researchDoc(shadowed), {
      userId,
      overwrite: false,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ParameterApplyError);
    expect(err).toMatchObject(SHADOW);
    expect(await drugRow(matched)).toEqual({ pubchemCid: null, source: null });
    expect(await db.select({ id: citations.id }).from(citations)).toHaveLength(0);
  });

  it('backfills a first CID that shadows nothing', async () => {
    await seedCidLess('annet-stoff', 'Annet stoff');
    const matched = await seedDrug(db, {
      slug: 'kokain',
      names: { nb: 'Kokain', en: 'Cocaine' },
      searchKey: 'kokain\tcocaine',
      pubchemCid: null,
    });

    const stats = await runImport(db, researchDoc(446220), {
      userId,
      overwrite: false,
    });

    expect(stats.drugId).toBe(matched);
    expect(stats.drugCreated).toBe(false);
    expect(await drugRow(matched)).toEqual({
      pubchemCid: 446220,
      source: 'deep-research',
    });
  });

  it('keeps a matched drug\'s existing CID without refusing, as the fill-if-empty backfill always did', async () => {
    const shadowed = await seedCidLess('annet-stoff', 'Annet stoff');
    const matched = await seedDrug(db, {
      slug: 'kokain',
      names: { nb: 'Kokain', en: 'Cocaine' },
      searchKey: 'kokain\tcocaine',
      pubchemCid: 446220,
    });

    // The document claims the shadowing number, but nothing will write it:
    // the drug already has a CID, and moving one is retarget:cid's job.
    const stats = await runImport(db, researchDoc(shadowed), {
      userId,
      overwrite: false,
    });

    expect(stats.drugId).toBe(matched);
    expect((await drugRow(matched))?.pubchemCid).toBe(446220);
  });
});
