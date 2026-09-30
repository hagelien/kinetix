import { describe, expect, it } from 'vitest';
import { SEX_FEMALE, SEX_MALE, SEX_UNSET } from '@/lib/etohWorkbookFlowsV3';
import {
  WIDMARK_LOOKUP_HEIGHTS_CM,
  WIDMARK_LOOKUP_WEIGHTS_KG,
  lookupWidmarkR,
  widmarkLookupOutOfTable,
  widmarkREffective,
} from './widmarkLookup';

describe('lookupWidmarkR', () => {
  it('returns the workbook value at an exact grid coordinate (male 170 cm × 75 kg)', () => {
    // Confirmed against the v3 `Vd M` sheet.
    expect(lookupWidmarkR(SEX_MALE, 75, 170)).toBe(0.7);
  });

  it('returns the workbook value at an exact grid coordinate (female 170 cm × 75 kg)', () => {
    expect(lookupWidmarkR(SEX_FEMALE, 75, 170)).toBe(0.61);
  });

  it('rounds inputs to the nearest 5 (workbook C40/C41 ROUND-to-5)', () => {
    // 173 cm → 175, 77 kg → 75. Vd M[175][75] = 0.72.
    expect(lookupWidmarkR(SEX_MALE, 77, 173)).toBe(0.72);
    // Female counterpart at the same rounded coordinate: Vd K[175][75] = 0.63.
    expect(lookupWidmarkR(SEX_FEMALE, 77, 173)).toBe(0.63);
  });

  it('returns 0 when sex is unset', () => {
    expect(lookupWidmarkR(SEX_UNSET, 75, 170)).toBe(0);
  });

  it('returns 0 when weight is below the grid (45 kg minimum)', () => {
    expect(lookupWidmarkR(SEX_MALE, 30, 170)).toBe(0);
  });

  it('returns 0 when weight is above the grid (115 kg maximum)', () => {
    expect(lookupWidmarkR(SEX_MALE, 130, 200)).toBe(0);
  });

  it('returns 0 when height is below the grid (150 cm minimum)', () => {
    expect(lookupWidmarkR(SEX_MALE, 75, 140)).toBe(0);
  });

  it('returns 0 when height is above the grid (205 cm maximum)', () => {
    expect(lookupWidmarkR(SEX_MALE, 75, 215)).toBe(0);
  });

  it('returns 0 for an absent cell within the grid (height 150 cm × weight 80 kg)', () => {
    // Workbook leaves the (150, 80) cell empty in both Vd M and Vd K.
    expect(lookupWidmarkR(SEX_MALE, 80, 150)).toBe(0);
    expect(lookupWidmarkR(SEX_FEMALE, 80, 150)).toBe(0);
  });

  it('returns 0 for non-finite inputs', () => {
    expect(lookupWidmarkR(SEX_MALE, NaN, 170)).toBe(0);
    expect(lookupWidmarkR(SEX_MALE, 75, Infinity)).toBe(0);
  });

  it('accepts the entire documented weight and height grid', () => {
    expect(WIDMARK_LOOKUP_WEIGHTS_KG).toEqual([
      45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115,
    ]);
    expect(WIDMARK_LOOKUP_HEIGHTS_CM).toEqual([
      150, 155, 160, 165, 170, 175, 180, 185, 190, 195, 200, 205,
    ]);
  });
});

describe('widmarkLookupOutOfTable', () => {
  it('flags an out-of-grid male at 130 kg / 200 cm with no manual override', () => {
    expect(widmarkLookupOutOfTable(0, SEX_MALE, 130, 200)).toBe(true);
  });

  it('clears the flag once the user supplies a positive manual r', () => {
    // Workbook B44 = manualR when B43 > 0, so F82 = (B44 == 0) goes false.
    expect(widmarkLookupOutOfTable(0.72, SEX_MALE, 130, 200)).toBe(false);
  });

  it('does not flag an in-grid combination', () => {
    expect(widmarkLookupOutOfTable(0, SEX_MALE, 75, 170)).toBe(false);
  });

  it('does not flag when sex is unset (UI surfaces "Velg kjønn" first)', () => {
    expect(widmarkLookupOutOfTable(0, SEX_UNSET, 75, 170)).toBe(false);
  });

  it('does not flag when weight or height is non-positive (no input yet)', () => {
    expect(widmarkLookupOutOfTable(0, SEX_MALE, 0, 170)).toBe(false);
    expect(widmarkLookupOutOfTable(0, SEX_MALE, 75, 0)).toBe(false);
  });
});

describe('widmarkREffective — workbook B44 resolution', () => {
  it('returns the manual override when positive', () => {
    expect(widmarkREffective(0.73, SEX_MALE, 75, 170)).toBe(0.73);
  });

  it('falls through to the male lookup when manual is 0', () => {
    expect(widmarkREffective(0, SEX_MALE, 75, 170)).toBe(0.7);
  });

  it('falls through to the female lookup when manual is 0', () => {
    expect(widmarkREffective(0, SEX_FEMALE, 75, 170)).toBe(0.61);
  });

  it('returns 0 when manual is 0 and sex is unset', () => {
    expect(widmarkREffective(0, SEX_UNSET, 75, 170)).toBe(0);
  });

  it('returns 0 when manual is 0 and the lookup is out of grid', () => {
    expect(widmarkREffective(0, SEX_MALE, 130, 200)).toBe(0);
  });

  it('treats negative manual r the same as missing (workbook B43>0 condition)', () => {
    expect(widmarkREffective(-0.1, SEX_MALE, 75, 170)).toBe(0.7);
  });
});
