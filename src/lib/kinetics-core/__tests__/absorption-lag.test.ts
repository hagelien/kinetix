/**
 * SC-4A absorption lag time (`tlag`) on the first-order absorption families.
 *
 * Asserts, through the same `resolveRouteKernel` the engine's linear path uses, that
 * a declared `absorptionLagHours`:
 *   - shifts the whole first-order profile later by `tlag` (`C(t)=0` for `t<tlag`,
 *     the ordinary Bateman curve in `t−tlag`);
 *   - is reported on the summary only when declared (unlagged summaries unchanged);
 *   - is drawn only when present (no PRNG perturbation is asserted at the engine
 *     level, but the unlagged path is byte-identical — see the parity fixture);
 *   - fails the physicality gate when negative.
 */
import { describe, it, expect } from 'vitest';
import { resolveRouteKernel } from '../simulate';
import { concentrationOralFirstOrder, eliminationConstant } from '../equations';
import { fixed } from '../param';
import type {
  OneCompartmentRouteParams,
  OneCompartmentClvRouteParams,
} from '../types';

const T = [0, 0.25, 0.4, 0.5, 0.6, 1, 2, 4, 8, 16];

describe('one-compartment-first-order — tlag', () => {
  const ka = 1.2;
  const halfLife = 6;
  const ke = eliminationConstant(halfLife);
  const vdPerKg = 4;
  const scaleKg = 70;
  const vd = vdPerKg * scaleKg; // 280 L
  const f = 0.8;
  const lag = 0.5;
  const base: OneCompartmentRouteParams = {
    family: 'one-compartment-first-order',
    kaPerHour: fixed(ka),
    eliminationHalfLifeHours: fixed(halfLife),
    vdLitersPerKg: fixed(vdPerKg),
    bioavailability: fixed(f),
  };

  it('shifts the profile by tlag and is 0 before it', () => {
    const r = resolveRouteKernel('oral', { ...base, absorptionLagHours: fixed(lag) }, scaleKg, undefined);
    expect(r.valid).toBe(true);
    for (const t of T) {
      const want = concentrationOralFirstOrder(50, vd, f, ka, ke, t - lag);
      expect(r.kernel(t, 50)).toBeCloseTo(want, 12);
    }
    expect(r.kernel(0.4, 50)).toBe(0); // before the lag → exactly 0
    expect(r.kernel(0.5, 50)).toBe(0); // at the lag, elapsed-lag = 0 → 0
    expect(r.kernel(1, 50)).toBeGreaterThan(0);
    expect(r.summary.absorptionLagHours).toBeCloseTo(lag, 12);
  });

  it('equals the unlagged curve at lag 0, and omits the summary field when undeclared', () => {
    const unlagged = resolveRouteKernel('oral', base, scaleKg, undefined);
    const zeroLag = resolveRouteKernel('oral', { ...base, absorptionLagHours: fixed(0) }, scaleKg, undefined);
    for (const t of T) {
      expect(zeroLag.kernel(t, 50)).toBeCloseTo(unlagged.kernel(t, 50), 12);
    }
    // Undeclared → the optional field is absent (unlagged summaries stay unchanged).
    expect('absorptionLagHours' in unlagged.summary).toBe(false);
    // Declared (even as 0) → reported.
    expect(zeroLag.summary.absorptionLagHours).toBe(0);
  });

  it('rejects a negative lag', () => {
    const r = resolveRouteKernel('oral', { ...base, absorptionLagHours: fixed(-0.5) }, scaleKg, undefined);
    expect(r.valid).toBe(false);
  });
});

describe('one-compartment-clv — tlag', () => {
  const clF = 6;
  const vF = 120;
  const ka = 1.2;
  const ke = clF / vF;
  const lag = 0.75;
  const params: OneCompartmentClvRouteParams = {
    family: 'one-compartment-clv',
    kaPerHour: fixed(ka),
    clearance: { id: 'CL', basis: 'apparent-extravascular', spec: fixed(clF) },
    volume: { id: 'Vc', basis: 'apparent-extravascular', spec: fixed(vF) },
    absorptionLagHours: fixed(lag),
  };

  it('shifts the clv profile by tlag', () => {
    const r = resolveRouteKernel('oral', params, 70, undefined);
    expect(r.valid).toBe(true);
    for (const t of T) {
      const want = concentrationOralFirstOrder(50, vF, 1, ka, ke, t - lag);
      expect(r.kernel(t, 50)).toBeCloseTo(want, 12);
    }
    expect(r.kernel(0.5, 50)).toBe(0); // before the 0.75 h lag
    expect(r.summary.absorptionLagHours).toBeCloseTo(lag, 12);
    // The lag composes with a covariate factor on ke without interaction.
    const scaled = resolveRouteKernel('oral', params, 70, undefined, { CL: 1.2 });
    for (const t of T) {
      expect(scaled.kernel(t, 50)).toBeCloseTo(
        concentrationOralFirstOrder(50, vF, 1, ka, (clF * 1.2) / vF, t - lag),
        12,
      );
    }
  });
});
