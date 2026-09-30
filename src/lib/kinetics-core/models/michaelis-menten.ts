/**
 * One-compartment first-order absorption with Michaelis–Menten (saturable)
 * elimination — the ethanol / GHB / MDMA family. (MDMA's CYP2D6 auto-inhibition is
 * the same saturable Vmax·C/(Km+C) clearance, so it reuses this family rather than
 * a separate one — only its Vd scaling differs.)
 *
 * Ported from Redose's `lib/pk/models/michaelis-menten.ts` (`simulateEthanol` /
 * `simulateGHB`) into the portable core, in CANONICAL units (HOURS, mg, L, mg/L)
 * rather than the legacy minutes + g/dL (ethanol) / ng/mL (GHB). The unit
 * conversion is baked into the registry-authored Vmax/Km, so the math here is
 * unit-neutral: everything is mg/L and per-hour.
 *
 * The engine works in CONCENTRATION space (like the legacy models): each dose is
 * deposited into its own gut compartment as a concentration-equivalent
 * (amountMg · F / Vd, in mg/L), absorbs first-order into the central concentration
 * C, and C is eliminated at the saturable rate Vmax·C/(Km+C):
 *
 *   dGut_i/dt = −ka_i · Gut_i
 *   dC/dt     =  Σ ka_i·Gut_i − Vmax·C / (Km + C)          (mg/L per hour)
 *
 * One gut compartment PER DOSE (so a future mixed-route MM model absorbs each dose
 * at its own ka). For the current single-route substances every ka is equal, so
 * the per-dose guts sum to exactly the legacy single shared-gut trajectory — the
 * absorption sub-system is linear, so RK4 on per-dose guts reproduces the pooled
 * gut bit-for-bit. The saturable elimination is a drug property shared across
 * routes; Vmax/Km/Vd are taken from the earliest dose's route.
 *
 * A non-finite state is a STRUCTURED FAILURE (ok = false), never a clamped zero
 * (plan §5.5) — matching the two-compartment port and the shared RK4 solver.
 */
import { integrate, type DerivativeFn } from '../solver.js';
import { MAX_STEP_HOURS } from './two-compartment.js';

/** Concentration below which a Michaelis–Menten dose is treated as fully cleared. */
const MM_NEGLIGIBLE_MG_PER_L = 1e-9;

/**
 * A provably-safe UPPER BOUND (hours) on how long a Michaelis–Menten dose stays
 * non-negligible (central concentration ≥ MM_NEGLIGIBLE_MG_PER_L). Unlike a
 * first-order drug, MM elimination saturates at Vmax, so a dose's clearance time
 * grows with its magnitude — a fixed time lookback (as used for the exponential
 * two-compartment family) could silently drop a large-but-not-yet-cleared overdose
 * and return an all-zero curve, underestimating concentration. This bound lets the
 * engine drop a dose ONLY when it is genuinely negligible at the window start.
 *
 * The bound sums three conservative terms (each an over-estimate):
 *   - ~10 absorption half-lives of tail (absorption delays and lowers the peak,
 *     so treating the whole bioavailable mass as instantly central over-estimates);
 *   - the zero-order phase: the whole deposited concentration cleared no faster
 *     than the Vmax ceiling → g0 / Vmax;
 *   - the first-order tail from Km down to the negligible threshold: (Km/Vmax)·ln(g0/ε).
 */
export function mmClearanceHorizonHours(
  depositedConcMgPerL: number,
  vmaxMgPerLPerHour: number,
  kmMgPerL: number,
  kaPerHour: number,
): number {
  const g0 = depositedConcMgPerL;
  if (!(g0 > MM_NEGLIGIBLE_MG_PER_L) || !(vmaxMgPerLPerHour > 0)) return 0;
  const absorptionTail = kaPerHour > 0 ? (10 * Math.LN2) / kaPerHour : 0;
  const zeroOrderPhase = g0 / vmaxMgPerLPerHour;
  const firstOrderTail =
    kmMgPerL > 0
      ? (kmMgPerL / vmaxMgPerLPerHour) * Math.log(g0 / MM_NEGLIGIBLE_MG_PER_L)
      : 0;
  return absorptionTail + zeroOrderPhase + firstOrderTail;
}

/**
 * The earliest pre-window dose time that can still matter at the first output
 * `minTime`, for a Michaelis–Menten cluster of combined deposited concentration
 * `gTotalMgPerL`. A dose OLDER than this is provably negligible even if it carried
 * the ENTIRE cluster mass (its clearance horizon under the most conservative
 * disposition ends before `minTime`), so it can be dropped without changing the
 * curve — while the combined tail of ALL dropped doses stays < ε (each is bounded
 * by the same full-mass horizon). This keeps recent doses (nonlinear saturation
 * needs them) yet drops an ancient/typo dose that would otherwise push the
 * integration start back and blow the compute budget.
 */
export function mmPreWindowKeepThreshold(
  gTotalMgPerL: number,
  minTime: number,
  vmaxMgPerLPerHour: number,
  kmMgPerL: number,
  kaPerHour: number,
): number {
  return minTime - mmClearanceHorizonHours(gTotalMgPerL, vmaxMgPerLPerHour, kmMgPerL, kaPerHour);
}

/** Resolved per-route Michaelis–Menten parameters (already Vd-scaled to subject). */
export interface MichaelisMentenResolvedRoute {
  kaPerHour: number;
  /** Maximum elimination rate Vmax, mg/L per hour. */
  vmaxMgPerLPerHour: number;
  /** Michaelis constant Km, mg/L. */
  kmMgPerL: number;
  /** Distribution volume in litres (vdLitersPerKg × subject scale). */
  vdLiters: number;
  bioavailability: number;
}

/** A dose with its resolved route params. */
export interface MichaelisMentenDose {
  tHours: number;
  amountMg: number;
  route: MichaelisMentenResolvedRoute;
}

export interface MichaelisMentenCurve {
  ok: boolean;
  /** Concentration (mg/L) at each requested time; empty when ok = false. */
  values: number[];
}

/**
 * Keep the pre-window RESOLVED doses that can still matter: aggregate the combined
 * deposited concentration under the most conservative disposition (slowest
 * absorption/elimination, largest Km → longest horizon) to derive a keep-threshold,
 * then retain doses at/after it and drop the provably-negligible older ones.
 */
function retainPreWindow(
  preWindow: MichaelisMentenDose[],
  minTime: number,
): MichaelisMentenDose[] {
  let gTotal = 0;
  let minKa = Infinity;
  let minVmax = Infinity;
  let maxKm = 0;
  for (const d of preWindow) {
    const r = d.route;
    gTotal += r.vdLiters > 0 ? (d.amountMg * r.bioavailability) / r.vdLiters : 0;
    if (r.kaPerHour < minKa) minKa = r.kaPerHour;
    if (r.vmaxMgPerLPerHour < minVmax) minVmax = r.vmaxMgPerLPerHour;
    if (r.kmMgPerL > maxKm) maxKm = r.kmMgPerL;
  }
  const keepThreshold = mmPreWindowKeepThreshold(gTotal, minTime, minVmax, maxKm, minKa);
  return preWindow.filter((d) => d.tHours >= keepThreshold);
}

/**
 * Integrate the Michaelis–Menten system over the whole scenario and return the
 * central concentration (mg/L) at each requested time. All `times` and dose
 * `tHours` are on the same absolute hour axis. The saturable disposition
 * (Vmax/Km/Vd) is a drug property taken from the earliest dose's route; per-dose
 * ka/F drive absorption. Returns `ok = false` (no clamped-zero fallback) on a
 * non-finite state. Structurally identical to `twoCompartmentCurve`.
 */
export function michaelisMentenCurve(
  doses: MichaelisMentenDose[],
  times: number[],
  stepHours: number,
): MichaelisMentenCurve {
  if (doses.length === 0 || times.length === 0) {
    return { ok: true, values: times.map(() => 0) };
  }

  // Bound the integration span. Drop a dose after the last output time (nothing
  // depends on it). For doses BEFORE the window, "negligible" is dose-dependent
  // because MM clearance saturates at Vmax — and it is NONLINEAR, so several
  // individually-"cleared" doses can collectively stay in the zero-order phase and
  // keep each other present. So the pre-window doses are judged as a CLUSTER by
  // their COMBINED deposited concentration (an upper bound: all mass treated as one
  // dose at the latest pre-window time), never dropped one at a time.
  let maxTime = times[0]!;
  let minTime = times[0]!;
  for (const t of times) {
    if (t > maxTime) maxTime = t;
    if (t < minTime) minTime = t;
  }
  const inWindow: MichaelisMentenDose[] = [];
  const preWindow: MichaelisMentenDose[] = [];
  for (const d of doses) {
    if (d.tHours > maxTime + 1e-12) continue;
    (d.tHours >= minTime ? inWindow : preWindow).push(d);
  }
  const keptPre = preWindow.length > 0 ? retainPreWindow(preWindow, minTime) : [];
  const sorted = [...inWindow, ...keptPre].sort((a, b) => a.tHours - b.tHours);
  if (sorted.length === 0) {
    return { ok: true, values: times.map(() => 0) };
  }

  // Shared saturable disposition from the earliest dose's route (a drug property).
  const disp = sorted[0]!.route;
  const vmax = disp.vmaxMgPerLPerHour;
  const km = disp.kmMgPerL;
  const vdLiters = disp.vdLiters;
  const kaByDose = sorted.map((d) => d.route.kaPerHour);

  const n = sorted.length;
  const CENTRAL = 0;
  const GUT0 = 1;

  const deriv: DerivativeFn = (_t, s) => {
    const c = s[CENTRAL]! > 0 ? s[CENTRAL]! : 0;
    let absorption = 0;
    const d = new Array<number>(1 + n).fill(0);
    for (let i = 0; i < n; i++) {
      const gut = s[GUT0 + i]!;
      const flux = kaByDose[i]! * gut;
      absorption += flux;
      d[GUT0 + i] = -flux;
    }
    const elimination = (vmax * c) / (km + c);
    d[CENTRAL] = absorption - elimination;
    return d;
  };

  let state = new Array<number>(1 + n).fill(0);
  const step = Math.min(stepHours > 0 ? stepHours : MAX_STEP_HOURS, MAX_STEP_HOURS);

  const stops = Array.from(new Set([...times, ...sorted.map((d) => d.tHours)])).sort(
    (a, b) => a - b,
  );

  const deposited = new Array<boolean>(n).fill(false);
  const depositDueAt = (tp: number): void => {
    for (let i = 0; i < n; i++) {
      if (!deposited[i] && sorted[i]!.tHours <= tp + 1e-12) {
        // Deposit the bioavailable mass as a concentration (mg/L) into this dose's
        // own gut compartment: amountMg · F / Vd.
        state[GUT0 + i] =
          state[GUT0 + i]! +
          (sorted[i]!.amountMg * sorted[i]!.route.bioavailability) / vdLiters;
        deposited[i] = true;
      }
    }
  };

  const concentrationAt = new Map<number, number>();
  // Nothing is in the system before the first retained dose, so every output at or
  // before it is exactly zero. Start the cursor at the FIRST DOSE (not stops[0]):
  // an early baseline output far before the first dose must not make RK4 integrate
  // an empty state across the whole pre-dose gap — those earlier stops read as zero.
  let cursor = sorted[0]!.tHours;
  depositDueAt(cursor);
  concentrationAt.set(cursor, state[CENTRAL]!);

  for (const stop of stops) {
    if (stop <= cursor + 1e-12) {
      concentrationAt.set(stop, state[CENTRAL]!);
      continue;
    }
    const outcome = integrate(state, deriv, cursor, stop, step);
    if (!outcome.ok) return { ok: false, values: [] };
    state = outcome.final;
    cursor = stop;
    depositDueAt(cursor);
    concentrationAt.set(cursor, state[CENTRAL]!);
  }

  return { ok: true, values: times.map((t) => concentrationAt.get(t) ?? 0) };
}
