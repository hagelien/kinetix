import { isQualifierOperator, type NumericRange } from '@/types';
import { MOLAR_DISPLAY_UNIT, normalizePdUnit } from '@/lib/pdComparison';
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
 * Conservative read-time classification of `assaySpecies`. Blank is
 * unstated — never human. Only an explicit "Homo sapiens" or the standalone
 * word "human" counts as human, so "recombinant human (HEK293)" is human while
 * a bare "HEK293" is not assumed to carry a human receptor construct.
 */
export function classifyAssaySpecies(
  value: string | null | undefined,
): SpeciesClass {
  const normalized = (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) return 'unstated';
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
    return { value: range.median, exact: !qualified, low, high };
  }
  if (finite(range.mean)) {
    return { value: range.mean, exact: !qualified, low, high };
  }
  if (hasMin && hasMax) {
    return {
      value: (range.min! + range.max!) / 2,
      exact: !qualified,
      low,
      high,
    };
  }
  if (hasMin) return { value: range.min!, exact: false, low: null, high: null };
  if (hasMax) return { value: range.max!, exact: false, low: null, high: null };
  return null;
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
  | 'heterogeneous_units';

export interface ActivityPlotPoint {
  ligand: EntityTargetLigand;
  group: ActivityGroup;
  /** Representative value in the plot's unit. */
  value: number;
  /** Two-sided span in the plot's unit, drawn as an error bar. */
  low: number | null;
  high: number | null;
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
 * other unit, a one-sided bound, or a non-positive value stays in the table
 * but is listed as omitted. Non-concentration metrics (Emax, efficacy, and
 * affinity/potency recorded without a molar unit) use a linear axis in the
 * stored unit — and only when every value shares that unit; mixed units
 * disable the plot rather than pretending the numbers are comparable.
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
      } else {
        const low = scalar.low !== null && scalar.low > 0 ? scalar.low * factor : null;
        const high = scalar.high !== null && low !== null ? scalar.high * factor : null;
        points.push({
          ligand,
          group: normalizeInteractionType(ligand.interactionType).group,
          value: scalar.value * factor,
          low,
          high,
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

  const units = new Set(measured.map((m) => normalizePdUnit(m.range.unit).unit));
  if (units.size > 1) {
    return {
      metric,
      scale: 'linear',
      unit: '',
      groups: [],
      omitted: measured.map(({ ligand }) => ({
        ligand,
        reason: 'heterogeneous_units' as const,
      })),
      pointCount: 0,
    };
  }
  for (const { ligand, scalar } of measured) {
    if (!scalar.exact) {
      omitted.push({ ligand, reason: 'one_sided' });
      continue;
    }
    points.push({
      ligand,
      group: normalizeInteractionType(ligand.interactionType).group,
      value: scalar.value,
      low: scalar.low,
      high: scalar.high,
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
 * A comparable number for a measurement column: the representative scalar,
 * converted to nM when the unit is molar so 1 µM sorts after 50 nM.
 */
export function measurementSortValue(
  range: NumericRange | null | undefined,
): number | null {
  const scalar = rangeScalar(range);
  if (!scalar) return null;
  return toNanomolar(scalar.value, range?.unit) ?? scalar.value;
}

/**
 * Sort a ligand list for the table. `default` keeps the server's stable
 * order. Rows without a value for the sorted measurement always go last, in
 * either direction, so the qualitative rows never crowd out the measured ones.
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
  return rows.sort((a, b) => {
    const va = measurementSortValue(a[key]);
    const vb = measurementSortValue(b[key]);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return sign * (va - vb);
  });
}
