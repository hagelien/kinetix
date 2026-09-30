import type { ModelingSeries } from '@/types/modeling';
import type { CaseDisplaySettings } from '@/types/simulator';

/**
 * A single chart panel. Incompatible units must never share a y-axis, so the
 * chart is split into genuine small multiples — one panel per unit — rather
 * than overlaying e.g. mg/L, g/dL and molar series under one "concentration"
 * axis.
 */
export interface ChartPanel {
  key: string;
  /** Shared unit of the panel's series, if they have one. */
  unit?: string;
  series: ModelingSeries[];
}

/**
 * Group series into chart panels:
 *  - normalized view → a single dimensionless panel (every series is a ratio);
 *  - "separate" mode → one panel per series;
 *  - otherwise        → one panel per unit, preserving first-seen unit order.
 */
export function buildChartPanels(
  series: ModelingSeries[],
  opts: { mode: CaseDisplaySettings['mode']; normalized: boolean },
): ChartPanel[] {
  if (series.length === 0) return [];
  if (opts.normalized) {
    return [{ key: 'normalized', series }];
  }
  if (opts.mode === 'separate') {
    return series.map((s) => ({ key: s.id, unit: s.unit, series: [s] }));
  }
  const order: string[] = [];
  const byUnit = new Map<string, ModelingSeries[]>();
  for (const s of series) {
    const u = s.unit ?? '';
    if (!byUnit.has(u)) {
      byUnit.set(u, []);
      order.push(u);
    }
    byUnit.get(u)!.push(s);
  }
  return order.map((u) => ({
    key: u || 'unitless',
    unit: u || undefined,
    series: byUnit.get(u)!,
  }));
}
