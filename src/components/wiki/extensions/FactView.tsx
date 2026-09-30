import { useTranslation } from 'react-i18next';
import {
  NodeViewContent,
  NodeViewWrapper,
  type NodeViewProps,
} from '@tiptap/react';

/**
 * Node view for atomic-fact wrapper nodes (issue #284). Renders the fact's
 * children via `NodeViewContent` so the inner paragraph stays editable in
 * place; adds a small "Edit" affordance in the corner that fires the
 * extension's `onEdit` callback with the fact's identity + plaintext +
 * references. The MonographSectionEditor uses that callback to open the
 * EditFactPanel for a `wiki_fact replace`/`remove` submission.
 *
 * The Edit button shows whenever the host has wired an `onEdit` handler,
 * independent of `editor.isEditable`. The button never mutates the
 * editor directly — it opens the EditFactPanel, which submits a
 * `wiki_fact` pending edit — so #303 hard-mode read-only sections still
 * need the affordance to keep approved facts editable through the
 * pending-edit pipeline.
 */
export function FactView({ node, extension }: NodeViewProps): JSX.Element {
  const { t } = useTranslation();
  const factId =
    typeof node.attrs.factId === 'string' ? node.attrs.factId : null;
  const referenceIdsRaw = node.attrs.referenceIds;
  const referenceIds = Array.isArray(referenceIdsRaw)
    ? (referenceIdsRaw.filter(
        (n: unknown): n is number =>
          typeof n === 'number' && Number.isFinite(n),
      ) as number[])
    : [];

  const onEdit = extension.options.onEdit as
    | ((data: {
        factId: string;
        statement: string;
        content: unknown[];
        referenceIds: number[];
      }) => void)
    | undefined;
  const onMoveUp = extension.options.onMoveUp as
    | ((data: { factId: string }) => void)
    | undefined;
  const onMoveDown = extension.options.onMoveDown as
    | ((data: { factId: string }) => void)
    | undefined;

  function gatherStatement(): string {
    const parts: string[] = [];
    node.descendants((child) => {
      if (child.isText && typeof child.text === 'string') {
        parts.push(child.text);
      }
    });
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function gatherContent(): unknown[] {
    const json = node.toJSON() as { content?: unknown[] };
    return Array.isArray(json.content) ? json.content : [];
  }

  function handleEdit(event: React.MouseEvent) {
    // Block ProseMirror from re-focusing the editor on the click and
    // hijacking the focused selection — we want to open a panel, not move
    // the cursor.
    event.preventDefault();
    event.stopPropagation();
    if (!factId || !onEdit) return;
    onEdit({
      factId,
      statement: gatherStatement(),
      content: gatherContent(),
      referenceIds,
    });
  }

  function handleMove(event: React.MouseEvent, direction: 'up' | 'down') {
    event.preventDefault();
    event.stopPropagation();
    if (!factId) return;
    if (direction === 'up') onMoveUp?.({ factId });
    else onMoveDown?.({ factId });
  }

  // Stacked button group in the corner. Buttons are hover-only the
  // same way Edit is — keeps prose readable when the fact list is
  // long. The ↑ on the first fact and ↓ on the last fact still
  // render but the host's reorder handler safely no-ops on
  // out-of-range moves.
  const showReorder = Boolean(onMoveUp || onMoveDown);
  const buttonClass =
    'rounded border border-border bg-background/80 px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100 focus:opacity-100';

  return (
    <NodeViewWrapper
      className="monograph-fact group relative"
      data-fact-id={factId ?? undefined}
    >
      {factId && (onEdit || showReorder) ? (
        <div
          className="absolute right-1 top-1 flex items-center gap-1"
          contentEditable={false}
        >
          {onMoveUp ? (
            <button
              type="button"
              contentEditable={false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => handleMove(e, 'up')}
              className={buttonClass}
              aria-label={
                t('wikiFact.moveUp', {
                  defaultValue: 'Move fact up',
                }) as string
              }
              title={
                t('wikiFact.moveUp', {
                  defaultValue: 'Move fact up',
                }) as string
              }
            >
              ↑
            </button>
          ) : null}
          {onMoveDown ? (
            <button
              type="button"
              contentEditable={false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => handleMove(e, 'down')}
              className={buttonClass}
              aria-label={
                t('wikiFact.moveDown', {
                  defaultValue: 'Move fact down',
                }) as string
              }
              title={
                t('wikiFact.moveDown', {
                  defaultValue: 'Move fact down',
                }) as string
              }
            >
              ↓
            </button>
          ) : null}
          {onEdit ? (
            <button
              type="button"
              contentEditable={false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleEdit}
              className={buttonClass}
              aria-label={t('wikiFact.editAria') as string}
            >
              {t('wikiFact.editButton')}
            </button>
          ) : null}
        </div>
      ) : null}
      <NodeViewContent />
    </NodeViewWrapper>
  );
}
