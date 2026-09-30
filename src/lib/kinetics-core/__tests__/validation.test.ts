/**
 * SC-7A — external-validation fixture/report format.
 *
 * The landmark computations are non-compartmental (they read only the reported curve), so
 * they are tested against exact synthetic series, and `validateFixture` is exercised
 * end-to-end against a registered IV model whose terminal half-life is analytically the
 * model's declared half-life (a pure-exponential IV bolus).
 */
import { describe, it, expect } from 'vitest';
import {
  computeAucLast,
  estimateTerminalHalfLife,
  validateFixture,
  renderValidationReport,
  type ValidationFixture,
} from '../validation';
import type { CanonicalScenario, CanonicalSubject, CurvePoint } from '../types';

const flat = (tHours: number, median: number): CurvePoint => ({
  tHours,
  median,
  p05: median,
  p25: median,
  p75: median,
  p95: median,
});

describe('SC-7A — computeAucLast', () => {
  it('is the exact trapezoidal area over the median', () => {
    // Triangle up then down: (0,0)-(1,10)-(2,0) → two triangles of area 5 each = 10.
    const ts = [flat(0, 0), flat(1, 10), flat(2, 0)];
    expect(computeAucLast(ts)).toBeCloseTo(10, 12);
  });

  it('is zero for a series shorter than two points', () => {
    expect(computeAucLast([])).toBe(0);
    expect(computeAucLast([flat(0, 5)])).toBe(0);
  });

  it('ignores non-advancing time intervals', () => {
    const ts = [flat(0, 0), flat(0, 10), flat(1, 10)]; // duplicate t=0 contributes nothing
    expect(computeAucLast(ts)).toBeCloseTo(10, 12); // only the [0,1] rectangle of height 10
  });
});

describe('SC-7A — estimateTerminalHalfLife', () => {
  it('recovers the half-life of a pure exponential decay exactly', () => {
    const ke = Math.LN2 / 3; // t½ = 3 h
    const ts: CurvePoint[] = [];
    for (let t = 0; t <= 24; t += 1) ts.push(flat(t, 100 * Math.exp(-ke * t)));
    expect(estimateTerminalHalfLife(ts)).toBeCloseTo(3, 6);
  });

  it('recovers the terminal half-life after an absorption peak', () => {
    // Rise to a peak at t=2, then pure exponential decay with t½ = 2 h.
    const ke = Math.LN2 / 2;
    const ts = [flat(0, 0), flat(1, 6), flat(2, 10)];
    for (let t = 3; t <= 16; t += 1) ts.push(flat(t, 10 * Math.exp(-ke * (t - 2))));
    expect(estimateTerminalHalfLife(ts)).toBeCloseTo(2, 6);
  });

  it('returns null when there is no resolvable terminal phase', () => {
    expect(estimateTerminalHalfLife([flat(0, 1), flat(1, 2), flat(2, 3)])).toBeNull(); // rising
    expect(estimateTerminalHalfLife([flat(0, 5), flat(1, 5)])).toBeNull(); // flat
  });

  it('isolates the terminal phase of a biexponential (best-fit λz), not the whole tail', () => {
    // C(t) = 50·e^-t + 50·e^-0.1t. The slow phase has t½ = ln2/0.1 ≈ 6.93 h. A single fit
    // over the entire post-peak tail folds in the fast (t½ ≈ 0.69 h) phase and reports
    // ≈5 h (the reported regression bias); best-fit terminal selection recovers ≈6.93 h.
    const ts: CurvePoint[] = [];
    for (let t = 0; t <= 12 + 1e-9; t += 0.25) {
      ts.push(flat(Number(t.toFixed(2)), 50 * Math.exp(-t) + 50 * Math.exp(-0.1 * t)));
    }
    const est = estimateTerminalHalfLife(ts);
    expect(est).not.toBeNull();
    expect(est!).toBeGreaterThan(6.3);
    expect(est!).toBeLessThan(7.3);
  });

  it('selects against the global-best fit, not a drifting pairwise near-tie', () => {
    // C(t) = 3·e^-0.2t + e^-0.1t, sampled every 0.25 h to 48 h. True terminal t½ = 6.93 h.
    // A pairwise near-tie rule accumulates sub-threshold deterioration across window sizes
    // and selects all 192 tail points → ~5.5 h; comparing every window against the GLOBAL
    // maximum adjusted R² keeps the fit on the terminal suffix.
    const ts: CurvePoint[] = [];
    for (let t = 0; t <= 48 + 1e-9; t += 0.25) {
      ts.push(flat(Number(t.toFixed(2)), 3 * Math.exp(-0.2 * t) + Math.exp(-0.1 * t)));
    }
    const est = estimateTerminalHalfLife(ts);
    expect(est).not.toBeNull();
    expect(est!).toBeGreaterThan(6.3); // not the ~5.5 h whole-tail regression
    expect(est!).toBeLessThan(7.1);
  });

  it('handles a fine grid in linear time (no Θ(n²) rescan, no argument-limit spread)', () => {
    // A pure exponential sampled on a fine grid: the incremental cumulative-sum scan must
    // return the exact half-life without slicing/refitting every suffix or spreading a huge
    // array into Math.max. 4000 points would be ~16M visits if it were Θ(n²) per window.
    const ke = Math.LN2 / 4; // t½ = 4 h
    const ts: CurvePoint[] = [];
    for (let i = 0; i <= 4000; i++) {
      const t = i * 0.01;
      ts.push(flat(t, 100 * Math.exp(-ke * t)));
    }
    const est = estimateTerminalHalfLife(ts);
    expect(est).not.toBeNull();
    expect(est!).toBeCloseTo(4, 4);
  });

  it('rejects a poorly log-linear tail (no coincidental λz from a curved profile)', () => {
    // [100, 99, 1] declines monotonically but is nowhere near log-linear (adjusted R² ≈ 0.5):
    // a curved / saturable profile that has not reached its terminal phase. It must return
    // null rather than a coincidental ~0.30 h slope that could pass against a literature value.
    expect(estimateTerminalHalfLife([flat(0, 100), flat(1, 99), flat(2, 1)])).toBeNull();
  });

  it('does not span a later dose: a sub-Cmax bump near the grid end yields null', () => {
    // 4 h exponential from 100 at t=0, plus an 80-unit dose at t=20 that stays below the
    // original Cmax and lands too near the grid end to leave three declining samples. The fit
    // must not cross the second administration and report a plausible ~4.6 h — it must reject.
    const ke = Math.LN2 / 4;
    const ts: CurvePoint[] = [];
    for (let t = 0; t <= 21; t++) {
      const c = 100 * Math.exp(-ke * t) + (t >= 20 ? 80 * Math.exp(-ke * (t - 20)) : 0);
      ts.push(flat(t, c));
    }
    expect(estimateTerminalHalfLife(ts)).toBeNull();
  });

  it('bounds the terminal phase to after the last input (event-time bound)', () => {
    // Pure exponential (t½ = 3 h). The optional bound excludes samples at/before the last
    // input's end — catching an input that only slows the decline without a visible rise.
    const ke = Math.LN2 / 3;
    const ts: CurvePoint[] = [];
    for (let t = 0; t <= 24; t++) ts.push(flat(t, 100 * Math.exp(-ke * t)));
    expect(estimateTerminalHalfLife(ts)).toBeCloseTo(3, 6); // no bound → full terminal
    expect(estimateTerminalHalfLife(ts, 10)).toBeCloseTo(3, 6); // ≥3 samples after t=10
    expect(estimateTerminalHalfLife(ts, 23)).toBeNull(); // only t=23,24 remain → no phase
  });

  it('recovers the half-life on a time axis with a large nonzero origin (stable centring)', () => {
    // The canonical time axis permits a large origin. ln(C) is exactly linear in absolute t
    // (a constant time shift only moves the intercept), so the slope is −ke regardless of
    // origin — but raw ΣT² − (ΣT)²/n cancels catastrophically at t ≈ 1e12 and would report
    // no terminal phase. The Welford-centred accumulation recovers the half-life.
    const ke = Math.LN2 / 5; // t½ = 5 h
    const t0 = 1e12;
    const ts: CurvePoint[] = [];
    for (let i = 0; i <= 30; i++) ts.push(flat(t0 + i * 10, 100 * Math.exp(-ke * i * 10)));
    const est = estimateTerminalHalfLife(ts);
    expect(est).not.toBeNull();
    expect(est!).toBeCloseTo(5, 4);
  });
});

const subject: CanonicalSubject = { weightKg: 80 };
const NOW = '2026-08-21T00:00:00.000Z';
const REF = ['kinetics-core registry: cocaine IV disposition (declared terminal t½ 1.5 h)'];

function cocaineIv(): CanonicalScenario {
  return {
    schemaVersion: '1',
    analyte: 'cocaine',
    subject,
    doses: [{ tHours: 0, amountMg: 100, route: 'iv', basis: 'active-moiety' }],
    timeGrid: { startHours: 0, endHours: 12, stepHours: 0.25 },
  };
}

describe('SC-7A — validateFixture end-to-end', () => {
  it('passes when the computed terminal half-life matches the reviewed value', () => {
    // Cocaine IV is a pure-exponential bolus with a declared terminal t½ of 1.5 h, so the
    // NCA terminal-slope estimate recovers it independent of the (unasserted) amplitude.
    const fixture: ValidationFixture = {
      id: 'cocaine-iv-terminal-t-half',
      description: 'Cocaine IV bolus terminal half-life',
      scenario: cocaineIv(),
      expected: { terminalHalfLifeHours: { value: 1.5, relTol: 0.02 } },
      references: REF,
    };
    const report = validateFixture(fixture, NOW);
    expect(report.simulated).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.comparisons[0]!.computed).toBeCloseTo(1.5, 3);
    expect(report.references).toEqual(REF); // provenance preserved on the report
  });

  it('fails a fixture whose expected landmark is wrong', () => {
    const fixture: ValidationFixture = {
      id: 'cocaine-iv-wrong',
      description: 'Deliberately wrong expectation',
      scenario: cocaineIv(),
      expected: { terminalHalfLifeHours: { value: 5, relTol: 0.02 } },
      references: REF,
    };
    const report = validateFixture(fixture, NOW);
    expect(report.simulated).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.comparisons[0]!.pass).toBe(false);
  });

  it('does not let a non-finite tolerance pass an arbitrary result', () => {
    // Cocaine IV terminal t½ ≈ 1.5 h; expecting 5 h must FAIL even though the fixture
    // (accidentally) declares an infinite tolerance that would otherwise accept anything.
    for (const bad of [
      { value: 5, absTol: Infinity },
      { value: 5, relTol: Infinity },
      { value: 5, absTol: -1, relTol: Number.NaN },
    ]) {
      const report = validateFixture(
        {
          id: 'cocaine-iv-bad-tol',
          description: 'Non-finite / negative tolerance',
          scenario: cocaineIv(),
          expected: { terminalHalfLifeHours: bad },
          references: REF,
        },
        NOW,
      );
      expect(report.simulated).toBe(true);
      expect(report.passed).toBe(false);
      expect(report.comparisons[0]!.pass).toBe(false);
    }
  });

  it('fails a fixture with no cited source (missing provenance), without simulating', () => {
    const fixture: ValidationFixture = {
      id: 'cocaine-iv-no-source',
      description: 'No references',
      scenario: cocaineIv(),
      expected: { terminalHalfLifeHours: { value: 1.5, relTol: 0.02 } },
      references: [],
    };
    const report = validateFixture(fixture, NOW);
    expect(report.simulated).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.comparisons).toEqual([]);
    expect(report.failure).toContain('missing-provenance');
  });

  it('rejects a blank / whitespace-only source as missing provenance', () => {
    const fixture: ValidationFixture = {
      id: 'cocaine-iv-blank-source',
      description: 'Whitespace-only reference',
      scenario: cocaineIv(),
      expected: { terminalHalfLifeHours: { value: 1.5, relTol: 0.02 } },
      references: ['   '],
    };
    const report = validateFixture(fixture, NOW);
    expect(report.simulated).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.failure).toContain('missing-provenance');
  });

  it('keeps only real citations, dropping blank entries, when some are valid', () => {
    const fixture: ValidationFixture = {
      id: 'cocaine-iv-mixed-source',
      description: 'One blank, one real reference',
      scenario: cocaineIv(),
      expected: { terminalHalfLifeHours: { value: 1.5, relTol: 0.02 } },
      references: ['  ', REF[0]!],
    };
    const report = validateFixture(fixture, NOW);
    expect(report.simulated).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.references).toEqual(REF); // blank dropped, real citation kept
  });

  it('ignores a dose scheduled after the reported window when bounding λz', () => {
    // A second IV dose at t=100 h lies past the 12 h horizon: the simulator ignores it, so the
    // terminal cutoff must ignore it too (otherwise the bound exceeds every sample and nulls an
    // unchanged curve). The terminal half-life must still resolve to the model's 1.5 h.
    const scenario: CanonicalScenario = {
      ...cocaineIv(),
      doses: [
        { tHours: 0, amountMg: 100, route: 'iv', basis: 'active-moiety' },
        { tHours: 100, amountMg: 100, route: 'iv', basis: 'active-moiety' },
      ],
    };
    const report = validateFixture(
      {
        id: 'cocaine-iv-post-window-dose',
        description: 'Dose after the horizon',
        scenario,
        expected: { terminalHalfLifeHours: { value: 1.5, relTol: 0.02 } },
        references: REF,
      },
      NOW,
    );
    expect(report.simulated).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.comparisons[0]!.computed).toBeCloseTo(1.5, 3);
  });

  it('ignores a zero-effect dose whose onset is exactly at the horizon', () => {
    // A second ORAL (first-order) dose at exactly t=12 h has zero concentration at the only
    // sample it could touch, so the curve is unchanged; its onset must not bound the terminal
    // phase to the final timestamp and null an otherwise resolvable λz.
    const scenario: CanonicalScenario = {
      schemaVersion: '1',
      analyte: 'amphetamine',
      subject,
      doses: [
        { tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' },
        { tHours: 12, amountMg: 30, route: 'oral', basis: 'active-moiety' },
      ],
      timeGrid: { startHours: 0, endHours: 12, stepHours: 0.25 },
    };
    const report = validateFixture(
      {
        id: 'amph-boundary-dose',
        description: 'Dose onset at the horizon',
        scenario,
        expected: { terminalHalfLifeHours: { value: 11, relTol: 0.3 } },
        references: REF,
      },
      NOW,
    );
    expect(report.simulated).toBe(true);
    expect(report.comparisons[0]!.computed).not.toBeNull(); // terminal resolved, not spuriously null
  });

  it('bounds the terminal phase at a boundary IV bolus (instantaneous input counts)', () => {
    // Unlike a first-order dose (zero at onset), an IV bolus at exactly the horizon delivers its
    // full contribution at the last sample, so it DOES bound the terminal phase — leaving no
    // clean terminal decline after it and yielding null rather than a fit drawn across the dose.
    const scenario: CanonicalScenario = {
      ...cocaineIv(),
      doses: [
        { tHours: 0, amountMg: 100, route: 'iv', basis: 'active-moiety' },
        { tHours: 12, amountMg: 100, route: 'iv', basis: 'active-moiety' },
      ],
    };
    const report = validateFixture(
      {
        id: 'cocaine-iv-boundary-bolus',
        description: 'IV bolus at the horizon',
        scenario,
        expected: { terminalHalfLifeHours: { value: 1.5, relTol: 0.02 } },
        references: REF,
      },
      NOW,
    );
    expect(report.simulated).toBe(true);
    expect(report.comparisons[0]!.computed).toBeNull(); // bolus counts → no resolvable terminal
  });

  it('reports a simulation failure without comparisons', () => {
    const fixture: ValidationFixture = {
      id: 'no-such-analyte',
      description: 'Unknown analyte',
      scenario: { ...cocaineIv(), analyte: 'not-a-real-drug' },
      expected: { cmax: { value: 1, relTol: 0.1 } },
      references: ['n/a'],
    };
    const report = validateFixture(fixture, NOW);
    expect(report.simulated).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.comparisons).toEqual([]);
    expect(report.failure).toContain('insufficient-model-data');
  });

  it('renders a small relative tolerance without rounding it to zero', () => {
    const report = validateFixture(
      {
        id: 'cocaine-iv-tight-tol',
        description: 'Tight relative tolerance',
        scenario: cocaineIv(),
        expected: { terminalHalfLifeHours: { value: 1.5, relTol: 0.0004 } },
        references: REF,
      },
      NOW,
    );
    const md = renderValidationReport([report]);
    expect(md).toContain('0.04%'); // not rounded to ±0.0%
    expect(md).not.toContain('±0.0%');
  });

  it('renders a Markdown report with a pass/fail summary and the source', () => {
    const report = validateFixture(
      {
        id: 'cocaine-iv',
        description: 'x',
        scenario: cocaineIv(),
        expected: { terminalHalfLifeHours: { value: 1.5, relTol: 0.02 } },
        references: REF,
      },
      NOW,
    );
    const md = renderValidationReport([report]);
    expect(md).toContain('external validation report');
    expect(md).toContain('Passed:** 1 / 1');
    expect(md).toContain('terminalHalfLifeHours');
    expect(md).toContain('**Source:**');
    expect(md).toContain(REF[0]!); // the cited source appears in the artifact
  });
});
