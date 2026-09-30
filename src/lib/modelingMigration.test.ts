import { describe, expect, it } from 'vitest';
import type { DrugComponent } from '@/types';
import {
  buildEthanolConfig,
  buildKinelabConfigFromCase,
  scenarioFromLocationHash,
} from '@/lib/modelingMigration';
import { buildScenario } from '@/lib/etohScenario';
import type { KineLabCaseData } from '@/types/kinelabCase';

const ethanolComponent: DrugComponent = {
  id: '702',
  names: { en: 'Ethanol', nb: 'Etanol' },
  molecularWeight: 46.07,
};

describe('modeling migration bridges', () => {
  it('converts a legacy ethanol scenario into an ethanol component', () => {
    const scenario = buildScenario({
      referenceTime: '22:00',
      intakes: [{ id: 'drink-1', timeHour: 1.5, ethanolGrams: 28 }],
      person: {
        weightKg: 80,
        biologicalSex: 'male',
        eliminationRateGdlPerHour: 0.016,
      },
      workbook: {
        drinkStopTime: 22 / 24,
        eventTime: 21 / 24,
        sampleTime: 23 / 24,
        detectedPromille: 0.7,
        secondSampleTime: null,
        secondSamplePromille: 0,
        eliminationMin: 0.1,
        eliminationLikely: 0.15,
        absorptionMinHours: 3,
        absorptionLikelyHours: 1,
        drinksMl: [0, 0, 0, 0, 0, 0],
        drinksAbvPercent: [0, 0, 0, 0, 0, 0],
        firstPassMinPercent: 10,
        firstPassLikelyPercent: 20,
        weightKg: 80,
        widmarkR: 0.7,
        sexMale01: 1,
        heightCm: 180,
        ageYears: 35,
      },
    });

    const config = buildEthanolConfig(ethanolComponent, scenario);

    expect(config.engine).toBe('ethanol-widmark');
    expect(config.ethanol?.weightKg).toBe(80);
    expect(config.ethanol?.workbook?.detectedPromille).toBe(0.7);
    expect(config.events).toMatchObject([
      { type: 'dose', t: 1.5, amount: 28, unit: 'g', route: 'oral' },
    ]);
  });

  it('falls back to a default ethanol config for invalid legacy scenario hashes', () => {
    expect(scenarioFromLocationHash('#scenario=not-json')).toBeNull();

    const config = buildEthanolConfig(ethanolComponent, null);

    expect(config.engine).toBe('ethanol-widmark');
    expect(config.events).toEqual([]);
    expect(config.ethanol?.weightKg).toBe(75);
  });

  it('maps saved KineLab case data into a kinelab-bayes component', () => {
    const caseData: KineLabCaseData = {
      kind: 'kinelab-case',
      schemaVersion: 1,
      input: {
        modelId: 'ketamine-one-comp-v0',
        analyte: 'ketamine',
        route: 'oral',
        observations: [
          {
            id: 'obs-1',
            analyte: 'ketamine',
            concentration: { value: 0.2, unit: 'mg/L' },
            matrix: 'whole_blood',
            sampleTime: '2026-01-01T06:00:00.000Z',
            assay: { uncertaintyCV: 0.12 },
          },
        ],
        priors: {
          dose: { type: 'uniform', min: 20, max: 500 },
          halfLife: { type: 'fixed', value: 3 },
          vd: { type: 'fixed', value: 200 },
          f: { type: 'fixed', value: 0.9 },
        },
        scenario: {
          possibleIntakeWindow: {
            earliestIso: '2026-01-01T00:00:00.000Z',
            latestIso: '2026-01-01T05:00:00.000Z',
          },
        },
        subject: { weightKg: 72, sex: 'unknown', age: 34 },
        defaultAssayCV: 0.15,
        gridResolution: 40,
        drawCount: 4000,
        seed: 42,
      },
    };

    const config = buildKinelabConfigFromCase(
      { ...ethanolComponent, id: '3821', names: { en: 'Ketamine' } },
      caseData,
      'Saved case',
    );

    expect(config.engine).toBe('kinelab-bayes');
    expect(config.label).toBe('Saved case');
    expect(config.kinelab?.priorsSnapshot).toEqual(caseData.input.priors);
    expect(config.events).toMatchObject([
      { type: 'dose', tRange: [0, 5], amountRange: { min: 20, max: 500 } },
      { type: 'measurement', t: 6, value: 0.2, assayCV: 0.12 },
    ]);
  });
});
