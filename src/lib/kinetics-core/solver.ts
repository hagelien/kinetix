/**
 * Portable 4th-order Runge–Kutta ODE integrator — the numerical core for the
 * nonlinear / multicompartment model families (two-compartment, Michaelis–Menten,
 * nonlinear clearance).
 *
 * This is the SAME RK4 scheme as Redose's `lib/pk/solver.ts`, lifted into the
 * dependency-free kinetics-core so both apps integrate identical ODEs under Node
 * and Hermes. It differs from the Redose original in ONE deliberate,
 * plan-mandated way (plan §5.5): a non-finite state is a STRUCTURED FAILURE, not
 * a value silently clamped to zero. Negative states are still clamped to zero
 * (physically, an amount/concentration cannot be negative), but Infinity/NaN sets
 * `ok = false` so the engine returns a numerical-failure rather than a plausible
 * zero curve.
 *
 * All times are in HOURS (the canonical unit), unlike the Redose original which
 * integrates in minutes.
 */

/** dState/dt = f(t, state). Must return a vector the same length as `state`. */
export type DerivativeFn = (t: number, state: readonly number[]) => number[];

export interface IntegrationOutcome {
  /** False when any state became non-finite; `final` is then not trustworthy. */
  ok: boolean;
  /**
   * The state vector at `tEnd`. Only the final state is returned (not the whole
   * history): callers integrate segment-by-segment and read the endpoint, so
   * retaining every internal sub-step state would allocate millions of arrays
   * that are immediately discarded and could exhaust a browser worker.
   */
  final: number[];
}

function rk4Step(
  f: DerivativeFn,
  t: number,
  state: number[],
  dt: number,
): number[] {
  const k1 = f(t, state);
  const k2 = f(t + dt / 2, state.map((s, i) => s + (dt / 2) * k1[i]!));
  const k3 = f(t + dt / 2, state.map((s, i) => s + (dt / 2) * k2[i]!));
  const k4 = f(t + dt, state.map((s, i) => s + dt * k3[i]!));
  return state.map(
    (s, i) => s + (dt / 6) * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!),
  );
}

/**
 * Integrate `f` from `tStart` to `tEnd` (hours) with step `dt`, returning the
 * state at each visited time. Negative states are clamped to zero; a non-finite
 * state stops integration and sets `ok = false` (never a silent zero).
 */
export function integrate(
  initialState: number[],
  f: DerivativeFn,
  tStart: number,
  tEnd: number,
  dt: number,
): IntegrationOutcome {
  let t = tStart;
  let state = initialState.slice();

  while (t < tEnd - 1e-12) {
    const step = Math.min(dt, tEnd - t);
    if (!(step > 0)) break;
    // If the step is below the floating-point spacing at this (large) t, `t +=
    // step` would not advance and the loop would never terminate. Treat that as a
    // numerical failure rather than hanging or silently returning a partial curve.
    if (t + step === t) return { ok: false, final: state };
    const next = rk4Step(f, t, state, step);
    for (let i = 0; i < next.length; i++) {
      const v = next[i]!;
      if (!Number.isFinite(v)) return { ok: false, final: state };
      next[i] = Math.max(0, v); // physical: amounts/concentrations are non-negative
    }
    state = next;
    t += step;
  }

  return { ok: true, final: state };
}
