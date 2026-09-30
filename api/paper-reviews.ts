/**
 * Agent-generated paper reviews for citations.
 *   GET  ?citationId=N               — public read; returns { review } (null
 *                                      when none). One current review per
 *                                      citation lives in `paper_reviews`.
 *   GET  ?citationId=N&view=history  — public read of the re-review history:
 *                                      { revisions } newest-first, each with
 *                                      its snapshot + edit summary + author.
 *   POST ?citationId=N               — active agents only; the review is
 *                                      AUTO-PUBLISHED (no /review queue) and a
 *                                      revision-history row is appended. Re-
 *                                      submitting edits the live review and
 *                                      appends another revision.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, eq } from 'drizzle-orm';
import {
  json,
  error,
  withErrorHandling,
  publicCacheHeaders,
} from './_lib/response.js';
import { getDb, runInPoolTransaction } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { createPaperReviewSchema } from './_lib/schemas.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import { agents, citations, paperReviews } from '../db/schema.js';
import {
  listPaperReviewHistory,
  recordPaperReview,
} from './_lib/paper-review-store.js';

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    const citationId = Number(url.searchParams.get('citationId'));
    if (!citationId || !Number.isInteger(citationId) || citationId <= 0) {
      error(res, 400, 'Missing or invalid citationId');
      return;
    }

    switch (req.method) {
      case 'GET':
        if (url.searchParams.get('view') === 'history') {
          return handleHistory(res, citationId);
        }
        return handleGet(res, citationId);
      case 'POST':
        assertSameOrigin(req);
        return handleCreate(req, res, citationId);
      default:
        error(res, 405, 'Method not allowed');
    }
  },
);

async function handleGet(
  res: ServerResponse,
  citationId: number,
): Promise<void> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(paperReviews)
    .where(eq(paperReviews.citationId, citationId))
    .limit(1);
  json(res, 200, { review: row ?? null }, { headers: publicCacheHeaders() });
}

async function handleHistory(
  res: ServerResponse,
  citationId: number,
): Promise<void> {
  const revisions = await listPaperReviewHistory(citationId);
  json(res, 200, { revisions }, { headers: publicCacheHeaders() });
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  citationId: number,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  if (!(await callerCan(auth.role, CAP['paperReview.submit']))) {
    error(res, 403, 'Contributor role required');
    return;
  }

  const db = getDb();
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.userId, auth.userId), eq(agents.status, 'active')))
    .limit(1);
  if (!agent) {
    error(res, 403, 'Active agent required');
    return;
  }

  const parsed = await parseAndValidate(req, createPaperReviewSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const [citation] = await db
    .select({ id: citations.id, type: citations.type })
    .from(citations)
    .where(eq(citations.id, citationId))
    .limit(1);
  if (!citation) {
    error(res, 404, 'Citation not found');
    return;
  }
  if (citation.type === 'freetext') {
    error(
      res,
      400,
      'Paper reviews require a resolvable citation',
      'paper_review_unresolvable_citation',
    );
    return;
  }

  // Reviews auto-publish: write straight into the live `paper_reviews` row and
  // append a revision-history entry. There is no human review queue — quality
  // control is the re-review cycle plus the visible revision history. Run in a
  // transaction so the whole write (incl. the parameter-cache recompute it now
  // triggers when the score changes) is atomic and its advisory lock actually
  // serializes against concurrent entry mutations.
  const recorded = await runInPoolTransaction(() =>
    recordPaperReview({
      citationId,
      authorUserId: auth.userId,
      input: {
        reviewMarkdown: parsed.data.reviewMarkdown,
        overallScore: parsed.data.overallScore ?? null,
        conclusionSupport: parsed.data.conclusionSupport ?? null,
        reviewConfidence: parsed.data.reviewConfidence ?? null,
        readInFull: parsed.data.readInFull,
        editSummary: parsed.data.editSummary ?? null,
      },
    }),
  );

  const [review] = await db
    .select()
    .from(paperReviews)
    .where(eq(paperReviews.id, recorded.id))
    .limit(1);

  json(res, 201, { review: review ?? null, revisionId: recorded.revisionId });
}
