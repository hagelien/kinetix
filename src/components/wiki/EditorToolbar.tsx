import type { Editor } from '@tiptap/react';
import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface EditorToolbarProps {
  editor: Editor;
  onCite?: () => void;
}

function ToolbarButton({
  onClick,
  active,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`px-2 py-1 text-xs rounded hover:bg-muted/80 disabled:opacity-30 ${
        active ? 'bg-muted text-foreground font-semibold' : 'text-muted-foreground'
      }`}
    >
      {children}
    </button>
  );
}

function Separator() {
  return <div className="w-px h-5 bg-border mx-1" />;
}

export function EditorToolbar({ editor, onCite }: EditorToolbarProps) {
  const { t } = useTranslation();
  const [showLinkInput, setShowLinkInput] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [wikiResults, setWikiResults] = useState<Array<{ slug: string; title: string }>>([]);
  const linkContainerRef = useRef<HTMLDivElement>(null);

  // Search wiki pages when link input looks like a search query (not a URL)
  useEffect(() => {
    if (!showLinkInput || !linkUrl.trim() || linkUrl.startsWith('http') || linkUrl.startsWith('/')) {
      setWikiResults([]);
      return;
    }
    const timer = setTimeout(() => {
      fetch(`/api/wiki/search?q=${encodeURIComponent(linkUrl)}&limit=5&view=compact`)
        .then((r) => r.ok ? r.json() : { results: [] })
        .then((data) => setWikiResults(data.results ?? data.pages ?? []))
        .catch(() => setWikiResults([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [linkUrl, showLinkInput]);

  function setLink(url?: string) {
    const href = url ?? linkUrl;
    if (href) {
      editor.chain().focus().setLink({ href }).run();
    }
    setShowLinkInput(false);
    setLinkUrl('');
    setWikiResults([]);
  }

  return (
    <div className="flex items-center gap-0.5 flex-wrap border-b border-border px-2 py-1.5 bg-muted/30">
      {/* Text formatting */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive('bold')}
        title={t('wikiEditor.toolbar.bold')}
      >
        B
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive('italic')}
        title={t('wikiEditor.toolbar.italic')}
      >
        <em>I</em>
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive('strike')}
        title={t('wikiEditor.toolbar.strikethrough')}
      >
        <s>S</s>
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleCode().run()}
        active={editor.isActive('code')}
        title={t('wikiEditor.toolbar.inlineCode')}
      >
        {'</>'}
      </ToolbarButton>

      <Separator />

      {/* Headings */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        active={editor.isActive('heading', { level: 1 })}
        title={t('wikiEditor.toolbar.heading1')}
      >
        H1
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={editor.isActive('heading', { level: 2 })}
        title={t('wikiEditor.toolbar.heading2')}
      >
        H2
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        active={editor.isActive('heading', { level: 3 })}
        title={t('wikiEditor.toolbar.heading3')}
      >
        H3
      </ToolbarButton>

      <Separator />

      {/* Lists */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive('bulletList')}
        title={t('wikiEditor.toolbar.bulletList')}
      >
        {t('wikiEditor.toolbar.bulletListLabel')}
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive('orderedList')}
        title={t('wikiEditor.toolbar.orderedList')}
      >
        1.
      </ToolbarButton>

      <Separator />

      {/* Block elements */}
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        active={editor.isActive('blockquote')}
        title={t('wikiEditor.toolbar.blockquote')}
      >
        {t('wikiEditor.toolbar.blockquoteLabel')}
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        active={editor.isActive('codeBlock')}
        title={t('wikiEditor.toolbar.codeBlock')}
      >
        {t('wikiEditor.toolbar.codeBlockLabel')}
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
        title={t('wikiEditor.toolbar.horizontalRule')}
      >
        &#8213;
      </ToolbarButton>

      <Separator />

      {/* Table */}
      <ToolbarButton
        onClick={() =>
          editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
        }
        title={t('wikiEditor.toolbar.insertTable')}
      >
        {t('wikiEditor.toolbar.insertTableLabel')}
      </ToolbarButton>

      {/* Link */}
      <ToolbarButton
        onClick={() => {
          if (editor.isActive('link')) {
            editor.chain().focus().unsetLink().run();
          } else {
            setShowLinkInput(true);
          }
        }}
        active={editor.isActive('link')}
        title={t('wikiEditor.toolbar.link')}
      >
        {t('wikiEditor.toolbar.linkLabel')}
      </ToolbarButton>

      {/* Image */}
      <ToolbarButton
        onClick={() => {
          const url = prompt(t('wiki.insertImage'));
          if (url) editor.chain().focus().setImage({ src: url }).run();
        }}
        title={t('wikiEditor.toolbar.insertImage')}
      >
        {t('wikiEditor.toolbar.insertImageLabel')}
      </ToolbarButton>

      <Separator />

      {/* Math (KaTeX) */}
      <ToolbarButton
        onClick={() => {
          const tex = prompt(
            t("wiki.insertMathInline", {
              defaultValue: "Inline LaTeX (e.g. C_0 e^{-kt})",
            }),
          );
          if (tex?.trim())
            editor.chain().focus().insertMathInline(tex.trim()).run();
        }}
        title={t('wikiEditor.toolbar.inlineMath')}
      >
        <em>∑</em>
      </ToolbarButton>
      <ToolbarButton
        onClick={() => {
          const tex = prompt(
            t("wiki.insertMathBlock", {
              defaultValue: "Display LaTeX (e.g. \\frac{a}{b})",
            }),
          );
          if (tex?.trim())
            editor.chain().focus().insertMathBlock(tex.trim()).run();
        }}
        title={t('wikiEditor.toolbar.displayMath')}
      >
        ∑▢
      </ToolbarButton>

      {/* Citation */}
      {onCite && (
        <>
          <Separator />
          <ToolbarButton onClick={onCite} title={t('wikiEditor.toolbar.insertCitation')}>
            {t('wikiEditor.toolbar.insertCitationLabel')}
          </ToolbarButton>
        </>
      )}

      {/* Inline link input with wiki page search */}
      {showLinkInput && (
        <div ref={linkContainerRef} className="relative flex items-center gap-1 ml-2">
          <div className="relative">
            <input
              type="text"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && setLink()}
              placeholder={t('wiki.searchOrPasteUrl')}
              className="px-2 py-0.5 text-xs border border-input rounded bg-background w-64"
              autoFocus
            />
            {wikiResults.length > 0 && (
              <div className="absolute z-50 top-full left-0 w-full mt-1 bg-card border rounded shadow-lg max-h-40 overflow-y-auto">
                {wikiResults.map((p) => (
                  <button
                    key={p.slug}
                    className="w-full text-left px-2 py-1.5 text-xs hover:bg-muted/50 border-b last:border-b-0"
                    onClick={() => setLink(`/wiki/${p.slug}`)}
                  >
                    {p.title}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => setLink()}
            className="text-xs px-2 py-0.5 bg-primary text-primary-foreground rounded"
          >
            OK
          </button>
          <button
            onClick={() => {
              setShowLinkInput(false);
              setLinkUrl('');
            }}
            className="text-xs px-1 text-muted-foreground"
          >
            {t('common.cancel')}
          </button>
        </div>
      )}
    </div>
  );
}
