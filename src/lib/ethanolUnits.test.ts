import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ETHANOL_UNIT,
  ETHANOL_UNIT_OPTIONS,
  ethanolDisplayUnits,
  isEthanolDrug,
  normalizeEthanolUnit,
} from './ethanolUnits';
import {
  convertConcentrationRange,
  convertToDisplayUnit,
  isConcentrationUnit,
} from './unitConversion';
import {
  getConversionTooltipRows,
  getPreferredUnitDisplay,
} from './unitTooltip';
import {
  convertParameterDisplayValue,
  convertParameterValue,
  preferredDisplayUnit,
} from './parameterUnits';
import { convertPmValue } from './pmConcentrations';

const ETHANOL_MW = 46.07;

describe('ethanol display units', () => {
  it('defaults to per mille and offers ‰, % and every concentration unit', () => {
    expect(DEFAULT_ETHANOL_UNIT).toBe('‰');
    expect(ETHANOL_UNIT_OPTIONS.slice(0, 2)).toEqual(['‰', '%']);
    expect(ETHANOL_UNIT_OPTIONS).toContain('µmol/L');
    expect(ETHANOL_UNIT_OPTIONS).toContain('mg/L');
  });

  it('repairs an unknown stored unit to ‰', () => {
    expect(normalizeEthanolUnit('%')).toBe('%');
    expect(normalizeEthanolUnit('mg/L')).toBe('mg/L');
    expect(normalizeEthanolUnit('furlongs')).toBe('‰');
    expect(normalizeEthanolUnit(undefined)).toBe('‰');
  });

  it('recognises ethanol by its PubChem CID', () => {
    expect(isEthanolDrug({ pubchemCid: 702 })).toBe(true);
    expect(isEthanolDrug({ pubchemCid: 7028 })).toBe(false);
    expect(isEthanolDrug(null)).toBe(false);
  });

  it('puts the ethanol unit first and keeps the other enabled units', () => {
    expect(ethanolDisplayUnits(['µmol/L', 'mg/L'], '‰')).toEqual([
      '‰',
      'µmol/L',
      'mg/L',
    ]);
    expect(ethanolDisplayUnits(['µmol/L', 'mg/L'], 'mg/L')).toEqual([
      'mg/L',
      'µmol/L',
    ]);
  });

  it('never makes ‰ or % a catalog concentration unit', () => {
    // A stored `%` is a fraction (F, protein binding), never a concentration.
    expect(isConcentrationUnit('%')).toBe(false);
    expect(isConcentrationUnit('‰')).toBe(false);
    expect(convertParameterValue(1, 'mg/L', '‰')).toBeNull();
  });
});

describe('conversion into ‰ and %', () => {
  it('treats ‰ as g/L and % as g/dL', () => {
    expect(convertToDisplayUnit(500, 'mg/L', '‰')).toBeCloseTo(0.5);
    expect(convertToDisplayUnit(800, 'mg/L', '%')).toBeCloseTo(0.08);
    expect(convertToDisplayUnit(0.5, 'mg/L', 'mg/L')).toBe(0.5);
  });

  it('converts molar figures through the molecular weight', () => {
    // 10 000 µmol/L × 46.07 g/mol = 460.7 mg/L = 0.4607 ‰
    expect(convertToDisplayUnit(10000, 'µmol/L', '‰', ETHANOL_MW)).toBeCloseTo(
      0.4607,
    );
    expect(() => convertToDisplayUnit(10000, 'µmol/L', '‰')).toThrow();
  });

  it('converts a whole range for the monograph sidebar', () => {
    const out = convertConcentrationRange(
      { min: 10000, max: 20000, unit: 'µmol/L' },
      '‰',
      ETHANOL_MW,
    );
    expect(out?.unit).toBe('‰');
    expect(out?.min).toBeCloseTo(0.4607);
    expect(out?.max).toBeCloseTo(0.9214);
  });

  it('re-expresses prose and lists ‰ in the tooltip as a mass unit', () => {
    const preferred = getPreferredUnitDisplay(
      { low: 500, high: 1000 },
      'mg/L',
      ETHANOL_MW,
      ['‰', 'µmol/L'],
    );
    expect(preferred).toEqual({ unit: '‰', formatted: '0.5–1' });

    const rows = getConversionTooltipRows(
      { low: 500, high: 1000 },
      'mg/L',
      'µmol/L',
      ETHANOL_MW,
      ['µmol/L', '%'],
    );
    expect(rows.find((r) => r.unit === '%')).toMatchObject({
      formatted: '0.05–0.1',
      kind: 'mass',
    });
    // The authored unit leads the tooltip when it is not the one on screen.
    expect(rows[0]?.unit).toBe('mg/L');
  });

  it('builds the tooltip from the stored range when ‰ is on screen', () => {
    const rows = getConversionTooltipRows(
      { low: 500, high: 1000 },
      'mg/L',
      '‰',
      ETHANOL_MW,
      ['‰', 'µmol/L'],
    );
    expect(rows.map((r) => r.unit)).toEqual(['mg/L', 'µmol/L']);
  });

  it('lets source lists and forest plots display in ‰', () => {
    expect(preferredDisplayUnit('mg/L', ['‰'], ETHANOL_MW)).toBe('‰');
    expect(convertParameterDisplayValue(1, 'mg/L', '‰')).toBeCloseTo(0.001);
    // A non-concentration parameter never converts into ‰.
    expect(preferredDisplayUnit('h', ['‰'], ETHANOL_MW)).toBe('h');
  });

  it('converts postmortem figures into ‰', () => {
    expect(
      convertPmValue(1500, {
        targetUnit: '‰',
        sourceUnit: 'mg/L',
        sourceMatrix: 'whole_blood',
        displayMatrix: 'whole_blood',
      }),
    ).toBeCloseTo(1.5);
  });
});
