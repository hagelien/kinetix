/**
 * External validation: fixture format + landmark computation + comparison report (SC-7A,
 * plan §S7). Every scientific slice carries a validation burden — the engine must be
 * checkable against reviewed literature landmarks (Cmax, Tmax, AUC, terminal half-life),
 * not only against its own golden curves. A `ValidationFixture` pairs a canonical scenario
 * with the EXPECTED landmarks and tolerances from a named source; `validateFixture` runs
 * the engine and reports each landmark's computed value against the expectation.
 *
 * This module is pure tooling ON TOP of results — it changes no equation, solver, or
 * scenario/result contract, so it carries no `CORE_VERSION` bump and no shipped fixture
 * (a fixture with real expected values is evidence-authored, like a registry model). The
 * landmark computations are non-compartmental (NCA): they read only the reported curve,
 * so they validate the engine's OUTPUT rather than re-deriving its internals.
 */
import type {
  CanonicalScenario,
  CanonicalResult,
  CurvePoint,
} from "./types.js";
import { simulateScenario } from "./simulate.js";
import { CORE_VERSION } from "./version.js";
import { REGISTRY_CHECKSUM, REGISTRY_VERSION } from "./registry.js";

/** Absolute adjusted-R² a terminal window must reach to be reported as a log-linear λz fit
 * (standard NCA acceptance). Below this the profile is not in a resolvable terminal phase. */
const MIN_TERMINAL_ADJ_R2 = 0.9;

/** An expected landmark value with a tolerance. A comparison passes when the computed
 * value is within `absTol` (absolute) OR `relTol` (relative to the expected) — whichever
 * is satisfied. At least one tolerance must be provided. */
export interface ExpectedLandmark {
  value: number;
  /** Relative tolerance (fraction of `value`, e.g. 0.2 = ±20%). */
  relTol?: number;
  /** Absolute tolerance (same unit as `value`). */
  absTol?: number;
}

/**
 * Expected non-compartmental landmarks for a fixture. Each is optional — a fixture asserts
 * only the landmarks its source reports.
 */
export interface ValidationExpectation {
  /** Peak concentration Cmax (mg/L). */
  cmax?: ExpectedLandmark;
  /** Time of peak Tmax (h). */
  tmaxHours?: ExpectedLandmark;
  /** Area under the curve from the first to the last sample, trapezoidal (mg/L·h). */
  aucLast?: ExpectedLandmark;
  /** Terminal elimination half-life from the log-linear terminal slope (h). */
  terminalHalfLifeHours?: ExpectedLandmark;
}

/** A reviewed external-validation case: a scenario plus the landmarks its source reports. */
export interface ValidationFixture {
  id: string;
  description: string;
  scenario: CanonicalScenario;
  expected: ValidationExpectation;
  /**
   * Literature source(s) the expected landmarks come from. REQUIRED and must be non-empty:
   * an external-validation fixture with no cited source cannot establish which literature
   * value was tested, so a committed passing report would be unverifiable. A fixture with
   * an empty source list fails validation (see `validateFixture`).
   */
  references: string[];
}

/** One landmark's computed-vs-expected comparison. */
export interface LandmarkComparison {
  landmark: "cmax" | "tmaxHours" | "aucLast" | "terminalHalfLifeHours";
  expected: number;
  /** The engine-derived value, or null when it could not be computed from the curve. */
  computed: number | null;
  /** The tolerance applied, for the report (e.g. "±20% or ±0.3"). */
  tolerance: string;
  pass: boolean;
}

/** The result of validating one fixture. */
export interface FixtureValidationReport {
  fixtureId: string;
  /** The fixture's cited literature source(s), echoed so the committed report is
   * self-describing (which value was tested, and from where). */
  references: string[];
  /** Whether the fixture was actually validated (simulation ran AND provenance is present);
   * when false, `failure` explains why and no comparisons are produced. */
  simulated: boolean;
  failure?: string;
  comparisons: LandmarkComparison[];
  /** True when the fixture was validated AND every asserted landmark is within tolerance. */
  passed: boolean;
}

/**
 * Trapezoidal AUC of the median curve from the first to the last sample (mg/L·h). Reads
 * only the reported time series, so it measures the engine's OUTPUT. Points must be in
 * ascending time; a series shorter than two points has no area (0).
 */
export function computeAucLast(timeSeries: CurvePoint[]): number {
  let auc = 0;
  for (let i = 1; i < timeSeries.length; i++) {
    const dt = timeSeries[i]!.tHours - timeSeries[i - 1]!.tHours;
    if (dt <= 0) continue; // non-monotone or duplicate time: contributes no interval
    auc += 0.5 * (timeSeries[i]!.median + timeSeries[i - 1]!.median) * dt;
  }
  return auc;
}

/**
 * Scan every terminal window (the last k points, k = 3 … tail.length) of an ascending-time,
 * positive-median tail, calling `visit` with each window's declining log-linear fit. Runs
 * in a single O(n) pass with O(1) extra memory, extending the window one point at a time
 * (walking from the last sample toward the front) and computing each window's slope and
 * adjusted R² in constant time — never slicing or refitting a window, so a fine grid (the
 * engine accepts up to 200k points) cannot make this Θ(n²) or hang.
 *
 * The centred sums (Stt/Syy/Sty) are accumulated with a numerically stable online (Welford)
 * co-moment update rather than subtracting raw second-moment totals: the canonical time axis
 * permits a large nonzero origin (e.g. t ≈ 1e12), where `ΣT² − (ΣT)²/n` cancels
 * catastrophically and would spuriously report no terminal phase.
 *
 * Windows with no time spread, no `ln(C)` variation, a non-declining slope, or a non-finite
 * fit are skipped. `visit` receives windows in increasing size (increasing `count`).
 */
function scanTerminalWindows(
  tail: CurvePoint[],
  visit: (count: number, slope: number, adjR2: number) => void,
): void {
  let meanT = 0;
  let meanY = 0;
  let Stt = 0; // Σ(t − t̄)²
  let Syy = 0; // Σ(y − ȳ)²
  let Sty = 0; // Σ(t − t̄)(y − ȳ)
  let count = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const t = tail[i]!.tHours;
    const y = Math.log(tail[i]!.median);
    count++;
    const dT = t - meanT;
    const dY = y - meanY;
    meanT += dT / count;
    meanY += dY / count;
    // Welford co-moment update: use the pre-update delta on one factor and the post-update
    // residual on the other, so no near-equal totals are ever subtracted.
    Stt += dT * (t - meanT);
    Syy += dY * (y - meanY);
    Sty += dT * (y - meanY);
    if (count < 3) continue; // adjusted R² needs count − 2 > 0
    if (!(Stt > 0) || !(Syy > 0)) continue; // no time spread / no concentration variation
    const slope = Sty / Stt;
    if (!(slope < 0) || !Number.isFinite(slope)) continue;
    const r2 = (Sty * Sty) / (Stt * Syy);
    const adjR2 = 1 - ((1 - r2) * (count - 1)) / (count - 2);
    if (!Number.isFinite(adjR2)) continue;
    visit(count, slope, adjR2);
  }
}

/**
 * Terminal elimination half-life (h) from the log-linear terminal slope of the median
 * curve — the standard NCA λz estimate with objective terminal-phase selection.
 *
 * A single fit over the whole declining tail folds absorption/distribution phases into the
 * slope, so for a Bateman or multi-exponential curve the reported half-life is biased and
 * window-dependent. Instead this uses the well-established "best fit" rule: among all
 * windows of the last k points AFTER the peak (k = 3 … tailLength), fit `ln(C)` vs `t` and
 * choose the window that MAXIMISES the adjusted R². A window that reaches back into a
 * non-terminal phase curves the semi-log plot and lowers adjusted R², so it is not chosen;
 * on a near-tie (within 1e-4) the window with MORE points wins, using all the terminal
 * data that fits. `t½ = ln2 / (−slope)`.
 *
 * Two O(n) passes over cumulative suffix statistics (see `scanTerminalWindows`): the first
 * finds the global maximum adjusted R²; the second selects the largest window within 1e-4
 * of it. Selecting against the GLOBAL maximum (not pairwise between neighbouring sizes)
 * avoids a fit that drifts downhill one sub-threshold step at a time back into the
 * distribution phase.
 *
 * The terminal phase must lie within a SINGLE uninterrupted decline, so the candidate points
 * are the maximal non-increasing suffix (not merely everything after the global peak): a later
 * input — e.g. a second dose that rises without exceeding the original Cmax — starts a new
 * disposition phase, and a fit that spanned it would report a plausible but biased half-life.
 *
 * `earliestTerminalHours` optionally bounds the terminal phase to AFTER the last input has
 * ended (`validateFixture` derives it from the scenario's dose times + resolved infusion/
 * zero-order input durations). The curve-only non-increasing anchor cannot see an input that
 * merely slows the decline without producing a visible rise; this event-time bound closes that
 * gap. When fewer than three samples decline after that time, there is no terminal phase.
 *
 * Returns null when there is no resolvable terminal phase — fewer than three positive samples
 * decline after the last rise / last input, or no window yields a negative slope (still-rising,
 * flat, or a saturable curve that has not entered first-order decline within the window).
 */
export function estimateTerminalHalfLife(
  timeSeries: CurvePoint[],
  earliestTerminalHours?: number,
): number | null {
  // Anchor to the maximal NON-INCREASING suffix: walk back from the last sample while each
  // earlier median is ≥ the next, stopping at the last rise (a later dose / new input). This
  // keeps the fit inside one decline instead of spanning a second administration.
  const lastIdx = timeSeries.length - 1;
  if (lastIdx < 2) return null;
  let startIdx = lastIdx;
  while (
    startIdx - 1 >= 0 &&
    timeSeries[startIdx - 1]!.median >= timeSeries[startIdx]!.median
  ) {
    startIdx--;
  }
  let tail = timeSeries.slice(startIdx).filter((p) => p.median > 0);
  // Additionally exclude anything at or before the last input's end: even a dose that only
  // slows the decline (no visible rise) must not be inside the fitted window.
  if (
    earliestTerminalHours !== undefined &&
    Number.isFinite(earliestTerminalHours)
  ) {
    tail = tail.filter((p) => p.tHours >= earliestTerminalHours);
  }
  if (tail.length < 3) return null;

  let maxAdjR2 = -Infinity;
  scanTerminalWindows(tail, (_count, _slope, adjR2) => {
    if (adjR2 > maxAdjR2) maxAdjR2 = adjR2;
  });
  if (!Number.isFinite(maxAdjR2)) return null; // no declining window at all
  // Absolute log-linearity floor (standard NCA λz acceptance): even the best-fitting window
  // must be genuinely log-linear. A curved profile that has not reached its terminal phase —
  // saturable elimination, an ongoing input, a distribution phase — has a poor fit on every
  // window (e.g. [100, 99, 1] gives adjusted R² ≈ 0.5), and must yield null rather than a
  // coincidental slope. The engine's reported curve is a smooth deterministic median, so a
  // true terminal segment sits at adjusted R² ≈ 1; 0.9 rejects the curved cases with margin.
  if (maxAdjR2 < MIN_TERMINAL_ADJ_R2) return null;

  // Among windows within 1e-4 of the global maximum, prefer the one with the most points.
  // `count` increases across the scan, so the last qualifying window has the most points.
  let bestSlope: number | null = null;
  let bestCount = 0;
  scanTerminalWindows(tail, (count, slope, adjR2) => {
    if (adjR2 >= maxAdjR2 - 1e-4 && count > bestCount) {
      bestCount = count;
      bestSlope = slope;
    }
  });
  return bestSlope === null ? null : Math.LN2 / -bestSlope;
}

/**
 * Whether `computed` matches `expected` within tolerance. A tolerance is honoured only when
 * it is a finite, non-negative number, and the expected value must itself be finite — a
 * fixture that accidentally supplies `Infinity`/`NaN`/negative tolerances (which
 * TypeScript's `number` does not exclude) must NOT let an arbitrary result pass as validated.
 */
function withinTolerance(
  computed: number,
  expected: ExpectedLandmark,
): boolean {
  if (!Number.isFinite(computed) || !Number.isFinite(expected.value))
    return false;
  const abs = Math.abs(computed - expected.value);
  const { absTol, relTol } = expected;
  if (
    absTol !== undefined &&
    Number.isFinite(absTol) &&
    absTol >= 0 &&
    abs <= absTol
  ) {
    return true;
  }
  if (
    relTol !== undefined &&
    Number.isFinite(relTol) &&
    relTol >= 0 &&
    abs <= Math.abs(expected.value) * relTol
  ) {
    return true;
  }
  return false;
}

function toleranceLabel(e: ExpectedLandmark): string {
  const parts: string[] = [];
  // Preserve the configured tolerance in the committed report: a fixed 1-decimal percent
  // rounds a small relTol (e.g. 0.0004 → "0.0%") to a value `withinTolerance` never used,
  // making a pass un-auditable. Trim float noise without dropping magnitude.
  if (e.relTol !== undefined) parts.push(`±${trimNumber(e.relTol * 100)}%`);
  if (e.absTol !== undefined) parts.push(`±${trimNumber(e.absTol)}`);
  return parts.join(" or ") || "(none)";
}

/** String form of a number that keeps its magnitude (no fixed-decimal rounding to zero) while
 * dropping binary-float noise — `0.04` stays `0.04`, `20` stays `20`, `0.0001` stays `0.0001`. */
function trimNumber(n: number): string {
  return Number.isFinite(n) ? String(Number(n.toPrecision(6))) : String(n);
}

/**
 * Compute a landmark set from an OK result's reported curve (the same non-compartmental
 * quantities a validation source reports). Cmax/Tmax come straight from the reported peak;
 * AUC and terminal t½ are computed from the median time series. `earliestTerminalHours`
 * (when provided) bounds the terminal half-life to after the last input ended.
 */
export function computeLandmarks(
  result: Extract<CanonicalResult, { ok: true }>,
  earliestTerminalHours?: number,
): {
  cmax: number;
  tmaxHours: number;
  aucLast: number;
  terminalHalfLifeHours: number | null;
} {
  return {
    cmax: result.peak.concentration,
    tmaxHours: result.peak.tHours,
    aucLast: computeAucLast(result.timeSeries),
    terminalHalfLifeHours: estimateTerminalHalfLife(
      result.timeSeries,
      earliestTerminalHours,
    ),
  };
}

/**
 * The hour by which the last input has ended = max over the scenario's doses of
 * `dose.tHours + input-duration`, where the input duration is the resolved infusion / zero-order
 * release length for that dose's route (0 for a bolus or a first-order absorption route). Used to
 * bound the terminal phase after administration, catching an input that only slows the decline
 * without a visible concentration rise. Returns undefined when there are no doses.
 */
function lastInputEndHours(
  scenario: CanonicalScenario,
  result: Extract<CanonicalResult, { ok: true }>,
): number | undefined {
  const doses = scenario.doses;
  if (!doses || doses.length === 0) return undefined;
  // A dose scheduled after the reported window is ignored by the simulator (it cannot affect any
  // reported sample), so it must not move the terminal cutoff either — otherwise the bound could
  // exceed every sample and null a curve that is unchanged.
  const series = result.timeSeries;
  if (series.length === 0) return undefined;
  const lastReportedHours = series[series.length - 1]!.tHours;
  // Per route: the absorption lag (when the input onset begins) and the active zero-order /
  // infusion duration. The duration counts only when its pathway carries mass — a mixed-order
  // route resolved with firstOrderFraction === 1 collapses to pure first-order absorption, so
  // its declared zero-order duration is inert (matching the peak-refinement gate).
  const routeInput = new Map<
    string,
    { lag: number; activeDuration: number; instantaneous: boolean }
  >();
  for (const r of result.modelSummary.routes) {
    const activeDuration =
      r.firstOrderFraction === 1 ? 0 : (r.infusionDurationHours ?? 0);
    routeInput.set(r.route, {
      lag: r.absorptionLagHours ?? 0,
      activeDuration,
      // An instantaneous input (IV bolus) delivers its full dose AT the onset instant, so its
      // concentration is nonzero at the onset sample; a first-order (ka) or zero-order / infusion
      // input is zero at onset and only builds afterwards.
      instantaneous: r.kaPerHour === null && activeDuration === 0,
    });
  }
  let end = -Infinity;
  for (const d of doses) {
    const info = routeInput.get(d.route) ?? {
      lag: 0,
      activeDuration: 0,
      instantaneous: false,
    };
    const onset = d.tHours + info.lag;
    if (info.instantaneous) {
      // A bolus affects samples at t ≥ onset, so it bounds the phase when its onset is within
      // the reported window (including the boundary); only a strictly-post-window bolus, which
      // the simulator ignores, is skipped. Its input ends at the onset instant.
      if (onset > lastReportedHours) continue;
      if (onset > end) end = onset;
    } else {
      // A gradual input is zero at its onset, so an onset at or beyond the last reported sample
      // cannot affect any reported point (as the simulator likewise ignores it) and must not
      // bound the phase — else the cutoff jumps to the final timestamp and nulls an unchanged curve.
      if (onset >= lastReportedHours) continue;
      const inputEnd = onset + info.activeDuration;
      if (inputEnd > end) end = inputEnd;
    }
  }
  return Number.isFinite(end) ? end : undefined;
}

/**
 * Run the engine on a fixture's scenario and compare each asserted landmark against its
 * expectation. When the simulation fails, `simulated` is false and no comparisons are
 * produced (the fixture cannot be judged). A fixture that asserts a landmark the engine
 * cannot compute (e.g. no resolvable terminal phase) records `computed: null` and fails
 * that comparison rather than silently passing.
 */
export function validateFixture(
  fixture: ValidationFixture,
  nowIso: string,
): FixtureValidationReport {
  // Provenance is intrinsic to an external-validation fixture: without a cited source the
  // fixture cannot establish which literature value was tested, so it is not validatable.
  // Blank / whitespace-only entries do not count as a source — keep only real citations.
  const references = (fixture.references ?? []).filter(
    (r) => r.trim().length > 0,
  );
  if (references.length === 0) {
    return {
      fixtureId: fixture.id,
      references,
      simulated: false,
      failure:
        "missing-provenance: an external-validation fixture requires at least one literature reference",
      comparisons: [],
      passed: false,
    };
  }
  const result = simulateScenario(fixture.scenario, nowIso);
  if (!result.ok) {
    return {
      fixtureId: fixture.id,
      references,
      simulated: false,
      failure: `${result.failure}: ${result.detail}`,
      comparisons: [],
      passed: false,
    };
  }
  const landmarks = computeLandmarks(
    result,
    lastInputEndHours(fixture.scenario, result),
  );
  const comparisons: LandmarkComparison[] = [];
  const add = (
    name: LandmarkComparison["landmark"],
    computed: number | null,
    expected: ExpectedLandmark | undefined,
  ): void => {
    if (!expected) return;
    comparisons.push({
      landmark: name,
      expected: expected.value,
      computed,
      tolerance: toleranceLabel(expected),
      pass: computed !== null && withinTolerance(computed, expected),
    });
  };
  add("cmax", landmarks.cmax, fixture.expected.cmax);
  add("tmaxHours", landmarks.tmaxHours, fixture.expected.tmaxHours);
  add("aucLast", landmarks.aucLast, fixture.expected.aucLast);
  add(
    "terminalHalfLifeHours",
    landmarks.terminalHalfLifeHours,
    fixture.expected.terminalHalfLifeHours,
  );
  return {
    fixtureId: fixture.id,
    references,
    simulated: true,
    comparisons,
    passed: comparisons.length > 0 && comparisons.every((c) => c.pass),
  };
}

/**
 * Render a set of fixture reports as a Markdown table — one row per landmark comparison,
 * plus a per-fixture pass/fail line — so an external-validation run is a committable,
 * diffable artifact (the same shape a CI gate can assert against).
 */
export function renderValidationReport(
  reports: FixtureValidationReport[],
): string {
  const lines: string[] = [];
  lines.push("# kinetics-core external validation report");
  lines.push("");
  const passedCount = reports.filter((r) => r.passed).length;
  lines.push(`- **Fixtures:** ${reports.length}`);
  lines.push(`- **Passed:** ${passedCount} / ${reports.length}`);
  lines.push("");
  for (const r of reports) {
    lines.push(`## ${r.fixtureId} — ${r.passed ? "✅ pass" : "❌ fail"}`);
    lines.push("");
    if (r.references.length > 0) {
      lines.push(`**Source:** ${r.references.join("; ")}`);
      lines.push("");
    }
    if (!r.simulated) {
      lines.push(`Not validated: \`${r.failure}\``);
      lines.push("");
      continue;
    }
    lines.push("| Landmark | Expected | Computed | Tolerance | Result |");
    lines.push("|---|---|---|---|---|");
    for (const c of r.comparisons) {
      const computed = c.computed === null ? "—" : fmtNum(c.computed);
      lines.push(
        `| ${c.landmark} | ${fmtNum(c.expected)} | ${computed} | ${c.tolerance} | ` +
          `${c.pass ? "✅" : "❌"} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toPrecision(4);
}

/** Version of the machine-readable scientific-validation fixture contract. */
export const VALIDATION_SUITE_VERSION = "1.0.0";

export type ValidationEndpoint =
  | "dimensional-consistency"
  | "mass-balance"
  | "solver-convergence"
  | "event-timing"
  | "literature-landmark"
  | "observed-concentration"
  | "stochastic-interval-coverage"
  | "paired-matrix-transform";

export interface ReviewedSource {
  id: string;
  citation: string;
  locator: string;
  /** Review is a human evidence decision, not a successful parity test. */
  reviewedBy: string;
  reviewedAt: string;
  evidenceKind:
    | "external-literature"
    | "observed-dataset"
    | "internal-invariant";
  /** Scientific endpoints this source actually supports; provenance is never fixture-wide. */
  endpoints: ValidationEndpoint[];
}

export type SuiteCheck =
  | { endpoint: "dimensional-consistency" }
  | {
      endpoint: "mass-balance";
      doseMg: number;
      volumeLiters: number;
      atHours: number;
      relTol: number;
    }
  | {
      endpoint: "event-timing";
      eventHours: number;
      beforeMax?: number;
      atMin?: number;
      afterMin?: number;
    }
  | {
      endpoint: "literature-landmark";
      landmark: LandmarkComparison["landmark"];
      expected: ExpectedLandmark;
    }
  | {
      endpoint: "observed-concentration";
      observations: Array<{
        tHours: number;
        valueMgPerL: number;
        relTol?: number;
        absTol?: number;
      }>;
    }
  | {
      endpoint: "stochastic-interval-coverage";
      observations: Array<{ tHours: number; valueMgPerL: number }>;
      minimumFraction: number;
      interval: "p05-p95" | "p25-p75";
    }
  | {
      endpoint: "solver-convergence";
      refinedScenario: CanonicalScenario;
      endpointLandmark: "cmax" | "aucLast";
      relTol: number;
    }
  | {
      endpoint: "paired-matrix-transform";
      observedMatrix: CanonicalScenario["matrix"];
      ratio: number;
      relTol: number;
    };

export interface VersionedValidationFixture {
  fixtureVersion: 1;
  suiteVersion: string;
  id: string;
  description: string;
  modelId: string;
  /** Exact release selectors make fixture impact selection deterministic in CI. */
  selectors: {
    coreVersions: string[];
    registryVersions: string[];
    registryChecksums?: string[];
    solvers: Array<"closed-form" | "rk4">;
    parameterSets: string[];
  };
  scenario: CanonicalScenario;
  sources: ReviewedSource[];
  checks: SuiteCheck[];
}

export interface ScientificCheckResult {
  modelId: string;
  fixtureId: string;
  endpoint: ValidationEndpoint;
  passed: boolean;
  detail: string;
  /** Only externally reviewed evidence can confer this status. */
  externallyValidated: boolean;
}

export interface VersionedValidationReport {
  suiteVersion: string;
  coreVersion: string;
  registryVersion: string;
  registryChecksum: string;
  generatedAtIso: string;
  results: ScientificCheckResult[];
  passed: boolean;
}

function interpolate(points: CurvePoint[], t: number): CurvePoint | null {
  const exact = points.find((p) => p.tHours === t);
  if (exact) return exact;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a.tHours < t && t < b.tHours) {
      const f = (t - a.tHours) / (b.tHours - a.tHours);
      const lerp = (x: keyof CurvePoint) => a[x] + (b[x] - a[x]) * f;
      return {
        tHours: t,
        median: lerp("median"),
        p05: lerp("p05"),
        p25: lerp("p25"),
        p75: lerp("p75"),
        p95: lerp("p95"),
      };
    }
  }
  return null;
}

/** Run all independent scientific endpoints in a versioned fixture. */
export function validateVersionedFixture(
  fixture: VersionedValidationFixture,
  nowIso: string,
): ScientificCheckResult[] {
  const result = simulateScenario(fixture.scenario, nowIso);
  if (!result.ok)
    return fixture.checks.map((check) => ({
      modelId: fixture.modelId,
      fixtureId: fixture.id,
      endpoint: check.endpoint,
      passed: false,
      externallyValidated: false,
      detail: `${result.failure}: ${result.detail}`,
    }));
  const landmarks = computeLandmarks(
    result,
    lastInputEndHours(fixture.scenario, result),
  );
  const native = result.timeSeries;
  const emit = (
    check: SuiteCheck,
    passed: boolean,
    detail: string,
  ): ScientificCheckResult => {
    const externalSource = fixture.sources.some(
      (s) =>
        s.evidenceKind !== "internal-invariant" &&
        s.endpoints.includes(check.endpoint) &&
        s.reviewedBy.trim() &&
        s.locator.trim(),
    );
    return {
      modelId: fixture.modelId,
      fixtureId: fixture.id,
      endpoint: check.endpoint,
      passed,
      detail,
      // Numerical parity/invariants can never promote a model to externally validated.
      externallyValidated: passed && externalSource,
    };
  };
  return fixture.checks.map((check) => {
    if (check.endpoint === "dimensional-consistency") {
      const pass =
        result.unit === "mg/L" &&
        native.every(
          (p, i) =>
            Number.isFinite(p.tHours) &&
            p.tHours >= (native[i - 1]?.tHours ?? -Infinity) &&
            [p.p05, p.p25, p.median, p.p75, p.p95].every(Number.isFinite) &&
            p.p05 >= 0 &&
            p.p05 <= p.p25 &&
            p.p25 <= p.median &&
            p.median <= p.p75 &&
            p.p75 <= p.p95,
        );
      return emit(
        check,
        pass,
        `model=${fixture.modelId}; unit=${result.unit}; ordered finite mg/L curve=${pass}`,
      );
    }
    if (check.endpoint === "mass-balance") {
      const p = interpolate(native, check.atHours);
      const recovered = p === null ? null : p.median * check.volumeLiters;
      const pass =
        recovered !== null &&
        Math.abs(recovered - check.doseMg) <=
          Math.abs(check.doseMg) * check.relTol;
      return emit(
        check,
        pass,
        `model=${fixture.modelId}; endpoint=mass at ${check.atHours}h; expected=${check.doseMg}mg; recovered=${recovered ?? "unavailable"}mg`,
      );
    }
    if (check.endpoint === "event-timing") {
      const before = interpolate(
        native,
        check.eventHours - fixture.scenario.timeGrid.stepHours,
      )?.median;
      const at = interpolate(native, check.eventHours)?.median;
      const after = interpolate(
        native,
        check.eventHours + fixture.scenario.timeGrid.stepHours,
      )?.median;
      const pass =
        before !== undefined &&
        at !== undefined &&
        after !== undefined &&
        (check.beforeMax === undefined || before <= check.beforeMax) &&
        (check.atMin === undefined || at >= check.atMin) &&
        (check.afterMin === undefined || after >= check.afterMin);
      return emit(
        check,
        pass,
        `model=${fixture.modelId}; endpoint=event at ${check.eventHours}h; before=${before}; at=${at}; after=${after}`,
      );
    }
    if (check.endpoint === "literature-landmark") {
      const computed = landmarks[check.landmark];
      const pass =
        computed !== null && withinTolerance(computed, check.expected);
      return emit(
        check,
        pass,
        `model=${fixture.modelId}; endpoint=${check.landmark}; expected=${check.expected.value}; computed=${computed}`,
      );
    }
    if (check.endpoint === "observed-concentration") {
      const failed = check.observations.filter((o) => {
        const p = interpolate(native, o.tHours);
        return (
          !p ||
          !withinTolerance(p.median, {
            value: o.valueMgPerL,
            relTol: o.relTol,
            absTol: o.absTol,
          })
        );
      });
      return emit(
        check,
        failed.length === 0 && check.observations.length > 0,
        `model=${fixture.modelId}; endpoint=observed concentration-time; failed=${failed.length}/${check.observations.length}`,
      );
    }
    if (check.endpoint === "stochastic-interval-coverage") {
      const covered = check.observations.filter((o) => {
        const p = interpolate(native, o.tHours);
        if (!p) return false;
        return check.interval === "p05-p95"
          ? o.valueMgPerL >= p.p05 && o.valueMgPerL <= p.p95
          : o.valueMgPerL >= p.p25 && o.valueMgPerL <= p.p75;
      }).length;
      const fraction = check.observations.length
        ? covered / check.observations.length
        : 0;
      return emit(
        check,
        fraction >= check.minimumFraction,
        `model=${fixture.modelId}; endpoint=${check.interval} coverage; coverage=${fraction}`,
      );
    }
    if (check.endpoint === "solver-convergence") {
      const refined = simulateScenario(check.refinedScenario, nowIso);
      const coarseValue =
        check.endpointLandmark === "aucLast"
          ? landmarks.aucLast
          : landmarks.cmax;
      const refinedValue = refined.ok
        ? computeLandmarks(refined)[check.endpointLandmark]
        : null;
      const pass =
        refinedValue !== null &&
        withinTolerance(coarseValue, {
          value: refinedValue,
          relTol: check.relTol,
        });
      return emit(
        check,
        pass,
        `model=${fixture.modelId}; endpoint=${check.endpointLandmark} solver convergence; coarse=${coarseValue}; refined=${refinedValue}`,
      );
    }
    const paired = simulateScenario(
      { ...fixture.scenario, matrix: check.observedMatrix },
      nowIso,
    );
    const ratios = paired.ok
      ? native.map((p, i) =>
          p.median === 0
            ? true
            : Math.abs(
                (paired.timeSeries[i]?.median ?? NaN) / p.median - check.ratio,
              ) <=
              check.relTol * Math.abs(check.ratio),
        )
      : [];
    return emit(
      check,
      paired.ok && ratios.length === native.length && ratios.every(Boolean),
      `model=${fixture.modelId}; endpoint=paired matrix ${result.matrix}->${check.observedMatrix}; expected ratio=${check.ratio}`,
    );
  });
}

export function validateVersionedSuite(
  fixtures: VersionedValidationFixture[],
  nowIso: string,
): VersionedValidationReport {
  const selected = fixtures.filter(
    (f) =>
      f.suiteVersion === VALIDATION_SUITE_VERSION &&
      f.selectors.coreVersions.includes(CORE_VERSION) &&
      f.selectors.registryVersions.includes(REGISTRY_VERSION) &&
      (!f.selectors.registryChecksums ||
        f.selectors.registryChecksums.includes(REGISTRY_CHECKSUM)),
  );
  const results = selected.flatMap((f) => validateVersionedFixture(f, nowIso));
  return {
    suiteVersion: VALIDATION_SUITE_VERSION,
    coreVersion: CORE_VERSION,
    registryVersion: REGISTRY_VERSION,
    registryChecksum: REGISTRY_CHECKSUM,
    generatedAtIso: nowIso,
    results,
    passed:
      selected.length > 0 &&
      results.length > 0 &&
      results.every((r) => r.passed),
  };
}

/** Stable Markdown artifact; passing and failing endpoints are equally visible in diffs. */
export function renderVersionedValidationReport(
  report: VersionedValidationReport,
  previous?: VersionedValidationReport,
): string {
  const old = new Map(
    previous?.results.map((r) => [`${r.fixtureId}:${r.endpoint}`, r.passed]),
  );
  return [
    `# kinetics-core validation suite ${report.suiteVersion}`,
    "",
    `Core: \`${report.coreVersion}\` · Registry: \`${report.registryVersion}\` (\`${report.registryChecksum}\`)`,
    "",
    "| Model | Fixture | Scientific endpoint | Result | Evidence status | Change | Detail |",
    "|---|---|---|---|---|---|---|",
    ...report.results.map((r) => {
      const before = old.get(`${r.fixtureId}:${r.endpoint}`);
      const change =
        before === undefined
          ? "new"
          : before === r.passed
            ? "unchanged"
            : `${before ? "pass" : "fail"} → ${r.passed ? "pass" : "fail"}`;
      return `| ${r.modelId} | ${r.fixtureId} | ${r.endpoint} | ${r.passed ? "✅ pass" : "❌ fail"} | ${r.externallyValidated ? "externally validated" : "implementation/invariant only"} | ${change} | ${r.detail.split("|").join("\\|")} |`;
    }),
    "",
  ].join("\n");
}
