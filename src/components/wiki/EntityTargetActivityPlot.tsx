import { useId } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { formatWithMaxDecimals } from '@/lib/rangeUtils';
import {
  formatPlotPointValue,
  type ActivityGroup,
  type ActivityPlot,
  type ActivityPlotPoint,
} from '@/lib/entityTargetLigands';
import type { EntityTargetLigand } from '@/lib/receptorTargets';

export const ACTIVITY_GROUP_LABEL_KEYS: Record<ActivityGroup, string> = {
  agonist: 'bioEntity.activityAgonist',
  partial_agonist: 'bioEntity.activityPartialAgonist',
  inverse_agonist: 'bioEntity.activityInverseAgonist',
  antagonist: 'bioEntity.activityAntagonist',
  positive_allosteric_modulator: 'bioEntity.activityPam',
  negative_allosteric_modulator: 'bioEntity.activityNam',
  inhibitor: 'bioEntity.activityInhibitor',
  other: 'bioEntity.activityOther',
};

interface Axis {
  min: number;
  max: number;
  ticks: number[];
  /** 0–100 position of a value along the track. */
  position: (value: number) => number;
}

function pointExtent(points: ActivityPlotPoint[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    for (const v of [p.value, p.low, p.high]) {
      if (v === null || !Number.isFinite(v)) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  return [lo, hi];
}

function logAxis(points: ActivityPlotPoint[]): Axis {
  const [lo, hi] = pointExtent(points);
  let min = Math.floor(Math.log10(lo));
  let max = Math.ceil(Math.log10(hi));
  if (max <= min) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  // Keep the tick labels legible on a narrow screen: at most ~7 decades.
  const step = Math.max(1, Math.ceil(span / 6));
  const ticks: number[] = [];
  for (let e = min; e <= max; e += step) ticks.push(10 ** e);
  return {
    min: 10 ** min,
    max: 10 ** max,
    ticks,
    position: (value) =>
      Math.min(100, Math.max(0, ((Math.log10(value) - min) / span) * 100)),
  };
}

function linearAxis(points: ActivityPlotPoint[]): Axis {
  const [lo, hi] = pointExtent(points);
  const min = Math.min(0, lo);
  const max = hi > min ? hi : min + 1;
  const ticks = Array.from({ length: 5 }, (_, i) => min + ((max - min) * i) / 4);
  return {
    min,
    max,
    ticks,
    position: (value) =>
      Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)),
  };
}

interface EntityTargetActivityPlotProps {
  plot: ActivityPlot;
  metricLabel: string;
  drugName: (ligand: EntityTargetLigand) => string;
  drugHref: (ligand: EntityTargetLigand) => string;
  activityLabel: (ligand: EntityTargetLigand) => string;
  speciesLabel: (ligand: EntityTargetLigand) => string;
}

/**
 * Activity-grouped dot plot of one measurement across the ligands of a
 * target. One metric at a time on one axis — concentrations in nM on a log
 * scale, anything else linear in its single stored unit. A two-sided range
 * draws as a bar around its representative point.
 *
 * Drawn with positioned HTML rather than a chart library so every point is an
 * ordinary focusable link to the drug's monograph, carrying its full detail as
 * accessible text; the value is also printed beside each row, so nothing is
 * reachable by hover alone. The ligand table remains the canonical view.
 */
export function EntityTargetActivityPlot({
  plot,
  metricLabel,
  drugName,
  drugHref,
  activityLabel,
  speciesLabel,
}: EntityTargetActivityPlotProps) {
  const { t } = useTranslation();
  const captionId = useId();
  const points = plot.groups.flatMap((g) => g.points);
  const axis = plot.scale === 'log' ? logAxis(points) : linearAxis(points);
  const unit = plot.unit;
  const axisLabel =
    plot.scale === 'log'
      ? t('bioEntity.plotAxisLog', { metric: metricLabel, unit })
      : unit
        ? t('bioEntity.plotAxisLinear', { metric: metricLabel, unit })
        : t('bioEntity.plotAxisLinearUnitless', { metric: metricLabel });
  const formatValue = (p: ActivityPlotPoint) => formatPlotPointValue(p, unit);
  const formatTick = (value: number) => formatWithMaxDecimals(value, 3);

  const rowGrid =
    'grid grid-cols-[minmax(5rem,9rem)_minmax(8rem,1fr)_minmax(4.5rem,auto)] items-center gap-2';

  return (
    <figure
      className="mt-4"
      aria-labelledby={captionId}
      data-testid="target-activity-plot"
    >
      <figcaption id={captionId} className="mb-2 text-xs text-muted-foreground">
        {t('bioEntity.plotLabel', { metric: metricLabel })} — {axisLabel}
      </figcaption>
      <div className="space-y-3">
        {plot.groups.map((group) => (
          <div key={group.group} role="group" aria-label={t(ACTIVITY_GROUP_LABEL_KEYS[group.group])}>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t(ACTIVITY_GROUP_LABEL_KEYS[group.group])}
            </div>
            <ul className="space-y-1">
              {group.points.map((p) => {
                const name = drugName(p.ligand);
                const value = formatValue(p);
                const detail = t('bioEntity.pointDetail', {
                  drug: name,
                  activity: activityLabel(p.ligand),
                  metric: metricLabel,
                  value,
                  species: speciesLabel(p.ligand),
                  references: t('bioEntity.referenceCount', {
                    count: p.ligand.referenceIds.length,
                  }),
                });
                const dot = axis.position(p.value);
                const start = p.low !== null ? axis.position(p.low) : null;
                const end = p.high !== null ? axis.position(p.high) : null;
                return (
                  <li
                    key={p.ligand.relationshipId}
                    className={`${rowGrid} text-xs`}
                    data-testid="target-plot-point"
                    data-drug={p.ligand.drugSlug}
                  >
                    <span className="truncate font-medium" title={name}>
                      {name}
                    </span>
                    <div className="relative h-5">
                      <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-border" />
                      {start !== null && end !== null && (
                        <div
                          className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary/25"
                          style={{
                            left: `${Math.min(start, end)}%`,
                            width: `${Math.max(1, Math.abs(end - start))}%`,
                          }}
                        />
                      )}
                      <Link
                        to={drugHref(p.ligand)}
                        aria-label={detail}
                        title={detail}
                        className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        style={{ left: `${dot}%` }}
                      />
                    </div>
                    <span className="text-right tabular-nums text-muted-foreground">
                      {value}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        <div className={`${rowGrid} text-[10px] text-muted-foreground`} aria-hidden="true">
          <span />
          <div className="relative h-4">
            {axis.ticks.map((tick) => (
              <span
                key={tick}
                className="absolute -translate-x-1/2 tabular-nums"
                style={{ left: `${axis.position(tick)}%` }}
              >
                {formatTick(tick)}
              </span>
            ))}
          </div>
          <span className="text-right">{unit}</span>
        </div>
      </div>
    </figure>
  );
}
