import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { EntryDetails, type EntryFields } from '@/components/review/ParameterEntryDiff';

interface ReturnDialogProps {
  proposedValue: unknown;
  mode?: 'return' | 'revise';
  onReturn: (args: { comment: string; proposedValue?: unknown }) => void;
  onCancel: () => void;
  /**
   * Withdraws the pending edit outright (#1295). Only used in revise mode
   * when `conflictEntryDeleted` is set: the marker's target row is gone, so
   * there is no live entry left to revise against — any resubmission would
   * still fail approval with `param_entry_target_missing`, whatever the
   * proposed value says. The dialog offers withdrawal instead of an editor
   * that can never lead anywhere.
   */
  onWithdraw?: () => void;
  saving: boolean;
  /**
   * Failure surfaced from the parent's review call. Rendered inside the
   * dialog so the reviewer sees why a return didn't go through instead of
   * the modal silently staying open with the error hidden behind it.
   */
  error?: string | null;
  /**
   * The live `param_entry` row a `direct_admin_write` conflict marker is
   * warning about (#1258). Shown above the JSON editor in revise mode so the
   * author sees what actually changed under them BEFORE editing — the part
   * that does the real work; the marker id itself is echoed back by the
   * caller once the author has revised (see `PendingEditCard.handleReviseAndResubmit`).
   * Undefined when there is no conflict, or the edit isn't a `param_entry`.
   */
  liveEntry?: {
    fields: EntryFields;
    citation?: { id: number; identifier: string; metadata: unknown } | null;
  } | null;
  /**
   * The other half of the `direct_admin_write` marker (#1293): the entry it
   * warns about was deleted directly rather than edited, so there is no live
   * row left to revise against. Renders an explicit notice in place of the
   * JSON editor, with a withdraw action instead of a submit one (#1295) —
   * any revision would still fail approval with `param_entry_target_missing`,
   * so there is nothing a resubmission here could accomplish.
   */
  conflictEntryDeleted?: boolean;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

export function ReturnDialog({
  proposedValue,
  mode = 'return',
  onReturn,
  onCancel,
  onWithdraw,
  saving,
  error,
  liveEntry,
  conflictEntryDeleted = false,
}: ReturnDialogProps) {
  const { t } = useTranslation();
  const isRevise = mode === 'revise';
  // One string for the visible heading and the dialog's accessible name, so
  // the two can never drift apart.
  const heading = isRevise
    ? t('review.reviseReturnedEdit')
    : t('review.returnEdit');
  const initialJson = useMemo(() => stableJson(proposedValue), [proposedValue]);
  const [comment, setComment] = useState('');
  const [jsonValue, setJsonValue] = useState(initialJson);
  const [jsonError, setJsonError] = useState<string | null>(null);

  // The JSON editor only exists in revise mode. A plain return is reviewer
  // feedback to the author — comment only — so there is never a proposed-value
  // change to track or send when returning.
  const changed = isRevise && jsonValue.trim() !== initialJson.trim();
  const submitDisabled =
    saving || (isRevise ? !changed : !comment.trim());

  function handleSubmit() {
    if (!isRevise) {
      onReturn({ comment: comment.trim() });
      return;
    }
    let parsed: unknown | undefined;
    if (changed) {
      try {
        parsed = JSON.parse(jsonValue);
      } catch {
        setJsonError(t('review.returnInvalidJson'));
        return;
      }
    }
    setJsonError(null);
    onReturn({
      comment: comment.trim(),
      ...(changed ? { proposedValue: parsed } : {}),
    });
  }

  return (
    <ModalOverlay
      onClose={onCancel}
      ariaLabel={heading}
      className="w-full max-w-2xl p-6"
    >
      <h3 className="mb-2 text-lg font-semibold">{heading}</h3>
      <p className="mb-3 text-sm text-muted-foreground">
        {isRevise
          ? t('review.reviseReturnedExplanation')
          : t('review.returnExplanation')}
      </p>

      {!isRevise ? (
        <>
          <label className="mb-1 block text-xs font-medium">
            {t('review.returnCommentLabel')}
          </label>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t('review.returnPlaceholder')}
            autoFocus
            className="min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </>
      ) : conflictEntryDeleted ? (
        // No JSON editor here (#1295): the marker's target row is gone, so
        // there is nothing a revised proposal could apply to — any edit
        // would still fail approval with `param_entry_target_missing`. The
        // only way forward is withdrawing the suggestion (footer button).
        <div className="mb-3 rounded-md border border-rose-500/30 bg-rose-500/10 p-2">
          <p className="text-xs font-medium text-rose-700 dark:text-rose-300">
            {t('review.conflictLiveEntryDeleted', {
              defaultValue:
                'This entry was deleted directly since you last edited it. Your proposal will need to target a different entry — it can no longer be applied to this one.',
            })}
          </p>
        </div>
      ) : (
        <>
          {liveEntry ? (
            <div className="mb-3 rounded-md border border-accent/30 bg-accent/10 p-2">
              <p className="mb-1 text-xs font-medium text-accent">
                {t('review.conflictLiveEntryHeading', {
                  defaultValue:
                    'This entry was changed directly since you last edited it — review it before revising your proposal:',
                })}
              </p>
              <EntryDetails
                fields={liveEntry.fields}
                citation={liveEntry.citation}
              />
            </div>
          ) : null}
          <label className="mb-1 mt-3 block text-xs font-medium">
            {t('review.returnProposedValueLabel')}
          </label>
          <textarea
            value={jsonValue}
            onChange={(e) => {
              setJsonValue(e.target.value);
              setJsonError(null);
            }}
            spellCheck={false}
            className="min-h-[180px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {jsonError ? (
            <p className="mt-1 text-xs text-rose-600 dark:text-rose-300">
              {jsonError}
            </p>
          ) : null}
        </>
      )}

      {error ? (
        <p className="mt-3 rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          {t('review.cancel')}
        </Button>
        {isRevise && conflictEntryDeleted ? (
          <Button variant="outline" onClick={onWithdraw} disabled={saving}>
            {t('review.cancelSuggestion')}
          </Button>
        ) : (
          <Button onClick={handleSubmit} disabled={submitDisabled}>
            {saving
              ? isRevise
                ? t('review.resubmitting')
                : t('review.returning')
              : isRevise
                ? t('review.updateAndResubmit')
                : t('review.returnForRevision')}
          </Button>
        )}
      </div>
    </ModalOverlay>
  );
}
