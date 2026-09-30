import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, createPendingEdit } from '@/lib/pendingEditsApi';

const SECTION_ERROR_KEYS: Record<string, string> = {
  wiki_section_invalid_section_id: 'topicSections.errorInvalidSectionId',
  wiki_section_not_found: 'topicSections.errorSectionNotFound',
  wiki_section_unsupported_page_type: 'topicSections.errorPageTypeUnsupported',
};

interface BaseProps {
  pageId: number;
  onClose: () => void;
  onSubmitted: () => void;
}

interface AddPanelProps extends BaseProps {
  position: number;
}

interface RenamePanelProps extends BaseProps {
  sectionId: string;
  initialText: string;
}

interface ReorderControlProps {
  pageId: number;
  sectionId: string;
  position: number;
  onSubmitted: () => void;
}

interface RemovePanelProps extends BaseProps {
  sectionId: string;
  /** Number of fact nodes in the section. Cascade-eligible. */
  factCount: number;
  /** Number of non-fact nodes (paragraphs / lists / etc). Blocks removal. */
  proseCount: number;
}

export function localiseError(err: unknown, t: (k: string) => string): string {
  if (err instanceof ApiError) {
    const key = err.code ? SECTION_ERROR_KEYS[err.code] : null;
    if (key) return t(key);
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Shared reorder submission so the up/down buttons and the
 * drag-and-drop handler post identical payloads (#349 / #359). The
 * caller decides how to compute `position`; this helper just owns
 * the createPendingEdit shape.
 */
export async function submitSectionReorder(args: {
  pageId: number;
  sectionId: string;
  position: number;
}): Promise<void> {
  await createPendingEdit({
    editType: 'wiki_section',
    targetId: args.pageId,
    proposedValue: {
      operation: 'reorder',
      position: Math.max(0, args.position),
    },
    sectionId: args.sectionId,
  });
}

/** Inline form for submitting a `wiki_section add` pending edit. */
export function AddSectionPanel({
  pageId,
  position,
  onClose,
  onSubmitted,
}: AddPanelProps): JSX.Element {
  const { t } = useTranslation();
  const [headingText, setHeadingText] = useState('');
  const [headingLevel, setHeadingLevel] = useState<2 | 3>(2);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = headingText.trim();
  const canSubmit = !submitting && trimmed.length > 0 && trimmed.length <= 200;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await createPendingEdit({
        editType: 'wiki_section',
        targetId: pageId,
        proposedValue: {
          operation: 'add',
          headingText: trimmed,
          headingLevel,
          position,
        },
      });
      onSubmitted();
      setHeadingText('');
      onClose();
    } catch (err) {
      setError(localiseError(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed border-border bg-muted/20 px-3 py-2">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          type="text"
          value={headingText}
          onChange={(e) => setHeadingText(e.target.value)}
          placeholder={t('topicSections.newHeadingPlaceholder')}
          maxLength={200}
          className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>{t('topicSections.newHeadingLevelLabel')}</span>
          <select
            value={headingLevel}
            onChange={(e) => setHeadingLevel(Number(e.target.value) as 2 | 3)}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs"
          >
            <option value={2}>H2</option>
            <option value={3}>H3</option>
          </select>
        </label>
      </div>
      {error ? (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-2 py-1 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="rounded-md border border-input bg-background px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          {t('topicSections.cancel')}
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {submitting ? t('topicSections.submitting') : t('topicSections.submit')}
        </button>
      </div>
    </div>
  );
}

/** Inline form for submitting a `wiki_section edit` (rename) pending edit. */
export function RenameSectionPanel({
  pageId,
  sectionId,
  initialText,
  onClose,
  onSubmitted,
}: RenamePanelProps): JSX.Element {
  const { t } = useTranslation();
  const [headingText, setHeadingText] = useState(initialText);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = headingText.trim();
  const canSubmit =
    !submitting &&
    trimmed.length > 0 &&
    trimmed.length <= 200 &&
    trimmed !== initialText.trim();

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await createPendingEdit({
        editType: 'wiki_section',
        targetId: pageId,
        proposedValue: {
          operation: 'edit',
          headingText: trimmed,
        },
        // Top-level sectionId column anchors the target. The pending-edits
        // API exposes it through the createPendingEdit body — see the
        // schema's superRefine block.
        sectionId,
      });
      onSubmitted();
      onClose();
    } catch (err) {
      setError(localiseError(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-2 px-3 py-2">
      <input
        autoFocus
        type="text"
        value={headingText}
        onChange={(e) => setHeadingText(e.target.value)}
        placeholder={t('topicSections.renamePlaceholder')}
        maxLength={200}
        className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      {error ? (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-2 py-1 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="rounded-md border border-input bg-background px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          {t('topicSections.cancel')}
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {submitting ? t('topicSections.submitting') : t('topicSections.submit')}
        </button>
      </div>
    </div>
  );
}

/** Move-up / move-down buttons that submit a `wiki_section reorder`. */
export function ReorderSectionControls({
  pageId,
  sectionId,
  position,
  onSubmitted,
}: ReorderControlProps): JSX.Element {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function move(delta: number) {
    setSubmitting(true);
    setError(null);
    try {
      await submitSectionReorder({
        pageId,
        sectionId,
        position: position + delta,
      });
      onSubmitted();
    } catch (err) {
      setError(localiseError(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => move(-1)}
        disabled={submitting || position === 0}
        title={t('topicSections.moveUp')}
        aria-label={t('topicSections.moveUp')}
        className="rounded-md border border-input bg-background px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-30"
      >
        ↑
      </button>
      <button
        type="button"
        onClick={() => move(1)}
        disabled={submitting}
        title={t('topicSections.moveDown')}
        aria-label={t('topicSections.moveDown')}
        className="rounded-md border border-input bg-background px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-30"
      >
        ↓
      </button>
      {error ? (
        <span className="ml-2 text-xs text-rose-600">{error}</span>
      ) : null}
    </div>
  );
}

/** Confirmation panel for submitting a `wiki_section remove` pending edit. */
export function RemoveSectionPanel({
  pageId,
  sectionId,
  factCount,
  proseCount,
  onClose,
  onSubmitted,
}: RemovePanelProps): JSX.Element {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // #360 cascade flag — only meaningful when the section has facts.
  // It rejects pending fact edits and strips existing facts before
  // the section is spliced out.
  const [cascade, setCascade] = useState(false);

  const hasFacts = factCount > 0;
  const hasProse = proseCount > 0;
  // Cascade only addresses fact nodes — non-fact prose still blocks
  // the splice on the server (Codex review on #370 round 1). Surface
  // that constraint up-front so the user doesn't submit a cascade
  // that the API will reject.
  const proseBlocks = hasProse;
  const blocked = (hasFacts && !cascade) || proseBlocks;

  async function handleSubmit() {
    if (blocked || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await createPendingEdit({
        editType: 'wiki_section',
        targetId: pageId,
        proposedValue: cascade
          ? { operation: 'remove', cascade: true }
          : { operation: 'remove' },
        sectionId,
      });
      onSubmitted();
      onClose();
    } catch (err) {
      setError(localiseError(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-2 px-3 py-2">
      {proseBlocks ? (
        <p className="text-xs text-rose-700 dark:text-rose-300">
          {t('topicSections.removeBlockedByProse', {
            count: proseCount,
            defaultValue:
              'This section has {{count}} non-fact paragraph(s). Cascade only addresses facts — remove the prose via the whole-page editor first.',
          })}
        </p>
      ) : hasFacts ? (
        <>
          <p className="text-xs text-rose-700 dark:text-rose-300">
            {t('topicSections.removeWarningWithFacts', { count: factCount })}
          </p>
          <label className="flex items-start gap-2 text-xs text-foreground">
            <input
              type="checkbox"
              checked={cascade}
              onChange={(e) => setCascade(e.target.checked)}
              disabled={submitting}
              className="mt-0.5"
            />
            <span>
              {t('topicSections.removeCascadeLabel', {
                count: factCount,
                defaultValue:
                  'Also remove the {{count}} fact(s) and reject any pending fact edits in this section',
              })}
            </span>
          </label>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t('topicSections.removeConfirmEmpty')}
        </p>
      )}
      {error ? (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-2 py-1 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="rounded-md border border-input bg-background px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          {t('topicSections.cancel')}
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={blocked || submitting}
          className="rounded-md bg-rose-600 px-3 py-1 text-xs text-white hover:bg-rose-600/90 disabled:opacity-50"
        >
          {submitting
            ? t('topicSections.submitting')
            : t('topicSections.removeSection')}
        </button>
      </div>
    </div>
  );
}
