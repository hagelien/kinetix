import type { EthanolSimulationOutput } from '@/lib/ethanolEngine';
import type { PosteriorPredictivePoint } from '@/lib/compute/inference';
import type { InferenceResult, SimulationResult } from '@/lib/compute/types';
import type { WorkerInferenceOutput } from '@/workers/inference.worker';
import type { DrugSimResult, NormalizeMode } from '@/types/simulator';
import type {
  ModelingMarker,
  ModelingReferenceLine,
  ModelingSeries,
} from '@/types/modeling';

interface KinelabRunResultLike {
  predictive: PosteriorPredictivePoint[];
}

export interface SimulatorSeriesAdapterOptions {
  labels?: Record<string, string>;
  colors?: Record<string, string>;
  visibleIds?: Set<string>;
  normalizeMode?: NormalizeMode;
  /** Component ids whose result is out of date — rendered dimmed. */
  staleIds?: Set<string>;
  /**
   * Per-series multiplier that re-expresses the plotted whole-blood curve in the
   * chart's display matrix (`1/(B:P)` for serum/plasma). Applied to the plotted
   * points only — never to the canonical scalar readouts (the "Svar" answer, the
   * inferred dose) — so a matrix view stays a chart-display concern. Absent or 1
   * means whole blood / no conversion. See `src/lib/matrixDisplay.ts`.
   */
  matrixFactors?: Record<string, number>;
}

function normalizeSimulatorPoints(
  result: DrugSimResult,
  mode: NormalizeMode = 'none',
): DrugSimResult['timeSeries'] {
  const points = result.timeSeries;
  if (mode === 'none' || points.length === 0) return points;
  const divisor =
    mode === 'peak'
      ? Math.max(...points.map((p) => p.median)) || 1
      : points[0]!.median || 1;
  return points.map((p) => ({
    t: p.t,
    median: p.median / divisor,
    p05: p.p05 / divisor,
    p25: p.p25 / divisor,
    p75: p.p75 / divisor,
    p95: p.p95 / divisor,
  }));
}

export function simulatorResultsToModelingSeries(
  results: Record<string, DrugSimResult>,
  options: SimulatorSeriesAdapterOptions = {},
): ModelingSeries[] {
  return Object.entries(results)
    .filter(([id]) => options.visibleIds?.has(id) ?? true)
    .map(([id, result]) => {
      // Shift the curve from its engine-relative frame onto the absolute event
      // frame so it lines up with the dose/prediction guide lines and the event
      // timeline. Legacy results without a stamp keep the old relative frame.
      const anchor = result.anchorTime ?? 0;
      // Matrix factor scales the plotted whole-blood curve into the display
      // matrix. `normalizeMode` divides by the curve's own peak, so a uniform
      // factor cancels out there — apply it only in absolute modes.
      const f =
        options.normalizeMode && options.normalizeMode !== 'none'
          ? 1
          : (options.matrixFactors?.[id] ?? 1);
      return {
        id,
        label: options.labels?.[id] ?? id,
        color: options.colors?.[id],
        // The curve's own unit: in `dose-from-concentration` the scalar answer
        // is a dose but the plotted series is still a concentration.
        unit: result.curveUnit ?? result.unit,
        visible: true,
        showUncertainty: true,
        dimmed: options.staleIds?.has(id) ?? false,
        points: normalizeSimulatorPoints(result, options.normalizeMode).map(
          (p) => ({
            x: p.t + anchor,
            y: p.median * f,
            lo: p.p05 * f,
            hi: p.p95 * f,
            loInner: p.p25 * f,
            hiInner: p.p75 * f,
          }),
        ),
      };
    });
}

export function computeSimulationToModelingSeries(
  result: SimulationResult,
  options: { id?: string; label?: string; color?: string } = {},
): ModelingSeries[] {
  return [
    {
      id: options.id ?? result.modelId,
      label: options.label ?? result.modelId,
      color: options.color,
      unit: result.unit,
      showUncertainty: true,
      points: result.timeSeries.map((p) => ({
        x: p.t,
        y: p.median,
        lo: p.p05,
        hi: p.p95,
        loInner: p.p25,
        hiInner: p.p75,
      })),
    },
  ];
}

export function kinelabPredictiveToModelingSeries(
  points: PosteriorPredictivePoint[],
  options: {
    id?: string;
    label?: string;
    color?: string;
    unit?: string;
    observations?: Array<{
      tHours: number;
      concentration: number;
      label?: string;
    }>;
  } = {},
): ModelingSeries[] {
  const id = options.id ?? 'kinelab-posterior-predictive';
  return [
    {
      id,
      label: options.label ?? 'Posterior predictive',
      color: options.color,
      unit: options.unit ?? 'mg/L',
      showUncertainty: true,
      points: points.map((p) => ({
        x: p.t,
        y: p.median,
        lo: p.p05,
        hi: p.p95,
        loInner: p.p25,
        hiInner: p.p75,
      })),
      markers: options.observations?.map((o, idx) => ({
        x: o.tHours,
        y: o.concentration,
        label: o.label ?? `Observation ${idx + 1}`,
        color: '#f59e0b',
        seriesId: id,
      })),
    },
  ];
}

export function kinelabRunResultToModelingSeries(
  result: KinelabRunResultLike,
  options: Parameters<typeof kinelabPredictiveToModelingSeries>[1] = {},
): ModelingSeries[] {
  return kinelabPredictiveToModelingSeries(result.predictive, options);
}

export function workerInferenceOutputToModelingSeries(
  output: WorkerInferenceOutput,
  options: Parameters<typeof kinelabPredictiveToModelingSeries>[1] = {},
): ModelingSeries[] {
  return kinelabPredictiveToModelingSeries(output.predictive, options);
}

export function kinelabInferenceResultToModelingSeries(
  result: InferenceResult,
  options: Parameters<typeof kinelabPredictiveToModelingSeries>[1] = {},
): ModelingSeries[] {
  return kinelabPredictiveToModelingSeries(
    result.posteriorPredictive?.timeSeries ?? [],
    { unit: result.posteriorPredictive?.unit, ...options },
  );
}

export function ethanolBacToModelingSeries(
  bacCurve: EthanolSimulationOutput,
  options: { id?: string; label?: string; color?: string } = {},
): ModelingSeries[] {
  return [
    {
      id: options.id ?? 'ethanol-bac',
      label: options.label ?? 'Ethanol BAC',
      color: options.color ?? '#f97316',
      unit: 'g/dL',
      showUncertainty: false,
      points: bacCurve.points.map((p) => ({ x: p.t, y: p.bacGdl })),
    },
  ];
}

export function ethanolLegalLimitsToReferenceLines(
  limits: Array<{
    value: number;
    label: string;
    color?: string;
    dash?: ModelingReferenceLine['dash'];
  }>,
): ModelingReferenceLine[] {
  return limits.map((limit) => ({
    y: limit.value,
    label: limit.label,
    color: limit.color,
    dash: limit.dash,
  }));
}

export function pointAnnotationsToModelingMarkers(
  annotations: Array<{ x: number; y: number; label: string; color?: string }>,
): ModelingMarker[] {
  return annotations.map((a) => ({ ...a }));
}
