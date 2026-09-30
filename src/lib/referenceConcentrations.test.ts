import { describe, it, expect } from 'vitest';
import {
  REFERENCE_MATRICES,
  REFERENCE_SCENARIOS,
  REFERENCE_UNITS,
  SCENARIO_TO_PARAMETER,
  defaultScenarioForParameter,
  scenariosForParameter,
  referenceConcentrationInputSchema,
} from './referenceConcentrations';
import {
  parameterIsSummarizable,
  isDrugParameterId,
} from './drugParameters';

const baseValid = {
  drugId: 1,
  low: 10,
  high: 100,
  unit: 'ng/mL' as const,
  matrix: 'serum' as const,
  scenario: 'living_therapeutic' as const,
};

describe('SCENARIO_TO_PARAMETER (migration 0078 mapping)', () => {
  it('maps every scenario to a valid summarized parameter id', () => {
    for (const scenario of REFERENCE_SCENARIOS) {
      const parameter = SCENARIO_TO_PARAMETER[scenario];
      expect(isDrugParameterId(parameter)).toBe(true);
      expect(parameterIsSummarizable(parameter as never)).toBe(true);
    }
  });

  it('maps the clean interpretive scenarios to their parameters', () => {
    expect(SCENARIO_TO_PARAMETER.living_therapeutic).toBe(
      'therapeuticConcentration',
    );
    expect(SCENARIO_TO_PARAMETER.living_toxic).toBe('toxicConcentration');
    expect(SCENARIO_TO_PARAMETER.living_dui).toBe('impairmentConcentration');
    expect(SCENARIO_TO_PARAMETER.postmortem_mono_intox).toBe(
      'fatalConcentration',
    );
    expect(SCENARIO_TO_PARAMETER.postmortem_poly_intox).toBe(
      'fatalConcentration',
    );
  });
});

describe('referenceConcentrations canonical enums', () => {
  it('exposes the 8 owner-specified scenarios', () => {
    expect(REFERENCE_SCENARIOS).toEqual([
      'living_therapeutic',
      'living_toxic',
      'living_dui',
      'postmortem_non_intox',
      'postmortem_mono_intox',
      'postmortem_poly_intox',
      'case_report',
      'case_series',
    ]);
  });

  it('exposes 18 unit strings (nano/micro/milli × mL/dL/L, mass and molar)', () => {
    expect(REFERENCE_UNITS).toHaveLength(18);
    expect(REFERENCE_UNITS).toEqual([
      'ng/mL', 'ng/dL', 'ng/L',
      'µg/mL', 'µg/dL', 'µg/L',
      'mg/mL', 'mg/dL', 'mg/L',
      'nmol/mL', 'nmol/dL', 'nmol/L',
      'µmol/mL', 'µmol/dL', 'µmol/L',
      'mmol/mL', 'mmol/dL', 'mmol/L',
    ]);
    // Spot-check a few representative combinations across prefix × volume.
    expect(REFERENCE_UNITS).toContain('ng/mL');
    expect(REFERENCE_UNITS).toContain('mg/L');
    expect(REFERENCE_UNITS).toContain('µg/dL');
    expect(REFERENCE_UNITS).toContain('nmol/L');
    expect(REFERENCE_UNITS).toContain('µmol/mL');
    expect(REFERENCE_UNITS).toContain('mmol/dL');
  });

  it('includes serum, plasma and whole_blood matrices', () => {
    expect(REFERENCE_MATRICES).toContain('serum');
    expect(REFERENCE_MATRICES).toContain('plasma');
    expect(REFERENCE_MATRICES).toContain('whole_blood');
  });
});

describe('referenceConcentrationInputSchema — unit enum', () => {
  it.each(REFERENCE_UNITS)('accepts %s', (unit) => {
    const result = referenceConcentrationInputSchema.safeParse({
      ...baseValid,
      unit,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown unit', () => {
    const result = referenceConcentrationInputSchema.safeParse({
      ...baseValid,
      unit: 'mg/mL/extra',
    });
    expect(result.success).toBe(false);
  });
});

describe('referenceConcentrationInputSchema — matrix and scenario', () => {
  it.each(REFERENCE_MATRICES)('accepts matrix %s', (matrix) => {
    expect(
      referenceConcentrationInputSchema.safeParse({ ...baseValid, matrix }).success,
    ).toBe(true);
  });

  it.each(REFERENCE_SCENARIOS)('accepts scenario %s', (scenario) => {
    expect(
      referenceConcentrationInputSchema.safeParse({ ...baseValid, scenario }).success,
    ).toBe(true);
  });

  it('rejects an unknown matrix', () => {
    expect(
      referenceConcentrationInputSchema.safeParse({
        ...baseValid,
        matrix: 'cerebrospinal',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown scenario', () => {
    expect(
      referenceConcentrationInputSchema.safeParse({
        ...baseValid,
        scenario: 'living_fatal',
      }).success,
    ).toBe(false);
  });
});

describe('referenceConcentrationInputSchema — low/high', () => {
  it('accepts low only', () => {
    const { high: _, ...rest } = baseValid;
    const result = referenceConcentrationInputSchema.safeParse(rest);
    expect(result.success).toBe(true);
  });

  it('accepts high only', () => {
    const { low: _, ...rest } = baseValid;
    const result = referenceConcentrationInputSchema.safeParse(rest);
    expect(result.success).toBe(true);
  });

  it('accepts both low and high', () => {
    expect(referenceConcentrationInputSchema.safeParse(baseValid).success).toBe(true);
  });

  it('rejects when neither low nor high is present', () => {
    const { low: _l, high: _h, ...rest } = baseValid;
    const result = referenceConcentrationInputSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects when low > high', () => {
    const result = referenceConcentrationInputSchema.safeParse({
      ...baseValid,
      low: 200,
      high: 100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative low', () => {
    const result = referenceConcentrationInputSchema.safeParse({
      ...baseValid,
      low: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe('referenceConcentrationInputSchema — n and citationId', () => {
  it('accepts positive integer n', () => {
    expect(
      referenceConcentrationInputSchema.safeParse({ ...baseValid, n: 42 }).success,
    ).toBe(true);
  });

  it('rejects non-positive n', () => {
    expect(
      referenceConcentrationInputSchema.safeParse({ ...baseValid, n: 0 }).success,
    ).toBe(false);
    expect(
      referenceConcentrationInputSchema.safeParse({ ...baseValid, n: -3 }).success,
    ).toBe(false);
  });

  it('rejects non-integer n', () => {
    expect(
      referenceConcentrationInputSchema.safeParse({ ...baseValid, n: 1.5 }).success,
    ).toBe(false);
  });

  it('accepts positive integer citationId', () => {
    expect(
      referenceConcentrationInputSchema.safeParse({
        ...baseValid,
        citationId: 7,
      }).success,
    ).toBe(true);
  });

  it('rejects non-integer drugId', () => {
    expect(
      referenceConcentrationInputSchema.safeParse({ ...baseValid, drugId: 1.5 }).success,
    ).toBe(false);
  });
});

describe('scenariosForParameter / defaultScenarioForParameter', () => {
  it('restricts to scenarios that back the parameter and defaults sensibly', () => {
    // toxicConcentration is backed by living_toxic (among others), never
    // living_therapeutic — so the default is a toxic scenario, not therapeutic.
    const toxic = scenariosForParameter('toxicConcentration');
    expect(toxic.length).toBeGreaterThan(0);
    expect(toxic.every((s) => SCENARIO_TO_PARAMETER[s] === 'toxicConcentration')).toBe(true);
    expect(defaultScenarioForParameter('toxicConcentration')).toBe('living_toxic');
    expect(defaultScenarioForParameter('fatalConcentration')).toBe(
      'postmortem_non_intox',
    );
  });

  it('falls back to all scenarios for a parameter with no dedicated scenario', () => {
    // supratherapeuticConcentration has no scenario in SCENARIO_TO_PARAMETER.
    expect(scenariosForParameter('supratherapeuticConcentration')).toEqual([
      ...REFERENCE_SCENARIOS,
    ]);
  });
});
