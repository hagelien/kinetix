import { describe, it, expect } from 'vitest';
import { deriveQuestion, migrateDrugConfig } from './eventDerivation';
import type { DrugSimConfig, SimEvent } from '@/types/simulator';

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

describe('deriveQuestion route approximation warning', () => {
  const dosed = (route: DrugSimConfig['route']): SimEvent[] => [
    { id: 'd', type: 'dose', t: 0, amount: 500, unit: 'mg', route },
    { id: 'q', type: 'query', t: 2, solveFor: 'concentration' },
  ];
  const hasRouteWarning = (config: DrugSimConfig) =>
    deriveQuestion(config).warnings.some(
      (w) => w.messageKey === 'simulator.warnings.routeApproximated',
    );

  it.each(['insufflation', 'inhalation', 'other'] as const)(
    'warns that %s is approximated as immediate absorption',
    (route) => {
      expect(hasRouteWarning(baseConfig({ events: dosed(route), route }))).toBe(
        true,
      );
    },
  );

  it.each(['oral', 'iv'] as const)(
    'does not warn for the directly-modelled route %s',
    (route) => {
      expect(hasRouteWarning(baseConfig({ events: dosed(route), route }))).toBe(
        false,
      );
    },
  );
});

describe('deriveQuestion (event-based)', () => {
  it('derives later-from-earlier from a measurement + later query', () => {
    const events: SimEvent[] = [
      { id: 'm', type: 'measurement', t: 2, value: 50, unit: 'mg/L' },
      { id: 'q', type: 'query', t: 6, solveFor: 'concentration' },
    ];
    const d = deriveQuestion(baseConfig({ events }));
    expect(d.complete).toBe(true);
    expect(d.questionMode).toBe('later-from-earlier');
    expect(d.inputs.measuredConcentration).toBe(50);
    expect(d.inputs.measuredTime).toBe(2);
    expect(d.inputs.targetTime).toBe(6);
  });

  it('derives earlier-from-later when the query precedes the measurement', () => {
    const events: SimEvent[] = [
      { id: 'q', type: 'query', t: 1, solveFor: 'concentration' },
      { id: 'm', type: 'measurement', t: 5, value: 30, unit: 'mg/L' },
    ];
    const d = deriveQuestion(baseConfig({ events }));
    expect(d.questionMode).toBe('earlier-from-later');
  });

  it('derives concentration-from-dose from a dose + query', () => {
    const events: SimEvent[] = [
      { id: 'dose', type: 'dose', t: 0, amount: 500, unit: 'mg', route: 'iv' },
      { id: 'q', type: 'query', t: 4, solveFor: 'concentration' },
    ];
    const d = deriveQuestion(baseConfig({ events }));
    expect(d.questionMode).toBe('concentration-from-dose');
    expect(d.inputs.dose).toBe(500);
    expect(d.inputs.timeSinceDose).toBe(4);
    expect(d.route).toBe('iv');
  });

  it('does not run concentration-from-dose for a dose-solving query without a measurement', () => {
    const events: SimEvent[] = [
      { id: 'dose', type: 'dose', t: 0, amount: 500, unit: 'mg', route: 'iv' },
      { id: 'q', type: 'query', t: 4, solveFor: 'dose' },
    ];
    const d = deriveQuestion(baseConfig({ events }));
    expect(d.complete).toBe(false);
    expect(d.questionMode).toBe('dose-from-concentration');
    expect(d.inputs.timeSinceDose).toBeUndefined();
  });

  it('derives dose-from-concentration from a measurement + dose-solving query', () => {
    const events: SimEvent[] = [
      { id: 'dose', type: 'dose', t: 0, unit: 'mg', route: 'oral' },
      { id: 'm', type: 'measurement', t: 3, value: 12, unit: 'mg/L' },
      { id: 'q', type: 'query', t: 3, solveFor: 'dose' },
    ];
    const d = deriveQuestion(baseConfig({ events }));
    expect(d.questionMode).toBe('dose-from-concentration');
    expect(d.inputs.measuredConcentration).toBe(12);
    expect(d.inputs.timeSinceDose).toBe(3);
  });

  it('uses the measurement time (not the query time) when solving dose from concentration', () => {
    const events: SimEvent[] = [
      { id: 'dose', type: 'dose', t: 0, unit: 'mg', route: 'oral' },
      { id: 'm', type: 'measurement', t: 3, value: 12, unit: 'mg/L' },
      { id: 'q', type: 'query', t: 5, solveFor: 'dose' },
    ];
    const d = deriveQuestion(baseConfig({ events }));
    expect(d.questionMode).toBe('dose-from-concentration');
    // The concentration belongs to the measurement at t=3, so elapsed time is
    // 3 − 0 = 3, regardless of the query asking at t=5.
    expect(d.inputs.timeSinceDose).toBe(3);
  });

  it('keeps dose-solving queries incomplete without a dose anchor', () => {
    const events: SimEvent[] = [
      { id: 'm', type: 'measurement', t: 3, value: 12, unit: 'mg/L' },
      { id: 'q', type: 'query', t: 5, solveFor: 'dose' },
    ];
    const d = deriveQuestion(baseConfig({ events }));
    expect(d.questionMode).toBe('dose-from-concentration');
    expect(d.complete).toBe(false);
    expect(d.inputs.timeSinceDose).toBeUndefined();
  });

  it('requires an explicit dose anchor before solving for dose', () => {
    const events: SimEvent[] = [
      { id: 'm', type: 'measurement', t: 3, value: 12, unit: 'mg/L' },
      { id: 'q', type: 'query', t: 3, solveFor: 'dose' },
    ];
    const d = deriveQuestion(baseConfig({ events }));
    expect(d.complete).toBe(false);
    expect(d.questionMode).toBe('dose-from-concentration');
    expect(d.inputs.timeSinceDose).toBeUndefined();
  });

  it('uses the dose→measurement elapsed time as the dose elapsed time', () => {
    const events: SimEvent[] = [
      { id: 'dose', type: 'dose', t: 1, unit: 'mg', route: 'oral' },
      { id: 'm', type: 'measurement', t: 3, value: 12, unit: 'mg/L' },
      { id: 'q', type: 'query', t: 5, solveFor: 'dose' },
    ];
    const d = deriveQuestion(baseConfig({ events }));
    expect(d.questionMode).toBe('dose-from-concentration');
    // dose at t=1, measurement at t=3 → elapsed 2 (the query at t=5 is ignored).
    expect(d.inputs.timeSinceDose).toBe(2);
  });

  it('reports incomplete when not enough events exist', () => {
    const events: SimEvent[] = [
      { id: 'm', type: 'measurement', t: 2, value: 50, unit: 'mg/L' },
    ];
    expect(deriveQuestion(baseConfig({ events })).complete).toBe(false);
  });

  it('keeps dose-based questions incomplete when event timing is negative', () => {
    const concentrationEvents: SimEvent[] = [
      {
        id: 'dose',
        type: 'dose',
        t: 8,
        amount: 500,
        unit: 'mg',
        route: 'oral',
      },
      { id: 'q', type: 'query', t: 2, solveFor: 'concentration' },
    ];
    const concentration = deriveQuestion(
      baseConfig({ events: concentrationEvents }),
    );
    expect(concentration.questionMode).toBe('concentration-from-dose');
    expect(concentration.complete).toBe(false);
    expect(concentration.inputs.timeSinceDose).toBeUndefined();

    const doseEvents: SimEvent[] = [
      { id: 'dose', type: 'dose', t: 8, unit: 'mg', route: 'oral' },
      { id: 'm', type: 'measurement', t: 2, value: 12, unit: 'mg/L' },
      { id: 'q', type: 'query', t: 2, solveFor: 'dose' },
    ];
    const dose = deriveQuestion(baseConfig({ events: doseEvents }));
    expect(dose.questionMode).toBe('dose-from-concentration');
    expect(dose.complete).toBe(false);
    expect(dose.inputs.timeSinceDose).toBeUndefined();
  });

  it('does not warn about multiple doses for a forward question (they superpose)', () => {
    const events: SimEvent[] = [
      { id: 'd1', type: 'dose', t: 0, amount: 500, unit: 'mg', route: 'oral' },
      { id: 'd2', type: 'dose', t: 6, amount: 250, unit: 'mg', route: 'oral' },
      { id: 'q', type: 'query', t: 8, solveFor: 'concentration' },
    ];
    const d = deriveQuestion(baseConfig({ events }));
    expect(
      d.warnings.some(
        (w) => w.messageKey === 'simulator.warnings.multipleDosesLatestOnly',
      ),
    ).toBe(false);
  });

  it('still warns about multiple doses when solving for dose (uses the latest)', () => {
    const events: SimEvent[] = [
      { id: 'd1', type: 'dose', t: 0, amount: 500, unit: 'mg', route: 'oral' },
      { id: 'd2', type: 'dose', t: 6, amount: 250, unit: 'mg', route: 'oral' },
      { id: 'm', type: 'measurement', t: 8, value: 3, unit: 'mg/L' },
      { id: 'q', type: 'query', t: 8, solveFor: 'dose' },
    ];
    const d = deriveQuestion(baseConfig({ events }));
    expect(
      d.warnings.some(
        (w) => w.messageKey === 'simulator.warnings.multipleDosesLatestOnly',
      ),
    ).toBe(true);
  });

  it('falls back to legacy fields when there are no events', () => {
    const cfg = baseConfig({
      events: undefined as unknown as SimEvent[],
      questionMode: 'concentration-from-dose',
      route: 'iv',
      inputs: { dose: 100, doseUnit: 'mg', timeSinceDose: 2 },
    });
    const d = deriveQuestion(cfg);
    expect(d.questionMode).toBe('concentration-from-dose');
    expect(d.route).toBe('iv');
    expect(d.inputs.dose).toBe(100);
  });

  it('does not reactivate hidden legacy inputs after event rows are cleared', () => {
    const cfg = baseConfig({
      questionMode: 'concentration-from-dose',
      route: 'iv',
      inputs: { dose: 100, doseUnit: 'mg', timeSinceDose: 2 },
      events: [],
    });
    const d = deriveQuestion(cfg);
    expect(d.complete).toBe(false);
    expect(d.inputs).toEqual({});
  });
});

describe('migrateDrugConfig round-trips through deriveQuestion', () => {
  const cases: { name: string; cfg: Partial<DrugSimConfig> }[] = [
    {
      name: 'later-from-earlier',
      cfg: {
        questionMode: 'later-from-earlier',
        inputs: {
          measuredConcentration: 40,
          measuredTime: 1,
          targetTime: 5,
          concentrationUnit: 'mg/L',
        },
      },
    },
    {
      name: 'earlier-from-later',
      cfg: {
        questionMode: 'earlier-from-later',
        inputs: {
          measuredConcentration: 40,
          measuredTime: 5,
          targetTime: 1,
          concentrationUnit: 'mg/L',
        },
      },
    },
    {
      name: 'concentration-from-dose',
      cfg: {
        questionMode: 'concentration-from-dose',
        route: 'iv',
        inputs: { dose: 500, doseUnit: 'mg', timeSinceDose: 3 },
      },
    },
    {
      name: 'dose-from-concentration',
      cfg: {
        questionMode: 'dose-from-concentration',
        route: 'oral',
        inputs: {
          measuredConcentration: 12,
          timeSinceDose: 4,
          concentrationUnit: 'mg/L',
        },
      },
    },
  ];

  for (const { name, cfg } of cases) {
    it(`preserves ${name}`, () => {
      const original = baseConfig(cfg);
      const migrated = migrateDrugConfig(original);
      expect(migrated.events.length).toBeGreaterThan(0);
      const d = deriveQuestion(migrated);
      expect(d.questionMode).toBe(original.questionMode);
      expect(d.inputs.measuredConcentration).toBe(
        original.inputs.measuredConcentration,
      );
      expect(d.inputs.dose).toBe(original.inputs.dose);
      expect(d.inputs.timeSinceDose).toBe(original.inputs.timeSinceDose);
      if (original.inputs.measuredTime != null) {
        expect(d.inputs.measuredTime).toBe(original.inputs.measuredTime);
        expect(d.inputs.targetTime).toBe(original.inputs.targetTime);
      }
    });
  }

  it('is idempotent when events already exist', () => {
    const cfg = baseConfig({
      events: [{ id: 'q', type: 'query', t: 3, solveFor: 'concentration' }],
    });
    expect(migrateDrugConfig(cfg)).toBe(cfg);
  });

  it('does not invent timing for incomplete legacy dose-from-concentration rows', () => {
    const migrated = migrateDrugConfig(
      baseConfig({
        questionMode: 'dose-from-concentration',
        route: 'oral',
        inputs: { measuredConcentration: 12, concentrationUnit: 'mg/L' },
      }),
    );
    const d = deriveQuestion(migrated);
    expect(d.complete).toBe(false);
    expect(d.inputs.timeSinceDose).toBeUndefined();
  });

  it('preserves partial legacy dose-from-concentration values during migration', () => {
    const concentrationOnly = migrateDrugConfig(
      baseConfig({
        questionMode: 'dose-from-concentration',
        route: 'oral',
        inputs: { measuredConcentration: 12, concentrationUnit: 'mg/L' },
      }),
    );
    expect(concentrationOnly.events).toEqual([
      expect.objectContaining({ type: 'dose', t: 0 }),
      expect.objectContaining({
        type: 'measurement',
        t: undefined,
        value: 12,
        unit: 'mg/L',
      }),
      expect.objectContaining({ type: 'query', t: undefined }),
    ]);

    const timeOnly = migrateDrugConfig(
      baseConfig({
        questionMode: 'dose-from-concentration',
        route: 'oral',
        inputs: { timeSinceDose: 4, concentrationUnit: 'mg/L' },
      }),
    );
    expect(timeOnly.events).toEqual([
      expect.objectContaining({ type: 'dose', t: 0 }),
      expect.objectContaining({
        type: 'measurement',
        t: 4,
        value: undefined,
      }),
      expect.objectContaining({ type: 'query', t: 4 }),
    ]);
  });

  it('preserves legacy concentration prefills when event mode starts', () => {
    const migrated = migrateDrugConfig(
      baseConfig({
        questionMode: 'later-from-earlier',
        inputs: { measuredConcentration: 12, concentrationUnit: 'mg/L' },
      }),
    );
    expect(migrated.events).toEqual([
      expect.objectContaining({
        type: 'measurement',
        t: 0,
        value: 12,
        unit: 'mg/L',
      }),
    ]);
  });
});
