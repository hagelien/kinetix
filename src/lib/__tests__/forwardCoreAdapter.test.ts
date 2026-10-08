import { afterEach, describe, expect, it, vi } from 'vitest';
import { simulateScenario, type CanonicalResultOk } from '@/lib/kinetics-core';
import {
  coreResultToMonteCarloResult,
  toCanonicalScenario,
  type ForwardCoreRequest,
} from '../forwardCoreAdapter';

const baseReq = (over: Partial<ForwardCoreRequest> = {}): ForwardCoreRequest => ({
  analyte: 'amphetamine',
  route: 'oral',
  subject: { weightKg: 70 },
  doses: [{ amountMg: 30, tHours: 0 }],
  timeRange: { start: 0, end: 24, steps: 24 },
  ...over,
});

describe('toCanonicalScenario', () => {
  it('maps a valid request to a deterministic canonical scenario', () => {
    const result = toCanonicalScenario(baseReq());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.scenario;
    expect(s.analyte).toBe('amphetamine');
    expect(s.subject.weightKg).toBe(70);
    expect(s.doses).toEqual([
      { tHours: 0, amountMg: 30, route: 'oral', basis: 'parent' },
    ]);
    expect(s.timeGrid).toEqual({ startHours: 0, endHours: 24, stepHours: 1 });
    // No uncertainty requested → deterministic (median-only) run.
    expect(s.uncertainty).toBeUndefined();
  });

  it('renames insufflation to the core intranasal route', () => {
    const result = toCanonicalScenario(baseReq({ route: 'insufflation' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scenario.doses[0]!.route).toBe('intranasal');
  });

  it('passes an uncertainty config through unchanged', () => {
    const result = toCanonicalScenario(
      baseReq({ uncertainty: { seed: 42, draws: 500 } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scenario.uncertainty).toEqual({ seed: 42, draws: 500 });
  });

  it('rejects an analyte the registry does not carry', () => {
    const result = toCanonicalScenario(baseReq({ analyte: 'not-a-real-drug' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unsupported).toMatch(/not in the kinetics-core registry/);
  });

  it('rejects a route the model does not declare', () => {
    // amphetamine has oral + intranasal, but no IV route.
    const result = toCanonicalScenario(baseReq({ route: 'iv' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unsupported).toMatch(/is not modeled/);
  });

  it('rejects a dose basis the model cannot consume', () => {
    const result = toCanonicalScenario(baseReq({ basis: 'salt' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unsupported).toMatch(/basis/);
  });

  it('preserves a per-dose route override on each canonical dose event', () => {
    // cocaine models both intranasal and iv; a mixed-route case keeps both.
    const result = toCanonicalScenario(
      baseReq({
        analyte: 'cocaine',
        route: 'insufflation',
        doses: [
          { amountMg: 30, tHours: 0 },
          { amountMg: 20, tHours: 1, route: 'iv' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scenario.doses.map((d) => d.route)).toEqual([
      'intranasal',
      'iv',
    ]);
  });

  it('rejects the whole case when any dose route is unmodeled', () => {
    // amphetamine has no IV route; a single IV dose sends it to legacy.
    const result = toCanonicalScenario(
      baseReq({
        doses: [
          { amountMg: 30, tHours: 0 },
          { amountMg: 30, tHours: 4, route: 'iv' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unsupported).toMatch(/is not modeled/);
  });

  it('rejects a per-dose IV infusion (bolus-only) so it falls back to legacy', () => {
    const result = toCanonicalScenario(
      baseReq({
        analyte: 'cocaine',
        route: 'iv',
        doses: [{ amountMg: 20, tHours: 0, durationHours: 0.5 }],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unsupported).toMatch(/infusion duration/);
  });

  it('rejects a degenerate time range and an empty dose list', () => {
    expect(toCanonicalScenario(baseReq({ timeRange: { start: 0, end: 24, steps: 0 } })).ok).toBe(false);
    expect(toCanonicalScenario(baseReq({ timeRange: { start: 24, end: 0, steps: 24 } })).ok).toBe(false);
    expect(toCanonicalScenario(baseReq({ doses: [] })).ok).toBe(false);
  });
});

describe('coreResultToMonteCarloResult', () => {
  it('round-trips a real core run into the MonteCarloResult shape', () => {
    const scenario = toCanonicalScenario(baseReq());
    expect(scenario.ok).toBe(true);
    if (!scenario.ok) return;
    const core = simulateScenario(scenario.scenario);
    expect(core.ok).toBe(true);
    if (!core.ok) return;

    const mc = coreResultToMonteCarloResult(core, {
      drugConfigId: 'cfg-1',
      queryTimeHours: 2,
    });
    // Inclusive grid: 0..24 by 1h → 25 samples.
    expect(mc.timeSeries).toHaveLength(25);
    expect(mc.timeSeries[0]!.t).toBe(0);
    expect(mc.unit).toBe('mg/L');
    expect(mc.drugConfigId).toBe('cfg-1');
    expect(Number.isFinite(mc.median)).toBe(true);
    expect(mc.sensitivity).toEqual([]);
  });

  it('applies the display conversion and unit to every value', () => {
    const scenario = toCanonicalScenario(baseReq());
    if (!scenario.ok) throw new Error('scenario should be supported');
    const core = simulateScenario(scenario.scenario);
    if (!core.ok) throw new Error('core run should succeed');

    const plain = coreResultToMonteCarloResult(core, {
      drugConfigId: 'c',
      queryTimeHours: 3,
    });
    const doubled = coreResultToMonteCarloResult(core, {
      drugConfigId: 'c',
      queryTimeHours: 3,
      toDisplay: (v) => v * 2,
      unit: 'µg/L',
    });
    expect(doubled.unit).toBe('µg/L');
    expect(doubled.median).toBeCloseTo(plain.median * 2, 9);
    expect(doubled.timeSeries[5]!.median).toBeCloseTo(
      plain.timeSeries[5]!.median * 2,
      9,
    );
  });

  it('subtracts originHours so times land in the legacy dose-relative frame', () => {
    const scenario = toCanonicalScenario(baseReq());
    if (!scenario.ok) throw new Error('scenario should be supported');
    const core = simulateScenario(scenario.scenario);
    if (!core.ok) throw new Error('core run should succeed');

    const shifted = coreResultToMonteCarloResult(core, {
      drugConfigId: 'c',
      queryTimeHours: 2,
      originHours: 5,
    });
    // Every emitted time is the absolute core time minus the origin, so a curve
    // built on an absolute axis isn't shifted twice once the chart re-anchors it.
    expect(shifted.timeSeries[0]!.t).toBe(core.timeSeries[0]!.tHours - 5);
    expect(shifted.timeSeries.at(-1)!.t).toBe(
      core.timeSeries.at(-1)!.tHours - 5,
    );
  });

  it('carries the core limitation text verbatim, without inventing a key', () => {
    const fake = {
      ok: true,
      timeSeries: [
        { tHours: 0, median: 1, p05: 1, p25: 1, p75: 1, p95: 1 },
        { tHours: 1, median: 2, p05: 2, p25: 2, p75: 2, p95: 2 },
      ],
      limitations: [
        {
          code: 'sex-coefficient-fallback',
          text: 'For sex "other" the female coefficient set is applied.',
          severity: 'warning',
        },
      ],
      manifest: { seed: 7, draws: 500, acceptedDraws: 480 },
    } as unknown as CanonicalResultOk;

    const mc = coreResultToMonteCarloResult(fake, {
      drugConfigId: 'c',
      queryTimeHours: 0,
    });
    // The accurate core text is surfaced as-is; no messageKey overrides it with
    // a generic translation that could misstate the modeling assumption.
    expect(mc.warnings[0]).toEqual({
      type: 'model-limitation',
      message: 'For sex "other" the female coefficient set is applied.',
      severity: 'warning',
    });
    expect(mc.warnings[0]!.messageKey).toBeUndefined();
    expect(mc.seed).toBe(7);
    // drawCount reports the VALID (accepted) draws, not the requested count.
    expect(mc.drawCount).toBe(480);
  });

  it('falls back to requested draws when the core reports no acceptedDraws', () => {
    const fake = {
      ok: true,
      timeSeries: [{ tHours: 0, median: 1, p05: 1, p25: 1, p75: 1, p95: 1 }],
      limitations: [],
      manifest: { seed: 1, draws: 200, acceptedDraws: null },
    } as unknown as CanonicalResultOk;
    const mc = coreResultToMonteCarloResult(fake, {
      drugConfigId: 'c',
      queryTimeHours: 0,
    });
    expect(mc.drawCount).toBe(200);
  });

  it('interpolates the scalar point estimate between grid samples', () => {
    const scenario = toCanonicalScenario(baseReq());
    if (!scenario.ok) throw new Error('scenario should be supported');
    const core = simulateScenario(scenario.scenario);
    if (!core.ok) throw new Error('core run should succeed');

    // A query at an off-grid time (2.5 h) must land between its neighbours.
    const at2 = core.timeSeries.find((p) => p.tHours === 2)!.median;
    const at3 = core.timeSeries.find((p) => p.tHours === 3)!.median;
    const mc = coreResultToMonteCarloResult(core, {
      drugConfigId: 'c',
      queryTimeHours: 2.5,
    });
    const lo = Math.min(at2, at3);
    const hi = Math.max(at2, at3);
    expect(mc.median).toBeGreaterThanOrEqual(lo);
    expect(mc.median).toBeLessThanOrEqual(hi);
  });
});

describe('coreAnalyteFor — which analyte id a drug runs under', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('falls back to the name-derived id a reviewed model is keyed by', async () => {
    const { coreAnalyteFor: pick } = await import('../forwardCoreAdapter');
    // A Norwegian catalog slug the reviewed tier does not know, then the English-derived id.
    expect(pick(['etanol', 'ethanol'])).toBe('ethanol');
  });

  it('reports the last candidate when none resolves', async () => {
    const { coreAnalyteFor: pick } = await import('../forwardCoreAdapter');
    expect(pick([undefined, 'not-a-model'])).toBe('not-a-model');
  });

  it('resolves a catalog-derived model through the drug’s slug, not its English name', async () => {
    // The derived tier is keyed by `drugs.slug`, which often differs from the display name:
    // paracetamol's slug is `paracetamol-acetaminophen`, so the name-derived `paracetamol`
    // found no model and the run reported "not in the kinetics-core registry".
    vi.stubEnv('VITE_DERIVED_REGISTRY_ENABLED', 'true');
    const { coreAnalyteFor: pick, toCanonicalScenario: build } = await import('../forwardCoreAdapter');
    // The name-derived id alone is what the run used before, and it resolves nothing.
    expect(build({
      analyte: 'paracetamol',
      route: 'oral',
      subject: { weightKg: 70 },
      doses: [{ amountMg: 1000, tHours: 0 }],
      timeRange: { start: 0, end: 12, steps: 24 },
    }).ok).toBe(false);
    const analyte = pick(['paracetamol-acetaminophen', 'paracetamol']);
    expect(analyte).toBe('paracetamol-acetaminophen');
    const built = build({
      analyte,
      route: 'oral',
      subject: { weightKg: 70 },
      doses: [{ amountMg: 1000, tHours: 0 }],
      timeRange: { start: 0, end: 12, steps: 24 },
    });
    expect(built.ok).toBe(true);
  });
});
