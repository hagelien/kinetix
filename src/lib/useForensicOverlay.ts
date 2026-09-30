/**
 * Fetches the forensic postmortem "source values" for the substances on a
 * modeling chart and turns them into drawable bands + reference lines.
 *
 * The arithmetic (conversion, pooling, evidence-opacity) lives in
 * `forensicConcentrations.ts`; this hook is the wiring — which substances are on
 * the chart, what unit each is displayed in, what the user's persisted settings
 * say, and reading the raw per-reference `parameter_entries` rows (the source
 * values) rather than the collapsed `fatalConcentration` cache.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import {
  buildForensicCategories,
  evidenceAlpha,
  forensicCategoryMeta,
  hasUnconvertibleForensicRows,
  withAlpha,
  BAND_FILL_SCALE,
  FORENSIC_CATEGORY_IDS,
  type ForensicCategoryId,
  type ForensicConversionContext,
  type ForensicEntryInput,
  type ForensicLineSettings,
} from './forensicConcentrations';
import { fetchParameterEntries, type ParameterEntryRow } from './parameterEntriesApi';
import type { ChartMatrix } from './matrixDisplay';
import { entryCentralValue } from './entryDoseContext';
import type {
  ModelingReferenceBand,
  ModelingReferenceLine,
} from '@/types/modeling';
import type { NumericRange } from '@/types';
import type { SimulatorForensicOverlay } from '@/components/simulator/SimulatorGraph';

/** All three forensic scenarios back the one `fatalConcentration` parameter. */
const FORENSIC_PARAMETER = 'fatalConcentration';

/**
 * Settings used only to discover which categories a drug has DATA for —
 * everything on, so availability reflects the source rows, never the user's
 * current visibility choices.
 */
const AVAILABILITY_SETTINGS: ForensicLineSettings = {
  enabled: true,
  categories: FORENSIC_CATEGORY_IDS.reduce(
    (acc, id) => {
      acc[id] = true;
      return acc;
    },
    {} as Record<ForensicCategoryId, boolean>,
  ),
  showIndividual: false,
};

/** One series on the chart, as the host knows it. */
export interface ForensicOverlaySeriesInput {
  /** Chart series id (the component config id). */
  seriesId: string;
  /** Internal `drugs.id`, the key the entries API answers on. */
  drugDbId: number | null;
  label: string;
  /** Unit the series is being displayed in. */
  unit: string;
  molecularWeight?: number | null;
  bloodPlasmaRatio?: NumericRange | number | null;
  visible: boolean;
  /**
   * Matrix this series' curve is drawn in — its effective matrix, already
   * collapsed to whole blood by the host when the drug has no B/P ratio, so a
   * forensic band never lands in a matrix the curve beside it could not reach.
   * Defaults to whole blood.
   */
  displayMatrix?: ChartMatrix;
}

/** A short human label for a citation, best-effort from its metadata. */
function citationShortLabel(row: ParameterEntryRow): string | null {
  const meta = row.citation?.metadata as
    | { authors?: unknown; year?: unknown }
    | undefined;
  const year =
    meta && (typeof meta.year === 'number' || typeof meta.year === 'string')
      ? String(meta.year)
      : null;
  const authors = meta && Array.isArray(meta.authors) ? meta.authors : null;
  const firstAuthor =
    authors && authors.length > 0 && typeof authors[0] === 'string'
      ? (authors[0] as string).split(/[\s,]+/)[0]
      : null;
  if (firstAuthor && year) return `${firstAuthor} ${year}`;
  if (firstAuthor) return firstAuthor;
  if (row.citation?.identifier) return row.citation.identifier;
  return null;
}

/** Fetch the forensic source values for a set of drug ids, keyed by drug id. */
function useForensicEntries(
  drugDbIds: readonly (number | null)[],
): Map<number, ParameterEntryRow[]> {
  const [byDrug, setByDrug] = useState<Map<number, ParameterEntryRow[]>>(
    () => new Map(),
  );
  const key = useMemo(
    () =>
      Array.from(new Set(drugDbIds.filter((id): id is number => id != null)))
        .sort((a, b) => a - b)
        .join(','),
    [drugDbIds],
  );

  useEffect(() => {
    if (!key) {
      setByDrug(new Map());
      return;
    }
    let cancelled = false;
    const ids = key.split(',').map(Number);
    Promise.all(
      ids.map((id) =>
        fetchParameterEntries(id, { parameter: FORENSIC_PARAMETER })
          .then((rows) => [id, rows] as const)
          // A failed overlay must never take the chart down with it: the curve
          // is the deliverable, the bands are context.
          .catch(() => [id, [] as ParameterEntryRow[]] as const),
      ),
    ).then((pairs) => {
      if (!cancelled) setByDrug(new Map(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return byDrug;
}

/**
 * Build the forensic overlay for a set of chart series.
 *
 * Only VISIBLE series contribute, so a drug's bands vanish with its curve
 * exactly as its therapeutic/toxic lines already do. With more than one
 * substance on the chart each label is prefixed with its drug — a bare "PM
 * mono-intoks" on a two-drug chart belongs to neither.
 */
export function useForensicOverlay(
  series: readonly ForensicOverlaySeriesInput[],
): SimulatorForensicOverlay | undefined {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.forensicLines);
  const drugDbIds = useMemo(() => series.map((s) => s.drugDbId), [series]);
  const entriesByDrug = useForensicEntries(drugDbIds);

  return useMemo(() => {
    const visible = series.filter((s) => s.visible && s.drugDbId != null);
    if (visible.length === 0) return undefined;

    const multi = visible.length > 1;
    const lines: ModelingReferenceLine[] = [];
    const bands: ModelingReferenceBand[] = [];
    // Which categories any visible substance actually has data for, so a toggle
    // for a category nobody has is disabled rather than silently inert.
    const available = new Set<ForensicCategoryId>();
    const categorySummaries = new Map<
      ForensicCategoryId,
      { refCount: number; totalN: number }
    >();
    // Substances that DO have forensic rows but none could be placed on the
    // axis (plasma/serum with no B/P ratio, or molar with no molecular weight):
    // reported so the panel does not read identically to "no forensic data".
    const conversionUnavailableFor: string[] = [];
    // The duplicate-drug flow (two regimens of one substance) puts two series
    // on the same `drugDbId` over the identical source rows. Bands draw on each
    // series' own axis, but the evidence SUMMARY and the warning are per
    // substance — counting them once per drug keeps n and the reference count
    // honest instead of doubling with each duplicate.
    const summarizedDrugs = new Set<number>();
    const warnedDrugs = new Set<number>();

    for (const s of visible) {
      const drugId = s.drugDbId!;
      const rows = entriesByDrug.get(drugId) ?? [];
      if (rows.length === 0) continue;
      const entries: ForensicEntryInput[] = rows.map((row) => ({
        scenario: row.scenario,
        low: row.low,
        high: row.high,
        // A labelled source value keeps its centre in `centralValue`.
        median: entryCentralValue({
          median: row.median,
          centralValue: row.doseContext?.centralValue,
        }),
        qualifier: row.qualifier,
        unit: row.unit,
        matrix: row.matrix,
        n: row.n,
        origin: row.origin,
        citationId: row.citationId,
        citationLabel: citationShortLabel(row),
      }));

      const conversionCtx: ForensicConversionContext = {
        targetUnit: s.unit,
        displayMatrix: s.displayMatrix ?? 'whole_blood',
        molecularWeight: s.molecularWeight,
        bloodPlasmaRatio: s.bloodPlasmaRatio,
      };
      if (
        !warnedDrugs.has(drugId) &&
        hasUnconvertibleForensicRows(entries, conversionCtx)
      ) {
        conversionUnavailableFor.push(s.label);
        warnedDrugs.add(drugId);
      }

      // Availability and the controls panel must NOT depend on the user's
      // visibility settings: a category is "available" when the drug has data
      // for it, full stop. Deriving it from a settings-filtered build would make
      // a category's own toggle disable itself (so it could never be turned back
      // on), and the disabled master switch would empty the overlay and remove
      // the whole panel — both permanently, since the setting is persisted. So
      // the data pass runs with every category on, and the settings gate only
      // what gets DRAWN.
      const dataResults = buildForensicCategories(
        entries,
        conversionCtx,
        AVAILABILITY_SETTINGS,
      );

      const prefix = multi ? `${s.label} ` : '';
      // Count this drug's evidence into the summary only once, even if several
      // series share its `drugDbId`.
      const countSummary = !summarizedDrugs.has(drugId);
      summarizedDrugs.add(drugId);

      for (const result of dataResults) {
        available.add(result.category);
        if (countSummary) {
          const prev = categorySummaries.get(result.category) ?? {
            refCount: 0,
            totalN: 0,
          };
          categorySummaries.set(result.category, {
            refCount: prev.refCount + result.refCount,
            totalN: prev.totalN + result.totalN,
          });
        }

        // From here down is DRAWING, gated by the live settings.
        if (!settings.enabled || !settings.categories[result.category]) continue;

        const categoryLabel = t(
          forensicCategoryMeta(result.category)?.i18nKey ?? result.category,
        );

        // The band carries the category label + the evidence behind it, so the
        // label lives in one place whether or not individual lines are drawn.
        if (result.band) {
          bands.push({
            y0: result.band.low,
            y1: result.band.high,
            color: withAlpha(
              result.color,
              evidenceAlpha(result.totalN) * BAND_FILL_SCALE,
            ),
            label: t('forensicConc.bandLabel', {
              category: `${prefix}${categoryLabel}`,
              n: result.totalN,
              refs: result.refCount,
            }),
            labelColor: result.color,
            seriesId: s.seriesId,
          });
        }

        let drewLine = false;
        if (settings.showIndividual) {
          // One faint→strong line per contributing reference, each named by its
          // citation so the source-level view is actually readable — otherwise
          // the lines are indistinguishable and the mode is pointless.
          for (const point of result.points) {
            lines.push({
              y: point.representative,
              label: t('forensicConc.individualLabel', {
                // Prefix with the substance in multi-drug mode: category colours
                // are shared across drugs, so an unprefixed citation (or a
                // fallback category label) would be ambiguous between axes.
                source: `${prefix}${point.citationLabel ?? categoryLabel}`,
                n: point.n,
              }),
              color: withAlpha(result.color, evidenceAlpha(point.n)),
              dash: 'solid',
              seriesId: s.seriesId,
            });
            drewLine = true;
          }
        } else if (result.representative != null) {
          // One pooled representative line, opacity by the total evidence.
          lines.push({
            y: result.representative,
            label: '',
            color: withAlpha(result.color, evidenceAlpha(result.totalN)),
            dash: 'solid',
            seriesId: s.seriesId,
          });
          drewLine = true;
        }

        // A category whose only data is one-sided bounds has no representative,
        // and if those bounds converge on ONE value the band collapses to a
        // zero-height, invisible rectangle. Only then draw a dotted indicator at
        // that value (dotted, not solid, to mark a bound rather than a pooled
        // estimate). A band spanning distinct bounds is already a visible rect,
        // and its midpoint is a value no source reported — so it is left alone.
        if (
          !drewLine &&
          result.band &&
          result.band.low === result.band.high &&
          Number.isFinite(result.band.low) &&
          result.band.low > 0
        ) {
          lines.push({
            y: result.band.low,
            label: '',
            color: withAlpha(result.color, evidenceAlpha(result.totalN)),
            dash: 'dot',
            seriesId: s.seriesId,
          });
        }
      }
    }

    // Return the overlay whenever the chart has forensic DATA — drawable, or
    // present-but-unconvertible — even if the user has everything toggled off.
    // Otherwise the controls panel (its master switch, and the warning naming
    // the unconvertible drugs) would disappear and the chart would look like it
    // had no forensic sources at all.
    if (available.size === 0 && conversionUnavailableFor.length === 0) {
      return undefined;
    }

    return {
      lines,
      bands,
      availableCategories: FORENSIC_CATEGORY_IDS.filter((id) =>
        available.has(id),
      ),
      categories: FORENSIC_CATEGORY_IDS.filter((id) => available.has(id)).map(
        (id) => ({
          category: id,
          ...(categorySummaries.get(id) ?? { refCount: 0, totalN: 0 }),
        }),
      ),
      conversionUnavailableFor,
    };
  }, [series, entriesByDrug, settings, t]);
}
