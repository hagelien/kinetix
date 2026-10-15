import { isQualifierOperator, type NumericRange } from '@/types';
import {
  formatPdNumber,
  MOLAR_DISPLAY_UNIT,
  normalizePdUnit,
} from '@/lib/pdComparison';
import { formatRange } from '@/lib/rangeUtils';
import type { EntityTargetLigand } from '@/lib/receptorTargets';

/**
 * Presentation logic for a bio entity's target-pharmacology collection: the
 * ligand table and the activity-grouped measurement plot. Pure and
 * React-free so the scientific rules are testable on their own.
 *
 * Everything here is read-side presentation. The stored interaction type,
 * species and measurement ranges are never rewritten — they are classified
 * for grouping, filtering and plotting only, and the table keeps showing the
 * originals.
 */

// ─── Activity grouping ───────────────────────────────────────────────────────

/** Presentation groups, in display order. */
export const ACTIVITY_GROUPS = [
  'agonist',
  'partial_agonist',
  'inverse_agonist',
  'antagonist',
  'positive_allosteric_modulator',
  'negative_allosteric_modulator',
  'inhibitor',
  'other',
] as const;
export type ActivityGroup = (typeof ACTIVITY_GROUPS)[number];

/**
 * The explicit alias table. Deliberately short: a term that is not listed
 * goes to "other" with its label intact rather than being guessed into a
 * group by substring (a "biased agonist" is not silently an agonist).
 */
const ACTIVITY_ALIASES: Record<string, ActivityGroup> = {
  agonist: 'agonist',
  full_agonist: 'agonist',
  partial_agonist: 'partial_agonist',
  inverse_agonist: 'inverse_agonist',
  antagonist: 'antagonist',
  competitive_antagonist: 'antagonist',
  noncompetitive_antagonist: 'antagonist',
  non_competitive_antagonist: 'antagonist',
  uncompetitive_antagonist: 'antagonist',
  neutral_antagonist: 'antagonist',
  positive_allosteric_modulator: 'positive_allosteric_modulator',
  pam: 'positive_allosteric_modulator',
  negative_allosteric_modulator: 'negative_allosteric_modulator',
  nam: 'negative_allosteric_modulator',
  inhibitor: 'inhibitor',
  blocker: 'inhibitor',
  enzyme_inhibitor: 'inhibitor',
  reuptake_inhibitor: 'inhibitor',
  channel_blocker: 'inhibitor',
};

/** Trim, lowercase, and fold spaces/hyphens onto underscores. */
export function interactionTypeKey(value: string | null | undefined): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '_');
}

export interface NormalizedInteraction {
  group: ActivityGroup;
  /** The stored value, cosmetically formatted (separators → spaces). */
  label: string;
}

export function normalizeInteractionType(
  value: string | null | undefined,
): NormalizedInteraction {
  const key = interactionTypeKey(value);
  return {
    group: ACTIVITY_ALIASES[key] ?? 'other',
    label: (value ?? '').trim().replace(/[_\s]+/g, ' '),
  };
}

// ─── Assay species ───────────────────────────────────────────────────────────

export const SPECIES_CLASSES = ['human', 'non_human', 'unstated'] as const;
export type SpeciesClass = (typeof SPECIES_CLASSES)[number];
export type SpeciesFilter = 'all' | SpeciesClass;

/**
 * A negated "human": "non-human", "nonhuman", "non human", "not human",
 * "non‑human" (any hyphen or dash). Matched before the positive test, because
 * the word "human" inside one would otherwise read as a human assay.
 */
const NEGATED_HUMAN = /\b(?:non|not)[\s_\u2010-\u2015-]*human/;

/**
 * Conservative read-time classification of `assaySpecies`. Blank is
 * unstated — never human. Only an explicit "Homo sapiens" or the standalone
 * word "human" counts as human, so "recombinant human (HEK293)" is human while
 * a bare "HEK293" is not assumed to carry a human receptor construct. A label
 * that negates "human" anywhere ("non-human primate", "nonhuman tissue") is
 * explicitly animal evidence and is never classified as human.
 */
export function classifyAssaySpecies(
  value: string | null | undefined,
): SpeciesClass {
  const normalized = (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return 'unstated';
  if (NEGATED_HUMAN.test(normalized)) return 'non_human';
  if (normalized.includes('homo sapiens') || /\bhuman\b/.test(normalized)) {
    return 'human';
  }
  return 'non_human';
}

export function filterLigandsBySpecies(
  ligands: readonly EntityTargetLigand[],
  filter: SpeciesFilter,
): EntityTargetLigand[] {
  if (filter === 'all') return [...ligands];
  return ligands.filter((l) => classifyAssaySpecies(l.assaySpecies) === filter);
}

export function countLigandsBySpecies(
  ligands: readonly EntityTargetLigand[],
): Record<SpeciesFilter, number> {
  const counts: Record<SpeciesFilter, number> = {
    all: ligands.length,
    human: 0,
    non_human: 0,
    unstated: 0,
  };
  for (const ligand of ligands) {
    counts[classifyAssaySpecies(ligand.assaySpecies)] += 1;
  }
  return counts;
}

// ─── Representative value ────────────────────────────────────────────────────

export interface RangeScalar {
  /** The single value a plot positions the range at. */
  value: number;
  /**
   * False for a one-sided bound — a `<`/`>`/`≤`/`≥` qualifier, or a range
   * carrying only `min` or only `max`. Such a value is a limit, not a point,
   * and must not be drawn as an exact measurement.
   */
  exact: boolean;
  /** The two-sided span, when both bounds are stored. */
  low: number | null;
  high: number | null;
  /**
   * True when `value` is the min/max midpoint rather than a stored median or
   * mean. It positions a point but was never reported, so it must not be
   * displayed as if it were the measurement — show the range instead.
   */
  fromBounds: boolean;
}

const finite = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n);

/**
 * The project's scalar preference for a `NumericRange`: median, then mean,
 * then the min/max midpoint, then whichever single bound exists.
 */
export function rangeScalar(
  range: NumericRange | null | undefined,
): RangeScalar | null {
  if (!range) return null;
  const qualified = isQualifierOperator(range.qualifier);
  const hasMin = finite(range.min);
  const hasMax = finite(range.max);
  const low = hasMin && hasMax ? range.min! : null;
  const high = hasMin && hasMax ? range.max! : null;
  if (finite(range.median)) {
    return { value: range.median, exact: !qualified, low, high, fromBounds: false };
  }
  if (finite(range.mean)) {
    return { value: range.mean, exact: !qualified, low, high, fromBounds: false };
  }
  if (hasMin && hasMax) {
    return {
      value: (range.min! + range.max!) / 2,
      exact: !qualified,
      low,
      high,
      fromBounds: true,
    };
  }
  const oneSided = { exact: false, low: null, high: null, fromBounds: true };
  if (hasMin) return { value: range.min!, ...oneSided };
  if (hasMax) return { value: range.max!, ...oneSided };
  return null;
}

// ─── Display ─────────────────────────────────────────────────────────────────

/**
 * A stored measurement as the table shows it: in its own unit, with a range
 * kept as a range. Unlike the shared `formatRange`, a comparison qualifier is
 * kept even when the range has no central value — `{ max: 10, qualifier: '<' }`
 * reads "< 10 nM", not "≤10 nM", and a qualified min–max span keeps its
 * operator — so a strict bound is never shown as an inclusive one or dropped.
 */
export function formatMeasurement(range: NumericRange | null | undefined): string {
  if (!range) return '';
  const { qualifier, unit } = range;
  const hasCentral = finite(range.median) || finite(range.mean);
  if (isQualifierOperator(qualifier) && !hasCentral) {
    const hasMin = finite(range.min);
    const hasMax = finite(range.max);
    if (hasMin && hasMax && range.min !== range.max) {
      return `${qualifier} ${formatRange({ min: range.min, max: range.max, unit }, { showNote: false })}`;
    }
    const bound = hasMin ? range.min : hasMax ? range.max : undefined;
    if (bound !== undefined) {
      return formatRange({ median: bound, qualifier, unit }, { showNote: false });
    }
  }
  return formatRange(range, { showNote: false });
}

// ─── Units ───────────────────────────────────────────────────────────────────

export const CONCENTRATION_DISPLAY_UNIT = MOLAR_DISPLAY_UNIT;

/**
 * Factor converting a molar concentration unit (M, mM, µM/uM, nM, pM, and the
 * mol/L spellings) to nM, or null when the unit is not a molar concentration.
 */
export function nanomolarFactor(unit: string | null | undefined): number | null {
  const normalized = normalizePdUnit(unit);
  return normalized.unit === MOLAR_DISPLAY_UNIT ? normalized.factor : null;
}

/** A molar value converted to nM; null for any other unit. */
export function toNanomolar(
  value: number,
  unit: string | null | undefined,
): number | null {
  const factor = nanomolarFactor(unit);
  return factor === null ? null : value * factor;
}

/**
 * The common scale a stored unit folds onto, with the factor its numbers must
 * be multiplied by to be expressed on that scale: molar units → nM, `%` /
 * `percent` → %, `fraction` → % (×100). Any other unit — including none — is
 * its own scale (factor 1) and is only comparable with itself.
 *
 * Every caller that groups values by `unit` must also scale them by
 * `factor`; folding the label without the number is how 1 mM ends up
 * positioned at "1 nM".
 */
export function comparableUnit(unit: string | null | undefined): {
  unit: string;
  factor: number;
} {
  const raw = (unit ?? '').trim();
  if (raw.toLowerCase() === 'fraction') return { unit: '%', factor: 100 };
  return normalizePdUnit(raw);
}

// ─── Metrics and the activity plot ───────────────────────────────────────────

/** Plot metrics, in selector order. One is shown at a time — never mixed. */
export const TARGET_METRICS = [
  'ki',
  'ec50',
  'ic50',
  'emax',
  'affinity',
  'potency',
  'efficacy',
] as const;
export type TargetMetric = (typeof TARGET_METRICS)[number];

/** Always concentrations: plotted on a log nM axis or not at all. */
const CONCENTRATION_METRICS: ReadonlySet<TargetMetric> = new Set([
  'ki',
  'ec50',
  'ic50',
]);
/** Concentrations when recorded in a molar unit, otherwise linear values. */
const MAYBE_CONCENTRATION_METRICS: ReadonlySet<TargetMetric> = new Set([
  'affinity',
  'potency',
]);

export type PlotOmissionReason =
  | 'one_sided'
  | 'unsupported_unit'
  | 'non_positive'
  | 'non_positive_bound'
  | 'non_finite'
  | 'heterogeneous_units';

/** How a measurement is placed on a common scale. */
export type MeasurementScale =
  /** Molar concentration in nM; must be strictly positive (log axis). */
  | 'concentration'
  /** Linear value on its {@link comparableUnit} scale; any finite number. */
  | 'linear';

/**
 * The verdict of {@link assessMeasurement}: either an exact value (with its
 * span) expressed on one common scale, or the reason it cannot be placed.
 */
export type MeasurementVerdict =
  | {
      ok: true;
      /** The common scale's unit (nM, %, or the stored unit). */
      unit: string;
      value: number;
      low: number | null;
      high: number | null;
      fromBounds: boolean;
    }
  | { ok: false; reason: PlotOmissionReason | 'missing' };

/**
 * THE single validity predicate for a stored measurement. Both the activity
 * plot and the table's sort keys use it, so a value is ranked exactly when
 * it is plotted, and for the same reasons when it is not:
 *
 * - no stored median, mean or bound (or only NaN/Infinity) → `missing`;
 * - a one-sided bound (min-only, max-only, or a `<`/`>`/`≤`/`≥` qualifier)
 *   → `one_sided` — a limit, never an exact value;
 * - `concentration`: a unit that is not molar → `unsupported_unit`; a value
 *   ≤ 0 → `non_positive`; a range bound ≤ 0 → `non_positive_bound`;
 * - a value that is not finite once scaled → `non_finite`.
 *
 * On success the value and its bounds are scaled onto the common unit — the
 * unit and the number always move together.
 */
export function assessMeasurement(
  range: NumericRange | null | undefined,
  scale: MeasurementScale,
): MeasurementVerdict {
  const scalar = rangeScalar(range);
  if (!range || !scalar) return { ok: false, reason: 'missing' };
  if (!scalar.exact) return { ok: false, reason: 'one_sided' };
  let unit: string;
  let factor: number;
  if (scale === 'concentration') {
    const nm = nanomolarFactor(range.unit);
    if (nm === null) return { ok: false, reason: 'unsupported_unit' };
    if (scalar.value <= 0) return { ok: false, reason: 'non_positive' };
    if (
      (scalar.low !== null && scalar.low <= 0) ||
      (scalar.high !== null && scalar.high <= 0)
    ) {
      return { ok: false, reason: 'non_positive_bound' };
    }
    unit = CONCENTRATION_DISPLAY_UNIT;
    factor = nm;
  } else {
    ({ unit, factor } = comparableUnit(range.unit));
  }
  const value = scalar.value * factor;
  const low = scalar.low === null ? null : scalar.low * factor;
  const high = scalar.high === null ? null : scalar.high * factor;
  if (![value, low ?? 0, high ?? 0].every(Number.isFinite)) {
    return { ok: false, reason: 'non_finite' };
  }
  return { ok: true, unit, value, low, high, fromBounds: scalar.fromBounds };
}

/**
 * Assess a whole column of measurements on one scale. On the linear scale
 * the valid values must also share ONE common unit; if they do not, none of
 * them is comparable and every one is `heterogeneous_units` (the plot is
 * disabled and the column does not rank, rather than pretending mixed units
 * line up). Concentrations always share nM.
 */
export function assessColumn(
  ranges: readonly (NumericRange | null | undefined)[],
  scale: MeasurementScale,
): MeasurementVerdict[] {
  const verdicts = ranges.map((r) => assessMeasurement(r, scale));
  if (scale === 'linear') {
    const units = new Set(verdicts.flatMap((v) => (v.ok ? [v.unit] : [])));
    if (units.size > 1) {
      return verdicts.map((v) =>
        v.ok ? { ok: false, reason: 'heterogeneous_units' as const } : v,
      );
    }
  }
  return verdicts;
}

export interface ActivityPlotPoint {
  ligand: EntityTargetLigand;
  group: ActivityGroup;
  /** Representative value in the plot's unit. */
  value: number;
  /** Two-sided span in the plot's unit, drawn as an error bar. */
  low: number | null;
  high: number | null;
  /** `value` is the midpoint of `low`–`high`, not a reported figure. */
  fromBounds: boolean;
}

/**
 * A plotted point's value in the plot's unit, as text. A stored median or mean
 * leads, with its range alongside; a value that is only the midpoint of a
 * range is shown as the range itself, never as a single number nobody
 * reported.
 */
export function formatPlotPointValue(point: ActivityPlotPoint, unit: string): string {
  const span =
    point.low !== null && point.high !== null && point.low !== point.high
      ? `${formatPdNumber(point.low, '')}–${formatPdNumber(point.high, unit)}`
      : null;
  if (point.fromBounds && span) return span;
  const central = formatPdNumber(point.value, unit);
  return span ? `${central} (${span})` : central;
}

export interface ActivityPlotGroup {
  group: ActivityGroup;
  points: ActivityPlotPoint[];
}

export interface ActivityPlot {
  metric: TargetMetric;
  scale: 'log' | 'linear';
  /** The common unit every point is expressed in ('' when unitless). */
  unit: string;
  groups: ActivityPlotGroup[];
  /** Rows that carry a value for the metric but cannot be plotted. */
  omitted: { ligand: EntityTargetLigand; reason: PlotOmissionReason }[];
  pointCount: number;
}

function groupPoints(
  points: ActivityPlotPoint[],
  ascending: boolean,
): ActivityPlotGroup[] {
  return ACTIVITY_GROUPS.map((group) => ({
    group,
    points: points
      .filter((p) => p.group === group)
      .sort((a, b) => (ascending ? a.value - b.value : b.value - a.value)),
  })).filter((g) => g.points.length > 0);
}

/**
 * The scale a plot metric uses for these ligands: Ki/EC50/IC50 are always
 * concentrations; affinity/potency are when any of them is recorded in a
 * molar unit; Emax/efficacy (and non-molar affinity/potency) are linear.
 */
export function metricScale(
  ligands: readonly EntityTargetLigand[],
  metric: TargetMetric,
): MeasurementScale {
  if (CONCENTRATION_METRICS.has(metric)) return 'concentration';
  if (
    MAYBE_CONCENTRATION_METRICS.has(metric) &&
    ligands.some((l) => nanomolarFactor(l[metric]?.unit) !== null)
  ) {
    return 'concentration';
  }
  return 'linear';
}

/**
 * Derive the activity-grouped plot for one metric. Which rows are plotted —
 * and why the others are not — is decided entirely by {@link assessColumn}:
 * concentrations go on a log nM axis, everything else on a linear axis in
 * one common unit. Rows without any value are neither plotted nor listed;
 * every other non-plottable row stays in the table and is listed as omitted.
 *
 * Within each activity group, concentration points run smallest first;
 * linear points largest first.
 */
export function buildActivityPlot(
  ligands: readonly EntityTargetLigand[],
  metric: TargetMetric,
): ActivityPlot {
  const scale = metricScale(ligands, metric);
  const verdicts = assessColumn(
    ligands.map((l) => l[metric]),
    scale,
  );
  const omitted: ActivityPlot['omitted'] = [];
  const points: ActivityPlotPoint[] = [];
  let unit = scale === 'concentration' ? CONCENTRATION_DISPLAY_UNIT : '';
  ligands.forEach((ligand, i) => {
    const verdict = verdicts[i]!;
    if (!verdict.ok) {
      if (verdict.reason !== 'missing') {
        omitted.push({ ligand, reason: verdict.reason });
      }
      return;
    }
    unit = verdict.unit;
    points.push({
      ligand,
      group: normalizeInteractionType(ligand.interactionType).group,
      value: verdict.value,
      low: verdict.low,
      high: verdict.high,
      fromBounds: verdict.fromBounds,
    });
  });
  return {
    metric,
    scale: scale === 'concentration' ? 'log' : 'linear',
    unit,
    groups: groupPoints(points, scale === 'concentration'),
    omitted,
    pointCount: points.length,
  };
}

/** Metrics with at least one plottable value among `ligands`, in selector order. */
export function plottableMetrics(
  ligands: readonly EntityTargetLigand[],
): TargetMetric[] {
  return TARGET_METRICS.filter(
    (metric) => buildActivityPlot(ligands, metric).pointCount > 0,
  );
}

export interface MetricOmissions {
  metric: TargetMetric;
  omitted: ActivityPlot['omitted'];
}

/**
 * Per metric, in selector order, the recorded values among `ligands` that
 * cannot be plotted and why — for every metric that has any, whether or not
 * the metric itself is plottable. Lets the panel explain what was left out
 * even when no metric has a single plottable point (so there is no plot,
 * and no selected metric, to report against). The reasons are exactly those
 * {@link buildActivityPlot} gives, i.e. {@link assessColumn}'s verdicts.
 */
export function metricOmissions(
  ligands: readonly EntityTargetLigand[],
): MetricOmissions[] {
  return TARGET_METRICS.map((metric) => ({
    metric,
    omitted: buildActivityPlot(ligands, metric).omitted,
  })).filter((m) => m.omitted.length > 0);
}

/** The distinct reasons among omitted rows, in first-seen order. */
export function omissionReasons(
  omitted: ActivityPlot['omitted'],
): PlotOmissionReason[] {
  return [...new Set(omitted.map((o) => o.reason))];
}

/**
 * The metric to show: the reader's choice while it stays plottable, else Ki
 * when available (the most direct binding-affinity measure), else the first
 * available in selector order. Null when nothing is plottable.
 */
export function resolvePlotMetric(
  available: readonly TargetMetric[],
  selected: TargetMetric | null,
): TargetMetric | null {
  if (selected && available.includes(selected)) return selected;
  return available[0] ?? null;
}

// ─── Table sorting ───────────────────────────────────────────────────────────

export type LigandSortKey = 'default' | 'drug' | 'activity' | 'ki' | 'ec50' | 'ic50' | 'emax';

/**
 * Sort key for a Ki, EC50 or IC50 cell: its nM value when
 * {@link assessMeasurement} accepts it as a concentration — exactly the rows
 * the plot draws — otherwise null (unsortable).
 */
export function measurementSortValue(
  range: NumericRange | null | undefined,
): number | null {
  const verdict = assessMeasurement(range, 'concentration');
  return verdict.ok ? verdict.value : null;
}

/**
 * The value the combined "Emax / efficacy" column shows first: Emax when it
 * carries a reading, otherwise efficacy.
 */
export function emaxOrEfficacy(ligand: EntityTargetLigand): NumericRange | null {
  return rangeScalar(ligand.emax) ? ligand.emax : ligand.efficacy;
}

/**
 * Sort keys for the combined Emax / efficacy column, through the same
 * {@link assessColumn} rule as the linear plot: exact values in one common
 * unit rank; anything else (missing, one-sided, non-finite, or a column whose
 * units do not fold onto one scale) is unsortable.
 */
function efficacySortValues(
  ligands: readonly EntityTargetLigand[],
): Map<EntityTargetLigand, number | null> {
  const verdicts = assessColumn(ligands.map(emaxOrEfficacy), 'linear');
  return new Map(
    ligands.map((l, i) => {
      const v = verdicts[i]!;
      return [l, v.ok ? v.value : null];
    }),
  );
}

/**
 * Sort a ligand list for the table. `default` keeps the server's stable
 * order. Rows the shared {@link assessMeasurement} predicate rejects for the
 * sorted column — the same rows the plot omits — always go last, in either
 * direction and in their original order, so they never crowd out, or get
 * ranked against, the comparable ones.
 */
export function sortLigands(
  ligands: readonly EntityTargetLigand[],
  key: LigandSortKey,
  direction: 'asc' | 'desc',
  drugName: (ligand: EntityTargetLigand) => string,
): EntityTargetLigand[] {
  const rows = [...ligands];
  if (key === 'default') return rows;
  const sign = direction === 'asc' ? 1 : -1;
  if (key === 'drug') {
    return rows.sort((a, b) => sign * drugName(a).localeCompare(drugName(b)));
  }
  if (key === 'activity') {
    return rows.sort((a, b) => {
      const na = normalizeInteractionType(a.interactionType);
      const nb = normalizeInteractionType(b.interactionType);
      const byGroup =
        ACTIVITY_GROUPS.indexOf(na.group) - ACTIVITY_GROUPS.indexOf(nb.group);
      return sign * (byGroup || na.label.localeCompare(nb.label));
    });
  }
  const values =
    key === 'emax'
      ? efficacySortValues(rows)
      : new Map(rows.map((l) => [l, measurementSortValue(l[key])]));
  return rows.sort((a, b) => {
    const va = values.get(a) ?? null;
    const vb = values.get(b) ?? null;
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return sign * (va - vb);
  });
}
