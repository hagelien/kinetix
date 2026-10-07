import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BookText, ExternalLink, FlaskConical } from 'lucide-react';
import {
  citationExternalHref,
  citationTooltipLabel,
  citationTooltipTitle,
} from '@/lib/citationFormat';
import {
  fetchReference,
  fetchPaperReview,
  fetchReferenceUsage,
  PaperReviewFetchError,
  ReferenceFetchError,
  type CitationRow,
  type PaperReviewRow,
  type ReferenceUsageLocation,
} from '@/lib/referencesApi';
import { formatGenericDrugName, resolveDrugName } from '@/lib/drugNames';
import { renderMarkdown } from '@/lib/renderMarkdown';
import { CitationPdfSection } from '@/components/wiki/CitationPdfSection';
import { noPdfReason } from '@/lib/publicDatabaseRecord';
import { ReviewHistory } from '@/components/reference/ReviewHistory';

function usageLocationLabel(
  location: ReferenceUsageLocation,
  lang: string | undefined,
): string {
  if (location.kind === 'drug') {
    return (
      formatGenericDrugName(resolveDrugName(location.names, lang)) ||
      location.slug
    );
  }
  return location.title || location.slug;
}

function CitedInSection({ citationId }: { citationId: number }): JSX.Element {
  const { t, i18n } = useTranslation();
  const [locations, setLocations] = useState<ReferenceUsageLocation[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    fetchReferenceUsage(citationId)
      .then((rows) => {
        if (!cancelled) setLocations(rows);
      })
      .catch(() => {
        if (!cancelled) setLocations([]);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [citationId]);

  const decorated = useMemo(
    () =>
      locations
        .map((location) => ({
          location,
          label: usageLocationLabel(location, i18n.language),
        }))
        .sort((a, b) =>
          a.label.localeCompare(b.label, i18n.language || undefined),
        ),
    [locations, i18n.language],
  );

  const drugLocations = decorated.filter(
    ({ location }) => location.kind === 'drug',
  );
  const wikiLocations = decorated.filter(
    ({ location }) => location.kind === 'wiki',
  );

  return (
    <section className="border-t border-border py-6">
      <h2 className="text-lg font-semibold">{t('referenceModule.citedIn')}</h2>
      {!loaded ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {t('referenceModule.loading')}
        </p>
      ) : decorated.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {t('referenceModule.citedInEmpty')}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {[...drugLocations, ...wikiLocations].map(({ location, label }) => {
            const Icon = location.kind === 'drug' ? FlaskConical : BookText;
            return (
              <Link
                key={`${location.kind}-${location.id}`}
                to={location.href}
                className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-sm hover:bg-accent"
              >
                <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                {label}
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

function normalizeAuthors(authors: unknown): string[] {
  if (Array.isArray(authors)) {
    return authors.filter(
      (author): author is string =>
        typeof author === 'string' && author.trim().length > 0,
    );
  }
  if (typeof authors === 'string' && authors.trim()) {
    return authors.split(/,\s*/).filter((author) => author.trim().length > 0);
  }
  return [];
}

function referenceTypeLabel(
  type: string,
  t: ReturnType<typeof useTranslation>['t'],
) {
  if (type === 'doi') return t('referenceModule.typeDoi');
  if (type === 'pmid') return t('referenceModule.typePmid');
  if (type === 'url') return t('referenceModule.typeUrl');
  return t('referenceModule.typeFreetext');
}

function reviewConfidenceLabel(
  confidence: string,
  t: ReturnType<typeof useTranslation>['t'],
) {
  if (confidence === 'high') return t('referenceModule.reviewConfidenceHigh');
  if (confidence === 'medium') {
    return t('referenceModule.reviewConfidenceMedium');
  }
  if (confidence === 'low') return t('referenceModule.reviewConfidenceLow');
  return confidence;
}

export function ReferencePage(): JSX.Element {
  const { t } = useTranslation();
  const params = useParams();
  const id = Number(params.referenceId);
  const [reference, setReference] = useState<CitationRow | null>(null);
  const [review, setReview] = useState<PaperReviewRow | null>(null);
  const [reviewLoaded, setReviewLoaded] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!Number.isInteger(id) || id <= 0) {
      setLoading(false);
      setError(t('referenceModule.invalidId'));
      return;
    }

    setLoading(true);
    setError(null);
    fetchReference(id)
      .then((row) => {
        if (!cancelled) setReference(row);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ReferenceFetchError && err.status === 404) {
          setError(t('referenceModule.notFound'));
        } else {
          setError(t('referenceModule.loadFailed'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, t]);

  useEffect(() => {
    let cancelled = false;
    if (!Number.isInteger(id) || id <= 0) {
      setReview(null);
      setReviewLoaded(false);
      setReviewError(null);
      return;
    }
    setReview(null);
    setReviewLoaded(false);
    setReviewError(null);
    fetchPaperReview(id)
      .then((row) => {
        if (!cancelled) {
          setReview(row);
          setReviewLoaded(true);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setReview(null);
        setReviewLoaded(true);
        if (err instanceof PaperReviewFetchError) {
          setReviewError(t('referenceModule.agentReviewLoadFailed'));
        } else {
          setReviewError(t('referenceModule.agentReviewLoadFailed'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, t]);

  const sourceHref = useMemo(
    () => (reference ? citationExternalHref(reference) : null),
    [reference],
  );

  const reviewHtml = useMemo(
    () => (review ? renderMarkdown(review.reviewMarkdown) : null),
    [review],
  );

  if (loading) {
    return (
      <main className="mx-auto w-full max-w-4xl px-4 py-8">
        <p className="text-sm text-muted-foreground">
          {t('referenceModule.loading')}
        </p>
      </main>
    );
  }

  if (error || !reference) {
    return (
      <main className="mx-auto w-full max-w-4xl px-4 py-8">
        <p className="text-sm text-destructive">
          {error ?? t('referenceModule.loadFailed')}
        </p>
      </main>
    );
  }

  const metadata = reference.metadata ?? {};
  const title = citationTooltipTitle(reference);
  const authors = normalizeAuthors(metadata.authors);
  const year = metadata.year ? String(metadata.year) : '';
  const journal = metadata.journal?.trim() ?? '';
  const typeLabel = referenceTypeLabel(reference.type, t);
  const reviewConfidence = review?.reviewConfidence
    ? reviewConfidenceLabel(review.reviewConfidence, t)
    : null;

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8">
      <header className="border-b border-border pb-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {typeLabel} #{reference.id}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {citationTooltipLabel(reference)}
        </p>
      </header>

      <div className="grid gap-6 py-6 md:grid-cols-[minmax(0,1fr)_18rem]">
        <section>
          <h2 className="text-lg font-semibold">
            {t('referenceModule.sourceDetails')}
          </h2>
          <dl className="mt-3 grid gap-3 text-sm">
            {authors.length > 0 && (
              <div>
                <dt className="font-medium text-muted-foreground">
                  {t('referenceModule.authors')}
                </dt>
                <dd>{authors.join(', ')}</dd>
              </div>
            )}
            {journal && (
              <div>
                <dt className="font-medium text-muted-foreground">
                  {t('referenceModule.journal')}
                </dt>
                <dd>{journal}</dd>
              </div>
            )}
            {year && (
              <div>
                <dt className="font-medium text-muted-foreground">
                  {t('referenceModule.year')}
                </dt>
                <dd>{year}</dd>
              </div>
            )}
            <div>
              <dt className="font-medium text-muted-foreground">
                {t('referenceModule.identifier')}
              </dt>
              <dd className="break-all font-mono text-xs">
                {reference.identifier}
              </dd>
            </div>
          </dl>
        </section>

        <aside className="space-y-3">
          <h2 className="text-lg font-semibold">
            {t('referenceModule.links')}
          </h2>
          {sourceHref ? (
            <a
              href={sourceHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent"
            >
              <ExternalLink className="h-4 w-4" />
              {t('referenceModule.openSource')}
            </a>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('referenceModule.noExternalLink')}
            </p>
          )}
        </aside>
      </div>

      <CitationPdfSection
        citationId={reference.id}
        resolvable={reference.type !== 'freetext'}
        hasReview={reviewLoaded ? Boolean(review) : null}
        noPdfReason={noPdfReason(reference)}
      />

      <CitedInSection citationId={reference.id} />

      <section className="border-t border-border py-6">
        <h2 className="text-lg font-semibold">
          {t('referenceModule.agentReview')}
        </h2>
        {review && reviewHtml ? (
          <>
            <div
              className="prose prose-sm mt-4 max-w-none dark:prose-invert"
              dangerouslySetInnerHTML={{ __html: reviewHtml }}
            />
            <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 border-t border-border pt-3 text-sm">
              {typeof review.overallScore === 'number' && (
                <div>
                  <dt className="font-medium text-muted-foreground">
                    {t('referenceModule.reviewScore')}
                  </dt>
                  <dd>{review.overallScore}/100</dd>
                </div>
              )}
              {review.conclusionSupport && (
                <div>
                  <dt className="font-medium text-muted-foreground">
                    {t('referenceModule.reviewVerdict')}
                  </dt>
                  <dd>{review.conclusionSupport}</dd>
                </div>
              )}
              {reviewConfidence && (
                <div>
                  <dt className="font-medium text-muted-foreground">
                    {t('referenceModule.reviewConfidence')}
                  </dt>
                  <dd>{reviewConfidence}</dd>
                </div>
              )}
            </dl>
          </>
        ) : reviewError ? (
          <p className="mt-2 text-sm text-destructive">{reviewError}</p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">
            {t('referenceModule.noAgentReview')}
          </p>
        )}
      </section>

      <ReviewHistory citationId={reference.id} />
    </main>
  );
}
