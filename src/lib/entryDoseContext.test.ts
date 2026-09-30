/**
 * The write-time rules for structured dose context (Cmax dose-context RFC,
 * *Tests required before merge → Schema / validation*). Exercised directly
 * against `validateDoseContext` in `'required'` mode, because no parameter is
 * registered as dose-context until the Cmax registry entry lands; the
 * `'forbidden'` cases go through `validateEntryForParameter`, which is what
 * every write path calls.
 */
import { describe, expect, it } from 'vitest';
import en from '../locales/en.json';
import nb from '../locales/nb.json';
import {
  canonicalizeReportedStatistic,
  CENTRAL_STATISTICS,
  doseContextIdentityKey,
  COADMINISTRATION_STATES,
  DOSE_BASES,
  DOSE_CONTEXT_FIELD_KEYS,
  DOSE_NORMALIZED_UNITS,
  REPORTED_STATISTIC_FIELD_KEYS,
  DOSE_REGIMENS,
  INTERVAL_KINDS,
  IV_INPUT_MODES,
  PHYSICAL_FORMS,
  PK_POPULATIONS,
  PRANDIAL_STATES,
  RELEASE_PROFILES,
  roundToScale,
  VALUE_BASES,
  validateDoseContext,
  type DoseContextCoreFields,
  type DoseContextFields,
} from './entryDoseContext';
import {
  parameterEntryPatchSchema,
  sourceQuoteEvidenceUnchanged,
  validateEntryForParameter,
} from './parameterEntries';

type Entry = DoseContextFields & DoseContextCoreFields;

/** A well-formed self-administered, single-dose, oral Cmax reading. */
const base: Entry = {
  centralValue: 0.084,
  centralStatistic: 'arithmetic_mean',
  low: 0.07,
  high: 0.098,
  intervalKind: 'sd',
  unit: 'µmol/L',
  route: 'oral',
  valueBasis: 'concentration',
  doseValue: 2,
  doseUnit: 'mg',
  doseBasis: 'salt',
  doseSaltForm: 'hydrochloride',
  doseRegimen: 'single',
  administeredDrugId: 7,
  releaseProfile: 'immediate',
  physicalForm: 'tablet_capsule',
  prandialState: 'fasted',
  coadministrationState: 'monotherapy',
  pkPopulation: 'healthy_adult',
};

function check(entry: Entry): string | null {
  return validateDoseContext('cmax', 'required', canonicalizeReportedStatistic(entry));
}

describe('validateDoseContext — required', () => {
  it('accepts a complete exact-dose entry', () => {
    expect(check(base)).toBeNull();
  });

  it('accepts a metabolite reading whose administered drug is another substance', () => {
    expect(check({ ...base, administeredDrugId: 99 })).toBeNull();
  });

  it('rejects a missing administeredDrugId', () => {
    expect(check({ ...base, administeredDrugId: null })).toMatch(/administeredDrugId/);
  });

  describe('dose shape', () => {
    it('accepts a range-only dose', () => {
      expect(
        check({ ...base, doseValue: undefined, doseLow: 1, doseHigh: 4 }),
      ).toBeNull();
    });
    it('rejects an exact dose beside a range', () => {
      expect(check({ ...base, doseLow: 1, doseHigh: 4 })).toMatch(/either an exact/);
    });
    it.each([
      [{ doseLow: 1 }],
      [{ doseHigh: 4 }],
    ])('rejects a one-sided range %o', (partial) => {
      expect(check({ ...base, doseValue: undefined, ...partial })).toMatch(
        /both doseLow and doseHigh/,
      );
    });
    it('rejects a degenerate range — author it as doseValue', () => {
      expect(
        check({ ...base, doseValue: undefined, doseLow: 2, doseHigh: 2 }),
      ).toMatch(/state it as doseValue/);
    });
    it('rejects an inverted range and non-positive doses', () => {
      expect(
        check({ ...base, doseValue: undefined, doseLow: 4, doseHigh: 1 }),
      ).toMatch(/greater than/);
      expect(check({ ...base, doseValue: 0 })).toMatch(/positive/);
      expect(check({ ...base, doseValue: -2 })).toMatch(/positive/);
    });
    it('requires a dose unit with a dose', () => {
      expect(check({ ...base, doseUnit: null })).toMatch(/doseUnit/);
    });
    it('rejects a concentration Cmax with no dose at all', () => {
      expect(check({ ...base, doseValue: undefined })).toMatch(/needs the dose/);
    });
    it('keeps absolute and weight-normalized dose families apart for a declared ratio', () => {
      const ratio: Entry = { ...base, valueBasis: 'dose_normalized', unit: 'µmol/L/mg' };
      expect(check(ratio)).toBeNull();
      expect(check({ ...ratio, doseUnit: 'mg/kg' })).toMatch(/different dose families/);
      expect(check({ ...ratio, unit: 'µmol/L/(mg/kg)', doseUnit: 'mg/kg' })).toBeNull();
    });
    it('accepts a declared ratio with no dose at all', () => {
      expect(
        check({
          ...base,
          valueBasis: 'dose_normalized',
          unit: 'µmol/L/mg',
          doseValue: undefined,
          doseUnit: undefined,
          doseBasis: undefined,
          doseSaltForm: undefined,
        }),
      ).toBeNull();
    });
    it('only allows a salt form with a salt basis', () => {
      expect(check({ ...base, doseBasis: 'free-base' })).toMatch(/doseSaltForm/);
    });
  });

  describe('what the number is', () => {
    it('requires valueBasis to store', () => {
      expect(check({ ...base, valueBasis: undefined })).toMatch(/valueBasis is required/);
    });
    it('matches the unit to the value basis', () => {
      expect(check({ ...base, unit: 'µmol/L/mg' })).toMatch(/concentration unit/);
      expect(check({ ...base, valueBasis: 'dose_normalized' })).toMatch(
        /concentration-per-dose/,
      );
    });
    it('generates dose-normalized units that fit the unit column', () => {
      expect(DOSE_NORMALIZED_UNITS).toContain('µmol/L/(mg/kg)');
      for (const unit of DOSE_NORMALIZED_UNITS) expect(unit.length).toBeLessThanOrEqual(20);
    });
  });

  describe('reported statistic', () => {
    it('round-trips mean ± SD, geometric mean with CI, and median with range', () => {
      expect(check(base)).toBeNull();
      expect(
        check({
          ...base,
          centralStatistic: 'geometric_mean',
          centralValue: 5,
          low: 3,
          high: 9,
          intervalKind: 'ci95',
        }),
      ).toBeNull();
      expect(
        check({
          ...base,
          centralStatistic: 'median',
          centralValue: 5,
          low: 2,
          high: 12,
          intervalKind: 'range',
        }),
      ).toBeNull();
    });
    it('canonicalizes the median shorthand to centralValue + median label', () => {
      const out = canonicalizeReportedStatistic({
        ...base,
        centralValue: undefined,
        centralStatistic: undefined,
        median: 0.084,
      });
      expect(out).toMatchObject({ centralValue: 0.084, centralStatistic: 'median' });
      expect(out.median).toBeUndefined();
      expect(check(out)).toBeNull();
    });
    it('treats median and an equal centralValue as one statement', () => {
      expect(
        check({ ...base, centralStatistic: undefined, median: 0.084 }),
      ).toBeNull();
    });
    it('rejects median beside a different centralValue', () => {
      expect(check({ ...base, centralStatistic: undefined, median: 0.09 })).toMatch(
        /disagree/,
      );
    });
    it('rejects the median shorthand contradicting an explicit label', () => {
      expect(
        check({ ...base, centralValue: undefined, median: 0.084 }),
      ).toMatch(/cannot label a arithmetic_mean/);
    });
    it('rejects bounds without an interval kind, and an interval kind without bounds', () => {
      expect(check({ ...base, intervalKind: undefined })).toMatch(/needs an intervalKind/);
      expect(
        check({ ...base, low: undefined, high: undefined, intervalKind: 'range' }),
      ).toMatch(/bounds that are not there/);
    });
    // Codex P1 on #1360: a one-ended interval passed because only SD/SEM
    // demanded both bounds.
    it.each(['range', 'iqr', 'ci95', 'unknown'] as const)(
      'rejects a %s interval with only one endpoint',
      (intervalKind) => {
        const interval: Entry = { ...base, intervalKind, centralValue: 5, low: 4, high: 6 };
        expect(check(interval)).toBeNull();
        expect(check({ ...interval, high: undefined })).toMatch(/both low and high/);
        expect(check({ ...interval, low: undefined })).toMatch(/both low and high/);
      },
    );
    it('requires a centre for SD/SEM, and a symmetric interval', () => {
      expect(
        check({ ...base, centralValue: undefined, centralStatistic: undefined }),
      ).toMatch(/needs the central value/);
      expect(check({ ...base, centralValue: 5, low: 4, high: 9 })).toMatch(/symmetric/);
    });
    it('allows an SD interval with a negative lower end', () => {
      expect(check({ ...base, centralValue: 1, low: -1, high: 3 })).toBeNull();
    });
    it('rejects a centre outside its interval', () => {
      expect(
        check({ ...base, intervalKind: 'range', centralValue: 9, low: 1, high: 5 }),
      ).toMatch(/within low..high/);
    });
    it('stores a censored threshold as centralValue with no label or interval', () => {
      const censored: Entry = {
        ...base,
        centralValue: 5,
        centralStatistic: undefined,
        low: undefined,
        high: undefined,
        intervalKind: undefined,
        qualifier: '<',
      };
      expect(check(censored)).toBeNull();
      expect(check({ ...censored, centralStatistic: 'arithmetic_mean' })).toMatch(
        /censored/,
      );
      expect(check({ ...censored, intervalKind: 'sd' })).toMatch(/censored/);
    });
    it('rejects a single-subject value claiming a cohort', () => {
      const one: Entry = {
        ...base,
        centralStatistic: 'single_subject',
        low: undefined,
        high: undefined,
        intervalKind: undefined,
      };
      expect(check({ ...one, n: 400 })).toMatch(/single-subject/);
      expect(check({ ...one, n: 1 })).toBeNull();
      expect(check(one)).toBeNull();
    });
    it('rejects a statistic label with nothing to label', () => {
      expect(
        check({ ...base, centralValue: undefined, intervalKind: 'range' }),
      ).toMatch(/labels a centralValue/);
    });
  });

  describe('regimen and administration', () => {
    it('rejects a dosing interval on a single dose', () => {
      expect(check({ ...base, doseIntervalHours: 12 })).toMatch(/single dose/);
    });
    it('accepts a steady-state entry with its interval', () => {
      expect(
        check({ ...base, doseRegimen: 'steady_state', doseIntervalHours: 12 }),
      ).toBeNull();
    });
    it('confines doseNumber and regimenDurationHours to a multiple regimen', () => {
      expect(check({ ...base, doseNumber: 3 })).toMatch(/multiple/);
      expect(
        check({ ...base, doseRegimen: 'multiple', doseNumber: 3, regimenDurationHours: 48 }),
      ).toBeNull();
      expect(check({ ...base, doseRegimen: 'multiple', doseNumber: 0 })).toMatch(
        /counts from 1/,
      );
    });
    it('stores a multiple regimen without its exposure position', () => {
      // Flagged `unresolved_exposure_state` by the normalizer, not refused here.
      expect(check({ ...base, doseRegimen: 'multiple' })).toBeNull();
    });
    it('stores a null or unknown regimen', () => {
      expect(check({ ...base, doseRegimen: null })).toBeNull();
      expect(check({ ...base, doseRegimen: 'unknown' })).toBeNull();
    });
    it('rejects a bolus with a duration and an infusion without one', () => {
      const iv: Entry = {
        ...base,
        route: 'iv',
        releaseProfile: 'not_applicable',
        physicalForm: 'solution',
        prandialState: undefined,
      };
      expect(check({ ...iv, ivInputMode: 'bolus' })).toBeNull();
      expect(
        check({ ...iv, ivInputMode: 'bolus', administrationDurationMin: 10 }),
      ).toMatch(/only meaningful for an infusion/);
      expect(check({ ...iv, ivInputMode: 'infusion' })).toMatch(/needs its duration/);
      expect(
        check({ ...iv, ivInputMode: 'infusion', administrationDurationMin: 120 }),
      ).toBeNull();
    });
    it('confines ivInputMode to intravenous administration', () => {
      expect(check({ ...base, ivInputMode: 'bolus' })).toMatch(/intravenous/);
    });
    it('sets releaseProfile and physicalForm independently', () => {
      expect(
        check({ ...base, releaseProfile: 'modified', physicalForm: 'suspension' }),
      ).toBeNull();
    });
  });

  describe('context the source may omit is storable', () => {
    it.each([
      ['centralStatistic', 'unknown'],
      ['intervalKind', 'unknown'],
      ['doseBasis', undefined],
      ['releaseProfile', 'unknown'],
      ['physicalForm', 'unknown'],
      ['prandialState', 'unspecified'],
      ['pkPopulation', 'unknown'],
      ['coadministrationState', 'unknown'],
    ] as const)('%s = %s', (field, value) => {
      const entry: Entry = { ...base, [field]: value };
      if (field === 'doseBasis') entry.doseSaltForm = undefined;
      expect(check(entry)).toBeNull();
    });
  });

  describe('coadministration and population', () => {
    it('names an interacting drug only for an interaction arm', () => {
      expect(check({ ...base, interactingDrugId: 12 })).toMatch(/interactingDrugId/);
      expect(
        check({
          ...base,
          coadministrationState: 'with_interacting_drug',
          interactingDrugId: 12,
        }),
      ).toBeNull();
    });
    it('qualifies only a non-healthy-adult population', () => {
      expect(check({ ...base, populationQualifier: 'CYP2D6 PM' })).toMatch(
        /populationQualifier/,
      );
      expect(
        check({
          ...base,
          pkPopulation: 'metabolizer_phenotype',
          populationQualifier: 'CYP2D6 PM',
        }),
      ).toBeNull();
    });
  });
});

describe('dose context on a parameter that does not declare it', () => {
  it('rejects every dose field through validateEntryForParameter', () => {
    const legacy = { low: 1, high: 2, unit: 'h' };
    expect(validateEntryForParameter('tmax', legacy)).toBeNull();
    const statistic: readonly string[] = REPORTED_STATISTIC_FIELD_KEYS;
    for (const key of DOSE_CONTEXT_FIELD_KEYS.filter((k) => !statistic.includes(k))) {
      const value = key === 'priorDosingRegular' ? true : key.endsWith('Id') ? 1 : 1;
      expect(
        validateEntryForParameter('tmax', { ...legacy, [key]: value }),
        key,
      ).toMatch(/takes no dose context/);
    }
  });
  it('treats explicit nulls as absent', () => {
    expect(
      validateEntryForParameter('tmax', {
        low: 1,
        high: 2,
        unit: 'h',
        valueBasis: null,
        administeredDrugId: null,
      }),
    ).toBeNull();
  });
});

describe('the entry schemas carry dose context instead of stripping it', () => {
  it('keeps every field through the patch schema', () => {
    const parsed = parameterEntryPatchSchema.parse({
      low: 1,
      high: 2,
      unit: 'µmol/L',
      citationId: 3,
      ...base,
    });
    for (const key of DOSE_CONTEXT_FIELD_KEYS) {
      expect(parsed[key as keyof typeof parsed], key).toEqual(base[key]);
    }
  });
});

describe('vocabulary labels', () => {
  const vocabularies = {
    centralStatistic: CENTRAL_STATISTICS,
    intervalKind: INTERVAL_KINDS,
    doseBasis: DOSE_BASES,
    doseRegimen: DOSE_REGIMENS,
    ivInputMode: IV_INPUT_MODES,
    releaseProfile: RELEASE_PROFILES,
    physicalForm: PHYSICAL_FORMS,
    prandialState: PRANDIAL_STATES,
    coadministrationState: COADMINISTRATION_STATES,
    pkPopulation: PK_POPULATIONS,
    valueBasis: VALUE_BASES,
  } as const;
  it.each([
    ['en', en],
    ['nb', nb],
  ] as const)('every member has a %s label', (_lang, locale) => {
    const values = (locale as { doseContext: { values: Record<string, Record<string, string>> } })
      .doseContext.values;
    for (const [field, members] of Object.entries(vocabularies)) {
      expect(Object.keys(values[field] ?? {}).sort(), field).toEqual([...members].sort());
    }
  });
  it('has no parenteral physical form', () => {
    expect(PHYSICAL_FORMS as readonly string[]).not.toContain('parenteral');
  });
});

describe('doseContextIdentityKey', () => {
  it('equates null, absent, and a numeric column string with its number', () => {
    expect(doseContextIdentityKey({ doseValue: '2.000000', doseUnit: 'mg' })).toBe(
      doseContextIdentityKey({ doseValue: 2, doseUnit: 'mg', doseLow: null }),
    );
    expect(doseContextIdentityKey({})).toBe(doseContextIdentityKey({ valueBasis: null }));
  });
  it('separates arms that differ in any context field', () => {
    const arm = { doseValue: 2, doseUnit: 'mg', prandialState: 'fasted' };
    expect(doseContextIdentityKey(arm)).not.toBe(
      doseContextIdentityKey({ ...arm, doseValue: 4 }),
    );
    expect(doseContextIdentityKey(arm)).not.toBe(
      doseContextIdentityKey({ ...arm, prandialState: 'fed' }),
    );
  });
  it('rounds numerics to their column scale, as the stored value is', () => {
    expect(doseContextIdentityKey({ doseValue: 2.0000001 })).toBe(
      doseContextIdentityKey({ doseValue: '2.000000' }),
    );
    expect(doseContextIdentityKey({ doseIntervalHours: 12.00001 })).toBe(
      doseContextIdentityKey({ doseIntervalHours: '12.0000' }),
    );
  });
  it('rounds a decimal tie up, as Postgres does, where toFixed rounds it down', () => {
    // (0.0000005).toFixed(6) is '0.000000'; numeric(14, 6) stores 0.000001.
    expect(doseContextIdentityKey({ doseValue: 0.0000005 })).toBe(
      doseContextIdentityKey({ doseValue: '0.000001' }),
    );
  });
  it('leaves the central value to the same-reading test', () => {
    expect(doseContextIdentityKey({ centralValue: 1 })).toBe(
      doseContextIdentityKey({ centralValue: 2 }),
    );
  });
});

// Codex P1 on #1360: the review card compared a median-shorthand patch raw
// against the stored centralValue and reported the quote lost, while the write
// canonicalizes first and keeps it. Both must answer in stored form.
describe('sourceQuoteEvidenceUnchanged — reported statistic in stored form', () => {
  const stored = {
    ...base,
    centralValue: 5,
    centralStatistic: 'median',
    intervalKind: 'range',
    low: 2,
    high: 12,
    unit: 'µmol/L',
  } as Record<string, unknown>;
  it('treats a median shorthand patch as the centralValue it will be stored as', () => {
    const patch = { ...stored, centralValue: undefined, centralStatistic: undefined, median: 5 };
    expect(sourceQuoteEvidenceUnchanged(stored, patch)).toBe(true);
  });
  it('treats excess digits the column rounds away as the same evidence', () => {
    // Codex review on #1368: the SQL comparison casts to the column type, so
    // the in-memory one used by the review card and withoutStaleEntryQuote
    // has to round the same way or the three disagree.
    const stored = { ...base, low: 0.07, doseValue: 2, doseIntervalHours: 12 };
    const echoed = { ...stored, low: 0.0700000001, doseValue: 2.0000001, doseIntervalHours: 12.00001 };
    expect(sourceQuoteEvidenceUnchanged(stored, echoed)).toBe(true);
    expect(sourceQuoteEvidenceUnchanged(stored, { ...stored, low: 0.071 })).toBe(false);
  });
  it('still sees a changed central value', () => {
    const patch = { ...stored, centralValue: undefined, centralStatistic: undefined, median: 6 };
    expect(sourceQuoteEvidenceUnchanged(stored, patch)).toBe(false);
  });
});

describe('the Cmax registry entry', () => {
  it('is entry-backed with no drug-level value anywhere', async () => {
    const dp = await import('./drugParameters');
    expect(dp.isDrugParameterId('cmax')).toBe(true);
    expect(dp.parameterIsEntryBacked('cmax')).toBe(true);
    expect(dp.parameterAcceptsAuthoredValue('cmax')).toBe(false);
    expect(dp.parameterHasDrugLevelValue('cmax')).toBe(false);
    expect(dp.VISIBLE_PARAMETER_IDS).not.toContain('cmax');
    expect(dp.DRUG_VALUE_PARAMETER_IDS).not.toContain('cmax');
    expect(dp.SUMMARIZED_PARAMETER_IDS).not.toContain('cmax');
    expect(dp.getParametersInGroup('dose_exposure')).not.toContain('cmax');
    expect(dp.ENTRY_ONLY_PARAMETER_IDS).toEqual(['cmax']);
    expect(dp.parameterDoseContextMode('cmax')).toBe('required');
    // Opened in release C.
    expect(dp.parameterAuthoringGated('cmax')).toBe(false);
    expect(dp.parameterAuthoringGated('tmax')).toBe(false);
  });

  it('accepts a complete Cmax entry through the shared validator, and refuses one without context', () => {
    const entry = {
      ...base,
      unit: 'ng/mL',
      matrix: 'plasma',
      centralValue: 84,
      low: 70,
      high: 98,
    } as Parameters<typeof validateEntryForParameter>[1];
    expect(validateEntryForParameter('cmax', entry)).toBeNull();
    expect(validateEntryForParameter('cmax', { ...entry, valueBasis: undefined })).toMatch(
      /valueBasis/,
    );
    expect(validateEntryForParameter('cmax', { ...entry, matrix: undefined })).toMatch(/matrix/);
    expect(
      validateEntryForParameter('cmax', {
        ...entry,
        valueBasis: 'dose_normalized',
        unit: 'ng/mL/mg',
        centralValue: 42,
        low: 35,
        high: 49,
      }),
    ).toBeNull();
  });

  it('bounds the central value like every other value field', () => {
    const entry = { ...base, unit: 'ng/mL', matrix: 'plasma' } as Parameters<
      typeof validateEntryForParameter
    >[1];
    expect(
      validateEntryForParameter('cmax', {
        ...entry,
        intervalKind: 'range',
        centralValue: -1,
        low: -2,
        high: 1,
      }),
    ).toMatch(/outside the allowed range/);
  });
});

// Codex P1s on #1360: every comparison against a stored value has to round the
// way Postgres rounds into the column, and validation has to judge the values
// that will be stored rather than the digits that were sent.
describe('roundToScale — Postgres numeric rounding', () => {
  it('rounds the decimal text half away from zero', () => {
    expect(roundToScale(0.0000005, 6)).toBe(0.000001);
    expect(roundToScale(-0.0000005, 6)).toBe(-0.000001);
    expect(roundToScale(1.23455, 4)).toBe(1.2346);
    expect(roundToScale(1.0000001, 6)).toBe(1);
    expect(roundToScale(0.0000004, 6)).toBe(0);
  });
  it('leaves a value that already fits untouched', () => {
    expect(roundToScale(12.5, 4)).toBe(12.5);
    expect(roundToScale(3, 6)).toBe(3);
    expect(roundToScale(1e21, 6)).toBe(1e21);
  });
  it('carries into the whole part', () => {
    expect(roundToScale(0.9999995, 6)).toBe(1);
    expect(roundToScale(9.99995, 4)).toBe(10);
  });
});

describe('validateDoseContext — judged at the stored precision', () => {
  it('refuses a dose range whose ends store as the same dose', () => {
    const entry = { ...base, doseValue: undefined, doseLow: 1.0000001, doseHigh: 1.0000002 };
    expect(check(entry)).toMatch(/equal ends/);
  });
  it('refuses a positive dose that stores as zero', () => {
    expect(check({ ...base, doseValue: 0.0000004 })).toMatch(/positive/);
  });
  it('still refuses a median and centralValue that differ only past the stored scale', () => {
    // Rounded they agree, but the canonicalizer compares them as sent and so
    // would not fold them into one central value — both would be stored.
    const entry: Entry = {
      ...base,
      centralStatistic: undefined,
      centralValue: 1.0000001,
      median: 1.0000002,
      low: undefined,
      high: undefined,
      intervalKind: undefined,
    };
    expect(check(entry)).toMatch(/median and centralValue disagree/);
  });
  it('accepts a symmetric SD whose rounded centre is a half tick off, as stored', () => {
    // Stored: low 0, centre 0.100001, high 0.200001. The distances differ by
    // exactly one tick, the permitted rounding, but by a hair more in floats.
    const entry: Entry = {
      ...base,
      centralValue: 0.1000005,
      low: 0,
      high: 0.200001,
      intervalKind: 'sd',
    };
    expect(check(entry)).toBeNull();
    expect(check({ ...entry, high: 0.200004 })).toMatch(/symmetric/);
  });
  it('refuses a dosing interval that stores as zero', () => {
    const entry: Entry = { ...base, doseRegimen: 'multiple', doseIntervalHours: 0.00004 };
    expect(check(entry)).toMatch(/doseIntervalHours must be positive/);
  });
});

/**
 * The reported statistic is not dose context: a half-life, Vd or protein
 * binding is a mean, a median or a single subject exactly as a Cmax is. On a
 * parameter that forbids dose context it is OPTIONAL — absent on every legacy
 * entry — and held to the same shape rules when stated.
 */
describe('the reported statistic on an ordinary parameter', () => {
  const meanSd = {
    low: 0.42,
    high: 0.66,
    centralValue: 0.54,
    centralStatistic: 'arithmetic_mean' as const,
    intervalKind: 'sd' as const,
    unit: 'h',
    n: 12,
  };
  const check = (entry: Record<string, unknown>) =>
    validateEntryForParameter('halfLife', entry as never);

  it('accepts a labelled mean ± SD, a labelled range and a legacy median', () => {
    expect(check(meanSd)).toBeNull();
    expect(
      check({ low: 0.3, high: 0.9, intervalKind: 'range', unit: 'h' }),
    ).toBeNull();
    expect(check({ low: 4, high: 6, median: 5, unit: 'h' })).toBeNull();
    // A source that labels its centre but not its bounds: 'unknown' says so.
    expect(check({ ...meanSd, intervalKind: 'unknown' })).toBeNull();
    // A legacy lone bound stays legal while it is not labelled an interval.
    expect(validateEntryForParameter('tmax', { low: 4, unit: 'h' })).toBeNull();
  });

  it('bounds only the centre of an arithmetic interval', () => {
    // 0.3 ± 0.4 h: the low end is arithmetic, not a half-life anyone had.
    expect(
      check({ ...meanSd, low: -0.1, high: 0.7, centralValue: 0.3 }),
    ).toBeNull();
  });

  it.each([
    ['a central value without its statistic', { centralStatistic: undefined }, /needs its centralStatistic/],
    ['a statistic without a central value', { centralValue: undefined, intervalKind: 'range' }, /labels a centralValue/],
    ['an asymmetric SD', { low: 0.4 }, /symmetric/],
    ['an SD with no centre', { centralValue: undefined, centralStatistic: undefined }, /needs the central value/],
    ['an interval kind with one bound', { high: undefined, intervalKind: 'range' }, /both low and high/],
    ['an interval kind with no bounds', { low: undefined, high: undefined, intervalKind: 'range' }, /both low and high|not there/],
    ['a centre outside its bounds', { centralValue: 0.7, intervalKind: 'range' }, /within low\.\.high/],
    ['a statistic on a censored threshold', { qualifier: '<', low: undefined, high: undefined, intervalKind: undefined }, /censored/],
    ['a single subject with a cohort', { centralStatistic: 'single_subject', intervalKind: undefined, low: undefined, high: undefined }, /single-subject/],
    ['a labelled centre beside bounds nobody named', { intervalKind: undefined }, /needs an intervalKind/],
    ['a median beside a mean label', { centralValue: undefined, median: 0.54 }, /shorthand for a median/],
    ['a median that disagrees with the centre', { median: 0.5, centralStatistic: 'median' }, /disagree/],
  ])('refuses %s', (_label, over, message) => {
    expect(check({ ...meanSd, ...over })).toMatch(message);
  });

  it('folds a labelled median shorthand into the central value, and leaves a legacy median alone', () => {
    expect(
      canonicalizeReportedStatistic({ median: 5, intervalKind: 'iqr' as const }),
    ).toEqual({ centralValue: 5, centralStatistic: 'median', intervalKind: 'iqr', median: undefined });
    expect(canonicalizeReportedStatistic({ median: 5 })).toEqual({ median: 5 });
  });

  it('still refuses every dose field beside it', () => {
    expect(check({ ...meanSd, doseValue: 25, doseUnit: 'mg/kg' })).toMatch(
      /takes no dose context/,
    );
  });

  it('does not let a categorical model-structure entry carry one', () => {
    expect(
      validateEntryForParameter('dispositionModel', {
        categoricalValue: 'one-compartment',
        unit: '',
        centralStatistic: 'median',
      } as never),
    ).toMatch(/labels a centralValue/);
  });
});
