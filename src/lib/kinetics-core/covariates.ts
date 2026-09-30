/**
 * Declarative covariate-function evaluation (SC-2A).
 *
 * A `CovariateFunction` is model-declared DATA (plan §4.2/§5.4): it scales one
 * structural parameter (`CL`/`Vc`/`ka`) by a subject covariate. This module turns a
 * model's declared functions plus a subject into the per-parameter multiplicative
 * factors the engine applies — or a structured `missing` result when a function
 * requires a covariate the subject does not provide. The core never invents a
 * covariate effect and never applies a universal disease/size multiplier; a
 * covariate changes a parameter only where a reviewed model declares it.
 *
 * Pure and dependency-free, like the rest of kinetics-core: no I/O, no wall clock,
 * so it is portable and Hermes-safe, and the factors are deterministic (they depend
 * on the subject and the declared constants, never on a random draw) — which is why
 * the engine applies them AFTER the seeded parameter draw without perturbing the
 * parity-locked PRNG stream.
 */
import type {
  AppliedCovariate,
  CanonicalSubject,
  CategoricalCovariateId,
  ContinuousCovariateId,
  CovariateFunction,
  CovariateTargetParameter,
} from './types.js';

/** The subject covariate a function reads (for missing-input reporting). */
export function covariateOf(
  fn: CovariateFunction,
): ContinuousCovariateId | CategoricalCovariateId {
  return fn.covariate;
}

/** True when any declared function individualises the DISPOSITION (`CL` or `Vc`). */
export function individualisesDisposition(fns: readonly CovariateFunction[]): boolean {
  return fns.some((f) => f.target === 'CL' || f.target === 'Vc');
}

/** A numeric covariate value from the subject, or undefined when absent/non-finite. */
function continuousValue(
  subject: CanonicalSubject,
  id: ContinuousCovariateId,
): number | undefined {
  const v = subject[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** A categorical covariate value from the subject, or undefined when absent. */
function categoricalValue(
  subject: CanonicalSubject,
  id: CategoricalCovariateId,
): string | undefined {
  const v = subject[id];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * The multiplicative factor a single function contributes, or `null` when its
 * required covariate is absent. A categorical value that is PRESENT but not listed
 * in the multiplier map contributes factor 1 (an explicit no-effect, not a missing
 * input) — only an absent value is missing.
 */
function factorFor(fn: CovariateFunction, subject: CanonicalSubject): number | null {
  if (fn.kind === 'categorical') {
    const cat = categoricalValue(subject, fn.covariate);
    if (cat === undefined) return null;
    return fn.multipliers[cat] ?? 1;
  }
  const value = continuousValue(subject, fn.covariate);
  if (value === undefined) return null;
  if (fn.kind === 'allometric') {
    return (value / fn.reference) ** fn.exponent;
  }
  // linear
  return 1 + fn.slope * (value - fn.reference);
}

export type CovariateResolution =
  | {
      ok: true;
      /** Per-target product of every applicable factor (targets with no function omitted). */
      factors: Partial<Record<CovariateTargetParameter, number>>;
      /** Per-function applied effects, in declaration order, for run reporting. */
      applied: AppliedCovariate[];
    }
  | {
      ok: false;
      /** Every covariate a declared function requires but the subject does not provide. */
      missing: (ContinuousCovariateId | CategoricalCovariateId)[];
    };

/**
 * Evaluate all declared covariate functions against a subject into per-parameter
 * multiplicative factors plus a per-function applied report. When ANY function's
 * required covariate is absent, returns `{ ok: false, missing }` listing them all
 * (deduplicated, in first-seen order) — an explicit insufficient-input result, never
 * a silent reference default (§4.2). A function's `reference`/`slope`/`exponent` are
 * trusted as authored; only the SUBJECT input is validated here.
 */
export function resolveCovariateFactors(
  fns: readonly CovariateFunction[],
  subject: CanonicalSubject,
): CovariateResolution {
  const missing: (ContinuousCovariateId | CategoricalCovariateId)[] = [];
  const seen = new Set<string>();
  const factors: Partial<Record<CovariateTargetParameter, number>> = {};
  const applied: AppliedCovariate[] = [];

  for (const fn of fns) {
    const factor = factorFor(fn, subject);
    if (factor === null) {
      if (!seen.has(fn.covariate)) {
        seen.add(fn.covariate);
        missing.push(fn.covariate);
      }
      continue;
    }
    factors[fn.target] = (factors[fn.target] ?? 1) * factor;
    applied.push({ covariate: fn.covariate, target: fn.target, factor });
  }

  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, factors, applied };
}
