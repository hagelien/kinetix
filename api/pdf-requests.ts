/**
 * PDF requests — the queue the review agent files when a cited paper has no
 * legitimately free full text, and contributors fulfil by supplying a PDF.
 *   GET                    — authenticated list of open requests, plus the
 *                            unrequested full-text gaps (see below)
 *   GET  ?awaitingReview=1 — list fulfilled requests whose citation has no
 *                            paper review yet, or whose review was withdrawn
 *                            (the agent's follow-up queue)
 *   GET  ?citationId=N      — the request for one citation (null when none)
 *   POST ?citationId=N      — contributors (agents and humans); upserts an open
 *                            request. Agents file these when they hit a paywall;
 *                            a human contributor self-provisions one when they
 *                            supply full text directly from the reference page.
 *                            Body `{ replace: true }` (editor+) reopens a
 *                            request for a citation that already HAS full text,
 *                            so an unusable stored PDF can be swapped.
 *
 * The default GET returns two classes side by side:
 *   `requests` — open `pdf_requests` rows. An agent (or a contributor) has
 *                stated on the record that this paper's full text is needed.
 *   `gaps`     — cited resolvable papers with no stored PDF and no read-in-full
 *                review that carry no request at all (`listFullTextGaps`).
 * The gap class exists because the reference page already tells a reader
 * "this paper hasn't been reviewed because the full text isn't on file" from
 * client-side state alone, while the queue only ever showed `pdf_requests`
 * rows — so a paper could advertise the need on its own page indefinitely and
 * never appear here. Listing them keeps the two surfaces in agreement without
 * writing request rows nothing has actually asked for, and keeps the
 * agent-confirmed "I tried and could not get it" signal distinguishable from
 * "nobody has looked yet". `countOnly` deliberately still counts only
 * `requests`: the header badge means "needs attention now", and folding in
 * every not-yet-reviewed citation would make it a permanent large number.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  json,
  error,
  noStoreHeaders,
  withErrorHandling,
} from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { createPdfRequestSchema } from './_lib/schemas.js';
import { listFullTextGaps } from './_lib/full-text-gaps.js';
import { citationsWithPendingInboxItems } from './_lib/pdf-inbox-store.js';
import { CAP } from '../src/lib/permissions.js';
import {
  NO_PDF_URL_PATTERN,
  noPdfReason,
} from '../src/lib/publicDatabaseRecord.js';
import { callerCan } from './_lib/permissions-store.js';
import {
  citationPdfs,
  citations,
  paperExtractionJobs,
  paperReviews,
  pdfRequests,
} from '../db/schema.js';

const publicPdfRequestColumns = {
  id: pdfRequests.id,
  citationId: pdfRequests.citationId,
  status: pdfRequests.status,
  reason: pdfRequests.reason,
  // Not sensitive, and the client benefits from knowing: a replacement
  // request is editor-only to fulfil, so the UI can say so rather than
  // offering an upload that will 403.
  isReplacement: pdfRequests.isReplacement,
  fulfilledAt: pdfRequests.fulfilledAt,
  createdAt: pdfRequests.createdAt,
};

// A citation whose full text is already stored needs no upload, so it must
// never surface as an open request. The review agent re-files a request on
// every paywalled pass — including passes that run after a contributor already
// supplied full text (the agent can't see the stored asset) — which would
// otherwise resurface an already-satisfied paper in the queue. Every open-queue
// read excludes citations that already have a citation_pdfs row.
const citationHasNoStoredPdf = sql`not exists (
  select 1 from ${citationPdfs}
  where ${citationPdfs.citationId} = ${pdfRequests.citationId}
)`;

// A public database record or a site's landing page can never be satisfied by
// a PDF either (src/lib/publicDatabaseRecord.ts), so it never surfaces as an
// open request. POST refuses new ones and migrations 0137/0139 cancelled the
// old ones, but the previous deployment keeps serving POST until this one is
// live and can still file one in that window; filtering on read keeps such a
// row out of the queue and the header badge instead of stranding it there.
const citationCanTakeAPdf = sql`not exists (
  select 1 from ${citations}
  where ${citations.id} = ${pdfRequests.citationId}
    and ${citations.type} = 'url'
    and btrim(${citations.identifier}) ~* ${NO_PDF_URL_PATTERN}
)`;

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );

    switch (req.method) {
      case 'GET':
        return handleGet(req, res, url);
      case 'POST':
        assertSameOrigin(req);
        return handleCreate(req, res, url);
      default:
        error(res, 405, 'Method not allowed');
    }
  },
);

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }

  const db = getDb();

  // Lightweight count of the OPEN queue — papers the review agent couldn't
  // access, awaiting a human contributor to supply full text. These are the
  // "needs attention" items surfaced in the header review badge alongside the
  // pending-edit count. Kept separate from the list payload so the badge poll
  // stays cheap. The open queue is global (any contributor may fulfil), so the
  // count is not user-scoped.
  const countOnly = url.searchParams.get('countOnly');
  if (countOnly === 'true' || countOnly === '1') {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pdfRequests)
      .where(
        and(
          eq(pdfRequests.status, 'open'),
          citationHasNoStoredPdf,
          citationCanTakeAPdf,
        ),
      );
    json(
      res,
      200,
      { count: result?.count ?? 0 },
      { headers: noStoreHeaders() },
    );
    return;
  }

  const citationIdParam = url.searchParams.get('citationId');

  if (citationIdParam !== null) {
    const citationId = Number(citationIdParam);
    if (!citationId || !Number.isInteger(citationId) || citationId <= 0) {
      error(res, 400, 'Invalid citationId');
      return;
    }
    const [[row], [pdf]] = await Promise.all([
      db
        .select(publicPdfRequestColumns)
        .from(pdfRequests)
        .where(eq(pdfRequests.citationId, citationId))
        .limit(1),
      db
        .select({ id: citationPdfs.id })
        .from(citationPdfs)
        .where(eq(citationPdfs.citationId, citationId))
        .limit(1),
    ]);
    json(
      res,
      200,
      { request: row ?? null, hasPdf: Boolean(pdf) },
      { headers: noStoreHeaders() },
    );
    return;
  }

  // Follow-up queue: a contributor supplied full text for a paper a request was
  // filed for, but no paper review exists yet. The review agent drains this
  // first so every fulfilled request is followed up — even when the citation is
  // not (yet) in use on a popular drug and would otherwise never surface in the
  // agent's popularity walk. Oldest fulfilment first so the queue drains FIFO.
  const awaitingReview = url.searchParams.get('awaitingReview');
  if (awaitingReview === '1' || awaitingReview === 'true') {
    const rows = await db
      .select({
        ...publicPdfRequestColumns,
        citationType: citations.type,
        citationIdentifier: citations.identifier,
        citationMetadata: citations.metadata,
      })
      .from(pdfRequests)
      .innerJoin(citations, eq(citations.id, pdfRequests.citationId))
      .leftJoin(
        paperReviews,
        eq(paperReviews.citationId, pdfRequests.citationId),
      )
      // A review that EXISTS but has been withdrawn (`read_in_full = false`) is
      // awaiting review just as much as no review at all. Replacing a stored
      // PDF withdraws the old attestation precisely because it appraised
      // different bytes — so keying this queue on the review row's *absence*
      // would drop a replaced paper out of it entirely: never re-reviewed, and
      // every fact citing it blocked by `reference_not_judged` with nothing
      // anywhere saying why.
      .where(
        and(
          eq(pdfRequests.status, 'fulfilled'),
          or(isNull(paperReviews.id), eq(paperReviews.readInFull, false)),
        ),
      )
      .orderBy(asc(pdfRequests.fulfilledAt))
      .limit(200);
    json(res, 200, { requests: rows }, { headers: noStoreHeaders() });
    return;
  }

  // The two classes are independent reads — run them together so adding the
  // gap list costs no extra latency on a page that already waits on one query.
  //
  // They are also independent *snapshots*: the neon-http driver sends each
  // statement as its own transaction, and request creation runs concurrently
  // (the agent files on every paywalled pass, contributors self-provision on
  // upload). A request inserted between the two reads can therefore be seen by
  // one and not the other. Only one of the two orderings is worth spending
  // anything on: gap-read-then-insert-then-request-read puts the same paper in
  // both sections, under contradictory framing, which is the bug a reader
  // would actually report. The reverse ordering drops it from both for a
  // single page load, and it reappears as an open request on the next one —
  // accepted, since serializing the pair would cost a transaction on every
  // queue view to close a self-correcting one-render omission.
  const [rows, gaps] = await Promise.all([
    db
      .select({
        ...publicPdfRequestColumns,
        citationType: citations.type,
        citationIdentifier: citations.identifier,
        citationMetadata: citations.metadata,
      })
      .from(pdfRequests)
      .innerJoin(citations, eq(citations.id, pdfRequests.citationId))
      .where(
        and(
          eq(pdfRequests.status, 'open'),
          citationHasNoStoredPdf,
          citationCanTakeAPdf,
        ),
      )
      .orderBy(desc(pdfRequests.createdAt))
      .limit(200),
    listFullTextGaps(db),
  ]);

  // Make the classes disjoint against the requests this response actually
  // carries, rather than against whatever the gap query's snapshot saw.
  const requested = new Set(rows.map((row) => row.citationId));
  const gapRows = gaps.rows.filter((gap) => !requested.has(gap.citationId));

  // A paper whose full text is already sitting in the bulk inbox, matched but
  // not yet linked, is not a paper anybody needs to go and fetch — the copy is
  // on the premises. Without this the queue would send a contributor to a
  // library proxy for a PDF that is one click away, which is precisely the
  // wasted effort the inbox exists to remove. Flagged rather than hidden: the
  // paper genuinely still lacks full text until the link is made, and a row
  // that silently vanished would leave no way to notice a match nobody
  // confirmed.
  const inboxAwaiting = await citationsWithPendingInboxItems([
    ...requested,
    ...gapRows.map((gap) => gap.citationId),
  ]);

  json(
    res,
    200,
    {
      requests: rows.map((row) => ({
        ...row,
        pdfInInbox: inboxAwaiting.has(row.citationId),
      })),
      gaps: gapRows.map((gap) => ({
        ...gap,
        pdfInInbox: inboxAwaiting.has(gap.citationId),
      })),
      // Discount the overlap so the "showing N of M" line stays truthful.
      gapTotal: Math.max(0, gaps.total - (gaps.rows.length - gapRows.length)),
    },
    { headers: noStoreHeaders() },
  );
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const citationId = Number(url.searchParams.get('citationId'));
  if (!citationId || !Number.isInteger(citationId) || citationId <= 0) {
    error(res, 400, 'Missing or invalid citationId');
    return;
  }

  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  if (!(await callerCan(auth.role, CAP['pdfRequest.create']))) {
    error(res, 403, 'Contributor role required');
    return;
  }

  const db = getDb();

  const parsed = await parseAndValidate(req, createPdfRequestSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const [citation] = await db
    .select({
      id: citations.id,
      type: citations.type,
      identifier: citations.identifier,
    })
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
      'PDF requests require a resolvable citation',
      'pdf_request_unresolvable_citation',
    );
    return;
  }
  // A public database record is read directly, and its facts are cited to the
  // primary study it attributes (PubChem through `node
  // scripts/kinetix-fulltext.mjs pubchem <CID>`); a site's landing page has no
  // specific source to read at all and needs re-citing. Either way a PDF
  // request would ask a contributor for something that does not exist.
  const reason = noPdfReason(citation);
  if (reason === 'public_database_record') {
    error(
      res,
      400,
      'Public database records need no PDF; read the record directly and cite the primary study it attributes',
      'pdf_request_public_database_record',
    );
    return;
  }
  if (reason === 'site_landing_page') {
    error(
      res,
      400,
      "This citation is a site's front page, not a specific source; replace it with the exact page or study instead of requesting a PDF",
      'pdf_request_unspecific_url',
    );
    return;
  }

  // Full text may already be stored — the review agent re-files on every
  // paywalled pass and can't see the stored asset, and a human might paste a
  // citation whose PDF another contributor already supplied. Opening (or
  // reopening) a request here would resurface an already-satisfied paper in the
  // queue. Instead, leave the asset in place and reconcile any lingering open
  // request to 'fulfilled' so the agent's follow-up review queue still picks it
  // up, then report the citation as already satisfied.
  const [existingPdf] = await db
    .select({ id: citationPdfs.id })
    .from(citationPdfs)
    .where(eq(citationPdfs.citationId, citationId))
    .limit(1);

  // Replacing stored full text is the deliberate exception to the guard
  // below. It exists because a stored PDF can be unusable — the wrong paper,
  // or a scan with no readable text layer — and every other path treats "a
  // PDF exists" as "this is settled", which left no way to swap it. Gated to
  // editor+ because it discards the previous asset.
  const wantsReplace = parsed.data.replace === true;
  if (
    wantsReplace &&
    !(await callerCan(auth.role, CAP['citation.pdf.replace']))
  ) {
    error(res, 403, 'Editor role required', 'pdf_replace_requires_editor');
    return;
  }

  // The stored PDF belongs to the CITATION, not to any one extraction job, so
  // swapping it while a job is queued or claimed silently changes the input
  // that job was queued with — and if it is already claimed, mid-read. A
  // citation can easily have settled history alongside a newer open job, so
  // this is reachable from the queue page's own cards. Refuse at the API
  // rather than only hiding the button: the UI check is a courtesy, this is
  // the guarantee. Cancel the open job first, then replace, then re-queue.
  if (wantsReplace) {
    const [openJob] = await db
      .select({ id: paperExtractionJobs.id })
      .from(paperExtractionJobs)
      .where(
        and(
          eq(paperExtractionJobs.citationId, citationId),
          inArray(paperExtractionJobs.status, ['queued', 'claimed']),
        ),
      )
      .limit(1);
    if (openJob) {
      error(
        res,
        409,
        'An extraction job for this paper is still open; cancel it before replacing the full text',
        'pdf_replace_extraction_in_flight',
      );
      return;
    }
  }

  if (existingPdf && !wantsReplace) {
    const [existingRequest] = await db
      .select(publicPdfRequestColumns)
      .from(pdfRequests)
      .where(eq(pdfRequests.citationId, citationId))
      .limit(1);

    // "Open request + stored PDF" used to have exactly one meaning — a stale
    // request the agent re-filed after someone already supplied the full text
    // — which is why reconciling it to `fulfilled` was right. Replacement gave
    // that same state a second meaning, and for a replacement the
    // reconciliation is precisely wrong: it closes the editor's only upload
    // authorization (the routes require an OPEN request) and leaves the bad
    // PDF in place. The review agent re-files on every paywalled pass, so this
    // is a routine trigger, not a rare one. Leave a replacement open.
    if (
      existingRequest &&
      existingRequest.status === 'open' &&
      !existingRequest.isReplacement
    ) {
      const [reconciled] = await db
        .update(pdfRequests)
        .set({ status: 'fulfilled', fulfilledAt: new Date() })
        .where(
          and(
            eq(pdfRequests.citationId, citationId),
            eq(pdfRequests.status, 'open'),
            // Also in the WHERE, not just the branch guard: an editor may open
            // a replacement between the read above and this write.
            eq(pdfRequests.isReplacement, false),
          ),
        )
        .returning(publicPdfRequestColumns);
      json(
        res,
        200,
        { request: reconciled ?? existingRequest, hasPdf: true },
        { headers: noStoreHeaders() },
      );
      return;
    }

    json(
      res,
      200,
      { request: existingRequest ?? null, hasPdf: true },
      { headers: noStoreHeaders() },
    );
    return;
  }

  const now = new Date();
  const [row] = await db
    .insert(pdfRequests)
    .values({
      citationId,
      status: 'open',
      reason: parsed.data.reason ?? null,
      isReplacement: wantsReplace,
      requestedBy: auth.userId,
      fulfilledBy: null,
      fulfilledAt: null,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: pdfRequests.citationId,
      set: {
        status: 'open',
        // Set explicitly in BOTH directions: an ordinary re-request on a row
        // that once carried a replacement must clear the flag, or it would
        // keep an editor-only gate on a request that is no longer one.
        isReplacement: wantsReplace,
        reason: parsed.data.reason ?? null,
        requestedBy: auth.userId,
        fulfilledBy: null,
        fulfilledAt: null,
        createdAt: now,
      },
    })
    .returning();

  json(res, 201, { request: row }, { headers: noStoreHeaders() });
}
