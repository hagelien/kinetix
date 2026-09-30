import * as Comlink from 'comlink';
import type { PosteriorPredictivePoint } from '@/lib/compute/inference';
import { runLiteInference } from '@/lib/compute/liteInference';
import type {
  InferenceInput,
  PosteriorSummary,
} from '@/lib/compute/types';

// Off-thread inference. Mirrors the existing montecarlo.worker.ts shape
// (Comlink-exposed object) so consumers can `Comlink.wrap` it the same way.

export interface WorkerInferenceOutput {
  posterior: PosteriorSummary;
  predictive: PosteriorPredictivePoint[];
  diagnostics: {
    sampleCount: number;
    rejectedNonphysical: number;
    rejectedImpossible: number;
    effectiveSampleSize: number;
  };
}

export interface RunInferenceArgs {
  input: InferenceInput;
  /**
   * Time range for the posterior predictive curve. The page derives this
   * from the intake window + sample times before posting because the worker
   * shouldn't be re-doing UI math.
   */
  predictiveRangeHours: { start: number; end: number; steps: number };
}

export interface RunScenarioComparisonArgs {
  scenarios: Array<{
    id: string;
    label: string;
    args: RunInferenceArgs;
  }>;
}

export interface WorkerScenarioComparisonOutput {
  scenarios: Array<{
    id: string;
    label: string;
    output: WorkerInferenceOutput;
  }>;
}

function runOne(args: RunInferenceArgs): WorkerInferenceOutput {
  // Runs the SAME validated pipeline as `LiteBrowserEngine.infer()`: schema
  // parse, model-card lookup, and matrix policy are no longer bypassed on the
  // off-thread path. Matrix violations / malformed input throw here and
  // propagate back to the caller. The predictive range is passed through
  // (computed UI-side) so the curve is byte-identical to the previous output.
  const lite = runLiteInference(args.input, {
    predictiveRange: args.predictiveRangeHours,
  });
  return {
    posterior: lite.posterior,
    predictive: lite.predictive,
    diagnostics: {
      sampleCount: lite.diagnostics.sampleCount,
      rejectedNonphysical: lite.diagnostics.rejectedNonphysical,
      rejectedImpossible: lite.diagnostics.rejectedImpossible,
      effectiveSampleSize: lite.diagnostics.effectiveSampleSize,
    },
  };
}

const inferenceWorkerApi = {
  runInference(args: RunInferenceArgs): WorkerInferenceOutput {
    return runOne(args);
  },
  runScenarioComparison(
    args: RunScenarioComparisonArgs,
  ): WorkerScenarioComparisonOutput {
    return {
      scenarios: args.scenarios.map((s) => ({
        id: s.id,
        label: s.label,
        output: runOne(s.args),
      })),
    };
  },
};

export type InferenceWorkerApi = typeof inferenceWorkerApi;

Comlink.expose(inferenceWorkerApi);
