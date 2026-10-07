import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import type { DrugSimResult } from '@/types/simulator';
import {
  deriveAnswer,
  hasUncertaintyBand,
  kinelabRobustness,
} from '@/lib/modelingAnswer';
import { formatSignificant } from '@/lib/rangeUtils';
import { UnitTooltip } from '@/components/ui/UnitTooltip';
import { useAppStore } from '@/stores/appStore';
import {
  convertConcentration,
  isConcentrationUnit,
} from '@/lib/unitConversion';

interface AnswerCardProps {
  results: Record<string, DrugSimResult>;
  drugLabels: Record<string, string>;
  drugColors: Record<string, string>;
  /** Molecular weights, keyed by component id — needed for molar↔mass display. */
  drugMolecularWeights?: Record<string, number | null>;
  /** Component ids whose result is out of date — badged "out of date". */
  staleIds?: Set<string>;
}

function fmt(n: number): string {
  return formatSignificant(n);
}

interface AnswerDisplay {
  unit: string;
  value: number;
  low?: number;
  high?: number;
  /** Whether the figures are a concentration (→ convertible + tooltip-able). */
  isConcentration: boolean;
}

/**
 * Re-express a concentration answer in the user's preferred display unit
 * (`enabledUnits[0]`) when the conversion is possible, so the headline "Svar"
 * honours the setting instead of always showing the drug's authored unit. Dose
 * / BAC answers (non-concentration units) are left untouched.
 */
function toDisplay(
  value: number,
  low: number | undefined,
  high: number | undefined,
  sourceUnit: string,
  mw: number | null,
  preferredUnit: string | undefined,
): AnswerDisplay {
  if (!isConcentrationUnit(sourceUnit)) {
    return { unit: sourceUnit, value, low, high, isConcentration: false };
  }
  if (
    preferredUnit &&
    isConcentrationUnit(preferredUnit) &&
    preferredUnit !== sourceUnit
  ) {
    try {
      const conv = (n: number) =>
        convertConcentration(n, sourceUnit, preferredUnit, mw ?? undefined);
      return {
        unit: preferredUnit,
        value: conv(value),
        low: low != null ? conv(low) : undefined,
        high: high != null ? conv(high) : undefined,
        isConcentration: true,
      };
    } catch {
      // Cross-kind conversion without a molecular weight — keep the source unit.
    }
  }
  return { unit: sourceUnit, value, low, high, isConcentration: true };
}

/**
 * The median / 25–75% / 5–95% distribution for a result, shown under the
 * headline answer. Moved here from the "Resultater" pane so the full set of
 * figures lives in one place, in the preferred display unit.
 */
function ResultDistribution({
  result,
  mw,
}: {
  result: DrugSimResult;
  mw: number | null;
}) {
  const { t } = useTranslation();
  const isConcentration =
    result.engine === 'kinelab-bayes' ||
    result.questionMode !== 'dose-from-concentration';

  const cell = (low: number, high: number | null) =>
    isConcentration ? (
      <UnitTooltip
        value={high == null ? low : undefined}
        low={high == null ? undefined : low}
        high={high ?? undefined}
        unit={result.unit}
        molecularWeight={mw}
      >
        {high == null
          ? `${fmt(low)} ${result.unit}`
          : `${fmt(low)} – ${fmt(high)} ${result.unit}`}
      </UnitTooltip>
    ) : (
      <>
        {high == null
          ? `${fmt(low)} ${result.unit}`
          : `${fmt(low)} – ${fmt(high)} ${result.unit}`}
      </>
    );

  // A run whose percentiles all coincide produced no spread at all. Printing
  // "2.839 – 2.839" for the quartile and 5–95% rows dresses a deterministic
  // point estimate up as a distribution, so those rows are replaced by the
  // reason the band is absent.
  if (!hasUncertaintyBand(result)) {
    return (
      <div className="mt-1.5 space-y-0.5 text-xs">
        <div className="grid grid-cols-3 gap-x-3">
          <div className="text-muted-foreground">{t('results.median')}</div>
          <div className="num col-span-2">{cell(result.median, null)}</div>
        </div>
        <p className="text-muted-foreground">{t('answer.deterministic')}</p>
      </div>
    );
  }

  return (
    <div className="mt-1.5 grid grid-cols-3 gap-x-3 gap-y-0.5 text-xs">
      <div className="text-muted-foreground">{t('results.median')}</div>
      <div className="num col-span-2">{cell(result.median, null)}</div>

      <div className="text-muted-foreground">25–75%</div>
      <div className="num col-span-2">{cell(result.p25, result.p75)}</div>

      <div className="text-muted-foreground">5–95%</div>
      <div className="num col-span-2">{cell(result.p05, result.p95)}</div>
    </div>
  );
}

/**
 * The "answer card": the primary, task-specific result shown immediately below
 * the chart. It states the one quantity the question asks for (inferred dose,
 * predicted/back-extrapolated concentration, or BAC) with a correctly named
 * uncertainty interval — instead of always leading with a peak value.
 */
export function AnswerCard({
  results,
  drugLabels,
  drugColors,
  drugMolecularWeights,
  staleIds,
}: AnswerCardProps) {
  const { t } = useTranslation();
  const enabledUnits = useAppStore((s) => s.enabledUnits);
  const preferredUnit = enabledUnits[0];
  const entries = Object.entries(results);
  if (entries.length === 0) return null;

  return (
    <Card className="border-mode-accent/40">
      <CardContent className="space-y-3 p-3">
        <h3 className="text-sm font-semibold">{t('answer.title')}</h3>
        {entries.map(([id, result]) => {
          const answer = deriveAnswer(result);
          const isStale = staleIds?.has(id) ?? false;
          const robustness = kinelabRobustness(result);
          const mw = drugMolecularWeights?.[id] ?? null;
          const display = toDisplay(
            answer.value,
            answer.low,
            answer.high,
            answer.unit,
            mw,
            preferredUnit,
          );
          return (
            <div
              key={id}
              className="border-l-4 pl-2.5"
              style={{ borderLeftColor: drugColors[id] ?? '#2563eb' }}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {drugLabels[id] ?? id} · {t(answer.labelKey)}
                </span>
                {isStale && (
                  <span
                    className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-900/50 dark:text-amber-200"
                    title={t('results.outOfDateHint')}
                  >
                    {t('results.outOfDate')}
                  </span>
                )}
                {!robustness.robust && (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-800 dark:bg-red-900/50 dark:text-red-200">
                    {t(
                      result.failure
                        ? 'answer.failed.badge'
                        : 'answer.notRobust.badge',
                    )}
                  </span>
                )}
              </div>
              {robustness.robust ? (
                <>
                  <div
                    className={`num text-2xl font-semibold ${isStale ? 'opacity-50' : ''}`}
                  >
                    {display.isConcentration ? (
                      <UnitTooltip
                        value={display.value}
                        unit={display.unit}
                        molecularWeight={mw}
                      >
                        {fmt(display.value)}{' '}
                        <span className="text-base font-normal text-muted-foreground">
                          {display.unit}
                        </span>
                      </UnitTooltip>
                    ) : (
                      <>
                        {fmt(display.value)}{' '}
                        <span className="text-base font-normal text-muted-foreground">
                          {display.unit}
                        </span>
                      </>
                    )}
                  </div>
                  {display.low != null &&
                    display.high != null &&
                    answer.intervalKey && (
                      <div className="text-xs text-muted-foreground">
                        {t(answer.intervalKey)}:{' '}
                        {display.isConcentration ? (
                          <UnitTooltip
                            low={display.low}
                            high={display.high}
                            unit={display.unit}
                            molecularWeight={mw}
                          >
                            {fmt(display.low)} – {fmt(display.high)}{' '}
                            {display.unit}
                          </UnitTooltip>
                        ) : (
                          <>
                            {fmt(display.low)} – {fmt(display.high)}{' '}
                            {display.unit}
                          </>
                        )}
                      </div>
                    )}
                  <ResultDistribution result={result} mw={mw} />
                </>
              ) : (
                // Not robust: block the authoritative median/CI and say why.
                <>
                  <div className="text-sm font-semibold text-red-700 dark:text-red-300">
                    {t(
                      result.failure ? 'answer.failed.title' : 'answer.notRobust.title',
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t(robustness.reasonKey)}
                  </div>
                  {/* A weak posterior still HAS a value, shown struck-through
                      for reference. A failed run does not — its percentiles are
                      placeholder zeros — so nothing numeric is shown at all. */}
                  {!result.failure && (
                    <div className="num text-sm text-muted-foreground line-through opacity-60">
                      {fmt(display.value)} {display.unit}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
