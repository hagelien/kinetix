import { describe, it, expect } from 'vitest';
import {
  parseRatio,
  describeRatio,
  convertBetweenKinds,
  getUnitKind,
  molarUnits,
  massUnits,
} from './conversions';

describe('conversions', () => {
  describe('parseRatio', () => {
    it('returns numeric value when valid', () => {
      expect(parseRatio(1.5)).toBe(1.5);
    });

    it('extracts numeric from range', () => {
      expect(parseRatio({ median: 1.2 })).toBe(1.2);
    });

    it('returns 1 for invalid values', () => {
      expect(parseRatio(null)).toBe(1);
      expect(parseRatio(undefined)).toBe(1);
      expect(parseRatio(0)).toBe(1);
      expect(parseRatio(-1)).toBe(1);
    });
  });

  describe('describeRatio', () => {
    it('collapses a min/max range to its midpoint and reports the bounds', () => {
      const info = describeRatio({ min: 0.5, max: 0.6 });
      expect(info.applied).toBeCloseTo(0.55, 10);
      expect(info.min).toBe(0.5);
      expect(info.max).toBe(0.6);
      expect(info.isRange).toBe(true);
      expect(info.defined).toBe(true);
    });

    it('marks a single-point ratio as not a range', () => {
      const info = describeRatio({ median: 0.6 });
      expect(info.applied).toBe(0.6);
      expect(info.isRange).toBe(false);
      expect(info.defined).toBe(true);
    });

    it('handles a bare number ratio', () => {
      const info = describeRatio(1);
      expect(info.applied).toBe(1);
      expect(info.isRange).toBe(false);
      expect(info.defined).toBe(true);
    });

    it('falls back to 1 and flags undefined when no data', () => {
      const info = describeRatio(null);
      expect(info.applied).toBe(1);
      expect(info.defined).toBe(false);
    });
  });

  describe('getUnitKind', () => {
    it('identifies molar units', () => {
      expect(getUnitKind('µmol/L')).toBe('molar');
      expect(getUnitKind('nmol/L')).toBe('molar');
      expect(getUnitKind('mmol/L')).toBe('molar');
    });

    it('identifies mass units', () => {
      expect(getUnitKind('µg/L')).toBe('mass');
      expect(getUnitKind('mg/L')).toBe('mass');
    });

    it('returns null for unknown units', () => {
      expect(getUnitKind('unknown')).toBeNull();
      expect(getUnitKind(null)).toBeNull();
    });
  });

  describe('convertBetweenKinds', () => {
    const mockDrug = {
      molecularWeight: 300,
      bloodPlasmaRatio: 1,
    };

    it('converts molar to mass', () => {
      const result = convertBetweenKinds(
        1,
        'molar',
        'µmol/L',
        'blood',
        'mass',
        'mg/L',
        'blood',
        mockDrug
      );
      // 1 µmol/L * 300 g/mol = 300 µg/L = 0.3 mg/L
      expect(result).toBeCloseTo(0.3, 4);
    });

    it('converts mass to molar', () => {
      const result = convertBetweenKinds(
        0.3,
        'mass',
        'mg/L',
        'blood',
        'molar',
        'µmol/L',
        'blood',
        mockDrug
      );
      // 0.3 mg/L = 300 µg/L / 300 g/mol = 1 µmol/L
      expect(result).toBeCloseTo(1, 4);
    });

    it('handles matrix conversion', () => {
      const drugWithRatio = { ...mockDrug, bloodPlasmaRatio: 0.8 };
      const result = convertBetweenKinds(
        100,
        'mass',
        'µg/L',
        'blood',
        'mass',
        'µg/L',
        'plasma/serum',
        drugWithRatio
      );
      // blood to plasma: divide by ratio
      expect(result).toBeCloseTo(125, 4);
    });

    it('returns empty string for invalid input', () => {
      expect(
        convertBetweenKinds('', 'molar', 'µmol/L', 'blood', 'mass', 'mg/L', 'blood', mockDrug)
      ).toBe('');
    });

    // #1287 Codex P1: the widened mass-unit range (#1209) put a 1e7 ratio
    // between the smallest and largest factor, and the old fixed
    // 6-decimal-place round turned a real result into 0.
    it('does not round a small nonzero result to 0 across the widened unit range', () => {
      const result = convertBetweenKinds(
        1,
        'mass',
        'ng/L',
        'blood',
        'mass',
        'mg/dL',
        'blood',
        mockDrug
      );
      // 1 ng/L = 1e-3 µg/L; mg/dL is 1e4 µg/L, so the ratio is 1e-7.
      expect(result).toBe(1e-7);
    });
  });

  describe('unit factors', () => {
    it('has correct molar unit factors', () => {
      expect(molarUnits['nmol/L']).toBe(1e-9);
      expect(molarUnits['µmol/L']).toBe(1e-6);
      expect(molarUnits['mmol/L']).toBe(1e-3);
    });

    it('has correct mass unit factors', () => {
      expect(massUnits['µg/L']).toBe(1);
      expect(massUnits['mg/L']).toBe(1e3);
    });

    // #1209: every unit PreferencesPage.tsx's MASS_UNITS/MOLAR_UNITS lists
    // (i.e. everything a user can enable in settings) must have a matching
    // entry here, or the row/tooltip converter can't offer it as an option.
    it('has an entry for every unit the preferences UI can enable', () => {
      const settingsMassUnits = [
        'mg/L', 'µg/mL', 'ng/mL', 'µg/L', 'ng/L', 'mg/dL', 'µg/dL', 'ng/dL',
      ];
      const settingsMolarUnits = [
        'mmol/L', 'µmol/L', 'nmol/L', 'mmol/dL', 'µmol/dL', 'nmol/dL',
      ];
      for (const unit of settingsMassUnits) {
        expect(massUnits[unit]).not.toBeUndefined();
      }
      for (const unit of settingsMolarUnits) {
        expect(molarUnits[unit]).not.toBeUndefined();
      }
    });

    // Cross-checked against the independently-defined, already-correct
    // factors in `unitConversion.ts` (MASS_TO_MG_PER_L / MOLAR_TO_MMOL_PER_L),
    // just rescaled onto this file's µg/L / mol/L basis instead of mg/L / mmol/L.
    it('agrees with unitConversion.ts on well-known unit equivalences', () => {
      // 1 mg/L == 1 µg/mL == 1000 ng/mL
      expect(massUnits['mg/L']).toBe(massUnits['µg/mL']);
      expect(massUnits['mg/L']).toBe(massUnits['ng/mL']! * 1000);
      // 1 mg/dL == 10 mg/L
      expect(massUnits['mg/dL']).toBe(massUnits['mg/L']! * 10);
      // 1 µg/dL == 10 µg/L; 1 ng/dL == 10 ng/L
      expect(massUnits['µg/dL']).toBe(massUnits['µg/L']! * 10);
      expect(massUnits['ng/dL']).toBe(massUnits['ng/L']! * 10);
      // Same /dL == 10x /L pattern for molar units
      expect(molarUnits['mmol/dL']).toBeCloseTo(molarUnits['mmol/L']! * 10, 15);
      expect(molarUnits['µmol/dL']).toBeCloseTo(molarUnits['µmol/L']! * 10, 15);
      expect(molarUnits['nmol/dL']).toBeCloseTo(molarUnits['nmol/L']! * 10, 15);
    });
  });
});
