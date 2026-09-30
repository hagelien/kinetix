import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';
import {
  fetchPaperReviewHistory,
  type PaperReviewRevisionRow,
} from '@/lib/referencesApi';
import { renderMarkdown } from '@/lib/renderMarkdown';

interface ReviewHistoryProps {
  citationId: number;
}

function confidenceLabel(
  confidence: string | null,
  t: ReturnType<typeof useTranslation>['t'],
): string | null {
  if (confidence === 'high') return t('referenceModule.reviewConfidenceHigh');
  if (confidence === 'medium') {
    return t('referenceModule.reviewConfidenceMedium');
  }
  if (confidence === 'low') return t('referenceModule.reviewConfidenceLow');
  return confidence;
}

function formatTimestamp(iso: string, lang: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(lang, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(parsed);
  } catch {
    return parsed.toISOString();
  }
}

function authorName(
  author: PaperReviewRevisionRow['author'],
  t: ReturnType<typeof useTranslation>['t'],
): string {
  return (
    author.displayName ??
    author.username ??
    (author.isAgent ? t('referenceModule.reviewAuthorAgent') : '—')
  );
}

/**
 * Per-reference paper-review revision history. Auto-published reviews are
 * re-reviewed over time; this surfaces every recorded change (WHAT changed via
 * the snapshot metadata + full text, WHY via the author's edit summary) for
 * humans and agents. Renders nothing until there is at least one revision.
 */
export function ReviewHistory({ citationId }: ReviewHistoryProps): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const [revisions, setRevisions] = useState<PaperReviewRevisionRow[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRevisions(null);
    setError(null);
    if (!Number.isInteger(citationId) || citationId <= 0) return;
    fetchPaperReviewHistory(citationId)
      .then((rows) => {
        if (!cancelled) setRevisions(rows);
      })
      .catch(() => {
        if (!cancelled) setError(t('referenceModule.reviewHistoryLoadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [citationId, t]);

  if (error) {
    return (
      <section className="border-t border-border py-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <History className="h-4 w-4" />
          {t('referenceModule.reviewHistory')}
        </h2>
        <p className="mt-2 text-sm text-destructive">{error}</p>
      </section>
    );
  }

  // While loading (null) or when a reference has never been reviewed (empty),
  // render nothing — the section pops in once there is history to show.
  if (!revisions || revisions.length === 0) return null;

  return (
    <section className="border-t border-border py-6">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <History className="h-4 w-4" />
        {t('referenceModule.reviewHistory')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('referenceModule.reviewHistoryHint')}
      </p>

      <ol className="mt-4 space-y-4">
        {revisions.map((rev, idx) => {
          const isInitial = idx === revisions.length - 1;
          const confidence = confidenceLabel(rev.reviewConfidence, t);
          const html = renderMarkdown(rev.reviewMarkdown);
          return (
            <li
              key={rev.id}
              className="rounded-md border border-border bg-muted/20 px-3 py-3"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="font-medium">
                  {authorName(rev.author, t)}
                </span>
                {rev.author.isAgent && (
                  <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                    {t('referenceModule.reviewAuthorAgent')}
                  </span>
                )}
                <span className="text-muted-foreground">·</span>
                <time className="text-muted-foreground">
                  {formatTimestamp(rev.createdAt, i18n.language)}
                </time>
              </div>

              <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                {typeof rev.overallScore === 'number' && (
                  <div>
                    <dt className="inline font-semibold text-muted-foreground">
                      {t('referenceModule.reviewScore')}:
                    </dt>{' '}
                    <dd className="inline">{rev.overallScore}/100</dd>
                  </div>
                )}
                {rev.conclusionSupport && (
                  <div>
                    <dt className="inline font-semibold text-muted-foreground">
                      {t('referenceModule.reviewVerdict')}:
                    </dt>{' '}
                    <dd className="inline">{rev.conclusionSupport}</dd>
                  </div>
                )}
                {confidence && (
                  <div>
                    <dt className="inline font-semibold text-muted-foreground">
                      {t('referenceModule.reviewConfidence')}:
                    </dt>{' '}
                    <dd className="inline">{confidence}</dd>
                  </div>
                )}
                {rev.readInFull && (
                  <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-medium text-emerald-700 dark:text-emerald-300">
                    {t('referenceModule.reviewReadInFull')}
                  </span>
                )}
              </dl>

              {rev.editSummary ? (
                <p className="mt-2 text-sm">
                  <span className="font-medium text-muted-foreground">
                    {t('referenceModule.reviewChangeReason')}:
                  </span>{' '}
                  {rev.editSummary}
                </p>
              ) : isInitial ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  {t('referenceModule.reviewInitialRevision')}
                </p>
              ) : null}

              <details className="mt-2 text-sm">
                <summary className="cursor-pointer select-none text-primary hover:underline">
                  {t('referenceModule.reviewShowText')}
                </summary>
                <div
                  className="prose prose-sm mt-2 max-w-none dark:prose-invert"
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
