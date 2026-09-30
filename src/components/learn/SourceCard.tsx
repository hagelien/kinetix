import { useTranslation } from 'react-i18next';
import { ExternalLink, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  difficultyLabelKey,
  safeHttpUrl,
  sourceLinkOutUrl,
} from '@/lib/learnContent';
import type { LearningUnitContent, LearningUnitSource } from '@/lib/learnApi';

function formatAuthors(authors: string | string[] | undefined): string | null {
  if (!authors) return null;
  return Array.isArray(authors) ? authors.join(', ') : authors;
}

/**
 * The §7.1 source card: bibliographic header for the anchoring citation, why
 * the unit matters, estimated reading time, and a LINK-OUT to the source — we
 * never embed or serve the PDF/full text.
 */
export function SourceCard({
  title,
  difficulty,
  source,
  card,
}: {
  title: string;
  difficulty: string;
  source: LearningUnitSource | null;
  card: LearningUnitContent['sourceCard'];
}) {
  const { t } = useTranslation();
  const meta = source?.metadata ?? null;
  const authors = formatAuthors(meta?.authors);
  const url =
    (source?.url ? safeHttpUrl(source.url) : null) ??
    (source ? sourceLinkOutUrl(source.type, source.identifier) : null);

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('learn.sourceCard.heading')}
          </p>
          <h1 className="mt-1 text-xl font-bold leading-tight">{title}</h1>
        </div>
        <Badge variant="secondary" className="shrink-0">
          {t(difficultyLabelKey(difficulty))}
        </Badge>
      </div>

      {meta?.title && (
        <p className="mt-3 font-medium leading-snug">{meta.title}</p>
      )}
      {(authors || meta?.journal || meta?.year) && (
        <p className="mt-1 text-sm text-muted-foreground">
          {[authors, meta?.journal, meta?.year ? String(meta.year) : null]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}

      <div className="mt-4">
        <h2 className="text-sm font-semibold">
          {t('learn.sourceCard.whyItMatters')}
        </h2>
        <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">
          {card.whyItMatters}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          {t('learn.readingMinutes', { count: card.estimatedReadingMinutes })}
        </span>
        {card.sourceStatus.map((s) => (
          <Badge key={s} variant="outline">
            {s}
          </Badge>
        ))}
      </div>

      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          <ExternalLink className="h-4 w-4" />
          {t('learn.sourceCard.open')}
        </a>
      )}
    </section>
  );
}
