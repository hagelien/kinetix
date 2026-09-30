import { PRNG } from '../distributions';
import {
  findModelCardById,
  findModelCardByAnalyte,
  type PKModelCard,
} from './modelCards';
import {
  runInference,
  summarizePosterior,
  posteriorPredictive,
  residualSigmaFromCV,
  type InferenceComputation,
  type PosteriorPredictivePoint,
} from './inference';
import {
  inferenceInputSchema,
  type InferenceInput,
  type PosteriorSummary,
} from './types';

// ─── Single Lite-inference boundary ─────────────────────────────────────────
//
// `runLiteInference` is the ONE validated pipeline for the Lite engine:
// schema parse → model-card lookup → matrix policy → importance-sampling
// inference → posterior → posterior predictive → diagnostics. It exists so the
// two entry points that were drifting apart —
//   • `LiteBrowserEngine.infer()` (direct, fully-guarded), and
//   • `inference.worker.ts` (the off-thread path the /modeling UI actually
//     runs, which previously called the raw `runInference()` with no schema
//     validation, no card lookup, and no matrix policy)
// — now share the exact same validation and math. Any guard added here applies
// to both callers, so they can no longer disagree about whether a case is even
// runnable.

/** Canonical ESS thresholds. Single source of truth for the engine, the
 *  worker, and the UI adapter (`modelingRun.ts`), so "low" / "critical" mean
 *  the same thing wherever effective sample size is judged. */
export const LOW_ESS_RATIO = 0.1;
export const CRITICAL_ESS_RATIO = 0.02;

export type EssStatus = 'ok' | 'low' | 'critical';

/** Classify an ESS ratio against the canonical thresholds. */
export function classifyEss(essRatio: number): EssStatus {
  if (essRatio < CRITICAL_ESS_RATIO) return 'critical';
  if (essRatio < LOW_ESS_RATIO) return 'low';
  return 'ok';
}

/**
 * True when the card declares a PK family the Lite importance-sampler does not
 * implement mechanistically. `runInference` dispatches purely on the priors'
 * shape — zero-order iff an `eliminationRate` prior is present, else
 * first-order — so a `parent_metabolite_simple` card still produces a result,
 * but as a parent-only first-order approximation. Callers surface this rather
 * than letting the richer-sounding card imply a mechanism the math lacks.
 */
export function isApproximatedModelCard(card: PKModelCard | undefined): boolean {
  return card?.modelType === 'parent_metabolite_simple';
}

export type LiteInferenceErrorCode = 'matrix-mixed' | 'matrix-unsupported';

/** Typed validation failure raised by the Lite inference boundary. Carries a
 *  machine-readable `code` + `details` so callers (e.g. the /modeling adapter)
 *  can render a localized, structured error instead of a bare string. */
export class LiteInferenceError extends Error {
  readonly code: LiteInferenceErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: LiteInferenceErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'LiteInferenceError';
    this.code = code;
    this.details = details;
  }
}

export interface LiteInferenceDiagnostics {
  sampleCount: number;
  attempted: number;
  rejectedNonphysical: number;
  rejectedImpossible: number;
  effectiveSampleSize: number;
  /** ESS as a fraction of surviving draws (0 when the posterior is empty). */
  essRatio: number;
  essStatus: EssStatus;
}

export interface LiteInferenceResult {
  /** The parsed (schema-validated, default-filled) input. */
  input: InferenceInput;
  /** The matched model card, if any. Undefined for components with no card
   *  (the engine still runs, with a "no card" warning). */
  card: PKModelCard | undefined;
  computation: InferenceComputation;
  posterior: PosteriorSummary;
  predictive: PosteriorPredictivePoint[];
  predictiveRange: { start: number; end: number; steps: number };
  diagnostics: LiteInferenceDiagnostics;
  /** Human-readable diagnostic strings, matching the engine's historical set. */
  warnings: string[];
}

export interface LiteInferenceOptions {
  /** Explicit predictive-curve time range. When omitted it is derived from the
   *  input's intake window ∪ observation times (`derivePredictiveRange`). The
   *  worker passes an explicit range (computed UI-side); the direct engine
   *  lets it derive. */
  predictiveRange?: { start: number; end: number; steps: number };
}

/**
 * Enforce the Lite matrix policy: Lite does not (yet) apply matrix-to-matrix
 * scaling, so silently mixing matrices would bias the posterior. Reject when
 *   1. observations span more than one matrix, or
 *   2. the observation matrix isn't in the model card's supportedMatrices.
 * Phase-2 matrix conversion (with its own uncertainty) will relax this.
 */
export function enforceMatrixPolicy(
  input: InferenceInput,
  card: PKModelCard | undefined,
): void {
  const observedMatrices = new Set(input.observations.map((o) => o.matrix));
  if (observedMatrices.size > 1) {
    throw new LiteInferenceError(
      'matrix-mixed',
      `Lite inference requires all observations to share a single matrix; got [${[...observedMatrices].join(', ')}]. Cross-matrix conversion is a phase-2 feature.`,
      { matrices: [...observedMatrices] },
    );
  }
  if (card) {
    const obsMatrix = input.observations[0]!.matrix;
    if (!card.supportedMatrices.includes(obsMatrix)) {
      throw new LiteInferenceError(
        'matrix-unsupported',
        `Observation matrix '${obsMatrix}' is not in the supported matrices for model card '${card.id}': [${card.supportedMatrices.join(', ')}]. Lite does not yet apply matrix-to-matrix scaling.`,
        {
          matrix: obsMatrix,
          supportedMatrices: card.supportedMatrices,
          cardId: card.id,
        },
      );
    }
  }
}

/**
 * Parse + look up the card + enforce the matrix policy, without running the
 * (heavier) inference. Callers on the main thread use this as a cheap
 * pre-flight so a policy violation surfaces as a typed `LiteInferenceError`
 * *before* work is dispatched to the worker (where the error would otherwise
 * cross the Comlink boundary and lose its `code`/`details`). The worker path
 * still runs the full `runLiteInference`, so the guard holds either way.
 */
export function validateLiteInferenceInput(rawInput: InferenceInput): {
  input: InferenceInput;
  card: PKModelCard | undefined;
} {
  const input = inferenceInputSchema.parse(rawInput);
  const card =
    findModelCardById(input.modelId) ?? findModelCardByAnalyte(input.analyte);
  enforceMatrixPolicy(input, card);
  return { input, card };
}

/**
 * The single Lite inference pipeline. Throws `LiteInferenceError` on a matrix
 * violation, `ZodError` on a malformed input, and the same observation/unit
 * errors `runInference` raises (missing sampleTime, molar units).
 */
export function runLiteInference(
  rawInput: InferenceInput,
  options: LiteInferenceOptions = {},
): LiteInferenceResult {
  const { input, card } = validateLiteInferenceInput(rawInput);

  const isIv = input.route === 'iv';
  const computation = runInference(input, new PRNG(input.seed));
  const posterior = summarizePosterior(computation, isIv);

  const predictiveRange = options.predictiveRange ?? derivePredictiveRange(input);
  // True posterior predictive: layer residual/observation error (assay CV) on
  // top of parameter uncertainty, on a dedicated RNG stream so predictive noise
  // never perturbs the inference draws. `posteriorPredictive` returns [] for an
  // empty posterior.
  const predictive = posteriorPredictive(computation, isIv, predictiveRange, {
    sigma: residualSigmaFromCV(input.defaultAssayCV),
    rng: new PRNG(input.seed + 7919),
  });

  const essRatio =
    computation.samples.length > 0
      ? computation.effectiveSampleSize / computation.samples.length
      : 0;
  const essStatus =
    computation.samples.length === 0 ? 'ok' : classifyEss(essRatio);

  const warnings: string[] = [];
  if (!card) {
    warnings.push(
      'No KineLab model card was found for the requested analyte; using bare analytic-PK defaults.',
    );
  } else if (isApproximatedModelCard(card)) {
    warnings.push(
      `Model card '${card.id}' declares a parent/metabolite model, but the Lite engine runs it as a parent-only first-order approximation; the metabolite chain is not modelled.`,
    );
  }
  if (computation.rejectedNonphysical > 0) {
    warnings.push(
      `${computation.rejectedNonphysical} of ${computation.attempted} draws were rejected because the priors produced nonphysical PK parameters.`,
    );
  }
  if (computation.rejectedImpossible > 0) {
    warnings.push(
      `${computation.rejectedImpossible} of ${computation.attempted} draws had zero likelihood (e.g. observation before intake or predicted concentration of zero); they were discarded.`,
    );
  }
  if (computation.samples.length === 0) {
    warnings.push(
      'No draws survived the likelihood evaluation. Tighten priors, widen the intake window, or re-check observation times — the posterior is empty.',
    );
  } else if (essStatus !== 'ok') {
    warnings.push(
      `Effective sample size is low (${computation.effectiveSampleSize.toFixed(1)} of ${computation.samples.length} surviving draws, ratio ${(essRatio * 100).toFixed(1)}%). Posterior summaries are dominated by a few high-weight draws — consider widening priors or adding draws.`,
    );
  }
  // Non-IV first-order without an absorption rate: the engine falls back to
  // instantaneous absorption, which is not valid around Tmax.
  if (
    input.route !== 'iv' &&
    !input.priors.eliminationRate &&
    !input.priors.ka
  ) {
    warnings.push(
      'Absorption is treated as instantaneous (no ka); concentrations sampled near Tmax are not reliable. Provide an absorption rate constant (ka) to use the Bateman model.',
    );
  }

  return {
    input,
    card,
    computation,
    posterior,
    predictive,
    predictiveRange,
    diagnostics: {
      sampleCount: computation.samples.length,
      attempted: computation.attempted,
      rejectedNonphysical: computation.rejectedNonphysical,
      rejectedImpossible: computation.rejectedImpossible,
      effectiveSampleSize: computation.effectiveSampleSize,
      essRatio,
      essStatus,
    },
    warnings,
  };
}

/**
 * Cover the union of [intake window] ∪ [observation times], with a fixed
 * forward margin so the predictive curve clearly tails off past the last
 * sample. Moved here from `LiteBrowserEngine` so the direct engine and the
 * worker derive the same range.
 */
export function derivePredictiveRange(input: InferenceInput): {
  start: number;
  end: number;
  steps: number;
} {
  const sampleHours: number[] = [];
  const baselineMs = (() => {
    const win = input.scenario?.possibleIntakeWindow;
    if (win) {
      const ms = Date.parse(win.earliestIso);
      if (Number.isFinite(ms)) return ms;
    }
    const ts = input.observations
      .map((o) => (o.sampleTime ? Date.parse(o.sampleTime) : NaN))
      .filter((v) => Number.isFinite(v));
    return ts.length ? Math.min(...ts) : Date.now();
  })();
  for (const o of input.observations) {
    if (o.sampleTime) {
      const ms = Date.parse(o.sampleTime);
      if (Number.isFinite(ms)) sampleHours.push((ms - baselineMs) / 3_600_000);
    }
  }
  const win = input.scenario?.possibleIntakeWindow;
  let windowEndHours = 0;
  if (win) {
    const ms = Date.parse(win.latestIso);
    if (Number.isFinite(ms)) windowEndHours = (ms - baselineMs) / 3_600_000;
  }
  const lastObs = sampleHours.length ? Math.max(...sampleHours) : 0;
  const end = Math.max(windowEndHours, lastObs) + 6; // 6h tail margin
  return { start: 0, end: Math.max(end, 1), steps: 60 };
}
