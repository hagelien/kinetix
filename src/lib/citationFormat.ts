import {
  authorSurname,
  normalizeAuthorList as normalizeAuthors,
} from '@/lib/authorNames';
import type { CitationRow } from '@/lib/referencesApi';

interface MaybeAuthorsMeta {
  authors?: unknown;
  year?: unknown;
  title?: unknown;
}

function citationYear(meta: MaybeAuthorsMeta): string {
  const yearRaw = meta.year;
  return typeof yearRaw === 'number'
    ? String(yearRaw)
    : typeof yearRaw === 'string' && yearRaw.trim()
      ? yearRaw.trim()
      : '';
}

function encodeDoiPathSegment(segment: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}

/**
 * Return `value` when it parses as a safe http(s) URL, otherwise `null`.
 * Guards against unsafe schemes (e.g. `javascript:`) and malformed input.
 */
function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? value
      : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort short identifier for an inline citation marker, modeled on
 * "[Huertas 2020]" / "[Huertas et al. 2020]" — see issue #265.
 *
 * Falls back gracefully when metadata is incomplete:
 *   - no year  → "[Huertas]"
 *   - no first author → "[2020]" or truncated title / identifier
 *   - freetext/url with no metadata → identifier (truncated to 40 chars)
 *   - last resort → "ref N" so the marker is still visible.
 */
export function citationShortLabel(row: CitationRow): string {
  const meta = (row.metadata ?? {}) as MaybeAuthorsMeta;
  const year = citationYear(meta);

  const authors = normalizeAuthors(meta.authors);
  let firstAuthor = '';
  const multiAuthor = authors.length > 1;
  firstAuthor = authors[0] ? authorSurname(authors[0]) : '';

  if (firstAuthor && year) {
    return multiAuthor
      ? `${firstAuthor} et al. ${year}`
      : `${firstAuthor} ${year}`;
  }
  if (firstAuthor) return firstAuthor;
  if (year) return year;

  const title = typeof meta.title === 'string' ? meta.title.trim() : '';
  if (title) return title.length > 40 ? `${title.slice(0, 37)}…` : title;

  const identifier = row.identifier?.trim() ?? '';
  if (identifier)
    return identifier.length > 40 ? `${identifier.slice(0, 37)}…` : identifier;

  return `ref ${row.id}`;
}

export function citationTooltipLabel(row: CitationRow): string {
  const meta = (row.metadata ?? {}) as MaybeAuthorsMeta;
  const authors = normalizeAuthors(meta.authors)
    .map(authorSurname)
    .filter(Boolean);
  const year = citationYear(meta);
  let authorPart = '';

  if (authors.length === 1) {
    authorPart = authors[0]!;
  } else if (authors.length === 2) {
    authorPart = `${authors[0]} & ${authors[1]}`;
  } else if (authors.length > 2) {
    authorPart = `${authors[0]} et al.`;
  }

  if (authorPart && year) return `${authorPart}, ${year}`;
  if (authorPart) return authorPart;
  if (year) return year;
  return citationShortLabel(row);
}

export function citationTooltipTitle(row: CitationRow): string {
  const meta = (row.metadata ?? {}) as MaybeAuthorsMeta;
  const title = typeof meta.title === 'string' ? meta.title.trim() : '';
  return title || row.identifier?.trim() || `ref ${row.id}`;
}

/**
 * Best external URL for an inline citation, prioritized as DOI > PMID >
 * URL. For `url` rows — and for any other type (e.g. `freetext`) whose
 * identifier happens to be a bare http(s) link — the identifier is
 * returned verbatim so non-PubMed/DOI references stay clickable. Returns
 * `null` when the row carries no linkable identifier, in which case
 * callers should fall back to the in-page bibliography anchor.
 */
export function citationExternalHref(row: CitationRow): string | null {
  const id = row.identifier?.trim();
  if (!id) return null;
  if (row.type === 'doi') {
    // Strip an optional "doi:" or "https://doi.org/" prefix users may
    // have pasted into the identifier field.
    const cleaned = id
      .replace(/^doi:\s*/i, '')
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
    const encoded = cleaned.split('/').map(encodeDoiPathSegment).join('/');
    return `https://doi.org/${encoded}`;
  }
  if (row.type === 'pmid') {
    const numeric = id.replace(/\D+/g, '');
    if (!numeric) return null;
    return `https://pubmed.ncbi.nlm.nih.gov/${numeric}/`;
  }
  // `url` rows always carry a link here; `freetext` (and any legacy type)
  // rows fall through and are treated as a link only when the identifier is
  // itself a safe http(s) URL.
  return safeHttpUrl(id);
}
