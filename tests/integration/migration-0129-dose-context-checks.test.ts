/**
 * Cmax release D (#1342): migration 0129's CHECK constraints refuse, at the
 * database, every structural shape the API refuses — so a direct writer (a
 * script, a manual INSERT) cannot store a Cmax row the application would not
 * — while every legacy row and every well-formed Cmax row still stores.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parameterEntries } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug } from './setup/seed.js';

let db: IntegrationDb;
let drugId: number;
let otherId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  drugId = await seedDrug(db, { slug: 'kokain' });
  otherId = await seedDrug(db, { slug: 'ketokonazol' });
});

function cmax(over: Record<string, unknown> = {}) {
  return {
    drugId,
    parameter: 'cmax',
    unit: 'ng/mL',
    matrix: 'plasma',
    low: '70',
    high: '98',
    intervalKind: 'sd',
    centralValue: '84',
    centralStatistic: 'arithmetic_mean',
    valueBasis: 'concentration',
    doseValue: '2',
    doseUnit: 'mg',
    administeredDrugId: drugId,
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

describe('migration 0129 — dose-context CHECK constraints', () => {
  it('stores a well-formed Cmax row and a legacy row', async () => {
    expect(await insertFails(cmax())).toBeNull();
    expect(
      await insertFails({ drugId, parameter: 'tmax', unit: 'h', low: '1', high: '2' }),
    ).toBeNull();
  });

  it.each([
    ['no administered drug', { administeredDrugId: null }, 'parameter_entries_dose_context_required'],
    ['no value basis', { valueBasis: null }, 'parameter_entries_dose_context_required'],
    ['an exact dose beside a range', { doseLow: '1', doseHigh: '4' }, 'parameter_entries_dose_shape'],
    ['half a range', { doseValue: null, doseLow: '1' }, 'parameter_entries_dose_shape'],
    ['a zero-width range', { doseValue: null, doseLow: '2', doseHigh: '2' }, 'parameter_entries_dose_shape'],
    ['a non-positive dose', { doseValue: '0' }, 'parameter_entries_dose_shape'],
    ['a dose with no unit', { doseUnit: null }, 'parameter_entries_dose_shape'],
    ['a salt form without a salt basis', { doseBasis: 'parent', doseSaltForm: 'hydrochloride' }, 'parameter_entries_dose_context_dependencies'],
    ['an interacting drug without an interaction arm', { interactingDrugId: 0 }, 'parameter_entries_dose_context_dependencies'],
    ['an infusion without its time', { route: 'iv', ivInputMode: 'infusion' }, 'parameter_entries_dose_context_dependencies'],
    ['an infusion time on a bolus', { route: 'iv', ivInputMode: 'bolus', administrationDurationMin: '10' }, 'parameter_entries_dose_context_dependencies'],
    ['bounds without an interval kind', { intervalKind: null }, 'parameter_entries_dose_context_interval'],
    ['an interval kind without bounds', { low: null, high: null }, 'parameter_entries_dose_context_interval'],
    // The NULL traps: each dependency must hold when the field it depends on
    // is MISSING, not only when it holds another value (a CHECK passes on NULL).
    ['a salt form with no basis at all', { doseSaltForm: 'hydrochloride' }, 'parameter_entries_dose_context_dependencies'],
    ['an infusion time with no input mode', { route: 'iv', administrationDurationMin: '10' }, 'parameter_entries_dose_context_dependencies'],
    ['a value outside the vocabulary', { prandialState: 'after lunch' }, 'parameter_entries_dose_context_vocabulary'],
    // Codex P1s on #1383: every rule validateDoseContext() applies, not only
    // the structural ones the first draft carried.
    // The reported value.
    ['a reading with no value at all', { centralValue: null, centralStatistic: null, low: null, high: null, intervalKind: null }, 'parameter_entries_dose_context_reported_value'],
    ['a central value with no statistic', { centralStatistic: null }, 'parameter_entries_dose_context_reported_value'],
    ['a statistic with no central value', { centralValue: null, intervalKind: 'range' }, 'parameter_entries_dose_context_reported_value'],
    ['a censored value with a statistic', { qualifier: '<', low: null, high: null, intervalKind: null }, 'parameter_entries_dose_context_reported_value'],
    ['a censored value with a median', { qualifier: '<', centralStatistic: null, intervalKind: null, low: null, high: null, median: '84' }, 'parameter_entries_dose_context_reported_value'],
    ['an SD with no central value', { centralValue: null, centralStatistic: null }, 'parameter_entries_dose_context_reported_value'],
    ['an asymmetric SD', { high: '99' }, 'parameter_entries_dose_context_reported_value'],
    ['a central value outside its bounds', { intervalKind: 'range', centralValue: '60' }, 'parameter_entries_dose_context_reported_value'],
    ['a single subject in a cohort', { centralStatistic: 'single_subject', n: 5 }, 'parameter_entries_dose_context_reported_value'],
    // Codex P1s on #1383, second pass.
    ['a median beside the central value', { median: '84' }, 'parameter_entries_dose_context_reported_value'],
    ['a median standing in for the central value', { centralValue: null, centralStatistic: null, intervalKind: 'range', median: '84' }, 'parameter_entries_dose_context_reported_value'],
    ['reversed bounds with no central value', { centralValue: null, centralStatistic: null, intervalKind: 'range', low: '98', high: '70' }, 'parameter_entries_dose_context_reported_value'],
    ['a NaN dose', { doseValue: 'NaN' }, 'parameter_entries_dose_context_finite'],
    ['a NaN dose range end', { doseValue: null, doseLow: '1', doseHigh: 'NaN' }, 'parameter_entries_dose_context_finite'],
    ['a NaN central value', { centralValue: 'NaN', intervalKind: 'range' }, 'parameter_entries_dose_context_finite'],
    ['a NaN dosing interval', { doseRegimen: 'multiple', doseIntervalHours: 'NaN' }, 'parameter_entries_dose_context_finite'],
    ['a NaN regimen duration', { doseRegimen: 'multiple', regimenDurationHours: 'NaN' }, 'parameter_entries_dose_context_finite'],
    ['a NaN infusion time', { route: 'iv', ivInputMode: 'infusion', administrationDurationMin: 'NaN' }, 'parameter_entries_dose_context_finite'],
    ['a NaN bound', { intervalKind: 'range', high: 'NaN' }, 'parameter_entries_dose_context_finite'],
    // What the number is.
    ['a concentration with no dose', { doseValue: null, doseUnit: null }, 'parameter_entries_dose_context_value_basis'],
    ['a concentration in a ratio unit', { unit: 'ng/mL/mg' }, 'parameter_entries_dose_context_value_basis'],
    ['a dose-normalized value in a concentration unit', { valueBasis: 'dose_normalized' }, 'parameter_entries_dose_context_value_basis'],
    ['a per-kg ratio beside an absolute dose', { valueBasis: 'dose_normalized', unit: 'ng/mL/(mg/kg)' }, 'parameter_entries_dose_context_value_basis'],
    ['an absolute ratio beside a per-kg dose', { valueBasis: 'dose_normalized', unit: 'ng/mL/mg', doseUnit: 'mg/kg' }, 'parameter_entries_dose_context_value_basis'],
    // The regimen, including its NULL traps.
    ['a dosing interval on a single dose', { doseRegimen: 'single', doseIntervalHours: '12' }, 'parameter_entries_dose_context_dependencies'],
    ['a dose number outside a multiple regimen', { doseRegimen: 'steady_state', doseNumber: 3 }, 'parameter_entries_dose_context_dependencies'],
    ['a dose number with no regimen', { doseNumber: 3 }, 'parameter_entries_dose_context_dependencies'],
    ['a regimen duration on a single dose', { doseRegimen: 'single', regimenDurationHours: '24' }, 'parameter_entries_dose_context_dependencies'],
    ['a regimen duration with no regimen', { regimenDurationHours: '24' }, 'parameter_entries_dose_context_dependencies'],
    ['regular prior dosing on a single dose', { doseRegimen: 'single', priorDosingRegular: true }, 'parameter_entries_dose_context_dependencies'],
    ['regular prior dosing with no regimen', { priorDosingRegular: true }, 'parameter_entries_dose_context_dependencies'],
    // Administration and population.
    ['IV input on an oral dose', { route: 'oral', ivInputMode: 'bolus' }, 'parameter_entries_dose_context_dependencies'],
    ['a population qualifier on healthy adults', { pkPopulation: 'healthy_adult', populationQualifier: 'CYP2D6 PM' }, 'parameter_entries_dose_context_dependencies'],
    ['a population qualifier with no population', { populationQualifier: 'CYP2D6 PM' }, 'parameter_entries_dose_context_dependencies'],
  ] as const)('refuses %s', async (_label, over, constraint) => {
    const values = cmax(over);
    if ('interactingDrugId' in over) values.interactingDrugId = otherId;
    expect(await insertFails(values)).toBe(constraint);
  });

  it.each([
    ['a censored threshold', { qualifier: '<', centralValue: '5', centralStatistic: null, low: null, high: null, intervalKind: null }],
    ['an SD one tick off symmetric (the stored-scale tolerance)', { high: '98.000001' }],
    ['a dose-normalized value whose source gave no dose', { valueBasis: 'dose_normalized', unit: 'ng/mL/mg', doseValue: null, doseUnit: null }],
    ['a per-kg ratio beside a per-kg dose', { valueBasis: 'dose_normalized', unit: 'ng/mL/(mg/kg)', doseUnit: 'mg/kg' }],
    ['the third dose of a multiple regimen', { doseRegimen: 'multiple', doseNumber: 3, doseIntervalHours: '12', regimenDurationHours: '24', priorDosingRegular: true }],
    ['regular prior dosing at steady state', { doseRegimen: 'steady_state', priorDosingRegular: true, doseIntervalHours: '24' }],
    ['a timed IV infusion', { route: 'iv', ivInputMode: 'infusion', administrationDurationMin: '30' }],
    ['IV input with no route stated', { ivInputMode: 'bolus' }],
    ['a qualified patient population', { pkPopulation: 'metabolizer_phenotype', populationQualifier: 'CYP2D6 PM' }],
    ['a single subject', { centralStatistic: 'single_subject', n: 1 }],
    ['a bounds-only range', { centralValue: null, centralStatistic: null, intervalKind: 'range' }],
  ] as const)('stores %s', async (_label, over) => {
    expect(await insertFails(cmax(over))).toBeNull();
  });

  it('refuses dose context on a parameter that does not carry it', async () => {
    expect(
      await insertFails({
        drugId,
        parameter: 'tmax',
        unit: 'h',
        low: '1',
        high: '2',
        doseValue: '2',
        doseUnit: 'mg',
      }),
    ).toBe('parameter_entries_dose_context_forbidden');
  });
});
