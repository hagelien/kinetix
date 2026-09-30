import { ENGINE_LIMITS } from '@/lib/kinetics-core';
import type {
  DrugSimConfig,
  DrugSimInputs,
  DoseEvent,
  MeasurementEvent,
  QueryEvent,
  QuestionMode,
  RouteType,
  SimEvent,
  SimulationWarning,
} from '@/types/simulator';

export interface DerivedQuestion {
  questionMode: QuestionMode;
  inputs: DrugSimInputs;
  route: RouteType;
  /** Whether the events resolve to a runnable question. */
  complete: boolean;
  warnings: SimulationWarning[];
}

function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  );
}

/** Whether the derived inputs carry every numeric field the worker needs. */
export function inputsComplete(
  questionMode: QuestionMode,
  inputs: DrugSimInputs,
): boolean {
  switch (questionMode) {
    case 'earlier-from-later':
    case 'later-from-earlier':
      return (
        inputs.measuredConcentration != null &&
        inputs.measuredTime != null &&
        inputs.targetTime != null
      );
    case 'concentration-from-dose':
      return inputs.dose != null && inputs.timeSinceDose != null;
    case 'dose-from-concentration':
      return (
        inputs.measuredConcentration != null && inputs.timeSinceDose != null
      );
    default:
      return false;
  }
}

const isDose = (e: SimEvent): e is DoseEvent => e.type === 'dose';
const isMeasurement = (e: SimEvent): e is MeasurementEvent =>
  e.type === 'measurement';
const isQuery = (e: SimEvent): e is QueryEvent => e.type === 'query';

function elapsedSinceDose(
  eventTime: number | undefined,
  doseTime: number | undefined,
): number | undefined {
  if (eventTime == null || doseTime == null) return undefined;
  const elapsed = eventTime - doseTime;
  return elapsed >= 0 ? elapsed : undefined;
}

function sortTime(event: SimEvent): number {
  return event.t ?? Number.POSITIVE_INFINITY;
}

/**
 * Derive the question being answered (and the flat inputs the Monte Carlo worker
 * expects) from a component's events. When the component has no events we fall
 * back to the legacy `questionMode`/`inputs`/`route` fields so existing UI and
 * saved cases keep working unchanged.
 */
export function deriveQuestion(config: DrugSimConfig): DerivedQuestion {
  const hasEventList = Array.isArray(config.events);
  const events = hasEventList ? config.events : [];

  if (!hasEventList) {
    const inputs = config.inputs ?? {};
    return {
      questionMode: config.questionMode,
      inputs,
      route: config.route,
      complete: inputsComplete(config.questionMode, inputs),
      warnings: [],
    };
  }

  const sorted = [...events].sort((a, b) => sortTime(a) - sortTime(b));
  const doses = sorted.filter(isDose);
  const measurements = sorted.filter(isMeasurement);
  const queries = sorted.filter(isQuery);

  const lastDose = doses[doses.length - 1];
  const lastDoseWithAmount = [...doses].reverse().find((d) => d.amount != null);
  const lastMeasurement = measurements[measurements.length - 1];
  const lastQuery = queries[queries.length - 1];
  const route: RouteType =
    lastDoseWithAmount?.route ?? lastDose?.route ?? config.route ?? 'oral';
  const weight = config.weight;

  const warnings: SimulationWarning[] = [];
  // The forward concentration-from-dose path now superposes every dose, so the
  // "latest dose only" limitation only applies to dose-from-concentration
  // (inferring a dose still uses the single most recent dose). That warning is
  // pushed in the dose-solving branch below.
  const multipleDoses = doses.filter((d) => d.amount != null).length > 1;
  const latestDoseOnlyWarning: SimulationWarning = {
    type: 'model-limitation',
    messageKey: 'simulator.warnings.multipleDosesLatestOnly',
    message: 'simulator.warnings.multipleDosesLatestOnly',
    severity: 'warning',
  };
  // The Lite engine only distinguishes IV from everything else: oral,
  // insufflation, inhalation and "other" all share the immediate-absorption
  // equation. Flag the routes whose name implies an absorption profile the
  // model does not actually apply, so the result does not overstate precision.
  if (
    route === 'insufflation' ||
    route === 'inhalation' ||
    route === 'other'
  ) {
    warnings.push({
      type: 'model-limitation',
      messageKey: 'simulator.warnings.routeApproximated',
      message: 'simulator.warnings.routeApproximated',
      severity: 'warning',
    });
  }

  // dose-from-concentration: a measurement plus a query that solves for dose.
  // The concentration belongs to the measurement, so the elapsed time used for
  // back-calculation must run from the dose to the MEASUREMENT — not to the
  // query. A query selects the quantity to report; it does not relocate the
  // observation in time.
  if (lastQuery?.solveFor === 'dose' && lastMeasurement && lastDose) {
    const inputs = {
      measuredConcentration: lastMeasurement.value,
      concentrationUnit: lastMeasurement.unit,
      timeSinceDose: elapsedSinceDose(lastMeasurement.t, lastDose.t),
      weight,
    };
    return {
      questionMode: 'dose-from-concentration',
      inputs,
      route,
      complete: inputsComplete('dose-from-concentration', inputs),
      warnings: multipleDoses ? [...warnings, latestDoseOnlyWarning] : warnings,
    };
  }
  if (lastQuery?.solveFor === 'dose') {
    return {
      questionMode: 'dose-from-concentration',
      inputs: {
        measuredConcentration: lastMeasurement?.value,
        concentrationUnit: lastMeasurement?.unit,
        weight,
      },
      route,
      complete: false,
      warnings: multipleDoses ? [...warnings, latestDoseOnlyWarning] : warnings,
    };
  }

  // concentration-from-dose: a dose with a known amount plus a query time.
  if (lastDoseWithAmount && lastQuery?.solveFor === 'concentration') {
    const inputs = {
      dose: lastDoseWithAmount.amount,
      doseUnit: lastDoseWithAmount.unit,
      timeSinceDose: elapsedSinceDose(lastQuery.t, lastDoseWithAmount.t),
      weight,
    };
    return {
      questionMode: 'concentration-from-dose',
      inputs,
      route,
      complete: inputsComplete('concentration-from-dose', inputs),
      warnings,
    };
  }

  // concentration-to-concentration extrapolation: a measurement plus a query time.
  if (lastMeasurement && lastQuery?.solveFor === 'concentration') {
    const questionMode: QuestionMode =
      lastQuery.t != null &&
      lastMeasurement.t != null &&
      lastQuery.t < lastMeasurement.t
        ? 'earlier-from-later'
        : 'later-from-earlier';
    const inputs = {
      measuredConcentration: lastMeasurement.value,
      concentrationUnit: lastMeasurement.unit,
      measuredTime: lastMeasurement.t,
      targetTime: lastQuery.t,
    };
    return {
      questionMode,
      inputs,
      route,
      complete: inputsComplete(questionMode, inputs),
      warnings,
    };
  }

  // Not enough information yet to run a simulation.
  return {
    questionMode: config.questionMode ?? 'later-from-earlier',
    inputs: {},
    route,
    complete: false,
    warnings,
  };
}

/**
 * Pick a time window for the simulated curve that comfortably contains the
 * measured/target/dose times. Shared by both Monte Carlo config builders.
 */
export function inferTimeRange(
  questionMode: QuestionMode,
  inputs: DrugSimInputs,
): { start: number; end: number } {
  if (
    questionMode === 'earlier-from-later' ||
    questionMode === 'later-from-earlier'
  ) {
    const measured = inputs.measuredTime ?? 0;
    const target = inputs.targetTime ?? 24;
    const start = Math.min(measured, target, 0);
    const end = Math.max(Math.max(measured, target) * 3, 24);
    return { start, end };
  }
  if (inputs.timeSinceDose) {
    return { start: 0, end: Math.max(inputs.timeSinceDose * 3, 24) };
  }
  return { start: 0, end: 24 };
}

/** Synthesize events from the legacy questionMode + inputs of a saved config. */
function eventsFromLegacy(config: DrugSimConfig): SimEvent[] {
  const inp = config.inputs ?? {};
  const route = config.route ?? 'oral';
  const concUnit = inp.concentrationUnit ?? 'mg/L';
  const doseUnit = inp.doseUnit ?? 'mg';

  switch (config.questionMode) {
    case 'later-from-earlier':
    case 'earlier-from-later': {
      const out: SimEvent[] = [];
      if (inp.measuredConcentration != null) {
        out.push({
          id: newId(),
          type: 'measurement',
          t: inp.measuredTime ?? 0,
          value: inp.measuredConcentration,
          unit: concUnit,
        });
      }
      if (inp.targetTime != null) {
        out.push({
          id: newId(),
          type: 'query',
          t: inp.targetTime,
          solveFor: 'concentration',
        });
      }
      return out;
    }
    case 'concentration-from-dose': {
      const out: SimEvent[] = [];
      if (inp.dose != null) {
        out.push({
          id: newId(),
          type: 'dose',
          t: 0,
          amount: inp.dose,
          unit: doseUnit,
          route,
        });
      }
      if (inp.timeSinceDose != null) {
        out.push({
          id: newId(),
          type: 'query',
          t: inp.timeSinceDose,
          solveFor: 'concentration',
        });
      }
      return out;
    }
    case 'dose-from-concentration': {
      const out: SimEvent[] = [];
      out.push({ id: newId(), type: 'dose', t: 0, unit: doseUnit, route });
      if (inp.timeSinceDose != null || inp.measuredConcentration != null) {
        out.push({
          id: newId(),
          type: 'measurement',
          t: inp.timeSinceDose,
          value: inp.measuredConcentration,
          unit: concUnit,
        });
        out.push({
          id: newId(),
          type: 'query',
          t: inp.timeSinceDose,
          solveFor: 'dose',
        });
      }
      return out;
    }
    default:
      return [];
  }
}

/**
 * Normalise a draw-count override the way the run does (truncate, cap at
 * `ENGINE_LIMITS.maxDraws`); a non-finite or non-positive value is dropped so the
 * default applies.
 */
export function normalizeDrawOverride(n: number): number | undefined {
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.min(Math.trunc(n), ENGINE_LIMITS.maxDraws);
}

/**
 * Ensure a config loaded from persistence carries an `events` array, deriving it
 * from the legacy fields when absent. Idempotent: configs that already have
 * events are returned unchanged.
 */
export function migrateDrugConfig(config: DrugSimConfig): DrugSimConfig {
  const drawCount = config.overrides?.drawCount;
  if (drawCount != null && normalizeDrawOverride(drawCount) !== drawCount) {
    // A saved/imported case can carry an out-of-range draw count; normalise it so the
    // displayed and persisted input is the value the run actually uses.
    config = {
      ...config,
      overrides: { ...config.overrides, drawCount: normalizeDrawOverride(drawCount) },
    };
  }
  if (config.events && config.events.length > 0) return config;
  return {
    ...config,
    events: eventsFromLegacy(config),
    weight: config.weight ?? config.inputs?.weight,
  };
}
