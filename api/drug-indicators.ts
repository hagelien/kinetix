/**
 * Aggregated indicators used to decorate parameter / fact boxes:
 *   GET ?drugId=N
 *   →  {
 *        comments: { [parameter]: number, __monograph__?: number },
 *        refs:     { [parameter]: number[] }
 *      }
 *   GET ?wikiPageId=N        (topic / non-monograph pages)
 *   →  { comments: { [fact:<id>]: number }, refs: {} }
 *
 * Used by the wiki sidebar and parameter header to surface comment counts,
 * missing-reference warnings, and the multi-reference superscripts per fact.
 * Topic pages have no drug_parameter_revisions, so `refs` is always empty for
 * the wikiPageId form.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq, sql } from "drizzle-orm";
import {
  json,
  error,
  withErrorHandling,
  publicCacheHeaders,
  noStoreHeaders,
} from "./_lib/response.js";

const DRUG_INDICATORS_CACHE_HEADERS = publicCacheHeaders({
  sMaxAge: 60,
  staleWhileRevalidate: 300,
});
import { getDb } from "./_lib/db.js";
import { getUserFromRequest } from "./_lib/auth.js";
import {
  callerCanReadWikiPage,
} from "./_lib/permissions-store.js";
import { drugParameterDiscussions, wikiPages } from "../db/schema.js";

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
    if (req.method !== "GET") {
      error(res, 405, "Method not allowed");
      return;
    }
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const drugIdRaw = url.searchParams.get("drugId");
    const wikiPageIdRaw = url.searchParams.get("wikiPageId");
    if ((drugIdRaw == null) === (wikiPageIdRaw == null)) {
      error(res, 400, "Provide exactly one of drugId or wikiPageId");
      return;
    }
    if (wikiPageIdRaw != null) {
      const wikiPageId = Number(wikiPageIdRaw);
      if (!wikiPageId || Number.isNaN(wikiPageId)) {
        error(res, 400, "Missing or invalid wikiPageId");
        return;
      }
      return handleGetWikiPage(req, res, wikiPageId);
    }
    const drugId = Number(drugIdRaw);
    if (!drugId || Number.isNaN(drugId)) {
      error(res, 400, "Missing or invalid drugId");
      return;
    }
    return handleGet(res, drugId);
  },
);

async function handleGetWikiPage(
  req: IncomingMessage,
  res: ServerResponse,
  wikiPageId: number,
): Promise<void> {
  const db = getDb();
  const [page] = await db
    .select({ status: wikiPages.status })
    .from(wikiPages)
    .where(eq(wikiPages.id, wikiPageId))
    .limit(1);
  if (!page) {
    error(res, 404, "Page not found", "wiki_page_not_found");
    return;
  }

  const auth = await getUserFromRequest(req);
  if (
    !(await callerCanReadWikiPage(
      page.status,
      auth ? { role: auth.role } : null,
    ))
  ) {
    error(res, 404, "Page not found", "wiki_page_not_found");
    return;
  }

  const commentCounts = await db
    .select({
      parameter: drugParameterDiscussions.parameter,
      count: sql<number>`count(*)::int`,
    })
    .from(drugParameterDiscussions)
    .where(eq(drugParameterDiscussions.wikiPageId, wikiPageId))
    .groupBy(drugParameterDiscussions.parameter);

  const comments: Record<string, number> = {};
  for (const row of commentCounts) {
    // Topic-page rows always carry a `fact:<id>` parameter (enforced at the
    // discussions write boundary); skip any stray null defensively rather
    // than bucketing it as a monograph-wide thread that can't exist here.
    if (row.parameter) comments[row.parameter] = row.count;
  }

  json(
    res,
    200,
    { comments, refs: {} },
    {
      headers:
        page.status === "published"
          ? DRUG_INDICATORS_CACHE_HEADERS
          : noStoreHeaders(),
    },
  );
}

async function handleGet(res: ServerResponse, drugId: number): Promise<void> {
  const db = getDb();

  // Both queries are independent — run in parallel to avoid two sequential
  // Neon HTTP round-trips.
  const [commentCounts, revRows] = await Promise.all([
    db
      .select({
        parameter: drugParameterDiscussions.parameter,
        count: sql<number>`count(*)::int`,
      })
      .from(drugParameterDiscussions)
      .where(eq(drugParameterDiscussions.drugId, drugId))
      .groupBy(drugParameterDiscussions.parameter),

    // DISTINCT ON (parameter) uses the (drug_id, parameter, created_at) index to
    // return only the latest revision per parameter in one pass, avoiding a full
    // history scan and JS dedup that grows with edit count.
    db.execute<{
      parameter: string;
      reference_id: number | null;
      reference_ids: number[] | null;
    }>(sql`
      SELECT DISTINCT ON (parameter)
        parameter,
        reference_id,
        reference_ids
      FROM drug_parameter_revisions
      WHERE drug_id = ${drugId}
      ORDER BY parameter, created_at DESC
    `),
  ]);

  const comments: Record<string, number> = {};
  for (const row of commentCounts) {
    const key = row.parameter ?? "__monograph__";
    comments[key] = row.count;
  }

  const refs: Record<string, number[]> = {};
  for (const row of revRows.rows) {
    const ids =
      row.reference_ids && row.reference_ids.length > 0
        ? row.reference_ids
        : row.reference_id
          ? [row.reference_id]
          : [];
    refs[row.parameter] = ids;
  }

  json(
    res,
    200,
    { comments, refs },
    { headers: DRUG_INDICATORS_CACHE_HEADERS },
  );
}
