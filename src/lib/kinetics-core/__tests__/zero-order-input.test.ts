/**
 * SC-4A part 2 — zero-order (constant-rate) extravascular input family.
 *
 * Asserts, through the same `resolveRouteKernel` the engine's linear path uses (no
 * zero-order model ships in the registry yet — the family is an administration
 * capability, tested directly like `one-compartment-clv` and the absorption-lag
 * families), that `one-compartment-zero-order`:
 *
 *   - produces the EXACT constant-rate-input closed form on the absorbed amount
 *     `F·Dose` over the declared duration `D` (rising while input continues, mono-
 *     exponential decay after), i.e. `concentrationInfusion(F·Dose, Vd, ke, D, t)`;
 *   - peaks at the END of input (`t = D`), and at `t = tlag + D` with an absorption lag;
 *   - scales linearly with bioavailability `F`;
 *   - is zero before the lag;
 *   - rejects a non-physical route (D ≤ 0, F out of (0,1], negative lag).
 */
import { describe, it, expect } from 'vitest';
import { resolveRouteKernel } from '../simulate';
import { concentrationInfusion, eliminationConstant } from '../equations';
import { fixed } from '../param';
import type { OneCompartmentZeroOrderRouteParams } from '../types';

const base: OneCompartmentZeroOrderRouteParams = {
  family: 'one-compartment-zero-order',
  zeroOrderDurationHours: fixed(4),
  eliminationHalfLifeHours: fixed(3),
  vdLitersPerKg: fixed(0.6),
  bioavailability: fixed(0.8),
};

const scaleKg = 70;

describe('SC-4A part 2 — one-compartment-zero-order (constant-rate input) family', () => {
  it('matches the exact constant-rate-input closed form on the absorbed amount F·Dose', () => {
    const r = resolveRouteKernel('oral', base, scaleKg, undefined);
    expect(r.valid).toBe(true);
    const vd = 0.6 * scaleKg;
    const ke = eliminationConstant(3);
    const dose = 100;
    for (const t of [0, 0.5, 1, 2, 4, 4.0001, 6, 12, 24]) {
      const expected = concentrationInfusion(0.8 * dose, vd, ke, 4, t);
      expect(r.kernel(t, dose)).toBeCloseTo(expected, 12);
    }
  });

  it('peaks at the end of input (t = D) — a rate-controlled corner, not a first-order peak', () => {
    const r = resolveRouteKernel('oral', base, scaleKg, undefined);
    const dose = 100;
    const cAtD = r.kernel(4, dose);
    // Strictly rising up to D...
    expect(r.kernel(3.5, dose)).toBeLessThan(cAtD);
    expect(r.kernel(3.99, dose)).toBeLessThan(cAtD);
    // ...and strictly falling after D.
    expect(r.kernel(4.5, dose)).toBeLessThan(cAtD);
    expect(r.kernel(6, dose)).toBeLessThan(cAtD);
  });

  it('shifts the whole profile by an absorption lag: C=0 before tlag, peak at tlag+D', () => {
    const lag = 1.5;
    const lagged = resolveRouteKernel(
      'oral',
      { ...base, absorptionLagHours: fixed(lag) },
      scaleKg,
      undefined,
    );
    const dose = 100;
    // Zero right up to the lag.
    expect(lagged.kernel(1.0, dose)).toBe(0);
    expect(lagged.kernel(1.49, dose)).toBe(0);
    // The lagged curve at t equals the unlagged curve at t−lag.
    const unlagged = resolveRouteKernel('oral', base, scaleKg, undefined);
    for (const t of [1.5, 2, 3, 5.5, 8]) {
      expect(lagged.kernel(t, dose)).toBeCloseTo(unlagged.kernel(t - lag, dose), 12);
    }
    // Peak now at tlag + D = 5.5.
    const cPeak = lagged.kernel(lag + 4, dose);
    expect(lagged.kernel(lag + 3.5, dose)).toBeLessThan(cPeak);
    expect(lagged.kernel(lag + 4.5, dose)).toBeLessThan(cPeak);
  });

  it('scales linearly with bioavailability', () => {
    const full = resolveRouteKernel('oral', { ...base, bioavailability: fixed(1) }, scaleKg, undefined);
    const half = resolveRouteKernel('oral', { ...base, bioavailability: fixed(0.5) }, scaleKg, undefined);
    for (const t of [1, 2, 4, 8]) {
      expect(half.kernel(t, 100)).toBeCloseTo(0.5 * full.kernel(t, 100), 12);
    }
  });

  it('reports the duration under infusionDurationHours and a null ka', () => {
    const r = resolveRouteKernel('oral', base, scaleKg, undefined);
    expect(r.summary.family).toBe('one-compartment-zero-order');
    expect(r.summary.kaPerHour).toBeNull();
    expect(r.summary.infusionDurationHours).toBeCloseTo(4, 12);
    expect(r.summary.bioavailability).toBeCloseTo(0.8, 12);
    expect(r.summary.vdLiters).toBeCloseTo(0.6 * scaleKg, 12);
  });

  it.each([
    ['duration = 0 (a bolus belongs to another family)', { zeroOrderDurationHours: fixed(0) }],
    ['negative duration', { zeroOrderDurationHours: fixed(-2) }],
    ['bioavailability > 1', { bioavailability: fixed(1.2) }],
    ['bioavailability = 0', { bioavailability: fixed(0) }],
    ['negative lag', { absorptionLagHours: fixed(-0.5) }],
  ] as const)('rejects a non-physical route: %s', (_label, patch) => {
    const r = resolveRouteKernel(
      'oral',
      { ...base, ...patch } as OneCompartmentZeroOrderRouteParams,
      scaleKg,
      undefined,
    );
    expect(r.valid).toBe(false);
  });
});
