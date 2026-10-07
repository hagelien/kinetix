/**
 * Postmortem concentration distributions — the shared domain layer.
 *
 * A distribution is one cohort's order statistics for one analyte in one
 * matrix: how often a concentration is actually seen at autopsy. That is a
 * different claim from every interpretive concentration Kinetix already holds.
 * `therapeuticConcentration` and friends say what a concentration MEANS;
 * these percentiles say what gets MEASURED, in material that carries no link
 * to cause of death. The two must never be read as the same kind of line, so
 * they never share a store, a pool, or a label.
 *
 * Everything here is pure: the API serves stored rows, the chart and the
 * monograph table render them, and the conversion arithmetic in between lives
 * in one place so a percentile on a chart and the same percentile in a table
 * can never disagree.
 */
import {
  convertToDisplayUnit,
  isConcentrationUnit,
  isEthanolDisplayUnit,
  type ConcentrationUnit,
  type DisplayConcentrationUnit,
} from './unitConversion.js';
import {
  bloodPlasmaFactorOrNull,
  convertToDisplayMatrix,
  isBloodLikeMatrix,
  matrixConversionApplies,
  type ChartMatrix,
} from './matrixDisplay.js';
import type { NumericRange } from '@/types';

/** The statistics a distribution can carry, in display order. */
export const PM_STATISTIC_IDS = [
  'loq',
  'mean',
  'median',
  'p90',
  'p95',
  'p975',
] as const;

export type PmStatisticId = (typeof PM_STATISTIC_IDS)[number];

export interface PmStatisticMeta {
  id: PmStatisticId;
  /** i18n key under `pmConcentrations.statistic`. */
  i18nKey: string;
  /**
   * Dash pattern for this statistic's chart line. Chosen to stay legible
   * against the interpretive lines already on the chart, which use `dot`
   * (therapeutic) and `dash` (toxic/lethal): the percentile ladder uses
   * `longdash`/`dashdot` variants so a reader never mistakes a 97.5th
   * percentile for a lethal threshold at a glance.
   */
  dash: 'solid' | 'dot' | 'dash' | 'longdash' | 'dashdot' | 'longdashdot';
  /**
   * Whether this line is drawn before the reader touches anything. Median and
   * the 90th percentile are on: together they say "typical finding" and "high
   * but ordinary finding", which is the pair that orients a case. The upper
   * percentiles and the mean are opt-in — a skewed distribution's mean sits
   * above its 90th percentile often enough that showing it unasked misleads.
   */
  defaultVisible: boolean;
}

export const PM_STATISTICS: readonly PmStatisticMeta[] = [
  {
    id: 'loq',
    i18nKey: 'pmConcentrations.statistic.loq',
    dash: 'dot',
    defaultVisible: false,
  },
  {
    id: 'mean',
    i18nKey: 'pmConcentrations.statistic.mean',
    dash: 'dashdot',
    defaultVisible: false,
  },
  {
    id: 'median',
    i18nKey: 'pmConcentrations.statistic.median',
    dash: 'longdash',
    defaultVisible: true,
  },
  {
    id: 'p90',
    i18nKey: 'pmConcentrations.statistic.p90',
    dash: 'longdash',
    defaultVisible: true,
  },
  {
    id: 'p95',
    i18nKey: 'pmConcentrations.statistic.p95',
    dash: 'longdash',
    defaultVisible: false,
  },
  {
    id: 'p975',
    i18nKey: 'pmConcentrations.statistic.p975',
    dash: 'longdash',
    defaultVisible: false,
  },
];

const STATISTIC_BY_ID = new Map(PM_STATISTICS.map((s) => [s.id, s]));

/** One cohort's metadata, as served to the client. */
export interface PmConcentrationSourceInfo {
  key: string;
  citation: string;
  shortLabel: string;
  heading: string;
  matrix: string;
  unit: string;
  description: string;
  caveats: string[];
}

/** One analyte's distribution within a cohort, in the source's own unit. */
export interface PmDistribution {
  sourceKey: string;
  drugId: number;
  pubchemCid: number | null;
  analyte: string;
  n: number;
  loq: number | null;
  mean: number | null;
  median: number | null;
  p90: number | null;
  p95: number | null;
  p975: number | null;
  tcPlasma: number | null;
  medianOverTc: number | null;
  anomaly: string | null;
  /** Statistics that must not be drawn (see `anomaly`). */
  undrawable: PmStatisticId[];
  reviewNote: string | null;
  /**
   * Exact source strings for values a float cannot reproduce, keyed by column
   * (`{ p95: '0.20' }`). Display only — every calculation uses the numbers.
   */
  printed: Record<string, string>;
}

export interface PmDistributionPayload {
  sources: PmConcentrationSourceInfo[];
  distributions: PmDistribution[];
}

export interface PmLineSettings {
  /** Master switch for the whole overlay. */
  enabled: boolean;
  /** Which statistics are drawn. */
  statistics: Record<PmStatisticId, boolean>;
}

export const DEFAULT_PM_LINE_SETTINGS: PmLineSettings = {
  enabled: true,
  statistics: PM_STATISTICS.reduce(
    (acc, s) => {
      acc[s.id] = s.defaultVisible;
      return acc;
    },
    {} as Record<PmStatisticId, boolean>,
  ),
};

/**
 * Merge a stored settings blob with the defaults.
 *
 * Persisted preferences outlive the code that wrote them: a statistic added in
 * a later release is absent from a blob written today, and a statistic removed
 * in a later release lingers in one. Both are resolved against the current
 * registry so a stale blob can neither hide a new line nor resurrect a dead
 * one.
 */
export function normalizePmLineSettings(
  stored: unknown,
  fallback: PmLineSettings = DEFAULT_PM_LINE_SETTINGS,
): PmLineSettings {
  const raw = (stored ?? {}) as Partial<PmLineSettings>;
  const statistics = {} as Record<PmStatisticId, boolean>;
  for (const stat of PM_STATISTICS) {
    const value = (raw.statistics as Record<string, unknown> | undefined)?.[
      stat.id
    ];
    statistics[stat.id] =
      typeof value === 'boolean' ? value : fallback.statistics[stat.id];
  }
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    statistics,
  };
}

export function pmStatisticValue(
  distribution: PmDistribution,
  statistic: PmStatisticId,
): number | null {
  return distribution[statistic];
}

/** Whether a statistic may be drawn for this row (see `undrawable`). */
export function isPmStatisticDrawable(
  distribution: PmDistribution,
  statistic: PmStatisticId,
): boolean {
  return !distribution.undrawable.includes(statistic);
}

/** Whether this cohort's matrix is blood-like (what a plasma view transforms). */
export function pmMatrixIsBlood(sourceMatrix: string): boolean {
  return isBloodLikeMatrix(sourceMatrix);
}

/**
 * Whether the drug has a blood:plasma ratio a non-whole-blood view could use.
 *
 * Exported so a caller can test THIS specifically rather than inferring it from
 * `convertPmValue` returning null — that null has several causes, and a message
 * naming the missing B/P ratio must be shown only when the ratio is what is
 * actually missing.
 */
export function pmHasUsableBloodPlasmaRatio(
  bloodPlasmaRatio: NumericRange | number | null | undefined,
): boolean {
  return bloodPlasmaFactorOrNull(bloodPlasmaRatio) != null;
}

export interface PmConversionContext {
  /** Unit the chart or table is displaying. */
  targetUnit: string;
  /** Unit the cohort's numbers are stored in (from the source row). */
  sourceUnit: string;
  /** Matrix the cohort's numbers are in (from the source row). */
  sourceMatrix: string;
  /** Matrix the chart is displaying — the cohort is converted toward it. */
  displayMatrix: ChartMatrix;
  molecularWeight?: number | null;
  bloodPlasmaRatio?: NumericRange | number | null;
}

/**
 * Convert one stored figure into the display matrix + unit.
 *
 * Returns `null` rather than an approximation whenever the conversion is not
 * defined: a molar target unit without a molecular weight, or a blood/plasma
 * crossing on a drug with no blood:plasma ratio. A missing line is recoverable;
 * a line drawn at a wrong height is read as fact.
 */
export function convertPmValue(
  value: number | null,
  ctx: PmConversionContext,
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (!isConcentrationUnit(ctx.sourceUnit)) return null;
  // The target may also be an ethanol display unit (‰, %); the source never is.
  if (
    !isConcentrationUnit(ctx.targetUnit) &&
    !isEthanolDisplayUnit(ctx.targetUnit)
  ) {
    return null;
  }

  const inMatrix = convertToDisplayMatrix(
    value,
    ctx.sourceMatrix,
    ctx.displayMatrix,
    bloodPlasmaFactorOrNull(ctx.bloodPlasmaRatio),
  );
  if (inMatrix == null) return null;

  try {
    return convertToDisplayUnit(
      inMatrix,
      ctx.sourceUnit as ConcentrationUnit,
      ctx.targetUnit as DisplayConcentrationUnit,
      ctx.molecularWeight ?? undefined,
    );
  } catch {
    return null;
  }
}

export interface PmChartLine {
  seriesId: string;
  statistic: PmStatisticId;
  y: number;
  /** Statistic label, without the drug prefix the chart may add. */
  labelKey: string;
  dash: PmStatisticMeta['dash'];
  sourceShortLabel: string;
  /**
   * The matrix the value was converted INTO when the cohort's published matrix
   * and the display matrix cross the blood/plasma boundary, else `null`. Carries
   * the destination (not just a "converted" flag) so the label can name it — a
   * plasma cohort shown in whole blood is converted TO whole blood, not plasma.
   */
  convertedTo: ChartMatrix | null;
}

export interface PmSeriesContext {
  seriesId: string;
  distribution: PmDistribution;
  source: PmConcentrationSourceInfo;
  targetUnit: string;
  /**
   * Matrix THIS series is drawn in — its curve's effective matrix, which falls
   * back to whole blood when the drug has no ratio, so the cohort is never
   * converted into a matrix the curve beside it could not reach.
   */
  displayMatrix: ChartMatrix;
  molecularWeight?: number | null;
  bloodPlasmaRatio?: NumericRange | number | null;
}

/**
 * Build the drawable lines for the visible series.
 *
 * Kept free of Plotly and i18n so it can be unit-tested against numbers: the
 * caller turns each line into a `ModelingReferenceLine` with the drug's colour,
 * its axis and the translated label. Each context carries its own display
 * matrix, so a chart mixing a convertible drug with a no-ratio one draws each in
 * the matrix its curve actually uses.
 */
export function buildPmChartLines(
  contexts: readonly PmSeriesContext[],
  settings: PmLineSettings,
): PmChartLine[] {
  if (!settings.enabled) return [];
  const lines: PmChartLine[] = [];
  for (const ctx of contexts) {
    for (const stat of PM_STATISTICS) {
      if (!settings.statistics[stat.id]) continue;
      if (!isPmStatisticDrawable(ctx.distribution, stat.id)) continue;
      const raw = pmStatisticValue(ctx.distribution, stat.id);
      const y = convertPmValue(raw, {
        targetUnit: ctx.targetUnit,
        sourceUnit: ctx.source.unit,
        sourceMatrix: ctx.source.matrix,
        displayMatrix: ctx.displayMatrix,
        molecularWeight: ctx.molecularWeight,
        bloodPlasmaRatio: ctx.bloodPlasmaRatio,
      });
      if (y == null || y <= 0) continue;
      lines.push({
        seriesId: ctx.seriesId,
        statistic: stat.id,
        y,
        labelKey: stat.i18nKey,
        dash: stat.dash,
        sourceShortLabel: ctx.source.shortLabel,
        convertedTo: matrixConversionApplies(ctx.source.matrix, ctx.displayMatrix)
          ? ctx.displayMatrix
          : null,
      });
    }
  }
  return lines;
}

/** Look up a statistic's registry entry. */
export function pmStatisticMeta(
  id: PmStatisticId,
): PmStatisticMeta | undefined {
  return STATISTIC_BY_ID.get(id);
}
