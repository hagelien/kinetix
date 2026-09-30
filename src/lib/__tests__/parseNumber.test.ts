import { describe, expect, it } from 'vitest';
import { parseLocaleNumber, parseLocaleNumberDetailed } from '../parseNumber';

describe('parseLocaleNumber', () => {
  it('parses plain integers and decimals with either separator', () => {
    expect(parseLocaleNumber('1500')).toBe(1500);
    expect(parseLocaleNumber('12.5')).toBe(12.5);
    expect(parseLocaleNumber('12,5')).toBe(12.5);
    expect(parseLocaleNumber('-3,14')).toBe(-3.14);
    expect(parseLocaleNumber('0.001')).toBe(0.001);
  });

  it('rejects ambiguous single-separator-with-3-digit-tail inputs', () => {
    // "1,500" could mean 1.500 (decimal) or 1500 (US thousands). Refuse.
    expect(parseLocaleNumber('1,500')).toBeNaN();
    expect(parseLocaleNumber('1.500')).toBeNaN();
    expect(parseLocaleNumber('25,000')).toBeNaN();
  });

  it('rejects them with a sign on the front too', () => {
    // A relative hour is naturally signed, and `+1,500` reads 1.5 or 1500
    // exactly as the unsigned text does. A check that saw only the minus let
    // the plus through to a 1000× guess.
    expect(parseLocaleNumber('+1,500')).toBeNaN();
    expect(parseLocaleNumber('-1,500')).toBeNaN();
    expect(parseLocaleNumberDetailed('+1,500')).toEqual({
      ok: false,
      reason: 'ambiguous',
      asDecimal: 1.5,
      asThousands: 1500,
    });
    // And a signed value that is not that shape still parses.
    expect(parseLocaleNumber('+1,5')).toBe(1.5);
  });

  it('treats unambiguous decimals (≠ 3 trailing digits) as decimal', () => {
    expect(parseLocaleNumber('1,5')).toBe(1.5);
    expect(parseLocaleNumber('1,5000')).toBe(1.5);
    expect(parseLocaleNumber('1.25')).toBe(1.25);
  });

  it('handles mixed separators by taking the last as decimal', () => {
    expect(parseLocaleNumber('1,500.25')).toBe(1500.25);
    expect(parseLocaleNumber('1.500,25')).toBe(1500.25);
    expect(parseLocaleNumber('1,000,000.5')).toBe(1000000.5);
  });

  it('treats repeated single-type separators as thousands when the shape fits', () => {
    expect(parseLocaleNumber('1,500,000')).toBe(1500000);
    expect(parseLocaleNumber('1.500.000')).toBe(1500000);
  });

  it('rejects malformed thousands shapes', () => {
    expect(parseLocaleNumber('1,50,000')).toBeNaN();
    expect(parseLocaleNumber('1.5.0')).toBeNaN();
  });

  it('rejects empty / non-string / pure-separator input', () => {
    expect(parseLocaleNumber('')).toBeNaN();
    expect(parseLocaleNumber('   ')).toBeNaN();
    expect(parseLocaleNumber('.')).toBeNaN();
    expect(parseLocaleNumber(',')).toBeNaN();
    // @ts-expect-error guarding non-string runtime input
    expect(parseLocaleNumber(undefined)).toBeNaN();
  });

  it('rejects non-finite input so callers only need an isFinite guard', () => {
    expect(parseLocaleNumber('Infinity')).toBeNaN();
    expect(parseLocaleNumber('1e400')).toBeNaN();
  });
});

describe('parseLocaleNumberDetailed', () => {
  it('returns the value for unambiguous input', () => {
    expect(parseLocaleNumberDetailed('12,5')).toEqual({ ok: true, value: 12.5 });
    expect(parseLocaleNumberDetailed('0.001')).toEqual({ ok: true, value: 0.001 });
    expect(parseLocaleNumberDetailed('1.500,25')).toEqual({ ok: true, value: 1500.25 });
  });

  it('separates ambiguity from garbage and offers both readings', () => {
    // Nitrate's PubChem molecular weight — the case that used to be
    // unenterable in the monograph create form.
    expect(parseLocaleNumberDetailed('62.005')).toEqual({
      ok: false,
      reason: 'ambiguous',
      asDecimal: 62.005,
      asThousands: 62005,
    });
    expect(parseLocaleNumberDetailed('1,500')).toEqual({
      ok: false,
      reason: 'ambiguous',
      asDecimal: 1.5,
      asThousands: 1500,
    });
    expect(parseLocaleNumberDetailed('abc')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseLocaleNumberDetailed('1,50,000')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseLocaleNumberDetailed('')).toEqual({ ok: false, reason: 'invalid' });
  });
});
