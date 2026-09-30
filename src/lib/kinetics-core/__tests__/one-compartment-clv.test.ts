/**
 * SC-1A `one-compartment-clv` family resolution.
 *
 * Asserts, through the same `resolveRouteKernel` the engine's linear path uses,
 * that a clearance/volume route:
 *   - produces the SAME closed-form curve as its half-life parameterisation
 *     (`ke = CL/Vc`), so CL/V is a re-parameterisation, not a different model;
 *   - reports a DERIVED half-life and the structural identity (`CL/F` vs `CL`);
 *   - folds `F` into the apparent volume (apparent basis) or applies a separate
 *     `F` (absolute basis), and marks bioavailability accordingly;
 *   - fails the physicality gate for a non-physical or under-specified draw.
 */
import { describe, it, expect } from 'vitest';
import { resolveRouteKernel } from '../simulate';
import { concentrationOralFirstOrder, halfLifeFromK } from '../equations';
import { fixed } from '../param';
import type { OneCompartmentClvRouteParams } from '../types';

const T_SAMPLES = [0, 0.25, 0.5, 1, 2, 4, 8, 16, 24];

describe('one-compartment-clv — apparent extravascular (CL/F, Vc/F)', () => {
  const clF = 6; // L/h
  const vF = 120; // L → ke = 0.05 /h
  const ka = 1.2;
  const ke = clF / vF;
  const params: OneCompartmentClvRouteParams = {
    family: 'one-compartment-clv',
    kaPerHour: fixed(ka),
    clearance: { id: 'CL', basis: 'apparent-extravascular', spec: fixed(clF), unit: 'L/h' },
    volume: { id: 'Vc', basis: 'apparent-extravascular', spec: fixed(vF), unit: 'L' },
    // No bioavailability: F is folded into Vc/F.
  };
  // scaleKg is ignored by this family (absolute volumes) — pass a non-1 value to prove it.
  const r = resolveRouteKernel('oral', params, 70, undefined);

  it('reproduces the Bateman curve with amplitude Dose/(Vc/F)', () => {
    expect(r.valid).toBe(true);
    for (const t of T_SAMPLES) {
      const got = r.kernel(t, 50);
      const want = concentrationOralFirstOrder(50, vF, 1, ka, ke, t);
      expect(got).toBeCloseTo(want, 12);
    }
  });

  it('reports a derived half-life and CL/F identity, F not separately identified', () => {
    expect(r.summary.family).toBe('one-compartment-clv');
    expect(r.summary.eliminationHalfLifeHours).toBeCloseTo(halfLifeFromK(ke), 12);
    expect(r.summary.vdLiters).toBe(vF);
    expect(r.summary.bioavailability).toBeNull();
    const s = r.summary.structural!;
    expect(s.eliminationRatePerHour).toBeCloseTo(ke, 12);
    expect(s.clearance.identity).toBe('CL/F');
    expect(s.clearance.value).toBe(clF);
    expect(s.clearance.exposableAsAbsolute).toBe(false);
    expect(s.volume.identity).toBe('Vc/F');
    expect(s.volume.exposableAsAbsolute).toBe(false);
  });
});

describe('one-compartment-clv — absolute (IV-anchored CL, Vc) with a separate F', () => {
  const CL = 6;
  const Vc = 120;
  const F = 0.7;
  const ka = 1.2;
  const ke = CL / Vc;
  const params: OneCompartmentClvRouteParams = {
    family: 'one-compartment-clv',
    kaPerHour: fixed(ka),
    clearance: { id: 'CL', basis: 'iv-anchored', spec: fixed(CL), unit: 'L/h' },
    volume: { id: 'Vc', basis: 'iv-anchored', spec: fixed(Vc), unit: 'L' },
    bioavailability: fixed(F),
  };
  const r = resolveRouteKernel('oral', params, 70, undefined);

  it('applies the separate F: amplitude F·Dose/Vc', () => {
    expect(r.valid).toBe(true);
    for (const t of T_SAMPLES) {
      const got = r.kernel(t, 50);
      const want = concentrationOralFirstOrder(50, Vc, F, ka, ke, t);
      expect(got).toBeCloseTo(want, 12);
    }
  });

  it('reports the absolute CL identity and the real F', () => {
    expect(r.summary.bioavailability).toBeCloseTo(F, 12);
    const s = r.summary.structural!;
    expect(s.clearance.identity).toBe('CL');
    expect(s.clearance.exposableAsAbsolute).toBe(true);
    expect(s.volume.identity).toBe('Vc');
  });

  it('the two parameterisations give the same rate but different amplitude', () => {
    // Same CL/Vc as the apparent block above (ke identical) but the absolute route
    // scales by a real F<1, so its curve is lower — the identities are not just a label.
    const apparent = resolveRouteKernel(
      'oral',
      {
        family: 'one-compartment-clv',
        kaPerHour: fixed(ka),
        clearance: { id: 'CL', basis: 'apparent-extravascular', spec: fixed(CL), unit: 'L/h' },
        volume: { id: 'Vc', basis: 'apparent-extravascular', spec: fixed(Vc), unit: 'L' },
      },
      70,
      undefined,
    );
    expect(apparent.summary.eliminationHalfLifeHours).toBeCloseTo(
      r.summary.eliminationHalfLifeHours,
      12,
    );
    // Apparent folds F=1 (amplitude Dose/Vc); absolute uses F=0.7 (F·Dose/Vc) → lower.
    expect(r.kernel(2, 50)).toBeLessThan(apparent.kernel(2, 50));
  });
});

describe('one-compartment-clv — covariate factors (SC-2A)', () => {
  const clF = 6;
  const vF = 120;
  const ka = 1.2;
  const params: OneCompartmentClvRouteParams = {
    family: 'one-compartment-clv',
    kaPerHour: fixed(ka),
    clearance: { id: 'CL', basis: 'apparent-extravascular', spec: fixed(clF) },
    volume: { id: 'Vc', basis: 'apparent-extravascular', spec: fixed(vF) },
  };

  it('a CL factor scales clearance → ke, leaving Vc/amplitude unchanged', () => {
    const r = resolveRouteKernel('oral', params, 70, undefined, { CL: 1.2 });
    const ke = (clF * 1.2) / vF; // 0.06
    expect(r.summary.structural!.eliminationRatePerHour).toBeCloseTo(ke, 12);
    expect(r.summary.structural!.clearance.value).toBeCloseTo(clF * 1.2, 12);
    expect(r.summary.vdLiters).toBe(vF); // Vc unaffected
    for (const t of T_SAMPLES) {
      expect(r.kernel(t, 50)).toBeCloseTo(concentrationOralFirstOrder(50, vF, 1, ka, ke, t), 12);
    }
  });

  it('a Vc factor scales the apparent volume (amplitude) and ke', () => {
    const r = resolveRouteKernel('oral', params, 70, undefined, { Vc: 1.5 });
    const vd = vF * 1.5;
    const ke = clF / vd;
    expect(r.summary.vdLiters).toBeCloseTo(vd, 12);
    expect(r.summary.structural!.eliminationRatePerHour).toBeCloseTo(ke, 12);
    for (const t of T_SAMPLES) {
      expect(r.kernel(t, 50)).toBeCloseTo(concentrationOralFirstOrder(50, vd, 1, ka, ke, t), 12);
    }
  });

  it('a ka factor scales absorption only', () => {
    const r = resolveRouteKernel('oral', params, 70, undefined, { ka: 2 });
    expect(r.summary.kaPerHour).toBeCloseTo(ka * 2, 12);
    const ke = clF / vF;
    for (const t of T_SAMPLES) {
      expect(r.kernel(t, 50)).toBeCloseTo(concentrationOralFirstOrder(50, vF, 1, ka * 2, ke, t), 12);
    }
  });

  it('no factors (default) is identical to a factor of 1', () => {
    const base = resolveRouteKernel('oral', params, 70, undefined);
    const ones = resolveRouteKernel('oral', params, 70, undefined, { CL: 1, Vc: 1, ka: 1 });
    for (const t of T_SAMPLES) {
      expect(ones.kernel(t, 50)).toBeCloseTo(base.kernel(t, 50), 12);
    }
  });
});

describe('one-compartment-clv — physicality gate', () => {
  const base = {
    family: 'one-compartment-clv' as const,
    kaPerHour: fixed(1.2),
    volume: { id: 'Vc' as const, basis: 'apparent-extravascular' as const, spec: fixed(120) },
  };

  it('rejects a zero clearance (ke = 0)', () => {
    const r = resolveRouteKernel(
      'oral',
      { ...base, clearance: { id: 'CL', basis: 'apparent-extravascular', spec: fixed(0) } },
      70,
      undefined,
    );
    expect(r.valid).toBe(false);
  });

  it('rejects an absolute basis with no bioavailability (amplitude undefined)', () => {
    const r = resolveRouteKernel(
      'oral',
      {
        family: 'one-compartment-clv',
        kaPerHour: fixed(1.2),
        clearance: { id: 'CL', basis: 'iv-anchored', spec: fixed(6) },
        volume: { id: 'Vc', basis: 'iv-anchored', spec: fixed(120) },
        // bioavailability deliberately omitted — an authoring error for an absolute basis.
      },
      70,
      undefined,
    );
    expect(r.valid).toBe(false);
  });

  it('rejects an apparent basis that ALSO supplies a separate F (F must be folded)', () => {
    const r = resolveRouteKernel(
      'oral',
      {
        family: 'one-compartment-clv',
        kaPerHour: fixed(1.2),
        clearance: { id: 'CL', basis: 'apparent-extravascular', spec: fixed(6) },
        volume: { id: 'Vc', basis: 'apparent-extravascular', spec: fixed(120) },
        bioavailability: fixed(0.7), // contradiction: F is folded into Vc/F
      },
      70,
      undefined,
    );
    expect(r.valid).toBe(false);
  });

  it('rejects an incoherent pair: apparent CL with an absolute Vc', () => {
    const r = resolveRouteKernel(
      'oral',
      {
        family: 'one-compartment-clv',
        kaPerHour: fixed(1.2),
        clearance: { id: 'CL', basis: 'apparent-extravascular', spec: fixed(6) },
        volume: { id: 'Vc', basis: 'iv-anchored', spec: fixed(120) },
        bioavailability: fixed(0.7),
      },
      70,
      undefined,
    );
    expect(r.valid).toBe(false);
  });

  it('rejects a `derived` basis on an authored primitive', () => {
    const r = resolveRouteKernel(
      'oral',
      {
        family: 'one-compartment-clv',
        kaPerHour: fixed(1.2),
        clearance: { id: 'CL', basis: 'derived', spec: fixed(6) },
        volume: { id: 'Vc', basis: 'derived', spec: fixed(120) },
      },
      70,
      undefined,
    );
    expect(r.valid).toBe(false);
  });

  it('rejects an unknown/out-of-enum basis on both sides (non-TS caller)', () => {
    const r = resolveRouteKernel(
      'oral',
      {
        family: 'one-compartment-clv',
        kaPerHour: fixed(1.2),
        // Same unknown value for both bases would pass a naive same-class check.
        clearance: { id: 'CL', basis: null as never, spec: fixed(6) },
        volume: { id: 'Vc', basis: null as never, spec: fixed(120) },
        bioavailability: fixed(0.7),
      } as unknown as OneCompartmentClvRouteParams,
      70,
      undefined,
    );
    expect(r.valid).toBe(false);
  });

  it('rejects swapped/foreign structural ids (runtime guard behind the type pinning)', () => {
    const r = resolveRouteKernel(
      'oral',
      {
        family: 'one-compartment-clv',
        kaPerHour: fixed(1.2),
        // A non-TS caller could pass a swapped id; the type system pins these to
        // 'CL'/'Vc', so the cast simulates that boundary.
        clearance: { id: 'Vc', basis: 'apparent-extravascular', spec: fixed(6) },
        volume: { id: 'CL', basis: 'apparent-extravascular', spec: fixed(120) },
      } as unknown as OneCompartmentClvRouteParams,
      70,
      undefined,
    );
    expect(r.valid).toBe(false);
  });
});
