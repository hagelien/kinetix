import { describe, it, expect } from 'vitest';
import {
  meanRange,
  hasRangeData,
  formatRange,
  normalizeRangeInput,
  normalizeFraction,
  mapRange,
  combineRanges,
  rangesEqual,
  rangeToDistribution,
  rangeRepresentative,
  rangeMax,
  rangeMin,
  formatCalcRange,
  formatWithMaxDecimals,
  groupThousands,
  round,
  normalizeFractionDisplay,
  showFractionAsPercent,
  isPercentUnit,
} from './rangeUtils';

// Non-breaking space used as the thousands separator in formatted numbers.
const NBSP = '\u00A0';

describe('rangeUtils', () => {
  describe('meanRange', () => {
    it('returns value when provided', () => {
      expect(meanRange({ median: 5 })).toBe(5);
    });

    it('returns average of min and max', () => {
      expect(meanRange({ min: 2, max: 8 })).toBe(5);
    });

    it('returns null for empty range', () => {
      expect(meanRange(null)).toBeNull();
      expect(meanRange(undefined)).toBeNull();
      expect(meanRange({})).toBeNull();
    });
  });

  describe('hasRangeData', () => {
    it('returns true for range with value', () => {
      expect(hasRangeData({ median: 5 })).toBe(true);
    });

    it('returns true for range with min/max', () => {
      expect(hasRangeData({ min: 2, max: 8 })).toBe(true);
    });

    it('returns false for null/undefined/empty', () => {
      expect(hasRangeData(null)).toBe(false);
      expect(hasRangeData(undefined)).toBe(false);
      expect(hasRangeData({})).toBe(false);
    });
  });

  describe('formatRange', () => {
    it('formats value with unit', () => {
      expect(formatRange({ median: 5, unit: 'mg' })).toBe('5 mg');
    });

    it('formats range with min and max', () => {
      expect(formatRange({ min: 2, max: 8, unit: 'h' })).toBe('2–8 h');
    });

    it('formats qualifier', () => {
      expect(formatRange({ median: 5, qualifier: '>', unit: 'mg' })).toBe('> 5 mg');
    });

    it('includes note', () => {
      expect(formatRange({ median: 5, note: 'oral' })).toBe('5 (oral)');
    });

    it('renders min-only thresholds as ≥min (#302 P3)', () => {
      expect(formatRange({ min: 50, unit: 'ng/mL' })).toBe('≥50 ng/mL');
    });

    it('renders max-only thresholds as ≤max (#302 P3)', () => {
      expect(formatRange({ max: 200, unit: 'mg/L' })).toBe('≤200 mg/L');
    });

    it('ignores a free-text qualifier and falls back to the min–max range', () => {
      // Legacy import stuffed a route/population label into `qualifier`
      // alongside a real range; it must never shadow the min–max display.
      expect(
        formatRange({
          min: 0.36,
          max: 1,
          median: 0.86,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          qualifier: 'voksen po' as any,
          unit: 'fraction',
        }),
      ).toBe('0.36–1');
    });

    describe('asPercent', () => {
      it('scales a fraction scalar and marks it with %', () => {
        expect(
          formatRange({ median: 0.3, unit: 'fraction' }, { asPercent: true }),
        ).toBe('30%');
      });

      it('scales both bounds but suffixes % once', () => {
        expect(
          formatRange(
            { min: 0.25, max: 0.4, unit: 'fraction' },
            { asPercent: true },
          ),
        ).toBe('25–40%');
      });

      it('keeps % when the caller suppresses the unit', () => {
        // The drug table hides units (they live in the column header), but a
        // bare "30" would be indistinguishable from the stored fraction.
        expect(
          formatRange(
            { median: 0.3, unit: 'fraction' },
            { asPercent: true, showUnit: false },
          ),
        ).toBe('30%');
      });

      it('carries the qualifier and the one-sided thresholds', () => {
        expect(
          formatRange({ median: 0.9, qualifier: '>' }, { asPercent: true }),
        ).toBe('> 90%');
        expect(formatRange({ min: 0.05 }, { asPercent: true })).toBe('≥5%');
        expect(formatRange({ max: 0.99 }, { asPercent: true })).toBe('≤99%');
      });

      it('does not leak binary float noise into the display', () => {
        // 0.29 * 100 is 28.999999999999996 in IEEE-754.
        expect(formatRange({ median: 0.29 }, { asPercent: true })).toBe('29%');
        expect(formatRange({ median: 0.07 }, { asPercent: true })).toBe('7%');
      });

      it('keeps the note alongside the percentage', () => {
        expect(
          formatRange({ median: 0.3, note: 'oral' }, { asPercent: true }),
        ).toBe('30% (oral)');
      });

      it('leaves the decimal untouched when the option is off', () => {
        expect(formatRange({ median: 0.3, unit: 'fraction' })).toBe('0.3');
      });

      it('does not re-scale a range already stored in %', () => {
        // Most catalog protein-binding values are `{ median: 80, unit: '%' }`,
        // not `0.8`. Scaling one again would claim 8000% binding.
        expect(
          formatRange({ median: 80, unit: '%' }, { asPercent: true }),
        ).toBe('80%');
        expect(
          formatRange({ min: 80, max: 85, unit: '%' }, { asPercent: true }),
        ).toBe('80–85%');
      });

      it('still scales a fraction-united range beside it', () => {
        expect(
          formatRange({ median: 0.8, unit: 'fraction' }, { asPercent: true }),
        ).toBe('80%');
      });
    });

    it('keeps rendering a %-united range unchanged in decimal mode', () => {
      expect(formatRange({ median: 80, unit: '%' })).toBe('80 %');
    });
  });

  describe('isPercentUnit', () => {
    it('recognises the stored percent unit', () => {
      expect(isPercentUnit('%')).toBe(true);
      expect(isPercentUnit(' % ')).toBe(true);
    });

    it('is false for the fraction and every other unit', () => {
      expect(isPercentUnit('fraction')).toBe(false);
      expect(isPercentUnit('ratio')).toBe(false);
      expect(isPercentUnit('mg/L')).toBe(false);
      expect(isPercentUnit(undefined)).toBe(false);
    });
  });

  describe('normalizeFractionDisplay', () => {
    it('accepts the percent mode', () => {
      expect(normalizeFractionDisplay('percent')).toBe('percent');
    });

    it('falls back to decimal for anything else', () => {
      expect(normalizeFractionDisplay('decimal')).toBe('decimal');
      expect(normalizeFractionDisplay(undefined)).toBe('decimal');
      expect(normalizeFractionDisplay('promille')).toBe('decimal');
      expect(normalizeFractionDisplay(1)).toBe('decimal');
    });
  });

  describe('showFractionAsPercent', () => {
    it('is true only for a fraction parameter under the percent preference', () => {
      expect(showFractionAsPercent('fraction', 'percent')).toBe(true);
      expect(showFractionAsPercent('fraction', 'decimal')).toBe(false);
    });

    it('never scales a non-fraction kind — a ratio is not a percentage', () => {
      expect(showFractionAsPercent('ratio', 'percent')).toBe(false);
      expect(showFractionAsPercent('range', 'percent')).toBe(false);
      expect(showFractionAsPercent(undefined, 'percent')).toBe(false);
    });
  });

  describe('normalizeRangeInput', () => {
    it('normalizes number input', () => {
      expect(normalizeRangeInput(5)).toEqual({ median: 5 });
    });

    it('normalizes object input', () => {
      expect(normalizeRangeInput({ min: 2, max: 8 })).toEqual({ min: 2, max: 8 });
    });

    it('handles fraction normalization', () => {
      expect(normalizeRangeInput(80, { asFraction: true })).toEqual({ median: 0.8 });
      expect(normalizeRangeInput(0.8, { asFraction: true })).toEqual({ median: 0.8 });
    });

    it('returns null for invalid input', () => {
      expect(normalizeRangeInput(null)).toBeNull();
      expect(normalizeRangeInput(undefined)).toBeNull();
    });
  });

  describe('normalizeFraction', () => {
    it('converts percentage to fraction', () => {
      expect(normalizeFraction(80)).toBe(0.8);
    });

    it('keeps fraction as is', () => {
      expect(normalizeFraction(0.8)).toBe(0.8);
    });

    it('returns null for invalid values', () => {
      expect(normalizeFraction(0)).toBeNull();
      expect(normalizeFraction(-1)).toBeNull();
      expect(normalizeFraction(null)).toBeNull();
    });
  });

  describe('mapRange', () => {
    it('applies mapper to all range values', () => {
      const result = mapRange({ min: 2, max: 4, median: 3 }, (x) => x * 2);
      expect(result).toEqual({ min: 4, max: 8, median: 6 });
    });

    it('filters non-positive when positiveOnly is true', () => {
      const result = mapRange({ min: -2, max: 2 }, (x) => x, { positiveOnly: true });
      expect(result).toEqual({ max: 2 });
    });

    it('returns null for invalid input', () => {
      expect(mapRange(null, (x) => x)).toBeNull();
    });
  });

  describe('combineRanges', () => {
    it('combines two ranges with addition', () => {
      const result = combineRanges({ median: 3 }, { median: 2 }, (a, b) => a + b);
      expect(result?.median).toBe(5);
    });

    it('computes min/max correctly', () => {
      const result = combineRanges({ min: 1, max: 3 }, { min: 2, max: 4 }, (a, b) => a * b);
      expect(result?.min).toBe(2); // 1 * 2
      expect(result?.max).toBe(12); // 3 * 4
    });
  });

  describe('rangesEqual', () => {
    it('returns true for equal ranges', () => {
      expect(rangesEqual({ min: 2, max: 4 }, { min: 2, max: 4 })).toBe(true);
    });

    it('returns false for different ranges', () => {
      expect(rangesEqual({ min: 2 }, { max: 4 })).toBe(false);
    });

    it('returns false for null inputs', () => {
      expect(rangesEqual(null, { median: 5 })).toBe(false);
    });
  });

  describe('rangeRepresentative', () => {
    it('returns average of all candidates', () => {
      expect(rangeRepresentative({ min: 2, max: 4, median: 3 })).toBe(3);
    });

    it('returns value when only value exists', () => {
      expect(rangeRepresentative({ median: 5 })).toBe(5);
    });
  });

  describe('rangeMax and rangeMin', () => {
    it('returns correct max and min', () => {
      const range = { min: 2, max: 8, median: 5 };
      expect(rangeMax(range)).toBe(8);
      expect(rangeMin(range)).toBe(2);
    });
  });

  describe('formatCalcRange', () => {
    it('formats value', () => {
      expect(formatCalcRange({ median: 5 })).toBe('5');
    });

    it('formats range', () => {
      expect(formatCalcRange({ min: 2, max: 8 })).toBe('2–8');
    });

    it('returns dash for empty', () => {
      expect(formatCalcRange(null)).toBe('—');
    });
  });

  describe('groupThousands', () => {
    it('groups the integer part with a non-breaking space', () => {
      expect(groupThousands('300000')).toBe(`300${NBSP}000`);
      expect(groupThousands('1000')).toBe(`1${NBSP}000`);
      expect(groupThousands('1234567')).toBe(`1${NBSP}234${NBSP}567`);
    });

    it('preserves sign and decimals, grouping only the integer part', () => {
      expect(groupThousands('-43263.5')).toBe(`-43${NBSP}263.5`);
      expect(groupThousands('0.00123')).toBe('0.00123');
    });

    it('leaves sub-thousand and non-numeric strings untouched', () => {
      expect(groupThousands('999')).toBe('999');
      expect(groupThousands('≥50')).toBe('≥50');
    });
  });

  describe('formatWithMaxDecimals', () => {
    it('groups large integers with a space thousands separator', () => {
      expect(formatWithMaxDecimals(300000)).toBe(`300${NBSP}000`);
      expect(formatWithMaxDecimals(43263)).toBe(`43${NBSP}263`);
      expect(formatWithMaxDecimals(-100947)).toBe(`-100${NBSP}947`);
    });

    it('groups the integer part while keeping decimals ungrouped', () => {
      expect(formatWithMaxDecimals(12.345)).toBe('12.3');
      expect(formatWithMaxDecimals(-1.2345)).toBe('-1.23');
    });

    it('drops decimals once the integer part carries the precision', () => {
      expect(formatWithMaxDecimals(12345.678)).toBe(`12${NBSP}346`);
      expect(formatWithMaxDecimals(3277.154)).toBe(`3${NBSP}277`);
      expect(formatWithMaxDecimals(156.055)).toBe('156');
      expect(formatWithMaxDecimals(78.027)).toBe('78');
      expect(formatWithMaxDecimals(6.242)).toBe('6.24');
    });

    it('never shows more decimals than the caller allows', () => {
      expect(formatWithMaxDecimals(1.5, 1)).toBe('1.5');
      expect(formatWithMaxDecimals(1.234, 1)).toBe('1.2');
      expect(formatWithMaxDecimals(1.234, 0)).toBe('1');
    });

    it('does not group numbers below 1000', () => {
      expect(formatWithMaxDecimals(700)).toBe('700');
      expect(formatWithMaxDecimals(0.00123456)).toBe('0.00123');
    });
  });

  describe('round', () => {
    it('rounds to 6 decimal places', () => {
      expect(round(1.23456789)).toBe(1.234568);
    });

    it('handles non-finite values', () => {
      expect(round(Infinity)).toBe('');
      expect(round(NaN)).toBe('');
    });
  });

  describe('rangeToDistribution', () => {
    it('converts a plain number to fixed distribution', () => {
      expect(rangeToDistribution(5)).toEqual({ type: 'fixed', value: 5 });
    });

    it('converts a single-value range to fixed distribution', () => {
      expect(rangeToDistribution({ median: 3 })).toEqual({ type: 'fixed', value: 3 });
    });

    it('converts min+max range to uniform distribution', () => {
      expect(rangeToDistribution({ min: 2, max: 8 })).toEqual({ type: 'uniform', min: 2, max: 8 });
    });

    it('converts min+max+value range to triangular distribution', () => {
      expect(rangeToDistribution({ min: 2, max: 8, median: 5 })).toEqual({
        type: 'triangular', min: 2, mode: 5, max: 8,
      });
    });

    it('clamps mode to [min, max] for triangular', () => {
      const result = rangeToDistribution({ min: 2, max: 8, median: 10 });
      expect(result).toEqual({ type: 'triangular', min: 2, mode: 8, max: 8 });
    });

    it('returns fallback for null/undefined', () => {
      expect(rangeToDistribution(null, 7)).toEqual({ type: 'fixed', value: 7 });
      expect(rangeToDistribution(undefined)).toEqual({ type: 'fixed', value: 1 });
    });

    it('handles min equal to max as fixed', () => {
      expect(rangeToDistribution({ min: 5, max: 5 })).toEqual({ type: 'fixed', value: 5 });
    });
  });
});
