/**
 * The reported statistic on every numeric parameter (migration 0135).
 *
 * A half-life reported as "0.54 (0.12) h, mean (SD)" is stored as what it
 * is — `centralValue` 0.54, `centralStatistic` 'arithmetic_mean',
 * `intervalKind` 'sd' — instead of as a median with unlabelled bounds, which
 * was the only shape available outside Cmax. The database refuses the same
 * ill-formed statistics the application does, the store round-trips the
 * labels, and the pooled summary reads the labelled centre.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { parameterEntries } from '../../db/schema.js';
import {
  getParameterSummariesWithRoutes,
  insertParameterEntry,
  listEntriesForDrug,
} from '../../api/_lib/parameter-entries-store.js';
import type { ParameterEntryInput } from '../../src/lib/parameterEntries.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let drugId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  drugId = await seedDrug(db, { slug: 'gammahydroksybutyrat' });
});

function halfLife(over: Record<string, unknown> = {}) {
  return {
    drugId,
    parameter: 'halfLife',
    unit: 'h',
    low: '0.42',
    high: '0.66',
    centralValue: '0.54',
    centralStatistic: 'arithmetic_mean',
    intervalKind: 'sd',
    n: 12,
    ...over,
  };
}

async function insertFails(values: Record<string, unknown>): Promise<string | null> {
  try {
    await db.insert(parameterEntries).values(values as never);
    return null;
  } catch (err) {
    const cause = (err as { cause?: { code?: string; constraint?: string } }).cause;
    expect(cause?.code).toBe('23514');
    return cause?.constraint ?? 'unknown';
  }
}

describe('migration 0135 — the reported statistic outside Cmax', () => {
  it('stores a labelled mean ± SD half-life, and a legacy unlabelled one', async () => {
    expect(await insertFails(halfLife())).toBeNull();
    expect(
      await insertFails({ drugId, parameter: 'halfLife', unit: 'h', low: '4', high: '6', median: '5' }),
    ).toBeNull();
    // A labelled centre whose bounds the source did not name says so.
    expect(await insertFails(halfLife({ intervalKind: 'unknown' }))).toBeNull();
    // A labelled range with no centre is a reading too.
    expect(
      await insertFails(
        halfLife({ centralValue: null, centralStatistic: null, intervalKind: 'range' }),
      ),
    ).toBeNull();
  });

  it.each([
    ['a central value without its statistic', { centralStatistic: null }],
    ['a statistic without a central value', { centralValue: null, intervalKind: 'range' }],
    ['a labelled centre beside a bare median', { median: '0.54' }],
    ['an interval kind with one bound', { high: null, intervalKind: 'range', centralStatistic: 'median' }],
    ['an asymmetric SD', { low: '0.40' }],
    ['an SD with no centre', { centralValue: null, centralStatistic: null }],
    ['a centre outside its bounds', { centralValue: '0.70', intervalKind: 'range' }],
    ['a statistic on a censored threshold', { qualifier: '<', intervalKind: null, low: '0.54', high: '0.54' }],
    ['a single subject with a cohort', { centralStatistic: 'single_subject', intervalKind: null, low: null, high: null }],
    ['a labelled centre beside bounds nobody named', { intervalKind: null }],
  ])('refuses %s', async (_label, over) => {
    expect(await insertFails(halfLife(over))).toBe('parameter_entries_reported_statistic');
  });

  it('still refuses dose context outside Cmax', async () => {
    expect(await insertFails(halfLife({ doseValue: '25', doseUnit: 'mg/kg' }))).toBe(
      'parameter_entries_dose_context_forbidden',
    );
  });
});

describe('entry store — a labelled source value of an ordinary parameter', () => {
  async function seed() {
    const citationId = await seedAdmissibleCitation(db);
    const userId = await seedUser(db);
    return { citationId, userId };
  }

  it('round-trips the labels and pools the labelled centre', async () => {
    const { citationId, userId } = await seed();
    await insertParameterEntry(
      {
        drugId,
        citationId,
        parameter: 'halfLife',
        unit: 'h',
        low: 0.42,
        high: 0.66,
        centralValue: 0.54,
        centralStatistic: 'arithmetic_mean',
        intervalKind: 'sd',
        n: 12,
      } as ParameterEntryInput,
      userId,
    );

    const [entry] = await listEntriesForDrug(drugId);
    expect(entry!.median).toBeNull();
    expect(entry!.doseContext).toMatchObject({
      centralValue: 0.54,
      centralStatistic: 'arithmetic_mean',
      intervalKind: 'sd',
    });

    const { summaries } = await getParameterSummariesWithRoutes(drugId);
    expect(summaries.halfLife?.representative).toBeCloseTo(0.54, 6);
    expect(summaries.halfLife?.points[0]?.representative).toBeCloseTo(0.54, 6);
  });

  it('folds a labelled median shorthand into the central value', async () => {
    const { citationId, userId } = await seed();
    const row = await insertParameterEntry(
      {
        drugId,
        citationId,
        parameter: 'halfLife',
        unit: 'h',
        low: 0.3,
        high: 0.9,
        median: 0.5,
        intervalKind: 'range',
      } as ParameterEntryInput,
      userId,
    );
    const [stored] = await db
      .select({
        median: parameterEntries.median,
        centralValue: parameterEntries.centralValue,
        centralStatistic: parameterEntries.centralStatistic,
      })
      .from(parameterEntries)
      .where(eq(parameterEntries.id, row.id));
    expect(stored).toEqual({
      median: null,
      centralValue: '0.500000',
      centralStatistic: 'median',
    });
  });
});
