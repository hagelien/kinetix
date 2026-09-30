/**
 * Canonical scenario / result contract for kinetics-core.
 *
 * This is the harmonization boundary: given the SAME CanonicalScenario, Kinetix
 * and Redose must return the SAME CanonicalResult within declared tolerance.
 * Everything here is a plain TypeScript type (no zod) so the package stays
 * dependency-free and Hermes-safe; validation is hand-rolled in `simulate.ts`.
 */

/** Administration route of a single dose event. */
/** Administration routes, as a runtime pick-list. The single source of truth for the route
 *  vocabulary — the `RouteId` type derives from it, and the DB's route CHECK (migration 0111,
 *  CV-2c) is held in step with it by `modelStructureVocabulary.test.ts`, exactly as the
 *  model-structure axes are. */
export const ROUTE_IDS = [
  'oral',
  'intranasal',
  'iv',
  'im',
  'sublingual',
  'rectal',
  'inhalation',
  'other',
] as const;
export type RouteId = (typeof ROUTE_IDS)[number];

/** Biological matrix the concentration curve represents. */
export type Matrix =
  | 'plasma'
  | 'serum'
  | 'whole_blood'
  | 'breath'
  | 'other';

/**
 * A reviewed conversion between the matrix a model NATIVELY computes (its latent
 * matrix) and the matrix a measurement is actually taken in (SC-5A, plan §5.6/§S5).
 * The observation is not the latent state: a plasma-parameterised model must not be
 * silently read as a whole-blood laboratory value. A model DECLARES the conversions
 * that are scientifically reviewed for its analyte; a scenario requesting a matrix the
 * model does not natively compute is honoured only when a declared transform covers it,
 * and the applied transform is recorded in the run manifest.
 *
 * `ratio` is the multiplicative factor: an observed (`to`) concentration equals the
 * latent (`from`) concentration times `ratio` (e.g. a whole-blood:plasma partition
 * ratio). Reviewed, finite and > 0. Uncertainty in the ratio is a separate observation
 * layer (SC-5B); this contract carries the deterministic point conversion.
 */
export interface MatrixTransform {
  from: Matrix;
  to: Matrix;
  ratio: number;
  /**
   * The analyte this conversion applies to. A blood/plasma partition ratio is
   * analyte-SPECIFIC — a metabolite is a distinct chemical entity with its own ratio —
   * so a multi-analyte model must declare a transform per emitted analyte. Omit for the
   * model's PRIMARY analyte; set to a metabolite's analyte id for that curve. A
   * cross-matrix request is refused unless EVERY emitted analyte has a matching transform,
   * so a metabolite is never rescaled by the parent's ratio.
   */
  analyte?: string;
  /** Why this conversion is valid for this analyte (evidence / citation). */
  rationale: string;
}

/**
 * One reviewed OBSERVATION residual-error component (SC-5B, plan §5.6/§S5). The reported
 * concentration is a latent MODEL prediction; a real MEASUREMENT of it also carries error
 * that the latent kinetics do not — assay imprecision, preanalytical (stability/handling),
 * unmodelled biological, and structural residual error — and the plan requires these kept
 * as DISTINCT named layers rather than folded into one number. A model declares the layers
 * that are reviewed for an analyte; the engine composes independent layers in variance
 * (`totalCv = √Σcv²`, `totalSd = √Σsd²`) and WIDENS the reported uncertainty bands by the
 * resulting observation error (the median — the deterministic central prediction — is
 * unchanged, since the error is zero-mean). This is an OBSERVATION layer, distinct from
 * the PARAMETER/individual variability that produces the underlying bands (plan §4.3).
 */
export interface ObservationErrorLayer {
  /** The error source: e.g. `analytical`, `preanalytical`, `biological`, `structural`. */
  layer: string;
  /**
   * Proportional component — a fractional coefficient of variation applied to the
   * concentration (0.1 = 10%). The SD it contributes at concentration `C` is `cv·C`.
   */
  proportionalCv?: number;
  /** Additive component — a concentration-independent SD in canonical units (mg/L). */
  additiveSd?: number;
  /**
   * The analyte this error applies to. Assay/residual error is analyte- and
   * method-specific, so a multi-analyte model declares error per emitted analyte. Omit
   * for the model's PRIMARY analyte; set to a metabolite's id for that curve. An analyte
   * with no declared layer simply gets no observation widening (the layer is optional).
   */
  analyte?: string;
  /** Why this error model is valid for this analyte (evidence / citation). */
  rationale: string;
}

/** What the dose mass represents. The core never infers this from a label. */
export type DoseBasis = 'active-moiety' | 'parent' | 'salt' | 'free-base';

/** Implemented PK model families. Extend as reviewed models are added. */
export type ModelFamily =
  | 'one-compartment-first-order'
  | 'one-compartment-clv'
  | 'iv-one-compartment'
  | 'one-compartment-zero-order'
  | 'one-compartment-mixed-order'
  | 'two-compartment-first-order'
  | 'michaelis-menten'
  | 'parent-metabolite-first-order';

/**
 * The same families as a RUNTIME list, so a consumer that has to enumerate them
 * (the mechanics page's family table, a coverage report) reads the engine rather
 * than transcribing it — a family added to the type above and left out here fails
 * the exhaustiveness assertion below at compile time.
 */
export const MODEL_FAMILIES = [
  'one-compartment-first-order',
  'one-compartment-clv',
  'iv-one-compartment',
  'one-compartment-zero-order',
  'one-compartment-mixed-order',
  'two-compartment-first-order',
  'michaelis-menten',
  'parent-metabolite-first-order',
] as const;

// Compile-time exhaustiveness: both directions, so neither list can gain a member
// the other lacks.
type _FamilyListCoversType = ModelFamily extends (typeof MODEL_FAMILIES)[number]
  ? true
  : never;
type _FamilyListStaysInType = (typeof MODEL_FAMILIES)[number] extends ModelFamily
  ? true
  : never;
const _familyListIsExhaustive: [_FamilyListCoversType, _FamilyListStaysInType] = [
  true,
  true,
];
void _familyListIsExhaustive;

/**
 * How a family's concentration curve is evaluated. `closed-form` families are
 * evaluated analytically at any time and superposed dose by dose; `ode` families
 * are integrated numerically over the whole scenario at once (see `solver.ts`).
 * The distinction is user-visible: only the closed-form path can refine Cmax
 * between output-grid samples.
 */
export const MODEL_FAMILY_EVALUATION: Record<ModelFamily, 'closed-form' | 'ode'> = {
  'one-compartment-first-order': 'closed-form',
  'one-compartment-clv': 'closed-form',
  'iv-one-compartment': 'closed-form',
  'one-compartment-zero-order': 'closed-form',
  'one-compartment-mixed-order': 'closed-form',
  'two-compartment-first-order': 'ode',
  'michaelis-menten': 'ode',
  'parent-metabolite-first-order': 'ode',
};

/** The canonical concentration unit the core emits. */
export type CanonicalUnit = 'mg/L';

/** Covariates a model may declare it consumes. Others are ignored + surfaced. */
export type CovariateId =
  | 'weightKg'
  | 'heightCm'
  | 'age'
  | 'sex'
  | 'liverFunction'
  | 'kidneyFunction';

/**
 * How a route's volume of distribution scales to the subject.
 *   - `total-weight`   — Vd = vdLitersPerKg · weightKg (lipophilic drugs; default).
 *   - `lean-body-mass` — Vd = vdLitersPerKg · 70 · (LBM / 56), LBM from the Boer
 *     formula. For hydrophilic drugs that distribute into lean/water mass rather
 *     than fat. Requires the subject's `heightCm` and `sex`. Reproduces Redose's
 *     legacy `scaleVd(..., lipophilic=false)` exactly (see scaling.ts).
 *   - `widmark` — Vd = vdLitersPerKg · weightKg · r, where r is the Widmark factor
 *     (total body water via the Watson formula ÷ weight·0.806, clamped 0.4–0.9).
 *     The ethanol distribution volume. The subject-derived r carries the body
 *     composition, so a `widmark` model sets `vdLitersPerKg = 1` (Vd = weightKg·r).
 *     Requires the subject's `age`, `heightCm`, and `sex`. Reproduces Redose's
 *     legacy `widmarkFactor()` exactly (see scaling.ts).
 */
export type VdScaling = 'total-weight' | 'lean-body-mass' | 'widmark';

export type ValidationStatus =
  | 'toy'
  | 'literature-derived'
  | 'validated'
  | 'experimental';

/**
 * A model parameter that is either a fixed (deterministic) value or a
 * distribution used only when an uncertainty run is requested. The deterministic
 * / median path always uses `centralValue()` (see simulate.ts), so a `fixed`
 * spec and the central tendency of a distribution give the same median curve.
 */
export type ParamSpec =
  | { kind: 'fixed'; value: number }
  | { kind: 'uniform'; min: number; max: number; bounds?: BoundMeaning }
  | { kind: 'triangular'; min: number; mode: number; max: number; bounds?: BoundMeaning }
  | { kind: 'lognormal'; mu: number; sigma: number; median: number };

export type BoundMeaning =
  | { kind: 'extrema' }
  | { kind: 'quantiles'; lowerProbability: number; upperProbability: number }
  | { kind: 'confidence-limits'; level: number };

export interface CovarianceModel {
  parameterIds: string[];
  standardDeviations: number[];
  covariance?: number[][];
  scale: 'normal' | 'log';
}
export type CovarianceState = 'provided' | 'assumed-diagonal';
export interface ScenarioUncertaintyLayers {
  dose?: ParamSpec;
  purityOrActiveMoietyConversion?: ParamSpec;
  administrationTime?: ParamSpec;
  administrationWindow?: ParamSpec;
  infusionDuration?: ParamSpec;
  adherence?: ParamSpec;
}

/**
 * A named structural PK parameter, identity-agnostic to whether the value is an
 * absolute physiological quantity or an apparent (÷F) one — that distinction is
 * carried by its `IdentifiabilityBasis`, not by the id. (S1, plan §5.3.)
 *
 *   CL   — clearance (L/h)              Vmax — max elimination rate (mg/L/h)
 *   Vc   — central volume (L)           Km   — Michaelis constant (mg/L)
 *   Vp   — peripheral volume (L)        ka   — first-order absorption (1/h)
 *   Q    — inter-compartmental CL (L/h) F    — bioavailability (0-1)
 */
export type StructuralParameterId =
  | 'CL'
  | 'Vc'
  | 'Vp'
  | 'Q'
  | 'ka'
  | 'F'
  | 'Vmax'
  | 'Km';

/**
 * Why a structural parameter can (or cannot) be read as an ABSOLUTE physiological
 * value. This is the core of the plan's true-vs-apparent identifiability rule
 * (§4.1): a model fitted only to extravascular data identifies `CL/F` and `V/F`,
 * NOT `CL` and `V`, because absolute clearance/volume cannot be separated from
 * bioavailability without an IV reference or an independently supported `F`.
 *
 *   - `iv-anchored`            — an IV reference in the source identifies the
 *                               absolute value directly.
 *   - `absolute-f-supported`  — `F` is independently supported, so the apparent
 *                               value can be de-apparented to an absolute one.
 *   - `apparent-extravascular`— extravascular-only fit; ONLY the apparent value
 *                               (`CL/F`, `V/F`, `Q/F`) is identified. Never
 *                               surfaced as absolute. This is the COMMON case for
 *                               Kinetix's extravascular catalogue, not an edge case.
 *   - `derived`               — computed from other structural parameters
 *                               (e.g. `ke`, terminal `t½`, α/β macroconstants).
 */
export type IdentifiabilityBasis =
  | 'iv-anchored'
  | 'absolute-f-supported'
  | 'apparent-extravascular'
  | 'derived';

/**
 * An authored structural parameter: its identity, its identifiability basis, and
 * the distribution/fixed value it takes. The basis and id together determine the
 * DISPLAY identity (`CL` vs `CL/F`) — see `structural.ts`. The `spec`'s value is
 * in the parameter's canonical unit and, for an `apparent-extravascular` basis,
 * is the APPARENT value (`CL/F`, `V/F`), not the absolute one.
 */
export interface StructuralParameterSpec<
  Id extends StructuralParameterId = StructuralParameterId,
> {
  id: Id;
  basis: IdentifiabilityBasis;
  spec: ParamSpec;
  /** Canonical unit, for reporting only (e.g. `'L/h'` for CL, `'L'` for Vc). */
  unit?: string;
}

/** A structural parameter after a value has been drawn/resolved for one run. */
export interface ResolvedStructuralParameter {
  id: StructuralParameterId;
  basis: IdentifiabilityBasis;
  /**
   * The resolved value in the canonical unit. For an `apparent-extravascular`
   * basis this is the APPARENT value (`CL/F`, `V/F`) — `exposableAsAbsolute` is
   * then false and a consumer must NOT report it as an absolute quantity.
   */
  value: number;
  /** Display identity given the basis, e.g. `'CL'` or `'CL/F'`. */
  identity: string;
  /** Whether `value` may be reported as an ABSOLUTE physiological quantity. */
  exposableAsAbsolute: boolean;
}

/** A structural parameter a covariate function may scale (SC-2A). */
export type CovariateTargetParameter = 'CL' | 'Vc' | 'ka';

/** Continuous (numeric) subject covariates a covariate function can read. */
export type ContinuousCovariateId = 'weightKg' | 'heightCm' | 'age';

/** Categorical subject covariates a covariate function can read. */
export type CategoricalCovariateId = 'sex' | 'liverImpairment' | 'kidneyImpairment';

/**
 * A portable, declarative covariate function: a model-declared relationship that
 * scales ONE structural parameter (CL/Vc/ka) by a subject covariate (SC-2A, plan
 * §4.2/§5.4). It is DATA the core evaluates, not an application callback, so it
 * stays portable and auditable. A covariate changes a parameter ONLY where a
 * reviewed model declares it — the core applies no universal disease/size
 * multipliers (§4.2: "no generic patient-adjustment folklore"). Several functions
 * may target the same parameter; their factors multiply.
 *
 * `F` is deliberately NOT a target here: route/formulation-specific bioavailability
 * covariates belong to the richer administration layer (S4), and for the common
 * `apparent-extravascular` clv model `F` is not even separately identified.
 */
export type CovariateFunction =
  | {
      /**
       * Allometric power: `factor = (value / reference) ** exponent`. The standard
       * body-size relationship (e.g. weight on CL with exponent 0.75, on V with 1).
       */
      kind: 'allometric';
      covariate: ContinuousCovariateId;
      target: CovariateTargetParameter;
      exponent: number;
      /** Covariate value at which the factor is 1 (the model's reference subject). */
      reference: number;
    }
  | {
      /** Linear: `factor = 1 + slope * (value - reference)`. */
      kind: 'linear';
      covariate: ContinuousCovariateId;
      target: CovariateTargetParameter;
      slope: number;
      reference: number;
    }
  | {
      /**
       * Categorical multiplier: `factor = multipliers[category] ?? 1`. A category the
       * model does not list has NO effect (factor 1) rather than a hidden default; an
       * ABSENT covariate value is a missing required input, not a category.
       */
      kind: 'categorical';
      covariate: CategoricalCovariateId;
      target: CovariateTargetParameter;
      multipliers: Partial<Record<string, number>>;
    };

/** One covariate function's resolved effect on a parameter, for run reporting. */
export interface AppliedCovariate {
  covariate: ContinuousCovariateId | CategoricalCovariateId;
  target: CovariateTargetParameter;
  /** The multiplicative factor applied (1 = no material change). */
  factor: number;
}

/** Route-specific parameters for the one-compartment-first-order family. */
export interface OneCompartmentRouteParams {
  family: 'one-compartment-first-order';
  /** First-order absorption rate constant, per hour. */
  kaPerHour: ParamSpec;
  /** Terminal elimination half-life, hours. */
  eliminationHalfLifeHours: ParamSpec;
  /** Volume of distribution, L/kg (scaled to the subject per `vdScaling`). */
  vdLitersPerKg: ParamSpec;
  /** Bioavailability by this route, 0-1. */
  bioavailability: ParamSpec;
  /**
   * How `vdLitersPerKg` scales to the subject. Defaults to `total-weight` when
   * omitted, so existing models are unchanged. `lean-body-mass` requires the
   * subject's height and sex.
   */
  vdScaling?: VdScaling;
  /**
   * Absorption lag time `tlag`, hours (SC-4A). Absorption begins `tlag` hours after
   * the dose: `C(t) = 0` for `t < tlag`, then the ordinary first-order profile in
   * `t - tlag`. Omitted / non-positive is no lag (existing models unchanged). Must be
   * finite and `>= 0`.
   */
  absorptionLagHours?: ParamSpec;
}

/**
 * One-compartment first-order absorption parameterised by CLEARANCE and VOLUME
 * rather than a terminal half-life (SC-1A, plan §4.1/§5.3). This is the structural
 * parameterisation the plan prefers for reviewed population models: elimination is
 * `ke = CL / Vc` and the terminal half-life is DERIVED (`ln2/ke`), not an
 * independent primitive.
 *
 * `clearance` and `volume` are `StructuralParameterSpec`s, so each carries an
 * `identifiabilityBasis`. The two must share the SAME identifiability class:
 *   - `apparent-extravascular` (both) — the values are `CL/F` and `Vc/F`. `F` is
 *     NOT separately identified and is folded into the apparent volume, so
 *     `bioavailability` MUST be omitted and the curve amplitude is `Dose / (Vc/F)`.
 *     This is the expected case for Kinetix's extravascular catalogue.
 *   - absolute (`iv-anchored` / `absolute-f-supported`, both) — the values are
 *     absolute `CL` and `Vc`, so the extravascular fraction absorbed is a real
 *     unknown: `bioavailability` (`F`) is REQUIRED and the amplitude is `F·Dose/Vc`.
 *
 * In every case `ke = CL/Vc` is identifiable — `(CL/F)/(Vc/F) = CL/Vc` — so the
 * elimination rate and derived half-life are well-defined regardless of basis.
 * Base `clearance`/`volume` values are for the model's reference subject; a model
 * individualises them by declaring `covariateFunctions` (SC-2A) rather than through
 * the weight-proportional `vdScaling` the other families use.
 */
export interface OneCompartmentClvRouteParams {
  family: 'one-compartment-clv';
  /** First-order absorption rate constant, per hour. */
  kaPerHour: ParamSpec;
  /**
   * Clearance (`CL` or `CL/F`), L/h. The `id` is pinned to `'CL'` so a mislabelled
   * parameter can't masquerade as clearance; the absolute-vs-apparent identity is
   * set by `clearance.basis`.
   */
  clearance: StructuralParameterSpec<'CL'>;
  /** Central volume (`Vc` or `Vc/F`), L. The `id` is pinned to `'Vc'`. */
  volume: StructuralParameterSpec<'Vc'>;
  /**
   * Bioavailability `F` (0-1). REQUIRED for an absolute disposition basis and
   * FORBIDDEN for `apparent-extravascular` (where `F` is folded into `Vc/F`).
   */
  bioavailability?: ParamSpec;
  /**
   * Model-declared covariate functions (SC-2A) that individualise `CL`/`Vc`/`ka` to
   * the subject. Omitted/empty means the curve is the reference-subject prediction
   * (the `clv-reference-subject` limitation is then emitted). A function whose
   * REQUIRED covariate the subject does not provide makes the run an explicit
   * insufficient-input failure, never a silent reference default (§4.2). When a
   * function targets `CL` or `Vc` the disposition is individualised, so the
   * reference-subject limitation is not emitted.
   */
  covariateFunctions?: CovariateFunction[];
  /**
   * Absorption lag time `tlag`, hours (SC-4A). Absorption begins `tlag` hours after
   * the dose: `C(t) = 0` for `t < tlag`, then the ordinary first-order profile in
   * `t - tlag`. Omitted / non-positive is no lag. Must be finite and `>= 0`.
   */
  absorptionLagHours?: ParamSpec;
}

/**
 * IV bolus or constant-rate infusion into a one-compartment space. There is no
 * absorption phase and bioavailability is 1 by definition, so neither is a
 * parameter. A positive `infusionDurationHours` models a constant-rate infusion;
 * omitted / non-positive is an instantaneous bolus (C(0) = dose/Vd).
 */
export interface IvOneCompartmentRouteParams {
  family: 'iv-one-compartment';
  /** Terminal elimination half-life, hours. */
  eliminationHalfLifeHours: ParamSpec;
  /** Volume of distribution, L/kg (scaled to the subject per `vdScaling`). */
  vdLitersPerKg: ParamSpec;
  /** Optional constant-rate infusion duration, hours. Omit for a bolus. */
  infusionDurationHours?: number;
  /** How `vdLitersPerKg` scales to the subject. Defaults to `total-weight`. */
  vdScaling?: VdScaling;
}

/**
 * One-compartment linear disposition fed by ZERO-ORDER (constant-rate) EXTRAVASCULAR
 * input over a finite duration (SC-4A) — a sustained-/controlled-release oral product,
 * a transdermal patch, or a depot approximated as constant-rate release, where the
 * input is NOT the exponential first-order `ka` shape. Unlike the IV infusion family
 * this carries a real bioavailability `F` (< 1 is normal for an extravascular route)
 * and an optional absorption lag. The concentration is the constant-rate-input solution
 * `C(t) = (F·Dose/(D·Vd·ke))·(1−e^(−ke·t))` while input continues (`t ≤ D`) and decays
 * mono-exponentially afterwards — the same closed form as a constant-rate infusion of
 * the absorbed amount `F·Dose` over `D`, so the peak sits at the end of input (`t = D`,
 * shifted by any lag). A pure first-order product keeps using
 * `one-compartment-first-order`; this family is for genuinely rate-controlled input.
 */
export interface OneCompartmentZeroOrderRouteParams {
  family: 'one-compartment-zero-order';
  /** Duration of the constant-rate (zero-order) input, hours (> 0). */
  zeroOrderDurationHours: ParamSpec;
  /** Terminal elimination half-life, hours (`ke` is derived from it). */
  eliminationHalfLifeHours: ParamSpec;
  /** Central volume of distribution, L/kg (scaled to the subject per `vdScaling`). */
  vdLitersPerKg: ParamSpec;
  /** Bioavailability of the absorbed dose by this route, 0–1. */
  bioavailability: ParamSpec;
  /**
   * Optional lag before zero-order input begins, hours (SC-4A). `C(t)=0` for `t<tlag`,
   * then the constant-rate profile in `t−tlag`. Drawn only when declared, so an
   * unlagged model keeps the identical PRNG stream.
   */
  absorptionLagHours?: ParamSpec;
  /** How `vdLitersPerKg` scales to the subject. Defaults to `total-weight`. */
  vdScaling?: VdScaling;
}

/**
 * One-compartment linear disposition fed by PARALLEL (mixed) input (SC-4A): a fraction
 * `firstOrderFraction` of the absorbed dose enters by first-order absorption (`ka`), and
 * the remaining `1 − firstOrderFraction` enters by zero-order (constant-rate) input over
 * `zeroOrderDurationHours`. Both pathways share one bioavailability `F`, one disposition
 * (`Vd`, `ke`), and one optional absorption lag; the concentration is the LINEAR
 * SUPERPOSITION of the two single-pathway closed forms — a rapid first-order rise onto a
 * slower rate-controlled component, which neither a pure first-order nor a pure
 * zero-order model reproduces (e.g. a burst-then-sustained formulation, or fast-then-
 * flip-flop absorption). At the extremes it collapses to those families
 * (`firstOrderFraction` 1 → first-order, 0 → zero-order); a genuinely single-pathway
 * product should use the dedicated family.
 */
export interface OneCompartmentMixedOrderRouteParams {
  family: 'one-compartment-mixed-order';
  /** Fraction of the absorbed dose entering via the first-order pathway, 0–1. */
  firstOrderFraction: ParamSpec;
  /** First-order absorption rate constant, per hour (the first-order pathway). */
  kaPerHour: ParamSpec;
  /** Duration of the constant-rate (zero-order) pathway, hours (> 0). */
  zeroOrderDurationHours: ParamSpec;
  /** Terminal elimination half-life, hours (`ke` is derived from it). */
  eliminationHalfLifeHours: ParamSpec;
  /** Central volume of distribution, L/kg (scaled to the subject per `vdScaling`). */
  vdLitersPerKg: ParamSpec;
  /** Bioavailability of the absorbed dose by this route, 0–1 (shared by both pathways). */
  bioavailability: ParamSpec;
  /**
   * Optional lag before BOTH pathways begin, hours (SC-4A). `C(t)=0` for `t<tlag`, then
   * the superposed profile in `t−tlag`. Drawn only when declared, so an unlagged model
   * keeps the identical PRNG stream.
   */
  absorptionLagHours?: ParamSpec;
  /** How `vdLitersPerKg` scales to the subject. Defaults to `total-weight`. */
  vdScaling?: VdScaling;
}

/**
 * Two-compartment model with first-order absorption (THC-style lipophilic
 * disposition). Absorption (`kaPerHour`, `bioavailability`) is route-specific;
 * the disposition (`k12`, `k21`, terminal half-life, central volume) is a drug
 * property shared across a model's routes. `vdLitersPerKg` is the CENTRAL volume
 * V1 (not the large apparent steady-state Vd — tissue loading is captured by
 * k12/k21). The central elimination micro-constant k10 is derived from the
 * terminal half-life so disease/covariate adjustments to elimination flow through.
 */
export interface TwoCompartmentRouteParams {
  family: 'two-compartment-first-order';
  /** First-order absorption rate constant, per hour. */
  kaPerHour: ParamSpec;
  /** Terminal elimination half-life, hours (k10 is derived from it). */
  eliminationHalfLifeHours: ParamSpec;
  /** Central → peripheral micro-rate constant, per hour. */
  k12PerHour: ParamSpec;
  /** Peripheral → central micro-rate constant, per hour. */
  k21PerHour: ParamSpec;
  /** Central volume of distribution V1, L/kg (scaled to the subject). */
  vdLitersPerKg: ParamSpec;
  /** Bioavailability by this route, 0-1. */
  bioavailability: ParamSpec;
  /** How `vdLitersPerKg` scales to the subject. Defaults to `total-weight`. */
  vdScaling?: VdScaling;
}

/**
 * One-compartment first-order absorption with saturable (Michaelis–Menten)
 * elimination — the ethanol / GHB family. Absorption is ordinary first-order; the
 * elimination rate is `Vmax·C / (Km + C)` rather than a fixed `ke·C`, so at high
 * concentration (C ≫ Km) clearance saturates toward zero-order (a fixed
 * mass/time), producing the disproportionate concentration rise these drugs show.
 *
 * `vmaxMgPerLPerHour` and `kmMgPerL` are in CANONICAL units (mg/L per hour, mg/L),
 * unlike the legacy Redose engine which carried g/dL (ethanol) or ng/mL (GHB). The
 * conversion is done once at registry-authoring time, not at run time.
 *
 * `eliminationHalfLifeHours` does NOT drive elimination here (Vmax/Km do); it is a
 * nominal terminal half-life used only for the display/horizon conventions and is
 * reported in the summary for continuity with the other families.
 */
export interface MichaelisMentenRouteParams {
  family: 'michaelis-menten';
  /** First-order absorption rate constant, per hour. */
  kaPerHour: ParamSpec;
  /** Maximum elimination rate Vmax, in mg/L per hour (canonical). */
  vmaxMgPerLPerHour: ParamSpec;
  /** Michaelis constant Km (concentration at half-Vmax), in mg/L (canonical). */
  kmMgPerL: ParamSpec;
  /** Nominal terminal half-life, hours (display/horizon only; not elimination). */
  eliminationHalfLifeHours: ParamSpec;
  /** Volume of distribution, L/kg (scaled to the subject per `vdScaling`). */
  vdLitersPerKg: ParamSpec;
  /** Bioavailability by this route, 0-1. */
  bioavailability: ParamSpec;
  /** How `vdLitersPerKg` scales to the subject. Defaults to `total-weight`. */
  vdScaling?: VdScaling;
}

/**
 * Linear one-step parent → metabolite kinetics (SC-3A): a parent absorbed first-order
 * and eliminated, a molar `formationFraction` of which forms a metabolite in its own
 * central volume with its own elimination. The scenario's `analyte` is the PARENT; the
 * metabolite is emitted as an additional analyte (`AnalyteCurve`) labelled
 * `metaboliteAnalyte`. The disposition/formation is a drug property shared across a
 * model's routes; absorption (`kaPerHour`, `bioavailability`) is route-specific.
 * Half-lives parameterise elimination for consistency with the other families; molar
 * masses carry the molar↔mass stoichiometry of formation. See
 * `models/parent-metabolite.ts` for the ODE and its validation.
 */
export interface ParentMetaboliteRouteParams {
  family: 'parent-metabolite-first-order';
  /** First-order absorption rate constant, per hour. */
  kaPerHour: ParamSpec;
  /** Bioavailability of the parent by this route, 0-1. */
  bioavailability: ParamSpec;
  /** Parent terminal elimination half-life, hours (`keParent` is derived from it). */
  parentEliminationHalfLifeHours: ParamSpec;
  /** Parent central volume of distribution, L/kg (scaled to the subject per `vdScaling`). */
  parentVdLitersPerKg: ParamSpec;
  /** Molar fraction of parent elimination that forms the metabolite (0-1). */
  formationFraction: ParamSpec;
  /** Parent molar mass, g/mol (fixed; drives molar↔mass formation stoichiometry). */
  parentMolarMass: number;
  /** Metabolite molar mass, g/mol (fixed). */
  metaboliteMolarMass: number;
  /** Metabolite terminal elimination half-life, hours. */
  metaboliteEliminationHalfLifeHours: ParamSpec;
  /** Metabolite central volume of distribution, L/kg (scaled to the subject). */
  metaboliteVdLitersPerKg: ParamSpec;
  /** The metabolite's analyte id, for the emitted additional-analyte curve. */
  metaboliteAnalyte: string;
  /** How both volumes scale to the subject. Defaults to `total-weight`. */
  vdScaling?: VdScaling;
}

export type RouteModelParams =
  | OneCompartmentRouteParams
  | OneCompartmentClvRouteParams
  | IvOneCompartmentRouteParams
  | OneCompartmentZeroOrderRouteParams
  | OneCompartmentMixedOrderRouteParams
  | TwoCompartmentRouteParams
  | MichaelisMentenRouteParams
  | ParentMetaboliteRouteParams;

/** A reviewed model for one analyte: its routes, matrix, covariates, provenance. */
export interface DrugModelDefinition {
  analyte: string;
  /**
   * Alternate analyte ids that resolve to this same model (e.g. a prodrug modelled
   * as its active moiety: `psilocybin` also resolvable as `psilocin`). Lets a
   * consumer keyed on a catalog/analytical-method identity find the curve. Must not
   * collide with another model's `analyte` or alias.
   */
  aliases?: string[];
  displayName: string;
  modelId: string;
  matrix: Matrix;
  validationStatus: ValidationStatus;
  routes: Partial<Record<RouteId, RouteModelParams>>;
  /** Covariates the model actually uses. The core applies no others. */
  supportedCovariates: CovariateId[];
  /**
   * Dose bases the model can consume without an unimplemented conversion. A dose
   * whose basis is not listed is rejected as an unsupported scenario rather than
   * silently mis-scaled (e.g. a salt or free-base mass fed as if it were the
   * active moiety). Typically `['active-moiety', 'parent']`.
   */
  supportedBases: DoseBasis[];
  /**
   * Reviewed latent→observed matrix conversions this model supports (SC-5A). Each
   * declares a `from` (must be the model's native `matrix`) and a `to` observed matrix
   * with a multiplicative `ratio`. A scenario requesting a matrix other than the native
   * one is honoured only when a declared transform covers it; absent or unmatched, the
   * cross-matrix request is refused rather than silently mislabelled.
   */
  matrixTransforms?: MatrixTransform[];
  /**
   * Reviewed observation residual-error layers (SC-5B) that widen the reported bands to
   * reflect measurement error the latent kinetics do not carry. Optional and additive:
   * a model with none reports parameter/variability bands only. Analyte-specific.
   */
  observationError?: ObservationErrorLayer[];
  /** Inter-individual/between-subject variability, separate from fixed effects. */
  iiv?: CovarianceModel;
  references?: string[];
  notes?: string;
}

/** Subject covariates. A model consumes only those it declares supported. */
export interface CanonicalSubject {
  weightKg: number;
  /** Body height in cm. Required only by models using `lean-body-mass` Vd scaling. */
  heightCm?: number;
  age?: number;
  sex?: 'male' | 'female' | 'other';
  liverImpairment?: 'none' | 'mild' | 'moderate' | 'severe';
  kidneyImpairment?: 'none' | 'mild' | 'moderate' | 'severe';
}

/** One administration event. Every dose carries its OWN route (no first-route reuse). */
export interface CanonicalDoseEvent {
  /**
   * Dose time in hours on the scenario's absolute time axis (t = 0 is the
   * scenario origin). This is the SAME axis as `timeGrid.startHours/endHours`,
   * so a dose is `gridTime - tHours` hours old at each grid point. The grid does
   * NOT have to start at 0: with `timeGrid.startHours = 8`, a dose at the window
   * start is `tHours: 8`, not `tHours: 0`. (Redose always uses `startHours = 0`
   * with the origin at the earliest dose, so grid start and t=0 coincide there.)
   */
  tHours: number;
  /** Mass of the specified basis, in mg. */
  amountMg: number;
  route: RouteId;
  basis: DoseBasis;
  uncertainty?: ScenarioUncertaintyLayers;
}

export interface UncertaintyConfig {
  seed: number;
  draws: number;
}

export interface CanonicalScenario {
  schemaVersion: string;
  analyte: string;
  /** Optional matrix override; defaults to the model's declared matrix. */
  matrix?: Matrix;
  subject: CanonicalSubject;
  doses: CanonicalDoseEvent[];
  /**
   * Output sampling grid on the same absolute time axis as each dose's `tHours`.
   * `startHours` need not be 0; it is where sampling begins, not the dose origin.
   */
  timeGrid: { startHours: number; endHours: number; stepHours: number };
  /** Omit for a deterministic (median-only) run. */
  uncertainty?: UncertaintyConfig;
}

export type FailureCode =
  | 'unsupported-scenario'
  | 'invalid-input'
  | 'numerical-failure'
  | 'insufficient-model-data'
  | 'not-robust'
  | 'incompatible-release';

export interface CurvePoint {
  tHours: number;
  median: number;
  p05: number;
  p25: number;
  p75: number;
  p95: number;
}

export interface Limitation {
  code: string;
  text: string;
  severity: 'info' | 'warning' | 'critical';
}

/** Provenance for a single run — what produced this curve, reproducibly. */
export interface RunManifest {
  coreVersion: string;
  registryVersion: string;
  registryChecksum: string;
  modelId: string | null;
  analyte: string;
  /**
   * The matrix the reported curve is IN — the observed matrix when a matrix transform
   * was applied (SC-5A), otherwise the model's native matrix. When a transform was
   * applied, `matrixTransform.from` is the model's native (latent) matrix, so the report
   * always states both the latent and the observed matrix.
   */
  matrix: Matrix | null;
  /**
   * The reviewed latent→observed matrix conversion applied to this curve (SC-5A), or
   * absent when the reported matrix is the model's native one (no conversion). Present
   * so a report never treats a converted observed value as a native prediction.
   */
  matrixTransform?: MatrixTransform;
  /**
   * The reviewed observation residual-error layers applied to the reported bands (SC-5B),
   * or absent when the model declares none. Present so a report discloses that (and how)
   * the bands were widened for measurement error beyond parameter/individual variability.
   */
  observationError?: ObservationErrorLayer[];
  uncertaintyLayers?: {
    fixedEffects: 'model-parameter-specifications';
    iiv: { state: CovarianceState; model: CovarianceModel } | null;
    scenarioInputs: Array<{ doseIndex: number; uncertainty: ScenarioUncertaintyLayers }>;
    observationError: ObservationErrorLayer[];
  };
  unit: CanonicalUnit;
  seed: number | null;
  /** Requested Monte-Carlo draws (null for a deterministic run). */
  draws: number | null;
  /** Draws that survived the physicality filter and contributed to the bands. */
  acceptedDraws: number | null;
  scenarioHash: string;
  createdAtIso: string;
  /**
   * Numerical integration settings for ODE-family results (two-compartment,
   * Michaelis–Menten, …). Absent for closed-form families (one-compartment, IV),
   * which need no solver. Lets an audit log or vendored fixture consumer tell
   * which integration policy produced a curve from the result alone (plan §4.4).
   */
  solver?: {
    method: 'rk4';
    /** Effective internal step in hours (the requested step capped by the family's max). */
    stepHours: number;
  };
}

/** Resolved central parameters used for the median curve (per route). */
export interface ResolvedRouteSummary {
  route: RouteId;
  family: ModelFamily;
  /** Absorption rate; null for families without an absorption phase (IV). */
  kaPerHour: number | null;
  eliminationHalfLifeHours: number;
  vdLiters: number;
  /**
   * Bioavailability; null when the family fixes it (IV = 1) OR when `F` is not
   * separately identified (a `one-compartment-clv` route with an
   * `apparent-extravascular` basis, where `F` is folded into the apparent volume).
   */
  bioavailability: number | null;
  /**
   * The constant-rate (zero-order) INPUT duration in hours: for an IV route the
   * infusion duration (0 for an instantaneous bolus), and for the
   * `one-compartment-zero-order` extravascular family the zero-order release duration.
   * A positive value means the input is rate-controlled (peak at the input endpoint),
   * so a bolus, an infusion and a zero-order release are distinguishable in the result
   * alone. Absent for the first-order absorption families.
   */
  infusionDurationHours?: number;
  /**
   * Absorption lag time `tlag` in hours (SC-4A), for a first-order absorption route
   * that declared one. Present and `> 0` means absorption started `tlag` hours after
   * the dose; absent or 0 means no lag. Reported so a lagged profile is
   * distinguishable from the result alone (and so peak refinement can offset by it).
   */
  absorptionLagHours?: number;
  /**
   * Inter-compartmental micro-rate constants (per hour). Present for the
   * two-compartment family only — they define the distribution phase, so two
   * models with the same ka/half-life/Vd/F but different k12/k21 give different
   * curves and must be distinguishable from the result alone.
   */
  k12PerHour?: number;
  k21PerHour?: number;
  /**
   * Saturable-elimination parameters (mg/L per hour, mg/L). Present for the
   * Michaelis–Menten family only — they define the nonlinear clearance, so an
   * MM curve is not reconstructable from ka/half-life/Vd/F alone and these must be
   * distinguishable from the result.
   */
  vmaxMgPerLPerHour?: number;
  kmMgPerL?: number;
  /**
   * Structural (CL/Vc) parameterisation actually used. Present ONLY for the
   * `one-compartment-clv` family (SC-1A). Carries each parameter's resolved value
   * and identifiability (`CL` vs `CL/F`), so a consumer never reports an apparent
   * value as an absolute physiological one, plus the elimination rate `ke = CL/Vc`
   * from which `eliminationHalfLifeHours` above was DERIVED. `vdLiters` above is
   * the volume the curve amplitude scales with (`Vc` absolute, or `Vc/F` apparent).
   */
  structural?: {
    clearance: ResolvedStructuralParameter;
    volume: ResolvedStructuralParameter;
    /** Elimination rate constant `ke = CL/Vc` (1/h) — identifiable in either basis. */
    eliminationRatePerHour: number;
  };
  /**
   * Parent/metabolite resolved parameters (SC-3A `parent-metabolite-first-order`).
   * Present only for that family. The summary's top-level `kaPerHour`,
   * `eliminationHalfLifeHours`, `vdLiters` and `bioavailability` describe the PARENT;
   * this block carries the metabolite disposition and the formation stoichiometry so a
   * consumer can attribute the emitted metabolite curve.
   */
  parentMetabolite?: {
    metaboliteAnalyte: string;
    /** Molar fraction of parent elimination that forms the metabolite. */
    formationFraction: number;
    parentMolarMass: number;
    metaboliteMolarMass: number;
    metaboliteEliminationHalfLifeHours: number;
    metaboliteVdLiters: number;
  };
  /**
   * Fraction of the absorbed dose entering via the FIRST-ORDER pathway (SC-4A). Present
   * only for the `one-compartment-mixed-order` family, whose input is parallel
   * first-order (`kaPerHour`) and zero-order (`infusionDurationHours`); the remaining
   * `1 − firstOrderFraction` enters via the zero-order pathway. Both the ka and the
   * duration are reported above, so the mixed split is fully reconstructable from the
   * result. 1 collapses to pure first-order, 0 to pure zero-order.
   */
  firstOrderFraction?: number;
}

/**
 * One additional measured analyte's full curve, emitted alongside the primary result
 * by a multi-analyte model family (SC-3A parent/metabolite) — one scenario can yield
 * more than one analyte (e.g. a parent and its metabolite). Each carries its OWN
 * analyte id, matrix, unit, time series and peak; the PRIMARY analyte stays in the
 * top-level `analyte`/`matrix`/`timeSeries`/`peak` of `CanonicalResultOk`. The
 * `timeSeries` is on the same time grid and in the same canonical unit as the primary.
 * A single-analyte consumer can ignore `additionalAnalytes` and read the primary curve
 * unchanged — which is why the field is additive/optional.
 */
export interface AnalyteCurve {
  analyte: string;
  matrix: Matrix;
  unit: CanonicalUnit;
  timeSeries: CurvePoint[];
  peak: { concentration: number; tHours: number };
  /**
   * The reviewed latent→observed conversion applied to THIS analyte's curve (SC-5A),
   * or absent when its `matrix` is the model's native one. A partition ratio is
   * analyte-specific, so a metabolite carries its OWN transform here — the primary
   * analyte's is on `RunManifest.matrixTransform` — and a persisted result can disclose
   * and reproduce the exact ratio applied to every curve.
   */
  matrixTransform?: MatrixTransform;
}

export interface CanonicalResultOk {
  ok: true;
  analyte: string;
  matrix: Matrix;
  unit: CanonicalUnit;
  timeSeries: CurvePoint[];
  peak: { concentration: number; tHours: number };
  status: 'ok' | 'not-robust';
  limitations: Limitation[];
  /** Central parameters actually used, for display conventions (never re-derive science). */
  modelSummary: {
    modelId: string;
    validationStatus: ValidationStatus;
    routes: ResolvedRouteSummary[];
  };
  /**
   * Additional measured analytes emitted from the SAME scenario by a multi-analyte
   * family (SC-3A parent/metabolite) — e.g. the metabolite curve alongside the parent
   * primary. Absent for single-analyte models. Additive: a single-analyte consumer
   * ignores it and reads the primary curve unchanged.
   */
  additionalAnalytes?: AnalyteCurve[];
  manifest: RunManifest;
}

export interface CanonicalResultFailure {
  ok: false;
  failure: FailureCode;
  detail: string;
  limitations: Limitation[];
  manifest: RunManifest;
}

export type CanonicalResult = CanonicalResultOk | CanonicalResultFailure;
