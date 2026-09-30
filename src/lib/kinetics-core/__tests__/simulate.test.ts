/**
 * kinetics-core engine behaviour: deterministic curve correctness, per-dose
 * route handling (the mixed-route fix), structured failures, MC plumbing, and
 * provenance stability.
 */
import { describe, it, expect } from 'vitest';
import { simulateScenario, peakRefineSchedule } from '../simulate';
import {
  concentrationOralFirstOrder,
  concentrationFromDoseIV,
  eliminationConstant,
} from '../equations';
import { CORE_VERSION } from '../version';
import { REGISTRY_CHECKSUM, findModel } from '../registry';
import type { CanonicalScenario } from '../types';

const NOW = '2026-07-21T00:00:00.000Z';

function baseSubject() {
  return { weightKg: 70, age: 30, sex: 'male' as const };
}

describe('simulateScenario — deterministic amphetamine', () => {
  it('reproduces the Bateman curve for a single oral dose', () => {
    const scenario: CanonicalScenario = {
      schemaVersion: '1',
      analyte: 'amphetamine',
      subject: baseSubject(),
      doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
      timeGrid: { startHours: 0, endHours: 12, stepHours: 0.5 },
    };
    const res = simulateScenario(scenario, NOW);
    if (!res.ok) throw new Error('expected ok');

    // Independent recomputation of the closed form (mg/L).
    const vd = 4.0 * 70;
    const ka = Math.LN2 / 1.0;
    const ke = eliminationConstant(11);
    for (const pt of res.timeSeries) {
      const expected = concentrationOralFirstOrder(30, vd, 0.8, ka, ke, pt.tHours);
      expect(pt.median).toBeCloseTo(expected, 12);
      // Deterministic run: every band collapses onto the median.
      expect(pt.p05).toBe(pt.median);
      expect(pt.p95).toBe(pt.median);
    }
    expect(res.unit).toBe('mg/L');
    expect(res.matrix).toBe('plasma');
    expect(res.peak.concentration).toBeGreaterThan(0);
  });

  it('uses each dose OWN route (mixed-route sessions, not first-route reuse)', () => {
    const mixed: CanonicalScenario = {
      schemaVersion: '1',
      analyte: 'amphetamine',
      subject: baseSubject(),
      doses: [
        { tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' },
        { tHours: 2, amountMg: 20, route: 'intranasal', basis: 'active-moiety' },
      ],
      timeGrid: { startHours: 0, endHours: 14, stepHours: 0.5 },
    };
    const res = simulateScenario(mixed, NOW);
    if (!res.ok) throw new Error('expected ok');

    // Superposition of an oral curve (ka slow) and an intranasal curve (ka fast,
    // shifted +2h). If the engine wrongly reused the first dose's route, the
    // second dose would rise slowly like an oral dose instead.
    const vd = 4.0 * 70;
    const ke = eliminationConstant(11);
    const kaOral = Math.LN2 / 1.0;
    const kaIN = Math.LN2 / (10 / 60);
    for (const pt of res.timeSeries) {
      const expected =
        concentrationOralFirstOrder(30, vd, 0.8, kaOral, ke, pt.tHours) +
        concentrationOralFirstOrder(20, vd, 0.7, kaIN, ke, pt.tHours - 2);
      expect(pt.median).toBeCloseTo(expected, 12);
    }
    // The two routes must be reported distinctly in the model summary.
    expect(res.modelSummary.routes.map((r) => r.route).sort()).toEqual([
      'intranasal',
      'oral',
    ]);
  });
});

describe('simulateScenario — IV bolus family (iv-one-compartment)', () => {
  it('peaks at t=0 with C = dose/Vd and decays first-order (cocaine iv)', () => {
    const weightKg = 75;
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject: { weightKg, age: 28, sex: 'male' },
        doses: [{ tHours: 0, amountMg: 40, route: 'iv', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 6, stepHours: 0.5 },
      },
      NOW,
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.ok === false ? res.failure : ''}`);

    // Bolus: highest concentration is at t=0 (no absorption rise), unlike oral.
    expect(res.peak.tHours).toBe(0);

    // C(t) = (dose/Vd)·e^(-ke·t); Vd = 2.7 L/kg · 75 kg, ke from t½ 1.5 h.
    const vdL = 2.7 * weightKg;
    const ke = eliminationConstant(1.5);
    for (const pt of res.timeSeries) {
      const expected = concentrationFromDoseIV(40, vdL, ke, pt.tHours);
      expect(pt.median).toBeCloseTo(expected, 9);
    }
    // Summary reports the IV family with no absorption rate / bioavailability.
    const ivRoute = res.modelSummary.routes.find((r) => r.route === 'iv')!;
    expect(ivRoute.family).toBe('iv-one-compartment');
    expect(ivRoute.kaPerHour).toBeNull();
    expect(ivRoute.bioavailability).toBeNull();
  });

  it('an oral route on the same analyte still rises to a later peak', () => {
    // Contrast: cocaine intranasal (first-order) peaks after t=0.
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject: { weightKg: 75, age: 28, sex: 'male' },
        doses: [{ tHours: 0, amountMg: 40, route: 'intranasal', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 6, stepHours: 0.5 },
      },
      NOW,
    );
    if (!res.ok) throw new Error('expected ok');
    expect(res.peak.tHours).toBeGreaterThan(0);
  });
});

describe('simulateScenario — grid-independent peak (linear families)', () => {
  // A fast-absorption route (smoked cocaine, absorption t½ ~1.1 min) peaks a few
  // minutes after dosing, BETWEEN samples of a coarse output grid. The reported
  // Cmax must be the true peak regardless of the caller's grid resolution, so a
  // coarse-grid consumer never reads a materially low SAFETY peak.
  const smoked = (stepHours: number, endHours: number): CanonicalScenario => ({
    schemaVersion: '1',
    analyte: 'cocaine',
    subject: { weightKg: 75, age: 28, sex: 'male' },
    doses: [{ tHours: 0, amountMg: 40, route: 'inhalation', basis: 'active-moiety' }],
    timeGrid: { startHours: 0, endHours, stepHours },
  });

  it('coarse and fine grids report the same peak, above every coarse sample', () => {
    const coarse = simulateScenario(smoked(0.5, 6), NOW);
    const fine = simulateScenario(smoked(0.005, 2), NOW);
    if (!coarse.ok || !fine.ok) throw new Error('expected ok');

    // The refined peak agrees across resolutions (to the internal sub-grid step).
    expect(coarse.peak.concentration).toBeCloseTo(fine.peak.concentration, 3);
    // The true peak falls between coarse samples, so it exceeds every coarse
    // grid value — the exact defect Codex flagged (grid-scan peak understated).
    const coarseSampleMax = Math.max(...coarse.timeSeries.map((p) => p.median));
    expect(coarse.peak.concentration).toBeGreaterThan(coarseSampleMax);
    // The peak time is early (minutes), not snapped to the 0.5 h grid.
    expect(coarse.peak.tHours).toBeGreaterThan(0);
    expect(coarse.peak.tHours).toBeLessThan(0.5);
  });

  it('never reports a peak below the output-grid maximum (monotone refinement)', () => {
    // A slow oral route lands its peak near a grid sample; refinement must not
    // move the peak DOWN — it is seeded from and floored by the grid scan.
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject: { weightKg: 75, age: 28, sex: 'male' },
        doses: [{ tHours: 0, amountMg: 100, route: 'oral', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 8, stepHours: 0.25 },
      },
      NOW,
    );
    if (!res.ok) throw new Error('expected ok');
    const sampleMax = Math.max(...res.timeSeries.map((p) => p.median));
    expect(res.peak.concentration).toBeGreaterThanOrEqual(sampleMax);
  });

  it('refines a peak far out in a long, coarsely-sampled window (dose-anchored)', () => {
    // Regression: a single inhalation dose at 5000 h in a 0–10000 h window sampled
    // only at its two endpoints. Because the refinement anchors to the DOSE (not a
    // uniform whole-window scan), it still resolves the true peak (~0.107 mg/L a few
    // minutes after 5000 h) despite the 10000 h output step — a uniform scan would
    // sample every ~0.5 h and understate it.
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject: { weightKg: 75, age: 28, sex: 'male' },
        doses: [{ tHours: 5000, amountMg: 40, route: 'inhalation', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 10000, stepHours: 10000 },
      },
      NOW,
    );
    if (!res.ok) throw new Error('expected ok');
    expect(res.peak.concentration).toBeGreaterThan(0.1);
    expect(res.peak.tHours).toBeGreaterThan(5000);
    expect(res.peak.tHours).toBeLessThan(5001);
  });

  it('post-window doses do not steal refinement slots from the in-window peak', () => {
    // One 40 mg dose inside the window, plus many LARGER doses scheduled long after
    // the window ends (they contribute nothing within it). Prioritizing purely by
    // amount would let the future doses consume every refinement slot and understate
    // the real in-window peak; post-window doses must be excluded as candidates.
    const doses = [
      { tHours: 0, amountMg: 40, route: 'inhalation' as const, basis: 'active-moiety' as const },
      ...Array.from({ length: 999 }, () => ({
        tHours: 1000,
        amountMg: 100,
        route: 'inhalation' as const,
        basis: 'active-moiety' as const,
      })),
    ];
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject: { weightKg: 75, age: 28, sex: 'male' },
        doses,
        timeGrid: { startHours: 0, endHours: 6, stepHours: 3 },
      },
      NOW,
    );
    if (!res.ok) throw new Error('expected ok');
    // The in-window peak (~0.107 mg/L from the 40 mg dose) must survive.
    expect(res.peak.concentration).toBeGreaterThan(0.1);
    expect(res.peak.tHours).toBeLessThan(1);
  });

  it('expired pre-window doses do not steal slots from the in-window peak', () => {
    // One 40 mg in-window dose plus many LARGER doses long BEFORE the window, fully
    // decayed by the time it starts. Ranking by raw amount would spend every slot on
    // the expired doses; ranking by in-window contribution keeps the real peak.
    const doses = [
      { tHours: 0, amountMg: 40, route: 'inhalation' as const, basis: 'active-moiety' as const },
      ...Array.from({ length: 999 }, () => ({
        tHours: -1000,
        amountMg: 100,
        route: 'inhalation' as const,
        basis: 'active-moiety' as const,
      })),
    ];
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject: { weightKg: 75, age: 28, sex: 'male' },
        doses,
        timeGrid: { startHours: 0, endHours: 6, stepHours: 3 },
      },
      NOW,
    );
    if (!res.ok) throw new Error('expected ok');
    expect(res.peak.concentration).toBeGreaterThan(0.1);
    expect(res.peak.tHours).toBeLessThan(1);
  });

  it('rejects a time origin too large to resolve the peak scale', () => {
    // |t| ~ 1e16 h: the grid step still advances, but the sub-step refinement width is
    // below the floating-point resolution, so the peak cannot be represented. Reject as
    // invalid-input rather than silently report an understated peak.
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject: { weightKg: 75, age: 28, sex: 'male' },
        doses: [{ tHours: 1e16, amountMg: 40, route: 'inhalation', basis: 'active-moiety' }],
        timeGrid: { startHours: 1e16, endHours: 1e16 + 100, stepHours: 10 },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('invalid-input');
  });

  it('rejects an unresolvable absorption origin even when boluses out-rank it', () => {
    // At t=1e16 the inhalation dose's peak time collapses to its administration instant,
    // so its ranked contribution reads 0 and smaller IV boluses would displace it from
    // the refined prefix. Origins are validated for ALL candidates up front, so the
    // unresolvable absorption peak is still rejected rather than silently coarse-peaked.
    const doses = [
      { tHours: 1e16, amountMg: 40, route: 'inhalation' as const, basis: 'active-moiety' as const },
      ...Array.from({ length: 20 }, () => ({
        tHours: 1e16,
        amountMg: 100,
        route: 'iv' as const,
        basis: 'active-moiety' as const,
      })),
    ];
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject: { weightKg: 75, age: 28, sex: 'male' },
        doses,
        timeGrid: { startHours: 1e16, endHours: 1e16 + 100, stepHours: 10 },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('invalid-input');
  });

  it('a fully-decayed pre-window dose at a huge historical origin stays valid', () => {
    // The dose's peak is long BEFORE the window (t=-1e16), so its in-window contribution
    // is ~0 at a representable boundary — the unresolvable-origin rejection must NOT fire
    // (it applies only to peaks that fall inside the window).
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject: { weightKg: 75, age: 28, sex: 'male' },
        doses: [{ tHours: -1e16, amountMg: 40, route: 'inhalation', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 6, stepHours: 3 },
      },
      NOW,
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.ok === false ? res.failure : ''}`);
    expect(res.peak.concentration).toBeLessThan(1e-6);
  });

  it('rejects a dose count too large to bound the peak analysis', () => {
    // Beyond ~MAX_PEAK_REFINE_EVALS/8 doses, even the minimum bounded scan (7 evals)
    // plus the reserved per-candidate ranking evaluations would exceed the eval
    // budget; reject as a structured non-result rather than run unbounded work.
    const doses = Array.from({ length: 400_001 }, () => ({
      tHours: 0,
      amountMg: 1,
      route: 'oral' as const,
      basis: 'active-moiety' as const,
    }));
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject: { weightKg: 75, age: 28, sex: 'male' },
        doses,
        timeGrid: { startHours: 0, endHours: 6, stepHours: 3 },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('invalid-input');
  });

  describe('peakRefineSchedule keeps the off-grid scan within its eval budget', () => {
    // The refinement loop's worst-case curveAt count: per refined dose, one
    // analytic-peak probe plus an inclusive per-dose scanWindow (ptsPer + 1 points);
    // plus the inclusive grid-argmax bracket (bracketPts + 1). This must never exceed
    // pointBudget — the earlier schedule ignored the probes and the inclusive +1,
    // overshooting by ~2·refinedDoses (the #365 defect). MIN_PEAK_REFINE_SCAN (7) is
    // the smallest budget the caller allows.
    const worstCaseEvals = (
      refinedDoses: number,
      ptsPer: number,
      bracketPts: number
    ): number => refinedDoses * (1 + (ptsPer + 1)) + (bracketPts + 1);

    const cases: Array<[pointBudget: number, candidates: number]> = [
      [7, 1], // the minimum admissible budget
      [7, 250_001], // budget floored, many candidates (the overflow-detection scenario)
      [200, 1],
      [2000, 1000],
      [20_000, 2], // few doses, generous budget
      [20_000, 100_000], // refinedDoses capped by budget, not candidates
    ];

    for (const [pointBudget, candidates] of cases) {
      it(`pointBudget=${pointBudget}, candidates=${candidates}`, () => {
        const { refinedDoses, ptsPer, bracketPts } = peakRefineSchedule(
          pointBudget,
          candidates
        );
        expect(refinedDoses).toBeGreaterThanOrEqual(1);
        expect(refinedDoses).toBeLessThanOrEqual(candidates);
        expect(ptsPer).toBeGreaterThanOrEqual(2);
        expect(bracketPts).toBeGreaterThanOrEqual(2);
        // The invariant: the true worst-case work fits the declared budget.
        expect(worstCaseEvals(refinedDoses, ptsPer, bracketPts)).toBeLessThanOrEqual(
          pointBudget
        );
      });
    }

    it('gives the argmax bracket a dedicated share, not the collapsed per-dose ptsPer', () => {
      // With many candidates competing, ptsPer floors at 2 — but the bracket (the
      // only scanner covering a superposition peak among unrefined doses) must stay
      // well-resolved rather than collapse with it.
      const { ptsPer, bracketPts } = peakRefineSchedule(2000, 1000);
      expect(ptsPer).toBe(2);
      expect(bracketPts).toBeGreaterThanOrEqual(200);
    });
  });

  it('captures a co-located superposition peak even when the dose count throttles refinement', () => {
    // 1,000 identical inhalation doses at t=0 superpose into one curve = 1000× a
    // single dose, peaking at the (shared) sub-grid absorption tmax. The eval
    // budget cannot refine all 1,000, but ranking by co-located-cluster
    // contribution refines a member of the cluster, whose window sees the FULL
    // superposition via curveAt — so the reported peak is ~1000×, not a starved
    // grid sample. (Regression guard for the schedule that collapsed the bracket
    // to 2 points and under-reported this peak.)
    const grid = { startHours: 0, endHours: 6, stepHours: 0.5 };
    const subject = { weightKg: 75, age: 28, sex: 'male' as const };
    const single = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject,
        doses: [{ tHours: 0, amountMg: 40, route: 'inhalation', basis: 'active-moiety' }],
        timeGrid: grid,
      },
      NOW,
    );
    const many = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject,
        doses: Array.from({ length: 1000 }, () => ({
          tHours: 0,
          amountMg: 40,
          route: 'inhalation' as const,
          basis: 'active-moiety' as const,
        })),
        timeGrid: grid,
      },
      NOW,
    );
    if (!single.ok || !many.ok) throw new Error('expected ok');
    // Superposition is exact: the 1000-dose Cmax is 1000× the single-dose Cmax.
    expect(many.peak.concentration).toBeCloseTo(1000 * single.peak.concentration, 4);
  });

  it('refines every distinct peak CLUSTER, not just the largest, under throttling', () => {
    // 1,000 doses in three co-located clusters: 400 at 0 h, 390 at 1 h, and 210
    // negligible. The global Cmax is the 1 h cluster's peak PLUS the 0 h cluster's
    // still-substantial residual (~1.1 h), which exceeds the larger 0 h cluster's own
    // peak. The eval budget throttles refinement; refining ONE representative per
    // cluster covers BOTH the 0 h and 1 h peaks. Spending every slot on the larger
    // 0 h cluster (the pre-dedup bug) would miss the 1 h peak, and on this coarse grid
    // the argmax bracket cannot resolve it either — reporting only the 0 h peak.
    const subject = { weightKg: 75, age: 28, sex: 'male' as const };
    const inh = (tHours: number, amountMg: number) => ({
      tHours,
      amountMg,
      route: 'inhalation' as const,
      basis: 'active-moiety' as const,
    });
    const doses = [
      ...Array.from({ length: 400 }, () => inh(0, 40)),
      ...Array.from({ length: 390 }, () => inh(1, 40)),
      ...Array.from({ length: 210 }, () => inh(2, 0.0001)),
    ];
    // Coarse grid ([0,1000] step 1000) samples neither absorption peak, so the
    // reported Cmax comes entirely from the off-grid refinement.
    const coarse = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject,
        doses,
        timeGrid: { startHours: 0, endHours: 1000, stepHours: 1000 },
      },
      NOW,
    );
    // Fine reference grid resolves the true global peak directly.
    const fine = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject,
        doses,
        timeGrid: { startHours: 0, endHours: 3, stepHours: 0.005 },
      },
      NOW,
    );
    if (!coarse.ok || !fine.ok) throw new Error('expected ok');
    // The coarse-grid refined peak matches the fine-grid true peak (both find the
    // global superposition near 1.1 h), which sits at the 1 h cluster, not 0 h.
    expect(coarse.peak.concentration).toBeCloseTo(fine.peak.concentration, 1);
    expect(coarse.peak.tHours).toBeGreaterThan(0.9);
  });

  it('accepts an IV bolus at a large origin (peak is at the representable instant)', () => {
    // A bolus peaks exactly at administration (the first grid sample), so a huge origin
    // needs no off-grid resolution and must NOT be rejected like an absorption route.
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject: { weightKg: 75, age: 28, sex: 'male' },
        doses: [{ tHours: 1e16, amountMg: 40, route: 'iv', basis: 'active-moiety' }],
        timeGrid: { startHours: 1e16, endHours: 1e16 + 100, stepHours: 10 },
      },
      NOW,
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.ok === false ? res.failure : ''}`);
    // Bolus Cmax = dose/Vd = 40 / (2.7·75) ≈ 0.1975 mg/L at administration.
    expect(res.peak.concentration).toBeCloseTo(40 / (2.7 * 75), 6);
  });

  it('refines within a single-sample window (span shorter than the step)', () => {
    // Window shorter than stepHours → one grid point (t=0). The grid scan alone
    // reports a spurious 0 peak; refinement must still find the true peak inside the
    // requested [0, 0.25] h window.
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject: { weightKg: 75, age: 28, sex: 'male' },
        doses: [{ tHours: 0, amountMg: 40, route: 'inhalation', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 0.25, stepHours: 0.5 },
      },
      NOW,
    );
    if (!res.ok) throw new Error('expected ok');
    expect(res.peak.concentration).toBeGreaterThan(0.1);
    expect(res.peak.tHours).toBeGreaterThan(0);
    expect(res.peak.tHours).toBeLessThan(0.25);
  });

  it('a huge output step does not spuriously fail (argmax bracket clamped)', () => {
    // stepHours ~ Number.MAX_VALUE → the grid-argmax bracket [seedT±step] would have
    // an infinite span; clamping the endpoints to the finite window keeps it finite,
    // so an otherwise-finite curve stays an ok result.
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject: { weightKg: 75, age: 28, sex: 'male' },
        doses: [{ tHours: 0, amountMg: 40, route: 'inhalation', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 1e308, stepHours: 1e308 },
      },
      NOW,
    );
    if (!res.ok) throw new Error(`expected ok, got ${res.ok === false ? res.failure : ''}`);
    expect(res.peak.concentration).toBeGreaterThan(0.1);
  });

  it('detects an overflowing peak even when doses exceed the refinement budget', () => {
    // A large dose count (admitted, but too many to refine each one finely): a
    // bounded scan around the largest cluster must still run so the between-sample
    // overflow is caught (structured non-result), not returned as an ok finite peak.
    const doses = Array.from({ length: 200_000 }, () => ({
      tHours: 0,
      amountMg: 1e308,
      route: 'inhalation' as const,
      basis: 'active-moiety' as const,
    }));
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject: { weightKg: 75, age: 28, sex: 'male' },
        doses,
        timeGrid: { startHours: 0, endHours: 100, stepHours: 50 },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('numerical-failure');
  });

  it('catches an overflow at the analytic peak even when the window scan is thinned', () => {
    // Under budget throttling the per-window scan is coarse enough to straddle the peak
    // at tmax; the analytic peak time is scanned explicitly, so an overflow that occurs
    // exactly there (finite grid AND finite window samples) is still a numerical-failure.
    const doses = Array.from({ length: 1000 }, () => ({
      tHours: 0,
      amountMg: 6.744259770847219e307,
      route: 'inhalation' as const,
      basis: 'active-moiety' as const,
    }));
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject: { weightKg: 75, age: 28, sex: 'male' },
        doses,
        timeGrid: { startHours: 0, endHours: 100, stepHours: 100 },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('numerical-failure');
  });

  it('a peak that overflows BETWEEN samples is a structured numerical-failure', () => {
    // Many enormous inhalation doses at t=0: every coarse grid sample is finite
    // (0 at t=0; large-but-finite as they decay), so the grid-sample overflow
    // guard passes — but the true peak a few minutes in overflows to Infinity.
    // The refinement must surface that as a numerical-failure, never an ok result
    // carrying Infinity (the structured-non-result contract).
    const doses = Array.from({ length: 1000 }, () => ({
      tHours: 0,
      amountMg: 1e308,
      route: 'inhalation' as const,
      basis: 'active-moiety' as const,
    }));
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'cocaine',
        subject: { weightKg: 75, age: 28, sex: 'male' },
        doses,
        timeGrid: { startHours: 0, endHours: 100, stepHours: 50 },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('numerical-failure');
  });
});

describe('simulateScenario — Monte-Carlo plumbing', () => {
  it('collapses bands to the median when params are fixed and is deterministic', () => {
    const scenario: CanonicalScenario = {
      schemaVersion: '1',
      analyte: 'amphetamine',
      subject: baseSubject(),
      doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
      timeGrid: { startHours: 0, endHours: 12, stepHours: 1 },
      uncertainty: { seed: 42, draws: 500 },
    };
    const a = simulateScenario(scenario, NOW);
    const b = simulateScenario(scenario, NOW);
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(a.status).toBe('ok');
    for (const pt of a.timeSeries) {
      expect(pt.p05).toBeCloseTo(pt.median, 12);
      expect(pt.p95).toBeCloseTo(pt.median, 12);
    }
    expect(a.timeSeries).toEqual(b.timeSeries); // seeded determinism
  });

  it('reports the deterministic median in MC mode (seed/draw-independent)', () => {
    const base = {
      schemaVersion: '1' as const,
      analyte: 'amphetamine',
      subject: baseSubject(),
      doses: [
        { tHours: 0, amountMg: 30, route: 'oral' as const, basis: 'active-moiety' as const },
      ],
      timeGrid: { startHours: 0, endHours: 12, stepHours: 1 },
    };
    const deterministic = simulateScenario(base, NOW);
    const mc = simulateScenario(
      { ...base, uncertainty: { seed: 123, draws: 250 } },
      NOW,
    );
    if (!deterministic.ok || !mc.ok) throw new Error('expected ok');
    // The median must be identical whether or not uncertainty is enabled — a
    // median-only consumer and a banded consumer derive the same median.
    for (let i = 0; i < deterministic.timeSeries.length; i++) {
      expect(mc.timeSeries[i]!.median).toBe(deterministic.timeSeries[i]!.median);
    }
  });
});

describe('simulateScenario — structured failures', () => {
  const subject = { weightKg: 70 };
  it('unknown analyte -> insufficient-model-data', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'nope',
        subject,
        doses: [{ tHours: 0, amountMg: 10, route: 'oral', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 4, stepHours: 1 },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('insufficient-model-data');
  });

  it('unsupported route -> unsupported-scenario (no silent zero curve)', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'amphetamine',
        subject,
        doses: [{ tHours: 0, amountMg: 10, route: 'iv', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 4, stepHours: 1 },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('unsupported-scenario');
  });

  it('wrong schema version -> incompatible-release', () => {
    const res = simulateScenario(
      {
        schemaVersion: '999',
        analyte: 'amphetamine',
        subject,
        doses: [{ tHours: 0, amountMg: 10, route: 'oral', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 4, stepHours: 1 },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('incompatible-release');
  });

  it('invalid input -> invalid-input', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'amphetamine',
        subject: { weightKg: 0 },
        doses: [{ tHours: 0, amountMg: 10, route: 'oral', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 4, stepHours: 1 },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('invalid-input');
  });
});

describe('simulateScenario — input hardening (no zod boundary)', () => {
  const subject = { weightKg: 70 };
  const grid = { startHours: 0, endHours: 4, stepHours: 1 };

  it('null / non-object scenario -> invalid-input, not a throw', () => {
    const bad = simulateScenario(null as never, NOW);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.failure).toBe('invalid-input');
    expect(() => simulateScenario(undefined as never, NOW)).not.toThrow();
  });

  it('non-numeric / non-finite subject weight -> invalid-input (no coercion)', () => {
    for (const weightKg of [true as never, "70" as never, NaN, Infinity, 0, -5]) {
      const res = simulateScenario(
        {
          schemaVersion: '1',
          analyte: 'amphetamine',
          subject: { weightKg },
          doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
          timeGrid: grid,
        },
        NOW,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.failure).toBe('invalid-input');
    }
  });

  it('non-finite dose amount -> invalid-input (no NaN/Infinity in an ok curve)', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'amphetamine',
        subject,
        doses: [{ tHours: 0, amountMg: Infinity, route: 'oral', basis: 'active-moiety' }],
        timeGrid: grid,
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('invalid-input');
  });

  it('unsupported dose basis (salt) -> unsupported-scenario, not a silent ok', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'amphetamine',
        subject,
        doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'salt' }],
        timeGrid: grid,
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('unsupported-scenario');
  });

  it('inherited route property (__proto__) -> unsupported-scenario', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'amphetamine',
        subject,
        doses: [{ tHours: 0, amountMg: 30, route: '__proto__' as never, basis: 'active-moiety' }],
        timeGrid: grid,
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('unsupported-scenario');
  });

  it('Infinity / non-integer draw counts -> invalid-input (bounded MC loop)', () => {
    for (const draws of [Infinity, 1e9, 2.5, 0]) {
      const res = simulateScenario(
        {
          schemaVersion: '1',
          analyte: 'amphetamine',
          subject,
          doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
          timeGrid: grid,
          uncertainty: { seed: 42, draws },
        },
        NOW,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.failure).toBe('invalid-input');
    }
  });

  it('non-finite time-grid step -> invalid-input', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'amphetamine',
        subject,
        doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 4, stepHours: Infinity },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('invalid-input');
  });

  it('time-grid step too small to advance (large origin) -> invalid-input, no hang', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'amphetamine',
        subject,
        doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
        timeGrid: { startHours: 1e16, endHours: 1e16, stepHours: 1 },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('invalid-input');
  });

  it('invalid matrix override -> invalid-input (contract not broken)', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'amphetamine',
        matrix: '' as never,
        subject,
        doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
        timeGrid: grid,
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('invalid-input');
  });

  it('scenario exceeding the combined compute budget -> invalid-input', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'amphetamine',
        subject,
        doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
        // 200k points within the grid cap, but × 300 draws blows the cell budget.
        timeGrid: { startHours: 0, endHours: 199999, stepHours: 1 },
        uncertainty: { seed: 42, draws: 300 },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('invalid-input');
  });

  it('present-but-invalid uncertainty (null / 0) -> invalid-input', () => {
    for (const uncertainty of [null as never, 0 as never, 'x' as never]) {
      const res = simulateScenario(
        {
          schemaVersion: '1',
          analyte: 'amphetamine',
          subject,
          doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
          timeGrid: grid,
          uncertainty,
        },
        NOW,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.failure).toBe('invalid-input');
    }
  });

  it('sub-kilogram weight -> invalid-input (not silently clamped)', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'amphetamine',
        subject: { weightKg: 0.5 },
        doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
        timeGrid: grid,
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('invalid-input');
  });

  it('present age/sex covariates the model ignores are surfaced as limitations', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'amphetamine',
        subject: { weightKg: 70, age: 30, sex: 'male' },
        doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
        timeGrid: grid,
      },
      NOW,
    );
    if (!res.ok) throw new Error('expected ok');
    const codes = res.limitations.map((l) => l.text);
    expect(codes.some((t) => t.includes('age'))).toBe(true);
    expect(codes.some((t) => t.includes('sex'))).toBe(true);
  });

  it('height sent to a total-weight model is surfaced as an ignored covariate', () => {
    // amphetamine is total-weight, so a hashed heightCm had no effect; the
    // consumer must be told rather than silently trusting it mattered.
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'amphetamine',
        subject: { weightKg: 70, heightCm: 180 },
        doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
        timeGrid: grid,
      },
      NOW,
    );
    if (!res.ok) throw new Error('expected ok');
    expect(res.limitations.some((l) => l.code === 'covariate-not-modelled' && l.text.includes('height'))).toBe(true);
  });

  it('height sent to a lean-body-mass model is NOT surfaced (it is consumed)', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'methylphenidate',
        subject: { weightKg: 70, heightCm: 180, sex: 'male' },
        doses: [{ tHours: 0, amountMg: 20, route: 'oral', basis: 'active-moiety' }],
        timeGrid: grid,
      },
      NOW,
    );
    if (!res.ok) throw new Error('expected ok');
    expect(res.limitations.some((l) => l.text.includes('height'))).toBe(false);
  });

  it('out-of-range seed -> invalid-input (PRNG is 32-bit)', () => {
    for (const seed of [-1, 4294967296, 2 ** 40]) {
      const res = simulateScenario(
        {
          schemaVersion: '1',
          analyte: 'amphetamine',
          subject,
          doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
          timeGrid: grid,
          uncertainty: { seed, draws: 10 },
        },
        NOW,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.failure).toBe('invalid-input');
    }
  });

  it('malformed subject covariates -> invalid-input', () => {
    const bad = [
      { weightKg: 70, sex: 'femalee' as never },
      { weightKg: 70, age: Infinity },
      { weightKg: 70, liverImpairment: 'sever' as never },
      { weightKg: 70, kidneyImpairment: 'bad' as never },
    ];
    for (const s of bad) {
      const res = simulateScenario(
        {
          schemaVersion: '1',
          analyte: 'amphetamine',
          subject: s,
          doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
          timeGrid: grid,
        },
        NOW,
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.failure).toBe('invalid-input');
    }
  });

  it('draws:1 runs an MC pass and reports acceptedDraws (no contradictory provenance)', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'amphetamine',
        subject,
        doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
        timeGrid: grid,
        uncertainty: { seed: 42, draws: 1 },
      },
      NOW,
    );
    if (!res.ok) throw new Error('expected ok');
    expect(res.manifest.draws).toBe(1);
    expect(res.manifest.acceptedDraws).toBe(1);
  });

  it('a failure manifest keeps a string analyte even for a numeric analyte input', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 42 as never,
        subject,
        doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
        timeGrid: grid,
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    expect(typeof res.manifest.analyte).toBe('string');
    expect(res.manifest.analyte).toBe('unknown');
  });

  it('a Symbol schemaVersion -> structured failure (no TypeError formatting it)', () => {
    let res!: ReturnType<typeof simulateScenario>;
    expect(() => {
      res = simulateScenario(
        {
          schemaVersion: Symbol('1') as never,
          analyte: 'amphetamine',
          subject,
          doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
          timeGrid: grid,
        },
        NOW,
      );
    }).not.toThrow();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('incompatible-release');
  });

  it('a Symbol route -> unsupported-scenario (no TypeError formatting the message)', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'amphetamine',
        subject,
        doses: [{ tHours: 0, amountMg: 30, route: Symbol('iv') as never, basis: 'active-moiety' }],
        timeGrid: grid,
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('unsupported-scenario');
  });

  it('valid scenarios with a circular extra still get distinct scenario hashes', () => {
    function withCircular(amountMg: number) {
      const s: Record<string, unknown> = {
        schemaVersion: '1',
        analyte: 'amphetamine',
        subject: { weightKg: 70 },
        doses: [{ tHours: 0, amountMg, route: 'oral', basis: 'active-moiety' }],
        timeGrid: grid,
      };
      s.self = s; // circular extra
      return s as never;
    }
    const a = simulateScenario(withCircular(30), NOW);
    const b = simulateScenario(withCircular(100), NOW);
    if (!a.ok || !b.ok) throw new Error('expected ok');
    // Distinct doses -> distinct hashes, and neither is the sentinel.
    expect(a.manifest.scenarioHash).not.toBe('unhashable');
    expect(a.manifest.scenarioHash).not.toBe(b.manifest.scenarioHash);
  });

  it('unserializable scenarios (circular / BigInt) do not throw', () => {
    // A BigInt field would make JSON.stringify throw during manifest hashing.
    const bigintScenario = {
      schemaVersion: '1',
      analyte: 'amphetamine',
      subject: { weightKg: 70n as never },
      doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
      timeGrid: grid,
    } as never;
    expect(() => simulateScenario(bigintScenario, NOW)).not.toThrow();
    const res = simulateScenario(bigintScenario, NOW);
    expect(res.ok).toBe(false); // BigInt weightKg is not a number -> invalid-input

    // A circular reference would make the recursive key-sort blow the stack.
    const circular: Record<string, unknown> = {
      schemaVersion: '1',
      analyte: 'amphetamine',
      subject: { weightKg: 70 },
      doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
      timeGrid: grid,
    };
    circular.self = circular;
    expect(() => simulateScenario(circular as never, NOW)).not.toThrow();
  });

  it('overflow to a non-finite curve -> numerical-failure (not an ok result)', () => {
    // Finite-but-huge dose totals that sum past Number.MAX_VALUE.
    const doses = Array.from({ length: 2000 }, () => ({
      tHours: 0,
      amountMg: Number.MAX_VALUE,
      route: 'oral' as const,
      basis: 'active-moiety' as const,
    }));
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'amphetamine',
        subject,
        doses,
        timeGrid: { startHours: 0, endHours: 4, stepHours: 1 },
      },
      NOW,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure).toBe('numerical-failure');
  });

  it('reports acceptedDraws in the manifest for an MC run', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'amphetamine',
        subject,
        doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
        timeGrid: grid,
        uncertainty: { seed: 42, draws: 100 },
      },
      NOW,
    );
    if (!res.ok) throw new Error('expected ok');
    expect(res.manifest.acceptedDraws).toBe(100);
    expect(res.manifest.draws).toBe(100);
  });
});

describe('registry immutability (provenance integrity)', () => {
  it('findModel returns a frozen model that cannot be mutated', () => {
    const m = findModel('amphetamine')!;
    expect(Object.isFrozen(m)).toBe(true);
    const oral = m.routes.oral!;
    expect(oral.family).toBe('one-compartment-first-order');
    expect(() => {
      // Frozen at runtime: assignment throws in strict mode (ES modules).
      if (oral.family === 'one-compartment-first-order') {
        oral.bioavailability = { kind: 'fixed', value: 0.1 };
      }
    }).toThrow();
  });
});

describe('simulateScenario — covariate policy & provenance', () => {
  it('surfaces a limitation for an unmodelled covariate rather than adjusting silently', () => {
    const res = simulateScenario(
      {
        schemaVersion: '1',
        analyte: 'amphetamine',
        subject: { weightKg: 70, liverImpairment: 'severe' },
        doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
        timeGrid: { startHours: 0, endHours: 4, stepHours: 1 },
      },
      NOW,
    );
    if (!res.ok) throw new Error('expected ok');
    expect(res.limitations.some((l) => l.code === 'covariate-not-modelled')).toBe(true);
  });

  it('stamps a stable provenance manifest', () => {
    const scenario: CanonicalScenario = {
      schemaVersion: '1',
      analyte: 'amphetamine',
      subject: baseSubject(),
      doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
      timeGrid: { startHours: 0, endHours: 4, stepHours: 1 },
    };
    const res = simulateScenario(scenario, NOW);
    if (!res.ok) throw new Error('expected ok');
    expect(res.manifest.coreVersion).toBe(CORE_VERSION);
    expect(res.manifest.registryChecksum).toBe(REGISTRY_CHECKSUM);
    expect(res.manifest.modelId).toBe('amphetamine-one-comp-v1');
    expect(res.manifest.createdAtIso).toBe(NOW);
    // Scenario hash is stable for identical input.
    expect(simulateScenario(scenario, NOW).manifest.scenarioHash).toBe(
      res.manifest.scenarioHash,
    );
  });
});
