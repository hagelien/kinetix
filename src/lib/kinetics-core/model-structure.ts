/**
 * Model-structure axes → engine model family (CV-1a, catalog-coverage track).
 *
 * The engine's `ModelFamily` is a flat union of 8 names that conflate three independent
 * scientific axes (and a structural link). To let a drug DECLARE its kinetics as reviewed,
 * citable data — rather than hand-authoring one registry entry per drug — this module models
 * those axes orthogonally and COMPOSES them into a `ModelFamily`:
 *
 *   - disposition  (molecule):  one- vs two-compartment
 *   - elimination  (molecule):  first-order, saturable (Michaelis–Menten), or the CL/V form
 *   - absorption   (route):     bolus, first-order, zero-order, mixed, or transit
 *
 * A combination the engine does not run resolves to `unsupported` (with a reason) — never
 * forced into the nearest family. This is the plan's "missing model science stays missing":
 * the derivation surfaces a gap instead of manufacturing a curve.
 *
 * Pure and additive: no equation/solver/scenario-result-contract change, so no `CORE_VERSION`
 * bump. The DB write-path (CV-1b) stores these axes as categorical parameter kinds and
 * validates each declaration against `validateModelStructure`; this module is the single
 * authority on which combinations are valid and what parameters each requires.
 *
 * Parent/metabolite (`parent-metabolite-first-order`) is NOT produced here: it is selected by a
 * drug-level structural LINK (a declared active metabolite), not by these single-analyte axes.
 */
import type { IdentifiabilityBasis, ModelFamily, RouteId } from './types.js';
import { isAbsoluteBasis, isApparentBasis, isCoherentClvDisposition } from './structural.js';

/** Disposition axis — a molecule property. The allowed values, as a runtime pick-list (the DB's
 * categorical parameter kinds and any UI dropdown derive their vocabulary from these). */
export const DISPOSITION_KINDS = ['one-compartment', 'two-compartment'] as const;
export type DispositionKind = (typeof DISPOSITION_KINDS)[number];

/** Elimination axis — a molecule property. `clv-structural` is the CL/Vc parameterisation
 * (SC-1A); `michaelis-menten` is saturable elimination (the ethanol / GHB shape). */
export const ELIMINATION_KINDS = ['first-order', 'michaelis-menten', 'clv-structural'] as const;
export type EliminationKind = (typeof ELIMINATION_KINDS)[number];

/** Absorption / input axis — a route/formulation property. `bolus` and `iv-infusion` are the two
 * IV inputs (instantaneous vs constant-rate into the central compartment, no bioavailability);
 * `zero-order` is the EXTRAVASCULAR constant-rate release (carries F). `transit` (a
 * transit-compartment / depot chain) has no engine family yet (SC-4B) and composes to
 * `unsupported`. */
export const ABSORPTION_KINDS = [
  'bolus',
  'iv-infusion',
  'first-order',
  'zero-order',
  'mixed',
  'transit',
] as const;
export type AbsorptionKind = (typeof ABSORPTION_KINDS)[number];

/** The two IV inputs — instantaneous (`bolus`) or constant-rate (`iv-infusion`) into the central
 *  compartment, no absorption phase, F = 1. The rest of `ABSORPTION_KINDS` are extravascular inputs
 *  that carry an absorption phase. */
export const IV_ABSORPTION_KINDS = ['bolus', 'iv-infusion'] as const satisfies readonly AbsorptionKind[];
const IV_ABSORPTIONS = new Set<AbsorptionKind>(IV_ABSORPTION_KINDS);

/** Whether an absorption kind is an IV input rather than an extravascular absorption phase. */
export function isIvAbsorptionKind(absorption: AbsorptionKind): boolean {
  return IV_ABSORPTIONS.has(absorption);
}

/** Absorption inputs that include a FIRST-ORDER absorption phase, i.e. the ones an absorption rate
 *  (`ka`) parameterises. `mixed` has a parallel first-order component; `bolus`/`iv-infusion` (IV)
 *  and `zero-order` (constant-rate) do not, so a `ka` authored for them is a contradiction. */
const FIRST_ORDER_ABSORPTIONS = new Set<AbsorptionKind>(['first-order', 'mixed']);

/** Whether an absorption kind carries a first-order absorption rate (`ka`). */
export function absorptionHasFirstOrderRate(absorption: AbsorptionKind): boolean {
  return FIRST_ORDER_ABSORPTIONS.has(absorption);
}

/** Routes that deliver directly into the central compartment with no absorption phase, so they
 *  REQUIRE an IV input shape and never take the extravascular absorption default. Today only
 *  intravenous; IM/SC/sublingual/rectal/inhaled all carry an absorption phase and are extravascular. */
const SYSTEMIC_INPUT_ROUTES = new Set<RouteId>(['iv']);

/**
 * Whether an absorption input shape is coherent with an administration route. An intravenous route
 * must use an IV input (`bolus`/`iv-infusion`); every extravascular route must use an extravascular
 * input (`first-order`/`zero-order`/`mixed`/`transit`). This stops a route-labelled model from
 * carrying the wrong input physics — an `iv` route silently taking the extravascular default, or an
 * `oral` route declared as an IV bolus. Route/absorption compatibility is a per-route rule (the
 * shape-keyed derivation has no route), so it lives here for the route-keyed derivation to enforce.
 */
export function absorptionCoherentWithRoute(route: RouteId, absorption: AbsorptionKind): boolean {
  return SYSTEMIC_INPUT_ROUTES.has(route) === isIvAbsorptionKind(absorption);
}

/** The three orthogonal axes for one route of a drug. */
export interface ModelStructure {
  disposition: DispositionKind;
  elimination: EliminationKind;
  absorption: AbsorptionKind;
}

/** A parameter role a family requires. The DB's parameter kinds map onto these roles; the
 * coupling here is what keeps an incoherent declaration (e.g. a saturable model with a
 * half-life and no Km) out of the store. */
export type RequiredParam =
  | 'ka'
  | 'vd'
  | 'centralVolume'
  | 'clearance'
  | 'bioavailability'
  | 'eliminationHalfLife'
  | 'k12'
  | 'k21'
  | 'vmax'
  | 'km'
  | 'zeroOrderDuration'
  | 'infusionDuration'
  | 'firstOrderFraction'
  | 'formationFraction'
  | 'metaboliteEliminationHalfLife'
  | 'metaboliteVd'
  | 'parentMolarMass'
  | 'metaboliteMolarMass';

/** Result of composing the axes into an engine family. */
export type ComposeResult =
  | { supported: true; family: ModelFamily }
  | { supported: false; reason: string };

/**
 * Compose the three axes into one engine `ModelFamily`, or report why the combination is not
 * runnable. Only the combinations the engine actually implements succeed; everything else is
 * `unsupported` with a human-readable reason (missing stays missing).
 */
const DISPOSITIONS = new Set<DispositionKind>(DISPOSITION_KINDS);
const ELIMINATIONS = new Set<EliminationKind>(ELIMINATION_KINDS);
const ABSORPTIONS = new Set<AbsorptionKind>(ABSORPTION_KINDS);

export function composeModelFamily(s: ModelStructure): ComposeResult {
  const { disposition, elimination, absorption } = s;

  // Positively validate each axis before any fallback: a persisted or JS-supplied value that is
  // missing or from a future vocabulary must resolve to `unsupported`, not slip through a
  // disposition/elimination fallback as one-compartment / first-order (unknown model science must
  // not masquerade as a supported family).
  if (!DISPOSITIONS.has(disposition)) {
    return { supported: false, reason: `unrecognized disposition "${String(disposition)}"` };
  }
  if (!ELIMINATIONS.has(elimination)) {
    return { supported: false, reason: `unrecognized elimination "${String(elimination)}"` };
  }
  if (!ABSORPTIONS.has(absorption)) {
    return { supported: false, reason: `unrecognized absorption "${String(absorption)}"` };
  }

  if (absorption === 'transit') {
    return { supported: false, reason: 'transit-compartment absorption is not yet modelled (SC-4B)' };
  }

  if (elimination === 'michaelis-menten') {
    if (disposition === 'one-compartment' && absorption === 'first-order') {
      return { supported: true, family: 'michaelis-menten' };
    }
    return {
      supported: false,
      reason: `saturable (Michaelis–Menten) elimination is modelled only for one-compartment disposition with first-order absorption, not ${disposition} + ${absorption} absorption`,
    };
  }

  if (elimination === 'clv-structural') {
    if (disposition === 'one-compartment' && absorption === 'first-order') {
      return { supported: true, family: 'one-compartment-clv' };
    }
    return {
      supported: false,
      reason: `the CL/V structural form is modelled only for one-compartment disposition with first-order absorption, not ${disposition} + ${absorption} absorption`,
    };
  }

  // elimination === 'first-order'
  if (disposition === 'two-compartment') {
    if (absorption === 'first-order') return { supported: true, family: 'two-compartment-first-order' };
    return {
      supported: false,
      reason: `two-compartment disposition is modelled only with first-order absorption, not ${absorption} absorption`,
    };
  }

  // one-compartment, first-order elimination
  switch (absorption) {
    case 'bolus':
    case 'iv-infusion':
      // Both are IV inputs into the one-compartment central space (F = 1). They share the family;
      // the constant-rate variant additionally requires an infusion duration (see requiredParams).
      return { supported: true, family: 'iv-one-compartment' };
    case 'first-order':
      return { supported: true, family: 'one-compartment-first-order' };
    case 'zero-order':
      return { supported: true, family: 'one-compartment-zero-order' };
    case 'mixed':
      return { supported: true, family: 'one-compartment-mixed-order' };
    default:
      return { supported: false, reason: `unsupported absorption "${absorption}"` };
  }
}

const REQUIRED_PARAMETERS: Record<ModelFamily, RequiredParam[]> = {
  'iv-one-compartment': ['eliminationHalfLife', 'vd'],
  'one-compartment-first-order': ['ka', 'eliminationHalfLife', 'vd', 'bioavailability'],
  'one-compartment-zero-order': ['zeroOrderDuration', 'eliminationHalfLife', 'vd', 'bioavailability'],
  'one-compartment-mixed-order': [
    'firstOrderFraction',
    'ka',
    'zeroOrderDuration',
    'eliminationHalfLife',
    'vd',
    'bioavailability',
  ],
  // CL/V structural: `bioavailability` (F) is BASIS-DEPENDENT — required for an absolute basis,
  // forbidden for apparent-extravascular (folded into Vc/F). It is added / forbidden by
  // `requiredParametersFor` / `forbiddenParametersFor` from the declared `clvBasis`, not here.
  'one-compartment-clv': ['ka', 'clearance', 'centralVolume'],
  // The volume is the CENTRAL compartment V1 (not the larger generic steady-state/terminal Vd),
  // so a distinct `centralVolume` role — reusing `vd` would let a generic catalog Vd be mapped
  // to V1 and corrupt both amplitude and distribution kinetics.
  'two-compartment-first-order': [
    'ka',
    'eliminationHalfLife',
    'k12',
    'k21',
    'centralVolume',
    'bioavailability',
  ],
  // The nominal `eliminationHalfLife` is mandatory on MichaelisMentenRouteParams (display/horizon),
  // even though Vmax/Km drive elimination.
  'michaelis-menten': ['ka', 'vmax', 'km', 'vd', 'bioavailability', 'eliminationHalfLife'],
  // Parent/metabolite is link-selected, not axis-composed; the parent-side (incl. parent `vd`,
  // read unconditionally by the engine) + formation + metabolite-disposition roles it needs.
  'parent-metabolite-first-order': [
    'ka',
    'vd',
    'bioavailability',
    'eliminationHalfLife',
    'formationFraction',
    'metaboliteEliminationHalfLife',
    'metaboliteVd',
    // Both molar masses drive the formation stoichiometry and are read unconditionally.
    'parentMolarMass',
    'metaboliteMolarMass',
  ],
};

/** Options that make a family's required/forbidden parameters context-dependent. */
export interface StructureRequirementOptions {
  /** Identifiability basis of a `one-compartment-clv` declaration's CLEARANCE parameter (CL or
   * CL/F). Together with `clvVolumeBasis` it fixes whether bioavailability (F) is required
   * (absolute) or forbidden (apparent-extravascular). */
  clvClearanceBasis?: IdentifiabilityBasis;
  /** Identifiability basis of a `one-compartment-clv` declaration's central VOLUME parameter (Vc
   * or Vc/F). Must share the clearance's identifiability class — a mixed pair (e.g. apparent CL/F
   * with an IV-anchored Vc) is not runnable (see `isCoherentClvDisposition`). */
  clvVolumeBasis?: IdentifiabilityBasis;
  /** True for the constant-rate IV INFUSION variant of `iv-one-compartment` (`iv-infusion`
   * absorption): it additionally requires an `infusionDuration`. A plain IV bolus omits it. */
  ivInfusion?: boolean;
}

/** Whether a CL/V options pair names two present, primitive, same-class bases (the engine's own
 * coherence rule). CL and Vc ids are fixed, so only the bases vary. */
function clvBasesCoherent(opts?: StructureRequirementOptions): boolean {
  if (!opts?.clvClearanceBasis || !opts.clvVolumeBasis) return false;
  return isCoherentClvDisposition(
    { id: 'CL', basis: opts.clvClearanceBasis },
    { id: 'Vc', basis: opts.clvVolumeBasis },
  );
}

/**
 * The parameter roles a family requires — the coupling the DB validates a declaration against.
 * For `one-compartment-clv`, F is added only when the CL and Vc bases are a coherent ABSOLUTE pair
 * (for an apparent-extravascular pair F is folded into Vc/F and is instead *forbidden*, see
 * `forbiddenParametersFor`); with no/incoherent bases F is not required (the apparent case is the
 * expected extravascular default, and an incoherent pair is reported by `validateModelStructure`).
 */
export function requiredParametersFor(
  family: ModelFamily,
  opts?: StructureRequirementOptions,
): RequiredParam[] {
  const required = [...REQUIRED_PARAMETERS[family]];
  if (
    family === 'one-compartment-clv' &&
    clvBasesCoherent(opts) &&
    isAbsoluteBasis(opts!.clvClearanceBasis!)
  ) {
    required.push('bioavailability');
  }
  if (family === 'iv-one-compartment' && opts?.ivInfusion) {
    required.push('infusionDuration');
  }
  return required;
}

/**
 * Parameter roles a family FORBIDS. Currently only `one-compartment-clv` on a coherent
 * apparent-extravascular pair, which forbids a separate bioavailability (`F` is folded into Vc/F).
 *
 * NOTE: an absorption-phase contradiction (e.g. a stored `ka` on an IV or zero-order input, which
 * has no first-order absorption rate) is deliberately NOT expressed here. This validator is FAMILY-
 * wide and is shared by the shape-keyed `resolveDrugModels`, whose sibling shapes share ONE
 * parameter pool — there a `ka` belongs to a first-order sibling and is harmlessly shared with the
 * bolus shape, so forbidding it family-wide would wrongly sink that sibling. The contradiction is
 * real only when the parameter is genuinely ROUTE-SCOPED (authored FOR a non-absorbing route), so
 * the route-keyed derivation enforces it there (see `absorptionHasFirstOrderRate` +
 * `resolveDrugModelsByRoute`).
 */
export function forbiddenParametersFor(
  family: ModelFamily,
  opts?: StructureRequirementOptions,
): RequiredParam[] {
  if (
    family === 'one-compartment-clv' &&
    clvBasesCoherent(opts) &&
    isApparentBasis(opts!.clvClearanceBasis!)
  ) {
    return ['bioavailability'];
  }
  return [];
}

/** The outcome of validating a declared structure against the engine + a set of present params. */
export interface StructureValidation {
  /** Whether the engine can run this axis combination at all. */
  supported: boolean;
  /** The composed family, when supported. */
  family?: ModelFamily;
  /** Why the combination is not runnable, when unsupported. */
  reason?: string;
  /** Required parameter roles that are not present, when supported but incompletely parameterised. */
  missingParameters?: RequiredParam[];
  /** Present parameter roles the family forbids (e.g. a separate F on an apparent-extravascular
   * CL/V model, where it is folded into Vc/F). */
  forbiddenParameters?: RequiredParam[];
  /** A `one-compartment-clv` declaration whose CL and Vc bases are absent, non-primitive, or a
   * mixed pair (different identifiability classes): the engine cannot construct the route, so the
   * declaration is incomplete even if every parameter role is present. */
  basisError?: string;
}

/**
 * Validate a declared structure: compose it to a family, and (when supported) report which of
 * that family's required parameters are absent from `present`, and which present parameters the
 * family forbids. An unsupported structure carries a reason and no family. A supported-but-
 * incomplete structure is still `supported: true` (the engine has the family) with
 * `missingParameters` populated — the caller's policy (default + disclose + grade, or reject)
 * decides what to do with that. `opts` supplies basis-dependent rules (see `clvBasis`).
 */
export function validateModelStructure(
  s: ModelStructure,
  present: Iterable<RequiredParam>,
  opts?: StructureRequirementOptions,
): StructureValidation {
  const composed = composeModelFamily(s);
  if (!composed.supported) return { supported: false, reason: composed.reason };
  const have = new Set(present);
  // The infusion variant of iv-one-compartment is fixed by the structure's absorption axis, not
  // by the caller — derive it so the constant-rate duration is required for an IV infusion.
  const effectiveOpts: StructureRequirementOptions = { ...opts, ivInfusion: s.absorption === 'iv-infusion' };
  const missing = requiredParametersFor(composed.family, effectiveOpts).filter((p) => !have.has(p));
  const forbidden = forbiddenParametersFor(composed.family, effectiveOpts).filter((p) => have.has(p));
  // CL/V is runnable only when its CL and Vc bases are a coherent primitive pair (same
  // identifiability class) — that pair fixes whether F is required or forbidden. Absent,
  // `derived`, or mixed-class bases are not sufficient: report it, so an absolute-without-F,
  // apparent-with-F, or mixed-basis declaration is not silently accepted as complete.
  const basisError =
    composed.family === 'one-compartment-clv' && !clvBasesCoherent(opts)
      ? 'one-compartment-clv requires a coherent primitive CL/V identifiability basis (CL and Vc sharing an apparent-extravascular or absolute class); none was supplied or they conflict'
      : undefined;
  return {
    supported: true,
    family: composed.family,
    missingParameters: missing.length > 0 ? missing : undefined,
    forbiddenParameters: forbidden.length > 0 ? forbidden : undefined,
    basisError,
  };
}
