import { describe, expect, it } from 'vitest';
import {
  buildParameterComparison,
  formatComparisonRepresentative,
  formatComparisonValue,
  relativeRatio,
} from './comparison';
import type { DrugRow } from './drugApi';

function drug(overrides: Partial<DrugRow>): DrugRow {
  return {
    id: 1,
    slug: 'drug-a',
    names: { en: 'Drug A' },
    nameShort: null,
    aliases: null,
    pubchemCid: 1,
    molecularWeight: null,
    halfLife: null,
    volumeOfDistribution: null,
    bioavailability: null,
    proteinBinding: null,
    bloodPlasmaRatio: null,
    tmax: null,
    pKa: null,
    popularityScore: 0,
    searchKey: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('comparison helpers', () => {
  it('preserves range bounds and representative values', () => {
    const comparison = buildParameterComparison('halfLife', [
      drug({ id: 1, halfLife: { min: 4, max: 8, unit: 'h' } }),
    ]);

    expect(comparison.values[0]).toMatchObject({
      numeric: 6,
      min: 4,
      max: 8,
      unit: 'h',
      valueType: 'range',
    });
  });

  describe('the fraction-display preference', () => {
    function fractionValue(
      parameter: 'bioavailability' | 'proteinBinding',
      stored: DrugRow['bioavailability'],
    ) {
      return buildParameterComparison(parameter, [
        drug({ id: 1, [parameter]: stored }),
      ]).values[0]!;
    }

    it('writes a median-only fraction as a percentage in both columns', () => {
      // A median-only range is the common catalog shape; the value cell and
      // the representative column beside it must not disagree.
      const value = fractionValue('bioavailability', {
        median: 0.75,
        unit: 'fraction',
      });

      expect(formatComparisonValue(value, 'percent')).toBe('75%');
      expect(formatComparisonRepresentative(value, 'percent')).toBe('75%');
    });

    it('leaves a value already stored in % alone', () => {
      const value = fractionValue('proteinBinding', {
        median: 80,
        unit: '%',
      });

      expect(formatComparisonValue(value, 'percent')).toBe('80%');
      expect(formatComparisonRepresentative(value, 'percent')).toBe('80%');
    });

    it('defaults to the stored decimal', () => {
      const value = fractionValue('bioavailability', {
        median: 0.75,
        unit: 'fraction',
      });

      expect(formatComparisonValue(value)).toBe('0.75');
      expect(formatComparisonRepresentative(value)).toBe('0.75');
    });

    it('never scales a ratio, which is not a fraction', () => {
      const value = buildParameterComparison('bloodPlasmaRatio', [
        drug({ id: 1, bloodPlasmaRatio: { median: 0.9, unit: 'ratio' } }),
      ]).values[0]!;

      expect(formatComparisonValue(value, 'percent')).toBe('0.9');
      expect(formatComparisonRepresentative(value, 'percent')).toBe('0.9');
    });
  });

  it('flags unit mismatches instead of treating values as comparable', () => {
    const comparison = buildParameterComparison('therapeuticConcentration', [
      drug({
        id: 1,
        therapeuticConcentration: { median: 1, unit: 'mg/L' },
      }),
      drug({
        id: 2,
        therapeuticConcentration: { median: 1000, unit: 'ng/mL' },
      }),
    ]);

    expect(comparison.hasUnitMismatch).toBe(true);
    expect(comparison.commonUnit).toBeNull();
  });

  it('inverts Ki/IC50/EC50-style relative ratios', () => {
    expect(relativeRatio(5, 10, false)).toBe(0.5);
    expect(relativeRatio(5, 10, true)).toBe(2);
  });
});
