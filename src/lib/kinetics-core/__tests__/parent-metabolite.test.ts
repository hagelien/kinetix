/**
 * SC-3A parent → metabolite model.
 *
 * Validated against EXACT closed forms, not just self-consistency:
 *   - the parent central concentration is the ordinary one-compartment Bateman
 *     curve (gut → parent), i.e. `concentrationOralFirstOrder`;
 *   - the metabolite central concentration is the triple-exponential convolution
 *     of the parent Bateman with the metabolite's own elimination;
 *   - metabolite exposure (AUC) obeys mass balance and molar↔mass stoichiometry:
 *     `AUC_m = fm·(mwM/mwP)·F·D / (keMet·Vd_m)`.
 */
import { describe, it, expect } from 'vitest';
import {
  parentMetaboliteCurve,
  parentMetaboliteClearanceHorizonHours,
  formationMassCoefficient,
  type ParentMetaboliteResolvedRoute,
} from '../models/parent-metabolite';
import { concentrationOralFirstOrder } from '../equations';

const NEGLIGIBLE = 1e-9;

const route: ParentMetaboliteResolvedRoute = {
  kaPerHour: 1.5,
  bioavailability: 0.8,
  keParentPerHour: 0.3,
  vdParentLiters: 50,
  formationFraction: 0.6,
  molarMassParent: 200,
  molarMassMetabolite: 180,
  keMetabolitePerHour: 0.15,
  vdMetaboliteLiters: 80,
};
const DOSE = 100; // mg

/** Exact metabolite central concentration for a single oral parent dose at t=0. */
function analyticMetabolite(r: ParentMetaboliteResolvedRoute, dose: number, t: number): number {
  const { kaPerHour: ka, keParentPerHour: keP, keMetabolitePerHour: keM } = r;
  const kForm = formationMassCoefficient(r);
  // Parent central AMOUNT Bateman coefficient P: A_p(t) = P·(e^{-keP t} - e^{-ka t}).
  const P = (r.bioavailability * dose * ka) / (ka - keP);
  // A_m(t) = kForm·P·[ (e^{-keP t}-e^{-keM t})/(keM-keP) - (e^{-ka t}-e^{-keM t})/(keM-ka) ]
  const term1 = (Math.exp(-keP * t) - Math.exp(-keM * t)) / (keM - keP);
  const term2 = (Math.exp(-ka * t) - Math.exp(-keM * t)) / (keM - ka);
  const am = kForm * P * (term1 - term2);
  return am / r.vdMetaboliteLiters;
}

const T_SAMPLES = [0, 0.5, 1, 2, 4, 8, 16, 24, 48];

describe('parentMetaboliteCurve — parent matches the one-compartment Bateman', () => {
  it('reproduces concentrationOralFirstOrder for the parent central curve', () => {
    const res = parentMetaboliteCurve(
      [{ tHours: 0, amountMg: DOSE, route }],
      T_SAMPLES,
      1 / 60,
    );
    expect(res.ok).toBe(true);
    for (let i = 0; i < T_SAMPLES.length; i++) {
      const want = concentrationOralFirstOrder(
        DOSE,
        route.vdParentLiters,
        route.bioavailability,
        route.kaPerHour,
        route.keParentPerHour,
        T_SAMPLES[i]!,
      );
      // RK4 vs analytic: small integration error only.
      expect(res.parent[i]!).toBeCloseTo(want, 5);
    }
  });
});

describe('parentMetaboliteCurve — metabolite matches the triple-exponential', () => {
  it('reproduces the exact formation→elimination convolution', () => {
    const res = parentMetaboliteCurve(
      [{ tHours: 0, amountMg: DOSE, route }],
      T_SAMPLES,
      1 / 60,
    );
    for (let i = 0; i < T_SAMPLES.length; i++) {
      expect(res.metabolite[i]!).toBeCloseTo(analyticMetabolite(route, DOSE, T_SAMPLES[i]!), 5);
    }
    // The metabolite peaks LATER than the parent (formation then elimination).
    expect(res.metabolite[0]).toBe(0); // nothing formed at t=0
  });
});

describe('parentMetaboliteCurve — mass balance and stoichiometry', () => {
  // Fine, long grid for an accurate trapezoidal AUC over essentially the whole curve.
  const grid: number[] = [];
  for (let t = 0; t <= 400; t += 0.05) grid.push(Number(t.toFixed(2)));

  function auc(values: number[]): number {
    let a = 0;
    for (let i = 1; i < grid.length; i++) {
      a += ((values[i]! + values[i - 1]!) / 2) * (grid[i]! - grid[i - 1]!);
    }
    return a;
  }

  it('metabolite AUC = fm·(mwM/mwP)·F·D / (keMet·Vd_m)', () => {
    const res = parentMetaboliteCurve([{ tHours: 0, amountMg: DOSE, route }], grid, 1 / 60);
    const expected =
      (route.formationFraction *
        (route.molarMassMetabolite / route.molarMassParent) *
        route.bioavailability *
        DOSE) /
      (route.keMetabolitePerHour * route.vdMetaboliteLiters);
    expect(auc(res.metabolite)).toBeCloseTo(expected, 1); // within ~0.05 absolute
  });

  it('parent AUC = F·D / (keParent·Vd_p)', () => {
    const res = parentMetaboliteCurve([{ tHours: 0, amountMg: DOSE, route }], grid, 1 / 60);
    const expected =
      (route.bioavailability * DOSE) / (route.keParentPerHour * route.vdParentLiters);
    expect(auc(res.parent)).toBeCloseTo(expected, 1);
  });

  it('formationFraction = 0 yields no metabolite', () => {
    const res = parentMetaboliteCurve(
      [{ tHours: 0, amountMg: DOSE, route: { ...route, formationFraction: 0 } }],
      T_SAMPLES,
      1 / 60,
    );
    for (const c of res.metabolite) expect(c).toBe(0);
    // …but the parent curve is unaffected.
    expect(res.parent.some((c) => c > 0)).toBe(true);
  });

  it('molar-mass ratio scales the metabolite mass linearly', () => {
    const base = parentMetaboliteCurve([{ tHours: 0, amountMg: DOSE, route }], T_SAMPLES, 1 / 60);
    const doubledMw = parentMetaboliteCurve(
      [{ tHours: 0, amountMg: DOSE, route: { ...route, molarMassMetabolite: route.molarMassMetabolite * 2 } }],
      T_SAMPLES,
      1 / 60,
    );
    for (let i = 1; i < T_SAMPLES.length; i++) {
      if (base.metabolite[i]! > 1e-9) {
        expect(doubledMw.metabolite[i]! / base.metabolite[i]!).toBeCloseTo(2, 6);
      }
    }
  });
});

describe('parentMetaboliteClearanceHorizonHours — a conservative upper bound', () => {
  // Each pathological case exercises one horizon concern: a slow ka (flip-flop, the
  // gut governs the tail), a tiny metabolite volume (concentration amplification), and
  // equal parent/metabolite rates (a t·e^{-kt} term). For a single unit dose the bound
  // must exceed the time at which BOTH curves have fallen below the negligible
  // threshold — otherwise the pre-window pruning would drop a still-contributing dose.
  const cases: Array<{ name: string; route: ParentMetaboliteResolvedRoute; dose: number }> = [
    {
      name: 'flip-flop (slow absorption governs the tail)',
      route: {
        kaPerHour: 0.01,
        bioavailability: 1,
        keParentPerHour: 0.1,
        vdParentLiters: 100,
        formationFraction: 0.5,
        molarMassParent: 200,
        molarMassMetabolite: 180,
        keMetabolitePerHour: 0.2,
        vdMetaboliteLiters: 100,
      },
      dose: 100,
    },
    {
      name: 'tiny metabolite volume (concentration amplification)',
      route: {
        kaPerHour: 1,
        bioavailability: 1,
        keParentPerHour: 0.5,
        vdParentLiters: 100,
        formationFraction: 0.9,
        molarMassParent: 200,
        molarMassMetabolite: 180,
        keMetabolitePerHour: 0.4,
        vdMetaboliteLiters: 1, // 100× smaller than the parent volume
      },
      dose: 100,
    },
    {
      name: 'equal parent/metabolite rates (t·e^{-kt} term)',
      route: {
        kaPerHour: 1,
        bioavailability: 1,
        keParentPerHour: 0.2,
        vdParentLiters: 100,
        formationFraction: 0.7,
        molarMassParent: 200,
        molarMassMetabolite: 180,
        keMetabolitePerHour: 0.2, // == keParent
        vdMetaboliteLiters: 100,
      },
      dose: 100,
    },
  ];

  for (const { name, route, dose } of cases) {
    it(`bounds both curves below ε — ${name}`, () => {
      const g0 = (dose * route.bioavailability) / route.vdParentLiters;
      const H = parentMetaboliteClearanceHorizonHours(
        g0,
        route.keParentPerHour,
        route.keMetabolitePerHour,
        formationMassCoefficient(route),
        route.kaPerHour,
        route.vdParentLiters,
        route.vdMetaboliteLiters,
      );
      expect(H).toBeGreaterThan(0);
      // Sample the single-dose curve AT the horizon: both curves must be negligible.
      const res = parentMetaboliteCurve(
        [{ tHours: 0, amountMg: dose, route }],
        [H],
        1 / 60,
      );
      expect(res.ok).toBe(true);
      expect(res.parent[0]!).toBeLessThan(NEGLIGIBLE);
      expect(res.metabolite[0]!).toBeLessThan(NEGLIGIBLE);
    });
  }

  it('bounds the degree-2 tail when all three rates coincide at a short horizon', () => {
    // Reviewer's exact counterexample: ka = keParent = keMetabolite = 0.2, unit
    // amplification, gAmp/ε = e² (a ~20 h horizon). The metabolite carries a
    // (s·t)²/2·e^{-s·t} term whose COEFFICIENT — not just the exponent — must be
    // dominated, or the curve is still ~1.08ε at the naive horizon.
    const s = 0.2;
    const route: ParentMetaboliteResolvedRoute = {
      kaPerHour: s,
      bioavailability: 1,
      keParentPerHour: s,
      vdParentLiters: 100,
      formationFraction: 1,
      molarMassParent: 200,
      molarMassMetabolite: 200, // unit molar-mass ratio → unit formation amplification
      keMetabolitePerHour: s,
      vdMetaboliteLiters: 100,
    };
    const g0 = NEGLIGIBLE * Math.E ** 2; // gAmp = g0 (unit amplification)
    const dose = g0 * route.vdParentLiters; // amount·F/Vd_p = g0
    const H = parentMetaboliteClearanceHorizonHours(
      g0,
      route.keParentPerHour,
      route.keMetabolitePerHour,
      formationMassCoefficient(route),
      route.kaPerHour,
      route.vdParentLiters,
      route.vdMetaboliteLiters,
    );
    const res = parentMetaboliteCurve([{ tHours: 0, amountMg: dose, route }], [H], 1 / 60);
    expect(res.parent[0]!).toBeLessThan(NEGLIGIBLE);
    expect(res.metabolite[0]!).toBeLessThan(NEGLIGIBLE);
  });

  it('does not early-exit to a zero horizon when the parent is tiny but amplification is large', () => {
    // g0 below ε, but a large Vd_p/Vd_m and formation make the metabolite exceed ε.
    // The early-exit must gate on the amplified concentration, not g0 alone.
    const r: ParentMetaboliteResolvedRoute = {
      kaPerHour: 1,
      bioavailability: 1,
      keParentPerHour: 0.1,
      vdParentLiters: 1000,
      formationFraction: 0.5,
      molarMassParent: 200,
      molarMassMetabolite: 200,
      keMetabolitePerHour: 0.1,
      vdMetaboliteLiters: 1, // 1000× smaller → strong concentration amplification
    };
    const g0 = 1e-10; // ≤ ε
    const H = parentMetaboliteClearanceHorizonHours(
      g0,
      r.keParentPerHour,
      r.keMetabolitePerHour,
      formationMassCoefficient(r),
      r.kaPerHour,
      r.vdParentLiters,
      r.vdMetaboliteLiters,
    );
    expect(H).toBeGreaterThan(0);
    // A truly negligible amplified concentration still returns 0 (drop is safe).
    const negligible = parentMetaboliteClearanceHorizonHours(
      1e-12,
      r.keParentPerHour,
      r.keMetabolitePerHour,
      formationMassCoefficient({ ...r, formationFraction: 0 }),
      r.kaPerHour,
      r.vdParentLiters,
      1000, // no amplification
    );
    expect(negligible).toBe(0);
  });

  it('retains a pre-window dose whose late contribution is still non-negligible', () => {
    // Flip-flop route: a dose at t=0 still contributes ~1e-5 mg/L around 500 h. An
    // in-window run (window from 0) and a pre-window run (window starting at 500) must
    // agree at the overlapping late times — i.e. the pre-window dose was NOT dropped.
    const route = cases[0]!.route;
    const dose = cases[0]!.dose;
    const lateTimes = [500, 520, 540];
    const inWindow = parentMetaboliteCurve(
      [{ tHours: 0, amountMg: dose, route }],
      [0, ...lateTimes],
      1 / 60,
    );
    const preWindow = parentMetaboliteCurve(
      [{ tHours: 0, amountMg: dose, route }],
      lateTimes,
      1 / 60,
    );
    for (let i = 0; i < lateTimes.length; i++) {
      // Non-trivial contribution, and identical whether the dose is in- or pre-window.
      expect(inWindow.parent[i + 1]!).toBeGreaterThan(NEGLIGIBLE);
      expect(preWindow.parent[i]!).toBeCloseTo(inWindow.parent[i + 1]!, 9);
    }
  });
});

describe('parentMetaboliteCurve — plumbing', () => {
  it('is zero everywhere with no doses, and superposes repeated doses', () => {
    const none = parentMetaboliteCurve([], T_SAMPLES, 1 / 60);
    expect(none.parent.every((c) => c === 0)).toBe(true);
    expect(none.metabolite.every((c) => c === 0)).toBe(true);

    const single = parentMetaboliteCurve([{ tHours: 0, amountMg: DOSE, route }], T_SAMPLES, 1 / 60);
    const twice = parentMetaboliteCurve(
      [
        { tHours: 0, amountMg: DOSE, route },
        { tHours: 0, amountMg: DOSE, route },
      ],
      T_SAMPLES,
      1 / 60,
    );
    // Linear system: two co-timed doses give exactly double.
    for (let i = 0; i < T_SAMPLES.length; i++) {
      expect(twice.metabolite[i]!).toBeCloseTo(2 * single.metabolite[i]!, 9);
    }
  });
});
