/**
 * SC-5B — observation residual-error layer.
 *
 * The reported concentration is a latent MODEL prediction; a MEASUREMENT of it also
 * carries error the kinetics do not (assay, preanalytical, biological, structural). A
 * model declares reviewed error layers; the engine composes independent layers in
 * variance and WIDENS the reported bands, leaving the deterministic median unchanged.
 *
 * The composition and widening are tested directly (no shipped model declares an error
 * layer yet — a reviewed error model is evidence-gated per analyte), plus the inert
 * (no-error) path end-to-end through a registered model.
 */
import { describe, it, expect } from 'vitest';
import {
  simulateScenario,
  composeObservationError,
  widenBandForObservationError,
} from '../simulate';
import type { CanonicalScenario, CanonicalSubject, ObservationErrorLayer, CurvePoint } from '../types';

const Z95 = 1.6448536269514722;
const Z75 = 0.6744897501960817;

describe('SC-5B — composeObservationError', () => {
  it('returns null when no layer applies to the analyte', () => {
    const layers: ObservationErrorLayer[] = [
      { layer: 'analytical', proportionalCv: 0.1, analyte: 'metabolite', rationale: 'x' },
    ];
    expect(composeObservationError(layers, 'parent', 'parent')).toBeNull();
  });

  it('composes independent layers in VARIANCE (√Σcv², √Σsd²)', () => {
    const layers: ObservationErrorLayer[] = [
      { layer: 'analytical', proportionalCv: 0.1, additiveSd: 0.3, rationale: 'a' },
      { layer: 'biological', proportionalCv: 0.2, additiveSd: 0.4, rationale: 'b' },
    ];
    const e = composeObservationError(layers, 'drug', 'drug');
    expect(e).not.toBeNull();
    expect(e!.propCv).toBeCloseTo(Math.sqrt(0.1 ** 2 + 0.2 ** 2), 12);
    expect(e!.addSd).toBeCloseTo(Math.sqrt(0.3 ** 2 + 0.4 ** 2), 12);
  });

  it('filters per analyte — a metabolite layer does not apply to the primary', () => {
    const layers: ObservationErrorLayer[] = [
      { layer: 'analytical', proportionalCv: 0.1, rationale: 'primary' }, // no analyte → primary
      { layer: 'analytical', proportionalCv: 0.5, analyte: 'metabolite', rationale: 'met' },
    ];
    expect(composeObservationError(layers, 'parent', 'parent')!.propCv).toBeCloseTo(0.1, 12);
    expect(composeObservationError(layers, 'metabolite', 'parent')!.propCv).toBeCloseTo(0.5, 12);
  });

  it('throws on a non-physical layer (negative or non-finite cv/sd)', () => {
    for (const bad of [
      { layer: 'x', proportionalCv: -0.1, rationale: 'r' },
      { layer: 'x', additiveSd: Number.NaN, rationale: 'r' },
      { layer: 'x', additiveSd: -1, rationale: 'r' },
    ] as ObservationErrorLayer[]) {
      expect(() => composeObservationError([bad], 'drug', 'drug')).toThrow();
    }
  });

  it('throws on an empty layer that declares no error component', () => {
    for (const empty of [
      { layer: 'x', rationale: 'r' }, // both omitted
      { layer: 'x', proportionalCv: 0, additiveSd: 0, rationale: 'r' }, // both zero
    ] as ObservationErrorLayer[]) {
      expect(() => composeObservationError([empty], 'drug', 'drug')).toThrow();
    }
  });

  it('throws when a finite component overflows the composed variance', () => {
    const huge: ObservationErrorLayer = { layer: 'x', additiveSd: 1e308, rationale: 'r' };
    expect(() => composeObservationError([huge], 'drug', 'drug')).toThrow();
  });
});

describe('SC-5B — widenBandForObservationError', () => {
  const flat = (m: number): CurvePoint => ({ tHours: 1, median: m, p05: m, p25: m, p75: m, p95: m });

  it('is a no-op when there is no error', () => {
    const p = { tHours: 1, median: 10, p05: 8, p25: 9, p75: 11, p95: 12 };
    expect(widenBandForObservationError(p, 0, 0)).toEqual(p);
  });

  it('builds a symmetric normal band on a deterministic (flat) point, median unchanged', () => {
    const sd = 2;
    const w = widenBandForObservationError(flat(10), 0, sd);
    expect(w.median).toBe(10);
    expect(w.p95).toBeCloseTo(10 + Z95 * sd, 12);
    expect(w.p05).toBeCloseTo(10 - Z95 * sd, 12);
    expect(w.p75).toBeCloseTo(10 + Z75 * sd, 12);
    expect(w.p25).toBeCloseTo(10 - Z75 * sd, 12);
  });

  it('uses the proportional CV against the concentration on a flat point', () => {
    const cv = 0.1;
    const w = widenBandForObservationError(flat(20), cv, 0);
    expect(w.p95).toBeCloseTo(20 + Z95 * (cv * 20), 12);
  });

  it('truncates negative percentiles at zero', () => {
    const w = widenBandForObservationError(flat(1), 0, 2); // obsSd 2 ≫ median 1
    expect(w.p05).toBe(0);
    expect(w.p25).toBe(0);
    expect(w.median).toBe(1);
    expect(w.p95).toBeGreaterThan(1);
  });

  it('widens a median-centred MC band in variance while preserving shape and median', () => {
    const p: CurvePoint = { tHours: 1, median: 10, p05: 8, p25: 9, p75: 11, p95: 12 };
    const paramSd = (p.p95 - p.p05) / (2 * Z95);
    const addSd = paramSd; // equal observation SD → total SD = √2 · paramSd
    const w = widenBandForObservationError(p, 0, addSd);
    const factor = Math.sqrt(2);
    const c = (p.p05 + p.p95) / 2; // = 10 = median here
    expect(w.median).toBe(10);
    expect(w.p95).toBeCloseTo(c + (p.p95 - c) * factor, 12);
    expect(w.p05).toBeCloseTo(c + (p.p05 - c) * factor, 12);
    expect(w.p75).toBeCloseTo(c + (p.p75 - c) * factor, 12);
    expect(w.p95 - w.p05).toBeGreaterThan(p.p95 - p.p05);
  });

  it('scales proportional error off the BAND concentration, not the median (median=0 still widens)', () => {
    // The reported median is 0 (deterministic central), but the sampled band is at positive
    // concentrations. Proportional error scaled off the median would add nothing; it must
    // scale off the band's own concentration so the bands actually widen.
    const p: CurvePoint = { tHours: 1, median: 0, p05: 10, p25: 15, p75: 25, p95: 30 };
    const w = widenBandForObservationError(p, 0.1, 0); // proportional only
    expect(w.median).toBe(0);
    expect(w.p95).toBeGreaterThan(30); // widened outward...
    expect(w.p05).toBeLessThan(10); // ...both ways, around the band centre (20)
    expect((w.p05 + w.p95) / 2).toBeCloseTo(20, 9);
  });

  it('convolves around the BAND centre, not the median — an offset band widens BOTH ways', () => {
    // The reported median is the deterministic central curve, INDEPENDENT of the sampled
    // band: here the whole band sits ABOVE the median. Adding residual error must introduce
    // LOWER observations (p05 decreases), not push the band further from the median.
    const p: CurvePoint = { tHours: 1, median: 10, p05: 20, p25: 23, p75: 27, p95: 30 };
    const c = (p.p05 + p.p95) / 2; // 25
    const paramSd = (p.p95 - p.p05) / (2 * Z95);
    const w = widenBandForObservationError(p, 0, paramSd); // obsSd = paramSd → factor √2
    const factor = Math.sqrt(2);
    expect(w.median).toBe(10); // unchanged
    expect(w.p05).toBeCloseTo(c + (p.p05 - c) * factor, 12);
    expect(w.p05).toBeLessThan(p.p05); // ↓ lower observations introduced (the bug fix)
    expect(w.p95).toBeGreaterThan(p.p95); // ↑ higher observations too
    // Band centre is preserved; the band widens symmetrically around it.
    expect((w.p05 + w.p95) / 2).toBeCloseTo(c, 9);
  });
});

const subject: CanonicalSubject = { weightKg: 80 };
describe('SC-5B — inert without a declared error model', () => {
  it('leaves the bands and manifest unchanged for a model with no observation error', () => {
    const scenario: CanonicalScenario = {
      schemaVersion: '1',
      analyte: 'amphetamine',
      subject,
      doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
      timeGrid: { startHours: 0, endHours: 12, stepHours: 1 },
    };
    const res = simulateScenario(scenario, '2026-08-21T00:00:00.000Z');
    if (!res.ok) throw new Error(`expected ok, got ${res.failure}`);
    expect(res.manifest.observationError).toBeUndefined();
    // Deterministic run: bands are flat (no widening applied).
    for (const p of res.timeSeries) {
      expect(p.p05).toBe(p.median);
      expect(p.p95).toBe(p.median);
    }
  });
});
