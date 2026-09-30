import { describe, it, expect } from 'vitest';
import { runInference, summarizePosterior } from '../inference';
import { runLiteInference } from '../liteInference';
import { concentrationOralFirstOrder } from '../../pkEquations';
import type { InferenceInput } from '../types';

// Phase D: the inference likelihood + predictive use the Bateman (first-order
// absorption) curve when a `ka` prior is present on a non-IV first-order case,
// instead of the instantaneous post-absorption approximation.

const BASELINE = new Date('2030-01-01T00:00:00Z').getTime();

const TRUE_DOSE = 100;
const VD = 50;
const HALF = 4;
const KE = Math.LN2 / HALF;
const KA = 1.5;
const SAMPLE_HOURS = 1; // near the absorption phase, where Bateman ≠ instantaneous
const TRUE_C = concentrationOralFirstOrder(TRUE_DOSE, VD, 1, KA, KE, SAMPLE_HOURS);

function baseInput(overrides: Partial<InferenceInput> = {}): InferenceInput {
  const sampleIso = new Date(BASELINE + SAMPLE_HOURS * 3_600_000).toISOString();
  return {
    modelId: 'ketamine-one-comp-component-v0',
    analyte: 'ketamine',
    route: 'oral',
    observations: [
      {
        id: 'obs-1',
        analyte: 'ketamine',
        concentration: { value: TRUE_C, unit: 'mg/L' },
        matrix: 'whole_blood',
        sampleTime: sampleIso,
        assay: { uncertaintyCV: 0.05 },
      },
    ],
    priors: {
      dose: { type: 'uniform', min: 10, max: 500 },
      halfLife: { type: 'fixed', value: HALF },
      vd: { type: 'fixed', value: VD },
      f: { type: 'fixed', value: 1 },
      ka: { type: 'fixed', value: KA },
    },
    scenario: {
      possibleIntakeWindow: {
        earliestIso: new Date(BASELINE).toISOString(),
        latestIso: new Date(BASELINE).toISOString(),
      },
    },
    defaultAssayCV: 0.15,
    drawCount: 6000,
    gridResolution: 40,
    seed: 11,
    ...overrides,
  };
}

describe('Bateman absorption in inference (ka prior present)', () => {
  it('recovers the true dose from a Bateman-generated observation near Tmax', () => {
    const comp = runInference(baseInput());
    const posterior = summarizePosterior(comp, false);
    const dose = posterior.intervals.dose!;
    // Within 15% of the true 100 mg, and the 90% CI brackets the truth.
    expect(dose.median).toBeGreaterThan(85);
    expect(dose.median).toBeLessThan(115);
    expect(dose.p05).toBeLessThan(TRUE_DOSE);
    expect(dose.p95).toBeGreaterThan(TRUE_DOSE);
  });

  it('surfaces the ka parameter in the posterior when it was sampled', () => {
    const comp = runInference(
      baseInput({
        priors: {
          dose: { type: 'uniform', min: 10, max: 500 },
          halfLife: { type: 'fixed', value: HALF },
          vd: { type: 'fixed', value: VD },
          f: { type: 'fixed', value: 1 },
          ka: { type: 'uniform', min: 0.8, max: 3 },
        },
      }),
    );
    const posterior = summarizePosterior(comp, false);
    expect(posterior.intervals.ka).toBeDefined();
    expect(posterior.intervals.ka!.unit).toBe('1/h');
  });

  it('an instantaneous fit to the same near-Tmax observation is biased (Bateman is needed)', () => {
    // Drop the ka prior: the engine falls back to instantaneous absorption,
    // which cannot reproduce a rising limb, so the recovered dose is biased.
    const instantComp = runInference(
      baseInput({
        priors: {
          dose: { type: 'uniform', min: 10, max: 500 },
          halfLife: { type: 'fixed', value: HALF },
          vd: { type: 'fixed', value: VD },
          f: { type: 'fixed', value: 1 },
        },
      }),
    );
    const instantDose = summarizePosterior(instantComp, false).intervals.dose!;
    const batemanDose = summarizePosterior(runInference(baseInput()), false)
      .intervals.dose!;
    // The Bateman fit is closer to the truth than the instantaneous fit.
    expect(Math.abs(batemanDose.median - TRUE_DOSE)).toBeLessThan(
      Math.abs(instantDose.median - TRUE_DOSE),
    );
  });
});

describe('instantaneous-absorption warning', () => {
  it('warns when a non-IV first-order case has no ka prior', () => {
    const result = runLiteInference(
      baseInput({
        priors: {
          dose: { type: 'uniform', min: 10, max: 500 },
          halfLife: { type: 'fixed', value: HALF },
          vd: { type: 'fixed', value: VD },
          f: { type: 'fixed', value: 1 },
        },
      }),
    );
    expect(
      result.warnings.some((w) =>
        w.toLowerCase().includes('instantaneous'),
      ),
    ).toBe(true);
  });

  it('does not warn when a ka prior is present', () => {
    const result = runLiteInference(baseInput());
    expect(
      result.warnings.some((w) => w.toLowerCase().includes('instantaneous')),
    ).toBe(false);
  });

  it('does not warn for IV (ka is ignored, fully absorbed)', () => {
    const result = runLiteInference(
      baseInput({
        route: 'iv',
        priors: {
          dose: { type: 'uniform', min: 10, max: 500 },
          halfLife: { type: 'fixed', value: HALF },
          vd: { type: 'fixed', value: VD },
        },
      }),
    );
    expect(
      result.warnings.some((w) => w.toLowerCase().includes('instantaneous')),
    ).toBe(false);
  });
});
