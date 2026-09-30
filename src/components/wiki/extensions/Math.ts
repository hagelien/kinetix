import { Node, mergeAttributes, nodeInputRule } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { MathView } from "./MathView";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    math: {
      /** Insert an inline `$…$` math node carrying the given LaTeX. */
      insertMathInline: (tex: string) => ReturnType;
      /** Insert a centered display `$$…$$` math block carrying LaTeX. */
      insertMathBlock: (tex: string) => ReturnType;
    };
  }
}

/**
 * Shared attribute spec: the LaTeX source lives in `data-tex`. The node is an
 * atom with no child content, so this attribute is the entire payload — both
 * the server renderer (`api/_lib/tiptap-utils.ts`) and the read-only
 * `WikiRenderer` reconstruct the formula from it via KaTeX.
 */
const texAttribute = {
  tex: {
    default: "",
    parseHTML: (element: HTMLElement) => element.getAttribute("data-tex") ?? "",
    renderHTML: (attributes: { tex?: string }) =>
      attributes.tex ? { "data-tex": attributes.tex } : {},
  },
};

/**
 * Inline math: `$C_0 e^{-kt}$`. Renders into a `<span class="kx-math">`
 * marker that the sanitizer allowlists (`data-tex` on `span`) and the
 * client renderer hydrates with KaTeX output post-sanitization.
 */
export const MathInline = Node.create({
  name: "mathInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return texAttribute;
  },

  parseHTML() {
    return [{ tag: "span[data-tex]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ class: "kx-math" }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathView);
  },

  addInputRules() {
    return [
      // `$…$` (no inner `$` or newline) collapses into an inline math node.
      nodeInputRule({
        find: /\$([^$\n]+)\$$/,
        type: this.type,
        getAttributes: (match) => ({ tex: match[1] }),
      }),
    ];
  },

  addCommands() {
    return {
      insertMathInline:
        (tex: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { tex } }),
    };
  },
});

/**
 * Display math block: `$$ … $$`, rendered centered on its own line. Backs
 * multi-line constructs (`\frac`, `cases`, matrices) that have no inline
 * Unicode equivalent — e.g. the iPMR-LS formula.
 */
export const MathBlock = Node.create({
  name: "mathBlock",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return texAttribute;
  },

  parseHTML() {
    return [{ tag: "div[data-tex]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ class: "kx-math-block" }, HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathView);
  },

  addInputRules() {
    return [
      // `$$…$$` at the start of a block becomes a display math block.
      nodeInputRule({
        find: /^\$\$([^$]+)\$\$$/,
        type: this.type,
        getAttributes: (match) => ({ tex: match[1] }),
      }),
    ];
  },

  addCommands() {
    return {
      insertMathBlock:
        (tex: string) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { tex } }),
    };
  },
});

/** Convenience bundle for editor `extensions` arrays. */
export const MathExtensions = [MathInline, MathBlock];
