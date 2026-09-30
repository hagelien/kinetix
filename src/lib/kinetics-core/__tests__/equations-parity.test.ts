/**
 * Anti-drift guard: the kinetics-core equation kernel must stay numerically
 * identical to the app's existing `src/lib/pkEquations.ts`. If someone edits one
 * copy and not the other, this fails.
 */
import { describe, it, expect } from 'vitest';
import * as core from '../equations';
import * as legacy from '../../pkEquations';

describe('kinetics-core equations match pkEquations', () => {
  const cases = [
    { dose: 30, vd: 280, f: 0.8, ka: 0.693, ke: 0.063, t: 0 },
    { dose: 30, vd: 280, f: 0.8, ka: 0.693, ke: 0.063, t: 4 },
    { dose: 20, vd: 280, f: 0.7, ka: 4.159, ke: 0.063, t: 1.5 },
    { dose: 100, vd: 50, f: 1, ka: 5, ke: 0.5, t: 2 },
    // ka ≈ ke → analytic-limit branch
    { dose: 50, vd: 100, f: 0.9, ka: 0.5, ke: 0.5, t: 3 },
  ];

  it('concentrationOralFirstOrder is identical', () => {
    for (const c of cases) {
      const a = core.concentrationOralFirstOrder(c.dose, c.vd, c.f, c.ka, c.ke, c.t);
      const b = legacy.concentrationOralFirstOrder(c.dose, c.vd, c.f, c.ka, c.ke, c.t);
      expect(a).toBe(b);
    }
  });

  it('concentrationFromDoseIV / zero-order / infusion are identical', () => {
    expect(core.concentrationFromDoseIV(100, 50, 0.5, 2)).toBe(
      legacy.concentrationFromDoseIV(100, 50, 0.5, 2),
    );
    expect(core.concentrationFromDoseOral(100, 50, 0.8, 0.5, 2)).toBe(
      legacy.concentrationFromDoseOral(100, 50, 0.8, 0.5, 2),
    );
    expect(core.concentrationZeroOrder(5, 40, 0.15, 3)).toBe(
      legacy.concentrationZeroOrder(5, 40, 0.15, 3),
    );
    expect(core.concentrationInfusion(100, 50, 0.5, 1, 2)).toBe(
      legacy.concentrationInfusion(100, 50, 0.5, 1, 2),
    );
  });

  it('is identical across the t < 0 sign boundary (incl. the unguarded IV helper)', () => {
    for (const t of [-5, -1, -0.001]) {
      // IV bolus has NO negative-time guard in either kernel — both grow as t<0.
      expect(core.concentrationFromDoseIV(100, 50, 0.5, t)).toBe(
        legacy.concentrationFromDoseIV(100, 50, 0.5, t),
      );
      // The guarded kernels both return 0 for t<0.
      expect(core.concentrationOralFirstOrder(30, 280, 0.8, 0.693, 0.063, t)).toBe(
        legacy.concentrationOralFirstOrder(30, 280, 0.8, 0.693, 0.063, t),
      );
      expect(core.concentrationInfusion(100, 50, 0.5, 1, t)).toBe(
        legacy.concentrationInfusion(100, 50, 0.5, 1, t),
      );
      expect(core.concentrationZeroOrder(5, 40, 0.15, t)).toBe(
        legacy.concentrationZeroOrder(5, 40, 0.15, t),
      );
    }
  });

  it('eliminationConstant round-trips with halfLifeFromK', () => {
    const k = core.eliminationConstant(11);
    expect(core.halfLifeFromK(k)).toBeCloseTo(11, 12);
  });
});
