/**
 * The Cmax normalizer and summary, against the RFC's *Tests required before
 * merge → Normalization / Aggregation* list. Numbers are asserted, not just
 * eligibility: a direction or unit error is invisible to a test that only
 * checks which variant came back.
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeCmaxEntry,
  resolveBloodPlasmaRatio,
  summarizeCmax,
  type CmaxNormalizationContext,
  type CmaxSourceEntry,
  type RatioSourceEntry,
} from './cmaxNormalization';
import { ROUTE_IDS } from './kinetics-core';

const MW = 303.35; // cocaine, g/mol
const ctx: CmaxNormalizationContext = { molecularWeight: MW, bloodPlasma: { ratio: 0.5 } };

/** A fully resolved oral single-dose reading: 303.35 ng/mL after 2 mg → 1 µmol/L / 2 mg. */
function entry(over: Partial<CmaxSourceEntry> = {}, dc: Record<string, unknown> = {}): CmaxSourceEntry {
  return {
    entryId: 1,
    low: null,
    high: null,
    median: null,
    qualifier: null,
    unit: 'ng/mL',
    matrix: 'plasma',
    route: 'oral',
    n: 10,
    reviewScore: 80,
    citationId: 5,
    ...over,
    doseContext: {
      valueBasis: 'concentration',
      centralValue: 303.35,
      centralStatistic: 'arithmetic_mean',
      doseValue: 2,
      doseUnit: 'mg',
      doseBasis: 'free-base',
      doseRegimen: 'single',
      releaseProfile: 'immediate',
      physicalForm: 'tablet_capsule',
      prandialState: 'fasted',
      coadministrationState: 'monotherapy',
      pkPopulation: 'healthy_adult',
      administeredDrugId: 42,
      ...dc,
    },
  };
}

function valueOf(e: CmaxSourceEntry, c = ctx): number | undefined {
  const o = normalizeCmaxEntry(e, c);
  return o.kind === 'ineligible' ? undefined : o.entry.normalizedCentralValue;
}

function reasonOf(e: CmaxSourceEntry, c = ctx): string {
  const o = normalizeCmaxEntry(e, c);
  return o.kind === 'poolable' ? 'poolable' : o.reason;
}

describe('normalizeCmaxEntry — the arithmetic', () => {
  it('converts the unit before dividing: 303.35 ng/mL of MW 303.35 after 2 mg is 0.5 µmol/L/mg', () => {
    const o = normalizeCmaxEntry(entry(), ctx);
    expect(o.kind).toBe('poolable');
    if (o.kind !== 'poolable') return;
    expect(o.entry.normalizedCentralValue).toBeCloseTo(0.5, 9);
    expect(o.entry.normalizedUnit).toBe('µmol/L/mg');
    expect(o.entry.normalizedMatrix).toBe('plasma');
  });

  it('normalizes µg, mg and g doses identically', () => {
    const mg = valueOf(entry());
    expect(valueOf(entry({}, { doseValue: 2000, doseUnit: 'µg' }))).toBeCloseTo(mg!, 9);
    expect(valueOf(entry({}, { doseValue: 0.002, doseUnit: 'g' }))).toBeCloseTo(mg!, 9);
  });

  it('normalizes µg/kg and mg/kg identically, and never into the mg family', () => {
    const a = normalizeCmaxEntry(entry({}, { doseValue: 0.03, doseUnit: 'mg/kg' }), ctx);
    const b = normalizeCmaxEntry(entry({}, { doseValue: 30, doseUnit: 'µg/kg' }), ctx);
    if (a.kind !== 'poolable' || b.kind !== 'poolable') throw new Error('expected poolable');
    expect(a.entry.normalizedCentralValue).toBeCloseTo(b.entry.normalizedCentralValue, 9);
    expect(a.entry.normalizedUnit).toBe('µmol/L/(mg/kg)');
  });

  // The RFC's direction check: plasma = blood / r, so blood 10 with r 0.5 is plasma 20.
  it('converts whole blood to plasma by DIVIDING by the ratio', () => {
    const blood = entry({ matrix: 'whole_blood', unit: 'µmol/L' }, { centralValue: 10, doseValue: 1 });
    expect(valueOf(blood)).toBeCloseTo(20, 9);
  });

  it('treats serum as plasma without consulting the ratio', () => {
    const serum = entry({ matrix: 'serum' });
    expect(valueOf(serum, { molecularWeight: MW, bloodPlasma: { reason: 'unsourced_matrix_ratio' } })).toBeCloseTo(0.5, 9);
  });

  it('passes a declared ratio through, converting both halves of its unit', () => {
    const perMg = entry({ unit: 'µmol/L/mg' }, { valueBasis: 'dose_normalized', centralValue: 0.5 });
    const perUg = entry({ unit: 'µmol/L/µg' }, { valueBasis: 'dose_normalized', centralValue: 0.0005 });
    expect(valueOf(perMg)).toBeCloseTo(0.5, 9);
    expect(valueOf(perUg)).toBeCloseTo(0.5, 9);
  });

  it('never substitutes a midpoint for a missing central value', () => {
    const o = normalizeCmaxEntry(
      entry({ low: 200, high: 400 }, { centralValue: null, centralStatistic: null, intervalKind: 'range' }),
      ctx,
    );
    expect(o.kind).toBe('normalized_not_poolable');
    if (o.kind !== 'normalized_not_poolable') return;
    expect(o.reason).toBe('missing_central_value');
    expect(o.entry.normalizedCentralValue).toBeUndefined();
    expect(o.entry.normalizedLow).toBeGreaterThan(0);
  });
});

describe('normalizeCmaxEntry — eligibility', () => {
  it.each([
    ['a concentration with a dose range', {}, { doseValue: null, doseLow: 1, doseHigh: 4 }, 'dose_range_without_exact_dose'],
    ['no route', { route: null }, {}, 'missing_route'],
    ["route 'other'", { route: 'other' }, {}, 'unresolved_route'],
    ["statistic 'unknown'", {}, { centralStatistic: 'unknown' }, 'unlabelled_statistic'],
    ['no dose basis', {}, { doseBasis: null }, 'unknown_dose_basis'],
    ['an off-axis matrix', { matrix: 'urine' }, {}, 'unsupported_matrix_conversion'],
    ['a mass unit with no molecular weight', {}, {}, 'missing_molecular_weight'],
    ["release profile 'unknown'", {}, { releaseProfile: 'unknown' }, 'unknown_formulation'],
    ["physical form 'other'", {}, { physicalForm: 'other' }, 'unknown_formulation'],
    ['oral with fed state unspecified', {}, { prandialState: 'unspecified' }, 'unknown_prandial_state'],
    ['a null regimen', {}, { doseRegimen: null }, 'unknown_dose_regimen'],
    ["regimen 'unknown'", {}, { doseRegimen: 'unknown' }, 'unknown_dose_regimen'],
    ['steady state with no interval', {}, { doseRegimen: 'steady_state' }, 'missing_dosing_interval'],
    ['multiple doses with no exposure position', {}, { doseRegimen: 'multiple', doseIntervalHours: 12, priorDosingRegular: true }, 'unresolved_exposure_state'],
    // Codex P1 on #1387: repeated dosing needs priorDosingRegular: true.
    ['steady state with prior dosing unstated', {}, { doseRegimen: 'steady_state', doseIntervalHours: 24 }, 'unsupported_regimen_context'],
    ['steady state with irregular prior dosing', {}, { doseRegimen: 'steady_state', doseIntervalHours: 24, priorDosingRegular: false }, 'unsupported_regimen_context'],
    ['multiple doses with prior dosing unstated', {}, { doseRegimen: 'multiple', doseIntervalHours: 12, doseNumber: 3 }, 'unsupported_regimen_context'],
    ['multiple doses with irregular prior dosing', {}, { doseRegimen: 'multiple', doseIntervalHours: 12, doseNumber: 3, priorDosingRegular: false }, 'unsupported_regimen_context'],
    // Codex on #1387: a ratio with no stated dose still needs its basis — "per mg"
    // of salt, free base, parent or active moiety are different quantities.
    ['a declared ratio with neither dose nor basis', { unit: 'µmol/L/mg' }, { valueBasis: 'dose_normalized', centralValue: 0.5, doseValue: null, doseUnit: null, doseBasis: null }, 'unknown_dose_basis'],
    ['an interaction arm', {}, { coadministrationState: 'with_interacting_drug' }, 'interaction_arm_not_pooled'],
    ["coadministration 'unknown'", {}, { coadministrationState: 'unknown' }, 'unknown_coadministration_state'],
    ['an altered population', {}, { pkPopulation: 'renal_impairment' }, 'altered_population_not_pooled'],
    ["population 'other'", {}, { pkPopulation: 'other' }, 'unknown_population'],
  ] as const)('%s → %s', (_label, over, dc, reason) => {
    const c = reason === 'missing_molecular_weight' ? { ...ctx, molecularWeight: null } : ctx;
    expect(reasonOf(entry(over as Partial<CmaxSourceEntry>, dc), c)).toBe(reason);
  });

  it('refuses a whole-blood reading for each way the ratio can be missing', () => {
    for (const reason of [
      'unsourced_matrix_ratio',
      'bounds_only_matrix_ratio',
      'censored_matrix_ratio',
      'missing_matrix_conversion',
    ] as const) {
      expect(reasonOf(entry({ matrix: 'whole_blood' }), { molecularWeight: MW, bloodPlasma: { reason } })).toBe(reason);
    }
  });

  it('applies the route-conditional requirements to exactly their own route, for every route', () => {
    for (const route of ROUTE_IDS) {
      if (route === 'other') continue;
      const noFed = reasonOf(entry({ route }, { prandialState: null, ivInputMode: route === 'iv' ? 'bolus' : null }));
      expect(noFed, route).toBe(route === 'oral' ? 'unknown_prandial_state' : 'poolable');
      const noInput = reasonOf(entry({ route }, { ivInputMode: null }));
      expect(noInput, route).toBe(route === 'iv' ? 'unknown_iv_input_mode' : 'poolable');
    }
  });

  it.each([
    ['a declared ratio with no dose', { unit: 'µmol/L/mg' }, { valueBasis: 'dose_normalized', centralValue: 0.5, doseValue: null, doseUnit: null }, 'unstated_dose_level'],
    ['a salt with no salt form', {}, { doseBasis: 'salt' }, 'unspecified_salt_form'],
    ['a censored threshold', { qualifier: '<' }, { centralStatistic: null }, 'censored_value'],
  ] as const)('normalizes but does not pool %s', (_label, over, dc, reason) => {
    const o = normalizeCmaxEntry(entry(over as Partial<CmaxSourceEntry>, dc), ctx);
    expect(o.kind).toBe('normalized_not_poolable');
    if (o.kind === 'normalized_not_poolable') expect(o.reason).toBe(reason);
  });
});

describe('normalizeCmaxEntry — repeated dosing that does pool', () => {
  it('pools a verified steady state and a positioned multiple dose with regular prior dosing', () => {
    expect(
      reasonOf(entry({}, { doseRegimen: 'steady_state', doseIntervalHours: 24, priorDosingRegular: true })),
    ).toBe('poolable');
    expect(
      reasonOf(
        entry({}, { doseRegimen: 'multiple', doseIntervalHours: 12, doseNumber: 3, priorDosingRegular: true }),
      ),
    ).toBe('poolable');
  });
});

describe('resolveBloodPlasmaRatio', () => {
  const sourced = (over: Partial<RatioSourceEntry>): RatioSourceEntry => ({
    median: 0.8,
    low: null,
    high: null,
    qualifier: null,
    n: 10,
    reviewScore: 50,
    citationId: 1,
    origin: 'legacy',
    ...over,
  });

  it('refuses a hand-authored estimate with no source', () => {
    expect(resolveBloodPlasmaRatio([sourced({ citationId: null })])).toEqual({ reason: 'unsourced_matrix_ratio' });
    expect(resolveBloodPlasmaRatio([sourced({ origin: 'grandfathered' })])).toEqual({ reason: 'unsourced_matrix_ratio' });
  });

  it('refuses bounds-only and censored ratios, and never midpoints', () => {
    expect(resolveBloodPlasmaRatio([sourced({ median: null, low: 0.6, high: 1 })])).toEqual({ reason: 'bounds_only_matrix_ratio' });
    expect(resolveBloodPlasmaRatio([sourced({ qualifier: '<' })])).toEqual({ reason: 'censored_matrix_ratio' });
  });

  it('excludes a zero ratio rather than letting it drag the median', () => {
    expect(resolveBloodPlasmaRatio([sourced({ median: 0, n: 1000 }), sourced({ median: 0.8 })])).toEqual({ ratio: 0.8 });
    expect(resolveBloodPlasmaRatio([sourced({ median: 0 })])).toEqual({ reason: 'missing_matrix_conversion' });
  });

  it('takes the weighted median of several, ties downward', () => {
    expect(resolveBloodPlasmaRatio([sourced({ median: 0.6 }), sourced({ median: 0.9 })])).toEqual({ ratio: 0.6 });
  });
});

describe('summarizeCmax', () => {
  it('pools only identical strata and shows one headline for one stratum', () => {
    const s = summarizeCmax(
      [
        entry({ entryId: 1, n: 10 }, { centralValue: 303.35 }),
        entry({ entryId: 2, n: 30 }, { centralValue: 606.7 }),
        entry({ entryId: 3, n: 10 }, { centralValue: 303.35, doseValue: 4 }),
      ],
      ctx,
    );
    expect(s.strata).toHaveLength(2);
    expect(s.headline).toEqual({ kind: 'multiple', strata: 2 });
    const twoMg = s.strata.find((st) => st.cohorts === 2)!;
    // Weighted median: the n=30 cohort carries three quarters of the weight.
    expect(twoMg.value).toBeCloseTo(1, 9);
    expect(twoMg.spread!.low).toBeCloseTo(0.5, 9);
    expect(twoMg.spread!.high).toBeCloseTo(1, 9);
  });

  it('never pools different salt forms, statistics or fed states', () => {
    const s = summarizeCmax(
      [
        entry({ entryId: 1 }, { doseBasis: 'salt', doseSaltForm: 'hydrochloride' }),
        entry({ entryId: 2 }, { doseBasis: 'salt', doseSaltForm: 'mesylate' }),
        entry({ entryId: 3 }, { centralStatistic: 'geometric_mean' }),
        entry({ entryId: 4 }, { prandialState: 'fed' }),
      ],
      ctx,
    );
    expect(s.strata).toHaveLength(4);
  });

  it('pools two IV entries with no fed state together', () => {
    const iv = { route: 'iv' } as const;
    const s = summarizeCmax(
      [
        entry({ entryId: 1, ...iv }, { prandialState: null, ivInputMode: 'bolus', releaseProfile: 'not_applicable', physicalForm: 'solution' }),
        entry({ entryId: 2, ...iv }, { prandialState: null, ivInputMode: 'bolus', releaseProfile: 'not_applicable', physicalForm: 'solution' }),
      ],
      ctx,
    );
    expect(s.strata).toHaveLength(1);
    expect(s.headline.kind).toBe('single');
  });

  it('shows a single cohort with its own interval, and no headline with no poolable entry', () => {
    const one = summarizeCmax([entry({ low: 242.68, high: 364.02 }, { intervalKind: 'sd' })], ctx);
    expect(one.headline.kind).toBe('single');
    expect(one.strata[0]!.spread).toBeNull();
    expect(one.strata[0]!.ownInterval).toMatchObject({ kind: 'sd' });
    expect(summarizeCmax([entry({ route: null })], ctx).headline).toEqual({ kind: 'none' });
  });
});
