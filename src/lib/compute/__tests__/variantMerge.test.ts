import { describe, it, expect } from 'vitest';
import { mergeVariantIntoBaseline } from '../variantMerge';
import type { InferenceInput } from '../types';

const BASELINE: InferenceInput = {
  modelId: 'ketamine-one-comp-v0',
  analyte: 'ketamine',
  route: 'oral',
  observations: [
    {
      id: 'obs-1',
      analyte: 'ketamine',
      concentration: { value: 0.2, unit: 'mg/L' },
      matrix: 'whole_blood',
      sampleTime: '2030-01-01T03:00:00.000Z',
      assay: { uncertaintyCV: 0.15 },
    },
  ],
  priors: {
    dose: { type: 'uniform', min: 20, max: 500 },
    halfLife: { type: 'fixed', value: 2.5 },
    vd: { type: 'fixed', value: 210 },
    f: { type: 'fixed', value: 0.2 },
  },
  scenario: {
    possibleIntakeWindow: {
      earliestIso: '2030-01-01T00:00:00.000Z',
      latestIso: '2030-01-01T02:00:00.000Z',
    },
  },
  defaultAssayCV: 0.15,
  drawCount: 4000,
  gridResolution: 40,
  seed: 42,
};

describe('mergeVariantIntoBaseline', () => {
  it('returns the baseline unchanged when every override is blank', () => {
    const out = mergeVariantIntoBaseline(BASELINE, {});
    expect(out.priors).toEqual(BASELINE.priors);
    expect(out.defaultAssayCV).toBe(BASELINE.defaultAssayCV);
    expect(out.observations).toEqual(BASELINE.observations);
  });

  it('overrides the dose prior with a new uniform range', () => {
    const out = mergeVariantIntoBaseline(BASELINE, {
      doseLowMg: '100',
      doseHighMg: '200',
    });
    expect(out.priors.dose).toEqual({ type: 'uniform', min: 100, max: 200 });
  });

  it('falls back to the baseline range half when only one bound is supplied', () => {
    const out = mergeVariantIntoBaseline(BASELINE, { doseLowMg: '100' });
    // Original max (500) is preserved.
    expect(out.priors.dose).toEqual({ type: 'uniform', min: 100, max: 500 });
  });

  it('ignores non-positive dose bounds (regression: PR #245)', () => {
    // Negative low — keeps baseline; otherwise drawValidDraw rejects every
    // sampled draw inside the inference loop and ESS collapses silently.
    const out1 = mergeVariantIntoBaseline(BASELINE, {
      doseLowMg: '-50',
      doseHighMg: '200',
    });
    expect(out1.priors.dose).toEqual(BASELINE.priors.dose);
    // Zero high — keeps baseline.
    const out2 = mergeVariantIntoBaseline(BASELINE, {
      doseLowMg: '50',
      doseHighMg: '0',
    });
    expect(out2.priors.dose).toEqual(BASELINE.priors.dose);
    // Single non-positive bound (low) likewise inherits.
    const out3 = mergeVariantIntoBaseline(BASELINE, { doseLowMg: '0' });
    expect(out3.priors.dose).toEqual(BASELINE.priors.dose);
  });

  it('ignores degenerate overrides where high <= low', () => {
    const out = mergeVariantIntoBaseline(BASELINE, {
      doseLowMg: '500',
      doseHighMg: '100',
    });
    expect(out.priors.dose).toEqual(BASELINE.priors.dose);
  });

  it('overrides fixed-shape priors via half-life / vd / F', () => {
    const out = mergeVariantIntoBaseline(BASELINE, {
      halfLifeHours: '1.5',
      vdLitres: '180',
      bioavailability: '0.4',
    });
    expect(out.priors.halfLife).toEqual({ type: 'fixed', value: 1.5 });
    expect(out.priors.vd).toEqual({ type: 'fixed', value: 180 });
    expect(out.priors.f).toEqual({ type: 'fixed', value: 0.4 });
  });

  it('treats non-finite or non-positive overrides as "inherit"', () => {
    const out = mergeVariantIntoBaseline(BASELINE, {
      halfLifeHours: 'oops',
      vdLitres: '0',
      bioavailability: '-0.1',
    });
    expect(out.priors.halfLife).toEqual(BASELINE.priors.halfLife);
    expect(out.priors.vd).toEqual(BASELINE.priors.vd);
    expect(out.priors.f).toEqual(BASELINE.priors.f);
  });

  it('inherits the baseline F when the override exceeds 1 (regression: round 3)', () => {
    // The locale-aware parser turns `1,5` into 1.5; without an upper-
    // bound check the inference draw validator rejects every
    // first-order draw with `f > 1`, collapsing the variant to an
    // empty posterior while the typed override stays visible.
    const out = mergeVariantIntoBaseline(BASELINE, { bioavailability: '1,5' });
    expect(out.priors.f).toEqual(BASELINE.priors.f);

    // Plain dot decimal too.
    const out2 = mergeVariantIntoBaseline(BASELINE, { bioavailability: '1.4' });
    expect(out2.priors.f).toEqual(BASELINE.priors.f);

    // Boundary: f === 1 is permitted (Widmark / IV).
    const out3 = mergeVariantIntoBaseline(BASELINE, { bioavailability: '1' });
    expect(out3.priors.f).toEqual({ type: 'fixed', value: 1 });
  });

  it('rewrites both defaultAssayCV and per-observation uncertaintyCV when overridden', () => {
    const out = mergeVariantIntoBaseline(BASELINE, { assayCV: '0.05' });
    expect(out.defaultAssayCV).toBeCloseTo(0.05, 6);
    expect(out.observations[0]!.assay?.uncertaintyCV).toBeCloseTo(0.05, 6);
  });

  it('leaves observations untouched when assay CV override is blank', () => {
    const out = mergeVariantIntoBaseline(BASELINE, {});
    expect(out.observations).toBe(BASELINE.observations);
  });

  it('keeps shared fields (analyte, route, observations, window, seed) intact', () => {
    const out = mergeVariantIntoBaseline(BASELINE, {
      doseLowMg: '50',
      doseHighMg: '300',
      halfLifeHours: '3',
    });
    expect(out.analyte).toBe(BASELINE.analyte);
    expect(out.route).toBe(BASELINE.route);
    expect(out.scenario).toEqual(BASELINE.scenario);
    expect(out.seed).toBe(BASELINE.seed);
    // Same observation matrix + sample time so the comparison is meaningful.
    expect(out.observations[0]!.matrix).toBe(BASELINE.observations[0]!.matrix);
    expect(out.observations[0]!.sampleTime).toBe(BASELINE.observations[0]!.sampleTime);
  });

  it('parses Norwegian comma-decimal overrides instead of inheriting the baseline', () => {
    // `Number('150,5')` is NaN, so prior to switching to `parseLocaleNumber`
    // a Norwegian user typing `150,5` would silently get the baseline
    // value back while their override stayed visible in the form.
    const out = mergeVariantIntoBaseline(BASELINE, {
      halfLifeHours: '3,5',
      vdLitres: '180,5',
      assayCV: '0,2',
    });
    expect(out.priors.halfLife).toEqual({ type: 'fixed', value: 3.5 });
    expect(out.priors.vd).toEqual({ type: 'fixed', value: 180.5 });
    expect(out.defaultAssayCV).toBeCloseTo(0.2, 6);
    expect(out.observations[0]!.assay?.uncertaintyCV).toBeCloseTo(0.2, 6);
  });

  it('parses comma-decimal elimination-rate overrides for zero-order baselines', () => {
    const zeroBaseline: InferenceInput = {
      ...BASELINE,
      analyte: 'ethanol',
      modelId: 'ethanol-zero-order-v0',
      priors: {
        dose: { type: 'uniform', min: 10_000, max: 200_000 },
        vd: { type: 'fixed', value: 50 },
        eliminationRate: { type: 'uniform', min: 100, max: 200 },
      },
      observations: [
        {
          ...BASELINE.observations[0]!,
          analyte: 'ethanol',
          concentration: { value: 800, unit: 'mg/L' },
        },
      ],
    };
    const out = mergeVariantIntoBaseline(zeroBaseline, {
      eliminationRateMgPerLPerHour: '150,5',
    });
    expect(out.priors.eliminationRate).toEqual({ type: 'fixed', value: 150.5 });
    // First-order priors stay undefined on a zero-order baseline.
    expect(out.priors.halfLife).toBeUndefined();
  });
});
