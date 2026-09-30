import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ParameterSourcesDialog } from '@/components/wiki/ParameterSourcesDialog';
import { DRUG_PARAMETERS } from '@/lib/drugParameters';
import { useParameterLabels } from '@/lib/useParameterLabels';
import { formatWithMaxDecimals } from '@/lib/rangeUtils';
import {
  detectionSpan,
  hasDetectionData,
  type DetectionBand,
  type DetectionWindow,
} from '@/lib/detectionWindows';
import type { ParameterSummary } from '@/lib/parameterEntryAggregation';
import type { NumericRange } from '@/types';

interface Props {
  window: DetectionWindow;
  drugId: number;
  drugName: string;
  summaries?: Record<string, ParameterSummary>;
  molecularWeight?: number | null;
  bloodPlasmaRatio?: NumericRange | number | null;
  canEdit: boolean;
  isAdmin: boolean;
  /** Reload the substance after a direct write so the band and span refresh. */
  onMutated?: () => void;
}

/**
 * Band chip shading. The same hue throughout, deepening with the length of the
 * window: a longer detection time is not a worse one, so a red/green scale would
 * read as a verdict. The gradient only says "further back".
 */
const BAND_TONE: Record<DetectionBand, string> = {
  halfDay: 'bg-primary/5 text-primary border-primary/20',
  day: 'bg-primary/10 text-primary border-primary/25',
  days: 'bg-primary/15 text-primary border-primary/30',
  week: 'bg-primary/20 text-primary border-primary/35',
  twoWeeks: 'bg-primary/25 text-primary border-primary/40',
  weeks: 'bg-primary/30 text-primary border-primary/45',
  monthPlus: 'bg-primary/40 text-primary border-primary/50',
};

/** One matrix's detection window, with the source values behind it one click away. */
export function DetectionMatrixCard({
  window,
  drugId,
  drugName,
  summaries,
  molecularWeight,
  bloodPlasmaRatio,
  canEdit,
  isAdmin,
  onMutated,
}: Props) {
  const { t } = useTranslation();
  const { longLabel } = useParameterLabels(DRUG_PARAMETERS[window.parameter]);
  const [showSources, setShowSources] = useState(false);

  const span = detectionSpan(window);
  const unitLabel = span ? t(`detection.unit.${span.unit}`) : '';
  const num = (value: number) => formatWithMaxDecimals(value, 1);

  // One string per shape rather than glued-together fragments: the unit sits on
  // a different side of the number in other languages, and only the locale file
  // can say where.
  let spanText = '';
  if (span) {
    const { low, high } = span;
    if (low != null && high != null && low !== high) {
      spanText = t('detection.spanRange', {
        low: num(low),
        high: num(high),
        unit: unitLabel,
      });
    } else {
      const single = high ?? low ?? span.representative;
      if (single != null) {
        spanText = t('detection.spanSingle', { value: num(single), unit: unitLabel });
      }
    }
  }

  // Only worth showing when it says something the span does not — a median
  // equal to an edge is the same number twice.
  const medianText =
    span?.representative != null &&
    span.representative !== span.low &&
    span.representative !== span.high
      ? t('detection.medianHint', {
          value: num(span.representative),
          unit: unitLabel,
        })
      : '';

  const hasData = hasDetectionData(window);

  return (
    <div
      data-testid={`detection-matrix-${window.key}`}
      className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4"
    >
      <div>
        <h3 className="text-sm font-semibold">
          {t(`detection.matrix.${window.key}`)}
        </h3>
        <p className="text-[11px] text-muted-foreground">{longLabel}</p>
      </div>

      {window.band ? (
        <span
          data-testid={`detection-band-${window.key}`}
          title={t('detection.bandDerived')}
          className={`w-fit rounded-full border px-2 py-0.5 text-xs font-medium ${BAND_TONE[window.band]}`}
        >
          {t(`detection.band.${window.band}`)}
        </span>
      ) : (
        <span className="w-fit rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
          {hasData ? t('detection.notPooled') : t('detection.noData')}
        </span>
      )}

      {spanText && (
        <p data-testid={`detection-span-${window.key}`} className="text-sm">
          {spanText}
        </p>
      )}
      {medianText && (
        <p className="text-xs text-muted-foreground">{medianText}</p>
      )}

      <div className="mt-auto pt-1">
        {hasData || canEdit ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setShowSources(true)}
          >
            {hasData
              ? t('parameterEntries.sources', { count: window.entryCount })
              : t('parameterEntries.addSources')}
          </Button>
        ) : (
          // Nothing recorded and nothing this reader can add: say so instead of
          // offering a button that opens an empty dialog.
          <p className="text-xs text-muted-foreground">
            {t('detection.noSourcesYet')}
          </p>
        )}
        {window.citationCount > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t('detection.citationCount', { count: window.citationCount })}
          </p>
        )}
      </div>

      {showSources && (
        <ParameterSourcesDialog
          drugId={drugId}
          drugName={drugName}
          parameter={window.parameter}
          summaries={summaries}
          molecularWeight={molecularWeight ?? null}
          bloodPlasmaRatio={bloodPlasmaRatio ?? null}
          canEdit={canEdit}
          isAdmin={isAdmin}
          onMutated={onMutated}
          onClose={() => setShowSources(false)}
        />
      )}
    </div>
  );
}

export default DetectionMatrixCard;
