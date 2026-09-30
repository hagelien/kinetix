import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { renderTexToHtml } from "@/lib/katexRender";

/**
 * Editor node view for `mathInline` / `mathBlock`. Renders the stored LaTeX
 * with KaTeX (same helper as the read-only renderer, so WYSIWYG matches the
 * published page) and offers a click-to-edit affordance: clicking the formula
 * swaps in a small text field, and committing (Enter / blur) writes the new
 * source back to the node's `tex` attribute.
 */
export function MathView({ node, updateAttributes, editor }: NodeViewProps) {
  const { t } = useTranslation();
  const isBlock = node.type.name === "mathBlock";
  const tex = (node.attrs.tex as string) ?? "";
  // A freshly inserted empty node opens straight into edit mode so the author
  // can type without an extra click.
  const [editing, setEditing] = useState(tex.trim() === "");
  const [draft, setDraft] = useState(tex);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraft(tex);
  }, [tex]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    updateAttributes({ tex: draft });
    setEditing(false);
    editor.commands.focus();
  };

  const cancel = () => {
    setDraft(tex);
    setEditing(false);
  };

  const html = renderTexToHtml(
    tex.trim() === "" ? "\\textcolor{gray}{\\,?\\,}" : tex,
    isBlock,
  );

  if (editing && editor.isEditable) {
    const commonProps = {
      ref: inputRef as never,
      value: draft,
      onChange: (
        e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => setDraft(e.target.value),
      onBlur: commit,
      placeholder: isBlock ? t('wikiEditor.mathPlaceholderBlock') : "LaTeX",
      className:
        "kx-math-input rounded border border-input bg-background px-1.5 py-0.5 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-ring",
    };
    return (
      <NodeViewWrapper
        as={isBlock ? "div" : "span"}
        className={isBlock ? "kx-math-block-edit my-2 block text-center" : ""}
      >
        {isBlock ? (
          <textarea
            {...commonProps}
            rows={2}
            className={`${commonProps.className} w-full max-w-xl text-left`}
            onKeyDown={(e) => {
              if (e.key === "Escape") cancel();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
            }}
          />
        ) : (
          <input
            {...commonProps}
            type="text"
            onKeyDown={(e) => {
              if (e.key === "Escape") cancel();
              if (e.key === "Enter") commit();
            }}
          />
        )}
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      as={isBlock ? "div" : "span"}
      className={`kx-math-node ${isBlock ? "kx-math-block my-2 block cursor-pointer text-center" : "kx-math cursor-pointer"}`}
      onClick={() => editor.isEditable && setEditing(true)}
      title={editor.isEditable ? tex || t('wikiEditor.mathClickToEdit') : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
