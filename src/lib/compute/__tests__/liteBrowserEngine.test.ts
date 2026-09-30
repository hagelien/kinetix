import { describe, it, expect } from 'vitest';
import { LiteBrowserEngine } from '../liteBrowserEngine';
import { type SimulationInput, type InferenceInput } from '../types';

const ETHANOL_INPUT: SimulationInput = {
  modelId: 'ethanol-zero-order-v0',
  analyte: 'ethanol',
  matrix: 'whole_blood',
  route: 'oral',
  parameters: {
    halfLife: { type: 'fixed', value: 4 },
    vd: { type: 'fixed', value: 0.6 },
    f: { type: 'fixed', value: 1 },
  },
  dose: { value: 200, unit: 'mg' },
  timeRangeHours: { start: 0, end: 6, steps: 12 },
  drawCount: 100,
  seed: 7,
};

describe('LiteBrowserEngine.simulate', () => {
  it('returns a result whose engine + diagnostics match the engine identity', async () => {
    const engine = new LiteBrowserEngine();
    const result = await engine.simulate(ETHANOL_INPUT);
    expect(result.engine).toBe('lite-browser');
    expect(result.diagnostics.engine).toBe('lite-browser');
    expect(result.diagnostics.method).toBe('analytic-pk-monte-carlo');
    expect(result.diagnostics.sampleCount).toBe(100);
  });

  it('produces a time series spanning the requested window', async () => {
    const engine = new LiteBrowserEngine();
    const result = await engine.simulate(ETHANOL_INPUT);
    expect(result.timeSeries.length).toBe(13); // steps + 1
    expect(result.timeSeries[0]!.t).toBe(0);
    expect(result.timeSeries.at(-1)!.t).toBe(6);
    // Concentrations decay across the window for fixed half-life dosing.
    expect(result.timeSeries[0]!.median).toBeGreaterThan(
      result.timeSeries.at(-1)!.median,
    );
  });

  it('attaches the analyte model card assumptions and limitations', async () => {
    const engine = new LiteBrowserEngine();
    const result = await engine.simulate(ETHANOL_INPUT);
    expect(result.assumptions.length).toBeGreaterThan(0);
    expect(result.limitations.length).toBeGreaterThan(0);
    expect(
      result.limitations.some((l) =>
        l.text.toLowerCase().includes('lite engine'),
      ),
    ).toBe(true);
  });
});

describe('LiteBrowserEngine.simulate route handling', () => {
  it('IV ignores sampled bioavailability and matches dose/Vd at t=0', async () => {
    // C(0) for IV bolus = dose / Vd, regardless of f. With f sampled at 0.25
    // an oral approximation would underestimate the curve by 4×.
    const engine = new LiteBrowserEngine();
    const dose = 100;
    const vd = 50;
    const ivResult = await engine.simulate({
      ...ETHANOL_INPUT,
      route: 'iv',
      parameters: {
        halfLife: { type: 'fixed', value: 4 },
        vd: { type: 'fixed', value: vd },
        f: { type: 'fixed', value: 0.25 },
      },
      dose: { value: dose, unit: 'mg' },
      timeRangeHours: { start: 0, end: 0, steps: 1 },
      drawCount: 50,
    });
    const expected = dose / vd;
    expect(ivResult.timeSeries[0]!.median).toBeCloseTo(expected, 6);
  });

  it('non-IV routes still apply the sampled bioavailability', async () => {
    const engine = new LiteBrowserEngine();
    const dose = 100;
    const vd = 50;
    const f = 0.25;
    const oralResult = await engine.simulate({
      ...ETHANOL_INPUT,
      route: 'oral',
      parameters: {
        halfLife: { type: 'fixed', value: 4 },
        vd: { type: 'fixed', value: vd },
        f: { type: 'fixed', value: f },
      },
      dose: { value: dose, unit: 'mg' },
      timeRangeHours: { start: 0, end: 0, steps: 1 },
      drawCount: 50,
    });
    expect(oralResult.timeSeries[0]!.median).toBeCloseTo((f * dose) / vd, 6);
  });
});

describe('LiteBrowserEngine.simulate validity guards', () => {
  it('zeros pre-dose timepoints rather than computing exp(+k|t|) above C0', async () => {
    // A negative `t` would otherwise evaluate to dose/Vd * exp(+k*|t|), i.e.
    // a curve that starts higher than C0 before dose administration.
    const engine = new LiteBrowserEngine();
    const dose = 100;
    const vd = 50;
    const result = await engine.simulate({
      ...ETHANOL_INPUT,
      route: 'iv',
      parameters: {
        halfLife: { type: 'fixed', value: 4 },
        vd: { type: 'fixed', value: vd },
        f: { type: 'fixed', value: 1 },
      },
      dose: { value: dose, unit: 'mg' },
      // Window straddling t=0 with a single pre-dose point.
      timeRangeHours: { start: -2, end: 0, steps: 2 },
      drawCount: 50,
    });
    const C0 = dose / vd;
    expect(result.timeSeries[0]!.t).toBe(-2);
    expect(result.timeSeries[0]!.median).toBe(0);
    expect(result.timeSeries[0]!.p95).toBe(0);
    // t=0 is the dose moment so the curve should land at exactly C0.
    expect(result.timeSeries.at(-1)!.median).toBeCloseTo(C0, 6);
    expect(result.timeSeries.at(-1)!.median).toBeLessThanOrEqual(C0);
  });

  it('rejects nonphysical PK draws (vd <= 0 or F outside (0, 1])', async () => {
    // A uniform Vd straddling zero forces ~half the draws into the rejection
    // path. The engine should report the rejection count in diagnostics
    // rather than emit negative concentrations into the percentile summary.
    const engine = new LiteBrowserEngine();
    const result = await engine.simulate({
      ...ETHANOL_INPUT,
      route: 'oral',
      parameters: {
        halfLife: { type: 'fixed', value: 4 },
        vd: { type: 'uniform', min: -10, max: 10 },
        f: { type: 'fixed', value: 1 },
      },
      dose: { value: 100, unit: 'mg' },
      timeRangeHours: { start: 0, end: 4, steps: 4 },
      drawCount: 200,
      seed: 11,
    });
    expect(result.diagnostics.sampleCount).toBeLessThan(200);
    expect(
      result.diagnostics.warnings.some((w) =>
        w.toLowerCase().includes('rejected'),
      ),
    ).toBe(true);
    // No NaN / negative concentrations should escape into the time series.
    for (const point of result.timeSeries) {
      expect(Number.isFinite(point.p05)).toBe(true);
      expect(Number.isFinite(point.median)).toBe(true);
      expect(Number.isFinite(point.p95)).toBe(true);
      expect(point.p05).toBeGreaterThanOrEqual(0);
    }
  });

  it('rejects F > 1 for non-IV routes', async () => {
    const engine = new LiteBrowserEngine();
    const result = await engine.simulate({
      ...ETHANOL_INPUT,
      route: 'oral',
      parameters: {
        halfLife: { type: 'fixed', value: 4 },
        vd: { type: 'fixed', value: 50 },
        // F values entirely above the valid range — every draw should be rejected.
        f: { type: 'fixed', value: 1.5 },
      },
      dose: { value: 100, unit: 'mg' },
      timeRangeHours: { start: 0, end: 4, steps: 4 },
      drawCount: 50,
    });
    expect(result.diagnostics.sampleCount).toBe(0);
    expect(
      result.diagnostics.warnings.some((w) =>
        w.toLowerCase().includes('no draws survived'),
      ),
    ).toBe(true);
    for (const point of result.timeSeries) {
      expect(point.median).toBe(0);
    }
  });
});

describe('LiteBrowserEngine.infer', () => {
  // Build a synthetic IV scenario where the *true* dose is 100 mg, vd=50 L,
  // half-life=4 h, intake at the window start (offset=0). Predicted C(2h) =
  // (100/50) * exp(-ln(2)/4 * 2) = 2 * 0.7071 = 1.4142 mg/L.
  const TRUE_DOSE = 100;
  const TRUE_VD = 50;
  const TRUE_HALF = 4;
  const SAMPLE_HOURS = 2;
  const PREDICTED_C = (TRUE_DOSE / TRUE_VD) * Math.exp(-Math.LN2 / TRUE_HALF * SAMPLE_HOURS);

  function makeInferenceInput(overrides: Partial<InferenceInput> = {}): InferenceInput {
    const baseline = new Date('2030-01-01T00:00:00Z').getTime();
    const sampleIso = new Date(baseline + SAMPLE_HOURS * 3_600_000).toISOString();
    return {
      modelId: 'ethanol-zero-order-v0',
      analyte: 'ethanol',
      route: 'iv',
      observations: [
        {
          id: 'obs-1',
          analyte: 'ethanol',
          concentration: { value: PREDICTED_C, unit: 'mg/L' },
          matrix: 'whole_blood',
          sampleTime: sampleIso,
          assay: { uncertaintyCV: 0.05 },
        },
      ],
      priors: {
        // Wide-but-bounded priors centred away from the true value so the
        // recovery test exercises the importance weighting rather than just
        // returning the prior.
        dose: { type: 'uniform', min: 10, max: 500 },
        halfLife: { type: 'fixed', value: TRUE_HALF },
        vd: { type: 'fixed', value: TRUE_VD },
      },
      scenario: {
        possibleIntakeWindow: {
          earliestIso: new Date(baseline).toISOString(),
          latestIso: new Date(baseline).toISOString(),
        },
      },
      defaultAssayCV: 0.15,
      drawCount: 4000,
      gridResolution: 40,
      seed: 7,
      ...overrides,
    };
  }

  it('recovers the true dose when half-life and vd are pinned', async () => {
    const engine = new LiteBrowserEngine();
    const result = await engine.infer(makeInferenceInput());
    expect(result.engine).toBe('lite-browser');
    expect(result.diagnostics.method).toBe('monte-carlo-importance-sampling');
    const dose = result.posteriorSummary.intervals.dose;
    expect(dose).toBeDefined();
    // Posterior median should be within 15% of the true 100 mg.
    expect(dose!.median).toBeGreaterThan(85);
    expect(dose!.median).toBeLessThan(115);
    // 90% CI should bracket the truth.
    expect(dose!.p05).toBeLessThan(TRUE_DOSE);
    expect(dose!.p95).toBeGreaterThan(TRUE_DOSE);
  });

  it('produces a posterior predictive curve that brackets the observation', async () => {
    const engine = new LiteBrowserEngine();
    const result = await engine.infer(makeInferenceInput());
    expect(result.posteriorPredictive).toBeDefined();
    const series = result.posteriorPredictive!.timeSeries;
    expect(series.length).toBeGreaterThan(0);
    // Find the predictive point closest to t=2h and check it brackets the obs.
    const closest = series.reduce((best, p) =>
      Math.abs(p.t - SAMPLE_HOURS) < Math.abs(best.t - SAMPLE_HOURS) ? p : best,
    );
    expect(closest.p05).toBeLessThan(PREDICTED_C);
    expect(closest.p95).toBeGreaterThan(PREDICTED_C);
  });

  it('reports an empty posterior + warning when no draws survive', async () => {
    const engine = new LiteBrowserEngine();
    const result = await engine.infer(
      makeInferenceInput({
        // F > 1 for an oral route → every draw rejected as nonphysical.
        route: 'oral',
        priors: {
          dose: { type: 'fixed', value: 100 },
          halfLife: { type: 'fixed', value: TRUE_HALF },
          vd: { type: 'fixed', value: TRUE_VD },
          f: { type: 'fixed', value: 1.5 },
        },
        drawCount: 100,
      }),
    );
    expect(result.diagnostics.sampleCount).toBe(0);
    expect(result.posteriorSummary.intervals).toEqual({});
    expect(result.posteriorPredictive).toBeUndefined();
    expect(
      result.diagnostics.warnings.some((w) =>
        w.toLowerCase().includes('no draws survived'),
      ),
    ).toBe(true);
  });

  it('warns when effective sample size is low', async () => {
    const engine = new LiteBrowserEngine();
    // Very tight assay CV + extremely wide dose prior → only a thin slice of
    // dose values will have non-negligible likelihood, driving ESS very low.
    const result = await engine.infer(
      makeInferenceInput({
        priors: {
          dose: { type: 'uniform', min: 1, max: 10000 },
          halfLife: { type: 'fixed', value: TRUE_HALF },
          vd: { type: 'fixed', value: TRUE_VD },
        },
        observations: [
          {
            id: 'obs-1',
            analyte: 'ethanol',
            concentration: { value: PREDICTED_C, unit: 'mg/L' },
            matrix: 'whole_blood',
            sampleTime: new Date(
              new Date('2030-01-01T00:00:00Z').getTime() + SAMPLE_HOURS * 3_600_000,
            ).toISOString(),
            assay: { uncertaintyCV: 0.001 },
          },
        ],
        drawCount: 500,
      }),
    );
    expect(
      result.diagnostics.warnings.some((w) =>
        w.toLowerCase().includes('effective sample size'),
      ),
    ).toBe(true);
  });

  it('rejects observations whose sampleTime is missing', async () => {
    const engine = new LiteBrowserEngine();
    const input = makeInferenceInput({
      observations: [
        {
          id: 'obs-no-time',
          analyte: 'ethanol',
          concentration: { value: PREDICTED_C, unit: 'mg/L' },
          matrix: 'whole_blood',
        },
      ],
    });
    await expect(engine.infer(input)).rejects.toThrow(/sampleTime/);
  });

  it('rejects observations spanning multiple matrices', async () => {
    const engine = new LiteBrowserEngine();
    const baseline = new Date('2030-01-01T00:00:00Z').getTime();
    const sampleIso = new Date(baseline + SAMPLE_HOURS * 3_600_000).toISOString();
    const input = makeInferenceInput({
      observations: [
        {
          id: 'obs-blood',
          analyte: 'ethanol',
          concentration: { value: PREDICTED_C, unit: 'mg/L' },
          matrix: 'whole_blood',
          sampleTime: sampleIso,
        },
        {
          id: 'obs-serum',
          analyte: 'ethanol',
          concentration: { value: PREDICTED_C, unit: 'mg/L' },
          matrix: 'serum',
          sampleTime: sampleIso,
        },
      ],
    });
    await expect(engine.infer(input)).rejects.toThrow(/single matrix|whole_blood.*serum|serum.*whole_blood/);
  });

  it('rejects observations whose matrix is not in the model card supportedMatrices', async () => {
    const engine = new LiteBrowserEngine();
    // The ethanol model card supports whole_blood, serum, plasma — not urine.
    const baseline = new Date('2030-01-01T00:00:00Z').getTime();
    const sampleIso = new Date(baseline + SAMPLE_HOURS * 3_600_000).toISOString();
    const input = makeInferenceInput({
      observations: [
        {
          id: 'obs-urine',
          analyte: 'ethanol',
          concentration: { value: PREDICTED_C, unit: 'mg/L' },
          matrix: 'urine',
          sampleTime: sampleIso,
        },
      ],
    });
    await expect(engine.infer(input)).rejects.toThrow(/urine|supported matrices/);
  });

  it('falls back to defaultAssayCV when an observation supplies cv = 0', async () => {
    // Without the fallback, sigma collapses to 0 and every draw is rejected
    // as "impossible", producing an empty posterior with a misleading warning.
    const engine = new LiteBrowserEngine();
    const result = await engine.infer(
      makeInferenceInput({
        observations: [
          {
            id: 'obs-1',
            analyte: 'ethanol',
            concentration: { value: PREDICTED_C, unit: 'mg/L' },
            matrix: 'whole_blood',
            sampleTime: new Date(
              new Date('2030-01-01T00:00:00Z').getTime() + SAMPLE_HOURS * 3_600_000,
            ).toISOString(),
            assay: { uncertaintyCV: 0 },
          },
        ],
        defaultAssayCV: 0.15,
      }),
    );
    expect(result.diagnostics.sampleCount).toBeGreaterThan(0);
    const dose = result.posteriorSummary.intervals.dose;
    expect(dose).toBeDefined();
    // Sanity-check: the posterior should still be informative.
    expect(dose!.median).toBeGreaterThan(50);
    expect(dose!.median).toBeLessThan(200);
  });

  it('rejects µmol/L observations until MW plumbing lands', async () => {
    const engine = new LiteBrowserEngine();
    const input = makeInferenceInput({
      observations: [
        {
          id: 'obs-molar',
          analyte: 'ethanol',
          concentration: { value: 30, unit: 'µmol/L' },
          matrix: 'whole_blood',
          sampleTime: new Date(
            new Date('2030-01-01T00:00:00Z').getTime() + SAMPLE_HOURS * 3_600_000,
          ).toISOString(),
        },
      ],
    });
    await expect(engine.infer(input)).rejects.toThrow(/molecular weight|µmol\/L/);
  });
});
