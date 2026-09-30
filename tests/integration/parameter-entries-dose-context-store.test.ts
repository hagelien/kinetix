/**
 * Cmax release B (#1340): the shared entry store persists and returns the
 * complete dose-context shape (migration 0127), so an approval issued by
 * release-B code persists a release-C payload instead of truncating it to the
 * legacy column list, and the API can re-read it faithfully.
 *
 * The store is driven directly with the dose fields, as an approved payload
 * would reach it. No parameter accepts dose context through validation until
 * the Cmax registry entry lands; that is the validator's job, not the store's.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { parameterEntries } from '../../db/schema.js';
import {
  entryDuplicateExists,
  insertParameterEntry,
  listEntriesForDrug,
  updateParameterEntryRow,
} from '../../api/_lib/parameter-entries-store.js';
import type {
  ParameterEntryInput,
  ParameterEntryPatch,
} from '../../src/lib/parameterEntries.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedDrug, seedUser } from './setup/seed.js';

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

const doseContext = {
  centralValue: 0.084,
  centralStatistic: 'arithmetic_mean',
  intervalKind: 'sd',
  doseValue: 2,
  doseLow: null,
  doseHigh: null,
  doseUnit: 'mg',
  doseBasis: 'salt',
  doseSaltForm: 'hydrochloride',
  doseRegimen: 'steady_state',
  doseIntervalHours: 12,
  doseNumber: null,
  regimenDurationHours: null,
  priorDosingRegular: true,
  ivInputMode: null,
  administrationDurationMin: null,
  releaseProfile: 'immediate',
  physicalForm: 'tablet_capsule',
  prandialState: 'fasted',
  administeredDrugId: null as number | null,
  coadministrationState: 'monotherapy',
  interactingDrugId: null,
  pkPopulation: 'metabolizer_phenotype',
  populationQualifier: 'CYP2D6 PM',
  valueBasis: 'concentration',
} as const;

async function setup() {
  const drugId = await seedDrug(db, { slug: 'kokain' });
  const citationId = await seedAdmissibleCitation(db);
  const userId = await seedUser(db);
  return { drugId, citationId, userId };
}

function cmaxInput(
  drugId: number,
  citationId: number,
  over: Record<string, unknown> = {},
): ParameterEntryInput {
  return {
    drugId,
    citationId,
    parameter: 'cmax',
    unit: 'µmol/L',
    matrix: 'plasma',
    low: 0.07,
    high: 0.098,
    route: 'oral',
    ...doseContext,
    administeredDrugId: drugId,
    ...over,
  } as unknown as ParameterEntryInput;
}

describe('entry store — dose context', () => {
  it('persists the complete shape and returns it from the entry list', async () => {
    const { drugId, citationId, userId } = await setup();
    await insertParameterEntry(cmaxInput(drugId, citationId), userId);

    const [entry] = await listEntriesForDrug(drugId);
    expect(entry!.doseContext).toEqual({ ...doseContext, administeredDrugId: drugId });
  });

  it('returns null dose context for an ordinary entry', async () => {
    const { drugId, citationId, userId } = await setup();
    await insertParameterEntry(
      { drugId, citationId, parameter: 'tmax', unit: 'h', low: 1, high: 2 } as ParameterEntryInput,
      userId,
    );
    const [entry] = await listEntriesForDrug(drugId);
    expect(entry!.doseContext).toBeNull();
  });

  it('stores the median shorthand of a dose-context entry as its central value', async () => {
    const { drugId, citationId, userId } = await setup();
    const row = await insertParameterEntry(
      cmaxInput(drugId, citationId, {
        centralValue: undefined,
        centralStatistic: undefined,
        intervalKind: 'range',
        median: 0.08,
      }),
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
      centralValue: '0.080000',
      centralStatistic: 'median',
    });
  });

  it('leaves the median of an ordinary entry alone', async () => {
    const { drugId, citationId, userId } = await setup();
    const row = await insertParameterEntry(
      { drugId, citationId, parameter: 'tmax', unit: 'h', median: 1.5 } as ParameterEntryInput,
      userId,
    );
    const [stored] = await db
      .select({ median: parameterEntries.median, centralValue: parameterEntries.centralValue })
      .from(parameterEntries)
      .where(eq(parameterEntries.id, row.id));
    expect(stored).toEqual({ median: '1.500000', centralValue: null });
  });

  it('writes the whole shape on update', async () => {
    const { drugId, citationId, userId } = await setup();
    const row = await insertParameterEntry(cmaxInput(drugId, citationId), userId);
    const { drugId: _d, parameter: _p, ...rest } = cmaxInput(drugId, citationId, {
      doseValue: 4,
      prandialState: 'fed',
    }) as unknown as Record<string, unknown>;
    await updateParameterEntryRow(row.id, rest as ParameterEntryPatch);
    const [entry] = await listEntriesForDrug(drugId);
    expect(entry!.doseContext).toMatchObject({ doseValue: 4, prandialState: 'fed' });
  });

  // A quote is evidence about a specific reading, and the dose is part of
  // which reading it is: a sentence about a 2 mg dose does not attest to a
  // value filed at 4 mg.
  it('detaches an omitted quote when the dose changes, and keeps it when it does not', async () => {
    const { drugId, citationId, userId } = await setup();
    const quote = 'Cmax was 0.084 ± 0.014 µmol/L after 2 mg.';
    const row = await insertParameterEntry(
      cmaxInput(drugId, citationId, { quote }),
      userId,
    );
    const { drugId: _d, parameter: _p, ...same } = cmaxInput(
      drugId,
      citationId,
    ) as unknown as Record<string, unknown>;

    await updateParameterEntryRow(row.id, same as ParameterEntryPatch);
    let [entry] = await listEntriesForDrug(drugId);
    expect(entry!.sourceQuote).toBe(quote);

    await updateParameterEntryRow(row.id, {
      ...same,
      doseValue: 4,
    } as ParameterEntryPatch);
    [entry] = await listEntriesForDrug(drugId);
    expect(entry!.sourceQuote).toBeNull();
  });
});

// The duplicate identity on the ordinary write path (`entryDuplicateExists`)
// compares the complete entry shape, not the legacy value tuple.
describe('entry store — duplicate identity over dose context', () => {
  it('treats two arms at different doses with the same Cmax as distinct', async () => {
    const { drugId, citationId, userId } = await setup();
    await insertParameterEntry(cmaxInput(drugId, citationId), userId);

    expect(await entryDuplicateExists(cmaxInput(drugId, citationId))).toBe(true);
    expect(
      await entryDuplicateExists(cmaxInput(drugId, citationId, { doseValue: 4 })),
    ).toBe(false);
    expect(
      await entryDuplicateExists(
        cmaxInput(drugId, citationId, { doseRegimen: 'single', doseIntervalHours: null, priorDosingRegular: null }),
      ),
    ).toBe(false);
    expect(
      await entryDuplicateExists(cmaxInput(drugId, citationId, { pkPopulation: 'healthy_adult', populationQualifier: null })),
    ).toBe(false);
    expect(
      await entryDuplicateExists(cmaxInput(drugId, citationId, { centralStatistic: 'geometric_mean' })),
    ).toBe(false);
  });

  it('collides the same cohort authored as median and as centralValue', async () => {
    const { drugId, citationId, userId } = await setup();
    const asCentral = {
      centralValue: 0.08,
      centralStatistic: 'median',
      intervalKind: 'range',
    };
    await insertParameterEntry(cmaxInput(drugId, citationId, asCentral), userId);
    expect(
      await entryDuplicateExists(
        cmaxInput(drugId, citationId, {
          centralValue: undefined,
          centralStatistic: undefined,
          intervalKind: 'range',
          median: 0.08,
        }),
      ),
    ).toBe(true);
  });

  it('still finds an ordinary duplicate with no dose context', async () => {
    const { drugId, citationId, userId } = await setup();
    const plain = { drugId, citationId, parameter: 'tmax', unit: 'h', low: 1, high: 2 } as ParameterEntryInput;
    await insertParameterEntry(plain, userId);
    expect(await entryDuplicateExists(plain)).toBe(true);
  });
});

// Codex P1 on #1360: Postgres rounds a written value to the column's scale,
// so a retry carrying one digit more than the column keeps must be compared
// the same way — otherwise it misses the row it wrote and is stored (and
// pooled) twice.
describe('entry store — duplicates at the stored precision', () => {
  it('matches a central value with more digits than numeric(14, 6) keeps', async () => {
    const { drugId, citationId, userId } = await setup();
    await insertParameterEntry(cmaxInput(drugId, citationId, { centralValue: 0.0840001 }), userId);
    expect(
      await entryDuplicateExists(cmaxInput(drugId, citationId, { centralValue: 0.0840001 })),
    ).toBe(true);
  });

  it('matches a dosing interval with more digits than numeric(10, 4) keeps', async () => {
    const { drugId, citationId, userId } = await setup();
    await insertParameterEntry(
      cmaxInput(drugId, citationId, { doseIntervalHours: 12.00001 }),
      userId,
    );
    expect(
      await entryDuplicateExists(cmaxInput(drugId, citationId, { doseIntervalHours: 12.00001 })),
    ).toBe(true);
  });

  it('matches an ordinary low/high with excess digits too', async () => {
    const { drugId, citationId, userId } = await setup();
    const plain = {
      drugId,
      citationId,
      parameter: 'tmax',
      unit: 'h',
      low: 1.0000001,
      high: 2,
    } as ParameterEntryInput;
    await insertParameterEntry(plain, userId);
    expect(await entryDuplicateExists(plain)).toBe(true);
  });
});

// Codex P1 on #1360: the quote-preservation rule compares a patch against the
// stored row, and the write rounds the patch to each column's scale — so a
// patch repeating a stored value with excess digits is the same evidence and
// must not cost the entry its quote.
describe('entry store — quote evidence at the stored precision', () => {
  it('keeps the quote when a patch repeats the dose and interval with excess digits', async () => {
    const { drugId, citationId, userId } = await setup();
    const quote = 'Cmax was 0.084 ± 0.014 µmol/L after 2 mg every 12 h.';
    const row = await insertParameterEntry(cmaxInput(drugId, citationId, { quote }), userId);
    const { drugId: _d, parameter: _p, ...same } = cmaxInput(drugId, citationId, {
      doseValue: 2.0000001,
      doseIntervalHours: 12.00001,
      low: 0.0700000001,
    }) as unknown as Record<string, unknown>;

    await updateParameterEntryRow(row.id, same as ParameterEntryPatch);
    const [entry] = await listEntriesForDrug(drugId);
    expect(entry!.sourceQuote).toBe(quote);
  });
});
