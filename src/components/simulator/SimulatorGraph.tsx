import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Layers, LayoutGrid } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { HelpfulTip } from "@/components/ui/HelpfulTip";
import { ModelingChart } from "@/components/modeling/ModelingChart";
import {
  ethanolLegalLimitsToReferenceLines,
  pointAnnotationsToModelingMarkers,
  simulatorResultsToModelingSeries,
} from "@/lib/modelingAdapters";
import { buildChartPanels } from "@/lib/simulatorPanels";
import { computeTimelineTicks } from "@/components/simulator/EventTimeline";
import type { DrugSimResult, CaseDisplaySettings } from "@/types/simulator";
import type {
  ModelingReferenceBand,
  ModelingReferenceLine,
  ModelingTimeMarker,
} from "@/types/modeling";
import type {
  PmConcentrationSourceInfo,
  PmStatisticId,
} from "@/lib/pmConcentrations";
import type { ForensicCategoryId } from "@/lib/forensicConcentrations";
import {
  CHART_MATRICES,
  CHART_MATRIX_LABEL_KEYS,
  type ChartMatrix,
} from "@/lib/matrixDisplay";
import { cn } from "@/lib/utils";
import { PmReferenceLineControls } from "./PmReferenceLineControls";
import { ForensicReferenceLineControls } from "./ForensicReferenceLineControls";
import type { ReferenceRange, LegalLimit } from "./simulatorGraphShapes";

export type { ReferenceRange, LegalLimit };

/**
 * Shared time window + event points that tie the chart's x-axis to the event
 * timeline strip: identical span, identical ticks, and a vertical guide line
 * per event marker.
 */
export interface SimulatorTimeAxis {
  from: number;
  to: number;
  markers: { t: number; color: string; label: string }[];
  /**
   * Curve-feature guide lines (currently Tmax) carried alongside the event
   * markers but kept separate: they are not draggable events, are labelled on
   * the chart, and are filtered to the panel that owns the component.
   */
  curveMarkers?: {
    x: number;
    color: string;
    label: string;
    componentId: string;
  }[];
}

export interface PointAnnotation {
  x: number;
  y: number;
  label: string;
  color?: string;
}

/**
 * The postmortem-distribution overlay, prepared by the page (which knows each
 * component's display unit, molecular weight and blood:plasma ratio) and drawn
 * here.
 *
 * Passed as one object rather than loose props because the controls below the
 * chart must describe the SAME overlay the chart drew: which cohorts it came
 * from, and whether a requested plasma conversion silently produced no line.
 */
export interface SimulatorPmOverlay {
  lines: ModelingReferenceLine[];
  sources: PmConcentrationSourceInfo[];
  /** Statistics that at least one visible substance can actually draw. */
  availableStatistics: PmStatisticId[];
  /**
   * A substance on the chart has a distribution, but plasma conversion was
   * requested and it has no blood:plasma ratio — so its lines are missing
   * rather than wrong. The controls say so; silence would read as "no data".
   */
  conversionUnavailableFor: string[];
  /**
   * Distributions on the chart whose analyte mapping is not finally confirmed,
   * as `{ label, note }`. The monograph shows these; the chart drew them
   * unqualified, which is the surface where a line is likeliest to be read as
   * settled fact.
   */
  reviewNotes: { label: string; note: string }[];
}

/**
 * Forensic postmortem overlay: shaded bands (one per category) + representative
 * or per-reference lines, plus the backing data for the controls below the
 * chart. Built by `useForensicOverlay` from the drug's `parameter_entries`
 * source values.
 */
export interface SimulatorForensicOverlay {
  lines: ModelingReferenceLine[];
  bands: ModelingReferenceBand[];
  /** Categories at least one visible substance has data for. */
  availableCategories: ForensicCategoryId[];
  /** Per-category evidence totals for the controls (Σn and reference count). */
  categories: {
    category: ForensicCategoryId;
    refCount: number;
    totalN: number;
  }[];
  /**
   * Substances with forensic rows that could not be placed on the axis (no
   * blood:plasma ratio, or molar with no molecular weight) — their lines are
   * missing rather than wrong, and the controls say so.
   */
  conversionUnavailableFor: string[];
}

export interface SimulatorGraphProps {
  results: Record<string, DrugSimResult>;
  drugLabels: Record<string, string>;
  drugColors: Record<string, string>;
  visibleDrugs: Set<string>;
  displaySettings: CaseDisplaySettings;
  referenceRanges?: Record<string, ReferenceRange>;
  legalLimits?: LegalLimit[];
  /** Postmortem distribution lines + the controls' backing data. */
  pmOverlay?: SimulatorPmOverlay;
  /** Forensic postmortem bands/lines + the controls' backing data. */
  forensicOverlay?: SimulatorForensicOverlay;
  /** Component ids whose result is out of date — rendered dimmed. */
  staleIds?: Set<string>;
  /** Markers on the curve (e.g. peak BAC, time-to-sober). */
  pointAnnotations?: PointAnnotation[];
  /**
   * Shared window with the event timeline. When set, the chart adopts the
   * timeline's span + ticks and draws a vertical guide line for every event.
   */
  timeAxis?: SimulatorTimeAxis;
  /** Event timeline strip, rendered flush beneath the chart's x-axis. */
  timeline?: ReactNode;
  onToggleMode: () => void;
  /** Toggle a drug's visibility (curve + helper lines) from a legend click. */
  onSeriesToggle?: (seriesId: string) => void;
  /** Matrix the whole chart is displayed in (curve + every overlay). */
  displayMatrix?: ChartMatrix;
  /** Change the chart's display matrix. */
  onDisplayMatrixChange?: (matrix: ChartMatrix) => void;
  /**
   * Per-series multiplier applied to the plotted curve to express it in the
   * display matrix (chart only — never the canonical readouts).
   */
  matrixFactors?: Record<string, number>;
  /** True when at least one visible curve actually converted to the matrix. */
  matrixConverted?: boolean;
  /** Visible drugs shown in whole blood because their curve could not convert. */
  matrixConversionUnavailableFor?: string[];
}

function yAxisTitle(
  normalizeMode: CaseDisplaySettings["normalizeMode"],
  fallback: string,
): string {
  switch (normalizeMode) {
    case "peak":
      return "C / C_peak";
    case "initial_point":
      return "C / C(0)";
    default:
      return fallback;
  }
}

/**
 * Multiple of the curve peak beyond which a threshold line is drawn but no
 * longer expands the y-axis. Keeps a far-above lethal (or toxic) line from
 * leaving a large empty band above the curve, while nearby thresholds stay in
 * the auto-fit.
 */
const RANGE_INCLUDE_MULTIPLE = 3;

function referenceRangesToLines(
  referenceRanges: Record<string, ReferenceRange> | undefined,
  visibleDrugs: Set<string>,
  labels: Record<string, string>,
  /** Per-drug curve colour, so a drug's threshold lines match its curve. */
  colors: Record<string, string>,
  t: (key: string) => string,
  /** Peak median concentration on this panel; drives the y-fit policy. */
  peak: number,
): ModelingReferenceLine[] {
  if (!referenceRanges) return [];
  const visibleCount = Object.keys(referenceRanges).filter((id) =>
    visibleDrugs.has(id),
  ).length;
  // Only clamp when we have a real peak; an empty/stale panel (peak 0) keeps
  // every line in the fit so thresholds don't vanish.
  const ceiling = peak > 0 ? peak * RANGE_INCLUDE_MULTIPLE : Infinity;
  const nearCurve = (y: number) => y <= ceiling;
  const lines: ModelingReferenceLine[] = [];
  for (const [id, range] of Object.entries(referenceRanges)) {
    if (!visibleDrugs.has(id)) continue;
    const prefix = visibleCount > 1 ? `${labels[id] ?? id} ` : "";
    // All of a drug's helper lines share its curve colour so the overview reads
    // per drug; the dash style still distinguishes therapeutic / toxic / lethal.
    const color = colors[id] ?? "#2563eb";
    if (range.therapeutic?.max != null) {
      lines.push({
        y: range.therapeutic.max,
        label: `${prefix}${t('simulator.referenceLines.therapeutic')}`,
        color,
        dash: "dot",
        seriesId: id,
        // Therapeutic band is the user's primary reference — always in the fit.
        includeInRange: true,
      });
    }
    if (
      range.therapeutic?.min != null &&
      range.therapeutic.min !== range.therapeutic.max
    ) {
      lines.push({
        y: range.therapeutic.min,
        label: `${prefix}${t('simulator.referenceLines.therapeuticMin')}`,
        color,
        dash: "dot",
        seriesId: id,
        includeInRange: true,
      });
    }
    const toxic = range.toxic?.min ?? range.toxic?.max;
    if (toxic != null)
      lines.push({
        y: toxic,
        label: `${prefix}${t('simulator.referenceLines.toxic')}`,
        color,
        dash: "dash",
        seriesId: id,
        includeInRange: nearCurve(toxic),
      });
    const lethal = range.lethal?.min ?? range.lethal?.max;
    if (lethal != null)
      lines.push({
        y: lethal,
        label: `${prefix}${t('simulator.referenceLines.lethal')}`,
        color,
        dash: "dash",
        seriesId: id,
        // Lethal is typically far above the curve; draw it but don't let it
        // dominate the y-range.
        includeInRange: false,
      });
  }
  return lines;
}

export function SimulatorGraph({
  results,
  drugLabels,
  drugColors,
  visibleDrugs,
  displaySettings,
  referenceRanges,
  legalLimits,
  pmOverlay,
  forensicOverlay,
  staleIds,
  pointAnnotations,
  timeAxis,
  timeline,
  onToggleMode,
  onSeriesToggle,
  displayMatrix = "whole_blood",
  onDisplayMatrixChange,
  matrixFactors,
  matrixConverted = false,
  matrixConversionUnavailableFor = [],
}: SimulatorGraphProps) {
  const { t } = useTranslation();
  const series = useMemo(
    () =>
      simulatorResultsToModelingSeries(results, {
        labels: drugLabels,
        colors: drugColors,
        visibleIds: visibleDrugs,
        normalizeMode: displaySettings.normalizeMode,
        staleIds,
        matrixFactors,
      }),
    [
      results,
      drugLabels,
      drugColors,
      visibleDrugs,
      displaySettings.normalizeMode,
      staleIds,
      matrixFactors,
    ],
  );

  const hasStaleVisible = useMemo(
    () => series.some((s) => s.dimmed),
    [series],
  );

  const normalized = displaySettings.normalizeMode !== "none";

  // Genuine small multiples: never overlay incompatible units on one y-axis.
  const panels = useMemo(
    () =>
      buildChartPanels(series, {
        mode: displaySettings.mode,
        normalized,
      }),
    [series, displaySettings.mode, normalized],
  );

  // The legal-limit lines are blood-alcohol thresholds in g/dL; only attach
  // them to a g/dL panel.
  const legalLimitLines = useMemo(
    () =>
      ethanolLegalLimitsToReferenceLines(
        (legalLimits ?? []).map((l) => ({
          value: l.value,
          label: l.label,
          color: l.color,
          dash: l.dash as ModelingReferenceLine["dash"],
        })),
      ),
    [legalLimits],
  );

  const seriesPeak = (s: { points: { y: number; hi?: number }[] }): number => {
    let peak = 0;
    for (const p of s.points) {
      const top = p.hi ?? p.y;
      if (Number.isFinite(top) && top > peak) peak = top;
    }
    return peak;
  };

  const panelPeak = (panel: {
    series: { points: { y: number; hi?: number }[] }[];
  }): number => {
    let peak = 0;
    for (const s of panel.series) {
      const top = seriesPeak(s);
      if (top > peak) peak = top;
    }
    return peak;
  };

  const panelReferenceLines = (panel: {
    unit?: string;
    series: { id: string; points: { y: number; hi?: number }[] }[];
  }): ModelingReferenceLine[] => {
    if (normalized) return [];
    const panelIds = new Set(
      panel.series.map((s) => s.id).filter((id) => visibleDrugs.has(id)),
    );
    const lines = referenceRangesToLines(
      referenceRanges,
      panelIds,
      drugLabels,
      drugColors,
      t,
      panelPeak(panel),
    );
    if (panel.unit === "g/dL") lines.push(...legalLimitLines);
    // Postmortem lines follow the same panel/visibility rules as the
    // interpretive ones: a drug's overlay lives on that drug's axis and
    // disappears with its curve.
    //
    // They also follow the same y-fit policy as the toxic threshold, and for a
    // sharper reason. A linear y-axis is hard-set to [0, yMax] and yMax counts
    // only the lines that opted into the fit, so a line left out is not merely
    // "drawn without claiming room" — it is CLIPPED, and vanishes. Median and
    // the 90th percentile are drawn by default, so excluding them wholesale
    // would make the overlay silently absent exactly when it sits above the
    // curve. Including everything is no better: a 97.5th percentile of autopsy
    // findings can be a hundredfold above a therapeutic-dose curve and would
    // flatten it. So the same bounded multiple decides, and the controls say
    // plainly that anything beyond it needs the log axis.
    // The ceiling is per SERIES, not per panel. With two same-unit drugs
    // overlaid the chart gives each its own y-axis, and each axis is fitted
    // from its own series' lines — so judging a line against the panel's
    // largest peak would let a high-concentration drug vouch for a line that
    // then blows out a low-concentration drug's axis and flattens its curve.
    for (const line of pmOverlay?.lines ?? []) {
      if (!line.seriesId || !panelIds.has(line.seriesId)) continue;
      const own = panel.series.find((s) => s.id === line.seriesId);
      const peak = own ? seriesPeak(own) : 0;
      const ceiling = peak > 0 ? peak * RANGE_INCLUDE_MULTIPLE : Infinity;
      lines.push({ ...line, includeInRange: line.y <= ceiling });
    }
    // Forensic postmortem lines follow the exact same panel/visibility/y-fit
    // rules as the postmortem-percentile lines above.
    for (const line of forensicOverlay?.lines ?? []) {
      if (!line.seriesId || !panelIds.has(line.seriesId)) continue;
      const own = panel.series.find((s) => s.id === line.seriesId);
      const peak = own ? seriesPeak(own) : 0;
      const ceiling = peak > 0 ? peak * RANGE_INCLUDE_MULTIPLE : Infinity;
      lines.push({ ...line, includeInRange: line.y <= ceiling });
    }
    return lines;
  };

  // Forensic bands are anchored to their series' axis and follow the same y-fit
  // policy as the lines. The UPPER edge decides: ModelingChart fits the axis to
  // `max(y0, y1)`, so a band whose top runs far above the curve must be excluded
  // from the fit — otherwise it blows the axis out and flattens the curve, the
  // exact failure this ceiling prevents. Excluded, the band is still drawn (its
  // near-curve portion visible) and its remote top is clipped at the axis top.
  const panelReferenceBands = (panel: {
    series: { id: string; points: { y: number; hi?: number }[] }[];
  }): ModelingReferenceBand[] => {
    if (normalized) return [];
    const panelIds = new Set(
      panel.series.map((s) => s.id).filter((id) => visibleDrugs.has(id)),
    );
    const bands: ModelingReferenceBand[] = [];
    for (const band of forensicOverlay?.bands ?? []) {
      if (!band.seriesId || !panelIds.has(band.seriesId)) continue;
      const own = panel.series.find((s) => s.id === band.seriesId);
      const peak = own ? seriesPeak(own) : 0;
      const ceiling = peak > 0 ? peak * RANGE_INCLUDE_MULTIPLE : Infinity;
      const high = Math.max(band.y0, band.y1);
      bands.push({ ...band, includeInRange: high <= ceiling });
    }
    return bands;
  };

  const multi = panels.length > 1;

  // Derive the shared x-axis span, ticks, and vertical event lines once, so
  // every panel lines up with the event timeline below.
  const xRange = useMemo<[number, number] | undefined>(
    () => (timeAxis ? [timeAxis.from, timeAxis.to] : undefined),
    [timeAxis],
  );
  const xTickHours = useMemo(
    () => (timeAxis ? computeTimelineTicks(timeAxis.from, timeAxis.to) : undefined),
    [timeAxis],
  );
  const eventTimeMarkers = useMemo<ModelingTimeMarker[]>(() => {
    if (!timeAxis) return [];
    const seen = new Set<string>();
    const out: ModelingTimeMarker[] = [];
    for (const m of timeAxis.markers) {
      if (!Number.isFinite(m.t)) continue;
      // Collapse events that share a time + colour to a single guide line.
      const key = `${m.t.toFixed(4)}:${m.color}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ x: m.t, color: m.color, label: m.label });
    }
    return out;
  }, [timeAxis]);

  // Tmax guide lines are labelled (annotate) and dash-dotted to read as curve
  // features distinct from the event guides. Kept with their component id so a
  // component's Tmax lands only on the panel that shows it.
  const tmaxMarkers = useMemo<
    (ModelingTimeMarker & { componentId: string })[]
  >(() => {
    if (!timeAxis?.curveMarkers) return [];
    return timeAxis.curveMarkers
      .filter((m) => Number.isFinite(m.x))
      .map((m) => ({
        x: m.x,
        color: m.color,
        label: m.label,
        dash: "dashdot" as const,
        annotate: true,
        componentId: m.componentId,
      }));
  }, [timeAxis]);

  const panelTimeMarkers = (panel: {
    series: { id: string }[];
  }): ModelingTimeMarker[] | undefined => {
    if (!timeAxis) return undefined;
    const panelIds = new Set(panel.series.map((s) => s.id));
    const tmax = tmaxMarkers
      .filter((m) => panelIds.has(m.componentId))
      .map(({ componentId: _componentId, ...marker }) => marker);
    return [...eventTimeMarkers, ...tmax];
  };

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <h3 className="font-semibold text-sm">
              {multi
                ? t("modelingChart.separatePanels")
                : t("modelingChart.overlayView")}
            </h3>
            {displaySettings.showUncertaintyBands && (
              <HelpfulTip
                id="modeling-uncertainty-bands"
                triggerLabel={t("modelingChart.bandLegendLabel")}
                content={t("modelingChart.bandLegend")}
              />
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Chart matrix: the modelled curve and every overlay are shown in
                the chosen matrix. Hidden in normalized mode, where a matrix
                means nothing against C/C_peak. */}
            {!normalized && onDisplayMatrixChange && (
              <div
                className="flex items-center gap-0.5 rounded-md border border-input p-0.5"
                role="group"
                aria-label={t("chartMatrix.label")}
              >
                {CHART_MATRICES.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => onDisplayMatrixChange(m)}
                    aria-pressed={displayMatrix === m}
                    className={cn(
                      "rounded px-2 py-0.5 text-xs transition-colors",
                      displayMatrix === m
                        ? "bg-primary text-primary-foreground"
                        : "text-foreground hover:bg-muted",
                    )}
                  >
                    {t(CHART_MATRIX_LABEL_KEYS[m])}
                  </button>
                ))}
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={onToggleMode}
            >
              {displaySettings.mode === "overlay" ? (
                <>
                  <LayoutGrid className="h-3.5 w-3.5 mr-1" />
                  {t("modelingChart.separate")}
                </>
              ) : (
                <>
                  <Layers className="h-3.5 w-3.5 mr-1" />
                  {t("modelingChart.overlay")}
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Only claim conversion when at least one visible curve actually
            moved — a derived value must never wear a published one's label,
            and neither must an unchanged one. Not gated on a non-blood display:
            a plasma model shown in whole blood is converted too. */}
        {!normalized && matrixConverted && (
          <p className="text-xs text-muted-foreground">
            {t("chartMatrix.convertedNote")}
          </p>
        )}
        {/* Curves that could not be converted (no blood:plasma ratio, or a
            non-concentration quantity like ethanol g/dL) stay in the matrix
            their own model computed in — named, so an unconverted curve is
            never taken for the chosen matrix. */}
        {!normalized && matrixConversionUnavailableFor.length > 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {t("chartMatrix.unavailable")}{" "}
            {matrixConversionUnavailableFor.join(", ")}
          </p>
        )}

        {hasStaleVisible && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200">
            {t('modelingChart.staleResults')}
          </div>
        )}

        {panels.map((panel) => (
          <ModelingChart
            key={panel.key}
            series={panel.series}
            options={{
              accent: panel.unit === "g/dL" ? "ethanol" : "simulator",
              xFormat: displaySettings.timeFormat,
              referenceTime: displaySettings.referenceTime,
              xAxisTitle:
                displaySettings.timeFormat === "clock"
                  ? t("modelingChart.xAxisClock")
                  : t("modelingChart.xAxisHours"),
              yAxisTitle: normalized
                ? yAxisTitle(
                    displaySettings.normalizeMode,
                    t("modelingChart.concentration"),
                  )
                : panel.unit
                  ? `${t("modelingChart.concentration")} (${panel.unit})`
                  : t("modelingChart.concentration"),
              showUncertaintyBands: displaySettings.showUncertaintyBands,
              showLogToggle: !normalized,
              referenceLines: panelReferenceLines(panel),
              referenceBands: panelReferenceBands(panel),
              xRange,
              xTickHours,
              timeMarkers: panelTimeMarkers(panel),
              // Point annotations (peak/time-to-sober BAC) are g/dL; keep them
              // off non-g/dL panels when split into small multiples.
              markers:
                !multi || panel.unit === "g/dL"
                  ? pointAnnotationsToModelingMarkers(pointAnnotations ?? [])
                  : [],
              emptyMessage: t("modelingChart.runSimulationEmpty"),
              height: 360,
              // Give each drug its own scaled y-axis when a panel overlays 2+
              // curves, so a wide-range drug doesn't flatten the others.
              perSeriesAxis: !normalized && panel.series.length > 1,
              onSeriesToggle,
            }}
          />
        ))}

        {/* The event timeline tucks flush under the chart's x-axis, sharing the
            same window + ticks so it reads as part of the chart body. */}
        {timeline && <div className="-mt-1">{timeline}</div>}

        {/* Hidden in normalized mode with the rest of the absolute-scale
            overlays: a percentile in mg/L means nothing against C/C_peak. */}
        {!normalized && pmOverlay && (
          <PmReferenceLineControls
            sources={pmOverlay.sources}
            availableStatistics={pmOverlay.availableStatistics}
            conversionUnavailableFor={pmOverlay.conversionUnavailableFor}
            reviewNotes={pmOverlay.reviewNotes}
          />
        )}

        {!normalized && forensicOverlay && (
          <ForensicReferenceLineControls
            availableCategories={forensicOverlay.availableCategories}
            categories={forensicOverlay.categories}
            conversionUnavailableFor={forensicOverlay.conversionUnavailableFor}
          />
        )}
      </CardContent>
    </Card>
  );
}
