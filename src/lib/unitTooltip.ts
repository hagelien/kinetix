import {
  convertToDisplayUnit,
  isConcentrationUnit,
  isEthanolDisplayUnit,
  isMolarUnit,
  normalizeUnit,
  type ConcentrationUnit,
  type DisplayConcentrationUnit,
} from './unitConversion';
import { formatSignificant, formatWithMaxDecimals, groupThousands } from './rangeUtils';
import { getParameterSpec } from './drugParameters';

export type ConcentrationKind = 'molar' | 'mass';

function kindOf(unit: DisplayConcentrationUnit): ConcentrationKind {
  // ‰ and % are mass-per-volume (g/L, g/dL), so they group with the mass units.
  return !isEthanolDisplayUnit(unit) && isMolarUnit(unit) ? 'molar' : 'mass';
}

/**
 * True when `parameterId` names a range-kind drug parameter whose canonical
 * unit is a concentration (mg/L, µmol/L, …). These are the parameters whose
 * displayed values benefit from the magic unit-conversion tooltip — the
 * interpretive concentrations (therapeutic/toxic/impairment/…) and any other
 * concentration-valued range. Used by display surfaces (the review diff, the
 * drug table) to decide whether to wrap a value in `UnitTooltip`.
 */
export function isConcentrationParameterId(
  parameterId: string | null | undefined,
): boolean {
  if (!parameterId) return false;
  const spec = getParameterSpec(parameterId);
  return (
    spec !== null &&
    spec.kind === 'range' &&
    isConcentrationUnit(normalizeUnit(spec.canonicalUnit))
  );
}

/**
 * Curated list of alternative units the magic-conversion tooltip *renders*.
 * Source units that aren't in this list (e.g. `ng/mL`, `µg/mL`) are still
 * accepted as input via `isConcentrationUnit`; the tooltip just expresses
 * them in equivalent /L or /dL units, which are clinically more common in
 * this app and avoid noise (1 ng/mL ≡ 1 µg/L numerically).
 */
const ALTERNATIVE_UNITS: ConcentrationUnit[] = [
  'nmol/L',
  'µmol/L',
  'mmol/L',
  'mg/L',
  'µg/L',
  'ng/L',
  'mg/dL',
  'µg/dL',
];

export interface AlternativeUnit {
  unit: string;
  formatted: string;
  kind: ConcentrationKind;
}

/**
 * Format a converted value for *prose* display (the value shown inline, not in
 * the tooltip). Trims the false precision that plagues large magnitudes: a
 * salicylate reading of `300 mg/L` becomes `2 170 µmol/L`, not
 * `2 172.024 µmol/L` — the same rounding the tooltip rows use.
 */
function formatDisplayValue(value: number): string {
  if (!Number.isFinite(value)) return '';
  return formatSignificant(value);
}

/**
 * Format a figure in the unit it was authored in, digits as the source wrote
 * them. A converted figure is rounded to the house precision, but the authored
 * one is what the reader checks against the source — rounding `1.234 mg/L` to
 * `1.23` would misquote it.
 */
function formatAuthoredValue(value: number): string {
  const plain = String(value);
  return /e/i.test(plain) ? formatWithMaxDecimals(value, 3) : groupThousands(plain);
}

function safeConvert(
  value: number,
  from: ConcentrationUnit,
  to: DisplayConcentrationUnit,
  molecularWeight: number | null | undefined,
): number | null {
  try {
    return convertToDisplayUnit(value, from, to, molecularWeight ?? undefined);
  } catch {
    // Cross-kind conversion without MW throws — treat as "not available".
    return null;
  }
}

/**
 * Normalize a source unit and return the canonical ConcentrationUnit, or null
 * if the unit isn't recognized.
 */
function asConcUnit(unit: string | null | undefined): ConcentrationUnit | null {
  if (!unit) return null;
  const norm = normalizeUnit(unit);
  return isConcentrationUnit(norm) ? norm : null;
}

/**
 * Like {@link asConcUnit}, but also accepts the ethanol display units (‰, %).
 * Only for units something is converted *into* — a source unit stays strict,
 * since a stored `%` is a fraction, never a concentration.
 */
function asTargetUnit(
  unit: string | null | undefined,
): DisplayConcentrationUnit | null {
  if (unit && isEthanolDisplayUnit(unit)) return unit;
  return asConcUnit(unit);
}

/**
 * Resolve the unit list the tooltip should iterate over. When the caller
 * supplies `enabledUnits` (the user's #306 preference), the tooltip
 * honors it; otherwise it falls back to the curated default. Unrecognized
 * unit strings in `enabledUnits` are silently dropped.
 */
function targetUnits(
  enabledUnits: readonly string[] | null | undefined,
): DisplayConcentrationUnit[] {
  if (!enabledUnits || enabledUnits.length === 0) return ALTERNATIVE_UNITS;
  const seen = new Set<string>();
  const out: DisplayConcentrationUnit[] = [];
  for (const u of enabledUnits) {
    const norm = asTargetUnit(u);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out.length > 0 ? out : ALTERNATIVE_UNITS;
}

/**
 * Convert a single concentration value to all relevant alternative units.
 * Skips the source unit and any unit whose conversion isn't possible (e.g.
 * molar↔mass without molecularWeight). Deduplicates alternatives that
 * produce the same formatted value (e.g. µg/mL and mg/L are numerically
 * equivalent — only the first one wins).
 *
 * `enabledUnits` (#306) restricts the rendered alternatives to the units
 * the user has enabled in their preferences. When omitted, the curated
 * `ALTERNATIVE_UNITS` list is used so anonymous visitors and unmigrated
 * call sites keep working.
 */
export function getAlternativeUnits(
  value: number | null | undefined,
  sourceUnit: string | null | undefined,
  molecularWeight: number | null | undefined,
  enabledUnits?: readonly string[] | null,
): AlternativeUnit[] {
  if (value === null || value === undefined || !Number.isFinite(value)) return [];
  const source = asConcUnit(sourceUnit);
  if (!source) return [];

  const out: AlternativeUnit[] = [];
  const seen = new Set<string>();
  for (const target of targetUnits(enabledUnits)) {
    if (target === source) continue;
    const converted = safeConvert(value, source, target, molecularWeight);
    if (converted === null || !Number.isFinite(converted)) continue;
    const formatted = formatSignificant(converted);
    if (!formatted || seen.has(formatted)) continue;
    seen.add(formatted);
    out.push({ unit: target, formatted, kind: kindOf(target) });
  }
  return out;
}

export interface AlternativeRange {
  unit: string;
  formatted: string;
  kind: ConcentrationKind;
}

export interface PreferredUnitDisplay {
  unit: DisplayConcentrationUnit;
  /** Value(s) formatted in the preferred unit, e.g. `2 172–3 620` or `≤ 33.333`. */
  formatted: string;
}

/**
 * The user's preferred concentration unit is the first entry of `enabledUnits`
 * (#306). When it differs from the unit a value is authored in — and the
 * conversion is actually possible (same kind, or cross-kind with a molecular
 * weight) — return the value re-expressed in that preferred unit so callers can
 * show it inline instead of the authored figure. Returns `null` when the value
 * should be left as authored: unknown unit, preferred unit equals the source,
 * or a cross-kind conversion was requested without a molecular weight.
 */
export function getPreferredUnitDisplay(
  args: {
    value?: number | null;
    low?: number | null;
    high?: number | null;
  },
  sourceUnit: string | null | undefined,
  molecularWeight: number | null | undefined,
  enabledUnits: readonly string[] | null | undefined,
): PreferredUnitDisplay | null {
  const source = asConcUnit(sourceUnit);
  if (!source) return null;
  const preferred = asTargetUnit(enabledUnits?.[0]);
  if (!preferred || preferred === source) return null;

  const convert = (v: number | null | undefined) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return null;
    return safeConvert(v, source, preferred, molecularWeight);
  };
  const low = convert(args.low);
  const high = convert(args.high);
  const val = convert(args.value);

  let formatted: string | null = null;
  if (low != null && high != null) {
    formatted =
      low === high
        ? formatDisplayValue(low)
        : `${formatDisplayValue(low)}–${formatDisplayValue(high)}`;
  } else if (low != null) {
    formatted = `≥ ${formatDisplayValue(low)}`;
  } else if (high != null) {
    formatted = `≤ ${formatDisplayValue(high)}`;
  } else if (val != null) {
    formatted = formatDisplayValue(val);
  }
  if (formatted === null) return null;
  return { unit: preferred, formatted };
}

/**
 * Build the tooltip rows for a concentration whose prose display uses
 * `displayUnit`. Lists every other relevant unit — the user's enabled units
 * plus the authored `sourceUnit` itself when it differs from what's on screen
 * (so the original figures stay visible once they've been converted out of the
 * prose) — while excluding `displayUnit`. Each row formats both endpoints (or
 * just `value`) in the same target unit so a tooltip can render `12.3–45.6 mg/L`
 * style lines, deduplicating rows whose formatted output equals an earlier
 * entry (numerically equivalent units like µg/mL ≡ mg/L collapse to one row).
 *
 * When `displayUnit === sourceUnit` this is exactly the classic
 * alternative-unit list.
 */
export function getConversionTooltipRows(
  args: {
    value?: number | null;
    low?: number | null;
    high?: number | null;
  },
  sourceUnit: string | null | undefined,
  displayUnit: string | null | undefined,
  molecularWeight: number | null | undefined,
  enabledUnits?: readonly string[] | null,
): AlternativeRange[] {
  const { value, low, high } = args;
  const source = asConcUnit(sourceUnit);
  if (!source) return [];
  const display = asTargetUnit(displayUnit) ?? source;

  // Ordered, de-duplicated target list. The authored unit comes first when it
  // isn't the one on display; the user's enabled units follow. The unit shown
  // in prose is skipped entirely.
  const targets: DisplayConcentrationUnit[] = [];
  const queued = new Set<string>();
  const queue = (unit: DisplayConcentrationUnit) => {
    if (unit === display || queued.has(unit)) return;
    queued.add(unit);
    targets.push(unit);
  };
  if (source !== display) queue(source);
  for (const unit of targetUnits(enabledUnits)) queue(unit);

  const out: AlternativeRange[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const convert = (v: number | null | undefined) => {
      if (v === null || v === undefined || !Number.isFinite(v)) return null;
      if (target === source) return v;
      return safeConvert(v, source, target, molecularWeight);
    };
    const fmt = target === source ? formatAuthoredValue : formatSignificant;

    const lowConv = convert(low);
    const highConv = convert(high);
    const valConv = convert(value);

    let formatted: string | null = null;
    if (lowConv != null && highConv != null) {
      // A degenerate range (low === high) is one figure; "0.854–0.854" is noise.
      // Compare the numbers, not the rounded labels: distinct bounds that round
      // alike are still a range.
      formatted =
        lowConv === highConv ? fmt(lowConv) : `${fmt(lowConv)}–${fmt(highConv)}`;
    } else if (lowConv != null) {
      formatted = `≥ ${fmt(lowConv)}`;
    } else if (highConv != null) {
      formatted = `≤ ${fmt(highConv)}`;
    } else if (valConv != null) {
      formatted = fmt(valConv);
    }

    if (!formatted || seen.has(formatted)) continue;
    seen.add(formatted);
    out.push({ unit: target, formatted, kind: kindOf(target) });
  }
  return out;
}

/**
 * Build alternative-unit display strings for a value or low–high range. Thin
 * wrapper over {@link getConversionTooltipRows} for the common case where the
 * prose keeps the authored unit and the tooltip lists every *other* unit.
 */
export function getAlternativeUnitsForRange(
  args: {
    value?: number | null;
    low?: number | null;
    high?: number | null;
  },
  sourceUnit: string | null | undefined,
  molecularWeight: number | null | undefined,
  enabledUnits?: readonly string[] | null,
): AlternativeRange[] {
  return getConversionTooltipRows(
    args,
    sourceUnit,
    sourceUnit,
    molecularWeight,
    enabledUnits,
  );
}
