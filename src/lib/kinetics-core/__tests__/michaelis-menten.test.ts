/**
 * Michaelis–Menten (saturable-elimination) family: the ethanol / GHB port. Tests
 * the defining nonlinear signature (fractional clearance rises as concentration
 * falls — a first-order drug would clear at a constant fraction), ODE convergence,
 * the covariate requirements of the Vd-scaling modes (lean-body-mass, widmark),
 * and the resolved-summary contract (Vmax/Km must be diffable from the result).
 * Cross-runtime parity against Redose's RK4 is measured in the Redose repo, which
 * vendors this engine; the golden parity fixtures cover the numeric curves here.
 */
import { describe, it, expect } from 'vitest';
import { simulateScenario } from '../simulate';
import { widmarkFactor, totalBodyWaterL } from '../scaling';
import { mmClearanceHorizonHours } from '../models/michaelis-menten';
import type { CanonicalScenario, CanonicalSubject } from '../types';

const NOW = '2026-07-21T00:00:00.000Z';
const subject: CanonicalSubject = { weightKg: 80, heightCm: 180, age: 35, sex: 'male' };

function ghb(
  doses: CanonicalScenario['doses'],
  stepHours = 0.25,
  endHours = 8,
): CanonicalScenario {
  return { schemaVersion: '1', analyte: 'ghb', subject, doses, timeGrid: { startHours: 0, endHours, stepHours } };
}
function ethanol(
  doses: CanonicalScenario['doses'],
  stepHours = 0.5,
  endHours = 12,
): CanonicalScenario {
  return { schemaVersion: '1', analyte: 'ethanol', subject, doses, timeGrid: { startHours: 0, endHours, stepHours } };
}

describe('Michaelis–Menten (ethanol / GHB) family', () => {
  it('produces a rise-peak-decay curve and reports the family + Vmax/Km in the summary', () => {
    const res = simulateScenario(
      ghb([{ tHours: 0, amountMg: 1500, route: 'oral', basis: 'active-moiety' }]),
      NOW,
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.ok === false ? res.failure : ''}`);
    expect(res.peak.tHours).toBeGreaterThan(0);
    expect(res.peak.concentration).toBeGreaterThan(0);
    const late = res.timeSeries[res.timeSeries.length - 1]!;
    expect(late.median).toBeGreaterThanOrEqual(0);
    expect(late.median).toBeLessThan(res.peak.concentration);
    const r = res.modelSummary.routes[0]!;
    expect(r.family).toBe('michaelis-menten');
    // Vmax/Km are curve-defining and not catalog-checkable: they must be readable
    // from the result alone. GHB: 833 ng/mL/min → 49.98 mg/L/h; 40000 ng/mL → 40.
    expect(r.vmaxMgPerLPerHour).toBeCloseTo(833 * 0.001 * 60, 9);
    expect(r.kmMgPerL).toBeCloseTo(40, 9);
  });

  it('clears saturably: the fractional decline is SMALLER at high C than in the low tail', () => {
    // The hallmark of Michaelis–Menten elimination vs first-order: fractional
    // clearance (Vmax / (Km + C)) rises as C falls, so a fixed-length window
    // removes a SMALLER fraction near the (saturated) peak than in the low tail.
    // A one-compartment drug would remove the same fraction in both windows.
    const res = simulateScenario(
      ethanol([{ tHours: 0, amountMg: 30000, route: 'oral', basis: 'active-moiety' }], 0.5, 16),
      NOW,
    );
    if (!res.ok) throw new Error('expected ok');
    const at = (h: number) =>
      res.timeSeries.reduce((b, p) => (Math.abs(p.tHours - h) < Math.abs(b.tHours - h) ? p : b)).median;
    // Just after the peak, concentration is high (saturated regime, C ≫ Km=80).
    const highStart = at(1.5);
    const highEnd = at(2.5);
    // Deep in the tail, concentration is low (C approaches / below Km).
    const lowStart = at(9);
    const lowEnd = at(10);
    expect(highStart).toBeGreaterThan(160); // well above Km
    expect(lowStart).toBeGreaterThan(0);
    expect(lowStart).toBeLessThan(highStart);
    const fracHigh = (highStart - highEnd) / highStart;
    const fracLow = (lowStart - lowEnd) / lowStart;
    expect(fracLow).toBeGreaterThan(fracHigh);
  });

  it('ODE converges: halving the step changes the curve within a tight tolerance', () => {
    const coarse = simulateScenario(ghb([{ tHours: 0, amountMg: 1500, route: 'oral', basis: 'active-moiety' }], 1 / 30), NOW);
    const fine = simulateScenario(ghb([{ tHours: 0, amountMg: 1500, route: 'oral', basis: 'active-moiety' }], 1 / 120), NOW);
    if (!coarse.ok || !fine.ok) throw new Error('expected ok');
    const fineByT = new Map(fine.timeSeries.map((p) => [Number(p.tHours.toFixed(6)), p.median]));
    let maxRel = 0;
    for (const p of coarse.timeSeries) {
      const f = fineByT.get(Number(p.tHours.toFixed(6)));
      if (f === undefined) continue;
      const denom = Math.max(Math.abs(p.median), Math.abs(f), 1e-9);
      maxRel = Math.max(maxRel, Math.abs(p.median - f) / denom);
    }
    expect(maxRel).toBeLessThan(1e-2);
  });

  it('a redose keeps contributing (per-dose gut absorption, event timing)', () => {
    const single = simulateScenario(
      ghb([{ tHours: 0, amountMg: 1000, route: 'oral', basis: 'active-moiety' }]),
      NOW,
    );
    const redose = simulateScenario(
      ghb([
        { tHours: 0, amountMg: 1000, route: 'oral', basis: 'active-moiety' },
        { tHours: 2, amountMg: 1000, route: 'oral', basis: 'active-moiety' },
      ]),
      NOW,
    );
    if (!single.ok || !redose.ok) throw new Error('expected ok');
    const at = (r: typeof single, h: number) =>
      (r as typeof single & { ok: true }).timeSeries.reduce((b, p) =>
        Math.abs(p.tHours - h) < Math.abs(b.tHours - h) ? p : b,
      ).median;
    // After the second dose the redose curve is clearly higher than the single.
    expect(at(redose, 3)).toBeGreaterThan(at(single, 3));
  });

  it('GHB (lean-body-mass Vd) requires the subject height', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'ghb',
        subject: { weightKg: 80, sex: 'male' },
        doses: [{ tHours: 0, amountMg: 1500, route: 'oral', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 8, stepHours: 0.5 },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('invalid-input');
  });

  it('ethanol (Widmark Vd) requires the subject age', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'ethanol',
        subject: { weightKg: 80, heightCm: 180, sex: 'male' },
        doses: [{ tHours: 0, amountMg: 30000, route: 'oral', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 12, stepHours: 1 },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('invalid-input');
  });

  it('MDMA reuses the family with total-weight (lipophilic) scaling and shows auto-inhibition', () => {
    // MDMA's CYP2D6 auto-inhibition is the same saturable clearance; it uses
    // total-weight Vd scaling (Vd 6.5 L/kg lipophilic), unlike GHB/ethanol. A
    // second (smaller) dose lands while clearance is still saturated by the first,
    // so the concentration bump is disproportionate — the family captures this.
    const mdma = (doses: CanonicalScenario['doses']): CanonicalScenario => ({
      schemaVersion: '1',
      analyte: 'mdma',
      subject: { weightKg: 70, age: 28, sex: 'male' },
      doses,
      timeGrid: { startHours: 0, endHours: 12, stepHours: 0.5 },
    });
    const single = simulateScenario(mdma([{ tHours: 0, amountMg: 120, route: 'oral', basis: 'active-moiety' }]), NOW);
    const redose = simulateScenario(
      mdma([
        { tHours: 0, amountMg: 120, route: 'oral', basis: 'active-moiety' },
        { tHours: 2, amountMg: 60, route: 'oral', basis: 'active-moiety' },
      ]),
      NOW,
    );
    if (!single.ok || !redose.ok) throw new Error('expected ok');
    // MDMA needs no height/sex-based Vd (total-weight), so a minimal subject works.
    expect(single.modelSummary.routes[0]!.family).toBe('michaelis-menten');
    // The +60 mg redose lifts the later curve above the single-dose tail.
    const at = (r: typeof single & { ok: true }, h: number) =>
      r.timeSeries.reduce((b, p) => (Math.abs(p.tHours - h) < Math.abs(b.tHours - h) ? p : b)).median;
    expect(at(redose as typeof single & { ok: true }, 4)).toBeGreaterThan(at(single as typeof single & { ok: true }, 4));
  });

  it('the MM clearance horizon is dose-dependent (saturable) and monotonic in dose', () => {
    // Ethanol Vmax/Km (mg/L·h⁻¹, mg/L) and ka.
    const vmax = 0.000283 * 10000 * 60; // 169.8
    const km = 0.008 * 10000; // 80
    const ka = Math.LN2 / (15 / 60);
    // A realistic BAC-scale deposit clears well within the old fixed 500 h lookback…
    expect(mmClearanceHorizonHours(500, vmax, km, ka)).toBeLessThan(500);
    // …but a physically-absurd overdose stays non-negligible far longer (zero-order
    // ceiling), so a fixed lookback would wrongly drop it. Horizon grows with dose.
    expect(mmClearanceHorizonHours(200_000, vmax, km, ka)).toBeGreaterThan(500);
    expect(mmClearanceHorizonHours(400_000, vmax, km, ka)).toBeGreaterThan(
      mmClearanceHorizonHours(200_000, vmax, km, ka),
    );
    expect(mmClearanceHorizonHours(0, vmax, km, ka)).toBe(0);
  });

  it('retains a large saturable overdose beyond the fixed lookback (no silent zero)', () => {
    // A dose 600 h before the window — beyond the two-compartment 500 h fixed
    // lookback. A realistic dose there is fully cleared (dropped → zero), but a
    // physically-absurd overdose is still non-negligible and MUST be retained
    // rather than silently returning an all-zero (concentration-underestimating) curve.
    const eth = (amountMg: number): CanonicalScenario => ({
      schemaVersion: '1',
      analyte: 'ethanol',
      subject,
      doses: [{ tHours: -600, amountMg, route: 'oral', basis: 'active-moiety' }],
      timeGrid: { startHours: 0, endHours: 8, stepHours: 0.5 },
    });
    const realistic = simulateScenario(eth(30_000), NOW); // 30 g — long cleared by 600 h
    const overdose = simulateScenario(eth(12_300_000), NOW); // absurd — still present
    if (!realistic.ok || !overdose.ok) throw new Error('expected ok');
    expect(realistic.peak.concentration).toBe(0); // negligible → dropped
    expect(overdose.peak.concentration).toBeGreaterThan(0); // retained, not zeroed
  });

  it('judges pre-window saturable doses as a cluster, not independently', () => {
    // 20 ethanol doses of 400 g at −600 h. EACH one alone is fully cleared by the
    // window (a per-dose filter would drop them all → all-zero curve), but their
    // COMBINED mass keeps elimination saturated (zero-order) long enough to still be
    // present — so the cluster must be retained. This is the nonlinearity a per-dose
    // horizon misses.
    const preWindow = (amountMg: number, n: number): CanonicalScenario => ({
      schemaVersion: '1',
      analyte: 'ethanol',
      subject,
      doses: Array.from({ length: n }, () => ({
        tHours: -600,
        amountMg,
        route: 'oral' as const,
        basis: 'active-moiety' as const,
      })),
      timeGrid: { startHours: 0, endHours: 8, stepHours: 0.5 },
    });
    // One 400 g dose alone → individually negligible by the window (dropped → zero).
    const single = simulateScenario(preWindow(400_000, 1), NOW);
    // 20 of them together → combined mass still saturating → retained, nonzero.
    const cluster = simulateScenario(preWindow(400_000, 20), NOW);
    if (!single.ok || !cluster.ok) throw new Error('expected ok');
    expect(single.peak.concentration).toBe(0); // per-dose: each is cleared
    expect(cluster.peak.concentration).toBeGreaterThan(0); // aggregate is not
  });

  it('rejects a psilocin (active-moiety) dose for the parent-only psilocybin model', () => {
    // F folds the psilocybin→psilocin conversion, so accepting psilocin-equivalent
    // mg would double-convert and underestimate — the moiety basis is unsupported.
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'psilocybin',
        subject: { weightKg: 68, heightCm: 172, sex: 'female' },
        doses: [{ tHours: 0, amountMg: 25, route: 'oral', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 10, stepHours: 0.5 },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('unsupported-scenario');
  });

  it('resolves the psilocybin model under its psilocin catalog alias', () => {
    // A consumer keyed on the catalog/analytical identity `psilocin` must reach the
    // same curve as `psilocybin` (the model is the psilocin active moiety).
    const viaAlias = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'psilocin',
        subject: { weightKg: 68, heightCm: 172, sex: 'female' },
        doses: [{ tHours: 0, amountMg: 25, route: 'oral', basis: 'parent' }],
        timeGrid: { startHours: 0, endHours: 10, stepHours: 0.5 },
      },
      NOW,
    );
    if (!viaAlias.ok) throw new Error(`expected ok, got ${viaAlias.failure}`);
    expect(viaAlias.modelSummary.modelId).toBe('psilocybin-one-comp-v1');
  });

  it('flags a sex-coefficient fallback for Widmark scaling when sex is "other"', () => {
    // Widmark Vd is sex-specific; "other" falls back to the female coefficients, so
    // the run stays ok (a harm-reduction estimate is useful) but surfaces the
    // assumption as a warning rather than silently applying one coefficient set.
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'ethanol',
        subject: { weightKg: 80, heightCm: 180, age: 35, sex: 'other' },
        doses: [{ tHours: 0, amountMg: 30000, route: 'oral', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 12, stepHours: 0.5 },
      },
      NOW,
    );
    if (!res.ok) throw new Error('expected ok');
    const lim = res.limitations.find((l) => l.code === 'sex-coefficient-fallback');
    expect(lim).toBeDefined();
    expect(lim!.severity).toBe('warning');
  });

  it('widmarkFactor matches the legacy Watson-TBW formula and clamps to [0.4, 0.9]', () => {
    const r = widmarkFactor(subject);
    const expected = totalBodyWaterL(subject) / (subject.weightKg * 0.806);
    expect(r).toBeCloseTo(expected, 12);
    expect(r).toBeGreaterThanOrEqual(0.4);
    expect(r).toBeLessThanOrEqual(0.9);
    // A pathological body composition is clamped, never returned raw.
    const tiny = widmarkFactor({ weightKg: 300, heightCm: 150, age: 80, sex: 'female' });
    expect(tiny).toBeGreaterThanOrEqual(0.4);
    expect(tiny).toBeLessThanOrEqual(0.9);
  });
});
