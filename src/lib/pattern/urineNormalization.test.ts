import { describe, expect, it } from 'vitest';
import { concentrationPerCreatinine } from './urineNormalization';
import type { PatternSpecimen } from '../../types/patternCase';

const urine: PatternSpecimen = { id: 'u', matrix: 'urine', urine: { creatinineMmolL: 5 } };

describe('concentration per mmol creatinine', () => {
  it('cancels urine volume and keeps molar and mass amounts explicit', () => {
    expect(concentrationPerCreatinine(100, 'nmol/L', urine)).toEqual({ value: 20, unit: 'nmol/mmol' });
    expect(concentrationPerCreatinine(100, 'ng/mL', urine)).toEqual({ value: 20, unit: 'µg/mmol' });
    expect(concentrationPerCreatinine(0.1, 'mg/L', urine)).toEqual({ value: 0.02, unit: 'mg/mmol' });
    expect(concentrationPerCreatinine(0, 'µmol/L', urine)).toEqual({ value: 0, unit: 'µmol/mmol' });
  });

  it('refuses missing or invalid creatinine, other matrices and unknown units', () => {
    for (const creatinineMmolL of [undefined, 0, -1, NaN, Infinity]) {
      expect(concentrationPerCreatinine(100, 'nmol/L', { ...urine, urine: { creatinineMmolL } })).toBeUndefined();
    }
    for (const unit of ['toString', '__proto__', 'unknown']) {
      expect(concentrationPerCreatinine(100, unit, urine)).toBeUndefined();
    }
    expect(concentrationPerCreatinine(100, 'nmol/L', { ...urine, matrix: 'plasma' })).toBeUndefined();
    for (const value of [undefined, NaN, Infinity, -1]) {
      expect(concentrationPerCreatinine(value, 'nmol/L', urine)).toBeUndefined();
    }
  });
});
