/**
 * Assemble a runnable engine route from a derived model + its parameter values (CV-4b,
 * catalog-coverage track).
 *
 * CV-2's `deriveModel` answers "what family does this drug's declaration compose to, and what is
 * missing?"; CV-3 grades and disclaims that. This module is the next step in the integration spine
 * (plan §4 / §6): given a `modelable` `DerivedModel` and the numeric values the catalog holds, build
 * the engine's `RouteModelParams` for that family — the shape `simulateScenario` consumes.
 *
 * **The range→ParamSpec policy is `triangular(low, median, high)` where the catalog holds a spread,
 * `fixed(median)` where it does not (owner decision, 2026-10-07, superseding the 2026-08-24
 * `fixed(median)`-only policy).** The DB stores each parameter as a pooled median plus the lowest
 * and highest values its sources report. A role with such a spread (`opts.ranges`) becomes a
 * triangular spec over it, peaked at the median: the central value — and so the deterministic and
 * median curve — is exactly what `fixed(median)` gave, and a Monte-Carlo run draws a band across
 * the published spread. The band means "the curves the reported values allow", sampled
 * independently per input: bounds are extrema (`BoundMeaning` `extrema`), not quantiles, so it is a
 * plausible range and never a confidence or prediction interval. A role with no usable spread stays
 * `fixed(median)`, and the grade says so.
 *
 * Scope: this pure primitive maps every family the catalog derivation can supply inputs for — the
 * linear `iv-one-compartment`, `one-compartment-first-order`, `one-compartment-zero-order` and
 * `one-compartment-mixed-order` (their zero-order duration and first-order fraction are route-scoped
 * catalog parameters), the saturable `michaelis-menten` family (molecule-level Vmax and Km, canonical
 * mg/L/h and mg/L), and `two-compartment-first-order` in its micro-constant form (molecule-level k12,
 * k21 and central volume V1, with k10 derived by the engine from the terminal half-life). An optional
 * absorption lag rides on the families whose engine route carries one. Families that need inputs the
 * catalog cannot yet supply — the CL/V structural identifiability basis (and absolute-litre volumes)
 * of `one-compartment-clv`, or the parent→metabolite link and molar masses — return `unsupported`
 * until those inputs land, rather than assembling from data the catalog does not have. "Missing
 * stays missing" holds here too: an incomplete family is reported, never filled with a guessed value.
 *
 * Pure and additive: engine vocabulary only, no DB read, no equation/solver/scenario change, so no
 * `CORE_VERSION` bump. It consumes CANONICAL engine units (hours, per-hour, L/kg, 0–1); the DB→
 * canonical unit conversion and the `vdScaling`-from-unit inference are the read adapter's concern
 * (a following slice), which passes `vdScaling` in via `opts`.
 */
import { fixed, triangular } from './param.js';
import type { DerivedModel } from './derive-model.js';
import {
  optionalParametersFor,
  requiredParametersFor,
  type RequiredParam,
  type StructureRequirementOptions,
} from './model-structure.js';
import type {
  IvOneCompartmentRouteParams,
  MichaelisMentenRouteParams,
  ParamSpec,
  ModelFamily,
  OneCompartmentMixedOrderRouteParams,
  OneCompartmentRouteParams,
  OneCompartmentZeroOrderRouteParams,
  RouteModelParams,
  TwoCompartmentRouteParams,
  VdScaling,
} from './types.js';

/**
 * Canonical-unit MEDIAN values for a model's parameter roles, keyed by `RequiredParam`. Each is the
 * single value the `fixed(median)` policy wraps into a `ParamSpec`. A role absent from the map (or
 * present but not a finite number) is treated as missing.
 */
export type AssemblyValues = Partial<Record<RequiredParam, number>>;

/** The lowest and highest value a role's sources report, in the same canonical unit as its median. */
export interface AssemblyRange {
  low: number;
  high: number;
}

/** Per-role reported spreads, keyed like `AssemblyValues`. A role absent here has no spread. */
export type AssemblyRanges = Partial<Record<RequiredParam, AssemblyRange>>;

/** Options that steer assembly beyond the parameter values themselves. */
export interface AssembleOptions extends StructureRequirementOptions {
  /**
   * The reported spread for each role, when the catalog holds one. A usable spread (see
   * `rangedSpec`) turns that role's `fixed(median)` into `triangular(low, median, high)`.
   */
  ranges?: AssemblyRanges;
  /**
   * How the assembled `vdLitersPerKg` scales to the subject. Omitted → the engine's `total-weight`
   * default (the field is left unset, so an assembled model matches a hand-authored one that omits
   * it). The read adapter infers this from the stored Vd's unit.
   */
  vdScaling?: VdScaling;
}

/** The outcome of assembling one route's parameters. */
export type ModelAssembly =
  | { outcome: 'assembled'; family: ModelFamily; params: RouteModelParams }
  /** The family is supported but one or more required values are absent/non-finite (missing stays
   *  missing) — the caller grades it down (CV-3), it is not a curve. */
  | { outcome: 'incomplete'; family: ModelFamily; missing: RequiredParam[] }
  /** No route can be assembled: the derivation is not-modelable, its family needs inputs this
   *  primitive does not yet map (see the module header), a supplied optional input (a lag) has no
   *  place in the family, or — `contradiction: true` — the supplied values contradict the family's
   *  own structure (two-compartment rates that cannot produce the stored terminal half-life). A
   *  contradiction is a curation finding: a caller must not paper over it with a simpler model. */
  | { outcome: 'unsupported'; reason: string; contradiction?: true };

/** The families this primitive maps today (see the module header for what is deferred and why). */
type AssembledFamily =
  | 'iv-one-compartment'
  | 'one-compartment-first-order'
  | 'one-compartment-zero-order'
  | 'one-compartment-mixed-order'
  | 'michaelis-menten'
  | 'two-compartment-first-order';

const ASSEMBLED_FAMILIES: readonly AssembledFamily[] = [
  'iv-one-compartment',
  'one-compartment-first-order',
  'one-compartment-zero-order',
  'one-compartment-mixed-order',
  'michaelis-menten',
  'two-compartment-first-order',
];

function isAssembledFamily(family: ModelFamily): family is AssembledFamily {
  return (ASSEMBLED_FAMILIES as readonly ModelFamily[]).includes(family);
}

/** Duration roles that must be STRICTLY POSITIVE to be usable. A non-positive infusion/zero-order
 *  duration is not merely an out-of-range value the engine rejects: `simulate.ts` treats a
 *  non-positive `infusionDurationHours` as `infusing = false` and silently runs the IV BOLUS kernel
 *  (and a zero zero-order duration divides by zero), so a `0`/negative duration would produce a
 *  curve for the WRONG input shape rather than being refused. Treat it as missing (missing stays
 *  missing), not assembled. */
const POSITIVE_DURATION_ROLES: readonly RequiredParam[] = ['infusionDuration', 'zeroOrderDuration'];

/** A role's value is usable only if it is present AND a finite number — a `NaN`/`Infinity` must not
 *  become a `fixed(NaN)` curve, so it is treated as missing. Duration roles additionally require a
 *  strictly positive value (see `POSITIVE_DURATION_ROLES`). Other semantic range checks (`vd > 0`,
 *  `0 ≤ F ≤ 1`) are the engine's own scenario gate downstream — it fails those VISIBLY
 *  (`valid: false`), so they are not re-implemented here; the duration case is special only because
 *  the engine reinterprets it silently instead of rejecting it. */
function isUsable(role: RequiredParam, value: number | undefined): value is number {
  if (value === undefined || !Number.isFinite(value)) return false;
  if (POSITIVE_DURATION_ROLES.includes(role) && value <= 0) return false;
  if (NON_NEGATIVE_ROLES.includes(role) && value < 0) return false;
  return true;
}

/** Roles whose value is a fraction and must stay within [0, 1] at every draw. */
const FRACTION_ROLES: readonly RequiredParam[] = ['bioavailability', 'firstOrderFraction'];

/** Roles for which zero is a real value rather than a degenerate one: a lag of 0 h is "no lag". A
 *  negative lag is not a time the input can start at, so it is unusable. */
const NON_NEGATIVE_ROLES: readonly RequiredParam[] = ['absorptionLag'];

/**
 * The spec for one role: `triangular(low, median, high)` when its reported spread is usable, else
 * `fixed(median)`. Usable means finite, a real interval (`low < high`) containing the median, and
 * inside the role's possible values at both ends — strictly positive for a rate, half-life, volume
 * or duration, within [0, 1] for a fraction — so no draw can leave the domain the engine accepts.
 * A spread failing any of these is dropped rather than clipped: clipping would invent a bound no
 * source reported.
 */
function rangedSpec(role: RequiredParam, median: number, ranges: AssemblyRanges | undefined): ParamSpec {
  const range = ranges?.[role];
  if (!range || !rangeIsUsable(role, median, range)) return fixed(median);
  return triangular(range.low, median, range.high);
}

/** Whether `range` can be drawn from for `role` around `median` (see `rangedSpec`). */
export function rangeIsUsable(role: RequiredParam, median: number, range: AssemblyRange): boolean {
  const { low, high } = range;
  if (!Number.isFinite(low) || !Number.isFinite(high) || !(low < high)) return false;
  if (median < low || median > high) return false;
  if (FRACTION_ROLES.includes(role)) return low >= 0 && high <= 1;
  if (NON_NEGATIVE_ROLES.includes(role)) return low >= 0;
  return low > 0;
}

/**
 * Whether a two-compartment route's micro-constants can produce its stored terminal half-life. The
 * terminal rate β (= ln2 / t½) is the smaller root of `s² − (k10+k12+k21)·s + k10·k21`, and that
 * root always lies strictly below k21; conversely any k21 > β gives a positive k10 =
 * β(k12+k21−β)/(k21−β) whose smaller root is exactly β. So `k21 > β` is the whole coherence
 * condition. The engine does not refuse the incoherent case — `deriveK10` silently falls back to
 * k10 = β, a different curve from the one the cited numbers describe — so assembly must.
 */
function twoCompartmentCoherent(k21: number, halfLifeHours: number): boolean {
  return k21 > Math.LN2 / halfLifeHours;
}

/**
 * Assemble the engine `RouteModelParams` for one route from a derived model and its median values.
 * Pure. Returns `unsupported` when the derivation is not-modelable or its family is not yet mapped;
 * `incomplete` (with the missing roles) when a required value is absent/non-finite; otherwise
 * `assembled`, each value wrapped as a triangular spec over its reported spread or as
 * `fixed(median)` when it has none (see `rangedSpec`).
 */
export function assembleRouteParams(
  derived: DerivedModel,
  values: AssemblyValues,
  opts: AssembleOptions = {},
): ModelAssembly {
  if (derived.outcome !== 'modelable' || !derived.family) {
    return { outcome: 'unsupported', reason: derived.reason ?? 'derivation is not modelable' };
  }
  const family = derived.family;
  if (!isAssembledFamily(family)) {
    return {
      outcome: 'unsupported',
      reason: `assembly for the ${family} family is not implemented yet`,
    };
  }

  // Gate completeness against the SAME authority the derivation used, re-checked against the actual
  // numeric values now supplied. The IV-infusion variant is fixed by the absorption axis (not the
  // caller), mirroring `validateModelStructure`, so a constant-rate IV route requires its duration.
  const effectiveOpts: StructureRequirementOptions = {
    ...opts,
    ivInfusion: derived.structure.absorption === 'iv-infusion',
  };
  const required = requiredParametersFor(family, effectiveOpts);
  const missing = required.filter((role) => !isUsable(role, values[role]));
  // An optional role that is PRESENT must be usable too: a stored lag that cannot be read as a time
  // (negative, non-finite) is not "no lag", and running without it would misplace the peak.
  const optional = optionalParametersFor(family);
  const unusableOptional = optional.filter(
    (role) => values[role] !== undefined && !isUsable(role, values[role]),
  );
  if (missing.length > 0 || unusableOptional.length > 0) {
    return { outcome: 'incomplete', family, missing: [...missing, ...unusableOptional] };
  }
  // A contradiction must survive an unsupported lag so the read adapter cannot choose a fallback.
  if (
    family === 'two-compartment-first-order' &&
    !twoCompartmentCoherent(values.k21!, values.eliminationHalfLife!)
  ) {
    return {
      outcome: 'unsupported',
      contradiction: true,
      reason: `the two-compartment rates contradict the terminal half-life: k21 (${values.k21} /h) must exceed the terminal rate ln2/t½ (${(Math.LN2 / values.eliminationHalfLife!).toPrecision(4)} /h)`,
    };
  }
  // A lag the family has no place for is refused, not dropped: the engine routes of the
  // two-compartment, saturable and IV families carry no lag, and a curve that ignores a cited lag
  // puts the peak too early. A cited lag of exactly zero with no spread IS "no lag", so it is the
  // one lag such a family can honour by omitting it.
  const lagIsNone =
    values.absorptionLag === 0 &&
    !(opts.ranges?.absorptionLag && rangeIsUsable('absorptionLag', 0, opts.ranges.absorptionLag));
  if (values.absorptionLag !== undefined && !lagIsNone && !optional.includes('absorptionLag')) {
    return {
      outcome: 'unsupported',
      reason: `the ${family} family does not model an absorption lag, so the stored lag cannot be run`,
    };
  }
  return { outcome: 'assembled', family, params: buildParams(family, derived, values, opts) };
}

/**
 * The spreads a two-compartment route may be drawn across. Each Monte-Carlo draw takes k21 and the
 * half-life independently, so a draw pairing the lowest k21 with the shortest half-life can fall
 * outside the coherence condition the medians satisfy — and the engine would then run that draw on
 * a different curve without saying so (see `twoCompartmentCoherent`). When the reported spreads
 * admit such a pair, both are dropped to their medians rather than clipped: clipping would invent a
 * bound no source reported, and the grade reports a fixed input as one without a spread.
 */
function coherentTwoCompartmentRanges(
  values: AssemblyValues,
  ranges: AssemblyRanges | undefined,
): AssemblyRanges | undefined {
  if (!ranges) return ranges;
  const k21Range = ranges.k21;
  const halfLifeRange = ranges.eliminationHalfLife;
  const lowestK21 =
    k21Range && rangeIsUsable('k21', values.k21!, k21Range) ? k21Range.low : values.k21!;
  const shortestHalfLife =
    halfLifeRange && rangeIsUsable('eliminationHalfLife', values.eliminationHalfLife!, halfLifeRange)
      ? halfLifeRange.low
      : values.eliminationHalfLife!;
  if (twoCompartmentCoherent(lowestK21, shortestHalfLife)) return ranges;
  const rest: AssemblyRanges = { ...ranges };
  delete rest.k21;
  delete rest.eliminationHalfLife;
  return rest;
}

/** Build the family-specific route params. Every required role is guaranteed present and finite by
 *  the completeness gate in `assembleRouteParams`, so the reads below are safe. */
function buildParams(
  family: AssembledFamily,
  derived: DerivedModel,
  values: AssemblyValues,
  opts: AssembleOptions,
): RouteModelParams {
  const ranges =
    family === 'two-compartment-first-order'
      ? coherentTwoCompartmentRanges(values, opts.ranges)
      : opts.ranges;
  const spec = (role: RequiredParam): ParamSpec => rangedSpec(role, values[role]!, ranges);
  // The optional lag, when stored. The completeness gate has refused it for a family without a lag
  // field, so only the cases below that carry one read it.
  const lag = values.absorptionLag !== undefined ? spec('absorptionLag') : undefined;
  switch (family) {
    case 'iv-one-compartment': {
      const params: IvOneCompartmentRouteParams = {
        family: 'iv-one-compartment',
        eliminationHalfLifeHours: spec('eliminationHalfLife'),
        vdLitersPerKg: spec('vd'),
      };
      // The constant-rate IV infusion variant carries a real (non-ParamSpec) duration; a plain bolus
      // omits it. The gate has already ensured it is present for an `iv-infusion` route.
      if (derived.structure.absorption === 'iv-infusion') {
        params.infusionDurationHours = values.infusionDuration!;
      }
      if (opts.vdScaling) params.vdScaling = opts.vdScaling;
      return params;
    }
    case 'one-compartment-first-order': {
      const params: OneCompartmentRouteParams = {
        family: 'one-compartment-first-order',
        kaPerHour: spec('ka'),
        eliminationHalfLifeHours: spec('eliminationHalfLife'),
        vdLitersPerKg: spec('vd'),
        bioavailability: spec('bioavailability'),
      };
      if (opts.vdScaling) params.vdScaling = opts.vdScaling;
      if (lag) params.absorptionLagHours = lag;
      return params;
    }
    case 'one-compartment-zero-order': {
      const params: OneCompartmentZeroOrderRouteParams = {
        family: 'one-compartment-zero-order',
        zeroOrderDurationHours: spec('zeroOrderDuration'),
        eliminationHalfLifeHours: spec('eliminationHalfLife'),
        vdLitersPerKg: spec('vd'),
        bioavailability: spec('bioavailability'),
      };
      if (opts.vdScaling) params.vdScaling = opts.vdScaling;
      if (lag) params.absorptionLagHours = lag;
      return params;
    }
    case 'one-compartment-mixed-order': {
      const params: OneCompartmentMixedOrderRouteParams = {
        family: 'one-compartment-mixed-order',
        firstOrderFraction: spec('firstOrderFraction'),
        kaPerHour: spec('ka'),
        zeroOrderDurationHours: spec('zeroOrderDuration'),
        eliminationHalfLifeHours: spec('eliminationHalfLife'),
        vdLitersPerKg: spec('vd'),
        bioavailability: spec('bioavailability'),
      };
      if (opts.vdScaling) params.vdScaling = opts.vdScaling;
      if (lag) params.absorptionLagHours = lag;
      return params;
    }
    case 'michaelis-menten': {
      // The half-life is the family's nominal display value only; Vmax and Km drive elimination.
      const params: MichaelisMentenRouteParams = {
        family: 'michaelis-menten',
        kaPerHour: spec('ka'),
        vmaxMgPerLPerHour: spec('vmax'),
        kmMgPerL: spec('km'),
        eliminationHalfLifeHours: spec('eliminationHalfLife'),
        vdLitersPerKg: spec('vd'),
        bioavailability: spec('bioavailability'),
      };
      if (opts.vdScaling) params.vdScaling = opts.vdScaling;
      return params;
    }
    case 'two-compartment-first-order': {
      // The engine's `vdLitersPerKg` here is the CENTRAL volume V1, so it is filled from the
      // `centralVolume` role — never from the generic (steady-state/terminal) Vd, which would scale
      // the whole curve by the tissue volume. The half-life is the TERMINAL one; the engine derives
      // k10 from it and the two micro-constants.
      const params: TwoCompartmentRouteParams = {
        family: 'two-compartment-first-order',
        kaPerHour: spec('ka'),
        eliminationHalfLifeHours: spec('eliminationHalfLife'),
        k12PerHour: spec('k12'),
        k21PerHour: spec('k21'),
        vdLitersPerKg: spec('centralVolume'),
        bioavailability: spec('bioavailability'),
      };
      if (opts.vdScaling) params.vdScaling = opts.vdScaling;
      return params;
    }
    default:
      return assertNever(family);
  }
}

/** Compile-time exhaustiveness guard: a new `AssembledFamily` without a case fails the build. */
function assertNever(family: never): never {
  throw new Error(`unhandled assembled family: ${String(family)}`);
}
