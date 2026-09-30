const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const SAFE_IMAGE_PROTOCOLS = new Set(['http:', 'https:']);
const URL_BASE = 'https://kinetix.no';
const ALLOWED_TAGS = new Set([
  'a',
  // Inline parameter-anchor placeholder (issue #276 phase 1d). The
  // server emits an empty `<aside class="monograph-parameter" data-…>`
  // marker for each schema-declared parameter field; WikiRenderer
  // replaces it with the formatted live value before rendering.
  'aside',
  'blockquote',
  'code',
  // Definition-list elements used by the parameter-anchor replacement
  // (issue #276 phase 1d) when WikiRenderer hydrates `<aside …>`
  // placeholders into structured `<dl><dt>…</dt><dd>…</dd></dl>`.
  'dd',
  'dl',
  'dt',
  // Atomic-fact wrapper (issue #284). Survives sanitization with the
  // narrow attribute allowlist below so client-side enrichment can
  // identify facts post-render.
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'strong',
  'span',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'tr',
  'ul',
]);
const STRIP_ENTIRELY = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'template',
]);
const ALLOWED_ATTRIBUTES = new Map<string, Set<string>>([
  // `target` is allowlisted so external citation markers (#265) can open
  // in a new tab; the post-processing below pins the value to `_blank`
  // and `rel` is force-set to `noopener noreferrer` for any `<a>`.
  ['a', new Set(['href', 'rel', 'target'])],
  // Parameter placeholder; replaced by WikiRenderer before render. The
  // class is what the client uses to discover them; the data-attrs let
  // the replacer pick up the section/field/parameter identity.
  [
    'aside',
    new Set([
      'class',
      'data-monograph-parameter',
      'data-monograph-section',
      'data-monograph-field',
    ]),
  ],
  // Same data-attrs apply to the dl that the parameter replacement
  // emits in WikiRenderer, so the rendered output keeps a stable hook
  // for future CSS or click-to-jump-to-sidebar affordances.
  [
    'dl',
    new Set([
      'class',
      'data-monograph-parameter',
      'data-monograph-section',
      'data-monograph-field',
    ]),
  ],
  // Fact wrappers carry their identity in data-attrs; keeping the class
  // is what wires up the .monograph-fact CSS treatment. Single-paragraph
  // facts emit a `<p class="monograph-fact" …>` directly (issue #303 P2)
  // so they flow as prose; multi-block facts still wrap in `<div>`. Both
  // shapes need the same allowlist so legacy stored content keeps
  // rendering after a re-sanitize on read.
  // `data-tex` carries the LaTeX source of a display math block
  // (`div.kx-math-block`). WikiRenderer reads it and renders KaTeX into the
  // (otherwise empty) element after sanitization; the raw TeX string itself
  // is inert text and safe to keep here.
  ['div', new Set(['class', 'data-fact-id', 'data-fact-refs', 'data-tex'])],
  ['p', new Set(['class', 'data-fact-id', 'data-fact-refs'])],
  // `title` lets the renderer-injected verification-level badge carry a
  // hover label; it is inert text and safe to keep through sanitization.
  // `data-tex` carries the LaTeX source of an inline math node
  // (`span.kx-math`); rendered to KaTeX by WikiRenderer post-sanitization.
  ['span', new Set(['class', 'title', 'data-tex'])],
  ['img', new Set(['src', 'alt'])],
  ['sup', new Set(['class'])],
]);
const ALLOWED_CLASSES = new Map<string, Set<string>>([
  ['aside', new Set(['monograph-parameter'])],
  ['div', new Set(['monograph-fact', 'kx-math-block'])],
  ['dl', new Set(['monograph-parameter'])],
  ['p', new Set(['monograph-fact'])],
  [
    'span',
    new Set([
      'citation-tooltip',
      'citation-tooltip-entry',
      'citation-tooltip-trigger',
      'kx-math',
    ]),
  ],
  ['sup', new Set(['footnote-marker'])],
]);

export function sanitizeWikiHtml(html: string): string {
  if (!html) return '';

  const document = new DOMParser().parseFromString(html, 'text/html');
  const elements = Array.from(document.body.querySelectorAll('*'));

  for (const element of elements) {
    const tag = element.tagName.toLowerCase();

    if (!ALLOWED_TAGS.has(tag)) {
      if (STRIP_ENTIRELY.has(tag)) {
        element.remove();
      } else {
        unwrapElement(element);
      }
      continue;
    }

    const allowedAttributes = ALLOWED_ATTRIBUTES.get(tag) ?? new Set<string>();
    for (const attribute of Array.from(element.attributes)) {
      if (!allowedAttributes.has(attribute.name.toLowerCase())) {
        element.removeAttribute(attribute.name);
      }
    }
    normalizeClassAttribute(element, ALLOWED_CLASSES.get(tag));

    if (tag === 'a') {
      const href = element.getAttribute('href');
      if (!href || !isSafeUrl(href, SAFE_LINK_PROTOCOLS)) {
        unwrapElement(element);
        continue;
      }
      element.setAttribute('rel', 'noopener noreferrer');
      // Pin the value of `target` to `_blank` if present at all — anything
      // else (including unsafe values like `_top`) is overridden.
      if (element.hasAttribute('target')) {
        element.setAttribute('target', '_blank');
      }
      continue;
    }

    if (tag === 'img') {
      const src = element.getAttribute('src');
      if (!src || !isSafeUrl(src, SAFE_IMAGE_PROTOCOLS)) {
        element.remove();
      }
    }
  }

  return document.body.innerHTML;
}

function unwrapElement(element: Element): void {
  element.replaceWith(...Array.from(element.childNodes));
}

function normalizeClassAttribute(
  element: Element,
  allowedClasses: ReadonlySet<string> | undefined,
): void {
  if (!element.hasAttribute('class')) return;
  if (!allowedClasses) {
    element.removeAttribute('class');
    return;
  }

  const classes = Array.from(element.classList).filter((name) =>
    allowedClasses.has(name),
  );
  if (classes.length === 0) {
    element.removeAttribute('class');
    return;
  }
  element.setAttribute('class', classes.join(' '));
}

function isSafeUrl(
  raw: string,
  allowedProtocols: ReadonlySet<string>,
): boolean {
  const value = raw.trim();
  if (!value || value.startsWith('//')) return false;
  if (value.startsWith('#')) return true;

  try {
    const parsed = new URL(value, URL_BASE);
    return allowedProtocols.has(parsed.protocol);
  } catch {
    return false;
  }
}
