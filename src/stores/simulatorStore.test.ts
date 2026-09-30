import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveQuestion } from '@/lib/eventDerivation';
import { monteCarloResultToDrugSimResult } from '@/lib/modelingRun';
import { ENGINE_LIMITS } from '@/lib/kinetics-core';
import {
  buildConfigWithDrugData,
  DEFAULT_DRAW_COUNT,
  useSimulatorStore,
} from './simulatorStore';
import type {
  DrugSimConfig,
  MonteCarloResult,
  QueryEvent,
} from '@/types/simulator';
import type { DrugComponent } from '@/types';

const displaySettings = {
  mode: 'overlay' as const,
  showUncertaintyBands: true,
  normalizeMode: 'none' as const,
  yAxisMode: 'shared' as const,
  timeFormat: 'clock' as const,
  referenceTime: '00:00',
  displayMatrix: 'whole_blood' as const,
};

function baseConfig(overrides: Partial<DrugSimConfig> = {}): DrugSimConfig {
  return {
    id: 'cfg1',
    drugId: 'drug1',
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

function baseResult(
  overrides: Partial<MonteCarloResult> = {},
): MonteCarloResult {
  return {
    drugConfigId: 'cfg1',
    median: 10,
    p05: 8,
    p25: 9,
    p75: 11,
    p95: 12,
    unit: 'mg/L',
    timeSeries: [],
    warnings: [],
    sensitivity: [],
    seed: 42,
    drawCount: 100,
    ...overrides,
  };
}

beforeEach(() => {
  useSimulatorStore.setState({
    caseName: 'New Case',
    caseId: null,
    drugs: [],
    displaySettings,
    results: {},
    isRunning: false,
    runningDrugIds: new Set(),
    savedCases: [],
  });
});

describe('useSimulatorStore event migration', () => {
  it('preserves legacy prefilled concentration when adding the first event', () => {
    useSimulatorStore.setState({
      drugs: [
        baseConfig({
          inputs: { measuredConcentration: 12, concentrationUnit: 'mg/L' },
        }),
      ],
    });

    const query: QueryEvent = {
      id: 'q',
      type: 'query',
      t: 4,
      solveFor: 'concentration',
    };
    useSimulatorStore.getState().addEvent('cfg1', query);

    const [drug] = useSimulatorStore.getState().drugs;
    expect(drug).toBeDefined();
    if (!drug) throw new Error('Expected simulator drug config');
    expect(drug.events).toEqual([
      expect.objectContaining({
        type: 'measurement',
        t: 0,
        value: 12,
        unit: 'mg/L',
      }),
      query,
    ]);
    expect(deriveQuestion(drug).complete).toBe(true);
  });

  it('keeps derivation warnings when converting worker results', () => {
    const drug = baseConfig({
      events: [
        {
          id: 'd1',
          type: 'dose',
          t: 0,
          amount: 500,
          unit: 'mg',
          route: 'oral',
        },
        {
          id: 'd2',
          type: 'dose',
          t: 6,
          amount: 250,
          unit: 'mg',
          route: 'oral',
        },
        { id: 'm', type: 'measurement', t: 8, value: 3, unit: 'mg/L' },
        { id: 'q', type: 'query', t: 8, solveFor: 'dose' },
      ],
    });

    const result = monteCarloResultToDrugSimResult(
      baseResult(),
      drug,
      undefined,
    );

    // Solving for dose still uses only the latest dose, so the warning flows
    // through the worker-result conversion.
    expect(result.warnings).toEqual([
      expect.objectContaining({
        type: 'model-limitation',
        messageKey: 'simulator.warnings.multipleDosesLatestOnly',
      }),
    ]);
  });

  it('does not fall back to stale legacy inputs after the last event is removed', () => {
    useSimulatorStore.setState({
      drugs: [
        baseConfig({
          questionMode: 'concentration-from-dose',
          inputs: { dose: 500, doseUnit: 'mg', timeSinceDose: 4 },
          events: [
            {
              id: 'dose',
              type: 'dose',
              t: 0,
              amount: 500,
              unit: 'mg',
              route: 'oral',
            },
          ],
        }),
      ],
    });

    useSimulatorStore.getState().removeEvent('cfg1', 'dose');

    const [drug] = useSimulatorStore.getState().drugs;
    expect(drug?.events).toEqual([]);
    expect(drug?.inputs).toEqual({});
    expect(drug ? deriveQuestion(drug).complete : true).toBe(false);
  });
});

describe('buildConfigWithDrugData — Vd weight scaling', () => {
  function drugWithVd(
    vd: { value: number; unit?: string } | undefined,
  ): DrugComponent {
    return {
      id: 'drug1',
      name: 'Test',
      volumeOfDistribution: vd,
    } as unknown as DrugComponent;
  }

  it('scales Vd by weight only when the unit is explicitly L/kg', () => {
    const cfg = baseConfig({
      events: [
        { id: 'd', type: 'dose', t: 0, amount: 500, unit: 'mg', route: 'oral' },
        { id: 'q', type: 'query', t: 2, solveFor: 'concentration' },
      ],
      weight: 80,
    });
    const mc = buildConfigWithDrugData(
      cfg,
      drugWithVd({ value: 4, unit: 'L/kg' }),
    );
    expect(mc.weightScaling).toBe(true);
    // The supplied subject weight flows through for the L/kg scaling.
    expect(mc.weight).toBe(80);
  });

  it('falls back to a 70 kg reference adult for L/kg Vd with no subject weight', () => {
    const cfg = baseConfig({
      events: [
        { id: 'd', type: 'dose', t: 0, amount: 500, unit: 'mg', route: 'oral' },
        { id: 'q', type: 'query', t: 2, solveFor: 'concentration' },
      ],
    });
    const mc = buildConfigWithDrugData(
      cfg,
      drugWithVd({ value: 4, unit: 'L/kg' }),
    );
    expect(mc.weightScaling).toBe(true);
    expect(mc.weight).toBe(70);
  });

  it('does NOT scale an absolute-litre Vd even when a weight is entered', () => {
    const cfg = baseConfig({
      events: [
        { id: 'd', type: 'dose', t: 0, amount: 500, unit: 'mg', route: 'oral' },
        { id: 'm', type: 'measurement', t: 2, value: 5, unit: 'mg/L' },
      ],
      weight: 80,
    });
    const mc = buildConfigWithDrugData(cfg, drugWithVd({ value: 50, unit: 'L' }));
    expect(mc.weightScaling).toBe(false);
  });

  it('treats a missing Vd unit as unknown (absolute litres), not implicit L/kg', () => {
    const cfg = baseConfig({
      events: [
        { id: 'd', type: 'dose', t: 0, amount: 500, unit: 'mg', route: 'oral' },
        { id: 'm', type: 'measurement', t: 2, value: 5, unit: 'mg/L' },
      ],
      weight: 80,
    });
    const mc = buildConfigWithDrugData(cfg, drugWithVd({ value: 50 }));
    expect(mc.weightScaling).toBe(false);
  });

  it('does not scale a user override even if the drug row is L/kg', () => {
    const cfg = baseConfig({
      events: [
        { id: 'd', type: 'dose', t: 0, amount: 500, unit: 'mg', route: 'oral' },
        { id: 'm', type: 'measurement', t: 2, value: 5, unit: 'mg/L' },
      ],
      weight: 80,
      overrides: { vd: { type: 'fixed', value: 60 } },
    });
    const mc = buildConfigWithDrugData(
      cfg,
      drugWithVd({ value: 4, unit: 'L/kg' }),
    );
    expect(mc.weightScaling).toBe(false);
  });
});

describe('buildConfigWithDrugData — draw count', () => {
  it('clamps an oversized draw count to the engine cap', () => {
    const cfg = baseConfig({ overrides: { drawCount: 1_000_000 } });
    expect(buildConfigWithDrugData(cfg, undefined).drawCount).toBe(
      ENGINE_LIMITS.maxDraws,
    );
  });

  it('falls back to the default for a non-positive draw count', () => {
    const cfg = baseConfig({ overrides: { drawCount: 0 } });
    expect(buildConfigWithDrugData(cfg, undefined).drawCount).toBe(
      DEFAULT_DRAW_COUNT,
    );
  });
});

describe('buildConfigWithDrugData — repeated-dose superposition', () => {
  it('builds a doses array (relative to the first dose) for a forward multi-dose question', () => {
    const cfg = baseConfig({
      questionMode: 'concentration-from-dose',
      route: 'oral',
      events: [
        { id: 'd1', type: 'dose', t: 2, amount: 500, unit: 'mg', route: 'oral' },
        { id: 'd2', type: 'dose', t: 8, amount: 250, unit: 'mg', route: 'oral' },
        { id: 'q', type: 'query', t: 10, solveFor: 'concentration' },
      ],
    });
    const mc = buildConfigWithDrugData(cfg, undefined);
    expect(mc.doses).toEqual([
      { amount: 500, tHours: 0 },
      { amount: 250, tHours: 6 },
    ]);
    expect(mc.queryTimeHours).toBe(8);
    // The window expands to cover the last dose + query.
    expect(mc.timeRange.start).toBe(0);
    expect(mc.timeRange.end).toBeGreaterThanOrEqual(8);
  });

  it('reduces to a single-element doses array for one dose (byte-identical path)', () => {
    const cfg = baseConfig({
      questionMode: 'concentration-from-dose',
      route: 'oral',
      events: [
        { id: 'd1', type: 'dose', t: 0, amount: 500, unit: 'mg', route: 'oral' },
        { id: 'q', type: 'query', t: 4, solveFor: 'concentration' },
      ],
    });
    const mc = buildConfigWithDrugData(cfg, undefined);
    expect(mc.doses).toEqual([{ amount: 500, tHours: 0 }]);
    expect(mc.queryTimeHours).toBe(4);
  });

  it('carries an IV infusion duration onto the dose entry', () => {
    const cfg = baseConfig({
      questionMode: 'concentration-from-dose',
      route: 'iv',
      events: [
        {
          id: 'd1',
          type: 'dose',
          t: 0,
          amount: 1000,
          unit: 'mg',
          route: 'iv',
          durationHours: 2,
        },
        { id: 'q', type: 'query', t: 4, solveFor: 'concentration' },
      ],
    });
    const mc = buildConfigWithDrugData(cfg, undefined);
    expect(mc.doses).toEqual([
      { amount: 1000, tHours: 0, durationHours: 2 },
    ]);
  });

  it('ignores a duration on a non-IV dose (bolus)', () => {
    const cfg = baseConfig({
      questionMode: 'concentration-from-dose',
      route: 'oral',
      events: [
        {
          id: 'd1',
          type: 'dose',
          t: 0,
          amount: 500,
          unit: 'mg',
          route: 'oral',
          durationHours: 2,
        },
        { id: 'q', type: 'query', t: 4, solveFor: 'concentration' },
      ],
    });
    const mc = buildConfigWithDrugData(cfg, undefined);
    expect(mc.doses).toEqual([{ amount: 500, tHours: 0 }]);
  });

  it('does not superpose when solving for dose', () => {
    const cfg = baseConfig({
      questionMode: 'dose-from-concentration',
      events: [
        { id: 'd1', type: 'dose', t: 0, amount: 500, unit: 'mg', route: 'oral' },
        { id: 'd2', type: 'dose', t: 6, amount: 250, unit: 'mg', route: 'oral' },
        { id: 'm', type: 'measurement', t: 8, value: 3, unit: 'mg/L' },
        { id: 'q', type: 'query', t: 8, solveFor: 'dose' },
      ],
    });
    const mc = buildConfigWithDrugData(cfg, undefined);
    expect(mc.doses).toBeUndefined();
  });
});

describe('buildConfigWithDrugData — Bateman oral absorption', () => {
  const baseEvents: import('@/types/simulator').SimEvent[] = [
    { id: 'd', type: 'dose', t: 0, amount: 500, unit: 'mg', route: 'oral' },
    { id: 'q', type: 'query', t: 4, solveFor: 'concentration' },
  ];

  it('enables absorptionKa only when a positive ka override is supplied', () => {
    const cfg = baseConfig({
      questionMode: 'concentration-from-dose',
      route: 'oral',
      events: baseEvents,
      overrides: { ka: 1.2 },
    });
    const mc = buildConfigWithDrugData(cfg, undefined);
    expect(mc.absorptionKa).toBe(1.2);
  });

  it('leaves absorptionKa undefined by default (instantaneous absorption)', () => {
    const cfg = baseConfig({
      questionMode: 'concentration-from-dose',
      route: 'oral',
      events: baseEvents,
    });
    const mc = buildConfigWithDrugData(cfg, undefined);
    expect(mc.absorptionKa).toBeUndefined();
  });

  it('ignores a non-positive ka override', () => {
    const cfg = baseConfig({
      questionMode: 'concentration-from-dose',
      route: 'oral',
      events: baseEvents,
      overrides: { ka: 0 },
    });
    expect(buildConfigWithDrugData(cfg, undefined).absorptionKa).toBeUndefined();
  });
});

describe('useSimulatorStore loadCase display-matrix hydration', () => {
  function stubCase(displayMatrix: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 7,
          name: 'Case',
          caseData: { drugs: [], displaySettings: { displayMatrix } },
        }),
      }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to whole blood for an invalid persisted matrix', async () => {
    // caseData is arbitrary JSON: an unknown string must not survive hydration,
    // or wholeBloodDisplayFactor would read it as plasma-like and scale curves.
    stubCase('not-a-matrix');
    await useSimulatorStore.getState().loadCase(7);
    expect(useSimulatorStore.getState().displaySettings.displayMatrix).toBe(
      'whole_blood',
    );
  });

  it('falls back to whole blood for a null persisted matrix', async () => {
    stubCase(null);
    await useSimulatorStore.getState().loadCase(7);
    expect(useSimulatorStore.getState().displaySettings.displayMatrix).toBe(
      'whole_blood',
    );
  });

  it('keeps a valid persisted matrix', async () => {
    stubCase('plasma');
    await useSimulatorStore.getState().loadCase(7);
    expect(useSimulatorStore.getState().displaySettings.displayMatrix).toBe(
      'plasma',
    );
  });
});
