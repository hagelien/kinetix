/**
 * Migration 0117 — volume-of-distribution values stored in the wrong unit.
 *
 * `volumeOfDistribution` is `L/kg` in the registry. A bulk auto-extraction
 * wrote absolute volumes under `unit: 'L'` instead — a different quantity, and
 * one no conversion recovers, because litres reach litres per kilogram only
 * through a body weight the source never stated. The migration deletes those
 * rows rather than rescaling them; the pair then reappears as an open gap on a
 * core-coverage parameter, where a curator can source a cited value.
 *
 * What these tests are really pinning is the WHERE clause's edges — that it
 * reaches every non-canonical unit, spares the canonical one and the unit-less
 * row, spares the parameter's neighbours, and takes the row rather than the
 * drug or its entries. The harness truncates every table between tests, so the
 * migration's own pass (against an empty database) leaves nothing to observe;
 * the real statements are pulled out of the .sql file and re-run against seeded
 * rows, the same approach as the 0078, 0098, 0104 and 0116 tests, so this
 * cannot drift from what ships.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { drugParameters, parameterEntries, drugs } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';
import { DRUG_PARAMETERS } from '../../src/lib/drugParameters.js';
import type { NumericRange } from '../../src/types/index.js';

let db: IntegrationDb;
let userId: number;
let drugId: number;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  HERE,
  '../../drizzle/0117_drop_unit_invalid_volume_of_distribution.sql',
);

/** Every statement of the real migration, in order. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runMigration(): Promise<void> {
  for (const statement of migrationStatements()) {
    await db.execute(sql.raw(statement));
  }
}

async function storedValue(
  parameter: string,
  forDrug: number = drugId,
): Promise<NumericRange | undefined> {
  const [row] = await db
    .select()
    .from(drugParameters)
    .where(
      and(
        eq(drugParameters.drugId, forDrug),
        eq(drugParameters.parameter, parameter),
      ),
    );
  return row?.value as NumericRange | undefined;
}

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  userId = await seedUser(db);
  drugId = await seedDrug(db);
});

describe('migration 0117 — Vd stored in a unit the parameter does not have', () => {
  it('deletes the absolute-litre row', async () => {
    // Sufentanil's real row: the one this migration reaches in production.
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'volumeOfDistribution',
      value: {
        median: 14,
        unit: 'L',
        note: 'auto-extracted from PubChem (total volume)',
      },
      updatedBy: userId,
    });

    await runMigration();

    expect(await storedValue('volumeOfDistribution')).toBeUndefined();
  });

  it('does not rescale the value into the canonical unit', async () => {
    // The whole judgement of this migration in one assertion: 14 L must not
    // become 14/70 = 0.2 L/kg, or any other per-weight number. The four of
    // these drugs since curated from cited entries missed such a conversion by
    // 4–10× — the extractor had not picked a steady-state volume at all.
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'volumeOfDistribution',
      value: { median: 14, unit: 'L' },
      updatedBy: userId,
    });

    await runMigration();

    const rows = await db
      .select()
      .from(drugParameters)
      .where(eq(drugParameters.parameter, 'volumeOfDistribution'));
    expect(rows).toEqual([]);
  });

  it('keeps every value already in the canonical unit', async () => {
    const good = {
      min: 0.6,
      max: 0.8,
      median: 0.65,
      unit: 'L/kg',
      note: 'Aggregated from 2 source entries',
      derivedFromEntries: true,
    };
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'volumeOfDistribution',
      value: good,
      updatedBy: userId,
    });

    await runMigration();

    expect(await storedValue('volumeOfDistribution')).toEqual(good);
    // And it is a value the registry accepts, which is the point of keeping it.
    expect(
      DRUG_PARAMETERS.volumeOfDistribution.zod.safeParse(good).success,
    ).toBe(true);
  });

  it('reaches any non-canonical unit, not only the litre spelling seen today', async () => {
    // The clause states the registry's rule — "the unit is not L/kg" — rather
    // than the one violation that happens to exist, so a stray 'l' or 'mL'
    // from the same class of extraction does not survive it.
    const other = await seedDrug(db, { slug: 'other-drug' });
    await db.insert(drugParameters).values([
      {
        drugId,
        parameter: 'volumeOfDistribution',
        value: { median: 14, unit: 'l' },
        updatedBy: userId,
      },
      {
        drugId: other,
        parameter: 'volumeOfDistribution',
        value: { median: 14000, unit: 'mL' },
        updatedBy: userId,
      },
    ]);

    await runMigration();

    expect(await storedValue('volumeOfDistribution')).toBeUndefined();
    expect(await storedValue('volumeOfDistribution', other)).toBeUndefined();
  });

  it('leaves a row that states no unit at all', async () => {
    // A missing unit is ambiguity, not a wrong claim: the number may well be
    // canonical. Deciding that is a different judgement from this one, and no
    // such row exists today — the clause is what keeps it out of scope.
    const unitless = { min: 3, max: 5, median: 4 };
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'volumeOfDistribution',
      value: unitless,
      updatedBy: userId,
    });

    await runMigration();

    expect(await storedValue('volumeOfDistribution')).toEqual(unitless);
  });

  it('leaves other parameters alone, including ones that legitimately use L/h', async () => {
    // Clearance is stored in three units by design (L/h, L/h/kg, mL/min/kg),
    // none of them L/kg. Selecting on the unit alone would empty it.
    const clearance = { min: 10, max: 20, median: 15, unit: 'L/h' };
    const halfLife = { min: 2, max: 4, median: 3, unit: 'h' };
    await db.insert(drugParameters).values([
      { drugId, parameter: 'clearance', value: clearance, updatedBy: userId },
      { drugId, parameter: 'halfLife', value: halfLife, updatedBy: userId },
    ]);

    await runMigration();

    expect(await storedValue('clearance')).toEqual(clearance);
    expect(await storedValue('halfLife')).toEqual(halfLife);
  });

  it('deletes the parameter row, not the drug', async () => {
    // `drug_parameters` cascades from `drugs`, and the delete is written
    // against the parameter table; the drug and its other parameters stay.
    const halfLife = { min: 2, max: 4, median: 3, unit: 'h' };
    await db.insert(drugParameters).values([
      {
        drugId,
        parameter: 'volumeOfDistribution',
        value: { median: 14, unit: 'L' },
        updatedBy: userId,
      },
      { drugId, parameter: 'halfLife', value: halfLife, updatedBy: userId },
    ]);

    await runMigration();

    const remaining = await db.select().from(drugs).where(eq(drugs.id, drugId));
    expect(remaining).toHaveLength(1);
    expect(await storedValue('halfLife')).toEqual(halfLife);
  });

  it('leaves parameter_entries alone — they are validated on write', async () => {
    // The cited per-source observations are where a replacement value comes
    // from. Every entry write checks the unit against the parameter's
    // allowedUnits, so none of them carries the defect being deleted here.
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'volumeOfDistribution',
      low: '0.6',
      high: '0.8',
      unit: 'L/kg',
      createdBy: userId,
    });
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'volumeOfDistribution',
      value: { median: 14, unit: 'L' },
      updatedBy: userId,
    });

    await runMigration();

    const [entry] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, drugId));
    expect(entry?.unit).toBe('L/kg');
    expect(Number(entry?.low)).toBe(0.6);
    expect(await storedValue('volumeOfDistribution')).toBeUndefined();
  });

  it('is idempotent — a second pass changes nothing', async () => {
    const good = { min: 0.6, max: 0.8, median: 0.65, unit: 'L/kg' };
    await db.insert(drugParameters).values([
      {
        drugId,
        parameter: 'volumeOfDistribution',
        value: { median: 14, unit: 'L' },
        updatedBy: userId,
      },
    ]);
    const other = await seedDrug(db, { slug: 'other-drug' });
    await db.insert(drugParameters).values({
      drugId: other,
      parameter: 'volumeOfDistribution',
      value: good,
      updatedBy: userId,
    });

    await runMigration();
    await runMigration();

    expect(await storedValue('volumeOfDistribution')).toBeUndefined();
    expect(await storedValue('volumeOfDistribution', other)).toEqual(good);
  });
});
