import {
  isMonographContentV2,
  isTipTapDocEmpty,
  iterateSectionBodies,
  normalizeMonographContentV2,
  type MonographBodyChunk,
  type MonographContentV2,
  type TipTapDoc,
} from '../../src/lib/monographContent.js';
import {
  MONOGRAPH_SECTIONS,
  getMonographField,
  getMonographSection,
} from '../../src/lib/monographSections.js';
import { mintTopicSectionIds } from '../../src/lib/topicSections.js';

/**
 * Server-side guarantee that a topic page's top-level headings each carry a
 * stable `sectionId` anchor (#348). Minting happens client-side in
 * `WikiEditor.tsx`, but API write paths (admin-direct create/update and the
 * `wiki_new` / `wiki_page` approval cascade) must not depend on the client
 * having run it — otherwise a heading reaches the DB without an anchor and no
 * `wiki_fact` can ever target it. Idempotent and monograph-safe: returns the
 * input untouched for non-topic pages and for topic docs that are already
 * fully sectioned. Call this right before computing `contentHtml` /
 * `contentPlaintext` so the rendered `data-section-id` attributes match the
 * stored doc.
 */
export function ensureTopicSectionIds(
  pageType: string | null | undefined,
  content: unknown,
): unknown {
  // Entity monographs (#785) reuse the topic flat-doc + section-id model.
  if (pageType !== 'topic' && pageType !== 'entity_monograph') return content;
  if (!content || typeof content !== 'object') return content;
  return mintTopicSectionIds(content as { content?: unknown[] }).doc;
}

let footnoteCounter = 0;
let footnoteRefMap: Map<string, number> = new Map();
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const SAFE_IMAGE_PROTOCOLS = new Set(['http:', 'https:']);
const URL_BASE = 'https://kinetix.no';

interface TipTapNode {
  type?: string;
  text?: string;
  content?: TipTapNode[];
  attrs?: Record<string, unknown>;
}

/**
 * Extract plaintext from a TipTap document — either a legacy free-form doc
 * (`{ type: 'doc', ... }`) or a v2 monograph envelope. The v2 path emits the
 * Norwegian section/field titles inline so full-text search can match
 * "Halveringstid" or "IUPAC-navn" naturally.
 */
export function extractPlaintext(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return '';
  const parts: string[] = [];
  if (isMonographContentV2(doc)) {
    walkMonographPlaintext(doc, parts);
  } else {
    walkNodes(doc as TipTapNode, parts);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function walkMonographPlaintext(
  content: MonographContentV2,
  parts: string[],
): void {
  for (const chunk of iterateSectionBodies(content)) {
    const heading = monographChunkHeading(chunk);
    if (heading) parts.push(heading);
    walkNodes(chunk.body as TipTapNode, parts);
  }
}

function monographChunkHeading(chunk: MonographBodyChunk): string {
  const section = getMonographSection(chunk.sectionId);
  if (chunk.fieldId) {
    const field = getMonographField(chunk.sectionId, chunk.fieldId);
    return field ? field.titleNb : '';
  }
  return section.titleNb;
}

function walkNodes(node: TipTapNode, parts: string[]): void {
  if (node.text) {
    parts.push(node.text);
  }
  // Math atoms carry their LaTeX source in `attrs.tex` rather than a text
  // child; surface it so formula source is at least weakly searchable.
  if (
    (node.type === 'mathInline' || node.type === 'mathBlock') &&
    typeof node.attrs?.tex === 'string'
  ) {
    parts.push(node.attrs.tex);
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      walkNodes(child, parts);
    }
  }
}

/**
 * Render TipTap content to basic HTML for server-side pre-rendering.
 *
 * Accepts either the legacy free-form doc shape or a v2 monograph envelope.
 * v2 envelopes emit one `<section data-monograph-section="…">` per declared
 * section in `MONOGRAPH_SECTIONS` order, each with a Norwegian `<h2>` and any
 * non-empty fields rendered under `<h3 data-monograph-field="…">` headings.
 * Empty sections are skipped so partial monographs render cleanly.
 *
 * Footnote numbering is shared across all sections so the bibliography panel
 * sees a single, monotonically increasing sequence.
 */
export function renderHtml(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return '';
  footnoteCounter = 0;
  footnoteRefMap = new Map();
  if (isMonographContentV2(doc)) {
    return renderMonographV2(doc);
  }
  const node = doc as TipTapNode;
  if (node.type !== 'doc' || !node.content) return '';
  return node.content.map(renderNode).join('');
}

function renderMonographV2(content: MonographContentV2): string {
  const parts: string[] = [];
  const normalized = normalizeMonographContentV2(content);
  for (const section of MONOGRAPH_SECTIONS) {
    const stored = normalized.sections[section.id];
    const sectionBody =
      stored?.body && !isTipTapDocEmpty(stored.body) ? stored.body : null;

    // Decide which schema-declared fields contribute output. Parameter-kind
    // fields always emit a placeholder so the client can hydrate the live
    // value (issue #276 phase 1d) — they don't have prose bodies. Prose
    // and subsection fields only emit when they hold non-empty content.
    interface FieldEntry {
      field: (typeof section.fields)[number];
      body: TipTapDoc | null;
    }
    const fieldEntries: FieldEntry[] = [];
    for (const field of section.fields) {
      const stored = normalized.sections[section.id]?.fields?.[field.id];
      if (field.kind === 'parameter') {
        fieldEntries.push({ field, body: null });
      } else if (stored?.body && !isTipTapDocEmpty(stored.body)) {
        fieldEntries.push({ field, body: stored.body });
      }
    }

    if (!sectionBody && fieldEntries.length === 0) continue;

    parts.push(`<section data-monograph-section="${escapeAttr(section.id)}">`);
    // The Norwegian title is the canonical authoring language and what
    // contentPlaintext stores for search; the client-side WikiRenderer
    // replaces the inner text based on the active i18n locale before
    // sanitization (so an English user sees "Pharmacokinetics" rather
    // than "Farmakokinetikk"). The data-attr is the lookup key.
    parts.push(
      `<h2 data-monograph-section-title="${escapeAttr(section.id)}">${escapeHtml(section.titleNb)}</h2>`,
    );
    if (sectionBody) {
      parts.push(renderDocContent(sectionBody));
    }

    for (const { field, body } of fieldEntries) {
      if (field.kind === 'parameter' && field.parameterAnchor) {
        // Empty placeholder; WikiRenderer's parameterValues prop replaces
        // this with the formatted live value at render time. Keeping the
        // wrapper light (just data-attrs) means stored contentHtml stays
        // tiny and free of stale numbers.
        parts.push(
          '<aside class="monograph-parameter"' +
            ` data-monograph-parameter="${escapeAttr(field.parameterAnchor)}"` +
            ` data-monograph-section="${escapeAttr(section.id)}"` +
            ` data-monograph-field="${escapeAttr(field.id)}"></aside>`,
        );
      } else if (body) {
        // `data-monograph-field-section` lets the client-side title
        // localizer scope the field-id lookup to the right section
        // (field ids like `iupac_name` aren't globally unique).
        parts.push(
          `<h3 data-monograph-field="${escapeAttr(field.id)}"` +
            ` data-monograph-field-section="${escapeAttr(section.id)}">` +
            `${escapeHtml(field.titleNb)}</h3>`,
        );
        parts.push(renderDocContent(body));
      }
    }

    parts.push('</section>');
  }
  return parts.join('');
}

function renderDocContent(doc: TipTapDoc): string {
  if (!doc.content) return '';
  return doc.content.map((n) => renderNode(n as TipTapNode)).join('');
}

function renderNode(node: TipTapNode): string {
  if (node.type === 'text') {
    let text = escapeHtml(node.text ?? '');
    const marks = (
      node as unknown as {
        marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
      }
    ).marks;
    if (marks) {
      for (const mark of marks) {
        switch (mark.type) {
          case 'bold':
            text = `<strong>${text}</strong>`;
            break;
          case 'italic':
            text = `<em>${text}</em>`;
            break;
          case 'strike':
            text = `<s>${text}</s>`;
            break;
          case 'code':
            text = `<code>${text}</code>`;
            break;
          case 'link': {
            const href = sanitizeUrl(
              String(mark.attrs?.href ?? ''),
              SAFE_LINK_PROTOCOLS,
            );
            if (href) {
              text = `<a href="${escapeAttr(href)}" rel="noopener noreferrer nofollow">${text}</a>`;
            }
            break;
          }
        }
      }
    }
    return text;
  }

  const children = (node.content ?? []).map(renderNode).join('');

  switch (node.type) {
    case 'paragraph':
      return `<p>${children}</p>`;
    case 'heading': {
      const level = normalizeHeadingLevel(node.attrs?.level);
      // Topic-page headings carry a stable sectionId minted by #348 so
      // atomic facts can anchor against them. Surface it in the rendered
      // HTML too — read-only viewers and permalinks key off the attribute.
      const sectionId =
        typeof node.attrs?.sectionId === 'string' && node.attrs.sectionId
          ? ` data-section-id="${escapeAttr(node.attrs.sectionId)}"`
          : '';
      return `<h${level}${sectionId}>${children}</h${level}>`;
    }
    case 'bulletList':
      return `<ul>${children}</ul>`;
    case 'orderedList':
      return `<ol>${children}</ol>`;
    case 'listItem':
      return `<li>${children}</li>`;
    case 'blockquote':
      return `<blockquote>${children}</blockquote>`;
    case 'codeBlock':
      return `<pre><code>${children}</code></pre>`;
    case 'horizontalRule':
      return '<hr />';
    case 'image': {
      const src = sanitizeUrl(
        String(node.attrs?.src ?? ''),
        SAFE_IMAGE_PROTOCOLS,
      );
      if (!src) return '';
      return `<img src="${escapeAttr(src)}" alt="${escapeAttr(String(node.attrs?.alt ?? ''))}" />`;
    }
    case 'table':
      return `<table>${children}</table>`;
    case 'tableRow':
      return `<tr>${children}</tr>`;
    case 'tableHeader':
      return `<th>${children}</th>`;
    case 'tableCell':
      return `<td>${children}</td>`;
    case 'mathInline': {
      // Atom node: the LaTeX source rides in `data-tex` and the element is
      // emitted empty. The client WikiRenderer reconstructs the formula with
      // KaTeX after sanitization (sanitizeWikiHtml allowlists `data-tex` on
      // span/div but strips KaTeX's own output, so rendering happens client
      // side on the trusted post-sanitize string).
      const tex = String(node.attrs?.tex ?? '');
      if (!tex) return '';
      return `<span class="kx-math" data-tex="${escapeAttr(tex)}"></span>`;
    }
    case 'mathBlock': {
      const tex = String(node.attrs?.tex ?? '');
      if (!tex) return '';
      return `<div class="kx-math-block" data-tex="${escapeAttr(tex)}"></div>`;
    }
    case 'footnote': {
      const refId = String(node.attrs?.referenceId ?? '');
      let num = footnoteRefMap.get(refId);
      if (num === undefined) {
        footnoteCounter++;
        num = footnoteCounter;
        footnoteRefMap.set(refId, num);
      }
      return `<sup class="footnote-marker" data-reference-id="${escapeAttr(refId)}"><a href="#ref-${num}">[${num}]</a></sup>`;
    }
    case 'fact': {
      // Atomic fact wrapper (issue #284). data-fact-id is the stable
      // anchor that the API uses to target replace/remove ops; preserving
      // it in HTML lets the editor and any future client-side enrichment
      // identify facts post-render.
      //
      // The fact's referenceIds are also rendered as visible footnote
      // markers using the same numbering counter as inline `<footnote>`
      // nodes, so the page-level bibliography (driven by
      // extractFootnoteIds + useDrugBibliography) shows them and so the
      // claim renders as cited rather than as a bare assertion.
      //
      // #303 P2: render single-paragraph facts (the AddFactPanel
      // shape) as a flat `<p class="monograph-fact" …>` so adjacent
      // facts flow as natural prose paragraphs and the citation
      // markers sit at the end of the sentence rather than dangling
      // below it. Multi-block facts keep the `<div>` wrapper but the
      // markers are spliced into the last block-level child for the
      // same reason.
      const factId = String(node.attrs?.factId ?? '');
      const refsRaw = node.attrs?.referenceIds;
      const refs = Array.isArray(refsRaw)
        ? (refsRaw.filter(
            (n): n is number => typeof n === 'number' && Number.isFinite(n),
          ) as number[])
        : [];
      const factAttrs: string[] = ['class="monograph-fact"'];
      if (factId) factAttrs.push(`data-fact-id="${escapeAttr(factId)}"`);
      if (refs.length > 0)
        factAttrs.push(`data-fact-refs="${escapeAttr(refs.join(','))}"`);

      let markers = '';
      for (const refId of refs) {
        const key = String(refId);
        let num = footnoteRefMap.get(key);
        if (num === undefined) {
          footnoteCounter++;
          num = footnoteCounter;
          footnoteRefMap.set(key, num);
        }
        markers += `<sup class="footnote-marker" data-reference-id="${escapeAttr(key)}"><a href="#ref-${num}">[${num}]</a></sup>`;
      }

      const childNodes = Array.isArray(node.content) ? node.content : [];
      if (childNodes.length === 1 && childNodes[0]?.type === 'paragraph') {
        const innerHtml = (childNodes[0]?.content ?? [])
          .map(renderNode)
          .join('');
        return `<p ${factAttrs.join(' ')}>${innerHtml}${markers}</p>`;
      }

      // Multi-block fact (rare — AddFactPanel only produces single
      // paragraphs today). Splice markers into the last block-level
      // child so the citation reads inline with the closing sentence
      // instead of trailing below the wrapper.
      const childHtmls = childNodes.map(renderNode);
      const closingTagRe = /<\/(p|h[1-6]|li|blockquote)>\s*$/;
      let injected = !markers;
      for (let i = childHtmls.length - 1; i >= 0 && !injected; i--) {
        const html = childHtmls[i] ?? '';
        const match = html.match(closingTagRe);
        if (match) {
          const closeTag = match[0];
          childHtmls[i] =
            html.slice(0, html.length - closeTag.length) + markers + closeTag;
          injected = true;
        }
      }
      const inner = childHtmls.join('') + (injected ? '' : markers);
      return `<div ${factAttrs.join(' ')}>${inner}</div>`;
    }
    default:
      return children;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeHeadingLevel(level: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  const numericLevel = Number(level);
  if (
    Number.isInteger(numericLevel) &&
    numericLevel >= 1 &&
    numericLevel <= 6
  ) {
    return numericLevel as 1 | 2 | 3 | 4 | 5 | 6;
  }
  return 1;
}

function sanitizeUrl(
  raw: string,
  allowedProtocols: ReadonlySet<string>,
): string | null {
  const value = raw.trim();
  if (!value || value.startsWith('//')) return null;
  if (value.startsWith('#')) return value;

  try {
    const parsed = new URL(value, URL_BASE);
    if (!allowedProtocols.has(parsed.protocol)) {
      return null;
    }
    // For same-origin relative paths return the normalized href so path
    // traversal sequences (e.g. /a/../../b → /b) are resolved before the
    // value lands in a rendered href attribute.
    if (parsed.origin === URL_BASE) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
    return value;
  } catch {
    return null;
  }
}
