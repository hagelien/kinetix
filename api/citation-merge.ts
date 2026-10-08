/**
 * Merge citation rows that are one paper (Admin → Merge → Merge citations).
 *
 *   GET  /api/citation-merge?q=…
 *     → candidate rows matching the query, each with what hangs off it (usage
 *       count, paper review, stored PDF, PDF request). Unlike the public
 *       reference search this lists every row, including ones nothing cites
 *       yet — a duplicate that exists only as a PDF request is exactly what an
 *       admin comes here to fold.
 *
 *   POST /api/citation-merge   { survivorId, mergeIds }
 *     → folds every `mergeIds` row into `survivorId` inside one transaction
 *       and returns the per-row stats.
 *
 * The automatic paths (`resolveCitation`, `merge:split-citations`) only fold
 * rows they can prove are one paper — a shared PMID/DOI, or free text whose
 * author, year and title match. Two free-text spellings of the same paper
 * that drift further apart than that stay split, and every split row carries
 * its own PDF request and review. This is the manual override for those: an
 * admin vouches that the rows are the same work, and the same fold the
 * automatic paths use (`mergeCitations`) does the rest.
 *
 * Gated on `citation.merge` (floors at editor) and same-origin. Agent
 * identities are refused outright: a merge rewrites wiki documents and
 * repoints review and parameter provenance on the judgment that two rows are
 * one paper, and that judgment is a person's to make.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { inArray } from 'drizzle-orm';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb, runInPoolTransaction } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { citationMergeApplySchema } from './_lib/schemas.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import { isActiveAgentUser } from './_lib/agent-verifications.js';
import {
  citationPdfs,
  citations,
  paperReviews,
  pdfRequests,
} from '../db/schema.js';
import {
  parseReferenceQuery,
  searchCitationRows,
} from './_lib/reference-search.js';
import { normalizeReferenceMetadata } from './_lib/reference-metadata.js';
import {
  CitationCohortConflictError,
  assertNoConflictingCohortBaselines,
  countCitationUsage,
  mergeCitations,
  type CitationMergeStats,
} from './_lib/citation-merge.js';
import { citationHandleRank } from '../src/lib/citationHandles.js';

/** Enough to show every spelling of one paper alongside its neighbours. */
const CANDIDATE_LIMIT = 40;

export default withErrorHandling(
  async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'POST') {
      error(res, 405, 'Method not allowed');
      return;
    }
    if (req.method === 'POST') assertSameOrigin(req);

    const auth = await getUserFromRequest(req);
    if (!auth || !(await callerCan(auth.role, CAP['citation.merge']))) {
      error(res, 403, 'Admin role required');
      return;
    }
    if (await isActiveAgentUser(auth.userId)) {
      error(res, 403, 'Citation merges are made by people, not agents.', 'agent_refused');
      return;
    }

    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      return handleSearch(res, url);
    }
    return handleApply(req, res, auth.userId);
  },
);

async function handleSearch(res: ServerResponse, url: URL): Promise<void> {
  const parsed = parseReferenceQuery(url.searchParams.get('q') ?? '');
  if (parsed.terms.length === 0) {
    json(res, 200, { candidates: [] });
    return;
  }
  const db = getDb();
  const rows = await searchCitationRows(db, parsed, CANDIDATE_LIMIT);
  if (rows.length === 0) {
    json(res, 200, { candidates: [] });
    return;
  }
  const ids = rows.map((row) => row.id);

  const [reviews, pdfs, requests, usage] = await Promise.all([
    db
      .select({ citationId: paperReviews.citationId, readInFull: paperReviews.readInFull })
      .from(paperReviews)
      .where(inArray(paperReviews.citationId, ids)),
    db
      .select({ citationId: citationPdfs.citationId })
      .from(citationPdfs)
      .where(inArray(citationPdfs.citationId, ids)),
    db
      .select({ citationId: pdfRequests.citationId, status: pdfRequests.status })
      .from(pdfRequests)
      .where(inArray(pdfRequests.citationId, ids)),
    Promise.all(ids.map((id) => countCitationUsage(db, id))),
  ]);
  const reviewOf = new Map(reviews.map((r) => [r.citationId, r]));
  const pdfIds = new Set(pdfs.map((p) => p.citationId));
  const requestOf = new Map(requests.map((r) => [r.citationId, r.status]));

  json(res, 200, {
    candidates: rows.map((row, i) => {
      const review = reviewOf.get(row.id);
      return {
        id: row.id,
        type: row.type,
        identifier: row.identifier,
        metadata: normalizeReferenceMetadata(row.metadata),
        usageCount: usage[i] ?? 0,
        review: review ? { readInFull: review.readInFull } : null,
        hasPdf: pdfIds.has(row.id),
        pdfRequestStatus: requestOf.get(row.id) ?? null,
      };
    }),
  });
}

async function handleApply(
  req: IncomingMessage,
  res: ServerResponse,
  actorUserId: number,
): Promise<void> {
  const parsed = await parseAndValidate(req, citationMergeApplySchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }
  const { survivorId } = parsed.data;
  const mergeIds = [...new Set(parsed.data.mergeIds)].filter((id) => id !== survivorId);
  if (mergeIds.length === 0) {
    error(res, 400, 'Pick at least one citation besides the one being kept.', 'nothing_to_merge');
    return;
  }

  const db = getDb();
  const groupIds = [survivorId, ...mergeIds];
  const rows = await db
    .select({ id: citations.id, type: citations.type })
    .from(citations)
    .where(inArray(citations.id, groupIds));
  const found = new Set(rows.map((row) => row.id));
  const missing = groupIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    json(res, 404, {
      error: 'Some of these citations no longer exist — they may already have been merged.',
      code: 'not_found',
      missing,
    });
    return;
  }

  // The survivor must be filed under the group's strongest handle. A PMID or
  // DOI is what lets the reference resolver find this paper again; folding a
  // PMID row into a free-text one would leave the PMID only as an alias and
  // invite the next write declaring it to treat the free text as the paper.
  const survivorType = rows.find((row) => row.id === survivorId)!.type;
  const strongest = Math.min(...rows.map((row) => citationHandleRank(row.type)));
  if (citationHandleRank(survivorType) > strongest) {
    error(
      res,
      400,
      'Keep the citation with the strongest identifier (PMID, then DOI, then URL).',
      'weaker_survivor',
    );
    return;
  }

  try {
    // Over the whole group before the first fold — see the note on the
    // function. Re-checked per pair inside `mergeCitations`, and the whole
    // group runs in one transaction, so a late refusal rolls back cleanly.
    await assertNoConflictingCohortBaselines(db, groupIds);
    const stats = await runInPoolTransaction(async () => {
      const tx = getDb();
      const out: CitationMergeStats[] = [];
      for (const loserId of mergeIds) {
        out.push(await mergeCitations(tx, survivorId, loserId, { actorUserId }));
      }
      return out;
    });
    const deferred = stats.filter((s) => s.deferred).map((s) => s.loserId);
    json(res, 200, {
      ok: true,
      survivorId,
      merged: stats.filter((s) => !s.deferred).map((s) => s.loserId),
      deferred,
      stats,
    });
  } catch (err) {
    if (err instanceof CitationCohortConflictError) {
      json(res, 409, { error: err.message, code: 'cohort_conflict' });
      return;
    }
    console.error('Failed to merge citations:', {
      survivorId,
      mergeIds,
      message: err instanceof Error ? err.message : String(err),
      cause: (err as { cause?: unknown })?.cause,
    });
    error(res, 500, 'Failed to merge citations');
  }
}
