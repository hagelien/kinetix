import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import type { PosteriorPredictivePoint } from '@/lib/compute/inference';

interface Props {
  points: PosteriorPredictivePoint[];
  observations?: Array<{ tHours: number; concentration: number }>;
  unit?: string;
  ariaLabel?: string;
}

// Lazy-load the Plotly-backed chart so /kinelab only pulls Plotly into the
// bundle when an inference result is actually rendered. Sharing the chunk
// with LazySimulatorGraph keeps Plotly to a single shared chunk.
const PosteriorPredictiveChartPlotly = lazy(() =>
  import('./PosteriorPredictiveChartPlotly').then((module) => ({
    default: module.PosteriorPredictiveChartPlotly,
  })),
);

const FALLBACK_HEIGHT_PX = 280;

function ChartFallback({ ariaLabel }: { ariaLabel?: string }) {
  const { t } = useTranslation();
  return (
    <div
      role="figure"
      aria-label={ariaLabel ?? t('kinelab.chart.ariaLabel')}
      className="flex items-center justify-center rounded-lg border border-dashed border-muted-foreground/30 bg-card/40 animate-pulse"
      style={{ height: FALLBACK_HEIGHT_PX }}
    />
  );
}

export function LazyPosteriorPredictiveChart(props: Props) {
  return (
    <Suspense fallback={<ChartFallback ariaLabel={props.ariaLabel} />}>
      <PosteriorPredictiveChartPlotly {...props} />
    </Suspense>
  );
}
