/**
 * Formatting a measured quantity states exactly the precision it was given.
 *
 * The two failure directions are both real: the ratio ladder rounds a
 * concentration down to fewer digits than the laboratory reported, and asking
 * Intl for its 20-digit cap pads a small value out to a precision nobody
 * measured. On a forensic concentration either one is a claim about the assay.
 */

import { describe, it, expect } from 'vitest';

import { formatForEditing, formatMeasured, reportedDecimalsOf } from './format.js';
import { parseLocaleNumber } from '../parseNumber.js';

describe('formatMeasured', () => {
  it('keeps the decimals the value carries, in the reader’s locale', () => {
    expect(formatMeasured(315.39)).toBe('315,39');
    expect(formatMeasured(315.39, 'en-GB')).toBe('315.39');
    expect(formatMeasured(457.317)).toBe('457,317');
    // Norwegian groups with a non-breaking space, so the separator is compared
    // by class rather than by the character a keyboard would type.
    expect(formatMeasured(1000)).toMatch(/^1\s000$/u);
  });

  it('does not pad an exponential value out to twenty decimals', () => {
    // `String(1e-7)` is `"1e-7"`, and treating that as "unknown precision, use
    // the cap" rendered `0,00000010000000000000` — thirteen digits of invented
    // precision on a reported measurement.
    expect(formatMeasured(1e-7)).toBe('0,0000001');
    expect(formatMeasured(1.25e-7)).toBe('0,000000125');
    expect(formatMeasured(2.5e-8, 'en-GB')).toBe('0.000000025');
  });

  it('adds no decimals to a large exponential value', () => {
    // `1e21` stringifies as `"1e+21"`, where the exponent is positive and the
    // value has no fractional part at all.
    expect(formatMeasured(1e21, 'en-GB')).toBe('1,000,000,000,000,000,000,000');
  });

  it('states the precision the source reported, not the one the number kept', () => {
    // `1.50` and `1.5` are the same JavaScript value and different statements
    // about the assay. Reconstructing the display from the number drops the
    // laboratory's last significant digit, so the source's answer travels
    // beside the value.
    expect(formatMeasured(1.5, 'nb-NO', 2)).toBe('1,50');
    expect(formatMeasured(1.5, 'en-GB', 3)).toBe('1.500');
    // And it overrides in the other direction too, for a source that reported
    // fewer digits than the float happens to carry.
    expect(formatMeasured(0.30000000000000004, 'en-GB', 2)).toBe('0.30');
  });

  it('shows every digit a scientific value was reported with', () => {
    // Past twenty decimals the only form that can state the measurement at all
    // is scientific — and `Intl`'s default rounds it to three fraction digits,
    // so `1,23456789E-21` would display as `1,235E-21` while the ratio beside
    // it was computed from the value in full. Two numbers on one screen, one
    // of them wrong.
    expect(formatMeasured(1.23456789e-21, 'en-GB', 29)).toBe('1.23456789E-21');
    // Trailing zeros the source stated survive too: 24 decimals is `1.500e-21`,
    // which says three significant figures after the first.
    expect(formatMeasured(1.5e-21, 'en-GB', 24)).toBe('1.500E-21');
    expect(formatMeasured(1e-21, 'en-GB', 21)).toBe('1E-21');
  });

  it('writes a quantified zero out at the precision it was reported to', () => {
    // A quantified zero is a real result (§8.1), and a laboratory reporting it
    // past twenty decimals is stating its assay's reach exactly as `1,50` does.
    // The scientific form renders it `0E0` and states none of that — and zero
    // is the one value that needs no scientific form, because writing the
    // digits out is exact at any scale.
    expect(formatMeasured(0, 'en-GB', 21)).toBe(`0.${'0'.repeat(21)}`);
    expect(formatForEditing(0, 'nb-NO', 21)).toBe(`0,${'0'.repeat(21)}`);
    // And it survives being typed back, which is the editable field's whole
    // requirement.
    expect(parseLocaleNumber(formatForEditing(0, 'nb-NO', 21))).toBe(0);
    expect(reportedDecimalsOf(formatForEditing(0, 'nb-NO', 21))).toBe(21);
    // Below the cap nothing changes: `Intl` states it and groups nothing.
    expect(formatMeasured(0, 'en-GB', 2)).toBe('0.00');
  });

  it('renders a non-finite value as an em dash rather than as a number', () => {
    expect(formatMeasured(Number.NaN)).toBe('—');
    expect(formatMeasured(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatForEditing', () => {
  it('drops the grouping separator that makes a value untypeable', () => {
    // `1 000` and `1,000` are both right to read and neither survives being
    // typed back: the parser rejects the non-breaking space and reads the
    // English form as ambiguous — correctly, since `1,000` is 1 or 1000
    // depending on the reader. A grouped editable field can only be cleared.
    expect(formatForEditing(1000)).toBe('1000');
    expect(formatForEditing(2250, 'en-GB')).toBe('2250');
    expect(formatForEditing(315.39)).toBe('315,39');
    expect(formatForEditing(1.5, 'nb-NO', 2)).toBe('1,50');
  });
});

describe('formatForEditing past the decimal cap', () => {
  it('keeps the digits a tiny value was reported with', () => {
    // `String(1e-21)` is `"1e-21"` whatever the source stated, so a result
    // entered as `1,00e-21` came back two digits short — a field less precise
    // than the case it edits, while Save filed the precise claim.
    expect(formatForEditing(1e-21, 'nb-NO', 23)).toBe('1,00e-21');
    expect(formatForEditing(1.25e-21, 'en-GB', 23)).toBe('1.25e-21');
    // And it is still typeable back, precision included, which is the whole
    // reason this path does not use `Intl`'s scientific form.
    expect(parseLocaleNumber(formatForEditing(1e-21, 'nb-NO', 23))).toBe(1e-21);
    expect(reportedDecimalsOf(formatForEditing(1e-21, 'nb-NO', 23))).toBe(23);
  });

  it('does not invent figures the number never carried', () => {
    // A stored 1.5 claiming forty decimals is storable — it is a claim about a
    // real value — but writing it out as `1,50000000000000000000` asserts
    // thirty-nine digits the double never had. Inventing precision is the same
    // error as dropping it, pointing the other way.
    expect(formatForEditing(1.5, 'nb-NO', 40)).toBe('1,5');
    expect(formatMeasured(1.5, 'en-GB', 40)).toBe('1.5E0');
  });

  it('does not try to write out a precision no value could have', () => {
    // `1e-1000000000` underflows to a finite zero and states a billion decimal
    // places. Carried forward, the next render repeats a character a billion
    // times — a `RangeError`, or the tab.
    expect(reportedDecimalsOf('1e-1000000000')).toBeUndefined();
    expect(formatForEditing(0, 'nb-NO', 1e9).length).toBeLessThan(400);
    expect(formatMeasured(0, 'nb-NO', 1e9).length).toBeLessThan(400);
  });
});

describe('reportedDecimalsOf', () => {
  it('reads the precision a reader’s own text states', () => {
    expect(reportedDecimalsOf('1,50')).toBe(2);
    expect(reportedDecimalsOf('1.50')).toBe(2);
    expect(reportedDecimalsOf('210')).toBe(0);
  });

  it('accounts for the exponent rather than reading it as no decimals', () => {
    // `1e-7` has no decimal separator and is not a whole number. Recording zero
    // decimals and then treating that as authoritative renders a reported
    // measurement as `0`.
    expect(reportedDecimalsOf('1e-7')).toBe(7);
    expect(reportedDecimalsOf('1.50e-7')).toBe(9);
    expect(reportedDecimalsOf('2,5E-3')).toBe(4);
    expect(reportedDecimalsOf('1e21')).toBe(0);
  });

  it('reports the true figure past Intl’s limit, not the clamp', () => {
    // The formatters need to know when a decimal rendering cannot express the
    // value at all, which a clamped answer hides.
    expect(reportedDecimalsOf('1e-21')).toBe(21);
    expect(reportedDecimalsOf('1.25e-21')).toBe(23);
  });

  it('keeps the precision of a grouped number the parser accepts', () => {
    // `1.500,20` parses as 1500.2, so the trailing zero survives only here.
    // Read with a rule of its own — comma to dot, and nothing else — the text
    // becomes `1.500.20`, which is malformed, and the precision the parse
    // accepted is dropped by the one step that exists to keep it.
    expect(reportedDecimalsOf('1.500,20')).toBe(2);
    expect(reportedDecimalsOf('1,500.20')).toBe(2);
    expect(reportedDecimalsOf('1 500,20')).toBe(2);
    // Grouping all the way down states no decimals at all.
    expect(reportedDecimalsOf('1.500.000')).toBe(0);
  });

  it('states nothing for text that is not a number', () => {
    expect(reportedDecimalsOf('abc')).toBeUndefined();
    // Nor for one the parser refuses to read: `1,500` is 1.5 or 1500, and a
    // decimal count for a value nobody may have is a statement about neither.
    expect(reportedDecimalsOf('1,500')).toBeUndefined();
  });
});

describe('a measurement too small for a decimal rendering', () => {
  it('states it in scientific notation rather than as zero', () => {
    // `1e-21` needs 21 decimals and Intl accepts 20, so a decimal rendering
    // prints `0` for a value the arithmetic is still computing ratios from —
    // the observation contradicting the result derived from it.
    expect(formatMeasured(1e-21)).not.toMatch(/^0[,.]0+$/);
    expect(formatMeasured(1e-21)).toMatch(/1.*21/);
    expect(formatMeasured(1.25e-21, 'en-GB')).toMatch(/1\.25E-21/);
  });

  it('offers an editable form the parser accepts back', () => {
    // Intl's scientific notation uses a Unicode minus the parser rejects, so
    // the editable form is the number's own exponential text with the locale's
    // separator — which round trips.
    const text = formatForEditing(1.25e-21);
    expect(text).toBe('1,25e-21');
    expect(parseLocaleNumber(text)).toBe(1.25e-21);
  });
});

describe('formatMeasured, continued', () => {
  it('still renders a non-finite value as an em dash', () => {
    expect(formatMeasured(Number.NaN)).toBe('—');
    expect(formatMeasured(Number.POSITIVE_INFINITY)).toBe('—');
  });
});
