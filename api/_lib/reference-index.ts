/**
 * Grouping + pagination for the site-wide reference index (`/references`).
 *
 * The index used to ship every anchored citation in one response and let the
 * browser group and filter them. At 800+ sources that is a slow, unreadable
 * wall of text, so the server now owns three things instead: which axis the
 * bibliography is grouped along, which bucket of that axis the user is looking
 * at, and which page of it.
 *
 * Four axes, mirroring how people actually look for a source they half
 * remember:
 *   - `drug` — the owning drug monograph or wiki page (the original view; a
 *     source cited from two pages appears under both)
 *   - `alpha`  — first letter of the title, the classic A–Z bibliography
 *   - `author` — first letter of the first author's surname, the way a printed
 *     reference list is filed; sources with no author bucket last
 *   - `year`  — publication year, newest first
 *
 * Pagination counts *references*, not groups, so every page is the same size
 * whether the user is looking at a drug with two sources or a letter with two
 * hundred. A group that straddles a page boundary is re-headed on the next
 * page and carries its full bucket count, so "M (48)" reads the same on both.
 *
 * This module is pure — no DB, no HTTP — so the ordering rules are unit
 * testable and the route stays a thin assembly layer.
 */
import { firstAuthorSurname } from '../../src/lib/authorNames.js';
import type { ReferenceMetadata } from './reference-metadata.js';

export type ReferenceGroupBy = 'drug' | 'alpha' | 'author' | 'year';

export const DEFAULT_REFERENCE_PAGE_SIZE = 50;
export const MAX_REFERENCE_PAGE_SIZE = 200;

export interface IndexCitation {
  id: number;
  drugId: number | null;
  type: string;
  identifier: string;
  metadata: ReferenceMetadata | null;
  createdAt: unknown;
  needsFullReview?: boolean;
}

/** A drug monograph or wiki page, with the citations anchored to it. */
export interface ReferenceOwner {
  kind: 'drug' | 'wiki';
  id: number;
  slug: string;
  names?: Record<string, string>;
  title?: string;
  pageType?: string;
  href: string;
  /** Display name resolved server-side (drug name in the request language). */
  heading: string;
  citationIds: number[];
}

export interface ReferenceBucket {
  key: string;
  /** Display label; `null` for the catch-all "unknown year" bucket. */
  label: string | null;
  count: number;
}

export interface ReferenceIndexGroup {
  kind: 'drug' | 'wiki' | 'alpha' | 'author' | 'year';
  /** Stable identity across pages, e.g. `drug-7`, `alpha-M`, `year-2019`. */
  key: string;
  id?: number;
  slug?: string;
  names?: Record<string, string>;
  title?: string;
  pageType?: string;
  href?: string;
  label?: string | null;
  references: IndexCitation[];
  /** References in this bucket across every page, not just the visible slice. */
  totalReferences: number;
}

export interface ReferenceIndexPage {
  groups: ReferenceIndexGroup[];
  buckets: ReferenceBucket[];
  /** The bucket actually applied — `null` when the requested one has no rows. */
  bucket: string | null;
  page: number;
  pageSize: number;
  totalPages: number;
  /** Distinct references matching the query (before the bucket filter). */
  matchedReferences: number;
  /** Rows on the current axis — a source counts once per owner in drug mode. */
  totalRows: number;
  /** 1-based index of the first row on this page; 0 when the page is empty. */
  rangeStart: number;
  rangeEnd: number;
}

export function parseGroupBy(value: string | null): ReferenceGroupBy {
  return value === 'alpha' || value === 'author' || value === 'year'
    ? value
    : 'drug';
}

export function parsePageSize(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_REFERENCE_PAGE_SIZE;
  }
  // Clamp AFTER truncating: a positive fraction like `0.5` truncates to 0,
  // which would slice every page empty and make totalPages Infinity.
  return Math.min(
    Math.max(1, Math.trunc(parsed)),
    MAX_REFERENCE_PAGE_SIZE,
  );
}

// Structurally valid BCP-47: `nb`, `en-GB`, `zh-Hant-TW`. Anything else —
// notably the POSIX-style `en_US` a caller may reasonably guess — would make
// Intl throw a RangeError, so it is dropped in favour of the default locale.
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

export function parseLang(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && LANGUAGE_TAG.test(trimmed) ? trimmed : undefined;
}

export function parsePage(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.trunc(parsed);
}

/** What a reference sorts and buckets by: its title, or the raw identifier. */
export function referenceSortTitle(row: IndexCitation): string {
  const title = row.metadata?.title?.trim();
  return title || row.identifier?.trim() || `#${row.id}`;
}

/**
 * What a reference files under on the author axis: the surname of its first
 * author, parsed by the same heuristic that renders "[Huertas 2020]" inline.
 * Empty for a source with no author — a standard, a dataset, a web page — and
 * those collect in their own bucket rather than being filed under a guess.
 */
export function referenceSortAuthor(row: IndexCitation): string {
  return firstAuthorSurname(row.metadata?.authors);
}

const LEADING_NOISE = /^[^\p{Letter}\p{Number}]+/u;

/**
 * A–Z bucket: the first letter of the title, uppercased, with leading quotes
 * and brackets skipped. Digits and everything else fall into `#`. Accents are
 * folded so "Éliminati…" files under E, but Norwegian Æ/Ø/Å keep their own
 * buckets — they are distinct letters, not decorated A/O.
 */
export function alphaBucketKey(title: string): string {
  const cleaned = title.replace(LEADING_NOISE, '');
  const first = [...cleaned][0];
  if (!first) return '#';
  const upper = first.toLocaleUpperCase('nb');
  if (!/\p{Letter}/u.test(upper)) return '#';
  if ('ÆØÅ'.includes(upper)) return upper;
  const folded = upper.normalize('NFD').replace(/\p{Mark}+/gu, '');
  const base = [...folded][0] ?? upper;
  return /^[A-Z]$/.test(base) ? base : upper;
}

/**
 * The A–Z axis has one canonical order, independent of the reader's language:
 * A–Z, then the Norwegian letters Æ Ø Å, then anything else, with `#` (digits
 * and symbols) last. Locale collation cannot supply it — under an English
 * collator Å and Æ are variants of A and Ø a variant of O, which would
 * interleave the Norwegian buckets into the Latin ones for exactly the readers
 * least likely to expect it. Titles and monograph headings still sort by the
 * request locale; only the bucket sequence is fixed.
 */
const ALPHA_BUCKET_ORDER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZÆØÅ';

/** The catch-all bucket for a source with no year, and none with no author. */
const UNKNOWN_BUCKET = 'unknown';

/**
 * A–Å bucket for the first author's surname, or the catch-all bucket when the
 * source names no author. Shares `alphaBucketKey` with the title axis so
 * "Ødegård" and "Østerud" file together under Ø on both.
 */
export function authorBucketKey(row: IndexCitation): string {
  const surname = referenceSortAuthor(row);
  return surname ? alphaBucketKey(surname) : UNKNOWN_BUCKET;
}

export function alphaBucketRank(key: string): number {
  // Authorless sources file after everything, `#` included — they are the
  // "and the rest" of an author list, not a symbol-initial name. The title
  // axis never produces this bucket.
  if (key === UNKNOWN_BUCKET) return ALPHA_BUCKET_ORDER.length + 2;
  if (key === '#') return ALPHA_BUCKET_ORDER.length + 1;
  const index = ALPHA_BUCKET_ORDER.indexOf(key);
  // A letter outside the Norwegian alphabet (Cyrillic, Greek, …) files after
  // Å but ahead of the symbol bucket, ordered among its peers by code point.
  return index === -1 ? ALPHA_BUCKET_ORDER.length : index;
}

export function yearBucketKey(row: IndexCitation): string {
  const raw = row.metadata?.year;
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length === 4 ? digits : UNKNOWN_BUCKET;
}

type Comparator = (a: string, b: string) => number;

/**
 * Locale-aware collation so Norwegian Æ/Ø/Å sort after Z rather than next to
 * A/O. Built once per request rather than per comparison, and defensive about
 * the locale: `lang` arrives from a query parameter, and a malformed tag makes
 * Intl throw — a sort order is never worth a 500.
 */
function makeComparator(lang: string | undefined): Comparator {
  let collator: Intl.Collator;
  try {
    collator = new Intl.Collator(lang || 'nb', { sensitivity: 'base' });
  } catch {
    collator = new Intl.Collator('nb', { sensitivity: 'base' });
  }
  // Fall back to a code-point comparison so equal-under-collation headings
  // still get a stable, deterministic order.
  return (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

interface Slot {
  bucketKey: string;
  label: string | null;
  reference: IndexCitation;
  owner?: ReferenceOwner;
}

function orderedSlots(
  owners: ReferenceOwner[],
  citations: Map<number, IndexCitation>,
  groupBy: ReferenceGroupBy,
  compare: Comparator,
): Slot[] {
  if (groupBy === 'drug') {
    // Drug monographs first, then wiki pages — the two sections the page has
    // always rendered — each alphabetically by its resolved heading.
    const sorted = [...owners].sort(
      (a, b) =>
        (a.kind === b.kind ? 0 : a.kind === 'drug' ? -1 : 1) ||
        compare(a.heading, b.heading) ||
        a.id - b.id,
    );
    return sorted.flatMap((owner) => {
      const refs = owner.citationIds
        .map((id) => citations.get(id))
        .filter((row): row is IndexCitation => row != null)
        .sort(
          (a, b) =>
            compare(referenceSortTitle(a), referenceSortTitle(b)) ||
            a.id - b.id,
        );
      return refs.map((reference) => ({
        bucketKey: `${owner.kind}-${owner.id}`,
        label: owner.heading,
        reference,
        owner,
      }));
    });
  }

  // alpha / author / year: one row per source, regardless of how many pages
  // cite it.
  const rows = [...citations.values()];
  const keyed = rows.map((reference) => {
    const key =
      groupBy === 'alpha'
        ? alphaBucketKey(referenceSortTitle(reference))
        : groupBy === 'author'
          ? authorBucketKey(reference)
          : yearBucketKey(reference);
    return {
      bucketKey: key,
      label: key === UNKNOWN_BUCKET ? null : key,
      reference,
    };
  });

  keyed.sort((a, b) => {
    if (a.bucketKey !== b.bucketKey) {
      if (groupBy === 'year') {
        // Newest first; undated sources last so they never head the list.
        if (a.bucketKey === UNKNOWN_BUCKET) return 1;
        if (b.bucketKey === UNKNOWN_BUCKET) return -1;
        return Number(b.bucketKey) - Number(a.bucketKey);
      }
      return (
        alphaBucketRank(a.bucketKey) - alphaBucketRank(b.bucketKey) ||
        (a.bucketKey < b.bucketKey ? -1 : 1)
      );
    }
    // Within a bucket the author axis sorts by surname first — the bucket only
    // fixes the initial, so "Aasen" still has to sort ahead of "Axelsson" —
    // and falls back to the title when two papers share an author.
    if (groupBy === 'author') {
      return (
        compare(
          referenceSortAuthor(a.reference),
          referenceSortAuthor(b.reference),
        ) ||
        compare(
          referenceSortTitle(a.reference),
          referenceSortTitle(b.reference),
        ) ||
        a.reference.id - b.reference.id
      );
    }
    return (
      compare(
        referenceSortTitle(a.reference),
        referenceSortTitle(b.reference),
      ) || a.reference.id - b.reference.id
    );
  });

  return keyed;
}

function bucketsFrom(slots: Slot[]): ReferenceBucket[] {
  const buckets: ReferenceBucket[] = [];
  const byKey = new Map<string, ReferenceBucket>();
  for (const slot of slots) {
    let bucket = byKey.get(slot.bucketKey);
    if (!bucket) {
      bucket = { key: slot.bucketKey, label: slot.label, count: 0 };
      byKey.set(slot.bucketKey, bucket);
      buckets.push(bucket);
    }
    bucket.count += 1;
  }
  return buckets;
}

function groupFor(slot: Slot, groupBy: ReferenceGroupBy): ReferenceIndexGroup {
  if (groupBy === 'drug' && slot.owner) {
    const owner = slot.owner;
    return {
      kind: owner.kind,
      key: slot.bucketKey,
      id: owner.id,
      slug: owner.slug,
      ...(owner.names ? { names: owner.names } : {}),
      ...(owner.title ? { title: owner.title } : {}),
      ...(owner.pageType ? { pageType: owner.pageType } : {}),
      href: owner.href,
      label: owner.heading,
      references: [],
      totalReferences: 0,
    };
  }
  return {
    kind: groupBy === 'drug' ? 'alpha' : groupBy,
    key: slot.bucketKey,
    label: slot.label,
    references: [],
    totalReferences: 0,
  };
}

/**
 * Order → bucket → paginate. `bucket` narrows to a single letter/year/page
 * before slicing, so "jump to M" starts at M's first page rather than hunting
 * for it.
 */
export function buildReferenceIndexPage(options: {
  owners: ReferenceOwner[];
  citations: Map<number, IndexCitation>;
  groupBy: ReferenceGroupBy;
  bucket?: string | null;
  page: number;
  pageSize: number;
  lang?: string;
}): ReferenceIndexPage {
  const { owners, citations, groupBy, page, pageSize, lang } = options;
  const slots = orderedSlots(owners, citations, groupBy, makeComparator(lang));
  const buckets = bucketsFrom(slots);

  const bucketKey = options.bucket?.trim() || null;
  const known = bucketKey != null && buckets.some((b) => b.key === bucketKey);
  const visible = known
    ? slots.filter((slot) => slot.bucketKey === bucketKey)
    : slots;

  const totalRows = visible.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const offset = (currentPage - 1) * pageSize;
  const pageSlots = visible.slice(offset, offset + pageSize);

  const bucketCounts = new Map(buckets.map((b) => [b.key, b.count]));
  const groups: ReferenceIndexGroup[] = [];
  for (const slot of pageSlots) {
    let group = groups[groups.length - 1];
    if (!group || group.key !== slot.bucketKey) {
      group = groupFor(slot, groupBy);
      group.totalReferences = bucketCounts.get(slot.bucketKey) ?? 0;
      groups.push(group);
    }
    group.references.push(slot.reference);
  }

  return {
    groups,
    buckets,
    bucket: known ? bucketKey : null,
    page: currentPage,
    pageSize,
    totalPages,
    matchedReferences: citations.size,
    totalRows,
    rangeStart: pageSlots.length > 0 ? offset + 1 : 0,
    rangeEnd: offset + pageSlots.length,
  };
}
