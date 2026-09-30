import { describe, expect, it } from 'vitest';
import {
  clockToHours,
  coerceClockTime,
  formatHoursAsHHMM,
  hoursToClockTime,
  isValidClockTime,
  parseClockTime,
} from '../timeFormat';

describe('parseClockTime', () => {
  it('accepts well-formed values', () => {
    expect(parseClockTime('02:00')).toEqual({ hour: 2, minute: 0 });
    expect(parseClockTime('9:30')).toEqual({ hour: 9, minute: 30 });
    expect(parseClockTime('  09:30  ')).toEqual({ hour: 9, minute: 30 });
  });

  it('rejects out-of-range or malformed values', () => {
    expect(parseClockTime('24:00')).toBeNull();
    expect(parseClockTime('12:60')).toBeNull();
    expect(parseClockTime('abc')).toBeNull();
    expect(parseClockTime('0200')).toBeNull();
  });
});

describe('coerceClockTime', () => {
  it('passes valid HH:MM input through with zero-padded hour', () => {
    expect(coerceClockTime('02:00')).toBe('02:00');
    expect(coerceClockTime('9:30')).toBe('09:30');
    expect(coerceClockTime('  02:00 ')).toBe('02:00');
  });

  it('inserts a colon for 4-digit input', () => {
    expect(coerceClockTime('0200')).toBe('02:00');
    expect(coerceClockTime('2359')).toBe('23:59');
    expect(coerceClockTime('0000')).toBe('00:00');
  });

  it('inserts a colon for 3-digit input', () => {
    expect(coerceClockTime('930')).toBe('09:30');
    expect(coerceClockTime('230')).toBe('02:30');
    expect(coerceClockTime('001')).toBe('00:01');
  });

  it('reads a bare 1–2 digit entry as a whole hour', () => {
    expect(coerceClockTime('2')).toBe('02:00');
    expect(coerceClockTime('9')).toBe('09:00');
    expect(coerceClockTime('23')).toBe('23:00');
    expect(coerceClockTime('0')).toBe('00:00');
  });

  it('passes invalid values through unchanged so validation surfaces the error', () => {
    expect(coerceClockTime('2400')).toBe('2400');
    expect(coerceClockTime('2461')).toBe('2461');
    expect(coerceClockTime('25:00')).toBe('25:00');
    expect(coerceClockTime('24')).toBe('24');
    expect(coerceClockTime('abc')).toBe('abc');
  });

  it('passes empty string through', () => {
    expect(coerceClockTime('')).toBe('');
    expect(coerceClockTime('   ')).toBe('');
  });
});

describe('clockToHours / hoursToClockTime / formatHoursAsHHMM / isValidClockTime', () => {
  it('round-trips clock times across a reference', () => {
    expect(clockToHours('11:00', '09:00')).toBe(2);
    expect(clockToHours('01:00', '23:00')).toBe(2); // wraps midnight
    expect(hoursToClockTime(2, '09:00')).toBe('11:00');
  });

  it('formats elapsed hours', () => {
    expect(formatHoursAsHHMM(1.5)).toBe('01:30');
    expect(formatHoursAsHHMM(0)).toBe('00:00');
    expect(formatHoursAsHHMM(-1)).toBe('00:00');
  });

  it('isValidClockTime echoes parseClockTime', () => {
    expect(isValidClockTime('12:00')).toBe(true);
    expect(isValidClockTime('25:00')).toBe(false);
  });
});
