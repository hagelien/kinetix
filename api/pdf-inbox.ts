/**
 * The PDF inbox — bulk-dropped full text waiting to be linked to a citation.
 *
 *   GET                       — the pending items, with what was read out of
 *                               each file and the citations it may belong to
 *   GET  ?countOnly=1         — how many are waiting (header badge)
 *   GET  ?status=attached     — the audit trail of links already made
 *   POST ?id=N&citationId=M   — link this file to that citation
 *   POST ?id=N&action=rematch — re-run matching for one item
 *   POST ?action=autoAttach   — link every item whose match is unambiguous
 *   DELETE ?id=N              — discard an item, and its bytes, unlinked
 *
 * Why `autoAttach` exists as an explicit action as well as an automatic step
 * at upload time: the citation corpus grows. A paper dropped in on Monday may
 * have had no citation to match to, and have one by Wednesday because an agent
 * cited it. Re-running the match over the whole inbox is the cheap way to
 * collect that, and it is the same code path the uploader takes — so a
 * link made a day later is indistinguishable from one made on arrival.
 *
 * Note on who may call this: `pdfInbox.resolve` is a contributor capability
 * because attaching produces exactly the state a contributor already produces
 * by uploading from a reference page. It is explicitly NOT authority to
 * overwrite full text already on file — that check (`citation.pdf.replace`)
 * is made separately, per attach, in `attachInboxItem`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import {
  json,
  error,
  noStoreHeaders,
  withErrorHandling,
} from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin } from './_lib/validate.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import { citations, pdfInboxItems } from '../db/schema.js';
import {
  mayAutoAttach,
  matchInboxItem,
  type MatchCandidate,
  type MatchConfidence,
} from './_lib/pdf-inbox-match.js';
import {
  InboxAttachError,
  attachInboxItem,
  countPendingBlobCleanups,
  discardInboxItem,
  recordAttachFailure,
  retryPendingBlobDeletions,
  saveMatch,
} from './_lib/pdf-inbox-store.js';
import { MAX_PENDING_INBOX_ITEMS } from './pdf-inbox-upload.js';

/** Most items returned in one listing. The inbox is capped well below this. */
const LIST_LIMIT = 500;

/**
 * Most items one `autoAttach` sweep will attach before it stops.
 *
 * Each attach is its own transaction, so a sweep is a loop of round trips and
 * a large inbox would run past a serverless function's time budget — leaving
 * the caller with a timeout and no idea how much of the work landed. Bounding
 * it means the answer is always complete and honest ("linked 50, N left"), and
 * the caller simply runs it again.
 */
const AUTO_ATTACH_TARGET = 50;

/**
 * Most items one sweep may inspect while looking for that many attaches.
 *
 * This has to cover the whole inbox (`MAX_PENDING_INBOX_ITEMS`), not just one
 * batch's worth: unmatchable items (scans with no text layer, DOIs with no
 * citation yet) sort no differently from matchable ones, so a smaller inspect
 * limit lets a run of them at the front of the queue permanently shadow an
 * exact match sitting behind them — every sweep re-selects the same stuck
 * items and never reaches the rest.
 */
const AUTO_ATTACH_SCAN_LIMIT = MAX_PENDING_INBOX_ITEMS;

/**
 * The columns a client may see. `blob_pathname` and `blob_url` are withheld
 * for the same reason `citation_pdfs` withholds them: an unlinked item is
 * still licensed full text, and the URL is the only thing standing between a
 * private object and anyone holding it.
 */
const publicInboxColumns = {
  id: pdfInboxItems.id,
  originalFilename: pdfInboxItems.originalFilename,
  sizeBytes: pdfInboxItems.sizeBytes,
  status: pdfInboxItems.status,
  extracted: pdfInboxItems.extracted,
  candidates: pdfInboxItems.candidates,
  matchedCitationId: pdfInboxItems.matchedCitationId,
  matchConfidence: pdfInboxItems.matchConfidence,
  autoAttached: pdfInboxItems.autoAttached,
  attachedAt: pdfInboxItems.attachedAt,
  lastError: pdfInboxItems.lastError,
  createdAt: pdfInboxItems.createdAt,
};

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
      assertSameOrigin(req);
      return handlePost(req, res, url);
    case 'DELETE':
      assertSameOrigin(req);
      return handleDelete(req, res, url);
    default:
      error(res, 405, 'Method not allowed');
  }
});

/**
 * Resolve the caller and confirm they may work the inbox.
 *
 * Returns null and writes the response when they may not, so every handler
 * below opens with the same two lines and none of them can forget one.
 */
async function requireResolver(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ userId: number; role: string } | null> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return null;
  }
  if (!(await callerCan(auth.role, CAP['pdfInbox.resolve']))) {
    error(res, 403, 'Contributor role required');
    return null;
  }
  return { userId: auth.userId, role: auth.role };
}

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireResolver(req, res);
  if (!auth) return;
  const db = getDb();

  const countOnly = url.searchParams.get('countOnly');
  if (countOnly === '1' || countOnly === 'true') {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pdfInboxItems)
      .where(eq(pdfInboxItems.status, 'pending'));
    json(res, 200, { count: row?.count ?? 0 }, { headers: noStoreHeaders() });
    return;
  }

  const status = url.searchParams.get('status') ?? 'pending';
  if (status !== 'pending' && status !== 'attached' && status !== 'discarded') {
    error(res, 400, 'Invalid status');
    return;
  }

  const items = await db
    .select(publicInboxColumns)
    .from(pdfInboxItems)
    .where(eq(pdfInboxItems.status, status))
    .orderBy(desc(pdfInboxItems.createdAt))
    .limit(LIST_LIMIT);

  // Every citation the listing mentions — the chosen match and every
  // alternative — resolved in one query. The candidates already carry a
  // denormalised copy from match time, but a title edited since would render
  // stale, and a queue whose purpose is "is this the right paper?" cannot
  // afford to show an out-of-date answer to exactly that question.
  const citationIds = new Set<number>();
  for (const item of items) {
    if (item.matchedCitationId !== null) citationIds.add(item.matchedCitationId);
    for (const candidate of readCandidates(item.candidates)) {
      citationIds.add(candidate.citationId);
    }
  }
  const citationRows =
    citationIds.size === 0
      ? []
      : await db
          .select({
            id: citations.id,
            type: citations.type,
            identifier: citations.identifier,
            metadata: citations.metadata,
            createdAt: citations.createdAt,
          })
          .from(citations)
          .where(inArray(citations.id, [...citationIds]));

  // How many discarded objects are still awaiting deletion. The sweep is what
  // retries them, so the client needs this to keep that action reachable even
  // when the inbox has nothing pending — otherwise a failed discard on the last
  // item leaves the object with no way to trigger the retry.
  const cleanupPending = await countPendingBlobCleanups();

  json(
    res,
    200,
    { items, citations: citationRows, cleanupPending },
    { headers: noStoreHeaders() },
  );
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireResolver(req, res);
  if (!auth) return;

  const action = url.searchParams.get('action');
  if (action === 'autoAttach') return handleAutoAttach(res, auth);

  const itemId = Number(url.searchParams.get('id'));
  if (!itemId || !Number.isInteger(itemId) || itemId <= 0) {
    error(res, 400, 'Missing or invalid id');
    return;
  }

  if (action === 'rematch') return handleRematch(res, itemId);

  const citationId = Number(url.searchParams.get('citationId'));
  if (!citationId || !Number.isInteger(citationId) || citationId <= 0) {
    error(res, 400, 'Missing or invalid citationId');
    return;
  }

  // Resolved once, here, rather than inside the attach: the capability belongs
  // to the caller, and the store's job is to apply it, not to look it up.
  const mayReplace = await callerCan(auth.role, CAP['citation.pdf.replace']);
  try {
    const result = await attachInboxItem({
      itemId,
      citationId,
      userId: auth.userId,
      mayReplace,
      auto: false,
    });
    json(res, 200, { attached: result }, { headers: noStoreHeaders() });
  } catch (err) {
    if (err instanceof InboxAttachError) {
      await recordAttachFailure(itemId, err.code).catch(() => undefined);
      error(res, statusForAttachFailure(err.code), attachMessage(err.code), err.code);
      return;
    }
    throw err;
  }
}

/**
 * Re-run matching for one item.
 *
 * The obvious trigger is "the citation did not exist yet". The subtler one is
 * that a citation's `metadata.altIds` crosswalk fills in over time — a row
 * filed under a PMID gains its DOI when a resolver runs — so the same file and
 * the same corpus can match today and not have matched yesterday.
 */
async function handleRematch(
  res: ServerResponse,
  itemId: number,
): Promise<void> {
  const db = getDb();
  const [item] = await db
    .select({
      id: pdfInboxItems.id,
      status: pdfInboxItems.status,
      extracted: pdfInboxItems.extracted,
    })
    .from(pdfInboxItems)
    .where(eq(pdfInboxItems.id, itemId))
    .limit(1);
  if (!item) {
    error(res, 404, 'Inbox item not found', 'inbox_item_not_found');
    return;
  }
  if (item.status !== 'pending') {
    error(res, 409, 'This item is no longer pending', 'inbox_item_not_pending');
    return;
  }
  const match = await matchInboxItem(db, readExtracted(item.extracted));
  await saveMatch(itemId, match);
  json(res, 200, { match }, { headers: noStoreHeaders() });
}

/**
 * Link everything whose match is beyond doubt, in one call.
 *
 * "Beyond doubt" is `mayAutoAttach`: a registered identifier read from the
 * document itself, resolving to exactly one citation that has no full text on
 * file. Deliberately re-matched first rather than trusting the stored grading
 * — the stored one is a snapshot of a corpus that has since changed, and the
 * whole reason to run this sweep is that it has.
 */
async function handleAutoAttach(
  res: ServerResponse,
  auth: { userId: number; role: string },
): Promise<void> {
  const db = getDb();

  // Clear any objects a previous discard failed to delete. This is the
  // operator-initiated "work the inbox" action, so it is the natural place to
  // retry: it happens whenever somebody is actually using the feature, and
  // the count comes back in the response rather than disappearing into a log.
  const cleaned = await retryPendingBlobDeletions();

  const pending = await db
    .select({
      id: pdfInboxItems.id,
      extracted: pdfInboxItems.extracted,
    })
    .from(pdfInboxItems)
    .where(eq(pdfInboxItems.status, 'pending'))
    .orderBy(pdfInboxItems.createdAt)
    .limit(AUTO_ATTACH_SCAN_LIMIT);

  const attached: Array<{ itemId: number; citationId: number }> = [];
  const failed: Array<{ itemId: number; code: string }> = [];
  let scanned = 0;

  for (const item of pending) {
    scanned += 1;
    const match = await matchInboxItem(db, readExtracted(item.extracted));
    await saveMatch(item.id, match);
    if (mayAutoAttach(match) && match.citationId !== null) {
      try {
        await attachInboxItem({
          itemId: item.id,
          citationId: match.citationId,
          userId: auth.userId,
          // A sweep never replaces. `mayAutoAttach` already refuses a citation
          // that has full text, so this only makes the rule structural — but the
          // caller may well hold the editor capability, and a bulk action is the
          // last place to let it apply silently.
          mayReplace: false,
          auto: true,
        });
        attached.push({ itemId: item.id, citationId: match.citationId });
      } catch (err) {
        const code = err instanceof InboxAttachError ? err.code : 'attach_failed';
        await recordAttachFailure(item.id, code).catch(() => undefined);
        failed.push({ itemId: item.id, code });
      }
    }
    // Stop once this sweep has done a batch's worth of linking, not once it
    // has merely looked at a batch's worth of items. Unmatchable items it
    // scanned past stay pending and cost a match query again next time, but
    // every item this sweep attached is gone from the pending set for good,
    // so a run of stuck items at the front no longer prevents forward
    // progress the way a fixed 50-row scan window did.
    if (attached.length >= AUTO_ATTACH_TARGET) break;
  }

  const [remaining] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pdfInboxItems)
    .where(eq(pdfInboxItems.status, 'pending'));

  json(
    res,
    200,
    {
      attached,
      failed,
      // Says plainly whether the sweep saw the whole inbox, so a caller with
      // more still unreached knows to run it again rather than concluding the
      // rest are unmatchable. Re-running is meaningful even when nothing was
      // matched this pass: the items scanned this time are no longer at the
      // front of the pending queue, so a further sweep reaches new ground.
      scanned,
      truncated: scanned < pending.length,
      pending: remaining?.count ?? 0,
      /** Objects from earlier failed discards that this pass finally removed. */
      cleaned,
    },
    { headers: noStoreHeaders() },
  );
}

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await requireResolver(req, res);
  if (!auth) return;
  const itemId = Number(url.searchParams.get('id'));
  if (!itemId || !Number.isInteger(itemId) || itemId <= 0) {
    error(res, 400, 'Missing or invalid id');
    return;
  }
  try {
    await discardInboxItem(itemId);
    json(res, 200, { discarded: itemId }, { headers: noStoreHeaders() });
  } catch (err) {
    if (err instanceof InboxAttachError) {
      error(
        res,
        409,
        'Only a pending inbox item can be discarded',
        'inbox_item_not_pending',
      );
      return;
    }
    throw err;
  }
}

// ─── shapes stored as jsonb ────────────────────────────────────────────────
//
// These come back from the database as `unknown`. Nothing outside this system
// writes them, but they are still read defensively: a row written by an older
// release must degrade to "no candidates" rather than throwing inside a
// listing that would otherwise have rendered every other row fine.

function readCandidates(value: unknown): MatchCandidate[] {
  return Array.isArray(value) ? (value as MatchCandidate[]) : [];
}

function readExtracted(value: unknown): {
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  title: string | null;
  year: number | null;
  sources: Record<string, never>;
} {
  const raw = (value ?? {}) as Record<string, unknown>;
  const text = (key: string): string | null =>
    typeof raw[key] === 'string' && raw[key] !== '' ? (raw[key] as string) : null;
  return {
    doi: text('doi'),
    pmid: text('pmid'),
    pmcid: text('pmcid'),
    title: text('title'),
    year: typeof raw.year === 'number' ? raw.year : null,
    sources: (typeof raw.sources === 'object' && raw.sources !== null
      ? raw.sources
      : {}) as Record<string, never>,
  };
}

function statusForAttachFailure(code: string): number {
  if (code === 'inbox_item_not_found' || code === 'citation_not_found') return 404;
  if (code === 'pdf_replace_requires_editor') return 403;
  return 409;
}

function attachMessage(code: string): string {
  switch (code) {
    case 'inbox_item_not_found':
      return 'Inbox item not found';
    case 'inbox_item_not_pending':
      return 'This item has already been linked or discarded';
    case 'citation_not_found':
      return 'Citation not found';
    case 'pdf_request_unresolvable_citation':
      return 'Full text can only be attached to a resolvable citation';
    case 'pdf_replace_requires_editor':
      return 'Replacing stored full text requires the editor role';
    case 'pdf_replace_extraction_in_flight':
      return 'An extraction job for this paper is still open';
    case 'inbox_attach_conflict':
      return 'Another link reached this reference first; try again';
    default:
      return 'Could not link this PDF';
  }
}

export type InboxMatchConfidence = MatchConfidence;
