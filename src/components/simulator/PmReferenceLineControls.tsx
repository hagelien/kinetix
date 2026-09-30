import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useAppStore } from '@/stores/appStore';
import { PM_STATISTICS, type PmStatisticId } from '@/lib/pmConcentrations';
import type { PmConcentrationSourceInfo } from '@/lib/pmConcentrations';
import { cn } from '@/lib/utils';

export interface PmReferenceLineControlsProps {
  sources: PmConcentrationSourceInfo[];
  availableStatistics: PmStatisticId[];
  /** Labels of substances whose plasma conversion could not be done. */
  conversionUnavailableFor: string[];
  /** Substances on the chart whose analyte mapping is not yet confirmed. */
  reviewNotes: { label: string; note: string }[];
}

/**
 * Toggles for the postmortem distribution overlay, sitting under the chart.
 *
 * Two things this deliberately does NOT do. It does not hide behind a settings
 * page — the reader decides which percentile matters while looking at the
 * curve, not before. And it never renders bare percentile checkboxes: the
 * source's own heading is the first line of the panel, because a 97.5th
 * percentile of autopsy findings with no link to cause of death is one label
 * away from being read as a lethal threshold.
 */
export function PmReferenceLineControls({
  sources,
  availableStatistics,
  conversionUnavailableFor,
  reviewNotes,
}: PmReferenceLineControlsProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const settings = useAppStore((s) => s.pmLines);
  const setEnabled = useAppStore((s) => s.setPmLinesEnabled);
  const toggleStatistic = useAppStore((s) => s.togglePmStatistic);

  const available = useMemo(
    () => new Set(availableStatistics),
    [availableStatistics],
  );

  if (sources.length === 0) return null;

  // With one cohort its own heading IS the panel's title — that sentence is the
  // point. With two, no single heading can speak for both, and picking the
  // first would qualify one cohort's lines with another cohort's caveat (and
  // "first" is only query row order). Each heading then moves down beside the
  // cohort it belongs to, and the collapsed label goes generic.
  const singleSource = sources.length === 1 ? sources[0]! : null;
  const heading = singleSource
    ? singleSource.heading
    : t('pmConcentrations.shortTitle');

  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 text-left font-medium text-foreground hover:underline"
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          <span>{heading}</span>
        </button>
        <label className="flex items-center gap-2 shrink-0">
          <span className="sr-only">{t('pmConcentrations.toggle')}</span>
          <Switch
            checked={settings.enabled}
            onCheckedChange={setEnabled}
            aria-label={t('pmConcentrations.toggle')}
          />
        </label>
      </div>

      {expanded && (
        <div className="mt-2 space-y-3">
          <p className="text-muted-foreground">
            {t('pmConcentrations.notAThreshold')}
          </p>
          {/* Stated unconditionally rather than computed per panel: it is true
              of every linear chart, and a reader who finds a toggled-on
              percentile missing needs the explanation to be present, not
              inferred from whether we detected it this render. */}
          <p className="text-muted-foreground">
            {t('pmConcentrations.offScale')}
          </p>

          <div className="flex flex-wrap gap-1.5">
            {PM_STATISTICS.map((stat) => {
              const isAvailable = available.has(stat.id);
              const isOn = settings.statistics[stat.id];
              return (
                <button
                  key={stat.id}
                  type="button"
                  disabled={!isAvailable || !settings.enabled}
                  onClick={() => toggleStatistic(stat.id)}
                  aria-pressed={isOn}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 transition-colors',
                    isOn && settings.enabled
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input text-foreground hover:bg-muted',
                    (!isAvailable || !settings.enabled) &&
                      'cursor-not-allowed opacity-50',
                  )}
                  title={
                    isAvailable ? undefined : t('pmConcentrations.notDrawn')
                  }
                >
                  {t(stat.i18nKey)}
                </button>
              );
            })}
          </div>

          {/* The matrix is chosen once for the whole chart (the selector above
              the plot); here we only flag cohorts the chosen matrix could not
              convert — a missing line is invisible, and without this the reader
              concludes the substance has no data rather than no B/P ratio. */}
          {conversionUnavailableFor.length > 0 && (
            <p className="text-amber-600 dark:text-amber-400">
              {t('pmConcentrations.matrix.unavailable')}{' '}
              {conversionUnavailableFor.join(', ')}
            </p>
          )}

          {reviewNotes.length > 0 && (
            // The monograph flags an unconfirmed analyte mapping; the chart
            // used to draw the same rows unqualified, and a line is the
            // likeliest place for a number to be taken as settled.
            <div className="space-y-1 text-amber-600 dark:text-amber-400">
              {reviewNotes.map((entry) => (
                <p key={entry.label} className="flex items-start gap-1">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    <strong>{entry.label}:</strong>{' '}
                    {t('pmConcentrations.reviewNote')} {entry.note}
                  </span>
                </p>
              ))}
            </div>
          )}

          <div className="space-y-2 text-muted-foreground">
            {sources.map((source) => (
              <div key={source.key} className="space-y-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="muted">{source.shortLabel}</Badge>
                  <span>{source.citation}</span>
                </div>
                {!singleSource && (
                  <p className="font-medium text-foreground">
                    {source.heading}
                  </p>
                )}
                {/* The source's own stated limits. The API carries them so the
                    client can qualify the numbers, and the monograph shows
                    them — but a forensic reader works from the chart, where a
                    line carried none of it. */}
                {source.caveats.length > 0 && (
                  <ul className="list-disc space-y-0.5 pl-4">
                    {source.caveats.map((caveat) => (
                      <li key={caveat}>{caveat}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
