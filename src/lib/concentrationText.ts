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
 * The figure must start a number, not continue an expression the pattern
 * cannot read. Without this, the matcher restarted partway through one and the
 * tooltip converted the wrong value: `500` from `2 500 mg/L`, `3` from
 * `1e-3 mg/L` or `5 × 10^-3 mg/L`, the uncertainty `14` from `84 ± 14 ng/mL`.
 *
 * So the figure is refused when, looking back across anything that is neither
 * a letter nor a digit (spaces, `±`, `×`, `^`, dashes, brackets, colons), the
 * nearest character is a digit — the figure is then part of something
 * numeric that started earlier. Also refused: a letter of any script, `_` or
 * decimal mark directly before it (`A5`, `β5`), an exponent marker (`1e-3`, `1E3`), and a digit
 * then the letter `x` used as a multiplication sign (`5 x 10-3`), and a sign
 * before it, spaced or not (`−1–3 ng/mL`, `− 1–3`, `+ 2 mg/L`): the pattern is
 * unsigned, so it would convert the interval as positive. A real range
 * (`1–3 mg/L`) is matched from its first figure and is unaffected. The cost is
 * the safe one: a concentration written straight after an unrelated number
 * (`dag 1: 5 mg/L`) is left unannotated rather than ever converted wrongly.
 */
const LETTER = String.raw`\p{L}`;
const CONCENTRATION_NUMBER_START_GUARD = String.raw`(?<!\d[^${LETTER}\d]*|\d\s*[xX]\s*|[${LETTER}_.,]|[eE][+\-\u2212]?|[+\-\u2212–±]\s*)`;

/**
 * Group 1: the (optionally qualified, optionally ranged) figure — it may carry
 * the whitespace that precedes it. Group 2: the unit as written. A unit that is
 * itself the numerator of a compound unit (`mg/L/h`, `mg/L per dose`) is not a
 * concentration and is left alone.
 */
const CONCENTRATION_SOURCE = `((?:<=|>=|[<>≤≥])?\\s*${CONCENTRATION_NUMBER_START_GUARD}${CONCENTRATION_NUMBER_PATTERN}(?:\\s*${CONCENTRATION_RANGE_SEPARATOR_PATTERN}\\s*${CONCENTRATION_NUMBER_PATTERN})?)\\s*(${CONCENTRATION_UNIT_PATTERN})(?!\\s*(?:/|[·⋅∙•×*]|x\\s+\\p{L}|per\\b))\\b`;

const CANONICAL_CONCENTRATION_UNITS = [
  "mmol/dL", "µmol/dL", "nmol/dL", "mmol/L", "µmol/L", "nmol/L",
  "ng/mL", "µg/mL", "mg/L", "µg/L", "ng/L", "mg/dL", "µg/dL", "ng/dL",
];

/**
 * The registry spelling of a matched unit. The pattern matches case-
 * insensitively and accepts `u`/`μ` for micro, so `mg/l`, `NG/ML` and `ug/L`
 * reach here as written; the conversion registry only knows `mg/L`, `ng/mL`,
 * `µg/L`. Use this for the conversion; keep the authored spelling on screen.
 */
export function canonicalConcentrationUnit(unit: string): string {
  const key = unit.replace(/^[uμ]/i, "µ").toLowerCase();
  return CANONICAL_CONCENTRATION_UNITS.find((u) => u.toLowerCase() === key) ?? unit;
}

/** Non-global, so testing it carries no `lastIndex` state between calls. */
const CONCENTRATION_TEST_RE = new RegExp(CONCENTRATION_SOURCE, "iu");

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
  for (const match of text.matchAll(new RegExp(CONCENTRATION_SOURCE, "giu"))) {
    const index = match.index ?? 0;
    const raw = match[0];
    const leading = /^\s*/.exec(raw)?.[0] ?? "";
    const value = (match[1] ?? "").trim();
    // A figure the value parser cannot read stays plain text rather than
    // carrying a tooltip with nothing to convert.
    if (Object.keys(parseConcentrationValue(value)).length === 0) {
      pushText(text.slice(lastIndex, index + raw.length));
      lastIndex = index + raw.length;
      continue;
    }
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
