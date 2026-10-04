/**
 * Global "recent changes" feed for the landing page — the most recent
 * applied edits to drug parameters and wiki content, merged and sorted by
 * time. Each source table already carries a `createdAt`-only index
 * (`drug_param_rev_created_idx`, `wiki_revisions_created_idx`) built for
 * exactly this kind of global recency query, not just the per-drug/per-page
 * history views that use them today.
 *
 * Approved source values on parameters with no drug-level value (Cmax, ka,
 * the model-structure axes) never write a `drug_parameter_revisions` row, so
 * they are read from their approved pending edits instead — otherwise a
 * stretch of agent work confined to those parameters leaves the feed frozen
 * even though changes are landing. `pending_edits_rejection_scan_idx`
 * (status, reviewed_at desc) serves that recency query.
 *
 *   GET ?limit=
 */
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { json, error, withErrorHandling, publicCacheHeaders } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import {
  drugParameterRevisions,
  drugs,
  wikiRevisions,
  wikiPages,
  users,
  agents,
  pendingEdits,
  parameterEntries,
} from '../db/schema.js';
import {
  DRUG_PARAMETER_IDS,
  parameterIsEntryBacked,
  parameterIsSummarizable,
} from '../src/lib/drugParameters.js';

const DEFAULT_LIMIT = 20;

// Entry-backed parameters whose approved source values never surface as a
// revision: a summarizable one records a revision whenever its cached
// aggregate moves, but these have no aggregate to move.
const REVISIONLESS_ENTRY_PARAMETERS: string[] = DRUG_PARAMETER_IDS.filter(
  (id) => parameterIsEntryBacked(id) && !parameterIsSummarizable(id),
);
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
    const [parameterRows, wikiRows, sourceValueRows] = await Promise.all([
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
      db
        .select({
          id: pendingEdits.id,
          parameter: pendingEdits.parameter,
          editSummary: sql<string | null>`${pendingEdits.proposedMeta} ->> 'editSummary'`,
          createdAt: pendingEdits.reviewedAt,
          drug: {
            id: drugs.id,
            slug: drugs.slug,
            names: drugs.names,
            nameShort: drugs.nameShort,
          },
          author: authorColumns,
        })
        .from(pendingEdits)
        // A `create` names its drug in `target_id`; an `update`/`delete`
        // names the entry, so its drug is read off that entry. An applied
        // delete has no entry left to read and drops out of the feed.
        .leftJoin(
          parameterEntries,
          and(
            sql`${pendingEdits.proposedValue} ->> 'op' <> 'create'`,
            eq(parameterEntries.id, pendingEdits.targetId),
          ),
        )
        .innerJoin(
          drugs,
          eq(
            drugs.id,
            sql`case when ${pendingEdits.proposedValue} ->> 'op' = 'create' then ${pendingEdits.targetId} else ${parameterEntries.drugId} end`,
          ),
        )
        .leftJoin(users, eq(pendingEdits.submittedBy, users.id))
        .leftJoin(agents, eq(agents.userId, users.id))
        .where(
          and(
            eq(pendingEdits.status, 'approved'),
            eq(pendingEdits.editType, 'param_entry'),
            inArray(pendingEdits.parameter, REVISIONLESS_ENTRY_PARAMETERS),
            isNotNull(pendingEdits.reviewedAt),
          ),
        )
        .orderBy(desc(pendingEdits.reviewedAt))
        .limit(limit),
    ]);

    // Each query already returns its own top `limit` rows sorted by
    // recency, so the true global top `limit` is necessarily a subset of
    // their union — safe to merge and re-slice client-side.
    //
    // Source values reuse the `drug_parameter` shape so a client still on the
    // previous bundle renders them as parameter changes; `origin` keeps their
    // ids (pending-edit ids) apart from revision ids.
    const changes = [
      ...parameterRows.map((r) => ({
        type: 'drug_parameter' as const,
        origin: 'revision' as const,
        ...r,
      })),
      // `parameter` and `reviewedAt` are non-null by the query's filter.
      ...sourceValueRows.map((r) => ({
        type: 'drug_parameter' as const,
        origin: 'source_value' as const,
        ...r,
        parameter: r.parameter!,
        createdAt: r.createdAt!,
      })),
      ...wikiRows.map((r) => ({ type: 'wiki' as const, ...r })),
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);

    json(res, 200, { changes }, { headers: publicCacheHeaders() });
  } catch {
    error(res, 500, 'Failed to fetch recent changes');
  }
});
