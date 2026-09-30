import { describe, expect, it } from 'vitest';
import {
  DETECTION_BANDS,
  DETECTION_MATRICES,
  DETECTION_WINDOW_PARAMETERS,
  detectionBandForHours,
  detectionBandsFromCachedValues,
  detectionSpan,
  detectionWindowFor,
  detectionWindowsFor,
  hasAnyDetectionData,
  hasDetectionData,
} from './detectionWindows';
import {
  DRUG_PARAMETERS,
  getRangeSpec,
  parameterIsSummarizable,
  type DrugParameterId,
} from './drugParameters';
import type { ParameterSummary } from './parameterEntryAggregation';

function summary(over: Partial<ParameterSummary> = {}): ParameterSummary {
  return {
    representative: null,
    iqrLow: null,
    iqrHigh: null,
    min: null,
    max: null,
    unit: 'h',
    entryCount: 0,
    pooledCount: 0,
    contributingCitationIds: [],
    byMatrix: [],
    points: [],
    normalizedToWholeBlood: false,
    ...over,
  };
}

describe('DETECTION_MATRICES', () => {
  it('is a view over the parameter registry, not a second registry', () => {
    for (const spec of DETECTION_MATRICES) {
      expect(
        DRUG_PARAMETERS[spec.parameter],
        `${spec.parameter} is not a registry parameter`,
      ).toBeDefined();
      // The module reads hours out of the pooled aggregate and derives its
      // bands from them; a parameter in another unit would be silently
      // mis-banded.
      expect(getRangeSpec(spec.parameter).canonicalUnit).toBe('h');
    }
  });

  it('only lists source-value-backed parameters', () => {
    // The kildeverdier paradigm is the whole point: every number the module
    // shows must be traceable to a cited source value, so a hand-authored
    // parameter must never appear here.
    for (const parameter of DETECTION_WINDOW_PARAMETERS) {
      expect(parameterIsSummarizable(parameter as DrugParameterId)).toBe(true);
    }
  });

  it('covers every detection-window parameter the registry defines', () => {
    const registryWindows = (
      Object.keys(DRUG_PARAMETERS) as DrugParameterId[]
    ).filter((id) => id.endsWith('DetectionWindow'));
    expect([...DETECTION_WINDOW_PARAMETERS].sort()).toEqual(
      registryWindows.sort(),
    );
  });
});

describe('detectionBandForHours', () => {
  it('places each window in the band a report would speak in', () => {
    expect(detectionBandForHours(6)).toBe('halfDay');
    expect(detectionBandForHours(12)).toBe('halfDay');
    expect(detectionBandForHours(13)).toBe('day');
    expect(detectionBandForHours(24)).toBe('day');
    expect(detectionBandForHours(48)).toBe('days');
    expect(detectionBandForHours(96)).toBe('days');
    expect(detectionBandForHours(120)).toBe('week');
    expect(detectionBandForHours(168)).toBe('week');
    expect(detectionBandForHours(240)).toBe('twoWeeks');
    expect(detectionBandForHours(336)).toBe('twoWeeks');
    expect(detectionBandForHours(500)).toBe('weeks');
    expect(detectionBandForHours(720)).toBe('weeks');
    expect(detectionBandForHours(721)).toBe('monthPlus');
    expect(detectionBandForHours(8760)).toBe('monthPlus');
  });

  it('returns every band it can name', () => {
    const produced = new Set(
      [6, 20, 48, 150, 300, 600, 5000].map((h) => detectionBandForHours(h)),
    );
    expect([...produced].sort()).toEqual([...DETECTION_BANDS].sort());
  });

  it('refuses values that cannot be a detection time', () => {
    // A negative or non-finite window is a data error. Clamping it into
    // "the last half day" would hide the error behind a plausible chip.
    expect(detectionBandForHours(null)).toBeNull();
    expect(detectionBandForHours(undefined)).toBeNull();
    expect(detectionBandForHours(-1)).toBeNull();
    expect(detectionBandForHours(Number.NaN)).toBeNull();
    expect(detectionBandForHours(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('treats zero as the shortest band rather than as no data', () => {
    expect(detectionBandForHours(0)).toBe('halfDay');
  });
});

describe('detectionWindowFor', () => {
  const urine = DETECTION_MATRICES.find((m) => m.key === 'urine')!;

  it('reads the pooled edges and derives the band from the far edge', () => {
    const window = detectionWindowFor(urine, {
      urineDetectionWindow: summary({
        min: 48,
        max: 336,
        representative: 120,
        entryCount: 4,
        pooledCount: 3,
        contributingCitationIds: [11, 12, 13],
      }),
    });

    expect(window.lowHours).toBe(48);
    expect(window.highHours).toBe(336);
    expect(window.representativeHours).toBe(120);
    // 120 h would read "the last week"; the window reaches two weeks, and
    // that longer reach is the statement a detection time makes.
    expect(window.band).toBe('twoWeeks');
    expect(window.entryCount).toBe(4);
    expect(window.pooledCount).toBe(3);
    expect(window.citationCount).toBe(3);
  });

  it('falls back to the median, then the near edge, when there is no far edge', () => {
    expect(
      detectionWindowFor(urine, {
        urineDetectionWindow: summary({ representative: 20, entryCount: 1 }),
      }).band,
    ).toBe('day');
    expect(
      detectionWindowFor(urine, {
        urineDetectionWindow: summary({ min: 200, entryCount: 1 }),
      }).band,
    ).toBe('twoWeeks');
  });

  it('returns an empty window rather than nothing for a matrix with no sources', () => {
    const window = detectionWindowFor(urine, {});
    expect(window.key).toBe('urine');
    expect(window.parameter).toBe('urineDetectionWindow');
    expect(window.band).toBeNull();
    expect(window.entryCount).toBe(0);
    expect(hasDetectionData(window)).toBe(false);
  });

  it('reports a matrix whose sources exist but do not pool', () => {
    // Entries that could not be pooled still mean "someone has recorded a
    // source value here" — the module offers the source list either way.
    const window = detectionWindowFor(urine, {
      urineDetectionWindow: summary({ entryCount: 2, pooledCount: 0 }),
    });
    expect(hasDetectionData(window)).toBe(true);
    expect(window.band).toBeNull();
    expect(window.pooledCount).toBe(0);
  });
});

describe('detectionWindowsFor', () => {
  it('answers for every matrix, in display order, from one summary map', () => {
    const windows = detectionWindowsFor({
      bloodDetectionWindow: summary({ max: 10, entryCount: 1 }),
      urineDetectionWindow: summary({ max: 300, entryCount: 2 }),
    });

    expect(windows.map((w) => w.key)).toEqual(['blood', 'oralFluid', 'urine']);
    expect(windows.map((w) => w.band)).toEqual(['halfDay', null, 'twoWeeks']);
    expect(hasAnyDetectionData(windows)).toBe(true);
  });

  it('handles a substance with no summaries at all', () => {
    const windows = detectionWindowsFor(null);
    expect(windows).toHaveLength(DETECTION_MATRICES.length);
    expect(hasAnyDetectionData(windows)).toBe(false);
  });
});

describe('detectionBandsFromCachedValues', () => {
  const derived = (over: Record<string, unknown>) => ({
    unit: 'h',
    derivedFromEntries: true,
    ...over,
  });

  it('bands each matrix from the recomputed cache', () => {
    const bands = detectionBandsFromCachedValues({
      bloodDetectionWindow: derived({ min: 6, max: 20, median: 12 }),
      urineDetectionWindow: derived({ min: 96, max: 336 }),
    });

    expect(bands.map((b) => b.key)).toEqual(['blood', 'oralFluid', 'urine']);
    expect(bands.map((b) => b.band)).toEqual(['day', null, 'twoWeeks']);
  });

  it('falls back to the representative when the cache has no upper edge', () => {
    const [blood] = detectionBandsFromCachedValues({
      bloodDetectionWindow: derived({ median: 20 }),
    });
    expect(blood!.band).toBe('day');
  });

  it('refuses a value that is not derived from source values', () => {
    // A grandfathered legacy reading is displayed elsewhere with its provenance
    // visible. Banded into a listing that cannot say so, it would read as a
    // pooled result.
    const [blood] = detectionBandsFromCachedValues({
      bloodDetectionWindow: { min: 6, max: 20, unit: 'h', note: 'legacy import' },
    });
    expect(blood!.band).toBeNull();
  });

  it('refuses a value that is not in hours', () => {
    const [blood] = detectionBandsFromCachedValues({
      bloodDetectionWindow: derived({ min: 6, max: 20, unit: 'd' }),
    });
    expect(blood!.band).toBeNull();
  });

  it('answers for every matrix even with nothing to read', () => {
    expect(detectionBandsFromCachedValues(null).map((b) => b.band)).toEqual([
      null,
      null,
      null,
    ]);
  });
});

describe('detectionSpan', () => {
  const spec = DETECTION_MATRICES[0]!;
  const windowWith = (over: Partial<ParameterSummary>) =>
    detectionWindowFor(spec, { [spec.parameter]: summary(over) });

  it('keeps short windows in hours', () => {
    const span = detectionSpan(windowWith({ min: 4, max: 12, representative: 8 }));
    expect(span).toEqual({ unit: 'hours', low: 4, high: 12, representative: 8 });
  });

  it('switches to days once the window outgrows a couple of days', () => {
    const span = detectionSpan(windowWith({ min: 24, max: 96, representative: 48 }));
    expect(span).toEqual({ unit: 'days', low: 1, high: 4, representative: 2 });
  });

  it('switches to weeks for the longest windows', () => {
    const span = detectionSpan(windowWith({ min: 168, max: 672, representative: 336 }));
    expect(span).toEqual({ unit: 'weeks', low: 1, high: 4, representative: 2 });
  });

  it('expresses every edge in the same unit', () => {
    // The whole point of picking one unit: "24 h–3 weeks" would ask the reader
    // to compare two scales in their head.
    const span = detectionSpan(windowWith({ min: 24, max: 504 }))!;
    expect(span.unit).toBe('weeks');
    expect(span.low).toBeCloseTo(24 / 168, 6);
    expect(span.high).toBe(3);
  });

  it('is null when the window carries no number', () => {
    expect(detectionSpan(windowWith({ entryCount: 2, pooledCount: 0 }))).toBeNull();
  });
});
