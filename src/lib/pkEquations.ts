/**
 * Pure one-compartment PK equation functions.
 *
 * Standalone helpers for the Monte Carlo simulation engine.
 *
 * All concentrations are in consistent units (caller's responsibility).
 * Time is in hours. Dose is in mg (or consistent mass unit).
 * Vd is in L (or L/kg if weight-normalized). F is dimensionless (0-1).
 */

/** Elimination rate constant from half-life: k = ln(2) / t_half */
export function eliminationConstant(halfLife: number): number {
  return Math.LN2 / halfLife;
}

/** Half-life from elimination rate constant: t_half = ln(2) / k */
export function halfLifeFromK(k: number): number {
  return Math.LN2 / k;
}

/** Forward concentration (decay): C(t2) = C(t1) * exp(-k * deltaT) */
export function forwardConcentration(c0: number, k: number, deltaT: number): number {
  return c0 * Math.exp(-k * deltaT);
}

/** Backward concentration (earlier from later): C(t1) = C(t2) * exp(k * deltaT) */
export function backwardConcentration(c1: number, k: number, deltaT: number): number {
  return c1 * Math.exp(k * deltaT);
}

/** Concentration from IV-like dose at time t: C(t) = (Dose / Vd) * exp(-k * t) */
export function concentrationFromDoseIV(dose: number, vd: number, k: number, t: number): number {
  return (dose / vd) * Math.exp(-k * t);
}

/** Concentration from oral dose (simplified): C(t) = (F * Dose / Vd) * exp(-k * t) */
export function concentrationFromDoseOral(
  dose: number,
  vd: number,
  f: number,
  k: number,
  t: number
): number {
  return (f * dose / vd) * Math.exp(-k * t);
}

/**
 * Zero-order elimination concentration (Widmark-style ethanol kinetics):
 *   C(t) = max(0, Dose / Vd - β * t)
 * where β is the elimination rate in the same concentration unit as Dose/Vd
 * per hour. Distribution is treated as instantaneous (the forensic Widmark
 * convention used by `src/lib/ethanolEngine/bac.ts`); absorption phase is
 * not modelled because it's negligible relative to the post-peak window
 * KineLab cases live in.
 *
 * Returns 0 once the linear curve crosses below zero — the engine's
 * `logLikelihood` then treats the draw as impossible (the observed
 * concentration is non-zero by construction).
 */
export function concentrationZeroOrder(
  dose: number,
  vd: number,
  beta: number,
  t: number
): number {
  if (t < 0) return 0;
  return Math.max(0, dose / vd - beta * t);
}

/**
 * One-compartment first-order absorption (Bateman equation):
 *
 *   C(t) = (F·Dose·ka) / (V·(ka − ke)) · (e^{−ke·t} − e^{−ka·t})
 *
 * Unlike `concentrationFromDoseOral` (which assumes instantaneous absorption
 * and is only valid post-Tmax), this models the rising absorption phase via an
 * explicit absorption-rate constant `ka`. When `ka` ≈ `ke` the standard form is
 * numerically unstable, so the analytic limit is used:
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
  return (
    base * (ka / (ka - ke)) * (Math.exp(-ke * t) - Math.exp(-ka * t))
  );
}

/**
 * Constant-rate IV infusion of `dose` (total mass) delivered over `duration`
 * hours, sampled at time `t` (hours from infusion start):
 *
 *   during infusion (0 ≤ t ≤ duration):
 *     C(t) = R / (V·k) · (1 − e^{−k·t})
 *   after infusion (t > duration):
 *     C(t) = C(duration) · e^{−k·(t − duration)}
 *
 * where R = dose / duration is the infusion rate. A zero or negative duration
 * degenerates to an instantaneous IV bolus.
 *
 * Returns 0 for t < 0.
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
 * Linear superposition of repeated doses. For a linear PK model, the total
 * concentration at time `t` is the sum of each dose's single-dose curve shifted
 * to its administration time. Doses still in the future at `t` contribute zero.
 *
 * `singleDose(elapsed, dose)` returns the concentration `elapsed` hours after a
 * single administration of `dose`.
 */
export function superposeDoses(
  doses: Array<{ tDose: number; amount: number }>,
  singleDose: (elapsed: number, amount: number) => number,
  t: number,
): number {
  let sum = 0;
  for (const d of doses) {
    const elapsed = t - d.tDose;
    if (elapsed < 0) continue;
    sum += singleDose(elapsed, d.amount);
  }
  return sum;
}

/** Dose from measured concentration (IV): Dose = C(t) * Vd * exp(k * t) */
export function doseFromConcentrationIV(c: number, vd: number, k: number, t: number): number {
  return c * vd * Math.exp(k * t);
}

/** Dose from measured concentration (oral, simplified): Dose = C(t) * Vd * exp(k * t) / F */
export function doseFromConcentrationOral(
  c: number,
  vd: number,
  f: number,
  k: number,
  t: number
): number {
  return (c * vd * Math.exp(k * t)) / f;
}

/**
 * Generate a concentration-time curve for a single parameter set.
 * Returns array of {t, c} points from t=0 to t=tMax.
 */
export function concentrationTimeCurve(
  c0: number,
  k: number,
  tMax: number,
  steps: number
): Array<{ t: number; c: number }> {
  const points: Array<{ t: number; c: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = (tMax / steps) * i;
    points.push({ t, c: c0 * Math.exp(-k * t) });
  }
  return points;
}
