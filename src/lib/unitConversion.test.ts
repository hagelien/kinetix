import { describe, it, expect } from 'vitest';
import {
  convertConcentration,
  defaultConcentrationUnit,
  convertConcentrationRange,
  isConcentrationUnit,
  isMassUnit,
  isMolarUnit,
} from './unitConversion';

describe('unitConversion — dL variants', () => {
  it('converts mg/dL to mg/L (x10)', () => {
    expect(convertConcentration(1, 'mg/dL', 'mg/L')).toBe(10);
  });

  it('converts µg/dL to µg/L', () => {
    // 1 µg/dL = 0.01 mg/L = 10 µg/L
    expect(convertConcentration(1, 'µg/dL', 'µg/L')).toBeCloseTo(10, 10);
  });

  it('converts ng/dL to ng/mL', () => {
    // 100 ng/dL = 1 ng/mL
    expect(convertConcentration(100, 'ng/dL', 'ng/mL')).toBeCloseTo(1, 10);
  });

  it('round-trips mg/dL -> mg/L -> mg/dL', () => {
    const v = 150;
    const mgL = convertConcentration(v, 'mg/dL', 'mg/L');
    expect(convertConcentration(mgL, 'mg/L', 'mg/dL')).toBeCloseTo(v, 10);
  });

  it('converts molar dL units (nmol/dL to nmol/L)', () => {
    // 1 nmol/dL = 10 nmol/L
    expect(convertConcentration(1, 'nmol/dL', 'nmol/L')).toBeCloseTo(10, 10);
  });

  it('cross-category: nmol/dL -> ng/mL with MW', () => {
    // MW 300 g/mol. 100 nmol/dL = 1000 nmol/L = 1 µmol/L.
    // 1 µmol/L × 300 g/mol = 300 µg/L = 0.3 µg/mL = 300 ng/mL.
    expect(convertConcentration(100, 'nmol/dL', 'ng/mL', 300)).toBeCloseTo(300, 6);
  });

  it('recognises the new units via isConcentrationUnit', () => {
    expect(isConcentrationUnit('mg/dL')).toBe(true);
    expect(isConcentrationUnit('nmol/dL')).toBe(true);
    expect(isConcentrationUnit('bogus')).toBe(false);
  });

  it('categorises dL units correctly', () => {
    expect(isMassUnit('mg/dL')).toBe(true);
    expect(isMolarUnit('nmol/dL')).toBe(true);
  });
});

describe('convertConcentrationRange', () => {
  it('converts a min–max range within the same kind without MW', () => {
    const result = convertConcentrationRange(
      { min: 100, max: 300, unit: 'nmol/L' },
      'µmol/L',
    );
    expect(result).not.toBeNull();
    expect(result!.unit).toBe('µmol/L');
    expect(result!.min).toBeCloseTo(0.1, 10);
    expect(result!.max).toBeCloseTo(0.3, 10);
  });

  it('converts across kinds with a molecular weight', () => {
    // 1 µmol/L × MW 300 = 300 µg/L = 0.3 mg/L
    const result = convertConcentrationRange(
      { median: 1, unit: 'µmol/L' },
      'mg/L',
      300,
    );
    expect(result).not.toBeNull();
    expect(result!.median).toBeCloseTo(0.3, 10);
  });

  it('returns null when crossing kinds without a molecular weight', () => {
    expect(
      convertConcentrationRange({ median: 1, unit: 'µmol/L' }, 'mg/L'),
    ).toBeNull();
  });

  it('returns null when source unit is unrecognised', () => {
    expect(
      convertConcentrationRange({ median: 1, unit: 'IU/L' }, 'µmol/L'),
    ).toBeNull();
  });

  it('returns the original range when source equals target', () => {
    const range = { min: 1, max: 2, unit: 'µmol/L' };
    expect(convertConcentrationRange(range, 'µmol/L')).toBe(range);
  });

  it('preserves qualifier and note metadata', () => {
    const result = convertConcentrationRange(
      { median: 1000, unit: 'nmol/L', qualifier: '≥', note: 'toxic' },
      'µmol/L',
    );
    expect(result).not.toBeNull();
    expect(result!.qualifier).toBe('≥');
    expect(result!.note).toBe('toxic');
    expect(result!.median).toBeCloseTo(1, 10);
  });
});

describe('defaultConcentrationUnit', () => {
  // A new concentration event used to start in a hardcoded mg/L, ignoring the
  // user's primary display unit — so a µmol/L user typed into a mg/L field.
  it('starts a new measurement in the user\'s primary unit', () => {
    expect(defaultConcentrationUnit(['µmol/L', 'mg/L'], 135.2)).toBe('µmol/L');
  });

  it('falls back when the drug cannot express the primary unit', () => {
    // A molar unit needs a molecular weight to convert; without one the unit
    // picker does not offer it, so seeding it would leave the field showing a
    // value outside its own option list.
    expect(defaultConcentrationUnit(['µmol/L', 'mg/L'], null)).toBe('mg/L');
  });

  it('takes the first alternate the drug can serve before defaulting', () => {
    expect(defaultConcentrationUnit(['µmol/L', 'ng/mL'], undefined)).toBe(
      'ng/mL',
    );
  });

  it('defaults to mg/L for an empty or unusable preference list', () => {
    expect(defaultConcentrationUnit([], 135.2)).toBe('mg/L');
    expect(defaultConcentrationUnit(['not-a-unit'], 135.2)).toBe('mg/L');
  });

  it('accepts micro-prefix variants of the stored preference', () => {
    expect(defaultConcentrationUnit(['umol/L'], 135.2)).toBe('µmol/L');
  });
});
