// --- Distribution types ---

export type DistributionType = 'fixed' | 'uniform' | 'triangular' | 'lognormal';

export interface FixedDistribution {
  type: 'fixed';
  value: number;
}

export interface UniformDistribution {
  type: 'uniform';
  min: number;
  max: number;
}

export interface TriangularDistribution {
  type: 'triangular';
  min: number;
  mode: number;
  max: number;
}

export interface LogNormalDistribution {
  type: 'lognormal';
  mu: number;
  sigma: number;
}

export type DistributionSpec =
  | FixedDistribution
  | UniformDistribution
  | TriangularDistribution
  | LogNormalDistribution;

// --- Question modes ---

export type QuestionMode =
  | 'earlier-from-later' // A: Earlier concentration from later concentration
  | 'later-from-earlier' // B: Later concentration from earlier concentration
  | 'concentration-from-dose' // C: Concentration from known dose
  | 'dose-from-concentration'; // D: Dose from measured concentration

// --- Route types ---

export type RouteType = 'iv' | 'oral' | 'insufflation' | 'inhalation' | 'other';

// --- Events ---
// A component's inputs are modelled as a chronological list of events. The
// question being answered (forward-predict, back-calculate, dose-from-conc) is
// derived from which events are present (see lib/eventDerivation.ts) rather than
// chosen explicitly. Times are hours from the reference time (same axis as the
// legacy measuredTime/targetTime fields).

export type SimEventType = 'dose' | 'measurement' | 'query';

export interface SimEventBase {
  id: string;
  t?: number; // hours from reference; undefined while the user is editing
}

export interface DoseEvent extends SimEventBase {
  type: 'dose';
  amount?: number; // may be undefined when the dose is the unknown being solved for
  amountRange?: { min: number; max: number }; // optional dose prior for inverse inference
  tRange?: [number, number]; // optional intake window for inverse inference
  unit: string;
  route: RouteType;
  // IV infusion duration in hours. When set (> 0) for an IV dose, the forward
  // simulator models a constant-rate infusion over this window instead of an
  // instantaneous bolus. Omitted/0 → bolus.
  durationHours?: number;
}

export interface MeasurementEvent extends SimEventBase {
  type: 'measurement';
  value?: number; // may be undefined while the user is still entering it
  unit: string;
  assayCV?: number; // optional per-observation analytical uncertainty
  /**
   * Left-censoring for a non-detect. When set, `value` is the limit (LOD or
   * LOQ) and the observation contributes "true concentration < limit" to the
   * KineLab likelihood instead of being treated as a point value — rather than
   * being dropped for being below quantification.
   */
  censoring?: 'below_lod' | 'below_loq';
}

export interface QueryEvent extends SimEventBase {
  type: 'query';
  solveFor: 'concentration' | 'dose';
}

export type SimEvent = DoseEvent | MeasurementEvent | QueryEvent;

// --- Component engine ---
// A component selects the compute engine that turns its events into a curve.
// `pk-montecarlo` is the default one-compartment Monte Carlo simulator; other
// engines (ethanol Widmark, and later the KineLab Bayesian inference engine)
// plug into the same event model and feed the same chart via a unified result.

export type ComponentEngine =
  | 'pk-montecarlo'
  | 'ethanol-widmark'
  | 'kinelab-bayes';

/** Component-level Widmark parameters for the ethanol engine. */
export interface EthanolComponentParams {
  weightKg?: number;
  biologicalSex?: 'female' | 'male';
  /** Elimination slope in g/dL/hour. Typical: 0.015 */
  eliminationRateGdlPerHour?: number;
  /** Optional Widmark distribution ratio override. */
  distributionRatioOverride?: number;
  /** Optional forensic workbook inputs attached to this ethanol component. */
  workbook?: import('@/lib/etohWorkbookFlows').EtohParityInput;
}

export interface KinelabComponentParams {
  assayCV?: number;
  drawCount?: number;
  /** Observation matrix. Defaults to whole blood (the model reference matrix).
   *  Selecting another matrix records it and warns that no matrix conversion
   *  is applied — the concentration is used as-is. */
  matrix?: import('@/lib/compute/types').Matrix;
  priorsSnapshot?: import('@/lib/compute/types').InferencePriors;
  subject?: {
    weightKg?: number;
    sex?: 'male' | 'female' | 'unknown';
    ageYears?: number;
  };
}

// --- Drug simulation config ---

export interface DrugSimInputs {
  // Concentration-to-concentration modes (A & B)
  measuredConcentration?: number;
  measuredTime?: number; // hours from reference
  targetTime?: number; // hours from reference
  concentrationUnit?: string;

  // Dose-to-concentration mode (C)
  dose?: number;
  doseUnit?: string;
  timeSinceDose?: number; // hours
  weight?: number; // kg

  // Concentration-to-dose mode (D)
  // uses measuredConcentration, timeSinceDose, weight from above
}

export interface DrugSimOverrides {
  halfLife?: DistributionSpec;
  vd?: DistributionSpec;
  f?: DistributionSpec;
  drawCount?: number;
  /**
   * First-order absorption rate constant ka (per hour) for the oral forward
   * model. When supplied (> 0) the forward simulator uses the Bateman equation
   * (a rising then falling curve, valid around Tmax) instead of the default
   * instantaneous-absorption approximation. Omitted → instantaneous absorption.
   */
  ka?: number;
}

export interface DrugDisplaySettings {
  visible: boolean;
  color?: string;
}

export interface DrugSimConfig {
  id: string;
  drugId: string; // references DrugComponent.id
  drugName: string;
  label: string;
  // Event-based inputs: the chronological list of doses/measurements/queries.
  // The legacy `route`/`questionMode`/`inputs` fields are derived from these
  // (or vice-versa for migration) — see lib/eventDerivation.ts.
  events: SimEvent[];
  weight?: number; // patient body weight (kg), component-level
  // Compute engine for this component. Defaults to 'pk-montecarlo' when absent
  // so existing saved cases keep running through the Monte Carlo path.
  engine?: ComponentEngine;
  // Engine-specific parameters. Only read when `engine` selects that engine.
  ethanol?: EthanolComponentParams;
  kinelab?: KinelabComponentParams;
  // --- Legacy/derived fields (kept for back-compat + worker boundary) ---
  route: RouteType;
  questionMode: QuestionMode;
  inputs: DrugSimInputs;
  overrides: DrugSimOverrides;
  display: DrugDisplaySettings;
}

// --- Simulation results ---

export interface UncertaintyPoint {
  t: number;
  p05: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
}

export interface SimulationWarning {
  type:
    | 'instability'
    | 'sensitivity'
    | 'model-limitation'
    | 'input-uncertainty';
  message: string;
  messageKey?: string;
  /** Interpolation values for `messageKey` (e.g. hours, parameter name, %). */
  messageParams?: Record<string, string | number>;
  severity: 'info' | 'warning' | 'critical';
}

export interface SensitivityEntry {
  parameter: string;
  influence: number; // 0-1, relative influence on output variance
}

export interface DrugSimResult {
  drugConfigId: string;
  // Which engine produced this result. Lets the results pane render
  // engine-specific extras (e.g. ethanol legal-limit lines) without
  // re-deriving the engine from the component config.
  engine?: ComponentEngine;
  questionMode: QuestionMode;
  // Point estimate at target time
  median: number;
  p05: number;
  p25: number;
  p75: number;
  p95: number;
  unit: string;
  /**
   * Set when the engine could not produce an answer at all — an unbuildable
   * scenario, a numerical failure, or a question this model cannot be asked
   * (back-calculating a dose through saturable elimination).
   *
   * The percentiles on such a result are placeholder zeros, not an estimate of
   * zero, so every numeric surface must suppress them and show this reason
   * instead. `warnings` carries the same reason as a critical entry; this field
   * is what makes "there is no answer" legible without pattern-matching on
   * warning severity.
   */
  failure?: { message: string; messageKey?: string };
  /**
   * Unit of the plotted `timeSeries`, when it differs from `unit`.
   *
   * `unit` names the SCALAR answer, which is not always a concentration: in
   * `dose-from-concentration` the answer is a dose (mg) while the curve under
   * it is still a concentration. Axis labels, threshold lines and the
   * postmortem/forensic overlays describe the curve, so they read this; the
   * answer card and the exported figure read `unit`. Omitted when the two
   * coincide, which is every other mode.
   */
  curveUnit?: string;
  // Time series for graphing
  timeSeries: UncertaintyPoint[];
  /**
   * Absolute clock time (hours from the case reference time) that the curve's
   * `timeSeries[].t = 0` maps to. The worker produces a curve in an engine- and
   * mode-specific time frame (relative to the dose origin for dose modes,
   * already absolute for extrapolation/ethanol); this stamp lets the chart shift
   * the curve back onto the absolute event-timeline frame so it aligns with the
   * dose/prediction guide lines. Omitted on results computed before this field
   * existed → treated as 0 (renders in the legacy relative frame until re-run).
   */
  anchorTime?: number;
  // Metadata
  assumptions: SimulationAssumptions;
  sensitivity: SensitivityEntry[];
  warnings: SimulationWarning[];
  seed: number;
  drawCount: number;
  // Hash of the inputs that produced this result (see lib/resultStaleness.ts).
  // Optional so older saved cases without a stamp keep loading. When present,
  // a mismatch against the live component's hash marks the result out of date.
  inputHash?: string;
  // Reproducibility manifest: exactly which engine/model/seed/inputs produced
  // this result, and when. Lets a report state its provenance and supports
  // stale-result detection. Optional for back-compat with older saved cases.
  manifest?: RunManifest;
  /** Complete scientific-engine output. Kept intact so reports and future UI
   * surfaces can inspect secondary analytes, limitations and uncertainty. */
  canonicalResult?: import('@/lib/kinetics-core').CanonicalResult;
  kinelab?: {
    posterior: import('@/lib/compute/types').PosteriorSummary;
    diagnostics: {
      sampleCount: number;
      rejectedNonphysical: number;
      rejectedImpossible: number;
      effectiveSampleSize: number;
    };
    // Prior 5/50/95 intervals keyed like the posterior (dose, vd, …). Lets the
    // UI show prior vs posterior side by side, exposing weak identifiability or
    // a result driven almost entirely by its prior. Optional for back-compat.
    priorIntervals?: Record<
      string,
      { p05: number; median: number; p95: number }
    >;
    /** Observation matrix the inference ran against (recorded for provenance). */
    matrix?: import('@/lib/compute/types').Matrix;
  };
}

/**
 * Where a PK parameter's value came from. Forensic work needs this distinction
 * to be explicit rather than letting a synthesized default look as trustworthy
 * as a literature value:
 *  - `verified`   — taken from the drug's curated literature data;
 *  - `assumption` — an explicit value the user entered as an override;
 *  - `fallback`   — a generic default used because no data was available.
 */
export type ParameterProvenance = 'verified' | 'assumption' | 'fallback';

export interface ParameterProvenanceMap {
  halfLife: ParameterProvenance;
  vd: ParameterProvenance;
  f: ParameterProvenance;
}

export interface RunManifest {
  /** Hash of the inputs that produced the result (see lib/resultStaleness.ts). */
  inputHash: string;
  engine: ComponentEngine;
  /** Model identifier or i18n key recorded for the run. */
  model: string;
  seed: number;
  drawCount: number;
  /** ISO timestamp of when the run was produced. */
  createdAtIso: string;
  /** App/build version when known, for cross-version reproducibility. */
  appVersion?: string;
  /** Effective sample size for inference runs, when applicable. */
  effectiveSampleSize?: number;
  /** Valid draws that entered the estimate, when applicable. */
  sampleCount?: number;
  /** Observation matrix for inference runs, when applicable. */
  matrix?: import('@/lib/compute/types').Matrix;
}

export interface SimulationAssumptions {
  model: string;
  modelKey?: string;
  route: RouteType;
  halfLife: DistributionSpec;
  vd: DistributionSpec;
  f: DistributionSpec;
  weightScaling: boolean;
  /**
   * Per-parameter provenance. Present for the Monte Carlo PK engine, which is
   * the only engine that uses half-life/Vd/F. Absent for ethanol/KineLab whose
   * assumptions are model-specific.
   */
  provenance?: ParameterProvenanceMap;
  /** Oral absorption rate constant ka (per hour) when Bateman absorption is
   *  active; absent when absorption is treated as instantaneous. */
  absorptionKa?: number;
  /**
   * Reviewed registry model id that produced the curve (e.g. `thc-two-comp-v1`),
   * when the run came from kinetics-core. Absent for the ethanol/KineLab engines,
   * which do not resolve a registry model.
   */
  modelId?: string;
  /**
   * The resolved model FAMILY, read from the core's `modelSummary` rather than
   * assumed. Present whenever `modelId` is: the two travel together, so a
   * consumer never has to infer one from the other.
   */
  family?: import('@/lib/kinetics-core').ModelFamily;
  /** Reviewed validation status of that model, for the disclosure surface. */
  validationStatus?: import('@/lib/kinetics-core').ValidationStatus;
  /**
   * The biological matrix the model NATIVELY computes in (plasma for most
   * reviewed models, whole blood for ethanol). The chart converts from this to
   * the display matrix; it is not the matrix the user is necessarily reading.
   */
  nativeMatrix?: string;
}

// --- Display settings ---

export type DisplayMode = 'overlay' | 'separate';
export type NormalizeMode = 'none' | 'peak' | 'initial_point';
export type YAxisMode = 'shared' | 'independent';
export type TimeFormat = 'clock' | 'hours';

export interface CaseDisplaySettings {
  mode: DisplayMode;
  showUncertaintyBands: boolean;
  normalizeMode: NormalizeMode;
  yAxisMode: YAxisMode;
  timeFormat: TimeFormat;
  referenceTime: string; // "HH:MM" — the t=0 clock time
  /**
   * Biological matrix the whole chart is displayed in — the modelled curve and
   * every reference overlay are converted to it via the drug's blood:plasma
   * ratio. Defaults to whole blood (the model's reference frame), where no
   * conversion happens. See `src/lib/matrixDisplay.ts`.
   */
  displayMatrix: import('@/lib/matrixDisplay').ChartMatrix;
}

// --- Simulation case ---

export interface SimulationCase {
  id: string;
  name: string;
  drugs: DrugSimConfig[];
  displaySettings: CaseDisplaySettings;
  results: Record<string, DrugSimResult>; // keyed by DrugSimConfig.id
  createdAt?: string;
  updatedAt?: string;
}

// --- Monte Carlo worker messages ---

export interface MonteCarloConfig {
  drugConfigId: string;
  questionMode: QuestionMode;
  route: RouteType;
  inputs: DrugSimInputs;
  halfLife: DistributionSpec;
  vd: DistributionSpec;
  f: DistributionSpec;
  drawCount: number;
  seed: number;
  timeRange: { start: number; end: number; steps: number };
  weightScaling: boolean;
  weight?: number;
  molecularWeight?: number;
  /**
   * Repeated-dose superposition for the forward concentration-from-dose mode.
   * Each entry is a dose amount (in `inputs.doseUnit`) and its administration
   * time in hours relative to the FIRST dose. When present, the worker sums
   * every dose's single-dose curve instead of using only the latest dose. A
   * single-element array reproduces the single-dose result exactly.
   */
  doses?: Array<{ amount: number; tHours: number; durationHours?: number }>;
  /** Concentration query time in hours relative to the first dose (for `doses`). */
  queryTimeHours?: number;
  /** First-order oral absorption rate constant (per hour). When > 0 the forward
   *  oral curve uses the Bateman equation instead of instantaneous absorption. */
  absorptionKa?: number;
}

/** Worker boundary for the canonical forward engine. */
export interface CanonicalSimulationConfig {
  drugConfigId: string;
  scenario: import('@/lib/kinetics-core').CanonicalScenario;
}

export interface MonteCarloResult {
  drugConfigId: string;
  median: number;
  p05: number;
  p25: number;
  p75: number;
  p95: number;
  unit: string;
  timeSeries: UncertaintyPoint[];
  warnings: SimulationWarning[];
  sensitivity: SensitivityEntry[];
  seed: number;
  drawCount: number;
  /** Lossless core result; adapters must not reduce this to legacy percentiles. */
  canonicalResult?: import('@/lib/kinetics-core').CanonicalResult;
}
