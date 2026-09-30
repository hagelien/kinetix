import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PendingEditRow } from '@/lib/pendingEditsApi';
import { renderMarkdown } from '@/lib/renderMarkdown';

interface PaperReviewDiffProps {
  edit: PendingEditRow;
}

interface PaperReviewPayload {
  reviewMarkdown: string;
  overallScore: number | null;
  conclusionSupport: string | null;
  reviewConfidence: string | null;
}

function readPayload(value: unknown): PaperReviewPayload | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.reviewMarkdown !== 'string' || !v.reviewMarkdown.trim()) {
    return null;
  }
  return {
    reviewMarkdown: v.reviewMarkdown,
    overallScore: typeof v.overallScore === 'number' ? v.overallScore : null,
    conclusionSupport:
      typeof v.conclusionSupport === 'string' ? v.conclusionSupport : null,
    reviewConfidence:
      typeof v.reviewConfidence === 'string' ? v.reviewConfidence : null,
  };
}

function confidenceLabel(
  confidence: string | null,
  t: ReturnType<typeof useTranslation>['t'],
): string | null {
  if (confidence === 'high') return t('referenceModule.reviewConfidenceHigh');
  if (confidence === 'medium')
    return t('referenceModule.reviewConfidenceMedium');
  if (confidence === 'low') return t('referenceModule.reviewConfidenceLow');
  return confidence;
}

/**
 * Renders a proposed agent paper review (editType='paper_review') in the
 * review queue. The prose is author-written markdown — the same render
 * the public ReferencePage uses once approved — so reviewers preview
 * exactly what will go live on approval.
 */
export function PaperReviewDiff({ edit }: PaperReviewDiffProps): JSX.Element {
  const { t } = useTranslation();
  const payload = readPayload(edit.proposedValue);
  const html = useMemo(
    () => (payload ? renderMarkdown(payload.reviewMarkdown) : null),
    [payload],
  );

  if (!payload || !html) {
    return (
      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {t('review.unknownPayload', { defaultValue: 'Unknown review payload' })}
      </div>
    );
  }

  const confidence = confidenceLabel(payload.reviewConfidence, t);

  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-sm">
      {edit.readInFullUnverified ? (
        <div className="rounded-md border border-amber-500/50 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/40 dark:text-amber-200">
          {t('review.readInFullUnverified')}
        </div>
      ) : null}
      {payload.overallScore !== null ||
      payload.conclusionSupport ||
      confidence ? (
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
          {payload.overallScore !== null ? (
            <div>
              <dt className="inline font-semibold text-muted-foreground">
                {t('referenceModule.reviewScore')}:
              </dt>{' '}
              <dd className="inline">{payload.overallScore}/100</dd>
            </div>
          ) : null}
          {payload.conclusionSupport ? (
            <div>
              <dt className="inline font-semibold text-muted-foreground">
                {t('referenceModule.reviewVerdict')}:
              </dt>{' '}
              <dd className="inline">{payload.conclusionSupport}</dd>
            </div>
          ) : null}
          {confidence ? (
            <div>
              <dt className="inline font-semibold text-muted-foreground">
                {t('referenceModule.reviewConfidence')}:
              </dt>{' '}
              <dd className="inline">{confidence}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      <div
        className="prose prose-sm max-w-none dark:prose-invert"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
