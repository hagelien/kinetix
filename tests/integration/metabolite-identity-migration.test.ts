/**
 * Migration 0099 — collapse metabolite links that name one substance twice.
 *
 * The migration's own pass ran against an empty database, so the interesting
 * half — merging the duplicates a live catalog already holds before the unique
 * index can exist — leaves nothing to observe there. These tests recreate the
 * pre-0099 world (drop the index, insert the rows it now forbids) and re-run
 * the real statements out of the .sql file, the same approach as the 0087 and
 * 0078 tests, so the merge cannot drift from what ships.
 *
 * What is being protected: the extra rows are *deleted*, so anything only the
 * later row carried — a conversion fraction, an evidence note, its citations —
 * has to move to the survivor first or it is gone for good.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { drugMetabolites } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug } from './setup/seed.js';

let db: IntegrationDb;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  HERE,
  '../../drizzle/0099_metabolite_substance_identity.sql',
);
const INDEX = 'drug_metabolites_parent_metabolite_drug_idx';

/**
 * Every statement of the real migration, in order. Comment-only chunks (the
 * header) are dropped: `execute` sends one command, and a comment is none.
 */
async function runMigration(): Promise<void> {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.replace(/^--.*$/gm, '').trim().length > 0);
  // Two, not three: the fold and the delete are deliberately one statement,
  // because each chunk commits separately under the neon-http migrator.
  expect(statements).toHaveLength(2);
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

/** Put the table back the way it looked before 0099. */
async function dropSubstanceIndex(): Promise<void> {
  await db.execute(sql.raw(`DROP INDEX IF EXISTS "${INDEX}"`));
}

async function indexExists(): Promise<boolean> {
  const rows = await db.execute<{ indexname: string }>(sql`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'drug_metabolites' AND indexname = ${INDEX}
  `);
  return (Array.isArray(rows) ? rows : (rows as { rows: unknown[] }).rows)
    .length === 1;
}

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  await dropSubstanceIndex();
});

describe('0099 — merging duplicate metabolite links', () => {
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

  it('keeps the first-listed row and absorbs what only the others carried', async () => {
    const { cocaine, be } = await seedCocaine();
    await db.insert(drugMetabolites).values([
      {
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'Benzoylecgonine',
        activity: 'unknown',
        referenceIds: [11],
        sortOrder: 0,
      },
      {
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'benzoylecgonin',
        activity: 'inactive',
        conversionFractionMin: '0.3000',
        conversionFractionMax: '0.5000',
        evidenceNote: 'major urinary metabolite',
        referenceIds: [12],
        sortOrder: 1,
      },
    ]);

    await runMigration();

    const rows = await db
      .select()
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, cocaine));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Position and label are the survivor's…
    expect(row.metaboliteName).toBe('Benzoylecgonine');
    expect(row.sortOrder).toBe(0);
    // …everything the dropped row alone held moved across.
    expect(row.activity).toBe('inactive');
    expect(Number(row.conversionFractionMin)).toBe(0.3);
    expect(Number(row.conversionFractionMax)).toBe(0.5);
    expect(row.evidenceNote).toBe('major urinary metabolite');
    expect(row.referenceIds).toEqual([11, 12]);
  });

  it('unlinks a disagreeing duplicate instead of folding or deleting it', async () => {
    const { cocaine, be } = await seedCocaine();
    await db.insert(drugMetabolites).values([
      {
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'Benzoylecgonine',
        activity: 'inactive',
        conversionFraction: '0.4000',
        evidenceNote: 'curated',
        referenceIds: [11],
        sortOrder: 0,
      },
      {
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'benzoylecgonin',
        activity: 'active',
        conversionFraction: '0.9000',
        evidenceNote: 'imported',
        referenceIds: [12],
        sortOrder: 1,
      },
    ]);

    await runMigration();

    const rows = await db
      .select()
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, cocaine))
      .orderBy(asc(drugMetabolites.sortOrder));
    expect(rows).toHaveLength(2);

    // The survivor is untouched — and critically keeps only ITS OWN citation.
    // Reference ids are the evidence for the claim on their own row, so
    // handing the 'active' row's paper to the kept 'inactive' row would make
    // it appear to support a conclusion it argues against.
    expect(rows[0]!.activity).toBe('inactive');
    expect(Number(rows[0]!.conversionFraction)).toBe(0.4);
    expect(rows[0]!.evidenceNote).toBe('curated');
    expect(rows[0]!.referenceIds).toEqual([11]);

    // The disagreeing row survives whole, merely dropped out of the index's
    // reach, so its claim and its own source stay on the record.
    expect(rows[1]!.metaboliteDrugId).toBeNull();
    expect(rows[1]!.activity).toBe('active');
    expect(Number(rows[1]!.conversionFraction)).toBe(0.9);
    expect(rows[1]!.evidenceNote).toBe('imported');
    expect(rows[1]!.referenceIds).toEqual([12]);

    // And it stays that way: unlinked, it is not a duplicate any more, so a
    // re-run neither sees it nor touches it.
    await runMigration();
    expect(
      await db
        .select()
        .from(drugMetabolites)
        .where(eq(drugMetabolites.parentDrugId, cocaine)),
    ).toHaveLength(2);
  });

  it('moves nothing at all in a group where any row disagrees', async () => {
    const { cocaine, be } = await seedCocaine();
    await db.insert(drugMetabolites).values([
      {
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'Benzoylecgonine',
        activity: 'inactive',
        referenceIds: [11],
        sortOrder: 0,
      },
      // On its own this row would fold in — it states nothing the survivor
      // contradicts. But the group it belongs to disagrees with itself, and
      // resolution is all-or-nothing per group.
      {
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'benzoylecgonin',
        activity: 'unknown',
        evidenceNote: 'major urinary metabolite',
        referenceIds: [12],
        sortOrder: 1,
      },
      {
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'benzoylecgonin (BE)',
        activity: 'active',
        referenceIds: [13],
        sortOrder: 2,
      },
    ]);

    await runMigration();

    const rows = await db
      .select()
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, cocaine))
      .orderBy(asc(drugMetabolites.sortOrder));
    expect(rows).toHaveLength(3);
    // Every row keeps its own claim and its own citation; only the link that
    // the index cannot accommodate is given up.
    expect(rows.map((r) => r.metaboliteDrugId)).toEqual([be, null, null]);
    expect(rows.map((r) => r.referenceIds)).toEqual([[11], [12], [13]]);
    expect(rows[0]!.evidenceNote).toBeNull();
    expect(rows[1]!.evidenceNote).toBe('major urinary metabolite');
  });

  it('takes a conversion range from one row, never a column at a time', async () => {
    const { cocaine, be } = await seedCocaine();
    await db.insert(drugMetabolites).values([
      {
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'Benzoylecgonine',
        conversionFraction: '0.8000',
        sortOrder: 0,
      },
      {
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'benzoylecgonin',
        conversionFractionMin: '0.2000',
        conversionFractionMax: '0.5000',
        sortOrder: 1,
      },
    ]);

    await runMigration();

    const rows = await db
      .select()
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, cocaine))
      .orderBy(asc(drugMetabolites.sortOrder));
    // The three columns are one 0–1 range. Filling each from the first row
    // that has it would produce min 0.2 / median 0.8 / max 0.5 — a median
    // outside its own bounds, a contradiction no write path can produce.
    expect(Number(rows[0]!.conversionFraction)).toBe(0.8);
    expect(rows[0]!.conversionFractionMin).toBeNull();
    expect(rows[0]!.conversionFractionMax).toBeNull();
    // Two ranges that disagree are a conflict, so the second is unlinked
    // rather than folded away.
    expect(rows[1]!.metaboliteDrugId).toBeNull();
    expect(Number(rows[1]!.conversionFractionMin)).toBe(0.2);
  });

  it('hands a whole range over when the group agrees about it', async () => {
    const { cocaine, be } = await seedCocaine();
    await db.insert(drugMetabolites).values([
      {
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'Benzoylecgonine',
        sortOrder: 0,
      },
      {
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'benzoylecgonin',
        conversionFractionMin: '0.2000',
        conversionFractionMax: '0.5000',
        referenceIds: [12],
        sortOrder: 1,
      },
    ]);

    await runMigration();

    const rows = await db
      .select()
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, cocaine));
    expect(rows).toHaveLength(1);
    // All three columns arrive together, and the citation that backs them
    // arrives with them.
    expect(rows[0]!.conversionFraction).toBeNull();
    expect(Number(rows[0]!.conversionFractionMin)).toBe(0.2);
    expect(Number(rows[0]!.conversionFractionMax)).toBe(0.5);
    expect(rows[0]!.referenceIds).toEqual([12]);
  });

  it('leaves the survivor without a range when two donors disagree about it', async () => {
    const { cocaine, be } = await seedCocaine();
    await db.insert(drugMetabolites).values([
      // States no range, so it contradicts neither donor — but the donors
      // contradict each other, which a survivor-relative comparison would
      // miss entirely.
      {
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'Benzoylecgonine',
        sortOrder: 0,
      },
      {
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'benzoylecgonin',
        conversionFractionMin: '0.2000',
        conversionFractionMax: '0.5000',
        referenceIds: [12],
        sortOrder: 1,
      },
      {
        parentDrugId: cocaine,
        metaboliteDrugId: be,
        metaboliteName: 'benzoylecgonin (BE)',
        conversionFraction: '0.9000',
        referenceIds: [13],
        sortOrder: 2,
      },
    ]);

    await runMigration();

    const rows = await db
      .select()
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, cocaine))
      .orderBy(asc(drugMetabolites.sortOrder));
    expect(rows).toHaveLength(3);
    // No measurement is copied anywhere, so no row ends up showing a number
    // whose citation stayed behind on another row.
    expect(rows[0]!.conversionFractionMin).toBeNull();
    expect(rows[0]!.referenceIds).toBeNull();
    expect(rows.map((r) => r.metaboliteDrugId)).toEqual([be, null, null]);
    expect(Number(rows[1]!.conversionFractionMin)).toBe(0.2);
    expect(rows[1]!.referenceIds).toEqual([12]);
    expect(Number(rows[2]!.conversionFraction)).toBe(0.9);
    expect(rows[2]!.referenceIds).toEqual([13]);
  });

  it('leaves rows that are already unique untouched', async () => {
    const { cocaine, be } = await seedCocaine();
    const cocaethylene = await seedDrug(db, {
      slug: 'kokaetylen',
      names: { nb: 'kokaetylen' },
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
      // Free text: no substance to key on, so the partial index ignores it and
      // the merge must too, however similar the names look.
      { parentDrugId: cocaine, metaboliteName: 'Ecgonine', sortOrder: 2 },
      {
        parentDrugId: cocaine,
        metaboliteName: 'Ecgonine methyl ester',
        sortOrder: 3,
      },
      // Same metabolite, different parent — a different link entirely.
      {
        parentDrugId: cocaethylene,
        metaboliteDrugId: be,
        metaboliteName: 'benzoylecgonin',
        sortOrder: 0,
      },
    ]);

    await runMigration();

    const rows = await db
      .select({ name: drugMetabolites.metaboliteName })
      .from(drugMetabolites)
      .orderBy(asc(drugMetabolites.parentDrugId), asc(drugMetabolites.sortOrder));
    expect(rows.map((r) => r.name)).toEqual([
      'benzoylecgonin',
      'kokaetylen',
      'Ecgonine',
      'Ecgonine methyl ester',
      'benzoylecgonin',
    ]);
  });

  it('is re-runnable, and a duplicate arriving late is merged by the re-run', async () => {
    // The deploy-time hazard the file's header calls out: migrations run while
    // the previous build still accepts writes, so a duplicate can land after
    // the DELETE and abort the CREATE INDEX. Re-running has to finish the job
    // rather than fail again.
    const { cocaine, be } = await seedCocaine();
    await db.insert(drugMetabolites).values({
      parentDrugId: cocaine,
      metaboliteDrugId: be,
      metaboliteName: 'Benzoylecgonine',
      sortOrder: 0,
    });

    await runMigration();
    expect(await indexExists()).toBe(true);

    // A late writer against the old build, i.e. before the index existed.
    await dropSubstanceIndex();
    await db.insert(drugMetabolites).values({
      parentDrugId: cocaine,
      metaboliteDrugId: be,
      metaboliteName: 'benzoylecgonin',
      evidenceNote: 'arrived mid-deploy',
      sortOrder: 1,
    });

    await runMigration();

    const rows = await db
      .select()
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, cocaine));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.evidenceNote).toBe('arrived mid-deploy');
    expect(await indexExists()).toBe(true);

    // And a third pass over already-clean data changes nothing.
    await runMigration();
    expect(
      await db
        .select()
        .from(drugMetabolites)
        .where(eq(drugMetabolites.parentDrugId, cocaine)),
    ).toHaveLength(1);
  });
});
