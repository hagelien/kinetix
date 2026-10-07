import { describe, it, expect } from 'vitest';
import {
  getAlternativeUnits,
  getAlternativeUnitsForRange,
  getConversionTooltipRows,
  getPreferredUnitDisplay,
  isConcentrationParameterId,
} from './unitTooltip';

// Non-breaking space used as the thousands separator in formatted numbers.
const NBSP = '\u00A0';

describe('unitTooltip — getAlternativeUnits', () => {
  it('returns same-kind alternatives without molecular weight', () => {
    const out = getAlternativeUnits(1, 'µmol/L', null);
    const map = Object.fromEntries(out.map((a) => [a.unit, a.formatted]));
    expect(map['nmol/L']).toBe(`1${NBSP}000`);
    expect(map['mmol/L']).toBe('0.001');
    // mass alternatives skipped without MW
    expect(map['mg/L']).toBeUndefined();
    expect(map['µg/L']).toBeUndefined();
  });

  it('returns molar→mass alternatives with molecular weight', () => {
    // 1 µmol/L of MW 100 = 0.1 mg/L = 100 µg/L
    const out = getAlternativeUnits(1, 'µmol/L', 100);
    const map = Object.fromEntries(out.map((a) => [a.unit, a.formatted]));
    expect(map['mg/L']).toBe('0.1');
    expect(map['µg/L']).toBe('100');
  });

  it('handles ng/mL source units (simulator default)', () => {
    // 100 ng/mL at MW 200 = 0.1 mg/L = 100 µg/L = 0.5 µmol/L
    const out = getAlternativeUnits(100, 'ng/mL', 200);
    const map = Object.fromEntries(out.map((a) => [a.unit, a.formatted]));
    expect(map['mg/L']).toBe('0.1');
    expect(map['µg/L']).toBe('100');
    expect(map['µmol/L']).toBe('0.5');
  });

  it('handles mg/dL source units (clinical lab)', () => {
    // 80 mg/dL = 800 mg/L (ethanol-like)
    const out = getAlternativeUnits(80, 'mg/dL', null);
    const map = Object.fromEntries(out.map((a) => [a.unit, a.formatted]));
    expect(map['mg/L']).toBe('800');
  });

  it('normalizes Greek mu and ASCII u prefixes in source unit', () => {
    const out = getAlternativeUnits(1, 'μmol/L', 100);
    const map = Object.fromEntries(out.map((a) => [a.unit, a.formatted]));
    expect(map['nmol/L']).toBe(`1${NBSP}000`);
  });

  it('deduplicates numerically-equivalent alternatives', () => {
    // µg/mL and mg/L produce the same number — only the first should appear.
    const out = getAlternativeUnits(1, 'µmol/L', 100);
    const formatted = out.map((a) => a.formatted);
    const dupes = formatted.filter((v, i) => formatted.indexOf(v) !== i);
    expect(dupes).toEqual([]);
  });

  it('excludes the source unit from alternatives', () => {
    const out = getAlternativeUnits(1, 'µmol/L', 100);
    expect(out.find((a) => a.unit === 'µmol/L')).toBeUndefined();
  });

  it('returns empty list for null value', () => {
    expect(getAlternativeUnits(null, 'µmol/L', 100)).toEqual([]);
  });

  it('returns empty list for unknown unit', () => {
    expect(getAlternativeUnits(1, 'arbitrary/unit', 100)).toEqual([]);
  });

  it('returns empty list for null unit', () => {
    expect(getAlternativeUnits(1, null, 100)).toEqual([]);
  });
});

describe('unitTooltip — getAlternativeUnitsForRange', () => {
  it('formats low–high pairs in the same target unit', () => {
    const out = getAlternativeUnitsForRange(
      { low: 1, high: 2 },
      'µmol/L',
      100,
    );
    const map = Object.fromEntries(out.map((a) => [a.unit, a.formatted]));
    expect(map['mg/L']).toBe('0.1–0.2');
    expect(map['nmol/L']).toBe(`1${NBSP}000–2${NBSP}000`);
  });

  it('formats single-bound ranges with ≥ / ≤ qualifiers', () => {
    const lowOnly = getAlternativeUnitsForRange(
      { low: 1 },
      'µmol/L',
      100,
    );
    const map = Object.fromEntries(lowOnly.map((a) => [a.unit, a.formatted]));
    expect(map['mg/L']).toBe('≥ 0.1');

    const highOnly = getAlternativeUnitsForRange(
      { high: 2 },
      'µmol/L',
      100,
    );
    const map2 = Object.fromEntries(highOnly.map((a) => [a.unit, a.formatted]));
    expect(map2['mg/L']).toBe('≤ 0.2');
  });

  it('falls back to value when no low/high', () => {
    const out = getAlternativeUnitsForRange({ value: 5 }, 'µmol/L', 100);
    const map = Object.fromEntries(out.map((a) => [a.unit, a.formatted]));
    expect(map['mg/L']).toBe('0.5');
  });

  it('skips alternatives that cannot be computed', () => {
    const out = getAlternativeUnitsForRange(
      { low: 1, high: 2 },
      'µmol/L',
      null, // no MW → mass alternatives skipped
    );
    const units = out.map((a) => a.unit);
    expect(units).toContain('nmol/L');
    expect(units).toContain('mmol/L');
    expect(units).not.toContain('mg/L');
    expect(units).not.toContain('µg/L');
    expect(units).not.toContain('ng/mL');
  });

  it('handles ng/mL source on a low–high range', () => {
    const out = getAlternativeUnitsForRange(
      { low: 100, high: 300 },
      'ng/mL',
      200,
    );
    const map = Object.fromEntries(out.map((a) => [a.unit, a.formatted]));
    expect(map['µmol/L']).toBe('0.5–1.5');
  });
});

describe('unitTooltip — getPreferredUnitDisplay', () => {
  it('re-expresses a range in the first enabled (preferred) unit', () => {
    // 300–500 mg/L at MW 150 → 2000–3333 µmol/L, shown at three significant
    // figures.
    const out = getPreferredUnitDisplay(
      { low: 300, high: 500 },
      'mg/L',
      150,
      ['µmol/L', 'mg/L'],
    );
    expect(out).toEqual({
      unit: 'µmol/L',
      formatted: `2${NBSP}000–3${NBSP}330`,
    });
  });

  it('keeps three significant figures below 100', () => {
    // 1.234 mg/L at MW 150 → 8.227 µmol/L.
    const out = getPreferredUnitDisplay(
      { value: 1.234 },
      'mg/L',
      150,
      ['µmol/L', 'mg/L'],
    );
    expect(out).toEqual({ unit: 'µmol/L', formatted: '8.23' });
  });

  it('preserves single-bound ≥ / ≤ qualifiers', () => {
    const low = getPreferredUnitDisplay({ low: 1 }, 'µmol/L', 100, ['mg/L']);
    expect(low).toEqual({ unit: 'mg/L', formatted: '≥ 0.1' });
    const high = getPreferredUnitDisplay({ high: 2 }, 'µmol/L', 100, ['mg/L']);
    expect(high).toEqual({ unit: 'mg/L', formatted: '≤ 0.2' });
  });

  it('converts within a kind without a molecular weight', () => {
    const out = getPreferredUnitDisplay({ value: 5 }, 'mg/L', null, [
      'µg/L',
      'mg/L',
    ]);
    expect(out).toEqual({ unit: 'µg/L', formatted: `5${NBSP}000` });
  });

  it('returns null when the preferred unit equals the authored unit', () => {
    expect(
      getPreferredUnitDisplay({ value: 5 }, 'mg/L', 150, ['mg/L', 'µmol/L']),
    ).toBeNull();
  });

  it('returns null when a cross-kind conversion lacks a molecular weight', () => {
    expect(
      getPreferredUnitDisplay({ value: 5 }, 'mg/L', null, ['µmol/L', 'mg/L']),
    ).toBeNull();
  });

  it('returns null for unknown units or an empty preference list', () => {
    expect(getPreferredUnitDisplay({ value: 1 }, null, 100, ['µmol/L'])).toBeNull();
    expect(getPreferredUnitDisplay({ value: 1 }, 'mg/L', 100, [])).toBeNull();
  });
});

describe('unitTooltip — getConversionTooltipRows', () => {
  it('lists the authored source unit first when it differs from the display unit', () => {
    const rows = getConversionTooltipRows(
      { value: 1 },
      'mg/L',
      'µmol/L',
      100,
      ['µmol/L', 'mg/L'],
    );
    expect(rows[0]?.unit).toBe('mg/L');
  });

  it('excludes the unit shown in prose', () => {
    const rows = getConversionTooltipRows(
      { value: 1 },
      'mg/L',
      'µmol/L',
      100,
      ['µmol/L', 'mg/L'],
    );
    expect(rows.find((r) => r.unit === 'µmol/L')).toBeUndefined();
  });

  it('matches the classic alternatives when display equals source', () => {
    const args = { low: 1, high: 2 } as const;
    expect(
      getConversionTooltipRows(args, 'µmol/L', 'µmol/L', 100, ['mg/L', 'nmol/L']),
    ).toEqual(getAlternativeUnitsForRange(args, 'µmol/L', 100, ['mg/L', 'nmol/L']));
  });
});

describe('unitTooltip — isConcentrationParameterId', () => {
  it('recognises the interpretive concentration parameters', () => {
    expect(isConcentrationParameterId('impairmentConcentration')).toBe(true);
    expect(isConcentrationParameterId('therapeuticConcentration')).toBe(true);
    expect(isConcentrationParameterId('toxicConcentration')).toBe(true);
    expect(isConcentrationParameterId('fatalConcentration')).toBe(true);
  });

  it('rejects non-concentration range params', () => {
    // halfLife (h) and volumeOfDistribution (L/kg) are ranges but not
    // concentration-valued.
    expect(isConcentrationParameterId('halfLife')).toBe(false);
    expect(isConcentrationParameterId('volumeOfDistribution')).toBe(false);
  });

  it('rejects unknown and empty ids', () => {
    expect(isConcentrationParameterId('notARealParameter')).toBe(false);
    expect(isConcentrationParameterId('')).toBe(false);
    expect(isConcentrationParameterId(null)).toBe(false);
    expect(isConcentrationParameterId(undefined)).toBe(false);
  });
});
