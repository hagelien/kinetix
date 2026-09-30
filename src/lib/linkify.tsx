import type { ReactNode } from 'react';

// Match http(s) URLs up to the next whitespace or angle/bracket. Parens are
// allowed inside the URL so Wikipedia-style links (e.g.
// "https://en.wikipedia.org/wiki/Function_(mathematics)") stay intact; a
// trailing unbalanced `)` is then peeled off so a URL in prose like
// "(see https://example.org)" doesn't absorb the closing paren.
const URL_REGEX = /https?:\/\/[^\s<>\]]+/g;
const TRAILING_PUNCT = /[.,;:!?]+$/;

function trimTrailing(url: string): string {
  let out = url.replace(TRAILING_PUNCT, '');
  // Peel off a trailing `)` that has no matching `(` in the remaining URL.
  while (out.endsWith(')')) {
    const opens = (out.match(/\(/g) ?? []).length;
    const closes = (out.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    out = out.slice(0, -1);
    out = out.replace(TRAILING_PUNCT, '');
  }
  return out;
}

/**
 * Turn plain-text into a React fragment where URLs become clickable links.
 * Safe against XSS: we only emit strings and <a> nodes via React, never HTML.
 */
export function linkify(text: string): ReactNode[] {
  if (!text) return [text];
  const out: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(URL_REGEX)) {
    const raw = match[0];
    const start = match.index ?? 0;
    // Strip trailing punctuation and unbalanced closing parens so a URL in
    // prose doesn't absorb the sentence's final `.`, `,`, or `)`.
    const href = trimTrailing(raw);
    const trailing = raw.slice(href.length);
    if (start > lastIndex) out.push(text.slice(lastIndex, start));
    out.push(
      <a
        key={key++}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline hover:no-underline break-all"
      >
        {href}
      </a>,
    );
    if (trailing) out.push(trailing);
    lastIndex = start + raw.length;
  }
  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out;
}
