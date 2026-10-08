/**
 * Bridge the drug catalog to the engine's model derivation (CV-2, catalog-coverage track).
 *
 * CV-2a's kinetics-core `deriveModel` answers "given a model-structure DECLARATION (the three
 * axes) and the set of engine parameter ROLES present, is the model runnable, and what is
 * missing?" It speaks the engine's vocabulary — `ModelStructureDeclaration` and `RequiredParam` —
 * and knows nothing about how Kinetix stores a drug.
 *
 * This module is the adapter from Kinetix's catalog vocabulary (`DrugParameterId`) onto that
 * engine vocabulary. It is deliberately kept OUT of kinetics-core: the portable engine must not
 * import a Redose concept like `DrugParameterId`. Two responsibilities:
 *
 *   1. **Parameter role mapping.** A drug stores numeric parameters under catalog ids
 *      (`halfLife`, `volumeOfDistribution`, …); the engine needs them under structural roles
 *      (`eliminationHalfLife`, `vd`, …). `parameterRoleFor` is that map — a direct 1:1 rename for
 *      the four quantities the catalog holds. Crucially, several engine roles have NO catalog
 *      source and are NOT invented from a proxy: the first-order absorption rate `ka`
 *      (`kaPerHour`) is route-specific with no catalog field and is reviewer-authored per route
 *      (see `kinetics-core/provenance.ts`) — the catalog's `tmax` is the time of peak, a different
 *      quantity that cannot yield `ka` without also knowing `ke` and solving an implicit,
 *      two-root equation. So `tmax` does NOT supply `ka`; `ka` stays missing and is graded down.
 *      The two-compartment micro-rates, central volume, saturable pair, input durations, and
 *      parent/metabolite roles are likewise absent — reported as `missingParameters`, never
 *      fabricated ("missing stays missing").
 *
 *   2. **Per-shape resolution.** Disposition and elimination are molecule-level axes: every cited
 *      declaration for a drug should agree, and two DIFFERENT values are a curation conflict, not a
 *      model — surfaced as `not-modelable`, never silently resolved by picking one. Absorption is a
 *      per-ROUTE axis (CV-1b's documented limitation): a drug given both IV and orally declares two
 *      absorption SHAPES, and each derives its own model. `resolveDrugModels` turns the stored
 *      value SETS into one derivation per distinct absorption shape. NOTE: an absorption shape is
 *      NOT an administration `RouteId` — the catalog does not yet key declarations by
 *      route/formulation (that key is the deferred next CV-2 step), so two real routes that share a
 *      shape (e.g. oral and intranasal, both first-order, but with different F and ka) collapse to
 *      one shape here and cannot yet be converted into distinct per-route registry entries.
 *
 * Pure: no DB or engine-registry access. The read adapter (`api/_lib/model-derivation-store.ts`)
 * supplies the stored value sets and the present catalog parameters; this module maps and derives.
 */
import {
  ABSORPTION_KINDS,
  DISPOSITION_KINDS,
  absorptionCoherentWithRoute,
  absorptionHasFirstOrderRate,
  isIvAbsorptionKind,
  deriveModel,
  inferKaFromTmax,
  MODEL_STRUCTURE_DEFAULTS,
  requiredParametersFor,
  type AbsorptionKind,
  type AssemblyRange,
  type AssemblyRanges,
  type AssemblyValues,
  type AxisProvenance,
  type DerivedModel,
  type DispositionKind,
  type RouteProvenance,
  type DoseBasis,
  type DrugDefinitionMetadata,
  type EliminationKind,
  type ModelStructure,
  type ModelStructureDeclaration,
  type RequiredParam,
  type RouteId,
  type StructureRequirementOptions,
  type VdScaling,
} from './kinetics-core/index.js';
import { DRUG_PARAMETERS, isRangeSpec, type DrugParameterId } from './drugParameters.js';
import { convertParameterValue } from './parameterUnits.js';

/**
 * The catalog parameter id that stores each model-structure axis. The three enum parameters
 * (CV-1b) are the drug-facing names; `ModelStructureDeclaration` is the engine-facing shape.
 * A single source of truth so the read adapter and any UI read the same mapping.
 */
export const MODEL_STRUCTURE_AXIS_PARAMETERS = {
  disposition: 'dispositionModel',
  elimination: 'eliminationModel',
  absorption: 'absorptionModel',
} as const satisfies Record<keyof ModelStructureDeclaration, DrugParameterId>;

/**
 * Catalog parameter → engine role. Only the four quantities the catalog directly holds appear;
 * every other catalog parameter (interpretive concentrations, dose ranges, chemistry constants,
 * `tmax`, …) has no structural role and maps to `null`.
 *
 * `ka` maps from its own route-scoped catalog parameter (CV-2c), NOT from `tmax`. The engine's
 * first-order absorption rate (`kaPerHour`) is route-specific and reviewer-authored per route
 * (`kinetics-core/provenance.ts`); CV-2c gives it a catalog home (a `routeScoped` `ka` parameter
 * stored per route). `tmax` is still NOT a substitute: the time of peak is a joint function of `ka`
 * and `ke` (`tmax = ln(ka/ke)/(ka−ke)`), so recovering `ka` from it needs `ke` and an implicit
 * two-root solve — `tmax`→`ka` would manufacture a rate. So `ka` is present per route when a
 * reviewer has authored it, and otherwise stays in `missingParameters`. The two-compartment
 * micro-rates (`k12`/`k21`), central volume (`centralVolume`), saturable pair (`vmax`/`km`), input
 * durations, and parent/metabolite roles remain source-less: a family that requires any of them
 * reports it as `missingParameters`, the honest "incomplete, grade it down" signal.
 */
const PARAMETER_ROLES: Partial<Record<DrugParameterId, RequiredParam>> = {
  halfLife: 'eliminationHalfLife',
  volumeOfDistribution: 'vd',
  clearance: 'clearance',
  bioavailability: 'bioavailability',
  // `ka` now HAS a catalog home (CV-2c): a route-scoped, reviewer-authored
  // parameter. It is supplied per route (a route's `presentParameters`), so an
  // oral first-order model can finally be completed once a reviewer authors it.
  ka: 'ka',
};

/**
 * Numeric values whose aggregation key includes the administration route.
 *
 * `tmax` is here for the same reason `ka` and `bioavailability` are: time to peak is a property of
 * an absorption phase, not of a molecule, so an oral and an insufflated Tmax are different
 * observations and must not pool. It differs from the other two in that it fills no engine role
 * directly — the engine has no `tmax` parameter — but it is the observable the per-route `ka`
 * inference solves against, so the read adapter needs it keyed by route just the same.
 */
export const ROUTE_ASSEMBLY_PARAMETER_IDS = [
  'ka',
  'bioavailability',
  'tmax',
] as const satisfies readonly DrugParameterId[];

export function isRouteAssemblyParameter(id: DrugParameterId): boolean {
  return (ROUTE_ASSEMBLY_PARAMETER_IDS as readonly DrugParameterId[]).includes(id);
}

/** The engine role a catalog parameter supplies, or `null` if it feeds no structural role. */
export function parameterRoleFor(id: DrugParameterId): RequiredParam | null {
  return PARAMETER_ROLES[id] ?? null;
}

// ─── CV-4c-2 — catalog value → canonical `AssemblyValues` + `vdScaling` ──────────
//
// CV-4b's `assembleRouteParams` and CV-4c-1's `assembleDrugDefinition` consume CANONICAL engine units
// (hours, per-hour, L/kg, 0–1) and an already-inferred `vdScaling`, and both pin those two conversions
// to "the read adapter's concern" (see `assemble-model.ts`). These pure helpers are that concern: they
// map a drug's stored catalog values onto the engine's `AssemblyValues`, and a stored Vd unit onto a
// `VdScaling`. They stay OUT of kinetics-core (which must not import a Redose `DrugParameterId`) and
// beside `parameterRoleFor`, its role-mapping sibling. The DB read that gathers the raw values lives in
// `api/_lib/model-derivation-store.ts`.

/**
 * The canonical unit a catalog parameter's values are converted INTO for the engine, or `null` when
 * the parameter has no ranged/canonical unit. The catalog's canonical units were chosen to equal the
 * engine's (`h` = hours, `L/kg` = `vdLitersPerKg`, `1/h` = per-hour, `fraction` = 0–1), so most role
 * conversions are identity; `clearance` (L/h, from L/min / mL/min / …) is the one that actually
 * rescales. A single accessor so a value read and its unit conversion always agree.
 */
export function canonicalUnitFor(id: DrugParameterId): string | null {
  const spec = DRUG_PARAMETERS[id];
  return isRangeSpec(spec) ? spec.canonicalUnit : null;
}

/**
 * A drug's stored numeric value for one catalog parameter, reduced to what canonical-unit conversion
 * needs: the representative scalar (a `NumericRange`'s `representativeValue`, or a route's pooled
 * median) and the unit it is stored in. The read adapter builds these from the `drug_parameters` cache
 * (drug-level roles) and the route-scoped `parameter_entries` (route-specific `ka`/`F`).
 */
export interface CatalogParameterValue {
  parameter: DrugParameterId;
  /** The representative scalar in `unit` — the point the `fixed(median)` assembly policy consumes. */
  value: number;
  /** The unit `value` is expressed in (converted to the parameter's canonical unit here). */
  unit: string;
  /**
   * The lowest and highest value the parameter's sources report, in `unit`, when the catalog holds
   * them. Carried so assembly can draw across the published spread (`toAssemblyRanges`).
   */
  low?: number;
  high?: number;
}

/**
 * Convert a drug's stored catalog values into the engine's canonical-unit `AssemblyValues`, keyed by
 * the structural role each parameter fills — the "DB→canonical unit conversion" CV-4b/CV-4c pin to the
 * read adapter. Each value is mapped onto its `RequiredParam` role (`parameterRoleFor`) and converted
 * from its stored unit to the parameter's canonical unit (`convertParameterValue`). A value whose
 * parameter has no structural role, no canonical unit, is non-finite, or whose conversion is undefined
 * (`convertParameterValue` → `null`, e.g. incompatible units) is skipped: the role stays absent and the
 * assembler reports it missing — never a guessed number (missing stays missing). If two inputs fill one
 * role the later wins; a drug's drug-level and route-specific roles are disjoint, so that does not
 * arise. Pure.
 */
export function toAssemblyValues(values: Iterable<CatalogParameterValue>): AssemblyValues {
  const out: AssemblyValues = {};
  for (const { parameter, value, unit } of values) {
    const role = parameterRoleFor(parameter);
    if (role === null || !Number.isFinite(value)) continue;
    const canonicalUnit = canonicalUnitFor(parameter);
    if (canonicalUnit === null) continue;
    const canonical = convertParameterValue(value, unit, canonicalUnit);
    if (canonical === null || !Number.isFinite(canonical)) continue;
    out[role] = canonical;
  }
  return out;
}

/**
 * Units that imply a NON-DEFAULT Vd scaling. The catalog stores volume of distribution only as `L/kg`
 * — a per-total-body-weight volume, i.e. the engine's `total-weight` scaling, which is the DEFAULT and
 * is represented by OMITTING `vdScaling` (so an assembled model matches a hand-authored one that omits
 * it and the CV-4a snapshot checksum stays bit-for-bit). `L/kg` is therefore intentionally ABSENT here.
 * The other scalings — `lean-body-mass` (hydrophilic drugs), `widmark` (ethanol) — are NOT a unit
 * distinction: the catalog has no distinct unit for them, and the lipophilic/hydrophilic choice is a
 * REVIEWED clinical judgement (a numeric L/kg threshold applied per drug) that lives in the reviewed
 * override tier (which always wins, CV-4a), never manufactured here from a unit. This map is the single
 * seam where a future absolute-`L` or body-surface Vd unit would map to a non-default scaling.
 */
const NON_DEFAULT_VD_UNIT_SCALINGS: Readonly<Record<string, VdScaling>> = {};

/**
 * Infer the Vd scaling a stored Vd unit implies — the "`vdScaling`-from-unit inference" CV-4b/CV-4c pin
 * to the read adapter. Returns `undefined` for the catalog's `L/kg` (the `total-weight` default, left
 * unset) and for any unrecognized unit (the default rather than a guessed scaling); a future non-kg
 * unit maps via `NON_DEFAULT_VD_UNIT_SCALINGS`. Pure.
 */
export function inferVdScaling(vdUnit: string): VdScaling | undefined {
  return NON_DEFAULT_VD_UNIT_SCALINGS[vdUnit];
}

// ─── ka from tmax — the extravascular inference (plan §7, CV-2b revisited) ──────
//
// CV-2b ruled that `ka` "stays missing, never manufactured", because no catalog field holds it and
// recovering it from `tmax` "needs `ke` and an implicit two-root solve". The first clause still
// governs: a cited `ka` always wins, and nothing here invents one where the arithmetic does not
// determine it. The second clause is what `kinetics-core/ka-inference.ts` revisits — with `ke` known
// from the elimination half-life the solve has exactly one root, and the case that genuinely cannot
// be trusted (flip-flop kinetics) is identifiable from the stored values rather than ambiguous.
//
// The split of concerns: kinetics-core owns the arithmetic and the flip-flop refusal; this module
// owns the POLICY — when an inference may be attempted at all, and what it must disclose. The read
// adapter owns deciding WHICH stored `tmax` is attributable to the route (a route-scoped entry, or a
// drug-level figure on a single-route drug), because only it can see the drug's route set.

/** The engine role `tmax` is used to solve for. Named so the disclosure and the grade agree. */
const TMAX_INFERRED_ROLE: RequiredParam = 'ka';

/** The outcome of offering a route's `tmax` to the `ka` inference. */
export interface KaInferenceOutcome {
  /** The route's values, with `ka` filled in when the inference succeeded. */
  values: AssemblyValues;
  /**
   * Roles whose value was inferred rather than read from a cited entry — `['ka']` when the solve
   * succeeded, empty otherwise. Feeds `GradeInputs.inferredParameters`, so an inferred value is
   * graded down and disclosed at the curve, never presented as a catalog number.
   */
  inferredParameters: RequiredParam[];
  /**
   * Why a `tmax` that was offered did not produce a `ka`. Present only when an inference was
   * attempted and refused (flip-flop kinetics, or an input the solver rejected) — a diagnostic for
   * the curator, not a user-facing string. `ka` stays absent in that case and the route grades down
   * as incomplete: missing stays missing.
   */
  declined?: string;
}

/**
 * Fill a route's `ka` from its `tmax` when — and only when — every condition holds:
 *
 *  1. the route is modelable and its absorption shape actually carries a first-order rate (an IV or
 *     purely zero-order input has no `ka`, and one authored for it would be a contradiction);
 *  2. no cited `ka` is already present (an authored value is evidence and always wins);
 *  3. an attributable `tmax` was supplied by the caller;
 *  4. the route has an elimination half-life to solve against;
 *  5. the solve succeeds — i.e. the pair is not in the flip-flop regime, where the stored half-life
 *     cannot be read as an elimination half-life at all.
 *
 * Any condition failing leaves `values` untouched. Pure; the returned `values` is a copy, so the
 * caller's object is never mutated.
 */
export function applyKaInference(
  derived: DerivedModel,
  values: AssemblyValues,
  tmaxHours: number | undefined,
): KaInferenceOutcome {
  const unchanged: KaInferenceOutcome = { values, inferredParameters: [] };

  if (derived.outcome !== 'modelable') return unchanged;
  if (!absorptionHasFirstOrderRate(derived.structure.absorption)) return unchanged;
  // An authored, cited ka is evidence; an inference is an assumption. Evidence wins.
  if (values[TMAX_INFERRED_ROLE] !== undefined) return unchanged;
  if (tmaxHours === undefined) return unchanged;

  const halfLife = values.eliminationHalfLife;
  if (halfLife === undefined) {
    return { ...unchanged, declined: 'no elimination half-life to solve the absorption rate against' };
  }

  const inference = inferKaFromTmax(tmaxHours, halfLife);
  if (inference.status !== 'inferred') {
    return { ...unchanged, declined: inference.reason };
  }
  return {
    values: { ...values, [TMAX_INFERRED_ROLE]: inference.kaPerHour },
    inferredParameters: [TMAX_INFERRED_ROLE],
  };
}

// ─── A cautious default for a missing bioavailability ───────────────────────────────
//
// Owner decision (2026-09-29): a route missing an input that has a CAUTIOUS default runs on it,
// labelled, instead of producing no curve. §5.1 already names the case — completeness C is
// "runnable only because one input uses an explicitly conservative default" — so this is the grade
// the policy anticipated, not a new tier.
//
// Exactly one input qualifies: bioavailability. Concentration is proportional to F at every time,
// so F = 1 bounds the curve from above everywhere — one direction, always. Nothing else does:
//   - `ka` has NO cautious value. A faster absorption raises the early peak but, with the same
//     exposure, LOWERS every late concentration (Bateman: at late t the curve scales with
//     ka/(ka−ke), which falls as ka rises); even instantaneous absorption sits below a slower
//     curve late on. A default would understate late concentrations and overstate a dose worked
//     back from one — the opposite of what "cautious" would claim.
//   - a half-life or a volume of distribution has no direction either.
// So a route missing any of those stays missing.

/** F assumed when none is stored: complete absorption, the highest concentration a dose can give. */
export const CAUTIOUS_DEFAULT_BIOAVAILABILITY = 1;

/** Roles that may be filled with a cautious default. Only F has a one-sided direction. */
export const CAUTIOUS_DEFAULT_ROLES = ['bioavailability'] as const satisfies readonly RequiredParam[];
export type CautiousDefaultRole = (typeof CAUTIOUS_DEFAULT_ROLES)[number];

/** The outcome of offering a route's values to the cautious-default step. */
export interface CautiousDefaultOutcome {
  values: AssemblyValues;
  /** Roles filled with a cautious default rather than read — graded and disclosed. */
  defaultedParameters: CautiousDefaultRole[];
}

/**
 * Fill a route's missing F with `CAUTIOUS_DEFAULT_BIOAVAILABILITY`, when — and only when:
 *
 *  1. the route is modelable and its family REQUIRES F (an IV route does not);
 *  2. F has no value;
 *  3. the caller does not report F as BLOCKED — the substance is not administered (no dose of it
 *     exists to be absorbed), or a route-scoped F entry exists but pools to no value (a censored
 *     "< 0.5"). Curated evidence that cannot be used is still evidence; a default drawn over it
 *     would contradict the curation, so such a route stays incomplete.
 *
 * Pure; the returned `values` is a copy.
 */
export function applyCautiousDefaults(
  derived: DerivedModel,
  values: AssemblyValues,
  blocked: ReadonlySet<CautiousDefaultRole> = new Set(),
  opts?: StructureRequirementOptions,
): CautiousDefaultOutcome {
  if (derived.outcome !== 'modelable' || !derived.family) return { values, defaultedParameters: [] };
  const required = requiredParametersFor(derived.family, {
    ...opts,
    ivInfusion: derived.structure.absorption === 'iv-infusion',
  });
  if (
    !required.includes('bioavailability') ||
    blocked.has('bioavailability') ||
    Number.isFinite(values.bioavailability)
  ) {
    return { values, defaultedParameters: [] };
  }
  return {
    values: { ...values, bioavailability: CAUTIOUS_DEFAULT_BIOAVAILABILITY },
    defaultedParameters: ['bioavailability'],
  };
}

/**
 * The `tmax` among a set of stored catalog values, in canonical hours, or `undefined` if none is
 * present or its unit cannot be converted.
 *
 * `tmax` fills no engine role, so `toAssemblyValues` drops it — this is the parallel accessor that
 * pulls it out for the inference. Pure.
 */
/**
 * The reported spread behind each role of `toAssemblyValues(values)`, converted to canonical units.
 * Mirrors its rule exactly — a later value fills a role over an earlier one, so it also replaces (or
 * clears) the earlier value's spread — so a role's range always belongs to the value it runs on. A
 * value whose bounds are absent or do not convert contributes no range.
 */
export function toAssemblyRanges(values: Iterable<CatalogParameterValue>): AssemblyRanges {
  const out: AssemblyRanges = {};
  for (const value of values) {
    const role = parameterRoleFor(value.parameter);
    if (role === null || toAssemblyValues([value])[role] === undefined) continue;
    const range = canonicalRange(value);
    if (range) out[role] = range;
    else delete out[role];
  }
  return out;
}

/** A value's reported spread in its parameter's canonical unit, or `undefined` when it has none. */
function canonicalRange(value: CatalogParameterValue): AssemblyRange | undefined {
  const canonicalUnit = canonicalUnitFor(value.parameter);
  if (canonicalUnit === null || value.low === undefined || value.high === undefined) return undefined;
  const low = convertParameterValue(value.low, value.unit, canonicalUnit);
  const high = convertParameterValue(value.high, value.unit, canonicalUnit);
  if (low === null || high === null || !Number.isFinite(low) || !Number.isFinite(high)) return undefined;
  return { low, high };
}

/**
 * The `ka` spread an inferred `ka` gets from the Tmax spread it was solved from. `ka` falls as Tmax
 * rises, so the shortest reported Tmax gives the highest `ka` and the longest the lowest; the
 * half-life is held at its median, so this is the spread Tmax alone accounts for. No range when
 * either end cannot be solved — the longest Tmax may fall in the flip-flop regime the central
 * inference avoided — because a one-sided spread would invent the missing bound.
 */
export function inferredKaRange(
  tmax: CatalogParameterValue | undefined,
  halfLifeHours: number | undefined,
): AssemblyRange | undefined {
  if (!tmax || halfLifeHours === undefined || tmax.parameter !== 'tmax') return undefined;
  const range = canonicalRange(tmax);
  if (!range || !(range.low > 0) || !(range.low < range.high)) return undefined;
  const fastest = inferKaFromTmax(range.low, halfLifeHours);
  const slowest = inferKaFromTmax(range.high, halfLifeHours);
  if (fastest.status !== 'inferred' || slowest.status !== 'inferred') return undefined;
  return { low: slowest.kaPerHour, high: fastest.kaPerHour };
}

export function tmaxHoursFrom(values: Iterable<CatalogParameterValue>): number | undefined {
  const canonicalUnit = canonicalUnitFor('tmax');
  if (canonicalUnit === null) return undefined;
  for (const { parameter, value, unit } of values) {
    if (parameter !== 'tmax' || !Number.isFinite(value)) continue;
    const canonical = convertParameterValue(value, unit, canonicalUnit);
    if (canonical === null || !Number.isFinite(canonical) || canonical <= 0) continue;
    return canonical;
  }
  return undefined;
}

// ─── CV-4c-2b — derived-tier definition metadata ────────────────────────────────
//
// `assembleDrugDefinition` (CV-4c-1) derives a route's runnable parameters from data, but a
// `DrugModelDefinition` also carries catalog metadata the engine cannot derive from parameters —
// analyte identity, display name, native matrix, validation status, dose bases. For a DERIVED model
// these follow the same disclosed-default discipline as the axes (plan §2, "a default is a disclosed
// assumption"): the reviewed override tier (which always wins, CV-4a) carries the curated metadata for
// the drugs that matter, so the derived tier states an honest, minimal default rather than guessing.

/** The identity fields a derived definition takes from the drug row (the rest are disclosed defaults). */
export interface DerivedDrugIdentity {
  /** The drug's stable slug — the engine `analyte` id (registry analytes are lowercase slugs). */
  slug: string;
  /** The human-readable model name (the drug's preferred-locale display name). */
  displayName: string;
}

/** The native matrix a derived model computes in. `plasma` is the conventional PK parameterisation
 *  matrix and the value every hand-authored `registry.ts` entry uses; a drug whose reviewed model is
 *  authored in whole blood carries that in the override tier, which wins. */
export const DERIVED_MODEL_MATRIX = 'plasma' as const;

/** A derived model is unvalidated by construction, so it is `literature-derived` — which CV-3a caps at
 *  grade B (only a validation fixture earns an A). */
export const DERIVED_MODEL_VALIDATION_STATUS = 'literature-derived' as const;

/** The dose bases a derived model accepts. `active-moiety` and `parent` are exactly the two bases the
 *  engine consumes WITHOUT a conversion (it treats them identically), and the set every hand-authored
 *  `registry.ts` entry uses; `salt`/`free-base` are omitted because they need a molar conversion the
 *  derived model does not carry (the engine would otherwise mis-scale them) — so this is the honest
 *  complete set, not an over-claim. */
export const DERIVED_MODEL_SUPPORTED_BASES: readonly DoseBasis[] = ['active-moiety', 'parent'];

/**
 * Build a derived model's catalog metadata from a drug's identity, filling the disclosed defaults
 * (matrix, validation status, dose bases) the catalog cannot derive. The `modelId` is a stable,
 * derived-tier-marked, versioned id (`<slug>-derived-v1`) distinct from the hand-authored ids
 * (`<slug>-one-comp-v1`), so a derived entry is never confused with a reviewed one. Pure.
 *
 * No `aliases`: a derived model resolves ONLY under its `analyte` (the drug's globally-unique slug).
 * A `DrugModelDefinition.alias` is a kinetics-core analyte identifier, but a drug's catalog `aliases`
 * are free-form literature/brand/street labels with no cross-drug uniqueness guarantee — promoting
 * them to registry lookup keys could resolve an ambiguous street name to the wrong model. Alternate
 * analyte identities (e.g. psilocin↔psilocybin) are a REVIEWED crosswalk, an override-tier concern,
 * not something derived from the catalog labels here.
 */
export function derivedDefinitionMetadata(identity: DerivedDrugIdentity): DrugDefinitionMetadata {
  return {
    analyte: identity.slug,
    displayName: identity.displayName,
    modelId: `${identity.slug}-derived-v1`,
    matrix: DERIVED_MODEL_MATRIX,
    validationStatus: DERIVED_MODEL_VALIDATION_STATUS,
    supportedBases: [...DERIVED_MODEL_SUPPORTED_BASES],
  };
}

/** The engine roles a set of present catalog parameters supplies (parameters with no role ignored). */
function presentRoles(presentParameters: Iterable<DrugParameterId>): Set<RequiredParam> {
  const present = new Set<RequiredParam>();
  for (const id of presentParameters) {
    const role = parameterRoleFor(id);
    if (role) present.add(role);
  }
  return present;
}

/**
 * Derive a runnable model for ONE resolved declaration from the drug's present catalog parameters.
 * Maps each present `DrugParameterId` onto its engine role, then delegates to CV-2a's `deriveModel`
 * for the family composition, missing/forbidden-parameter check, and outcome. Pure.
 */
export function deriveDrugModel(input: {
  declaration: ModelStructureDeclaration;
  presentParameters: Iterable<DrugParameterId>;
  opts?: StructureRequirementOptions;
}): DerivedModel {
  return deriveModel(input.declaration, presentRoles(input.presentParameters), input.opts);
}

/** The stored model-structure declarations and present parameters for one drug. */
export interface DrugModelInputs {
  /** Distinct disposition axis values declared across the drug's cited entries. */
  dispositionModels: string[];
  /** Distinct elimination axis values declared across the drug's cited entries. */
  eliminationModels: string[];
  /** Distinct absorption axis values declared — one per input SHAPE (see the collapse note). */
  absorptionModels: string[];
  /** Catalog parameters the drug has a value for (drives which engine roles are present). */
  presentParameters: DrugParameterId[];
  /** Basis-dependent CL/V rules, when the caller can supply them (absent in the catalog today). */
  opts?: StructureRequirementOptions;
}

/** A per-shape derivation: the model plus the absorption shape it was derived for. */
export interface ShapeModelDerivation extends DerivedModel {
  /**
   * The absorption input SHAPE this derivation is for: the declared absorption axis value, or
   * `null` when none was declared and the disclosed default (`first-order`) stood in.
   *
   * This is the absorption KIND, NOT an administration `RouteId`. The catalog does not yet key
   * declarations by route/formulation (the deferred CV-2 route-key step), so two distinct
   * administration routes that share an absorption shape collapse to one entry here — this output
   * therefore cannot yet be converted into faithful per-route registry entries with route-specific
   * F/ka.
   */
  absorptionShape: string | null;
}

/**
 * One administration route's declaration (CV-2c): the absorption input SHAPE for that route, and the
 * catalog parameters stored SPECIFICALLY for it. Absorption, bioavailability (`F`), and the
 * first-order rate (`ka`) are genuinely route-specific — the same molecule absorbs differently
 * intranasally vs orally — so they are declared per route, over and above the drug-level pool.
 */
export interface RouteDeclaration {
  /**
   * The route's absorption input shape(s). A single `AbsorptionKind`, or the declared SET when a
   * route carries more than one cited absorption value (a per-route curation conflict — see
   * `resolveDrugModelsByRoute`), or `null`/absent for the disclosed default. A read adapter that
   * reads several corroborating rows for one route passes the deduped set; the resolver decides
   * whether they agree.
   */
  absorption?: string | string[] | null;
  /** Catalog parameters stored for THIS route (e.g. route-specific `bioavailability`, `ka`). */
  presentParameters?: DrugParameterId[];
  /**
   * Where the ROUTE itself came from. `asserted` (the default) means a route-scoped row named it —
   * the faithful CV-2c case. `attributed` means the catalog named no route at all and the read
   * adapter attributed the drug's route-optional evidence (a drug-level Tmax/F, which only an
   * extravascular route can produce) to this one. An attributed route is a disclosed assumption in
   * exactly the sense the plan §2 admits for an unstated axis, so it is carried as provenance
   * rather than smoothed away: the grade must be able to see it.
   */
  provenance?: RouteProvenance;
}

/** A drug's stored declarations keyed by administration route (CV-2c) — the faithful per-route form. */
export interface RouteKeyedDrugModelInputs {
  /** Distinct disposition axis values (molecule-level, shared across routes). */
  dispositionModels: string[];
  /** Distinct elimination axis values (molecule-level, shared across routes). */
  eliminationModels: string[];
  /** Per-route absorption shape + route-specific parameters, keyed by `RouteId`. */
  routes: Partial<Record<RouteId, RouteDeclaration>>;
  /** Drug-level parameters shared by every route (e.g. `halfLife`, `volumeOfDistribution`). */
  presentParameters: DrugParameterId[];
  /** Basis-dependent CL/V rules, when the caller can supply them (absent in the catalog today). */
  opts?: StructureRequirementOptions;
}

/** A per-ROUTE derivation: the model plus the administration route it was derived for (CV-2c). */
export interface RouteModelDerivation extends DerivedModel {
  /** The administration route this derivation is for — a real `RouteId`, unlike the shape-keyed form. */
  route: RouteId;
  /** The absorption input shape used (the route's declared value, or `null` for the disclosed default). */
  absorptionShape: string | null;
  /** Whether the catalog named this route, or the read adapter attributed it (see `RouteDeclaration`). */
  routeProvenance: RouteProvenance;
  /**
   * The one-compartment form of this route, offered when the drug ASSERTS a richer disposition
   * (two-compartment) than the catalog can yet run. The two-compartment family needs `k12`, `k21`
   * and a central volume, none of which the catalog stores, so without this a drug that gained a
   * cited "two-compartment" fact would stop being modelable at all — the catalog learning more
   * would take a curve away. The read adapter falls back to this derivation only when the declared
   * one does not assemble, and records the simplification so the grade counts it against
   * completeness exactly as it counts a defaulted axis: the curve that runs is not the model the
   * evidence describes. Once the declared family can be assembled, the primary derivation wins and
   * the fallback is never used — capability grows with the data, it is never taken away by it.
   *
   * Offered only for a single, agreed, recognized disposition with no conflict on the route; an
   * unrecognized value stays not-modelable (unknown science must not masquerade as a supported
   * family), and a contradiction stays a contradiction.
   */
  dispositionFallback?: DerivedModel;
}

const ABSORPTION_KIND_SET: ReadonlySet<string> = new Set<AbsorptionKind>(ABSORPTION_KINDS);
const isAbsorptionKind = (value: string): value is AbsorptionKind => ABSORPTION_KIND_SET.has(value);

/** The resolution of one axis's declared value set: a single value, none, or a conflict. */
interface AxisResolution {
  /** The single agreed value, or `null` when unstated or in conflict. */
  value: string | null;
  /** The distinct declared values when there is more than one (a conflict); otherwise `null`. */
  conflict: string[] | null;
}

/**
 * Resolve a molecule-level axis's declared values. Agreement (or a single source) yields the value;
 * disagreement is a conflict the caller surfaces as `not-modelable` rather than resolving by fiat.
 * An empty set is unstated (the disclosed default applies downstream).
 */
function resolveAxis(values: readonly string[]): AxisResolution {
  const distinct = [...new Set(values.filter((v) => v.length > 0))];
  if (distinct.length === 0) return { value: null, conflict: null };
  if (distinct.length === 1) return { value: distinct[0]!, conflict: null };
  return { value: null, conflict: distinct };
}

/** The molecule-axis conflict reason for a drug, or `null` when disposition and elimination each
 *  have at most one declared value. A conflict makes every derivation `not-modelable`. */
function conflictReasonFor(disposition: AxisResolution, elimination: AxisResolution): string | null {
  if (disposition.conflict) {
    return `conflicting disposition declarations: ${disposition.conflict.join(', ')}`;
  }
  if (elimination.conflict) {
    return `conflicting elimination declarations: ${elimination.conflict.join(', ')}`;
  }
  return null;
}

/**
 * Derive the base model for one resolved (disposition, elimination, absorption-shape) triple and its
 * present parameters — the shared core of the shape-keyed and route-keyed resolvers. A molecule-axis
 * conflict short-circuits to `not-modelable` (no family, so no curve); otherwise this delegates to
 * `deriveDrugModel`. The caller attaches the key it resolved for (`absorptionShape`, `route`).
 */
function buildDerivation(args: {
  disposition: AxisResolution;
  elimination: AxisResolution;
  shape: string | null;
  /**
   * Whether the absorption axis was ASSERTED (a value was declared) rather than defaulted — used
   * only for the conflict branch's provenance. Defaults to `shape !== null`; the route-keyed
   * resolver overrides it to `true` for a route whose absorption values disagree (they WERE
   * asserted, they merely conflict, so `shape` is null but the axis is not a disclosed default).
   */
  absorptionAsserted?: boolean;
  presentParameters: Iterable<DrugParameterId>;
  opts?: StructureRequirementOptions;
  conflictReason: string | null;
}): DerivedModel {
  const { disposition, elimination, shape, presentParameters, opts, conflictReason } = args;
  const absorptionAsserted = args.absorptionAsserted ?? shape !== null;
  if (conflictReason) {
    // Represent the resolved structure with the disclosed defaults filled in for display, and mark a
    // conflicting axis `asserted` (its values WERE asserted — they merely disagree), an unstated one
    // `defaulted`. The outcome is `not-modelable` regardless, so no family is built.
    const structure: ModelStructure = {
      disposition: (disposition.value ?? MODEL_STRUCTURE_DEFAULTS.disposition) as DispositionKind,
      elimination: (elimination.value ?? MODEL_STRUCTURE_DEFAULTS.elimination) as EliminationKind,
      absorption: (shape ?? MODEL_STRUCTURE_DEFAULTS.absorption) as AbsorptionKind,
    };
    const asserted = (declared: boolean): AxisProvenance => (declared ? 'asserted' : 'defaulted');
    const axisProvenance = {
      disposition: asserted(disposition.value !== null || disposition.conflict !== null),
      elimination: asserted(elimination.value !== null || elimination.conflict !== null),
      absorption: asserted(absorptionAsserted),
    };
    const defaulted =
      axisProvenance.disposition === 'defaulted' ||
      axisProvenance.elimination === 'defaulted' ||
      axisProvenance.absorption === 'defaulted';
    return { outcome: 'not-modelable', structure, axisProvenance, defaulted, reason: conflictReason };
  }
  const declaration: ModelStructureDeclaration = {
    disposition: disposition.value as DispositionKind | null,
    elimination: elimination.value as EliminationKind | null,
    absorption: shape as AbsorptionKind | null,
  };
  return deriveDrugModel({ declaration, presentParameters, opts });
}

/**
 * Resolve a drug's stored axis value sets into one derivation per absorption input shape.
 *
 * Disposition and elimination are molecule-level: a single agreed value is asserted, none defaults
 * (disclosed), and two different values are a conflict that makes EVERY shape `not-modelable`
 * (a contradiction is a curation gap, not a model to grade). Absorption is per-shape: each distinct
 * declared value derives its own family; with none declared, the single disclosed-default shape
 * stands in. The result always has at least one entry. (An absorption shape is not a `RouteId` —
 * see `ShapeModelDerivation.absorptionShape`; the route-keyed `resolveDrugModelsByRoute` is the
 * faithful per-route form.)
 */
export function resolveDrugModels(inputs: DrugModelInputs): ShapeModelDerivation[] {
  const disposition = resolveAxis(inputs.dispositionModels);
  const elimination = resolveAxis(inputs.eliminationModels);
  const conflictReason = conflictReasonFor(disposition, elimination);

  const absorptions = [...new Set(inputs.absorptionModels.filter((v) => v.length > 0))];
  // At least one shape: with no absorption declared, the disclosed default (`first-order`) is it.
  const shapes: (string | null)[] = absorptions.length > 0 ? absorptions : [null];

  return shapes.map((shape): ShapeModelDerivation => ({
    ...buildDerivation({
      disposition,
      elimination,
      shape,
      presentParameters: inputs.presentParameters,
      opts: inputs.opts,
      conflictReason,
    }),
    absorptionShape: shape,
  }));
}

/**
 * Resolve a drug's route-keyed declarations into one derivation per administration ROUTE (CV-2c) —
 * the faithful per-route form. Each declared `RouteId` derives its own model from the drug-level
 * parameters PLUS that route's own parameters (route-specific `bioavailability`, `ka`), so two routes
 * sharing an absorption shape but differing in `F`/`ka` no longer collapse. Molecule-level axes
 * (disposition/elimination) are shared and, in conflict, make every route `not-modelable` exactly as
 * in the shape-keyed form.
 *
 * Absorption is resolved PER ROUTE with the same discipline as a molecule axis: a route may carry
 * several corroborating rows for one shape (deduped to that shape), but two DIFFERENT declared
 * shapes for one route are a curation conflict, surfaced as `not-modelable` for THAT route alone (a
 * molecule-axis conflict, by contrast, sinks every route). Unlike the shape-keyed `resolveDrugModels`
 * — where distinct absorption values are legitimately distinct SHAPES of one drug — a single route
 * has exactly one true input shape, so disagreement there is a contradiction, not two models.
 *
 * The resolved shape must also be COHERENT with the route (`absorptionCoherentWithRoute`): an `iv`
 * route must use an IV input, an extravascular route an extravascular one. This runs on the effective
 * shape — the declared value, or the disclosed extravascular default when unstated — so an `iv` route
 * with no absorption shape (reachable via a route-scoped `ka` stored against `route: 'iv'`) is
 * `not-modelable` rather than silently taking the extravascular default and yielding an IV-labelled
 * extravascular model; the mirror (an `oral` route declared as an IV bolus) is caught too.
 *
 * Finally, a route's OWN parameters must be coherent with its shape (`routeParamShapeConflict`): a
 * route-specific `ka` on an input with no first-order phase (IV bolus/infusion, zero-order), or a
 * route-specific `bioavailability` on an IV input (F is fixed at 1), is a contradiction the engine
 * would silently drop, so the route is `not-modelable`. This is scoped to the route's own parameters
 * deliberately — the shape-keyed `resolveDrugModels` shares one parameter pool across sibling shapes,
 * so a `ka`/`F` there belongs to a sibling and must not sink the IV shape.
 *
 * Routes are processed in a stable (sorted) order for determinism; a drug with no declared route
 * yields an empty array (no route data ⇒ nothing to derive — missing stays missing), which the
 * caller handles.
 */
/**
 * A route's OWN (route-scoped) parameter that contradicts its resolved input shape, or `null`. A
 * route-specific `ka` (a first-order absorption rate) needs a first-order absorption phase; a
 * route-specific `bioavailability` (F) is meaningless on an IV input (F is fixed at 1). Either is a
 * contradiction the engine would silently drop, so the route derives `not-modelable`.
 *
 * Scoped to the route's OWN parameters on purpose: the shape-keyed `resolveDrugModels` shares one
 * pool across sibling shapes, so a `ka`/`F` there belongs to a first-order/extravascular sibling and
 * must NOT sink the IV shape — hence this is a route-keyed rule, not a family-wide `forbidden` one.
 */
function routeParamShapeConflict(
  route: RouteId,
  shape: AbsorptionKind,
  routeRoles: ReadonlySet<RequiredParam | null>,
): string | null {
  if (routeRoles.has('ka') && !absorptionHasFirstOrderRate(shape)) {
    return `route ${route} declares an absorption rate (ka) but its input shape "${shape}" has no first-order absorption phase`;
  }
  if (routeRoles.has('bioavailability') && isIvAbsorptionKind(shape)) {
    return `route ${route} declares a bioavailability (F) but its IV input shape "${shape}" fixes F = 1`;
  }
  return null;
}

export function resolveDrugModelsByRoute(inputs: RouteKeyedDrugModelInputs): RouteModelDerivation[] {
  const disposition = resolveAxis(inputs.dispositionModels);
  const elimination = resolveAxis(inputs.eliminationModels);
  const moleculeConflict = conflictReasonFor(disposition, elimination);

  // Skip any route whose declaration is explicitly `undefined` — an absent route, not a declared
  // one. `Partial<Record<RouteId, RouteDeclaration>>` admits `{ oral: undefined }` (there is no
  // `exactOptionalPropertyTypes`), and a map built from route lookups can carry undefined too, so
  // guard the entries rather than trusting `Object.keys`. Sort for determinism.
  const declaredRoutes = (
    Object.entries(inputs.routes) as [RouteId, RouteDeclaration | undefined][]
  )
    .filter((entry): entry is [RouteId, RouteDeclaration] => entry[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return declaredRoutes.map(([route, declaration]): RouteModelDerivation => {
    // Normalize the declaration's absorption to a value set (a single value, a set, or none), then
    // resolve it exactly as a molecule axis: agreement/single ⇒ the shape, disagreement ⇒ a
    // route-local conflict, none ⇒ the disclosed default downstream.
    const absorptionValues =
      declaration.absorption == null
        ? []
        : Array.isArray(declaration.absorption)
          ? declaration.absorption
          : [declaration.absorption];
    const absorption = resolveAxis(absorptionValues);
    // A molecule-axis conflict sinks every route; a per-route absorption conflict sinks only this
    // one. The molecule conflict takes precedence in the reported reason when both hold.
    const absorptionConflict = absorption.conflict
      ? `conflicting absorption declarations for route ${route}: ${absorption.conflict.join(', ')}`
      : null;
    // Route/absorption coherence: an `iv` route must use an IV input shape, an extravascular route
    // an extravascular one. The check runs on the EFFECTIVE shape (the declared value, else the
    // disclosed extravascular default), so an `iv` route left to that default — reachable today via
    // a route-scoped `ka` stored against `route: 'iv'` — is caught rather than becoming an
    // IV-labelled extravascular model. Skip an unrecognized declared value; `deriveModel` reports it.
    const effectiveShape = absorption.value ?? MODEL_STRUCTURE_DEFAULTS.absorption;
    const incoherentRoute =
      !moleculeConflict &&
      !absorptionConflict &&
      isAbsorptionKind(effectiveShape) &&
      !absorptionCoherentWithRoute(route, effectiveShape)
        ? `route ${route} is incompatible with absorption shape "${effectiveShape}"${
            absorption.value === null ? ' (the disclosed extravascular default)' : ''
          }`
        : null;
    // A route's OWN (route-scoped) parameters must fit its input shape (see `routeParamShapeConflict`).
    const routeRoles = new Set(
      (declaration.presentParameters ?? []).map((p) => parameterRoleFor(p)),
    );
    const contradictoryRouteParam =
      !moleculeConflict && !absorptionConflict && !incoherentRoute && isAbsorptionKind(effectiveShape)
        ? routeParamShapeConflict(route, effectiveShape, routeRoles)
        : null;
    const conflictReason =
      moleculeConflict ?? absorptionConflict ?? incoherentRoute ?? contradictoryRouteParam;
    // The route derives from the drug-level pool plus its own route-specific parameters.
    const presentParameters = [
      ...inputs.presentParameters,
      ...(declaration.presentParameters ?? []),
    ];
    const derivationArgs = {
      elimination,
      shape: absorption.value,
      // Asserted when a shape was declared OR the values conflict (they were asserted, just
      // disagree) — so a conflicting route is not mislabelled as a disclosed default.
      absorptionAsserted: absorption.value !== null || absorption.conflict !== null,
      presentParameters,
      opts: inputs.opts,
      conflictReason,
    };
    const dispositionFallback = simplifiedDispositionFallback(disposition, conflictReason, () =>
      buildDerivation({
        ...derivationArgs,
        disposition: { value: SIMPLIFIED_DISPOSITION, conflict: null },
      }),
    );
    return {
      ...buildDerivation({ ...derivationArgs, disposition }),
      route,
      absorptionShape: absorption.value,
      routeProvenance: declaration.provenance ?? 'asserted',
      ...(dispositionFallback ? { dispositionFallback } : {}),
    };
  });
}

/** The disposition a richer declared one is simplified to when the catalog cannot yet run it. */
const SIMPLIFIED_DISPOSITION: DispositionKind = 'one-compartment';

/**
 * The one-compartment fallback for a route whose asserted disposition is richer than the catalog can
 * yet run (see `RouteModelDerivation.dispositionFallback`), or `undefined` when none applies: the
 * disposition is unstated (the default already IS one-compartment), already one-compartment, not a
 * recognized kind, or the route is in conflict. The fallback's disposition axis stays `asserted` —
 * the drug did declare one; what ran instead is recorded by the read adapter as a simplification.
 */
function simplifiedDispositionFallback(
  disposition: AxisResolution,
  conflictReason: string | null,
  derive: () => DerivedModel,
): DerivedModel | undefined {
  if (conflictReason !== null || disposition.value === null) return undefined;
  if (disposition.value === SIMPLIFIED_DISPOSITION) return undefined;
  if (!(DISPOSITION_KINDS as readonly string[]).includes(disposition.value)) return undefined;
  const fallback = derive();
  return {
    ...fallback,
    axisProvenance: { ...fallback.axisProvenance, disposition: 'asserted' },
  };
}
