import { marked } from 'marked';
import DOMPurify from 'dompurify';

const ALLOWED_MARKDOWN_TAGS = [
  'a',
  'blockquote',
  'br',
  'code',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
];
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const URL_BASE = 'https://kinetix.no';

/**
 * Parse trusted-but-not-trusted markdown (agent-authored review prose) into
 * sanitized HTML safe for dangerouslySetInnerHTML. Keep the allowed surface
 * deliberately small: paper reviews are prose, not arbitrary embedded media.
 */
export function renderMarkdown(markdown: string): string {
  const rawHtml = marked.parse(markdown, { async: false }) as string;
  const sanitized = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: ALLOWED_MARKDOWN_TAGS,
    ALLOWED_ATTR: ['href', 'title'],
  });
  return normalizeMarkdownLinks(sanitized);
}

function normalizeMarkdownLinks(html: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html');
  for (const anchor of Array.from(document.body.querySelectorAll('a'))) {
    const href = anchor.getAttribute('href');
    if (!href || !isSafeMarkdownUrl(href)) {
      unwrapElement(anchor);
      continue;
    }

    anchor.setAttribute('rel', 'noopener noreferrer nofollow');
  }
  return document.body.innerHTML;
}

function unwrapElement(element: Element): void {
  element.replaceWith(...Array.from(element.childNodes));
}

function isSafeMarkdownUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value || value.startsWith('//')) return false;
  if (value.startsWith('#')) return true;

  try {
    const parsed = new URL(value, URL_BASE);
    return (
      parsed.origin === URL_BASE || SAFE_LINK_PROTOCOLS.has(parsed.protocol)
    );
  } catch {
    return false;
  }
}
