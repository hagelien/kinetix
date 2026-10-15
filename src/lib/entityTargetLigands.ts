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
  | 'heterogeneous_units';

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
 * Derive the activity-grouped plot for one metric.
 *
 * Concentration metrics are converted to nM on a log axis; a value in any
 * other unit, a one-sided bound, a non-positive value, or a range reaching
 * zero or below stays in the table but is listed as omitted. Non-concentration metrics (Emax, efficacy, and
 * affinity/potency recorded without a molar unit) use a linear axis on one
 * common scale (see {@link comparableUnit}; values and bounds are scaled onto
 * it) — and only when every exact value folds onto that scale; mixed units
 * disable the plot rather than pretending the numbers are comparable.
 * One-sided bounds are never plotted as points on either axis.
 *
 * Within each activity group, concentration points run smallest first;
 * linear points largest first.
 */
export function buildActivityPlot(
  ligands: readonly EntityTargetLigand[],
  metric: TargetMetric,
): ActivityPlot {
  const measured = ligands
    .map((ligand) => ({ ligand, range: ligand[metric], scalar: rangeScalar(ligand[metric]) }))
    .filter(
      (m): m is { ligand: EntityTargetLigand; range: NumericRange; scalar: RangeScalar } =>
        m.range !== null && m.scalar !== null,
    );
  const omitted: ActivityPlot['omitted'] = [];
  const points: ActivityPlotPoint[] = [];

  const logScale =
    CONCENTRATION_METRICS.has(metric) ||
    (MAYBE_CONCENTRATION_METRICS.has(metric) &&
      measured.some((m) => nanomolarFactor(m.range.unit) !== null));

  if (logScale) {
    for (const { ligand, range, scalar } of measured) {
      const factor = nanomolarFactor(range.unit);
      if (factor === null) {
        omitted.push({ ligand, reason: 'unsupported_unit' });
      } else if (!scalar.exact) {
        omitted.push({ ligand, reason: 'one_sided' });
      } else if (scalar.value <= 0) {
        omitted.push({ ligand, reason: 'non_positive' });
      } else if (
        (scalar.low !== null && scalar.low <= 0) ||
        (scalar.high !== null && scalar.high <= 0)
      ) {
        // A log axis cannot show a range that reaches zero or below. Dropping
        // just the bounds would draw the midpoint as an exact value, so the
        // whole measurement stays in the table instead.
        omitted.push({ ligand, reason: 'non_positive_bound' });
      } else {
        points.push({
          ligand,
          group: normalizeInteractionType(ligand.interactionType).group,
          value: scalar.value * factor,
          low: scalar.low === null ? null : scalar.low * factor,
          high: scalar.high === null ? null : scalar.high * factor,
          fromBounds: scalar.fromBounds,
        });
      }
    }
    return {
      metric,
      scale: 'log',
      unit: CONCENTRATION_DISPLAY_UNIT,
      groups: groupPoints(points, true),
      omitted,
      pointCount: points.length,
    };
  }

  // One-sided bounds are never plotted, so they neither join nor break the
  // unit check; compatible units are folded AND scaled onto one scale.
  const exact = measured.filter((m) => m.scalar.exact);
  for (const { ligand } of measured.filter((m) => !m.scalar.exact)) {
    omitted.push({ ligand, reason: 'one_sided' });
  }
  const units = new Set(exact.map((m) => comparableUnit(m.range.unit).unit));
  if (units.size > 1) {
    return {
      metric,
      scale: 'linear',
      unit: '',
      groups: [],
      omitted: [
        ...exact.map(({ ligand }) => ({
          ligand,
          reason: 'heterogeneous_units' as const,
        })),
        ...omitted,
      ],
      pointCount: 0,
    };
  }
  for (const { ligand, range, scalar } of exact) {
    const { factor } = comparableUnit(range.unit);
    points.push({
      ligand,
      group: normalizeInteractionType(ligand.interactionType).group,
      value: scalar.value * factor,
      low: scalar.low === null ? null : scalar.low * factor,
      high: scalar.high === null ? null : scalar.high * factor,
      fromBounds: scalar.fromBounds,
    });
  }
  return {
    metric,
    scale: 'linear',
    unit: [...units][0] ?? '',
    groups: groupPoints(points, false),
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
 * A comparable number for a Ki, EC50 or IC50 column, or null when the value
 * cannot be ranked against the others.
 *
 * These are concentrations: they rank in nM (so 1 µM sorts after 50 nM), and
 * a value in any other unit — a mass concentration such as ng/mL, a
 * free-text unit, none at all — has no molar position, so it is treated as
 * unsortable rather than compared as a raw number against nM values.
 * Ranking 2.4 ng/mL beside 0.2 nM would assert a molar-vs-mass potency order
 * the data does not support. Such rows stay in the table and sort with the
 * rows that have no value. So does a one-sided bound, which is a limit rather
 * than a value that can be ranked.
 */
export function measurementSortValue(
  range: NumericRange | null | undefined,
): number | null {
  const scalar = rangeScalar(range);
  // A one-sided bound (min-only, max-only, or `<`/`>`/`≤`/`≥`) is a limit,
  // not a value: it has no exact rank among the measured ones.
  if (!scalar || !scalar.exact) return null;
  return toNanomolar(scalar.value, range?.unit);
}

/**
 * The value the combined "Emax / efficacy" column shows first: Emax when it
 * carries a reading, otherwise efficacy.
 */
export function emaxOrEfficacy(ligand: EntityTargetLigand): NumericRange | null {
  return rangeScalar(ligand.emax) ? ligand.emax : ligand.efficacy;
}

/**
 * A unit-tagged value for comparing Emax/efficacy readings, on the scale of
 * {@link comparableUnit}; null for a missing value or a one-sided bound.
 */
export function efficacyComparable(
  range: NumericRange | null | undefined,
): { unit: string; value: number } | null {
  const scalar = rangeScalar(range);
  // One-sided bounds are limits, not rankable values.
  if (!scalar || !scalar.exact) return null;
  const { unit, factor } = comparableUnit(range?.unit);
  return { unit, value: scalar.value * factor };
}

/**
 * Sort keys for the combined Emax / efficacy column. Values are ranked only
 * within one common unit — the unit most rows share once compatible units
 * are folded together (ties: the first such row's unit). A value in any other
 * unit cannot be ranked against them (0.9 "fraction" is 90%, not below 60%;
 * a.u. is not a percentage at all), so it is unsortable, like a missing one.
 */
function efficacySortValues(
  ligands: readonly EntityTargetLigand[],
): Map<EntityTargetLigand, number | null> {
  const comparable = ligands.map((l) => [l, efficacyComparable(emaxOrEfficacy(l))] as const);
  const counts = new Map<string, number>();
  for (const [, c] of comparable) {
    if (c) counts.set(c.unit, (counts.get(c.unit) ?? 0) + 1);
  }
  let common: string | null = null;
  for (const [unit, n] of counts) {
    if (common === null || n > counts.get(common)!) common = unit;
  }
  return new Map(
    comparable.map(([l, c]) => [l, c && c.unit === common ? c.value : null]),
  );
}

/**
 * Sort a ligand list for the table. `default` keeps the server's stable
 * order. Rows without a sortable value for the sorted measurement (none
 * recorded, a one-sided bound, a Ki/EC50/IC50 not in a molar unit, or an
 * Emax/efficacy outside the column's common unit) always go last, in either direction and in their
 * original order, so they never crowd out — or get ranked against — the
 * comparable ones.
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
