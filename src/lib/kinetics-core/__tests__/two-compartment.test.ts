/**
 * Two-compartment (THC) family: bi-exponential shape, ODE convergence, the
 * per-dose gut compartments (mixed-route correctness), and numerical-failure
 * behaviour. Cross-runtime parity against Redose's RK4 is measured separately
 * (that comparison lives in the Redose repo, which vendors this engine).
 */
import { describe, it, expect } from 'vitest';
import { simulateScenario } from '../simulate';
import { deriveK10 } from '../models/two-compartment';
import type { CanonicalScenario } from '../types';

const NOW = '2026-07-21T00:00:00.000Z';
const subject = { weightKg: 70, age: 30, sex: 'male' as const };

function thc(
  doses: CanonicalScenario['doses'],
  stepHours = 0.5,
  endHours = 12,
): CanonicalScenario {
  return {
    schemaVersion: '1',
    analyte: 'thc',
    subject,
    doses,
    timeGrid: { startHours: 0, endHours, stepHours },
  };
}

describe('two-compartment (THC) family', () => {
  it('produces a bi-exponential curve: rises, peaks, then a long terminal tail', () => {
    const res = simulateScenario(
      thc([{ tHours: 0, amountMg: 10, route: 'inhalation', basis: 'active-moiety' }], 1 / 60),
      NOW,
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.ok === false ? res.failure : ''}`);
    // Inhaled THC absorbs in ~minutes → an early peak, not at t=0.
    expect(res.peak.tHours).toBeGreaterThan(0);
    expect(res.peak.tHours).toBeLessThan(0.5);
    expect(res.peak.concentration).toBeGreaterThan(0);
    // Long terminal tail: still clearly non-zero many hours later (t½ ≈ 28 h).
    const late = res.timeSeries[res.timeSeries.length - 1]!;
    expect(late.tHours).toBeGreaterThanOrEqual(11);
    expect(late.median).toBeGreaterThan(0);
    expect(late.median).toBeLessThan(res.peak.concentration);
    // Summary reports the two-compartment family.
    expect(res.modelSummary.routes[0]!.family).toBe('two-compartment-first-order');
  });

  it('ODE converges: halving the step changes the curve within a tight tolerance', () => {
    const coarse = simulateScenario(thc([{ tHours: 0, amountMg: 10, route: 'inhalation', basis: 'active-moiety' }], 1 / 30), NOW);
    const fine = simulateScenario(thc([{ tHours: 0, amountMg: 10, route: 'inhalation', basis: 'active-moiety' }], 1 / 120), NOW);
    if (!coarse.ok || !fine.ok) throw new Error('expected ok');
    // Compare at the shared 0.5 h-multiple times present in both grids.
    const fineByT = new Map(fine.timeSeries.map((p) => [Number(p.tHours.toFixed(6)), p.median]));
    let maxRel = 0;
    for (const p of coarse.timeSeries) {
      const f = fineByT.get(Number(p.tHours.toFixed(6)));
      if (f === undefined) continue;
      const denom = Math.max(Math.abs(p.median), Math.abs(f), 1e-9);
      maxRel = Math.max(maxRel, Math.abs(p.median - f) / denom);
    }
    // 2 min vs 30 s RK4 steps: converged well under 1%.
    expect(maxRel).toBeLessThan(1e-2);
  });

  it('mixed-route (inhaled then oral) uses each dose\'s own absorption (per-dose gut)', () => {
    // The oral dose (slow ka, low F) adds a delayed shoulder; the inhaled dose
    // (fast ka) drives the early peak. A single shared gut with one ka could not
    // reproduce both — this verifies the second dose actually contributes later.
    const res = simulateScenario(
      thc(
        [
          { tHours: 0, amountMg: 10, route: 'inhalation', basis: 'active-moiety' },
          { tHours: 3, amountMg: 30, route: 'oral', basis: 'active-moiety' },
        ],
        1 / 60,
        10,
      ),
      NOW,
    );
    if (!res.ok) throw new Error('expected ok');
    const at = (h: number) =>
      res.timeSeries.reduce((best, p) => (Math.abs(p.tHours - h) < Math.abs(best.tHours - h) ? p : best)).median;
    // Concentration just after the oral dose keeps contributing (curve at 4 h is
    // supported by the oral shoulder, not merely the inhaled tail).
    expect(at(4)).toBeGreaterThan(0);
    // Two distinct routes were resolved in the summary.
    expect(new Set(res.modelSummary.routes.map((r) => r.route)).size).toBe(2);
  });

  it('reports k12/k21 in the route summary (curve-defining, must be diffable)', () => {
    const res = simulateScenario(
      thc([{ tHours: 0, amountMg: 10, route: 'inhalation', basis: 'active-moiety' }], 1 / 30),
      NOW,
    );
    if (!res.ok) throw new Error('expected ok');
    const r = res.modelSummary.routes[0]!;
    expect(r.k12PerHour).toBeCloseTo(0.152 * 60, 6);
    expect(r.k21PerHour).toBeCloseTo(0.0173 * 60, 6);
  });

  it('ignores a dose scheduled after the requested horizon (bounded ODE span)', () => {
    // A far-future (typo/scheduled) dose must not change a short-window curve nor
    // make the integrator run out to it.
    const base = simulateScenario(
      thc([{ tHours: 0, amountMg: 10, route: 'inhalation', basis: 'active-moiety' }], 1 / 30, 6),
      NOW,
    );
    const withFuture = simulateScenario(
      thc(
        [
          { tHours: 0, amountMg: 10, route: 'inhalation', basis: 'active-moiety' },
          { tHours: 100000, amountMg: 10, route: 'inhalation', basis: 'active-moiety' },
        ],
        1 / 30,
        6,
      ),
      NOW,
    );
    if (!base.ok || !withFuture.ok) throw new Error('expected ok');
    for (let i = 0; i < base.timeSeries.length; i++) {
      expect(withFuture.timeSeries[i]!.median).toBeCloseTo(base.timeSeries[i]!.median, 12);
    }
  });

  it('drops a dose older than the lookback and returns an all-zero curve (no integration)', () => {
    // A dose 100000 h BEFORE a short window is fully eliminated long before the
    // window opens, so it is dropped by the lookback filter — no dose is retained,
    // the work budget is SKIPPED, and the curve is a clean all-zero (not a reject,
    // not a hanging minute-by-minute integration over the enormous pre-window span).
    const res = simulateScenario(
      thc(
        [{ tHours: -100000, amountMg: 10, route: 'inhalation', basis: 'active-moiety' }],
        1 / 30,
        6,
      ),
      NOW,
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.failure}`);
    expect(res.peak.concentration).toBe(0);
    for (const p of res.timeSeries) expect(p.median).toBe(0);
  });

  it('skips the empty pre-dose gap: a baseline far before the only dose does not integrate it', () => {
    // Outputs at 0 and 4,000,000 h with the sole (retained) dose at 3,999,999 h.
    // Integration must start at the dose, not at t=0 — otherwise it would grind
    // through ~4M h of empty state, and the OLD budget (span from t=0) would even
    // reject it. Post-fix the span is ~1 h: it runs, t=0 reads 0, the late point is
    // positive. `res.ok` is the regression guard (the pre-fix budget rejected this).
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'thc',
        subject,
        doses: [{ tHours: 3_999_999, amountMg: 10, route: 'inhalation', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 4_000_000, stepHours: 4_000_000 },
      },
      NOW,
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.failure}`);
    expect(res.timeSeries[0]!.tHours).toBe(0);
    expect(res.timeSeries[0]!.median).toBe(0); // nothing in the system before the dose
    expect(res.timeSeries[res.timeSeries.length - 1]!.median).toBeGreaterThan(0);
  });

  it('retains a large pre-window dose whose exponential tail is still non-negligible', () => {
    // A dose 800 h before the window — well beyond the old fixed 500 h lookback and
    // past a realistic dose's (conservative) clearance horizon. A realistic 10 mg
    // dose is negligible there (dropped → zero), but a very large/typo dose still
    // has a non-negligible terminal tail and MUST be retained (dose-dependent
    // horizon), not silently dropped to an all-zero curve.
    const thcAt = (amountMg: number, tHours: number): CanonicalScenario => ({
      schemaVersion: '1',
      analyte: 'thc',
      subject,
      doses: [{ tHours, amountMg, route: 'inhalation', basis: 'active-moiety' }],
      timeGrid: { startHours: 0, endHours: 6, stepHours: 0.5 },
    });
    const realistic = simulateScenario(thcAt(10, -800), NOW);
    const huge = simulateScenario(thcAt(50_000_000, -800), NOW);
    if (!realistic.ok || !huge.ok) throw new Error('expected ok');
    expect(realistic.peak.concentration).toBe(0); // negligible → dropped
    expect(huge.peak.concentration).toBeGreaterThan(0); // retained, not zeroed
  });

  it('drops an ancient irrelevant pre-window dose without dropping a relevant one', () => {
    // A relevant recent dose (-1 h) plus a clearly-negligible ancient dose
    // (-2,000,000 h). Keeping the whole bucket would push the integration start back
    // ~2M h and blow the compute budget; the dose-aware keep-threshold drops only
    // the ancient dose, so the run succeeds and matches the recent-dose-only curve.
    const base = {
      schemaVersion: '1' as const,
      analyte: 'thc',
      subject,
      timeGrid: { startHours: 0, endHours: 6, stepHours: 0.5 },
    };
    const recentOnly = simulateScenario(
      { ...base, doses: [{ tHours: -1, amountMg: 10, route: 'inhalation', basis: 'active-moiety' }] },
      NOW,
    );
    const withAncient = simulateScenario(
      {
        ...base,
        doses: [
          { tHours: -1, amountMg: 10, route: 'inhalation', basis: 'active-moiety' },
          { tHours: -2_000_000, amountMg: 1, route: 'inhalation', basis: 'active-moiety' },
        ],
      },
      NOW,
    );
    if (!recentOnly.ok || !withAncient.ok) throw new Error('expected ok (ancient dose dropped, not budget-rejected)');
    for (let i = 0; i < recentOnly.timeSeries.length; i++) {
      expect(withAncient.timeSeries[i]!.median).toBeCloseTo(recentOnly.timeSeries[i]!.median, 12);
    }
  });

  it('carries the RK4 solver policy on an ODE failure result (reproducible non-result)', () => {
    // A dose-count over the cap fails as invalid-input; the failure manifest must
    // still record the solver step so a non-result is as reproducible as a success.
    const doses = Array.from({ length: 2000 }, () => ({
      tHours: 0,
      amountMg: 1,
      route: 'inhalation' as const,
      basis: 'active-moiety' as const,
    }));
    const res = simulateScenario(thc(doses, 1 / 30, 6), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure).toBe('invalid-input');
      expect(res.manifest.solver).toBeDefined();
      expect(res.manifest.solver!.method).toBe('rk4');
    }
  });

  it('rejects an ODE run whose retained-dose work blows the compute budget', () => {
    // A dose 400 h before the window IS retained (within the 500 h lookback), so it
    // drives a ~406 h integration span. Combined with many Monte-Carlo draws the
    // total scalar work (span/step × draws × doses) exceeds MAX_ODE_WORK even though
    // the grid is tiny and the cells budget passes — reject as invalid-input rather
    // than grind through hundreds of millions of RK4 sub-steps.
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'thc',
        subject,
        doses: [{ tHours: -400, amountMg: 10, route: 'inhalation', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 6, stepHours: 1 / 30 },
        uncertainty: { seed: 1, draws: 20000 },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('invalid-input');
  });

  it('rejects an ODE run with a pathological dose count (O(doses) per sub-step)', () => {
    // The two-compartment derivative loops over one gut compartment per dose on
    // every RK4 sub-step, so thousands of doses would hang even within span/draw
    // budgets — reject as invalid-input.
    const doses = Array.from({ length: 2000 }, () => ({
      tHours: 0,
      amountMg: 1,
      route: 'inhalation' as const,
      basis: 'active-moiety' as const,
    }));
    const res = simulateScenario(thc(doses, 1 / 30, 6), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('invalid-input');
  });

  it('records the RK4 solver step in the manifest (ODE family only)', () => {
    // The two-compartment run reports its effective integration policy so an audit
    // log / vendored-fixture consumer can tell which step produced the curve.
    const res = simulateScenario(
      thc([{ tHours: 0, amountMg: 10, route: 'inhalation', basis: 'active-moiety' }], 1 / 30),
      NOW,
    );
    if (!res.ok) throw new Error('expected ok');
    expect(res.manifest.solver).toBeDefined();
    expect(res.manifest.solver!.method).toBe('rk4');
    // Requested 1/30 h is coarser than the family's 1/60 h cap, so the effective
    // internal step is the capped 1/60 h — that is what the manifest records.
    expect(res.manifest.solver!.stepHours).toBeCloseTo(1 / 60, 12);
  });

  it('deriveK10 falls back to the terminal rate when k21 <= beta (ill-conditioned)', () => {
    // Well-conditioned: k21 >> beta.
    expect(deriveK10(0.025, 9.12, 1.038)).toBeGreaterThan(0);
    // k21 <= beta → degenerate; return beta rather than a negative/NaN rate.
    expect(deriveK10(2, 0.1, 1)).toBe(2);
  });
});
