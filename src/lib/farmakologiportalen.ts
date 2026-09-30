/**
 * Farmakologiportalen (https://farmakologiportalen.no) — the Norwegian
 * clinical-pharmacology reference Kinetix imports from and links out to.
 *
 * `drugs.farmakologiportalen_path` stores the portal's own content path for a
 * substance, e.g. '/content/757/Morfin-3-glukuronid-M3G'. Both segments are
 * required: '/content/757' on its own answers 200 with a shell page that names
 * no substance, so the id is not a usable handle by itself.
 */

export const FARMAKOLOGIPORTALEN_BASE_URL = 'https://farmakologiportalen.no';

/** '/content/<numeric id>/<slug>' — the portal's substance-page address. */
const CONTENT_PATH_RE = /^\/content\/\d+\/[^/?#\s]+$/;

/**
 * Absolute URL for a stored portal path, or null when there is nothing safe to
 * link to.
 *
 * The shape check is the reason this exists rather than a template literal at
 * the call site. The value reaches an `href` and arrives from an importer that
 * reads a third-party page, so anything that is not a plain content path —
 * an absolute URL to some other host, a `javascript:` string, a protocol-
 * relative `//evil.example` — must not become the destination. Rejecting
 * outright (rather than sanitizing) keeps the origin a constant of this module.
 */
export function farmakologiportalenUrl(
  path: string | null | undefined,
): string | null {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!CONTENT_PATH_RE.test(trimmed)) return null;
  return `${FARMAKOLOGIPORTALEN_BASE_URL}${trimmed}`;
}
