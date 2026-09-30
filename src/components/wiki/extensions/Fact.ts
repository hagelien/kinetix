import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { FactView } from './FactView';

/**
 * Callback invoked by the FactView's "Edit" affordance. Wired by the
 * MonographSectionEditor to open the EditFactPanel for a wiki_fact
 * replace/remove submission.
 */
export interface FactEditPayload {
  factId: string;
  statement: string;
  content: unknown[];
  referenceIds: number[];
}

/**
 * Callback for the reorder affordances (#358). FactView fires these
 * when the user clicks the ↑/↓ buttons; the host maps the factId to
 * its current fact-position and submits a `wiki_fact reorder` to a
 * new position +/- 1.
 */
export interface FactReorderPayload {
  factId: string;
}

export interface FactOptions {
  onEdit?: (payload: FactEditPayload) => void;
  onMoveUp?: (payload: FactReorderPayload) => void;
  onMoveDown?: (payload: FactReorderPayload) => void;
}

/**
 * TipTap node spec for the atomic-fact wrapper used by issue #284.
 *
 * Each fact is a block-level container with a stable `factId` (UUID) and an
 * embedded `referenceIds` list. The schema mirrors the JSON shape produced
 * by `createFactNode` in `src/lib/monographContent.ts`, so an editor that
 * loads a v2 envelope round-trips the same shape on `getJSON()` instead of
 * silently dropping the wrapper as an unknown node.
 *
 * Visual treatment lives in CSS (`wiki-prose .monograph-fact`); the node
 * spec only defines schema, attribute parsing, and HTML serialization.
 */
export const Fact = Node.create<FactOptions>({
  name: 'fact',
  group: 'block',
  // The body of a fact is one or more block children — typically a single
  // paragraph. Allowing multiple lets a future replace include richer
  // content (lists, tables) without changing the schema.
  content: 'block+',
  defining: true,

  addOptions() {
    return { onEdit: undefined, onMoveUp: undefined, onMoveDown: undefined };
  },

  addAttributes() {
    return {
      factId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-fact-id'),
        renderHTML: (attributes) =>
          attributes.factId ? { 'data-fact-id': attributes.factId } : {},
      },
      referenceIds: {
        default: [] as number[],
        parseHTML: (element) =>
          parseRefAttr(element.getAttribute('data-fact-refs')),
        renderHTML: (attributes) => {
          const refs = attributes.referenceIds as number[] | undefined;
          if (!refs || refs.length === 0) return {};
          return { 'data-fact-refs': refs.join(',') };
        },
      },
    };
  },

  parseHTML() {
    // `div[data-fact-id]` is the legacy multi-block shape; `p[data-fact-id]`
    // is the flat single-paragraph shape introduced in #303 P2 so reader
    // HTML round-trips back to a fact node when pasted into the editor.
    return [{ tag: 'div[data-fact-id]' }, { tag: 'p[data-fact-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes({ class: 'monograph-fact' }, HTMLAttributes),
      0,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FactView);
  },
});

function parseRefAttr(raw: string | null): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}
