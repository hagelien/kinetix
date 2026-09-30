/**
 * The portable forward simulator: CanonicalScenario -> CanonicalResult.
 *
 * Given a drug parameter set (from the registry), dose events (each with its OWN
 * route), subject covariates, a time grid, and an optional seeded uncertainty
 * config, it returns a canonical concentration curve in mg/L plus provenance.
 *
 * Guarantees that make cross-app harmonization possible:
 *   - deterministic: no Date.now / Math.random in the math; the manifest
 *     timestamp is the only wall-clock read and never affects the curve;
 *   - per-dose routes: mixed-route sessions are modelled correctly (no
 *     first-dose-route reuse);
 *   - failures are structured non-results, never a silent zero curve;
 *   - identical scenario -> identical curve under V8 and Hermes.
 */
import {
  CanonicalResult,
  CanonicalResultFailure,
  CanonicalScenario,
  CovariateId,
  CovariateTargetParameter,
  CurvePoint,
  DoseBasis,
  FailureCode,
  Limitation,
  Matrix,
  MatrixTransform,
  ObservationErrorLayer,
  ResolvedRouteSummary,
  RouteId,
  RouteModelParams,
  RunManifest,
} from './types.js';
import { CORE_VERSION, SCENARIO_SCHEMA_VERSION } from './version.js';
import {
  REGISTRY_VERSION,
  resolveModel,
  resolvedRegistryRelease,
} from './registry.js';
import { centralValue, sampleParam } from './param.js';
import {
  concentrationOralFirstOrder,
  concentrationFromDoseIV,
  concentrationInfusion,
  eliminationConstant,
} from './equations.js';
import {
  clvReferenceSubjectLimitation,
  isApparentBasis,
  isCoherentClvDisposition,
  resolveClvDisposition,
} from './structural.js';
import {
  individualisesDisposition,
  resolveCovariateFactors,
} from './covariates.js';
import { vdScaleKg } from './scaling.js';
import { ROUTE_IDS } from './types.js';
import type {
  AnalyteCurve,
  DrugModelDefinition,
  ModelFamily,
  ParamSpec,
  TwoCompartmentRouteParams,
  MichaelisMentenRouteParams,
  ParentMetaboliteRouteParams,
} from './types.js';
import {
  twoCompartmentCurve,
  twoCompPreWindowKeepThreshold,
  MAX_STEP_HOURS as ODE_MAX_STEP_HOURS,
  type TwoCompartmentDose,
  type TwoCompartmentResolvedRoute,
} from './models/two-compartment.js';
import {
  michaelisMentenCurve,
  mmPreWindowKeepThreshold,
  type MichaelisMentenDose,
  type MichaelisMentenResolvedRoute,
} from './models/michaelis-menten.js';
import {
  parentMetaboliteCurve,
  pmPreWindowKeepThreshold,
  formationMassCoefficient,
  type ParentMetaboliteDose,
  type ParentMetaboliteResolvedRoute,
} from './models/parent-metabolite.js';
import { PRNG, computePercentiles, covarianceCholesky } from './rng.js';
import { hashValue } from './hash.js';

/** Hard cap on grid points to reject pathological time grids up front. */
const MAX_GRID_POINTS = 200_000;
/** Hard cap on Monte-Carlo draws to reject pathological / non-terminating runs. */
const MAX_DRAWS = 200_000;
/**
 * Hard cap on total concentration evaluations for one run
 * (gridPoints × doses × max(draws, 1)). Each individual dimension has its own
 * cap, but their product can still be enormous (200k grid × 200k draws ≈ 4e10),
 * so bound the combined work to keep a browser/worker from hanging or OOMing.
 */
const MAX_SIM_CELLS = 50_000_000;
/**
 * Budget on the ACTUAL ODE work, which the grid-based MAX_SIM_CELLS check does not
 * capture. Every ODE family's derivative (two-compartment, Michaelis–Menten) is
 * O(doses) per RK4 sub-step, and the sub-step count is the integration span
 * (from the earliest retained dose — per the dose-dependent cluster horizon — to
 * the last output) divided by the internal step, per draw. So
 * total scalar work ≈ (span / step) × draws × retainedDoses. Bound that product,
 * so no combination of a long span, many draws, and many doses can drive billions
 * of derivative iterations and hang the worker. Realistic runs stay far under this
 * (24 h window × 1-min step × 500 draws × a handful of doses ≈ a few M).
 */
const MAX_ODE_WORK = 200_000_000;
/**
 * Absolute hard cap on retained doses in an ODE run (one gut compartment each),
 * independent of the work budget above.
 */
const MAX_ODE_DOSES = 1_000;
/** Below this fraction of surviving MC draws a result is flagged not-robust. */
const NOT_ROBUST_RATIO = 0.1;
/** Minimum supported subject weight (kg). Below this the one-compartment models
 * are out of their validated range, so reject rather than clamp/extrapolate. */
const MIN_WEIGHT_KG = 1;

/** The canonical route ids the engine recognises (own-property allow-list). Built from the single
 *  `ROUTE_IDS` source of truth so the engine's accepted routes cannot drift from the `RouteId` type
 *  and the DB route CHECK (CV-2c) — adding a route in one place adds it everywhere. */
const VALID_ROUTES: ReadonlySet<string> = new Set<RouteId>(ROUTE_IDS);

/** The canonical matrices the engine recognises (validates a caller override). */
const VALID_MATRICES: ReadonlySet<string> = new Set<Matrix>([
  'plasma',
  'serum',
  'whole_blood',
  'breath',
  'other',
]);

/**
 * A route's resolved single-dose contribution: concentration (mg/L) `elapsed`
 * hours after one administration of `amountMg` by that route. Each model family
 * produces one of these (from central or sampled parameters); the engine's
 * superposition, uncertainty, peak, and manifest plumbing is family-agnostic.
 */
type SingleDoseKernel = (elapsedHours: number, amountMg: number) => number;

export interface ResolvedDose {
  tHours: number;
  amountMg: number;
  kernel: SingleDoseKernel;
}

/** One route resolved to a kernel + validity + display summary. */
interface ResolvedRoute {
  kernel: SingleDoseKernel;
  valid: boolean;
  summary: ResolvedRouteSummary;
}

/** Concentration (mg/L) at absolute grid time `tHours` from resolved doses. */
function curveAt(resolved: ResolvedDose[], tHours: number): number {
  let sum = 0;
  for (const d of resolved) {
    const elapsed = tHours - d.tHours;
    if (elapsed < 0) continue;
    sum += d.kernel(elapsed, d.amountMg);
  }
  return sum;
}

/**
 * Finest sub-grid spacing (hours) used to refine the peak of a linear curve —
 * 0.5 min, fine enough to resolve a ~1-min-absorption pulmonary peak.
 */
const PEAK_REFINE_STEP_HOURS = 0.5 / 60;
/** Hard cap on peak-refinement sample points (absolute), regardless of window. */
const MAX_PEAK_REFINE_SAMPLES = 20_000;
/**
 * Cap on TOTAL peak-refinement dose-kernel evaluations (sample points × doses).
 * The grid-based compute budget (MAX_SIM_CELLS) charges gridPoints × doses × draws
 * but NOT this off-grid scan, so a scenario with a sparse grid and very many doses
 * could pass the budget yet drive billions of extra `curveAt` evaluations here. The
 * sample count is throttled so the scan never exceeds this bound regardless of dose
 * count — comfortably below MAX_SIM_CELLS, so refinement never dominates a run that
 * already passed the budget.
 */
const MAX_PEAK_REFINE_EVALS = 2_000_000;
/**
 * Minimum `curveAt` count for a useful bounded refinement — the worst case of the
 * SMALLEST schedule (one refined dose): its analytic-peak probe (1) + a 2-point
 * window sampled inclusively (`pts + 1` = 3) + the grid-argmax bracket sampled
 * inclusively (3) → 7 samples (see {@link peakRefineSchedule}). If the eval budget
 * cannot afford even this (too many doses), the scenario is rejected rather than
 * run an unbounded `≥ 7 × doses` scan the combined compute budget never charged for.
 */
const MIN_PEAK_REFINE_SCAN = 7;
/**
 * Target sample count for the final grid-argmax bracket — the ONLY scanner that
 * covers a between-dose superposition peak among UNREFINED doses. It gets a
 * dedicated share of the budget (never the per-dose `ptsPer`, which shrinks
 * toward 2 as doses compete) so that peak is not under-resolved when the dose
 * count throttles refinement. Capped at half the budget so per-dose windows and
 * the probes still run; a few hundred points resolve any realistic in-window
 * superposition.
 */
const BRACKET_TARGET_PTS = 512;

/**
 * The engine's compute guardrails and robustness thresholds, as one exported record.
 *
 * These are the numbers that decide whether a scenario runs at all and when a run is
 * downgraded to `not-robust`, so a reviewer auditing the simulator has to be able to read
 * them off the engine rather than off a document that transcribed them once. The mechanics
 * page (`/modeling/how-it-works`) renders this record directly; changing a constant above
 * changes the published page in the same commit.
 *
 * Declared HERE, below every constant it names, rather than beside the first of them: the
 * object literal is evaluated at module load, so a member referencing a `const` declared
 * further down would hit the temporal dead zone. Adding a guardrail means adding it above
 * this record, not below it.
 */
export const ENGINE_LIMITS = {
  /** Hard cap on output-grid points in one run. */
  maxGridPoints: MAX_GRID_POINTS,
  /** Hard cap on Monte-Carlo draws in one run. */
  maxDraws: MAX_DRAWS,
  /** Hard cap on grid points x doses x draws x emitted analyte series. */
  maxSimCells: MAX_SIM_CELLS,
  /** Hard cap on (integration span / step) x draws x retained doses for the ODE families. */
  maxOdeWork: MAX_ODE_WORK,
  /** Hard cap on doses retained in one ODE run. */
  maxOdeDoses: MAX_ODE_DOSES,
  /** Below this fraction of surviving draws the run is reported `not-robust`. */
  notRobustSurvivingDrawRatio: NOT_ROBUST_RATIO,
  /** Subjects lighter than this are refused rather than extrapolated. */
  minSubjectWeightKg: MIN_WEIGHT_KG,
  /** Finest sub-grid spacing the closed-form peak refinement resolves, in hours. */
  peakRefineStepHours: PEAK_REFINE_STEP_HOURS,
  /** Hard cap on peak-refinement sample points, whatever the window. */
  maxPeakRefineSamples: MAX_PEAK_REFINE_SAMPLES,
  /** Hard cap on peak-refinement dose-kernel evaluations (sample points x doses). */
  maxPeakRefineEvals: MAX_PEAK_REFINE_EVALS,
  /**
   * Fewest evaluations a useful bounded refinement needs. A scenario with too many doses
   * to afford even this is REJECTED rather than scanned unbounded — so this is a run-
   * bounding number, not just a tuning constant.
   */
  minPeakRefineScan: MIN_PEAK_REFINE_SCAN,
} as const;


/** One dose's inputs for dose-anchored peak refinement. */
export interface PeakRefineDose {
  tHours: number;
  amountMg: number;
  /** Absorption rate; null for a family with no absorption phase (IV). */
  ka: number | null;
  /** Elimination rate constant (1/h). */
  ke: number;
  /** >0 for a constant-rate IV infusion (peaks at the endpoint), else 0 (bolus). */
  infusionDurationHours: number;
  /** Absorption lag time (h), SC-4A; the whole first-order profile is shifted later by it. */
  lagHours: number;
}

/**
 * Budget-safe refinement schedule: how many doses to refine (`refinedDoses`),
 * how many points per per-dose window (`ptsPer`), and how many points the final
 * grid-argmax bracket gets (`bracketPts`) — sized so the WORST-CASE `curveAt`
 * count fits in `pointBudget`.
 *
 * The refinement loop spends, per refined dose, ONE analytic-peak probe plus an
 * inclusive `scanWindow` of `ptsPer + 1` points (the loop is `j <= pts`, so it
 * samples both endpoints); the final grid-argmax bracket adds one more inclusive
 * window of `bracketPts + 1`. The worst-case count is therefore
 *
 *     refinedDoses · (1 probe + (ptsPer + 1)) + (bracketPts + 1)
 *
 * which must not exceed `pointBudget` — each `curveAt` is O(doses) and the grid
 * compute budget never charged for this off-grid scan. An earlier version sized
 * `ptsPer` as `pointBudget / (refinedDoses + 1)` and ignored both the probes and
 * the inclusive `+1`, letting the real count overshoot by ~`2·refinedDoses`; it
 * also tied the bracket to `ptsPer`, so maximizing `refinedDoses` collapsed the
 * bracket to 2 points and could UNDER-report a between-dose superposition peak
 * (the bracket is the only scanner covering unrefined doses). The bracket now
 * gets a dedicated share.
 *
 * Precondition: `pointBudget >= MIN_PEAK_REFINE_SCAN` (7), the worst case of the
 * smallest schedule (1 dose, 2-point windows and bracket). The caller rejects a
 * scenario whose budget is below that, so the schedule always satisfies the bound.
 */
export function peakRefineSchedule(
  pointBudget: number,
  candidateCount: number,
): { refinedDoses: number; ptsPer: number; bracketPts: number } {
  // Dedicated, generous bracket share (never more than half the budget, so the
  // per-dose windows still run). Floored at 2, capped at BRACKET_TARGET_PTS.
  const bracketPts = Math.max(
    2,
    Math.min(BRACKET_TARGET_PTS, Math.floor(pointBudget / 2) - 1),
  );
  const perDoseBudget = pointBudget - (bracketPts + 1);
  // Cap refined doses so even a minimum 2-point (→ 3 inclusive) window + probe
  // per dose fits: each costs `ptsPer + 2` ≥ 4, so R ≤ perDoseBudget / 4.
  const refinedDoses = Math.max(
    1,
    Math.min(candidateCount, Math.floor(perDoseBudget / 4)),
  );
  // Largest ptsPer with R · (ptsPer + 2) ≤ perDoseBudget. Floored at 2, which the
  // R cap above keeps within budget.
  const ptsPer = Math.max(2, Math.floor(perDoseBudget / refinedDoses) - 2);
  return { refinedDoses, ptsPer, bracketPts };
}

/**
 * Refine the peak of a linear (closed-form) curve off the output grid by scanning
 * bounded fine intervals AROUND DOSE EVENTS — where a one-compartment curve's local
 * maxima live — plus a bracket around the grid argmax (to catch a superposition peak
 * sitting BETWEEN doses). This stays dense near every absorption peak even for a
 * long, sparsely-sampled window; a uniform whole-window scan would coarsen back into
 * the very output-grid defect this exists to fix (a lone dose far out in a huge
 * window would be sampled only every half-hour).
 *
 * Work is bounded: each `curveAt` is O(doses), so the total sample count is capped
 * at `MAX_PEAK_REFINE_EVALS / doses` (and `MAX_PEAK_REFINE_SAMPLES`). The schedule
 * ({@link peakRefineSchedule}) reserves the per-dose analytic-peak probe AND the
 * inclusive `scanWindow` endpoints, so the worst-case `curveAt` count stays within
 * that budget (not ~1.5× it). When there are more doses than the budget can refine,
 * the largest-amount doses (the biggest Cmax contributors) are refined first and
 * `refinedDoses < totalDoses` is reported so the caller surfaces a limitation rather
 * than silently under-refining. A bounded scan around the largest dose ALWAYS runs
 * (refinedDoses is floored at 1, ptsPer at 2), so the between-sample overflow check
 * is never skipped even for an under-refinable scenario.
 *
 * Seeded from the grid scan (peak never decreases). `overflow` flags a non-finite
 * value found between samples (→ structured numerical-failure, not an ok Infinity).
 * Deterministic: a fixed candidate set → identical peak on V8/Hermes.
 */
export function refineLinearPeak(
  resolvedAll: ResolvedDose[],
  dosesAll: PeakRefineDose[],
  gridStartHours: number,
  gridEndHours: number,
  stepHours: number,
  seedConc: number,
  seedT: number,
): {
  concentration: number;
  tHours: number;
  overflow: boolean;
  unresolvableOrigin: boolean;
  tooManyDoses: boolean;
  refinedDoses: number;
  totalDoses: number;
} {
  let bestC = seedConc;
  let bestT = seedT;
  let overflow = false;
  // Keep only doses that can contribute IN-WINDOW: absorption ONSET (`tHours + lag`;
  // lag 0 for IV / unlagged) at or before the window end. A dose whose onset is past
  // `gridEndHours` is identically 0 across the whole window, so it belongs in NEITHER
  // the `curveAt` sum (its per-scan cost is pure waste), the candidate set, nor the
  // `O(doses)` budget denominator `D` — a fleet of such doses must not collapse the
  // refinement resolution or trip `tooManyDoses` for peaks that need no work. Filtering
  // the resolved kernels and the peak-dose records together keeps them index-parallel.
  // (For an unlagged dose onset === tHours, and no fixture has a post-window dose, so
  // this is a no-op for every existing scenario — zero parity drift.)
  const keepIdx: number[] = [];
  for (let i = 0; i < dosesAll.length; i++) {
    if (dosesAll[i]!.tHours + dosesAll[i]!.lagHours <= gridEndHours) keepIdx.push(i);
  }
  const resolved =
    keepIdx.length === resolvedAll.length ? resolvedAll : keepIdx.map((i) => resolvedAll[i]!);
  const doses =
    keepIdx.length === dosesAll.length ? dosesAll : keepIdx.map((i) => dosesAll[i]!);
  const D = doses.length;
  if (D === 0 || gridEndHours <= gridStartHours) {
    return {
      concentration: bestC,
      tHours: bestT,
      overflow: false,
      unresolvableOrigin: false,
      tooManyDoses: false,
      refinedDoses: 0,
      totalDoses: D,
    };
  }
  const reject = (
    field: 'unresolvableOrigin' | 'tooManyDoses',
  ): ReturnType<typeof refineLinearPeak> => ({
    concentration: bestC,
    tHours: bestT,
    overflow: false,
    unresolvableOrigin: field === 'unresolvableOrigin',
    tooManyDoses: field === 'tooManyDoses',
    refinedDoses: 0,
    totalDoses: 0,
  });

  // Time of a dose's local peak, from its dynamics (NOT the output step, so an
  // arbitrarily coarse grid can't widen/coarsen the scan):
  //   - first-order absorption: analytic t_max = tlag + ln(ka/ke)/(ka-ke);
  //   - IV constant-rate infusion (ka null, duration>0): the infusion endpoint;
  //   - IV bolus (ka null, no duration): the administration time.
  // The absorption offset(s) of a dose's local peak(s) FROM ITS DYNAMICS ALONE (no
  // lag) — the width the fine refinement window must resolve, since a sharp peak needs
  // sub-step spacing regardless of how far a lag pushes it out:
  //   - first-order absorption (ka>0, ka≠ke): analytic t_max = ln(ka/ke)/(ka−ke);
  //   - zero-order / IV constant-rate input (duration>0): the input endpoint;
  //   - IV bolus (ka null, no duration) / degenerate ka≈ke: 0 (administration instant).
  // A MIXED route (SC-4A: ka>0 AND a zero-order duration>0) has BOTH a first-order peak
  // AND a zero-order endpoint corner, so it yields TWO candidate offsets — the refiner
  // MUST probe each, or a coarse output grid can step over the narrow zero-order corner
  // (the grid-argmax bracket only reaches it when that corner is the GLOBAL max) and
  // materially under-report Cmax. Every NON-mixed family returns exactly ONE offset,
  // identical to the previous single-offset behaviour — so their refinement, and the
  // golden parity, are unchanged.
  const firstOrderOffset = (m: PeakRefineDose): number | null => {
    if (!m.ka || m.ka <= 0) return null; // no first-order pathway (IV / pure zero-order)
    // Match `concentrationOralFirstOrder`'s own branch: at ka ≈ ke it uses the analytic
    // limit C ∝ ke·t·e^(−ke·t), whose peak is at t = 1/ke — NOT at administration.
    // The standard ln(ka/ke)/(ka−ke) would divide by ~0 there; its continuous limit as
    // ka→ke is exactly 1/ke, so this agrees with the standard form away from equality
    // and stays correct AT it (a mixed dose with ka===ke would otherwise drop its
    // first-order peak and under-report Cmax).
    if (Math.abs(m.ka - m.ke) < 1e-9 * Math.max(m.ka, m.ke)) return 1 / m.ke;
    return Math.log(m.ka / m.ke) / (m.ka - m.ke);
  };
  const absorptionOffsets = (m: PeakRefineDose): number[] => {
    const offs: number[] = [];
    const fo = firstOrderOffset(m);
    if (fo !== null && fo > 0) offs.push(fo);
    if (m.infusionDurationHours > 0) offs.push(m.infusionDurationHours);
    if (offs.length === 0) offs.push(0); // IV bolus / degenerate → administration instant
    return offs;
  };

  // One candidate peak location: a dose index plus ONE of its absorption offsets. A
  // mixed dose contributes two candidates (first-order t_max and zero-order endpoint);
  // every other dose contributes one. The lag (SC-4A) shifts WHERE the peak sits, never
  // how WIDE the window is (that is `absOff`), so a large lag can't dilute the samples.
  type PeakCandidate = { i: number; absOff: number };

  // Build in-window candidates AND validate every contributing peak's time resolution
  // UP FRONT — before contribution ranking or budget truncation could drop an
  // unresolvable one (whose collapsed window makes its ranked contribution read 0) and
  // let it escape rejection. Every dose here already contributes in-window (onset-past-
  // window doses were filtered out above).
  const candidates: PeakCandidate[] = [];
  for (let i = 0; i < D; i++) {
    const m = doses[i]!;
    for (const absOff of absorptionOffsets(m)) {
      const off = m.lagHours + absOff;
      // A peak needs sub-step resolution only if it falls INSIDE the window. If the dose
      // sits at an absolute time so large that its refinement width vanishes into the
      // floating-point ULP (`tPeak + w === tPeak`), that peak cannot be resolved at this
      // origin → reject (keyed off the actual PEAK LOCATION `tPeak`, where the fine
      // samples land). Exemptions: an offset of 0 (IV bolus) peaks at the representable
      // administration instant; and a peak OUTSIDE the window contributes only via its
      // tail, whose in-window maximum sits at a representable window boundary — so a
      // fully-decayed pre-window dose at a huge historical origin must not reject.
      if (off > 0) {
        const tPeak = m.tHours + off;
        if (
          tPeak >= gridStartHours &&
          tPeak <= gridEndHours &&
          tPeak + Math.max(4 * absOff, PEAK_REFINE_STEP_HOURS) === tPeak
        ) {
          return reject('unresolvableOrigin');
        }
      }
      candidates.push({ i, absOff });
    }
  }
  const C = candidates.length;
  if (C === 0) {
    return {
      concentration: bestC,
      tHours: bestT,
      overflow: false,
      unresolvableOrigin: false,
      tooManyDoses: false,
      refinedDoses: 0,
      totalDoses: 0,
    };
  }
  // Sample points affordable within the eval budget. Each scan point is a `curveAt`
  // (O(doses)) AND the candidate-ranking pass below spends one `candInWindowMax` kernel
  // evaluation per candidate (C total) — RESERVE those so the combined dose-kernel
  // work (ranking + scan) stays within MAX_PEAK_REFINE_EVALS, not just the scan.
  const affordable = Math.floor((MAX_PEAK_REFINE_EVALS - C) / D);
  // Too many doses to afford even a minimal bounded scan within the eval budget →
  // reject (structured non-result) rather than run `≥ 7 × doses` evaluations the
  // combined compute budget never charged for.
  if (affordable < MIN_PEAK_REFINE_SCAN) {
    return reject('tooManyDoses');
  }
  const pointBudget = Math.min(MAX_PEAK_REFINE_SAMPLES, affordable);

  const clampToWindow = (t: number): number =>
    t < gridStartHours ? gridStartHours : t > gridEndHours ? gridEndHours : t;
  const scan = (t: number): boolean => {
    const c = curveAt(resolved, t);
    if (!Number.isFinite(c)) {
      // Overflow BETWEEN output samples: a non-finite concentration is a structured
      // numerical-failure, not an ok result carrying Infinity/NaN.
      overflow = true;
      return false;
    }
    if (c > bestC) {
      bestC = c;
      bestT = t;
    }
    return true;
  };
  const scanWindow = (rawT0: number, rawT1: number, pts: number): boolean => {
    // Clamp both endpoints to the finite requested window BEFORE computing the span,
    // so a huge stepHours (a bracket like [-1e308, 1e308]) can't make the span
    // Infinity and turn `Infinity * 0` into a spurious NaN "overflow".
    const t0 = clampToWindow(rawT0);
    const t1 = clampToWindow(rawT1);
    const span = t1 - t0;
    if (span <= 0) return scan(t0);
    for (let j = 0; j <= pts; j++) {
      if (!scan(t0 + (span * j) / pts)) return false;
    }
    return true;
  };

  // Each dose's STANDALONE maximum concentration WITHIN the window (its own kernel
  // at its in-window peak time, clamped) — an O(1) proxy that ignores a fully
  // decayed pre-window dose (large amount, ~0 in-window contribution).
  const candPeakTime = (c: PeakCandidate): number =>
    clampToWindow(doses[c.i]!.tHours + doses[c.i]!.lagHours + c.absOff);
  const candInWindowMax = (c: PeakCandidate): number => {
    const m = doses[c.i]!;
    const elapsed = candPeakTime(c) - m.tHours;
    return elapsed >= 0 ? resolved[c.i]!.kernel(elapsed, m.amountMg) : 0;
  };
  // Group candidates into CO-LOCATED CLUSTERS (doses sharing an in-window peak
  // time superpose there) and refine ONE representative per cluster. A second
  // member of the same cluster is redundant — its window already sums the whole
  // cluster via `curveAt` — and refining it would starve OTHER clusters of slots,
  // leaving their superposition peaks to the argmax bracket alone. Rank clusters
  // by their combined standalone contribution so the largest superposition peaks
  // are refined first, and use the CLUSTER count (not the raw dose count) as the
  // refinable population — so e.g. 400 doses at 0 h and 390 at 1 h are two slots,
  // not 790 identical rescans of one window that never reach the second peak.
  // One `candInWindowMax` kernel evaluation per candidate (C total, reserved in the
  // budget above); the representative's own weight is cached so a collision never
  // re-evaluates it. A mixed dose's two candidates land in DIFFERENT clusters (distinct
  // peak times), so both its pathway peaks compete for a refinement slot.
  const clusters = new Map<
    number,
    { rep: PeakCandidate; repWeight: number; weight: number }
  >();
  for (const c of candidates) {
    const key = candPeakTime(c);
    const w = candInWindowMax(c);
    const existing = clusters.get(key);
    if (existing) {
      existing.weight += w;
      // Deterministic representative: the largest standalone member (a tie keeps
      // the earlier candidate) — identical choice on V8 and Hermes.
      if (w > existing.repWeight) {
        existing.rep = c;
        existing.repWeight = w;
      }
    } else {
      clusters.set(key, { rep: c, repWeight: w, weight: w });
    }
  }
  const rankedClusters = [...clusters.values()].sort((a, b) => b.weight - a.weight);
  const clusterCount = rankedClusters.length;
  const { refinedDoses, ptsPer, bracketPts } = peakRefineSchedule(
    pointBudget,
    clusterCount,
  );
  for (let k = 0; k < refinedDoses; k++) {
    const rep = rankedClusters[k]!.rep;
    const m = doses[rep.i]!;
    // The fine window sits AT the lag time and is sized from the absorption dynamics,
    // NOT from the lag: `windowStart = tHours + lag`, width `4·absOff`. This keeps the
    // samples dense around the real peak instead of diluting them across a long flat
    // pre-absorption interval when `tlag` is large (unlagged doses are unchanged — lag
    // 0, so windowStart === tHours). `absOff` is THIS candidate's offset (a mixed dose's
    // first-order t_max or its zero-order endpoint), so each pathway peak is sized and
    // probed on its own dynamics.
    const absOff = rep.absOff;
    const windowStart = m.tHours + m.lagHours;
    const w = Math.max(4 * absOff, PEAK_REFINE_STEP_HOURS);
    // ALWAYS sample the analytic peak time itself (clamped into the window) first — a
    // small point budget thins the window scan enough to straddle the peak, which would
    // miss both the true Cmax and an overflow occurring exactly there. `windowStart +
    // absOff` is the lag-shifted peak (first-order t_max OR the zero-order corner).
    if (!scan(clampToWindow(windowStart + absOff))) break;
    if (!scanWindow(windowStart, windowStart + w, ptsPer)) break;
  }
  // Bracket around the grid argmax — catches a superposition peak sitting BETWEEN
  // doses (near no single dose's own peak). Gets its own generous point budget so
  // it stays well-resolved even when many doses throttle the per-dose windows.
  if (!overflow) scanWindow(seedT - stepHours, seedT + stepHours, bracketPts);

  return {
    concentration: bestC,
    tHours: Number(bestT.toFixed(9)),
    overflow,
    unresolvableOrigin: false,
    tooManyDoses: false,
    refinedDoses,
    // The refinable population is the number of DISTINCT co-located peak clusters,
    // not the raw candidate count — refining one member per cluster covers its
    // whole superposition. `refinedDoses < totalDoses` then means some distinct
    // peak location went unrefined (the honest under-refinement signal).
    totalDoses: clusterCount,
  };
}

/** Central value (rng absent) or one seeded sample (rng present) of a spec. */
function pick(spec: ParamSpec, rng: PRNG | undefined): number {
  return rng ? sampleParam(spec, rng) : centralValue(spec);
}

/**
 * Resolve one route's params (deterministic central when `rng` is undefined, or
 * one seeded Monte-Carlo draw when present) into a single-dose kernel. Dispatches
 * on the model family. The DRAW ORDER per family is fixed and must never change —
 * it defines the seeded-parity contract (the golden PRNG stream).
 *
 * Exported so the closed-form families' resolution (kernel + resolved summary) can
 * be asserted directly in tests without routing a fixture model through the whole
 * registry-bound `simulateScenario` path.
 */
export function resolveRouteKernel(
  route: RouteId,
  params: RouteModelParams,
  scaleKg: number,
  rng: PRNG | undefined,
  /**
   * Deterministic per-parameter covariate factors (SC-2A), applied to `CL`/`Vc`/`ka`
   * AFTER the seeded draw so they never perturb the parity-locked PRNG stream. Only
   * the `one-compartment-clv` family reads them; other families ignore them. Empty
   * (the default) means no covariate individualisation.
   */
  covariateFactors: Partial<Record<CovariateTargetParameter, number>> = {},
): ResolvedRoute {
  switch (params.family) {
    case 'one-compartment-first-order': {
      // Draw order: ka, elimination t½, Vd/kg, F (unchanged from v0.1), then the
      // optional absorption lag (SC-4A) — drawn ONLY when the model declares one, so
      // a model without a lag keeps the identical PRNG stream.
      const ka = pick(params.kaPerHour, rng);
      const halfLife = pick(params.eliminationHalfLifeHours, rng);
      const vdLiters = pick(params.vdLitersPerKg, rng) * scaleKg;
      const f = pick(params.bioavailability, rng);
      const lag = params.absorptionLagHours ? pick(params.absorptionLagHours, rng) : 0;
      const ke = eliminationConstant(halfLife);
      const valid = isPhysical(ka, ke, vdLiters, f) && Number.isFinite(lag) && lag >= 0;
      return {
        valid,
        // `concentrationOralFirstOrder` returns 0 for a negative time, so shifting the
        // elapsed time by the lag yields 0 before `tlag` and the ordinary profile after.
        kernel: (elapsed, amountMg) =>
          concentrationOralFirstOrder(amountMg, vdLiters, f, ka, ke, elapsed - lag),
        summary: {
          route,
          family: params.family,
          kaPerHour: ka,
          eliminationHalfLifeHours: halfLife,
          vdLiters,
          bioavailability: f,
          ...(params.absorptionLagHours ? { absorptionLagHours: lag } : {}),
        },
      };
    }
    case 'one-compartment-clv': {
      // Structural CL/Vc parameterisation (SC-1A). Draw order: ka, CL, Vc, then F
      // only for an ABSOLUTE basis (an apparent-extravascular route has no separate
      // F to draw — it is folded into Vc/F). This order is the family's parity
      // contract; changing it re-defines the golden PRNG stream. Model-declared
      // covariate factors (SC-2A) scale ka/CL/Vc AFTER the draw — deterministic, so
      // the draw order and PRNG stream are untouched.
      const ka = pick(params.kaPerHour, rng) * (covariateFactors.ka ?? 1);
      const clVal = pick(params.clearance.spec, rng) * (covariateFactors.CL ?? 1);
      const vVal = pick(params.volume.spec, rng) * (covariateFactors.Vc ?? 1);
      const apparent = isApparentBasis(params.clearance.basis);
      // Apparent: F folded into Vc/F, so the kernel bioavailability is 1 and the
      // amplitude is Dose/(Vc/F). Absolute: a real, separately-identified F scales
      // the fraction absorbed (F·Dose/Vc).
      const f = apparent
        ? 1
        : params.bioavailability
          ? pick(params.bioavailability, rng)
          : NaN;
      // Optional absorption lag (SC-4A), drawn AFTER F and only when declared, so a
      // model without a lag keeps the identical PRNG stream. Not covariate-scaled
      // (SC-2A targets CL/Vc/ka only).
      const lag = params.absorptionLagHours ? pick(params.absorptionLagHours, rng) : 0;
      // Reject an incoherent authored disposition BEFORE trusting a single basis to
      // decide the whole calculation: a swapped/foreign id, a non-primitive basis, or
      // a mixed absolute/apparent CL·V pair would divide to a finite curve but report
      // contradictory identities. The bioavailability presence rule is part of
      // coherence too — an apparent basis folds F into Vc/F (so a separate F is a
      // contradiction), while an absolute basis needs a real F to set the amplitude.
      // Guarding here keeps this a STRUCTURED non-result and means the throw-on-
      // incoherence precondition inside resolveClvDisposition (which protects direct
      // package consumers) is never reached on the engine path.
      const coherent =
        isCoherentClvDisposition(params.clearance, params.volume) &&
        (apparent
          ? params.bioavailability === undefined
          : params.bioavailability !== undefined);
      if (!coherent) {
        return {
          valid: false,
          kernel: () => NaN,
          summary: {
            route,
            family: params.family,
            kaPerHour: ka,
            eliminationHalfLifeHours: NaN,
            vdLiters: NaN,
            bioavailability: apparent ? null : f,
          },
        };
      }
      const disp = resolveClvDisposition(
        params.clearance,
        params.volume,
        clVal,
        vVal,
      );
      const vd = disp.scalingVolumeLiters; // absolute Vc, or apparent Vc/F (both L)
      const ke = disp.eliminationRatePerHour;
      const valid = isPhysical(ka, ke, vd, f) && Number.isFinite(lag) && lag >= 0;
      return {
        valid,
        kernel: (elapsed, amountMg) =>
          concentrationOralFirstOrder(amountMg, vd, f, ka, ke, elapsed - lag),
        summary: {
          route,
          family: params.family,
          kaPerHour: ka,
          // Half-life is DERIVED from CL/Vc, not an independent primitive. Reporting
          // it as ln2/ke keeps peak refinement (which reconstructs ke via
          // eliminationConstant(t½)) exact for this family.
          eliminationHalfLifeHours: disp.halfLifeHours,
          vdLiters: vd,
          // F is null when it is not separately identified (apparent basis).
          bioavailability: apparent ? null : f,
          ...(params.absorptionLagHours ? { absorptionLagHours: lag } : {}),
          structural: {
            clearance: disp.clearance,
            volume: disp.volume,
            eliminationRatePerHour: ke,
          },
        },
      };
    }
    case 'iv-one-compartment': {
      // No absorption, F = 1 by definition. Draw order: elimination t½, Vd/kg.
      const halfLife = pick(params.eliminationHalfLifeHours, rng);
      const vdLiters = pick(params.vdLitersPerKg, rng) * scaleKg;
      const ke = eliminationConstant(halfLife);
      const duration = params.infusionDurationHours;
      const infusing = typeof duration === 'number' && duration > 0;
      const valid =
        Number.isFinite(ke) && ke > 0 && Number.isFinite(vdLiters) && vdLiters > 0 &&
        (!infusing || Number.isFinite(duration));
      return {
        valid,
        kernel: (elapsed, amountMg) =>
          infusing
            ? concentrationInfusion(amountMg, vdLiters, ke, duration as number, elapsed)
            : concentrationFromDoseIV(amountMg, vdLiters, ke, elapsed),
        summary: {
          route,
          family: params.family,
          kaPerHour: null,
          eliminationHalfLifeHours: halfLife,
          vdLiters,
          bioavailability: null,
          // 0 for a bolus, the duration for a constant-rate infusion — so the two
          // IV kernels are distinguishable from the result alone.
          infusionDurationHours: infusing ? (duration as number) : 0,
        },
      };
    }
    case 'one-compartment-zero-order': {
      // Zero-order (constant-rate) extravascular input over a finite duration (SC-4A).
      // Draw order: zero-order duration, elimination t½, Vd/kg, F, then the optional
      // lag (drawn ONLY when declared, so an unlagged model keeps the identical PRNG
      // stream). This order is the family's parity contract.
      const duration = pick(params.zeroOrderDurationHours, rng);
      const halfLife = pick(params.eliminationHalfLifeHours, rng);
      const vdLiters = pick(params.vdLitersPerKg, rng) * scaleKg;
      const f = pick(params.bioavailability, rng);
      const lag = params.absorptionLagHours ? pick(params.absorptionLagHours, rng) : 0;
      const ke = eliminationConstant(halfLife);
      // ke/Vd/F physical; a POSITIVE input duration (a zero-order route with D≤0 is a
      // bolus, which belongs to a different family, so reject rather than silently
      // collapse); lag finite ≥ 0.
      const valid =
        Number.isFinite(ke) && ke > 0 &&
        Number.isFinite(vdLiters) && vdLiters > 0 &&
        Number.isFinite(f) && f > 0 && f <= 1 &&
        Number.isFinite(duration) && duration > 0 &&
        Number.isFinite(lag) && lag >= 0;
      return {
        valid,
        // `F·Dose` is the amount reaching the central compartment; the infusion kernel
        // delivers it at a constant rate over `duration`, and shifting elapsed by the
        // lag yields C=0 before tlag and the ordinary constant-rate profile after.
        kernel: (elapsed, amountMg) =>
          concentrationInfusion(f * amountMg, vdLiters, ke, duration, elapsed - lag),
        summary: {
          route,
          family: params.family,
          kaPerHour: null, // rate-controlled input, no first-order absorption phase
          eliminationHalfLifeHours: halfLife,
          vdLiters,
          bioavailability: f,
          // The zero-order input duration is reported under the generic constant-rate
          // input field, so the peak refiner (which peaks a rate-controlled input at its
          // endpoint) and any consumer read it the same way they do an IV infusion.
          infusionDurationHours: duration,
          ...(params.absorptionLagHours ? { absorptionLagHours: lag } : {}),
        },
      };
    }
    case 'one-compartment-mixed-order': {
      // Parallel (mixed) input (SC-4A): a fraction `fr` of the absorbed dose enters
      // first-order (ka), the rest zero-order over `duration`, into one shared
      // disposition. Draw order: firstOrderFraction, ka, zero-order duration,
      // elimination t½, Vd/kg, F, then the optional lag (drawn ONLY when declared).
      // This order is the family's parity contract.
      const fr = pick(params.firstOrderFraction, rng);
      const ka = pick(params.kaPerHour, rng);
      const duration = pick(params.zeroOrderDurationHours, rng);
      const halfLife = pick(params.eliminationHalfLifeHours, rng);
      const vdLiters = pick(params.vdLitersPerKg, rng) * scaleKg;
      const f = pick(params.bioavailability, rng);
      const lag = params.absorptionLagHours ? pick(params.absorptionLagHours, rng) : 0;
      const ke = eliminationConstant(halfLife);
      // Both pathways are declared, so both must be physical (ka>0, duration>0) even at
      // a fraction extreme — a genuinely single-pathway product belongs to the dedicated
      // family. fr in [0,1]; ke/Vd/F physical; lag finite ≥ 0.
      const valid =
        Number.isFinite(fr) && fr >= 0 && fr <= 1 &&
        Number.isFinite(ka) && ka > 0 &&
        Number.isFinite(duration) && duration > 0 &&
        Number.isFinite(ke) && ke > 0 &&
        Number.isFinite(vdLiters) && vdLiters > 0 &&
        Number.isFinite(f) && f > 0 && f <= 1 &&
        Number.isFinite(lag) && lag >= 0;
      return {
        valid,
        // Linear superposition of the two pathways sharing one Vd/ke/F. The first-order
        // kernel applies F internally (absorbed = F·fr·Dose); the infusion kernel takes
        // the amount reaching central directly, so it gets F·(1−fr)·Dose. The lag shifts
        // BOTH pathways later (C=0 before tlag). BRANCH AROUND a zero-mass pathway at a
        // fraction extreme so the mixed curve genuinely collapses to the pure family:
        // `concentrationInfusion` forms `rate/(Vd·ke)`, which is 0/0 → NaN when a
        // dose of 0 meets an underflowed `Vd·ke` (tiny Vd, very long half-life) — pure
        // arithmetic that must not appear on the inactive pathway a pure route never runs.
        kernel: (elapsed, amountMg) => {
          const shifted = elapsed - lag;
          const foTerm =
            fr > 0 ? concentrationOralFirstOrder(fr * amountMg, vdLiters, f, ka, ke, shifted) : 0;
          const zoTerm =
            fr < 1
              ? concentrationInfusion(f * (1 - fr) * amountMg, vdLiters, ke, duration, shifted)
              : 0;
          return foTerm + zoTerm;
        },
        summary: {
          route,
          family: params.family,
          // Both pathways are reported: ka (first-order), the zero-order duration under
          // the generic constant-rate input field, and the split, so the mixed curve is
          // fully reconstructable from the result.
          kaPerHour: ka,
          eliminationHalfLifeHours: halfLife,
          vdLiters,
          bioavailability: f,
          infusionDurationHours: duration,
          firstOrderFraction: fr,
          ...(params.absorptionLagHours ? { absorptionLagHours: lag } : {}),
        },
      };
    }
    case 'two-compartment-first-order':
    case 'michaelis-menten':
    case 'parent-metabolite-first-order':
      // ODE-family routes are simulated by the whole-scenario ODE path, not by a
      // per-dose kernel; these branches are unreachable but keep the switch
      // exhaustive. Return invalid so any accidental use fails loudly.
      return {
        valid: false,
        kernel: () => NaN,
        summary: {
          route,
          family: params.family,
          kaPerHour: null,
          eliminationHalfLifeHours: NaN,
          vdLiters: NaN,
          bioavailability: null,
        },
      };
  }
}

/** Resolve one two-compartment route (central or one MC draw). */
function resolveTwoCompRoute(
  route: RouteId,
  params: TwoCompartmentRouteParams,
  scaleKg: number,
  rng: PRNG | undefined,
): { resolved: TwoCompartmentResolvedRoute; summary: ResolvedRouteSummary; valid: boolean } {
  const ka = pick(params.kaPerHour, rng);
  const halfLife = pick(params.eliminationHalfLifeHours, rng);
  const k12 = pick(params.k12PerHour, rng);
  const k21 = pick(params.k21PerHour, rng);
  const vdLiters = pick(params.vdLitersPerKg, rng) * scaleKg;
  const f = pick(params.bioavailability, rng);
  const beta = eliminationConstant(halfLife);
  const valid =
    [ka, beta, k12, k21, vdLiters, f].every((x) => Number.isFinite(x) && x > 0) && f <= 1;
  return {
    resolved: {
      kaPerHour: ka,
      betaPerHour: beta,
      k12PerHour: k12,
      k21PerHour: k21,
      vdLiters,
      bioavailability: f,
    },
    summary: {
      route,
      family: 'two-compartment-first-order',
      kaPerHour: ka,
      eliminationHalfLifeHours: halfLife,
      vdLiters,
      bioavailability: f,
      k12PerHour: k12,
      k21PerHour: k21,
    },
    valid,
  };
}

/** Resolve one Michaelis–Menten route (central or one MC draw). */
function resolveMmRoute(
  route: RouteId,
  params: MichaelisMentenRouteParams,
  scaleKg: number,
  rng: PRNG | undefined,
): { resolved: MichaelisMentenResolvedRoute; summary: ResolvedRouteSummary; valid: boolean } {
  // Draw order: ka, Vmax, Km, nominal t½, Vd/kg, F. Fixed for the parity contract.
  const ka = pick(params.kaPerHour, rng);
  const vmax = pick(params.vmaxMgPerLPerHour, rng);
  const km = pick(params.kmMgPerL, rng);
  const halfLife = pick(params.eliminationHalfLifeHours, rng);
  const vdLiters = pick(params.vdLitersPerKg, rng) * scaleKg;
  const f = pick(params.bioavailability, rng);
  // Km must be strictly positive: the derivative computes Vmax·C/(Km + C), so
  // Km = 0 gives 0/0 at the initial C = 0 and turns a valid dose into a spurious
  // numerical-failure. A real Michaelis constant is > 0 (Km = 0 would be pure
  // zero-order, which this saturable form does not represent at C = 0).
  const valid =
    [ka, vmax, km, vdLiters, f].every((x) => Number.isFinite(x) && x > 0) &&
    f <= 1;
  return {
    resolved: {
      kaPerHour: ka,
      vmaxMgPerLPerHour: vmax,
      kmMgPerL: km,
      vdLiters,
      bioavailability: f,
    },
    summary: {
      route,
      family: 'michaelis-menten',
      kaPerHour: ka,
      eliminationHalfLifeHours: halfLife,
      vdLiters,
      bioavailability: f,
      vmaxMgPerLPerHour: vmax,
      kmMgPerL: km,
    },
    valid,
  };
}

/**
 * Resolve one parent-metabolite route (central or one MC draw) into the model's
 * resolved-route params + a display summary. Exported so the resolution (parameter
 * draw, Vd scaling, half-life → ke, molar-mass stoichiometry) can be asserted directly
 * in tests without routing a fixture model through the registry-bound simulate path.
 * The DRAW ORDER is the family's parity contract and must never change: ka, F, parent
 * t½, parent Vd/kg, formationFraction, metabolite t½, metabolite Vd/kg.
 */
export function resolveParentMetaboliteRoute(
  route: RouteId,
  params: ParentMetaboliteRouteParams,
  scaleKg: number,
  rng: PRNG | undefined,
): {
  resolved: ParentMetaboliteResolvedRoute;
  summary: ResolvedRouteSummary;
  valid: boolean;
} {
  const ka = pick(params.kaPerHour, rng);
  const f = pick(params.bioavailability, rng);
  const parentHalfLife = pick(params.parentEliminationHalfLifeHours, rng);
  const parentVd = pick(params.parentVdLitersPerKg, rng) * scaleKg;
  const fm = pick(params.formationFraction, rng);
  const metHalfLife = pick(params.metaboliteEliminationHalfLifeHours, rng);
  const metVd = pick(params.metaboliteVdLitersPerKg, rng) * scaleKg;
  const keParent = eliminationConstant(parentHalfLife);
  const keMet = eliminationConstant(metHalfLife);
  const resolved: ParentMetaboliteResolvedRoute = {
    kaPerHour: ka,
    bioavailability: f,
    keParentPerHour: keParent,
    vdParentLiters: parentVd,
    formationFraction: fm,
    molarMassParent: params.parentMolarMass,
    molarMassMetabolite: params.metaboliteMolarMass,
    keMetabolitePerHour: keMet,
    vdMetaboliteLiters: metVd,
  };
  // ka/ke/Vd must be finite positive; F in (0,1]; fm in [0,1] (0 = no metabolite is a
  // valid, if unusual, model); molar masses finite positive.
  const valid =
    [ka, keParent, parentVd, keMet, metVd].every((x) => Number.isFinite(x) && x > 0) &&
    Number.isFinite(f) &&
    f > 0 &&
    f <= 1 &&
    Number.isFinite(fm) &&
    fm >= 0 &&
    fm <= 1 &&
    Number.isFinite(params.parentMolarMass) &&
    params.parentMolarMass > 0 &&
    Number.isFinite(params.metaboliteMolarMass) &&
    params.metaboliteMolarMass > 0;
  return {
    resolved,
    summary: {
      route,
      family: 'parent-metabolite-first-order',
      // Top-level summary describes the PARENT (the scenario's analyte).
      kaPerHour: ka,
      eliminationHalfLifeHours: parentHalfLife,
      vdLiters: parentVd,
      bioavailability: f,
      parentMetabolite: {
        metaboliteAnalyte: params.metaboliteAnalyte,
        formationFraction: fm,
        parentMolarMass: params.parentMolarMass,
        metaboliteMolarMass: params.metaboliteMolarMass,
        metaboliteEliminationHalfLifeHours: metHalfLife,
        metaboliteVdLiters: metVd,
      },
    },
    valid,
  };
}

type PmRun =
  | { ok: false; failure: FailureCode; detail: string }
  | {
      ok: true;
      parentMedians: number[];
      parentBands: CurvePoint[];
      metaboliteMedians: number[];
      metaboliteBands: CurvePoint[];
      status: 'ok' | 'not-robust';
      acceptedDraws: number | null;
    };

/**
 * Run the parent-metabolite family: resolve the central curves, then (if requested) a
 * seeded Monte-Carlo band — for BOTH the parent and the metabolite from ONE coupled
 * integration. Mirrors `runOdeFamily`'s median/MC/banding but tracks two output series
 * (the metabolite is a first-class analyte, not a derived scalar). A non-finite
 * integration is a structured failure / rejected draw, never a clamped zero.
 */
function runParentMetaboliteFamily(
  routesUsed: RouteId[],
  scenario: CanonicalScenario,
  routeParams: (route: RouteId) => ParentMetaboliteRouteParams,
  times: number[],
  stepHours: number,
  vdScaleKgByRoute: Map<RouteId, number>,
  centralByRoute: Map<RouteId, ResolvedRouteSummary>,
  limitations: Limitation[],
): PmRun {
  const resolve = (route: RouteId, rng: PRNG | undefined) =>
    resolveParentMetaboliteRoute(route, routeParams(route), vdScaleKgByRoute.get(route)!, rng);
  const toDoses = (
    byRoute: Map<RouteId, ParentMetaboliteResolvedRoute>,
  ): ParentMetaboliteDose[] =>
    scenario.doses.map((d) => ({
      tHours: d.tHours,
      amountMg: d.amountMg,
      route: byRoute.get(d.route)!,
    }));

  const centralRoutes = new Map<RouteId, ParentMetaboliteResolvedRoute>();
  for (const route of routesUsed) {
    const r = resolve(route, undefined);
    if (!r.valid) {
      return {
        ok: false,
        failure: 'numerical-failure',
        detail: `Central parameters for route "${route}" are non-physical.`,
      };
    }
    centralRoutes.set(route, r.resolved);
    centralByRoute.set(route, r.summary);
  }
  const central = parentMetaboliteCurve(toDoses(centralRoutes), times, stepHours);
  if (!central.ok) {
    return {
      ok: false,
      failure: 'numerical-failure',
      detail: 'Parent/metabolite integration produced a non-finite state.',
    };
  }
  const parentMedians = central.parent;
  const metaboliteMedians = central.metabolite;

  let status: 'ok' | 'not-robust' = 'ok';
  let acceptedDraws: number | null = null;
  let parentBands: CurvePoint[];
  let metaboliteBands: CurvePoint[];

  if (scenario.uncertainty) {
    const { seed, draws } = scenario.uncertainty;
    const rng = new PRNG(seed);
    const perTimeParent: number[][] = times.map(() => []);
    const perTimeMet: number[][] = times.map(() => []);
    let survived = 0;
    for (let i = 0; i < draws; i++) {
      const drawRoutes = new Map<RouteId, ParentMetaboliteResolvedRoute>();
      let drawOk = true;
      for (const route of routesUsed) {
        let r = resolve(route, rng);
        if (!r.valid) r = resolve(route, rng); // resample once
        if (!r.valid) {
          drawOk = false;
          break;
        }
        drawRoutes.set(route, r.resolved);
      }
      if (!drawOk) continue;
      const c = parentMetaboliteCurve(toDoses(drawRoutes), times, stepHours);
      if (!c.ok) continue; // a non-finite draw is rejected, not clamped
      survived++;
      for (let ti = 0; ti < times.length; ti++) {
        perTimeParent[ti]!.push(c.parent[ti]!);
        perTimeMet[ti]!.push(c.metabolite[ti]!);
      }
    }
    if (survived === 0) {
      return {
        ok: false,
        failure: 'numerical-failure',
        detail: 'No Monte-Carlo draws survived the physicality filter.',
      };
    }
    acceptedDraws = survived;
    if (survived / draws < NOT_ROBUST_RATIO) {
      status = 'not-robust';
      limitations.push({
        code: 'low-effective-draws',
        text: `Only ${survived}/${draws} draws were physical; uncertainty bands are unreliable.`,
        severity: 'warning',
      });
    } else if (survived < draws) {
      limitations.push({
        code: 'draws-rejected',
        text: `${draws - survived} of ${draws} draws were non-physical and excluded; ${survived} contributed to the bands.`,
        severity: 'info',
      });
    }
    const band = (medians: number[], perTime: number[][]): CurvePoint[] =>
      times.map((t, ti) => {
        const pct = computePercentiles(perTime[ti]!);
        return { tHours: t, median: medians[ti]!, p05: pct.p05, p25: pct.p25, p75: pct.p75, p95: pct.p95 };
      });
    parentBands = band(parentMedians, perTimeParent);
    metaboliteBands = band(metaboliteMedians, perTimeMet);
  } else {
    const flat = (medians: number[]): CurvePoint[] =>
      times.map((t, ti) => ({
        tHours: t,
        median: medians[ti]!,
        p05: medians[ti]!,
        p25: medians[ti]!,
        p75: medians[ti]!,
        p95: medians[ti]!,
      }));
    parentBands = flat(parentMedians);
    metaboliteBands = flat(metaboliteMedians);
  }
  return {
    ok: true,
    parentMedians,
    parentBands,
    metaboliteMedians,
    metaboliteBands,
    status,
    acceptedDraws,
  };
}

function isPhysical(ka: number, ke: number, vd: number, f: number): boolean {
  return (
    Number.isFinite(ka) &&
    ka > 0 &&
    Number.isFinite(ke) &&
    ke > 0 &&
    Number.isFinite(vd) &&
    vd > 0 &&
    Number.isFinite(f) &&
    f > 0 &&
    f <= 1
  );
}

/**
 * The ODE families integrate the WHOLE scenario at once (not per-dose kernel
 * superposition), so both share the same median + Monte-Carlo + banding plumbing;
 * only the per-route resolution and the integrator differ. `OdeFamilyOps` captures
 * that difference so `runOdeFamily` is written once and dispatched per family.
 */
interface OdeFamilyOps<R> {
  label: string;
  resolve(
    route: RouteId,
    scaleKg: number,
    rng: PRNG | undefined,
  ): { resolved: R; summary: ResolvedRouteSummary; valid: boolean };
  curve(
    doses: { tHours: number; amountMg: number; route: R }[],
    times: number[],
    stepHours: number,
  ): { ok: boolean; values: number[] };
}

type OdeRun =
  | { ok: false; failure: FailureCode; detail: string }
  | {
      ok: true;
      medians: number[];
      bands: CurvePoint[];
      status: 'ok' | 'not-robust';
      acceptedDraws: number | null;
    };

/**
 * Run one ODE family: resolve the central curve, then (if requested) a seeded
 * Monte-Carlo band. Fills `centralByRoute` with the resolved summaries and pushes
 * any robustness limitations. Identical control flow for every ODE family — the
 * family only supplies `resolve` + `curve`. A non-finite integration (central or a
 * draw) is a structured failure / rejected draw, never a clamped zero (plan §5.5).
 */
function runOdeFamily<R>(
  ops: OdeFamilyOps<R>,
  routesUsed: RouteId[],
  scenario: CanonicalScenario,
  times: number[],
  stepHours: number,
  vdScaleKgByRoute: Map<RouteId, number>,
  centralByRoute: Map<RouteId, ResolvedRouteSummary>,
  limitations: Limitation[],
): OdeRun {
  const toDoses = (
    byRoute: Map<RouteId, R>,
  ): { tHours: number; amountMg: number; route: R }[] =>
    scenario.doses.map((d) => ({
      tHours: d.tHours,
      amountMg: d.amountMg,
      route: byRoute.get(d.route)!,
    }));

  const centralRoutes = new Map<RouteId, R>();
  for (const route of routesUsed) {
    const r = ops.resolve(route, vdScaleKgByRoute.get(route)!, undefined);
    if (!r.valid) {
      return {
        ok: false,
        failure: 'numerical-failure',
        detail: `Central parameters for route "${route}" are non-physical.`,
      };
    }
    centralRoutes.set(route, r.resolved);
    centralByRoute.set(route, r.summary);
  }
  const centralCurve = ops.curve(toDoses(centralRoutes), times, stepHours);
  if (!centralCurve.ok) {
    return {
      ok: false,
      failure: 'numerical-failure',
      detail: `${ops.label} integration produced a non-finite state.`,
    };
  }
  const medians = centralCurve.values;

  let status: 'ok' | 'not-robust' = 'ok';
  let acceptedDraws: number | null = null;
  let bands: CurvePoint[];

  if (scenario.uncertainty) {
    const { seed, draws } = scenario.uncertainty;
    const rng = new PRNG(seed);
    const perTime: number[][] = times.map(() => []);
    let survived = 0;
    for (let i = 0; i < draws; i++) {
      const drawRoutes = new Map<RouteId, R>();
      let drawOk = true;
      for (const route of routesUsed) {
        const scaleKg = vdScaleKgByRoute.get(route)!;
        let r = ops.resolve(route, scaleKg, rng);
        if (!r.valid) r = ops.resolve(route, scaleKg, rng); // resample once
        if (!r.valid) {
          drawOk = false;
          break;
        }
        drawRoutes.set(route, r.resolved);
      }
      if (!drawOk) continue;
      const c = ops.curve(toDoses(drawRoutes), times, stepHours);
      if (!c.ok) continue; // a non-finite ODE draw is rejected, not clamped
      survived++;
      for (let ti = 0; ti < times.length; ti++) perTime[ti]!.push(c.values[ti]!);
    }
    if (survived === 0) {
      return {
        ok: false,
        failure: 'numerical-failure',
        detail: 'No Monte-Carlo draws survived the physicality filter.',
      };
    }
    acceptedDraws = survived;
    if (survived / draws < NOT_ROBUST_RATIO) {
      status = 'not-robust';
      limitations.push({
        code: 'low-effective-draws',
        text: `Only ${survived}/${draws} draws were physical; uncertainty bands are unreliable.`,
        severity: 'warning',
      });
    } else if (survived < draws) {
      limitations.push({
        code: 'draws-rejected',
        text: `${draws - survived} of ${draws} draws were non-physical and excluded; ${survived} contributed to the bands.`,
        severity: 'info',
      });
    }
    bands = times.map((t, ti) => {
      const pct = computePercentiles(perTime[ti]!);
      return { tHours: t, median: medians[ti]!, p05: pct.p05, p25: pct.p25, p75: pct.p75, p95: pct.p95 };
    });
  } else {
    bands = times.map((t, ti) => ({
      tHours: t,
      median: medians[ti]!,
      p05: medians[ti]!,
      p25: medians[ti]!,
      p75: medians[ti]!,
      p95: medians[ti]!,
    }));
  }
  return { ok: true, medians, bands, status, acceptedDraws };
}

/** Number of grid points for a (validated) time grid. */
function gridPointCount(startHours: number, endHours: number, stepHours: number): number {
  return Math.floor((endHours - startHours) / stepHours + 1e-9) + 1;
}

function gridTimes(scenario: CanonicalScenario): number[] {
  const { startHours, endHours, stepHours } = scenario.timeGrid;
  // Index-based so the loop always terminates even if floating-point spacing at a
  // large origin means `start + step === start` (accumulation would never advance).
  const n = gridPointCount(startHours, endHours, stepHours);
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    times.push(Number((startHours + i * stepHours).toFixed(9)));
  }
  return times;
}

/**
 * Decide how a requested observed matrix relates to a model's native matrix (SC-5A):
 *   - `native`      — no override, or the request equals the model's own matrix;
 *   - `transform`   — a different matrix the model DECLARES a reviewed conversion to;
 *   - `unsupported` — a different matrix with no declared (or a non-physical) transform.
 * Exported so the decision (and its refusal to silently cross matrices) can be asserted
 * directly, since no shipped model declares a transform yet (the reviewed conversion is
 * evidence-gated per analyte).
 */
export function selectMatrixTransform(
  model: Pick<DrugModelDefinition, 'matrix' | 'matrixTransforms' | 'analyte'>,
  requestedMatrix: Matrix | undefined,
  /**
   * The analyte to convert. Defaults to the model's primary analyte. A transform matches
   * an analyte when its `analyte` field (absent = the primary) equals this — so a
   * metabolite is only ever scaled by a transform declared for ITS analyte, never the
   * parent's.
   */
  targetAnalyte: string = model.analyte,
):
  | { kind: 'native' }
  | { kind: 'transform'; transform: MatrixTransform }
  | { kind: 'unsupported' } {
  if (requestedMatrix === undefined || requestedMatrix === model.matrix) {
    return { kind: 'native' };
  }
  const t = (model.matrixTransforms ?? []).find(
    (x) =>
      x.from === model.matrix &&
      x.to === requestedMatrix &&
      (x.analyte ?? model.analyte) === targetAnalyte,
  );
  if (!t || !Number.isFinite(t.ratio) || t.ratio <= 0) return { kind: 'unsupported' };
  return { kind: 'transform', transform: t };
}

/**
 * Scale one curve point by a matrix-transform ratio (SC-5A) — a deterministic linear
 * conversion, so every percentile scales by the same factor. Exported for direct testing.
 */
export function scaleCurvePointByRatio(p: CurvePoint, ratio: number): CurvePoint {
  return {
    tHours: p.tHours,
    median: p.median * ratio,
    p05: p.p05 * ratio,
    p25: p.p25 * ratio,
    p75: p.p75 * ratio,
    p95: p.p95 * ratio,
  };
}

// Standard-normal quantiles for the reported band percentiles (5/25/75/95).
const Z_P95 = 1.6448536269514722;
const Z_P75 = 0.6744897501960817;

/**
 * Compose independent observation residual-error layers (SC-5B) that apply to one analyte
 * into a single proportional CV and additive SD — independent variances add
 * (`√Σcv²`, `√Σsd²`). Returns null when no layer applies to the analyte (no widening).
 * A layer matches the analyte when its `analyte` (absent = the model's primary) equals it.
 * Throws on a non-physical layer (negative or non-finite cv/sd) so the caller can reject.
 */
export function composeObservationError(
  layers: ObservationErrorLayer[],
  targetAnalyte: string,
  primaryAnalyte: string,
): { propCv: number; addSd: number } | null {
  const applicable = layers.filter((l) => (l.analyte ?? primaryAnalyte) === targetAnalyte);
  if (applicable.length === 0) return null;
  let propVar = 0;
  let addVar = 0;
  for (const l of applicable) {
    const cv = l.proportionalCv ?? 0;
    const sd = l.additiveSd ?? 0;
    if (!Number.isFinite(cv) || cv < 0 || !Number.isFinite(sd) || sd < 0) {
      throw new Error(`non-physical observation-error layer "${l.layer}"`);
    }
    // A layer with NO positive component (both omitted or zero) widens nothing, so
    // recording it as "applied" would falsely claim the bands carry extra uncertainty.
    // A declared error layer must declare actual error — reject the empty one.
    if (cv === 0 && sd === 0) {
      throw new Error(`observation-error layer "${l.layer}" declares no error component`);
    }
    propVar += cv * cv;
    addVar += sd * sd;
  }
  // A finite component can still overflow when squared/summed (e.g. sd = 1e308 → Inf),
  // which would produce Infinity/NaN bands downstream. Reject a non-finite composed
  // variance as an authoring error rather than emit a non-finite curve.
  if (!Number.isFinite(propVar) || !Number.isFinite(addVar)) {
    throw new Error('observation-error variance overflowed');
  }
  return { propCv: Math.sqrt(propVar), addSd: Math.sqrt(addVar) };
}

/**
 * Widen one band point by an observation error (SC-5B). The observation SD at the point's
 * (central) concentration is `√((cv·median)² + sd²)`; it CONVOLVES with the underlying
 * parameter/variability spread (independent sources add in variance), leaving the median —
 * the deterministic central prediction — unchanged. Crucially the widening is centred on
 * the SAMPLED BAND'S OWN centre `(p05+p95)/2`, NOT on the reported median: `simulateScenario`
 * reports the deterministic central curve as `median` independently of the sampled
 * quantiles, so a band can sit entirely to one side of it — scaling each quantile's signed
 * distance from the median would then move observations the wrong way (e.g. push `p05` even
 * higher). When the point carries a spread (an MC run) the deviations FROM THE BAND CENTRE
 * are scaled by `√(1 + obsVar/paramVar)`, preserving the band's shape while widening it;
 * when it is flat (a deterministic run, so the centre equals the median) the band is rebuilt
 * symmetrically from the standard-normal quantiles. Concentrations are truncated at 0.
 * Assumes an approximately Gaussian residual — the standard PopPK residual-error model.
 */
export function widenBandForObservationError(
  p: CurvePoint,
  propCv: number,
  addSd: number,
): CurvePoint {
  if (propCv <= 0 && addSd <= 0) return p;
  const m = p.median;
  const nn = (x: number): number => (x < 0 ? 0 : x);
  // The sampled band's own centre — obs error convolves with the sampled distribution,
  // which sits here, not at the (separately-reported) deterministic median. The
  // proportional SD is scaled by THIS concentration too, not the deterministic median:
  // a band offset from the median (e.g. `median=0` with positive sampled quantiles) would
  // otherwise get zero proportional error. (A single centre concentration approximates the
  // per-quantile proportional scale; exact per-draw propagation is a follow-up.)
  const c = (p.p05 + p.p95) / 2;
  const obsVar = (propCv * c) ** 2 + addSd ** 2;
  const paramSd = (p.p95 - p.p05) / (2 * Z_P95);
  if (paramSd > 0) {
    const factor = Math.sqrt(1 + obsVar / (paramSd * paramSd));
    return {
      tHours: p.tHours,
      median: m,
      p05: nn(c + (p.p05 - c) * factor),
      p25: nn(c + (p.p25 - c) * factor),
      p75: nn(c + (p.p75 - c) * factor),
      p95: nn(c + (p.p95 - c) * factor),
    };
  }
  // Deterministic run (no parameter spread): a symmetric observation-error band around the
  // central prediction (here `c === m`, since the sampled band is flat at the median).
  const obsSd = Math.sqrt(obsVar);
  return {
    tHours: p.tHours,
    median: m,
    p05: nn(c - Z_P95 * obsSd),
    p25: nn(c - Z_P75 * obsSd),
    p75: nn(c + Z_P75 * obsSd),
    p95: nn(c + Z_P95 * obsSd),
  };
}

function baseManifest(
  scenario: CanonicalScenario,
  nowIso: string,
  modelId: string | null,
  matrix: Matrix | null,
): RunManifest {
  // Stamp the release this run RESOLVED THROUGH, not the reviewed-tier constant.
  // `resolveModel` below reads the flag-selected release, so with the derived tier
  // enabled a manifest carrying `REGISTRY_CHECKSUM` would name a release that does
  // not contain the model it just served — and checksum-based replay would fail for
  // exactly the curves whose provenance matters most.
  const release = resolvedRegistryRelease();
  return {
    coreVersion: CORE_VERSION,
    registryVersion: release.version,
    registryChecksum: release.checksum,
    modelId,
    matrix,
    unit: 'mg/L',
    // Sanitize so a failure manifest never violates RunManifest's types when the
    // scenario is malformed (e.g. a numeric analyte from a JS/JSON boundary).
    analyte: typeof scenario.analyte === 'string' ? scenario.analyte : 'unknown',
    seed:
      typeof scenario.uncertainty?.seed === 'number' &&
      Number.isFinite(scenario.uncertainty.seed)
        ? scenario.uncertainty.seed
        : null,
    draws:
      typeof scenario.uncertainty?.draws === 'number' &&
      Number.isFinite(scenario.uncertainty.draws)
        ? scenario.uncertainty.draws
        : null,
    acceptedDraws: null,
    // Hash a projection of ONLY the canonical contract fields, not the raw input.
    // This gives distinct hashes for scenarios that differ in a contract field
    // even if a caller attached an extra/circular property, and prevents an
    // unserializable extra from collapsing every hash to the 'unhashable' sentinel.
    scenarioHash: hashValue(hashableScenario(scenario)),
    createdAtIso: nowIso,
  };
}

/**
 * Projects a scenario onto just the canonical contract fields for hashing, using
 * primitive leaf values only — so an extra or circular property on the input can
 * neither change the hash nor make it throw / collapse to a sentinel. Two
 * scenarios with the same contract fields hash identically; any contract-field
 * difference changes the hash.
 */
function hashableScenario(scenario: CanonicalScenario): unknown {
  const s = scenario as unknown as Record<string, unknown>;
  const subj = (s.subject ?? {}) as Record<string, unknown>;
  const grid = (s.timeGrid ?? {}) as Record<string, unknown>;
  const unc = s.uncertainty as Record<string, unknown> | undefined;
  const doses = Array.isArray(s.doses) ? (s.doses as Record<string, unknown>[]) : [];
  return {
    schemaVersion: s.schemaVersion,
    analyte: s.analyte,
    matrix: s.matrix ?? null,
    subject: {
      weightKg: subj.weightKg,
      heightCm: subj.heightCm ?? null,
      age: subj.age ?? null,
      sex: subj.sex ?? null,
      liverImpairment: subj.liverImpairment ?? null,
      kidneyImpairment: subj.kidneyImpairment ?? null,
    },
    doses: doses.map((d) => ({
      tHours: d?.tHours,
      amountMg: d?.amountMg,
      route: typeof d?.route === 'string' ? d.route : String(d?.route),
      basis: typeof d?.basis === 'string' ? d.basis : String(d?.basis),
    })),
    timeGrid: {
      startHours: grid.startHours,
      endHours: grid.endHours,
      stepHours: grid.stepHours,
    },
    uncertainty:
      unc && typeof unc === 'object'
        ? { seed: unc.seed ?? null, draws: unc.draws ?? null }
        : null,
  };
}

function fail(
  code: FailureCode,
  detail: string,
  manifest: RunManifest,
  limitations: Limitation[] = [],
): CanonicalResultFailure {
  return { ok: false, failure: code, detail, limitations, manifest };
}

/**
 * Run a canonical forward simulation. `nowIso` is injected (defaults to the
 * wall clock) so callers can produce fully reproducible manifests in tests.
 */
export function simulateScenario(
  scenario: CanonicalScenario,
  nowIso: string = new Date().toISOString(),
): CanonicalResult {
  // --- object guard (no zod boundary): a null/non-object scenario must be a
  // structured failure, not a TypeError while building the manifest. ---
  if (!scenario || typeof scenario !== 'object') {
    return {
      ok: false,
      failure: 'invalid-input',
      detail: 'Scenario must be a non-null object.',
      limitations: [],
      manifest: {
        coreVersion: CORE_VERSION,
        registryVersion: resolvedRegistryRelease().version,
        registryChecksum: resolvedRegistryRelease().checksum,
        modelId: null,
        analyte: 'unknown',
        matrix: null,
        unit: 'mg/L',
        seed: null,
        draws: null,
        acceptedDraws: null,
        scenarioHash: hashValue(scenario ?? null),
        createdAtIso: nowIso,
      },
    };
  }

  const manifest = baseManifest(scenario, nowIso, null, null);

  // --- release compatibility ---
  if (scenario.schemaVersion !== SCENARIO_SCHEMA_VERSION) {
    return fail(
      'incompatible-release',
      `Scenario schemaVersion "${String(scenario.schemaVersion)}" is not understood by ` +
        `kinetics-core ${CORE_VERSION} (expects "${SCENARIO_SCHEMA_VERSION}").`,
      manifest,
    );
  }

  // --- structural validation ---
  if (typeof scenario.analyte !== 'string' || scenario.analyte.length === 0) {
    return fail('invalid-input', 'Scenario is missing an analyte id.', manifest);
  }
  if (
    !scenario.subject ||
    typeof scenario.subject.weightKg !== 'number' ||
    !Number.isFinite(scenario.subject.weightKg) ||
    scenario.subject.weightKg < MIN_WEIGHT_KG
  ) {
    return fail(
      'invalid-input',
      `Subject weightKg must be a finite number >= ${MIN_WEIGHT_KG}.`,
      manifest,
    );
  }
  // Optional covariates, when present, must be well-formed — otherwise a
  // malformed value (age: Infinity, sex: "femalee", liverImpairment: "sever")
  // would be simulated as valid and even hashed into provenance.
  const subj = scenario.subject;
  if (
    subj.age !== undefined &&
    (typeof subj.age !== 'number' || !Number.isFinite(subj.age) || subj.age < 0)
  ) {
    return fail('invalid-input', 'Subject age must be a finite non-negative number.', manifest);
  }
  if (
    subj.heightCm !== undefined &&
    (typeof subj.heightCm !== 'number' || !Number.isFinite(subj.heightCm) || subj.heightCm <= 0)
  ) {
    return fail('invalid-input', 'Subject heightCm must be a finite positive number.', manifest);
  }
  if (subj.sex !== undefined && !['male', 'female', 'other'].includes(subj.sex)) {
    return fail('invalid-input', `Unknown subject sex "${String(subj.sex)}".`, manifest);
  }
  const IMPAIRMENT = ['none', 'mild', 'moderate', 'severe'];
  if (subj.liverImpairment !== undefined && !IMPAIRMENT.includes(subj.liverImpairment)) {
    return fail('invalid-input', `Unknown liverImpairment "${String(subj.liverImpairment)}".`, manifest);
  }
  if (subj.kidneyImpairment !== undefined && !IMPAIRMENT.includes(subj.kidneyImpairment)) {
    return fail('invalid-input', `Unknown kidneyImpairment "${String(subj.kidneyImpairment)}".`, manifest);
  }
  if (!Array.isArray(scenario.doses) || scenario.doses.length === 0) {
    return fail('invalid-input', 'Scenario has no dose events.', manifest);
  }
  for (const d of scenario.doses) {
    if (
      !d ||
      typeof d !== 'object' ||
      !Number.isFinite(d.amountMg) ||
      d.amountMg <= 0 ||
      !Number.isFinite(d.tHours)
    ) {
      return fail(
        'invalid-input',
        'Every dose needs a finite positive amountMg and a finite tHours.',
        manifest,
      );
    }
  }
  const { startHours, endHours, stepHours } = scenario.timeGrid ?? ({} as never);
  if (
    !Number.isFinite(startHours) ||
    !Number.isFinite(endHours) ||
    !Number.isFinite(stepHours) ||
    !(stepHours > 0) ||
    endHours < startHours
  ) {
    return fail('invalid-input', 'Invalid time grid.', manifest);
  }
  // A positive finite step can still be below the floating-point spacing at a
  // large origin, so accumulation would never advance and produce a degenerate
  // single-point grid. Reject rather than silently drop the requested interval.
  if (startHours + stepHours === startHours) {
    return fail(
      'invalid-input',
      'Time-grid step is too small to advance from the start time.',
      manifest,
    );
  }
  const gridPoints = gridPointCount(startHours, endHours, stepHours);
  if (gridPoints > MAX_GRID_POINTS) {
    return fail('invalid-input', 'Time grid has too many points.', manifest);
  }

  // --- model resolution ---
  // Resolve through the same flag-selected release the preflight adapter uses. Resolving
  // through the reviewed tier alone would accept a derived analyte at the door and then
  // fail to find it here, turning every derived scenario into `insufficient-model-data`.
  const model = resolveModel(scenario.analyte);
  if (!model) {
    return fail(
      'insufficient-model-data',
      `No reviewed model for analyte "${scenario.analyte}" in registry ${REGISTRY_VERSION}.`,
      manifest,
    );
  }
  // A matrix override, when present, must be a known matrix — otherwise a falsy
  // or out-of-enum value (e.g. "" from a cleared form) would slip through the
  // `??`/truthiness below and yield an ok result whose matrix breaks the contract.
  if (scenario.matrix !== undefined && !VALID_MATRICES.has(scenario.matrix)) {
    return fail(
      'invalid-input',
      `Unknown matrix override "${String(scenario.matrix)}".`,
      baseManifest(scenario, nowIso, model.modelId, model.matrix),
    );
  }
  // The OBSERVED matrix the caller wants the curve reported in (defaults to the model's
  // native/latent matrix). A cross-matrix request is honoured only via a reviewed,
  // model-declared transform (SC-5A) — otherwise the engine refuses rather than silently
  // reporting a latent (e.g. plasma) prediction as an observed (e.g. whole-blood) value.
  const matrix: Matrix = scenario.matrix ?? model.matrix;
  const matrixChoice = selectMatrixTransform(model, scenario.matrix);
  if (matrixChoice.kind === 'unsupported') {
    return fail(
      'unsupported-scenario',
      `Model ${model.modelId} represents ${model.matrix}; no reviewed transform to ` +
        `${String(scenario.matrix)}.`,
      baseManifest(scenario, nowIso, model.modelId, model.matrix),
    );
  }
  const matrixTransform: MatrixTransform | null =
    matrixChoice.kind === 'transform' ? matrixChoice.transform : null;

  // A REPORTED uncertainty layer must be a layer that actually reached the
  // curve. The contract types for correlated IIV and for scenario/input
  // uncertainty (dose, purity, timing, duration, adherence) exist ahead of the
  // sampling that consumes them, so a model or scenario declaring one is
  // refused rather than run: a manifest that lists a layer the engine did not
  // sample would overstate the result's rigour, which is the precise failure
  // §4.3 of the completion plan forbids. Both refusals lift when the sampler
  // lands — they gate on the declaration, not on the model.
  let iiv: {
    state: 'provided' | 'assumed-diagonal';
    model: NonNullable<typeof model.iiv>;
  } | null = null;
  if (model.iiv) {
    try {
      if (model.iiv.parameterIds.length !== model.iiv.standardDeviations.length) throw new Error();
      if (model.iiv.covariance) covarianceCholesky(model.iiv.covariance);
      iiv = { state: model.iiv.covariance ? 'provided' : 'assumed-diagonal', model: model.iiv };
    } catch {
      return fail('insufficient-model-data', `Model ${model.modelId} has invalid IIV covariance.`, manifest);
    }
    return fail(
      'insufficient-model-data',
      `Model ${model.modelId} declares interindividual variability, but correlated random-effect sampling is not implemented; the curve would not carry the declared layer.`,
      manifest,
    );
  }
  const scenarioInputs = scenario.doses.flatMap((dose, doseIndex) =>
    dose.uncertainty ? [{ doseIndex, uncertainty: dose.uncertainty }] : [],
  );
  if (scenarioInputs.length > 0) {
    return fail(
      'unsupported-scenario',
      `Scenario declares dose/input uncertainty on dose ${scenarioInputs[0]!.doseIndex}, but input-uncertainty propagation is not implemented; the curve would not carry the declared layer.`,
      manifest,
    );
  }
  const observationError = model.observationError ?? [];
  const baseModelManifest = baseManifest(scenario, nowIso, model.modelId, matrix);
  // Omitted entirely when there is no layer beyond the model's own parameter
  // specifications, so a run that separates nothing does not claim to. This also
  // keeps a plain deterministic/MC run's manifest byte-identical to the pinned
  // cross-runtime parity goldens.
  const modelManifest: RunManifest =
    observationError.length > 0
      ? {
          ...baseModelManifest,
          uncertaintyLayers: {
            fixedEffects: 'model-parameter-specifications',
            iiv,
            scenarioInputs,
            observationError,
          },
        }
      : baseModelManifest;

  // Every distinct route in the scenario must be a recognised route id AND an
  // own (not inherited/prototype) property of the model's route map, so a
  // malformed route like "__proto__" or "constructor" is an explicit
  // unsupported-scenario failure rather than a later crash.
  const routesUsed: RouteId[] = Array.from(new Set(scenario.doses.map((d) => d.route)));
  for (const route of routesUsed) {
    if (
      !VALID_ROUTES.has(route) ||
      !Object.prototype.hasOwnProperty.call(model.routes, route) ||
      !model.routes[route]
    ) {
      return fail(
        'unsupported-scenario',
        `Model ${model.modelId} does not support route "${String(route)}". ` +
          `Supported: ${Object.keys(model.routes).join(', ')}.`,
        modelManifest,
      );
    }
  }

  // Each dose's basis must be one the model can consume without an unimplemented
  // conversion (e.g. salt/free-base would be silently mis-scaled). Reject others
  // as an explicit unsupported-scenario rather than returning an ok curve.
  const supportedBases: DoseBasis[] = model.supportedBases;
  for (const d of scenario.doses) {
    if (!supportedBases.includes(d.basis)) {
      return fail(
        'unsupported-scenario',
        `Model ${model.modelId} does not support dose basis "${String(d.basis)}". ` +
          `Supported: ${supportedBases.join(', ')}.`,
        modelManifest,
      );
    }
  }

  // --- uncertainty config validation (external, unvalidated at this boundary) ---
  // Presence-based: a present-but-malformed value (null, 0, a string) is an error,
  // not "uncertainty omitted". Only `undefined` means omitted.
  if (scenario.uncertainty !== undefined) {
    const u = scenario.uncertainty;
    if (u === null || typeof u !== 'object') {
      return fail(
        'invalid-input',
        'uncertainty must be an object { seed, draws } or omitted.',
        modelManifest,
      );
    }
    const { seed, draws } = u;
    if (
      !Number.isInteger(seed) ||
      // The PRNG seeds from a 32-bit word (seed | 0), so seeds outside the
      // unsigned 32-bit range alias to the same stream while the manifest records
      // a different seed — reject them to keep the seed unambiguous provenance.
      seed < 0 ||
      seed > 0xffffffff ||
      !Number.isInteger(draws) ||
      draws < 1 ||
      draws > MAX_DRAWS
    ) {
      return fail(
        'invalid-input',
        `uncertainty needs an integer seed in 0..${0xffffffff} and an integer ` +
          `draw count in 1..${MAX_DRAWS}.`,
        modelManifest,
      );
    }
  }

  // --- combined-work budget: each dimension is capped, but their product
  // (gridPoints × doses × draws) must also be bounded so a scenario at multiple
  // caps can't hang or OOM a browser/worker. ---
  const mcFactor = scenario.uncertainty ? scenario.uncertainty.draws : 1;
  // A multi-analyte family (parent-metabolite) retains ONE per-time draw collection
  // PER emitted analyte, so its peak retained-sample count is (analyte series ×
  // gridPoints × draws). The generic budget's `doses` factor over-counts stored
  // samples for a many-dose run, but a ONE-dose parent-metabolite run would store 2×
  // gridPoints×draws while this budget charged for 1× — so charge for every emitted
  // series explicitly rather than leaning on the dose count to hide it.
  const analyteSeries = routesUsed.some(
    (r) => (model.routes[r] as RouteModelParams).family === 'parent-metabolite-first-order',
  )
    ? 2
    : 1;
  if (gridPoints * scenario.doses.length * mcFactor * analyteSeries > MAX_SIM_CELLS) {
    return fail(
      'invalid-input',
      `Scenario exceeds the compute budget (${gridPoints} points × ` +
        `${scenario.doses.length} doses × ${mcFactor} draws × ${analyteSeries} analyte ` +
        `series > ${MAX_SIM_CELLS}).`,
      modelManifest,
    );
  }

  // --- covariate limitations (only declared covariates are applied) ---
  // Every subject covariate that is PRESENT but NOT declared supported by the
  // model is surfaced as a limitation, so a caller never believes an ignored
  // covariate (age, sex, or an impairment) affected the curve.
  const limitations: Limitation[] = [];
  const present: Array<[CovariateId, string]> = [];
  if (subj.age !== undefined) present.push(['age', `age (${subj.age})`]);
  if (subj.heightCm !== undefined) present.push(['heightCm', `height (${subj.heightCm} cm)`]);
  if (subj.sex !== undefined) present.push(['sex', `sex ("${subj.sex}")`]);
  if (subj.liverImpairment && subj.liverImpairment !== 'none') {
    present.push(['liverFunction', `liver impairment ("${subj.liverImpairment}")`]);
  }
  if (subj.kidneyImpairment && subj.kidneyImpairment !== 'none') {
    present.push(['kidneyFunction', `kidney impairment ("${subj.kidneyImpairment}")`]);
  }
  // A covariate a declared covariate FUNCTION consumes (SC-2A) DID affect the curve,
  // so it must not be warned as "not modelled" even if the model omitted it from
  // `supportedCovariates`. Map each function's subject-field name to its CovariateId
  // and treat those as consumed alongside `supportedCovariates`.
  const FN_COVARIATE_TO_ID: Record<string, CovariateId> = {
    weightKg: 'weightKg',
    heightCm: 'heightCm',
    age: 'age',
    sex: 'sex',
    liverImpairment: 'liverFunction',
    kidneyImpairment: 'kidneyFunction',
  };
  const consumedByCovariateFunctions = new Set<CovariateId>();
  for (const route of routesUsed) {
    const rp = model.routes[route] as RouteModelParams;
    if (rp.family === 'one-compartment-clv' && rp.covariateFunctions) {
      for (const fn of rp.covariateFunctions) {
        const id = FN_COVARIATE_TO_ID[fn.covariate];
        if (id) consumedByCovariateFunctions.add(id);
      }
    }
  }
  for (const [cov, desc] of present) {
    if (!model.supportedCovariates.includes(cov) && !consumedByCovariateFunctions.has(cov)) {
      limitations.push({
        code: 'covariate-not-modelled',
        text: `${desc} is recorded but ${model.modelId} does not model ${cov}; it did not affect the curve.`,
        severity: 'info',
      });
    }
  }

  const times = gridTimes(scenario);

  // --- resolve each route's Vd scale factor (deterministic given the subject) ---
  // A body-composition scaling needs specific covariates; reject up front rather
  // than silently falling back to weight scaling (which would change the curve).
  //   lean-body-mass → heightCm + sex     widmark → age + heightCm + sex
  const vdScaleKgByRoute = new Map<RouteId, number>();
  // Deterministic per-route covariate factors (SC-2A), applied by the clv family's
  // kernel after the seeded draw. Empty for every non-clv route.
  const covariateFactorsByRoute = new Map<
    RouteId,
    Partial<Record<CovariateTargetParameter, number>>
  >();
  for (const route of routesUsed) {
    const p = model.routes[route] as RouteModelParams;
    // The structural CL/Vc family carries reference-subject volumes and declares no
    // weight-proportional Vd scaling; it individualises CL/Vc/ka through declared
    // covariate functions instead (SC-2A). Evaluate them here (deterministic, given
    // the subject) so the kernel just multiplies the drawn parameter by the factor.
    if (p.family === 'one-compartment-clv') {
      vdScaleKgByRoute.set(route, 1);
      const fns = p.covariateFunctions ?? [];
      const cov = resolveCovariateFactors(fns, scenario.subject);
      if (!cov.ok) {
        // A model-declared covariate requires a subject field that was not provided.
        // That is an explicit insufficient-input failure, never a silent reference
        // default (plan §4.2).
        return fail(
          'invalid-input',
          `Model ${model.modelId} route "${route}" declares a covariate function that ` +
            `requires subject ${cov.missing.join(', ')}, which ${
              cov.missing.length > 1 ? 'were' : 'was'
            } not provided.`,
          modelManifest,
          limitations,
        );
      }
      covariateFactorsByRoute.set(route, cov.factors);
      // Report each covariate that MATERIALLY changed a parameter (factor ≠ 1), so a
      // consumer can trace which subject covariate moved which parameter.
      for (const a of cov.applied) {
        if (a.factor !== 1) {
          limitations.push({
            code: 'covariate-applied',
            text: `Subject ${a.covariate} scaled ${a.target} by ${a.factor.toFixed(3)}× for route "${route}".`,
            severity: 'info',
          });
        }
      }
      // Only warn "reference-subject" when the DISPOSITION is not individualised: a
      // model with a CL/Vc covariate function does scale the disposition to the
      // subject, so the blanket warning would be false; a ka-only (or no) covariate
      // model still leaves CL/Vc at reference values and keeps the warning.
      if (!individualisesDisposition(fns)) {
        limitations.push(clvReferenceSubjectLimitation(route));
      }
      continue;
    }
    const scaling = p.vdScaling ?? 'total-weight';
    const needs: Array<[boolean, string]> =
      scaling === 'lean-body-mass'
        ? [
            [typeof subj.heightCm !== 'number', 'heightCm'],
            [subj.sex === undefined, 'sex'],
          ]
        : scaling === 'widmark'
          ? [
              [typeof subj.age !== 'number', 'age'],
              [typeof subj.heightCm !== 'number', 'heightCm'],
              [subj.sex === undefined, 'sex'],
            ]
          : [];
    for (const [missing, covariate] of needs) {
      if (missing) {
        return fail(
          'invalid-input',
          `Model ${model.modelId} route "${route}" uses ${scaling} Vd scaling, ` +
            `which requires the subject ${covariate}.`,
          modelManifest,
          limitations,
        );
      }
    }
    // Widmark and lean-body-mass are sex-dependent (distinct Watson/Boer coefficient
    // sets). `sex === 'other'` falls back to the female coefficients, which for the
    // Widmark distribution volume can misstate BAC. Return an ok curve (a harm-
    // reduction estimate is still useful) but SURFACE the assumption as a limitation
    // rather than silently applying one coefficient set. (Widmark → BAC is the most
    // sensitive, so it is flagged as a warning; other sex-scaled models as info.)
    if ((scaling === 'widmark' || scaling === 'lean-body-mass') && subj.sex === 'other') {
      limitations.push({
        code: 'sex-coefficient-fallback',
        text:
          `Route "${route}" uses ${scaling} Vd scaling, which is sex-specific; for ` +
          `sex "other" the female coefficient set is applied, so the concentration ` +
          `(BAC for ethanol) is an approximation for a non-binary body composition.`,
        severity: scaling === 'widmark' ? 'warning' : 'info',
      });
    }
    vdScaleKgByRoute.set(route, vdScaleKg(scenario.subject, scaling));
  }

  // --- family class: ODE (whole-scenario integration) vs linear kernel
  // superposition. Two-compartment and Michaelis–Menten are ODE families. A
  // scenario's routes all come from one model; if any route is an ODE family, all
  // routes must be that SAME ODE family (mixing families in one run is rejected). ---
  const familyOf = (r: RouteId): ModelFamily =>
    (model.routes[r] as RouteModelParams).family;
  const isOdeFamily = (f: ModelFamily): boolean =>
    f === 'two-compartment-first-order' ||
    f === 'michaelis-menten' ||
    f === 'parent-metabolite-first-order';
  const odeFamilies = new Set(routesUsed.map(familyOf).filter(isOdeFamily));
  const usesOde = odeFamilies.size > 0;
  if (usesOde && (odeFamilies.size > 1 || routesUsed.some((r) => !isOdeFamily(familyOf(r))))) {
    return fail(
      'unsupported-scenario',
      `Model ${model.modelId} mixes an ODE family route with a differently-modelled ` +
        'route in one scenario, which is not supported.',
      modelManifest,
      limitations,
    );
  }
  const odeFamily: ModelFamily | null = usesOde ? [...odeFamilies][0]! : null;

  const centralByRoute = new Map<RouteId, ResolvedRouteSummary>();
  let medians: number[];
  let bands: CurvePoint[];
  let status: 'ok' | 'not-robust' = 'ok';
  let acceptedDraws: number | null = null;
  let odeSolver: RunManifest['solver'] | undefined;
  // Additional analyte curves (SC-3A parent/metabolite): the metabolite curve emitted
  // alongside the parent primary. Null for single-analyte families.
  let additionalAnalytes: AnalyteCurve[] | null = null;
  // The resolved central kernels for the linear (closed-form) path, kept so the
  // peak can be refined off the output grid (see the peak block). Null on the ODE
  // path, where there is no cheap arbitrary-time evaluation.
  let linearCentral: ResolvedDose[] | null = null;

  if (usesOde) {
    odeSolver = {
      method: 'rk4',
      stepHours: Math.min(
        stepHours > 0 ? stepHours : ODE_MAX_STEP_HOURS,
        ODE_MAX_STEP_HOURS,
      ),
    };
    // Every failure raised inside the ODE branch (budget reject or a non-finite
    // integration) carries the solver policy too, so a structured non-result is as
    // reproducible as a success — an audit log / vendored parity consumer can tell
    // which RK4 step produced the failure from the result alone (plan §4.4).
    const odeManifest: RunManifest = { ...modelManifest, solver: odeSolver };
    // --- ODE compute budget: bound the ACTUAL integration work (span × draws),
    // which the grid-based MAX_SIM_CELLS check does not capture. The span runs
    // from the earliest dose that can still affect an output (<= last output
    // time) to that last output time; a very old retained dose or a huge window
    // makes this large even with few grid points. Computed by iteration (no
    // `Math.max(...)` spread, which would overflow on a large grid). ---
    let outMax = times[0]!;
    let outMin = times[0]!;
    for (const t of times) {
      if (t > outMax) outMax = t;
      if (t < outMin) outMin = t;
    }
    // Mirror the curve's retention so the budget reflects the ACTUAL integration
    // span/doses. In-window doses (at/before the last output, at/after the first)
    // are always retained; integration starts at the FIRST RETAINED DOSE (the curve
    // skips the empty pre-dose gap), so `earliest` is the earliest retained dose,
    // NOT outMin. Doses BEFORE the window are judged as a CLUSTER by their COMBINED
    // deposited concentration — dose-dependent because both families have a
    // dose-scaled tail (exponential for two-compartment, saturable for Michaelis–
    // Menten) — kept or dropped together, never one at a time, and priced into the
    // budget when kept rather than silently dropped.
    const preWindow: Array<{
      tHours: number;
      g0: number;
      ka: number;
      beta: number;
      vmax: number;
      km: number;
      // Parent-metabolite pre-window fields (0 for the other ODE families).
      keParent: number;
      keMet: number;
      formCoeff: number;
      vdParent: number;
      vdMet: number;
    }> = [];
    let retainedDoses = 0;
    let earliest = outMax;
    for (const d of scenario.doses) {
      if (d.tHours > outMax + 1e-12) continue;
      if (d.tHours >= outMin) {
        retainedDoses++;
        if (d.tHours < earliest) earliest = d.tHours;
        continue;
      }
      // Pre-window dose: gather the central params needed for the cluster horizon,
      // per ODE family.
      const scaleKg = vdScaleKgByRoute.get(d.route)!;
      const fam = (model.routes[d.route] as RouteModelParams).family;
      if (fam === 'parent-metabolite-first-order') {
        const p = model.routes[d.route] as ParentMetaboliteRouteParams;
        const vd = centralValue(p.parentVdLitersPerKg) * scaleKg;
        const keParent = eliminationConstant(centralValue(p.parentEliminationHalfLifeHours));
        preWindow.push({
          tHours: d.tHours,
          g0: vd > 0 ? (d.amountMg * centralValue(p.bioavailability)) / vd : 0,
          ka: centralValue(p.kaPerHour),
          beta: 0,
          vmax: 0,
          km: 0,
          keParent,
          keMet: eliminationConstant(centralValue(p.metaboliteEliminationHalfLifeHours)),
          formCoeff: formationMassCoefficient({
            formationFraction: centralValue(p.formationFraction),
            molarMassMetabolite: p.metaboliteMolarMass,
            molarMassParent: p.parentMolarMass,
            keParentPerHour: keParent,
          } as ParentMetaboliteResolvedRoute),
          vdParent: vd,
          vdMet: centralValue(p.metaboliteVdLitersPerKg) * scaleKg,
        });
      } else {
        // Two-compartment / Michaelis–Menten both carry ka / F / Vd / terminal-t½.
        const p = model.routes[d.route] as
          | MichaelisMentenRouteParams
          | TwoCompartmentRouteParams;
        const isMm = p.family === 'michaelis-menten';
        const vd = centralValue(p.vdLitersPerKg) * scaleKg;
        preWindow.push({
          tHours: d.tHours,
          g0: vd > 0 ? (d.amountMg * centralValue(p.bioavailability)) / vd : 0,
          ka: centralValue(p.kaPerHour),
          beta: isMm ? 0 : eliminationConstant(centralValue(p.eliminationHalfLifeHours)),
          vmax: isMm ? centralValue(p.vmaxMgPerLPerHour) : 0,
          km: isMm ? centralValue(p.kmMgPerL) : 0,
          keParent: 0,
          keMet: 0,
          formCoeff: 0,
          vdParent: 0,
          vdMet: 0,
        });
      }
    }
    if (preWindow.length > 0) {
      let gTotal = 0;
      let minKa = Infinity;
      let minBeta = Infinity;
      let minVmax = Infinity;
      let maxKm = 0;
      let minKeParent = Infinity;
      let minKeMet = Infinity;
      let maxFormCoeff = 0;
      let maxVdParent = 0;
      let minVdMet = Infinity;
      for (const d of preWindow) {
        gTotal += d.g0;
        if (d.ka < minKa) minKa = d.ka;
        if (d.beta < minBeta) minBeta = d.beta;
        if (d.vmax < minVmax) minVmax = d.vmax;
        if (d.km > maxKm) maxKm = d.km;
        if (d.keParent < minKeParent) minKeParent = d.keParent;
        if (d.keMet < minKeMet) minKeMet = d.keMet;
        if (d.formCoeff > maxFormCoeff) maxFormCoeff = d.formCoeff;
        if (d.vdParent > maxVdParent) maxVdParent = d.vdParent;
        if (d.vdMet < minVdMet) minVdMet = d.vdMet;
      }
      // Only the pre-window doses at/after the dose-aware keep-threshold are
      // actually integrated (older ones are provably negligible and dropped by the
      // curve), so the budget counts and spans only those — an ancient/typo dose
      // does not inflate the retained span. (The two-comp/MM branches are unchanged;
      // parent-metabolite reuses its own validated horizon from part 1.)
      const keepThreshold =
        odeFamily === 'parent-metabolite-first-order'
          ? pmPreWindowKeepThreshold(
              gTotal,
              outMin,
              minKeParent,
              minKeMet,
              maxFormCoeff,
              minKa,
              maxVdParent,
              minVdMet,
            )
          : odeFamily === 'michaelis-menten'
            ? mmPreWindowKeepThreshold(gTotal, outMin, minVmax, maxKm, minKa)
            : twoCompPreWindowKeepThreshold(gTotal, outMin, minBeta, minKa);
      for (const d of preWindow) {
        if (d.tHours >= keepThreshold) {
          retainedDoses++;
          if (d.tHours < earliest) earliest = d.tHours;
        }
      }
    }
    if (retainedDoses > MAX_ODE_DOSES) {
      return fail(
        'invalid-input',
        `Scenario has ${retainedDoses} doses in the ODE window; the ODE ` +
          `solver is O(doses) per sub-step, so the limit is ${MAX_ODE_DOSES}.`,
        odeManifest,
        limitations,
      );
    }
    // No dose can affect any output → an all-zero curve, no integration; skip the
    // work budget entirely rather than rejecting on a meaningless full-window span.
    if (retainedDoses > 0) {
      const internalStep = Math.min(
        stepHours > 0 ? stepHours : ODE_MAX_STEP_HOURS,
        ODE_MAX_STEP_HOURS,
      );
      // A step below the float spacing at a huge time origin can't advance the
      // integrator — reject rather than risk a non-terminating run.
      if (earliest + internalStep === earliest) {
        return fail(
          'invalid-input',
          'ODE time origin is too large for the integration step to advance.',
          odeManifest,
          limitations,
        );
      }
      const spanHours = Math.max(0, outMax - earliest);
      const mcDraws = scenario.uncertainty ? scenario.uncertainty.draws : 1;
      const work = (spanHours / internalStep) * mcDraws * retainedDoses;
      if (work > MAX_ODE_WORK) {
        return fail(
          'invalid-input',
          `Scenario exceeds the ODE work budget (${Math.round(spanHours)} h span / ` +
            `${internalStep} h step × ${mcDraws} draws × ${retainedDoses} doses > ${MAX_ODE_WORK}).`,
          odeManifest,
          limitations,
        );
      }
    }

    // --- ODE path: integrate the whole scenario together, dispatched by family.
    // Both families share runOdeFamily's median + Monte-Carlo + banding; only the
    // per-route resolution and the integrator differ. ---
    const twoCompOps: OdeFamilyOps<TwoCompartmentResolvedRoute> = {
      label: 'Two-compartment',
      resolve: (route, scaleKg, rng) =>
        resolveTwoCompRoute(
          route,
          model.routes[route] as TwoCompartmentRouteParams,
          scaleKg,
          rng,
        ),
      curve: (doses, t, s) =>
        twoCompartmentCurve(doses as TwoCompartmentDose[], t, s),
    };
    const mmOps: OdeFamilyOps<MichaelisMentenResolvedRoute> = {
      label: 'Michaelis–Menten',
      resolve: (route, scaleKg, rng) =>
        resolveMmRoute(
          route,
          model.routes[route] as MichaelisMentenRouteParams,
          scaleKg,
          rng,
        ),
      curve: (doses, t, s) =>
        michaelisMentenCurve(doses as MichaelisMentenDose[], t, s),
    };

    if (odeFamily === 'parent-metabolite-first-order') {
      // Coupled parent→metabolite integration: one run yields TWO analytes. The parent
      // is the scenario's primary analyte (top-level curve); the metabolite is emitted
      // as an additional analyte on the same grid and canonical unit.
      const run = runParentMetaboliteFamily(
        routesUsed,
        scenario,
        (route) => model.routes[route] as ParentMetaboliteRouteParams,
        times,
        stepHours,
        vdScaleKgByRoute,
        centralByRoute,
        limitations,
      );
      if (!run.ok) return fail(run.failure, run.detail, odeManifest, limitations);
      medians = run.parentMedians;
      bands = run.parentBands;
      status = run.status;
      acceptedDraws = run.acceptedDraws;
      // Metabolite peak — grid scan of the metabolite median (ODE families report the
      // grid peak; a grid-independent ODE peak is a tracked follow-up, shared with the
      // parent/primary above).
      let metPeakConc = 0;
      let metPeakT = times[0] ?? 0;
      for (const pt of run.metaboliteBands) {
        if (pt.median > metPeakConc) {
          metPeakConc = pt.median;
          metPeakT = pt.tHours;
        }
      }
      // The metabolite analyte id comes from the resolved route summary (a single
      // parent-metabolite route per scenario; the first route carries the label).
      const pmSummary = centralByRoute.get(routesUsed[0]!)!.parentMetabolite;
      additionalAnalytes = [
        {
          analyte: pmSummary?.metaboliteAnalyte ?? 'metabolite',
          matrix,
          unit: 'mg/L',
          timeSeries: run.metaboliteBands,
          peak: { concentration: metPeakConc, tHours: metPeakT },
        },
      ];
    } else {
      const run =
        odeFamily === 'michaelis-menten'
          ? runOdeFamily(
              mmOps,
              routesUsed,
              scenario,
              times,
              stepHours,
              vdScaleKgByRoute,
              centralByRoute,
              limitations,
            )
          : runOdeFamily(
              twoCompOps,
              routesUsed,
              scenario,
              times,
              stepHours,
              vdScaleKgByRoute,
              centralByRoute,
              limitations,
            );
      if (!run.ok) return fail(run.failure, run.detail, odeManifest, limitations);
      medians = run.medians;
      bands = run.bands;
      status = run.status;
      acceptedDraws = run.acceptedDraws;
    }
  } else {
  // --- linear (kernel superposition) path — unchanged ---
  const centralKernelByRoute = new Map<RouteId, SingleDoseKernel>();
  for (const route of routesUsed) {
    const p = model.routes[route] as RouteModelParams;
    const resolved = resolveRouteKernel(
      route,
      p,
      vdScaleKgByRoute.get(route)!,
      undefined,
      covariateFactorsByRoute.get(route),
    );
    if (!resolved.valid) {
      return fail(
        'numerical-failure',
        `Central parameters for route "${route}" are non-physical.`,
        modelManifest,
        limitations,
      );
    }
    centralByRoute.set(route, resolved.summary);
    centralKernelByRoute.set(route, resolved.kernel);
  }
  const centralResolved: ResolvedDose[] = scenario.doses.map((d) => ({
    tHours: d.tHours,
    amountMg: d.amountMg,
    kernel: centralKernelByRoute.get(d.route)!,
  }));

  medians = times.map((t) => curveAt(centralResolved, t));
  linearCentral = centralResolved;

  if (scenario.uncertainty) {
    const { seed, draws } = scenario.uncertainty;
    const rng = new PRNG(seed);
    // Per time point, collect one concentration per surviving draw.
    const perTime: number[][] = times.map(() => []);
    let survived = 0;
    for (let i = 0; i < draws; i++) {
      const routeKernel = new Map<RouteId, SingleDoseKernel>();
      let drawOk = true;
      for (const route of routesUsed) {
        const p = model.routes[route] as RouteModelParams;
        const scaleKg = vdScaleKgByRoute.get(route)!;
        const covFactors = covariateFactorsByRoute.get(route);
        let s = resolveRouteKernel(route, p, scaleKg, rng, covFactors);
        if (!s.valid) s = resolveRouteKernel(route, p, scaleKg, rng, covFactors); // resample once
        if (!s.valid) {
          drawOk = false;
          break;
        }
        routeKernel.set(route, s.kernel);
      }
      if (!drawOk) continue;
      survived++;
      const resolved: ResolvedDose[] = scenario.doses.map((d) => ({
        tHours: d.tHours,
        amountMg: d.amountMg,
        kernel: routeKernel.get(d.route)!,
      }));
      for (let ti = 0; ti < times.length; ti++) {
        perTime[ti]!.push(curveAt(resolved, times[ti]!));
      }
    }

    if (survived === 0) {
      return fail(
        'numerical-failure',
        'No Monte-Carlo draws survived the physicality filter.',
        modelManifest,
        limitations,
      );
    }
    acceptedDraws = survived;
    if (survived / draws < NOT_ROBUST_RATIO) {
      status = 'not-robust';
      limitations.push({
        code: 'low-effective-draws',
        text: `Only ${survived}/${draws} draws were physical; uncertainty bands are unreliable.`,
        severity: 'warning',
      });
    } else if (survived < draws) {
      // Some draws were rejected as non-physical; report how many actually
      // contributed to the bands so consumers don't read them as all-draws.
      limitations.push({
        code: 'draws-rejected',
        text: `${draws - survived} of ${draws} draws were non-physical and excluded; ${survived} contributed to the bands.`,
        severity: 'info',
      });
    }
    // The reported median is ALWAYS the deterministic central-parameter curve,
    // never the sampled p50. This keeps the median seed/draw-independent and
    // identical to the deterministic path, so a median-only consumer (Redose) and
    // a banded consumer (Kinetix) derive the same median from the same canonical
    // result (plan §2). Monte-Carlo contributes only the surrounding bands.
    bands = times.map((t, ti) => {
      const pct = computePercentiles(perTime[ti]!);
      return {
        tHours: t,
        median: medians[ti]!,
        p05: pct.p05,
        p25: pct.p25,
        p75: pct.p75,
        p95: pct.p95,
      };
    });
  } else {
    // Deterministic: every band equals the median curve.
    bands = times.map((t, ti) => ({
      tHours: t,
      median: medians[ti]!,
      p05: medians[ti]!,
      p25: medians[ti]!,
      p75: medians[ti]!,
      p95: medians[ti]!,
    }));
  }
  } // end linear (kernel superposition) path

  // Guard against overflow: finite-but-huge dose totals can accumulate to
  // Infinity/NaN in curveAt(). A non-finite curve is a numerical failure, not an
  // ok result with non-finite values in the contract.
  for (const pt of bands) {
    if (
      !Number.isFinite(pt.median) ||
      !Number.isFinite(pt.p05) ||
      !Number.isFinite(pt.p25) ||
      !Number.isFinite(pt.p75) ||
      !Number.isFinite(pt.p95)
    ) {
      return fail(
        'numerical-failure',
        'Concentration curve contains non-finite values (overflow).',
        { ...modelManifest, acceptedDraws },
        limitations,
      );
    }
  }

  // --- peak ---
  // Start from the output-grid median scan, then (linear path only) refine off
  // the grid. Scanning grid samples ALONE understates Cmax whenever the grid is
  // coarser than the curve's peak width: a fast-absorption route (e.g. smoked
  // cocaine, ka from an absorption t½ ~1 min, peaks a few minutes after dosing)
  // has its true Cmax fall BETWEEN 0.5-h grid samples, so a coarse-grid consumer
  // would read a materially low safety peak. The reported time series still uses
  // the requested grid; only `peak` is refined, scanning the exact closed-form
  // central curve in bounded fine windows AROUND EACH DOSE (deterministic;
  // Hermes-safe — plain arithmetic). Seeded from the grid scan, so the refined
  // peak is NEVER lower than the sampled one. (ODE families integrate on a grid
  // and have slower absorption; a grid-independent ODE peak is a tracked follow-up.)
  let peakConc = 0;
  let peakT = times[0] ?? 0;
  for (const pt of bands) {
    if (pt.median > peakConc) {
      peakConc = pt.median;
      peakT = pt.tHours;
    }
  }
  if (linearCentral) {
    // Refine for ANY non-empty linear window — including one whose requested span is
    // shorter than stepHours (a single output sample), where the grid scan alone would
    // report a spurious 0 peak. The refiner's own gridEndHours<=gridStartHours check
    // handles a truly zero-length window.
    // Per-dose absorption dynamics (ka/ke) from the resolved central route summaries,
    // in scenario-dose order (linearCentral mirrors scenario.doses).
    const peakDoses: PeakRefineDose[] = scenario.doses.map((d, i) => {
      const s = centralByRoute.get(d.route)!;
      // Present ONLY the ACTIVE input pathways to the refiner, so a mixed route at a
      // fraction extreme collapses to the pure family in refinement exactly as it does
      // in the kernel (SC-4A). At firstOrderFraction === 0 the first-order pathway has
      // zero mass, so drop its `ka` (no first-order candidate); at === 1 the zero-order
      // pathway has zero mass, so drop its duration (no zero-order candidate). Otherwise,
      // and for every non-mixed family (fraction undefined), both fields pass through
      // unchanged. This keeps the refiner from spending a slot on — or worse, rejecting
      // the scenario for an unresolvable — peak of a pathway that contributes nothing.
      const fr = s.firstOrderFraction;
      return {
        tHours: linearCentral![i]!.tHours,
        amountMg: linearCentral![i]!.amountMg,
        ka: fr === 0 ? null : s.kaPerHour,
        ke: eliminationConstant(s.eliminationHalfLifeHours),
        infusionDurationHours: fr === 1 ? 0 : s.infusionDurationHours ?? 0,
        lagHours: s.absorptionLagHours ?? 0,
      };
    });
    const refined = refineLinearPeak(
      linearCentral,
      peakDoses,
      startHours,
      endHours,
      stepHours,
      peakConc,
      peakT,
    );
    if (refined.overflow) {
      return fail(
        'numerical-failure',
        'Concentration curve overflows between output-grid samples (peak refinement).',
        { ...modelManifest, acceptedDraws },
        limitations,
      );
    }
    if (refined.unresolvableOrigin) {
      return fail(
        'invalid-input',
        'A contributing dose sits at an absolute time too large to resolve its ' +
          'concentration peak at sub-step precision; use a smaller absolute time origin.',
        { ...modelManifest, acceptedDraws },
        limitations,
      );
    }
    if (refined.tooManyDoses) {
      return fail(
        'invalid-input',
        'Too many doses to bound the concentration-peak analysis within the compute ' +
          'budget; reduce the number of dose events.',
        { ...modelManifest, acceptedDraws },
        limitations,
      );
    }
    peakConc = refined.concentration;
    peakT = refined.tHours;
    if (refined.refinedDoses < refined.totalDoses) {
      // Too many distinct peak clusters to finely refine each within the compute
      // budget: the reported peak refined the largest-contribution clusters and may
      // still understate a narrow peak at a smaller, unrefined cluster. Surfaced
      // rather than silently under-resolved.
      limitations.push({
        code: 'peak-under-refined',
        text:
          `Peak refinement covered the ${refined.refinedDoses} highest-contribution ` +
          `of ${refined.totalDoses} distinct in-window peak clusters (compute budget); ` +
          `a narrow peak at a lower-contribution cluster may be understated — request a ` +
          `finer output grid for an exact Cmax.`,
        severity: 'info',
      });
    }
  }

  // --- observed-matrix transform (SC-5A) ---
  // Everything above is the LATENT prediction in the model's native matrix. When the
  // caller asked for a different observed matrix and a reviewed transform covers it,
  // scale every reported concentration by the transform ratio — a DETERMINISTIC linear
  // conversion, so each band percentile and the peak scale by the same factor — and
  // record the conversion, so an observed value is never read as a native prediction.
  let outBands = bands;
  let outPeakConc = peakConc;
  let outAdditional = additionalAnalytes;
  if (matrixTransform) {
    const r = matrixTransform.ratio;
    const scalePt = (p: CurvePoint): CurvePoint => scaleCurvePointByRatio(p, r);
    outBands = bands.map(scalePt);
    outPeakConc = peakConc * r;
    // Each ADDITIONAL analyte (e.g. a metabolite) is a distinct chemical entity with its
    // OWN partition ratio — sharing the parent's native matrix does NOT mean sharing its
    // blood/plasma ratio. So resolve a transform PER emitted analyte; if the model does
    // not declare one for an emitted analyte, refuse the whole cross-matrix request rather
    // than rescale a metabolite by the parent's ratio or return a mixed-matrix result.
    if (additionalAnalytes) {
      const scaled: AnalyteCurve[] = [];
      for (const a of additionalAnalytes) {
        const sub = selectMatrixTransform(model, scenario.matrix, a.analyte);
        if (sub.kind !== 'transform') {
          return fail(
            'unsupported-scenario',
            `Model ${model.modelId} declares a ${matrixTransform.from}→${matrixTransform.to} ` +
              `transform for ${scenario.analyte} but not for the emitted analyte ` +
              `"${a.analyte}"; cannot report every analyte in ${matrixTransform.to}.`,
            // No observed-matrix curve was produced, so report the model's NATIVE matrix
            // (and no applied transform) — matching the no-transform reject above, rather
            // than a manifest that claims the observed matrix with no conversion recorded.
            { ...modelManifest, matrix: model.matrix, acceptedDraws },
            limitations,
          );
        }
        const ar = sub.transform.ratio;
        scaled.push({
          ...a,
          timeSeries: a.timeSeries.map((p) => scaleCurvePointByRatio(p, ar)),
          peak: { concentration: a.peak.concentration * ar, tHours: a.peak.tHours },
          // Record the analyte's OWN conversion so a persisted result discloses the exact
          // ratio applied to this curve (the primary's is on the manifest).
          matrixTransform: sub.transform,
        });
      }
      outAdditional = scaled;
    }
    limitations.push({
      code: 'matrix-transform-applied',
      text:
        `Reported in ${matrixTransform.to} via a reviewed ${matrixTransform.from}→` +
        `${matrixTransform.to} conversion (×${r}); the underlying model computes ` +
        `${matrixTransform.from}. ${matrixTransform.rationale}`,
      severity: 'info',
    });
    // The finite-curve guard above ran on the LATENT curve; scaling by a finite ratio can
    // still overflow a finite-but-huge concentration to Infinity. A non-finite converted
    // curve is a numerical failure, not an ok result carrying Infinity/NaN.
    const finitePt = (p: CurvePoint): boolean =>
      Number.isFinite(p.median) &&
      Number.isFinite(p.p05) &&
      Number.isFinite(p.p25) &&
      Number.isFinite(p.p75) &&
      Number.isFinite(p.p95);
    const allFinite =
      outBands.every(finitePt) &&
      Number.isFinite(outPeakConc) &&
      (outAdditional ?? []).every(
        (a) => a.timeSeries.every(finitePt) && Number.isFinite(a.peak.concentration),
      );
    if (!allFinite) {
      return fail(
        'numerical-failure',
        `The ${matrixTransform.from}→${matrixTransform.to} matrix conversion overflowed the ` +
          `concentration to a non-finite value.`,
        // No valid observed-matrix curve was produced — report the NATIVE matrix (no
        // applied transform), consistent with the other matrix-failure manifests.
        { ...modelManifest, matrix: model.matrix, acceptedDraws },
        limitations,
      );
    }
  }

  // --- observation residual-error layer (SC-5B) ---
  // The bands so far reflect PARAMETER/individual variability of the latent kinetics. A
  // measurement of the (already matrix-converted) concentration also carries observation
  // error the kinetics do not — assay, preanalytical, biological, structural — kept as
  // distinct declared layers. Widen the bands by the composed error PER analyte, leaving
  // the deterministic median unchanged. Additive: a model with no layers is untouched.
  // The layer is declared in the model's NATIVE matrix; the proportional CV is unitless (so
  // matrix-invariant), but the additive SD carries concentration units, so when a matrix
  // transform converted this analyte's curve the additive SD is scaled by the SAME ratio to
  // land in the observed matrix — otherwise a plasma-reviewed SD would be reused for whole
  // blood unchanged.
  let obsErrApplied: ObservationErrorLayer[] | null = null;
  if (model.observationError && model.observationError.length > 0) {
    try {
      const primary = model.analyte;
      const primaryRatio = matrixTransform?.ratio ?? 1;
      const primaryErr = composeObservationError(model.observationError, primary, primary);
      if (primaryErr) {
        outBands = outBands.map((p) =>
          widenBandForObservationError(p, primaryErr.propCv, primaryErr.addSd * primaryRatio),
        );
      }
      if (outAdditional) {
        outAdditional = outAdditional.map((a) => {
          const e = composeObservationError(model.observationError!, a.analyte, primary);
          if (!e) return a;
          const ratio = a.matrixTransform?.ratio ?? 1;
          return {
            ...a,
            timeSeries: a.timeSeries.map((p) =>
              widenBandForObservationError(p, e.propCv, e.addSd * ratio),
            ),
          };
        });
      }
      // The widening multiplies concentrations by a variance factor, which can overflow a
      // finite-but-huge band to Infinity. A non-finite widened curve is a numerical failure,
      // not an ok result carrying Infinity/NaN.
      const finiteBand = (p: CurvePoint): boolean =>
        Number.isFinite(p.p05) &&
        Number.isFinite(p.p25) &&
        Number.isFinite(p.p75) &&
        Number.isFinite(p.p95);
      if (
        !outBands.every(finiteBand) ||
        (outAdditional ?? []).some((a) => !a.timeSeries.every(finiteBand))
      ) {
        return fail(
          'numerical-failure',
          `Model ${model.modelId}'s observation residual-error layer widened the bands to a ` +
            `non-finite value.`,
          { ...modelManifest, acceptedDraws },
          limitations,
        );
      }
      // Record the layers that actually applied to at least one emitted analyte, so the
      // report discloses how the bands were widened. The primary curve is matched by the
      // model's canonical analyte (not the scenario's, which may be an alias), consistent
      // with how the widening above resolved it.
      const emitted = new Set<string>([
        model.analyte,
        ...(outAdditional ?? []).map((a) => a.analyte),
      ]);
      obsErrApplied = model.observationError.filter((l) => emitted.has(l.analyte ?? model.analyte));
      if (obsErrApplied.length === 0) obsErrApplied = null;
      else {
        limitations.push({
          code: 'observation-error-applied',
          text:
            `Reported bands include a reviewed observation residual-error layer ` +
            `(${obsErrApplied.map((l) => l.layer).join(', ')}) beyond parameter/individual ` +
            `variability; the median is the deterministic central prediction.`,
          severity: 'info',
        });
      }
    } catch {
      // An invalid layer — non-physical (negative/non-finite cv or sd) or empty (no error
      // component) — is an authoring error, not a runnable model, so reject rather than
      // emit an ok result with a bad or falsely-annotated band.
      return fail(
        'invalid-input',
        `Model ${model.modelId} declares an invalid observation-error layer.`,
        { ...modelManifest, acceptedDraws },
        limitations,
      );
    }
  }

  return {
    ok: true,
    analyte: scenario.analyte,
    matrix,
    unit: 'mg/L',
    timeSeries: outBands,
    peak: { concentration: outPeakConc, tHours: peakT },
    status,
    limitations,
    modelSummary: {
      modelId: model.modelId,
      validationStatus: model.validationStatus,
      routes: Array.from(centralByRoute.values()),
    },
    ...(outAdditional ? { additionalAnalytes: outAdditional } : {}),
    manifest: {
      ...modelManifest,
      acceptedDraws,
      ...(matrixTransform ? { matrixTransform } : {}),
      ...(obsErrApplied ? { observationError: obsErrApplied } : {}),
      ...(odeSolver ? { solver: odeSolver } : {}),
    },
  };
}
