/**
 * Built-in wiki blocks: content that lives in code rather than in a page's
 * stored HTML, because it carries diagrams (the sanitizer strips SVG) or live
 * data. An editor places one by writing a paragraph that holds only the
 * marker `{{kinetix:<name>}}`; `WikiRenderer` swaps that paragraph for a
 * mount point and renders the block's component into it.
 *
 * Only names listed here are expanded, so an unknown or mistyped marker stays
 * visible as plain text instead of silently disappearing.
 */

export const BUILTIN_WIKI_BLOCK_NAMES = ['agents'] as const;

export type BuiltinWikiBlockName = (typeof BUILTIN_WIKI_BLOCK_NAMES)[number];

export function isBuiltinWikiBlockName(
  name: string | undefined,
): name is BuiltinWikiBlockName {
  return (BUILTIN_WIKI_BLOCK_NAMES as readonly string[]).includes(name ?? '');
}

const MARKER_PARAGRAPH_RE =
  /<p\b[^>]*>\s*\{\{\s*kinetix:([a-z0-9-]+)\s*\}\}\s*<\/p>/g;

/**
 * Replace each marker paragraph with an empty mount point. Runs on the
 * sanitized HTML, so the mount markup never has to pass the allowlist.
 */
export function expandBuiltinBlockMarkers(html: string): string {
  if (!html.includes('{{')) return html;
  return html.replace(MARKER_PARAGRAPH_RE, (match, name: string) =>
    isBuiltinWikiBlockName(name)
      ? `<div class="kx-builtin-block not-prose" data-kx-block="${name}"></div>`
      : match,
  );
}
