import { describe, it, expect, vi } from 'vitest';
import {
  buildInferenceInput,
  buildRunManifest,
  essProportion,
  getComponentEngine,
  getRunBlockReasonKey,
  isComponentRunnable,
  kinelabOutputToDrugSimResult,
  modelFamilyMismatch,
  priorIntervalsFromPriors,
  resolveParameterProvenance,
  runComponent,
  runEthanolComponent,
} from '@/lib/modelingRun';
import type { DrugSimResult } from '@/types/simulator';
import { estimateBacCurve } from '@/lib/ethanolEngine';
import type {
  DrugSimConfig,
  SimEvent,
} from '@/types/simulator';
import type { DrugComponent } from '@/types';
import { simulateScenario } from '@/lib/kinetics-core';

function baseConfig(overrides: Partial<DrugSimConfig> = {}): DrugSimConfig {
  return {
    id: 'cfg1',
    drugId: '702',
    drugName: 'Test',
    label: 'Test',
    events: [],
    route: 'oral',
    questionMode: 'later-from-earlier',
    inputs: {},
    overrides: {},
    display: { visible: true },
    ...overrides,
  };
}

describe('resolveParameterProvenance', () => {
  const drug = {
    id: '702',
    name: 'Test',
    halfLife: { value: 4, unit: 'h' },
    volumeOfDistribution: { value: 50, unit: 'L' },
    bioavailability: { value: 0.8 },
  } as unknown as DrugComponent;

  it('marks parameters from drug literature as verified', () => {
    const p = resolveParameterProvenance(baseConfig(), drug);
    expect(p).toEqual({ halfLife: 'verified', vd: 'verified', f: 'verified' });
  });

  it('marks user overrides as assumptions', () => {
    const p = resolveParameterProvenance(
      baseConfig({ overrides: { vd: { type: 'fixed', value: 60 } } }),
      drug,
    );
    expect(p.vd).toBe('assumption');
    expect(p.halfLife).toBe('verified');
  });

  it('marks missing data as fallback', () => {
    const p = resolveParameterProvenance(baseConfig(), undefined);
    expect(p).toEqual({ halfLife: 'fallback', vd: 'fallback', f: 'fallback' });
  });

  it('treats a partial drug row per-parameter', () => {
    const partial = {
      id: '702',
      name: 'Test',
      halfLife: { value: 4, unit: 'h' },
    } as unknown as DrugComponent;
    const p = resolveParameterProvenance(baseConfig(), partial);
    expect(p).toEqual({
      halfLife: 'verified',
      vd: 'fallback',
      f: 'fallback',
    });
  });
});

describe('getComponentEngine', () => {
  it('defaults to pk-montecarlo when unset', () => {
    expect(getComponentEngine(baseConfig())).toBe('pk-montecarlo');
  });

  it('returns the configured engine for ethanol components', () => {
    expect(getComponentEngine(baseConfig({ engine: 'ethanol-widmark' }))).toBe(
      'ethanol-widmark',
    );
  });

  it('falls back to PK for non-ethanol components with a stale Widmark engine', () => {
    expect(
      getComponentEngine(
        baseConfig({ drugId: 'drug1', engine: 'ethanol-widmark' }),
      ),
    ).toBe('pk-montecarlo');
  });
});

describe('buildInferenceInput', () => {
  const diazepam: DrugComponent = {
    id: '3016',
    names: { en: 'Diazepam', nb: 'Diazepam' },
    molecularWeight: 284.74,
    halfLife: { min: 20, max: 50, unit: 'h' },
    volumeOfDistribution: { min: 0.7, max: 1.7, unit: 'L/kg' },
    bioavailability: { median: 0.9 },
  };

  it('maps component events into a KineLab inference input', () => {
    const input = buildInferenceInput(
      baseConfig({
        drugId: diazepam.id,
        drugName: 'Diazepam',
        engine: 'kinelab-bayes',
        events: [
          {
            id: 'dose-1',
            type: 'dose',
            unit: 'mg',
            route: 'oral',
            amountRange: { min: 100, max: 300 },
            tRange: [0, 2],
          },
          {
            id: 'obs-1',
            type: 'measurement',
            t: 5,
            value: 1.2,
            unit: 'mg/L',
            assayCV: 0.2,
          },
        ],
        kinelab: {
          assayCV: 0.15,
          drawCount: 1500,
          subject: { weightKg: 80, sex: 'male', ageYears: 42 },
        },
      }),
      diazepam,
    );

    expect(input.modelId).toBe('diazepam-one-comp-component-v0');
    expect(input.route).toBe('oral');
    expect(input.scenario?.possibleIntakeWindow).toEqual({
      earliestIso: '2026-01-01T00:00:00.000Z',
      latestIso: '2026-01-01T02:00:00.000Z',
    });
    expect(input.observations[0]).toMatchObject({
      id: 'obs-1',
      concentration: { value: 1.2, unit: 'mg/L' },
      sampleTime: '2026-01-01T05:00:00.000Z',
      assay: { uncertaintyCV: 0.2 },
    });
    expect(input.priors.dose).toEqual({
      type: 'uniform',
      min: 100,
      max: 300,
    });
    expect(input.subject).toEqual({ weightKg: 80, sex: 'male', age: 42 });
    expect(input.drawCount).toBe(1500);
  });

  it('leaves additionalDoses unset for a single-dose case', () => {
    const input = buildInferenceInput(
      baseConfig({
        drugId: diazepam.id,
        engine: 'kinelab-bayes',
        events: [
          { id: 'd', type: 'dose', t: 0, amount: 10, unit: 'mg', route: 'oral' },
          { id: 'm', type: 'measurement', t: 5, value: 0.2, unit: 'mg/L' },
        ],
      }),
      diazepam,
    );
    expect(input.additionalDoses).toBeUndefined();
  });

  it('superposes extra dose events as fractions of the earliest (primary) dose', () => {
    const input = buildInferenceInput(
      baseConfig({
        drugId: diazepam.id,
        engine: 'kinelab-bayes',
        events: [
          // Out of order on purpose — the earliest becomes the primary.
          { id: 'd2', type: 'dose', t: 6, amount: 20, unit: 'mg', route: 'oral' },
          { id: 'd1', type: 'dose', t: 0, amount: 10, unit: 'mg', route: 'oral' },
          { id: 'm', type: 'measurement', t: 8, value: 0.3, unit: 'mg/L' },
        ],
      }),
      diazepam,
    );
    // Primary is the 10 mg dose at t=0; the 20 mg dose at t=6 is 2× at +6h.
    expect(input.additionalDoses).toEqual([
      { tHoursAfterPrimary: 6, doseFraction: 2 },
    ]);
    // The dose prior is the primary dose's amount, not the total.
    expect(input.priors.dose).toEqual({ type: 'fixed', value: 10 });
  });

  it('does not superpose extra doses for the ethanol zero-order path', () => {
    const input = buildInferenceInput(
      baseConfig({
        drugId: 'ethanol',
        engine: 'kinelab-bayes',
        events: [
          { id: 'd1', type: 'dose', t: 0, amount: 10, unit: 'g', route: 'oral' },
          { id: 'd2', type: 'dose', t: 1, amount: 10, unit: 'g', route: 'oral' },
          { id: 'm', type: 'measurement', t: 3, value: 0.5, unit: 'mg/L' },
        ],
      }),
      undefined,
    );
    expect(input.additionalDoses).toBeUndefined();
  });
});

describe('isComponentRunnable', () => {
  it('requires a dose event with grams for the ethanol engine', () => {
    expect(isComponentRunnable(baseConfig({ engine: 'ethanol-widmark' }))).toBe(
      false,
    );
    const events: SimEvent[] = [
      { id: 'd', type: 'dose', t: 0, amount: 20, unit: 'g', route: 'oral' },
    ];
    expect(
      isComponentRunnable(baseConfig({ engine: 'ethanol-widmark', events })),
    ).toBe(true);
  });

  it('requires recognized oral ethanol doses for the ethanol engine', () => {
    expect(
      isComponentRunnable(
        baseConfig({
          engine: 'ethanol-widmark',
          events: [
            {
              id: 'd',
              type: 'dose',
              t: 0,
              amount: 20,
              unit: 'g',
              route: 'iv',
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('requires timed ethanol doses and rejects unsupported dose-solving queries', () => {
    expect(
      isComponentRunnable(
        baseConfig({
          engine: 'ethanol-widmark',
          events: [
            { id: 'd', type: 'dose', amount: 20, unit: 'g', route: 'oral' },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isComponentRunnable(
        baseConfig({
          engine: 'ethanol-widmark',
          events: [
            {
              id: 'd',
              type: 'dose',
              t: 0,
              amount: 20,
              unit: 'g',
              route: 'oral',
            },
            { id: 'q', type: 'query', t: 2, solveFor: 'dose' },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isComponentRunnable(
        baseConfig({
          engine: 'ethanol-widmark',
          events: [
            {
              id: 'd',
              type: 'dose',
              t: 0,
              amount: 20,
              unit: 'g',
              route: 'oral',
            },
            { id: 'q', type: 'query', solveFor: 'dose' },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('falls back to question derivation for the PK engine', () => {
    const events: SimEvent[] = [
      { id: 'm', type: 'measurement', t: 2, value: 50, unit: 'mg/L' },
      { id: 'q', type: 'query', t: 6, solveFor: 'concentration' },
    ];
    expect(isComponentRunnable(baseConfig({ events }))).toBe(true);
  });

  it('requires a dose prior and timed measurement for KineLab inference', () => {
    const events: SimEvent[] = [
      {
        id: 'd',
        type: 'dose',
        unit: 'mg',
        route: 'oral',
        amountRange: { min: 50, max: 200 },
        tRange: [0, 1],
      },
      { id: 'm', type: 'measurement', t: 4, value: 1.4, unit: 'mg/L' },
    ];
    expect(
      isComponentRunnable(baseConfig({ engine: 'kinelab-bayes', events })),
    ).toBe(true);
    expect(
      isComponentRunnable(
        baseConfig({ engine: 'kinelab-bayes', events: [events[0]!] }),
      ),
    ).toBe(false);
  });
});

describe('getRunBlockReasonKey', () => {
  it('returns null when the component is runnable', () => {
    const events: SimEvent[] = [
      {
        id: 'd',
        type: 'dose',
        unit: 'mg',
        route: 'oral',
        amountRange: { min: 50, max: 200 },
        tRange: [0, 1],
      },
      { id: 'm', type: 'measurement', t: 4, value: 1.4, unit: 'mg/L' },
    ];
    expect(
      getRunBlockReasonKey(baseConfig({ engine: 'kinelab-bayes', events })),
    ).toBeNull();
  });

  it('points at the missing dose prior for KineLab inference', () => {
    const events: SimEvent[] = [
      { id: 'm', type: 'measurement', t: 4, value: 1.4, unit: 'mg/L' },
    ];
    expect(
      getRunBlockReasonKey(baseConfig({ engine: 'kinelab-bayes', events })),
    ).toBe('simulator.events.statusKinelabIncomplete');
  });

  it('flags an unsupported dose-solving query for the ethanol engine', () => {
    expect(
      getRunBlockReasonKey(
        baseConfig({
          engine: 'ethanol-widmark',
          events: [
            { id: 'd', type: 'dose', t: 0, amount: 20, unit: 'g', route: 'oral' },
            { id: 'q', type: 'query', t: 2, solveFor: 'dose' },
          ],
        }),
      ),
    ).toBe('simulator.events.statusEthanolDoseSolvingUnsupported');
  });

  it('reports the incomplete-ethanol hint when the dose is missing', () => {
    expect(
      getRunBlockReasonKey(baseConfig({ engine: 'ethanol-widmark' })),
    ).toBe('simulator.events.statusEthanolIncomplete');
  });

  it('falls back to the generic hint for the PK engine', () => {
    expect(getRunBlockReasonKey(baseConfig())).toBe(
      'simulator.events.statusIncomplete',
    );
  });
});

describe('runEthanolComponent', () => {
  const events: SimEvent[] = [
    { id: 'd1', type: 'dose', t: 0, amount: 28, unit: 'g', route: 'oral' },
    { id: 'd2', type: 'dose', t: 1, amount: 14, unit: 'g', route: 'oral' },
  ];
  const config = baseConfig({
    engine: 'ethanol-widmark',
    events,
    ethanol: {
      weightKg: 80,
      biologicalSex: 'male',
      eliminationRateGdlPerHour: 0.015,
    },
  });

  it('produces a g/dL BAC curve matching the Widmark engine', () => {
    const result = runEthanolComponent(config);
    expect(result.engine).toBe('ethanol-widmark');
    expect(result.unit).toBe('g/dL');
    expect(result.assumptions.model).toContain('Widmark');
    expect(result.timeSeries.length).toBeGreaterThan(0);

    // The point estimate is the peak BAC, and the bands collapse onto the median.
    expect(result.median).toBeGreaterThan(0);
    expect(result.p05).toBe(result.median);
    expect(result.p95).toBe(result.median);

    const intakes = [
      { id: 'd1', timeHour: 0, ethanolGrams: 28 },
      { id: 'd2', timeHour: 1, ethanolGrams: 14 },
    ];
    const peak = estimateBacCurve(intakes, {
      weightKg: 80,
      biologicalSex: 'male',
      eliminationRateGdlPerHour: 0.015,
    }).peakBacGdl;
    expect(result.median).toBeGreaterThan(peak - 0.05);
  });

  it('uses sensible defaults when ethanol params are absent', () => {
    const result = runEthanolComponent(
      baseConfig({ engine: 'ethanol-widmark', events }),
    );
    expect(result.median).toBeGreaterThan(0);
  });

  it('converts supported ethanol dose units to grams', () => {
    const grams = runEthanolComponent(
      baseConfig({
        engine: 'ethanol-widmark',
        events: [
          { id: 'd', type: 'dose', t: 0, amount: 1, unit: 'g', route: 'oral' },
        ],
        ethanol: {
          weightKg: 80,
          biologicalSex: 'male',
          eliminationRateGdlPerHour: 0.015,
        },
      }),
    );
    const milligrams = runEthanolComponent(
      baseConfig({
        engine: 'ethanol-widmark',
        events: [
          {
            id: 'd',
            type: 'dose',
            t: 0,
            amount: 1000,
            unit: 'mg',
            route: 'oral',
          },
        ],
        ethanol: {
          weightKg: 80,
          biologicalSex: 'male',
          eliminationRateGdlPerHour: 0.015,
        },
      }),
    );
    expect(milligrams.median).toBeCloseTo(grams.median, 8);
  });

  it('reports the ethanol point estimate at the query time when present', () => {
    const result = runEthanolComponent(
      baseConfig({
        engine: 'ethanol-widmark',
        events: [
          { id: 'd', type: 'dose', t: 0, amount: 28, unit: 'g', route: 'oral' },
          { id: 'q', type: 'query', t: 10, solveFor: 'concentration' },
        ],
        ethanol: {
          weightKg: 80,
          biologicalSex: 'male',
          eliminationRateGdlPerHour: 0.015,
        },
      }),
    );
    const peak = Math.max(...result.timeSeries.map((p) => p.median));
    expect(result.median).toBeLessThan(peak);
    expect(result.p05).toBe(result.median);
    expect(result.p95).toBe(result.median);
  });

  it('uses the latest concentration query by time, not insertion order', () => {
    const result = runEthanolComponent(
      baseConfig({
        engine: 'ethanol-widmark',
        events: [
          { id: 'd', type: 'dose', t: 0, amount: 28, unit: 'g', route: 'oral' },
          { id: 'late', type: 'query', t: 10, solveFor: 'concentration' },
          { id: 'early', type: 'query', t: 1, solveFor: 'concentration' },
        ],
        ethanol: {
          weightKg: 80,
          biologicalSex: 'male',
          eliminationRateGdlPerHour: 0.015,
        },
      }),
    );
    const peak = Math.max(...result.timeSeries.map((p) => p.median));
    expect(result.median).toBeLessThan(peak);
  });

  it('throws instead of running unsupported ethanol dose-solving queries', () => {
    expect(() =>
      runEthanolComponent(
        baseConfig({
          engine: 'ethanol-widmark',
          events: [
            {
              id: 'd',
              type: 'dose',
              t: 0,
              amount: 28,
              unit: 'g',
              route: 'oral',
            },
            { id: 'q', type: 'query', t: 2, solveFor: 'dose' },
          ],
        }),
      ),
    ).toThrow(/does not support dose solving/);
    expect(() =>
      runEthanolComponent(
        baseConfig({
          engine: 'ethanol-widmark',
          events: [
            {
              id: 'd',
              type: 'dose',
              t: 0,
              amount: 28,
              unit: 'g',
              route: 'oral',
            },
            { id: 'q', type: 'query', solveFor: 'dose' },
          ],
        }),
      ),
    ).toThrow(/does not support dose solving/);
  });

  it('falls back from non-physical ethanol parameters', () => {
    const result = runEthanolComponent(
      baseConfig({
        engine: 'ethanol-widmark',
        events,
        ethanol: {
          weightKg: 0,
          biologicalSex: 'male',
          eliminationRateGdlPerHour: -0.01,
          distributionRatioOverride: -1,
        },
      }),
    );
    expect(Number.isFinite(result.median)).toBe(true);
    expect(result.median).toBeGreaterThan(0);
  });

  it('extends the ethanol curve window to late intakes and queries', () => {
    const lateDose = runEthanolComponent(
      baseConfig({
        engine: 'ethanol-widmark',
        events: [
          {
            id: 'd',
            type: 'dose',
            t: 72,
            amount: 28,
            unit: 'g',
            route: 'oral',
          },
        ],
        ethanol: {
          weightKg: 80,
          biologicalSex: 'male',
          eliminationRateGdlPerHour: 0.015,
        },
      }),
    );
    expect(lateDose.timeSeries.at(-1)?.t).toBeGreaterThan(72);
    expect(
      Math.max(...lateDose.timeSeries.map((p) => p.median)),
    ).toBeGreaterThan(0);

    const lateQuery = runEthanolComponent(
      baseConfig({
        engine: 'ethanol-widmark',
        events: [
          { id: 'd', type: 'dose', t: 0, amount: 28, unit: 'g', route: 'oral' },
          { id: 'q', type: 'query', t: 72, solveFor: 'concentration' },
        ],
        ethanol: {
          weightKg: 80,
          biologicalSex: 'male',
          eliminationRateGdlPerHour: 0.015,
        },
      }),
    );
    expect(lateQuery.timeSeries.at(-1)?.t).toBeGreaterThan(72);
  });
});

describe('runComponent dispatch', () => {
  it('routes ethanol components to the Widmark engine without the worker', async () => {
    const runMonteCarlo = vi.fn();
    const config = baseConfig({
      engine: 'ethanol-widmark',
      events: [
        { id: 'd', type: 'dose', t: 0, amount: 20, unit: 'g', route: 'oral' },
      ],
    });
    const result = await runComponent(config, undefined, { runMonteCarlo });
    expect(runMonteCarlo).not.toHaveBeenCalled();
    expect(result.engine).toBe('ethanol-widmark');
  });

  it('routes PK components through the Monte Carlo worker', async () => {
    const events: SimEvent[] = [
      { id: 'd', type: 'dose', t: 0, amount: 10, unit: 'mg', route: 'oral' },
      { id: 'q', type: 'query', t: 6, solveFor: 'concentration' },
    ];
    const config = baseConfig({ events, drugName: 'Amphetamine' });
    const runMonteCarlo = vi.fn(async (workerConfig) =>
      simulateScenario(workerConfig.scenario),
    );
    const result = await runComponent(config, undefined, { runMonteCarlo });
    expect(runMonteCarlo).toHaveBeenCalledTimes(1);
    expect(result.engine).toBe('pk-montecarlo');
    expect(result.median).toBeGreaterThan(0);
    expect(result.assumptions.model).toContain('one-compartment');
  });

  it('routes KineLab components through the inference worker', async () => {
    const config = baseConfig({
      engine: 'kinelab-bayes',
      events: [
        {
          id: 'd',
          type: 'dose',
          unit: 'mg',
          route: 'oral',
          amountRange: { min: 100, max: 300 },
          tRange: [0, 2],
        },
        { id: 'm', type: 'measurement', t: 5, value: 1.2, unit: 'mg/L' },
      ],
    });
    const runMonteCarlo = vi.fn();
    const runInference = vi.fn(async () => ({
      posterior: {
        intervals: {
          dose: { p05: 120, median: 180, p95: 260, unit: 'mg' },
        },
      },
      predictive: [
        { t: 0, p05: 0, p25: 0, median: 0, p75: 0, p95: 0 },
        { t: 5, p05: 0.8, p25: 1, median: 1.2, p75: 1.4, p95: 1.6 },
      ],
      diagnostics: {
        sampleCount: 1000,
        rejectedNonphysical: 0,
        rejectedImpossible: 0,
        effectiveSampleSize: 800,
      },
    }));

    const result = await runComponent(config, undefined, {
      runMonteCarlo,
      runInference,
    });

    expect(runMonteCarlo).not.toHaveBeenCalled();
    expect(runInference).toHaveBeenCalledTimes(1);
    expect(result.engine).toBe('kinelab-bayes');
    expect(result.timeSeries).toHaveLength(2);
    expect(result.median).toBe(1.2);
    expect(result.kinelab?.posterior.intervals.dose?.median).toBe(180);
  });
});

describe('essProportion + low-ESS warning', () => {
  function output(sampleCount: number, ess: number) {
    return {
      predictive: [
        { t: 0, p05: 0, p25: 0, median: 1, p75: 2, p95: 3 },
        { t: 1, p05: 0, p25: 0, median: 0.5, p75: 1, p95: 1.5 },
      ],
      posterior: {
        intervals: { dose: { median: 100, p05: 60, p95: 150, unit: 'mg' } },
      },
      diagnostics: {
        sampleCount,
        rejectedNonphysical: 0,
        rejectedImpossible: 0,
        effectiveSampleSize: ess,
      },
    } as unknown as Parameters<typeof kinelabOutputToDrugSimResult>[0];
  }

  // IV route so the non-IV instantaneous-absorption warning (Phase D) doesn't
  // enter these ESS-only assertions.
  const config = baseConfig({ engine: 'kinelab-bayes', route: 'iv' });

  it('computes ESS as a fraction of valid draws', () => {
    expect(essProportion({ sampleCount: 2000, effectiveSampleSize: 500 })).toBe(
      0.25,
    );
    expect(essProportion({ sampleCount: 0, effectiveSampleSize: 0 })).toBe(0);
  });

  it('adds no warning when ESS proportion is healthy', () => {
    const r = kinelabOutputToDrugSimResult(output(2000, 800), config);
    expect(r.warnings).toHaveLength(0);
  });

  it('warns when ESS proportion is below 10%', () => {
    const r = kinelabOutputToDrugSimResult(output(2000, 120), config);
    expect(r.warnings.some((w) => w.messageKey === 'simulator.warnings.lowEss')).toBe(
      true,
    );
    expect(r.warnings[0]!.severity).toBe('warning');
  });

  it('escalates to critical below 2%', () => {
    const r = kinelabOutputToDrugSimResult(output(2000, 20), config);
    expect(r.warnings[0]!.severity).toBe('critical');
  });
});

describe('instantaneous-absorption warning (Phase D)', () => {
  function healthyOutput() {
    return {
      predictive: [{ t: 0, p05: 0, p25: 0, median: 1, p75: 2, p95: 3 }],
      posterior: {
        intervals: { dose: { median: 100, p05: 60, p95: 150, unit: 'mg' } },
      },
      diagnostics: {
        sampleCount: 2000,
        rejectedNonphysical: 0,
        rejectedImpossible: 0,
        effectiveSampleSize: 900,
      },
    } as unknown as Parameters<typeof kinelabOutputToDrugSimResult>[0];
  }
  const hasInstant = (r: DrugSimResult) =>
    r.warnings.some(
      (w) => w.messageKey === 'simulator.warnings.instantaneousAbsorption',
    );

  it('warns for a non-IV first-order case without a ka prior', () => {
    const r = kinelabOutputToDrugSimResult(
      healthyOutput(),
      baseConfig({ engine: 'kinelab-bayes', route: 'oral' }),
      { dose: { type: 'fixed', value: 100 }, halfLife: { type: 'fixed', value: 4 }, vd: { type: 'fixed', value: 50 } },
    );
    expect(hasInstant(r)).toBe(true);
  });

  it('does not warn when a ka prior is present (Bateman path)', () => {
    const r = kinelabOutputToDrugSimResult(
      healthyOutput(),
      baseConfig({ engine: 'kinelab-bayes', route: 'oral' }),
      {
        dose: { type: 'fixed', value: 100 },
        halfLife: { type: 'fixed', value: 4 },
        vd: { type: 'fixed', value: 50 },
        ka: { type: 'fixed', value: 1.2 },
      },
    );
    expect(hasInstant(r)).toBe(false);
  });

  it('does not warn for IV (fully absorbed) or zero-order (ethanol)', () => {
    const iv = kinelabOutputToDrugSimResult(
      healthyOutput(),
      baseConfig({ engine: 'kinelab-bayes', route: 'iv' }),
      { dose: { type: 'fixed', value: 100 }, halfLife: { type: 'fixed', value: 4 }, vd: { type: 'fixed', value: 50 } },
    );
    expect(hasInstant(iv)).toBe(false);

    const zeroOrder = kinelabOutputToDrugSimResult(
      healthyOutput(),
      baseConfig({ engine: 'kinelab-bayes', route: 'oral' }),
      {
        dose: { type: 'fixed', value: 100 },
        vd: { type: 'fixed', value: 50 },
        eliminationRate: { type: 'uniform', min: 100, max: 200 },
      },
    );
    expect(hasInstant(zeroOrder)).toBe(false);
  });
});

describe('buildRunManifest', () => {
  function pkResult(overrides: Partial<DrugSimResult> = {}): DrugSimResult {
    return {
      drugConfigId: 'c1',
      engine: 'pk-montecarlo',
      questionMode: 'later-from-earlier',
      median: 10,
      p05: 8,
      p25: 9,
      p75: 11,
      p95: 12,
      unit: 'mg/L',
      timeSeries: [],
      assumptions: {
        model: 'one-compartment, first-order elimination',
        modelKey: 'assumptions.models.oneCompartmentFirstOrder',
        route: 'oral',
        halfLife: { type: 'fixed', value: 4 },
        vd: { type: 'fixed', value: 50 },
        f: { type: 'fixed', value: 1 },
        weightScaling: false,
      },
      sensitivity: [],
      warnings: [],
      seed: 42,
      drawCount: 2000,
      ...overrides,
    };
  }

  it('records engine, model, seed, draws, hash and a valid timestamp', () => {
    const m = buildRunManifest(pkResult(), 'abc12345');
    expect(m.inputHash).toBe('abc12345');
    expect(m.engine).toBe('pk-montecarlo');
    expect(m.model).toBe('assumptions.models.oneCompartmentFirstOrder');
    expect(m.seed).toBe(42);
    expect(m.drawCount).toBe(2000);
    expect(Number.isNaN(Date.parse(m.createdAtIso))).toBe(false);
    expect(m.effectiveSampleSize).toBeUndefined();
  });

  it('includes ESS diagnostics for inference results', () => {
    const m = buildRunManifest(
      pkResult({
        engine: 'kinelab-bayes',
        kinelab: {
          posterior: { intervals: {} },
          diagnostics: {
            sampleCount: 2000,
            rejectedNonphysical: 0,
            rejectedImpossible: 0,
            effectiveSampleSize: 640,
          },
        },
      }),
      'h',
    );
    expect(m.effectiveSampleSize).toBe(640);
    expect(m.sampleCount).toBe(2000);
  });

  it('falls back to the engine default when engine is absent', () => {
    const m = buildRunManifest(pkResult({ engine: undefined }), 'h');
    expect(m.engine).toBe('pk-montecarlo');
  });
});

describe('priorIntervalsFromPriors', () => {
  it('maps first-order priors to keyed intervals', () => {
    const intervals = priorIntervalsFromPriors({
      dose: { type: 'uniform', min: 100, max: 300 },
      halfLife: { type: 'fixed', value: 30 },
      vd: { type: 'fixed', value: 70 },
      f: { type: 'fixed', value: 1 },
    });
    expect(intervals?.dose).toEqual({ p05: 110, median: 200, p95: 290 });
    expect(intervals?.halfLife?.median).toBe(30);
    expect(intervals).not.toHaveProperty('eliminationRate');
  });

  it('maps zero-order priors (eliminationRate, no halfLife/f)', () => {
    const intervals = priorIntervalsFromPriors({
      dose: { type: 'uniform', min: 10, max: 90 },
      vd: { type: 'uniform', min: 35, max: 70 },
      eliminationRate: { type: 'uniform', min: 100, max: 200 },
    });
    expect(intervals?.eliminationRate?.median).toBeCloseTo(150, 9);
    expect(intervals).not.toHaveProperty('halfLife');
    expect(intervals).not.toHaveProperty('f');
  });

  it('returns undefined when priors are absent', () => {
    expect(priorIntervalsFromPriors(undefined)).toBeUndefined();
  });
});

describe('KineLab matrix as a case input', () => {
  function output() {
    return {
      predictive: [{ t: 0, p05: 0, p25: 0, median: 1, p75: 2, p95: 3 }],
      posterior: {
        intervals: { dose: { median: 100, p05: 60, p95: 150, unit: 'mg' } },
      },
      diagnostics: {
        sampleCount: 2000,
        rejectedNonphysical: 0,
        rejectedImpossible: 0,
        effectiveSampleSize: 900,
      },
    } as unknown as Parameters<typeof kinelabOutputToDrugSimResult>[0];
  }

  it('defaults to whole blood with no matrix warning', () => {
    const r = kinelabOutputToDrugSimResult(
      output(),
      baseConfig({ engine: 'kinelab-bayes' }),
    );
    expect(r.kinelab?.matrix).toBe('whole_blood');
    expect(
      r.warnings.some(
        (w) => w.messageKey === 'simulator.warnings.matrixNoConversion',
      ),
    ).toBe(false);
  });

  it('records a non-blood matrix and warns that no conversion is applied', () => {
    const r = kinelabOutputToDrugSimResult(
      output(),
      baseConfig({ engine: 'kinelab-bayes', kinelab: { matrix: 'serum' } }),
    );
    expect(r.kinelab?.matrix).toBe('serum');
    expect(
      r.warnings.some(
        (w) => w.messageKey === 'simulator.warnings.matrixNoConversion',
      ),
    ).toBe(true);
    // The matrix flows into the run manifest for provenance.
    const m = buildRunManifest(r, 'hash');
    expect(m.matrix).toBe('serum');
  });
});

describe('buildInferenceInput — censored observations', () => {
  const drug = { id: '702', names: { en: 'Test', nb: 'Test' } } as unknown as DrugComponent;

  it('maps a < LOQ non-detect to observation censoring + assay.loq', () => {
    const input = buildInferenceInput(
      baseConfig({
        engine: 'kinelab-bayes',
        events: [
          {
            id: 'd',
            type: 'dose',
            unit: 'mg',
            route: 'iv',
            amountRange: { min: 50, max: 300 },
            tRange: [0, 1],
          },
          {
            id: 'm',
            type: 'measurement',
            t: 6,
            value: 0.5,
            unit: 'mg/L',
            censoring: 'below_loq',
          },
        ],
      }),
      drug,
    );
    expect(input.observations[0]!.censoring).toEqual({ kind: 'loq', limit: 0.5 });
    expect(input.observations[0]!.assay?.loq).toBe(0.5);
  });

  it('leaves censoring undefined for an ordinary measurement', () => {
    const input = buildInferenceInput(
      baseConfig({
        engine: 'kinelab-bayes',
        events: [
          {
            id: 'd',
            type: 'dose',
            unit: 'mg',
            route: 'iv',
            amountRange: { min: 50, max: 300 },
            tRange: [0, 1],
          },
          { id: 'm', type: 'measurement', t: 6, value: 1.2, unit: 'mg/L' },
        ],
      }),
      drug,
    );
    expect(input.observations[0]!.censoring).toBeUndefined();
  });
});

describe('modelFamilyMismatch', () => {
  const firstOrder = {
    dose: { type: 'uniform', min: 50, max: 300 },
    halfLife: { type: 'fixed', value: 4 },
    vd: { type: 'fixed', value: 50 },
    f: { type: 'fixed', value: 1 },
  } as unknown as import('@/lib/compute/types').InferencePriors;
  const zeroOrder = {
    dose: { type: 'uniform', min: 10, max: 90 },
    vd: { type: 'uniform', min: 35, max: 70 },
    eliminationRate: { type: 'uniform', min: 100, max: 200 },
  } as unknown as import('@/lib/compute/types').InferencePriors;

  it('flags ethanol running as first-order', () => {
    expect(modelFamilyMismatch('702', firstOrder)).toBe('ethanol-not-zero-order');
  });

  it('flags a non-ethanol analyte running as zero-order', () => {
    expect(modelFamilyMismatch('3016', zeroOrder)).toBe('nonethanol-zero-order');
  });

  it('accepts the consistent pairings', () => {
    expect(modelFamilyMismatch('702', zeroOrder)).toBeNull();
    expect(modelFamilyMismatch('3016', firstOrder)).toBeNull();
  });

  it('returns null without priors', () => {
    expect(modelFamilyMismatch('702', undefined)).toBeNull();
  });
});

describe('core-derived assumptions (model provenance)', () => {
  const runMonteCarlo = vi.fn(async (workerConfig) =>
    simulateScenario(workerConfig.scenario),
  );

  function runFor(drugName: string, route: 'oral' | 'inhalation' = 'oral') {
    const events: SimEvent[] = [
      { id: 'd', type: 'dose', t: 0, amount: 10, unit: 'mg', route },
      { id: 'q', type: 'query', t: 6, solveFor: 'concentration' },
    ];
    return runComponent(baseConfig({ events, drugName, route }), undefined, {
      runMonteCarlo,
    });
  }

  // A two-compartment ODE Monte Carlo run over THC's long horizon is ~70x the
  // cost of a closed-form one-compartment one, so this suite runs it once and
  // asserts against the single result.
  it(
    'reports the family, model and parameters that actually produced the curve',
    async () => {
      const result = await runFor('THC');

      // Before this, every core result was stamped one-compartment first-order.
      expect(result.assumptions.family).toBe('two-compartment-first-order');
      expect(result.assumptions.modelId).toBe('thc-two-comp-v1');
      expect(result.assumptions.model).not.toContain('one-compartment');
      expect(result.assumptions.modelKey).toBe(
        'assumptions.models.twoCompartmentFirstOrder',
      );

      // The reviewed model's own values (t1/2 = 1680 min, oral F = 0.06), not
      // the catalog config the legacy derivation reached for.
      expect(result.assumptions.halfLife).toEqual({ type: 'fixed', value: 28 });
      expect(result.assumptions.f).toEqual({ type: 'fixed', value: 0.06 });

      // The matrix the model computes in, so the chart can convert FROM it.
      expect(result.assumptions.nativeMatrix).toBe('plasma');
      expect(result.assumptions.validationStatus).toBe('literature-derived');

      // The manifest records the family too, so a saved run stays diagnosable.
      expect(result.manifest?.model).toBe(
        'assumptions.models.twoCompartmentFirstOrder',
      );
    },
    30_000,
  );

  // Saturable elimination is an ODE family too, so it carries the same cost.
  it(
    'reports a saturable model as Michaelis-Menten, not first-order',
    async () => {
      const result = await runFor('MDMA');
      expect(result.assumptions.family).toBe('michaelis-menten');
      expect(result.assumptions.model).toContain('Michaelis');
      expect(result.assumptions.modelId).toBe('mdma-michaelis-menten-v1');
    },
    30_000,
  );

  it('keeps a genuinely one-compartment model labelled as one', async () => {
    const result = await runFor('Amphetamine');
    expect(result.assumptions.family).toBe('one-compartment-first-order');
    expect(result.assumptions.model).toContain('one-compartment');
  });
});

describe('question modes the core path had stopped answering', () => {
  // Replacing the legacy Monte Carlo worker with kinetics-core left the core
  // path answering `concentration-from-dose` ONLY; every other mode threw
  // `kinetics-core does not support ...`. `handleRunAll` catches into
  // `console.error`, so the whole regression surfaced as a Run button that did
  // nothing at all. These modes must produce a result again.
  const runMonteCarlo = vi.fn(async (workerConfig) =>
    simulateScenario(workerConfig.scenario),
  );

  function run(events: SimEvent[], drugName = 'Amphetamine') {
    return runComponent(
      baseConfig({ events, drugName, route: 'oral' }),
      undefined,
      { runMonteCarlo },
    );
  }

  // Amphetamine's reviewed model: terminal half-life 11 h.
  const AMPHETAMINE_HALF_LIFE_H = 11;

  describe('predicting a concentration from a known concentration', () => {
    const events: SimEvent[] = [
      { id: 'm', type: 'measurement', t: 0, value: 3, unit: 'µmol/L' },
      { id: 'q', type: 'query', t: 4, solveFor: 'concentration' },
    ];

    it('runs, and decays at the model\'s own terminal half-life', async () => {
      const result = await run(events);
      expect(result.questionMode).toBe('later-from-earlier');
      const expected =
        3 * Math.exp((-Math.LN2 * 4) / AMPHETAMINE_HALF_LIFE_H);
      expect(result.median).toBeCloseTo(expected, 6);
      // The answer stays in the measurement's own unit — the extrapolation is
      // a ratio, so nothing needs converting.
      expect(result.unit).toBe('µmol/L');
      expect(result.timeSeries.length).toBeGreaterThan(0);
    });

    it('reports the resolved model, not a catalog guess', async () => {
      const result = await run(events);
      expect(result.assumptions.modelId).toBe('amphetamine-one-comp-v1');
      expect(result.assumptions.family).toBe('one-compartment-first-order');
      expect(result.assumptions.halfLife).toEqual({
        type: 'fixed',
        value: AMPHETAMINE_HALF_LIFE_H,
      });
    });

    it('says the extrapolation assumes the terminal phase', async () => {
      const result = await run(events);
      expect(result.warnings.map((w) => w.messageKey)).toContain(
        'simulator.warnings.terminalPhaseExtrapolation',
      );
    });

    it('back-extrapolates, and flags a long backward reach', async () => {
      const result = await run([
        { id: 'm', type: 'measurement', t: 30, value: 1, unit: 'mg/L' },
        { id: 'q', type: 'query', t: 0, solveFor: 'concentration' },
      ]);
      expect(result.questionMode).toBe('earlier-from-later');
      // Earlier than the measurement, so higher than it.
      expect(result.median).toBeCloseTo(
        Math.exp((Math.LN2 * 30) / AMPHETAMINE_HALF_LIFE_H),
        6,
      );
      const backward = result.warnings.find(
        (w) => w.messageKey === 'simulator.warnings.backwardExtrapolation',
      );
      expect(backward?.messageParams?.hours).toBe('30.0');
    });

    it(
      'refuses to extrapolate a saturable model first-order',
      async () => {
        // MDMA eliminates by Michaelis-Menten, so a mono-exponential
        // extrapolation would be a different model wearing its name.
        const result = await run(
          [
            { id: 'm', type: 'measurement', t: 0, value: 0.5, unit: 'mg/L' },
            { id: 'q', type: 'query', t: 4, solveFor: 'concentration' },
          ],
          'MDMA',
        );
        expect(result.warnings.map((w) => w.messageKey)).toContain(
          'simulator.warnings.nonlinearExtrapolation',
        );
        expect(result.timeSeries).toHaveLength(0);
      },
      30_000,
    );
  });

  describe('back-calculating a dose from a measured concentration', () => {
    const events: SimEvent[] = [
      { id: 'd', type: 'dose', t: 0, unit: 'mg', route: 'oral' },
      { id: 'm', type: 'measurement', t: 4, value: 0.05, unit: 'mg/L' },
      { id: 'q', type: 'query', t: 4, solveFor: 'dose' },
    ];

    it('runs and reports a dose', async () => {
      const result = await run(events);
      expect(result.questionMode).toBe('dose-from-concentration');
      expect(result.median).toBeGreaterThan(0);
      expect(result.unit).toBe('mg');
    });

    it('round-trips: forward-simulating the estimate reproduces the measurement', async () => {
      // The strongest statement available about a back-calculation — the dose
      // it returns must be the dose that predicts the concentration it was
      // given, through the same engine.
      const back = await run(events);
      const forward = await run([
        {
          id: 'd',
          type: 'dose',
          t: 0,
          amount: back.median,
          unit: 'mg',
          route: 'oral',
        },
        { id: 'q', type: 'query', t: 4, solveFor: 'concentration' },
      ]);
      expect(forward.median).toBeCloseTo(0.05, 6);
    });

    it('names the curve unit separately from the dose answer', async () => {
      const result = await run(events);
      // `unit` is the scalar's (a dose); the plotted curve is still a
      // concentration and must say so, or the axis reads "mg".
      expect(result.unit).toBe('mg');
      expect(result.curveUnit).toBe('mg/L');
      expect(result.timeSeries.length).toBeGreaterThan(0);
    });

    it('carries the retained core payload for the estimated dose', async () => {
      const result = await run(events);
      // Not the probe run: the recorded scenario must be the dose being
      // reported, so the manifest describes what is on screen.
      const scenario = result.canonicalResult?.manifest;
      expect(scenario?.modelId).toBe('amphetamine-one-comp-v1');
      expect(result.assumptions.modelId).toBe('amphetamine-one-comp-v1');
    });

    it('warns that a single concentration makes an unstable dose', async () => {
      const result = await run(events);
      expect(result.warnings.map((w) => w.messageKey)).toContain(
        'simulator.warnings.unstableDoseFromConcentration',
      );
    });

    it(
      'refuses to scale a dose through a saturable model',
      async () => {
        // Michaelis-Menten concentration is NOT proportional to dose, so the
        // linear rescaling this mode relies on does not hold.
        const result = await run(
          [
            { id: 'd', type: 'dose', t: 0, unit: 'mg', route: 'oral' },
            { id: 'm', type: 'measurement', t: 4, value: 0.05, unit: 'mg/L' },
            { id: 'q', type: 'query', t: 4, solveFor: 'dose' },
          ],
          'MDMA',
        );
        expect(result.warnings.map((w) => w.messageKey)).toContain(
          'simulator.warnings.nonlinearDoseSolve',
        );
      },
      30_000,
    );
  });

  describe('what blocks a dose back-calculation', () => {
    it('asks for the intake time, not for a prediction time point', () => {
      // The panel used to say "add a prediction time point" when the
      // prediction time was already there and the DOSE event was missing.
      const config = baseConfig({
        events: [
          { id: 'm', type: 'measurement', t: 4, value: 0.05, unit: 'mg/L' },
          { id: 'q', type: 'query', t: 5, solveFor: 'dose' },
        ],
      });
      expect(isComponentRunnable(config)).toBe(false);
      expect(getRunBlockReasonKey(config)).toBe(
        'simulator.events.statusDoseSolveNeedsDoseTime',
      );
    });

    it('asks for the concentration once the dose time is there', () => {
      const config = baseConfig({
        events: [
          { id: 'd', type: 'dose', t: 0, unit: 'mg', route: 'oral' },
          { id: 'q', type: 'query', t: 5, solveFor: 'dose' },
        ],
      });
      expect(getRunBlockReasonKey(config)).toBe(
        'simulator.events.statusDoseSolveNeedsConcentration',
      );
    });
  });
});

describe('review findings on the restored inverse modes', () => {
  const runMonteCarlo = vi.fn(async (workerConfig) =>
    simulateScenario(workerConfig.scenario),
  );

  function run(events: SimEvent[], drugName = 'Amphetamine') {
    return runComponent(
      baseConfig({ events, drugName, route: 'oral' }),
      undefined,
      { runMonteCarlo },
    );
  }

  it('solves from the chronologically last events, not the last array entries', async () => {
    // `updateEvent` rewrites a time in place without reordering the array, so
    // editing a dose earlier leaves it at a later array index. `deriveQuestion`
    // sorts by time before choosing; the engine must choose the same events, or
    // it silently solves from a different dose than the panel describes.
    const inOrder: SimEvent[] = [
      { id: 'd-early', type: 'dose', t: 0, unit: 'mg', route: 'oral' },
      { id: 'd-late', type: 'dose', t: 12, unit: 'mg', route: 'oral' },
      { id: 'm', type: 'measurement', t: 16, value: 0.05, unit: 'mg/L' },
      { id: 'q', type: 'query', t: 16, solveFor: 'dose' },
    ];
    // Same case, array order scrambled: the LATER dose sits first.
    const scrambled: SimEvent[] = [
      inOrder[1]!,
      inOrder[0]!,
      inOrder[3]!,
      inOrder[2]!,
    ];
    const a = await run(inOrder);
    const b = await run(scrambled);
    expect(b.median).toBeCloseTo(a.median, 9);
  });

  it('normalizes a micro-prefix unit alias before converting the curve', async () => {
    // A saved or imported case can carry `ug/L`. Unnormalized it fails
    // `isConcentrationUnit`, so the mg/L values were emitted unconverted under
    // a `ug/L` label — a 1000x display error.
    const alias = await run([
      { id: 'd', type: 'dose', t: 0, unit: 'mg', route: 'oral' },
      { id: 'm', type: 'measurement', t: 4, value: 50, unit: 'ug/L' },
      { id: 'q', type: 'query', t: 4, solveFor: 'dose' },
    ]);
    const canonical = await run([
      { id: 'd', type: 'dose', t: 0, unit: 'mg', route: 'oral' },
      { id: 'm', type: 'measurement', t: 4, value: 50, unit: 'µg/L' },
      { id: 'q', type: 'query', t: 4, solveFor: 'dose' },
    ]);
    expect(alias.curveUnit).toBe('µg/L');
    expect(alias.median).toBeCloseTo(canonical.median, 9);
    // 50 µg/L = 0.05 mg/L, so the curve at the measurement time is ~50 in µg/L.
    const atMeasurement = alias.timeSeries.find((p) => p.t >= 4)!;
    expect(atMeasurement.median).toBeGreaterThan(1);
  });

  it(
    'reports a refused run as having no answer, not as an estimate of zero',
    async () => {
      // `coreFailureResult` fills the percentiles with placeholder zeros. Those
      // must never reach a numeric surface as "0", so the result is marked
      // failed and the answer/export surfaces suppress it.
      const refused = await run(
        [
          { id: 'd', type: 'dose', t: 0, unit: 'mg', route: 'oral' },
          { id: 'm', type: 'measurement', t: 4, value: 0.05, unit: 'mg/L' },
          { id: 'q', type: 'query', t: 4, solveFor: 'dose' },
        ],
        'MDMA',
      );
      expect(refused.failure?.messageKey).toBe(
        'simulator.warnings.nonlinearDoseSolve',
      );
      expect(refused.median).toBe(0);
      expect(refused.timeSeries).toHaveLength(0);
    },
    30_000,
  );

  it('states which matrix the entered concentration is read as', async () => {
    // A measurement event carries no matrix, and the model computes in plasma.
    // Both inverse modes anchor on the entered value, so the reading has to be
    // stated — the chart converts the curve out of that matrix afterwards.
    const dose = await run([
      { id: 'd', type: 'dose', t: 0, unit: 'mg', route: 'oral' },
      { id: 'm', type: 'measurement', t: 4, value: 0.05, unit: 'mg/L' },
      { id: 'q', type: 'query', t: 4, solveFor: 'dose' },
    ]);
    const extrapolation = await run([
      { id: 'm', type: 'measurement', t: 0, value: 3, unit: 'µmol/L' },
      { id: 'q', type: 'query', t: 4, solveFor: 'concentration' },
    ]);
    for (const result of [dose, extrapolation]) {
      const warning = result.warnings.find(
        (w) => w.messageKey === 'simulator.warnings.observationMatrixAssumed',
      );
      expect(warning?.messageParams?.matrix).toBe('plasma');
      expect(result.assumptions.nativeMatrix).toBe('plasma');
    }
  });
});
