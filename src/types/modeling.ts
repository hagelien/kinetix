export type ModelingModeAccent =
  | "simulator"
  | "kinelab"
  | "ethanol"
  | "neutral";

export interface ModelingPoint {
  /** X coordinate in hours from the mode-specific baseline. */
  x: number;
  /** Central/median Y value. */
  y: number;
  /** Optional lower bound for an uncertainty band. */
  lo?: number;
  /** Optional upper bound for an uncertainty band. */
  hi?: number;
  /** Optional inner lower bound (for example p25) for a darker band. */
  loInner?: number;
  /** Optional inner upper bound (for example p75) for a darker band. */
  hiInner?: number;
  /** Optional display label for clock/tooltip customizations. */
  label?: string;
}

export interface ModelingMarker {
  x: number;
  y: number;
  label: string;
  color?: string;
  seriesId?: string;
}

export interface ModelingReferenceLine {
  y: number;
  label: string;
  color?: string;
  dash?: "solid" | "dot" | "dash" | "longdash" | "dashdot" | "longdashdot";
  /**
   * Whether this line participates in the y-axis auto-fit. Defaults to `true`.
   * Set `false` for a line that should still be drawn but must not expand the
   * range (e.g. a lethal threshold far above the curve), so the plot can hug the
   * curve + nearby thresholds instead of leaving a large empty band.
   */
  includeInRange?: boolean;
  /**
   * The series this line belongs to. When the chart draws a separate y-axis per
   * series (per-drug axes), the line is anchored to that series' axis so it
   * lands at the right height on the correctly-scaled axis.
   */
  seriesId?: string;
}

/**
 * A shaded horizontal band spanning the full plot width between two y values —
 * used to draw a concentration RANGE (e.g. the span of postmortem findings for
 * a forensic category) rather than a single threshold line. Rendered below the
 * curves so it reads as context, never as a boundary the curve crosses.
 */
export interface ModelingReferenceBand {
  y0: number;
  y1: number;
  /** Fill colour, typically an rgba string whose alpha encodes evidence strength. */
  color?: string;
  /** Optional caption anchored at the band's upper edge. */
  label?: string;
  /** Text colour for the caption; falls back to the fill colour. */
  labelColor?: string;
  /** See {@link ModelingReferenceLine.includeInRange}. */
  includeInRange?: boolean;
  /** See {@link ModelingReferenceLine.seriesId}. */
  seriesId?: string;
}

/**
 * A vertical guide line at a specific time (x) — used to project a companion
 * timeline's event points onto the chart so the two stay in lockstep.
 */
export interface ModelingTimeMarker {
  /** X position in hours from the mode-specific baseline. */
  x: number;
  color?: string;
  /** Optional label, shown on hover of the guide line. */
  label?: string;
  dash?: ModelingReferenceLine["dash"];
  /**
   * When `true`, render the label as a small text annotation at the top of the
   * line (not just on hover) — used for curve features like Tmax that warrant a
   * persistent caption. Plain event guide lines leave this unset.
   */
  annotate?: boolean;
}

export interface ModelingSeries {
  id: string;
  label: string;
  points: ModelingPoint[];
  color?: string;
  unit?: string;
  visible?: boolean;
  showUncertainty?: boolean;
  /**
   * Render this series faded to signal it is out of date — its inputs changed
   * since it was computed. The curve stays visible so the user can still read
   * it, but it is visibly de-emphasised until re-run.
   */
  dimmed?: boolean;
  /** Markers coupled to this series, such as observed samples. */
  markers?: ModelingMarker[];
}

export interface ModelingChartOptions {
  accent?: ModelingModeAccent;
  title?: string;
  ariaLabel?: string;
  emptyMessage?: string;
  xAxisTitle?: string;
  yAxisTitle?: string;
  height?: number;
  showLegend?: boolean;
  showUncertaintyBands?: boolean;
  /**
   * Give each visible series its own independently-scaled y-axis (overlaid on
   * the shared x-axis) instead of one shared axis. Lets drugs with very
   * different concentration ranges be compared on one chart without the large
   * one flattening the small one. Ignored when fewer than two series are shown.
   */
  perSeriesAxis?: boolean;
  /**
   * Called when the user clicks a series in the legend. Lets the host drive
   * visibility from its own store (so a drug's threshold lines and labels toggle
   * with its curve), instead of Plotly's local-only trace hide. Returning is not
   * required — the chart suppresses Plotly's default toggle when this is set.
   */
  onSeriesToggle?: (seriesId: string) => void;
  /** Render y-axis as log scale. Non-positive values are omitted by Plotly. */
  logY?: boolean;
  showLogToggle?: boolean;
  onLogYChange?: (enabled: boolean) => void;
  /** Clock labels use x as hour offsets from referenceTime (HH:mm). */
  xFormat?: "hours" | "clock";
  referenceTime?: string;
  referenceLines?: ModelingReferenceLine[];
  /** Shaded horizontal ranges drawn below the curves (e.g. forensic bands). */
  referenceBands?: ModelingReferenceBand[];
  markers?: ModelingMarker[];
  /**
   * Explicit x-axis window `[from, to]` in hours. Overrides the series-derived
   * range so the chart can share a window with a companion timeline.
   */
  xRange?: [number, number];
  /**
   * Explicit x-axis tick positions in hours. When set, the chart renders ticks
   * at exactly these positions (clock- or hour-formatted) so they line up with
   * a companion timeline's ticks.
   */
  xTickHours?: number[];
  /**
   * Vertical guide lines at specific times (hours), e.g. the event markers of a
   * companion timeline. Rendered as full-height lines behind the curves.
   */
  timeMarkers?: ModelingTimeMarker[];
}
