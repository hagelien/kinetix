import { describe, expect, it } from 'vitest';
import {
  canonicalConcentrationUnit,
  concentrationTooltipArgs,
  containsConcentration,
  parseConcentrationValue,
  splitConcentrationText,
} from './concentrationText';

describe('splitConcentrationText', () => {
  it('splits a unit out of prose, keeping the space before it in the text run', () => {
    const text = 'Påvisningstid i blod; LC-MS/MS med cut-off 1 µg/L.';
    expect(splitConcentrationText(text)).toEqual([
      { kind: 'text', text: 'Påvisningstid i blod; LC-MS/MS med cut-off ' },
      { kind: 'concentration', text: '1 µg/L', value: '1', unit: 'µg/L' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('round-trips the input exactly', () => {
    const text =
      'Toksisk 300–500 mg/L, terapeutisk 0,2 til 0,5 mg/L og < 5 ug/L i urin.';
    const segments = splitConcentrationText(text);
    expect(segments.map((s) => s.text).join('')).toBe(text);
    expect(
      segments.filter((s) => s.kind === 'concentration').length,
    ).toBe(3);
  });

  it('captures ranges, qualifiers and unit spellings as written', () => {
    const matches = splitConcentrationText(
      'from 10 to 30 mg/L, ≥ 2,5 μmol/L and 1.000 ng/mL',
    ).filter((s) => s.kind === 'concentration');
    expect(matches).toEqual([
      { kind: 'concentration', text: '10 to 30 mg/L', value: '10 to 30', unit: 'mg/L' },
      { kind: 'concentration', text: '≥ 2,5 μmol/L', value: '≥ 2,5', unit: 'μmol/L' },
      { kind: 'concentration', text: '1.000 ng/mL', value: '1.000', unit: 'ng/mL' },
    ]);
  });

  it('returns one text run for prose without a concentration', () => {
    expect(splitConcentrationText('Halveringstid 4 h.')).toEqual([
      { kind: 'text', text: 'Halveringstid 4 h.' },
    ]);
    expect(splitConcentrationText('')).toEqual([]);
  });

  it('leaves a compound unit (a rate, a per-dose figure) alone', () => {
    for (const text of [
      'Clearance 2 mg/L/h',
      'Økning 3 mg/L per dose',
      'AUC 5 mg/L⋅h',
      'AUC 5 mg/L×h',
      'AUC 5 mg/L · h',
      'AUC 5 mg/L x h',
      'AUC 5 mg/L.h',
      'AUC 5 mg/L.hr',
      'AUC 5 mg/L . h',
      'AUC 5 mg/L. h',
      'AUC 5 mg/L .h',
      'AUC 5 mg/L h',
      'AUC 5 mg/L t',
      'AUC 5 mg/L . seconds',
      'AUC 5 mg/L . days',
      'AUC 5 mg/L·min',
      'AUC 5 mg/L . minutes',
      'AUC 5 mg/L·døgn',
      'AUC 5 mg/L dag',
    ]) {
      expect(splitConcentrationText(text)).toEqual([{ kind: 'text', text }]);
      expect(containsConcentration(text)).toBe(false);
    }
  });

  it('never annotates the tail of a number it cannot read', () => {
    // A suffix-only match would convert the wrong value in the tooltip.
    for (const text of [
      'Cmax 2 500 mg/L',
      'Cmax 2\u00a0500 mg/L',
      'grense 1e-3 mg/L',
      'grense 1E3 mg/L',
      'prøve A5 mg/L',
      'grense 5 × 10^-3 mg/L',
      'grense 5 x 10-3 mg/L',
      'grense 5×10^3 mg/L',
      'grense 5 · 10\u22123 mg/L',
      'snitt 84 ± 14 ng/mL',
      'snitt 84 +/- 14 ng/mL',
      'reseptor β5 mg/L',
      'prøve Ж5 mg/L',
      '95% KI −1–3 ng/mL',
      '95% KI -1-3 ng/mL',
      'endring +2 mg/L',
      '95% KI − 1–3 ng/mL',
      'endring + 2 mg/L',
      'endring ± 2 mg/L',
    ]) {
      expect(splitConcentrationText(text)).toEqual([{ kind: 'text', text }]);
      expect(containsConcentration(text)).toBe(false);
    }
  });

  it('still reads a figure after a word, a qualifier or a range dash', () => {
    expect(
      splitConcentrationText('nivå 5 mg/L, < 2 µg/L, max 4 mg/L og 1–3 ng/mL. Slutt 7 mg/L. Hver dag 8 mg/L. Timen etter 9 mg/L. Dagen etter.')
        .filter((s) => s.kind === 'concentration')
        .map((s) => (s.kind === 'concentration' ? s.value : '')),
    ).toEqual(['5', '< 2', '4', '1–3', '7', '8', '9']);
  });

  it('agrees with containsConcentration and has no state between calls', () => {
    const text = 'cut-off 1 µg/L';
    expect(containsConcentration(text)).toBe(true);
    expect(containsConcentration(text)).toBe(true);
    expect(splitConcentrationText(text)).toHaveLength(2);
    expect(splitConcentrationText(text)).toHaveLength(2);
  });
});

describe('canonicalConcentrationUnit', () => {
  it('maps authored spellings to the registry unit', () => {
    expect(canonicalConcentrationUnit('mg/l')).toBe('mg/L');
    expect(canonicalConcentrationUnit('NG/ML')).toBe('ng/mL');
    expect(canonicalConcentrationUnit('ug/L')).toBe('µg/L');
    expect(canonicalConcentrationUnit('μmol/l')).toBe('µmol/L');
    expect(canonicalConcentrationUnit('mg/dl')).toBe('mg/dL');
  });
});

describe('parseConcentrationValue', () => {

  it('reads both decimal conventions, ranges and bounds', () => {
    expect(parseConcentrationValue('0,5')).toEqual({ value: 0.5 });
    expect(parseConcentrationValue('1.000')).toEqual({ value: 1000 });
    expect(parseConcentrationValue('0,2 til 0,5')).toEqual({ low: 0.2, high: 0.5 });
    expect(parseConcentrationValue('< 5')).toEqual({ high: 5 });
    expect(parseConcentrationValue('≥ 10')).toEqual({ low: 10 });
  });
});

describe('concentrationTooltipArgs', () => {
  it('converts both ends of a range', () => {
    expect(concentrationTooltipArgs('300–500')).toEqual({ low: 300, high: 500 });
  });

  it('converts a qualified figure as a bare bound', () => {
    // The qualifier stays visible in the prose; the tooltip must not turn a
    // strict "<" into "≤".
    expect(concentrationTooltipArgs('< 5')).toEqual({ value: 5 });
    expect(concentrationTooltipArgs('≥ 10')).toEqual({ value: 10 });
    expect(concentrationTooltipArgs('1,5')).toEqual({ value: 1.5 });
  });
});
