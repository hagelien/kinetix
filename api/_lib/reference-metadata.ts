import {
  normalizeAltIds,
  type CitationAltIds,
} from '../../src/lib/citationHandles.js';

export interface ReferenceMetadata {
  title?: string;
  authors?: string[];
  journal?: string;
  year?: number | null;
  volume?: string | null;
  pages?: string | null;
  /**
   * The handles this paper is NOT filed under (#1018). A citation row is
   * unique on `(type, identifier)`, so a paper can only sit under one handle;
   * the others live here, which is what lets a write arriving under a DOI find
   * the row already filed under its PMID instead of minting a second one. Also
   * part of the reference-search haystack, so the discarded handle stays
   * findable — keep `CITATION_HAYSTACK` in sync with the keys stored here.
   */
  altIds?: CitationAltIds;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return normalizeOptionalString(value);
}

function normalizeAuthors(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .map((author) => (typeof author === 'string' ? author.trim() : ''))
    .filter((author) => author.length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeYear(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined;
  }
  // Legacy rows predate the numeric-year schema and store `"2020"`. Dropping
  // those silently cost the citation its year everywhere it is rendered — and
  // filed it under "undated" on the reference index's year axis — so coerce a
  // plain four-digit string rather than discarding it.
  if (typeof value === 'string' && /^\s*\d{4}\s*$/.test(value)) {
    return Number(value.trim());
  }
  return undefined;
}

export function normalizeReferenceMetadata(metadata: unknown): ReferenceMetadata | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const source = metadata as Record<string, unknown>;
  const normalized: ReferenceMetadata = {};

  const title = normalizeOptionalString(source.title);
  if (title !== undefined) normalized.title = title;

  const authors = normalizeAuthors(source.authors);
  if (authors !== undefined) normalized.authors = authors;

  const journal = normalizeOptionalString(source.journal);
  if (journal !== undefined) normalized.journal = journal;

  const year = normalizeYear(source.year);
  if (year !== undefined) normalized.year = year;

  const volume = normalizeOptionalNullableString(source.volume);
  if (volume !== undefined) normalized.volume = volume;

  const pages = normalizeOptionalNullableString(source.pages);
  if (pages !== undefined) normalized.pages = pages;

  // Alt ids are normalized by the same rules the write path canonicalizes with,
  // so a stored crosswalk can be compared to a fresh one without re-parsing.
  const altIds = normalizeAltIds(source.altIds as CitationAltIds | undefined);
  if (Object.keys(altIds).length > 0) normalized.altIds = altIds;

  return Object.keys(normalized).length > 0 ? normalized : null;
}

