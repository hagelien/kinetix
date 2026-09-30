/**
 * Migration 0116 — fraction parameters stored as percentages.
 *
 * `bioavailability` and `proteinBinding` are `kind: 'fraction'`: the registry
 * allows only `unit: 'fraction'` and bounds the value 0–1. Rows that predate
 * the validated write path hold the percentage instead (`{ median: 80, unit:
 * '%' }`), which is out of bounds for its own parameter — the API rejects any
 * edit to such a row, and the monograph sidebar renders it as "80 %" beside a
 * neighbouring "0.3" for the same quantity.
 *
 * The harness truncates every table between tests, so the migration's own pass
 * (against an empty database) leaves nothing to observe. The real statements
 * are pulled out of the .sql file and re-run against seeded rows — the same
 * approach as the 0078, 0098 and 0104 tests, so this cannot drift from what
 * ships.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { drugParameters, parameterEntries } from '../../db/schema.js';
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
  '../../drizzle/0116_normalize_percent_fraction_parameters.sql',
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

async function storedValue(parameter: string): Promise<NumericRange> {
  const [row] = await db
    .select()
    .from(drugParameters)
    .where(
      and(
        eq(drugParameters.drugId, drugId),
        eq(drugParameters.parameter, parameter),
      ),
    );
  return row?.value as NumericRange;
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

describe('migration 0116 — percent-united fraction parameters', () => {
  it('rewrites every bound of a percent range as the 0–1 fraction', async () => {
    // Caffeine's real row, the shape with all three scalars populated.
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'proteinBinding',
      value: { min: 10, max: 35, median: 22.5, unit: '%' },
      updatedBy: userId,
    });

    await runMigration();

    expect(await storedValue('proteinBinding')).toEqual({
      min: 0.1,
      max: 0.35,
      median: 0.225,
      unit: 'fraction',
    });
  });

  it('keeps the note and any other key the row carries', async () => {
    // Remifentanil's row: a median-only value whose provenance note is the only
    // record of where the number came from.
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'proteinBinding',
      value: {
        median: 70,
        unit: '%',
        note: 'auto-extracted from OpenFDA',
        derivedFromEntries: false,
      },
      updatedBy: userId,
    });

    await runMigration();

    expect(await storedValue('proteinBinding')).toEqual({
      median: 0.7,
      unit: 'fraction',
      note: 'auto-extracted from OpenFDA',
      derivedFromEntries: false,
    });
  });

  it('produces a value the parameter registry now accepts', async () => {
    // The point of the migration: a row the API would reject for its unit and
    // its out-of-bounds numbers becomes one it accepts.
    const spec = DRUG_PARAMETERS.proteinBinding;
    const before = { min: 82, max: 86, unit: '%' };
    expect(spec.zod.safeParse(before).success).toBe(false);

    await db.insert(drugParameters).values({
      drugId,
      parameter: 'proteinBinding',
      value: before,
      updatedBy: userId,
    });
    await runMigration();

    expect(spec.zod.safeParse(await storedValue('proteinBinding')).success).toBe(
      true,
    );
  });

  it('fixes the unit without inventing the bounds a median-only row lacks', async () => {
    // `proteinBinding` is `requiresMinMax`, so ketamine's median-only row stays
    // invalid on SHAPE after the migration — and should. Deriving min = max =
    // median would assert a zero-width range the source never reported, which
    // is a curation decision, not a unit repair. What the migration owes this
    // row is that its number now means what its unit says.
    const spec = DRUG_PARAMETERS.proteinBinding;
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'proteinBinding',
      value: { median: 53.5, unit: '%', note: 'auto-extracted' },
      updatedBy: userId,
    });

    await runMigration();

    const after = await storedValue('proteinBinding');
    expect(after).toEqual({
      median: 0.535,
      unit: 'fraction',
      note: 'auto-extracted',
    });
    // In bounds and in the canonical unit — the two things that were wrong.
    expect(after.median).toBeGreaterThanOrEqual(spec.bounds.min);
    expect(after.median).toBeLessThanOrEqual(spec.bounds.max);
    expect(after.unit).toBe(spec.canonicalUnit);
    // Still short of a full parse, for the unrelated reason above.
    expect(spec.zod.safeParse(after).success).toBe(false);
  });

  it('converts bioavailability on the same terms', async () => {
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'bioavailability',
      value: { min: 25, max: 40, unit: '%' },
      updatedBy: userId,
    });

    await runMigration();

    expect(await storedValue('bioavailability')).toEqual({
      min: 0.25,
      max: 0.4,
      unit: 'fraction',
    });
  });

  it('leaves an uninterpretable over-100 value for a human', async () => {
    // A "percentage" above 100 is not a fraction anyone can recover; dividing
    // it would turn an obvious error into a plausible one.
    const bogus = { median: 800, unit: '%' };
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'proteinBinding',
      value: bogus,
      updatedBy: userId,
    });

    await runMigration();

    expect(await storedValue('proteinBinding')).toEqual(bogus);
  });

  it('does not touch a value already stored as a fraction', async () => {
    const already = { min: 0.82, max: 0.86, median: 0.85, unit: 'fraction' };
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'proteinBinding',
      value: already,
      updatedBy: userId,
    });

    await runMigration();

    expect(await storedValue('proteinBinding')).toEqual(already);
  });

  it('does not touch a non-fraction parameter that legitimately uses %', async () => {
    // Nothing declares `%` today, but the migration must select on the
    // parameter id rather than the unit alone: a future percentage-valued
    // parameter is not a 0–1 fraction and must not be divided.
    const value = { median: 40, unit: '%' };
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'halfLife',
      value,
      updatedBy: userId,
    });

    await runMigration();

    expect(await storedValue('halfLife')).toEqual(value);
  });

  it('is idempotent — a second pass changes nothing', async () => {
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'proteinBinding',
      value: { median: 80, unit: '%' },
      updatedBy: userId,
    });

    await runMigration();
    const once = await storedValue('proteinBinding');
    await runMigration();

    expect(await storedValue('proteinBinding')).toEqual(once);
    expect(once).toEqual({ median: 0.8, unit: 'fraction' });
  });

  it('leaves parameter_entries alone — they are validated on write', async () => {
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'proteinBinding',
      low: '0.82',
      high: '0.86',
      unit: 'fraction',
      createdBy: userId,
    });

    await runMigration();

    const [entry] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, drugId));
    expect(entry?.unit).toBe('fraction');
    expect(Number(entry?.low)).toBe(0.82);
    expect(Number(entry?.high)).toBe(0.86);
  });
});
