/**
 * Global "recent changes" feed for the landing page — the most recent
 * applied edits to drug parameters and wiki content, merged and sorted by
 * time. Each source table already carries a `createdAt`-only index
 * (`drug_param_rev_created_idx`, `wiki_revisions_created_idx`) built for
 * exactly this kind of global recency query, not just the per-drug/per-page
 * history views that use them today.
 *
 *   GET ?limit=
 */
import { desc, eq, sql } from 'drizzle-orm';
import { json, error, withErrorHandling, publicCacheHeaders } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import {
  drugParameterRevisions,
  drugs,
  wikiRevisions,
  wikiPages,
  users,
  agents,
} from '../db/schema.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Shared author projection — role + isAgent are already public (via
// /api/agents), but email is intentionally left out: this endpoint has no
// auth gate, so it would otherwise let anyone scrape contributor addresses
// off the landing page. UserBadge degrades to a plain span without it.
const authorColumns = {
  username: users.username,
  displayName: users.displayName,
  role: users.role,
  isAgent: sql<boolean>`${agents.id} is not null`,
};

export default withErrorHandling(async function handler(req, res): Promise<void> {
  if (req.method !== 'GET') {
    error(res, 405, 'Method not allowed');
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const limitParam = Number(url.searchParams.get('limit'));
  const limit =
    Number.isInteger(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_LIMIT)
      : DEFAULT_LIMIT;

  const db = getDb();
  try {
    const [parameterRows, wikiRows] = await Promise.all([
      db
        .select({
          id: drugParameterRevisions.id,
          parameter: drugParameterRevisions.parameter,
          editSummary: drugParameterRevisions.editSummary,
          createdAt: drugParameterRevisions.createdAt,
          drug: {
            id: drugs.id,
            // Kept alongside `id` so a client still on the previous
            // frontend bundle (slug-only rendering) doesn't construct
            // `/wiki/undefined` while this response is cached (up to 600s
            // stale-while-revalidate) across a deploy.
            slug: drugs.slug,
            names: drugs.names,
            nameShort: drugs.nameShort,
          },
          author: authorColumns,
        })
        .from(drugParameterRevisions)
        .innerJoin(drugs, eq(drugParameterRevisions.drugId, drugs.id))
        .leftJoin(users, eq(drugParameterRevisions.createdBy, users.id))
        .leftJoin(agents, eq(agents.userId, users.id))
        .orderBy(desc(drugParameterRevisions.createdAt))
        .limit(limit),
      db
        .select({
          id: wikiRevisions.id,
          editSummary: wikiRevisions.editSummary,
          createdAt: wikiRevisions.createdAt,
          page: {
            slug: wikiPages.slug,
            title: wikiPages.title,
          },
          author: authorColumns,
        })
        .from(wikiRevisions)
        // Draft/unpublished pages must not leak onto the public landing
        // page — same visibility rule as the wiki-revision governance
        // adapter (api/_lib/knowledge-governance/adapters/kinetix/wiki-revision.ts).
        .innerJoin(
          wikiPages,
          eq(wikiPages.id, wikiRevisions.pageId),
        )
        .leftJoin(users, eq(wikiRevisions.createdBy, users.id))
        .leftJoin(agents, eq(agents.userId, users.id))
        .where(eq(wikiPages.status, 'published'))
        .orderBy(desc(wikiRevisions.createdAt))
        .limit(limit),
    ]);

    // Each query already returns its own top `limit` rows sorted by
    // recency, so the true global top `limit` is necessarily a subset of
    // their union — safe to merge and re-slice client-side.
    const changes = [
      ...parameterRows.map((r) => ({ type: 'drug_parameter' as const, ...r })),
      ...wikiRows.map((r) => ({ type: 'wiki' as const, ...r })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);

    json(res, 200, { changes }, { headers: publicCacheHeaders() });
  } catch {
    error(res, 500, 'Failed to fetch recent changes');
  }
});
