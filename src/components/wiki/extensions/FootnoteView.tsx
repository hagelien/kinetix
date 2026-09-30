import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';

export function FootnoteView({ node, editor }: NodeViewProps) {
  // Count which footnote number this is by scanning all footnotes in order
  let num = 0;
  const refIdMap = new Map<number, number>();
  let counter = 0;

  editor.state.doc.descendants((n) => {
    if (n.type.name === 'footnote' && n.attrs.referenceId) {
      const rid = n.attrs.referenceId as number;
      if (!refIdMap.has(rid)) {
        counter++;
        refIdMap.set(rid, counter);
      }
      if (n.attrs.referenceId === node.attrs.referenceId && num === 0) {
        num = refIdMap.get(rid)!;
      }
    }
  });

  if (num === 0) num = counter + 1;

  return (
    <NodeViewWrapper
      as="sup"
      className="footnote-marker inline cursor-default select-none text-primary font-semibold text-[0.7em]"
    >
      [{num}]
    </NodeViewWrapper>
  );
}
