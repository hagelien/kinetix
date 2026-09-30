import { describe, it, expect } from 'vitest';
import {
  runInference,
  summarizePosterior,
  posteriorPredictive,
} from '../inference';
import {
  concentrationFromDoseIV,
} from '../../pkEquations';
import type { InferenceInput } from '../types';

// Phase E: repeated doses are superposed on the first-order model instead of
// being truncated to the first dose.

const BASELINE = new Date('2030-01-01T00:00:00Z').getTime();
const VD = 50;
const HALF = 4;
const KE = Math.LN2 / HALF;

/** Two IV doses of D at t=0 and t=3h; concentration at `t` by superposition. */
function twoDoseIvConc(dosePerAdministration: number, t: number): number {
  return (
    concentrationFromDoseIV(dosePerAdministration, VD, KE, t) +
    concentrationFromDoseIV(dosePerAdministration, VD, KE, t - 3)
  );
}

function baseInput(overrides: Partial<InferenceInput> = {}): InferenceInput {
  const iso = (h: number) =>
    new Date(BASELINE + h * 3_600_000).toISOString();
  return {
    modelId: 'x-one-comp',
    analyte: 'testanalyte',
    route: 'iv',
    observations: [
      {
        id: 'obs-1',
        analyte: 'testanalyte',
        // Measured 4h after the first dose, i.e. 1h after the second — both
        // contribute, so a single-dose model cannot reproduce it.
        concentration: { value: twoDoseIvConc(100, 4), unit: 'mg/L' },
        matrix: 'whole_blood',
        sampleTime: iso(4),
        assay: { uncertaintyCV: 0.05 },
      },
    ],
    priors: {
      dose: { type: 'uniform', min: 10, max: 500 },
      halfLife: { type: 'fixed', value: HALF },
      vd: { type: 'fixed', value: VD },
    },
    additionalDoses: [{ tHoursAfterPrimary: 3, doseFraction: 1 }],
    scenario: {
      possibleIntakeWindow: {
        earliestIso: iso(0),
        latestIso: iso(0),
      },
    },
    defaultAssayCV: 0.15,
    drawCount: 6000,
    gridResolution: 40,
    seed: 5,
    ...overrides,
  };
}

describe('multi-dose superposition in inference', () => {
  it('recovers the per-dose amount from an observation fed by two doses', () => {
    const comp = runInference(baseInput());
    const dose = summarizePosterior(comp, true).intervals.dose!;
    // True per-administration dose is 100 mg.
    expect(dose.median).toBeGreaterThan(85);
    expect(dose.median).toBeLessThan(115);
    expect(dose.p05).toBeLessThan(100);
    expect(dose.p95).toBeGreaterThan(100);
  });

  it('a single-dose model misfits the two-dose observation (superposition is needed)', () => {
    const single = summarizePosterior(
      runInference(baseInput({ additionalDoses: [] })),
      true,
    ).intervals.dose!;
    const multi = summarizePosterior(runInference(baseInput()), true).intervals
      .dose!;
    // The single-dose fit inflates the dose to explain the extra drug from the
    // second administration, so it lands further from the true 100 mg.
    expect(single.median).toBeGreaterThan(multi.median);
    expect(Math.abs(multi.median - 100)).toBeLessThan(
      Math.abs(single.median - 100),
    );
  });

  it('the predictive curve reflects the second dose (a second rise)', () => {
    const comp = runInference(baseInput());
    const curve = posteriorPredictive(comp, true, {
      start: 0,
      end: 8,
      steps: 80,
    });
    // Concentration just after the 2nd dose (t≈3.1h) exceeds the trough just
    // before it (t≈2.9h) — evidence the second dose is superposed.
    const near = (target: number) =>
      curve.reduce((best, p) =>
        Math.abs(p.t - target) < Math.abs(best.t - target) ? p : best,
      );
    expect(near(3.1).median).toBeGreaterThan(near(2.9).median);
  });

  it('is byte-identical to a single-dose run when additionalDoses is empty', () => {
    const withEmpty = runInference(baseInput({ additionalDoses: [] }));
    const without = runInference(
      baseInput({ additionalDoses: undefined }),
    );
    expect(summarizePosterior(withEmpty, true)).toEqual(
      summarizePosterior(without, true),
    );
  });
});
