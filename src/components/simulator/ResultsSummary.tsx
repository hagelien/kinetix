import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import type { DrugSimResult } from '@/types/simulator';
import { formatSignificant, formatWithMaxDecimals } from '@/lib/rangeUtils';
import { LOW_ESS_RATIO } from '@/lib/compute/liteInference';

interface ResultsSummaryProps {
  results: Record<string, DrugSimResult>;
  drugLabels: Record<string, string>;
  drugColors: Record<string, string>;
  /** Component ids whose result is out of date — badged "re-run". */
  staleIds?: Set<string>;
}

function fmt(n: number): string {
  return formatSignificant(n);
}

export function ResultsSummary({
  results,
  drugLabels,
  drugColors,
  staleIds,
}: ResultsSummaryProps) {
  const { t } = useTranslation();
  const entries = Object.entries(results);
  if (entries.length === 0) return null;

  return (
    <Card className="border-mode-accent/25">
      <CardContent className="p-3 space-y-3">
        <h3 className="font-semibold text-sm">{t('results.title')}</h3>

        {entries.map(([id, result]) => {
          const modeLabel =
            result.engine === 'ethanol-widmark'
              ? t('results.peakOrQueryBac')
              : result.engine === 'kinelab-bayes'
                ? t('results.posteriorPredictivePeak')
                : result.questionMode === 'dose-from-concentration'
                  ? t('results.plausibleDose')
                  : t('results.plausibleConcentration');

          return (
            <div
              key={id}
              className="border-l-4 pl-2 space-y-1"
              style={{ borderLeftColor: drugColors[id] ?? '#2563eb' }}
            >
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-sm">
                  {drugLabels[id] ?? id}
                </span>
                {staleIds?.has(id) && (
                  <span
                    className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-900/50 dark:text-amber-200"
                    title={t('results.outOfDateHint')}
                  >
                    {t('results.outOfDate')}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">{modeLabel}</div>
              {/* Sensitivity */}
              {result.sensitivity.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  <span
                    className="font-medium"
                    title={t('results.sensitivityTooltip')}
                  >
                    {t('results.sensitivity')}:{' '}
                  </span>
                  {result.sensitivity
                    .filter((s) => s.influence > 0.1)
                    .map(
                      (s) => `${s.parameter} ${Math.round(s.influence * 100)}%`,
                    )
                    .join(', ')}
                </div>
              )}

              {result.kinelab && (
                <div className="pt-1">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    {t('results.posteriorIntervals')}
                  </div>
                  <table className="w-full text-xs">
                    <thead className="text-[11px] uppercase text-muted-foreground">
                      <tr>
                        <th className="py-1 text-left">
                          {t('results.parameter')}
                        </th>
                        <th className="py-1 text-right">p05</th>
                        <th className="py-1 text-right">
                          {t('results.median')}
                        </th>
                        <th className="py-1 text-right">p95</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(result.kinelab.posterior.intervals).map(
                        ([key, interval]) => {
                          const prior =
                            result.kinelab?.priorIntervals?.[key];
                          return (
                            <tr
                              key={key}
                              className="border-t border-border/40 align-top"
                            >
                              <td className="py-1 font-medium">
                                {t(`kinelab.parameters.${key}`, {
                                  defaultValue: key,
                                })}
                                {interval.unit ? ` (${interval.unit})` : ''}
                                {prior && (
                                  <div className="font-normal text-[10px] uppercase tracking-wide text-muted-foreground">
                                    {t('results.priorRow')}
                                  </div>
                                )}
                              </td>
                              <td className="py-1 text-right tabular-nums">
                                {fmt(interval.p05)}
                                {prior && (
                                  <div className="text-[10px] text-muted-foreground">
                                    {fmt(prior.p05)}
                                  </div>
                                )}
                              </td>
                              <td className="py-1 text-right tabular-nums">
                                {fmt(interval.median)}
                                {prior && (
                                  <div className="text-[10px] text-muted-foreground">
                                    {fmt(prior.median)}
                                  </div>
                                )}
                              </td>
                              <td className="py-1 text-right tabular-nums">
                                {fmt(interval.p95)}
                                {prior && (
                                  <div className="text-[10px] text-muted-foreground">
                                    {fmt(prior.p95)}
                                  </div>
                                )}
                              </td>
                            </tr>
                          );
                        },
                      )}
                    </tbody>
                  </table>
                  {(() => {
                    const d = result.kinelab.diagnostics;
                    const ratio =
                      d.sampleCount > 0
                        ? d.effectiveSampleSize / d.sampleCount
                        : 0;
                    const pct = Math.round(ratio * 1000) / 10;
                    const low = ratio < LOW_ESS_RATIO;
                    // attempted = accepted + rejected (nonphysical + impossible);
                    // accepted fraction exposes how much of the sampler's work
                    // actually informed the posterior.
                    const attempted =
                      d.sampleCount +
                      d.rejectedNonphysical +
                      d.rejectedImpossible;
                    const acceptedPct =
                      attempted > 0
                        ? Math.round((d.sampleCount / attempted) * 1000) / 10
                        : 0;
                    return (
                      <div className="space-y-0.5 pt-1">
                        <div
                          className={`text-xs ${low ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}
                        >
                          {t('results.effectiveSampleSize', {
                            count: d.sampleCount,
                            ess: formatWithMaxDecimals(d.effectiveSampleSize),
                            pct,
                          })}
                          {low && ` — ${t('results.lowEssInline')}`}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t('results.acceptedDraws', {
                            accepted: d.sampleCount,
                            attempted,
                            pct: acceptedPct,
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
