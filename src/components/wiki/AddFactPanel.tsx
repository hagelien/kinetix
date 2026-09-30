import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ReferenceInput } from './ReferenceInput';
import {
  FactStatementEditor,
  type FactStatementValue,
} from './FactStatementEditor';
import {
  fetchReferencesByIds,
  formatReference,
  type ReferenceRow,
} from '@/lib/referenceApi';
import { ApiError, createPendingEdit } from '@/lib/pendingEditsApi';

const WIKI_FACT_ERROR_KEYS: Record<string, string> = {
  wiki_fact_invalid_topic_section_id: 'wikiFact.errorInvalidTopicSectionId',
  wiki_fact_section_not_found: 'wikiFact.errorSectionNotFound',
  wiki_fact_topic_field_not_supported: 'wikiFact.errorTopicFieldNotSupported',
};

interface AddFactPanelProps {
  pageId: number;
  /**
   * Section anchor for the new fact. For drug-monograph pages this is a
   * `MonographSectionId` from the fixed schema; for topic pages
   * (#310 phase 2 / #348) it's the heading-derived sectionId minted by
   * the migration. The panel doesn't validate the shape — the API does.
   */
  sectionId: string;
  /** Optional sub-field within the section (drug-monograph schema only). */
  fieldId?: string;
  /** Drug id for citation creation context. */
  drugId?: number | null;
  /**
   * Pre-fill the claim text. Used by the prose→fact conversion flow
   * (#310 phase 3) so an author promotes an existing paragraph instead
   * of retyping it. Omit for a blank panel.
   */
  initialStatement?: string;
  /** Pre-fill the rich statement content (see {@link initialStatement}). */
  initialContent?: unknown[];
  /**
   * Citation ids to pre-attach (resolved to full rows on mount). Lets a
   * converted paragraph keep the citations it already carried.
   */
  initialReferenceIds?: number[];
  onClose: () => void;
  /**
   * Called after a successful submit; the parent typically refreshes the
   * page or queues a toast. Signature stays minimal so the panel doesn't
   * couple to any particular page / store.
   */
  onSubmitted: () => void;
}

interface AttachedRef {
  id: number;
  /** Resolved row, undefined while a pre-attached id is still loading. */
  row?: ReferenceRow;
}

/**
 * Inline panel for posting a single `wiki_fact add` pending edit. The atomic
 * contract (issue #284) is enforced at the API layer; the UI mirrors it by
 * disabling submit until the author has typed a claim AND attached at least
 * one citation.
 */
export function AddFactPanel({
  pageId,
  sectionId,
  fieldId,
  drugId,
  initialStatement,
  initialContent,
  initialReferenceIds,
  onClose,
  onSubmitted,
}: AddFactPanelProps): JSX.Element {
  const { t } = useTranslation();
  const [statement, setStatement] = useState(initialStatement ?? '');
  const [statementContent, setStatementContent] = useState<unknown[]>(
    () => initialContent ?? [],
  );
  const [refs, setRefs] = useState<AttachedRef[]>(() =>
    (initialReferenceIds ?? []).map((id) => ({ id })),
  );
  const [showRefInput, setShowRefInput] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolve any pre-attached citation ids (conversion flow) to full rows
  // so they render with title/author instead of a bare number. Batched —
  // a converted paragraph can carry several citations.
  useEffect(() => {
    const uniqueIds = [...new Set(initialReferenceIds ?? [])].filter(
      (id) => Number.isInteger(id) && id > 0,
    );
    if (uniqueIds.length === 0) return;
    let cancelled = false;
    fetchReferencesByIds(uniqueIds)
      .then(({ references }) => {
        if (cancelled) return;
        const byId = new Map(references.map((row) => [row.id, row]));
        setRefs((prev) => prev.map((r) => ({ id: r.id, row: byId.get(r.id) })));
      })
      .catch(() => {
        /* leave ids unresolved — they still submit, just show as loading */
      });
    return () => {
      cancelled = true;
    };
  }, [initialReferenceIds]);

  const trimmed = statement.trim();
  const overLimit = trimmed.length > 400;
  const canSubmit =
    !submitting && trimmed.length > 0 && !overLimit && refs.length > 0;

  function handleAttachRef(ref: ReferenceRow) {
    if (refs.some((r) => r.id === ref.id)) {
      setShowRefInput(false);
      return;
    }
    setRefs((prev) => [...prev, { id: ref.id, row: ref }]);
    setShowRefInput(false);
  }

  function handleRemoveRef(id: number) {
    setRefs((prev) => prev.filter((r) => r.id !== id));
  }

  const handleStatementChange = useCallback((value: FactStatementValue) => {
    setStatement(value.text);
    setStatementContent(value.content);
  }, []);

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await createPendingEdit({
        editType: 'wiki_fact',
        targetId: pageId,
        proposedValue: { content: statementContent },
        sectionId,
        fieldId: fieldId ?? undefined,
        factOperation: 'add',
        factStatement: trimmed,
        referenceIds: refs.map((r) => r.id),
      } as Parameters<typeof createPendingEdit>[0]);
      onSubmitted();
      // Reset before closing so a quick re-open starts blank.
      setStatement('');
      setRefs([]);
      onClose();
    } catch (err) {
      // Map known stable codes to localised strings; fall back to the
      // server's English prose for anything we haven't taught the UI
      // about yet (AGENTS.md i18n rule).
      const key =
        err instanceof ApiError && err.code && WIKI_FACT_ERROR_KEYS[err.code];
      setError(
        key
          ? t(key)
          : err instanceof Error
            ? err.message
            : t('wiki.failedToSave'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-border bg-muted/20 px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{t('wikiFact.title')}</span>
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {t('common.cancel')}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">{t('wikiFact.hint')}</p>
      <FactStatementEditor
        initialText={initialStatement ?? ''}
        initialContent={initialContent}
        disabled={submitting}
        onChange={handleStatementChange}
      />
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {t('wikiFact.charCount', { count: trimmed.length, max: 400 })}
        </span>
        {overLimit ? (
          <span className="text-rose-600">{t('wikiFact.tooLong')}</span>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="text-xs font-medium">{t('wikiFact.references')}</div>
        {refs.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">
            {t('wikiFact.noReferencesYet')}
          </p>
        ) : (
          <ul className="space-y-1 text-xs">
            {refs.map((ref, idx) => (
              <li
                key={ref.id}
                className="flex items-start justify-between gap-2 rounded bg-background px-2 py-1"
              >
                <span className="leading-snug">
                  <span className="mr-1 text-muted-foreground">
                    [{idx + 1}]
                  </span>
                  {ref.row
                    ? formatReference(ref.row) || ref.row.identifier
                    : t('wikiFact.refLoading', { id: ref.id })}
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveRef(ref.id)}
                  disabled={submitting}
                  className="shrink-0 text-muted-foreground hover:text-rose-600"
                  aria-label={t('common.remove') as string}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {showRefInput ? (
          <ReferenceInput
            drugId={drugId ?? null}
            required
            onReferenceCreated={handleAttachRef}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowRefInput(true)}
            disabled={submitting}
            className="text-xs text-primary hover:underline"
          >
            {t('wikiFact.addReference')}
          </button>
        )}
      </div>

      {error ? (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </div>
      ) : null}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {submitting ? t('wiki.saving') : t('wikiFact.submit')}
        </button>
      </div>
    </div>
  );
}
