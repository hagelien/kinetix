import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { difficultyLabelKey } from '@/lib/learnContent';
import type { ClinicalCaseContent } from '@/lib/learnApi';

/**
 * The §5.4 clinical-case header: a prominent, visually distinct
 * educational-only safety notice (spec §12 Stage 12 — shown before the
 * scenario, never optional) followed by the fictional/composite vignette.
 * Replaces the unit-only SourceCard/PreReadingGuide for `kind:'clinical_case'`.
 * The safety-notice text is authored content (Norwegian), not an i18n key; only
 * the label chrome around it is translated.
 */
export function CaseScenario({
  title,
  difficulty,
  content,
}: {
  title: string;
  difficulty: string;
  content: Pick<ClinicalCaseContent, 'safetyNotice' | 'scenario'>;
}) {
  const { t } = useTranslation();

  return (
    <section className="space-y-4">
      <div
        role="note"
        className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide">
            {t('learn.case.safetyNoticeLabel')}
          </p>
          <p className="mt-0.5 font-medium">{content.safetyNotice}</p>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('learn.case.scenario')}
            </p>
            <h1 className="mt-1 text-xl font-bold leading-tight">{title}</h1>
          </div>
          <Badge variant="secondary" className="shrink-0">
            {t(difficultyLabelKey(difficulty))}
          </Badge>
        </div>
        <p className="mt-3 whitespace-pre-line text-sm text-muted-foreground">
          {content.scenario}
        </p>
      </div>
    </section>
  );
}
