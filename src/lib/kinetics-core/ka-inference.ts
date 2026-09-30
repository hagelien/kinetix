/**
 * Infer a first-order absorption rate (`ka`) from an observed time-to-peak (`tmax`).
 *
 * CV-2b decided that `ka` "has no catalog source — it stays missing, never manufactured", because
 * recovering it from `tmax` needs `ke` and "an implicit two-root solve". The first half of that is
 * right and this module does not weaken it: an authored, cited `ka` always wins. The second half is
 * what this module revisits, because the two-root worry does not survive contact with the algebra
 * once `ke` is known — and `ke` IS known, from the catalog's elimination half-life.
 *
 * **The solve is unique.** For a one-compartment first-order-input model,
 *
 *     tmax = ln(ka/ke) / (ka − ke)
 *
 * Substituting `r = ka/ke` gives `tmax = h(r)/ke` where `h(r) = ln(r)/(r − 1)`, and `h` is strictly
 * decreasing on `(0, ∞)` — from `+∞` as `r → 0⁺`, through `h(1) = 1` (the removable singularity), to
 * `0` as `r → ∞`. A strictly monotone function has at most one root, so for any positive `tmax`
 * there is EXACTLY ONE positive `ka`. There is no root to choose between and so no convention to
 * adopt.
 *
 * **The real hazard is flip-flop kinetics, and the data reports it.** Since `h` is decreasing
 * through `h(1) = 1`, the solution has `ka > ke` if and only if `ke·tmax < 1`. When `ke·tmax ≥ 1`
 * the unique solution has `ka ≤ ke`: absorption is slower than elimination, the drug is
 * absorption-rate-limited, and the terminal slope observed in vivo is `ka`, not `ke`. A catalog
 * "elimination half-life" measured from that terminal slope is then a half-life of ABSORPTION
 * wearing an elimination label, and feeding it back in as `ke` would compound the error rather than
 * model it.
 *
 * So this module refuses that regime outright (`flip-flop`) instead of returning a number: the
 * inference is trustworthy exactly where `ke·tmax < 1`, and that boundary is a property of the
 * stored values, not a judgement call. Missing stays missing — a refused inference leaves `ka`
 * absent, and the model grades down as incomplete.
 *
 * Pure: no DB, no registry, no engine change, so no `CORE_VERSION` bump. Consumes and returns
 * canonical engine units (hours, per-hour).
 */

/** The natural log of 2 — half-life to rate constant. */
const LN2 = Math.LN2;

/**
 * Where an inference landed. Only `inferred` carries a number; the other two are the honest
 * refusals, distinguished because they mean different things to a curator: `flip-flop` says the
 * stored pair is self-inconsistent under the assumed structure, `not-inferable` says an input was
 * absent or nonsensical.
 */
export type KaInference =
  | {
      status: 'inferred';
      /** The absorption rate constant, per hour. Always `> kePerHour`. */
      kaPerHour: number;
      /** The elimination rate constant the solve used, per hour (from the half-life). */
      kePerHour: number;
    }
  | {
      status: 'flip-flop';
      /** The elimination rate constant implied by the supplied half-life, per hour. */
      kePerHour: number;
      /** The largest `tmax` an absorption-faster-than-elimination model can produce, in hours
       *  (`1/ke`). The supplied `tmax` was at or above this. */
      maxTmaxHours: number;
      reason: string;
    }
  | { status: 'not-inferable'; reason: string };

/**
 * `h(r) = ln(r)/(r − 1)`, the dimensionless time-to-peak as a function of the rate ratio `r = ka/ke`.
 *
 * Strictly decreasing, with a removable singularity at `r = 1` where the limit is `1`. Near `r = 1`
 * the direct form loses precision to cancellation in both `ln(r)` and `r − 1`, so a Maclaurin series
 * in `d = r − 1` (`1 − d/2 + d²/3 − d³/4`) takes over there; the cutoff is far inside the radius of
 * convergence and well past the point where the series beats the cancellation.
 */
function timeToPeakRatio(r: number): number {
  const d = r - 1;
  if (Math.abs(d) < 1e-4) {
    return 1 - d / 2 + (d * d) / 3 - (d * d * d) / 4;
  }
  return Math.log(r) / d;
}

/**
 * Solve `h(r) = target` for `r > 1`, where `0 < target < 1`.
 *
 * `h` is strictly decreasing with `h(1) = 1 > target`, so the root is bracketed by `[1, hi]` for any
 * `hi` with `h(hi) < target`. The upper bound is found by doubling rather than assumed, so an
 * extreme ratio (a very fast absorption against a very slow elimination) is solved rather than
 * clipped. Bisection is used over Newton because `h` is monotone on the bracket — bisection cannot
 * leave it, and the iteration count is fixed and small.
 */
function solveRatioForTarget(target: number): number | null {
  let hi = 2;
  // 1e6 is not a modelling limit but an arithmetic one: beyond it `ln(r)/(r−1)` is denormal-small
  // and the bracket stops being meaningful. A drug needing r > 1e6 is not one this inference should
  // be quietly answering for.
  while (timeToPeakRatio(hi) > target && hi < 1e6) hi *= 2;
  if (timeToPeakRatio(hi) > target) return null;

  let lo = 1;
  // 200 halvings takes a bracket of any representable width below double precision; the loop is
  // bounded rather than convergence-tested so it cannot spin on a pathological input.
  for (let i = 0; i < 200; i += 1) {
    const mid = (lo + hi) / 2;
    if (mid === lo || mid === hi) break;
    if (timeToPeakRatio(mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Infer `ka` (per hour) from an observed `tmax` (hours) and an elimination half-life (hours).
 *
 * Returns `flip-flop` when `ke·tmax ≥ 1` — the regime where the unique solution has `ka ≤ ke` and
 * the supplied half-life is therefore not safely readable as an elimination half-life (see the
 * module comment). Returns `not-inferable` for absent or non-positive inputs. Pure.
 */
export function inferKaFromTmax(
  tmaxHours: number,
  eliminationHalfLifeHours: number,
): KaInference {
  if (!Number.isFinite(tmaxHours) || tmaxHours <= 0) {
    return { status: 'not-inferable', reason: 'tmax is absent or not a positive number of hours' };
  }
  if (!Number.isFinite(eliminationHalfLifeHours) || eliminationHalfLifeHours <= 0) {
    return {
      status: 'not-inferable',
      reason: 'elimination half-life is absent or not a positive number of hours',
    };
  }

  const kePerHour = LN2 / eliminationHalfLifeHours;
  const maxTmaxHours = 1 / kePerHour;
  // The dimensionless target h(r) = ke·tmax. Equality with 1 is the degenerate ka = ke case, which
  // the first-order model cannot express (the closed form divides by ka − ke), so it lands here too.
  const target = kePerHour * tmaxHours;
  if (target >= 1) {
    return {
      status: 'flip-flop',
      kePerHour,
      maxTmaxHours,
      reason:
        `tmax ${tmaxHours} h is at or beyond the ${maxTmaxHours.toFixed(2)} h maximum a model with ` +
        'absorption faster than elimination can produce, so the unique solution has ka ≤ ke: the ' +
        'drug is absorption-rate-limited and the stored half-life cannot be read as elimination',
    };
  }

  const ratio = solveRatioForTarget(target);
  if (ratio === null || !Number.isFinite(ratio)) {
    return { status: 'not-inferable', reason: 'no absorption rate reproduces the supplied tmax' };
  }
  const kaPerHour = ratio * kePerHour;
  if (!Number.isFinite(kaPerHour) || kaPerHour <= 0) {
    return { status: 'not-inferable', reason: 'the solved absorption rate is not a positive number' };
  }
  return { status: 'inferred', kaPerHour, kePerHour };
}
