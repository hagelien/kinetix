import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { activeLangCode } from '@/lib/useDrugName';
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
import { AddFactPanel } from './AddFactPanel';
import { EditFactPanel } from './EditFactPanel';
import type { MonographSection } from '@/lib/monographSections';
import {
  emptyTipTapDoc,
  hasLegacyProse,
  isTipTapDocEmpty,
  type TipTapDoc,
} from '@/lib/monographContent';
import '@/styles/wiki-prose.css';

interface MonographSectionEditorProps {
  section: MonographSection;
  /**
   * Initial body for this section. `null`/undefined renders an empty TipTap
   * surface seeded with one empty paragraph.
   */
  initialBody: TipTapDoc | null;
  /** Called whenever the section's body changes. Empty bodies are reported as null. */
  onBodyChange: (body: TipTapDoc | null) => void;
  /**
   * Surfaces the editor instance to the parent so it can target citation
   * inserts at the most recently focused section.
   */
  onEditorReady: (editor: Editor) => void;
  onFocus: () => void;
  onSelectionChange: (referenceId: number | null) => void;
  /**
   * When provided, the section card shows an "Add fact" affordance that
   * POSTs a `wiki_fact add` pending edit. Only present in edit mode where
   * the target page id is known; create mode (page doesn't exist yet)
   * intentionally hides it.
   */
  pageId?: number | null;
  /** Drug id for citation context; passed through to the AddFactPanel. */
  drugId?: number | null;
}

/**
 * Card renderer for a single monograph section. Owns one TipTap editor and
 * reports body changes upward as v2 content fragments. The card always shows
 * the Norwegian heading + author hint so empty sections look intentional
 * rather than broken.
 */
export function MonographSectionEditor({
  section,
  initialBody,
  onBodyChange,
  onEditorReady,
  onFocus,
  onSelectionChange,
  pageId,
  drugId,
}: MonographSectionEditorProps): JSX.Element {
  const [showAddFact, setShowAddFact] = useState(false);
  const [editingFact, setEditingFact] = useState<FactEditPayload | null>(null);
  // Section heading + author hint follow the active UI language; Norwegian
  // is canonical and the fallback for any non-`en` locale.
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);
  const title = lang === 'en' ? section.titleEn : section.titleNb;
  const description =
    lang === 'en' ? section.descriptionEn : section.descriptionNb;
  const addFactLabel = t('wikiFact.addToSection', { section: title });

  // #303 hard mode applies only once the page exists (edit flow):
  //   - create flow (pageId == null): editor stays editable so the
  //     initial monograph shell can be authored in one shot — there's
  //     no AddFactPanel surface yet because pending edits need a
  //     pageId. This v1 prose is grandfathered on the next edit.
  //   - edit flow (pageId set): editor is read-only; new content
  //     lands exclusively via AddFactPanel as `wiki_fact add` pending
  //     edits.
  const isHardMode = pageId != null;
  const editor = useEditor({
    editable: !isHardMode,
    extensions: [
      StarterKit.configure({ link: false }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      Image,
      Link.configure({ openOnClick: false }),
      Footnote,
      Fact.configure({
        // The FactView's "Edit" button always opens the EditFactPanel —
        // the panel posts a `wiki_fact replace`/`remove` pending edit
        // and never mutates the editor directly, so it stays usable
        // even when the section is read-only.
        onEdit: pageId ? setEditingFact : undefined,
      }),
      // Inline `$…$` / display `$$…$$` math (KaTeX) via input rules.
      ...MathExtensions,
    ],
    content: (initialBody ?? emptyTipTapDoc()) as unknown as Record<
      string,
      unknown
    >,
    editorProps: {
      attributes: {
        class:
          'wiki-prose prose prose-sm max-w-none focus:outline-none min-h-[120px] px-4 py-3',
      },
    },
  });

  // Surface the editor instance once it exists. Re-runs when the editor
  // identity changes (TipTap recreates on extension change, which we don't,
  // but the dependency keeps StrictMode happy).
  const onEditorReadyRef = useRef(onEditorReady);
  onEditorReadyRef.current = onEditorReady;
  useEffect(() => {
    if (editor) onEditorReadyRef.current(editor);
  }, [editor]);

  // Forward body changes upward. The parent assembles the v2 envelope from
  // these per-section deltas.
  const onBodyChangeRef = useRef(onBodyChange);
  onBodyChangeRef.current = onBodyChange;
  useEffect(() => {
    if (!editor) return;
    const sync = () => {
      const json = editor.getJSON() as unknown as TipTapDoc;
      onBodyChangeRef.current(isTipTapDocEmpty(json) ? null : json);
    };
    editor.on('update', sync);
    return () => {
      editor.off('update', sync);
    };
  }, [editor]);

  // Active-footnote highlighting: when this section has focus, report which
  // referenceId (if any) the cursor sits in so the parent's references panel
  // can highlight the matching entry.
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  useEffect(() => {
    if (!editor) return;
    const sync = () => {
      if (!editor.isFocused) return;
      const { from } = editor.state.selection;
      let found: number | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (found != null) return false;
        if (node.type.name === 'footnote') {
          const end = pos + node.nodeSize;
          if (from >= pos && from <= end) {
            const refId = node.attrs.referenceId;
            if (typeof refId === 'number') found = refId;
            return false;
          }
        }
        return true;
      });
      onSelectionChangeRef.current(found);
    };
    sync();
    editor.on('selectionUpdate', sync);
    editor.on('update', sync);
    return () => {
      editor.off('selectionUpdate', sync);
      editor.off('update', sync);
    };
  }, [editor]);

  // Show the legacy-prose deprecation hint only on sections that still
  // carry grandfathered v1 prose AND only in edit mode. In create mode
  // (pageId == null) the editor is editable for the initial shell, so
  // the banner would contradict valid input — author types prose,
  // banner immediately tells them prose is forbidden, even though
  // AddFactPanel can't surface yet.
  const showLegacyBanner = isHardMode && hasLegacyProse(initialBody);

  return (
    <section
      data-monograph-section={section.id}
      className="border border-border rounded-lg overflow-hidden bg-background"
      onFocus={onFocus}
    >
      <header className="px-4 py-2 bg-muted/30 border-b border-border">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </header>
      {showLegacyBanner ? (
        <div
          className="border-b border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs text-amber-900 dark:text-amber-200"
          role="note"
        >
          {t('wikiFact.legacyProseBanner', {
            defaultValue:
              'Existing prose is grandfathered as legacy. New content must be added as atomic facts via the panel below (#303).',
          })}
        </div>
      ) : null}
      <EditorContent editor={editor} />
      {pageId && editingFact ? (
        <EditFactPanel
          // Keying by factId remounts the panel when the user clicks a
          // different fact's Edit button while one is already open;
          // EditFactPanel reads its `initial*` props only in useState
          // initializers, so without a key the textarea + ref state would
          // stay stale and a submit could post the old fact's content
          // against the newly selected anchor.
          key={editingFact.factId}
          pageId={pageId}
          sectionId={section.id}
          factId={editingFact.factId}
          initialStatement={editingFact.statement}
          initialContent={editingFact.content}
          initialReferenceIds={editingFact.referenceIds}
          drugId={drugId ?? null}
          onClose={() => setEditingFact(null)}
          onSubmitted={() => {
            /* the queue picks the new pending edit up on next refresh */
          }}
        />
      ) : pageId ? (
        showAddFact ? (
          <AddFactPanel
            pageId={pageId}
            sectionId={section.id}
            drugId={drugId ?? null}
            onClose={() => setShowAddFact(false)}
            onSubmitted={() => {
              /* parent typically toasts; the panel resets + closes itself */
            }}
          />
        ) : (
          <div className="border-t border-border bg-muted/10 px-4 py-2">
            <button
              type="button"
              onClick={() => setShowAddFact(true)}
              className="text-xs text-primary hover:underline"
            >
              {addFactLabel}
            </button>
          </div>
        )
      ) : null}
    </section>
  );
}
