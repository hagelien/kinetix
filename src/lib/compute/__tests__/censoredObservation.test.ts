import { describe, it, expect } from 'vitest';
import { runInference, summarizePosterior } from '../inference';
import { PRNG } from '../../distributions';
import type { InferenceInput } from '../types';

const baseline = new Date('2030-01-01T00:00:00Z').getTime();

// IV, pinned half-life (4 h) and Vd (50 L): at t=4 h, exp(-k·4) = 0.5, so the
// predicted concentration is dose/100 mg/L. A LOQ of 1 mg/L therefore
// corresponds to dose ≈ 100 mg.
function makeInput(
  observationOverride: Partial<InferenceInput['observations'][number]>,
): InferenceInput {
  return {
    modelId: 'diazepam-one-comp-v0',
    analyte: 'diazepam',
    route: 'iv',
    observations: [
      {
        id: 'obs-1',
        analyte: 'diazepam',
        concentration: { value: 1, unit: 'mg/L' },
        matrix: 'whole_blood',
        sampleTime: new Date(baseline + 4 * 3_600_000).toISOString(),
        assay: { uncertaintyCV: 0.15 },
        ...observationOverride,
      },
    ],
    priors: {
      dose: { type: 'uniform', min: 10, max: 500 },
      halfLife: { type: 'fixed', value: 4 },
      vd: { type: 'fixed', value: 50 },
    },
    scenario: {
      possibleIntakeWindow: {
        earliestIso: new Date(baseline).toISOString(),
        latestIso: new Date(baseline).toISOString(),
      },
    },
    defaultAssayCV: 0.15,
    gridResolution: 40,
    drawCount: 6000,
    seed: 7,
  };
}

function doseMedian(input: InferenceInput): number {
  const comp = runInference(input, new PRNG(7));
  const posterior = summarizePosterior(comp, true);
  return posterior.intervals.dose!.median;
}

describe('censored (<LOQ / <LOD) observations', () => {
  it('runs and yields a valid posterior for a non-detect', () => {
    const comp = runInference(
      makeInput({ censoring: { kind: 'loq', limit: 1 } }),
      new PRNG(7),
    );
    expect(comp.samples.length).toBeGreaterThan(0);
    expect(comp.effectiveSampleSize).toBeGreaterThan(0);
  });

  it('pulls the dose posterior lower than treating the limit as a measured value', () => {
    // Measured point at the limit → dose concentrates near 100 mg.
    const measured = doseMedian(makeInput({}));
    // Non-detect < LOQ → true concentration is only known to be below the
    // limit, which is consistent with any lower dose, so the median drops.
    const censored = doseMedian(
      makeInput({ censoring: { kind: 'loq', limit: 1 } }),
    );
    expect(censored).toBeLessThan(measured);
  });

  it('a non-detect concentrates the dose below the limit-equivalent dose', () => {
    const censored = doseMedian(
      makeInput({ censoring: { kind: 'loq', limit: 1 } }),
    );
    // Limit of 1 mg/L ≈ dose 100 mg; a non-detect should favour < 100 mg.
    expect(censored).toBeLessThan(100);
  });
});
