/**
 * Prose → atomic-fact conversion helpers for topic pages (#310 phase 3).
 *
 * Legacy topic pages were authored as free-form prose through the
 * whole-page editor, so their section bodies are runs of `paragraph`
 * nodes rather than `fact` nodes. The reading view only decorates
 * `fact` nodes (verification badges + the Discuss affordance wired in
 * #701), so prose pages show no atomic-fact UI at all.
 *
 * A fully automatic split is impossible: the atomic-fact contract
 * (#284) requires every fact to carry at least one citation, and a
 * mechanical wrap would mint reference-less facts the API rejects. So
 * conversion is *guided* — this module extracts each convertible prose
 * paragraph (its plain text and any citations it already carries) so the
 * editor can pre-fill the Add-fact panel and let the author review,
 * trim to a single claim, and submit a real `wiki_fact add`.
 */

interface TipTapNode {
  type?: string;
  attrs?: Record<string, unknown> | null;
  content?: unknown[];
  text?: string;
}

export interface ConvertibleProse {
  /**
   * Index of this paragraph within the section's `bodyContent`. Stable
   * for a given doc, so it doubles as a React key and as the identity the
   * editor uses to track which paragraph is being converted.
   */
  index: number;
  /** Collapsed plain text of the paragraph, footnote markers excluded. */
  text: string;
  /**
   * The paragraph block with inline `footnote` nodes stripped, shaped as
   * `doc.content` for {@link FactStatementEditor}'s `initialContent`. The
   * statement editor doesn't load the Footnote extension, so leaving the
   * markers in would drop unknown nodes; citations are carried separately
   * via {@link referenceIds} instead.
   */
  content: unknown[];
  /** Citation ids harvested from the paragraph's inline footnotes. */
  referenceIds: number[];
}

function asNode(value: unknown): TipTapNode | null {
  if (!value || typeof value !== 'object') return null;
  return value as TipTapNode;
}

/** Concatenate the text of every descendant text node (skips footnotes). */
function collectText(node: TipTapNode): string {
  if (typeof node.text === 'string') return node.text;
  if (node.type === 'footnote') return '';
  if (!Array.isArray(node.content)) return '';
  return node.content
    .map((child) => {
      const c = asNode(child);
      return c ? collectText(c) : '';
    })
    .join('');
}

/** Push every `footnote` node's `referenceId` into `into`. */
function collectReferenceIds(node: TipTapNode, into: number[]): void {
  if (node.type === 'footnote') {
    const id = node.attrs?.referenceId;
    if (typeof id === 'number' && Number.isFinite(id)) into.push(id);
    return;
  }
  if (!Array.isArray(node.content)) return;
  for (const child of node.content) {
    const c = asNode(child);
    if (c) collectReferenceIds(c, into);
  }
}

/** Return a deep copy of `node` with every `footnote` descendant removed. */
function stripFootnotes(node: TipTapNode): TipTapNode {
  if (!Array.isArray(node.content)) return { ...node };
  const content: unknown[] = [];
  for (const child of node.content) {
    const c = asNode(child);
    if (!c || c.type === 'footnote') continue;
    content.push(stripFootnotes(c));
  }
  return { ...node, content };
}

/**
 * Extract the convertible prose paragraphs from a topic section's
 * `bodyContent`. Only top-level, non-empty `paragraph` nodes qualify —
 * existing `fact` nodes, lists, tables and images are left untouched so
 * conversion never mangles structured content.
 */
export function extractConvertibleProse(
  bodyContent: unknown[] | null | undefined,
): ConvertibleProse[] {
  const out: ConvertibleProse[] = [];
  const nodes = Array.isArray(bodyContent) ? bodyContent : [];
  nodes.forEach((raw, index) => {
    const node = asNode(raw);
    if (!node || node.type !== 'paragraph') return;
    const text = collectText(node).replace(/\s+/g, ' ').trim();
    if (!text) return;
    const referenceIds: number[] = [];
    collectReferenceIds(node, referenceIds);
    out.push({
      index,
      text,
      content: [stripFootnotes(node)],
      referenceIds: [...new Set(referenceIds)],
    });
  });
  return out;
}
