import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { FootnoteView } from './FootnoteView';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    footnote: {
      insertFootnote: (referenceId: number) => ReturnType;
    };
  }
}

export const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      referenceId: {
        default: null,
        parseHTML: (element) => Number(element.getAttribute('data-reference-id')) || null,
        renderHTML: (attributes) => ({ 'data-reference-id': attributes.referenceId }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'sup[data-reference-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['sup', mergeAttributes({ class: 'footnote-marker' }, HTMLAttributes), ''];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FootnoteView);
  },

  addCommands() {
    return {
      insertFootnote:
        (referenceId: number) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { referenceId },
          });
        },
    };
  },
});
