import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';

export interface FactStatementValue {
  text: string;
  content: unknown[];
}

interface FactStatementEditorProps {
  initialText: string;
  initialContent?: unknown[];
  disabled?: boolean;
  onChange: (value: FactStatementValue) => void;
}

type LinkMode = 'internal' | 'external';

interface WikiSearchResult {
  slug: string;
  title: string;
}

export function FactStatementEditor({
  initialText,
  initialContent,
  disabled = false,
  onChange,
}: FactStatementEditorProps): JSX.Element {
  const { t } = useTranslation();
  const [showLinkPanel, setShowLinkPanel] = useState(false);
  const [linkMode, setLinkMode] = useState<LinkMode>('internal');
  const [query, setQuery] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [results, setResults] = useState<WikiSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const initialDoc = useMemo(
    () => ({
      type: 'doc',
      content:
        Array.isArray(initialContent) && initialContent.length > 0
          ? initialContent
          : [
              {
                type: 'paragraph',
                content: initialText
                  ? [{ type: 'text', text: initialText }]
                  : undefined,
              },
            ],
    }),
    [initialContent, initialText],
  );

  const editor = useEditor({
    editable: !disabled,
    extensions: [
      StarterKit.configure({ heading: false, link: false }),
      Link.configure({
        openOnClick: false,
        autolink: false,
        linkOnPaste: true,
      }),
    ],
    content: initialDoc as Record<string, unknown>,
    onUpdate: ({ editor }) => {
      onChangeRef.current({
        text: editor.getText().replace(/\s+/g, ' ').trim(),
        content: editor.getJSON().content ?? [],
      });
    },
    editorProps: {
      attributes: {
        class:
          'wiki-prose prose prose-sm max-w-none min-h-[84px] rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring',
      },
    },
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (!editor) return;
    onChangeRef.current({
      text: editor.getText().replace(/\s+/g, ' ').trim(),
      content: editor.getJSON().content ?? [],
    });
  }, [editor]);

  useEffect(() => {
    if (!showLinkPanel || linkMode !== 'internal') {
      setResults([]);
      setSearching(false);
      return;
    }
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/wiki/search?q=${encodeURIComponent(q)}&limit=5&view=compact`,
        );
        if (!res.ok) {
          setResults([]);
          return;
        }
        const data = (await res.json()) as {
          results?: WikiSearchResult[];
          pages?: WikiSearchResult[];
        };
        setResults(data.results ?? data.pages ?? []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [linkMode, query, showLinkPanel]);

  function hasSelectedText(): boolean {
    if (!editor) return false;
    const { from, to } = editor.state.selection;
    if (from === to) return false;
    return editor.state.doc.textBetween(from, to, ' ').trim().length > 0;
  }

  function openLinkPanel() {
    if (!editor) return;
    setLinkError(null);
    if (editor.isActive('link')) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    if (!hasSelectedText()) {
      setLinkError(t('wikiFact.linkSelectText'));
      return;
    }
    setShowLinkPanel(true);
  }

  function applyHref(href: string) {
    if (!editor) return;
    if (!hasSelectedText()) {
      setLinkError(t('wikiFact.linkSelectText'));
      return;
    }
    const normalized = normalizeHref(href);
    if (!normalized) {
      setLinkError(t('wikiFact.linkInvalidUrl'));
      return;
    }
    editor.chain().focus().setLink({ href: normalized }).run();
    setShowLinkPanel(false);
    setQuery('');
    setExternalUrl('');
    setResults([]);
    setLinkError(null);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={openLinkPanel}
          disabled={disabled || !editor}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          {editor?.isActive('link')
            ? t('wikiFact.removeLink')
            : t('wikiFact.addLink')}
        </button>
        {linkError ? (
          <span className="text-xs text-rose-600">{linkError}</span>
        ) : null}
      </div>

      {showLinkPanel ? (
        <div className="rounded-md border border-border bg-background p-2 text-xs shadow-sm">
          <div className="mb-2 inline-flex overflow-hidden rounded-md border border-input">
            <button
              type="button"
              onClick={() => setLinkMode('internal')}
              className={`px-2 py-1 ${
                linkMode === 'internal'
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground'
              }`}
            >
              {t('wikiFact.linkInternal')}
            </button>
            <button
              type="button"
              onClick={() => setLinkMode('external')}
              className={`border-l border-input px-2 py-1 ${
                linkMode === 'external'
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground'
              }`}
            >
              {t('wikiFact.linkExternal')}
            </button>
          </div>

          {linkMode === 'internal' ? (
            <div className="space-y-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('wikiFact.linkSearchPlaceholder')}
                className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
              />
              {query.trim() ? (
                <div className="max-h-36 overflow-y-auto rounded-md border border-border">
                  {searching && results.length === 0 ? (
                    <div className="px-2 py-1 text-muted-foreground">
                      {t('wiki.searching')}
                    </div>
                  ) : results.length === 0 ? (
                    <div className="px-2 py-1 text-muted-foreground">
                      {t('common.noResults')}
                    </div>
                  ) : (
                    results.map((result) => (
                      <button
                        key={result.slug}
                        type="button"
                        onClick={() => applyHref(`/wiki/${result.slug}`)}
                        className="block w-full border-b border-border px-2 py-1.5 text-left last:border-b-0 hover:bg-muted"
                      >
                        {result.title}
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input
                value={externalUrl}
                onChange={(e) => setExternalUrl(e.target.value)}
                placeholder={t('wikiFact.linkUrlPlaceholder')}
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs"
              />
              <button
                type="button"
                onClick={() => applyHref(externalUrl)}
                className="rounded-md bg-primary px-2 py-1 text-primary-foreground"
              >
                {t('wikiFact.linkApply')}
              </button>
            </div>
          )}
        </div>
      ) : null}

      <EditorContent editor={editor} />
    </div>
  );
}

function normalizeHref(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.startsWith('//')) return null;
  if (value.startsWith('/wiki/') || value.startsWith('#')) return value;
  const withProtocol = /^[a-z][a-z0-9+.-]*:/i.test(value)
    ? value
    : `https://${value}`;
  try {
    const parsed = new URL(withProtocol);
    if (
      parsed.protocol === 'http:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'mailto:' ||
      parsed.protocol === 'tel:'
    ) {
      return withProtocol;
    }
  } catch {
    return null;
  }
  return null;
}
