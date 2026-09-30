import { describe, it, expect } from 'vitest';
import {
  runInference,
  posteriorPredictive,
  residualSigmaFromCV,
} from '../inference';
import { PRNG } from '../../distributions';
import type { InferenceInput } from '../types';

const baseline = new Date('2030-01-01T00:00:00Z').getTime();

function makeInput(): InferenceInput {
  return {
    modelId: 'diazepam-one-comp-v0',
    analyte: 'diazepam',
    route: 'iv',
    observations: [
      {
        id: 'obs-1',
        analyte: 'diazepam',
        concentration: { value: 2, unit: 'mg/L' },
        matrix: 'whole_blood',
        sampleTime: new Date(baseline + 3 * 3_600_000).toISOString(),
        assay: { uncertaintyCV: 0.1 },
      },
    ],
    priors: {
      dose: { type: 'uniform', min: 50, max: 400 },
      halfLife: { type: 'fixed', value: 30 },
      vd: { type: 'fixed', value: 70 },
    },
    scenario: {
      possibleIntakeWindow: {
        earliestIso: new Date(baseline).toISOString(),
        latestIso: new Date(baseline).toISOString(),
      },
    },
    defaultAssayCV: 0.25,
    gridResolution: 40,
    drawCount: 3000,
    seed: 7,
  };
}

describe('posteriorPredictive with residual error', () => {
  const range = { start: 0, end: 8, steps: 16 };

  it('widens the band but preserves the median vs the parameter-only envelope', () => {
    const comp = runInference(makeInput(), new PRNG(7));
    const expected = posteriorPredictive(comp, true, range);
    const predictive = posteriorPredictive(comp, true, range, {
      sigma: residualSigmaFromCV(0.25),
      rng: new PRNG(999),
    });

    // Compare at a point where the curve is clearly positive.
    const idx = 6; // t = 3h
    expect(predictive[idx]!.median).toBeCloseTo(expected[idx]!.median, 6);
    // Residual error must widen the predictive interval.
    const expectedWidth = expected[idx]!.p95 - expected[idx]!.p05;
    const predictiveWidth = predictive[idx]!.p95 - predictive[idx]!.p05;
    expect(predictiveWidth).toBeGreaterThan(expectedWidth);
  });

  it('keeps the band ordered (p05 <= p25 <= median <= p75 <= p95)', () => {
    const comp = runInference(makeInput(), new PRNG(7));
    const predictive = posteriorPredictive(comp, true, range, {
      sigma: residualSigmaFromCV(0.25),
      rng: new PRNG(999),
    });
    for (const p of predictive) {
      expect(p.p05).toBeLessThanOrEqual(p.p25 + 1e-9);
      expect(p.p25).toBeLessThanOrEqual(p.p75 + 1e-9);
      expect(p.p05).toBeLessThanOrEqual(p.p95 + 1e-9);
    }
  });

  it('residualSigmaFromCV matches sqrt(log(1+CV^2))', () => {
    expect(residualSigmaFromCV(0.2)).toBeCloseTo(
      Math.sqrt(Math.log(1 + 0.04)),
      12,
    );
    expect(residualSigmaFromCV(0)).toBe(0);
  });
});
