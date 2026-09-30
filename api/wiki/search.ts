import type { IncomingMessage, ServerResponse } from 'node:http';
import { sql, type SQL } from 'drizzle-orm';
import {
  json,
  error,
  withErrorHandling,
  publicCacheHeaders,
} from '../_lib/response.js';
import { getDb } from '../_lib/db.js';
import { wikiPages } from '../../db/schema.js';

// Wiki content only changes when a pending edit is approved, so repeated
// identical queries can safely be served from the CDN for 5 minutes.
// stale-while-revalidate=3600 keeps results fast during the background
// refresh without blocking users on a Neon round-trip.
const PUBLIC_WIKI_SEARCH_CACHE_HEADERS = publicCacheHeaders({
  sMaxAge: 300,
  staleWhileRevalidate: 3600,
});

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    error(res, 405, 'Method not allowed');
    return;
  }

  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  );
  const q = url.searchParams.get('q');
  const requestedLimit = Number(url.searchParams.get('limit'));
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.trunc(requestedLimit), 20)
      : 20;
  const view =
    url.searchParams.get('view') === 'compact' ? 'compact' : 'default';
  if (!q || !q.trim()) {
    error(res, 400, 'Missing search query');
    return;
  }

  const db = getDb();

  try {
    // Convert search terms for tsquery: split on spaces, join with &
    const trimmedQuery = q.trim();
    const rawTerms = trimmedQuery.split(/\s+/).filter((t) => t.length > 0);
    const terms = rawTerms
      .map((t) => t.replace(/[^a-zA-Z0-9]/g, ''))
      .filter((t) => t.length > 0);
    const needsTitleFallback =
      terms.length === 0 ||
      rawTerms.some((term) => term.replace(/[^a-zA-Z0-9]/g, '') !== term);

    const tsquery = terms.map((t) => `${t}:*`).join(' & ');
    // migration 0039 added a GENERATED ALWAYS AS STORED tsvector column
    // `search_tsvector` and moved the GIN index onto it. Both the @@ predicate
    // and ts_rank() now read the pre-computed value instead of calling
    // to_tsvector() twice per candidate row (once for the index match, once for
    // ranking). The column name is referenced directly via sql`` because
    // drizzle-orm does not have a built-in tsvector column type.
    const tsqueryExpr = sql`to_tsquery('english', ${tsquery})`;
    const rank =
      terms.length > 0
        ? sql<number>`ts_rank(search_tsvector, ${tsqueryExpr})`
        : sql<number>`0`;
    const ftsClause =
      terms.length > 0 ? sql`search_tsvector @@ ${tsqueryExpr}` : null;
    const titleFallbackClause = needsTitleFallback
      ? sql`${wikiPages.title} ILIKE ${`%${escapeLikePattern(trimmedQuery)}%`} ESCAPE '\\'`
      : null;

    // Drug monographs are titled with a single drug name (often the stale or
    // English-only one), so English FTS over title+content misses them when a
    // user types a Norwegian name, an alias, or a street name — the exact case
    // the agent-focus page picker and the command palette hit for "kokain".
    // Match those pages through the linked drug's `search_key` (the same
    // lowercase, tab-joined "name + nameEn + aliases + shortname" key the drug
    // typeahead `/api/drugs?view=search` uses) so wiki search resolves the same
    // drug the general search does. `wiki_pages.drug_cid` is mixed-vintage —
    // modern rows store `drugs.id`, legacy ones a PubChem CID — so match both.
    const loweredLike = escapeLikePattern(trimmedQuery.toLowerCase());
    const drugSearchKeyMatch = (pattern: string): SQL => sql`EXISTS (
      SELECT 1 FROM drugs d
      WHERE (d.id = ${wikiPages.drugCid} OR d.pubchem_cid = ${wikiPages.drugCid})
        AND d.search_key LIKE ${pattern} ESCAPE '\\'
    )`;
    const drugMonographClause = sql`${wikiPages.pageType} = 'drug_monograph' AND ${drugSearchKeyMatch(
      `%${loweredLike}%`,
    )}`;

    const clauses = [ftsClause, titleFallbackClause, drugMonographClause].filter(
      (c): c is SQL => c != null,
    );
    const matchClause =
      clauses.length === 1
        ? clauses[0]!
        : sql`(${sql.join(clauses, sql` OR `)})`;
    const whereClause = sql`${wikiPages.status} = 'published' AND ${matchClause}`;

    // A monograph matched only by its linked drug's name/alias has an FTS rank
    // of 0, so without a boost it would sort below every content hit and could
    // fall off the LIMIT. Float monographs whose drug name/alias *starts* with
    // the query (key start `q%` or right after a tab boundary `\tq%`, mirroring
    // the drug typeahead's relevance order) to the top of the list.
    const nameRank = sql<number>`CASE
      WHEN ${wikiPages.pageType} = 'drug_monograph'
        AND (${drugSearchKeyMatch(`${loweredLike}%`)} OR ${drugSearchKeyMatch(
          `%\t${loweredLike}%`,
        )})
      THEN 1 ELSE 0 END`;
    const orderBy = [sql`${nameRank} DESC`, sql`${rank} DESC`];

    const results =
      view === 'compact'
        ? await db
            .select({
              slug: wikiPages.slug,
              title: wikiPages.title,
              pageType: wikiPages.pageType,
            })
            .from(wikiPages)
            .where(whereClause)
            .orderBy(...orderBy)
            .limit(limit)
        : await db
            .select({
              id: wikiPages.id,
              slug: wikiPages.slug,
              title: wikiPages.title,
              pageType: wikiPages.pageType,
              snippet: sql<string>`left(${wikiPages.contentPlaintext}, 200)`,
              rank,
            })
            .from(wikiPages)
            .where(whereClause)
            .orderBy(...orderBy)
            .limit(limit);

    json(
      res,
      200,
      { results },
      {
        headers: PUBLIC_WIKI_SEARCH_CACHE_HEADERS,
      },
    );
  } catch {
    error(res, 500, 'Search failed');
  }
});
