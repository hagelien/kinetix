import { describe, it, expect } from 'vitest';
import { LiteBrowserEngine } from '../liteBrowserEngine';
import { inferenceInputSchema, inferencePriorsSchema, type InferenceInput } from '../types';
import { renderReportMarkdown } from '../report';

// End-to-end zero-order ethanol inference test. Builds a synthetic case
// where the true dose, Vd, and elimination rate are known, then asserts
// the posterior recovers the dose. Mirrors the structure of the
// first-order recovery test in liteBrowserEngine.test.ts so any future
// refactor of the importance-weighting pipeline catches both branches.

const TRUE_DOSE_MG = 70_000; // 70 g of ethanol
const TRUE_VD_L = 50;
const TRUE_BETA = 150; // mg/L/h (= 0.15 g/L/h, mid-range Widmark)
const SAMPLE_HOURS = 4;
// Forward-projected: 70_000 / 50 - 150 * 4 = 1400 - 600 = 800 mg/L.
const PREDICTED_C = TRUE_DOSE_MG / TRUE_VD_L - TRUE_BETA * SAMPLE_HOURS;

function makeEthanolInferenceInput(
  overrides: Partial<InferenceInput> = {},
): InferenceInput {
  const baseline = new Date('2030-01-01T00:00:00Z').getTime();
  const sampleIso = new Date(baseline + SAMPLE_HOURS * 3_600_000).toISOString();
  return {
    modelId: 'ethanol-zero-order-v0',
    analyte: 'ethanol',
    route: 'oral',
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
      // Broad dose prior centred well away from the true value so the
      // recovery is genuinely a function of the likelihood rather than
      // the prior alone.
      dose: { type: 'uniform', min: 10_000, max: 200_000 },
      vd: { type: 'fixed', value: TRUE_VD_L },
      eliminationRate: { type: 'fixed', value: TRUE_BETA },
    },
    scenario: {
      possibleIntakeWindow: {
        earliestIso: new Date(baseline).toISOString(),
        latestIso: new Date(baseline).toISOString(),
      },
    },
    defaultAssayCV: 0.05,
    drawCount: 4000,
    gridResolution: 40,
    seed: 11,
    ...overrides,
  };
}

describe('LiteBrowserEngine.infer (ethanol zero-order)', () => {
  it('recovers the true dose when Vd and elimination rate are pinned', async () => {
    const engine = new LiteBrowserEngine();
    const result = await engine.infer(makeEthanolInferenceInput());
    const dose = result.posteriorSummary.intervals.dose!;
    // 5% interval around 70_000 — comfortably within the 90% CI given
    // the 5% assay CV. Uses the same tolerance pattern as the first-
    // order recovery test.
    expect(dose.median).toBeCloseTo(TRUE_DOSE_MG, -3);
    expect(dose.median).toBeGreaterThan(TRUE_DOSE_MG * 0.9);
    expect(dose.median).toBeLessThan(TRUE_DOSE_MG * 1.1);
    expect(dose.p05).toBeLessThan(TRUE_DOSE_MG);
    expect(dose.p95).toBeGreaterThan(TRUE_DOSE_MG);
  });

  it('emits an eliminationRate interval and no halfLife/F intervals', async () => {
    // Confirms the dispatch in summarizePosterior actually swapped the
    // parameter set. Without this, regressions in the branch could
    // accidentally emit halfLife=0 (the placeholder) as a real interval.
    const engine = new LiteBrowserEngine();
    const result = await engine.infer(makeEthanolInferenceInput());
    expect(result.posteriorSummary.intervals.eliminationRate).toBeDefined();
    expect(result.posteriorSummary.intervals.eliminationRate?.unit).toBe('mg/L/h');
    expect(result.posteriorSummary.intervals.halfLife).toBeUndefined();
    expect(result.posteriorSummary.intervals.f).toBeUndefined();
  });

  it('produces a linearly-decaying posterior predictive curve', async () => {
    // Zero-order kinetics → the median curve should drop linearly. We
    // don't assert exact values (importance sampling jitters them), but
    // we assert monotonic decrease across the predictive window and
    // that the curve passes near the observation.
    const engine = new LiteBrowserEngine();
    const result = await engine.infer(makeEthanolInferenceInput());
    const series = result.posteriorPredictive?.timeSeries ?? [];
    expect(series.length).toBeGreaterThan(0);
    // Find the predictive point closest to the sample time and confirm
    // it lies near the observed concentration.
    let nearest = series[0]!;
    for (const p of series) {
      if (Math.abs(p.t - SAMPLE_HOURS) < Math.abs(nearest.t - SAMPLE_HOURS)) {
        nearest = p;
      }
    }
    expect(nearest.median).toBeGreaterThan(PREDICTED_C * 0.5);
    expect(nearest.median).toBeLessThan(PREDICTED_C * 2);

    // Monotonic non-increase from the peak onwards (zero-order math
    // never rebounds; importance weights can introduce tiny upticks
    // from sampling noise, so we allow a 1% tolerance on each step).
    let peakIdx = 0;
    for (let i = 1; i < series.length; i++) {
      if (series[i]!.median > series[peakIdx]!.median) peakIdx = i;
    }
    for (let i = peakIdx + 1; i < series.length; i++) {
      expect(series[i]!.median).toBeLessThanOrEqual(series[i - 1]!.median * 1.01);
    }
  });
});

describe('inferencePriorsSchema (cross-field validation)', () => {
  it('rejects priors with neither halfLife nor eliminationRate', () => {
    // Without this guard, a malformed payload reaches `runInference` where
    // `drawValidDraw` throws — the validation error should surface at the
    // schema boundary instead.
    const result = inferencePriorsSchema.safeParse({
      dose: { type: 'fixed', value: 100 },
      vd: { type: 'fixed', value: 50 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/halfLife|eliminationRate/);
    }
  });

  it('accepts priors with halfLife only (first-order)', () => {
    const result = inferencePriorsSchema.safeParse({
      dose: { type: 'fixed', value: 100 },
      vd: { type: 'fixed', value: 50 },
      halfLife: { type: 'fixed', value: 4 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts priors with eliminationRate only (zero-order)', () => {
    const result = inferencePriorsSchema.safeParse({
      dose: { type: 'fixed', value: 70_000 },
      vd: { type: 'fixed', value: 50 },
      eliminationRate: { type: 'fixed', value: 150 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts priors with both fields (dispatcher prefers eliminationRate)', () => {
    // The runtime dispatcher in `inference.ts` documents this precedence,
    // so the schema doesn't reject — it's a valid but rare payload.
    const result = inferencePriorsSchema.safeParse({
      dose: { type: 'fixed', value: 70_000 },
      vd: { type: 'fixed', value: 50 },
      halfLife: { type: 'fixed', value: 4 },
      eliminationRate: { type: 'fixed', value: 150 },
    });
    expect(result.success).toBe(true);
  });
});

describe('renderReportMarkdown (zero-order priors)', () => {
  it('emits an Elimination rate line when priors.eliminationRate is set', async () => {
    // Without this, ethanol/zero-order reports omit the parameter that
    // drives the posterior, breaking reproducibility.
    const engine = new LiteBrowserEngine();
    const input = makeEthanolInferenceInput();
    const result = await engine.infer(input);
    const md = renderReportMarkdown({
      inferenceInput: inferenceInputSchema.parse(input),
      inferenceResult: result,
    });
    expect(md).toContain('Elimination rate');
    expect(md).toContain('mg/L/h');
    // First-order half-life row should NOT appear for a zero-order run.
    expect(md).not.toMatch(/\*\*Half-life\*\*: /);
  });
});
