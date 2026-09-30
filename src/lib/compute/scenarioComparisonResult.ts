import type { UncertaintyPoint } from '@/types/simulator';
import type {
  Assumption,
  Limitation,
  PosteriorSummary,
  ScenarioComparisonResult,
} from './types';

// The scenario-comparison worker output (`WorkerScenarioComparisonOutput`)
// uses a flat per-scenario shape that's convenient for the React card but
// doesn't satisfy `scenarioComparisonResultSchema` — what the report
// renderer (and the engine surface) consumes. This module bridges the two.
//
// Lives next to `report.ts` so it's trivially unit-testable and any surface
// that lifts
// worker output (e.g. a future page-server bridge) can reuse it. Mirrors
// the shape `LiteBrowserEngine.compareScenarios()` returns so the report
// can't tell whether the comparison was computed inline or off-thread.

// Structurally typed against `WorkerScenarioComparisonOutput` so this module
// doesn't have to import from `src/workers/` (keeps the engine layer free of
// worker-thread types). Any shape with these fields satisfies the converter.
export interface WorkerScenarioOutputLike {
  posterior: PosteriorSummary;
  predictive: UncertaintyPoint[];
  diagnostics: {
    sampleCount: number;
    effectiveSampleSize: number;
  };
}

export interface WorkerScenarioComparisonOutputLike {
  scenarios: Array<{
    id: string;
    label: string;
    output: WorkerScenarioOutputLike;
  }>;
}

export interface BaselineMetadata {
  /** From `inferenceInput.modelId` — all scenarios in a comparison share the
   *  same model card today (variants inherit and override priors only),
   *  so a single value is propagated to every scenario's `modelIds`. */
  modelId: string;
  /** Pulled from the model card on the page; copied onto every scenario so
   *  the report's `InferenceResult.assumptions` field stays populated even
   *  though the comparison block itself doesn't render assumptions. */
  assumptions: Assumption[];
  limitations: Limitation[];
  /** mg/L today — keep as a parameter so a future per-matrix unit doesn't
   *  silently get hardcoded. */
  predictiveUnit: 'mg/L' | 'ng/mL' | 'µg/L';
}

export function workerOutputToScenarioComparisonResult<
  Output extends WorkerScenarioComparisonOutputLike,
>(output: Output, baseline: BaselineMetadata): ScenarioComparisonResult {
  const createdAt = new Date().toISOString();
  return {
    engine: 'lite-browser',
    scenarios: output.scenarios.map((s) => ({
      id: s.id,
      label: s.label,
      result: {
        engine: 'lite-browser',
        modelIds: [baseline.modelId],
        // The worker's `posterior` is built by the same `summarizePosterior`
        // call `LiteBrowserEngine.infer()` uses, so it already matches
        // `posteriorSummarySchema`.
        posteriorSummary: s.output.posterior,
        posteriorPredictive: {
          timeSeries: s.output.predictive,
          unit: baseline.predictiveUnit,
        },
        diagnostics: {
          engine: 'lite-browser',
          method: 'monte-carlo-importance-sampling',
          sampleCount: s.output.diagnostics.sampleCount,
          effectiveSampleSize: s.output.diagnostics.effectiveSampleSize,
          warnings: [],
        },
        assumptions: baseline.assumptions,
        limitations: baseline.limitations,
        createdAt,
      },
    })),
    diagnostics: {
      engine: 'lite-browser',
      method: 'monte-carlo-importance-sampling',
      // Aggregated total across scenarios, matching `compareScenarios()`'s
      // own diagnostic semantics so a comparison computed inline vs.
      // off-thread reports the same totals.
      sampleCount: output.scenarios.reduce(
        (sum, s) => sum + s.output.diagnostics.sampleCount,
        0,
      ),
      warnings: [],
    },
    createdAt,
  };
}
