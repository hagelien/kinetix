import { describe, it, expect } from 'vitest';
import {
  buildPmChartLines,
  convertPmValue,
  DEFAULT_PM_LINE_SETTINGS,
  normalizePmLineSettings,
  pmHasUsableBloodPlasmaRatio,
  PM_STATISTICS,
  type PmDistribution,
  type PmLineSettings,
  type PmConcentrationSourceInfo,
} from './pmConcentrations';

// Synthetic cohort and row: every name and number below is invented.
const SOURCE: PmConcentrationSourceInfo = {
  key: 'synthetic-test-cohort',
  citation: 'Syntetisk testkohort, oppdiktede tall (kun for tester)',
  shortLabel: 'Syntetisk',
  heading: 'Syntetiske postmortale testdata',
  matrix: 'postmortem_femoral_blood',
  unit: 'mg/L',
  description: '',
  caveats: [],
};

/** An invented analyte's row, shaped like a transcribed source row. */
const FICTAZEPAM: PmDistribution = {
  sourceKey: 'synthetic-test-cohort',
  drugId: 1,
  pubchemCid: 990001,
  analyte: 'Fictazepam',
  n: 1200,
  loq: 0.05,
  mean: 0.3,
  median: 0.125,
  p90: 0.5,
  p95: 0.75,
  p975: 1,
  tcPlasma: 1.5,
  medianOverTc: 0.08,
  anomaly: null,
  undrawable: [],
  reviewNote: null,
  printed: { p90: '0.50' },
};

const FICTAZEPAM_MW = 250;

function settings(overrides: Partial<PmLineSettings> = {}): PmLineSettings {
  return { ...DEFAULT_PM_LINE_SETTINGS, ...overrides };
}

describe('convertPmValue', () => {
  it('converts a whole row from mg/L to µmol/L by molecular weight', () => {
    // µmol/L = mg/L ÷ MW (g/mol) × 1000. With MW 250 the expected figures are
    // exact: LOQ 0.2, mean 1.2, median 0.5, 90th 2, TC 6.
    const toMicromolar = (value: number | null) =>
      convertPmValue(value, {
        targetUnit: 'µmol/L',
        sourceUnit: 'mg/L',
        sourceMatrix: 'postmortem_femoral_blood',
        molecularWeight: FICTAZEPAM_MW,
        displayMatrix: 'whole_blood',
      });

    expect(toMicromolar(FICTAZEPAM.loq)).toBeCloseTo(0.2, 6);
    expect(toMicromolar(FICTAZEPAM.mean)).toBeCloseTo(1.2, 6);
    expect(toMicromolar(FICTAZEPAM.median)).toBeCloseTo(0.5, 6);
    expect(toMicromolar(FICTAZEPAM.p90)).toBeCloseTo(2, 6);
    expect(toMicromolar(FICTAZEPAM.tcPlasma)).toBeCloseTo(6, 6);
  });

  it('passes a value through unchanged when source and target unit agree', () => {
    expect(
      convertPmValue(0.5, {
        targetUnit: 'mg/L',
        sourceUnit: 'mg/L',
        sourceMatrix: 'postmortem_femoral_blood',
        displayMatrix: 'whole_blood',
      }),
    ).toBe(0.5);
  });

  it('refuses a molar target without a molecular weight', () => {
    // Returning an unconverted number here would put a mg/L figure on a
    // µmol/L axis — a line off by the molecular weight, drawn as fact.
    expect(
      convertPmValue(0.5, {
        targetUnit: 'µmol/L',
        sourceUnit: 'mg/L',
        sourceMatrix: 'postmortem_femoral_blood',
        displayMatrix: 'whole_blood',
      }),
    ).toBeNull();
  });

  it('divides by the blood:plasma ratio in plasma mode', () => {
    // Stored figures are whole blood; blood = ratio × plasma.
    expect(
      convertPmValue(0.4, {
        targetUnit: 'mg/L',
        sourceUnit: 'mg/L',
        sourceMatrix: 'postmortem_femoral_blood',
        bloodPlasmaRatio: 2,
        displayMatrix: 'plasma',
      }),
    ).toBeCloseTo(0.2, 6);
  });

  it('reads a representative value out of a blood:plasma range', () => {
    expect(
      convertPmValue(0.4, {
        targetUnit: 'mg/L',
        sourceUnit: 'mg/L',
        sourceMatrix: 'postmortem_femoral_blood',
        bloodPlasmaRatio: { median: 2, min: 1.5, max: 2.5 },
        displayMatrix: 'plasma',
      }),
    ).toBeCloseTo(0.2, 6);
  });

  it('takes the midpoint of a bounds-only blood:plasma ratio', () => {
    // Much of the catalog states B/P as bounds alone (diazepam 0.51-0.59, the
    // alcohols 0.84-0.92). Reading those as "no ratio" reported conversion
    // unavailable for drugs that plainly have one.
    // Midpoint of 0.51-0.59 is 0.55, so 1.1 mg/L whole blood reads as 2 mg/L
    // plasma.
    expect(
      convertPmValue(1.1, {
        targetUnit: 'mg/L',
        sourceUnit: 'mg/L',
        sourceMatrix: 'postmortem_femoral_blood',
        bloodPlasmaRatio: { min: 0.51, max: 0.59 },
        displayMatrix: 'plasma',
      }),
    ).toBeCloseTo(2, 6);
  });

  it('refuses plasma mode without a blood:plasma ratio', () => {
    expect(
      convertPmValue(0.4, {
        targetUnit: 'mg/L',
        sourceUnit: 'mg/L',
        sourceMatrix: 'postmortem_femoral_blood',
        displayMatrix: 'plasma',
      }),
    ).toBeNull();
  });

  it('refuses a non-positive or missing value', () => {
    const ctx = {
      targetUnit: 'mg/L',
      sourceUnit: 'mg/L',
      sourceMatrix: 'postmortem_femoral_blood',
      displayMatrix: 'whole_blood' as const,
    };
    expect(convertPmValue(null, ctx)).toBeNull();
    expect(convertPmValue(Number.NaN, ctx)).toBeNull();
  });
});

describe('buildPmChartLines', () => {
  const context = {
    seriesId: 'series-1',
    distribution: FICTAZEPAM,
    source: SOURCE,
    targetUnit: 'mg/L',
    displayMatrix: 'whole_blood' as const,
    molecularWeight: FICTAZEPAM_MW,
  };

  it('draws median and the 90th percentile by default, and nothing else', () => {
    const lines = buildPmChartLines([context], DEFAULT_PM_LINE_SETTINGS);
    expect(lines.map((l) => l.statistic).sort()).toEqual(['median', 'p90']);
    expect(lines.map((l) => l.y).sort((a, b) => a - b)).toEqual([0.125, 0.5]);
  });

  it('draws nothing while the overlay is switched off', () => {
    expect(
      buildPmChartLines([context], settings({ enabled: false })),
    ).toEqual([]);
  });

  it('withholds a statistic the transcription flagged as undrawable', () => {
    // A synthetic row whose printed 90th percentile (12 mg/L) exceeds its own
    // 97.5th.
    const placebolol: PmDistribution = {
      ...FICTAZEPAM,
      analyte: 'Placebolol',
      median: 0.4,
      p90: 12,
      p95: 2.5,
      p975: 3.5,
      anomaly: 'trykkfeil',
      undrawable: ['p90'],
    };
    const lines = buildPmChartLines(
      [{ ...context, distribution: placebolol }],
      settings({
        statistics: { ...DEFAULT_PM_LINE_SETTINGS.statistics, p95: true },
      }),
    );
    expect(lines.map((l) => l.statistic).sort()).toEqual(['median', 'p95']);
    expect(lines.some((l) => l.y === 12)).toBe(false);
  });

  it('skips a statistic that has no value rather than drawing a zero', () => {
    const lines = buildPmChartLines(
      [{ ...context, distribution: { ...FICTAZEPAM, p90: null } }],
      DEFAULT_PM_LINE_SETTINGS,
    );
    expect(lines.map((l) => l.statistic)).toEqual(['median']);
  });

  it('drops every line for a drug whose plasma conversion is impossible', () => {
    // No blood:plasma ratio: the reader asked for plasma and gets nothing,
    // rather than whole-blood numbers silently relabelled as plasma.
    const lines = buildPmChartLines(
      [{ ...context, displayMatrix: 'plasma' as const }],
      settings(),
    );
    expect(lines).toEqual([]);
  });

  it('records the destination matrix so the caller can label it', () => {
    // The matrix choice persists across sessions; without this the next visit
    // draws B/P-derived values under the published statistic's name.
    const lines = buildPmChartLines(
      [{ ...context, bloodPlasmaRatio: 0.55, displayMatrix: 'plasma' as const }],
      settings(),
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.convertedTo === 'plasma')).toBe(true);

    const asPublished = buildPmChartLines([context], DEFAULT_PM_LINE_SETTINGS);
    expect(asPublished.every((l) => l.convertedTo == null)).toBe(true);
  });

  it('labels a reverse conversion by its whole-blood destination', () => {
    // A plasma cohort shown in the default whole-blood view is converted TO
    // whole blood — the destination the label must name, not "(plasma)".
    const plasmaCohort = {
      ...context,
      source: { ...SOURCE, matrix: 'plasma' },
      bloodPlasmaRatio: 0.55,
      displayMatrix: 'whole_blood' as const,
    };
    const lines = buildPmChartLines([plasmaCohort], settings());
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.convertedTo === 'whole_blood')).toBe(true);
  });

  it('does not call an untransformed plasma cohort converted', () => {
    // The arithmetic passes it through; the label must agree. Calling it
    // converted would describe a published percentile as derived — the same
    // error the labelling exists to prevent, pointed the other way.
    const plasmaCohort = {
      ...context,
      source: { ...SOURCE, matrix: 'plasma' },
      bloodPlasmaRatio: 0.55,
      displayMatrix: 'plasma' as const,
    };
    const lines = buildPmChartLines([plasmaCohort], settings());
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.convertedTo == null)).toBe(true);
  });

  it('leaves a cohort that is already plasma alone in plasma mode', () => {
    // Only latent today — the one shipped cohort is whole blood — but the
    // schema takes any matrix and the documented growth path is "add a cohort".
    // Dividing a plasma cohort by B/P would plot it at a height nobody
    // measured.
    const plasmaCohort = {
      ...context,
      source: { ...SOURCE, matrix: 'plasma' },
      bloodPlasmaRatio: 0.55,
      displayMatrix: 'plasma' as const,
    };
    const lines = buildPmChartLines([plasmaCohort], settings());
    expect(lines.find((l) => l.statistic === 'median')?.y).toBeCloseTo(0.125, 6);
  });

  it('declines plasma mode for a matrix it does not recognise', () => {
    const oddCohort = {
      ...context,
      source: { ...SOURCE, matrix: 'urine' },
      bloodPlasmaRatio: 0.55,
      displayMatrix: 'plasma' as const,
    };
    expect(buildPmChartLines([oddCohort], settings())).toEqual([]);
  });

  it('keeps each line on its own series', () => {
    const other = {
      ...context,
      seriesId: 'series-2',
      distribution: { ...FICTAZEPAM, drugId: 2, median: 1.5 },
    };
    const lines = buildPmChartLines([context, other], DEFAULT_PM_LINE_SETTINGS);
    expect(new Set(lines.map((l) => l.seriesId))).toEqual(
      new Set(['series-1', 'series-2']),
    );
    expect(
      lines.find((l) => l.seriesId === 'series-2' && l.statistic === 'median')
        ?.y,
    ).toBe(1.5);
  });
});

describe('pmHasUsableBloodPlasmaRatio', () => {
  // The panel's message names the missing B/P ratio, so the predicate behind it
  // has to test the ratio and nothing else. Inferring it from a failed
  // conversion also catches "no molecular weight" and "no such statistic", and
  // sends the reader to fill in a value that was never the problem.
  it('accepts a scalar, a median and bounds alone', () => {
    expect(pmHasUsableBloodPlasmaRatio(0.55)).toBe(true);
    expect(pmHasUsableBloodPlasmaRatio({ median: 0.6 })).toBe(true);
    expect(pmHasUsableBloodPlasmaRatio({ min: 0.51, max: 0.59 })).toBe(true);
  });

  it('rejects what cannot be divided by', () => {
    expect(pmHasUsableBloodPlasmaRatio(null)).toBe(false);
    expect(pmHasUsableBloodPlasmaRatio(undefined)).toBe(false);
    expect(pmHasUsableBloodPlasmaRatio(0)).toBe(false);
    expect(pmHasUsableBloodPlasmaRatio({ note: 'ukjent' })).toBe(false);
  });

  it('is independent of the reasons a conversion can fail', () => {
    // A drug with a perfectly good ratio, on a molar axis with no molecular
    // weight: the conversion fails, the ratio is not the reason.
    const ratio = 0.55;
    expect(
      convertPmValue(0.5, {
        targetUnit: 'µmol/L',
        sourceUnit: 'mg/L',
        sourceMatrix: 'postmortem_femoral_blood',
        bloodPlasmaRatio: ratio,
        displayMatrix: 'plasma',
      }),
    ).toBeNull();
    expect(pmHasUsableBloodPlasmaRatio(ratio)).toBe(true);
  });
});

describe('normalizePmLineSettings', () => {
  it('falls back to the defaults for an empty blob', () => {
    expect(normalizePmLineSettings(undefined)).toEqual(
      DEFAULT_PM_LINE_SETTINGS,
    );
  });

  it('keeps a stored choice', () => {
    const stored = normalizePmLineSettings({
      enabled: false,
      statistics: { median: false, p975: true },
    });
    expect(stored.enabled).toBe(false);
    expect(stored.statistics.median).toBe(false);
    expect(stored.statistics.p975).toBe(true);
  });

  it('fills in a statistic a stale blob never heard of', () => {
    // A blob written before a statistic existed must not hide it forever.
    const stored = normalizePmLineSettings({ statistics: { median: false } });
    for (const stat of PM_STATISTICS) {
      expect(typeof stored.statistics[stat.id]).toBe('boolean');
    }
    expect(stored.statistics.p90).toBe(true);
  });

  it('ignores keys the registry no longer knows', () => {
    const stored = normalizePmLineSettings({
      statistics: { p99: true, median: true },
    });
    expect(Object.keys(stored.statistics).sort()).toEqual(
      PM_STATISTICS.map((s) => s.id).sort(),
    );
  });
});
