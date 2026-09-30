/**
 * Consolidated wiki pages CRUD endpoint.
 * Dispatches by HTTP method:
 *   GET    — List pages (no slug), get single page (?slug=), get by drug (?drugCid=), or get by id (?pageId=)
 *   POST   — Create new page (editor+ role)
 *   PUT    — Update page (?slug=, editor+ role)
 *   DELETE — Delete page (?slug=, admin role)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq, ne, desc, and, sql, type SQL } from 'drizzle-orm';
import {
  json,
  error,
  withErrorHandling,
  noStoreHeaders,
  publicCacheHeaders,
} from '../_lib/response.js';
import { getDb } from '../_lib/db.js';
import { getUserFromRequest, requestHasAuthCookie } from '../_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from '../_lib/validate.js';
import { createPageSchema, updatePageSchema } from '../_lib/schemas.js';
import { generateSlug } from '../_lib/slug.js';
import {
  ensureTopicSectionIds,
  extractPlaintext,
  renderHtml,
} from '../_lib/tiptap-utils.js';
import {
  callerCan,
  callerCanReadWikiPage,
} from '../_lib/permissions-store.js';
import { CAP } from '../../src/lib/permissions.js';
import {
  blockedParametersFor,
  lockDrugForEntryApplicability,
  ParameterNotApplicableError,
  withDrugApplicabilityLock,
} from '../_lib/parameterApplicabilityStore.js';
import { inTransaction, runInPoolTransaction } from '../_lib/db.js';
import { resolveOwningDrugIdForMonograph } from '../_lib/monograph-helpers.js';

/**
 * Run the page-creation writes as one transaction, holding the per-drug
 * applicability lock when the page belongs to a drug. A topic page has no
 * drug to lock, so it gets the transaction alone — still worth having, since
 * it makes page + revision + categories atomic.
 */
function withPageWriteLock<T>(
  drugId: number | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return drugId === undefined
    ? inTransaction(fn)
    : withDrugApplicabilityLock(drugId, fn);
}
import {
  insertDrug,
  isUniqueViolation,
  validateParameterBag,
  applyInitialParameters,
} from '../_lib/drugs-helpers.js';
import {
  wikiPages,
  wikiRevisions,
  wikiPageCategories,
  users,
  agents,
  pendingEdits,
  drugs,
} from '../../db/schema.js';
import {
  isActiveAgentUser,
  recordImplicitAgentApproval,
  recordImplicitAgentApprovals,
} from '../_lib/agent-verifications.js';
import {
  wikiContentFocusRefusal,
  wikiTargetFocusRefusal,
} from '../agent-focus.js';

const PUBLIC_WIKI_LIST_CACHE_HEADERS = publicCacheHeaders();
// Published wiki pages change only when pending edits are approved (rare).
// 5-minute CDN cache eliminates repeated Neon round-trips for popular monographs
// while keeping content reasonably fresh. stale-while-revalidate=3600 keeps
// pages fast during background refresh without blocking on a cold Neon hit.
const PUBLIC_WIKI_PAGE_CACHE_HEADERS = publicCacheHeaders({
  sMaxAge: 300,
  staleWhileRevalidate: 3600,
});

/**
 * Maximum nesting depth for the wiki hierarchy (#301). A root page is
 * depth 1; a child of a root is depth 2; max depth 4 means at most three
 * `parentId` hops from any page back to a root. The constant is also used
 * as a safety cap when walking the parent chain so a corrupted cycle in
 * the data can't spin the request thread.
 */
export const MAX_NESTING_DEPTH = 4;

interface ParentValidationOk {
  ok: true;
}
interface ParentValidationError {
  ok: false;
  status: number;
  message: string;
}
type ParentValidation = ParentValidationOk | ParentValidationError;

/**
 * Verify that assigning `parentId` to `pageId` (or to a fresh insert when
 * pageId is null) keeps the tree acyclic and within MAX_NESTING_DEPTH.
 *
 * Two parallel recursive CTEs replace the previous sequential round-trips
 * (1 initial query + up to MAX_NESTING_DEPTH-1 ancestor steps + BFS
 * descendant levels = up to 7 sequential Neon HTTP calls):
 *   - ancestors CTE: walks up from parentId, computing its depth and
 *     detecting whether pageId appears in the chain (cycle).
 *   - descendants CTE: walks down from pageId, finding the deepest leaf.
 *
 * The new tree depth at the leaf is `parentDepth + 1 + leafDistance`.
 * We reject if that exceeds MAX_NESTING_DEPTH or if pageId appears in the
 * ancestor chain (cycle).
 */
export async function validateParentAssignment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  pageId: number | null,
  parentId: number | null | undefined,
): Promise<ParentValidation> {
  if (parentId == null) return { ok: true };
  if (pageId != null && parentId === pageId) {
    return {
      ok: false,
      status: 400,
      message: 'A page cannot be its own parent',
    };
  }

  // -1 is a safe sentinel: PostgreSQL serial PKs start at 1, so no real
  // page will ever have id=-1. Used to make bool_or(id = $pageId) well-
  // defined when pageId is null (new-page creation — no cycle possible).
  const cycleCheckId = pageId ?? -1;

  // Walk up MAX_NESTING_DEPTH+1 levels so that a parent already at depth
  // MAX_NESTING_DEPTH surfaces as parent_depth > MAX_NESTING_DEPTH.
  const [ancestorResult, descendantResult] = await Promise.all([
    db.execute(sql`
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_id, 1 AS depth, ARRAY[id] AS visited
        FROM wiki_pages
        WHERE id = ${parentId}
        UNION ALL
        SELECT wp.id, wp.parent_id, a.depth + 1, a.visited || wp.id
        FROM wiki_pages wp
        JOIN ancestors a ON wp.id = a.parent_id
        WHERE a.depth <= ${MAX_NESTING_DEPTH}
          AND NOT (wp.id = ANY(a.visited))
      )
      SELECT
        MAX(depth)              AS parent_depth,
        bool_or(id = ${cycleCheckId}) AS would_cycle
      FROM ancestors
    `),
    pageId != null
      ? db.execute(sql`
          WITH RECURSIVE descendants AS (
            SELECT id, 0 AS dist
            FROM wiki_pages
            WHERE id = ${pageId}
            UNION ALL
            SELECT wp.id, d.dist + 1
            FROM wiki_pages wp
            JOIN descendants d ON wp.parent_id = d.id
            WHERE d.dist < ${MAX_NESTING_DEPTH}
          )
          SELECT COALESCE(MAX(dist), 0) AS leaf_distance FROM descendants
        `)
      : Promise.resolve({ rows: [{ leaf_distance: 0 }] }),
  ]);

  const ancestorRow = (
    ancestorResult.rows as Array<Record<string, unknown>>
  )[0];

  if (!ancestorRow || ancestorRow.parent_depth == null) {
    return { ok: false, status: 400, message: 'Parent page does not exist' };
  }

  if (ancestorRow.would_cycle) {
    return {
      ok: false,
      status: 400,
      message: 'Cannot set a descendant as parent (cycle)',
    };
  }

  const parentDepth = Number(ancestorRow.parent_depth);

  if (parentDepth > MAX_NESTING_DEPTH) {
    return {
      ok: false,
      status: 400,
      message: `Maximum nesting depth (${MAX_NESTING_DEPTH}) exceeded`,
    };
  }

  const descendantRow = (
    descendantResult.rows as Array<Record<string, unknown>>
  )[0];
  const leafDistance = Number(descendantRow?.leaf_distance ?? 0);

  if (parentDepth + 1 + leafDistance > MAX_NESTING_DEPTH) {
    return {
      ok: false,
      status: 400,
      message: `This would push the page tree below the maximum depth of ${MAX_NESTING_DEPTH}`,
    };
  }

  return { ok: true };
}

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  );

  switch (req.method) {
    case 'GET':
      return handleGet(req, res, url);
    case 'POST':
      return handleCreate(req, res);
    case 'PUT':
      return handleUpdate(req, res, url);
    case 'DELETE':
      assertSameOrigin(req);
      return handleDelete(req, res, url);
    default:
      error(res, 405, 'Method not allowed');
  }
});

// ─── GET: list, get by slug, or get by drugCid ──────────────────────────────

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const slug = url.searchParams.get('slug');
  const drugCid = url.searchParams.get('drugCid');
  const pageId = url.searchParams.get('pageId');

  if (slug) return getBySlug(req, res, slug);
  if (drugCid) return getByDrugCid(req, res, Number(drugCid));
  if (pageId) return getById(req, res, Number(pageId));
  return listPages(res, url);
}

/**
 * Shared fetch-and-serve helper for single-page GET paths. Accepts any
 * Drizzle WHERE condition so both getBySlug and getById can reuse the same
 * query, access-control check, and response shape without an extra round
 * trip. After the initial page fetch the ancestors CTE and children query
 * run in parallel — they are independent of each other and both only need
 * page.id / page.parentId, which are available after the first query.
 */
async function fetchAndServePage(
  req: IncomingMessage,
  res: ServerResponse,
  condition: SQL,
): Promise<void> {
  const db = getDb();

  const [page] = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      content: wikiPages.content,
      contentHtml: wikiPages.contentHtml,
      pageType: wikiPages.pageType,
      drugCid: wikiPages.drugCid,
      // 'entity_monograph' pages hang their bio-entity-derived sections (e.g.
      // the drugs this entity metabolises) off this id.
      entityId: wikiPages.entityId,
      parentId: wikiPages.parentId,
      status: wikiPages.status,
      createdAt: wikiPages.createdAt,
      updatedAt: wikiPages.updatedAt,
      updatedBy: {
        username: users.username,
        displayName: users.displayName,
        // Email omitted — published wiki pages are public-readable, so
        // exposing email here would let anyone scrape contributor
        // addresses by walking page reads. Role + isAgent stay (public
        // already via /api/agents); UserBadge falls back to a plain span
        // when email is absent.
        role: users.role,
        isAgent: sql<boolean>`${agents.id} is not null`,
      },
    })
    .from(wikiPages)
    .leftJoin(users, eq(wikiPages.updatedBy, users.id))
    .leftJoin(agents, eq(agents.userId, users.id))
    .where(condition)
    .limit(1);

  if (!page) {
    error(res, 404, 'Page not found');
    return;
  }

  if (!(await canReadWikiPage(req, page.status))) {
    error(res, 404, 'Page not found');
    return;
  }

  // Walk parent chain to build breadcrumbs (root → … → parent) in a
  // single recursive CTE instead of one sequential round-trip per level.
  // Run in parallel with the children query — both are independent.
  const [ancestorsResult, childRows] = await Promise.all([
    page.parentId != null
      ? db.execute(sql`
          WITH RECURSIVE anc AS (
            SELECT id, slug, title, page_type, parent_id, 1 AS depth,
                   ARRAY[id] AS visited
            FROM wiki_pages
            WHERE id = ${page.parentId}
              AND id <> ${page.id}
            UNION ALL
            SELECT wp.id, wp.slug, wp.title, wp.page_type, wp.parent_id,
                   anc.depth + 1,
                   anc.visited || wp.id
            FROM wiki_pages wp
            JOIN anc ON wp.id = anc.parent_id
            WHERE anc.depth < ${MAX_NESTING_DEPTH}
              AND NOT (wp.id = ANY(anc.visited))
              AND wp.id <> ${page.id}
          )
          SELECT id, slug, title, page_type
          FROM anc
          ORDER BY depth DESC
        `)
      : Promise.resolve({ rows: [] as unknown[] }),
    db
      .select({
        id: wikiPages.id,
        slug: wikiPages.slug,
        title: wikiPages.title,
        pageType: wikiPages.pageType,
      })
      .from(wikiPages)
      .where(
        and(eq(wikiPages.parentId, page.id), eq(wikiPages.status, 'published')),
      )
      .orderBy(wikiPages.title),
  ]);

  const ancestors: Array<{
    id: number;
    slug: string;
    title: string;
    pageType: string;
  }> = (ancestorsResult.rows as Array<Record<string, unknown>>).map((r) => ({
    id: Number(r.id),
    slug: String(r.slug),
    title: String(r.title),
    pageType: String(r.page_type),
  }));

  // Published wiki pages are public-readable and only change when an edit is
  // approved, so let the CDN serve them. Draft/archived pages stay uncached.
  // A logged-in request (editor/admin) is served fresh so a direct admin save
  // is visible immediately instead of being masked by the shared edge cache
  // for the s-maxage/stale-while-revalidate window (#bug: admin edits not
  // reflected). Anonymous reads keep the CDN benefit.
  const isAuthed = requestHasAuthCookie(req);
  const cacheHeaders = isAuthed
    ? noStoreHeaders()
    : page.status === 'published'
      ? PUBLIC_WIKI_PAGE_CACHE_HEADERS
      : undefined;
  json(
    res,
    200,
    { page, ancestors, children: childRows },
    { headers: cacheHeaders },
  );
}

// Resolve a page by its numeric id. The public API otherwise only exposes
// pages by `slug`/`drugCid`, but server-fired agent hooks (and admin tooling)
// only carry `wiki_pages.id` — e.g. the `wiki_fact_approved` locator — so
// this lets a least-privilege client look up a page without direct DB access.
async function getById(
  req: IncomingMessage,
  res: ServerResponse,
  id: number,
): Promise<void> {
  if (!Number.isInteger(id) || id <= 0) {
    error(res, 400, 'Invalid pageId');
    return;
  }
  try {
    await fetchAndServePage(req, res, eq(wikiPages.id, id));
  } catch (err) {
    console.error('getById failed:', {
      id,
      message: err instanceof Error ? err.message : String(err),
      cause: (err as { cause?: unknown })?.cause,
      stack: err instanceof Error ? err.stack : undefined,
    });
    error(res, 500, 'Failed to fetch page');
  }
}

async function getBySlug(
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
): Promise<void> {
  try {
    await fetchAndServePage(req, res, eq(wikiPages.slug, slug));
  } catch (err) {
    console.error('getBySlug failed:', {
      slug,
      message: err instanceof Error ? err.message : String(err),
      cause: (err as { cause?: unknown })?.cause,
      stack: err instanceof Error ? err.stack : undefined,
    });
    error(res, 500, 'Failed to fetch page');
  }
}

async function getByDrugCid(
  req: IncomingMessage,
  res: ServerResponse,
  cid: number,
): Promise<void> {
  const db = getDb();
  try {
    const [page] = await db
      .select({
        id: wikiPages.id,
        slug: wikiPages.slug,
        title: wikiPages.title,
        pageType: wikiPages.pageType,
        status: wikiPages.status,
      })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.drugCid, cid),
          eq(wikiPages.pageType, 'drug_monograph'),
        ),
      )
      .limit(1);

    if (!page) {
      json(res, 200, { page: null });
      return;
    }

    if (!(await canReadWikiPage(req, page.status))) {
      json(res, 200, { page: null });
      return;
    }

    json(
      res,
      200,
      { page },
      requestHasAuthCookie(req)
        ? { headers: noStoreHeaders() }
        : page.status === 'published'
          ? { headers: PUBLIC_WIKI_PAGE_CACHE_HEADERS }
          : undefined,
    );
  } catch (err) {
    console.error('getByDrugCid failed:', {
      cid,
      message: err instanceof Error ? err.message : String(err),
      cause: (err as { cause?: unknown })?.cause,
      stack: err instanceof Error ? err.stack : undefined,
    });
    error(res, 500, 'Failed to fetch page');
  }
}

async function canReadWikiPage(
  req: IncomingMessage,
  status: string | null | undefined,
): Promise<boolean> {
  if (status === 'published') {
    return true;
  }

  return callerCanReadWikiPage(status, await getUserFromRequest(req));
}

async function listPages(res: ServerResponse, url: URL): Promise<void> {
  const pageType = url.searchParams.get('pageType');
  const excludePageType = url.searchParams.get('excludePageType');
  const view = url.searchParams.get('view');
  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
  const offset = Number(url.searchParams.get('offset')) || 0;
  const db = getDb();

  try {
    const conditions = [eq(wikiPages.status, 'published')];
    if (pageType) conditions.push(eq(wikiPages.pageType, pageType));
    if (excludePageType) {
      conditions.push(ne(wikiPages.pageType, excludePageType));
    }

    if (view === 'lookup') {
      const pages = await db
        .select({
          slug: wikiPages.slug,
          drugCid: wikiPages.drugCid,
        })
        .from(wikiPages)
        .where(and(...conditions))
        .orderBy(desc(wikiPages.updatedAt))
        .limit(limit)
        .offset(offset);

      json(
        res,
        200,
        { pages },
        {
          headers: PUBLIC_WIKI_LIST_CACHE_HEADERS,
        },
      );
      return;
    }

    if (view === 'summary') {
      const rows = await db
        .select({
          id: wikiPages.id,
          slug: wikiPages.slug,
          title: wikiPages.title,
          pageType: wikiPages.pageType,
          parentId: wikiPages.parentId,
          updatedAt: wikiPages.updatedAt,
        })
        .from(wikiPages)
        .where(and(...conditions))
        .orderBy(desc(wikiPages.updatedAt), desc(wikiPages.id))
        .limit(limit + 1)
        .offset(offset);
      const pages = rows.slice(0, limit);

      json(
        res,
        200,
        {
          pages,
          hasMore: rows.length > limit,
        },
        {
          headers: PUBLIC_WIKI_LIST_CACHE_HEADERS,
        },
      );
      return;
    }

    const [pages, [countResult]] = await Promise.all([
      db
        .select({
          id: wikiPages.id,
          slug: wikiPages.slug,
          title: wikiPages.title,
          pageType: wikiPages.pageType,
          drugCid: wikiPages.drugCid,
          updatedAt: wikiPages.updatedAt,
          updatedBy: {
            username: users.username,
            displayName: users.displayName,
            // Email omitted — published wiki pages are public-readable, so
            // exposing email here would let anyone scrape contributor
            // addresses by walking page reads. Role + isAgent stay (public
            // already via /api/agents); UserBadge falls back to a plain span
            // when email is absent.
            role: users.role,
            isAgent: sql<boolean>`${agents.id} is not null`,
          },
        })
        .from(wikiPages)
        .leftJoin(users, eq(wikiPages.updatedBy, users.id))
        .leftJoin(agents, eq(agents.userId, users.id))
        .where(and(...conditions))
        .orderBy(desc(wikiPages.updatedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(wikiPages)
        .where(and(...conditions)),
    ]);

    json(
      res,
      200,
      {
        pages,
        total: Number(countResult?.count ?? 0),
        hasMore: offset + limit < Number(countResult?.count ?? 0),
      },
      {
        headers: PUBLIC_WIKI_LIST_CACHE_HEADERS,
      },
    );
  } catch (err) {
    console.error('listPages failed:', {
      message: err instanceof Error ? err.message : String(err),
      cause: (err as { cause?: unknown })?.cause,
      stack: err instanceof Error ? err.stack : undefined,
    });
    error(res, 500, 'Failed to list pages');
  }
}

// ─── POST: create page ──────────────────────────────────────────────────────

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  if (!(await callerCan(auth.role, CAP['wiki.page.submit']))) {
    error(
      res,
      403,
      'Whole-page wiki creation is admin-only (#310); submit atomic-fact edits (editType="wiki_fact") via /api/pending-edits instead.',
      'wiki_admin_only_whole_page',
    );
    return;
  }

  const result = await parseAndValidate(req, createPageSchema);
  if ('error' in result) {
    error(res, 400, result.error);
    return;
  }

  const data = result.data;

  // ─── Cross-field validation for monograph creation ──────────────────────
  if (data.pageType === 'drug_monograph') {
    if (data.drugCid && data.newDrug) {
      error(res, 400, 'drugCid and newDrug are mutually exclusive');
      return;
    }
    if (!data.drugCid && !data.newDrug) {
      error(
        res,
        400,
        'A drug is required for a monograph — either link an existing drug or provide newDrug fields',
      );
      return;
    }
  } else {
    // Topic pages: no drug fields allowed.
    if (data.newDrug || data.drugCid || data.parameters) {
      error(res, 400, 'Drug fields are only valid for drug_monograph pages');
      return;
    }
  }

  // Creating a monograph with `newDrug` also creates the catalog drug, so it
  // needs the drug-creation capability on top of page submission — otherwise
  // delegating whole-page authoring would quietly hand out drug creation via
  // this side door.
  if (data.newDrug && !(await callerCan(auth.role, CAP['drug.create']))) {
    error(
      res,
      403,
      'Creating a new drug alongside the monograph requires the drug-creation permission; link an existing drug with drugCid instead.',
      'drug_create_forbidden',
    );
    return;
  }

  // Validate parameter bag (if present) against DRUG_PARAMETERS registry
  // BEFORE we write anything so the client gets a clean 400.
  let parameterEntries: ReturnType<typeof validateParameterBag> = [];
  if (data.parameters && Object.keys(data.parameters).length > 0) {
    try {
      parameterEntries = validateParameterBag(data.parameters);
    } catch (err) {
      error(
        res,
        400,
        err instanceof Error ? err.message : 'Invalid parameters',
      );
      return;
    }
    if (parameterEntries.length > 0 && !data.parametersReferenceId) {
      error(
        res,
        400,
        'parametersReferenceId is required when providing PK values',
      );
      return;
    }
  }

  // The parameters bag becomes drug-parameter revisions on both the direct
  // and the queued path (applyInitialParameters), so carrying one needs the
  // parameter-submit capability too — page authoring alone must not be a way
  // around what /api/drug-parameter would refuse.
  if (
    parameterEntries.length > 0 &&
    !(await callerCan(auth.role, CAP['edit.parameter.submit']))
  ) {
    error(
      res,
      403,
      'Submitting parameter values alongside the monograph requires the parameter-edit permission.',
      'parameter_submit_forbidden',
    );
    return;
  }

  // ─── Admin agent-focus gate on agent-authored wiki content ──────────────
  // Same gate `POST /api/pending-edits` applies to agent wiki edits, on the
  // other door into the same content. `wiki.page.submit` and
  // `edit.directWrite` both carry `floorTier: 'editor'`, so an admin may
  // delegate whole-page authoring to the editor tier — and an editor-role
  // agent identity would then create monographs here while the focus config
  // says agents write no wiki content. Humans are deliberately unaffected:
  // narrowing the agents is not narrowing the people.
  //
  // A `newDrug` monograph names no existing drug, so it is judged as a page
  // with no drug: in scope only under `mode = "all"` with the switch off. A
  // substance the catalog does not yet hold cannot be a component of a
  // selected method or a page an admin listed.
  //
  // Deliberately after the capability checks above and before the first step
  // that reads the database: those refusals are decided from the caller's
  // permissions alone, and a request that lacks the permission for what it is
  // asking should not cost a query to find out.
  if (await isActiveAgentUser(auth.userId)) {
    const focusDrugId =
      data.pageType === 'drug_monograph' && typeof data.drugCid === 'number'
        ? await resolveOwningDrugIdForMonograph(getDb(), data.drugCid)
        : null;
    const refusal = await wikiTargetFocusRefusal({
      pageId: null,
      pageType: data.pageType,
      drugId: focusDrugId ?? null,
    });
    if (refusal) {
      error(res, 403, refusal, 'agent_focus_out_of_scope');
      return;
    }
  }

  // Preflight the parameter bag against the applicability rules, before either
  // branch below writes anything.
  //
  // This is the *reporting* check, not the enforcing one: it costs a single
  // query and lets both branches fail with a 409 that names every offending
  // parameter, which the author needs in order to fix the submission. On the
  // queued branch it is the only check that runs at submission time, so
  // without it a `wiki_new` proposal carrying a blocked parameter would wait
  // in the review queue for an approval that could only ever be rejected.
  //
  // Enforcement lives with the writes: the admin branch below runs page,
  // revision, categories and parameters as one transaction holding the
  // per-drug applicability lock, so a marker created after this check cannot
  // slip in mid-sequence. This check alone would leave that window open.
  //
  // Only for an existing drug: `newDrug` is created fresh below with the
  // default class and no markers, so it has nothing to conflict with.
  if (parameterEntries.length > 0 && data.drugCid && !data.newDrug) {
    const blocked = await blockedParametersFor(
      getDb(),
      data.drugCid,
      parameterEntries.map((p) => p.id),
    );
    if (blocked.length) {
      json(res, 409, {
        error:
          'Some parameters are not defined quantities for this substance — either marked not applicable, or ruled out by its substance class.',
        code: 'parameter_not_applicable',
        parameters: blocked,
      });
      return;
    }
  }

  // ─── Non-admin / submit-for-review path: store everything in pendingEdits ─
  if (
    !(await callerCan(auth.role, CAP['edit.directWrite'])) ||
    data.submitForReview
  ) {
    const db = getDb();
    try {
      const [row] = await db
        .insert(pendingEdits)
        .values({
          editType: 'wiki_new',
          proposedValue: data.content as never,
          proposedMeta: {
            title: data.title,
            pageType: data.pageType,
            drugCid: data.drugCid,
            editSummary: data.editSummary,
            newDrug: data.newDrug,
            parameters: data.parameters,
            parametersReferenceId: data.parametersReferenceId,
          } as never,
          referenceId: data.parametersReferenceId,
          status: 'pending',
          submittedBy: auth.userId,
        })
        .returning();

      if (!row) {
        error(res, 500, 'Failed to submit page for review');
        return;
      }

      await recordImplicitAgentApproval({
        userId: auth.userId,
        targetType: 'pending_edit',
        targetId: row.id,
      });

      json(res, 201, { pending: true, pendingEditId: row.id });
    } catch (err) {
      // Log full error (drizzle hides the real PG reason on err.cause).
      const cause = (err as { cause?: unknown })?.cause;
      console.error('Failed to create wiki_new pending edit:', {
        message: err instanceof Error ? err.message : String(err),
        cause,
      });
      error(res, 500, 'Failed to submit page for review');
    }
    return;
  }

  // ─── Admin publish path ────────────────────────────────────────────────
  const {
    title,
    content,
    pageType,
    editSummary,
    categoryIds,
    status,
    parentId,
  } = data;
  const slug = generateSlug(title);
  // Mint topic-page section anchors server-side so headings are always
  // targetable by wiki_fact, regardless of whether the client minted them.
  const pageContent = ensureTopicSectionIds(pageType, content);
  const contentHtml = renderHtml(pageContent);
  const contentPlaintext = extractPlaintext(pageContent);
  const db = getDb();

  if (parentId != null) {
    const check = await validateParentAssignment(db, null, parentId);
    if (!check.ok) {
      error(res, check.status, check.message);
      return;
    }
  }

  // If a new drug is requested, create it first so we can link the monograph
  // to its row. neon-http has no interactive transactions, so we sequence
  // writes the same way the approval worker does.
  let finalDrugId: number | undefined = data.drugCid;
  if (data.newDrug) {
    try {
      // Pass the admin's user id so insertDrug can attribute the
      // initial molecularWeight (if any) on `drug_parameters.updated_by`.
      const drugRow = await insertDrug({
        ...data.newDrug,
        createdBy: auth.userId,
      });
      finalDrugId = drugRow.id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        error(res, 409, 'A drug with this slug or PubChem CID already exists');
        return;
      }
      console.error('insertDrug (admin monograph path) failed:', {
        newDrug: data.newDrug,
        message: err instanceof Error ? err.message : String(err),
        cause: (err as { cause?: unknown })?.cause,
        stack: err instanceof Error ? err.stack : undefined,
      });
      error(res, 500, 'Failed to create drug');
      return;
    }
  }

  try {
    // Page, revision, categories and initial parameters as one unit, holding
    // the per-drug applicability lock for the whole of it.
    //
    // The preflight above narrows the window but cannot close it: a marker
    // created between that check and `applyInitialParameters` would have the
    // parameter write throw *after* the page was committed, returning 500 and
    // leaving a retry to collide with its own slug. Holding the lock across
    // the unit means the guard state cannot change underneath it, and running
    // in a transaction means a failure anywhere rolls the page back instead of
    // stranding it — which was true of any mid-sequence failure here, not just
    // this one.
    type CreateOutcome =
      | { kind: 'ok'; page: { id: number; slug: string; title: string } }
      | { kind: 'drug_gone' };
    const outcome = await withPageWriteLock(
      finalDrugId,
      async (): Promise<CreateOutcome> => {
        const tx = getDb();

        // Re-verify the drug still exists now that the lock is held. The
        // preflight/insertDrug above ran before (or without) this lock, so a
        // merge or delete that committed while this request waited for the
        // lock could have removed the row out from under us — without this
        // check we would publish a drug_monograph linked to a drug that no
        // longer exists. Same shape as the "drug not found" 404 the other
        // drug-scoped write paths return.
        if (finalDrugId !== undefined) {
          const [drugRow] = await tx
            .select({ id: drugs.id })
            .from(drugs)
            .where(eq(drugs.id, finalDrugId))
            .limit(1);
          if (!drugRow) return { kind: 'drug_gone' };
        }

        const [page] = await tx
          .insert(wikiPages)
          .values({
            slug,
            title,
            content: pageContent as never,
            contentHtml,
            contentPlaintext,
            pageType,
            drugCid: finalDrugId ?? null,
            parentId: parentId ?? null,
            status: status ?? 'published',
            createdBy: auth.userId,
            updatedBy: auth.userId,
          })
          .returning();

        if (!page) throw new Error('wikiPages insert returned no row');

        const [newRev] = await tx
          .insert(wikiRevisions)
          .values({
            pageId: page.id,
            content: pageContent as never,
            contentHtml,
            editSummary: editSummary ?? 'Initial creation',
            createdBy: auth.userId,
          })
          .returning({ id: wikiRevisions.id });

        // Direct admin publish skips pending_edits, so the implicit-approve row
        // for the resulting wiki_revision has to be written here. No-op when
        // the submitter is a human (resolveActiveAgent returns null).
        if (newRev) {
          await recordImplicitAgentApproval({
            userId: auth.userId,
            targetType: 'wiki_revision',
            targetId: newRev.id,
          });
        }

        if (categoryIds && categoryIds.length > 0) {
          await tx
            .insert(wikiPageCategories)
            .values(
              categoryIds.map((categoryId) => ({ pageId: page.id, categoryId })),
            );
        }

        if (
          parameterEntries.length > 0 &&
          finalDrugId &&
          data.parametersReferenceId
        ) {
          const { revisionIds } = await applyInitialParameters({
            drugId: finalDrugId,
            entries: parameterEntries,
            referenceId: data.parametersReferenceId,
            userId: auth.userId,
            editSummary: editSummary ?? undefined,
          });
          // Same rationale as the wiki_revision stamp above: when an active
          // agent has been elevated to admin and publishes a monograph with
          // initial PK values, the resulting parameter revisions must also
          // carry the submitter's implicit-approve so peer verifiers see one
          // approval on each new revision row. recordImplicitAgentApprovals
          // is a no-op for human submitters. Using the batch variant
          // collapses N sequential round-trips into a single bulk upsert.
          await recordImplicitAgentApprovals({
            userId: auth.userId,
            targetType: 'drug_parameter_revision',
            targetIds: revisionIds,
          });
        }

        return {
          kind: 'ok',
          page: { id: page.id, slug: page.slug, title: page.title },
        };
      },
    );

    if (outcome.kind === 'drug_gone') {
      error(res, 404, 'Drug not found');
      return;
    }

    json(res, 201, { page: outcome.page });
  } catch (err: unknown) {
    if (err instanceof ParameterNotApplicableError) {
      // The marker or reclassification landed after the preflight. Nothing was
      // committed, so this is an ordinary 409 the author can act on rather
      // than a 500 over a half-created page.
      json(res, 409, {
        error: err.message,
        code: err.code,
      });
      return;
    }
    if (isUniqueViolation(err)) {
      error(res, 409, 'A page with this title/slug already exists');
      return;
    }
    console.error('handleCreate (admin publish path) failed:', {
      slug,
      pageType,
      drugCid: finalDrugId,
      message: err instanceof Error ? err.message : String(err),
      cause: (err as { cause?: unknown })?.cause,
      stack: err instanceof Error ? err.stack : undefined,
    });
    error(res, 500, 'Failed to create page');
  }
}

// ─── PUT: update page ───────────────────────────────────────────────────────

async function handleUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  if (!(await callerCan(auth.role, CAP['wiki.page.submit']))) {
    error(
      res,
      403,
      'Whole-page wiki edits are admin-only (#310); submit atomic-fact edits (editType="wiki_fact") via /api/pending-edits instead.',
      'wiki_admin_only_whole_page',
    );
    return;
  }

  const slug = url.searchParams.get('slug');
  if (!slug) {
    error(res, 400, 'Missing slug parameter');
    return;
  }

  const result = await parseAndValidate(req, updatePageSchema);
  if ('error' in result) {
    error(res, 400, result.error);
    return;
  }

  // ─── Admin agent-focus gate on agent-authored wiki content ──────────────
  // The same gate as page creation above and as `POST /api/pending-edits`,
  // and it has to sit ahead of BOTH branches below: the direct-write branch
  // publishes immediately, and the queued branch files a proposal that the
  // pending-edit gate would then have to refuse at approval time instead. A
  // page whose slug does not resolve falls through to the 404 the branches
  // already produce — refusing it here would answer a missing page with a
  // focus message.
  //
  // BOTH pictures of the page are judged, because this request can change the
  // two fields the focus reads. The before-picture asks "may an agent edit
  // this page at all"; the after-picture asks "may it leave the page like
  // that". Without the second, an in-scope component's monograph is a licence
  // to publish out-of-scope content: set `pageType: "topic"`, or repoint
  // `drugCid` at a drug no selected method names, and the branches below apply
  // it with nothing further to check.
  if (await isActiveAgentUser(auth.userId)) {
    const [target] = await getDb()
      .select({
        id: wikiPages.id,
        pageType: wikiPages.pageType,
        drugCid: wikiPages.drugCid,
      })
      .from(wikiPages)
      .where(eq(wikiPages.slug, slug))
      .limit(1);
    if (target) {
      const refusal = await wikiContentFocusRefusal(target.id);
      if (refusal) {
        error(res, 403, refusal, 'agent_focus_out_of_scope');
        return;
      }
      const nextPageType = result.data.pageType ?? target.pageType;
      const nextDrugCid =
        result.data.drugCid === undefined ? target.drugCid : result.data.drugCid;
      // Only when the write actually moves one of them: an ordinary content
      // edit leaves the identity alone and is already answered above.
      if (nextPageType !== target.pageType || nextDrugCid !== target.drugCid) {
        const nextDrugId =
          nextPageType === 'drug_monograph' && typeof nextDrugCid === 'number'
            ? await resolveOwningDrugIdForMonograph(getDb(), nextDrugCid)
            : null;
        const afterRefusal = await wikiTargetFocusRefusal({
          pageId: target.id,
          pageType: nextPageType,
          drugId: nextDrugId ?? null,
        });
        if (afterRefusal) {
          error(res, 403, afterRefusal, 'agent_focus_out_of_scope');
          return;
        }
      }
    }
  }

  // Non-admin users, or admins explicitly choosing review, create a pending edit.
  if (
    !(await callerCan(auth.role, CAP['edit.directWrite'])) ||
    result.data.submitForReview
  ) {
    const db = getDb();
    // Fetch id, status, content, and drug scope in one query. `drug_cid`
    // (when the page is a drug monograph) tells us which drug's merge
    // advisory lock to take before writing the pending edit — closes the
    // drug-merge race so a submission cannot land against a page that is
    // about to be deleted (or that just was).
    const [page] = await db
      .select({
        id: wikiPages.id,
        status: wikiPages.status,
        content: wikiPages.content,
        pageType: wikiPages.pageType,
        drugCid: wikiPages.drugCid,
      })
      .from(wikiPages)
      .where(eq(wikiPages.slug, slug))
      .limit(1);

    if (!page) {
      error(res, 404, 'Page not found');
      return;
    }

    // Submitting a whole-page edit is a separate capability from reading an
    // unpublished page, so a caller may hold the first without the second.
    // The content fallback below would copy the draft into a pending edit the
    // submitter can then read back — a way to see content GET /api/wiki/pages
    // would refuse them. Answer exactly as the read path does: don't disclose
    // that the draft exists.
    if (!(await callerCanReadWikiPage(page.status, { role: auth.role }))) {
      error(res, 404, 'Page not found');
      return;
    }

    const proposedContent = result.data.content ?? page.content;

    // For a drug monograph, take the same per-drug advisory lock the merge
    // admin does, then re-verify the page still exists inside the lock. A
    // concurrent drug-merge would otherwise be able to delete the loser's
    // monograph page between our SELECT and INSERT above, landing a
    // proposal on a deleted page (later impossible to approve, and the
    // merge itself may sweep the fresh proposal along with the page). Non-
    // drug-monograph pages don't participate in that race.
    //
    // `page.drug_cid` may be a legacy PubChem CID rather than the drug's
    // internal id; the merge locks by `drugs.id`, so we must resolve the
    // raw drug_cid to its owning `drugs.id` before locking or the two paths
    // would not serialize. And the resolver returning null means the drug
    // is gone (a merge deleted it between the initial page lookup and
    // here) — refuse rather than treat as if this were a non-drug page,
    // which would skip both the lock and the recheck below.
    let lockDrugId: number | null = null;
    if (page.pageType === 'drug_monograph' && page.drugCid != null) {
      lockDrugId = await resolveOwningDrugIdForMonograph(db, page.drugCid);
      if (lockDrugId == null) {
        error(res, 404, 'Page not found');
        return;
      }
    }
    type SubmitOutcome =
      | { kind: 'ok'; row: typeof pendingEdits.$inferSelect }
      | { kind: 'gone' };
    const outcome = await runInPoolTransaction<SubmitOutcome>(async () => {
      if (lockDrugId != null) {
        await lockDrugForEntryApplicability(lockDrugId);
        const [pageInTx] = await getDb()
          .select({ id: wikiPages.id })
          .from(wikiPages)
          .where(eq(wikiPages.id, page.id))
          .limit(1);
        if (!pageInTx) return { kind: 'gone' };
      }
      const [row] = await getDb()
        .insert(pendingEdits)
        .values({
          editType: 'wiki_page',
          targetId: page.id,
          proposedValue: (proposedContent ?? {}) as never,
          proposedMeta: {
            title: result.data.title,
            slug,
            editSummary: result.data.editSummary,
          } as never,
          status: 'pending',
          submittedBy: auth.userId,
        })
        .returning();
      if (!row) throw new Error('Failed to submit page for review');
      return { kind: 'ok', row };
    });
    if (outcome.kind === 'gone') {
      error(res, 404, 'Page not found');
      return;
    }

    await recordImplicitAgentApproval({
      userId: auth.userId,
      targetType: 'pending_edit',
      targetId: outcome.row.id,
    });

    json(res, 201, { pending: true, pendingEditId: outcome.row.id });
    return;
  }

  const db = getDb();
  const { title, content, editSummary, pageType, drugCid, status, parentId, expectedUpdatedAt } =
    result.data;

  try {
    // Fetch drugCid and pageType upfront so the drug_monograph guard below
    // can use them without a second round trip. `updatedAt` here is the
    // optimistic-concurrency snapshot used to reject a stale save that
    // waited for a merge's FOR UPDATE on this page (the editor's payload
    // was authored against a pre-merge revision; committing it would
    // restore the loser URL the merge just rewrote).
    const [existing] = await db
      .select({
        id: wikiPages.id,
        status: wikiPages.status,
        drugCid: wikiPages.drugCid,
        pageType: wikiPages.pageType,
        updatedAt: wikiPages.updatedAt,
      })
      .from(wikiPages)
      .where(eq(wikiPages.slug, slug))
      .limit(1);

    if (!existing) {
      error(res, 404, 'Page not found');
      return;
    }

    // The queued branch above checks this; the direct branch needs it too, or
    // a caller holding wiki.page.submit + edit.directWrite but not
    // wiki.draft.read could rewrite — or publish — a draft they cannot GET.
    if (!(await callerCanReadWikiPage(existing.status, { role: auth.role }))) {
      error(res, 404, 'Page not found');
      return;
    }

    // Prevent converting a page to drug_monograph without a drug link.
    // If pageType is being changed to drug_monograph, drugCid must be provided.
    // Also reject explicit drugCid: null which would unlink the drug.
    if (
      pageType === 'drug_monograph' &&
      (drugCid === undefined || drugCid === null)
    ) {
      if (!existing.drugCid && existing.pageType !== 'drug_monograph') {
        error(
          res,
          400,
          'A drug link (drugCid) is required when converting a page to a drug monograph',
        );
        return;
      }
      // Reject explicitly nulling drugCid on an existing monograph
      if (drugCid === null && existing.pageType === 'drug_monograph') {
        error(res, 400, 'Cannot remove the drug link from a drug monograph');
        return;
      }
    }

    if (parentId !== undefined) {
      const check = await validateParentAssignment(
        db,
        existing.id,
        parentId ?? null,
      );
      if (!check.ok) {
        error(res, check.status, check.message);
        return;
      }
    }

    const updates: Record<string, unknown> = {
      updatedBy: auth.userId,
      updatedAt: new Date(),
    };
    if (title !== undefined) updates.title = title;
    if (pageType !== undefined) updates.pageType = pageType;
    if (drugCid !== undefined) updates.drugCid = drugCid;
    if (parentId !== undefined) updates.parentId = parentId;
    if (status !== undefined) updates.status = status;
    // Mint topic-page section anchors server-side (see ensureTopicSectionIds)
    // using the effective page type — either the incoming change or, when
    // pageType isn't being updated, the page's current type.
    const effectivePageType = pageType ?? existing.pageType;
    const nextContent =
      content !== undefined
        ? ensureTopicSectionIds(effectivePageType, content)
        : undefined;
    if (nextContent !== undefined) {
      updates.content = nextContent;
      updates.contentHtml = renderHtml(nextContent);
      updates.contentPlaintext = extractPlaintext(nextContent);
    }

    // Predicate the UPDATE on `updatedAt` — if the row moved between our
    // caller's snapshot and this write, `returning` is empty and we
    // respond 409 wiki_page_changed instead of restoring stale content.
    //
    // Prefer the CLIENT-supplied `expectedUpdatedAt` when provided: the
    // server SELECT a few lines above always returns the CURRENT row, so
    // a merge that already committed BEFORE this request arrived is
    // invisible to a server-only snapshot — the predicate would compare
    // the post-merge timestamp against itself and accept the pre-merge
    // payload. The client-supplied snapshot is the editor's load-time
    // value; comparing against it catches the pre-request merge too.
    // Fall back to the server snapshot when the client didn't send one
    // (still closes the request-arrived-before-merge case).
    //
    // `wiki_pages.updated_at` is a plain `timestamp` column which Postgres
    // stores with microsecond precision, but JS `Date` (what Drizzle hands
    // us on the snapshot) carries only milliseconds — so a naive
    // `eq(updatedAt, snapshot)` predicate almost never matches on a row
    // that was created via `defaultNow()` and would 409 every ordinary
    // save. Compare with `date_trunc('milliseconds', ...)` on both sides
    // so ms-precision matches ms-precision while still catching a real
    // drift (a merge or competing writer stamps a new `Date()`, which
    // lands in a different ms slot).
    const versionSnapshot: Date = expectedUpdatedAt
      ? new Date(expectedUpdatedAt)
      : existing.updatedAt;
    //
    // Run the UPDATE and the wiki_revisions insert in one transaction so
    // the revision can never carry pre-merge content while the page
    // carries post-merge content (the revision insert would otherwise wait
    // for the merge's page FK lock and commit its pre-merge payload after
    // the merge finished).
    //
    // A drugCid that is being assigned or changed also takes the per-drug
    // applicability lock on the NEW drug — same lock the creation path takes
    // — before writing. Without it, a page could be linked to a drug that a
    // concurrent merge/delete removes moments later, or that is already gone
    // by the time this request's lock wait ends. `existing.drugCid` is the
    // pre-update value, so a resubmit that leaves it unchanged (including a
    // plain content edit on an already-linked monograph) skips the lock —
    // it isn't creating a new drug/page link for a merge to race against.
    type SaveOutcome =
      | {
          kind: 'ok';
          page: typeof wikiPages.$inferSelect;
          revisionId: number | null;
        }
      | { kind: 'stale' }
      | { kind: 'drug_gone' };
    const lockDrugCid =
      drugCid !== undefined && drugCid !== null && drugCid !== existing.drugCid
        ? drugCid
        : null;
    const outcome = await runInPoolTransaction<SaveOutcome>(async () => {
      if (lockDrugCid != null) {
        await lockDrugForEntryApplicability(lockDrugCid);
        // Re-verify the target drug still exists now that the lock is held —
        // matches the creation path's post-lock recheck.
        const [drugRow] = await getDb()
          .select({ id: drugs.id })
          .from(drugs)
          .where(eq(drugs.id, lockDrugCid))
          .limit(1);
        if (!drugRow) return { kind: 'drug_gone' };
      }
      const txDb = getDb();
      const [updated] = await txDb
        .update(wikiPages)
        .set(updates)
        .where(
          and(
            eq(wikiPages.slug, slug),
            sql`date_trunc('milliseconds', ${wikiPages.updatedAt}) = date_trunc('milliseconds', ${versionSnapshot}::timestamp)`,
          ),
        )
        .returning();
      if (!updated) return { kind: 'stale' };
      let revisionId: number | null = null;
      if (nextContent !== undefined) {
        const [rev] = await txDb
          .insert(wikiRevisions)
          .values({
            pageId: existing.id,
            content: nextContent as never,
            contentHtml: updates.contentHtml as string,
            editSummary: editSummary ?? null,
            createdBy: auth.userId,
          })
          .returning({ id: wikiRevisions.id });
        revisionId = rev?.id ?? null;
      }
      return { kind: 'ok', page: updated, revisionId };
    });
    if (outcome.kind === 'stale') {
      error(
        res,
        409,
        'The page was changed while this request was in flight (a concurrent merge or edit). Reload and re-submit.',
        'wiki_page_changed',
      );
      return;
    }
    if (outcome.kind === 'drug_gone') {
      error(res, 404, 'Drug not found');
      return;
    }

    if (outcome.revisionId != null) {
      // Same rationale as the admin publish path above — stamp the
      // implicit-approve so agent-authored direct edits show one approval.
      await recordImplicitAgentApproval({
        userId: auth.userId,
        targetType: 'wiki_revision',
        targetId: outcome.revisionId,
      });
    }

    const updated = outcome.page;
    json(res, 200, {
      page: { id: updated.id, slug: updated.slug, title: updated.title },
    });
  } catch (err) {
    console.error('handleUpdate failed:', {
      slug,
      message: err instanceof Error ? err.message : String(err),
      cause: (err as { cause?: unknown })?.cause,
      stack: err instanceof Error ? err.stack : undefined,
    });
    error(res, 500, 'Failed to update page');
  }
}

// ─── DELETE: delete page ────────────────────────────────────────────────────

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth || !(await callerCan(auth.role, CAP['wiki.page.delete']))) {
    error(res, 403, 'Admin role required');
    return;
  }

  const slug = url.searchParams.get('slug');
  if (!slug) {
    error(res, 400, 'Missing slug parameter');
    return;
  }

  const db = getDb();

  try {
    // Deleting by slug alone would let someone who knows a draft's slug
    // remove content the read and update paths answer 404 for. Resolve the
    // page first and apply the same visibility rule.
    const [page] = await db
      .select({ id: wikiPages.id, status: wikiPages.status })
      .from(wikiPages)
      .where(eq(wikiPages.slug, slug))
      .limit(1);

    if (
      !page ||
      !(await callerCanReadWikiPage(page.status, { role: auth.role }))
    ) {
      error(res, 404, 'Page not found');
      return;
    }

    // ─── Admin agent-focus gate on agent-authored wiki content ────────────
    // `wiki.page.delete` carries `floorTier: 'editor'` like the rest, so the
    // same delegation that lets an agent write whole pages lets it remove
    // them. Removing a monograph is a wiki-content write with no undo, so a
    // focus that closes agent wiki authoring has to close this too — the gate
    // would otherwise leave an agent unable to add a sentence to a page but
    // free to delete the page.
    //
    // After the visibility rule above on purpose: a page the caller may not
    // see answers 404 exactly as it does on every other verb, rather than
    // having its existence disclosed by a focus message.
    if (await isActiveAgentUser(auth.userId)) {
      const refusal = await wikiContentFocusRefusal(page.id);
      if (refusal) {
        error(res, 403, refusal, 'agent_focus_out_of_scope');
        return;
      }
    }

    const [deleted] = await db
      .delete(wikiPages)
      .where(eq(wikiPages.id, page.id))
      .returning({ id: wikiPages.id });

    if (!deleted) {
      error(res, 404, 'Page not found');
      return;
    }

    json(res, 200, { message: 'Page deleted' });
  } catch (err) {
    console.error('handleDelete failed:', {
      message: err instanceof Error ? err.message : String(err),
      cause: (err as { cause?: unknown })?.cause,
      stack: err instanceof Error ? err.stack : undefined,
    });
    error(res, 500, 'Failed to delete page');
  }
}
