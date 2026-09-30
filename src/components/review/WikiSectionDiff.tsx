import { useTranslation } from 'react-i18next';
import type { PendingEditRow } from '@/lib/pendingEditsApi';

interface WikiSectionDiffProps {
  edit: PendingEditRow;
}

interface SectionPayload {
  operation: 'add' | 'edit' | 'reorder' | 'remove';
  headingText?: string;
  headingLevel?: number;
  position?: number;
  /** #360: cascade rejection flag for `remove` ops. */
  cascade?: boolean;
}

function readPayload(value: unknown): SectionPayload | null {
  if (!value || typeof value !== 'object') return null;
  const op = (value as { operation?: unknown }).operation;
  if (op !== 'add' && op !== 'edit' && op !== 'reorder' && op !== 'remove') {
    return null;
  }
  return value as SectionPayload;
}

/**
 * Compact summary of a `wiki_section` pending edit for the review
 * queue. Splice details (where the section will land) are computed
 * server-side at approval time; the card surfaces just enough for a
 * reviewer to decide whether to approve.
 */
export function WikiSectionDiff({ edit }: WikiSectionDiffProps): JSX.Element {
  const { t } = useTranslation();
  const payload = readPayload(edit.proposedValue);
  if (!payload) {
    return (
      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        {t('review.unknownPayload', {
          defaultValue: 'Unknown section payload',
        })}
      </div>
    );
  }

  const sectionId = edit.sectionId ?? null;

  return (
    <div className="space-y-1 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs">
      <div className="font-semibold uppercase tracking-wide text-muted-foreground">
        {t(`review.wikiSection.${payload.operation}`, {
          defaultValue: payload.operation,
        })}
      </div>
      {payload.operation === 'add' ? (
        <div>
          <div>
            <span className="text-muted-foreground">
              {t('review.wikiSection.heading', { defaultValue: 'Heading' })}:
            </span>{' '}
            <span className="font-medium">{payload.headingText}</span>
            {payload.headingLevel ? (
              <span className="ml-1 text-muted-foreground">
                (h{payload.headingLevel})
              </span>
            ) : null}
          </div>
          <div>
            <span className="text-muted-foreground">
              {t('review.wikiSection.position', { defaultValue: 'Position' })}:
            </span>{' '}
            {payload.position}
          </div>
        </div>
      ) : null}
      {payload.operation === 'edit' && sectionId ? (
        <div>
          <span className="text-muted-foreground">
            {t('review.wikiSection.rename', { defaultValue: 'Rename' })}:
          </span>{' '}
          <span className="font-mono text-[11px] text-muted-foreground">
            {sectionId}
          </span>{' '}
          → <span className="font-medium">{payload.headingText}</span>
        </div>
      ) : null}
      {payload.operation === 'reorder' && sectionId ? (
        <div>
          <span className="text-muted-foreground">
            {t('review.wikiSection.move', { defaultValue: 'Move' })}:
          </span>{' '}
          <span className="font-mono text-[11px] text-muted-foreground">
            {sectionId}
          </span>{' '}
          →{' '}
          <span className="font-medium">
            {t('review.wikiSection.position', { defaultValue: 'Position' })}{' '}
            {payload.position}
          </span>
        </div>
      ) : null}
      {payload.operation === 'remove' && sectionId ? (
        <div className="space-y-1">
          <div>
            <span className="text-muted-foreground">
              {t('review.wikiSection.delete', { defaultValue: 'Remove' })}:
            </span>{' '}
            <span className="font-mono text-[11px]">{sectionId}</span>
          </div>
          {payload.cascade ? (
            <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-900 dark:text-rose-100">
              {t('review.wikiSection.cascadeWarning', {
                defaultValue:
                  'Cascade: rejects all pending fact edits in this section AND strips existing facts from the page before removal',
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
