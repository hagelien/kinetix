import { useMemo, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  Table,
  TableRow,
  TableHeader,
  TableCell,
} from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { Fact, type FactEditPayload } from './extensions/Fact';
import { Footnote } from './extensions/Footnote';
import { MathExtensions } from './extensions/Math';
import { HeadingWithSectionId } from './extensions/HeadingWithSectionId';
import { AddFactPanel } from './AddFactPanel';
import { EditFactPanel } from './EditFactPanel';
import {
  AddSectionPanel,
  localiseError,
  RemoveSectionPanel,
  RenameSectionPanel,
  ReorderSectionControls,
  submitSectionReorder,
} from './SectionOpsPanel';
import { extractTopicSections, type TopicSection } from '@/lib/topicSections';
import {
  extractConvertibleProse,
  type ConvertibleProse,
} from '@/lib/topicProseConversion';
import type { TipTapDoc } from '@/lib/monographContent';
import { createPendingEdit } from '@/lib/pendingEditsApi';
import '@/styles/wiki-prose.css';

interface TopicSectionsEditorProps {
  /**
   * Existing topic-page content. The component derives sections from
   * `data-section-id` attributes on top-level heading nodes (#310 phase
   * 2 / #348). Pages predating the migration may surface zero sections;
   * the empty state explains how an admin can add one.
   */
  content: TipTapDoc | null | undefined;
  /** Target page id; required so the fact panels can submit pending edits. */
  pageId: number;
  /**
   * Notified after any section / fact pending edit is submitted so the
   * parent page can refresh queues / toast. The submitted edit isn't
   * applied until a reviewer approves it; sections shown here come from
   * the live page content, not the in-flight queue.
   */
  onSectionEditSubmitted?: () => void;
}

/**
 * Read-only section browser for topic pages with atomic-fact and
 * section-CRUD controls attached. Mirrors the monograph section
 * editor's "hard mode" — prose stays untouched (admins still own
 * whole-page edits via the legacy surface) and every meaningful
 * change flows through `wiki_fact` or `wiki_section` pending edits.
 */
export function TopicSectionsEditor({
  content,
  pageId,
  onSectionEditSubmitted,
}: TopicSectionsEditorProps): JSX.Element {
  const { t } = useTranslation();
  const sections = useMemo<TopicSection[]>(
    () => extractTopicSections(content ?? null),
    [content],
  );
  // Track which add-section slot is open. `null` = no slot open;
  // numeric value = the section list position the new section will
  // be inserted at (0 = before first section, sections.length = at
  // end). Encoded as state because we render an "add here" affordance
  // between every two sections.
  const [addSlot, setAddSlot] = useState<number | null>(null);

  // Drag-and-drop reorder state (#359). `dragIndex` is the section
  // index being dragged; `dropIndex` is the gap-index the user is
  // currently hovering over (0 = before-first, sections.length =
  // after-last). Both reset when the drag ends.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);

  const handleSubmitted = () => {
    onSectionEditSubmitted?.();
  };

  const handleDragStart = (idx: number) => (e: DragEvent<HTMLDivElement>) => {
    setDragIndex(idx);
    setReorderError(null);
    // Native browsers refuse to start a drag without dataTransfer
    // payload in some configurations. Set a benign value so the
    // drag actually begins; we rely on React state for the index.
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
    } catch {
      /* setData can throw in tests / strict CSP — ignore. */
    }
  };

  const handleDragOver = (slot: number) => (e: DragEvent<HTMLDivElement>) => {
    // We must preventDefault on dragover for the drop event to fire.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (dropIndex !== slot) setDropIndex(slot);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDropIndex(null);
  };

  const handleDrop = async (slot: number) => {
    const from = dragIndex;
    setDragIndex(null);
    setDropIndex(null);
    if (from === null) return;
    // Translate the gap-index (slot) into the index the
    // wiki_section reorder splice expects. Dropping into the slot
    // *after* the dragged section is a no-op (same position);
    // dropping into a slot strictly before reduces the target index
    // by zero (the splice removes-then-inserts so the post-removal
    // indices line up); dropping into a slot strictly after the
    // source needs the -1 adjustment because removal shifts every
    // later section up by one.
    const target = slot > from ? slot - 1 : slot;
    if (target === from) return;
    const moving = sections[from];
    if (!moving) return;
    try {
      await submitSectionReorder({
        pageId,
        sectionId: moving.sectionId,
        position: target,
      });
      handleSubmitted();
    } catch (err) {
      // Reuse the same localization map the up/down buttons go
      // through (`localiseError` in SectionOpsPanel) so a stale-section
      // / missing-target error renders in the user's locale instead
      // of leaking the server's English prose into the Norwegian UI.
      setReorderError(localiseError(err, t));
    }
  };

  if (sections.length === 0) {
    return (
      <div className="space-y-4">
        <div className="border border-dashed border-border rounded-lg p-6 text-sm text-muted-foreground">
          {t('topicSections.empty', {
            defaultValue:
              'This topic page has no sectioned headings yet. An admin can add headings via the whole-page editor; once published, atomic facts can attach to each section.',
          })}
        </div>
        {addSlot === 0 ? (
          <AddSectionPanel
            pageId={pageId}
            position={0}
            onClose={() => setAddSlot(null)}
            onSubmitted={handleSubmitted}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAddSlot(0)}
            className="text-xs text-primary hover:underline"
          >
            + {t('topicSections.addSection')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {reorderError ? (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          {reorderError}
        </div>
      ) : null}
      {sections.map((section, idx) => (
        <div
          key={`${pageId}:${section.sectionId}`}
          className="space-y-2"
          onDragOver={handleDragOver(idx)}
          onDrop={(e) => {
            e.preventDefault();
            void handleDrop(idx);
          }}
        >
          {/* Insert affordance above each section, doubling as the
              drop indicator during a drag. */}
          {dragIndex !== null && dropIndex === idx ? (
            <div className="h-1 rounded-full bg-primary/70" />
          ) : null}
          {addSlot === idx ? (
            <AddSectionPanel
              pageId={pageId}
              position={idx}
              onClose={() => setAddSlot(null)}
              onSubmitted={handleSubmitted}
            />
          ) : dragIndex === null ? (
            <button
              type="button"
              onClick={() => setAddSlot(idx)}
              className="block w-full rounded-md border border-dashed border-border/60 bg-background/40 py-1 text-center text-[11px] text-muted-foreground hover:border-primary hover:text-primary"
            >
              + {t('topicSections.addSectionHere')}
            </button>
          ) : null}
          <TopicSectionCard
            section={section}
            pageId={pageId}
            sectionPosition={idx}
            onSubmitted={handleSubmitted}
            isDragging={dragIndex === idx}
            onDragHandleStart={handleDragStart(idx)}
            onDragHandleEnd={handleDragEnd}
          />
        </div>
      ))}
      {/* Tail drop slot — sections.length means "after last section".
          During a drag we render a tall placeholder so the slot can
          actually receive `dragover`; without it the empty div has
          zero height, the `dragover` never fires for it, dropIndex
          never becomes sections.length, and dropping at the end is
          unreachable. */}
      <div
        onDragOver={handleDragOver(sections.length)}
        onDrop={(e) => {
          e.preventDefault();
          void handleDrop(sections.length);
        }}
      >
        {dragIndex !== null && dropIndex === sections.length ? (
          <div className="h-1 rounded-full bg-primary/70 mb-2" />
        ) : null}
        {addSlot === sections.length ? (
          <AddSectionPanel
            pageId={pageId}
            position={sections.length}
            onClose={() => setAddSlot(null)}
            onSubmitted={handleSubmitted}
          />
        ) : dragIndex === null ? (
          <button
            type="button"
            onClick={() => setAddSlot(sections.length)}
            className="block w-full rounded-md border border-dashed border-border/60 bg-background/40 py-1 text-center text-[11px] text-muted-foreground hover:border-primary hover:text-primary"
          >
            + {t('topicSections.addSectionAtEnd')}
          </button>
        ) : (
          <div
            aria-hidden="true"
            className="h-12 rounded-md border border-dashed border-border/40 bg-background/20"
          />
        )}
      </div>
    </div>
  );
}

interface TopicSectionCardProps {
  section: TopicSection;
  pageId: number;
  sectionPosition: number;
  onSubmitted: () => void;
  isDragging: boolean;
  onDragHandleStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragHandleEnd: () => void;
}

function TopicSectionCard({
  section,
  pageId,
  sectionPosition,
  onSubmitted,
  isDragging,
  onDragHandleStart,
  onDragHandleEnd,
}: TopicSectionCardProps): JSX.Element {
  const { t } = useTranslation();
  const [editingFact, setEditingFact] = useState<FactEditPayload | null>(null);
  const [showAddFact, setShowAddFact] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [reorderError, setReorderError] = useState<string | null>(null);
  // Prose→fact conversion (#310 phase 3). `converting` toggles the list
  // of legacy paragraphs; `convertTarget` is the paragraph currently
  // being promoted into a fact via a pre-filled Add-fact panel.
  const [converting, setConverting] = useState(false);
  const [convertTarget, setConvertTarget] = useState<ConvertibleProse | null>(
    null,
  );

  const sectionDoc = useMemo(
    () => ({ type: 'doc', content: section.bodyContent }),
    [section.bodyContent],
  );

  // Legacy prose paragraphs in this section that an author can promote
  // into atomic facts. Empty once a section is fully fact-based.
  const convertibleProse = useMemo<ConvertibleProse[]>(
    () => extractConvertibleProse(section.bodyContent),
    [section.bodyContent],
  );

  // Stable list of factIds in document order so the reorder callback
  // can compute the source position from the bodyContent. Recomputed
  // each render but cheap — bodyContent length stays small per
  // section.
  const factIdsInOrder = useMemo<string[]>(() => {
    const ids: string[] = [];
    for (const node of section.bodyContent) {
      const n = node as { type?: string; attrs?: { factId?: string } } | null;
      if (n?.type === 'fact' && typeof n.attrs?.factId === 'string') {
        ids.push(n.attrs.factId);
      }
    }
    return ids;
  }, [section.bodyContent]);

  async function move(factId: string, direction: -1 | 1) {
    const cur = factIdsInOrder.indexOf(factId);
    if (cur === -1) return;
    const target = cur + direction;
    if (target < 0 || target >= factIdsInOrder.length) return; // edge fact, no-op
    setReorderError(null);
    try {
      await createPendingEdit({
        editType: 'wiki_fact',
        targetId: pageId,
        proposedValue: { position: target },
        sectionId: section.sectionId,
        factOperation: 'reorder',
        factTargetAnchor: { factId },
      });
      onSubmitted();
    } catch (err) {
      // Surface the failure inline. Without this the user sees an
      // arrow click do nothing — Codex review on #369 flagged that
      // a network blip / expired session is otherwise invisible.
      setReorderError(err instanceof Error ? err.message : String(err));
    }
  }

  const editor = useEditor({
    editable: false,
    extensions: [
      StarterKit.configure({ link: false, heading: false }),
      HeadingWithSectionId,
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Image,
      Link.configure({ openOnClick: false }),
      Footnote,
      Fact.configure({
        onEdit: (payload) => {
          setEditingFact(payload);
          setShowAddFact(false);
        },
        onMoveUp: ({ factId }) => void move(factId, -1),
        onMoveDown: ({ factId }) => void move(factId, 1),
      }),
      // Render any inline/display math stored in topic section bodies.
      ...MathExtensions,
    ],
    content: sectionDoc as unknown as Record<string, unknown>,
    editorProps: {
      attributes: {
        class:
          'wiki-prose prose prose-sm max-w-none focus:outline-none min-h-[60px] px-4 py-3',
      },
    },
  });

  return (
    <section
      data-topic-section={section.sectionId}
      className={`border border-border rounded-lg overflow-hidden bg-background transition-opacity ${
        isDragging ? 'opacity-40' : ''
      }`}
    >
      <header className="px-4 py-2 bg-muted/30 border-b border-border">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-2 min-w-0">
            <span
              draggable
              onDragStart={(e) =>
                onDragHandleStart(e as unknown as DragEvent<HTMLDivElement>)
              }
              onDragEnd={onDragHandleEnd}
              title={t('topicSections.dragHandle', {
                defaultValue: 'Drag to reorder',
              })}
              aria-label={t('topicSections.dragHandle', {
                defaultValue: 'Drag to reorder',
              })}
              className="cursor-grab text-muted-foreground/60 select-none hover:text-foreground active:cursor-grabbing"
            >
              ⠿
            </span>
            <h2 className="text-sm font-semibold tracking-tight truncate">
              {section.headingText || section.sectionId}
            </h2>
          </div>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-mono">
            {section.sectionId}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setRenaming((v) => !v);
                setRemoving(false);
              }}
              className="text-xs text-muted-foreground hover:text-primary hover:underline"
            >
              {t('topicSections.renameSection')}
            </button>
            <button
              type="button"
              onClick={() => {
                setRemoving((v) => !v);
                setRenaming(false);
              }}
              className="text-xs text-muted-foreground hover:text-rose-600 hover:underline"
            >
              {t('topicSections.removeSection')}
            </button>
          </div>
          <ReorderSectionControls
            pageId={pageId}
            sectionId={section.sectionId}
            position={sectionPosition}
            onSubmitted={onSubmitted}
          />
        </div>
      </header>
      {renaming ? (
        <RenameSectionPanel
          pageId={pageId}
          sectionId={section.sectionId}
          initialText={section.headingText}
          onClose={() => setRenaming(false)}
          onSubmitted={onSubmitted}
        />
      ) : null}
      {removing ? (
        <RemoveSectionPanel
          pageId={pageId}
          sectionId={section.sectionId}
          factCount={factIdsInOrder.length}
          proseCount={section.bodyContent.length - factIdsInOrder.length}
          onClose={() => setRemoving(false)}
          onSubmitted={onSubmitted}
        />
      ) : null}
      {reorderError ? (
        <div
          role="alert"
          className="border-t border-border bg-rose-500/10 px-4 py-2 text-xs text-rose-700 dark:text-rose-300 flex items-center justify-between gap-2"
        >
          <span>{reorderError}</span>
          <button
            type="button"
            onClick={() => setReorderError(null)}
            className="text-rose-500 hover:text-rose-700"
            aria-label={
              t('common.dismiss', { defaultValue: 'Dismiss' }) as string
            }
          >
            ×
          </button>
        </div>
      ) : null}
      <EditorContent editor={editor} />
      {editingFact ? (
        <EditFactPanel
          key={editingFact.factId}
          pageId={pageId}
          sectionId={section.sectionId}
          factId={editingFact.factId}
          initialStatement={editingFact.statement}
          initialContent={editingFact.content}
          initialReferenceIds={editingFact.referenceIds}
          onClose={() => setEditingFact(null)}
          onSubmitted={() => {
            onSubmitted();
          }}
        />
      ) : convertTarget ? (
        <AddFactPanel
          key={`convert-${convertTarget.index}`}
          pageId={pageId}
          sectionId={section.sectionId}
          initialStatement={convertTarget.text}
          initialContent={convertTarget.content}
          initialReferenceIds={convertTarget.referenceIds}
          onClose={() => setConvertTarget(null)}
          onSubmitted={onSubmitted}
        />
      ) : showAddFact ? (
        <AddFactPanel
          pageId={pageId}
          sectionId={section.sectionId}
          onClose={() => setShowAddFact(false)}
          onSubmitted={() => {
            onSubmitted();
          }}
        />
      ) : converting ? (
        <div className="space-y-2 border-t border-border bg-muted/10 px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">
              {t('wikiFact.convertTitle')}
            </span>
            <button
              type="button"
              onClick={() => setConverting(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {t('common.cancel')}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('wikiFact.convertHint')}
          </p>
          <ul className="space-y-2">
            {convertibleProse.map((prose) => (
              <li
                key={prose.index}
                className="flex items-start justify-between gap-2 rounded bg-background px-2 py-1.5"
              >
                <span className="leading-snug text-xs">{prose.text}</span>
                <button
                  type="button"
                  onClick={() => {
                    setConvertTarget(prose);
                    setConverting(false);
                  }}
                  className="shrink-0 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90"
                >
                  {t('wikiFact.convertThis')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex items-center gap-3 border-t border-border bg-muted/10 px-4 py-2">
          <button
            type="button"
            onClick={() => setShowAddFact(true)}
            className="text-xs text-primary hover:underline"
          >
            {t('wikiFact.addFact', { defaultValue: 'Add fact' })}
          </button>
          {convertibleProse.length > 0 ? (
            <button
              type="button"
              onClick={() => setConverting(true)}
              className="text-xs text-primary hover:underline"
            >
              {t('wikiFact.convertProse', { count: convertibleProse.length })}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
