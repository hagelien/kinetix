import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Skull } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { UnitTooltip } from '@/components/ui/UnitTooltip';
import { useAppStore } from '@/stores/appStore';
import { useAuthStore } from '@/stores/authStore';
import { canAccessPmConcentrations } from '@/lib/featureAccess';
import {
  convertPmValue,
  PM_STATISTICS,
  type PmConcentrationSourceInfo,
  type PmDistribution,
} from '@/lib/pmConcentrations';
import { isPlasmaLikeMatrix } from '@/lib/matrixDisplay';
import {
  EMPTY_PM_RESULT,
  fetchPmConcentrationsByDrugIds,
} from '@/lib/pmConcentrationsApi';

/**
 * A transcribed figure, shown exactly as the source printed it.
 *
 * Deliberately not the three-significant-figure house style for derived
 * numbers (docs/concentration-dose-display-precision.md): that policy exempts
 * source-reported quantities, and every column here is one. Reformatting a
 * source-printed figure (a very small LOQ, say) in house style would print a
 * different number from the table the reader is checking against.
 *
 * `printed` wins where it exists, because a float cannot carry a trailing
 * zero: a percentile printed 0.20 would otherwise be shown as 0.2, quietly
 * restating the source's precision. Only the digits are
 * taken from the source — the decimal separator still follows the reader's
 * locale, so a Norwegian reader sees 0,20 as they do everywhere else.
 */
function formatAsPrinted(
  value: number,
  locale: string,
  printed?: string,
): string {
  if (printed) {
    const decimals = printed.split('.')[1]?.length ?? 0;
    return value.toLocaleString(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }
  return value.toLocaleString(locale, { maximumSignificantDigits: 8 });
}

/** A value we computed (a unit conversion): house style, three sig figs. */
function formatDerived(value: number, locale: string): string {
  return value.toLocaleString(locale, { maximumSignificantDigits: 3 });
}

interface DrugPmConcentrationsProps {
  /** Internal `drugs.id`. Null while the host is still resolving the drug. */
  drugDbId: number | null;
  /** Needed only for the mass<->molar conversion into the reader's unit. */
  molecularWeight?: number | null;
  /** Suppress the source caveats in constrained sidebar presentations. */
  compact?: boolean;
}

/**
 * The source's row for one substance, reproduced as a table.
 *
 * This mirrors what the old data system showed under "Døde", and the layout is
 * load-bearing rather than decorative: the postmortem columns and the
 * therapeutic-concentration column sit under separate headings because they are
 * separate claims from separate populations, and the median(PM)/TC ratio only
 * means anything while both are visible next to it.
 *
 * The values are shown in the reader's preferred unit and, unconverted, in the
 * source's own — a percentile is a quotable figure, and a reader checking it
 * against the source table should not have to invert a conversion first.
 */
export function DrugPmConcentrations({
  drugDbId,
  molecularWeight = null,
  compact = false,
}: DrugPmConcentrationsProps) {
  const { t, i18n } = useTranslation();
  const canRead = useAuthStore((s) =>
    canAccessPmConcentrations(s.user, s.permissionOverrides),
  );
  // Cache identity: this data is gated, and signing in as somebody else in
  // this SPA replaces the store without reloading the module.
  const identity = useAuthStore((s) => s.user?.id ?? null);
  const preferredUnit = useAppStore((s) => s.enabledUnits)[0] ?? 'mg/L';
  // The answer is stored WITH the drug it answers for, and rendered only when
  // the two still agree.
  //
  // Clearing on change would also work, but this survives a case clearing
  // cannot: monograph navigation goes drug → drug without unmounting (the
  // sidebar reuses this component), so a slow or stalled request for the new
  // drug would otherwise leave the previous analyte's postmortem percentiles
  // on screen under the new drug's name. Binding the data to its id makes a
  // mismatch unrenderable rather than merely brief, and makes an out-of-order
  // response harmless too.
  const [state, setState] = useState<{
    drugDbId: number | null;
    result: typeof EMPTY_PM_RESULT;
  }>({ drugDbId: null, result: EMPTY_PM_RESULT });

  useEffect(() => {
    if (!canRead || drugDbId == null) {
      setState({ drugDbId, result: EMPTY_PM_RESULT });
      return;
    }
    let cancelled = false;
    fetchPmConcentrationsByDrugIds([drugDbId], identity)
      .then((result) => {
        if (!cancelled) setState({ drugDbId, result });
      })
      .catch(() => {
        if (!cancelled) setState({ drugDbId, result: EMPTY_PM_RESULT });
      });
    return () => {
      cancelled = true;
    };
  }, [canRead, drugDbId, identity]);

  const rows = useMemo(() => {
    // Nothing to show until the answer belongs to the drug on screen.
    const data =
      state.drugDbId === drugDbId && drugDbId != null
        ? state.result
        : EMPTY_PM_RESULT;
    const sourceByKey = new Map(data.sources.map((s) => [s.key, s]));
    return data.distributions
      .map((distribution) => ({
        distribution,
        source: sourceByKey.get(distribution.sourceKey),
      }))
      .filter(
        (row): row is { distribution: PmDistribution; source: PmConcentrationSourceInfo } =>
          row.source != null,
      );
  }, [state, drugDbId]);

  if (!canRead || rows.length === 0) return null;

  // One cohort's heading can stand as the section heading; two cannot. Taking
  // `rows[0]` would file the second cohort's numbers under the first cohort's
  // qualification, and which one won would be query row order. With several,
  // the section goes generic and each table carries its own.
  const singleCohort =
    new Set(rows.map((row) => row.source.key)).size === 1 ? rows[0]!.source : null;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Skull className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-semibold">
          {singleCohort ? singleCohort.heading : t('pmConcentrations.shortTitle')}
        </h3>
      </div>

      {rows.map(({ distribution, source }) => (
        <PmDistributionTable
          key={`${source.key}:${distribution.drugId}`}
          distribution={distribution}
          source={source}
          preferredUnit={preferredUnit}
          molecularWeight={molecularWeight}
          compact={compact}
          locale={i18n.language}
          showHeading={singleCohort == null}
          t={t}
        />
      ))}
    </section>
  );
}

interface TableProps {
  distribution: PmDistribution;
  source: PmConcentrationSourceInfo;
  preferredUnit: string;
  molecularWeight: number | null;
  compact: boolean;
  locale: string;
  /** Set when the section heading cannot speak for this cohort. */
  showHeading: boolean;
  t: (key: string, options?: Record<string, unknown>) => string;
}

function PmDistributionTable({
  distribution,
  source,
  preferredUnit,
  molecularWeight,
  compact,
  locale,
  showHeading,
  t,
}: TableProps) {
  const converted = (value: number | null): number | null => {
    if (preferredUnit === source.unit) return null;
    return convertPmValue(value, {
      targetUnit: preferredUnit,
      sourceUnit: source.unit,
      sourceMatrix: source.matrix,
      molecularWeight,
      // The monograph table presents each cohort in its OWN published matrix
      // (unit-only conversion, raw value shown alongside) — never reframed to
      // whole blood. Targeting the source's own blood/plasma side makes the
      // matrix step a pass-through, so a serum/plasma cohort stays serum/plasma
      // and never disappears for want of a B/P ratio.
      displayMatrix: isPlasmaLikeMatrix(source.matrix) ? 'plasma' : 'whole_blood',
    });
  };

  const concentration = (
    value: number,
    printed?: string,
    flagged = false,
  ) => {
    const preferredValue = converted(value);
    const displayUnit = preferredValue == null ? source.unit : preferredUnit;
    const formatted =
      preferredValue == null
        ? formatAsPrinted(value, locale, printed)
        : formatDerived(preferredValue, locale);

    return (
      <UnitTooltip
        value={value}
        unit={displayUnit}
        sourceUnit={source.unit}
        sourceFormatted={formatAsPrinted(value, locale, printed)}
        molecularWeight={molecularWeight}
      >
        {`${formatted}${flagged ? '*' : ''} ${displayUnit}`}
      </UnitTooltip>
    );
  };

  const cells = PM_STATISTICS.map((stat) => ({
    id: stat.id,
    label: t(stat.i18nKey),
    raw: distribution[stat.id],
    printed: distribution.printed?.[stat.id],
    // A statistic the transcription flagged is shown (it is what the source
    // printed) but marked, so a reader does not quietly copy a number the
    // chart deliberately refuses to draw.
    flagged: distribution.undrawable.includes(stat.id),
  }));
  const showsPreferredUnit =
    preferredUnit !== source.unit &&
    [...cells.map((cell) => cell.raw), distribution.tcPlasma].some(
      (value) => value != null && converted(value) != null,
    );

  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-xs">
      {showHeading && (
        <p className="font-semibold text-foreground">{source.heading}</p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse">
          <caption className="sr-only">
            {t('pmConcentrations.table.caption')}
          </caption>
          <thead>
            {/* Two column groups, because they are two claims about two
                populations: order statistics from an autopsy cohort, and the
                source's therapeutic concentration in the living. Flat, the TC
                cell reads as one more statistic from the same material — which
                is the misreading this whole feature is built to prevent. */}
            <tr className="text-left text-muted-foreground">
              <th className="pb-1 pr-3" aria-hidden />
              <th className="pb-1 pr-3" aria-hidden />
              <th
                className="border-b border-border pb-1 pr-3 font-semibold text-foreground"
                colSpan={cells.length}
                scope="colgroup"
              >
                {t('pmConcentrations.table.pmHeading')}
              </th>
              <th
                className="border-b border-border pb-1 pr-3 font-semibold text-foreground"
                colSpan={2}
                scope="colgroup"
              >
                {t('pmConcentrations.table.tcHeading')}
              </th>
            </tr>
            <tr className="text-left text-muted-foreground">
              <th className="pb-1 pr-3 font-medium">
                {t('pmConcentrations.table.analyte')}
              </th>
              <th className="pb-1 pr-3 font-medium">
                {t('pmConcentrations.table.n')}
              </th>
              {cells.map((cell) => (
                <th key={cell.id} className="pb-1 pr-3 font-medium">
                  {cell.label}
                </th>
              ))}
              <th className="pb-1 pr-3 font-medium">
                {t('pmConcentrations.table.tcPlasma')}
              </th>
              <th className="pb-1 font-medium">
                {t('pmConcentrations.table.medianOverTc')}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-border">
              <td className="py-1.5 pr-3">{distribution.analyte}</td>
              <td className="py-1.5 pr-3 tabular-nums">
                {distribution.n.toLocaleString(locale)}
              </td>
              {cells.map((cell) => (
                <td key={cell.id} className="py-1.5 pr-3 tabular-nums">
                  {cell.raw == null ? (
                    '–'
                  ) : (
                    <span className={cell.flagged ? 'text-amber-600 dark:text-amber-400' : ''}>
                      {concentration(cell.raw, cell.printed, cell.flagged)}
                    </span>
                  )}
                </td>
              ))}
              {/* TC follows the same preferred-unit display rule as the PM
                  columns so the adjacent values remain directly comparable. */}
              <td className="py-1.5 pr-3 tabular-nums">
                {distribution.tcPlasma == null ? (
                  '–'
                ) : (
                  <>
                    {concentration(
                      distribution.tcPlasma,
                      distribution.printed?.tcPlasma,
                    )}
                  </>
                )}
              </td>
              <td className="py-1.5 tabular-nums">
                {distribution.medianOverTc == null
                  ? '–'
                  : formatAsPrinted(
                      distribution.medianOverTc,
                      locale,
                      distribution.printed?.medianOverTc,
                    )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
        <span>
          {t('pmConcentrations.table.unit')}: {source.unit}
          {showsPreferredUnit && ` → ${preferredUnit}`}
        </span>
        <span>
          {t('pmConcentrations.table.source')}: {source.citation}
        </span>
        {/* `postmortem_femoral_blood` is a storage value, not something to
            show a reader. An unknown matrix falls back to the raw identifier
            rather than an empty badge — visibly unfinished beats absent. */}
        <Badge variant="muted">
          {t(`pmConcentrations.matrixName.${source.matrix}`, {
            defaultValue: source.matrix,
          })}
        </Badge>
      </div>

      {distribution.anomaly && (
        <p className="flex items-start gap-1 text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>* {distribution.anomaly}</span>
        </p>
      )}
      {distribution.reviewNote && (
        <p className="text-muted-foreground">
          {t('pmConcentrations.reviewNote')} {distribution.reviewNote}
        </p>
      )}

      {!compact && (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer font-medium text-foreground">
            {t('pmConcentrations.caveatsHeading')}
          </summary>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {source.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </details>
      )}

    </div>
  );
}
