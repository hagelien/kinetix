/**
 * Finding concentrations (a figure followed by a concentration unit, e.g.
 * "0,2 til 0,5 mg/L" or "< 5 µg/L") inside free prose, so a surface can hang
 * the unit-conversion tooltip on them.
 *
 * Shared by the two prose surfaces that do this: the wiki renderer, which
 * annotates sanitized HTML text nodes, and the per-source lists, which render
 * plain-text fields (source quote, observation context, comments) as React.
 * Keeping one pattern means the two never disagree about what counts as a
 * concentration.
 */

const CONCENTRATION_NUMBER_PATTERN = String.raw`\d+(?:(?:[,.]\d{3})+)?(?:[,.]\d+)?`;
const CONCENTRATION_RANGE_SEPARATOR_PATTERN = String.raw`(?:[–-]|\btil\b|\bto\b)`;
const CONCENTRATION_UNIT_PATTERN = [
  "mmol/dL",
  "(?:µ|μ|u)mol/dL",
  "nmol/dL",
  "mmol/L",
  "(?:µ|μ|u)mol/L",
  "nmol/L",
  "ng/mL",
  "(?:µ|μ|u)g/mL",
  "mg/L",
  "(?:µ|μ|u)g/L",
  "ng/L",
  "mg/dL",
  "(?:µ|μ|u)g/dL",
  "ng/dL",
].join("|");

/**
 * The figure must start a number, not continue one the pattern cannot read.
 * Without this, a space-grouped value (`2 500 mg/L`) or scientific notation
 * (`1e-3 mg/L`) matched from partway through — `500 mg/L`, `3 mg/L` — and the
 * tooltip converted the wrong value. Such forms are left unannotated instead:
 * no digit (or letter, decimal mark) may come before the figure, even across
 * spaces, and no exponent marker.
 */
const CONCENTRATION_NUMBER_START_GUARD = String.raw`(?<!\d[\s]*|[A-Za-zÀ-ɏ_.,]|[eE][+-]?)`;

/**
 * Group 1: the (optionally qualified, optionally ranged) figure — it may carry
 * the whitespace that precedes it. Group 2: the unit as written. A unit that is
 * itself the numerator of a compound unit (`mg/L/h`, `mg/L per dose`) is not a
 * concentration and is left alone.
 */
const CONCENTRATION_SOURCE = `((?:<=|>=|[<>≤≥])?\\s*${CONCENTRATION_NUMBER_START_GUARD}${CONCENTRATION_NUMBER_PATTERN}(?:\\s*${CONCENTRATION_RANGE_SEPARATOR_PATTERN}\\s*${CONCENTRATION_NUMBER_PATTERN})?)\\s*(${CONCENTRATION_UNIT_PATTERN})(?!\\s*(?:/|·|\\*|per\\b))\\b`;

/** Non-global, so testing it carries no `lastIndex` state between calls. */
const CONCENTRATION_TEST_RE = new RegExp(CONCENTRATION_SOURCE, "i");

/** True when `text` contains at least one concentration. */
export function containsConcentration(text: string): boolean {
  return CONCENTRATION_TEST_RE.test(text);
}

export type ConcentrationTextSegment =
  | { kind: "text"; text: string }
  | {
      kind: "concentration";
      /** The figure and unit exactly as written (`"0,2 til 0,5 mg/L"`). */
      text: string;
      /** The figure with any qualifier, trimmed (`"0,2 til 0,5"`, `"< 5"`). */
      value: string;
      /** The unit as written (`"mg/L"`, `"ug/L"`, `"μg/L"`). */
      unit: string;
    };

/**
 * Split prose into plain-text runs and concentrations, in order. Joining every
 * segment's `text` gives back the input unchanged. Whitespace the pattern
 * absorbs ahead of a figure stays with the preceding text run, so wrapping or
 * rewriting a concentration never eats the space before it.
 */
export function splitConcentrationText(text: string): ConcentrationTextSegment[] {
  const segments: ConcentrationTextSegment[] = [];
  const pushText = (run: string) => {
    if (!run) return;
    const last = segments[segments.length - 1];
    if (last?.kind === "text") last.text += run;
    else segments.push({ kind: "text", text: run });
  };

  let lastIndex = 0;
  // `matchAll` works on a copy of the regex, so no shared `lastIndex` leaks.
  for (const match of text.matchAll(new RegExp(CONCENTRATION_SOURCE, "gi"))) {
    const index = match.index ?? 0;
    const raw = match[0];
    const leading = /^\s*/.exec(raw)?.[0] ?? "";
    pushText(text.slice(lastIndex, index) + leading);
    segments.push({
      kind: "concentration",
      text: raw.slice(leading.length),
      value: (match[1] ?? "").trim(),
      unit: match[2] ?? "",
    });
    lastIndex = index + raw.length;
  }
  pushText(text.slice(lastIndex));
  return segments;
}

/**
 * Parse a matched figure into the `{ value } | { low } | { high } | { low, high }`
 * shape the conversion helpers take. Accepts both decimal conventions
 * (`0,5` / `0.5`) and thousands groups (`1 000`, `1.000`, `1,000`). `≥`/`>`
 * give a lower bound and `≤`/`<` an upper one. Unparseable input yields `{}`.
 */
export function parseConcentrationValue(raw: string): {
  value?: number;
  low?: number;
  high?: number;
} {
  const normalized = raw.trim();
  const numberFrom = (value: string) => {
    const compact = value.trim().replace(/\s+/g, "");
    const lastComma = compact.lastIndexOf(",");
    const lastDot = compact.lastIndexOf(".");
    if (lastComma >= 0 && lastDot >= 0) {
      return Number(
        lastComma > lastDot
          ? compact.replace(/\./g, "").replace(",", ".")
          : compact.replace(/,/g, ""),
      );
    }
    const commaMatches = compact.match(/,/g) ?? [];
    const dotMatches = compact.match(/\./g) ?? [];
    if (commaMatches.length > 1) return Number(compact.replace(/,/g, ""));
    if (commaMatches.length === 1) {
      const [whole = "", fraction = ""] = compact.split(",");
      if (whole !== "0" && /^\d{1,3}$/.test(whole) && /^0{3}$/.test(fraction)) {
        return Number(`${whole}${fraction}`);
      }
      return Number(compact.replace(",", "."));
    }
    if (dotMatches.length > 1) return Number(compact.replace(/\./g, ""));
    if (dotMatches.length === 1) {
      const [whole = "", fraction = ""] = compact.split(".");
      if (whole !== "0" && /^\d{1,3}$/.test(whole) && /^0{3}$/.test(fraction)) {
        return Number(`${whole}${fraction}`);
      }
    }
    return Number(compact);
  };
  if (/^(?:>=|>|≥)/.test(normalized)) {
    const value = numberFrom(normalized.replace(/^(?:>=|>|≥)\s*/, ""));
    return Number.isFinite(value) ? { low: value } : {};
  }
  if (/^(?:<=|<|≤)/.test(normalized)) {
    const value = numberFrom(normalized.replace(/^(?:<=|<|≤)\s*/, ""));
    return Number.isFinite(value) ? { high: value } : {};
  }

  const range = normalized.split(/\s*(?:[–-]|\btil\b|\bto\b)\s*/i);
  if (range.length === 2) {
    const low = numberFrom(range[0] ?? "");
    const high = numberFrom(range[1] ?? "");
    return Number.isFinite(low) && Number.isFinite(high) ? { low, high } : {};
  }

  const value = numberFrom(normalized);
  return Number.isFinite(value) ? { value } : {};
}

/** The strict comparison a figure opens with, if any (`<`/`>`, not `<=`/`≤`). */
export function strictOperator(raw: string): "<" | ">" | null {
  const normalized = raw.trim();
  if (/^<(?![=])/.test(normalized)) return "<";
  if (/^>(?![=])/.test(normalized)) return ">";
  return null;
}

/**
 * Restore a strict operator on a converted bound. The conversion helpers
 * format a one-sided bound as `≤`/`≥`; a source that wrote `< 5` must not be
 * re-expressed as `≤ 5 000`.
 */
export function preserveStrictOperator(
  formatted: string,
  op: "<" | ">" | null,
): string {
  if (op === "<") return formatted.replace(/^≤\s*/, "< ");
  if (op === ">") return formatted.replace(/^≥\s*/, "> ");
  return formatted;
}

/**
 * The numbers to hand `UnitTooltip` for a figure that stays on screen as
 * written. A range converts both ends; a qualified figure (`< 5`, `≥ 10`)
 * converts its bound as a bare number, since the qualifier is already visible
 * beside it — the same convention the source-value rows use for censored
 * readings, and the only one that cannot turn a strict `<` into `≤`.
 */
export function concentrationTooltipArgs(raw: string): {
  value?: number;
  low?: number;
  high?: number;
} {
  const parsed = parseConcentrationValue(raw);
  if (parsed.low != null && parsed.high != null) return parsed;
  const bound = parsed.value ?? parsed.low ?? parsed.high;
  return bound != null ? { value: bound } : {};
}
