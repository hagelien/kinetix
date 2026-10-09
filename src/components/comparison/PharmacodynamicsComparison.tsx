import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchDrugById } from '@/lib/drugApi';
import { formatRatio, relativeRatio } from '@/lib/comparison';
import {
  affinityStrength,
  buildPdTargetComparison,
  collectPdTargets,
  formatPdValue,
  pdHeadline,
  type PdDrugInput,
  type PdMetric,
  type PdMetricComparison,
  type PdTarget,
} from '@/lib/pdComparison';
import { formatInteractionLabel } from '@/lib/receptorInteractions';
import type {
  DrugReceptorTargetSummary,
  MechanismTier,
} from '@/lib/receptorTargets';

/** Conventional, language-neutral notation for the per-target measurements. */
const METRIC_SYMBOLS: Partial<Record<PdMetric, string>> = {
  ki: 'Ki',
  ec50: 'EC50',
  ic50: 'IC50',
  emax: 'Emax',
};

function useMetricLabel() {
  const { t } = useTranslation();
  return (metric: PdMetric) =>
    METRIC_SYMBOLS[metric] ?? t(`comparison.pd.metric.${metric}`);
}

function targetLabel(target: PdTarget, language: string): string {
  const name =
    language.startsWith('en') && target.nameEn ? target.nameEn : target.name;
  return name && name !== target.symbol ? name : '';
}

function pct(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || max <= min) return 50;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

/**
 * Loads the per-drug mechanism rows. The basket list endpoint serves only the
 * flat parameter columns; receptor mechanisms come with the single-drug read,
 * which is CDN-cached and shared with the monograph.
 */
function useReceptorTargets(drugIds: number[]) {
  const signature = drugIds.join(',');
  const [byDrug, setByDrug] = useState<
    Record<number, DrugReceptorTargetSummary[]>
  >({});
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ids = signature
      .split(',')
      .filter(Boolean)
      .map((id) => Number(id));
    if (!ids.length) {
      setByDrug({});
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    // A persisted basket can hold a drug that was since deleted or merged; one
    // rejected read must not discard the drugs that did load.
    Promise.allSettled(ids.map((id) => fetchDrugById(id)))
      .then((results) => {
        if (cancelled) return;
        const loaded: Record<number, DrugReceptorTargetSummary[]> = {};
        let firstError: unknown;
        let rejected = 0;
        for (const result of results) {
          if (result.status === 'fulfilled') {
            const { drug } = result.value;
            loaded[drug.id] = drug.receptorTargets ?? [];
          } else {
            rejected += 1;
            firstError ??= result.reason;
          }
        }
        setByDrug(loaded);
        if (rejected > 0) {
          // The raw message is API/browser prose (often English); log it and
          // show a localized notice instead, only when nothing loaded.
          console.error('Failed to load receptor mechanisms', firstError);
          setFailed(rejected === results.length);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [signature]);

  return { byDrug, loading, failed };
}

function TargetPicker({
  targets,
  selected,
  onToggle,
}: {
  targets: PdTarget[];
  selected: number[];
  onToggle: (targetId: number) => void;
}) {
  const { t } = useTranslation();
  const selectedSet = new Set(selected);
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {targets.map((target) => {
        const active = selectedSet.has(target.id);
        return (
          <button
            key={target.id}
            type="button"
            onClick={() => onToggle(target.id)}
            aria-pressed={active}
            title={t('comparison.pd.targetDrugCount', {
              count: target.drugCount,
            })}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              active
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground'
            }`}
          >
            {target.symbol}
            <span className="ml-1 opacity-70">({target.drugCount})</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Drugs × receptors overview: each cell carries the drug's strongest
 * affinity/potency reading at that receptor, shaded on a log scale so the
 * receptor profile (and selectivity) reads at a glance.
 */
function ReceptorProfileMatrix({
  drugs,
  targets,
  drugName,
}: {
  drugs: PdDrugInput[];
  targets: PdTarget[];
  drugName: (drugId: number) => string;
}) {
  const { t } = useTranslation();
  const metricLabel = useMetricLabel();
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-1 text-xs">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 pr-2 font-medium">{t('comparison.drug')}</th>
            {targets.map((target) => (
              <th
                key={target.id}
                className="px-1 py-1 text-center font-medium"
                title={target.nameEn ?? target.name}
              >
                {target.symbol}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {drugs.map((drug) => (
            <tr key={drug.id}>
              <td className="whitespace-nowrap py-1 pr-2 font-medium">
                {drugName(drug.id)}
              </td>
              {targets.map((target) => {
                const mechanisms = (drug.receptorTargets ?? []).filter(
                  (m) => m.target.id === target.id,
                );
                if (!mechanisms.length) {
                  return (
                    <td
                      key={target.id}
                      className="rounded bg-muted/30 px-2 py-1.5 text-center text-muted-foreground"
                    >
                      –
                    </td>
                  );
                }
                const headline = pdHeadline(mechanisms);
                const strength = affinityStrength(headline?.nanomolar ?? null);
                const interaction = formatInteractionLabel(
                  (headline?.mechanism ?? mechanisms[0]!).interactionType,
                  t,
                );
                return (
                  <td
                    key={target.id}
                    className="min-w-[6.5rem] rounded px-2 py-1.5 text-center"
                    style={{
                      backgroundColor:
                        strength === null
                          ? 'hsl(var(--primary) / 0.06)'
                          : `hsl(var(--primary) / ${(0.08 + strength * 0.4).toFixed(2)})`,
                    }}
                  >
                    <div className="font-medium tabular-nums">
                      {headline
                        ? `${metricLabel(headline.metric)} ${headline.formatted}`
                        : t('comparison.pd.noMeasurement')}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {interaction}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {t('comparison.pd.matrixLegend')}
      </p>
    </div>
  );
}

function MetricPlot({
  comparison,
  referenceDrugId,
  drugName,
}: {
  comparison: PdMetricComparison;
  referenceDrugId: number | null;
  drugName: (drugId: number) => string;
}) {
  const { t } = useTranslation();
  const metricLabel = useMetricLabel();
  const { values, direction, hasUnitMismatch } = comparison;
  const inverseStrength = direction === 'inverse';
  const reference =
    values.find((value) => value.drugId === referenceDrugId) ?? null;
  const populated = values.filter((value) => value.numeric !== null);
  // Concentration constants span orders of magnitude; plot them on a log axis.
  const useLog =
    inverseStrength && populated.every((value) => (value.numeric ?? 0) > 0);
  const project = (n: number) => (useLog ? Math.log10(n) : n);
  const lows = populated.map((value) => project(value.min ?? value.numeric!));
  const highs = populated.map((value) => project(value.max ?? value.numeric!));
  const axisMin = useLog ? Math.min(...lows) - 0.5 : Math.min(0, ...lows);
  const axisMax = useLog ? Math.max(...highs) + 0.5 : Math.max(...highs, 1);

  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium">{metricLabel(comparison.metric)}</h4>
        <span className="text-[11px] text-muted-foreground">
          {[
            comparison.commonUnit
              ? t('comparison.unit', { unit: comparison.commonUnit })
              : null,
            inverseStrength ? t('comparison.inverseStrength') : null,
            useLog ? t('comparison.logScale') : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      {hasUnitMismatch ? (
        <p className="mb-2 text-xs text-amber-800 dark:text-amber-200">
          {t('comparison.unitMismatch')}
        </p>
      ) : null}
      <div className="space-y-2">
        {values.map((value) => {
          const ratio =
            direction === null
              ? null
              : relativeRatio(
                  value.numeric,
                  reference?.numeric ?? null,
                  inverseStrength,
                );
          // Values in different units have no shared axis: list them only.
          const numeric = hasUnitMismatch ? null : value.numeric;
          const dot = numeric === null ? null : pct(project(numeric), axisMin, axisMax);
          const start =
            numeric === null
              ? 0
              : pct(project(value.min ?? numeric), axisMin, axisMax);
          const end =
            numeric === null
              ? 0
              : pct(project(value.max ?? numeric), axisMin, axisMax);
          return (
            <div
              key={value.drugId}
              className="grid grid-cols-[minmax(6rem,9rem)_1fr_minmax(4.5rem,auto)_3.5rem] items-center gap-2 text-xs"
            >
              <span className="truncate font-medium">
                {drugName(value.drugId)}
              </span>
              {dot === null ? (
                <span className="text-muted-foreground">
                  {value.numeric === null ? t('comparison.unavailable') : ''}
                </span>
              ) : (
                <div className="relative h-5">
                  <div className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-border" />
                  <div
                    className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-primary/25"
                    style={{
                      left: `${Math.min(start, end)}%`,
                      width: `${Math.max(2, Math.abs(end - start))}%`,
                    }}
                  />
                  <div
                    className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background"
                    style={{ left: `${dot}%` }}
                  />
                </div>
              )}
              <span className="text-right tabular-nums text-muted-foreground">
                {formatPdValue(value) || '-'}
              </span>
              <span
                className="text-right tabular-nums"
                title={t('comparison.pd.relativeHint')}
              >
                {formatRatio(ratio) || '-'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function tierLabel(
  tier: MechanismTier | null,
  t: (key: string) => string,
): string {
  switch (tier) {
    case 'primary':
      return t('comparison.pd.tier.primary');
    case 'secondary':
      return t('comparison.pd.tier.secondary');
    case 'tertiary':
      return t('comparison.pd.tier.tertiary');
    default:
      return '';
  }
}

function TargetComparisonCard({
  target,
  drugs,
  referenceDrugId,
  drugName,
}: {
  target: PdTarget;
  drugs: PdDrugInput[];
  referenceDrugId: number | null;
  drugName: (drugId: number) => string;
}) {
  const { t, i18n } = useTranslation();
  const comparison = useMemo(
    () => buildPdTargetComparison(target.id, drugs),
    [target.id, drugs],
  );
  const subtitle = targetLabel(target, i18n.language);

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-4">
        <h3 className="text-lg font-semibold">
          {target.symbol}
          {subtitle ? (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {subtitle}
            </span>
          ) : null}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t('comparison.pd.relativeTo', {
            drug: referenceDrugId !== null ? drugName(referenceDrugId) : '-',
          })}
        </p>
      </div>

      <div className="mb-4 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-2 pr-4 font-medium">{t('comparison.drug')}</th>
              <th className="py-2 pr-4 font-medium">
                {t('comparison.pd.mechanism')}
              </th>
              <th className="py-2 pr-4 font-medium">
                {t('comparison.pd.species')}
              </th>
            </tr>
          </thead>
          <tbody>
            {drugs.map((drug) => {
              const mechanisms = comparison.mechanismsByDrug.get(drug.id) ?? [];
              return (
                <tr key={drug.id} className="border-b border-border/60">
                  <td className="py-2 pr-4 font-medium">{drugName(drug.id)}</td>
                  <td className="py-2 pr-4">
                    {mechanisms.length
                      ? mechanisms
                          .map((m) =>
                            [
                              formatInteractionLabel(m.interactionType, t),
                              tierLabel(m.tier, t),
                            ]
                              .filter(Boolean)
                              .join(' · '),
                          )
                          .join('; ')
                      : t('comparison.pd.noMechanism')}
                  </td>
                  <td className="py-2 pr-4 text-muted-foreground">
                    {[
                      ...new Set(
                        mechanisms
                          .map((m) => m.assaySpecies)
                          .filter((s): s is string => Boolean(s)),
                      ),
                    ].join('; ') || '-'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {comparison.metrics.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {comparison.metrics.map((metric) => (
            <MetricPlot
              key={metric.metric}
              comparison={metric}
              referenceDrugId={referenceDrugId}
              drugName={drugName}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('comparison.pd.noMeasurements')}
        </p>
      )}
    </section>
  );
}

export function PharmacodynamicsComparison({
  drugIds,
  referenceDrugId,
  selectedTargetIds,
  onToggleTarget,
  drugName,
}: {
  drugIds: number[];
  referenceDrugId: number | null;
  selectedTargetIds: number[];
  onToggleTarget: (targetId: number) => void;
  drugName: (drugId: number) => string;
}) {
  const { t } = useTranslation();
  const { byDrug, loading, failed } = useReceptorTargets(drugIds);
  const drugs = useMemo<PdDrugInput[]>(
    () =>
      drugIds
        .filter((id) => id in byDrug)
        .map((id) => ({ id, receptorTargets: byDrug[id] })),
    [drugIds, byDrug],
  );
  const targets = useMemo(() => collectPdTargets(drugs), [drugs]);
  const selectedTargets = selectedTargetIds
    .map((id) => targets.find((target) => target.id === id))
    .filter((target): target is PdTarget => Boolean(target));

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">{t('comparison.pd.title')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('comparison.pd.body')}
        </p>
        {loading ? (
          <p className="mt-3 text-sm text-muted-foreground">
            {t('common.loading')}
          </p>
        ) : failed ? (
          <p className="mt-3 text-sm text-destructive">
            {t('comparison.pd.loadError')}
          </p>
        ) : targets.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            {t('comparison.pd.noTargets')}
          </p>
        ) : (
          <>
            <TargetPicker
              targets={targets}
              selected={selectedTargetIds}
              onToggle={onToggleTarget}
            />
            <ReceptorProfileMatrix
              drugs={drugs}
              targets={targets}
              drugName={drugName}
            />
          </>
        )}
      </section>

      {selectedTargets.map((target) => (
        <TargetComparisonCard
          key={target.id}
          target={target}
          drugs={drugs}
          referenceDrugId={referenceDrugId}
          drugName={drugName}
        />
      ))}
    </div>
  );
}
