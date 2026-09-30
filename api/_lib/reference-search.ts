/**
 * Reference search — matching a free-text query against everything we know
 * about a cited paper.
 *
 * A reference is not just its title: users look for the paper they have in
 * hand, and what they have is usually an identifier they pasted from a PDF or
 * a browser tab ("doi:10.1093/jat/bkaa107", "PMID 33245119",
 * "https://doi.org/10.1093/…"), or a phrase they remember from the agent's
 * quality review of it ("postmortem redistribution", "small cohort"). Matching
 * titles alone made all of those come back empty (#references-search).
 *
 * The search therefore covers, per citation:
 *   - the identifier, with the prefix/URL wrappers users paste stripped off
 *   - every metadata field (title, authors, journal, year, volume, pages)
 *   - the current agent paper review's markdown body
 *
 * Multi-word queries are AND-ed: every whitespace-separated term must appear
 * somewhere in that haystack — in the citation's own fields or in its review —
 * so adding a word narrows the result set.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { getDb } from './db.js';

type Db = ReturnType<typeof getDb>;

export interface ParsedReferenceQuery {
  /** The trimmed query exactly as typed. */
  raw: string;
  /**
   * Lowercased search terms, prefix-stripped and de-duplicated. Every term
   * must match for a citation to be returned.
   */
  terms: string[];
  /**
   * The query read as a bare identifier (DOI, PubMed ID, or URL) when it looks
   * like one, e.g. `doi:10.1093/jat/bkaa107` → `10.1093/jat/bkaa107`. Used for
   * exact-hit ranking; matching itself goes through `terms`.
   */
  identifier: string | null;
}

/** How a citation matched — powers the "why is this a hit?" hint in the UI. */
export type ReferenceMatchSource =
  | 'identifier'
  | 'metadata'
  | 'review'
  | 'other';

export interface CitationSearchRow extends Record<string, unknown> {
  id: number;
  drug_id: number | null;
  type: string;
  identifier: string;
  metadata: unknown;
  created_at: string | Date;
  match_rank: number;
  match_source: ReferenceMatchSource;
  review_snippet: string | null;
}

// Wrappers users paste along with an identifier. Stripped before matching so a
// pasted "doi:10.1093/jat/bkaa107" finds the row stored as "10.1093/jat/bkaa107"
// (and vice versa — matching is by substring, so it works in both directions).
//
// `expect` guards each text prefix: "doi" and "pubmed" are also ordinary words
// that appear in titles, journals, and review prose, so a prefix is only
// stripped when what follows actually is an identifier of that kind. Without
// it, searching "PubMed indexing" silently became a search for "indexing".
// `url: true` marks the resolver-URL forms — an address is unambiguous, so it
// always strips, along with any query string or fragment it carries.
// PMIDs are "a positive integer up to 8 digits" at the write boundary
// (validateReferenceIdentifier); the search must accept the same range, or a
// short PMID becomes unsearchable through its own wrapper.
const PMID_REMAINDER = /^\d{1,8}$/;
const DOI_REMAINDER = /^10\.\d+\/\S+/;

const IDENTIFIER_PREFIXES: Array<{
  pattern: RegExp;
  expect?: RegExp;
  url?: boolean;
}> = [
  { pattern: /^doi\s*[:=]\s*/i, expect: DOI_REMAINDER },
  { pattern: /^https?:\/\/(?:dx\.)?doi\.org\//i, url: true },
  { pattern: /^doi\.org\//i, url: true },
  { pattern: /^pmid\s*[:=]?\s*/i, expect: PMID_REMAINDER },
  { pattern: /^pubmed\s*(?:id)?\s*[:=]?\s*/i, expect: PMID_REMAINDER },
  { pattern: /^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//i, url: true },
  { pattern: /^https?:\/\/www\.ncbi\.nlm\.nih\.gov\/pubmed\//i, url: true },
];

/**
 * A search query is turned into one SQL scan arm per term, so an unbounded `q`
 * on these public routes would let a caller author an arbitrarily large
 * statement. Both routes therefore truncate rather than reject: an over-long
 * paste still searches on its leading terms (a superset of what the full query
 * would return) instead of erroring out on the user.
 */
export const MAX_REFERENCE_QUERY_LENGTH = 200;
export const MAX_REFERENCE_QUERY_TERMS = 8;

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/;
const PMID_PATTERN = PMID_REMAINDER;

/**
 * Strip the identifier wrappers users paste ("doi:", a doi.org/PubMed URL,
 * "PMID:") from the front of a query, and drop a trailing slash left behind by
 * a copied PubMed URL. Anything that is not an identifier passes through
 * unchanged.
 */
export function stripReferenceIdentifierPrefixes(value: string): string {
  const original = value.trim();
  for (const { pattern, expect, url } of IDENTIFIER_PREFIXES) {
    const stripped = original.replace(pattern, '');
    if (stripped === original) continue;
    // A resolver link copied from the address bar often brings a query string
    // or fragment along ("…/33245119/?format=pubmed"). Neither is part of the
    // stored identifier, so keeping them would match nothing.
    let remainder = stripped.trim();
    if (url) remainder = remainder.split(/[?#]/, 1)[0]!.trim();
    remainder = remainder.replace(/\/+$/, '').trim();
    // A wrapper with nothing after it is an identifier search the user has not
    // finished typing: it has no searchable term, and must not fall through to
    // a literal search for "doi:". The separator is what makes it a wrapper —
    // "doi:" and "https://doi.org/" are unfinished syntax, whereas a bare
    // "PubMed" is just a word someone is searching for.
    if (!remainder) {
      const matched = original.slice(0, original.length - stripped.length);
      return url || /[:=]/.test(matched) ? '' : original;
    }
    // Not an identifier of this kind — the "prefix" was just a word in the
    // query, so leave the query exactly as typed.
    if (expect && !expect.test(remainder)) return original;
    return remainder;
  }
  return original;
}

export function parseReferenceQuery(raw: string): ParsedReferenceQuery {
  const trimmed = (raw ?? '')
    .trim()
    .slice(0, MAX_REFERENCE_QUERY_LENGTH)
    .trim();
  if (!trimmed) return { raw: '', terms: [], identifier: null };

  const stripped = stripReferenceIdentifierPrefixes(trimmed);
  const lowered = stripped.toLowerCase();
  const terms = [...new Set(lowered.split(/\s+/).filter(Boolean))].slice(
    0,
    MAX_REFERENCE_QUERY_TERMS,
  );

  const identifier =
    DOI_PATTERN.test(stripped) ||
    PMID_PATTERN.test(stripped) ||
    /^https?:\/\/\S+$/i.test(stripped)
      ? lowered
      : null;

  return { raw: trimmed, terms, identifier };
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function contains(value: string): string {
  return `%${escapeLikePattern(value)}%`;
}

/**
 * `metadata.authors` as the text a reader sees, not as JSON.
 *
 * `->>` renders a jsonb array as JSON text — `["Huertas T", "Aasen B"]`,
 * brackets and quotes included — which puts punctuation *inside* the value
 * between the names. `translate` deletes those three structural characters,
 * leaving `Huertas T, Aasen B`: exactly what `/references/:id` renders with
 * `authors.join(', ')`, so an author list pasted from that page is compared
 * against the same string it was copied from. A legacy string value passes
 * through unchanged (nothing to strip), and the function is IMMUTABLE, so the
 * haystack built on it stays indexable.
 *
 * Used by all three author-aware expressions — the match predicate, the
 * relevance tiers, and the match-source probe. Matching on one shape while
 * ranking on another is how a hit lands in the `other` tier: it would still be
 * returned, then sorted behind less relevant rows in the palette's short,
 * rank-ordered list.
 */
const AUTHORS_TEXT = sql`translate(coalesce(c.metadata->>'authors', ''), '[]"', '')`;

/**
 * Every searchable field a citation carries in its own row, as one text blob.
 *
 * Built with `||` rather than `concat_ws` on purpose: concat_ws is only STABLE,
 * so Postgres refuses it in an index expression. This form is immutable, which
 * lets migration 0093 put a GIN trigram index on the *exact same expression* —
 * a predicate that doesn't match its index verbatim gets no index at all. Keep
 * the two in lockstep: editing the field list here means editing the migration.
 *
 * `authors` is an array, and `->>` renders one as JSON text — `["Huertas T",
 * "Aasen B"]`, brackets and quotes included. That put punctuation *inside* the
 * haystack between the names, so an author list pasted from a reference page
 * (which renders `authors.join(', ')`) tokenized to `huertas`, `t,`, … and the
 * `t,` term could not match `T", ` in the JSON rendering. `translate` deletes
 * the three structural characters, leaving `Huertas T, Aasen B` — the same text
 * the page displays. It is IMMUTABLE, so the expression stays indexable, and a
 * legacy string value passes through it unchanged (nothing to strip).
 *
 * Exported so the integration test can EXPLAIN this exact expression rather
 * than a hand-copied third version of it: a plan that stops using the index is
 * then a failing test, not a silent full scan on a public route.
 */
/**
 * The handles this paper is NOT filed under (#1018), as one text blob.
 *
 * One paper is one row, so the DOI a user has in hand may well belong to a row
 * filed under its PMID. Those handles are just as much "the identifier" from
 * the searcher's point of view, so every place that reasons about
 * `c.identifier` — matching, ranking, and the match-source probe — has to
 * consider them too, or a hit lands in a tier that contradicts why it matched.
 *
 * Deliberately NOT substituted into {@link CITATION_HAYSTACK}, which spells the
 * same four arms out inline. The haystack has to match migration 0093's index
 * expression character for character, and interpolating a composed fragment
 * would wrap these in an extra pair of parentheses — enough for Postgres to
 * stop using the index, silently, on a public route.
 */
const ALT_IDS_TEXT = sql`(
  coalesce(c.metadata->'altIds'->>'pmid', '') || ' ' ||
  coalesce(c.metadata->'altIds'->>'doi', '') || ' ' ||
  coalesce(c.metadata->'altIds'->>'pmcid', '') || ' ' ||
  coalesce(c.metadata->'altIds'->>'url', '')
)`;

/** Every handle the row is addressable by: its own, plus its alt ids. */
const IDENTIFIERS_TEXT = sql`(coalesce(c.identifier, '') || ' ' || ${ALT_IDS_TEXT})`;

/** Exact equality against any handle the row is addressable by. */
function identifierEquals(value: string): SQL {
  return sql`(
    lower(c.identifier) = ${value}
    OR lower(c.metadata->'altIds'->>'pmid') = ${value}
    OR lower(c.metadata->'altIds'->>'doi') = ${value}
    OR lower(c.metadata->'altIds'->>'pmcid') = ${value}
    OR lower(c.metadata->'altIds'->>'url') = ${value}
  )`;
}

// The `altIds` arms are the handles this paper is NOT filed under (#1018).
// One paper is one row, so a pasted DOI for a paper filed under its PMID would
// otherwise find nothing at all.
export const CITATION_HAYSTACK = sql`(
  coalesce(c.identifier, '') || ' ' ||
  coalesce(c.metadata->>'title', '') || ' ' ||
  ${AUTHORS_TEXT} || ' ' ||
  coalesce(c.metadata->>'journal', '') || ' ' ||
  coalesce(c.metadata->>'year', '') || ' ' ||
  coalesce(c.metadata->>'volume', '') || ' ' ||
  coalesce(c.metadata->>'pages', '') || ' ' ||
  coalesce(c.metadata->'altIds'->>'pmid', '') || ' ' ||
  coalesce(c.metadata->'altIds'->>'doi', '') || ' ' ||
  coalesce(c.metadata->'altIds'->>'pmcid', '') || ' ' ||
  coalesce(c.metadata->'altIds'->>'url', '')
)`;

/**
 * Best-effort numeric year for ordering, tolerant of the string years legacy
 * metadata carries. Reads the first four-digit run rather than every digit:
 * `metadata.year` is only bounded by `z.number().int()` at the write boundary,
 * so stripping non-digits from something like `3000000000` produced a value
 * past int4 and turned every search matching that row into a 500. A four-digit
 * window cannot overflow, and a nonsense year only sorts oddly.
 */
const YEAR_EXPR = sql`nullif(substring(coalesce(c.metadata->>'year', '') from '[0-9]{4}'), '')::int`;

/**
 * The set of citation ids matching every term.
 *
 * Shape matters for the query plan. A citation matches a term through its own
 * fields OR through its paper review — two different tables — so the naive
 * `citation_haystack ILIKE p OR review_markdown ILIKE p` over a LEFT JOIN
 * forces a sequential scan: no index can answer a predicate spanning both
 * sides of a join. Splitting each term into a UNION of two single-table scans
 * lets the trigram index on each table serve its own arm, and INTERSECTing the
 * per-term sets preserves the AND semantics exactly — including across sources,
 * so "postmortem kohorten" still matches a paper whose title carries one word
 * and whose review carries the other.
 */
function matchingCitationIds(parsed: ParsedReferenceQuery): SQL | null {
  if (parsed.terms.length === 0) return null;
  const perTerm = parsed.terms.map((term) => {
    const pattern = contains(term);
    // The inner `c` deliberately shadows the outer query's alias: each arm is
    // a self-contained single-table scan, which is what makes it indexable.
    return sql`(
      SELECT c.id FROM citations c
      WHERE ${CITATION_HAYSTACK} ILIKE ${pattern} ESCAPE '\\'
      UNION
      SELECT pr.citation_id FROM paper_reviews pr
      WHERE pr.review_markdown ILIKE ${pattern} ESCAPE '\\'
    )`;
  });
  return sql.join(perTerm, sql` INTERSECT `);
}

/**
 * Relevance tiers, lowest first: an identifier the user pasted verbatim beats a
 * title that starts with the query, which beats a match buried in the review
 * body. Mirrors the command palette's ranking vocabulary so merged results read
 * "best match first".
 */
function referenceSearchRank(parsed: ParsedReferenceQuery): SQL {
  const lowered = parsed.raw.toLowerCase();
  const identifierClause = parsed.identifier
    ? identifierEquals(parsed.identifier)
    : sql`false`;
  return sql`CASE
    WHEN ${identifierClause} THEN 0
    WHEN lower(coalesce(c.metadata->>'title', '')) LIKE ${`${escapeLikePattern(lowered)}%`} ESCAPE '\\' THEN 1
    WHEN ${IDENTIFIERS_TEXT} ILIKE ${contains(lowered)} ESCAPE '\\' THEN 2
    WHEN coalesce(c.metadata->>'title', '') ILIKE ${contains(lowered)} ESCAPE '\\' THEN 3
    WHEN ${AUTHORS_TEXT} ILIKE ${contains(lowered)} ESCAPE '\\' THEN 4
    ELSE 5
  END`;
}

/**
 * Which field the first term hit, so the UI can say "matched in the review"
 * instead of showing a result whose title has nothing to do with the query.
 */
function referenceMatchSource(term: string): SQL {
  const pattern = contains(term);
  return sql`CASE
    WHEN ${IDENTIFIERS_TEXT} ILIKE ${pattern} ESCAPE '\\' THEN 'identifier'
    WHEN concat_ws(' ', c.metadata->>'title', ${AUTHORS_TEXT}, c.metadata->>'journal', c.metadata->>'year') ILIKE ${pattern} ESCAPE '\\' THEN 'metadata'
    WHEN coalesce(pr.review_markdown, '') ILIKE ${pattern} ESCAPE '\\' THEN 'review'
    ELSE 'other'
  END`;
}

/** ~180 characters of review prose centred on the first term's position. */
function reviewSnippet(term: string): SQL {
  const pattern = contains(term);
  return sql`CASE
    WHEN coalesce(pr.review_markdown, '') ILIKE ${pattern} ESCAPE '\\'
    THEN substring(
      pr.review_markdown
      FROM greatest(1, strpos(lower(pr.review_markdown), ${term}) - 70)
      FOR 180
    )
    ELSE NULL
  END`;
}

/**
 * Citations matching `parsed`, best match first. `limit` of `null` returns
 * every hit (the reference index filters its own anchored universe by this
 * set); the palette passes a small limit.
 */
export async function searchCitationRows(
  db: Db,
  parsed: ParsedReferenceQuery,
  limit: number | null = null,
): Promise<CitationSearchRow[]> {
  const matches = matchingCitationIds(parsed);
  if (!matches) return [];

  const firstTerm = parsed.terms[0]!;
  const limitClause = limit != null ? sql`LIMIT ${limit}` : sql``;

  const result = await db.execute<CitationSearchRow>(sql`
    SELECT c.id,
           c.drug_id,
           c.type,
           c.identifier,
           c.metadata,
           c.created_at,
           ${referenceSearchRank(parsed)} AS match_rank,
           ${referenceMatchSource(firstTerm)} AS match_source,
           ${reviewSnippet(firstTerm)} AS review_snippet
    FROM citations c
    LEFT JOIN paper_reviews pr ON pr.citation_id = c.id
    WHERE c.id IN (SELECT id FROM (${matches}) AS matched(id))
    ORDER BY match_rank ASC, ${YEAR_EXPR} DESC NULLS LAST, c.id ASC
    ${limitClause}
  `);

  return result.rows ?? [];
}

/** Just the ids, for intersecting with an already-computed candidate set. */
export async function findCitationIdsMatchingQuery(
  db: Db,
  parsed: ParsedReferenceQuery,
): Promise<Set<number>> {
  const rows = await searchCitationRows(db, parsed, null);
  return new Set(rows.map((row) => row.id));
}
