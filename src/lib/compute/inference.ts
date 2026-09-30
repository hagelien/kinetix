import { PRNG, sampleDistribution, percentile } from '../distributions';
import {
  concentrationFromDoseIV,
  concentrationFromDoseOral,
  concentrationOralFirstOrder,
  concentrationZeroOrder,
} from '../kinetics-core/equations';
import type {
  InferenceInput,
  InferencePriors,
  Observation,
  PosteriorSummary,
} from './types';

// Two PK families are supported by the Lite engine today. The discriminator
// is the model card's `modelType`: `ethanol_zero_order` selects the
// Widmark-style linear elimination path; everything else falls through to
// the existing one-compartment first-order math (the IV vs. oral split is
// inside that branch, controlled by `route`).
export type InferenceModelType = 'first_order' | 'zero_order';

// Exported for the engine + tests. Pure-function module so the compute layer
// stays testable without spinning up the worker.

export interface ParameterDraw {
  dose: number;
  /** Hours. Set to 0 for zero-order draws (unused; the contract is that
   *  zero-order code paths read `eliminationRate` instead). */
  halfLife: number;
  /** mg/L per hour. Set to 0 for first-order draws (unused). */
  eliminationRate: number;
  vd: number;
  f: number;
  /** First-order absorption rate constant, per hour. 0 means instantaneous
   *  absorption (the default post-absorption approximation); > 0 selects the
   *  Bateman curve. Only non-zero for non-IV first-order draws with a `ka`
   *  prior. */
  ka: number;
  intakeOffsetHours: number;
}

export interface DrawSample {
  draw: ParameterDraw;
  /** Unnormalized importance weight (raw exp(log_lik), pre-normalize). */
  weight: number;
  /** Log likelihood at this draw. -Infinity if any observation is impossible. */
  logLikelihood: number;
}

/** A repeated dose beyond the primary (inferred) one, at a known time relative
 *  to the primary intake, expressed as a fraction of the inferred primary dose
 *  (1.0 = an identical repeat). Only the primary dose magnitude is inferred;
 *  the schedule and relative sizes are treated as known. First-order only —
 *  the zero-order (ethanol) path keeps its own Widmark multi-intake structure. */
export interface AdditionalDose {
  /** Hours after the primary intake (≥ 0). Shifts with the inferred offset. */
  tHoursAfterPrimary: number;
  /** Amount as a multiple of the inferred primary dose (> 0). */
  doseFraction: number;
}

export interface InferenceComputation {
  /** Which PK family the math used. The downstream summarizer + predictive
   *  curve generator branch on this to read the right parameter fields and
   *  emit the right intervals (e.g., `eliminationRate` instead of `halfLife`
   *  for ethanol). */
  modelType: InferenceModelType;
  /** Known repeated-dose schedule superposed on top of the primary dose
   *  (first-order only). Empty for a single-dose case. The predictive curve
   *  generator reads it, so it must travel with the computation. */
  additionalDoses: AdditionalDose[];
  /** Surviving draws after rejection of nonphysical or impossible samples. */
  samples: DrawSample[];
  /** Total number of attempted draws (before rejection). */
  attempted: number;
  /** Number rejected by the validity check (vd/halfLife/f bounds). */
  rejectedNonphysical: number;
  /** Number with -Infinity log-likelihood (e.g. sampleTime < intake). */
  rejectedImpossible: number;
  /** Effective sample size = (sum w)^2 / sum w^2. */
  effectiveSampleSize: number;
  /** Sum of normalized weights of the surviving draws (always == 1 unless 0). */
  totalWeight: number;
}

function deriveModelType(input: InferenceInput): InferenceModelType {
  // Priors-shape-driven dispatch over model-card-driven: presence of
  // `eliminationRate` is the explicit zero-order signal. This makes the
  // engine robust against test fixtures or saved cases whose `modelId`
  // is set to an ethanol card but whose priors are first-order-shaped
  // (legacy data, ad-hoc fixtures), and lets future analytes opt into
  // zero-order purely by supplying the right prior — no model-card
  // round-trip required. The model card stays the source of truth for
  // assumptions, limitations, and supported matrices, but it doesn't
  // pick the equation.
  if (input.priors.eliminationRate) return 'zero_order';
  return 'first_order';
}

// ─── Public entry point ────────────────────────────────────────────────────

export function runInference(
  input: InferenceInput,
  rng: PRNG = new PRNG(input.seed),
): InferenceComputation {
  const isIv = input.route === 'iv';
  const modelType = deriveModelType(input);
  const intakeOffsetMaxHours = deriveIntakeOffsetMaxHours(input);
  const baselineMs = deriveBaselineMs(input);
  // Repeated dosing is superposed only for the linear first-order model; the
  // zero-order (ethanol) path keeps its own Widmark multi-intake handling.
  const additionalDoses: AdditionalDose[] =
    modelType === 'first_order' ? (input.additionalDoses ?? []) : [];

  // Pre-compute observation absolute times (ms since baseline). Without a
  // sampleTime we cannot place the observation on the predicted curve, so we
  // reject the input rather than guess.
  const obsForLikelihood = input.observations.map((o) =>
    prepareObservation(o, baselineMs),
  );

  const samples: DrawSample[] = [];
  let rejectedNonphysical = 0;
  let rejectedImpossible = 0;

  for (let s = 0; s < input.drawCount; s++) {
    const draw = drawValidDraw(
      input.priors,
      rng,
      isIv,
      intakeOffsetMaxHours,
      modelType,
    );
    if (!draw) {
      rejectedNonphysical++;
      continue;
    }

    const logLik = logLikelihood(
      draw,
      obsForLikelihood,
      isIv,
      input.defaultAssayCV,
      modelType,
      additionalDoses,
    );

    if (!Number.isFinite(logLik)) {
      rejectedImpossible++;
      continue;
    }

    samples.push({ draw, logLikelihood: logLik, weight: 0 });
  }

  if (samples.length === 0) {
    return {
      modelType,
      additionalDoses,
      samples: [],
      attempted: input.drawCount,
      rejectedNonphysical,
      rejectedImpossible,
      effectiveSampleSize: 0,
      totalWeight: 0,
    };
  }

  // Convert log-likelihoods to normalized weights using the log-sum-exp trick
  // so very small / very large likelihoods don't underflow / overflow.
  const maxLogLik = samples.reduce(
    (m, s) => (s.logLikelihood > m ? s.logLikelihood : m),
    -Infinity,
  );
  let weightSum = 0;
  let weightSqSum = 0;
  for (const s of samples) {
    s.weight = Math.exp(s.logLikelihood - maxLogLik);
    weightSum += s.weight;
  }
  for (const s of samples) {
    s.weight /= weightSum; // normalize to sum to 1
    weightSqSum += s.weight * s.weight;
  }

  const ess = weightSqSum > 0 ? 1 / weightSqSum : 0;

  return {
    modelType,
    additionalDoses,
    samples,
    attempted: input.drawCount,
    rejectedNonphysical,
    rejectedImpossible,
    effectiveSampleSize: ess,
    totalWeight: 1,
  };
}

// ─── Posterior summary ─────────────────────────────────────────────────────

export function summarizePosterior(
  comp: InferenceComputation,
  isIv: boolean,
): PosteriorSummary {
  if (comp.samples.length === 0) {
    return { intervals: {} };
  }

  const intervals: PosteriorSummary['intervals'] = {};
  intervals.dose = weightedIntervals(comp.samples, (s) => s.draw.dose, 'mg');
  intervals.vd = weightedIntervals(comp.samples, (s) => s.draw.vd, 'L');
  intervals.intakeOffsetHours = weightedIntervals(
    comp.samples,
    (s) => s.draw.intakeOffsetHours,
    'h',
  );
  if (comp.modelType === 'zero_order') {
    // Zero-order ethanol: report the elimination rate in mg/L/h. The user
    // most commonly thinks in g/L/h or ‰/h (= 0.001 g/L/h); the renderer
    // converts at the UI layer.
    intervals.eliminationRate = weightedIntervals(
      comp.samples,
      (s) => s.draw.eliminationRate,
      'mg/L/h',
    );
  } else {
    intervals.halfLife = weightedIntervals(
      comp.samples,
      (s) => s.draw.halfLife,
      'h',
    );
    if (!isIv) {
      intervals.f = weightedIntervals(comp.samples, (s) => s.draw.f, '');
      // Only surface ka when it was actually sampled (the Bateman path);
      // an instantaneous-absorption run has ka fixed at 0 for every draw.
      if (comp.samples.some((s) => s.draw.ka > 0)) {
        intervals.ka = weightedIntervals(comp.samples, (s) => s.draw.ka, '1/h');
      }
    }
  }
  return { intervals };
}

// ─── Posterior predictive ──────────────────────────────────────────────────

export interface PosteriorPredictivePoint {
  /** Hours since the inference baseline (earliest possible intake). */
  t: number;
  p05: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
}

/**
 * Residual / observation-error layer for the posterior predictive. When
 * supplied, the predictive band reflects not just posterior parameter
 * uncertainty (a credible envelope for the *expected* concentration) but the
 * scatter a *future measurement* would show — i.e. a genuine posterior
 * predictive interval. `sigma` is the lognormal residual SD,
 * sqrt(log(1+CV²)); `rng` is a dedicated stream so predictive noise never
 * perturbs the inference draws.
 *
 * The reported median stays the expected-concentration median (the lognormal
 * residual is multiplicative with median 1, so it widens the band roughly
 * symmetrically in log space without shifting the centre); only the outer
 * quantiles widen.
 */
export interface PredictiveResidual {
  sigma: number;
  rng: PRNG;
}

export function posteriorPredictive(
  comp: InferenceComputation,
  isIv: boolean,
  timeRangeHours: { start: number; end: number; steps: number },
  residual?: PredictiveResidual,
): PosteriorPredictivePoint[] {
  if (comp.samples.length === 0) return [];

  const { start, end, steps } = timeRangeHours;
  const out: PosteriorPredictivePoint[] = [];

  for (let i = 0; i <= steps; i++) {
    const t = start + ((end - start) * i) / steps;
    const concs: number[] = [];
    const noisy: number[] = [];
    const weights: number[] = [];
    for (const s of comp.samples) {
      const tRel = t - s.draw.intakeOffsetHours;
      const k =
        comp.modelType === 'first_order' ? Math.LN2 / s.draw.halfLife : 0;
      // Superposes the primary dose with any known repeated doses (first-order);
      // `predictConcentration` returns 0 for not-yet-administered doses.
      const c = predictConcentration(
        s.draw,
        k,
        tRel,
        isIv,
        comp.modelType,
        comp.additionalDoses,
      );
      const cClamped = Number.isFinite(c) && c >= 0 ? c : 0;
      concs.push(cClamped);
      weights.push(s.weight);
      if (residual) {
        const [z] = residual.rng.nextGaussianPair();
        noisy.push(cClamped > 0 ? cClamped * Math.exp(residual.sigma * z) : 0);
      }
    }
    const expected = weightedQuantiles(concs, weights);
    if (residual) {
      // Median from the expected curve (stable, interpretable); band edges
      // from the residual-inflated predictive distribution.
      const pred = weightedQuantiles(noisy, weights);
      out.push({
        t,
        median: expected.median,
        p05: pred.p05,
        p25: pred.p25,
        p75: pred.p75,
        p95: pred.p95,
      });
    } else {
      out.push({ t, ...expected });
    }
  }
  return out;
}

/** Lognormal residual SD from an assay CV: σ = sqrt(log(1 + CV²)). */
export function residualSigmaFromCV(cv: number): number {
  return Math.sqrt(Math.log(1 + cv * cv));
}

// ─── Internal helpers ──────────────────────────────────────────────────────

interface PreparedObservation {
  /** Hours since baseline. */
  tHoursSinceBaseline: number;
  concentrationMgPerL: number;
  cv: number;
  /** Left-censoring limit in mg/L when the observation is a non-detect. */
  censoredBelowMgPerL?: number;
}

function prepareObservation(
  o: Observation,
  baselineMs: number,
): PreparedObservation {
  if (!o.sampleTime) {
    throw new Error(
      `Observation ${o.id} has no sampleTime; Lite inference cannot place it on the predicted curve.`,
    );
  }
  const ms = Date.parse(o.sampleTime);
  if (!Number.isFinite(ms)) {
    throw new Error(
      `Observation ${o.id} has unparseable sampleTime: ${o.sampleTime}`,
    );
  }
  const tHours = (ms - baselineMs) / 3_600_000;
  return {
    tHoursSinceBaseline: tHours,
    concentrationMgPerL: toMgPerL(o.concentration.value, o.concentration.unit),
    cv: o.assay?.uncertaintyCV ?? NaN, // resolved against the input default later
    censoredBelowMgPerL: o.censoring
      ? toMgPerL(o.censoring.limit, o.concentration.unit)
      : undefined,
  };
}

/** Error function via the Abramowitz–Stegun 7.1.26 approximation. */
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF Φ(x) = ½(1 + erf(x/√2)). */
function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Lossless conversion to mg/L. Mass units are handled directly; molar units
 *  would require a molecular weight which Lite does not yet plumb through —
 *  callers using molar should convert upstream. */
function toMgPerL(
  value: number,
  unit: Observation['concentration']['unit'],
): number {
  switch (unit) {
    case 'mg/L':
      return value;
    case 'µg/L':
      return value / 1000;
    case 'ng/mL':
      return value / 1000;
    case 'µmol/L':
    case 'mmol/L':
      // Molar requires MW; phase 1a does not plumb it through. Tell the caller
      // exactly what to do rather than silently mis-converting.
      throw new Error(
        `Observation in ${unit} is not yet supported by Lite inference; convert to mg/L upstream using the analyte molecular weight.`,
      );
  }
}

function deriveIntakeOffsetMaxHours(input: InferenceInput): number {
  const window = input.scenario?.possibleIntakeWindow;
  if (!window) return 0;
  const earliest = Date.parse(window.earliestIso);
  const latest = Date.parse(window.latestIso);
  if (!Number.isFinite(earliest) || !Number.isFinite(latest)) {
    throw new Error('Invalid intake window timestamp');
  }
  if (latest < earliest) {
    throw new Error(
      'possibleIntakeWindow.latestIso is earlier than earliestIso',
    );
  }
  return Math.max(0, (latest - earliest) / 3_600_000);
}

function deriveBaselineMs(input: InferenceInput): number {
  const window = input.scenario?.possibleIntakeWindow;
  if (window) {
    const earliest = Date.parse(window.earliestIso);
    if (Number.isFinite(earliest)) return earliest;
  }
  // Fall back to the earliest sampleTime so relative offsets are meaningful.
  const sampleTimes = input.observations
    .map((o) => (o.sampleTime ? Date.parse(o.sampleTime) : NaN))
    .filter((ms) => Number.isFinite(ms));
  if (sampleTimes.length === 0) {
    throw new Error(
      'Lite inference needs either a possibleIntakeWindow or at least one observation with sampleTime.',
    );
  }
  return Math.min(...sampleTimes);
}

function drawValidDraw(
  priors: InferencePriors,
  rng: PRNG,
  isIv: boolean,
  intakeOffsetMaxHours: number,
  modelType: InferenceModelType,
): ParameterDraw | null {
  // Same resample-once-then-skip pattern used by simulate() and the existing
  // montecarlo.worker.ts. Without it broad priors leak nonphysical draws.
  // Per-modelType priors: first-order needs `halfLife` (and `f` when oral);
  // zero-order needs `eliminationRate` and ignores `f` (Widmark assumes
  // complete absorption). A missing required prior throws because that's a
  // caller bug, not a draw to silently reject.
  if (modelType === 'first_order' && !priors.halfLife) {
    throw new Error(
      'First-order inference requires `priors.halfLife`; got undefined.',
    );
  }
  if (modelType === 'zero_order' && !priors.eliminationRate) {
    throw new Error(
      'Zero-order inference requires `priors.eliminationRate`; got undefined.',
    );
  }
  // Bateman absorption applies only to non-IV first-order draws with a `ka`
  // prior. Everything else keeps ka = 0 (instantaneous absorption).
  const usesKa = modelType === 'first_order' && !isIv && !!priors.ka;
  const draw = (): ParameterDraw => ({
    dose: sampleDistribution(priors.dose, rng),
    halfLife:
      modelType === 'first_order'
        ? sampleDistribution(priors.halfLife!, rng)
        : 0,
    eliminationRate:
      modelType === 'zero_order'
        ? sampleDistribution(priors.eliminationRate!, rng)
        : 0,
    vd: sampleDistribution(priors.vd, rng),
    // Zero-order math doesn't read F; keep it at 1 so any accidental cross-
    // model use still produces sensible numbers rather than zeros.
    f:
      isIv || modelType === 'zero_order'
        ? 1
        : sampleDistribution(priors.f ?? { type: 'fixed', value: 1 }, rng),
    ka: usesKa ? sampleDistribution(priors.ka!, rng) : 0,
    intakeOffsetHours:
      intakeOffsetMaxHours > 0 ? rng.next() * intakeOffsetMaxHours : 0,
  });
  const isValid = (d: ParameterDraw): boolean => {
    if (d.dose <= 0 || d.vd <= 0 || d.intakeOffsetHours < 0) return false;
    if (modelType === 'zero_order') {
      return d.eliminationRate > 0;
    }
    if (usesKa && !(d.ka > 0)) return false;
    return d.halfLife > 0 && d.f > 0 && d.f <= 1;
  };
  let d = draw();
  if (isValid(d)) return d;
  d = draw();
  return isValid(d) ? d : null;
}

/**
 * Predicted concentration at `tRel` hours after the primary (earliest) intake.
 * First-order cases superpose the primary dose with any known repeated doses
 * (each a fraction of the inferred dose, at a known relative offset); zero-order
 * returns the single Widmark concentration (repeated ethanol intakes are handled
 * by the dedicated ethanol path, not here). Doses whose elapsed time is negative
 * (not yet administered at `tRel`) contribute zero.
 */
function predictConcentration(
  draw: ParameterDraw,
  k: number,
  tRel: number,
  isIv: boolean,
  modelType: InferenceModelType,
  additionalDoses: AdditionalDose[],
): number {
  if (modelType === 'zero_order') {
    return concentrationZeroOrder(
      draw.dose,
      draw.vd,
      draw.eliminationRate,
      tRel,
    );
  }
  const single = (amount: number, elapsed: number): number => {
    if (elapsed < 0) return 0;
    if (isIv) return concentrationFromDoseIV(amount, draw.vd, k, elapsed);
    if (draw.ka > 0) {
      // Bateman first-order absorption (a rising-then-falling curve).
      return concentrationOralFirstOrder(
        amount,
        draw.vd,
        draw.f,
        draw.ka,
        k,
        elapsed,
      );
    }
    return concentrationFromDoseOral(amount, draw.vd, draw.f, k, elapsed);
  };
  let c = single(draw.dose, tRel);
  for (const add of additionalDoses) {
    c += single(draw.dose * add.doseFraction, tRel - add.tHoursAfterPrimary);
  }
  return c;
}

function logLikelihood(
  draw: ParameterDraw,
  observations: PreparedObservation[],
  isIv: boolean,
  defaultCV: number,
  modelType: InferenceModelType,
  additionalDoses: AdditionalDose[] = [],
): number {
  const k = modelType === 'first_order' ? Math.LN2 / draw.halfLife : 0;
  let logLik = 0;
  for (const o of observations) {
    const tRel = o.tHoursSinceBaseline - draw.intakeOffsetHours;
    const censored = o.censoredBelowMgPerL != null;
    if (tRel < 0) {
      // A quantified observation before the modelled intake is impossible under
      // this draw. A non-detect (censored) before intake is CONSISTENT — the
      // true concentration is 0, which is below any limit — so it contributes
      // log(1) = 0 rather than rejecting the draw. `tRel` is elapsed since the
      // PRIMARY (earliest) dose, so this holds for the whole schedule.
      if (censored) continue;
      return -Infinity;
    }
    const predicted = predictConcentration(
      draw,
      k,
      tRel,
      isIv,
      modelType,
      additionalDoses,
    );
    if (!Number.isFinite(predicted) || predicted <= 0) {
      // Predicted essentially zero: a non-detect is satisfied (contributes 0);
      // a quantified positive observation is impossible.
      if (censored) continue;
      return -Infinity;
    }
    const cv = Number.isFinite(o.cv) && o.cv > 0 ? o.cv : defaultCV;
    // Lognormal observation model: log(observed) ~ N(log(predicted), sigma)
    // with sigma = sqrt(log(1 + cv^2)). Standard PK convention. The cv > 0
    // guard above prevents sigma from collapsing to 0 (which would make
    // every draw NaN-rejected with a misleading empty-posterior warning).
    const sigma = Math.sqrt(Math.log(1 + cv * cv));
    if (censored) {
      // Left-censored non-detect: P(true concentration < limit | predicted)
      // under the lognormal model = Φ((log limit − log predicted) / sigma).
      const z =
        (Math.log(o.censoredBelowMgPerL!) - Math.log(predicted)) / sigma;
      logLik += Math.log(Math.max(normalCdf(z), 1e-300));
      continue;
    }
    const z = (Math.log(o.concentrationMgPerL) - Math.log(predicted)) / sigma;
    logLik +=
      -0.5 * z * z -
      Math.log(sigma * Math.sqrt(2 * Math.PI)) -
      Math.log(o.concentrationMgPerL);
  }
  return logLik;
}

// ─── Weighted percentile helpers ───────────────────────────────────────────

function weightedIntervals(
  samples: DrawSample[],
  pick: (s: DrawSample) => number,
  unit: string,
): { median: number; p05: number; p95: number; unit: string } {
  const values = samples.map(pick);
  const weights = samples.map((s) => s.weight);
  const q = weightedQuantiles(values, weights, [5, 50, 95]);
  return { p05: q.p05, median: q.median, p95: q.p95, unit };
}

function weightedQuantiles(
  values: number[],
  weights: number[],
  qs: [5, 50, 95] | [5, 25, 50, 75, 95] = [5, 25, 50, 75, 95],
): { p05: number; p25: number; median: number; p75: number; p95: number } {
  // Pair, sort by value, walk the cumulative weight to each quantile.
  const n = values.length;
  if (n === 0) {
    return { p05: 0, p25: 0, median: 0, p75: 0, p95: 0 };
  }
  const indices = values
    .map((_, i) => i)
    .sort((a, b) => values[a]! - values[b]!);
  const sortedValues: number[] = new Array(n);
  const sortedWeights: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    sortedValues[i] = values[indices[i]!]!;
    sortedWeights[i] = weights[indices[i]!]!;
  }
  const totalW = sortedWeights.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(totalW) || totalW <= 0) {
    // Fall back to unweighted quantiles so callers don't get NaN.
    const sorted = new Float64Array(values).sort();
    return {
      p05: percentile(sorted, 5),
      p25: percentile(sorted, 25),
      median: percentile(sorted, 50),
      p75: percentile(sorted, 75),
      p95: percentile(sorted, 95),
    };
  }

  const findQuantile = (q: number): number => {
    const target = (q / 100) * totalW;
    let cum = 0;
    for (let i = 0; i < n; i++) {
      cum += sortedWeights[i]!;
      if (cum >= target) return sortedValues[i]!;
    }
    return sortedValues[n - 1]!;
  };

  if (qs.length === 3) {
    return {
      p05: findQuantile(5),
      p25: 0,
      median: findQuantile(50),
      p75: 0,
      p95: findQuantile(95),
    };
  }
  return {
    p05: findQuantile(5),
    p25: findQuantile(25),
    median: findQuantile(50),
    p75: findQuantile(75),
    p95: findQuantile(95),
  };
}
