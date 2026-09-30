import { describe, it, expect } from 'vitest';
import {
  normalizeDecimals,
  extractNumbers,
  detectQualifier,
  parseMagnitude,
  timeFactorToHours,
  buildTimeRange,
  buildFraction,
  buildVolumeOfDistribution,
  buildRatio,
  buildConcentration,
  detectConcentrationUnit,
  parseMolecularWeight,
  parseSubstanceList,
  splitTitle,
  parseSubstancePage,
} from '../scripts/farmakologiportalen/parse';

describe('number parsing', () => {
  it('converts Norwegian decimal commas without touching list commas', () => {
    expect(normalizeDecimals('324,39')).toBe('324.39');
    expect(normalizeDecimals('0,5-3')).toBe('0.5-3');
    expect(normalizeDecimals('a, b')).toBe('a, b');
  });

  it('treats a hyphen between numbers as a separator, not a sign', () => {
    expect(extractNumbers('0,5-3')).toEqual([0.5, 3]);
    expect(extractNumbers('5,1-7,4')).toEqual([5.1, 7.4]);
    expect(extractNumbers('< 160 nmol/L')).toEqual([160]);
  });

  it('detects qualifiers', () => {
    expect(detectQualifier('< 120 nmol/L')).toBe('<');
    expect(detectQualifier('> 5')).toBe('>');
    expect(detectQualifier('1-2')).toBeUndefined();
  });
});

describe('parseMagnitude', () => {
  it('takes the central value for ± uncertainty', () => {
    expect(parseMagnitude('80±13 %')).toEqual({ median: 80, min: 80, max: 80 });
  });
  it('parses ranges', () => {
    expect(parseMagnitude('60-80 %')).toEqual({ min: 60, max: 80 });
    expect(parseMagnitude('0,6 – 1,2')).toEqual({ min: 0.6, max: 1.2 });
  });
  it('parses bounded values with a qualifier', () => {
    expect(parseMagnitude('< 120')).toEqual({ max: 120, qualifier: '<' });
    expect(parseMagnitude('> 5')).toEqual({ min: 5, qualifier: '>' });
  });
  it('parses a single value with degenerate bounds', () => {
    expect(parseMagnitude('12')).toEqual({ median: 12, min: 12, max: 12 });
  });
  it('returns null when there is no number', () => {
    expect(parseMagnitude('ukjent')).toBeNull();
  });
});

describe('unit conversion', () => {
  it('maps time words to an hour factor', () => {
    expect(timeFactorToHours('33 timer')).toBe(1);
    expect(timeFactorToHours('30 minutter')).toBeCloseTo(1 / 60);
    expect(timeFactorToHours('2 døgn')).toBe(24);
  });

  it('builds a half-life range in hours with both bounds', () => {
    expect(buildTimeRange('30-45 timer', true)).toMatchObject({
      min: 30,
      max: 45,
      unit: 'h',
    });
    // single value gets degenerate min=max for requiresMinMax params
    expect(buildTimeRange('33±4 timer', true)).toMatchObject({
      min: 33,
      max: 33,
      median: 33,
      unit: 'h',
    });
  });

  it('converts minutes to hours', () => {
    const r = buildTimeRange('30 minutter', false);
    expect(r?.median).toBeCloseTo(0.5);
    expect(r?.unit).toBe('h');
  });

  it('builds fractions from percentages', () => {
    expect(buildFraction('80 %')).toMatchObject({ min: 0.8, max: 0.8, unit: 'fraction' });
    expect(buildFraction('24±12 %')).toMatchObject({ median: 0.24, unit: 'fraction' });
    expect(buildFraction('60-80 %')).toMatchObject({ min: 0.6, max: 0.8 });
    // already-fractional input is left as-is
    expect(buildFraction('0')).toMatchObject({ min: 0, max: 0 });
  });

  it('reads a one-sided fraction bound as a [0,1]-clamped range', () => {
    // ">90 %" → [0.9, 1]
    expect(buildFraction('>90 %')).toMatchObject({
      min: 0.9,
      max: 1,
      qualifier: '>',
      unit: 'fraction',
    });
    // "<3 %" → [0, 0.03]
    expect(buildFraction('<3 %')).toMatchObject({
      min: 0,
      max: 0.03,
      qualifier: '<',
      unit: 'fraction',
    });
  });

  it('builds Vd in L/kg with degenerate bounds for single values', () => {
    expect(buildVolumeOfDistribution('15,4±2,4 L/kg')).toMatchObject({
      median: 15.4,
      min: 15.4,
      max: 15.4,
      unit: 'L/kg',
    });
  });

  it('builds dimensionless ratios', () => {
    expect(buildRatio('1,3-1,4')).toMatchObject({ min: 1.3, max: 1.4, unit: 'ratio' });
  });

  it('detects concentration units', () => {
    expect(detectConcentrationUnit('< 120 nmol/L')).toBe('nmol/L');
    expect(detectConcentrationUnit('0,5 – 1,0 mmol/L')).toBe('mmol/L');
  });

  it('normalizes Greek mu to the canonical micro-sign unit', () => {
    // Greek small letter mu (U+03BC), as used on the antiepileptic pages.
    const greek = detectConcentrationUnit('40 – 80 μmol/L');
    expect(greek).toBe('µmol/L'); // micro sign (U+00B5), matches the enum
    expect(detectConcentrationUnit('μg/mL')).toBe('µg/mL');
  });

  it('builds therapeutic concentration with qualifier and comment note', () => {
    expect(buildConcentration('< 120 nmol/L', 'Comment text')).toMatchObject({
      max: 120,
      qualifier: '<',
      unit: 'nmol/L',
      note: 'Comment text',
    });
  });

  it('parses molecular weight', () => {
    expect(parseMolecularWeight('324,39')).toBe(324.39);
  });
});

describe('substance list + title parsing', () => {
  it('decodes the double-encoded substances payload', () => {
    const payload = {
      substances: JSON.stringify([
        { title: 'Morfin', url: '/content/671/Morfin', associationId: 671 },
      ]),
    };
    expect(parseSubstanceList(payload)).toEqual([
      { title: 'Morfin', url: '/content/671/Morfin', associationId: 671 },
    ]);
  });

  it('splits a trailing parenthetical into an alias', () => {
    expect(splitTitle('2,5-Dimetoksy-4-jodamfetamin (DOI)')).toEqual({
      base: '2,5-Dimetoksy-4-jodamfetamin',
      alias: 'DOI',
    });
    expect(splitTitle('Alprazolam')).toEqual({ base: 'Alprazolam', alias: null });
  });
});

describe('parseSubstancePage', () => {
  const html = `
    <table>
      <tr><td>CAS-nummer</td><td>57-27-2</td></tr>
      <tr><td>Molekylvekt</td><td>285,34</td></tr>
      <tr><td>Biotilgjengelighet</td><td>24±12 %</td></tr>
      <tr><td>Tmax</td><td>0,5-1,5 timer</td></tr>
      <tr><td>Proteinbinding</td><td>35±2 %</td></tr>
      <tr><td>Distribusjonsvolum</td><td>3,3±0,9 L/kg</td></tr>
      <tr><td>Blod/plasma-ratio</td><td>1,0</td></tr>
      <tr><td>Halveringstid</td><td>1,9±0,5 timer</td></tr>
      <tr><td>Referanseområde</td><td>&lt; 120 nmol/L</td></tr>
    </table>
    <h3>Kommentar til referanseområdet</h3>
    <p>Gjelder for døgndoser.</p>
    <section id="metaboliter">
      <table>
        <tr><td><a href="/content/757/Morfin-3-glukuronid-M3G">Morfin-3-glukuronid (M3G)</a></td></tr>
        <tr><td><a href="/content/758/Morfin-6-glukuronid-M6G">Morfin-6-glukuronid (M6G)</a></td></tr>
      </table>
    </section>`;

  it('extracts the full parameter set', () => {
    const r = parseSubstancePage(html);
    expect(r.cas).toBe('57-27-2');
    expect(r.molecularWeight).toBe(285.34);
    expect(r.bioavailability).toMatchObject({ median: 0.24, unit: 'fraction' });
    expect(r.tmax).toMatchObject({ min: 0.5, max: 1.5, unit: 'h' });
    expect(r.proteinBinding).toMatchObject({ median: 0.35, unit: 'fraction' });
    expect(r.volumeOfDistribution).toMatchObject({ median: 3.3, unit: 'L/kg' });
    expect(r.bloodPlasmaRatio).toMatchObject({ median: 1, unit: 'ratio' });
    expect(r.halfLife).toMatchObject({ min: 1.9, max: 1.9, unit: 'h' });
    expect(r.therapeuticConcentration).toMatchObject({
      max: 120,
      qualifier: '<',
      unit: 'nmol/L',
      note: 'Gjelder for døgndoser.',
    });
    expect(r.metabolites).toHaveLength(2);
    expect(r.metabolites[0]).toMatchObject({
      name: 'Morfin-3-glukuronid (M3G)',
      url: '/content/757/Morfin-3-glukuronid-M3G',
    });
  });

  it('returns nulls for a page with no data', () => {
    const r = parseSubstancePage('<html><body><p>nothing</p></body></html>');
    expect(r.cas).toBeNull();
    expect(r.molecularWeight).toBeNull();
    expect(r.metabolites).toEqual([]);
  });
});
