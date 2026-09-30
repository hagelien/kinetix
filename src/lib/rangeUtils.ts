import { isQualifierOperator, type NumericRange } from '../types/index.js';
import type { DistributionSpec } from '../types/simulator.js';

/**
 * The single representative scalar carried directly on a range: the
 * median is preferred over the mean (per project convention), with no
 * derivation from the min/max bounds. Returns null when neither central
 * statistic is present — callers that also want the bound midpoint should
 * use `meanRange`.
 */
export function representativeValue(
  range: NumericRange | null | undefined,
): number | null {
  if (!range) return null;
  if (typeof range.median === 'number') return range.median;
  if (typeof range.mean === 'number') return range.mean;
  return null;
}

export function meanRange(range: NumericRange | null | undefined): number | null {
  if (!range) return null;
  const rep = representativeValue(range);
  if (rep !== null) return rep;
  if (typeof range.min === 'number' && typeof range.max === 'number') {
    return (range.min + range.max) / 2;
  }
  return null;
}

/**
 * Pick the representative scalar for a range when sorting. Ascending lists
 * are ordered by `min` (lowest min first); descending lists by `max` (highest
 * max first). Falls back to the representative value (median, then mean),
 * then to whichever bound exists.
 */
export function extremeForSort(
  range: NumericRange | null | undefined,
  direction: 'asc' | 'desc',
): number | null {
  if (!range) return null;
  const rep = representativeValue(range);
  if (direction === 'asc') {
    if (typeof range.min === 'number') return range.min;
    if (rep !== null) return rep;
    if (typeof range.max === 'number') return range.max;
    return null;
  }
  if (typeof range.max === 'number') return range.max;
  if (rep !== null) return rep;
  if (typeof range.min === 'number') return range.min;
  return null;
}

export function isUnitless(unit: string | null | undefined): boolean {
  if (!unit) return true;
  const normalized = unit.toLowerCase();
  return normalized === 'ratio' || normalized === 'unitless' || normalized === 'fraction';
}

export function formatUnit(unit: string | null | undefined): string {
  return isUnitless(unit) ? '' : (unit ?? '');
}

/**
 * How the user wants dimensionless fractions (bioavailability, plasma protein
 * binding) written: as the stored 0–1 decimal, or scaled to a percentage.
 *
 * A pure display preference — the stored value stays the canonical fraction, so
 * only the formatting layer ever sees this. Lives here rather than in the store
 * because the formatters below are the ones that act on it, and `lib/` code must
 * not reach into a React store.
 */
export type FractionDisplay = 'decimal' | 'percent';

export const DEFAULT_FRACTION_DISPLAY: FractionDisplay = 'decimal';

/** Coerce an unknown (persisted or API-supplied) value to a valid mode. */
export function normalizeFractionDisplay(value: unknown): FractionDisplay {
  return value === 'percent' ? 'percent' : DEFAULT_FRACTION_DISPLAY;
}

/**
 * A range whose stored unit is already `%` — the value IS the percentage, not
 * the 0–1 fraction. Most of the catalog's protein-binding values are shaped
 * this way (`{ median: 80, unit: '%' }`, not `{ median: 0.8 }`), so the percent
 * preference must render them untouched: scaling one again would report 80%
 * plasma protein binding as 8000%.
 */
export function isPercentUnit(unit: string | null | undefined): boolean {
  return unit?.trim() === '%';
}

/**
 * Whether a fraction-valued parameter should be rendered as a percentage.
 * Callers pass the parameter's `kind` so a non-fraction parameter (a ratio, a
 * concentration) is never scaled by the preference.
 */
export function showFractionAsPercent(
  kind: string | null | undefined,
  fractionDisplay: FractionDisplay | null | undefined,
): boolean {
  return kind === 'fraction' && fractionDisplay === 'percent';
}

export function formatRange(
  range: NumericRange | null | undefined,
  opts?: { showNote?: boolean; showUnit?: boolean; asPercent?: boolean },
): string {
  if (!range) return '';
  const { min, max, qualifier, unit, note } = range;
  // Median preferred, then mean — the single scalar shown when the range
  // has no two-sided min/max span to display.
  const rep = representativeValue(range);
  const showUnitFlag = opts?.showUnit ?? true;
  // A fraction rendered as a percentage carries `%` as its own suffix: the
  // stored unit is the dimensionless 'fraction' (which `formatUnit` blanks
  // anyway), and the `%` is notation on the number, not a unit the caller may
  // suppress with `showUnit: false` — without it "30" would read as the raw
  // stored value.
  const asPercent = opts?.asPercent ?? false;
  // …but only a value stored as a 0–1 fraction is scaled. A range that already
  // carries `unit: '%'` is the percentage, and is written out as it stands.
  const scaleToPercent = asPercent && !isPercentUnit(unit);
  const unitLabel = showUnitFlag ? formatUnit(unit) : '';
  const unitSuffix = asPercent ? '%' : unitLabel ? ` ${unitLabel}` : '';
  const fmt = (n: number) =>
    formatWithMaxDecimals(scaleToPercent ? n * 100 : n, 3);
  let s = '';

  // Only a comparison operator (e.g. "> 5") may prefix the value. Legacy
  // free-text qualifiers ("voksen po") are ignored here so they can never
  // shadow the real min–max range in the formatted output; the value then
  // falls through to the range/value branches below.
  if (rep != null && isQualifierOperator(qualifier)) s = `${qualifier} ${fmt(rep)}${unitSuffix}`;
  else if (min != null && max != null && min !== max) s = `${fmt(min)}–${fmt(max)}${unitSuffix}`;
  else if (min != null && max === min) s = `${fmt(min)}${unitSuffix}`;
  else if (rep != null) s = `${fmt(rep)}${unitSuffix}`;
  // One-sided thresholds: show "≥min" / "≤max" instead of an empty
  // string. Common for #302 P3 parameters like effect/toxic
  // thresholds and fatal-dose floors where the literature reports
  // only a one-sided cutoff.
  else if (min != null) s = `≥${fmt(min)}${unitSuffix}`;
  else if (max != null) s = `≤${fmt(max)}${unitSuffix}`;

  const showNote = opts?.showNote ?? true;
  return (note && showNote) ? `${s} (${note})` : s;
}

export function normalizeFraction(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  return value > 1 ? value / 100 : value;
}

export function extractNumeric(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  // Accept both '.' and ',' as decimal separators so Norwegian users can
  // type concentrations without converting to US notation. The match is
  // normalised to '.' so downstream Number() conversion succeeds.
  const match = String(value).match(/-?\d+(?:[.,]\d+)?/);
  return match ? match[0]?.replace(',', '.') ?? null : null;
}

interface NormalizeOptions {
  asFraction?: boolean;
}

export function normalizeRangeInput(
  raw: unknown,
  options: NormalizeOptions = {}
): NumericRange | null {
  const { asFraction = false } = options;
  if (raw === null || raw === undefined) return null;

  const normalizeValue = (val: unknown): number | null => {
    const num = Number(val);
    if (!Number.isFinite(num)) return null;
    if (asFraction) return normalizeFraction(num);
    return num;
  };

  if (typeof raw === 'number') {
    // A bare number is a point estimate — treated as the median.
    const normalized = normalizeValue(raw);
    return Number.isFinite(normalized) ? { median: normalized! } : null;
  }

  if (typeof raw === 'object' && raw !== null) {
    const range: NumericRange = {};
    const rawObj = raw as Record<string, unknown>;

    (['min', 'max', 'mean', 'median'] as const).forEach((key) => {
      const normalized = normalizeValue(rawObj[key]);
      if (Number.isFinite(normalized)) {
        range[key] = normalized!;
      }
    });
    // Defensive: fold a legacy standalone `value` (e.g. from an external
    // import that predates the mean/median split) into `median`.
    if (range.median === undefined) {
      const legacy = normalizeValue(rawObj.value);
      if (Number.isFinite(legacy)) range.median = legacy!;
    }
    if (!Object.keys(range).length) return null;
    // Preserve metadata for display (suppress unit when converting to fraction)
    if (typeof rawObj.unit === 'string' && !asFraction) range.unit = rawObj.unit;
    // Drop free-text qualifiers on import — only comparison operators are
    // valid; anything else is route/population prose that belongs in `note`.
    if (isQualifierOperator(rawObj.qualifier)) range.qualifier = rawObj.qualifier;
    if (typeof rawObj.note === 'string') {
      const n = rawObj.note;
      if (!n.startsWith('auto-extracted') && !n.startsWith('LD50') && n.length <= 40)
        range.note = n;
    }
    return range;
  }

  const numeric = normalizeValue(extractNumeric(raw));
  return Number.isFinite(numeric) ? { median: numeric! } : null;
}

export function hasRangeData(range: NumericRange | null | undefined): range is NumericRange {
  return (
    range !== null &&
    range !== undefined &&
    (Number.isFinite(range.median) ||
      Number.isFinite(range.mean) ||
      Number.isFinite(range.min) ||
      Number.isFinite(range.max))
  );
}

export function rangeCandidates(range: NumericRange | null | undefined): number[] {
  if (!range) return [];
  const vals: number[] = [];
  if (Number.isFinite(range.min)) vals.push(range.min!);
  if (Number.isFinite(range.max)) vals.push(range.max!);
  if (Number.isFinite(range.median)) vals.push(range.median!);
  if (Number.isFinite(range.mean)) vals.push(range.mean!);
  return vals;
}

export function buildRangeFromCandidates(
  candidates: number[],
  central?: { mean?: number | null; median?: number | null }
): NumericRange | null {
  const nums = candidates.filter((n) => Number.isFinite(n));
  const mean = central?.mean;
  const median = central?.median;
  if (!nums.length && !Number.isFinite(mean) && !Number.isFinite(median)) return null;

  const next: NumericRange = {};
  if (nums.length) {
    next.min = Math.min(...nums);
    next.max = Math.max(...nums);
  }
  if (Number.isFinite(mean)) next.mean = mean!;
  if (Number.isFinite(median)) next.median = median!;
  if (!Object.keys(next).length) return null;
  return next;
}

interface MapRangeOptions {
  positiveOnly?: boolean;
}

export function mapRange(
  range: NumericRange | null | undefined,
  mapper: (value: number) => number,
  options: MapRangeOptions = {}
): NumericRange | null {
  const { positiveOnly = false } = options;
  if (!hasRangeData(range)) return null;

  const next: NumericRange = {};
  const shouldKeep = (n: number): boolean =>
    positiveOnly ? Number.isFinite(n) && n > 0 : Number.isFinite(n);

  // Map each present field independently so mean/median keep their labels
  // through the transform (e.g. unit conversion).
  (['min', 'max', 'mean', 'median'] as const).forEach((key) => {
    if (Number.isFinite(range![key])) {
      const mapped = mapper(range![key]!);
      if (shouldKeep(mapped)) next[key] = mapped;
    }
  });

  return Object.keys(next).length ? next : null;
}

type CombinerFunction = (a: number, b: number) => number | null;

export function combineRanges(
  a: NumericRange | null | undefined,
  b: NumericRange | null | undefined,
  combiner: CombinerFunction,
  options: MapRangeOptions = {}
): NumericRange | null {
  const { positiveOnly = false } = options;
  const candidates: number[] = [];

  const combineValues = (valA: number | undefined, valB: number | undefined): number | null => {
    if (!Number.isFinite(valA) || !Number.isFinite(valB)) return null;
    const combined = combiner(valA!, valB!);
    if (combined === null || !Number.isFinite(combined)) return null;
    if (positiveOnly && combined <= 0) return null;
    return combined;
  };

  rangeCandidates(a).forEach((valA) => {
    rangeCandidates(b).forEach((valB) => {
      const combined = combineValues(valA, valB);
      if (combined !== null) candidates.push(combined);
    });
  });

  // Combine like-with-like for the central statistics.
  const meanCandidate = combineValues(a?.mean, b?.mean);
  const medianCandidate = combineValues(a?.median, b?.median);
  return buildRangeFromCandidates(candidates, {
    mean: meanCandidate,
    median: medianCandidate,
  });
}

export function rangesEqual(
  a: NumericRange | null | undefined,
  b: NumericRange | null | undefined
): boolean {
  if (!a || !b) return false;
  return (
    a.min === b.min &&
    a.max === b.max &&
    a.mean === b.mean &&
    a.median === b.median
  );
}

export function rangeRepresentative(range: NumericRange | null | undefined): number | null {
  const candidates = rangeCandidates(range);
  if (!candidates.length) return null;
  return candidates.reduce((sum, val) => sum + val, 0) / candidates.length;
}

export function rangeMax(range: NumericRange | null | undefined): number | null {
  const candidates = rangeCandidates(range).filter((n) => Number.isFinite(n));
  return candidates.length ? Math.max(...candidates) : null;
}

export function rangeMin(range: NumericRange | null | undefined): number | null {
  const candidates = rangeCandidates(range).filter((n) => Number.isFinite(n));
  return candidates.length ? Math.min(...candidates) : null;
}

/**
 * Thousands separator shown throughout the UI. A non-breaking space (U+00A0)
 * so grouped numbers like "300 000" render with a space yet never wrap across
 * lines — the SI / Norwegian convention for digit grouping.
 */
export const THOUSANDS_SEPARATOR = ' ';

/**
 * Insert {@link THOUSANDS_SEPARATOR} into the integer part of an already
 * formatted numeric string, leaving any leading sign and trailing decimals
 * untouched. E.g. "300000" → "300 000", "-43263.5" → "-43 263.5".
 */
export function groupThousands(formatted: string): string {
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(formatted);
  if (!match) return formatted;
  const [, sign = '', intPart = '', frac = ''] = match;
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS_SEPARATOR);
  return `${sign}${grouped}${frac}`;
}

/**
 * Format a number with at most 3 significant decimal places (excluding leading zeros).
 * Integer parts are grouped with a space thousands separator.
 * E.g., 0.00123456 → "0.00123", 1.23456 → "1.235", 300000 → "300 000"
 */
export function formatWithMaxDecimals(num: number, maxDecimals = 3): string {
  if (!isFinite(num)) return '';
  if (num === 0) return '0';

  const absNum = Math.abs(num);

  // For numbers >= 1, just use fixed decimal places
  if (absNum >= 1) {
    const rounded = Math.round(num * Math.pow(10, maxDecimals)) / Math.pow(10, maxDecimals);
    // Remove trailing zeros
    return groupThousands(String(rounded).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
  }

  // For numbers < 1, find position of first significant digit
  const logValue = Math.floor(Math.log10(absNum));
  const significantPosition = -logValue; // How many places after decimal the first sig digit is
  const totalDecimals = significantPosition + maxDecimals - 1;

  const rounded = Math.round(num * Math.pow(10, totalDecimals)) / Math.pow(10, totalDecimals);
  // Remove trailing zeros (integer part is always "0" here, so no grouping needed)
  return String(rounded).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function formatCalcRange(range: NumericRange | null | undefined): string {
  if (!hasRangeData(range)) return '—';
  const parts: string[] = [];

  const fmt = (n: number) => formatWithMaxDecimals(n, 3);

  const rep = representativeValue(range);
  if (rep !== null) parts.push(fmt(rep));
  else if (Number.isFinite(range.min) && Number.isFinite(range.max)) {
    parts.push(`${fmt(range.min!)}–${fmt(range.max!)}`);
  } else {
    if (Number.isFinite(range.min)) parts.push(`≥${fmt(range.min!)}`);
    if (Number.isFinite(range.max)) parts.push(`≤${fmt(range.max!)}`);
  }

  return parts.join(', ') || '—';
}

export function round(num: number, precision = 6): number | string {
  if (!isFinite(num)) return '';
  return Math.round(num * Math.pow(10, precision)) / Math.pow(10, precision);
}

/**
 * Convert a NumericRange (or plain number) to a DistributionSpec for Monte Carlo sampling.
 * - Single value → fixed distribution
 * - min + max → uniform distribution
 * - min + max + representative value → triangular distribution (median/mean as mode)
 */
export function rangeToDistribution(
  range: NumericRange | number | null | undefined,
  fallbackValue?: number
): DistributionSpec {
  if (typeof range === 'number' && Number.isFinite(range)) {
    return { type: 'fixed', value: range };
  }

  if (!range || !hasRangeData(range as NumericRange)) {
    return { type: 'fixed', value: fallbackValue ?? 1 };
  }

  const r = range as NumericRange;
  const hasMin = Number.isFinite(r.min);
  const hasMax = Number.isFinite(r.max);
  // Median preferred, then mean, as the central tendency / triangular mode.
  const rep = representativeValue(r);

  // Bounds + a central value: triangular with the median/mean as the mode.
  if (hasMin && hasMax && rep !== null && r.min! < r.max!) {
    const mode = Math.max(r.min!, Math.min(r.max!, rep));
    return { type: 'triangular', min: r.min!, mode, max: r.max! };
  }

  // Min and max only: uniform
  if (hasMin && hasMax && r.min! < r.max!) {
    return { type: 'uniform', min: r.min!, max: r.max! };
  }

  // Single value (representative, or min=max)
  const val = rep ?? r.min ?? r.max ?? fallbackValue ?? 1;
  return { type: 'fixed', value: val };
}
