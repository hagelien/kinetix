/**
 * Citation-visibility proof against the real migrated schema.
 *
 * `collectUsedCitationIdsForDrug` and `filterUsedCitationIds` are hand-written
 * SQL — table and column names are string literals the type checker never sees.
 * The unit suite (tests/api/citation-usage.test.ts) mocks `db.execute` outright,
 * so it asserts how the returned rows are folded into a Set and proves nothing
 * about whether the query runs. That gap let the queries keep selecting FROM
 * `reference_concentrations` after migration 0078 renamed it to
 * `parameter_entries`: every drug-scoped reference lookup failed with SQLSTATE
 * 42P01, the endpoint 500'd, and `fetchDrugReferences` swallows a non-OK
 * response as an empty list — so every monograph rendered with no bibliography
 * at all, and no error anywhere in the UI.
 *
 * Running the statements against PGlite with the committed migration chain
 * applied is the only thing that catches that class of drift.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  citations,
  drugEnzymeInteractions,
  drugMetabolismProfiles,
  drugMetabolites,
  drugParameterRevisions,
  drugReceptorTargets,
  parameterEntries,
} from '../../db/schema.js';
import { getDb } from '../../api/_lib/db.js';
import {
  collectReferenceUsage,
  collectUsedCitationIdsForDrug,
  filterUsedCitationIds,
} from '../../api/_lib/citation-usage.js';
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

async function seedCitation(identifier: string): Promise<number> {
  const [row] = await db
    .insert(citations)
    .values({ type: 'pmid', identifier })
    .returning({ id: citations.id });
  return row!.id;
}

describe('citation usage over real SQL', () => {
  it('runs the drug-scoped query against every table it names', async () => {
    // The regression itself: before the fix this threw 42P01 rather than
    // returning a set, and the caller turned that into an empty bibliography.
    const drugId = await seedDrug(db, { slug: 'venlafaxin' });
    await expect(
      collectUsedCitationIdsForDrug(getDb(), drugId),
    ).resolves.toBeInstanceOf(Set);
  });

  it('counts a citation anchored on a parameter entry', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db, { slug: 'venlafaxin' });
    const citationId = await seedCitation('37440364');
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'therapeuticConcentration',
      citationId,
      low: '0.11',
      high: '0.55',
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'therapeutic',
      createdBy: userId,
    });

    const used = await collectUsedCitationIdsForDrug(getDb(), drugId);
    expect(used.has(citationId)).toBe(true);
  });

  it('counts a citation anchored on a parameter revision', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db, { slug: 'venlafaxin' });
    const citationId = await seedCitation('9549664');
    await db.insert(drugParameterRevisions).values({
      drugId,
      parameter: 'halfLife',
      newValue: { median: 5, unit: 'h' },
      referenceIds: [citationId],
      createdBy: userId,
    });

    const used = await collectUsedCitationIdsForDrug(getDb(), drugId);
    expect(used.has(citationId)).toBe(true);
  });

  // The deep-research importer attaches a substantial share of a seeded drug's
  // sources to nothing but these rows. They render in the monograph sidebar
  // with numbered markers, so treating them as orphans hid real, cited content
  // from the bibliography and 404'd the marker's own link.
  it('counts citations anchored only on pharmacodynamic targets and metabolism', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db, { slug: 'venlafaxin' });
    const entityId = await seedBioEntity(
      db,
      { slug: 'cyp2d6', symbol: 'CYP2D6', name: 'Cytokrom P450 2D6' },
      ['drug_target', 'metabolic_enzyme'],
    );
    const targetRef = await seedCitation('16402124');
    const profileRef = await seedCitation('10192828');
    const metaboliteRef = await seedCitation('24128936');
    const enzymeRef = await seedCitation('23301719');

    await db.insert(drugReceptorTargets).values({
      drugId,
      bioEntityId: entityId,
      interactionType: 'reuptake_inhibitor',
      referenceIds: [targetRef],
      createdBy: userId,
      updatedBy: userId,
    });
    await db.insert(drugMetabolismProfiles).values({
      drugId,
      referenceIds: [profileRef],
      updatedBy: userId,
    });
    await db.insert(drugMetabolites).values({
      parentDrugId: drugId,
      metaboliteName: 'O-desmethylvenlafaxine',
      referenceIds: [metaboliteRef],
    });
    await db.insert(drugEnzymeInteractions).values({
      drugId,
      bioEntityId: entityId,
      role: 'substrate',
      referenceIds: [enzymeRef],
      createdBy: userId,
      updatedBy: userId,
    });

    const used = await collectUsedCitationIdsForDrug(getDb(), drugId);
    expect([...used].sort((a, b) => a - b)).toEqual(
      [targetRef, profileRef, metaboliteRef, enzymeRef].sort((a, b) => a - b),
    );

    // Same anchors resolve through the drug-less lookup the reference module
    // uses, so following a marker from the sidebar doesn't 404.
    const globallyVisible = await filterUsedCitationIds(getDb(), [
      targetRef,
      profileRef,
      metaboliteRef,
      enzymeRef,
    ]);
    expect(globallyVisible.size).toBe(4);
  });

  // getDrugMetabolism() reads the rows where a drug is the metabolite back as
  // that drug's `precursors`, so the junction row is rendered on both
  // monographs and is cited from both.
  it('counts a metabolite-junction citation from the precursor side too', async () => {
    const parentId = await seedDrug(db, { slug: 'venlafaxin' });
    const metaboliteId = await seedDrug(db, { slug: 'desvenlafaksin' });
    const citationId = await seedCitation('24128936');
    await db.insert(drugMetabolites).values({
      parentDrugId: parentId,
      metaboliteDrugId: metaboliteId,
      metaboliteName: 'O-desmethylvenlafaxine',
      referenceIds: [citationId],
    });

    await expect(
      collectUsedCitationIdsForDrug(getDb(), parentId),
    ).resolves.toContain(citationId);
    await expect(
      collectUsedCitationIdsForDrug(getDb(), metaboliteId),
    ).resolves.toContain(citationId);
  });

  // Visibility and attribution have to agree: a citation the bibliography shows
  // must be able to say where it is cited from. citations.drug_id points at
  // whichever drug created the row first (they are deduplicated globally on
  // type+identifier), so it cannot answer this on its own.
  it('attributes a target-only citation to the drug that cites it', async () => {
    const userId = await seedUser(db);
    const owningDrugId = await seedDrug(db, { slug: 'venlafaxin' });
    const unrelatedDrugId = await seedDrug(db, { slug: 'citalopram' });
    const entityId = await seedBioEntity(
      db,
      { slug: 'slc6a4', symbol: 'SLC6A4', name: 'Serotonintransportør' },
      ['drug_target'],
    );
    // The row is owned by an unrelated drug, exactly as a deduplicated citation
    // reused across drugs would be.
    const [citation] = await db
      .insert(citations)
      .values({ type: 'pmid', identifier: '16402124', drugId: unrelatedDrugId })
      .returning({ id: citations.id });
    await db.insert(drugReceptorTargets).values({
      drugId: owningDrugId,
      bioEntityId: entityId,
      interactionType: 'reuptake_inhibitor',
      referenceIds: [citation!.id],
      createdBy: userId,
      updatedBy: userId,
    });

    const usage = await collectReferenceUsage(getDb(), citation!.id);
    const drugIds = usage
      .filter((u) => u.kind === 'drug')
      .map((u) => u.id)
      .sort((a, b) => a - b);
    expect(drugIds).toEqual(
      [owningDrugId, unrelatedDrugId].sort((a, b) => a - b),
    );
  });

  it('attributes a metabolism citation to both ends of the junction', async () => {
    const parentId = await seedDrug(db, { slug: 'venlafaxin' });
    const metaboliteId = await seedDrug(db, { slug: 'desvenlafaksin' });
    const citationId = await seedCitation('10192828');
    await db.insert(drugMetabolites).values({
      parentDrugId: parentId,
      metaboliteDrugId: metaboliteId,
      metaboliteName: 'O-desmethylvenlafaxine',
      referenceIds: [citationId],
    });

    const usage = await collectReferenceUsage(getDb(), citationId);
    expect(
      usage
        .filter((u) => u.kind === 'drug')
        .map((u) => u.id)
        .sort((a, b) => a - b),
    ).toEqual([parentId, metaboliteId].sort((a, b) => a - b));
  });

  it('still hides a citation anchored nowhere', async () => {
    const drugId = await seedDrug(db, { slug: 'venlafaxin' });
    const orphan = await seedCitation('99999999');

    const used = await collectUsedCitationIdsForDrug(getDb(), drugId);
    expect(used.has(orphan)).toBe(false);
    await expect(filterUsedCitationIds(getDb(), [orphan])).resolves.toEqual(
      new Set(),
    );
  });

  it('does not leak another drug’s anchors into the drug-scoped set', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db, { slug: 'venlafaxin' });
    const otherDrugId = await seedDrug(db, { slug: 'citalopram' });
    const otherRef = await seedCitation('28910830');
    await db.insert(drugParameterRevisions).values({
      drugId: otherDrugId,
      parameter: 'halfLife',
      newValue: { median: 35, unit: 'h' },
      referenceIds: [otherRef],
      createdBy: userId,
    });

    const used = await collectUsedCitationIdsForDrug(getDb(), drugId);
    expect(used.has(otherRef)).toBe(false);
  });
});
