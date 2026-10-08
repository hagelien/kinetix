/**
 * Forward adapter: Kinetix modeling ⇄ kinetics-core (SC-0A).
 *
 * The roadmap's SC-0 makes Kinetix forward modeling call the shared
 * `kinetics-core` engine instead of its duplicate one-compartment worker path
 * (docs/kinetics-core/roadmap.md §0). This module is the translation layer:
 *
 *   toCanonicalScenario()        — Kinetix request → core `CanonicalScenario`
 *   coreResultToMonteCarloResult() — core `CanonicalResult` → `MonteCarloResult`
 *
 * It is pure plumbing — no PK science lives here. The engine reads its
 * parameters from the pinned registry keyed by analyte, so a scenario carries
 * NO half-life/Vd/F/ka: switching a drug onto the core path means its forward
 * curve becomes registry-driven rather than catalog/override-driven.
 *
 * This is the only adapter used by the modeling worker. Wiring responsibilities:
 *   - Matrix: the core emits its model's matrix (usually `plasma`), but the
 *     chart pipeline treats a modeled curve as whole blood before applying
 *     display-matrix factors. PR-C must pass a `toDisplay` that converts from
 *     `result.matrix` to whole blood using the drug's blood:plasma ratio (or
 *     carry `result.matrix` into the stored result so the chart converts it) —
 *     otherwise plasma values are mis-scaled against whole-blood overlays.
 *   - Model provenance: `monteCarloResultToDrugSimResult()` re-derives
 *     assumptions from the legacy catalog/config and stamps a generic
 *     one-compartment model. PR-C must thread the core `modelSummary`
 *     (model id, family, resolved route params) and manifest into the stored
 *     `DrugSimResult`, so a 2-comp/MM run isn't reported as one-compartment and
 *     the displayed parameters are the ones that actually produced the curve.
 *   - Limitation localization: the core's limitation `text` is accurate English
 *     that embeds specifics (route, scaling, covariate, counts) it does not
 *     expose as structured params. Localizing it needs the core to emit those
 *     params (a kinetics-core change) so a translation stays faithful — a
 *     generic key would drop or misstate them. Until then the accurate English
 *     `text` is surfaced as-is.
 */
import {
  SCENARIO_SCHEMA_VERSION,
  resolveModel,
  resolvableAnalyteIds,
  type CanonicalDoseEvent,
  type CanonicalResultOk,
  type CanonicalScenario,
  type CanonicalSubject,
  type CurvePoint,
  type DoseBasis,
  type RouteId,
} from '@/lib/kinetics-core';
import type {
  MonteCarloResult,
  RouteType,
  SimulationWarning,
  UncertaintyPoint,
} from '@/types/simulator';

/**
 * Kinetix `RouteType` → core `RouteId`. Every current Kinetix route maps; the
 * only rename is `insufflation` → the core's `intranasal`.
 */
const ROUTE_ID: Record<RouteType, RouteId> = {
  iv: 'iv',
  oral: 'oral',
  insufflation: 'intranasal',
  inhalation: 'inhalation',
  other: 'other',
};

/**
 * The kinetics-core analyte id to run a drug under: the first candidate the rendering release
 * resolves, else the last candidate (so an unresolvable drug still reports a meaningful id in
 * its "not in the registry" reason). Callers pass the drug's catalog slug first — a
 * catalog-derived model is keyed by it, and it often differs from the English display name
 * (`paracetamol-acetaminophen`, `metadon`) — then the name-derived id the reviewed models use
 * (`ethanol`, `ghb`).
 */
export function coreAnalyteFor(candidates: readonly (string | undefined)[]): string {
  const present = candidates.filter((c): c is string => typeof c === 'string' && c.length > 0);
  const resolvable = new Set(resolvableAnalyteIds());
  return present.find((c) => resolvable.has(c)) ?? present[present.length - 1] ?? '';
}

/** The core `RouteId` a Kinetix route maps to. Exported so the grade path can look up a
 *  route-keyed record for the same route the run used, rather than re-deriving the map. */
export function routeIdFor(route: RouteType): RouteId {
  return ROUTE_ID[route];
}

export interface ForwardCoreRequest {
  /** kinetics-core registry analyte id or alias (see `supportedAnalyteIds()`). */
  analyte: string;
  route: RouteType;
  /** `weightKg` is required by the core; extra covariates gate lean/widmark Vd. */
  subject: CanonicalSubject;
  /**
   * Doses already normalized to mg, on the SAME absolute time axis as
   * `timeRange` (t = 0 is the scenario origin, not "relative to the first
   * dose" — the legacy worker's relativization is dropped here). Each dose may
   * override `route`; the core models routes per dose, so a mixed-route case is
   * preserved rather than flattened onto the request route.
   */
  doses: Array<{
    amountMg: number;
    tHours: number;
    durationHours?: number;
    route?: RouteType;
  }>;
  timeRange: { start: number; end: number; steps: number };
  /** What the dose mass represents. Defaults to the model's basis (parent-first). */
  basis?: DoseBasis;
  /** Omit for a deterministic, median-only run. */
  uncertainty?: { seed: number; draws: number };
}

export type ToCanonicalScenarioResult =
  | { ok: true; scenario: CanonicalScenario }
  | { ok: false; unsupported: string };

/**
 * Build a core `CanonicalScenario` from a Kinetix forward request, or return a
 * structured `unsupported` reason when the core registry can't serve it (unknown
 * analyte, a route the model doesn't declare, an unsupported dose basis, or an
 * empty/degenerate window). The caller falls back to the legacy path on
 * `unsupported` rather than surfacing a failure.
 */
export function toCanonicalScenario(
  req: ForwardCoreRequest,
): ToCanonicalScenarioResult {
  const unsupported = (reason: string): ToCanonicalScenarioResult => ({
    ok: false,
    unsupported: reason,
  });

  const { start, end, steps } = req.timeRange;
  if (!(steps > 0) || !(end > start)) {
    return unsupported(
      `invalid time range [${start}, ${end}] over ${steps} steps`,
    );
  }
  if (req.doses.length === 0) {
    return unsupported('no doses to simulate');
  }

  // Resolve through the RENDERING release (reviewed tier, plus the committed derived
  // tier when the rollout flag is on) rather than the reviewed tier alone. An override
  // always wins a shared analyte, so a reviewed model is never displaced by a derived one.
  const model = resolvableAnalyteIds().includes(req.analyte)
    ? resolveModel(req.analyte)
    : undefined;
  if (!model) {
    return unsupported(
      `analyte "${req.analyte}" is not in the kinetics-core registry`,
    );
  }

  // Validate every dose's route — each may override the request-level default,
  // and the core models routes per dose, so a route the model doesn't declare
  // on ANY dose sends the whole case to the legacy path.
  for (const d of req.doses) {
    const routeType = d.route ?? req.route;
    const routeId = ROUTE_ID[routeType];
    if (!model.routes[routeId]) {
      return unsupported(
        `route "${routeType}" (${routeId}) is not modeled for "${req.analyte}"`,
      );
    }
  }

  // Basis: honour an explicit request; otherwise prefer `parent`, else the
  // model's first declared basis. A basis the model can't consume is rejected
  // rather than silently mis-scaled.
  const basis: DoseBasis | undefined =
    req.basis ??
    (model.supportedBases.includes('parent')
      ? 'parent'
      : model.supportedBases[0]);
  if (!basis || !model.supportedBases.includes(basis)) {
    return unsupported(
      `dose basis "${req.basis ?? basis ?? 'none'}" is not supported for "${req.analyte}"`,
    );
  }

  // Infusion duration is a registry-route property in the core, not a per-dose
  // field — so a user-entered `durationHours` can't be honoured. Rather than
  // silently simulate an infusion as an instantaneous bolus (a materially
  // different peak/curve), reject it so the caller falls back to the legacy
  // worker. SC-0A is bolus-only.
  if (req.doses.some((d) => (d.durationHours ?? 0) > 0)) {
    return unsupported(
      'per-dose infusion duration is not modeled by the core (SC-0A is bolus-only)',
    );
  }

  const doses: CanonicalDoseEvent[] = req.doses.map((d) => ({
    tHours: d.tHours,
    amountMg: d.amountMg,
    route: ROUTE_ID[d.route ?? req.route],
    basis,
  }));

  const scenario: CanonicalScenario = {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    analyte: req.analyte,
    subject: req.subject,
    doses,
    timeGrid: {
      startHours: start,
      endHours: end,
      stepHours: (end - start) / steps,
    },
    ...(req.uncertainty ? { uncertainty: req.uncertainty } : {}),
  };
  return { ok: true, scenario };
}

export interface CoreResultToMonteCarloOptions {
  drugConfigId: string;
  /**
   * Query time on the SAME (absolute) axis as the core grid, used to interpolate
   * the scalar point estimate. The scalar is a concentration, so it is unaffected
   * by `originHours`.
   */
  queryTimeHours: number;
  /**
   * Origin (in hours) to subtract from each emitted point's time, converting the
   * core's absolute axis back to the legacy dose-relative frame that
   * `MonteCarloResult.timeSeries` uses. Pass the SAME value the downstream chart
   * re-adds — `mcCurveAnchor(config)`, i.e. the earliest applicable dose time —
   * NOT the grid start (they differ when the first dose isn't at the grid
   * origin: a 0–24 grid with the first dose at hour 5 anchors on 5, not 0).
   * Without this, a curve beginning at absolute hour 5 would render at hour 10.
   * Defaults to 0.
   */
  originHours?: number;
  /** mg/L → the caller's display unit. Defaults to identity (the core emits mg/L). */
  toDisplay?: (mgPerL: number) => number;
  /** Display-unit label. Defaults to `'mg/L'`. */
  unit?: string;
}

type Band = Pick<CurvePoint, 'median' | 'p05' | 'p25' | 'p75' | 'p95'>;

/**
 * Map a successful core result onto the legacy `MonteCarloResult` shape, so the
 * rest of the modeling pipeline (`monteCarloResultToDrugSimResult`, chart
 * layout, …) consumes it unchanged. The scalar point estimate is the band
 * linearly interpolated at `queryTimeHours`; the core's `limitations` become
 * `model-limitation` warnings. Bands are passed through as the core produced
 * them (deterministic runs collapse every percentile onto the median).
 */
export function coreResultToMonteCarloResult(
  result: CanonicalResultOk,
  opts: CoreResultToMonteCarloOptions,
): MonteCarloResult {
  const conv = opts.toDisplay ?? ((v: number) => v);
  const origin = opts.originHours ?? 0;
  const timeSeries: UncertaintyPoint[] = result.timeSeries.map((p) => ({
    t: p.tHours - origin,
    p05: conv(p.p05),
    p25: conv(p.p25),
    median: conv(p.median),
    p75: conv(p.p75),
    p95: conv(p.p95),
  }));
  const scalar = interpolateCoreBand(result.timeSeries, opts.queryTimeHours);
  // The core's limitation `text` is carried verbatim. It is accurate but
  // English, and it embeds specifics (route, scaling, covariate name, rejected-
  // draw counts) the core does NOT expose as structured params — so a generic
  // localized key would either drop or, worse, misstate them (e.g. the
  // sex-coefficient-fallback text says the female coefficient set was applied
  // for sex "other", not that no sex was given). Faithful bilingual
  // localization therefore needs the core to emit structured params; it's a
  // PR-C responsibility (see the wiring notes above), not something to fake here.
  const warnings: SimulationWarning[] = result.limitations.map((l) => ({
    type: 'model-limitation',
    message: l.text,
    severity: l.severity,
  }));
  return {
    drugConfigId: opts.drugConfigId,
    median: conv(scalar.median),
    p05: conv(scalar.p05),
    p25: conv(scalar.p25),
    p75: conv(scalar.p75),
    p95: conv(scalar.p95),
    unit: opts.unit ?? 'mg/L',
    timeSeries,
    warnings,
    sensitivity: [],
    seed: result.manifest.seed ?? 0,
    // Legacy `drawCount` means the VALID draw count (the samples that actually
    // contributed to the bands), so use the core's `acceptedDraws` when present
    // and fall back to the requested `draws` for deterministic/older results —
    // otherwise a run that rejected non-physical draws overstates its sample size.
    drawCount: result.manifest.acceptedDraws ?? result.manifest.draws ?? 0,
    canonicalResult: result,
  };
}

function band(p: CurvePoint): Band {
  return { median: p.median, p05: p.p05, p25: p.p25, p75: p.p75, p95: p.p95 };
}

const lerp = (a: number, b: number, w: number): number => a + (b - a) * w;

/**
 * Linear interpolation of every percentile at `t`, clamped to the endpoints.
 * Exported as `interpolateCoreBand` for callers that need to read a core curve
 * at one instant — e.g. calibrating a back-calculated dose against what the
 * model predicts at the measurement time.
 */
export function interpolateCoreBand(
  points: readonly CurvePoint[],
  t: number,
): Band {
  const first = points[0];
  if (!first) return { median: 0, p05: 0, p25: 0, p75: 0, p95: 0 };
  if (t <= first.tHours) return band(first);
  const last = points[points.length - 1]!;
  if (t >= last.tHours) return band(last);
  for (let i = 1; i < points.length; i += 1) {
    const b = points[i]!;
    if (t <= b.tHours) {
      const a = points[i - 1]!;
      const span = b.tHours - a.tHours;
      const w = span > 0 ? (t - a.tHours) / span : 0;
      return {
        median: lerp(a.median, b.median, w),
        p05: lerp(a.p05, b.p05, w),
        p25: lerp(a.p25, b.p25, w),
        p75: lerp(a.p75, b.p75, w),
        p95: lerp(a.p95, b.p95, w),
      };
    }
  }
  return band(last);
}
