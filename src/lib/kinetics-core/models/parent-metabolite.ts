/**
 * Linear one-step parent → metabolite kinetics (SC-3A) — the first mechanistic
 * metabolite family (plan §5.5).
 *
 * A parent drug is absorbed (first-order, per-dose ka/F) into a parent central
 * compartment and eliminated at `keParent`. A molar FRACTION `formationFraction`
 * (`fm`) of that parent elimination forms the metabolite; the rest leaves by other
 * routes. The metabolite occupies its own central volume and is eliminated at
 * `keMetabolite`. BOTH concentration curves are emitted from one scenario — the
 * metabolite is a first-class modelled analyte, not a surrogate single curve with
 * F/ka folded to mimic formation.
 *
 * Molar↔mass stoichiometry: `fm` is a fraction of MOLES (one parent molecule yields
 * `fm` metabolite molecules), so the MASS formation rate carries the molar-mass
 * ratio `mwMetabolite / mwParent`:
 *
 *   dGut_i/dt = −ka_i · Gut_i                         (one gut compartment per dose)
 *   dA_p/dt   =  Σ ka_i·Gut_i − keParent · A_p        (parent central, mg)
 *   dA_m/dt   =  fm·(mwM/mwP)·keParent · A_p − keMetabolite · A_m   (metabolite central, mg)
 *   C_p(t)    =  A_p(t) / Vd_parent        C_m(t) = A_m(t) / Vd_metabolite   (mg/L)
 *
 * The parent→metabolite mass flux `k_form = fm·(mwM/mwP)·keParent` makes the
 * metabolite central amount a Bateman-shaped response to the parent (formation rate
 * `keParent`, elimination rate `keMetabolite`), so for a single IV parent bolus the
 * metabolite curve has the closed form the tests assert.
 *
 * Ships DARK (like the SC-0A forward adapter): this is the reviewed, mass-balance-
 * and analytic-validated science; wiring it into `simulateScenario` + the
 * multi-analyte result contract is a follow-up slice. It therefore carries its OWN
 * resolved-route type rather than joining `RouteModelParams`/`ModelFamily` yet.
 *
 * Portable and Hermes-safe: integrates on the shared RK4 solver in canonical units
 * (HOURS, mg, L, g/mol), a non-finite state is a structured failure (never a clamped
 * zero), and the same absolute-time superposition/pre-window handling as the
 * two-compartment family keeps a large/ancient dose from silently distorting the
 * budget or the curve.
 */
import { integrate, type DerivativeFn } from '../solver.js';

/** Largest internal integration step (hours) — 1 min. Matches the other ODE families. */
export const MAX_STEP_HOURS = 1 / 60;

/** Concentration below which a parent/metabolite dose is treated as fully cleared. */
const PM_NEGLIGIBLE_MG_PER_L = 1e-9;

/**
 * Resolved parent/metabolite parameters. Absorption (`kaPerHour`, `bioavailability`)
 * is route-specific; the disposition, formation and stoichiometry are drug properties
 * shared across a model's routes (taken, like two-compartment, from the earliest
 * dose's route).
 */
export interface ParentMetaboliteResolvedRoute {
  kaPerHour: number;
  bioavailability: number;
  /** Parent elimination rate constant (per hour). */
  keParentPerHour: number;
  /** Parent central volume of distribution (litres). */
  vdParentLiters: number;
  /** Molar fraction of parent elimination that forms the metabolite (0-1). */
  formationFraction: number;
  /** Molar mass of the parent (g/mol). */
  molarMassParent: number;
  /** Molar mass of the metabolite (g/mol). */
  molarMassMetabolite: number;
  /** Metabolite elimination rate constant (per hour). */
  keMetabolitePerHour: number;
  /** Metabolite central volume of distribution (litres). */
  vdMetaboliteLiters: number;
}

/** A dose with its resolved parent/metabolite route params. */
export interface ParentMetaboliteDose {
  tHours: number;
  amountMg: number;
  route: ParentMetaboliteResolvedRoute;
}

export interface ParentMetaboliteCurve {
  ok: boolean;
  /** Parent concentration (mg/L) at each requested time; empty when ok = false. */
  parent: number[];
  /** Metabolite concentration (mg/L) at each requested time; empty when ok = false. */
  metabolite: number[];
}

/** Mass formation-rate coefficient `k_form = fm·(mwM/mwP)·keParent` (per hour). */
export function formationMassCoefficient(route: ParentMetaboliteResolvedRoute): number {
  return (
    route.formationFraction *
    (route.molarMassMetabolite / route.molarMassParent) *
    route.keParentPerHour
  );
}

/**
 * A conservative UPPER BOUND (hours) on how long a parent/metabolite dose stays
 * non-negligible (either central concentration ≥ ε). Being too LONG is harmless (a
 * few extra doses are integrated); being too short drops a still-contributing dose,
 * so every term below is deliberately conservative.
 *
 *   - Terminal rate: the whole three-compartment cascade (gut → parent → metabolite)
 *     decays no faster than its SLOWEST rate — including ABSORPTION. Under flip-flop
 *     kinetics (`ka` < both eliminations) the gut governs the tail, so `slowRate =
 *     min(ka, keParent, keMetabolite)`, not `min(keParent, keMetabolite)`.
 *   - Amplitude, in CONCENTRATION units: the parent peaks at ≤ `g0 = amount·F/Vd_p`
 *     (a concentration). The metabolite central concentration is bounded (quasi-
 *     steady) by `k_form·A_p^max/(keMet·Vd_m)`; relative to `g0` that is
 *     `(k_form/keMet)·(Vd_p/Vd_m)` — the volume ratio matters, because `g0` is a
 *     PARENT concentration but ε is compared to a METABOLITE concentration, so a
 *     small metabolite volume amplifies it.
 *   - Polynomial factor: when two (or three) rates coincide the response carries a
 *     `t·e^{-kt}` / `t²·e^{-kt}` term rather than a fixed-coefficient exponential.
 *     Using HALF the slowest rate as the effective terminal rate dominates any such
 *     degree-≤2 factor for realistic amplitudes (`tⁿ·e^{-s·t} ≤ Cₙ·e^{-(s/2)·t}`),
 *     keeping the bound a true upper bound for equal / near-equal rates.
 */
export function parentMetaboliteClearanceHorizonHours(
  depositedParentConcMgPerL: number,
  keParentPerHour: number,
  keMetabolitePerHour: number,
  formationMassCoeff: number,
  kaPerHour: number,
  vdParentLiters: number,
  vdMetaboliteLiters: number,
): number {
  const g0 = depositedParentConcMgPerL;
  // Absorption is part of the system decay: a slow ka is the terminal rate (flip-flop).
  const slowRate = Math.min(kaPerHour, keParentPerHour, keMetabolitePerHour);
  // Metabolite CONCENTRATION amplification over the parent's g0: amount ratio
  // (k_form/keMet) × volume ratio (Vd_p/Vd_m).
  const metConcAmplification =
    keMetabolitePerHour > 0 && vdMetaboliteLiters > 0
      ? (formationMassCoeff / keMetabolitePerHour) * (vdParentLiters / vdMetaboliteLiters)
      : 0;
  // Test negligibility on the TALLER of the two curves — the amplified concentration
  // `gAmp`, not `g0`. A parent concentration at/below ε can still form a metabolite
  // that exceeds ε when Vd_p/Vd_m and formation are large, so gating the early exit on
  // `g0` alone would drop such a pre-window dose. (`gAmp ≥ g0`, so this only ever
  // keeps more.)
  const gAmp = g0 * Math.max(1, metConcAmplification);
  if (!(gAmp > PM_NEGLIGIBLE_MG_PER_L) || !(slowRate > 0)) return 0;
  // Terminal envelope: with all three rates equal to `s` the metabolite carries a
  // degree-2 term `(s·t)²/2 · e^{-s·t}` (a triple first-order convolution). Bound it
  // by the half-rate exponential AND the polynomial's peak constant — halving the
  // exponent alone is not enough at a short horizon, because the coefficient still
  // dominates. `(x²/2)·e^{-x} = ((x²/2)·e^{-x/2})·e^{-x/2} ≤ P·e^{-x/2}` where
  // `P = max_x (x²/2)·e^{-x/2} = 8/e² ≈ 1.083`. Inflating `gAmp` by `P` makes
  // `horizon = ln(P·gAmp/ε)/(s/2)` a true bound for the worst (all-equal-rate) case
  // — and a fortiori for the degree-≤1 (two-equal-rate) and distinct-rate cases.
  const POLY_ENVELOPE = 8 / Math.E ** 2;
  const effectiveRate = slowRate / 2;
  const decay = Math.log((POLY_ENVELOPE * gAmp) / PM_NEGLIGIBLE_MG_PER_L) / effectiveRate;
  return Math.max(0, decay);
}

/**
 * The earliest pre-window dose time that can still matter at the first output
 * `minTime` for a parent/metabolite cluster of combined deposited parent
 * concentration `gTotalMgPerL`. A dose OLDER than this is provably negligible even if
 * it carried the entire cluster mass, so it can be dropped without changing the curve.
 */
export function pmPreWindowKeepThreshold(
  gTotalMgPerL: number,
  minTime: number,
  keParentPerHour: number,
  keMetabolitePerHour: number,
  formationMassCoeff: number,
  kaPerHour: number,
  vdParentLiters: number,
  vdMetaboliteLiters: number,
): number {
  return (
    minTime -
    parentMetaboliteClearanceHorizonHours(
      gTotalMgPerL,
      keParentPerHour,
      keMetabolitePerHour,
      formationMassCoeff,
      kaPerHour,
      vdParentLiters,
      vdMetaboliteLiters,
    )
  );
}

/** Keep the pre-window doses that can still matter (see two-compartment retainPreWindow). */
function retainPreWindow(
  preWindow: ParentMetaboliteDose[],
  minTime: number,
): ParentMetaboliteDose[] {
  // Take the MOST CONSERVATIVE (longest-horizon) value of every quantity across the
  // cluster: slowest rates, largest formation coefficient, largest parent volume and
  // smallest metabolite volume (both maximise the metabolite concentration
  // amplification). Then no dose is dropped that any member's disposition could keep.
  let gTotal = 0;
  let minKa = Infinity;
  let minKeParent = Infinity;
  let minKeMet = Infinity;
  let maxFormCoeff = 0;
  let maxVdParent = 0;
  let minVdMet = Infinity;
  for (const d of preWindow) {
    const r = d.route;
    gTotal += r.vdParentLiters > 0 ? (d.amountMg * r.bioavailability) / r.vdParentLiters : 0;
    if (r.kaPerHour < minKa) minKa = r.kaPerHour;
    if (r.keParentPerHour < minKeParent) minKeParent = r.keParentPerHour;
    if (r.keMetabolitePerHour < minKeMet) minKeMet = r.keMetabolitePerHour;
    const fc = formationMassCoefficient(r);
    if (fc > maxFormCoeff) maxFormCoeff = fc;
    if (r.vdParentLiters > maxVdParent) maxVdParent = r.vdParentLiters;
    if (r.vdMetaboliteLiters < minVdMet) minVdMet = r.vdMetaboliteLiters;
  }
  const keepThreshold = pmPreWindowKeepThreshold(
    gTotal,
    minTime,
    minKeParent,
    minKeMet,
    maxFormCoeff,
    minKa,
    maxVdParent,
    minVdMet,
  );
  return preWindow.filter((d) => d.tHours >= keepThreshold);
}

/**
 * Integrate the parent/metabolite system over the whole scenario and return the
 * parent and metabolite central concentrations (mg/L) at each requested time. Same
 * absolute-time axis, per-dose gut compartments, and pre-window handling as the
 * two-compartment family. Returns `ok = false` (no clamped-zero fallback) on a
 * non-finite state. The shared disposition/formation is taken from the earliest
 * dose's route; per-dose ka/F drive absorption.
 */
export function parentMetaboliteCurve(
  doses: ParentMetaboliteDose[],
  times: number[],
  stepHours: number,
): ParentMetaboliteCurve {
  if (doses.length === 0 || times.length === 0) {
    return { ok: true, parent: times.map(() => 0), metabolite: times.map(() => 0) };
  }

  let maxTime = times[0]!;
  let minTime = times[0]!;
  for (const t of times) {
    if (t > maxTime) maxTime = t;
    if (t < minTime) minTime = t;
  }
  const inWindow: ParentMetaboliteDose[] = [];
  const preWindow: ParentMetaboliteDose[] = [];
  for (const d of doses) {
    if (d.tHours > maxTime + 1e-12) continue;
    (d.tHours >= minTime ? inWindow : preWindow).push(d);
  }
  const keptPre = preWindow.length > 0 ? retainPreWindow(preWindow, minTime) : [];
  const sorted = [...inWindow, ...keptPre].sort((a, b) => a.tHours - b.tHours);
  if (sorted.length === 0) {
    return { ok: true, parent: times.map(() => 0), metabolite: times.map(() => 0) };
  }

  // Shared disposition/formation from the earliest dose's route (a drug property).
  const disp = sorted[0]!.route;
  const keParent = disp.keParentPerHour;
  const keMet = disp.keMetabolitePerHour;
  const kForm = formationMassCoefficient(disp);
  const vdParent = disp.vdParentLiters;
  const vdMet = disp.vdMetaboliteLiters;
  const kaByDose = sorted.map((d) => d.route.kaPerHour);

  const n = sorted.length;
  const PARENT = 0;
  const METAB = 1;
  const GUT0 = 2;

  const deriv: DerivativeFn = (_t, s) => {
    const ap = s[PARENT]!;
    const am = s[METAB]!;
    let absorption = 0;
    const d = new Array<number>(2 + n).fill(0);
    for (let i = 0; i < n; i++) {
      const gut = s[GUT0 + i]!;
      const flux = kaByDose[i]! * gut;
      absorption += flux;
      d[GUT0 + i] = -flux;
    }
    d[PARENT] = absorption - keParent * ap;
    d[METAB] = kForm * ap - keMet * am;
    return d;
  };

  let state = new Array<number>(2 + n).fill(0);
  const step = Math.min(stepHours > 0 ? stepHours : MAX_STEP_HOURS, MAX_STEP_HOURS);

  const stops = Array.from(new Set([...times, ...sorted.map((d) => d.tHours)])).sort(
    (a, b) => a - b,
  );

  const deposited = new Array<boolean>(n).fill(false);
  const depositDueAt = (tp: number): void => {
    for (let i = 0; i < n; i++) {
      if (!deposited[i] && sorted[i]!.tHours <= tp + 1e-12) {
        state[GUT0 + i] =
          state[GUT0 + i]! + sorted[i]!.amountMg * sorted[i]!.route.bioavailability;
        deposited[i] = true;
      }
    }
  };

  const parentAt = new Map<number, number>();
  const metabAt = new Map<number, number>();
  let cursor = sorted[0]!.tHours;
  depositDueAt(cursor);
  parentAt.set(cursor, state[PARENT]! / vdParent);
  metabAt.set(cursor, state[METAB]! / vdMet);

  for (const stop of stops) {
    if (stop <= cursor + 1e-12) {
      parentAt.set(stop, state[PARENT]! / vdParent);
      metabAt.set(stop, state[METAB]! / vdMet);
      continue;
    }
    const outcome = integrate(state, deriv, cursor, stop, step);
    if (!outcome.ok) return { ok: false, parent: [], metabolite: [] };
    state = outcome.final;
    cursor = stop;
    depositDueAt(cursor);
    parentAt.set(cursor, state[PARENT]! / vdParent);
    metabAt.set(cursor, state[METAB]! / vdMet);
  }

  return {
    ok: true,
    parent: times.map((t) => parentAt.get(t) ?? 0),
    metabolite: times.map((t) => metabAt.get(t) ?? 0),
  };
}
