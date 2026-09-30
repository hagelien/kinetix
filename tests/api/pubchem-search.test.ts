import { describe, expect, it } from 'vitest';
import { CAS_PATTERN, cleanSynonyms } from '../../api/pubchem-search';

describe('CAS_PATTERN', () => {
  it('matches canonical CAS Registry Numbers', () => {
    // Real CAS numbers from compounds we'd actually look up.
    expect(CAS_PATTERN.test('28981-97-7')).toBe(true); // alprazolam
    expect(CAS_PATTERN.test('1490-04-6')).toBe(true);  // menthol
    expect(CAS_PATTERN.test('64-17-5')).toBe(true);    // ethanol (shortest realistic shape)
    expect(CAS_PATTERN.test('7440-44-0')).toBe(true);  // carbon
  });

  it('rejects non-CAS shapes that the autocomplete path should keep', () => {
    expect(CAS_PATTERN.test('123')).toBe(false);          // CID
    expect(CAS_PATTERN.test('alprazolam')).toBe(false);   // name
    expect(CAS_PATTERN.test('1234')).toBe(false);         // CID, no dashes
    expect(CAS_PATTERN.test('1-2-3')).toBe(false);        // too short on first segment
    expect(CAS_PATTERN.test('1234567890-12-3')).toBe(false); // first segment too long
    expect(CAS_PATTERN.test('123-1-2')).toBe(false);      // middle segment too short
    expect(CAS_PATTERN.test('123-12-34')).toBe(false);    // check digit must be exactly one
    expect(CAS_PATTERN.test('')).toBe(false);
  });
});

describe('cleanSynonyms', () => {
  it('returns up to 10 unique strings, preserving first-occurrence casing', () => {
    const raw = [
      'Alprazolam',
      'ALPRAZOLAM',           // dup case-insensitively
      'Xanax',
      'Niravam',
      ' Alprazolamum ',       // dup after trim
      '28981-97-7',           // pure numeric (after dash removal that's not what we strip — we strip only pure-digit)
      '12345',                // pure numeric — dropped
      'Tafil',
    ];
    const out = cleanSynonyms(raw);
    expect(out).toContain('Alprazolam');
    expect(out).toContain('Xanax');
    expect(out).toContain('Tafil');
    // `28981-97-7` is NOT pure numeric (it has dashes) so it survives —
    // dedicated CAS handling lives elsewhere.
    expect(out).toContain('28981-97-7');
    // Pure-digit `12345` is dropped.
    expect(out.includes('12345')).toBe(false);
    // Case dedup keeps the first occurrence.
    expect(out.filter((s) => s.toLowerCase() === 'alprazolam')).toHaveLength(1);
    expect(out[0]).toBe('Alprazolam');
  });

  it('caps the output at 10 entries', () => {
    const raw = Array.from({ length: 30 }, (_, i) => `synonym-${i}`);
    expect(cleanSynonyms(raw)).toHaveLength(10);
  });

  it('skips non-string and oversized entries safely', () => {
    const raw = [
      null,
      undefined,
      42,
      { name: 'object' },
      'a'.repeat(300), // too long
      'OK-name',
    ];
    expect(cleanSynonyms(raw)).toEqual(['OK-name']);
  });

  it('returns [] for an empty input', () => {
    expect(cleanSynonyms([])).toEqual([]);
  });
});
