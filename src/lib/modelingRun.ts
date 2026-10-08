import type { DrugComponent } from '@/types';
import type { DrugRow } from '@/lib/drugApi';
import type {
  ComponentEngine,
  DrugSimConfig,
  RouteType,
  DrugSimResult,
  MonteCarloConfig,
  MonteCarloResult,
  CanonicalSimulationConfig,
  ParameterProvenanceMap,
  SimEvent,
  SimulationAssumptions,
  SimulationWarning,
  UncertaintyPoint,
} from '@/types/simulator';
import type { InferenceInput } from '@/lib/compute/types';
import type {
  RunInferenceArgs,
  WorkerInferenceOutput,
} from '@/workers/inference.worker';
import {
  bacAtTime,
  estimateBacCurve,
  getWidmarkR,
  type EthanolIntake,
  type EthanolPersonParams,
} from '@/lib/ethanolEngine';
import { buildPriorsFromDrug } from '@/lib/compute/drugPriors';
import {
  validateLiteInferenceInput,
  isApproximatedModelCard,
  LiteInferenceError,
  LOW_ESS_RATIO,
  CRITICAL_ESS_RATIO,
} from '@/lib/compute/liteInference';
import type { PKModelCard } from '@/lib/compute/modelCards';
import { deriveQuestion } from '@/lib/eventDerivation';
import {
  modelFamilyLabel,
  modelFamilyLabelKey,
} from '@/lib/modelFamilyLabels';
import { distributionInterval } from '@/lib/distributionInterval';
import { hashRunInputs } from '@/lib/resultStaleness';
import { buildConfigWithDrugData } from '@/stores/simulatorStore';
import {
  convertDose,
  convertConcentration,
  isConcentrationUnit,
  isDoseUnit,
  normalizeUnit,
  type DoseUnit,
} from '@/lib/unitConversion';
import { isEthanolDrugId } from '@/lib/ethanolSimulator';
import {
  coreAnalyteFor,
  coreResultToMonteCarloResult,
  interpolateCoreBand,
  routeIdFor,
  toCanonicalScenario,
} from '@/lib/forwardCoreAdapter';
import {
  liveDerivedEntries,
  type CanonicalResult,
  type CanonicalResultOk,
} from '@/lib/kinetics-core';
import { refreshLiveDerivedModel } from '@/lib/liveDerivedModels';

/** The compute engine a component runs on, defaulting to Monte Carlo PK. */
export function getComponentEngine(config: DrugSimConfig): ComponentEngine {
  if (config.engine === 'ethanol-widmark' && !isEthanolDrugId(config.drugId)) {
    return 'pk-montecarlo';
  }
  return config.engine ?? 'pk-montecarlo';
}

const DEFAULT_ETHANOL_PARAMS: EthanolPersonParams = {
  weightKg: 70,
  biologicalSex: 'male',
  eliminationRateGdlPerHour: 0.015,
};

function positiveOrDefault(
  value: number | undefined,
  fallback: number,
): number {
  return value != null && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function positiveFinite(value: number | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}

function ethanolParamsFromConfig(config: DrugSimConfig): EthanolPersonParams {
  const p = config.ethanol;
  if (!p) {
    return {
      ...DEFAULT_ETHANOL_PARAMS,
      weightKg: positiveOrDefault(
        config.weight,
        DEFAULT_ETHANOL_PARAMS.weightKg,
      ),
    };
  }
  return {
    weightKg: positiveOrDefault(
      p.weightKg ?? config.weight,
      DEFAULT_ETHANOL_PARAMS.weightKg,
    ),
    biologicalSex:
      p.biologicalSex === 'female' || p.biologicalSex === 'male'
        ? p.biologicalSex
        : DEFAULT_ETHANOL_PARAMS.biologicalSex,
    eliminationRateGdlPerHour: positiveOrDefault(
      p.eliminationRateGdlPerHour,
      DEFAULT_ETHANOL_PARAMS.eliminationRateGdlPerHour,
    ),
    distributionRatioOverride: positiveOrDefault(
      p.distributionRatioOverride,
      0,
    ),
  };
}

function doseAmountToGrams(amount: number, unit: string): number | null {
  const normalized = normalizeUnit(unit);
  if (!isDoseUnit(normalized)) return null;
  return convertDose(amount, normalized as DoseUnit, 'g');
}

function doseAmountToMilligrams(amount: number, unit: string): number | null {
  const normalized = normalizeUnit(unit);
  if (!isDoseUnit(normalized)) return null;
  return convertDose(amount, normalized as DoseUnit, 'mg');
}

/**
 * Map a component's dose events onto ethanol intakes. For the ethanol engine a
 * dose event's amount is converted to grams of pure ethanol. Widmark applies to
 * absorbed oral ethanol, so non-oral routes are ignored by this engine.
 */
function ethanolIntakesFromEvents(events: SimEvent[]): EthanolIntake[] {
  return events
    .filter((e): e is Extract<SimEvent, { type: 'dose' }> => e.type === 'dose')
    .flatMap((e) => {
      if (
        e.route !== 'oral' ||
        e.t == null ||
        e.amount == null ||
        e.amount <= 0
      )
        return [];
      const ethanolGrams = doseAmountToGrams(e.amount, e.unit);
      if (ethanolGrams == null || ethanolGrams <= 0) return [];
      return [{ id: e.id, timeHour: e.t, ethanolGrams }];
    });
}

function concentrationQueryTime(events: SimEvent[]): number | null {
  const query = events
    .filter(
      (e): e is Extract<SimEvent, { type: 'query' }> =>
        e.type === 'query' && e.solveFor === 'concentration' && e.t != null,
    )
    .sort((a, b) => b.t! - a.t!)[0];
  return query?.t ?? null;
}

function ethanolQuestionMode(
  events: SimEvent[],
): DrugSimResult['questionMode'] {
  if (events.some((e) => e.type === 'query' && e.solveFor === 'dose')) {
    return 'dose-from-concentration';
  }
  const latestQuery = events
    .filter(
      (e): e is Extract<SimEvent, { type: 'query' }> =>
        e.type === 'query' && e.t != null,
    )
    .sort((a, b) => b.t! - a.t!)[0];
  return latestQuery?.solveFor === 'dose'
    ? 'dose-from-concentration'
    : 'concentration-from-dose';
}

function bacAtHour(
  intakes: EthanolIntake[],
  params: EthanolPersonParams,
  hour: number,
): number {
  // Reuse the chronological state model so the queried point estimate matches
  // the plotted curve and a single zero-order β governs the whole pool.
  return bacAtTime(intakes, params, hour);
}

/** A simulation window that comfortably contains the rise and clearance. */
function ethanolTimeRange(
  intakes: EthanolIntake[],
  params: EthanolPersonParams,
  queryTime: number | null,
): { fromHour: number; toHour: number; stepHours: number } {
  if (intakes.length === 0)
    return { fromHour: -2, toHour: 18, stepHours: 0.25 };
  const times = intakes.map((i) => i.timeHour);
  if (queryTime != null) times.push(queryTime);
  const minT = Math.min(...times);
  const maxIntakeT = Math.max(...intakes.map((i) => i.timeHour));
  const totalGrams = intakes.reduce(
    (sum, i) => sum + Math.max(0, i.ethanolGrams),
    0,
  );
  const r = getWidmarkR(params);
  const maxBac = totalGrams / (r * params.weightKg * 10);
  const clearHours =
    params.eliminationRateGdlPerHour > 0
      ? maxBac / params.eliminationRateGdlPerHour
      : 6;
  const fromHour = Math.min(0, minT) - 1;
  const toHour = Math.max(
    maxIntakeT + clearHours + 1,
    queryTime == null ? Number.NEGATIVE_INFINITY : queryTime + 1,
    fromHour + 6,
  );
  return { fromHour, toHour, stepHours: 0.25 };
}

/** Run the ethanol Widmark engine for a component and adapt to DrugSimResult. */
export function runEthanolComponent(config: DrugSimConfig): DrugSimResult {
  const questionMode = ethanolQuestionMode(config.events ?? []);
  if (questionMode !== 'concentration-from-dose') {
    throw new Error('Ethanol Widmark engine does not support dose solving');
  }
  const intakes = ethanolIntakesFromEvents(config.events ?? []);
  const params = ethanolParamsFromConfig(config);
  const queryTime = concentrationQueryTime(config.events ?? []);
  const range = ethanolTimeRange(intakes, params, queryTime);
  const curve = estimateBacCurve(intakes, params, range);
  const pointEstimate =
    queryTime == null
      ? curve.peakBacGdl
      : bacAtHour(intakes, params, queryTime);

  const timeSeries: UncertaintyPoint[] = curve.points.map((p) => ({
    t: p.t,
    // Deterministic engine: the band collapses onto the point estimate.
    p05: p.bacGdl,
    p25: p.bacGdl,
    median: p.bacGdl,
    p75: p.bacGdl,
    p95: p.bacGdl,
  }));

  return {
    drugConfigId: config.id,
    engine: 'ethanol-widmark',
    questionMode,
    median: pointEstimate,
    p05: pointEstimate,
    p25: pointEstimate,
    p75: pointEstimate,
    p95: pointEstimate,
    unit: 'g/dL',
    timeSeries,
    // The Widmark curve is built on the absolute intake clock already.
    anchorTime: 0,
    assumptions: {
      model: 'Widmark (zero-order elimination)',
      modelKey: 'assumptions.models.ethanolWidmark',
      route: 'oral',
      halfLife: { type: 'fixed', value: 0 },
      vd: { type: 'fixed', value: 0 },
      f: { type: 'fixed', value: 1 },
      weightScaling: true,
    },
    sensitivity: [],
    warnings: [],
    seed: 0,
    drawCount: 0,
  };
}

/**
 * Classify where each PK parameter came from: an explicit user override
 * (assumption), the drug's curated literature data (verified), or a generic
 * default used in the absence of either (fallback). Mirrors the resolution
 * order in `buildConfigWithDrugData`.
 */
export function resolveParameterProvenance(
  config: DrugSimConfig,
  drugComponent: DrugComponent | undefined,
): import('@/types/simulator').ParameterProvenanceMap {
  const classify = (
    override: unknown,
    literature: unknown,
  ): import('@/types/simulator').ParameterProvenance => {
    if (override != null) return 'assumption';
    if (literature != null) return 'verified';
    return 'fallback';
  };
  return {
    halfLife: classify(config.overrides.halfLife, drugComponent?.halfLife),
    vd: classify(config.overrides.vd, drugComponent?.volumeOfDistribution),
    f: classify(config.overrides.f, drugComponent?.bioavailability),
  };
}

/**
 * Absolute clock time (hours from the case reference) that a Monte Carlo curve's
 * `t = 0` maps to. The worker builds the curve in a mode-specific frame:
 *  - `concentration-from-dose` → relative to the earliest same-unit dose (the
 *    superposition origin `t0`); its `t=0` is that dose time.
 *  - `dose-from-concentration` → the concentration decays from the (single) dose
 *    time, so `t=0` is that dose time.
 *  - `earlier/later-from-*` → the worker already uses absolute measured/target
 *    times, so the curve is on the absolute frame (anchor 0).
 * Mirroring `buildSuperposedDoses`' same-unit filter keeps this in lockstep with
 * the worker's actual origin.
 */
function mcCurveAnchor(config: DrugSimConfig): number {
  const { questionMode, inputs } = deriveQuestion(config);
  if (
    questionMode === 'earlier-from-later' ||
    questionMode === 'later-from-earlier'
  ) {
    return 0;
  }
  const doseTimes = (config.events ?? [])
    .filter(
      (e) =>
        e.type === 'dose' &&
        e.t != null &&
        Number.isFinite(e.t) &&
        (questionMode !== 'concentration-from-dose' ||
          inputs.doseUnit == null ||
          e.unit === inputs.doseUnit),
    )
    .map((e) => e.t as number);
  return doseTimes.length > 0 ? Math.min(...doseTimes) : 0;
}

/**
 * Absolute clock time the KineLab posterior-predictive curve's `t = 0` maps to.
 * The predictive series is measured from the intake-window baseline
 * `windowRange[0]` (= the primary dose's `tRange[0] ?? t`, else the earliest
 * measurement), mirroring `buildInferenceInput`/`buildInferenceRunArgs`.
 */
function kinelabCurveAnchor(config: DrugSimConfig): number {
  const events = config.events ?? [];
  const measurementTimes = events
    .filter(
      (e): e is Extract<SimEvent, { type: 'measurement' }> =>
        e.type === 'measurement' && e.t != null && Number.isFinite(e.t),
    )
    .map((e) => e.t as number);
  const fallback =
    measurementTimes.length > 0 ? Math.min(...measurementTimes) : 0;
  const doseBaselines = events
    .filter((e): e is Extract<SimEvent, { type: 'dose' }> => e.type === 'dose')
    .map((d) => d.tRange?.[0] ?? d.t ?? fallback)
    .filter((h) => Number.isFinite(h));
  return doseBaselines.length > 0 ? Math.min(...doseBaselines) : fallback;
}

/**
 * The assumptions a CORE run actually ran under, read from its `modelSummary`.
 *
 * The legacy path re-derived these from the catalog config and stamped every
 * result `one-compartment, first-order elimination` — so a two-compartment or
 * Michaelis-Menten curve was reported as a family it is not, with half-life/Vd/F
 * that did not produce it. The engine reports the resolved route it used; this
 * reads that instead of guessing.
 *
 * Returns `null` for a failed or absent core result, so the caller keeps the
 * legacy derivation for the non-core engines (ethanol/Widmark, KineLab).
 */
function coreAssumptions(
  core: CanonicalResult | undefined,
  route: RouteType,
  weightScaling: boolean,
  provenance: ParameterProvenanceMap | undefined,
): SimulationAssumptions | null {
  if (!core?.ok) return null;
  const summary = core.modelSummary;
  // A scenario resolves one route per dose; the reported routes are those the
  // run actually used. Prefer the one matching the config's route, else the
  // single resolved route. With none there is nothing truthful to report.
  const resolved =
    summary.routes.find((r) => r.route === route) ?? summary.routes[0];
  if (!resolved) return null;
  return {
    model: modelFamilyLabel(resolved.family),
    modelKey: modelFamilyLabelKey(resolved.family),
    route,
    // The values that PRODUCED the curve, not the catalog's. These are the
    // RESOLVED central values the engine reports; the bands around the curve
    // come from the reviewed model's own parameter specs, so a `fixed` spec here
    // states the central value without claiming a spread it did not report. A
    // family with no separately identified F (IV, or an apparent-extravascular
    // clv route) reports F = 1 rather than inventing a fraction.
    halfLife: { type: 'fixed', value: resolved.eliminationHalfLifeHours },
    vd: { type: 'fixed', value: resolved.vdLiters },
    f: { type: 'fixed', value: resolved.bioavailability ?? 1 },
    weightScaling,
    provenance,
    ...(resolved.kaPerHour != null ? { absorptionKa: resolved.kaPerHour } : {}),
    modelId: summary.modelId,
    family: resolved.family,
    validationStatus: summary.validationStatus,
    nativeMatrix: core.matrix,
  };
}

/** Convert a Monte Carlo worker result into the stored DrugSimResult shape. */
export function monteCarloResultToDrugSimResult(
  result: MonteCarloResult,
  config: DrugSimConfig,
  drugComponent: DrugComponent | undefined,
): DrugSimResult {
  const mcConfig: MonteCarloConfig = buildConfigWithDrugData(
    config,
    drugComponent,
  );
  const { questionMode, route, warnings } = deriveQuestion(config);
  const provenance = resolveParameterProvenance(config, drugComponent);
  const assumptions: SimulationAssumptions = coreAssumptions(
    result.canonicalResult,
    route,
    mcConfig.weightScaling,
    provenance,
  ) ?? {
    // Legacy derivation, retained for a result with no core payload (an older
    // saved case, or a future non-core producer reusing this adapter).
    model: 'one-compartment, first-order elimination',
    modelKey: 'assumptions.models.oneCompartmentFirstOrder',
    route,
    halfLife: mcConfig.halfLife,
    vd: mcConfig.vd,
    f: mcConfig.f,
    weightScaling: mcConfig.weightScaling,
    provenance,
    absorptionKa: mcConfig.absorptionKa,
  };
  return {
    drugConfigId: result.drugConfigId,
    engine: 'pk-montecarlo',
    questionMode,
    median: result.median,
    p05: result.p05,
    p25: result.p25,
    p75: result.p75,
    p95: result.p95,
    unit: result.unit,
    timeSeries: result.timeSeries,
    anchorTime: mcCurveAnchor(config),
    assumptions,
    sensitivity: result.sensitivity,
    warnings: [...warnings, ...result.warnings],
    seed: result.seed,
    drawCount: result.drawCount,
    canonicalResult: result.canonicalResult,
  };
}

const INFERENCE_REFERENCE_ISO = '2026-01-01T00:00:00.000Z';

function hoursToIso(hours: number): string {
  return new Date(
    Date.parse(INFERENCE_REFERENCE_ISO) + hours * 3_600_000,
  ).toISOString();
}

function coerceNumericRange(
  value: DrugComponent['halfLife'],
): import('@/types').NumericRange | null {
  if (typeof value === 'number') return { median: value };
  return value ?? null;
}

function drugComponentToPriorRow(drug: DrugComponent | undefined): DrugRow {
  return {
    id: drug?._dbId ?? (Number(drug?.id) || 0),
    slug: drug?.id ?? 'component',
    names: drug?.names ?? {},
    nameShort: drug?.nameShort ?? null,
    aliases: drug?.aliases ?? null,
    pubchemCid: drug?.pubchemCid ?? (Number(drug?.id) || null),
    molecularWeight: drug?.molecularWeight ?? null,
    halfLife: coerceNumericRange(drug?.halfLife),
    volumeOfDistribution: coerceNumericRange(drug?.volumeOfDistribution),
    bioavailability: coerceNumericRange(drug?.bioavailability),
    proteinBinding: coerceNumericRange(drug?.proteinBinding),
    bloodPlasmaRatio: coerceNumericRange(drug?.bloodPlasmaRatio),
    tmax: coerceNumericRange(drug?.tmax),
    pKa: coerceNumericRange(drug?.pKa),
    therapeuticConcentration: coerceNumericRange(
      drug?.therapeuticConcentration,
    ),
    supratherapeuticConcentration: coerceNumericRange(
      drug?.supratherapeuticConcentration,
    ),
    impairmentConcentration: coerceNumericRange(drug?.impairmentConcentration),
    toxicConcentration: coerceNumericRange(drug?.toxicConcentration),
    fatalConcentration: coerceNumericRange(drug?.fatalConcentration),
    popularityScore: drug?._popularityScore ?? 0,
    searchKey: drug?._searchKey ?? null,
    createdAt: '',
    updatedAt: '',
  };
}

function analyteId(config: DrugSimConfig, drug: DrugComponent | undefined) {
  return (drug?.names.en ?? drug?.names.nb ?? config.drugName ?? config.drugId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function kinelabRoute(config: DrugSimConfig): InferenceInput['route'] {
  const dose = config.events.find(
    (e): e is Extract<SimEvent, { type: 'dose' }> => e.type === 'dose',
  );
  return dose?.route ?? config.route ?? 'oral';
}

function buildKinelabDosePrior(
  dose: Extract<SimEvent, { type: 'dose' }>,
): InferenceInput['priors']['dose'] {
  if (
    dose.amountRange &&
    positiveFinite(dose.amountRange.min) &&
    positiveFinite(dose.amountRange.max) &&
    dose.amountRange.max > dose.amountRange.min
  ) {
    const min = doseAmountToMilligrams(dose.amountRange.min, dose.unit);
    const max = doseAmountToMilligrams(dose.amountRange.max, dose.unit);
    if (min == null || max == null) {
      throw new Error('KineLab dose prior requires a supported mass unit');
    }
    return { type: 'uniform', min, max };
  }
  if (positiveFinite(dose.amount)) {
    const value = doseAmountToMilligrams(dose.amount, dose.unit);
    if (value == null) {
      throw new Error('KineLab dose prior requires a supported mass unit');
    }
    return { type: 'fixed', value };
  }
  throw new Error('KineLab inference requires a dose amount range');
}

function buildKinelabSubject(config: DrugSimConfig): InferenceInput['subject'] {
  const source = config.kinelab?.subject;
  const subject: NonNullable<InferenceInput['subject']> = {};
  const weightKg = source?.weightKg ?? config.weight;
  if (positiveFinite(weightKg)) subject.weightKg = weightKg;
  if (
    source?.sex === 'male' ||
    source?.sex === 'female' ||
    source?.sex === 'unknown'
  ) {
    subject.sex = source.sex;
  }
  if (
    source?.ageYears != null &&
    Number.isInteger(source.ageYears) &&
    source.ageYears >= 0
  ) {
    subject.age = source.ageYears;
  }
  return Object.keys(subject).length > 0 ? subject : undefined;
}

function kinelabConcentration(
  value: number,
  unit: string,
  molecularWeight: number | undefined,
): InferenceInput['observations'][number]['concentration'] {
  const normalized = normalizeUnit(unit);
  if (!isConcentrationUnit(normalized)) {
    throw new Error('KineLab measurement requires a supported unit');
  }
  if (
    normalized === 'mg/L' ||
    normalized === 'ng/mL' ||
    normalized === 'µg/L'
  ) {
    return { value, unit: normalized };
  }
  return {
    value: convertConcentration(value, normalized, 'mg/L', molecularWeight),
    unit: 'mg/L',
  };
}

/** Representative administration time (hours) of a dose event: its point time,
 *  the midpoint of its intake window, or a fallback when neither is set. */
function kinelabDoseHours(
  dose: Extract<SimEvent, { type: 'dose' }>,
  fallbackHours: number,
): number {
  if (dose.t != null && Number.isFinite(dose.t)) return dose.t;
  if (
    dose.tRange &&
    Number.isFinite(dose.tRange[0]) &&
    Number.isFinite(dose.tRange[1])
  ) {
    return (dose.tRange[0] + dose.tRange[1]) / 2;
  }
  return fallbackHours;
}

/** Representative dose amount in mg (point amount, or range midpoint), or null
 *  when it can't be resolved to a supported mass unit. */
function kinelabDoseAmountMg(
  dose: Extract<SimEvent, { type: 'dose' }>,
): number | null {
  const amount = positiveFinite(dose.amount)
    ? dose.amount
    : dose.amountRange &&
        positiveFinite(dose.amountRange.min) &&
        positiveFinite(dose.amountRange.max)
      ? (dose.amountRange.min + dose.amountRange.max) / 2
      : null;
  if (amount == null) return null;
  return doseAmountToMilligrams(amount, dose.unit);
}

/** Build the KineLab inference input from the unified component event model. */
export function buildInferenceInput(
  config: DrugSimConfig,
  drugComponent: DrugComponent | undefined,
): InferenceInput {
  const doseEvents = config.events.filter(
    (e): e is Extract<SimEvent, { type: 'dose' }> => e.type === 'dose',
  );
  if (doseEvents.length === 0) {
    throw new Error('KineLab inference requires a dose event');
  }

  const measurements = config.events.filter(
    (e): e is Extract<SimEvent, { type: 'measurement' }> =>
      e.type === 'measurement' &&
      positiveFinite(e.value) &&
      e.t != null &&
      Number.isFinite(e.t),
  );
  if (measurements.length === 0) {
    throw new Error('KineLab inference requires a timed measurement');
  }

  const route = kinelabRoute(config);
  const subject = buildKinelabSubject(config);
  const isZeroOrder = isEthanolDrugId(config.drugId);
  const priors =
    config.kinelab?.priorsSnapshot ??
    buildPriorsFromDrug(
      drugComponentToPriorRow(drugComponent),
      route === 'iv',
      isZeroOrder ? 'zero_order' : 'first_order',
      subject,
    ).priors;

  // Primary dose = the earliest event; any others are superposed (first-order
  // only) as fractions of the inferred primary dose at their known offsets.
  const fallbackDoseHours = Math.min(...measurements.map((m) => m.t!));
  const sortedDoses = [...doseEvents].sort(
    (a, b) =>
      kinelabDoseHours(a, fallbackDoseHours) -
      kinelabDoseHours(b, fallbackDoseHours),
  );
  const dose = sortedDoses[0]!;
  const primaryHours = kinelabDoseHours(dose, fallbackDoseHours);
  const primaryAmountMg = kinelabDoseAmountMg(dose);
  const additionalDoses =
    !isZeroOrder && primaryAmountMg != null && primaryAmountMg > 0
      ? sortedDoses.slice(1).flatMap((d) => {
          const amountMg = kinelabDoseAmountMg(d);
          if (amountMg == null || amountMg <= 0) return [];
          const tHoursAfterPrimary =
            kinelabDoseHours(d, fallbackDoseHours) - primaryHours;
          if (!Number.isFinite(tHoursAfterPrimary) || tHoursAfterPrimary < 0) {
            return [];
          }
          return [
            { tHoursAfterPrimary, doseFraction: amountMg / primaryAmountMg },
          ];
        })
      : [];

  const dosePrior = buildKinelabDosePrior(dose);
  // Opt-in Bateman absorption, mirroring the forward Monte Carlo path (#858):
  // an explicit `overrides.ka` (> 0) on a non-IV first-order case turns on the
  // rising-then-falling absorption curve. Absent it, the engine stays on the
  // instantaneous approximation (and warns). IV and ethanol never use ka.
  const kaOverride = config.overrides.ka;
  const kaPrior =
    route !== 'iv' && !isZeroOrder && positiveFinite(kaOverride)
      ? ({ type: 'fixed', value: kaOverride } as const)
      : undefined;
  const windowRange = dose.tRange ?? [
    dose.t ?? Math.min(...measurements.map((m) => m.t!)),
    dose.t ?? Math.min(...measurements.map((m) => m.t!)),
  ];
  if (
    !Number.isFinite(windowRange[0]) ||
    !Number.isFinite(windowRange[1]) ||
    windowRange[1] < windowRange[0]
  ) {
    throw new Error('KineLab intake window is invalid');
  }

  const defaultAssayCV = positiveFinite(config.kinelab?.assayCV)
    ? config.kinelab!.assayCV!
    : 0.15;

  return {
    modelId: `${analyteId(config, drugComponent)}-${isZeroOrder ? 'zero-order' : 'one-comp'}-component-v0`,
    analyte: analyteId(config, drugComponent),
    route,
    observations: measurements.map((m, idx) => {
      return {
        id: m.id || `obs-${idx + 1}`,
        analyte: analyteId(config, drugComponent),
        concentration: kinelabConcentration(
          m.value!,
          m.unit,
          drugComponent?.molecularWeight,
        ),
        matrix: config.kinelab?.matrix ?? 'whole_blood',
        sampleTime: hoursToIso(m.t!),
        assay: {
          uncertaintyCV: positiveFinite(m.assayCV) ? m.assayCV : defaultAssayCV,
          ...(m.censoring === 'below_lod' ? { lod: m.value! } : {}),
          ...(m.censoring === 'below_loq' ? { loq: m.value! } : {}),
        },
        // A non-detect is left-censored at its limit (the entered value).
        ...(m.censoring
          ? {
              censoring: {
                kind:
                  m.censoring === 'below_lod'
                    ? ('lod' as const)
                    : ('loq' as const),
                limit: m.value!,
              },
            }
          : {}),
      };
    }),
    priors: { ...priors, dose: dosePrior, ...(kaPrior ? { ka: kaPrior } : {}) },
    ...(additionalDoses.length > 0 ? { additionalDoses } : {}),
    scenario: {
      possibleIntakeWindow: {
        earliestIso: hoursToIso(windowRange[0]),
        latestIso: hoursToIso(windowRange[1]),
      },
    },
    subject,
    defaultAssayCV,
    gridResolution: 40,
    drawCount: Math.max(
      100,
      Math.min(
        20_000,
        Math.trunc(
          config.kinelab?.drawCount ?? config.overrides.drawCount ?? 2000,
        ),
      ),
    ),
    seed: 42,
  };
}

function buildInferenceRunArgs(
  config: DrugSimConfig,
  drugComponent: DrugComponent | undefined,
): RunInferenceArgs {
  const input = buildInferenceInput(config, drugComponent);
  const window = input.scenario!.possibleIntakeWindow!;
  const baseline = Date.parse(window.earliestIso);
  const latest = Date.parse(window.latestIso);
  const sampleHours = input.observations
    .map((o) => (Date.parse(o.sampleTime!) - baseline) / 3_600_000)
    .filter((t) => Number.isFinite(t));
  const windowHours = (latest - baseline) / 3_600_000;
  return {
    input,
    predictiveRangeHours: {
      start: 0,
      end: Math.max(windowHours, ...sampleHours) + 6,
      steps: 60,
    },
  };
}

/** Effective-sample-size proportion below which the importance sampler is
 *  considered unreliable (dominated by a few high-weight draws). Canonical
 *  thresholds live in `liteInference.ts` so the engine, the worker, and this
 *  UI adapter all judge "low" / "critical" the same way; re-exported here for
 *  existing call sites. */
export { LOW_ESS_RATIO, CRITICAL_ESS_RATIO };

/** ESS as a fraction of the valid draws that entered the weighted estimate. */
export function essProportion(diagnostics: {
  sampleCount: number;
  effectiveSampleSize: number;
}): number {
  if (diagnostics.sampleCount <= 0) return 0;
  return diagnostics.effectiveSampleSize / diagnostics.sampleCount;
}

/** Analytic prior 5/50/95 intervals keyed like the posterior, for side-by-side
 *  prior-vs-posterior display. */
export function priorIntervalsFromPriors(
  priors: import('@/lib/compute/types').InferencePriors | undefined,
): Record<string, { p05: number; median: number; p95: number }> | undefined {
  if (!priors) return undefined;
  const out: Record<string, { p05: number; median: number; p95: number }> = {};
  const add = (
    key: string,
    spec: import('@/types/simulator').DistributionSpec | undefined,
  ) => {
    if (spec) out[key] = distributionInterval(spec);
  };
  add('dose', priors.dose);
  add('halfLife', priors.halfLife);
  add('vd', priors.vd);
  add('f', priors.f);
  add('eliminationRate', priors.eliminationRate);
  add('ka', priors.ka);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Cross-check that the mathematical family (chosen from the priors' shape —
 * zero-order iff an `eliminationRate` prior is present) agrees with the
 * analyte, instead of trusting the prior shape alone. Ethanol must be
 * zero-order; anything else must be first-order. Returns the mismatch kind (for
 * a warning) or null when consistent.
 */
export function modelFamilyMismatch(
  drugId: string,
  priors: import('@/lib/compute/types').InferencePriors | undefined,
): 'ethanol-not-zero-order' | 'nonethanol-zero-order' | null {
  if (!priors) return null;
  const isEthanol = isEthanolDrugId(drugId);
  const isZeroOrder = priors.eliminationRate != null;
  if (isEthanol && !isZeroOrder) return 'ethanol-not-zero-order';
  if (!isEthanol && isZeroOrder) return 'nonethanol-zero-order';
  return null;
}

export function kinelabOutputToDrugSimResult(
  output: WorkerInferenceOutput,
  config: DrugSimConfig,
  priors?: import('@/lib/compute/types').InferencePriors,
  card?: PKModelCard,
): DrugSimResult {
  const timeSeries = output.predictive.map((p) => ({ ...p }));
  const peak = timeSeries.reduce(
    (best, point) => (point.median > best.median ? point : best),
    timeSeries[0] ?? { t: 0, p05: 0, p25: 0, median: 0, p75: 0, p95: 0 },
  );
  const essRatio = essProportion(output.diagnostics);
  const warnings: DrugSimResult['warnings'] =
    essRatio < LOW_ESS_RATIO
      ? [
          {
            type: 'instability',
            messageKey: 'simulator.warnings.lowEss',
            message: 'simulator.warnings.lowEss',
            severity: essRatio < CRITICAL_ESS_RATIO ? 'critical' : 'warning',
          },
        ]
      : [];
  // The model is parameterised against whole blood and no matrix conversion is
  // applied, so selecting another matrix means the concentration is used as-is.
  // Say so rather than silently pretending the matrices are interchangeable.
  const matrix = config.kinelab?.matrix;
  if (matrix && matrix !== 'whole_blood') {
    warnings.push({
      type: 'model-limitation',
      messageKey: 'simulator.warnings.matrixNoConversion',
      message: 'simulator.warnings.matrixNoConversion',
      severity: 'warning',
    });
  }
  // Non-IV first-order without an absorption rate runs instantaneous
  // absorption, which is not valid around Tmax. Say so (supply overrides.ka to
  // switch on the Bateman model). Zero-order (ethanol) and IV are exempt.
  const route = kinelabRoute(config);
  const isZeroOrder = !!priors?.eliminationRate;
  if (route !== 'iv' && !isZeroOrder && !priors?.ka) {
    warnings.push({
      type: 'model-limitation',
      messageKey: 'simulator.warnings.instantaneousAbsorption',
      message: 'simulator.warnings.instantaneousAbsorption',
      severity: 'warning',
    });
  }
  // The matched card declares a mechanism (parent/metabolite) the Lite engine
  // does not implement — it runs as a parent-only first-order approximation.
  // Flag it so the richer-sounding card doesn't imply modelling that isn't there.
  if (isApproximatedModelCard(card)) {
    warnings.push({
      type: 'model-limitation',
      messageKey: 'simulator.warnings.parentMetaboliteApprox',
      message: 'simulator.warnings.parentMetaboliteApprox',
      severity: 'warning',
    });
  }
  // Guard against the model family disagreeing with the analyte (e.g. a saved
  // case whose priors snapshot no longer matches the drug it is attached to).
  const familyMismatch = modelFamilyMismatch(config.drugId, priors);
  if (familyMismatch) {
    const key =
      familyMismatch === 'ethanol-not-zero-order'
        ? 'simulator.warnings.ethanolNotZeroOrder'
        : 'simulator.warnings.nonethanolZeroOrder';
    warnings.push({
      type: 'model-limitation',
      messageKey: key,
      message: key,
      severity: 'critical',
    });
  }
  return {
    drugConfigId: config.id,
    engine: 'kinelab-bayes',
    questionMode: 'dose-from-concentration',
    median: peak.median,
    p05: peak.p05,
    p25: peak.p25,
    p75: peak.p75,
    p95: peak.p95,
    unit: 'mg/L',
    timeSeries,
    anchorTime: kinelabCurveAnchor(config),
    assumptions: {
      model: 'KineLab Bayesian inference',
      modelKey: 'assumptions.models.kinelabBayes',
      route: kinelabRoute(config),
      halfLife: { type: 'fixed', value: 0 },
      vd: { type: 'fixed', value: 0 },
      f: { type: 'fixed', value: 1 },
      weightScaling: true,
    },
    sensitivity: [],
    warnings,
    seed: 42,
    drawCount: config.kinelab?.drawCount ?? config.overrides.drawCount ?? 2000,
    kinelab: {
      posterior: output.posterior,
      diagnostics: output.diagnostics,
      priorIntervals: priorIntervalsFromPriors(priors),
      matrix: matrix ?? 'whole_blood',
    },
  };
}

/**
 * Build a visible error result for a KineLab run that failed validation or
 * computation. Previously such failures were swallowed by a `console.error` in
 * the run loop, so the user just saw the spinner stop with no output. This
 * renders the failure as a critical warning card via the existing warnings
 * surface, with a localized message keyed off the failure kind.
 */
export function kinelabInferenceErrorResult(
  err: unknown,
  config: DrugSimConfig,
  priors?: import('@/lib/compute/types').InferencePriors,
): DrugSimResult {
  const messageKey =
    err instanceof LiteInferenceError
      ? err.code === 'matrix-unsupported'
        ? 'simulator.warnings.matrixUnsupported'
        : 'simulator.warnings.matrixMixed'
      : 'simulator.warnings.inferenceFailed';
  // Raw detail kept for logs/debugging only — the UI renders `messageKey` when
  // present (see AssumptionPanel), so this English string never reaches users.
  const detail = err instanceof Error ? err.message : String(err);
  return {
    drugConfigId: config.id,
    engine: 'kinelab-bayes',
    questionMode: 'dose-from-concentration',
    median: 0,
    p05: 0,
    p25: 0,
    p75: 0,
    p95: 0,
    unit: 'mg/L',
    timeSeries: [],
    assumptions: {
      model: 'KineLab Bayesian inference',
      modelKey: 'assumptions.models.kinelabBayes',
      route: kinelabRoute(config),
      halfLife: { type: 'fixed', value: 0 },
      vd: { type: 'fixed', value: 0 },
      f: { type: 'fixed', value: 1 },
      weightScaling: true,
    },
    sensitivity: [],
    warnings: [
      {
        type: 'model-limitation',
        messageKey,
        message: detail,
        severity: 'critical',
      },
    ],
    seed: 42,
    drawCount: config.kinelab?.drawCount ?? config.overrides.drawCount ?? 2000,
    kinelab: {
      posterior: { intervals: {} },
      diagnostics: {
        sampleCount: 0,
        rejectedNonphysical: 0,
        rejectedImpossible: 0,
        effectiveSampleSize: 0,
      },
      priorIntervals: priorIntervalsFromPriors(priors),
      matrix: config.kinelab?.matrix ?? 'whole_blood',
    },
  };
}

/** Whether a component carries enough input for its engine to run. */
export function isComponentRunnable(config: DrugSimConfig): boolean {
  switch (getComponentEngine(config)) {
    case 'kinelab-bayes': {
      const dose = config.events.find((e) => e.type === 'dose');
      const hasDosePrior =
        !!dose &&
        ((dose.amountRange != null &&
          positiveFinite(dose.amountRange.min) &&
          positiveFinite(dose.amountRange.max) &&
          dose.amountRange.max > dose.amountRange.min) ||
          positiveFinite(dose.amount));
      const hasMeasurement = config.events.some(
        (e) =>
          e.type === 'measurement' &&
          positiveFinite(e.value) &&
          e.t != null &&
          Number.isFinite(e.t),
      );
      return hasDosePrior && hasMeasurement;
    }
    case 'ethanol-widmark':
      return (
        ethanolQuestionMode(config.events ?? []) ===
          'concentration-from-dose' &&
        ethanolIntakesFromEvents(config.events ?? []).length > 0
      );
    case 'pk-montecarlo':
    default:
      return deriveQuestion(config).complete;
  }
}

/**
 * i18n key describing why a component cannot run yet, or null when it is
 * runnable. Mirrors the per-engine hint DrugPanel shows so the Run button can
 * tell the user what is still missing (e.g. a dose prior for KineLab).
 */
export function getRunBlockReasonKey(config: DrugSimConfig): string | null {
  if (isComponentRunnable(config)) return null;
  switch (getComponentEngine(config)) {
    case 'ethanol-widmark': {
      const hasUnsupportedDoseQuery = (config.events ?? []).some(
        (e) => e.type === 'query' && e.solveFor === 'dose',
      );
      return hasUnsupportedDoseQuery
        ? 'simulator.events.statusEthanolDoseSolvingUnsupported'
        : 'simulator.events.statusEthanolIncomplete';
    }
    case 'kinelab-bayes':
      return 'simulator.events.statusKinelabIncomplete';
    case 'pk-montecarlo':
    default: {
      // Solving for a dose needs the INTAKE TIME as well as the concentration:
      // the dose is back-calculated from how far the measurement sits after it.
      // Saying "add a prediction time point" when the prediction time is
      // already there — and the dose event is what is missing — sends the user
      // to the wrong control, so name the actual gap.
      const derived = deriveQuestion(config);
      if (derived.questionMode === 'dose-from-concentration') {
        const hasDoseTime = (config.events ?? []).some(
          (e) => e.type === 'dose' && e.t != null && Number.isFinite(e.t),
        );
        if (!hasDoseTime) {
          return 'simulator.events.statusDoseSolveNeedsDoseTime';
        }
        if (derived.inputs.measuredConcentration == null) {
          return 'simulator.events.statusDoseSolveNeedsConcentration';
        }
      }
      return 'simulator.events.statusIncomplete';
    }
  }
}

export interface ModelingRunDeps {
  /** Runs the canonical scenario off-thread (legacy name retained for callers). */
  runMonteCarlo: (
    config: CanonicalSimulationConfig,
  ) => Promise<CanonicalResult>;
  /** Runs KineLab Bayesian inference off-thread. Required for kinelab-bayes. */
  runInference?: (args: RunInferenceArgs) => Promise<WorkerInferenceOutput>;
}

/**
 * Dispatch a component to its compute engine and return a unified DrugSimResult
 * the shared chart can render. The Monte Carlo path stays off-thread via the
 * injected worker; the ethanol Widmark engine is synchronous.
 */
export async function runComponent(
  config: DrugSimConfig,
  drugComponent: DrugComponent | undefined,
  deps: ModelingRunDeps,
): Promise<DrugSimResult> {
  // Build a catalogue drug's model from the catalogue as it stands now, so a curated value reaches
  // this run without a regenerated registry; on any failure the committed snapshot is used. Fetched
  // ONCE per component and pinned: a back-calculation runs a probe and a final simulation, and a
  // refresh between them would infer the dose from one build and draw the curve from another.
  await refreshLiveDerivedModel(drugComponent?._slug);
  const pinned = liveDerivedEntries();
  const pinnedDeps: ModelingRunDeps = {
    ...deps,
    runMonteCarlo: (simulation) => deps.runMonteCarlo({ ...simulation, liveDerived: pinned }),
  };
  const result = await runComponentEngine(config, drugComponent, pinnedDeps);
  // Stamp the inputs this result was computed from so the UI can detect when a
  // later edit leaves the curve out of date, and attach a reproducibility
  // manifest recording exactly which engine/model/seed produced it.
  const inputHash = hashRunInputs(config);
  return {
    ...result,
    inputHash,
    manifest: buildRunManifest(result, inputHash),
  };
}

const APP_VERSION: string =
  (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? 'dev';

/** Consolidate the reproducibility metadata for a computed result. */
export function buildRunManifest(
  result: DrugSimResult,
  inputHash: string,
): import('@/types/simulator').RunManifest {
  return {
    inputHash,
    engine: result.engine ?? 'pk-montecarlo',
    model: result.assumptions.modelKey ?? result.assumptions.model,
    seed: result.seed,
    drawCount: result.drawCount,
    createdAtIso: new Date().toISOString(),
    appVersion: APP_VERSION,
    ...(result.kinelab
      ? {
          effectiveSampleSize: result.kinelab.diagnostics.effectiveSampleSize,
          sampleCount: result.kinelab.diagnostics.sampleCount,
          matrix: result.kinelab.matrix,
        }
      : {}),
  };
}

async function runComponentEngine(
  config: DrugSimConfig,
  drugComponent: DrugComponent | undefined,
  deps: ModelingRunDeps,
): Promise<DrugSimResult> {
  switch (getComponentEngine(config)) {
    case 'kinelab-bayes': {
      if (!deps.runInference) {
        throw new Error('KineLab inference worker is not available');
      }
      let args: RunInferenceArgs | undefined;
      try {
        args = buildInferenceRunArgs(config, drugComponent);
        // Main-thread pre-flight running the SAME schema + card + matrix
        // validation the worker now runs, so a policy violation surfaces as a
        // typed LiteInferenceError here (with its `code`) rather than crossing
        // the Comlink boundary and losing its structure.
        const { card } = validateLiteInferenceInput(args.input);
        const output = await deps.runInference(args);
        return kinelabOutputToDrugSimResult(
          output,
          config,
          args.input.priors,
          card,
        );
      } catch (err) {
        // Surface the failure as a visible result instead of a silent
        // console.error (the previous behaviour in `handleRunAll`).
        return kinelabInferenceErrorResult(err, config, args?.input.priors);
      }
    }
    case 'ethanol-widmark':
      return runEthanolComponent(config);
    case 'pk-montecarlo':
    default: {
      const mcConfig = buildConfigWithDrugData(config, drugComponent);
      switch (mcConfig.questionMode) {
        case 'dose-from-concentration':
          return runDoseFromConcentrationCore(
            config,
            drugComponent,
            mcConfig,
            deps,
          );
        case 'earlier-from-later':
        case 'later-from-earlier':
          return runExtrapolationCore(config, drugComponent, mcConfig, deps);
        case 'concentration-from-dose':
        default:
          return runForwardCore(config, drugComponent, mcConfig, deps);
      }
    }
  }
}

/** Dose (mg) used to probe a linear model's response before rescaling it. */
const PROBE_DOSE_MG = 100;

/**
 * A visible, non-throwing failure result for a core run that could not produce
 * an answer.
 *
 * `handleRunAll` swallows a thrown error into `console.error`, so a throw here
 * reaches the user as a Run button that does nothing at all. Every reason a
 * core run cannot answer the question therefore comes back as a result the UI
 * renders, carrying the reason as a critical warning.
 */
function coreFailureResult(
  config: DrugSimConfig,
  drugComponent: DrugComponent | undefined,
  mcConfig: MonteCarloConfig,
  reason: SimulationWarning,
  core?: CanonicalResult,
): DrugSimResult {
  const { questionMode, route, warnings } = deriveQuestion(config);
  const provenance = resolveParameterProvenance(config, drugComponent);
  return {
    drugConfigId: config.id,
    engine: 'pk-montecarlo',
    questionMode,
    median: 0,
    p05: 0,
    p25: 0,
    p75: 0,
    p95: 0,
    unit: mcConfig.inputs.concentrationUnit ?? 'mg/L',
    timeSeries: [],
    anchorTime: mcCurveAnchor(config),
    // A refusal (a saturable model this mode cannot solve) still ran the engine
    // and resolved a model, so the card names it. Only a run that never
    // resolved one falls back to the catalog derivation.
    assumptions: coreAssumptions(
      core,
      route,
      mcConfig.weightScaling,
      provenance,
    ) ?? {
      model: core?.manifest.modelId ?? 'kinetics-core',
      route,
      halfLife: mcConfig.halfLife,
      vd: mcConfig.vd,
      f: mcConfig.f,
      weightScaling: mcConfig.weightScaling,
      provenance,
    },
    sensitivity: [],
    // The zeros above are placeholders, not an estimate. `failure` is what the
    // answer card and the export read to suppress them.
    failure: { message: reason.message, messageKey: reason.messageKey },
    warnings: [
      ...warnings,
      ...(core && !core.ok
        ? core.limitations.map((limitation) => ({
            type: 'model-limitation' as const,
            message: limitation.text,
            severity: limitation.severity,
          }))
        : []),
      reason,
    ],
    seed: core?.manifest.seed ?? mcConfig.seed,
    drawCount: core && core.ok ? (core.manifest.acceptedDraws ?? 0) : 0,
  };
}

/**
 * Flatten the two ways a core run can fail — an unbuildable scenario
 * (`runCoreDoses` returning `ok: false`) and an engine that rejected it — into
 * one outcome, so every mode reports either a curve or a critical warning
 * without repeating both checks.
 */
type CoreRunOutcome =
  | { ok: true; core: CanonicalResultOk }
  | { ok: false; reason: SimulationWarning; core?: CanonicalResult };

function coreRunOutcome(
  run: { ok: true; core: CanonicalResult } | { ok: false; detail: string },
): CoreRunOutcome {
  if (!run.ok) {
    return {
      ok: false,
      reason: {
        type: 'instability',
        message: run.detail,
        severity: 'critical',
      },
    };
  }
  if (!run.core.ok) {
    return {
      ok: false,
      core: run.core,
      reason: {
        type: 'instability',
        message: `${run.core.failure}: ${run.core.detail}`,
        severity: 'critical',
      },
    };
  }
  return { ok: true, core: run.core };
}

/**
 * The concentration unit a Monte Carlo curve is reported in, NORMALIZED.
 *
 * The unit reaches here from a measurement event, and a saved or imported case
 * can carry a micro-prefix alias (`ug/L`, `μmol/L`) that `isConcentrationUnit`
 * does not recognise. Unnormalized, the conversion would be skipped while the
 * series kept the alias as its label — mg/L values labelled `ug/L`, a 1000x
 * display error — or, on the forward path, the run would fail outright.
 */
function curveConcentrationUnit(mcConfig: MonteCarloConfig): string {
  return normalizeUnit(mcConfig.inputs.concentrationUnit ?? 'mg/L');
}

/**
 * Run a core scenario for `doses` (already in mg, on the absolute axis) over the
 * component's window. Shared by every Monte Carlo question mode: the forward
 * curve, the probe run that calibrates a back-calculated dose, and the rerun
 * that reports it.
 */
async function runCoreDoses(
  config: DrugSimConfig,
  drugComponent: DrugComponent | undefined,
  mcConfig: MonteCarloConfig,
  doses: Array<{
    amountMg: number;
    tHours: number;
    route?: RouteType;
    durationHours?: number;
  }>,
  anchor: number,
  deps: ModelingRunDeps,
): Promise<{ ok: true; core: CanonicalResult } | { ok: false; detail: string }> {
  const build = (draws: number) =>
    toCanonicalScenario({
      analyte: coreAnalyteFor([drugComponent?._slug, analyteId(config, drugComponent)]),
      route: mcConfig.route,
      subject: { weightKg: mcConfig.weight ?? 70 },
      doses,
      timeRange: {
        start: mcConfig.timeRange.start + anchor,
        end: mcConfig.timeRange.end + anchor,
        steps: mcConfig.timeRange.steps,
      },
      uncertainty: { seed: mcConfig.seed, draws },
    });
  const first = build(mcConfig.drawCount);
  if (!first.ok) return { ok: false, detail: first.unsupported };
  const core = await runWithinComputeBudget(
    mcConfig.drawCount,
    async (draws) => {
      const built = draws === mcConfig.drawCount ? first : build(draws);
      if (!built.ok) throw new Error(built.unsupported);
      return deps.runMonteCarlo({
        drugConfigId: config.id,
        scenario: built.scenario,
      });
    },
  );
  return { ok: true, core };
}

/** The engine accepts down to one draw; the back-off never goes below it. */
const MIN_BUDGET_DRAWS = 1;

/**
 * Run with the requested draw count, and if the engine refuses it for exceeding a
 * compute budget (grid × doses × draws, or ODE work — limits that depend on the model
 * family, span and retained doses), retry with fewer draws until it is admitted. The
 * engine stays the single source of truth for its budgets; the draws actually used are
 * reported in the result's manifest.
 */
export async function runWithinComputeBudget(
  requested: number,
  run: (draws: number) => Promise<CanonicalResult>,
): Promise<CanonicalResult> {
  let draws = requested;
  let result = await run(draws);
  while (
    !result.ok &&
    result.failure === 'invalid-input' &&
    /compute budget|work budget/i.test(result.detail) &&
    draws > MIN_BUDGET_DRAWS
  ) {
    draws = Math.max(MIN_BUDGET_DRAWS, Math.floor(draws * 0.75));
    result = await run(draws);
  }
  return result;
}

/** Forward mode: one or more known doses → the concentration at the query time. */
async function runForwardCore(
  config: DrugSimConfig,
  drugComponent: DrugComponent | undefined,
  mcConfig: MonteCarloConfig,
  deps: ModelingRunDeps,
): Promise<DrugSimResult> {
  const anchor = mcCurveAnchor(config);
  const doseUnit = mcConfig.inputs.doseUnit ?? 'mg';
  const eventDoses = config.events.filter(
    (
      event,
    ): event is Extract<SimEvent, { type: 'dose' }> & {
      amount: number;
      t: number;
    } => event.type === 'dose' && event.amount != null && event.t != null,
  );
  const doses = eventDoses.map((event) => ({
    amountMg: doseAmountToMilligrams(event.amount, event.unit) ?? Number.NaN,
    tHours: event.t,
    route: event.route,
    durationHours: event.durationHours,
  }));
  // Saved legacy cases may not yet carry events; preserve their single dose.
  if (doses.length === 0 && mcConfig.inputs.dose != null) {
    doses.push({
      amountMg:
        doseAmountToMilligrams(mcConfig.inputs.dose, doseUnit) ?? Number.NaN,
      tHours: anchor,
      route: mcConfig.route,
      durationHours: undefined,
    });
  }
  const run = await runCoreDoses(
    config,
    drugComponent,
    mcConfig,
    doses,
    anchor,
    deps,
  );
  const outcome = coreRunOutcome(run);
  if (!outcome.ok) {
    return coreFailureResult(
      config,
      drugComponent,
      mcConfig,
      outcome.reason,
      outcome.core,
    );
  }
  const core = outcome.core;
  const queryTime =
    config.events
      .filter(
        (
          event,
        ): event is Extract<SimEvent, { type: 'query' }> & { t: number } =>
          event.type === 'query' &&
          event.solveFor === 'concentration' &&
          event.t != null,
      )
      .at(-1)?.t ??
    anchor + (mcConfig.queryTimeHours ?? mcConfig.inputs.timeSinceDose ?? 0);
  const concentrationUnit = curveConcentrationUnit(mcConfig);
  if (!isConcentrationUnit(concentrationUnit)) {
    throw new Error('Simulation output requires a supported concentration unit');
  }
  const result = coreResultToMonteCarloResult(core, {
    drugConfigId: config.id,
    queryTimeHours: queryTime,
    originHours: anchor,
    unit: concentrationUnit,
    toDisplay: (value) =>
      convertConcentration(
        value,
        'mg/L',
        concentrationUnit,
        drugComponent?.molecularWeight,
      ),
  });
  return monteCarloResultToDrugSimResult(result, config, drugComponent);
}

/**
 * The assumption every inverse mode rests on, stated rather than left implicit.
 *
 * A measurement event carries no matrix of its own, and the reviewed models
 * compute in their own (plasma for most of the registry). Both inverse modes
 * anchor on the entered concentration — the dose is calibrated so the model's
 * native-matrix curve passes through it, and the extrapolation is that value
 * times a decay — so the number is necessarily READ AS the model's matrix. The
 * chart then converts the curve from that matrix into the display matrix, which
 * is correct under this reading and visibly wrong under any other: the plotted
 * curve will not pass through a point entered in a different matrix.
 *
 * Converting instead would mean inventing the observation's matrix, which the
 * event model does not record. Until a measurement can declare one, the honest
 * move is to name the reading — the same stance `matrixNoConversion` takes for
 * the KineLab path.
 */
function observationMatrixWarning(matrix: string): SimulationWarning {
  return {
    type: 'input-uncertainty',
    messageKey: 'simulator.warnings.observationMatrixAssumed',
    messageParams: { matrix },
    message: 'simulator.warnings.observationMatrixAssumed',
    severity: 'warning',
  };
}

/**
 * The route the core actually resolved for this run, preferring the one the
 * component asked for. `modelSummary.routes` reports what the engine used, so
 * this is the resolved truth rather than a re-derivation from the catalog.
 */
function resolvedCoreRoute(core: CanonicalResultOk, route: RouteType) {
  const routeId = routeIdFor(route);
  return core.modelSummary.routes.find((r) => r.route === routeId)
    ?? core.modelSummary.routes[0];
}

/**
 * The CHRONOLOGICALLY last event of a kind — sorted by time, exactly as
 * `deriveQuestion` sorts before picking its last dose / measurement / query,
 * and with the same `undefined`-sorts-last rule.
 *
 * Array order is NOT chronological order: `updateEvent` rewrites an event's
 * time in place without reordering the list, so a dose whose time is edited
 * earlier keeps its later array position. Reading the last array entry would
 * then let the engine solve from a different dose or measurement than the one
 * the panel says it is solving from.
 */
function lastEventOfType<T extends SimEvent['type']>(
  config: DrugSimConfig,
  type: T,
): Extract<SimEvent, { type: T }> | undefined {
  const matching = (config.events ?? [])
    .filter((e): e is Extract<SimEvent, { type: T }> => e.type === type)
    .sort(
      (a, b) =>
        (a.t ?? Number.POSITIVE_INFINITY) - (b.t ?? Number.POSITIVE_INFINITY),
    );
  return matching[matching.length - 1];
}

/**
 * Back-calculate the dose that explains a measured concentration.
 *
 * Every core family except Michaelis–Menten is LINEAR in dose, so the curve for
 * an unknown dose is the curve for a known probe dose times a constant. We
 * therefore run the model once at `PROBE_DOSE_MG`, read what it predicts at the
 * measurement time, and scale: `dose = PROBE · measured / predicted`. The
 * reported curve then comes from a SECOND run at the estimated dose rather than
 * a rescaling of the probe, so the manifest and `canonicalResult` describe the
 * dose actually being reported.
 *
 * The interval inverts the probe band: a HIGHER predicted concentration for the
 * probe dose implies a SMALLER dose behind the same measurement, so the dose's
 * 5th percentile pairs with the concentration's 95th.
 */
async function runDoseFromConcentrationCore(
  config: DrugSimConfig,
  drugComponent: DrugComponent | undefined,
  mcConfig: MonteCarloConfig,
  deps: ModelingRunDeps,
): Promise<DrugSimResult> {
  const anchor = mcCurveAnchor(config);
  const dose = lastEventOfType(config, 'dose');
  const measurement = lastEventOfType(config, 'measurement');
  if (
    dose?.t == null ||
    !Number.isFinite(dose.t) ||
    measurement?.t == null ||
    measurement.value == null
  ) {
    return coreFailureResult(config, drugComponent, mcConfig, {
      type: 'instability',
      messageKey: 'simulator.warnings.doseSolveNeedsDoseTime',
      message: 'simulator.warnings.doseSolveNeedsDoseTime',
      severity: 'critical',
    });
  }

  const measuredUnit = normalizeUnit(measurement.unit ?? 'mg/L');
  if (!isConcentrationUnit(measuredUnit)) {
    return coreFailureResult(config, drugComponent, mcConfig, {
      type: 'instability',
      messageKey: 'simulator.warnings.unsupportedConcentrationUnit',
      message: 'simulator.warnings.unsupportedConcentrationUnit',
      severity: 'critical',
    });
  }
  let measuredMgL: number;
  try {
    measuredMgL = convertConcentration(
      measurement.value,
      measuredUnit,
      'mg/L',
      drugComponent?.molecularWeight,
    );
  } catch {
    return coreFailureResult(config, drugComponent, mcConfig, {
      type: 'instability',
      messageKey: 'simulator.warnings.unsupportedConcentrationUnit',
      message: 'simulator.warnings.unsupportedConcentrationUnit',
      severity: 'critical',
    });
  }
  if (!(measuredMgL > 0) || !Number.isFinite(measuredMgL)) {
    return coreFailureResult(config, drugComponent, mcConfig, {
      type: 'instability',
      messageKey: 'simulator.warnings.doseSolveNeedsPositiveConcentration',
      message: 'simulator.warnings.doseSolveNeedsPositiveConcentration',
      severity: 'critical',
    });
  }

  const doseAt = { tHours: dose.t, route: dose.route ?? mcConfig.route };
  const probeRun = await runCoreDoses(
    config,
    drugComponent,
    mcConfig,
    [{ amountMg: PROBE_DOSE_MG, ...doseAt }],
    anchor,
    deps,
  );
  const probeOutcome = coreRunOutcome(probeRun);
  if (!probeOutcome.ok) {
    return coreFailureResult(
      config,
      drugComponent,
      mcConfig,
      probeOutcome.reason,
      probeOutcome.core,
    );
  }
  const probe = probeOutcome.core;
  if (resolvedCoreRoute(probe, mcConfig.route)?.family === 'michaelis-menten') {
    return coreFailureResult(
      config,
      drugComponent,
      mcConfig,
      {
        type: 'model-limitation',
        messageKey: 'simulator.warnings.nonlinearDoseSolve',
        message: 'simulator.warnings.nonlinearDoseSolve',
        severity: 'critical',
      },
      probe,
    );
  }

  const probeBand = interpolateCoreBand(probe.timeSeries, measurement.t);
  if (!(probeBand.median > 0)) {
    return coreFailureResult(
      config,
      drugComponent,
      mcConfig,
      {
        type: 'instability',
        messageKey: 'simulator.warnings.doseSolveZeroPrediction',
        message: 'simulator.warnings.doseSolveZeroPrediction',
        severity: 'critical',
      },
      probe,
    );
  }

  const doseForPrediction = (predictedMgL: number): number =>
    predictedMgL > 0
      ? (PROBE_DOSE_MG * measuredMgL) / predictedMgL
      : Number.NaN;
  const doseMg = doseForPrediction(probeBand.median);

  // The reported curve is the estimated dose's own run, not a rescaled probe,
  // so the manifest and the retained core payload describe what is on screen.
  const finalRun = await runCoreDoses(
    config,
    drugComponent,
    mcConfig,
    [{ amountMg: doseMg, ...doseAt }],
    anchor,
    deps,
  );
  const finalOutcome = coreRunOutcome(finalRun);
  if (!finalOutcome.ok) {
    return coreFailureResult(
      config,
      drugComponent,
      mcConfig,
      finalOutcome.reason,
      finalOutcome.core,
    );
  }
  const finalCore = finalOutcome.core;

  const curveUnit = curveConcentrationUnit(mcConfig);
  const toCurveUnit = (mgPerL: number): number =>
    isConcentrationUnit(curveUnit)
      ? convertConcentration(
          mgPerL,
          'mg/L',
          curveUnit,
          drugComponent?.molecularWeight,
        )
      : mgPerL;
  const timeSeries: UncertaintyPoint[] = finalCore.timeSeries.map((p) => ({
    t: p.tHours - anchor,
    median: toCurveUnit(p.median),
    p05: toCurveUnit(p.p05),
    p25: toCurveUnit(p.p25),
    p75: toCurveUnit(p.p75),
    p95: toCurveUnit(p.p95),
  }));

  const doseUnit = normalizeUnit(dose.unit ?? mcConfig.inputs.doseUnit ?? 'mg');
  const toDoseUnit = (mg: number): number =>
    isDoseUnit(doseUnit) ? convertDose(mg, 'mg', doseUnit as DoseUnit) : mg;

  const { route, warnings } = deriveQuestion(config);
  const provenance = resolveParameterProvenance(config, drugComponent);
  return {
    drugConfigId: config.id,
    engine: 'pk-montecarlo',
    questionMode: 'dose-from-concentration',
    // The dose scalar; `curveUnit` names the plotted concentration curve.
    median: toDoseUnit(doseMg),
    p05: toDoseUnit(doseForPrediction(probeBand.p95)),
    p25: toDoseUnit(doseForPrediction(probeBand.p75)),
    p75: toDoseUnit(doseForPrediction(probeBand.p25)),
    p95: toDoseUnit(doseForPrediction(probeBand.p05)),
    unit: isDoseUnit(doseUnit) ? doseUnit : 'mg',
    curveUnit,
    timeSeries,
    anchorTime: anchor,
    assumptions:
      coreAssumptions(finalCore, route, mcConfig.weightScaling, provenance) ?? {
        model: 'one-compartment, first-order elimination',
        modelKey: 'assumptions.models.oneCompartmentFirstOrder',
        route,
        halfLife: mcConfig.halfLife,
        vd: mcConfig.vd,
        f: mcConfig.f,
        weightScaling: mcConfig.weightScaling,
        provenance,
      },
    sensitivity: [],
    warnings: [
      ...warnings,
      ...finalCore.limitations.map((limitation) => ({
        type: 'model-limitation' as const,
        message: limitation.text,
        severity: limitation.severity,
      })),
      observationMatrixWarning(finalCore.matrix),
      {
        type: 'model-limitation',
        messageKey: 'simulator.warnings.unstableDoseFromConcentration',
        message: 'simulator.warnings.unstableDoseFromConcentration',
        severity: 'warning',
      },
    ],
    seed: finalCore.manifest.seed ?? mcConfig.seed,
    drawCount: finalCore.manifest.acceptedDraws ?? mcConfig.drawCount,
    canonicalResult: finalCore,
  };
}

/**
 * Extrapolate a measured concentration forward or backward in time.
 *
 * With no dose event there is no absorption phase to model and no amplitude to
 * fit: the only thing the reviewed model contributes is its terminal
 * elimination rate, so the curve is `C(t) = C_measured · e^(−ke·(t − t_measured))`
 * anchored on the observation. That is a first-order assumption, so a saturable
 * (Michaelis–Menten) model is refused rather than approximated. The model is
 * still resolved through the core — a probe run supplies the engine's own
 * resolved half-life, family and matrix for this subject and route — so the
 * assumptions and grade reported here are the engine's, not a catalog guess.
 */
async function runExtrapolationCore(
  config: DrugSimConfig,
  drugComponent: DrugComponent | undefined,
  mcConfig: MonteCarloConfig,
  deps: ModelingRunDeps,
): Promise<DrugSimResult> {
  const { questionMode, route, warnings, inputs } = deriveQuestion(config);
  const measuredConcentration = inputs.measuredConcentration;
  const measuredTime = inputs.measuredTime;
  const targetTime = inputs.targetTime;
  if (
    measuredConcentration == null ||
    measuredTime == null ||
    targetTime == null
  ) {
    return coreFailureResult(config, drugComponent, mcConfig, {
      type: 'instability',
      messageKey: 'simulator.events.statusIncomplete',
      message: 'simulator.events.statusIncomplete',
      severity: 'critical',
    });
  }

  // A probe run purely to resolve the model: its curve is discarded, only the
  // engine's resolved route parameters are used.
  const probeRun = await runCoreDoses(
    config,
    drugComponent,
    mcConfig,
    [{ amountMg: PROBE_DOSE_MG, tHours: mcConfig.timeRange.start, route }],
    0,
    deps,
  );
  const probeOutcome = coreRunOutcome(probeRun);
  if (!probeOutcome.ok) {
    return coreFailureResult(
      config,
      drugComponent,
      mcConfig,
      probeOutcome.reason,
      probeOutcome.core,
    );
  }
  const probe = probeOutcome.core;
  const resolved = resolvedCoreRoute(probe, route);
  if (resolved?.family === 'michaelis-menten') {
    return coreFailureResult(
      config,
      drugComponent,
      mcConfig,
      {
        type: 'model-limitation',
        messageKey: 'simulator.warnings.nonlinearExtrapolation',
        message: 'simulator.warnings.nonlinearExtrapolation',
        severity: 'critical',
      },
      probe,
    );
  }
  const halfLife = resolved?.eliminationHalfLifeHours;
  if (halfLife == null || !(halfLife > 0) || !Number.isFinite(halfLife)) {
    return coreFailureResult(
      config,
      drugComponent,
      mcConfig,
      {
        type: 'instability',
        messageKey: 'simulator.warnings.noTerminalHalfLife',
        message: 'simulator.warnings.noTerminalHalfLife',
        severity: 'critical',
      },
      probe,
    );
  }

  const ke = Math.LN2 / halfLife;
  const at = (t: number): number =>
    measuredConcentration * Math.exp(-ke * (t - measuredTime));

  // The extrapolation is deterministic: it uses the resolved central half-life,
  // so every percentile coincides with the median. `hasUncertaintyBand` reads
  // that and presents a point estimate rather than a collapsed interval.
  const { start, end, steps } = mcConfig.timeRange;
  const timeSeries: UncertaintyPoint[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = start + ((end - start) * i) / steps;
    const value = at(t);
    const point = Number.isFinite(value) && value > 0 ? value : 0;
    timeSeries.push({
      t,
      median: point,
      p05: point,
      p25: point,
      p75: point,
      p95: point,
    });
  }
  const answer = at(targetTime);

  const provenance = resolveParameterProvenance(config, drugComponent);
  const unit = curveConcentrationUnit(mcConfig);
  const extrapolationWarnings: SimulationWarning[] = [
    {
      type: 'model-limitation',
      messageKey: 'simulator.warnings.terminalPhaseExtrapolation',
      message: 'simulator.warnings.terminalPhaseExtrapolation',
      severity: 'warning',
    },
    observationMatrixWarning(probe.matrix),
  ];
  const backwardHours = measuredTime - targetTime;
  if (backwardHours > 24) {
    extrapolationWarnings.push({
      type: 'input-uncertainty',
      messageKey: 'simulator.warnings.backwardExtrapolation',
      messageParams: { hours: backwardHours.toFixed(1) },
      message: 'simulator.warnings.backwardExtrapolation',
      severity: 'warning',
    });
  }

  return {
    drugConfigId: config.id,
    engine: 'pk-montecarlo',
    questionMode,
    median: answer,
    p05: answer,
    p25: answer,
    p75: answer,
    p95: answer,
    unit,
    timeSeries,
    // `deriveQuestion` builds these modes on the absolute event axis already.
    anchorTime: 0,
    assumptions:
      coreAssumptions(probe, route, mcConfig.weightScaling, provenance) ?? {
        model: 'one-compartment, first-order elimination',
        modelKey: 'assumptions.models.oneCompartmentFirstOrder',
        route,
        halfLife: mcConfig.halfLife,
        vd: mcConfig.vd,
        f: mcConfig.f,
        weightScaling: mcConfig.weightScaling,
        provenance,
      },
    sensitivity: [],
    warnings: [
      ...warnings,
      ...probe.limitations.map((limitation) => ({
        type: 'model-limitation' as const,
        message: limitation.text,
        severity: limitation.severity,
      })),
      ...extrapolationWarnings,
    ],
    seed: probe.manifest.seed ?? mcConfig.seed,
    drawCount: 0,
  };
}
