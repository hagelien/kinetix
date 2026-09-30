/**
 * Parse a numeric string that may use comma OR dot as the decimal
 * separator (Norwegian / European keyboards default to comma; US to dot).
 *
 * Returns NaN for non-numeric input — and importantly, also for
 * AMBIGUOUS input where a single separator is followed by exactly three
 * digits with no further context (`"1,500"`, `"1.500"`). Such strings
 * could legitimately mean either 1.5 (decimal) or 1500 (thousands), and
 * silently picking one risks a 1000× error in clinical / forensic
 * concentrations and doses. Callers that already validate finiteness
 * (`Number.isFinite(n)`) will then reject the input and surface a clear
 * error.
 *
 * Mixed-separator input is unambiguous: the right-most separator is the
 * decimal point and the other is treated as a thousands grouper.
 *   "1,500.25" → 1500.25
 *   "1.500,25" → 1500.25
 *
 * Multiple instances of a single separator are treated as thousands when
 * every group is exactly three digits.
 *   "1,500,000" → 1500000
 *   "1.500.000" → 1500000
 *
 * Non-finite results (`"Infinity"`, `"1e400"`) also come back as NaN, so a
 * `Number.isFinite` check at the call site is the only guard needed.
 */
export function parseLocaleNumber(value: string): number {
  const result = parseLocaleNumberDetailed(value);
  return result.ok ? result.value : Number.NaN;
}

/**
 * Why a parse failed. `invalid` means the input isn't a number at all
 * (or is a malformed thousands shape); `ambiguous` means it IS a number
 * under two readings that differ by 1000× and we refuse to pick one.
 */
export type LocaleNumberFailure =
  | { ok: false; reason: 'invalid' }
  | {
      ok: false;
      reason: 'ambiguous';
      /** Reading where the separator is a decimal point ("62.005" → 62.005). */
      asDecimal: number;
      /** Reading where the separator groups thousands ("62.005" → 62005). */
      asThousands: number;
    };

export type LocaleNumberResult = { ok: true; value: number } | LocaleNumberFailure;

/**
 * `parseLocaleNumber` with the reason attached. Callers that can offer the
 * user a way out of the ambiguous case (e.g. "did you mean 62,005 or
 * 62 005?") need to tell it apart from genuine garbage — collapsing both
 * to NaN leaves a form field with no message that fits, and a value like
 * a PubChem-sourced molecular weight of `62.005` unenterable.
 */
export function parseLocaleNumberDetailed(value: string): LocaleNumberResult {
  const invalid = { ok: false, reason: 'invalid' } as const;
  if (typeof value !== 'string') return invalid;
  const trimmed = value.trim();
  if (trimmed === '') return invalid;

  const ambiguous = ambiguousReadings(trimmed);
  if (ambiguous) {
    const asDecimal = Number(`${ambiguous.before}.${ambiguous.after}`);
    const asThousands = Number(`${ambiguous.before}${ambiguous.after}`);
    return Number.isFinite(asDecimal) && Number.isFinite(asThousands)
      ? { ok: false, reason: 'ambiguous', asDecimal, asThousands }
      : invalid;
  }

  const canonical = degroupedNumberText(trimmed);
  if (canonical === null) return invalid;
  const parsed = Number(canonical);
  return Number.isFinite(parsed) ? { ok: true, value: parsed } : invalid;
}

/**
 * The two readings of a single separator followed by exactly three digits,
 * or null where the text is not that shape.
 *
 * The leading group has to look like a thousands-formatted leader for the
 * ambiguity to exist at all: 1–3 digits with no leading zero and an optional
 * sign. `"1,500"` is 1.5 or 1500; `"0.001"` is decimal, because a leading zero
 * rules the thousands reading out; `"1234.567"` likewise, on four leading
 * digits.
 */
function ambiguousReadings(trimmed: string): { before: string; after: string } | null {
  const hasComma = trimmed.includes(',');
  const hasDot = trimmed.includes('.');
  // Both, or neither: the mixed case resolves itself by position, and text
  // with no separator has nothing to read two ways.
  if (hasComma === hasDot) return null;
  const parts = trimmed.split(hasComma ? ',' : '.');
  if (parts.length !== 2) return null;
  const [before, after] = parts;
  // The sign is part of the leading group, either sign: `+1,500` reads 1.5 or
  // 1500 exactly as `1,500` does, and a check that saw only the minus let the
  // plus through to a 1000× guess on a relative hour.
  return after && /^\d{3}$/.test(after) && before && /^[+-]?[1-9]\d{0,2}$/.test(before)
    ? { before, after }
    : null;
}

/**
 * The same digits with the grouping taken out and the decimal separator
 * written as a dot — `"1.500,20"` → `"1500.20"` — or null where the text is not
 * a number this parser accepts.
 *
 * Exported because the string form is the answer to a second question the
 * number cannot hold: how many decimals the reader actually stated.
 * `Number('1500.20')` is `1500.2`, so the laboratory's last significant digit
 * survives only in the text — and a caller counting decimals off the raw input
 * has to understand grouping exactly as this parser does, or it will read
 * `1.500,20` as malformed and drop the precision the parse accepted. One
 * implementation, so the two cannot disagree.
 *
 * Ambiguous input is null here too: the reading is refused, so there are no
 * decimals to state.
 */
export function degroupedNumberText(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (ambiguousReadings(trimmed)) return null;

  const hasComma = trimmed.includes(',');
  const hasDot = trimmed.includes('.');

  if (!hasComma && !hasDot) return trimmed;

  if (hasComma && hasDot) {
    // Last separator wins as the decimal point; the other is a thousands
    // grouper and gets stripped.
    const decimalSep = trimmed.lastIndexOf(',') > trimmed.lastIndexOf('.') ? ',' : '.';
    const thousandSep = decimalSep === ',' ? '.' : ',';
    return trimmed.split(thousandSep).join('').replace(decimalSep, '.');
  }

  // Single separator type, possibly repeated.
  const sep = hasComma ? ',' : '.';
  const parts = trimmed.split(sep);
  if (parts.length === 2) return trimmed.replace(sep, '.');

  // Multiple occurrences. Only meaningful if the shape matches a thousands
  // grouping: every middle group is exactly three digits, and the trailing
  // group is also exactly three digits (the last separator can't double as
  // a decimal point since both have the same character here).
  const middle = parts.slice(1, -1);
  const last = parts[parts.length - 1] ?? '';
  return middle.every((p) => /^\d{3}$/.test(p)) && /^\d{3}$/.test(last)
    ? parts.join('')
    : null;
}
