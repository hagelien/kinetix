/**
 * Number formatting for the ratio profile (§8.4).
 *
 * The handoff's precision ladder exactly, with a locale-aware separator. Kept
 * apart from the view so the same ladder serves report output in Phase 4 — the
 * handoff's own open item was that screen and report wording must not drift.
 */
import { degroupedNumberText } from '../parseNumber.js';

/**
 * Decimal places by magnitude: `≥100` → 0, `≥10` → 1, `≥1` → 2, else 3.
 * Exported because the axis and the value cells must agree, and a second copy of
 * this table is how they stop agreeing.
 */
export function precisionFor(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude >= 100) return 0;
  if (magnitude >= 10) return 1;
  if (magnitude >= 1) return 2;
  return 3;
}

/**
 * Format a ratio for display. Trailing zeros are stripped below 1, per the
 * handoff — `0,212` keeps three places but `0,210` reads `0,21`.
 *
 * Note `locale` defaults to Norwegian: this view ships in nb first and the
 * decimal comma is a correctness requirement in it, not a preference.
 */
export function formatRatio(value: number, locale = 'nb-NO'): string {
  if (!Number.isFinite(value)) return '—';
  const digits = precisionFor(value);
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
  if (digits === 0) return formatted;

  // Strip trailing zeros, then a bare separator left behind by stripping all of
  // them. Done on the formatted string rather than the number so the locale's
  // separator is whatever Intl chose, not an assumption about it.
  const separator = decimalSeparator(locale);
  if (!formatted.includes(separator)) return formatted;
  return formatted.replace(/0+$/, '').replace(new RegExp(`\\${separator}$`), '');
}

/**
 * Format a censored or interval-valued result. The comparison operators are part
 * of the value's meaning, so they belong here rather than in the component: a
 * `>` dropped at render time turns a bound into a measurement.
 */
export function formatInterval(
  interval: { low: number | null; high: number | null },
  status: string,
  locale = 'nb-NO',
): string {
  const { low, high } = interval;
  switch (status) {
    case 'point':
      return low === null ? '—' : formatRatio(low, locale);
    case 'lower_bound':
      return low === null ? '—' : `>${formatRatio(low, locale)}`;
    case 'upper_bound':
      return high === null ? '—' : `<${formatRatio(high, locale)}`;
    case 'interval':
      if (low === null || high === null) return '—';
      return `${formatRatio(low, locale)}–${formatRatio(high, locale)}`;
    default:
      // `indeterminate` and `blocked` both read as an em dash. A quantified zero
      // does not reach here — it is a `point` and renders as `0` (§8.3).
      return '—';
  }
}

/**
 * Format a measured quantity — a concentration, a reporting limit — for display.
 *
 * Deliberately *not* `formatRatio`: that ladder is calibrated for ratios, and a
 * three-digit concentration run through it loses every decimal the laboratory
 * reported. What is shared with `formatRatio` is the locale separator, which is
 * the whole reason this exists — a raw JS number interpolated into Norwegian
 * prose renders with a decimal point among values that use a comma.
 */
export function formatMeasured(
  value: number,
  locale = 'nb-NO',
  reportedDecimals?: number,
): string {
  if (!Number.isFinite(value)) return '—';
  // What the source reported wins over what the number can carry: `1.50` and
  // `1.5` are the same JavaScript value and different statements about the
  // assay's precision, and only the source knows which was made.
  const needed = reportedDecimals === undefined ? decimalsOf(value) : reportedDecimals;
  // Below Intl's twenty-decimal limit, a decimal rendering does not merely lose
  // precision — it prints `0` for a value the arithmetic is still using, so the
  // observation contradicts the ratio computed from it. Scientific notation is
  // the only form that can state such a measurement at all.
  if (needed > MAX_FRACTION_DIGITS) {
    // Zero first: it is the one value the decimal form can state at any scale,
    // because there is nothing to round off. See `zeroAtScale`.
    if (value === 0) return zeroAtScale(needed, locale);
    // With the significant digits stated, not `Intl`'s default three: the
    // whole reason this branch exists is that the decimal form cannot show
    // such a measurement, and a scientific form that rounds `1,23456789E-21`
    // to `1,235E-21` puts a different concentration on screen from the one the
    // ratio beside it was computed from. The count follows from what the
    // source reported — the decimals it stated, less the exponent, plus the
    // digit before the point.
    const digits = significantDigitsFor(value, needed);
    // Unless the claim outruns the number. Padding `1,5` out to forty decimals
    // states thirty-nine figures the double never had — inventing precision is
    // the same error as dropping it, in the other direction. There the value
    // states itself.
    return digits > MAX_SIGNIFICANT_DIGITS
      ? new Intl.NumberFormat(locale, {
          notation: 'scientific',
          maximumSignificantDigits: MAX_SIGNIFICANT_DIGITS,
        }).format(value)
      : new Intl.NumberFormat(locale, {
          notation: 'scientific',
          minimumSignificantDigits: digits,
          maximumSignificantDigits: digits,
        }).format(value);
  }
  const digits = clampDecimals(needed);
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/**
 * The same value with no grouping separators, for a field a reader will edit.
 *
 * `Intl` groups by default, so `1000` displays as `1 000` in Norwegian and
 * `1,000` in English. Both are right to read and neither survives being typed
 * back: the parser rejects the non-breaking space outright and classifies the
 * English form as ambiguous — deliberately, since `1,000` is 1 or 1000
 * depending on the reader. A grouped value in an editable field is therefore a
 * value that cannot be edited at all, only cleared and retyped.
 */
export function formatForEditing(
  value: number,
  locale = 'nb-NO',
  reportedDecimals?: number,
): string {
  if (!Number.isFinite(value)) return '';
  const needed = reportedDecimals === undefined ? decimalsOf(value) : reportedDecimals;
  // Same limit, different constraint: this text has to be *typeable back*, and
  // `Intl`'s scientific notation uses a Unicode minus the parser rejects. The
  // number's own exponential form with the locale's decimal separator round
  // trips — the parser accepts `1,25e-21` — and an uneditable field is worse
  // than an unfamiliar one.
  if (needed > MAX_FRACTION_DIGITS) {
    // `String(0)` is `"0"`, which states none of the decimals the source
    // reported — and unlike a tiny non-zero value, zero can be written out in
    // full at any scale. See `zeroAtScale`.
    if (value === 0) return zeroAtScale(needed, locale);
    // `String(1e-21)` is `"1e-21"` whatever the source reported, so a value
    // entered as `1,00e-21` came back two digits short — the field showing a
    // less precise result than the case it is editing, while Save went on
    // filing the precise one. The mantissa is written to the digits the source
    // stated instead, in a form the parser takes back.
    const digits = significantDigitsFor(value, needed);
    // A claim past what the double carries gets the number's own text, as
    // before: padding it out would put figures in the field that nothing in
    // the case ever held.
    if (digits > MAX_SIGNIFICANT_DIGITS) {
      return String(value).replace('.', decimalSeparator(locale));
    }
    const [mantissa, exponent] = value.toExponential(digits - 1).split('e');
    return `${mantissa!.replace('.', decimalSeparator(locale))}e${exponent}`;
  }
  const digits = clampDecimals(needed);
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  }).format(value);
}

/**
 * How many decimals a reader's own text states, or `undefined` where it states
 * nothing beyond what the number already carries.
 *
 * Written against the text rather than the parsed value because that is the
 * only place the answer survives — and it has to understand every form the
 * parser accepts, not only the common one. `1e-7` has no decimal separator at
 * all and is not a whole number; reading it as zero decimals and then treating
 * that as authoritative renders a reported measurement as `0`.
 *
 * Grouping is taken out by the parser's own function rather than by a rule
 * written here. `1.500,20` is a value the parser accepts as 1500.2, and a
 * second reading of it found `1.500.20` malformed and returned nothing \u2014 so
 * the trailing zero the laboratory reported was dropped by the one step whose
 * whole purpose is to keep it.
 */
export function reportedDecimalsOf(text: string): number | undefined {
  const normalized = degroupedNumberText(text.replace(/[\s\u00a0]/g, ''));
  if (normalized === null) return undefined;
  const parts = /^[+-]?(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(normalized);
  if (!parts) return undefined;
  const mantissaDecimals = parts[2]?.length ?? 0;
  const exponent = parts[3] === undefined ? 0 : Number(parts[3]);
  const decimals = Math.max(mantissaDecimals - exponent, 0);
  // Not clamped to what a formatter can render: they need the true figure to
  // know when a decimal rendering cannot express the value at all. Bounded
  // only where the claim stops being about a number — `1e-1000000000` states a
  // billion decimals about a value that underflowed to zero, and carrying that
  // figure forward would have something downstream try to write it out.
  return decimals > MAX_REPORTED_DECIMALS ? undefined : decimals;
}

/**
 * How many decimal places the number actually carries, so formatting neither
 * pads nor truncates what was entered.
 *
 * Exponential notation has to be expanded rather than waved through: asking for
 * the 20-digit cap on `1e-7` renders `0,00000010000000000000`, thirteen digits
 * of precision the laboratory never reported. The decimals a value in that form
 * needs are its mantissa's, shifted by the exponent.
 */
function decimalsOf(value: number): number {
  const text = String(value);
  const exponential = /^-?(\d+)(?:\.(\d+))?e([+-]?\d+)$/i.exec(text);
  if (exponential) {
    const mantissaDecimals = exponential[2]?.length ?? 0;
    const exponent = Number(exponential[3]);
    return Math.max(mantissaDecimals - exponent, 0);
  }
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** Intl accepts 0–20 fraction digits and throws outside that range. */
export const MAX_FRACTION_DIGITS = 20;

/**
 * The most decimals any measurement this program holds can be stated to.
 *
 * The smallest positive double is about 5e-324, so a claim past that describes
 * no value a case can carry — `1e-1000000000` parses to a finite zero and
 * states a billion decimal places, which is a precision about nothing. The
 * limit exists because the count is *used*: it decides how long a rendering
 * is, and an unbounded one is a string nobody asked for and a tab that stops
 * responding.
 */
export const MAX_REPORTED_DECIMALS = 324;

/**
 * The most significant digits a double distinguishes.
 *
 * Seventeen round-trip; past that the figures are an artefact of the binary
 * representation rather than anything a source stated. It bounds the *shown*
 * precision where `MAX_REPORTED_DECIMALS` bounds the *claimed* one: a value of
 * 1.5 reported to forty decimals is a real enough claim to store, and writing
 * it out as `1,50000000000000000000` would assert thirty-nine figures the
 * number never carried.
 */
const MAX_SIGNIFICANT_DIGITS = 17;

function clampDecimals(decimals: number): number {
  return Math.min(Math.max(decimals, 0), MAX_FRACTION_DIGITS);
}

/**
 * Zero, written at the precision the source stated.
 *
 * A quantified zero is a real result (§8.1), and a laboratory that reported it
 * to more decimals than `Intl` will render was making a statement about its
 * assay exactly as `1,50` is. Both other paths lose that: `Intl`'s scientific
 * form gives `0E0`, and `String(0)` gives `0`.
 *
 * Zero is also the one value that does not need either of them. The scientific
 * branch exists because a decimal rendering prints `0` for a value the
 * arithmetic is still using — here the value *is* zero, so writing the digits
 * out states it exactly, at any scale, and the text still parses back.
 */
function zeroAtScale(decimals: number, locale: string): string {
  // Bounded, because this expands into a string: `1e-1000000000` parses to a
  // finite zero and states a billion decimals, and repeating a character that
  // many times either throws or takes the tab with it. Beyond
  // `MAX_REPORTED_DECIMALS` the claim describes no value this program can
  // hold, so nothing is lost by declining to write it out.
  const digits = Math.min(decimals, MAX_REPORTED_DECIMALS);
  return digits <= 0 ? '0' : `0${decimalSeparator(locale)}${'0'.repeat(digits)}`;
}

/**
 * How many significant digits a scientific rendering has to show to state what
 * the source reported.
 *
 * `decimals` counts places after the point; scientific notation counts digits
 * from the first one. The exponent is what converts between them: `1.500e-21`
 * states 24 decimals and four significant digits, and 24 − 21 = 3 of them
 * follow the point.
 *
 * At least one, and no more than the 21 `Intl` accepts — beyond that a double
 * has no digits left to be honest about anyway.
 */
function significantDigitsFor(value: number, decimals: number): number {
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  return Math.min(Math.max(decimals + exponent + 1, 1), 21);
}

function decimalSeparator(locale: string): string {
  const parts = new Intl.NumberFormat(locale).formatToParts(1.1);
  return parts.find((p) => p.type === 'decimal')?.value ?? '.';
}
