/**
 * Assemble a full drug model definition from its per-route derivations (CV-4c, catalog-coverage
 * track).
 *
 * CV-4b's `assembleRouteParams` builds ONE route's `RouteModelParams`; this builds the whole
 * `DrugModelDefinition` the registry holds — the `RouteId`-keyed routes map plus the catalog
 * metadata (analyte, display name, matrix, validation status, dose bases, aliases). It is the pure
 * step between the route-keyed derivation (`resolveDrugModelsByRoute`, CV-2c) and the DB-reading
 * generation that emits the checksummed snapshot (CV-4c continued): a caller supplies one
 * derivation + its canonical-unit median values per administration route, and this assembles the
 * routes that are runnable into a definition.
 *
 * "Missing stays missing" holds per route: a route whose derivation is not-modelable, or whose
 * required parameters the catalog cannot supply, is REPORTED (`routeOutcomes`) and simply left out
 * of the routes map — never assembled from data it lacks. A drug modelable on one route (e.g. IV
 * bolus from t½ + Vd) but not another (oral, missing `ka`) yields a definition with just the
 * runnable route; only when NO route assembles is the whole drug `not-modelable` (no curve).
 *
 * Pure and additive: engine vocabulary only, no DB read, no equation/solver/scenario change, so no
 * `CORE_VERSION` bump. The DB→canonical unit conversion, `vdScaling` inference, and the catalog
 * metadata are the read adapter's concern; this consumes them.
 */
import { assembleRouteParams, type AssemblyRanges, type AssemblyValues } from './assemble-model.js';
import { requiredCovariatesForVdScaling } from './scaling.js';
import type { DerivedModel, RouteProvenance } from './derive-model.js';
import type { InputSource } from './derived-grade.js';
import type { ModelStructure, RequiredParam, StructureRequirementOptions } from './model-structure.js';
import type {
  CovariateId,
  DoseBasis,
  DrugModelDefinition,
  Matrix,
  RouteId,
  RouteModelParams,
  ValidationStatus,
  VdScaling,
} from './types.js';

/** One administration route's derivation plus the canonical-unit median values to assemble it. */
export interface RouteAssemblyInput {
  route: RouteId;
  /** The route's derived model (from `resolveDrugModelsByRoute`, CV-2c). */
  derived: DerivedModel;
  /** Canonical-unit median values for this route's parameter roles (the `fixed(median)` policy). */
  values: AssemblyValues;
  /** How this route's Vd scales to the subject (inferred from the stored unit by the read adapter). */
  vdScaling?: VdScaling;
  /**
   * Roles in `values` whose number was INFERRED from another stored observable rather than read
   * from a cited entry (today: `ka` solved from `tmax`, `ka-inference.ts`). Carried through to the
   * route's outcome so the grade and the disclosure at the curve can name it — an inferred value
   * must never be indistinguishable from a catalog one.
   */
  inferredParameters?: readonly RequiredParam[];
  /**
   * Why an inference the read adapter attempted was REFUSED (e.g. a stored `tmax`/half-life pair in
   * the flip-flop regime). Carried through so the coverage report can tell a curator "the observable
   * was there and the arithmetic rejected it" apart from "the observable is missing" — the first is
   * a data-quality finding about the drug, the second is just a gap.
   */
  inferenceDeclined?: string;
  /**
   * Whether the catalog NAMED this route, or the read adapter attributed it from evidence only a
   * route can produce (a drug-level Tmax/F) while the route's own label was unstated. Defaults to
   * `asserted`. Carried through to the route's outcome so the grade record can disclose it — an
   * attributed route must never be indistinguishable from a curated one.
   */
  routeProvenance?: RouteProvenance;
  /**
   * The ASSERTED structure axes this route runs in a simpler form than declared, keyed by axis with
   * the declared value (today: `{ disposition: 'two-compartment' }` run as one-compartment, because
   * the catalog cannot yet supply the two-compartment micro-constants). `derived.structure` is what
   * runs; this is what the evidence describes. Carried through so the grade counts the gap and a
   * simplified curve is never indistinguishable from one that runs the declared model.
   */
  simplifiedFrom?: Partial<ModelStructure>;
  /**
   * Roles in `values` filled with a labelled cautious default because the catalog holds no value
   * (today: F = 1 and a fast `ka`). Carried through so the grade and the disclosure can name them —
   * a defaulted value must never be indistinguishable from a catalog one.
   */
  defaultedParameters?: readonly RequiredParam[];
  /**
   * Where each catalog-supplied role's number came from, for the grade record only — the
   * assembler does not read it. Kept here so the read adapter can hand it to the snapshot builder
   * with the rest of the route's grade facts.
   */
  inputSources?: Partial<Record<RequiredParam, InputSource>>;
  /**
   * The reported spread for each role in `values`, when the catalog holds one (the lowest and
   * highest value its sources report, canonical units). A usable spread makes that role a
   * triangular spec instead of `fixed(median)` — see `assembleRouteParams`.
   */
  ranges?: AssemblyRanges;
  /** Basis-dependent CL/V rules, when the caller can supply them. */
  opts?: StructureRequirementOptions;
}

/**
 * Catalog metadata for the drug — the parts of a `DrugModelDefinition` the engine cannot derive
 * from parameters, supplied by the read adapter (analyte identity, display name, native matrix,
 * validation status, dose bases, aliases/citations).
 */
export interface DrugDefinitionMetadata {
  analyte: string;
  displayName: string;
  modelId: string;
  matrix: Matrix;
  validationStatus: ValidationStatus;
  supportedBases: DoseBasis[];
  aliases?: string[];
  /** Covariates the assembled model uses; a `fixed(median)` derived model uses none by default. */
  supportedCovariates?: CovariateId[];
  references?: string[];
  notes?: string;
}

/** The outcome of assembling one route — for grading/disclosure at the definition level. */
export interface RouteAssemblyOutcome {
  route: RouteId;
  outcome: 'assembled' | 'incomplete' | 'unsupported';
  /** Required roles absent for a supported-but-incomplete route. */
  missing?: RequiredParam[];
  /** Roles whose value was inferred rather than cited (carried from the input, for grading). */
  inferred?: RequiredParam[];
  /** Why an attempted inference was refused (carried from the input, for the coverage report). */
  inferenceDeclined?: string;
  /** Why a route could not be assembled (not-modelable, or a family not yet mapped). */
  reason?: string;
  /** Whether the catalog named this route or the read adapter attributed it (carried from the input). */
  routeProvenance?: RouteProvenance;
  /** Declared structure axes this route runs in simplified form (carried from the input). */
  simplifiedFrom?: Partial<ModelStructure>;
  /** Roles filled with a cautious default (carried from the input). */
  defaulted?: RequiredParam[];
}

/** The outcome of assembling a whole drug's definition. */
export type DrugDefinitionAssembly =
  | { outcome: 'assembled'; definition: DrugModelDefinition; routeOutcomes: RouteAssemblyOutcome[] }
  | { outcome: 'not-modelable'; routeOutcomes: RouteAssemblyOutcome[]; reason: string };

/**
 * Assemble a `DrugModelDefinition` from a drug's catalog metadata and its per-route derivations.
 * Each route is assembled independently (CV-4b); the runnable routes go into the definition's
 * routes map, the rest are reported. `not-modelable` when no route is runnable. Pure.
 *
 * @throws if two inputs name the same `RouteId` — the read adapter yields one input per route, so a
 *   duplicate is a generation bug, surfaced rather than silently dropping one.
 */
export function assembleDrugDefinition(
  metadata: DrugDefinitionMetadata,
  routes: readonly RouteAssemblyInput[],
): DrugDefinitionAssembly {
  const routeOutcomes: RouteAssemblyOutcome[] = [];
  const assembledRoutes: Partial<Record<RouteId, RouteModelParams>> = {};
  // Every route id seen, whatever its outcome — a duplicate must be rejected even when the first
  // occurrence was incomplete/unsupported (and so never entered `assembledRoutes`).
  const seenRoutes = new Set<RouteId>();
  // The Vd scaling of each ASSEMBLED route, so the definition can declare the covariates those
  // scalings consume (below).
  const assembledScalings: (VdScaling | undefined)[] = [];

  for (const input of routes) {
    if (seenRoutes.has(input.route)) {
      throw new Error(`assembleDrugDefinition: duplicate route "${input.route}"`);
    }
    seenRoutes.add(input.route);
    const result = assembleRouteParams(input.derived, input.values, {
      ...input.opts,
      vdScaling: input.vdScaling,
      ...(input.ranges ? { ranges: input.ranges } : {}),
    });
    // An inference only ever ADDS a value, so it cannot change whether a route assembles — but it
    // must ride along with whichever outcome results, so the grade sees it.
    const inferred = {
      ...(input.inferredParameters && input.inferredParameters.length > 0
        ? { inferred: [...input.inferredParameters] }
        : {}),
      ...(input.inferenceDeclined ? { inferenceDeclined: input.inferenceDeclined } : {}),
      // An attributed route rides along with every outcome for the same reason an inference does:
      // whichever way the route lands, the grade and the coverage report must be able to say the
      // route itself was assumed.
      ...(input.routeProvenance && input.routeProvenance !== 'asserted'
        ? { routeProvenance: input.routeProvenance }
        : {}),
      ...(input.simplifiedFrom ? { simplifiedFrom: { ...input.simplifiedFrom } } : {}),
      ...(input.defaultedParameters && input.defaultedParameters.length > 0
        ? { defaulted: [...input.defaultedParameters] }
        : {}),
    };
    if (result.outcome === 'assembled') {
      assembledRoutes[input.route] = result.params;
      assembledScalings.push(input.vdScaling);
      routeOutcomes.push({ route: input.route, outcome: 'assembled', ...inferred });
    } else if (result.outcome === 'incomplete') {
      routeOutcomes.push({
        route: input.route,
        outcome: 'incomplete',
        missing: result.missing,
        ...inferred,
      });
    } else {
      routeOutcomes.push({
        route: input.route,
        outcome: 'unsupported',
        reason: result.reason,
        ...inferred,
      });
    }
  }

  if (Object.keys(assembledRoutes).length === 0) {
    return {
      outcome: 'not-modelable',
      routeOutcomes,
      reason:
        routes.length === 0
          ? 'no administration route was supplied'
          : 'no administration route could be assembled into a runnable model',
    };
  }

  // Declare the covariates the assembled routes' Vd scalings consume (lean-body-mass → height+sex,
  // widmark → age+height+sex). Without this a subject's height/sex would BOTH drive the Vd and draw
  // a contradictory `covariate-not-modelled` limitation. Merged with any caller-supplied set and
  // sorted for a deterministic snapshot checksum.
  const covariates = new Set<CovariateId>(metadata.supportedCovariates ?? []);
  for (const scaling of assembledScalings) {
    for (const covariate of requiredCovariatesForVdScaling(scaling)) covariates.add(covariate);
  }

  const definition: DrugModelDefinition = {
    analyte: metadata.analyte,
    displayName: metadata.displayName,
    modelId: metadata.modelId,
    matrix: metadata.matrix,
    validationStatus: metadata.validationStatus,
    routes: assembledRoutes,
    supportedCovariates: [...covariates].sort(),
    supportedBases: metadata.supportedBases,
    ...(metadata.aliases ? { aliases: metadata.aliases } : {}),
    ...(metadata.references ? { references: metadata.references } : {}),
    ...(metadata.notes ? { notes: metadata.notes } : {}),
  };
  return { outcome: 'assembled', definition, routeOutcomes };
}
