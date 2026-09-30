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

function translateApiError(
  err: unknown,
  t: (key: string) => string,
  fallback: string,
): string {
  if (err instanceof ApiError && err.code && WIKI_FACT_ERROR_KEYS[err.code]) {
    return t(WIKI_FACT_ERROR_KEYS[err.code]!);
  }
  return err instanceof Error ? err.message : fallback;
}

interface EditFactPanelProps {
  pageId: number;
  /** See AddFactPanel — accepts both monograph and topic sectionIds. */
  sectionId: string;
  factId: string;
  initialStatement: string;
  initialContent?: unknown[];
  /** Reference ids currently embedded in the fact node. Resolved on mount. */
  initialReferenceIds: number[];
  drugId?: number | null;
  onClose: () => void;
  onSubmitted: () => void;
}

interface KeptRef {
  id: number;
  /** Resolved row, undefined while loading or if the lookup failed. */
  row?: ReferenceRow;
}

/**
 * Inline panel for posting a single `wiki_fact replace` (or `remove`)
 * pending edit. Prefilled with the fact's existing statement + references;
 * the user can edit the claim, drop or add references, or trigger a
 * delete-the-whole-fact submission.
 */
export function EditFactPanel({
  pageId,
  sectionId,
  factId,
  initialStatement,
  initialContent,
  initialReferenceIds,
  drugId,
  onClose,
  onSubmitted,
}: EditFactPanelProps): JSX.Element {
  const { t } = useTranslation();
  const [statement, setStatement] = useState(initialStatement);
  const [statementContent, setStatementContent] = useState<unknown[]>(
    () => initialContent ?? [],
  );
  const [keptRefs, setKeptRefs] = useState<KeptRef[]>(() =>
    initialReferenceIds.map((id) => ({ id })),
  );
  const [newRefs, setNewRefs] = useState<ReferenceRow[]>([]);
  const [showRefInput, setShowRefInput] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  // Resolve kept-ref ids to full citation rows so the panel can show
  // titles/authors. Use the batched API because fact edits can appear
  // many times on a page and one request per citation adds up quickly.
  useEffect(() => {
    let cancelled = false;
    const uniqueIds = [...new Set(initialReferenceIds)].filter(
      (id) => Number.isInteger(id) && id > 0,
    );
    if (uniqueIds.length === 0) {
      setKeptRefs([]);
      return () => {
        cancelled = true;
      };
    }

    fetchReferencesByIds(uniqueIds)
      .then(({ references }) => {
        if (cancelled) return;
        const byId = new Map(references.map((row) => [row.id, row]));
        setKeptRefs((prev) =>
          prev.map((entry) => ({
            id: entry.id,
            row: byId.get(entry.id),
          })),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setKeptRefs((prev) =>
          prev.map((entry) => ({ id: entry.id, row: undefined })),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [initialReferenceIds]);

  const trimmed = statement.trim();
  const overLimit = trimmed.length > 400;
  const totalRefIds = [
    ...keptRefs.map((r) => r.id),
    ...newRefs.map((r) => r.id),
  ];
  const canSubmit =
    !submitting && trimmed.length > 0 && !overLimit && totalRefIds.length > 0;

  function handleAttachRef(ref: ReferenceRow) {
    if (totalRefIds.includes(ref.id)) {
      setShowRefInput(false);
      return;
    }
    setNewRefs((prev) => [...prev, ref]);
    setShowRefInput(false);
  }

  function handleRemoveKeptRef(id: number) {
    setKeptRefs((prev) => prev.filter((r) => r.id !== id));
  }

  function handleRemoveNewRef(id: number) {
    setNewRefs((prev) => prev.filter((r) => r.id !== id));
  }

  const handleStatementChange = useCallback((value: FactStatementValue) => {
    setStatement(value.text);
    setStatementContent(value.content);
  }, []);

  async function handleReplace() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await createPendingEdit({
        editType: 'wiki_fact',
        targetId: pageId,
        proposedValue: { content: statementContent },
        sectionId,
        factOperation: 'replace',
        factStatement: trimmed,
        referenceIds: totalRefIds,
        factTargetAnchor: { factId },
      } as Parameters<typeof createPendingEdit>[0]);
      onSubmitted();
      onClose();
    } catch (err) {
      setError(translateApiError(err, t, t('wiki.failedToSave')));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemove() {
    setSubmitting(true);
    setError(null);
    try {
      await createPendingEdit({
        editType: 'wiki_fact',
        targetId: pageId,
        proposedValue: undefined,
        sectionId,
        factOperation: 'remove',
        factTargetAnchor: { factId },
      } as Parameters<typeof createPendingEdit>[0]);
      onSubmitted();
      onClose();
    } catch (err) {
      setError(translateApiError(err, t, t('wiki.failedToSave')));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-border bg-muted/20 px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">
          {t('wikiFact.editTitle', { id: factId.slice(0, 8) })}
        </span>
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          {t('common.cancel')}
        </button>
      </div>

      <FactStatementEditor
        initialText={initialStatement}
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
        {keptRefs.length === 0 && newRefs.length === 0 ? (
          <p className="text-xs italic text-muted-foreground">
            {t('wikiFact.noReferencesYet')}
          </p>
        ) : (
          <ul className="space-y-1 text-xs">
            {keptRefs.map((entry, idx) => (
              <li
                key={`kept-${entry.id}`}
                className="flex items-start justify-between gap-2 rounded bg-background px-2 py-1"
              >
                <span className="leading-snug">
                  <span className="mr-1 text-muted-foreground">
                    [{idx + 1}]
                  </span>
                  {entry.row
                    ? formatReference(entry.row) || entry.row.identifier
                    : t('wikiFact.refLoading', { id: entry.id })}
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveKeptRef(entry.id)}
                  disabled={submitting}
                  className="shrink-0 text-muted-foreground hover:text-rose-600"
                  aria-label={t('common.remove') as string}
                >
                  ×
                </button>
              </li>
            ))}
            {newRefs.map((ref, idx) => (
              <li
                key={`new-${ref.id}`}
                className="flex items-start justify-between gap-2 rounded bg-background px-2 py-1"
              >
                <span className="leading-snug">
                  <span className="mr-1 text-muted-foreground">
                    [{keptRefs.length + idx + 1}]
                  </span>
                  {formatReference(ref) || ref.identifier}
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveNewRef(ref.id)}
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

      <div className="flex items-center justify-between gap-2 pt-1">
        <div>
          {confirmingRemove ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">
                {t('wikiFact.confirmRemove')}
              </span>
              <button
                type="button"
                onClick={handleRemove}
                disabled={submitting}
                className="rounded-md border border-rose-500 bg-rose-500/10 px-2 py-1 text-xs text-rose-700 hover:bg-rose-500/20 disabled:opacity-50 dark:text-rose-300"
              >
                {t('wikiFact.confirmRemoveYes')}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingRemove(false)}
                disabled={submitting}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {t('common.cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingRemove(true)}
              disabled={submitting}
              className="text-xs text-rose-600 hover:underline"
            >
              {t('wikiFact.removeFact')}
            </button>
          )}
        </div>

        <div className="flex gap-2">
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
            onClick={handleReplace}
            disabled={!canSubmit}
            className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? t('wiki.saving') : t('wikiFact.replaceSubmit')}
          </button>
        </div>
      </div>
    </div>
  );
}
