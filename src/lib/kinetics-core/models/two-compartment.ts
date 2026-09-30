/**
 * Two-compartment model with first-order absorption — the THC family.
 *
 * Ported from Redose's `lib/pk/models/two-compartment.ts` into the portable core,
 * in canonical units (HOURS, mg, L). A highly lipophilic drug absorbs into a
 * central compartment, distributes into a peripheral (tissue) compartment via
 * k12/k21, and eliminates from the central compartment via k10. This produces the
 * bi-exponential plasma curve: a fast distribution drop then a long terminal tail.
 *
 * State vector: [A1 (central, mg), A2 (peripheral, mg), gut_0, gut_1, … gut_{n-1}]
 * with ONE gut compartment PER DOSE, so each dose absorbs at its own route's ka
 * (this fixes the legacy first-dose-route reuse for mixed-route sessions). The
 * disposition (k10/k12/k21/V1) is a drug property shared across routes.
 *
 *   dGut_i/dt = −ka_i · Gut_i
 *   dA1/dt    =  Σ ka_i·Gut_i − (k10 + k12)·A1 + k21·A2
 *   dA2/dt    =  k12·A1 − k21·A2
 *   C(t)      =  A1(t) / V1              (mg/L)
 *
 * k10 is derived from the terminal rate β (= ln2 / terminal t½), so any
 * disease/covariate adjustment to the terminal half-life flows through:
 *   k10 = β·(k12 + k21 − β) / (k21 − β).
 */
import { integrate, type DerivativeFn } from '../solver.js';

/** Largest internal integration step (hours) — 1 min. Doses split sub-steps. */
export const MAX_STEP_HOURS = 1 / 60;

/** Concentration below which a two-compartment dose is treated as fully cleared. */
const TWO_COMP_NEGLIGIBLE_MG_PER_L = 1e-9;

/**
 * A provably-safe UPPER BOUND (hours) on how long a two-compartment dose stays
 * non-negligible (central concentration ≥ TWO_COMP_NEGLIGIBLE_MG_PER_L). The
 * terminal central concentration decays no slower than the terminal rate β, and
 * its coefficient is at most the fully-absorbed central concentration g0 =
 * amount·F/V1, so C(t) ≤ g0·e^(−β·t) in the terminal phase. Inverting gives the
 * time to fall below ε, plus ~10 absorption half-lives of tail. This replaces a
 * fixed lookback (unsafe for a very large/typo dose, whose exponential tail can
 * still matter past a fixed cutoff) with a dose-dependent one.
 */
export function twoCompClearanceHorizonHours(
  depositedConcMgPerL: number,
  betaPerHour: number,
  kaPerHour: number,
): number {
  const g0 = depositedConcMgPerL;
  if (!(g0 > TWO_COMP_NEGLIGIBLE_MG_PER_L) || !(betaPerHour > 0)) return 0;
  const absorptionTail = kaPerHour > 0 ? (10 * Math.LN2) / kaPerHour : 0;
  const decay = Math.log(g0 / TWO_COMP_NEGLIGIBLE_MG_PER_L) / betaPerHour;
  return absorptionTail + decay;
}

/**
 * The earliest pre-window dose time that can still matter at the first output
 * `minTime`, for a two-compartment cluster of combined deposited concentration
 * `gTotalMgPerL`. A dose OLDER than this is provably negligible even if it carried
 * the ENTIRE cluster mass (g0·e^(−β·Δt) < ε), so it can be dropped without changing
 * the curve; the combined tail of ALL dropped doses stays < ε (linear superposition,
 * each bounded by the same full-mass horizon). Drops an ancient/typo dose that would
 * otherwise push the integration start back and blow the compute budget.
 */
export function twoCompPreWindowKeepThreshold(
  gTotalMgPerL: number,
  minTime: number,
  betaPerHour: number,
  kaPerHour: number,
): number {
  return minTime - twoCompClearanceHorizonHours(gTotalMgPerL, betaPerHour, kaPerHour);
}

/** Resolved per-route two-compartment parameters (already Vd-scaled to the subject). */
export interface TwoCompartmentResolvedRoute {
  kaPerHour: number;
  /** Terminal elimination rate constant (per hour). */
  betaPerHour: number;
  k12PerHour: number;
  k21PerHour: number;
  /** Central volume V1 in litres (vdLitersPerKg × subject kg). */
  vdLiters: number;
  bioavailability: number;
}

/** A dose with its resolved route params. */
export interface TwoCompartmentDose {
  tHours: number;
  amountMg: number;
  route: TwoCompartmentResolvedRoute;
}

export interface TwoCompartmentCurve {
  ok: boolean;
  /** Concentration (mg/L) at each requested time; empty when ok = false. */
  values: number[];
}

/**
 * Derive the central elimination micro-constant k10 from the terminal rate β and
 * the inter-compartmental rates. Guarded: if peripheral return is not slower than
 * the terminal phase (k21 ≤ β) the two-compartment assumption breaks down, so we
 * fall back to β directly (degenerates toward one-compartment). Matches Redose.
 */
export function deriveK10(beta: number, k12: number, k21: number): number {
  if (!(k21 > beta)) return beta;
  const k10 = (beta * (k12 + k21 - beta)) / (k21 - beta);
  return Number.isFinite(k10) && k10 > 0 ? k10 : beta;
}

/**
 * Keep the pre-window RESOLVED doses that can still matter: aggregate the combined
 * deposited central concentration under the most conservative disposition (slowest
 * absorption and slowest terminal decay → longest horizon) to derive a keep-
 * threshold, then retain doses at/after it and drop the provably-negligible older ones.
 */
function retainPreWindow(
  preWindow: TwoCompartmentDose[],
  minTime: number,
): TwoCompartmentDose[] {
  let gTotal = 0;
  let minKa = Infinity;
  let minBeta = Infinity;
  for (const d of preWindow) {
    const r = d.route;
    gTotal += r.vdLiters > 0 ? (d.amountMg * r.bioavailability) / r.vdLiters : 0;
    if (r.kaPerHour < minKa) minKa = r.kaPerHour;
    if (r.betaPerHour < minBeta) minBeta = r.betaPerHour;
  }
  const keepThreshold = twoCompPreWindowKeepThreshold(gTotal, minTime, minBeta, minKa);
  return preWindow.filter((d) => d.tHours >= keepThreshold);
}

/**
 * Integrate the two-compartment system over the whole scenario and return the
 * central concentration (mg/L) at each requested time. All `times` and dose
 * `tHours` are on the same absolute hour axis. The shared disposition (k10/k12/
 * k21/V1) is taken from the earliest dose's route; per-dose ka/F drive absorption.
 * Returns `ok = false` (no clamped-zero fallback) on a non-finite state.
 */
export function twoCompartmentCurve(
  doses: TwoCompartmentDose[],
  times: number[],
  stepHours: number,
): TwoCompartmentCurve {
  if (doses.length === 0 || times.length === 0) {
    return { ok: true, values: times.map(() => 0) };
  }

  // A dose administered AFTER the last requested output time cannot affect any
  // returned concentration, so drop it. A dose BEFORE the window is dropped only
  // when provably negligible there — and because the terminal tail is dose-
  // dependent, that decision is made per-CLUSTER on the combined deposited
  // concentration (a very large/typo dose past a fixed cutoff can still have a
  // non-negligible tail). (maxTime/minTime by iteration, not `Math.max(...times)`,
  // which would overflow the arg limit on a large grid.)
  let maxTime = times[0]!;
  let minTime = times[0]!;
  for (const t of times) {
    if (t > maxTime) maxTime = t;
    if (t < minTime) minTime = t;
  }
  const inWindow: TwoCompartmentDose[] = [];
  const preWindow: TwoCompartmentDose[] = [];
  for (const d of doses) {
    if (d.tHours > maxTime + 1e-12) continue;
    (d.tHours >= minTime ? inWindow : preWindow).push(d);
  }
  const keptPre = preWindow.length > 0 ? retainPreWindow(preWindow, minTime) : [];
  const sorted = [...inWindow, ...keptPre].sort((a, b) => a.tHours - b.tHours);
  if (sorted.length === 0) {
    return { ok: true, values: times.map(() => 0) };
  }
  // Shared disposition from the earliest dose's route (a drug property).
  const disp = sorted[0]!.route;
  const k12 = disp.k12PerHour;
  const k21 = disp.k21PerHour;
  const k10 = deriveK10(disp.betaPerHour, k12, k21);
  const vdLiters = disp.vdLiters;
  const kaByDose = sorted.map((d) => d.route.kaPerHour);

  const n = sorted.length;
  const CENTRAL = 0;
  const PERIPH = 1;
  const GUT0 = 2;

  const deriv: DerivativeFn = (_t, s) => {
    const a1 = s[CENTRAL]!;
    const a2 = s[PERIPH]!;
    let absorption = 0;
    const d = new Array<number>(2 + n).fill(0);
    for (let i = 0; i < n; i++) {
      const gut = s[GUT0 + i]!;
      const flux = kaByDose[i]! * gut;
      absorption += flux;
      d[GUT0 + i] = -flux;
    }
    d[CENTRAL] = absorption - (k10 + k12) * a1 + k21 * a2;
    d[PERIPH] = k12 * a1 - k21 * a2;
    return d;
  };

  let state = new Array<number>(2 + n).fill(0);
  const step = Math.min(stepHours > 0 ? stepHours : MAX_STEP_HOURS, MAX_STEP_HOURS);

  // Ordered stop points: every requested time AND every dose time, so a dose is
  // deposited exactly at its instant and every grid point is read off directly.
  const stops = Array.from(new Set([...times, ...sorted.map((d) => d.tHours)])).sort(
    (a, b) => a - b,
  );

  const deposited = new Array<boolean>(n).fill(false);
  const depositDueAt = (tp: number): void => {
    for (let i = 0; i < n; i++) {
      if (!deposited[i] && sorted[i]!.tHours <= tp + 1e-12) {
        // Deposit the bioavailable mass into this dose's own gut compartment.
        state[GUT0 + i] = state[GUT0 + i]! + sorted[i]!.amountMg * sorted[i]!.route.bioavailability;
        deposited[i] = true;
      }
    }
  };

  const concentrationAt = new Map<number, number>();
  // Nothing is in the system before the first retained dose, so every output at or
  // before it is exactly zero. Start the cursor at the FIRST DOSE (not stops[0]):
  // an early baseline output far before the first dose must not make RK4 integrate
  // an empty state across the whole pre-dose gap — those earlier stops are read off
  // as zero, and integration begins only once there is mass in the system.
  let cursor = sorted[0]!.tHours;
  depositDueAt(cursor);
  concentrationAt.set(cursor, state[CENTRAL]! / vdLiters);

  for (const stop of stops) {
    if (stop <= cursor + 1e-12) {
      concentrationAt.set(stop, state[CENTRAL]! / vdLiters);
      continue;
    }
    const outcome = integrate(state, deriv, cursor, stop, step);
    if (!outcome.ok) return { ok: false, values: [] };
    state = outcome.final;
    cursor = stop;
    // Deposit doses timed exactly at this stop AFTER integrating up to it, so a
    // dose absorbs from its own instant forward (gut deposit doesn't change the
    // central concentration read at that same instant).
    depositDueAt(cursor);
    concentrationAt.set(cursor, state[CENTRAL]! / vdLiters);
  }

  return { ok: true, values: times.map((t) => concentrationAt.get(t) ?? 0) };
}
