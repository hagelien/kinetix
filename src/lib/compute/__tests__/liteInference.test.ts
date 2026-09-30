import { describe, it, expect } from 'vitest';
import {
  runLiteInference,
  validateLiteInferenceInput,
  isApproximatedModelCard,
  LiteInferenceError,
  LOW_ESS_RATIO,
  CRITICAL_ESS_RATIO,
  classifyEss,
} from '../liteInference';
import { findModelCardByAnalyte } from '../modelCards';
import { LiteBrowserEngine } from '../liteBrowserEngine';
import { LOW_ESS_RATIO as ADAPTER_LOW, CRITICAL_ESS_RATIO as ADAPTER_CRITICAL } from '@/lib/modelingRun';
import type { InferenceInput, Matrix } from '../types';

// The whole point of the shared boundary: the direct engine
// (`LiteBrowserEngine.infer`) and the off-thread path (`inference.worker.ts`,
// which calls `runLiteInference` directly) must apply IDENTICAL validation, so
// they can never disagree about whether a case is runnable.

const BASELINE = new Date('2030-01-01T00:00:00Z').getTime();
const SAMPLE_HOURS = 2;
const PREDICTED_C = (100 / 50) * Math.exp((-Math.LN2 / 4) * SAMPLE_HOURS);

function makeInput(overrides: Partial<InferenceInput> = {}): InferenceInput {
  const sampleIso = new Date(BASELINE + SAMPLE_HOURS * 3_600_000).toISOString();
  return {
    // Matches the ethanol card by analyte (supportedMatrices:
    // whole_blood, serum, plasma — NOT urine).
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
      dose: { type: 'uniform', min: 10, max: 500 },
      halfLife: { type: 'fixed', value: 4 },
      vd: { type: 'fixed', value: 50 },
    },
    scenario: {
      possibleIntakeWindow: {
        earliestIso: new Date(BASELINE).toISOString(),
        latestIso: new Date(BASELINE).toISOString(),
      },
    },
    defaultAssayCV: 0.15,
    drawCount: 4000,
    gridResolution: 40,
    seed: 7,
    ...overrides,
  };
}

/** Rebuild the same input with a single non-whole-blood matrix. */
function withMatrix(matrix: Matrix): InferenceInput {
  const base = makeInput();
  return {
    ...base,
    observations: base.observations.map((o) => ({ ...o, matrix })),
  };
}

describe('runLiteInference — validation parity with the engine', () => {
  it('rejects an unsupported matrix (urine) the same way the engine does', async () => {
    const engine = new LiteBrowserEngine();
    const input = withMatrix('urine');

    // Direct engine path.
    await expect(engine.infer(input)).rejects.toThrow(/urine|supported matrices/);

    // Worker path (runLiteInference, called by inference.worker.ts) rejects it
    // too — with a typed, structured error.
    expect(() =>
      runLiteInference(input, {
        predictiveRange: { start: 0, end: 8, steps: 60 },
      }),
    ).toThrow(LiteInferenceError);

    try {
      runLiteInference(input);
      throw new Error('expected runLiteInference to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LiteInferenceError);
      expect((err as LiteInferenceError).code).toBe('matrix-unsupported');
      expect((err as LiteInferenceError).details.matrix).toBe('urine');
    }
  });

  it('rejects observations spanning multiple matrices', () => {
    const base = makeInput();
    const sampleIso = new Date(BASELINE + SAMPLE_HOURS * 3_600_000).toISOString();
    const input: InferenceInput = {
      ...base,
      observations: [
        base.observations[0]!,
        {
          id: 'obs-2',
          analyte: 'ethanol',
          concentration: { value: PREDICTED_C, unit: 'mg/L' },
          matrix: 'serum',
          sampleTime: sampleIso,
          assay: { uncertaintyCV: 0.05 },
        },
      ],
    };
    try {
      runLiteInference(input);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LiteInferenceError);
      expect((err as LiteInferenceError).code).toBe('matrix-mixed');
    }
  });

  it('accepts a supported non-blood matrix (serum for the ethanol card)', () => {
    const result = runLiteInference(withMatrix('serum'));
    expect(result.diagnostics.sampleCount).toBeGreaterThan(0);
    expect(result.card?.id).toBe('ethanol-zero-order-v0');
  });

  it('validateLiteInferenceInput returns the matched card without running inference', () => {
    const { card } = validateLiteInferenceInput(makeInput());
    expect(card?.id).toBe('ethanol-zero-order-v0');
  });
});

describe('runLiteInference — output parity with the engine happy path', () => {
  it('produces the same posterior + predictive as engine.infer for a valid case', async () => {
    const engine = new LiteBrowserEngine();
    const input = makeInput();
    const engineResult = await engine.infer(input);
    // The engine derives the predictive range internally; call the shared fn
    // the same way (no explicit range) so the curves are directly comparable.
    const lite = runLiteInference(input);

    expect(lite.posterior.intervals.dose!.median).toBeCloseTo(
      engineResult.posteriorSummary.intervals.dose!.median,
      6,
    );
    expect(lite.predictive.length).toBe(
      engineResult.posteriorPredictive!.timeSeries.length,
    );
    expect(lite.diagnostics.effectiveSampleSize).toBeCloseTo(
      engineResult.diagnostics.effectiveSampleSize ?? -1,
      6,
    );
  });
});

describe('parent/metabolite cards are flagged, never silently first-order', () => {
  it('isApproximatedModelCard is true for the morphine card', () => {
    expect(isApproximatedModelCard(findModelCardByAnalyte('morphine'))).toBe(true);
    expect(isApproximatedModelCard(findModelCardByAnalyte('ethanol'))).toBe(false);
    expect(isApproximatedModelCard(undefined)).toBe(false);
  });

  it('runLiteInference warns that a morphine (parent/metabolite) case runs as first-order', () => {
    const sampleIso = new Date(BASELINE + SAMPLE_HOURS * 3_600_000).toISOString();
    const input: InferenceInput = {
      modelId: 'morphine-first-order',
      analyte: 'morphine', // matches the (now correctly slugged) morphine card
      route: 'iv',
      observations: [
        {
          id: 'obs-1',
          analyte: 'morphine',
          concentration: { value: 0.05, unit: 'mg/L' },
          matrix: 'whole_blood',
          sampleTime: sampleIso,
          assay: { uncertaintyCV: 0.1 },
        },
      ],
      priors: {
        dose: { type: 'uniform', min: 1, max: 50 },
        halfLife: { type: 'fixed', value: 2.5 },
        vd: { type: 'fixed', value: 280 },
      },
      scenario: {
        possibleIntakeWindow: {
          earliestIso: new Date(BASELINE).toISOString(),
          latestIso: new Date(BASELINE).toISOString(),
        },
      },
      defaultAssayCV: 0.15,
      drawCount: 500,
      gridResolution: 40,
      seed: 3,
    };
    const result = runLiteInference(input);
    expect(result.card?.id).toBe('morphine-parent-metabolite-v0');
    expect(
      result.warnings.some((w) =>
        w.toLowerCase().includes('parent-only first-order'),
      ),
    ).toBe(true);
  });
});

describe('ESS thresholds are a single shared source', () => {
  it('the adapter re-exports the canonical thresholds', () => {
    expect(ADAPTER_LOW).toBe(LOW_ESS_RATIO);
    expect(ADAPTER_CRITICAL).toBe(CRITICAL_ESS_RATIO);
  });

  it('classifyEss uses the canonical thresholds', () => {
    expect(classifyEss(0.5)).toBe('ok');
    expect(classifyEss(LOW_ESS_RATIO)).toBe('ok');
    expect(classifyEss(LOW_ESS_RATIO - 0.001)).toBe('low');
    expect(classifyEss(CRITICAL_ESS_RATIO - 0.001)).toBe('critical');
  });
});
