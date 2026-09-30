/**
 * The live half of the "How the simulator works" page (`/modeling/how-it-works`).
 *
 * `docs/simulator-mechanics.md` carries the PROSE — the premises, the reasoning, the
 * strengths and weaknesses a reviewer reads. This module carries every FACT that page
 * states about the running system: which analytes resolve, which model families exist,
 * which compute guardrails apply, which subjects a model needs. Those are read out of
 * `kinetics-core` and the app's engine layer at render time, so they cannot describe
 * last quarter's simulator — a registry entry added, a family implemented, or a cap
 * changed moves the published page in the same commit.
 *
 * The split is deliberate: prose that a code change can invalidate is kept OUT of the
 * markdown and rendered from here instead, and the prose that remains is pinned by
 * `src/lib/__tests__/simulatorMechanics.test.ts`, which fails when the document and the
 * engine disagree.
 *
 * Pure and dependency-free of React: everything here is data, so the drift test can
 * assert on it without rendering.
 */
import {
  CORE_VERSION,
  ENGINE_LIMITS,
  MODEL_FAMILIES,
  MODEL_FAMILY_EVALUATION,
  ROUTE_IDS,
  SCENARIO_SCHEMA_VERSION,
  derivedRegistryRolloutEnabled,
  loadOfflineRegistry,
  requiredCovariatesForVdScaling,
  resolvedRegistryRelease,
  type CovariateId,
  type DrugModelDefinition,
  type ModelFamily,
  type RouteId,
  type RouteModelParams,
} from '@/lib/kinetics-core';
import { CRITICAL_ESS_RATIO, LOW_ESS_RATIO } from '@/lib/compute/liteInference';
import {
  DEFAULT_DRAW_COUNT,
  DEFAULT_SEED,
  MAX_TIME_STEPS,
  MIN_TIME_STEPS,
  TARGET_STEP_HOURS,
} from '@/stores/simulatorStore';

/** The release identifiers a run manifest is stamped with. */
export interface MechanicsVersions {
  /** Engine (equation/solver/contract) release. */
  coreVersion: string;
  /** Scenario contract version the engine accepts. */
  scenarioSchemaVersion: string;
  /** The release a rendering consumer actually resolves models through. */
  registryVersion: string;
  registryChecksum: string;
  /** Whether catalog-derived models are served alongside the reviewed tier. */
  derivedTierEnabled: boolean;
}

export function mechanicsVersions(): MechanicsVersions {
  const release = resolvedRegistryRelease();
  return {
    coreVersion: CORE_VERSION,
    scenarioSchemaVersion: SCENARIO_SCHEMA_VERSION,
    registryVersion: release.version,
    registryChecksum: release.checksum,
    derivedTierEnabled: derivedRegistryRolloutEnabled(),
  };
}

/** One administration route of one model, as the page tabulates it. */
export interface MechanicsRouteRow {
  route: RouteId;
  family: ModelFamily;
  /** Subject covariates this route's Vd scaling requires, beyond body weight. */
  requiredCovariates: CovariateId[];
}

/** One resolvable model, as the page tabulates it. */
export interface MechanicsModelRow {
  analyte: string;
  aliases: string[];
  displayName: string;
  modelId: string;
  /** The matrix the model natively computes in. */
  matrix: string;
  validationStatus: string;
  routes: MechanicsRouteRow[];
  /** Reviewed latent→observed matrix conversions the model declares. */
  matrixTransforms: Array<{ from: string; to: string; ratio: number }>;
  /** Reviewed observation residual-error layers that widen the reported bands. */
  observationErrorLayers: string[];
  /**
   * True when EVERY route runs for a subject described by body weight alone — which is
   * all the forward simulator currently supplies (see `docs/simulator-mechanics.md` §8).
   * False means the model resolves but the run fails for want of a covariate.
   */
  runsOnWeightOnlySubject: boolean;
  /**
   * True when at least one route parameter is a DISTRIBUTION rather than a point value.
   * Where every parameter is a point value, every Monte-Carlo draw reproduces the same
   * curve and the reported percentile bands collapse onto the median — the run is
   * deterministic no matter how many draws are requested. That is a property a reviewer
   * must be able to see, because a curve with no visible band looks like a precise
   * prediction rather than an uncharacterised one.
   */
  carriesParameterDistributions: boolean;
  /**
   * Whether the reported bands can be wider than the median curve at all: either a
   * parameter distribution or a declared observation-error layer must be present.
   */
  bandsCarryUncertainty: boolean;
}

/** The covariates the forward simulator supplies today. Body weight, and nothing else. */
export const FORWARD_SUBJECT_COVARIATES: CovariateId[] = ['weightKg'];

function routeRow(route: RouteId, params: RouteModelParams): MechanicsRouteRow {
  // `one-compartment-clv` carries reference-subject volumes and declares no
  // weight-proportional Vd scaling, so it has no scaling-driven covariate need; every
  // other family scales Vd, defaulting to total body weight when unstated.
  const scaling =
    params.family === 'one-compartment-clv'
      ? null
      : (params.vdScaling ?? 'total-weight');
  const required = scaling ? [...requiredCovariatesForVdScaling(scaling)] : [];
  return {
    route,
    family: params.family,
    // Body weight is always supplied, so listing it as a "requirement" would read as a
    // gap. Report only what the run additionally needs.
    requiredCovariates: required.filter(
      (c) => !FORWARD_SUBJECT_COVARIATES.includes(c),
    ),
  };
}

/** The `ParamSpec` kinds that actually spread. `fixed` is a point value. */
const SPREADING_PARAM_KINDS = new Set(['uniform', 'triangular', 'lognormal']);

/**
 * Whether a route's parameter block contains any spreading `ParamSpec`.
 *
 * Walked structurally rather than field by field: each family declares its parameters
 * under its own names, and a family added later must not silently report "no
 * distributions" here because this function had not been taught its field names.
 */
function hasSpreadingParam(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind === 'string' && SPREADING_PARAM_KINDS.has(kind)) return true;
  return Object.values(value as Record<string, unknown>).some((v) =>
    hasSpreadingParam(v, depth + 1),
  );
}

function modelRow(definition: DrugModelDefinition): MechanicsModelRow {
  const routes = (
    Object.entries(definition.routes) as Array<
      [RouteId, RouteModelParams | undefined]
    >
  ).flatMap(([route, params]) => (params ? [routeRow(route, params)] : []));
  const observationErrorLayers = (definition.observationError ?? []).map(
    (l) => l.layer,
  );
  const carriesParameterDistributions = Object.values(definition.routes).some(
    (params) => hasSpreadingParam(params),
  );
  return {
    analyte: definition.analyte,
    aliases: [...(definition.aliases ?? [])],
    displayName: definition.displayName,
    modelId: definition.modelId,
    matrix: definition.matrix,
    validationStatus: definition.validationStatus,
    routes,
    matrixTransforms: (definition.matrixTransforms ?? []).map((t) => ({
      from: t.from,
      to: t.to,
      ratio: t.ratio,
    })),
    observationErrorLayers,
    runsOnWeightOnlySubject: routes.every(
      (r) => r.requiredCovariates.length === 0,
    ),
    carriesParameterDistributions,
    bandsCarryUncertainty:
      carriesParameterDistributions || observationErrorLayers.length > 0,
  };
}

/**
 * Every model the app can resolve, alphabetically by analyte. Read through the SAME
 * accessor the simulator resolves through (`loadOfflineRegistry`), so the page lists
 * what would actually run, not the reviewed tier the file happens to declare.
 */
export function mechanicsModels(): MechanicsModelRow[] {
  return loadOfflineRegistry()
    .snapshot.definitions.map(modelRow)
    .sort((a, b) => a.analyte.localeCompare(b.analyte));
}

/** One implemented model family and how its curve is evaluated. */
export interface MechanicsFamilyRow {
  family: ModelFamily;
  evaluation: 'closed-form' | 'ode';
  /** Analytes in the resolvable release that use this family on at least one route. */
  usedBy: string[];
}

export function mechanicsFamilies(): MechanicsFamilyRow[] {
  const models = mechanicsModels();
  return MODEL_FAMILIES.map((family) => ({
    family,
    evaluation: MODEL_FAMILY_EVALUATION[family],
    usedBy: models
      .filter((m) => m.routes.some((r) => r.family === family))
      .map((m) => m.analyte),
  }));
}

/** The route vocabulary the engine accepts, and how many models declare each. */
export function mechanicsRouteCoverage(): Array<{
  route: RouteId;
  analytes: string[];
}> {
  const models = mechanicsModels();
  return ROUTE_IDS.map((route) => ({
    route,
    analytes: models
      .filter((m) => m.routes.some((r) => r.route === route))
      .map((m) => m.analyte),
  }));
}

/** A numeric guardrail or default, with the plain-language meaning the page shows. */
export interface MechanicsLimitRow {
  id: string;
  value: number;
}

/**
 * Every number that bounds or configures a run, read from the engine and the store.
 * Labels live in the locale files keyed by `id`; only the values come from here, so a
 * changed constant is republished without a translation edit.
 */
export function mechanicsLimits(): MechanicsLimitRow[] {
  return [
    { id: 'defaultDraws', value: DEFAULT_DRAW_COUNT },
    { id: 'defaultSeed', value: DEFAULT_SEED },
    { id: 'targetStepHours', value: TARGET_STEP_HOURS },
    { id: 'minTimeSteps', value: MIN_TIME_STEPS },
    { id: 'maxTimeSteps', value: MAX_TIME_STEPS },
    { id: 'maxGridPoints', value: ENGINE_LIMITS.maxGridPoints },
    { id: 'maxDraws', value: ENGINE_LIMITS.maxDraws },
    { id: 'maxSimCells', value: ENGINE_LIMITS.maxSimCells },
    { id: 'maxOdeWork', value: ENGINE_LIMITS.maxOdeWork },
    { id: 'maxOdeDoses', value: ENGINE_LIMITS.maxOdeDoses },
    // Ids of engine-sourced rows match their `ENGINE_LIMITS` key exactly, so the drift
    // guard can assert exhaustiveness by comparing keys rather than by a hand-kept list
    // that a new guardrail would silently escape.
    {
      id: 'notRobustSurvivingDrawRatio',
      value: ENGINE_LIMITS.notRobustSurvivingDrawRatio,
    },
    { id: 'minSubjectWeightKg', value: ENGINE_LIMITS.minSubjectWeightKg },
    {
      id: 'peakRefineStepHours',
      value: ENGINE_LIMITS.peakRefineStepHours,
    },
    {
      id: 'maxPeakRefineSamples',
      value: ENGINE_LIMITS.maxPeakRefineSamples,
    },
    { id: 'maxPeakRefineEvals', value: ENGINE_LIMITS.maxPeakRefineEvals },
    { id: 'minPeakRefineScan', value: ENGINE_LIMITS.minPeakRefineScan },
    { id: 'lowEssRatio', value: LOW_ESS_RATIO },
    { id: 'criticalEssRatio', value: CRITICAL_ESS_RATIO },
  ];
}

/** The three compute engines a modelling component can select. */
export const MECHANICS_ENGINE_IDS = [
  'pk-montecarlo',
  'ethanol-widmark',
  'kinelab-bayes',
] as const;

export type MechanicsEngineId = (typeof MECHANICS_ENGINE_IDS)[number];

/**
 * The live blocks `docs/simulator-mechanics.md` may request, as `{{live:<id>}}` on a line
 * of its own. The page implements exactly these; the drift test asserts the document
 * requests no other, so a token can never render as literal text on the published page.
 */
export const LIVE_BLOCK_IDS = [
  'versions',
  'models',
  'families',
  'limits',
] as const;

export type LiveBlockId = (typeof LIVE_BLOCK_IDS)[number];

const LIVE_TOKEN = /^\{\{live:([a-z-]+)\}\}$/;

export type MechanicsDocPart =
  | { kind: 'prose'; text: string }
  | { kind: 'live'; id: string };

/**
 * Split the document into prose chunks and the live blocks interleaved between them.
 * Shared by the page and the drift test so both agree on what a token is.
 */
export function splitMechanicsDocument(markdown: string): MechanicsDocPart[] {
  const parts: MechanicsDocPart[] = [];
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text) parts.push({ kind: 'prose', text });
    buffer = [];
  };
  for (const line of markdown.split('\n')) {
    const match = LIVE_TOKEN.exec(line.trim());
    if (match) {
      flush();
      parts.push({ kind: 'live', id: match[1]! });
    } else {
      buffer.push(line);
    }
  }
  flush();
  return parts;
}
