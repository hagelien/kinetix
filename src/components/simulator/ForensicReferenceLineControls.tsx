import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { useAppStore } from '@/stores/appStore';
import {
  FORENSIC_CATEGORIES,
  forensicCategoryMeta,
  type ForensicCategoryId,
} from '@/lib/forensicConcentrations';
import { cn } from '@/lib/utils';

export interface ForensicReferenceLineControlsProps {
  /** Categories at least one visible substance has data for. */
  availableCategories: ForensicCategoryId[];
  /** Per-category evidence totals, for the source summary. */
  categories: {
    category: ForensicCategoryId;
    refCount: number;
    totalN: number;
  }[];
  /** Substances whose forensic rows could not be placed on the axis. */
  conversionUnavailableFor: string[];
}

/**
 * Toggles for the forensic postmortem overlay, sitting under the chart beside
 * the postmortem-percentile controls.
 *
 * Like its neighbour it deliberately does NOT hide behind a settings page — the
 * reader decides which forensic context matters while looking at the curve. And
 * the caption states plainly that these are measured distributions, not
 * thresholds: a band of autopsy findings is one label away from being read as a
 * lethal limit.
 */
export function ForensicReferenceLineControls({
  availableCategories,
  categories,
  conversionUnavailableFor,
}: ForensicReferenceLineControlsProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const settings = useAppStore((s) => s.forensicLines);
  const setEnabled = useAppStore((s) => s.setForensicLinesEnabled);
  const toggleCategory = useAppStore((s) => s.toggleForensicCategory);
  const setShowIndividual = useAppStore((s) => s.setForensicShowIndividual);

  const available = useMemo(
    () => new Set(availableCategories),
    [availableCategories],
  );
  const summaryByCategory = useMemo(
    () => new Map(categories.map((c) => [c.category, c])),
    [categories],
  );

  // The panel also stays when the only forensic rows are unconvertible, so the
  // warning naming those substances has somewhere to render.
  if (availableCategories.length === 0 && conversionUnavailableFor.length === 0) {
    return null;
  }

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
          <span>{t('forensicConc.title')}</span>
        </button>
        <label className="flex items-center gap-2 shrink-0">
          <span className="sr-only">{t('forensicConc.toggle')}</span>
          <Switch
            checked={settings.enabled}
            onCheckedChange={setEnabled}
            aria-label={t('forensicConc.toggle')}
          />
        </label>
      </div>

      {expanded && (
        <div className="mt-2 space-y-3">
          <p className="text-muted-foreground">
            {t('forensicConc.notAThreshold')}
          </p>
          {/* True of every linear chart, stated unconditionally so a reader who
              finds a toggled-on band running off the top has the explanation
              present rather than inferred. */}
          <p className="text-muted-foreground">{t('forensicConc.offScale')}</p>

          {conversionUnavailableFor.length > 0 && (
            // Valid rows exist but could not be placed on the axis (no B/P
            // ratio, or molar with no molecular weight). Named, so the panel
            // does not read as "no forensic data".
            <p className="flex items-start gap-1 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>
                {t('forensicConc.conversionUnavailable')}{' '}
                {conversionUnavailableFor.join(', ')}
              </span>
            </p>
          )}

          <div className="flex flex-wrap gap-1.5">
            {FORENSIC_CATEGORIES.map((cat) => {
              const isAvailable = available.has(cat.id);
              const isOn = settings.categories[cat.id];
              return (
                <button
                  key={cat.id}
                  type="button"
                  disabled={!isAvailable || !settings.enabled}
                  onClick={() => toggleCategory(cat.id)}
                  aria-pressed={isOn}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 transition-colors',
                    isOn && settings.enabled
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input text-foreground hover:bg-muted',
                    (!isAvailable || !settings.enabled) &&
                      'cursor-not-allowed opacity-50',
                  )}
                  title={isAvailable ? undefined : t('forensicConc.noData')}
                >
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: cat.color }}
                    aria-hidden
                  />
                  {t(cat.i18nKey)}
                </button>
              );
            })}
          </div>

          <label className="flex items-center gap-2">
            <Switch
              checked={settings.showIndividual}
              onCheckedChange={setShowIndividual}
              disabled={!settings.enabled}
              aria-label={t('forensicConc.showIndividual')}
            />
            <span
              className={cn(
                'text-foreground',
                !settings.enabled && 'opacity-50',
              )}
            >
              {t('forensicConc.showIndividual')}
            </span>
          </label>

          {/* The evidence behind each band, so the opacity has a legend: a
              fainter band is fainter because fewer subjects stand behind it. */}
          <div className="space-y-1 text-muted-foreground">
            {availableCategories.map((id) => {
              const meta = forensicCategoryMeta(id);
              const summary = summaryByCategory.get(id);
              if (!meta || !summary) return null;
              return (
                <div key={id} className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: meta.color }}
                    aria-hidden
                  />
                  <span className="text-foreground">{t(meta.i18nKey)}</span>
                  <span>
                    {t('forensicConc.evidenceSummary', {
                      n: summary.totalN,
                      refs: summary.refCount,
                    })}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
