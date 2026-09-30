import { describe, expect, it } from 'vitest';
import { simulatorResultsToModelingSeries } from '@/lib/modelingAdapters';
import type { DrugSimResult } from '@/types/simulator';

function makeResult(overrides: Partial<DrugSimResult> = {}): DrugSimResult {
  return {
    drugConfigId: 'c1',
    questionMode: 'concentration-from-dose',
    median: 1,
    p05: 0.5,
    p25: 0.8,
    p75: 1.2,
    p95: 1.5,
    unit: 'mg/L',
    timeSeries: [
      { t: 0, p05: 0, p25: 0, median: 0, p75: 0, p95: 0 },
      { t: 2, p05: 0.4, p25: 0.6, median: 0.8, p75: 1.0, p95: 1.2 },
      { t: 4, p05: 0.2, p25: 0.3, median: 0.4, p75: 0.5, p95: 0.6 },
    ],
    assumptions: {
      model: 'test',
      route: 'oral',
      halfLife: { type: 'fixed', value: 4 },
      vd: { type: 'fixed', value: 50 },
      f: { type: 'fixed', value: 1 },
      weightScaling: false,
    },
    sensitivity: [],
    warnings: [],
    seed: 1,
    drawCount: 100,
    ...overrides,
  };
}

describe('simulatorResultsToModelingSeries anchor offset', () => {
  it('shifts every curve point by the result anchorTime (absolute frame)', () => {
    const series = simulatorResultsToModelingSeries({
      c1: makeResult({ anchorTime: 5.45 }),
    });
    // The relative curve (t = 0, 2, 4) lands on the absolute dose frame.
    expect(series[0]!.points.map((p) => p.x)).toEqual([5.45, 7.45, 9.45]);
  });

  it('leaves the curve in the relative frame when no anchor is stamped', () => {
    const series = simulatorResultsToModelingSeries({ c1: makeResult() });
    expect(series[0]!.points.map((p) => p.x)).toEqual([0, 2, 4]);
  });

  it('preserves the uncertainty bands while shifting x', () => {
    const series = simulatorResultsToModelingSeries({
      c1: makeResult({ anchorTime: 1 }),
    });
    const mid = series[0]!.points[1]!;
    expect(mid).toMatchObject({ x: 3, y: 0.8, lo: 0.4, hi: 1.2, loInner: 0.6, hiInner: 1.0 });
  });
});

describe('simulatorResultsToModelingSeries matrix factor', () => {
  it('scales every plotted point (curve + bands) by the per-series factor', () => {
    const series = simulatorResultsToModelingSeries(
      { c1: makeResult() },
      { matrixFactors: { c1: 2 } },
    );
    const mid = series[0]!.points[1]!;
    // Whole-blood 0.8 → plasma 1.6 at factor 2; bands scale too.
    expect(mid).toMatchObject({ y: 1.6, lo: 0.8, hi: 2.4, loInner: 1.2, hiInner: 2.0 });
  });

  it('leaves a series with no factor untouched', () => {
    const series = simulatorResultsToModelingSeries(
      { c1: makeResult() },
      { matrixFactors: { other: 2 } },
    );
    expect(series[0]!.points[1]!.y).toBe(0.8);
  });

  it('ignores the factor in normalized mode (it cancels against the peak)', () => {
    const withFactor = simulatorResultsToModelingSeries(
      { c1: makeResult() },
      { matrixFactors: { c1: 2 }, normalizeMode: 'peak' },
    );
    const withoutFactor = simulatorResultsToModelingSeries(
      { c1: makeResult() },
      { normalizeMode: 'peak' },
    );
    expect(withFactor[0]!.points.map((p) => p.y)).toEqual(
      withoutFactor[0]!.points.map((p) => p.y),
    );
  });
});
