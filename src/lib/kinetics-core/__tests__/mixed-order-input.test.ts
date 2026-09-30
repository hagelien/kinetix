/**
 * SC-4A part 3 — mixed parallel zero/first-order input family.
 *
 * Asserts, through the same `resolveRouteKernel` the engine's linear path uses (no mixed
 * model ships in the registry yet — the family is an administration capability, tested
 * directly like the zero-order and absorption-lag families), that
 * `one-compartment-mixed-order` is the EXACT linear superposition of the two
 * single-pathway closed forms:
 *
 *   C(t) = C_firstOrder(F·fr·Dose over ka) + C_zeroOrder(F·(1−fr)·Dose over D)
 *
 * and that:
 *   - the extremes collapse to the pure families (fr=1 → first-order, fr=0 → zero-order);
 *   - the mixed curve carries BOTH an early first-order rise and a later rate-controlled
 *     shoulder that neither single pathway produces;
 *   - a lag shifts the whole superposed profile (C=0 before tlag);
 *   - the summary reports ka, the zero-order duration, and the split;
 *   - a non-physical route is rejected (fr out of [0,1], ka≤0, D≤0, F out of (0,1], lag<0).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveRouteKernel,
  refineLinearPeak,
  type ResolvedDose,
  type PeakRefineDose,
} from '../simulate';
import {
  concentrationOralFirstOrder,
  concentrationInfusion,
  concentrationFromDoseIV,
  eliminationConstant,
} from '../equations';
import { fixed } from '../param';
import type {
  OneCompartmentMixedOrderRouteParams,
  OneCompartmentZeroOrderRouteParams,
  OneCompartmentRouteParams,
} from '../types';

const base: OneCompartmentMixedOrderRouteParams = {
  family: 'one-compartment-mixed-order',
  firstOrderFraction: fixed(0.4),
  kaPerHour: fixed(1.5),
  zeroOrderDurationHours: fixed(6),
  eliminationHalfLifeHours: fixed(4),
  vdLitersPerKg: fixed(0.5),
  bioavailability: fixed(0.9),
};

const scaleKg = 70;
const GRID = [0, 0.25, 0.5, 1, 2, 3, 6, 6.0001, 9, 12, 24];

describe('SC-4A part 3 — one-compartment-mixed-order (parallel input) family', () => {
  it('is the exact linear superposition of the first-order and zero-order pathways', () => {
    const r = resolveRouteKernel('oral', base, scaleKg, undefined);
    expect(r.valid).toBe(true);
    const vd = 0.5 * scaleKg;
    const ke = eliminationConstant(4);
    const f = 0.9;
    const fr = 0.4;
    const dose = 100;
    for (const t of GRID) {
      const expected =
        concentrationOralFirstOrder(fr * dose, vd, f, 1.5, ke, t) +
        concentrationInfusion(f * (1 - fr) * dose, vd, ke, 6, t);
      expect(r.kernel(t, dose)).toBeCloseTo(expected, 12);
    }
  });

  it('collapses to pure first-order at fraction 1', () => {
    const mixed = resolveRouteKernel('oral', { ...base, firstOrderFraction: fixed(1) }, scaleKg, undefined);
    const firstOrder: OneCompartmentRouteParams = {
      family: 'one-compartment-first-order',
      kaPerHour: fixed(1.5),
      eliminationHalfLifeHours: fixed(4),
      vdLitersPerKg: fixed(0.5),
      bioavailability: fixed(0.9),
    };
    const pure = resolveRouteKernel('oral', firstOrder, scaleKg, undefined);
    for (const t of GRID) {
      expect(mixed.kernel(t, 100)).toBeCloseTo(pure.kernel(t, 100), 12);
    }
  });

  it('collapses to pure zero-order at fraction 0', () => {
    const mixed = resolveRouteKernel('oral', { ...base, firstOrderFraction: fixed(0) }, scaleKg, undefined);
    const zeroOrder: OneCompartmentZeroOrderRouteParams = {
      family: 'one-compartment-zero-order',
      zeroOrderDurationHours: fixed(6),
      eliminationHalfLifeHours: fixed(4),
      vdLitersPerKg: fixed(0.5),
      bioavailability: fixed(0.9),
    };
    const pure = resolveRouteKernel('oral', zeroOrder, scaleKg, undefined);
    for (const t of GRID) {
      expect(mixed.kernel(t, 100)).toBeCloseTo(pure.kernel(t, 100), 12);
    }
  });

  it('at fraction 1, the inactive zero-order term never poisons the curve with NaN', () => {
    // Pathological-but-accepted params: a tiny Vd and a very long half-life make Vd·ke
    // underflow to 0. `concentrationInfusion` on the (zero-mass) zero-order pathway would
    // then form 0/0 = NaN — but at fr=1 the kernel must branch around it and stay finite,
    // matching the pure first-order route with the same parameters.
    const patho: OneCompartmentMixedOrderRouteParams = {
      ...base,
      firstOrderFraction: fixed(1),
      vdLitersPerKg: fixed(1e-202),
      eliminationHalfLifeHours: fixed(1e150),
    };
    const mixed = resolveRouteKernel('oral', patho, scaleKg, undefined);
    expect(mixed.valid).toBe(true);
    const firstOrder: OneCompartmentRouteParams = {
      family: 'one-compartment-first-order',
      kaPerHour: patho.kaPerHour,
      eliminationHalfLifeHours: patho.eliminationHalfLifeHours,
      vdLitersPerKg: patho.vdLitersPerKg,
      bioavailability: patho.bioavailability,
    };
    const pure = resolveRouteKernel('oral', firstOrder, scaleKg, undefined);
    for (const t of [0.5, 1, 2, 6, 12]) {
      const c = mixed.kernel(t, 100);
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBe(pure.kernel(t, 100));
    }
  });

  it('exceeds either single pathway at the same total dose (both contribute)', () => {
    // A dominant first-order fraction: the mixed curve is strictly the sum, so at an
    // early time it is above the zero-order-only curve, and past the first-order peak it
    // is above the first-order-only curve — no single pathway reproduces it.
    const fr = 0.5;
    const r = resolveRouteKernel('oral', { ...base, firstOrderFraction: fixed(fr) }, scaleKg, undefined);
    const vd = 0.5 * scaleKg;
    const ke = eliminationConstant(4);
    const f = 0.9;
    const dose = 100;
    // Early (t=0.5 h): the first-order pathway has risen but the zero-order is still low;
    // the sum exceeds a hypothetical all-zero-order input of the same total dose.
    const zeroAll = concentrationInfusion(f * dose, vd, ke, 6, 0.5);
    expect(r.kernel(0.5, dose)).toBeGreaterThan(zeroAll * 0.5); // sum has real first-order mass
    // The mixed curve is positive across the whole absorption window.
    for (const t of [0.25, 1, 3, 6]) expect(r.kernel(t, dose)).toBeGreaterThan(0);
  });

  it('shifts the whole superposed profile by an absorption lag (C=0 before tlag)', () => {
    const lag = 1.0;
    const lagged = resolveRouteKernel('oral', { ...base, absorptionLagHours: fixed(lag) }, scaleKg, undefined);
    const unlagged = resolveRouteKernel('oral', base, scaleKg, undefined);
    const dose = 100;
    expect(lagged.kernel(0.5, dose)).toBe(0);
    expect(lagged.kernel(0.99, dose)).toBe(0);
    for (const t of [1.0, 2, 4, 7, 10]) {
      expect(lagged.kernel(t, dose)).toBeCloseTo(unlagged.kernel(t - lag, dose), 12);
    }
  });

  it('reports ka, the zero-order duration, and the first-order fraction', () => {
    const r = resolveRouteKernel('oral', base, scaleKg, undefined);
    expect(r.summary.family).toBe('one-compartment-mixed-order');
    expect(r.summary.kaPerHour).toBeCloseTo(1.5, 12);
    expect(r.summary.infusionDurationHours).toBeCloseTo(6, 12);
    expect(r.summary.firstOrderFraction).toBeCloseTo(0.4, 12);
    expect(r.summary.bioavailability).toBeCloseTo(0.9, 12);
    expect(r.summary.vdLiters).toBeCloseTo(0.5 * scaleKg, 12);
  });

  it.each([
    ['fraction > 1', { firstOrderFraction: fixed(1.2) }],
    ['fraction < 0', { firstOrderFraction: fixed(-0.1) }],
    ['ka = 0', { kaPerHour: fixed(0) }],
    ['duration = 0', { zeroOrderDurationHours: fixed(0) }],
    ['bioavailability > 1', { bioavailability: fixed(1.3) }],
    ['negative lag', { absorptionLagHours: fixed(-0.5) }],
  ] as const)('rejects a non-physical route: %s', (_label, patch) => {
    const r = resolveRouteKernel(
      'oral',
      { ...base, ...patch } as OneCompartmentMixedOrderRouteParams,
      scaleKg,
      undefined,
    );
    expect(r.valid).toBe(false);
  });
});

/**
 * Peak refinement must probe BOTH of a mixed dose's pathway peaks. The adversarial case:
 * a mixed dose whose sharp zero-order corner is the GLOBAL Cmax, but on a coarse output
 * grid its grid samples straddle low and the grid argmax sits at a DIFFERENT dose — so
 * the grid-argmax bracket (centred on that other dose) never reaches the corner, and a
 * single-offset refiner that only probed the first-order t_max would materially
 * under-report Cmax. Exercised directly through the exported `refineLinearPeak`.
 */
describe('SC-4A part 3 — mixed peak refinement probes both pathway peaks', () => {
  const vd = 10;
  const ke = eliminationConstant(1); // t½ = 1 h

  // Dose B (t=0): a mixed route at the fr=0 extreme (all zero-order), input duration
  // D=3 h. Its reported ka is FAST (30/h) so a first-order-only refiner would place a
  // NARROW window (~0.5 h) near t=0 that never reaches the zero-order corner at t=3 h.
  const frB = 0;
  const dB = 3;
  const amtB = 100;
  const fB = 1;
  const kaB = 30;
  const kernelB = (elapsed: number, amt: number): number =>
    concentrationOralFirstOrder(frB * amt, vd, fB, kaB, ke, elapsed) +
    concentrationInfusion(fB * (1 - frB) * amt, vd, ke, dB, elapsed);

  // Dose A (t=8): an IV bolus whose peak sits EXACTLY on a grid point (t=8), making it
  // the GRID argmax — but lower than dose B's true corner. Its bracket is [4,12], which
  // does not reach the corner at t=3.
  const amtA = 30;
  const kernelA = (elapsed: number, amt: number): number =>
    concentrationFromDoseIV(amt, vd, ke, elapsed);

  const resolved: ResolvedDose[] = [
    { tHours: 0, amountMg: amtB, kernel: kernelB },
    { tHours: 8, amountMg: amtA, kernel: kernelA },
  ];
  const refineDoses: PeakRefineDose[] = [
    // Dose B reports a non-null ka (mixed) AND the zero-order duration — the exact shape
    // the resolved summary produces at the fr=0 extreme.
    { tHours: 0, amountMg: amtB, ka: kaB, ke, infusionDurationHours: dB, lagHours: 0 },
    // Dose A is an IV bolus (ka null, no infusion).
    { tHours: 8, amountMg: amtA, ka: null, ke, infusionDurationHours: 0, lagHours: 0 },
  ];

  const stepHours = 4; // deliberately coarse

  const curveAt = (t: number): number =>
    resolved.reduce((s, d) => (t >= d.tHours ? s + d.kernel(t - d.tHours, d.amountMg) : s), 0);

  it('recovers the true corner Cmax that a coarse grid + argmax bracket alone miss', () => {
    const start = 0;
    const end = 24;
    // Grid scan (what the engine seeds refinement from).
    let seedC = 0;
    let seedT = start;
    for (let t = start; t <= end + 1e-9; t += stepHours) {
      const c = curveAt(t);
      if (c > seedC) {
        seedC = c;
        seedT = t;
      }
    }
    // Brute-force fine scan for the TRUE global peak (reference).
    let trueC = 0;
    let trueT = start;
    for (let t = start; t <= end; t += 0.001) {
      const c = curveAt(t);
      if (c > trueC) {
        trueC = c;
        trueT = t;
      }
    }
    // Preconditions of the adversarial setup: the true peak is dose B's zero-order corner
    // at t=3 h, materially ABOVE the grid seed (whose argmax is dose A's bolus at t=8 h),
    // and the seed's bracket [4,12] does not reach the corner.
    expect(trueT).toBeGreaterThan(2.9);
    expect(trueT).toBeLessThan(3.05);
    expect(seedT).toBe(8); // grid argmax is dose A's bolus, far from the corner
    expect(seedT - stepHours).toBeGreaterThan(trueT); // corner is OUTSIDE the argmax bracket
    expect(trueC).toBeGreaterThan(seedC * 1.2); // the corner is materially higher

    const refined = refineLinearPeak(resolved, refineDoses, start, end, stepHours, seedC, seedT);
    expect(refined.overflow).toBe(false);
    // The two-candidate refiner recovers the corner to within a hair.
    expect(refined.concentration).toBeCloseTo(trueC, 4);
    expect(refined.tHours).toBeCloseTo(trueT, 2);
    // And it is NOT stuck at the (lower) grid seed a single-offset refiner would return.
    expect(refined.concentration).toBeGreaterThan(seedC * 1.2);
  });

  it('probes the equal-rate (ka===ke) first-order peak at 1/ke, not administration', () => {
    // A mixed dose at ka===ke: `concentrationOralFirstOrder` uses the analytic limit
    // C ∝ ke·t·e^(−ke·t), whose peak is at t = 1/ke. A refiner that dropped the
    // first-order candidate as "degenerate" would place no window there; with a coarse
    // grid and another dose owning the argmax bracket, that peak would be missed.
    const keq = eliminationConstant(1); // ka === ke === ln2
    const frB2 = 0.9; // mostly first-order, so the 1/ke peak is the global Cmax
    const dB2 = 0.1; // tiny zero-order component
    const amtB2 = 100;
    const kernelB2 = (elapsed: number, amt: number): number =>
      concentrationOralFirstOrder(frB2 * amt, vd, 1, keq, keq, elapsed) +
      concentrationInfusion(1 * (1 - frB2) * amt, vd, keq, dB2, elapsed);
    // Dose A: IV bolus at t=8 owning the grid argmax; its bracket [4,12] excludes 1/ke≈1.44.
    const amtA2 = 25;
    const kernelA2 = (elapsed: number, amt: number): number =>
      concentrationFromDoseIV(amt, vd, keq, elapsed);

    const resolved2: ResolvedDose[] = [
      { tHours: 0, amountMg: amtB2, kernel: kernelB2 },
      { tHours: 8, amountMg: amtA2, kernel: kernelA2 },
    ];
    const refineDoses2: PeakRefineDose[] = [
      { tHours: 0, amountMg: amtB2, ka: keq, ke: keq, infusionDurationHours: dB2, lagHours: 0 },
      { tHours: 8, amountMg: amtA2, ka: null, ke: keq, infusionDurationHours: 0, lagHours: 0 },
    ];
    const curveAt2 = (t: number): number =>
      resolved2.reduce((s, d) => (t >= d.tHours ? s + d.kernel(t - d.tHours, d.amountMg) : s), 0);

    const start = 0;
    const end = 24;
    let seedC = 0;
    let seedT = start;
    for (let t = start; t <= end + 1e-9; t += stepHours) {
      const c = curveAt2(t);
      if (c > seedC) { seedC = c; seedT = t; }
    }
    let trueC = 0;
    let trueT = start;
    for (let t = start; t <= end; t += 0.001) {
      const c = curveAt2(t);
      if (c > trueC) { trueC = c; trueT = t; }
    }
    // The true peak lies in the equal-rate first-order region (near 1/ke ≈ 1.44 h — the
    // zero-order tail pulls the combined peak slightly earlier), above the grid seed
    // (dose A's bolus at t=8) whose bracket [4,12] cannot reach it.
    expect(trueT).toBeGreaterThan(1);
    expect(trueT).toBeLessThan(1 / keq + 0.05);
    expect(seedT).toBe(8);
    expect(seedT - stepHours).toBeGreaterThan(trueT);
    expect(trueC).toBeGreaterThan(seedC * 1.1);

    const refined = refineLinearPeak(resolved2, refineDoses2, start, end, stepHours, seedC, seedT);
    expect(refined.overflow).toBe(false);
    // The equal-rate candidate at 1/ke places a fine window over the first-order peak, so
    // the refined Cmax recovers it — well above the grid seed a degenerate-drop would keep.
    expect(refined.concentration).toBeCloseTo(trueC, 3);
    expect(refined.tHours).toBeCloseTo(trueT, 1);
    expect(refined.concentration).toBeGreaterThan(seedC * 1.1);
  });

  it('drops the inactive pathway candidate at a fraction extreme (no wasted slot / spurious peak)', () => {
    // At firstOrderFraction === 1 the zero-order pathway has zero mass, so the curve is
    // pure first-order. The engine gates the PeakRefineDose accordingly (duration → 0);
    // without that, the refiner would still build a SECOND candidate at the (inactive)
    // zero-order endpoint — a spurious cluster that wastes a refinement slot and, at a
    // large absolute origin, can even reject the scenario as unresolvable. This checks
    // the refiner's own reported cluster count reflects the gating.
    const keq = eliminationConstant(2);
    const kaq = 1.5; // first-order t_max ≈ 1.08 h, distinct from the (inactive) endpoint
    const dInactive = 5; // the zero-order endpoint the gating must drop at fr=1
    const amt = 100;
    // The curve is pure first-order (fr=1 → zero-order term is identically 0).
    const kernelFO = (elapsed: number, a: number): number =>
      concentrationOralFirstOrder(a, 10, 1, kaq, keq, elapsed);
    const resolvedFO: ResolvedDose[] = [{ tHours: 0, amountMg: amt, kernel: kernelFO }];

    // What the engine now feeds the refiner at fr=1: the zero-order duration is dropped.
    const gated: PeakRefineDose[] = [
      { tHours: 0, amountMg: amt, ka: kaq, ke: keq, infusionDurationHours: 0, lagHours: 0 },
    ];
    // What an un-gated build would feed it: a second, inactive zero-order candidate.
    const ungated: PeakRefineDose[] = [
      { tHours: 0, amountMg: amt, ka: kaq, ke: keq, infusionDurationHours: dInactive, lagHours: 0 },
    ];

    const rGated = refineLinearPeak(resolvedFO, gated, 0, 24, 0.5, 0, 0);
    const rUngated = refineLinearPeak(resolvedFO, ungated, 0, 24, 0.5, 0, 0);

    // The gated build sees ONE peak cluster; the un-gated build spuriously sees two.
    expect(rGated.totalDoses).toBe(1);
    expect(rUngated.totalDoses).toBe(2);
    // Both still find the SAME (correct) first-order peak — the inactive candidate only
    // wastes work, it does not change the answer here.
    expect(rGated.concentration).toBeCloseTo(rUngated.concentration, 9);
    expect(rGated.concentration).toBeGreaterThan(0);
  });
});
