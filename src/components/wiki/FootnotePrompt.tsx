import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Editor } from '@tiptap/react';

interface FootnotePromptProps {
  editor: Editor;
  onAddCitation: () => void;
}

export function FootnotePrompt({ editor, onAddCitation }: FootnotePromptProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastParaRef = useRef<string | null>(null);
  const dismissedRef = useRef(new Set<string>());

  useEffect(() => {
    function checkPrompt() {
      if (!editor.isFocused) {
        setVisible(false);
        return;
      }

      const { $anchor } = editor.state.selection;
      const node = $anchor.parent;

      if (node.type.name !== 'paragraph' || node.textContent.length === 0) {
        setVisible(false);
        return;
      }

      const paraKey = `${$anchor.pos}-${node.textContent.length}`;

      if (dismissedRef.current.has(paraKey)) return;

      if (lastParaRef.current === paraKey) return;
      lastParaRef.current = paraKey;

      if (timerRef.current) clearTimeout(timerRef.current);

      timerRef.current = setTimeout(() => {
        const coords = editor.view.coordsAtPos($anchor.pos);
        const editorRect = editor.view.dom.getBoundingClientRect();
        setPosition({
          top: coords.bottom - editorRect.top + 4,
          left: coords.left - editorRect.left,
        });
        setVisible(true);

        setTimeout(() => setVisible(false), 4000);
      }, 3000);
    }

    editor.on('selectionUpdate', checkPrompt);
    editor.on('update', () => {
      setVisible(false);
      if (timerRef.current) clearTimeout(timerRef.current);
      lastParaRef.current = null;
    });

    return () => {
      editor.off('selectionUpdate', checkPrompt);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [editor]);

  if (!visible) return null;

  return (
    <div
      className="absolute z-30 bg-card border border-border rounded-md shadow-sm px-2.5 py-1.5 flex items-center gap-2 text-xs text-muted-foreground animate-in fade-in duration-200"
      style={{ top: position.top, left: position.left }}
    >
      <span>{t('references.addPrompt')}</span>
      <button
        type="button"
        onClick={() => {
          setVisible(false);
          onAddCitation();
        }}
        className="text-primary font-medium hover:underline"
      >
        [+]
      </button>
    </div>
  );
}
