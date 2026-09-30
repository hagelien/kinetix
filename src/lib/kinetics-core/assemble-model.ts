/**
 * Assemble a runnable engine route from a derived model + its parameter values (CV-4b,
 * catalog-coverage track).
 *
 * CV-2's `deriveModel` answers "what family does this drug's declaration compose to, and what is
 * missing?"; CV-3 grades and disclaims that. This module is the next step in the integration spine
 * (plan §4 / §6): given a `modelable` `DerivedModel` and the numeric values the catalog holds, build
 * the engine's `RouteModelParams` for that family — the shape `simulateScenario` consumes.
 *
 * **The range→ParamSpec policy is `fixed(median)` (founder decision, 2026-08-24).** The DB stores
 * each parameter as a min/median/max range; this slice maps the MEDIAN onto a `fixed` `ParamSpec`,
 * so a derived curve is the deterministic median prediction. The range is NOT yet turned into
 * parameter variability (SC-1B) — CV-3b's grade-band widening already keeps a derived curve from
 * reading as over-confident, and the distribution-shape choice (turning a stored range into a
 * `uniform`/`triangular`/`lognormal` spread) is deferred to its own later slice so no unvalidated
 * distribution assumption is baked into every catalog model here.
 *
 * Scope: this pure primitive maps the LINEAR ONE-COMPARTMENT families the catalog derivation
 * actually produces today (`iv-one-compartment`, `one-compartment-first-order`,
 * `one-compartment-zero-order`, `one-compartment-mixed-order`). Families that need inputs the
 * catalog cannot yet supply — the CL/V structural identifiability basis, two-compartment
 * micro-constants, Michaelis–Menten Vmax/Km in canonical units, or the parent→metabolite link and
 * molar masses — return `unsupported` until those inputs land, rather than assembling from data the
 * catalog does not have. "Missing stays missing" holds here too: an incomplete family is reported,
 * never filled with a guessed value.
 *
 * Pure and additive: engine vocabulary only, no DB read, no equation/solver/scenario change, so no
 * `CORE_VERSION` bump. It consumes CANONICAL engine units (hours, per-hour, L/kg, 0–1); the DB→
 * canonical unit conversion and the `vdScaling`-from-unit inference are the read adapter's concern
 * (a following slice), which passes `vdScaling` in via `opts`.
 */
import { fixed } from './param.js';
import type { DerivedModel } from './derive-model.js';
import {
  requiredParametersFor,
  type RequiredParam,
  type StructureRequirementOptions,
} from './model-structure.js';
import type {
  IvOneCompartmentRouteParams,
  ModelFamily,
  OneCompartmentMixedOrderRouteParams,
  OneCompartmentRouteParams,
  OneCompartmentZeroOrderRouteParams,
  RouteModelParams,
  VdScaling,
} from './types.js';

/**
 * Canonical-unit MEDIAN values for a model's parameter roles, keyed by `RequiredParam`. Each is the
 * single value the `fixed(median)` policy wraps into a `ParamSpec`. A role absent from the map (or
 * present but not a finite number) is treated as missing.
 */
export type AssemblyValues = Partial<Record<RequiredParam, number>>;

/** Options that steer assembly beyond the parameter values themselves. */
export interface AssembleOptions extends StructureRequirementOptions {
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
  /** No route can be assembled: the derivation is not-modelable, or its family needs inputs this
   *  primitive does not yet map (see the module header). */
  | { outcome: 'unsupported'; reason: string };

/** The families this primitive maps today (see the module header for what is deferred and why). */
type AssembledFamily =
  | 'iv-one-compartment'
  | 'one-compartment-first-order'
  | 'one-compartment-zero-order'
  | 'one-compartment-mixed-order';

const ASSEMBLED_FAMILIES: readonly AssembledFamily[] = [
  'iv-one-compartment',
  'one-compartment-first-order',
  'one-compartment-zero-order',
  'one-compartment-mixed-order',
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
  return true;
}

/**
 * Assemble the engine `RouteModelParams` for one route from a derived model and its median values.
 * Pure. Returns `unsupported` when the derivation is not-modelable or its family is not yet mapped;
 * `incomplete` (with the missing roles) when a required value is absent/non-finite; otherwise
 * `assembled` with every value wrapped as `fixed(median)`.
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
  if (missing.length > 0) return { outcome: 'incomplete', family, missing };

  return { outcome: 'assembled', family, params: buildParams(family, derived, values, opts) };
}

/** Build the family-specific route params. Every required role is guaranteed present and finite by
 *  the completeness gate in `assembleRouteParams`, so the reads below are safe. */
function buildParams(
  family: AssembledFamily,
  derived: DerivedModel,
  values: AssemblyValues,
  opts: AssembleOptions,
): RouteModelParams {
  switch (family) {
    case 'iv-one-compartment': {
      const params: IvOneCompartmentRouteParams = {
        family: 'iv-one-compartment',
        eliminationHalfLifeHours: fixed(values.eliminationHalfLife!),
        vdLitersPerKg: fixed(values.vd!),
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
        kaPerHour: fixed(values.ka!),
        eliminationHalfLifeHours: fixed(values.eliminationHalfLife!),
        vdLitersPerKg: fixed(values.vd!),
        bioavailability: fixed(values.bioavailability!),
      };
      if (opts.vdScaling) params.vdScaling = opts.vdScaling;
      return params;
    }
    case 'one-compartment-zero-order': {
      const params: OneCompartmentZeroOrderRouteParams = {
        family: 'one-compartment-zero-order',
        zeroOrderDurationHours: fixed(values.zeroOrderDuration!),
        eliminationHalfLifeHours: fixed(values.eliminationHalfLife!),
        vdLitersPerKg: fixed(values.vd!),
        bioavailability: fixed(values.bioavailability!),
      };
      if (opts.vdScaling) params.vdScaling = opts.vdScaling;
      return params;
    }
    case 'one-compartment-mixed-order': {
      const params: OneCompartmentMixedOrderRouteParams = {
        family: 'one-compartment-mixed-order',
        firstOrderFraction: fixed(values.firstOrderFraction!),
        kaPerHour: fixed(values.ka!),
        zeroOrderDurationHours: fixed(values.zeroOrderDuration!),
        eliminationHalfLifeHours: fixed(values.eliminationHalfLife!),
        vdLitersPerKg: fixed(values.vd!),
        bioavailability: fixed(values.bioavailability!),
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
