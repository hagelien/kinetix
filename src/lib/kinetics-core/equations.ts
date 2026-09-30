/**
 * Portable one-compartment PK equation primitives — the scientific kernel.
 *
 * These are the SAME closed forms as `src/lib/pkEquations.ts` (the equations
 * the Kinetix app already uses), lifted into the dependency-free kinetics-core
 * package so Redose can run identical math offline under React Native / Hermes.
 * `src/lib/kinetics-core/__tests__/equations-parity.test.ts` asserts these stay
 * numerically identical to `pkEquations.ts` so the two copies cannot drift.
 *
 * Conventions:
 *   - Time is in HOURS.
 *   - Rate constants (ka, ke) are per HOUR.
 *   - Dose is a mass (mg); Vd is a volume (L); F is dimensionless (0-1).
 *   - Concentration is returned in the same mass/volume basis as dose/Vd, i.e.
 *     mg/L (== µg/mL == 1000 ng/mL). Unit conversion for display is the
 *     consumer's responsibility and happens AFTER the calculation.
 */

/** Elimination rate constant from half-life: k = ln(2) / t_half. */
export function eliminationConstant(halfLife: number): number {
  return Math.LN2 / halfLife;
}

/** Half-life from elimination rate constant: t_half = ln(2) / k. */
export function halfLifeFromK(k: number): number {
  return Math.LN2 / k;
}

/** IV bolus, one-compartment: C(t) = (Dose / Vd) * exp(-k * t). */
export function concentrationFromDoseIV(
  dose: number,
  vd: number,
  k: number,
  t: number,
): number {
  // No t<0 guard here, deliberately: this stays numerically identical to
  // src/lib/pkEquations.ts (the parity-locked kernel), which has none. The
  // forward simulator never calls this with t<0 (curveAt skips negative elapsed),
  // and a dedicated IV bolus model family will own pre-dose handling.
  return (dose / vd) * Math.exp(-k * t);
}

/** Simplified oral dose with instantaneous absorption. */
export function concentrationFromDoseOral(
  dose: number,
  vd: number,
  f: number,
  k: number,
  t: number,
): number {
  return (f * dose / vd) * Math.exp(-k * t);
}

/**
 * One-compartment first-order absorption (Bateman equation):
 *
 *   C(t) = (F·Dose·ka) / (V·(ka − ke)) · (e^{−ke·t} − e^{−ka·t})
 *
 * When ka ≈ ke the standard form is numerically unstable, so the analytic limit
 * is used:
 *
 *   C(t) = (F·Dose / V) · ke · t · e^{−ke·t}
 *
 * Returns 0 for t < 0 (before administration).
 */
export function concentrationOralFirstOrder(
  dose: number,
  vd: number,
  f: number,
  ka: number,
  ke: number,
  t: number,
): number {
  if (t < 0) return 0;
  const base = (f * dose) / vd;
  // Treat ka and ke as equal within a small relative tolerance to avoid the
  // division blowing up near the flip-flop boundary.
  if (Math.abs(ka - ke) < 1e-9 * Math.max(ka, ke)) {
    return base * ke * t * Math.exp(-ke * t);
  }
  return base * (ka / (ka - ke)) * (Math.exp(-ke * t) - Math.exp(-ka * t));
}

/**
 * Constant-rate IV infusion of `dose` (total mass) delivered over `duration`
 * hours, sampled at time `t` (hours from infusion start). A zero or negative
 * duration degenerates to an instantaneous IV bolus. Returns 0 for t < 0.
 */
export function concentrationInfusion(
  dose: number,
  vd: number,
  k: number,
  duration: number,
  t: number,
): number {
  if (t < 0) return 0;
  if (duration <= 0) return concentrationFromDoseIV(dose, vd, k, t);
  const rate = dose / duration;
  const plateauFactor = rate / (vd * k);
  if (t <= duration) {
    return plateauFactor * (1 - Math.exp(-k * t));
  }
  const cEnd = plateauFactor * (1 - Math.exp(-k * duration));
  return cEnd * Math.exp(-k * (t - duration));
}

/**
 * Zero-order elimination (Widmark-style ethanol kinetics):
 *   C(t) = max(0, Dose / Vd − β · t)
 * where β is the elimination rate in concentration units per hour. Distribution
 * is treated as instantaneous. Returns 0 once the linear curve crosses below
 * zero, and 0 for t < 0.
 */
export function concentrationZeroOrder(
  dose: number,
  vd: number,
  beta: number,
  t: number,
): number {
  if (t < 0) return 0;
  return Math.max(0, dose / vd - beta * t);
}

/**
 * Linear superposition of repeated doses. For a linear PK model the total
 * concentration at time `t` is the sum of each dose's single-dose curve shifted
 * to its administration time. Doses still in the future at `t` contribute zero.
 *
 * `singleDose(elapsed, dose)` returns the concentration `elapsed` hours after a
 * single administration of `dose`.
 */
export function superposeDoses(
  doses: ReadonlyArray<{ tHours: number; amountMg: number }>,
  singleDose: (elapsedHours: number, amountMg: number) => number,
  t: number,
): number {
  let sum = 0;
  for (const d of doses) {
    const elapsed = t - d.tHours;
    if (elapsed < 0) continue;
    sum += singleDose(elapsed, d.amountMg);
  }
  return sum;
}
