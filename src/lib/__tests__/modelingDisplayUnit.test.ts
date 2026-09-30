import { describe, expect, it } from 'vitest';
import {
  curveUnitOf,
  toPreferredUnitResult,
} from '@/lib/modelingDisplayUnit';
import type { DrugSimResult } from '@/types/simulator';

function baseResult(overrides: Partial<DrugSimResult> = {}): DrugSimResult {
  return {
    drugConfigId: 'cfg-1',
    questionMode: 'concentration-from-dose',
    median: 1,
    p05: 0.5,
    p25: 0.8,
    p75: 1.2,
    p95: 1.5,
    unit: 'mg/L',
    timeSeries: [{ t: 0, p05: 0.5, p25: 0.8, median: 1, p75: 1.2, p95: 1.5 }],
    assumptions: {
      model: 'one-compartment',
      route: 'oral',
      halfLife: { type: 'fixed', value: 1 },
      vd: { type: 'fixed', value: 1 },
      f: { type: 'fixed', value: 1 },
      weightScaling: false,
    },
    sensitivity: [],
    warnings: [],
    seed: 1,
    drawCount: 1000,
    ...overrides,
  };
}

describe('toPreferredUnitResult', () => {
  it('converts a mass-based result into the preferred molar unit using MW', () => {
    // amphetamine MW ≈ 135.21 g/mol; 1 mg/L → 1000/135.21 µmol/L ≈ 7.396
    const out = toPreferredUnitResult(baseResult(), 135.21, 'µmol/L');
    expect(out.unit).toBe('µmol/L');
    expect(out.median).toBeCloseTo(7.396, 2);
    expect(out.p05).toBeCloseTo(3.698, 2);
    expect(out.timeSeries[0]!.median).toBeCloseTo(7.396, 2);
  });

  it('leaves the result unchanged when already in the preferred unit', () => {
    const result = baseResult();
    expect(toPreferredUnitResult(result, 135.21, 'mg/L')).toBe(result);
  });

  it('leaves non-concentration (dose) results untouched', () => {
    const dose = baseResult({
      questionMode: 'dose-from-concentration',
      unit: 'mg',
    });
    expect(toPreferredUnitResult(dose, 135.21, 'µmol/L')).toBe(dose);
  });

  it('keeps the source unit when a cross-kind conversion has no MW', () => {
    const result = baseResult();
    // No molecular weight → mass↔molar conversion throws → return as-is.
    expect(toPreferredUnitResult(result, null, 'µmol/L')).toBe(result);
  });

  it('converts between two mass units without a MW', () => {
    const out = toPreferredUnitResult(baseResult(), null, 'ng/mL');
    expect(out.unit).toBe('ng/mL');
    // 1 mg/L = 1000 ng/mL
    expect(out.median).toBeCloseTo(1000, 5);
  });
});

describe('a dose answer over a concentration curve', () => {
  // `dose-from-concentration` reports a DOSE (mg) with a concentration curve
  // under it. `unit` names the scalar, so the curve needs its own name —
  // otherwise the axis, threshold lines and PM overlays are all told the curve
  // is in "mg".
  function doseResult(): DrugSimResult {
    return baseResult({
      questionMode: 'dose-from-concentration',
      median: 22.3,
      p05: 22.3,
      p25: 22.3,
      p75: 22.3,
      p95: 22.3,
      unit: 'mg',
      curveUnit: 'mg/L',
    });
  }

  it('names the curve unit, not the dose unit', () => {
    expect(curveUnitOf(doseResult())).toBe('mg/L');
    expect(curveUnitOf(baseResult())).toBe('mg/L');
    expect(curveUnitOf(undefined)).toBeUndefined();
  });

  it('converts the curve into the preferred unit while the dose stays in mg', () => {
    const out = toPreferredUnitResult(doseResult(), 135.21, 'µmol/L');
    expect(out.unit).toBe('mg');
    expect(out.median).toBe(22.3);
    expect(out.curveUnit).toBe('µmol/L');
    expect(out.timeSeries[0]!.median).toBeCloseTo(7.396, 2);
  });

  it('clears curveUnit once the scalar and curve share one unit', () => {
    const out = toPreferredUnitResult(
      baseResult({ curveUnit: 'mg/L' }),
      135.21,
      'µmol/L',
    );
    expect(out.unit).toBe('µmol/L');
    expect(out.curveUnit).toBeUndefined();
    expect(curveUnitOf(out)).toBe('µmol/L');
  });
});
