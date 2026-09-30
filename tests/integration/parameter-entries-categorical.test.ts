import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { drugParameters, parameterEntries } from '../../db/schema.js';
import {
  entryDuplicateExists,
  insertParameterEntry,
  listEntriesForDrug,
  recomputeAndCacheParameterSummary,
} from '../../api/_lib/parameter-entries-store.js';
import type { ParameterEntryInput } from '../../src/lib/parameterEntries.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedDrug, seedUser } from './setup/seed.js';

/**
 * CV-1b — a categorical model-structure axis (dispositionModel / …) is stored as
 * an ordinary `parameter_entries` row carrying a `categorical_value` and NO
 * numbers. This exercises the real write path against PGlite: the store insert,
 * the read/list projection, exact-duplicate detection, the migration-0109 CHECK
 * constraints, and the (deliberate) absence of any aggregate cache.
 */

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

function dispositionEntry(
  over: Partial<ParameterEntryInput> & Pick<ParameterEntryInput, 'drugId' | 'citationId'>,
): ParameterEntryInput {
  return {
    parameter: 'dispositionModel',
    categoricalValue: 'two-compartment',
    unit: '',
    ...over,
  } as ParameterEntryInput;
}

describe('CV-1b — categorical model-structure entries', () => {
  it('persists a categorical value with no numeric fields', async () => {
    const drugId = await seedDrug(db);
    const citationId = await seedAdmissibleCitation(db);
    const userId = await seedUser(db);

    const row = await insertParameterEntry(
      dispositionEntry({ drugId, citationId }),
      userId,
    );

    const [stored] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, row.id));
    expect(stored!.parameter).toBe('dispositionModel');
    expect(stored!.categoricalValue).toBe('two-compartment');
    expect(stored!.low).toBeNull();
    expect(stored!.high).toBeNull();
    expect(stored!.median).toBeNull();
    expect(stored!.qualifier).toBeNull();
    expect(stored!.matrix).toBeNull();
    expect(stored!.scenario).toBeNull();
    expect(stored!.citationId).toBe(citationId);
  });

  it('surfaces the declared value through the list projection', async () => {
    const drugId = await seedDrug(db);
    const citationId = await seedAdmissibleCitation(db);
    const userId = await seedUser(db);
    await insertParameterEntry(
      dispositionEntry({ drugId, citationId, categoricalValue: 'one-compartment' }),
      userId,
    );

    const items = await listEntriesForDrug(drugId, 'dispositionModel');
    expect(items).toHaveLength(1);
    expect(items[0]!.categoricalValue).toBe('one-compartment');
    expect(items[0]!.low).toBeNull();
  });

  it('detects an exact duplicate but allows a different shape / axis', async () => {
    const drugId = await seedDrug(db);
    const citationId = await seedAdmissibleCitation(db);
    const userId = await seedUser(db);
    const base = dispositionEntry({ drugId, citationId });
    await insertParameterEntry(base, userId);

    // Same drug + parameter + citation + value → duplicate.
    expect(await entryDuplicateExists(base)).toBe(true);
    // A different declared shape (same citation) is a distinct, corroborating
    // observation, not a duplicate.
    expect(
      await entryDuplicateExists({ ...base, categoricalValue: 'one-compartment' }),
    ).toBe(false);
    // A different axis entirely is never a duplicate of this one.
    expect(
      await entryDuplicateExists({
        ...base,
        parameter: 'absorptionModel',
        categoricalValue: 'bolus',
      } as ParameterEntryInput),
    ).toBe(false);
  });

  it('multiple citations may corroborate the same shape', async () => {
    const drugId = await seedDrug(db);
    const c1 = await seedAdmissibleCitation(db, { identifier: '11111111' });
    const c2 = await seedAdmissibleCitation(db, { identifier: '22222222' });
    const userId = await seedUser(db);
    await insertParameterEntry(dispositionEntry({ drugId, citationId: c1 }), userId);
    await insertParameterEntry(dispositionEntry({ drugId, citationId: c2 }), userId);

    const items = await listEntriesForDrug(drugId, 'dispositionModel');
    expect(items).toHaveLength(2);
    expect(items.map((e) => e.citationId).sort()).toEqual([c1, c2].sort());
  });

  it('publishes no aggregate cache for a categorical axis', async () => {
    const drugId = await seedDrug(db);
    const citationId = await seedAdmissibleCitation(db);
    const userId = await seedUser(db);
    await insertParameterEntry(dispositionEntry({ drugId, citationId }), userId);

    const revisionId = await recomputeAndCacheParameterSummary(
      drugId,
      'dispositionModel',
      userId,
    );
    expect(revisionId).toBeNull();
    const cached = await db
      .select()
      .from(drugParameters)
      .where(
        and(
          eq(drugParameters.drugId, drugId),
          eq(drugParameters.parameter, 'dispositionModel'),
        ),
      );
    expect(cached).toHaveLength(0);
  });

  it('the DB CHECK rejects an out-of-vocabulary value', async () => {
    const drugId = await seedDrug(db);
    const citationId = await seedAdmissibleCitation(db);
    const userId = await seedUser(db);
    await expect(
      db.insert(parameterEntries).values({
        drugId,
        parameter: 'dispositionModel',
        categoricalValue: 'three-compartment',
        unit: '',
        citationId,
        createdBy: userId,
        origin: 'contributor',
      } as never),
    ).rejects.toThrow();
  });

  it('the DB CHECK rejects a categorical value beside a numeric one', async () => {
    const drugId = await seedDrug(db);
    const citationId = await seedAdmissibleCitation(db);
    const userId = await seedUser(db);
    await expect(
      db.insert(parameterEntries).values({
        drugId,
        parameter: 'dispositionModel',
        categoricalValue: 'two-compartment',
        low: '1',
        unit: '',
        citationId,
        createdBy: userId,
        origin: 'contributor',
      } as never),
    ).rejects.toThrow();
  });

  it('normalizes an empty-string categorical field on a numeric entry to NULL', async () => {
    // A generic client serializing a blank form control can send
    // categoricalValue: '' on a numeric entry; it must persist as NULL (the 0109
    // CHECK rejects '' for a numeric parameter), not blow up as a DB error.
    const drugId = await seedDrug(db);
    const citationId = await seedAdmissibleCitation(db);
    const userId = await seedUser(db);
    const row = await insertParameterEntry(
      {
        drugId,
        parameter: 'halfLife',
        categoricalValue: '' as unknown as undefined,
        low: 4,
        high: 9,
        unit: 'h',
        citationId,
      } as ParameterEntryInput,
      userId,
    );
    const [stored] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, row.id));
    expect(stored!.categoricalValue).toBeNull();
    expect(Number(stored!.low)).toBe(4);
  });

  it('the DB CHECK forbids a unit / matrix / scenario on a categorical row', async () => {
    const drugId = await seedDrug(db);
    const citationId = await seedAdmissibleCitation(db);
    const userId = await seedUser(db);
    const base = {
      drugId,
      parameter: 'dispositionModel',
      categoricalValue: 'two-compartment',
      unit: '',
      citationId,
      createdBy: userId,
      origin: 'contributor',
    };
    // A stray unit, matrix or scenario on a model-axis row is rejected by the DB,
    // mirroring validateCategoricalEntry, so a direct writer can't bypass it.
    await expect(
      db.insert(parameterEntries).values({ ...base, unit: 'h' } as never),
    ).rejects.toThrow();
    await expect(
      db.insert(parameterEntries).values({ ...base, matrix: 'serum' } as never),
    ).rejects.toThrow();
    await expect(
      db
        .insert(parameterEntries)
        .values({ ...base, scenario: 'living_therapeutic' } as never),
    ).rejects.toThrow();
  });

  it('the DB CHECK forbids a categorical value on a numeric parameter', async () => {
    const drugId = await seedDrug(db);
    const citationId = await seedAdmissibleCitation(db);
    const userId = await seedUser(db);
    await expect(
      db.insert(parameterEntries).values({
        drugId,
        parameter: 'halfLife',
        categoricalValue: 'two-compartment',
        unit: 'h',
        citationId,
        createdBy: userId,
        origin: 'contributor',
      } as never),
    ).rejects.toThrow();
  });
});
