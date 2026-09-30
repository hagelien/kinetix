import { describe, it, expect } from 'vitest';
import {
  eliminationConstant,
  halfLifeFromK,
  forwardConcentration,
  backwardConcentration,
  concentrationFromDoseIV,
  concentrationFromDoseOral,
  concentrationZeroOrder,
  concentrationOralFirstOrder,
  concentrationInfusion,
  superposeDoses,
  doseFromConcentrationIV,
  doseFromConcentrationOral,
  concentrationTimeCurve,
} from './pkEquations';

describe('eliminationConstant / halfLifeFromK', () => {
  it('computes k from half-life', () => {
    // t1/2 = 4h → k = ln(2)/4 ≈ 0.1733
    expect(eliminationConstant(4)).toBeCloseTo(0.1733, 3);
  });

  it('round-trips k ↔ halfLife', () => {
    const t = 6;
    const k = eliminationConstant(t);
    expect(halfLifeFromK(k)).toBeCloseTo(t, 10);
  });
});

describe('forward/backward concentration', () => {
  it('forward decay reduces concentration', () => {
    const c0 = 100;
    const k = eliminationConstant(4); // t1/2 = 4h
    const c1 = forwardConcentration(c0, k, 4); // after 1 half-life
    expect(c1).toBeCloseTo(50, 1); // should be half
  });

  it('backward extrapolation increases concentration', () => {
    const c1 = 50;
    const k = eliminationConstant(4);
    const c0 = backwardConcentration(c1, k, 4); // 1 half-life earlier
    expect(c0).toBeCloseTo(100, 1);
  });

  it('forward(backward(C)) round-trips', () => {
    const c = 75;
    const k = 0.15;
    const dt = 3;
    const earlier = backwardConcentration(c, k, dt);
    const back = forwardConcentration(earlier, k, dt);
    expect(back).toBeCloseTo(c, 10);
  });

  it('zero time returns same concentration', () => {
    expect(forwardConcentration(100, 0.1, 0)).toBe(100);
    expect(backwardConcentration(100, 0.1, 0)).toBe(100);
  });
});

describe('dose-concentration relationships', () => {
  it('IV dose to concentration', () => {
    // Dose=500mg, Vd=50L → C0 = 10 mg/L at t=0
    const c = concentrationFromDoseIV(500, 50, 0.1, 0);
    expect(c).toBeCloseTo(10, 5);
  });

  it('IV concentration decays over time', () => {
    const c0 = concentrationFromDoseIV(500, 50, 0.1, 0);
    const c1 = concentrationFromDoseIV(500, 50, 0.1, 2);
    expect(c1).toBeLessThan(c0);
  });

  it('oral dose includes bioavailability', () => {
    // F=0.5 halves the peak vs IV
    const cIV = concentrationFromDoseIV(500, 50, 0.1, 0);
    const cOral = concentrationFromDoseOral(500, 50, 0.5, 0.1, 0);
    expect(cOral).toBeCloseTo(cIV * 0.5, 5);
  });

  it('dose recovery from IV concentration', () => {
    const dose = 500;
    const vd = 50;
    const k = 0.1;
    const t = 3;
    const c = concentrationFromDoseIV(dose, vd, k, t);
    const recoveredDose = doseFromConcentrationIV(c, vd, k, t);
    expect(recoveredDose).toBeCloseTo(dose, 5);
  });

  it('dose recovery from oral concentration', () => {
    const dose = 500;
    const vd = 50;
    const f = 0.7;
    const k = 0.1;
    const t = 3;
    const c = concentrationFromDoseOral(dose, vd, f, k, t);
    const recoveredDose = doseFromConcentrationOral(c, vd, f, k, t);
    expect(recoveredDose).toBeCloseTo(dose, 5);
  });
});

describe('concentrationZeroOrder', () => {
  it('returns Dose/Vd at t=0', () => {
    // Forensic ethanol: 70 g (70_000 mg) into a Widmark Vd of 50 L gives
    // an instantaneous BAC of 1400 mg/L (= 1.4 g/L = 1.4 ‰), in line with
    // textbook Widmark numbers.
    expect(concentrationZeroOrder(70_000, 50, 150, 0)).toBeCloseTo(1400, 6);
  });

  it('decays linearly with the elimination rate', () => {
    // β = 150 mg/L/h → after 4h, drop is 600 mg/L. Starting at 1400 mg/L,
    // the curve should read 800 mg/L. Linear, by construction.
    expect(concentrationZeroOrder(70_000, 50, 150, 4)).toBeCloseTo(800, 6);
  });

  it('clips to zero rather than going negative once eliminated', () => {
    // After the BAC has hit zero the linear extrapolation would go
    // negative; the engine treats the value as 0 and `logLikelihood`
    // then rejects the draw because the observation is positive.
    expect(concentrationZeroOrder(70_000, 50, 150, 100)).toBe(0);
  });

  it('returns 0 for negative t (pre-intake)', () => {
    expect(concentrationZeroOrder(70_000, 50, 150, -1)).toBe(0);
  });
});

describe('concentrationTimeCurve', () => {
  it('generates the correct number of points', () => {
    const points = concentrationTimeCurve(100, 0.1, 24, 60);
    expect(points.length).toBe(61); // 0..60 inclusive
  });

  it('starts at c0 and decays', () => {
    const points = concentrationTimeCurve(100, 0.1, 24, 60);
    expect(points[0]!.t).toBe(0);
    expect(points[0]!.c).toBeCloseTo(100, 5);
    expect(points[points.length - 1]!.c).toBeLessThan(100);
  });

  it('monotonically decreases', () => {
    const points = concentrationTimeCurve(100, 0.1, 24, 60);
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.c).toBeLessThanOrEqual(points[i - 1]!.c);
    }
  });
});

describe('concentrationOralFirstOrder (Bateman)', () => {
  const dose = 100;
  const vd = 50;
  const f = 1;
  const ka = 1.2;
  const ke = 0.2;

  it('is zero at t=0 and before administration', () => {
    expect(concentrationOralFirstOrder(dose, vd, f, ka, ke, 0)).toBeCloseTo(0, 9);
    expect(concentrationOralFirstOrder(dose, vd, f, ka, ke, -1)).toBe(0);
  });

  it('rises to a peak then falls (absorption then elimination)', () => {
    const early = concentrationOralFirstOrder(dose, vd, f, ka, ke, 0.5);
    const peakish = concentrationOralFirstOrder(dose, vd, f, ka, ke, 1.8);
    const late = concentrationOralFirstOrder(dose, vd, f, ka, ke, 10);
    expect(peakish).toBeGreaterThan(early);
    expect(peakish).toBeGreaterThan(late);
  });

  it('matches the closed-form Bateman value', () => {
    const t = 2;
    const expected =
      ((f * dose) / vd) *
      (ka / (ka - ke)) *
      (Math.exp(-ke * t) - Math.exp(-ka * t));
    expect(concentrationOralFirstOrder(dose, vd, f, ka, ke, t)).toBeCloseTo(
      expected,
      9,
    );
  });

  it('uses the analytic limit when ka == ke without dividing by zero', () => {
    const k = 0.3;
    const t = 2;
    const v = concentrationOralFirstOrder(dose, vd, f, k, k, t);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeCloseTo(((f * dose) / vd) * k * t * Math.exp(-k * t), 9);
  });

  it('approaches the ka==ke limit continuously as ka -> ke', () => {
    const k = 0.3;
    const t = 2;
    const limit = concentrationOralFirstOrder(dose, vd, f, k, k, t);
    const near = concentrationOralFirstOrder(dose, vd, f, k + 1e-6, k, t);
    expect(near).toBeCloseTo(limit, 4);
  });
});

describe('concentrationInfusion', () => {
  const dose = 100;
  const vd = 50;
  const k = 0.2;
  const duration = 2;

  it('rises during the infusion and decays after it ends', () => {
    const mid = concentrationInfusion(dose, vd, k, duration, 1);
    const atEnd = concentrationInfusion(dose, vd, k, duration, duration);
    const after = concentrationInfusion(dose, vd, k, duration, duration + 4);
    expect(atEnd).toBeGreaterThan(mid);
    expect(after).toBeLessThan(atEnd);
  });

  it('peaks exactly at the end of the infusion', () => {
    const justBefore = concentrationInfusion(dose, vd, k, duration, duration - 0.01);
    const atEnd = concentrationInfusion(dose, vd, k, duration, duration);
    const justAfter = concentrationInfusion(dose, vd, k, duration, duration + 0.01);
    expect(atEnd).toBeGreaterThan(justBefore);
    expect(atEnd).toBeGreaterThan(justAfter);
  });

  it('degenerates to an IV bolus for zero duration', () => {
    expect(concentrationInfusion(dose, vd, k, 0, 3)).toBeCloseTo(
      concentrationFromDoseIV(dose, vd, k, 3),
      9,
    );
  });

  it('is zero before the infusion starts', () => {
    expect(concentrationInfusion(dose, vd, k, duration, -1)).toBe(0);
  });
});

describe('superposeDoses', () => {
  const single = (elapsed: number, amount: number) =>
    concentrationFromDoseIV(amount, 50, 0.2, elapsed);

  it('sums contributions of repeated doses', () => {
    const doses = [
      { tDose: 0, amount: 100 },
      { tDose: 4, amount: 100 },
    ];
    const t = 6;
    const expected =
      single(6, 100) + single(2, 100); // second dose has elapsed 2h
    expect(superposeDoses(doses, single, t)).toBeCloseTo(expected, 9);
  });

  it('ignores doses still in the future', () => {
    const doses = [
      { tDose: 0, amount: 100 },
      { tDose: 10, amount: 100 },
    ];
    expect(superposeDoses(doses, single, 3)).toBeCloseTo(single(3, 100), 9);
  });

  it('exceeds a single dose when doses accumulate', () => {
    const oneDose = superposeDoses([{ tDose: 0, amount: 100 }], single, 5);
    const twoDoses = superposeDoses(
      [
        { tDose: 0, amount: 100 },
        { tDose: 1, amount: 100 },
      ],
      single,
      5,
    );
    expect(twoDoses).toBeGreaterThan(oneDose);
  });
});
