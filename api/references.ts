import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq, and, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  json,
  error,
  withErrorHandling,
  publicCacheHeaders,
} from './_lib/response.js';

const DRUG_REFS_CACHE_HEADERS = publicCacheHeaders({
  sMaxAge: 60,
  staleWhileRevalidate: 300,
});
import { getDb } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import {
  createReferenceSchema,
  updateReferenceSchema,
} from './_lib/schemas.js';
import {
  normalizeReferenceMetadata,
  type ReferenceMetadata,
} from './_lib/reference-metadata.js';
import {
  collectParameterCitationUsageForDrug,
  collectReferenceUsage,
  collectUsedCitationIdsForDrug,
  filterUsedCitationIds,
} from './_lib/citation-usage.js';
import { findCitationsNeedingFullReview } from './_lib/reference-review-status.js';
import {
  findCitationIdsMatchingQuery,
  parseReferenceQuery,
  searchCitationRows,
} from './_lib/reference-search.js';
import {
  buildReferenceIndexPage,
  parseGroupBy,
  parseLang,
  parsePage,
  parsePageSize,
  type IndexCitation,
  type ReferenceOwner,
} from './_lib/reference-index.js';
import { formatGenericDrugName, resolveDrugName } from '../src/lib/drugNames.js';
import { fetchPubMedMetadata } from './_lib/pubmed.js';
import { resolveCitation } from './_lib/citation-store.js';
import { resolveOneCrosswalk } from './_lib/citation-crosswalk.js';
import { fetchCrossRefMetadata } from './_lib/crossref.js';
import { mergeAltIds } from '../src/lib/citationHandles.js';
import {
  citations as references,
  drugs,
  drugIonizationConstants,
  drugParameterRevisions,
  referenceConcentrations,
} from '../db/schema.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import { consumeRateLimit, getClientAddressKey } from './_lib/rate-limit.js';

const MAX_BATCH_REFERENCE_IDS = 200;
const REFERENCE_RESOLVER_LIMIT = 30;
const REFERENCE_RESOLVER_WINDOW_MS = 60_000;

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );

    switch (req.method) {
      case 'GET':
        return handleGet(res, url);
      case 'POST':
        assertSameOrigin(req);
        return handleCreate(req, res);
      case 'PATCH':
        assertSameOrigin(req);
        return handleUpdate(req, res, url);
      default:
        error(res, 405, 'Method not allowed');
    }
  },
);

function parseReferenceIds(raw: string | null): number[] {
  if (!raw) return [];
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const part of raw.split(',')) {
    const id = Number(part.trim());
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_BATCH_REFERENCE_IDS) break;
  }
  return ids;
}

async function handleGet(res: ServerResponse, url: URL): Promise<void> {
  const db = getDb();

  if (url.searchParams.get('view') === 'index') {
    return handleIndex(res, url);
  }

  if (url.searchParams.get('view') === 'search') {
    return handleSearch(res, url);
  }

  if (url.searchParams.get('view') === 'usage') {
    return handleUsage(res, url);
  }

  const id = Number(url.searchParams.get('id'));
  if (id) {
    const visibleIds = await filterUsedCitationIds(db, [id]);
    if (!visibleIds.has(id)) {
      error(res, 404, 'Reference not found');
      return;
    }
    const [row] = await db
      .select()
      .from(references)
      .where(eq(references.id, id))
      .limit(1);
    if (!row) {
      error(res, 404, 'Reference not found');
      return;
    }
    const needsReview = await findCitationsNeedingFullReview([row.id]);
    json(res, 200, {
      reference: {
        ...row,
        metadata: normalizeReferenceMetadata(row.metadata),
        needsFullReview: needsReview.has(row.id),
      },
    });
    return;
  }

  const ids = parseReferenceIds(url.searchParams.get('ids'));
  if (ids.length > 0) {
    const visibleIds = await filterUsedCitationIds(db, ids);
    const visibleRequestedIds = ids.filter((id) => visibleIds.has(id));
    if (visibleRequestedIds.length === 0) {
      json(res, 200, { references: [] });
      return;
    }
    const rows = await db
      .select()
      .from(references)
      .where(inArray(references.id, visibleRequestedIds))
      .orderBy(references.id);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const needsReview =
      await findCitationsNeedingFullReview(visibleRequestedIds);

    json(res, 200, {
      references: visibleRequestedIds.flatMap((id) => {
        const row = byId.get(id);
        return row
          ? [
              {
                ...row,
                metadata: normalizeReferenceMetadata(row.metadata),
                needsFullReview: needsReview.has(row.id),
              },
            ]
          : [];
      }),
    });
    return;
  }

  const drugId = Number(url.searchParams.get('drugId'));
  if (!drugId) {
    error(res, 400, 'Missing drugId, id, or ids parameter');
    return;
  }
  const includeUsage = url.searchParams.get('includeUsage') === '1';

  // Hide orphaned citations that were created during an "add fact" flow
  // and never linked to any persistent content (#304). A citation is
  // visible only when it appears in approved monograph content, a
  // parameter revision, a reference-concentration row, or a still-pending
  // edit awaiting review.
  const used = await collectUsedCitationIdsForDrug(db, drugId);
  if (used.size === 0) {
    json(res, 200, { references: [] }, { headers: DRUG_REFS_CACHE_HEADERS });
    return;
  }

  // Fetch only the citations whose IDs are in `used`. The `used` set was
  // already filtered to exclude orphans, so there is no need for a broader
  // `drugId = X OR id IN (used)` query that would over-fetch orphaned rows
  // only to discard them immediately after.
  // Both fetches depend on nothing more than `used` and `drugId` respectively —
  // run them in parallel to save one Neon HTTP round-trip when includeUsage=true.
  const [rows, parameterUsage, needsReview] = await Promise.all([
    db
      .select()
      .from(references)
      .where(inArray(references.id, [...used]))
      .orderBy(references.createdAt),
    includeUsage
      ? collectParameterCitationUsageForDrug(db, drugId)
      : Promise.resolve(null),
    findCitationsNeedingFullReview([...used]),
  ]);

  json(
    res,
    200,
    {
      references: rows.map((row) => ({
        ...row,
        metadata: normalizeReferenceMetadata(row.metadata),
        needsFullReview: needsReview.has(row.id),
        ...(parameterUsage
          ? {
              usage: {
                parameters: [...(parameterUsage.get(row.id) ?? [])].sort(),
              },
            }
          : {}),
      })),
    },
    { headers: DRUG_REFS_CACHE_HEADERS },
  );
}

const REFERENCE_INDEX_CACHE_HEADERS = publicCacheHeaders({
  sMaxAge: 300,
  staleWhileRevalidate: 900,
});

/**
 * Cross-links for one reference: every drug monograph and wiki page that cites
 * it. The inverse of the drug-scoped bibliography, surfaced on the reference
 * module page. Only returns locations when the citation is actually visible
 * (anchored) to avoid leaking abandoned draft citations.
 */
async function handleUsage(res: ServerResponse, url: URL): Promise<void> {
  const db = getDb();
  const id = Number(url.searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    error(res, 400, 'A positive id query parameter is required');
    return;
  }

  const visibleIds = await filterUsedCitationIds(db, [id]);
  if (!visibleIds.has(id)) {
    json(res, 200, { usage: [] }, { headers: DRUG_REFS_CACHE_HEADERS });
    return;
  }

  const usage = await collectReferenceUsage(db, id);
  json(res, 200, { usage }, { headers: DRUG_REFS_CACHE_HEADERS });
}

const REFERENCE_SEARCH_CACHE_HEADERS = publicCacheHeaders({
  sMaxAge: 60,
  staleWhileRevalidate: 300,
});

const MAX_REFERENCE_SEARCH_LIMIT = 25;
// Ceiling on how deep the visibility escalation will scan for one query.
const MAX_REFERENCE_SEARCH_SCAN = 500;

/**
 * Free-text reference lookup for the command palette (#references-search).
 *
 * Users paste what they have — a DOI, a PubMed ID, a phrase they remember from
 * the agent's review of the paper — so the query runs against identifiers,
 * every metadata field, and the review body (see `_lib/reference-search.ts`).
 * Results are filtered to citations that are actually anchored somewhere, so
 * abandoned "add fact" drafts stay out of search just as they stay out of the
 * bibliography.
 */
async function handleSearch(res: ServerResponse, url: URL): Promise<void> {
  const db = getDb();
  const parsed = parseReferenceQuery(url.searchParams.get('q') ?? '');
  if (parsed.terms.length === 0) {
    error(res, 400, 'Missing search query');
    return;
  }

  const requestedLimit = Number(url.searchParams.get('limit'));
  // Clamp AFTER truncating: `limit=0.5` clears the `> 0` guard and truncates
  // to 0, which would ask for `LIMIT 0` and return an empty result set for an
  // otherwise valid search.
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(
          Math.max(1, Math.trunc(requestedLimit)),
          MAX_REFERENCE_SEARCH_LIMIT,
        )
      : 8;

  // Visibility can only be proven in a second query, so the ranked hits are
  // fetched in widening batches until `limit` of them survive the filter.
  // A fixed over-fetch would silently lose a real source sitting behind a run
  // of orphaned drafts; escalating instead means the only way to come up short
  // is to have exhausted the matches (a batch shorter than requested) or to
  // have scanned the ceiling — both honest stopping conditions.
  const visible: typeof candidates = [];
  let candidates: Awaited<ReturnType<typeof searchCitationRows>> = [];
  for (const batchSize of searchBatchSizes(limit)) {
    candidates = await searchCitationRows(db, parsed, batchSize);
    if (candidates.length === 0) break;

    const visibleIds = await filterUsedCitationIds(
      db,
      candidates.map((row) => row.id),
    );
    visible.length = 0;
    for (const row of candidates) {
      if (visibleIds.has(row.id)) visible.push(row);
      if (visible.length >= limit) break;
    }
    // Enough survivors, or the match set is exhausted — either way, stop.
    if (visible.length >= limit || candidates.length < batchSize) break;
  }

  json(
    res,
    200,
    {
      references: visible.map((row) => ({
        id: row.id,
        drugId: row.drug_id,
        type: row.type,
        identifier: row.identifier,
        metadata: normalizeReferenceMetadata(row.metadata),
        createdAt: row.created_at,
        matchRank: row.match_rank,
        matchSource: row.match_source,
        reviewSnippet: row.review_snippet?.trim() || null,
      })),
    },
    { headers: REFERENCE_SEARCH_CACHE_HEADERS },
  );
}

/** Widening candidate batches: cheap first, exhaustive-enough last. */
function searchBatchSizes(limit: number): number[] {
  const first = Math.min(limit * 4, MAX_REFERENCE_SEARCH_SCAN);
  return first < MAX_REFERENCE_SEARCH_SCAN
    ? [first, MAX_REFERENCE_SEARCH_SCAN]
    : [first];
}

/**
 * Site-wide reference index (#references-module). Returns the citations that
 * are anchored to a persistent surface, grouped along the requested axis —
 * owning monograph/page (`groupBy=drug`, the default), title initial
 * (`alpha`), first author's surname initial (`author`), or publication year
 * (`year`) — and sliced to one page.
 *
 * Orphaned citation drafts (no anchor at all) are omitted, matching the
 * drug-scoped bibliography's "used" semantics. In `drug` mode a citation cited
 * from more than one page appears under every group that cites it; the flat
 * `alpha`/`author`/`year` axes list each source once.
 *
 * Query parameters: `q` (free-text, see `_lib/reference-search.ts`),
 * `groupBy`, `bucket` (a single letter/year/group key), `page`, `pageSize`,
 * and `lang` (drug-name resolution for headings and collation).
 */
async function handleIndex(res: ServerResponse, url: URL): Promise<void> {
  const db = getDb();

  const parsedQuery = parseReferenceQuery(url.searchParams.get('q') ?? '');
  const groupBy = parseGroupBy(url.searchParams.get('groupBy'));
  const bucket = url.searchParams.get('bucket');
  const requestedPage = parsePage(url.searchParams.get('page'));
  const pageSize = parsePageSize(url.searchParams.get('pageSize'));
  const lang = parseLang(url.searchParams.get('lang'));

  // Recursive-descent extraction of every citation anchor inside published
  // page content, tagged with the owning page. Mirrors the three anchor
  // shapes handled by collectUsedCitationIdsForDrug: fact-node referenceIds
  // arrays, footnote referenceId scalars, and v2 field-level refs arrays.
  // The search runs alongside the anchor scan — the two are independent, and
  // the result set is the intersection of "anchored" and "matches the query".
  const [pageRows, paramRows, concRows, ionRows, directRows, matchingIds] =
    await Promise.all([
      db.execute<{
        page_id: number;
        slug: string;
        title: string;
        page_type: string;
        drug_cid: number | null;
        citation_id: number;
      }>(sql`
          SELECT p.id AS page_id, p.slug, p.title, p.page_type, p.drug_cid,
                 (r.v #>> '{}')::int AS citation_id
          FROM wiki_pages p
          CROSS JOIN LATERAL (
            SELECT t.v
            FROM jsonb_path_query(p.content, '$.**.referenceIds[*]') t(v)
            WHERE jsonb_typeof(t.v) = 'number'
            UNION ALL
            SELECT t.v
            FROM jsonb_path_query(p.content, '$.**.referenceId') t(v)
            WHERE jsonb_typeof(t.v) = 'number'
            UNION ALL
            SELECT t.v
            FROM jsonb_path_query(p.content, '$.**.refs[*]') t(v)
            WHERE jsonb_typeof(t.v) = 'number'
          ) r(v)
          WHERE p.status = 'published'
            AND p.content IS NOT NULL
            AND (r.v #>> '{}')::int > 0
        `),
      db
        .select({
          drugId: drugParameterRevisions.drugId,
          referenceId: drugParameterRevisions.referenceId,
          referenceIds: drugParameterRevisions.referenceIds,
        })
        .from(drugParameterRevisions),
      db
        .select({
          drugId: referenceConcentrations.drugId,
          citationId: referenceConcentrations.citationId,
        })
        .from(referenceConcentrations),
      db
        .select({
          drugId: drugIonizationConstants.drugId,
          referenceIds: drugIonizationConstants.referenceIds,
        })
        .from(drugIonizationConstants),
      db
        .select({ id: references.id, drugId: references.drugId })
        .from(references)
        .where(isNotNull(references.drugId)),
      parsedQuery.terms.length > 0
        ? findCitationIdsMatchingQuery(db, parsedQuery)
        : // A non-empty `q` that strips to nothing (`q=doi:`, `q=PMID`) is an
          // active search with no searchable term — it must match nothing, not
          // fall through to the unfiltered bibliography.
          Promise.resolve(
            url.searchParams.get('q')?.trim() ? new Set<number>() : null,
          ),
    ]);

  // drugId -> set of citation ids, and pageId -> { meta, set of citation ids }.
  const drugCitations = new Map<number, Set<number>>();
  const wikiGroups = new Map<
    number,
    { slug: string; title: string; pageType: string; citationIds: Set<number> }
  >();
  const allCitationIds = new Set<number>();

  const addToDrug = (drugId: number, citationId: number) => {
    let set = drugCitations.get(drugId);
    if (!set) {
      set = new Set();
      drugCitations.set(drugId, set);
    }
    set.add(citationId);
    allCitationIds.add(citationId);
  };

  for (const row of pageRows.rows) {
    if (row.citation_id == null) continue;
    // A drug monograph is the drug's own page — fold its citations into the
    // drug group so every reference for a substance reads as one bibliography.
    if (row.page_type === 'drug_monograph' && row.drug_cid != null) {
      addToDrug(row.drug_cid, row.citation_id);
      continue;
    }
    let group = wikiGroups.get(row.page_id);
    if (!group) {
      group = {
        slug: row.slug,
        title: row.title,
        pageType: row.page_type,
        citationIds: new Set(),
      };
      wikiGroups.set(row.page_id, group);
    }
    group.citationIds.add(row.citation_id);
    allCitationIds.add(row.citation_id);
  }

  for (const row of paramRows) {
    if (row.drugId == null) continue;
    if (row.referenceId != null) addToDrug(row.drugId, row.referenceId);
    if (Array.isArray(row.referenceIds)) {
      for (const cid of row.referenceIds) {
        if (typeof cid === 'number') addToDrug(row.drugId, cid);
      }
    }
  }

  for (const row of concRows) {
    if (row.drugId != null && row.citationId != null) {
      addToDrug(row.drugId, row.citationId);
    }
  }

  for (const row of ionRows) {
    if (row.drugId == null || !Array.isArray(row.referenceIds)) continue;
    for (const cid of row.referenceIds) {
      if (typeof cid === 'number') addToDrug(row.drugId, cid);
    }
  }

  for (const row of directRows) {
    if (row.drugId != null) addToDrug(row.drugId, row.id);
  }

  // `totalReferences` always describes the whole anchored corpus so the page
  // header can say "12 of 806" while a search is active.
  const totalReferences = allCitationIds.size;
  const selectedIds =
    matchingIds == null
      ? allCitationIds
      : new Set([...allCitationIds].filter((id) => matchingIds.has(id)));

  if (selectedIds.size === 0) {
    json(
      res,
      200,
      {
        groups: [],
        buckets: [],
        groupBy,
        bucket: null,
        page: 1,
        pageSize,
        totalPages: 1,
        totalReferences,
        matchedReferences: 0,
        totalRows: 0,
        rangeStart: 0,
        rangeEnd: 0,
      },
      { headers: REFERENCE_INDEX_CACHE_HEADERS },
    );
    return;
  }

  // Owners keep only their surviving citations, so a search that matches one
  // source doesn't drag in the rest of that drug's bibliography.
  const keepSelected = (ids: Set<number>): number[] =>
    [...ids].filter((id) => selectedIds.has(id));

  const drugCitationIds = new Map<number, number[]>();
  for (const [drugId, ids] of drugCitations) {
    const kept = keepSelected(ids);
    if (kept.length > 0) drugCitationIds.set(drugId, kept);
  }

  const drugIds = [...drugCitationIds.keys()];
  const [citationRows, drugRows] = await Promise.all([
    db
      .select()
      .from(references)
      .where(inArray(references.id, [...selectedIds])),
    drugIds.length > 0
      ? db
          .select({ id: drugs.id, slug: drugs.slug, names: drugs.names })
          .from(drugs)
          .where(inArray(drugs.id, drugIds))
      : Promise.resolve(
          [] as Array<{ id: number; slug: string; names: unknown }>,
        ),
  ]);

  const citationById = new Map<number, IndexCitation>(
    citationRows.map((row) => [
      row.id,
      {
        ...row,
        metadata: normalizeReferenceMetadata(row.metadata),
      } as IndexCitation,
    ]),
  );
  const drugById = new Map(drugRows.map((d) => [d.id, d]));

  const owners: ReferenceOwner[] = [];
  for (const [drugId, citationIds] of drugCitationIds) {
    const drug = drugById.get(drugId);
    if (!drug) continue;
    const names = (drug.names ?? {}) as Record<string, string>;
    owners.push({
      kind: 'drug',
      id: drugId,
      slug: drug.slug,
      names,
      href: `/wiki/drug/${drugId}`,
      // Resolved here rather than in the browser: the server decides the page
      // slice, so it has to sort by the same heading the user will read.
      heading: formatGenericDrugName(resolveDrugName(names, lang)) || drug.slug,
      citationIds,
    });
  }
  for (const [pageId, group] of wikiGroups) {
    const citationIds = keepSelected(group.citationIds);
    if (citationIds.length === 0) continue;
    owners.push({
      kind: 'wiki',
      id: pageId,
      slug: group.slug,
      title: group.title,
      pageType: group.pageType,
      href: `/wiki/${group.slug}`,
      heading: group.title || group.slug,
      citationIds,
    });
  }

  const indexPage = buildReferenceIndexPage({
    owners,
    citations: citationById,
    groupBy,
    bucket,
    page: requestedPage,
    pageSize,
    lang,
  });

  json(
    res,
    200,
    { ...indexPage, groupBy, totalReferences },
    { headers: REFERENCE_INDEX_CACHE_HEADERS },
  );
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  if (!(await callerCan(auth.role, CAP['reference.create']))) {
    error(res, 403, 'Contributor role required');
    return;
  }

  const parsed = await parseAndValidate(req, createReferenceSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const { type, identifier, metadata, drugId } = parsed.data;
  const normalizedMetadata = normalizeReferenceMetadata(metadata);
  const db = getDb();

  // Check if this exact reference already exists before calling external
  // resolvers. Existing rows are the local cache; reusing them should not
  // depend on PubMed/CrossRef availability.
  const [existing] = await db
    .select()
    .from(references)
    .where(
      and(eq(references.type, type), eq(references.identifier, identifier)),
    )
    .limit(1);

  if (existing) {
    json(res, 200, {
      reference: {
        ...existing,
        metadata: normalizeReferenceMetadata(existing.metadata),
      },
    });
    return;
  }

  if (referenceTypeUsesExternalResolver(type)) {
    if (!consumeReferenceResolverQuota(req, res, auth.userId)) return;
  }

  const resolved = await resolveAuthoritativeMetadata(type, identifier);
  if (resolved.status === 'upstream_error') {
    error(
      res,
      502,
      `${resolved.provider} resolver is temporarily unavailable`,
      'reference_resolver_unavailable',
    );
    return;
  }
  if (resolved.status === 'unresolved') {
    error(
      res,
      400,
      `Could not resolve ${type === 'doi' ? 'DOI' : 'PubMed ID'}`,
      'reference_identifier_unresolved',
    );
    return;
  }
  const normalizedResolvedMetadata = resolved.metadata
    ? normalizeReferenceMetadata(resolved.metadata)
    : null;
  if (
    normalizedResolvedMetadata &&
    metadataTitleConflicts(normalizedMetadata, normalizedResolvedMetadata)
  ) {
    error(
      res,
      400,
      'Reference metadata does not match the resolved identifier title',
      'reference_metadata_mismatch',
    );
    return;
  }
  const metadataToStore = mergeReferenceMetadata(
    normalizedMetadata,
    normalizedResolvedMetadata,
  );

  // Which handles are the same paper (#1018). Best-effort and non-blocking: if
  // NCBI does not answer, the row is filed under the declared handle exactly as
  // it was before. Resolved here rather than in the store because the store
  // makes no network calls.
  const crosswalk = await resolveOneCrosswalk({ type, identifier });

  // `resolveCitation` is the only place a citation row is minted. It looks the
  // paper up under every handle it is known by, so a DOI submitted for a paper
  // already filed under its PMID returns that row — with its paper review, and
  // therefore its read-in-full attestation — instead of a second row that would
  // carry its own, independent review.
  const stored = await resolveCitation(
    db,
    {
      type,
      identifier,
      metadata: metadataToStore,
      drugId: drugId ?? null,
      crosswalk,
    },
    auth.userId,
  );

  const [row] = await db
    .select()
    .from(references)
    .where(eq(references.id, stored.id))
    .limit(1);

  if (!row) {
    error(res, 500, 'Failed to create reference');
    return;
  }

  json(res, stored.created ? 201 : 200, {
    reference: {
      ...row,
      metadata: normalizeReferenceMetadata(row.metadata),
    },
  });
}

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
  if (!(await callerCan(auth.role, CAP['reference.update']))) {
    error(res, 403, 'Contributor role required');
    return;
  }

  const id = Number(url.searchParams.get('id'));
  if (!Number.isInteger(id) || id <= 0) {
    error(res, 400, 'A positive id query parameter is required');
    return;
  }

  const parsed = await parseAndValidate(req, updateReferenceSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const db = getDb();
  const [existing] = await db
    .select()
    .from(references)
    .where(eq(references.id, id))
    .limit(1);
  if (!existing) {
    error(res, 404, 'Reference not found');
    return;
  }

  const suppliedMetadata =
    parsed.data.metadata !== undefined
      ? normalizeReferenceMetadata(parsed.data.metadata)
      : null;
  // Whether the caller *mentioned* the handles, which is a different question
  // from what they mentioned. Omitting `altIds` says nothing about them and
  // must not delete them; naming them — with a correction, or with an empty
  // object to drop one — is an editing operation on the handle set, and the
  // stored value gives way to it. Read off the raw body because normalization
  // erases the difference: an `altIds` whose every entry is malformed
  // normalizes to nothing, and so does an absent one.
  const patchNamesAltIds =
    !!parsed.data.metadata &&
    typeof parsed.data.metadata === 'object' &&
    !Array.isArray(parsed.data.metadata) &&
    'altIds' in (parsed.data.metadata as Record<string, unknown>);

  let metadataToStore: ReferenceMetadata | null;
  if (parsed.data.refresh) {
    if (referenceTypeUsesExternalResolver(existing.type)) {
      if (!consumeReferenceResolverQuota(req, res, auth.userId)) return;
    }
    const resolved = await resolveAuthoritativeMetadata(
      existing.type as 'freetext' | 'url' | 'pmid' | 'doi',
      existing.identifier,
    );
    if (resolved.status === 'upstream_error') {
      error(
        res,
        502,
        `${resolved.provider} resolver is temporarily unavailable`,
        'reference_resolver_unavailable',
      );
      return;
    }
    if (resolved.status === 'unresolved') {
      error(
        res,
        400,
        `Could not resolve ${existing.type === 'doi' ? 'DOI' : 'PubMed ID'}`,
        'reference_identifier_unresolved',
      );
      return;
    }
    const resolvedMetadata = resolved.metadata
      ? normalizeReferenceMetadata(resolved.metadata)
      : null;
    if (!resolvedMetadata) {
      // freetext/url rows have no authoritative external source to refresh from.
      error(
        res,
        400,
        `References of type "${existing.type}" cannot be refreshed from an external source; supply metadata instead`,
        'reference_not_refreshable',
      );
      return;
    }
    // When the caller also supplied metadata, guard the same title-conflict
    // invariant the create path enforces so a refresh can't be steered onto the
    // wrong record by a mismatched supplied title.
    if (
      suppliedMetadata &&
      metadataTitleConflicts(suppliedMetadata, resolvedMetadata)
    ) {
      error(
        res,
        400,
        'Reference metadata does not match the resolved identifier title',
        'reference_metadata_mismatch',
      );
      return;
    }
    // Precedence: authoritative resolver > caller-supplied > existing cache.
    // Resolver-omitted fields fall back so a refresh never drops data.
    const base = mergeReferenceMetadata(
      normalizeReferenceMetadata(existing.metadata),
      suppliedMetadata,
    );
    metadataToStore = mergeReferenceMetadata(base, resolvedMetadata);
  } else {
    // Explicit override with no external call — the escape hatch for url/freetext
    // rows or a genuinely wrong upstream record. An empty object normalizes to
    // null, which would blank the row; reject it rather than wipe the metadata.
    if (!suppliedMetadata) {
      error(
        res,
        400,
        'metadata must contain at least one field',
        'reference_metadata_empty',
      );
      return;
    }
    // The override replaces the description, not the identity — every other
    // field is deliberately overwritten, since correcting a wrong upstream
    // record is what this branch is for. `altIds` is not a description: it is
    // the set of handles this paper is also known by, and a patch supplying a
    // title has said nothing about them. Storing the supplied record wholesale
    // deleted them, re-splitting the paper the next time a write arrived under
    // a dropped handle. Removing a handle stays possible, but as an operation
    // rather than as a side effect of editing a title.
    const carriedAltIds = mergeAltIds(
      normalizeReferenceMetadata(existing.metadata)?.altIds,
      suppliedMetadata.altIds,
    );
    metadataToStore =
      Object.keys(carriedAltIds).length > 0
        ? { ...suppliedMetadata, altIds: carriedAltIds }
        : suppliedMetadata;
  }

  // A patch that named the handles gets the handles it named. Everything above
  // merges them, which is right when the other side is a resolver that was
  // never asked about them — and wrong when it is an editor correcting a wrong
  // DOI, since a fill-the-gaps merge keeps the stored value and the correction
  // is silently dropped. There is no separate handle-edit route to defer to.
  if (patchNamesAltIds) {
    metadataToStore = withExplicitAltIds(metadataToStore, suppliedMetadata);
  }

  const [row] = await db
    .update(references)
    .set({ metadata: metadataToStore })
    .where(eq(references.id, id))
    .returning();
  if (!row) {
    error(res, 500, 'Failed to update reference');
    return;
  }

  json(res, 200, {
    reference: {
      ...row,
      metadata: normalizeReferenceMetadata(row.metadata),
    },
  });
}

async function resolveAuthoritativeMetadata(
  type: 'freetext' | 'url' | 'pmid' | 'doi',
  identifier: string,
): Promise<
  | { status: 'resolved'; metadata: ReferenceMetadata | null }
  | { status: 'unresolved' }
  | { status: 'upstream_error'; provider: 'CrossRef' | 'PubMed' }
> {
  if (type === 'pmid') {
    try {
      const metadata = await fetchPubMedMetadata(identifier);
      return metadata
        ? { status: 'resolved', metadata }
        : { status: 'unresolved' };
    } catch {
      return { status: 'upstream_error', provider: 'PubMed' };
    }
  }
  if (type === 'doi') {
    try {
      return {
        status: 'resolved',
        metadata: await fetchCrossRefMetadata(identifier),
      };
    } catch {
      return { status: 'upstream_error', provider: 'CrossRef' };
    }
  }
  return { status: 'resolved', metadata: null };
}

function metadataTitleConflicts(
  supplied: ReferenceMetadata | null,
  resolved: ReferenceMetadata | null,
): boolean {
  const suppliedTitle = comparableTitle(supplied?.title);
  const resolvedTitle = comparableTitle(resolved?.title);
  if (!suppliedTitle || !resolvedTitle) return false;
  if (suppliedTitle === resolvedTitle) return false;

  const shorter =
    suppliedTitle.length < resolvedTitle.length ? suppliedTitle : resolvedTitle;
  const longer =
    suppliedTitle.length < resolvedTitle.length ? resolvedTitle : suppliedTitle;
  return !(shorter.length >= 32 && longer.includes(shorter));
}

/**
 * Field precedence between two metadata records: `resolved` wins, `supplied`
 * fills gaps.
 *
 * `altIds` is the exception, and it is a union rather than a precedence,
 * because it is not a description of the paper — it is the paper's other
 * handles, and the resolver that answered about one handle knows nothing about
 * the rest. Letting the winning record's absent `altIds` blank the stored ones
 * loses the crosswalk that keeps a paper in one row, and worse: a citation's
 * work kind is classified over the handles it carries (§13.3), so dropping a
 * handle here is dropping the evidence that handle produced. That the
 * classification survives a shrink is what makes this a bug about the
 * crosswalk rather than a hole in the gate — but there is no reason to lose the
 * handle either way.
 */
/**
 * Replace the stored handle set with the one the patch named, dropping the
 * field entirely when the patch named none.
 *
 * Returning `null` for a record that ends up empty matches what
 * `normalizeReferenceMetadata` would have produced, so the column never holds
 * an object whose only content was a field this function just removed.
 */
function withExplicitAltIds(
  metadata: ReferenceMetadata | null,
  supplied: ReferenceMetadata | null,
): ReferenceMetadata | null {
  if (!metadata) return metadata;
  const next: ReferenceMetadata = { ...metadata };
  if (supplied?.altIds && Object.keys(supplied.altIds).length > 0) {
    next.altIds = supplied.altIds;
  } else {
    delete next.altIds;
  }
  return Object.keys(next).length > 0 ? next : null;
}

function mergeReferenceMetadata(
  supplied: ReferenceMetadata | null,
  resolved: ReferenceMetadata | null,
): ReferenceMetadata | null {
  const carriedAltIds = mergeAltIds(supplied?.altIds, resolved?.altIds);
  if (!resolved) {
    if (!supplied) return null;
    return Object.keys(carriedAltIds).length > 0
      ? { ...supplied, altIds: carriedAltIds }
      : supplied;
  }
  const merged: ReferenceMetadata = {};

  const assignString = (field: 'title' | 'journal' | 'volume' | 'pages') => {
    const value = resolved[field] ?? supplied?.[field];
    if (value) merged[field] = value;
  };

  assignString('title');
  if (resolved.authors?.length) {
    merged.authors = resolved.authors;
  } else if (supplied?.authors?.length) {
    merged.authors = supplied.authors;
  }
  assignString('journal');
  const year = resolved.year ?? supplied?.year;
  if (year) merged.year = year;
  assignString('volume');
  assignString('pages');
  if (Object.keys(carriedAltIds).length > 0) merged.altIds = carriedAltIds;

  return Object.keys(merged).length > 0 ? merged : null;
}

function comparableTitle(title: string | null | undefined): string {
  return (title ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{Mark}+/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function referenceTypeUsesExternalResolver(type: string): boolean {
  return type === 'pmid' || type === 'doi';
}

function consumeReferenceResolverQuota(
  req: IncomingMessage,
  res: ServerResponse,
  userId: number,
): boolean {
  const ipLimit = consumeRateLimit(
    'references-resolver-ip',
    getClientAddressKey(req),
    REFERENCE_RESOLVER_LIMIT,
    REFERENCE_RESOLVER_WINDOW_MS,
  );
  if (ipLimit.limited) {
    res.setHeader('Retry-After', String(ipLimit.retryAfterSeconds));
    error(
      res,
      429,
      'Too many reference resolution requests. Please try again later.',
    );
    return false;
  }

  const userLimit = consumeRateLimit(
    'references-resolver-user',
    String(userId),
    REFERENCE_RESOLVER_LIMIT,
    REFERENCE_RESOLVER_WINDOW_MS,
  );
  if (!userLimit.limited) return true;

  res.setHeader('Retry-After', String(userLimit.retryAfterSeconds));
  error(
    res,
    429,
    'Too many reference resolution requests. Please try again later.',
  );
  return false;
}
