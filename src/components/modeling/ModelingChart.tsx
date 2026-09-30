import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  Config,
  Layout,
  PlotData,
  PlotlyHTMLElement,
} from 'plotly.js-basic-dist-min';
import { Switch } from '@/components/ui/switch';
import { hoursToClockTime } from '@/lib/timeFormat';
import { MODELING_CHART_MARGIN } from '@/lib/modelingChartLayout';
import type {
  ModelingChartOptions,
  ModelingMarker,
  ModelingReferenceBand,
  ModelingReferenceLine,
  ModelingSeries,
} from '@/types/modeling';

interface ModelingChartProps {
  series: ModelingSeries[];
  options?: ModelingChartOptions;
}

type PlotlyRuntime = Pick<
  typeof import('plotly.js-basic-dist-min'),
  'newPlot' | 'react' | 'purge'
>;

let plotlyPromise: Promise<PlotlyRuntime> | null = null;

function loadPlotly(): Promise<PlotlyRuntime> {
  plotlyPromise ??= import('plotly.js-basic-dist-min')
    .then((module) => {
      const runtime = module as Partial<PlotlyRuntime> & {
        default?: PlotlyRuntime;
      };
      const resolved = runtime.newPlot
        ? (runtime as PlotlyRuntime)
        : runtime.default;
      if (!resolved) throw new Error('Plotly runtime failed to load');
      return resolved;
    })
    .catch((err) => {
      plotlyPromise = null;
      throw err;
    });
  return plotlyPromise;
}

const DEFAULT_COLORS = [
  '#2563eb',
  '#10b981',
  '#f97316',
  '#a855f7',
  '#ec4899',
  '#06b6d4',
];

function accentToken(accent: string | undefined): string {
  switch (accent) {
    case 'simulator':
      return '--sim';
    case 'kinelab':
      return '--kine';
    case 'ethanol':
      return '--etoh';
    default:
      return '--primary';
  }
}

function tokenHsl(token: string, alpha?: number): string {
  if (typeof window === 'undefined') return 'transparent';
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(token)
    .trim();
  if (!raw) return 'transparent';
  return alpha != null ? `hsl(${raw} / ${alpha})` : `hsl(${raw})`;
}

function colorWithAlpha(color: string, alpha: number): string {
  if (color.startsWith('#') && (color.length === 7 || color.length === 4)) {
    const normalized =
      color.length === 4
        ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
        : color;
    const r = parseInt(normalized.slice(1, 3), 16);
    const g = parseInt(normalized.slice(3, 5), 16);
    const b = parseInt(normalized.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  if (color.startsWith('hsl(')) {
    return color.replace(
      /^hsl\((.*)\)$/,
      (_match, body: string) => `hsl(${body} / ${alpha})`,
    );
  }
  return color;
}

function finiteMax(values: number[]): number {
  const max = Math.max(...values.filter((v) => Number.isFinite(v)));
  return Number.isFinite(max) ? max : 0;
}

/**
 * Round up to a "nice" axis top with ~2 significant figures, so the plot hugs
 * the data instead of over-shooting. The step is 1/10 of the value's magnitude,
 * so 0.121 → 0.13 and 1.12 → 1.2 (vs. the old 1/2/5 ladder that jumped 0.121 →
 * 0.2, leaving a large empty band above the curve).
 */
function niceTop(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const step = Math.pow(10, exp - 1);
  return Math.ceil(value / step) * step;
}

function markerTrace(
  markers: ModelingMarker[],
  color: string,
  hoverTemplate: string,
): Partial<PlotData> {
  return {
    x: markers.map((m) => m.x),
    y: markers.map((m) => m.y),
    text: markers.map((m) => m.label),
    type: 'scatter',
    mode: 'markers',
    name: markers[0]?.label ?? 'marker',
    marker: {
      color: markers.map((m) => m.color ?? color),
      size: 8,
      line: { color: '#92400e', width: 1 },
    } as PlotData['marker'],
    showlegend: false,
    hovertemplate: hoverTemplate,
  };
}

export function ModelingChart({ series, options = {} }: ModelingChartProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<PlotlyHTMLElement | null>(null);
  const plotlyRef = useRef<PlotlyRuntime | null>(null);
  const [localLogY, setLocalLogY] = useState(options.logY ?? false);

  useEffect(() => setLocalLogY(options.logY ?? false), [options.logY]);

  const [themeTick, setThemeTick] = useState(0);
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeTick((n) => n + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  const gridColor = useMemo(() => tokenHsl('--border'), [themeTick]);
  const fontColor = useMemo(() => tokenHsl('--muted-foreground'), [themeTick]);
  const annotationColor = useMemo(() => tokenHsl('--foreground'), [themeTick]);
  const annotationBg = useMemo(() => tokenHsl('--card', 0.85), [themeTick]);
  const legendBg = useMemo(() => tokenHsl('--card', 0.8), [themeTick]);
  const primaryStroke = useMemo(
    () => tokenHsl(accentToken(options.accent)),
    [options.accent, themeTick],
  );

  const visibleSeries = useMemo(
    () => series.filter((s) => s.visible !== false && s.points.length > 0),
    [series],
  );
  const logY = options.logY ?? localLogY;
  const showBands = options.showUncertaintyBands ?? true;
  const useClock = options.xFormat === 'clock' && options.referenceTime;

  // Per-drug axes: each visible series gets its own independently-scaled y-axis
  // (only meaningful with 2+ series). `axisForSeries` maps a series id to its
  // Plotly axis reference ('y', 'y2', …), used both by the traces and by the
  // reference-line shapes so a drug's threshold lines land on its own axis.
  const perAxis = (options.perSeriesAxis ?? false) && visibleSeries.length >= 2;
  const axisForSeries = useMemo(() => {
    const map = new Map<string, string>();
    visibleSeries.forEach((s, idx) => map.set(s.id, idx === 0 ? 'y' : `y${idx + 1}`));
    return map;
  }, [visibleSeries]);

  // Latest legend-click handler, read from a ref so the Plotly event listener
  // (attached once) always calls the current callback without re-binding.
  const onSeriesToggleRef = useRef(options.onSeriesToggle);
  useEffect(() => {
    onSeriesToggleRef.current = options.onSeriesToggle;
  }, [options.onSeriesToggle]);

  const plotData = useMemo<Partial<PlotData>[]>(() => {
    const traces: Partial<PlotData>[] = [];
    visibleSeries.forEach((s, idx) => {
      const color =
        s.color ??
        (idx === 0
          ? primaryStroke
          : DEFAULT_COLORS[idx % DEFAULT_COLORS.length]!);
      const yAxisRef = perAxis ? (axisForSeries.get(s.id) ?? 'y') : undefined;
      const points = logY ? s.points.filter((p) => p.y > 0) : s.points;
      const xs = points.map((p) => p.x);
      const labels = useClock
        ? points.map(
            (p) => p.label ?? hoursToClockTime(p.x, options.referenceTime!),
          )
        : undefined;
      const bandPoints = logY
        ? points.filter((p) => (p.lo ?? p.y) > 0 && (p.hi ?? p.y) > 0)
        : points;
      const bandXs = bandPoints.map((p) => p.x);
      const reversed = bandPoints.slice().reverse();

      if (
        showBands &&
        s.showUncertainty !== false &&
        bandPoints.some((p) => p.lo != null && p.hi != null)
      ) {
        traces.push({
          x: [...bandXs, ...reversed.map((p) => p.x)],
          y: [
            ...bandPoints.map((p) => p.hi ?? p.y),
            ...reversed.map((p) => p.lo ?? p.y),
          ],
          fill: 'toself',
          fillcolor: colorWithAlpha(color, s.dimmed ? 0.05 : 0.12),
          line: { color: 'transparent' },
          type: 'scatter',
          mode: 'lines',
          name: `${s.label} 5–95%`,
          legendgroup: s.id,
          showlegend: false,
          hoverinfo: 'skip',
          yaxis: yAxisRef,
        });
      }

      if (
        showBands &&
        s.showUncertainty !== false &&
        bandPoints.some((p) => p.loInner != null && p.hiInner != null)
      ) {
        traces.push({
          x: [...bandXs, ...reversed.map((p) => p.x)],
          y: [
            ...bandPoints.map((p) => p.hiInner ?? p.y),
            ...reversed.map((p) => p.loInner ?? p.y),
          ],
          fill: 'toself',
          fillcolor: colorWithAlpha(color, s.dimmed ? 0.1 : 0.26),
          line: { color: 'transparent' },
          type: 'scatter',
          mode: 'lines',
          name: `${s.label} 25–75%`,
          legendgroup: s.id,
          showlegend: false,
          hoverinfo: 'skip',
          yaxis: yAxisRef,
        });
      }

      traces.push({
        x: xs,
        y: points.map((p) => p.y),
        text: labels,
        type: 'scatter',
        mode: 'lines',
        name: s.dimmed ? `${s.label} ⚠` : s.label,
        legendgroup: s.id,
        line: {
          color: s.dimmed ? colorWithAlpha(color, 0.4) : color,
          width: 2.5,
          dash: s.dimmed ? 'dot' : 'solid',
        },
        showlegend: options.showLegend ?? visibleSeries.length > 1,
        yaxis: yAxisRef,
        hovertemplate: useClock
          ? `<b>${s.label}</b><br>${t('modeling.workspace.chart.time')} = %{text}<br>${t('modeling.workspace.chart.value')} = %{y:.3f}${s.unit ? ` ${s.unit}` : ''}<extra></extra>`
          : `<b>${s.label}</b><br>${t('modeling.workspace.chart.time')} = %{x:.2f} h<br>${t('modeling.workspace.chart.value')} = %{y:.3f}${s.unit ? ` ${s.unit}` : ''}<extra></extra>`,
      });

      if (s.markers && s.markers.length > 0) {
        traces.push({
          ...markerTrace(
            logY ? s.markers.filter((m) => m.y > 0) : s.markers,
            color,
            useClock
              ? `%{text}<br>${t('modeling.workspace.chart.time')} = %{x:.2f} h<br>${t('modeling.workspace.chart.value')} = %{y:.3f}${s.unit ? ` ${s.unit}` : ''}<extra></extra>`
              : `%{text}<br>${t('modeling.workspace.chart.time')} = %{x:.2f} h<br>${t('modeling.workspace.chart.value')} = %{y:.3f}${s.unit ? ` ${s.unit}` : ''}<extra></extra>`,
          ),
          yaxis: yAxisRef,
        });
      }
    });

    const markers = options.markers ?? [];
    if (markers.length > 0) {
      traces.push(
        markerTrace(
          logY ? markers.filter((m) => m.y > 0) : markers,
          '#0f172a',
          `%{text}<br>${t('modeling.workspace.chart.time')} = %{x:.2f} h<br>${t('modeling.workspace.chart.value')} = %{y:.3f}<extra></extra>`,
        ),
      );
    }

    return traces;
  }, [
    visibleSeries,
    logY,
    showBands,
    useClock,
    options.referenceTime,
    options.showLegend,
    options.markers,
    primaryStroke,
    perAxis,
    axisForSeries,
    t,
  ]);
  const hasPlotData = plotData.length > 0;

  const layout = useMemo<Partial<Layout>>(() => {
    const allY = visibleSeries.flatMap((s) => [
      ...s.points.map((p) => p.hi ?? p.y),
      ...(s.markers ?? []).map((m) => m.y),
    ]);
    // Only reference lines that opt into the fit expand the y-range; a far-above
    // line (e.g. lethal) is still drawn but must not leave a big empty band.
    const lineY = (options.referenceLines ?? [])
      .filter((line) => line.includeInRange !== false)
      .map((line) => line.y);
    // A band that opts into the fit expands the range to its upper edge, so a
    // pooled forensic band sitting above the curve is not clipped away.
    const bandY = (options.referenceBands ?? [])
      .filter((band) => band.includeInRange !== false)
      .map((band) => Math.max(band.y0, band.y1));
    const yMax = niceTop(
      Math.max(finiteMax(allY), finiteMax(lineY), finiteMax(bandY), 1e-9) * 1.12,
    );
    const xs = visibleSeries.flatMap((s) => s.points.map((p) => p.x));
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const seriesRange: [number, number] | undefined =
      Number.isFinite(xMin) && Number.isFinite(xMax) ? [xMin, xMax] : undefined;
    // An explicit window (e.g. shared with the event timeline) wins over the
    // series-derived range so both axes cover the exact same span.
    const xRange = options.xRange ?? seriesRange;

    // Ticks handed in from a companion timeline take priority so the two axes
    // land their labels on identical positions; otherwise fall back to the
    // clock sampling of the series points.
    const explicitTicks = options.xTickHours;
    const xTickConfig =
      explicitTicks && explicitTicks.length > 0
        ? {
            tickmode: 'array' as const,
            tickvals: explicitTicks,
            ticktext: explicitTicks.map((h) =>
              useClock ? hoursToClockTime(h, options.referenceTime!) : `${h} h`,
            ),
          }
        : useClock
          ? {
              tickmode: 'array' as const,
              tickvals: visibleSeries[0]?.points
                .filter(
                  (_, i, arr) =>
                    i % Math.max(1, Math.ceil(arr.length / 8)) === 0,
                )
                .map((p) => p.x),
              ticktext: visibleSeries[0]?.points
                .filter(
                  (_, i, arr) =>
                    i % Math.max(1, Math.ceil(arr.length / 8)) === 0,
                )
                .map((p) => hoursToClockTime(p.x, options.referenceTime!)),
            }
          : {};

    // --- Per-drug axes -----------------------------------------------------
    // Group reference lines by owning series so each drug's axis includes its
    // own thresholds in the fit.
    const refLinesBySeries = new Map<string, ModelingReferenceLine[]>();
    for (const line of options.referenceLines ?? []) {
      const key = line.seriesId ?? '';
      const list = refLinesBySeries.get(key);
      if (list) list.push(line);
      else refLinesBySeries.set(key, [line]);
    }
    const bandsBySeries = new Map<string, ModelingReferenceBand[]>();
    for (const band of options.referenceBands ?? []) {
      const key = band.seriesId ?? '';
      const list = bandsBySeries.get(key);
      if (list) list.push(band);
      else bandsBySeries.set(key, [band]);
    }
    const seriesAxisTop = (s: ModelingSeries): number => {
      const ys = [
        ...s.points.map((p) => p.hi ?? p.y),
        ...(s.markers ?? []).map((m) => m.y),
      ];
      const lineYs = (refLinesBySeries.get(s.id) ?? [])
        .filter((l) => l.includeInRange !== false)
        .map((l) => l.y);
      const bandYs = (bandsBySeries.get(s.id) ?? [])
        .filter((b) => b.includeInRange !== false)
        .map((b) => Math.max(b.y0, b.y1));
      return niceTop(
        Math.max(finiteMax(ys), finiteMax(lineYs), finiteMax(bandYs), 1e-9) *
          1.12,
      );
    };
    // Reference-line/annotation y-anchor: a drug's threshold sits on that drug's
    // axis when per-drug axes are active, otherwise on the single shared axis.
    const yrefFor = (seriesId?: string): 'y' =>
      (perAxis
        ? (axisForSeries.get(seriesId ?? '') ?? 'y')
        : 'y') as unknown as 'y';

    const AXIS_OFFSET = 0.08;
    let leftExtra = 0;
    let rightExtra = 0;
    if (perAxis) {
      visibleSeries.forEach((_, i) => {
        if (i >= 2) {
          if (i % 2 === 0) leftExtra += 1;
          else rightExtra += 1;
        }
      });
    }
    // Shrink the plot's x-domain to make room for any 3rd+ axis drawn in the
    // left/right gutter, so their tick labels aren't clipped.
    const xDomain: [number, number] | undefined = perAxis
      ? [
          Math.min(0.35, leftExtra * AXIS_OFFSET),
          Math.max(0.65, 1 - rightExtra * AXIS_OFFSET),
        ]
      : undefined;
    const yAxes: Record<string, Record<string, unknown>> = {};
    if (perAxis) {
      let lFree = 0;
      let rFree = 0;
      visibleSeries.forEach((s, i) => {
        const key = i === 0 ? 'yaxis' : `yaxis${i + 1}`;
        const color =
          s.color ??
          (i === 0
            ? primaryStroke
            : DEFAULT_COLORS[i % DEFAULT_COLORS.length]!);
        const common: Record<string, unknown> = {
          title: { text: s.label, font: { size: 11, color } },
          color,
          gridcolor: gridColor,
          type: logY ? 'log' : 'linear',
          automargin: true,
          ...(logY ? {} : { range: [0, seriesAxisTop(s)] }),
        };
        if (i === 0) {
          yAxes[key] = common;
        } else if (i === 1) {
          yAxes[key] = { ...common, overlaying: 'y', side: 'right', anchor: 'x' };
        } else if (i % 2 === 0) {
          yAxes[key] = {
            ...common,
            overlaying: 'y',
            side: 'left',
            anchor: 'free',
            position: lFree * AXIS_OFFSET,
            showgrid: false,
          };
          lFree += 1;
        } else {
          yAxes[key] = {
            ...common,
            overlaying: 'y',
            side: 'right',
            anchor: 'free',
            position: 1 - rFree * AXIS_OFFSET,
            showgrid: false,
          };
          rFree += 1;
        }
      });
    }

    const layoutResult = {
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: fontColor ? { color: fontColor } : undefined,
      // Stack the (hover-only) toolbar vertically so it occupies a slim strip in
      // the corner instead of a wide bar across the top edge.
      modebar: { orientation: 'v' },
      margin: {
        t: options.title
          ? MODELING_CHART_MARGIN.topWithTitle
          : MODELING_CHART_MARGIN.top,
        r: MODELING_CHART_MARGIN.right,
        b: MODELING_CHART_MARGIN.bottom,
        l: MODELING_CHART_MARGIN.left,
      },
      showlegend: options.showLegend ?? visibleSeries.length > 1,
      legend: {
        orientation: 'h',
        y: 1.08,
        x: 0,
        bgcolor: legendBg,
      },
      hovermode: 'x',
      title: options.title
        ? { text: options.title, font: { size: 13 } }
        : undefined,
      xaxis: {
        title: {
          text: options.xAxisTitle ?? t('modeling.workspace.chart.xAxisHours'),
          font: { size: 11 },
        },
        gridcolor: gridColor,
        ...(xRange ? { range: xRange } : {}),
        ...(xDomain ? { domain: xDomain } : {}),
        ...xTickConfig,
      },
      // Per-drug axes are assigned below via Object.assign(yAxes); the single
      // shared axis is used only when they are off.
      yaxis: perAxis
        ? undefined
        : {
            title: {
              text: options.yAxisTitle ?? t('modeling.workspace.chart.yAxis'),
              font: { size: 11 },
            },
            gridcolor: gridColor,
            type: logY ? 'log' : 'linear',
            ...(logY ? {} : { range: [0, yMax] }),
          },
      shapes: [
        // Vertical event lines projected from the companion timeline. Drawn
        // first (and below the curves) so they read as background guides.
        ...(options.timeMarkers?.map((marker) => ({
          type: 'line' as const,
          xref: 'x' as const,
          yref: 'paper' as const,
          x0: marker.x,
          x1: marker.x,
          y0: 0,
          y1: 1,
          layer: 'below' as const,
          opacity: 0.5,
          line: {
            color: marker.color ?? primaryStroke,
            width: 1,
            dash: marker.dash ?? 'dot',
          },
        })) ?? []),
        // Shaded ranges (e.g. forensic bands) sit below the curves so they read
        // as context. Drawn before the reference lines so a representative line
        // stays legible on top of its own band.
        ...(options.referenceBands?.map((band) => ({
          type: 'rect' as const,
          xref: 'paper' as const,
          yref: yrefFor(band.seriesId),
          x0: 0,
          x1: 1,
          y0: Math.min(band.y0, band.y1),
          y1: Math.max(band.y0, band.y1),
          fillcolor: band.color ?? 'rgba(100,116,139,0.2)',
          line: { width: 0 },
          layer: 'below' as const,
        })) ?? []),
        ...(options.referenceLines?.map((line) => ({
          type: 'line' as const,
          xref: 'paper' as const,
          yref: yrefFor(line.seriesId),
          x0: 0,
          x1: 1,
          y0: line.y,
          y1: line.y,
          line: {
            color: line.color ?? '#ef4444',
            width: 1.5,
            dash: line.dash ?? 'dash',
          },
        })) ?? []),
      ],
      annotations: [
        // Reference-line labels are anchored to the LEFT plot edge so they stay
        // clear of the (hover-only) modebar in the top-right corner.
        ...(options.referenceLines?.map((line) => ({
          xref: 'paper' as const,
          yref: yrefFor(line.seriesId),
          x: 0,
          y: line.y,
          text: line.label,
          showarrow: false,
          xanchor: 'left' as const,
          yanchor: 'bottom' as const,
          font: { size: 11, color: line.color ?? annotationColor },
          bgcolor: annotationBg,
          borderpad: 2,
        })) ?? []),
        // Band captions sit at the upper edge, left-anchored like the line
        // labels. Only bands that carry a label draw one.
        ...(options.referenceBands ?? [])
          .filter((band) => band.label)
          .map((band) => ({
            xref: 'paper' as const,
            yref: yrefFor(band.seriesId),
            x: 0,
            y: Math.max(band.y0, band.y1),
            text: band.label!,
            showarrow: false,
            xanchor: 'left' as const,
            yanchor: 'bottom' as const,
            font: {
              size: 10,
              color: band.labelColor ?? band.color ?? annotationColor,
            },
            bgcolor: annotationBg,
            borderpad: 2,
          })),
        // Labelled curve-feature guides (Tmax): a small caption at the top of
        // the vertical line.
        ...(options.timeMarkers ?? [])
          .filter((m) => m.annotate && m.label)
          .map((m) => ({
            xref: 'x' as const,
            yref: 'paper' as const,
            x: m.x,
            y: 1,
            text: m.label,
            showarrow: false,
            xanchor: 'left' as const,
            yanchor: 'bottom' as const,
            font: { size: 10, color: m.color ?? primaryStroke },
            bgcolor: annotationBg,
            borderpad: 1,
          })),
      ],
    } as Partial<Layout>;
    // Attach the per-drug y-axes (yaxis, yaxis2, …). Object.assign keeps the
    // dynamic axis keys off the statically-typed literal above.
    if (perAxis) Object.assign(layoutResult, yAxes);
    return layoutResult;
  }, [
    visibleSeries,
    options,
    fontColor,
    legendBg,
    gridColor,
    useClock,
    logY,
    t,
    annotationColor,
    annotationBg,
    primaryStroke,
    perAxis,
    axisForSeries,
  ]);

  const config: Partial<Config> = useMemo(
    () => ({
      responsive: true,
      // Only reveal the toolbar on hover, and drop the redundant/rarely-used
      // buttons, so it stops crowding the top-right corner and overlapping the
      // reference-line labels. ('hover' is valid at runtime but missing from the
      // basic-dist typings, which only expose boolean.)
      displayModeBar: 'hover' as unknown as boolean,
      modeBarButtonsToRemove: [
        'lasso2d',
        'select2d',
        'zoomIn2d',
        'zoomOut2d',
        'autoScale2d',
      ] as string[],
      displaylogo: false,
    }),
    [],
  );

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    let cancelled = false;

    if (!hasPlotData) {
      if (plotRef.current) {
        plotlyRef.current?.purge(root);
        plotRef.current = null;
      }
      return;
    }

    void loadPlotly()
      .then((Plotly) => {
        if (cancelled || containerRef.current !== root) return;
        plotlyRef.current = Plotly;

        if (!plotRef.current) {
          void Plotly.newPlot(root, plotData, layout, config).then((el) => {
            if (cancelled) return;
            plotRef.current = el;
            // Drive series visibility from the host store instead of Plotly's
            // local trace hide, so a drug's threshold lines and labels toggle
            // together with its curve. Returning false suppresses the default.
            const on = (
              el as unknown as {
                on?: (
                  event: string,
                  cb: (e: {
                    curveNumber: number;
                    data?: Array<{ legendgroup?: string }>;
                  }) => boolean | void,
                ) => void;
              }
            ).on;
            if (typeof on === 'function') {
              on.call(el, 'plotly_legendclick', (e) => {
                const cb = onSeriesToggleRef.current;
                if (!cb) return true;
                const group = e?.data?.[e.curveNumber]?.legendgroup;
                if (typeof group === 'string' && group) {
                  cb(group);
                  return false;
                }
                return true;
              });
            }
          });
        } else {
          void Plotly.react(root, plotData, layout, config);
        }
      })
      .catch((err) => {
        if (!cancelled) console.error('Failed to load Plotly chart:', err);
      });

    return () => {
      cancelled = true;
    };
  }, [hasPlotData, plotData, layout, config]);

  useEffect(() => {
    return () => {
      if (containerRef.current) plotlyRef.current?.purge(containerRef.current);
    };
  }, []);

  const onLogChange = (enabled: boolean) => {
    setLocalLogY(enabled);
    options.onLogYChange?.(enabled);
  };

  return (
    <div
      role="figure"
      aria-label={
        options.ariaLabel ??
        options.title ??
        t('modeling.workspace.chart.ariaLabel')
      }
      className="space-y-2"
    >
      {options.showLogToggle && (
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <span>{t('modeling.workspace.chart.logY')}</span>
          <Switch
            checked={logY}
            onCheckedChange={onLogChange}
            aria-label={t('modeling.workspace.chart.logY')}
          />
        </div>
      )}
      <div
        className="relative w-full rounded-lg border border-border bg-card"
        style={{ height: `${options.height ?? 360}px` }}
      >
        <div ref={containerRef} className="h-full w-full" />
        {!hasPlotData && (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-muted-foreground">
            {options.emptyMessage ?? t('modeling.workspace.chart.empty')}
          </div>
        )}
      </div>
    </div>
  );
}
