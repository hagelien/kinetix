/**
 * Body-composition scaling for the volume of distribution.
 *
 * Reproduces Redose's legacy `lib/pk/scaling.ts` EXACTLY for the two branches the
 * shared one-compartment models use, so a hydrophilic drug migrated onto the core
 * matches the legacy curve to floating point (harmonization parity), and a
 * lipophilic drug keeps the total-weight scaling amphetamine already relies on.
 *
 * The constants (70 kg / 56 kg reference pair, the Boer 1984 LBM coefficients,
 * the 0.95·weight clamp) are copied verbatim from the legacy engine. Changing any
 * of them changes curves and MUST bump the model/parameter-set version.
 *
 * Pure and dependency-free: takes only the canonical subject.
 */
import type { CanonicalSubject, CovariateId, VdScaling } from './types.js';

/** Reference body weight the legacy per-kg Vd values were expressed against. */
export const REFERENCE_WEIGHT_KG = 70;
/** Reference lean body mass (~80% of the 70 kg reference) the legacy formula uses. */
export const REFERENCE_LBM_KG = 56;

/**
 * Lean body mass (kg) via the Boer (1984) formula, matching legacy
 * `leanBodyMass()`: the male coefficients for `sex === 'male'`, the female
 * coefficients for female OR other, clamped to `[1, 0.95·weight]`.
 *
 * Requires `heightCm` and `sex`; callers must validate their presence first
 * (a `lean-body-mass` model rejects a subject missing either).
 */
export function leanBodyMassKg(subject: CanonicalSubject): number {
  const { weightKg } = subject;
  const heightCm = subject.heightCm as number;
  const lbm =
    subject.sex === 'male'
      ? 0.407 * weightKg + 0.267 * heightCm - 19.2
      : 0.252 * weightKg + 0.473 * heightCm - 48.3;
  return Math.max(1, Math.min(lbm, weightKg * 0.95));
}

/**
 * Total body water (litres) via the Watson (1980) formula, matching legacy
 * `totalBodyWater()`: male and female coefficient sets. Requires `age`,
 * `heightCm`, `weightKg`; callers using `widmark` scaling must validate presence.
 */
export function totalBodyWaterL(subject: CanonicalSubject): number {
  const { weightKg } = subject;
  const heightCm = subject.heightCm as number;
  const age = subject.age as number;
  return subject.sex === 'male'
    ? 2.447 - 0.09156 * age + 0.1074 * heightCm + 0.3362 * weightKg
    : -2.097 + 0.1069 * heightCm + 0.2466 * weightKg;
}

/**
 * Widmark r-factor for ethanol Vd, matching legacy `widmarkFactor()`:
 * r = totalBodyWater / (weight · 0.806), clamped to the physiological [0.4, 0.9].
 * A non-positive weight falls back to the 0.68 male average (as in legacy).
 */
export function widmarkFactor(subject: CanonicalSubject): number {
  if (!(subject.weightKg > 0)) return 0.68;
  const r = totalBodyWaterL(subject) / (subject.weightKg * 0.806);
  return Math.max(0.4, Math.min(0.9, r));
}

/**
 * The effective kilogram multiplier applied to a route's `vdLitersPerKg`:
 *   Vd(L) = vdLitersPerKg · vdScaleKg(subject, scaling)
 *
 * - `total-weight`   → `weightKg`               (legacy lipophilic: vd·weight)
 * - `lean-body-mass` → `70 · (LBM / 56)`        (legacy hydrophilic: vd·70·lbm/56)
 * - `widmark`        → `weightKg · r`           (legacy ethanol: vd(=1)·weight·r)
 */
export function vdScaleKg(subject: CanonicalSubject, scaling: VdScaling): number {
  if (scaling === 'lean-body-mass') {
    return REFERENCE_WEIGHT_KG * (leanBodyMassKg(subject) / REFERENCE_LBM_KG);
  }
  if (scaling === 'widmark') {
    return subject.weightKg * widmarkFactor(subject);
  }
  return subject.weightKg;
}

/**
 * The subject covariates a Vd scaling actually CONSUMES — the `CovariateId`s a model using it must
 * declare in `supportedCovariates`, or `simulateScenario` would use them to compute Vd yet emit a
 * contradictory `covariate-not-modelled` limitation for them. `weightKg` is the base every model
 * uses and is never surfaced as a covariate, so `total-weight` requires none. Kept here beside the
 * scaling formulas so the two cannot drift (Boer LBM needs height + sex; Watson TBW/Widmark also
 * needs age).
 */
export function requiredCovariatesForVdScaling(scaling: VdScaling | undefined): CovariateId[] {
  if (scaling === 'lean-body-mass') return ['heightCm', 'sex'];
  if (scaling === 'widmark') return ['age', 'heightCm', 'sex'];
  return [];
}
