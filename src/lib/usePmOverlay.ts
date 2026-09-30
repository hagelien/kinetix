/**
 * Fetches the postmortem distributions for the substances on a chart and turns
 * them into drawable reference lines.
 *
 * The arithmetic lives in `pmConcentrations.ts`; this hook is the wiring —
 * which substances are on the chart, what unit each one is displayed in, and
 * what the user's persisted line settings say.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { useAuthStore } from '@/stores/authStore';
import { canAccessPmConcentrations } from './featureAccess';
import {
  buildPmChartLines,
  isPmStatisticDrawable,
  pmHasUsableBloodPlasmaRatio,
  pmStatisticValue,
  PM_STATISTICS,
  type PmDistribution,
  type PmSeriesContext,
  type PmStatisticId,
} from './pmConcentrations';
import {
  EMPTY_PM_RESULT,
  fetchPmConcentrationsByDrugIds,
  type PmConcentrationsResult,
} from './pmConcentrationsApi';
import {
  matrixConversionApplies,
  CHART_MATRIX_LABEL_KEYS,
  type ChartMatrix,
} from './matrixDisplay';
import type { ModelingReferenceLine } from '@/types/modeling';
import type { NumericRange } from '@/types';
import type { SimulatorPmOverlay } from '@/components/simulator/SimulatorGraph';

/** One series on the chart, as the host knows it. */
export interface PmOverlaySeriesInput {
  /** Chart series id (the component config id). */
  seriesId: string;
  /** Internal `drugs.id`, the key the API answers on. */
  drugDbId: number | null;
  label: string;
  color: string;
  /** Unit the series is being displayed in. */
  unit: string;
  molecularWeight?: number | null;
  bloodPlasmaRatio?: NumericRange | number | null;
  visible: boolean;
  /**
   * Matrix this series' curve is drawn in — its effective matrix, which the host
   * has already collapsed to whole blood when the drug has no B/P ratio. The
   * cohort is converted toward this, so an overlay never lands in a matrix the
   * curve beside it could not reach. Defaults to whole blood.
   */
  displayMatrix?: ChartMatrix;
}

export function usePmDistributions(
  drugDbIds: readonly (number | null)[],
): PmConcentrationsResult {
  // The answer is held WITH the access context that produced it, and returned
  // only while the two still match.
  //
  // Clearing in the effect is a paint too late: the auth store updates, React
  // commits the render it triggers, and only then does the effect run — so for
  // that one frame this hook would hand back the previous account's gated
  // payload and the chart would draw its lines. The monograph table already
  // binds its data to the drug that produced it for the same reason; this is
  // the same rule applied to identity instead of drug.
  const [state, setState] = useState<{
    canRead: boolean;
    identity: number | null;
    result: PmConcentrationsResult;
  }>({ canRead: false, identity: null, result: EMPTY_PM_RESULT });
  // The same gate the route enforces, applied before the request rather than
  // after. Without it a session that LOSES access keeps rendering whatever it
  // already holds: the store updates in place in this SPA, so nothing else
  // would prompt a re-read. `userId` is also the cache identity, so one
  // account's gated payload can never be served to the next.
  const canRead = useAuthStore((s) =>
    canAccessPmConcentrations(s.user, s.permissionOverrides),
  );
  const identity = useAuthStore((s) => s.user?.id ?? null);
  // Stable key so a re-render with an equal-but-new array does not refetch.
  const key = useMemo(
    () =>
      Array.from(new Set(drugDbIds.filter((id): id is number => id != null)))
        .sort((a, b) => a - b)
        .join(','),
    [drugDbIds],
  );

  useEffect(() => {
    if (!key || !canRead) {
      setState({ canRead, identity, result: EMPTY_PM_RESULT });
      return;
    }
    let cancelled = false;
    const ids = key.split(',').map(Number);
    fetchPmConcentrationsByDrugIds(ids, identity)
      .then((value) => {
        if (!cancelled) setState({ canRead, identity, result: value });
      })
      .catch(() => {
        // A failed overlay must not take the chart down with it: the curve is
        // the deliverable, the reference lines are context.
        if (!cancelled) {
          setState({ canRead, identity, result: EMPTY_PM_RESULT });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key, canRead, identity]);

  // Synchronous, not effect-delayed: a payload fetched under a different
  // identity or capability is not shown at all, however briefly.
  return canRead && state.canRead && state.identity === identity
    ? state.result
    : EMPTY_PM_RESULT;
}

/**
 * Build the overlay for a set of chart series.
 *
 * Only VISIBLE series contribute, so a drug's percentile lines vanish with its
 * curve exactly as its therapeutic/toxic lines already do. When more than one
 * substance is on the chart, each line is prefixed with its drug label — a bare
 * "PM 90. persentil" on a two-drug chart belongs to neither.
 */
export function usePmOverlay(
  series: readonly PmOverlaySeriesInput[],
): SimulatorPmOverlay | undefined {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.pmLines);
  const drugDbIds = useMemo(
    () => series.map((s) => s.drugDbId),
    [series],
  );
  const { sources, distributions } = usePmDistributions(drugDbIds);

  return useMemo(() => {
    if (distributions.length === 0) return undefined;

    const sourceByKey = new Map(sources.map((s) => [s.key, s]));
    const distributionByDrugId = new Map<number, PmDistribution>();
    for (const dist of distributions) {
      // One cohort today. With several, the first wins deterministically by
      // source key rather than by row order, so the chart cannot change
      // between reloads.
      const existing = distributionByDrugId.get(dist.drugId);
      if (!existing || dist.sourceKey < existing.sourceKey) {
        distributionByDrugId.set(dist.drugId, dist);
      }
    }

    const visible = series.filter((s) => s.visible && s.drugDbId != null);
    const contexts: PmSeriesContext[] = [];
    const usedSources = new Set<string>();
    for (const s of visible) {
      const dist = distributionByDrugId.get(s.drugDbId!);
      if (!dist) continue;
      const source = sourceByKey.get(dist.sourceKey);
      if (!source) continue;
      usedSources.add(source.key);
      contexts.push({
        seriesId: s.seriesId,
        distribution: dist,
        source,
        targetUnit: s.unit,
        displayMatrix: s.displayMatrix ?? 'whole_blood',
        molecularWeight: s.molecularWeight,
        bloodPlasmaRatio: s.bloodPlasmaRatio,
      });
    }
    if (contexts.length === 0) return undefined;

    const colorBySeries = new Map(series.map((s) => [s.seriesId, s.color]));
    const labelBySeries = new Map(series.map((s) => [s.seriesId, s.label]));
    const multi = contexts.length > 1;
    // With two cohorts on one chart a bare "PM 90. persentil" does not say
    // whose material it came from, and the two are qualified by different
    // caveats. Name the cohort on the line itself in that case only — on the
    // single-cohort chart the panel heading already says it, and repeating it
    // per line would crowd the plot.
    const multiSource = usedSources.size > 1;

    const lines: ModelingReferenceLine[] = buildPmChartLines(
      contexts,
      settings,
    ).map((line) => {
      const prefix = multi ? `${labelBySeries.get(line.seriesId) ?? ''} ` : '';
      const suffix = multiSource ? ` (${line.sourceShortLabel})` : '';
      // A converted line says so on the line, and names the matrix it was
      // converted INTO — a plasma cohort shown in whole blood reads "(whole
      // blood)", not "(plasma)". The matrix choice persists across sessions, so
      // the next visit opens with B/P-derived values already drawn and the
      // controls collapsed; without the tag nothing on the plot would
      // distinguish them from the source's published figures — a derived number
      // wearing a published one's label, which this feature guards against
      // everywhere else.
      const statistic = t(line.labelKey);
      const label = line.convertedTo
        ? t('pmConcentrations.lineLabelConverted', {
            statistic,
            matrix: t(CHART_MATRIX_LABEL_KEYS[line.convertedTo]).toLowerCase(),
          })
        : t('pmConcentrations.lineLabel', { statistic });
      return {
        y: line.y,
        label: `${prefix}${label}${suffix}`,
        color: colorBySeries.get(line.seriesId),
        dash: line.dash,
        seriesId: line.seriesId,
        // `includeInRange` is decided by the chart, not here: it depends on the
        // panel's peak, which only SimulatorGraph knows. Left unset the default
        // is `true`, which is the safe direction — a line that expands the axis
        // is visible, and one excluded from the fit is CLIPPED, because a
        // linear y-axis is hard-set to [0, yMax].
      };
    });

    // Which statistics any visible substance can actually draw, so a toggle
    // for a statistic nobody has is disabled rather than silently inert.
    const availableStatistics: PmStatisticId[] = PM_STATISTICS.filter((stat) =>
      contexts.some(
        (ctx) =>
          isPmStatisticDrawable(ctx.distribution, stat.id) &&
          pmStatisticValue(ctx.distribution, stat.id) != null,
      ),
    ).map((stat) => stat.id);

    // Substances whose lines are missing because plasma conversion has no
    // blood:plasma ratio to work with — and ONLY those.
    //
    // Probing this with `convertPmValue(...) == null` looked equivalent and is
    // not: that null also covers a molar display unit with no molecular weight
    // and a statistic the row does not carry. The panel's message names the
    // missing B/P ratio, so it has to be shown for exactly that cause; naming
    // the wrong absent datum sends the reader to fill in a value that was
    // never the problem.
    const conversionUnavailableFor = contexts
      .filter(
        (ctx) =>
          // A missing ratio only bites when the cohort's matrix and this
          // series' display matrix are on opposite sides of the blood/plasma
          // boundary — in EITHER direction (a plasma cohort shown in whole blood
          // needs the ratio just as a blood cohort shown in plasma does).
          matrixConversionApplies(ctx.source.matrix, ctx.displayMatrix) &&
          !pmHasUsableBloodPlasmaRatio(ctx.bloodPlasmaRatio),
      )
      .map((ctx) => labelBySeries.get(ctx.seriesId) ?? ctx.seriesId);

    // Mappings a human has still to confirm. Drawn, not withheld — the
    // numbers are the source's and remain useful — but never silently: the
    // monograph flags them, and the chart is where an unqualified line is
    // likeliest to be taken as settled.
    const reviewNotes = contexts
      .filter((ctx) => ctx.distribution.reviewNote)
      .map((ctx) => ({
        label: labelBySeries.get(ctx.seriesId) ?? ctx.distribution.analyte,
        note: ctx.distribution.reviewNote!,
      }));

    return {
      lines,
      sources: sources.filter((s) => usedSources.has(s.key)),
      availableStatistics,
      conversionUnavailableFor,
      reviewNotes,
    };
  }, [series, sources, distributions, settings, t]);
}
