import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import type { Editor } from '@tiptap/react';
import {
  MONOGRAPH_SECTIONS,
  type MonographSectionId,
} from '@/lib/monographSections';
import {
  emptyMonographContentV2,
  getSectionBody,
  isMonographContentV2,
  normalizeMonographContentV2,
  setSectionBody,
  wrapV1AsV2,
  type MonographContentV2,
  type TipTapDoc,
} from '@/lib/monographContent';
import { MonographSectionEditor } from './MonographSectionEditor';

export interface MonographSectionsEditorHandle {
  /** Returns the current v2 envelope assembled from all section editors. */
  getContent: () => MonographContentV2;
  /**
   * Returns the most recently focused section editor. The cite panel uses
   * this to know which section to insert a footnote into; falls back to the
   * first section's editor when nothing has been focused yet.
   */
  getActiveEditor: () => Editor | null;
}

interface MonographSectionsEditorProps {
  /**
   * Initial monograph content. Accepts a v2 envelope, a legacy v1 free-form
   * doc, or `null`/`undefined` (empty new monograph). Anything non-v2 is
   * wrapped under the first remaining section (`pd`) — see #396.
   */
  initialContent: unknown;
  onContentChange: (content: MonographContentV2) => void;
  onActiveReferenceChange: (referenceId: number | null) => void;
  /**
   * Wiki page id; when set, each section card surfaces an "Add fact"
   * affordance that POSTs `wiki_fact add`. Undefined in create mode (the
   * page doesn't exist yet) — the affordance is hidden there.
   */
  pageId?: number | null;
  /** Drug id used as citation context inside the AddFactPanel. */
  drugId?: number | null;
}

/**
 * Renders the monograph sections as a stack of cards, each with its own
 * TipTap surface. Owns the v2 envelope; the parent reads it via the
 * imperative ref handle on save.
 */
export const MonographSectionsEditor = forwardRef<
  MonographSectionsEditorHandle,
  MonographSectionsEditorProps
>(function MonographSectionsEditor(
  { initialContent, onContentChange, onActiveReferenceChange, pageId, drugId },
  ref,
) {
  const [content, setContent] = useState<MonographContentV2>(() => {
    if (isMonographContentV2(initialContent)) {
      return normalizeMonographContentV2(initialContent);
    }
    if (initialContent) return wrapV1AsV2(initialContent);
    return emptyMonographContentV2();
  });

  const editorsRef = useRef<Map<MonographSectionId, Editor>>(new Map());
  const lastFocusedRef = useRef<MonographSectionId | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      getContent: () => content,
      getActiveEditor: () => {
        const lastId = lastFocusedRef.current;
        if (lastId) {
          const editor = editorsRef.current.get(lastId);
          if (editor) return editor;
        }
        const firstId = MONOGRAPH_SECTIONS[0]?.id;
        return firstId ? (editorsRef.current.get(firstId) ?? null) : null;
      },
    }),
    [content],
  );

  const handleBodyChange = useCallback(
    (sectionId: MonographSectionId, body: TipTapDoc | null) => {
      setContent((prev) => {
        const next = setSectionBody(prev, sectionId, body);
        onContentChange(next);
        return next;
      });
    },
    [onContentChange],
  );

  return (
    <div className="space-y-3">
      {MONOGRAPH_SECTIONS.map((section) => (
        <MonographSectionEditor
          key={section.id}
          section={section}
          initialBody={getSectionBody(content, section.id)}
          onBodyChange={(body) => handleBodyChange(section.id, body)}
          onEditorReady={(editor) => {
            editorsRef.current.set(section.id, editor);
          }}
          onFocus={() => {
            lastFocusedRef.current = section.id;
          }}
          onSelectionChange={onActiveReferenceChange}
          pageId={pageId ?? null}
          drugId={drugId ?? null}
        />
      ))}
    </div>
  );
});
