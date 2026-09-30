/**
 * Derive a runnable model from a drug's DB declarations (CV-2, catalog-coverage track).
 *
 * CV-1a's `model-structure.ts` answers "given a COMPLETE `ModelStructure` and a set of present
 * parameters, does the engine run it, and what is missing?" (`validateModelStructure`). This module
 * adds the layer the catalog derivation needs on top of that:
 *
 *   1. **The disclosed default policy (plan §2).** A drug declares each axis independently and may
 *      leave any of them unstated. An unstated axis defaults to the LINEAR ONE-COMPARTMENT shape
 *      (one-compartment / first-order elimination / first-order extravascular absorption), and the
 *      derivation records WHICH axes were defaulted vs asserted — so a default is always a disclosed
 *      assumption, never presented with the authority of a reviewed model. A *stated* axis is never
 *      overridden, and a stated-but-unrecognized value (a future or corrupt vocabulary) is passed
 *      through to compose as `not-modelable` rather than silently replaced by the default — unknown
 *      model science must not masquerade as a supported family.
 *
 *   2. **The runnability outcome (plan §1/§2 "missing stays missing").** The resolved structure is
 *      composed and validated; the result is `modelable` (the engine has the family and can
 *      construct the route) or `not-modelable` with a reason. A `modelable` result may still be
 *      *incomplete* — required parameters absent — which is reported (`missingParameters`) for the
 *      grading slice (CV-3) to grade and widen bands, not a reason to withhold the family here.
 *
 * Pure and additive, like CV-1a: no equation/solver/scenario change, so no `CORE_VERSION` bump.
 * This module does not read the DB or the engine registry — a caller (CV-2 wiring) maps stored
 * declarations + numeric parameters onto these inputs. Absorption is taken as a single axis value
 * here (one route); keying declarations by route is the DB/read concern the wiring owns.
 */
import type { ModelFamily } from './types.js';
import {
  validateModelStructure,
  type AbsorptionKind,
  type DispositionKind,
  type EliminationKind,
  type ModelStructure,
  type RequiredParam,
  type StructureRequirementOptions,
} from './model-structure.js';

/**
 * A drug's model-structure declaration as stored: each axis independently stated or absent. Runtime
 * callers may pass a value from a future/corrupt vocabulary (the DB is the source of truth, not the
 * type checker); such a value is not defaulted — it composes to `not-modelable`.
 */
export interface ModelStructureDeclaration {
  disposition?: DispositionKind | null;
  elimination?: EliminationKind | null;
  absorption?: AbsorptionKind | null;
}

/** Whether an axis value came from the drug's declaration or from the disclosed default. */
export type AxisProvenance = 'asserted' | 'defaulted';

/**
 * Whether an administration route was NAMED by the drug's declarations (`asserted`), or attributed
 * by a read adapter from evidence that only a route can produce while the route's label itself was
 * unstated (`attributed`).
 *
 * The route axis's counterpart to `AxisProvenance`, and disclosed for the same reason: an
 * attributed route is a disclosed assumption, and a curve must never present one as a curated fact.
 */
export type RouteProvenance = 'asserted' | 'attributed';

/**
 * The linear one-compartment default an unstated axis takes (plan §2). First-order extravascular
 * absorption is the generic catalog case; a drug given only IV states `bolus`/`iv-infusion`.
 */
export const MODEL_STRUCTURE_DEFAULTS: ModelStructure = {
  disposition: 'one-compartment',
  elimination: 'first-order',
  absorption: 'first-order',
};

/** The outcome of deriving a model from a declaration + the parameters present for the drug. */
export interface DerivedModel {
  /** `modelable`: the engine has the family and can construct the route (parameters may still be
   *  missing — see `missingParameters`). `not-modelable`: the axis combination is unsupported, or a
   *  required structural basis is absent, so no curve can be produced. */
  outcome: 'modelable' | 'not-modelable';
  /** The resolved structure — the declaration with defaults filled in for unstated axes. */
  structure: ModelStructure;
  /** Per-axis provenance, so a surface can disclose exactly which parts were defaulted. */
  axisProvenance: {
    disposition: AxisProvenance;
    elimination: AxisProvenance;
    absorption: AxisProvenance;
  };
  /** True when ANY axis was defaulted — the disclosed-default flag for the whole model (plan §2). */
  defaulted: boolean;
  /** The composed engine family, when `modelable`. */
  family?: ModelFamily;
  /** Why no curve can be produced, when `not-modelable`. */
  reason?: string;
  /** Required parameter roles absent for a `modelable` family — for grading (CV-3), not a rejection. */
  missingParameters?: RequiredParam[];
  /** Present parameter roles the family FORBIDS (e.g. a separate F on an apparent-extravascular CL/V
   *  model, where it is folded into Vc/F). A contradictory declaration: the outcome is
   *  `not-modelable` and `family` is omitted, so no curve is manufactured from it. */
  forbiddenParameters?: RequiredParam[];
}

/** Resolve a partial declaration into a full structure, recording which axes were defaulted. */
function resolveStructure(decl: ModelStructureDeclaration): {
  structure: ModelStructure;
  axisProvenance: DerivedModel['axisProvenance'];
} {
  // A stated value (even an unrecognized one) is kept; only null/undefined is defaulted. Keeping an
  // unrecognized value is deliberate: `composeModelFamily` then reports it as not-modelable instead
  // of the default masking unknown science.
  const disposition = decl.disposition ?? MODEL_STRUCTURE_DEFAULTS.disposition;
  const elimination = decl.elimination ?? MODEL_STRUCTURE_DEFAULTS.elimination;
  const absorption = decl.absorption ?? MODEL_STRUCTURE_DEFAULTS.absorption;
  const provenance = (v: unknown): AxisProvenance =>
    v === null || v === undefined ? 'defaulted' : 'asserted';
  return {
    structure: { disposition, elimination, absorption } as ModelStructure,
    axisProvenance: {
      disposition: provenance(decl.disposition),
      elimination: provenance(decl.elimination),
      absorption: provenance(decl.absorption),
    },
  };
}

/**
 * Derive a runnable model for one route from its declaration and the parameter roles present for
 * the drug. `present` is the set of `RequiredParam` roles the caller has numeric values for; `opts`
 * supplies the basis-dependent rules CV-1a defines (the CL/V identifiability bases). Pure.
 */
export function deriveModel(
  declaration: ModelStructureDeclaration,
  present: Iterable<RequiredParam>,
  opts?: StructureRequirementOptions,
): DerivedModel {
  const { structure, axisProvenance } = resolveStructure(declaration);
  const defaulted =
    axisProvenance.disposition === 'defaulted' ||
    axisProvenance.elimination === 'defaulted' ||
    axisProvenance.absorption === 'defaulted';

  // Delegate to CV-1a's authority: it composes the family, applies the basis-dependent CL/V rules,
  // derives the IV-infusion duration requirement from the absorption axis, and reports missing /
  // forbidden parameters and any structural basis error.
  const validation = validateModelStructure(structure, present, opts);

  // Not runnable when the axis combination is unsupported, or when a required structural basis is
  // absent/incoherent (a CL/V declaration the engine cannot construct even with every numeric
  // parameter present). Both are "missing stays missing", not a curve to grade.
  if (!validation.supported) {
    return { outcome: 'not-modelable', structure, axisProvenance, defaulted, reason: validation.reason };
  }
  if (validation.basisError) {
    return { outcome: 'not-modelable', structure, axisProvenance, defaulted, reason: validation.basisError };
  }
  // A present-but-FORBIDDEN parameter is a contradictory declaration, not a runnable one: an
  // apparent-extravascular CL/V route folds F into Vc/F, so a separately-declared bioavailability
  // has no role. The engine would silently run it with F=1 — dropping the declared value — which is
  // exactly the "never manufacture a curve from bad data" the plan forbids. Surface it as
  // not-modelable so the contradiction is curated (drop F, or restate the basis as absolute), and
  // still report which parameters are the problem. `family` is intentionally omitted so a consumer
  // keying on it cannot construct the route.
  if (validation.forbiddenParameters && validation.forbiddenParameters.length > 0) {
    return {
      outcome: 'not-modelable',
      structure,
      axisProvenance,
      defaulted,
      reason: `declaration includes parameter(s) the ${validation.family} family forbids: ${validation.forbiddenParameters.join(', ')}`,
      forbiddenParameters: validation.forbiddenParameters,
    };
  }

  return {
    outcome: 'modelable',
    structure,
    axisProvenance,
    defaulted,
    family: validation.family,
    missingParameters: validation.missingParameters,
  };
}
