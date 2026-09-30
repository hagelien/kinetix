import { describe, it, expect } from 'vitest';
import {
  bloodPlasmaFactorOrNull,
  convertToDisplayMatrix,
  isChartMatrix,
  matrixConversionApplies,
  matrixDisplayFactor,
  wholeBloodDisplayFactor,
} from './matrixDisplay';

describe('bloodPlasmaFactorOrNull', () => {
  it('reads a scalar or a two-sided range, else null', () => {
    expect(bloodPlasmaFactorOrNull(0.8)).toBe(0.8);
    expect(bloodPlasmaFactorOrNull({ median: 0.55 })).toBe(0.55);
    expect(bloodPlasmaFactorOrNull({ min: 0.4, max: 0.6 })).toBeCloseTo(0.5, 6);
    // one-sided bound is not a representative factor
    expect(bloodPlasmaFactorOrNull({ min: 0.4 })).toBeNull();
    expect(bloodPlasmaFactorOrNull(0)).toBeNull();
    expect(bloodPlasmaFactorOrNull(null)).toBeNull();
  });
});

describe('isChartMatrix', () => {
  it('accepts only the three chart matrices', () => {
    expect(isChartMatrix('plasma')).toBe(true);
    expect(isChartMatrix('urine')).toBe(false);
    expect(isChartMatrix(undefined)).toBe(false);
  });
});

describe('convertToDisplayMatrix', () => {
  const r = 0.5; // [blood]/[plasma]

  it('passes blood-like sources through to whole blood', () => {
    expect(convertToDisplayMatrix(10, 'whole_blood', 'whole_blood', r)).toBe(10);
    expect(
      convertToDisplayMatrix(10, 'postmortem_femoral_blood', 'whole_blood', r),
    ).toBe(10);
  });

  it('divides blood by the ratio for plasma/serum', () => {
    // plasma = blood / r = 10 / 0.5 = 20
    expect(convertToDisplayMatrix(10, 'whole_blood', 'plasma', r)).toBeCloseTo(20, 6);
    expect(convertToDisplayMatrix(10, 'whole_blood', 'serum', r)).toBeCloseTo(20, 6);
  });

  it('passes plasma/serum through to each other, and multiplies to blood', () => {
    expect(convertToDisplayMatrix(20, 'serum', 'plasma', r)).toBe(20);
    // blood = r · plasma = 0.5 · 20 = 10
    expect(convertToDisplayMatrix(20, 'plasma', 'whole_blood', r)).toBeCloseTo(10, 6);
  });

  it('declines a cross-boundary move when the ratio is missing', () => {
    expect(convertToDisplayMatrix(10, 'whole_blood', 'plasma', null)).toBeNull();
    expect(convertToDisplayMatrix(20, 'plasma', 'whole_blood', null)).toBeNull();
    // but a same-side move needs no ratio
    expect(convertToDisplayMatrix(10, 'whole_blood', 'whole_blood', null)).toBe(10);
    expect(convertToDisplayMatrix(20, 'serum', 'plasma', null)).toBe(20);
  });

  it('returns null for a matrix the axis cannot represent', () => {
    expect(convertToDisplayMatrix(10, 'urine', 'whole_blood', r)).toBeNull();
    expect(convertToDisplayMatrix(10, 'hair', 'plasma', r)).toBeNull();
  });
});

describe('matrixConversionApplies', () => {
  it('is true only across the blood/plasma boundary', () => {
    expect(matrixConversionApplies('whole_blood', 'whole_blood')).toBe(false);
    expect(matrixConversionApplies('whole_blood', 'plasma')).toBe(true);
    expect(matrixConversionApplies('serum', 'plasma')).toBe(false);
    expect(matrixConversionApplies('serum', 'whole_blood')).toBe(true);
    expect(matrixConversionApplies('urine', 'plasma')).toBe(false);
  });
});

describe('wholeBloodDisplayFactor', () => {
  it('is 1 for whole blood and 1/r for plasma/serum', () => {
    expect(wholeBloodDisplayFactor('whole_blood', null)).toBe(1);
    expect(wholeBloodDisplayFactor('plasma', 0.5)).toBeCloseTo(2, 6);
    expect(wholeBloodDisplayFactor('serum', 0.5)).toBeCloseTo(2, 6);
    expect(wholeBloodDisplayFactor('plasma', null)).toBeNull();
  });
});

describe('matrixDisplayFactor — the modelled curve converts from its OWN matrix', () => {
  // The reviewed registry computes in plasma for 11 of 12 models, while the
  // chart defaults to whole blood. Treating the curve as already-whole-blood
  // plotted plasma numbers on a blood axis, understating them by the B:P ratio.
  it('scales a plasma model up by r when shown in whole blood', () => {
    expect(matrixDisplayFactor('plasma', 'whole_blood', 1.6)).toBeCloseTo(1.6);
  });

  it('leaves a plasma model unchanged when shown in plasma or serum', () => {
    expect(matrixDisplayFactor('plasma', 'plasma', 1.6)).toBe(1);
    expect(matrixDisplayFactor('plasma', 'serum', 1.6)).toBe(1);
  });

  it('scales a whole-blood model down by r when shown in plasma', () => {
    expect(matrixDisplayFactor('whole_blood', 'plasma', 1.6)).toBeCloseTo(1 / 1.6);
  });

  it('leaves a whole-blood model unchanged when shown in whole blood', () => {
    expect(matrixDisplayFactor('whole_blood', 'whole_blood', 1.6)).toBe(1);
  });

  it('refuses to convert without a ratio rather than substituting 1', () => {
    // A factor of 1 here would relabel the value's matrix, not convert it.
    expect(matrixDisplayFactor('plasma', 'whole_blood', null)).toBeNull();
    expect(matrixDisplayFactor('whole_blood', 'plasma', null)).toBeNull();
    // A same-side move needs no ratio, so it still resolves.
    expect(matrixDisplayFactor('plasma', 'plasma', null)).toBe(1);
  });

  it('refuses a source matrix off the blood/plasma axis', () => {
    expect(matrixDisplayFactor('urine', 'whole_blood', 1.6)).toBeNull();
  });

  it('keeps wholeBloodDisplayFactor behaviour for genuinely whole-blood data', () => {
    // The reference overlays and pooled thresholds ARE stored in whole blood.
    expect(wholeBloodDisplayFactor('whole_blood', 1.6)).toBe(1);
    expect(wholeBloodDisplayFactor('plasma', 1.6)).toBeCloseTo(1 / 1.6);
    expect(wholeBloodDisplayFactor('plasma', null)).toBeNull();
  });
});
