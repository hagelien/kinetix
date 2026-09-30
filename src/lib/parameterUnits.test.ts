import { describe, it, expect } from 'vitest';
import {
  DIMENSIONLESS_UNIT,
  convertParameterValue,
  entryUnitsForParameter,
  formatUnitSuffix,
  preferredDisplayUnit,
} from './parameterUnits';

describe('entryUnitsForParameter', () => {
  it('gives a concentration parameter the full canonical source-unit set', () => {
    // A paper reports in whatever unit it likes, and every unit in the set
    // converts to the canonical one at read time.
    const units = entryUnitsForParameter('therapeuticConcentration');
    expect(units).toContain('mg/L');
    expect(units).toContain('µmol/L');
    // Legacy reference_concentrations rows were written with this set, so they
    // stay re-validatable.
    expect(units).toContain('mg/mL');
  });

  it('limits a single-unit parameter to its own unit', () => {
    expect([...entryUnitsForParameter('halfLife')]).toEqual(['h']);
    expect([...entryUnitsForParameter('proteinBinding')]).toEqual(['fraction']);
    expect([...entryUnitsForParameter('bloodPlasmaRatio')]).toEqual(['ratio']);
  });

  it('gives a dimensionless parameter the empty unit only', () => {
    for (const id of ['logP', 'logD', 'pKa'] as const) {
      expect([...entryUnitsForParameter(id)]).toEqual([DIMENSIONLESS_UNIT]);
    }
  });

  it('offers every clearance unit', () => {
    expect([...entryUnitsForParameter('clearance')]).toEqual([
      'L/h',
      'L/min',
      'mL/min',
      'L/h/kg',
      'mL/min/kg',
    ]);
  });
});

describe('convertParameterValue', () => {
  it('passes identical units straight through', () => {
    expect(convertParameterValue(6, 'h', 'h')).toBe(6);
    expect(convertParameterValue(-1.2, '', '')).toBe(-1.2);
  });

  it('converts within a linear family', () => {
    // 1 mL/min = 60 mL/h = 0.06 L/h.
    expect(convertParameterValue(100, 'mL/min', 'L/h')).toBeCloseTo(6, 10);
    expect(convertParameterValue(6, 'L/h', 'mL/min')).toBeCloseTo(100, 10);
    expect(convertParameterValue(1, 'mL/min/kg', 'L/h/kg')).toBeCloseTo(0.06, 10);
    // A clearance the literature states per minute in litres — cocaine's ~2
    // L/min — must pool with one stated in L/h rather than drop out.
    expect(convertParameterValue(2, 'L/min', 'L/h')).toBeCloseTo(120, 10);
    expect(convertParameterValue(120, 'L/h', 'L/min')).toBeCloseTo(2, 10);
    expect(convertParameterValue(2, 'L/min', 'mL/min')).toBeCloseTo(2000, 10);
  });

  it('converts absolute dose masses to mg', () => {
    // A fatal dose reported in grams must pool with one reported in mg.
    expect(convertParameterValue(2, 'g', 'mg')).toBeCloseTo(2000, 10);
    expect(convertParameterValue(500, 'µg', 'mg')).toBeCloseTo(0.5, 10);
    expect(convertParameterValue(1500, 'mg', 'g')).toBeCloseTo(1.5, 10);
  });

  it('refuses conversions across families', () => {
    // L/h → L/h/kg needs a body weight no entry carries.
    expect(convertParameterValue(6, 'L/h', 'L/h/kg')).toBeNull();
    expect(convertParameterValue(6, 'h', 'fraction')).toBeNull();
    // Weight- and time-normalized doses need a body weight or dosing interval
    // no entry carries, so they never rescale to an absolute mg.
    expect(convertParameterValue(5, 'mg/kg', 'mg')).toBeNull();
    expect(convertParameterValue(5, 'mg/day', 'mg')).toBeNull();
    expect(convertParameterValue(5, 'mg/kg/day', 'mg/kg')).toBeNull();
  });

  it('converts concentrations, and refuses molar without a molecular weight', () => {
    expect(convertParameterValue(1, 'mg/L', 'ng/mL')).toBeCloseTo(1000, 6);
    expect(convertParameterValue(1, 'µmol/L', 'mg/L')).toBeNull();
    expect(convertParameterValue(1, 'µmol/L', 'mg/L', 200)).toBeCloseTo(0.2, 6);
  });
});

describe('formatUnitSuffix', () => {
  it('renders nothing for a dimensionless value', () => {
    expect(formatUnitSuffix('')).toBe('');
    expect(formatUnitSuffix(null)).toBe('');
    expect(formatUnitSuffix('mg/L')).toBe(' mg/L');
  });
});

describe('preferredDisplayUnit', () => {
  it("follows the reader's primary unit when the value can convert into it", () => {
    expect(preferredDisplayUnit('mg/L', ['µmol/L', 'mg/L'], 200)).toBe('µmol/L');
    expect(preferredDisplayUnit('ng/mL', ['mg/L'], null)).toBe('mg/L');
  });

  it('keeps the authored unit when the conversion is not available', () => {
    // Mass→molar needs a molecular weight; without one the authored unit stands.
    expect(preferredDisplayUnit('mg/L', ['µmol/L'], null)).toBe('mg/L');
    // Non-concentration quantities convert to nothing else.
    expect(preferredDisplayUnit('h', ['µmol/L'], 200)).toBe('h');
    expect(preferredDisplayUnit('', ['µmol/L'], 200)).toBe('');
    expect(preferredDisplayUnit('ratio', [], 200)).toBe('ratio');
  });
});
