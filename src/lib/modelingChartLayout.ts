/**
 * Fixed Plotly plot-area margins (in px) shared by the modeling chart and the
 * companion event timeline.
 *
 * The chart forces these margins (no automargin), so the plotting area always
 * starts `left` px from the card's inner edge and ends `right` px before it.
 * The event timeline insets its track by the same left/right amounts, so an
 * event marker on the strip lines up horizontally with the chart's vertical
 * event line above it — keeping the two axes visually synchronized.
 */
export const MODELING_CHART_MARGIN = {
  top: 18,
  topWithTitle: 42,
  right: 18,
  bottom: 48,
  left: 58,
} as const;
