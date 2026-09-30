/**
 * Turning an inbox item into a citation's stored full text.
 *
 * The inbox exists so bytes can arrive before anyone knows which paper they
 * are. Attaching is the moment that ends: from here on the file is an ordinary
 * `citation_pdfs` row, indistinguishable from one uploaded through the
 * reference page, and every downstream gate — the read-in-full review, the
 * agent's follow-up queue, the extraction queue — behaves exactly as it always
 * has. That equivalence is the point: the bulk path is a faster way to reach
 * the same state, never a second, weaker state.
 *
 * Two invariants therefore have to survive the shortcut:
 *
 *   1. **A stored PDF is authorized by a request.** Both existing fulfilment
 *      routes demand an open `pdf_requests` row, and the agent's follow-up
 *      queue reads the *fulfilled* rows to find papers awaiting review. An
 *      attach that skipped the request row would deliver full text that no
 *      reviewer is ever told about. So it opens one when none exists and
 *      closes it in the same breath.
 *   2. **Replacing stored full text is an editor's decision.** Everywhere else
 *      that is gated (`citation.pdf.replace`) because it discards an asset and
 *      invalidates the review written about the bytes that were there. Dropping
 *      a folder must not become a side door around it.
 *
 * Everything runs in one transaction, because the failure it prevents is
 * specific and bad: the request closed with no asset recorded would leave a
 * paper that the follow-up queue calls "supplied, awaiting review" and the
 * reference page calls "full text missing", with no upload path open to fix it.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { del } from '@vercel/blob';
import { getDb, runInPoolTransaction } from './db.js';
import {
  citationPdfs,
  citations,
  paperExtractionJobs,
  paperReviews,
  pdfInboxItems,
  pdfRequests,
} from '../../db/schema.js';
import type { MatchCandidate, MatchConfidence } from './pdf-inbox-match.js';

/** Why an attach could not happen, in the vocabulary the API returns. */
export type AttachFailure =
  | 'inbox_item_not_found'
  | 'inbox_item_not_pending'
  | 'citation_not_found'
  | 'pdf_request_unresolvable_citation'
  | 'pdf_replace_requires_editor'
  | 'pdf_replace_extraction_in_flight'
  /**
   * Another attach reached this citation's stored PDF between the check and
   * the write. Nothing was changed; retrying re-reads the citation and either
   * succeeds or refuses with the replacement error it should have.
   */
  | 'inbox_attach_conflict';

export class InboxAttachError extends Error {
  constructor(public readonly code: AttachFailure) {
    super(code);
    this.name = 'InboxAttachError';
  }
}

export interface AttachOptions {
  itemId: number;
  citationId: number;
  userId: number;
  /**
   * Whether this caller holds `citation.pdf.replace`. Passed in rather than
   * resolved here so the capability lookup stays on the route, next to the
   * auth it belongs to — and so this module has exactly one reason to refuse.
   */
  mayReplace: boolean;
  /** True when the matcher attached this with no human in the loop. */
  auto: boolean;
}

export interface AttachResult {
  citationId: number;
  /** The attach overwrote full text that was already on file. */
  replaced: boolean;
}

/**
 * Link one inbox item to one citation.
 *
 * The inbox row is locked for the duration, which is what makes a bulk
 * "attach everything obvious" safe to run concurrently with a human clicking
 * the same row: the loser sees `inbox_item_not_pending` rather than attaching
 * the same bytes twice under two different requests.
 */
export async function attachInboxItem(
  options: AttachOptions,
): Promise<AttachResult> {
  const { itemId, citationId, userId, mayReplace, auto } = options;

  const { result, supersededBlobUrl } = await runInPoolTransaction(async (tx) => {
    // SELECT ... FOR UPDATE, so two attaches of the same item serialise here
    // instead of racing through the checks below.
    const [item] = await tx
      .select({
        id: pdfInboxItems.id,
        status: pdfInboxItems.status,
        blobPathname: pdfInboxItems.blobPathname,
        blobUrl: pdfInboxItems.blobUrl,
        sizeBytes: pdfInboxItems.sizeBytes,
        sha256: pdfInboxItems.sha256,
        contentType: pdfInboxItems.contentType,
      })
      .from(pdfInboxItems)
      .where(eq(pdfInboxItems.id, itemId))
      .limit(1)
      .for('update');
    if (!item) throw new InboxAttachError('inbox_item_not_found');
    if (item.status !== 'pending') {
      throw new InboxAttachError('inbox_item_not_pending');
    }

    // SELECT ... FOR UPDATE on the CITATION, which is the row every attach
    // targeting this paper has in common — the inbox lock above only
    // serialises two attempts on the same *file*.
    //
    // Without it, two different files matching one citation (the same paper
    // downloaded twice, or an article and its own preprint, both carrying the
    // stamped DOI) can be attached concurrently — which a bulk drop makes
    // ordinary, since uploads run three completion callbacks in parallel.
    // Both would read `citation_pdfs` as empty, both would conclude they are
    // not replacing anything, and the second would then overwrite the first
    // through the upsert below: `mayReplace` never consulted, the read-in-full
    // attestation never withdrawn, and the first file's blob orphaned with its
    // inbox row still claiming it was attached.
    //
    // The citation row always exists (a `citation_pdfs` row may not), so it is
    // the only thing available to lock. Lock order is item → citation
    // throughout, so two attaches cannot deadlock against each other.
    const [citation] = await tx
      .select({ id: citations.id, type: citations.type })
      .from(citations)
      .where(eq(citations.id, citationId))
      .limit(1)
      .for('update');
    if (!citation) throw new InboxAttachError('citation_not_found');
    // A freetext citation names no paper, so there is nothing for a PDF to be
    // the full text *of*. Same refusal `POST /api/pdf-requests` gives.
    if (citation.type === 'freetext') {
      throw new InboxAttachError('pdf_request_unresolvable_citation');
    }

    const [existingPdf] = await tx
      .select({ id: citationPdfs.id, blobUrl: citationPdfs.blobUrl })
      .from(citationPdfs)
      .where(eq(citationPdfs.citationId, citationId))
      .limit(1);
    const replacing = existingPdf !== undefined;

    if (replacing) {
      if (!mayReplace) throw new InboxAttachError('pdf_replace_requires_editor');
      // The stored PDF belongs to the citation, not to any one job, so
      // swapping it while a job is queued (or claimed, i.e. mid-read) changes
      // the input that job was given. Same refusal the other replace paths
      // give; cancel the job, then replace, then re-queue.
      const [openJob] = await tx
        .select({ id: paperExtractionJobs.id })
        .from(paperExtractionJobs)
        .where(
          and(
            eq(paperExtractionJobs.citationId, citationId),
            inArray(paperExtractionJobs.status, ['queued', 'claimed']),
          ),
        )
        .limit(1);
      if (openJob) throw new InboxAttachError('pdf_replace_extraction_in_flight');
    }

    const now = new Date();

    // The request row: reuse whatever is there (an agent's open request, a
    // stale fulfilled one) rather than minting a parallel record. `citation_id`
    // is unique on this table, so there is exactly one lifecycle per paper and
    // this attach is its latest event.
    await tx
      .insert(pdfRequests)
      .values({
        citationId,
        status: 'fulfilled',
        reason: null,
        isReplacement: replacing,
        requestedBy: userId,
        fulfilledBy: userId,
        fulfilledAt: now,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: pdfRequests.citationId,
        set: {
          status: 'fulfilled',
          // Recorded for what this attach actually did, in both directions:
          // an ordinary attach onto a row that once carried a replacement must
          // clear the flag, exactly as `POST /api/pdf-requests` does.
          isReplacement: replacing,
          fulfilledBy: userId,
          fulfilledAt: now,
        },
      });

    // Defence in depth behind the citation lock: the upsert may only touch the
    // exact row this attach was authorized against.
    //
    // When we saw no stored PDF, a conflict means one appeared anyway, so the
    // DO UPDATE is disarmed (`false`) and nothing is written. When we saw one,
    // the update is admitted only while it is still the row whose replacement
    // `mayReplace` and the extraction-job check were evaluated for — the same
    // optimistic lock a reviewer's decision takes on `submitted_at`. Either
    // way an unauthorized overwrite becomes an empty RETURNING, which the
    // check below turns into a failed attach rather than a silent swap.
    const [stored] = await tx
      .insert(citationPdfs)
      .values({
        citationId,
        blobPathname: item.blobPathname,
        blobUrl: item.blobUrl,
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
        contentType: item.contentType,
        source: 'upload',
        sourceUrl: null,
        uploadedBy: userId,
      })
      .onConflictDoUpdate({
        target: citationPdfs.citationId,
        set: {
          blobPathname: item.blobPathname,
          blobUrl: item.blobUrl,
          sizeBytes: item.sizeBytes,
          sha256: item.sha256,
          contentType: item.contentType,
          source: 'upload',
          sourceUrl: null,
          uploadedBy: userId,
          createdAt: now,
        },
        setWhere: existingPdf
          ? eq(citationPdfs.blobUrl, existingPdf.blobUrl)
          : sql`false`,
      })
      .returning({ id: citationPdfs.id });
    if (!stored) throw new InboxAttachError('inbox_attach_conflict');

    // Replacing the bytes invalidates the appraisal of the bytes that were
    // there. `paper_reviews` is keyed by citation and the read-in-full gate
    // resolves on that key alone, so a review left standing beside replaced
    // full text would keep authorizing facts drawn from a document nobody
    // read. Identical to what `recordCitationPdf` does on the one-at-a-time
    // path — the bulk path must not be the one that forgets.
    if (replacing) {
      await tx
        .update(paperReviews)
        .set({ readInFull: false, updatedAt: now })
        .where(
          and(
            eq(paperReviews.citationId, citationId),
            eq(paperReviews.readInFull, true),
          ),
        );
    }

    await tx
      .update(pdfInboxItems)
      .set({
        status: 'attached',
        matchedCitationId: citationId,
        attachedAt: now,
        attachedBy: userId,
        autoAttached: auto,
        lastError: null,
      })
      .where(eq(pdfInboxItems.id, itemId));

    return {
      result: { citationId, replaced: replacing },
      // Only meaningful when it is a *different* object; the same blob being
      // re-recorded (a rematch onto the same citation) must not be deleted.
      supersededBlobUrl:
        existingPdf && existingPdf.blobUrl !== item.blobUrl
          ? existingPdf.blobUrl
          : null,
    };
  });

  // After the commit, never before: deleting the old object while the
  // transaction could still roll back would leave a citation pointing at bytes
  // that no longer exist. Best-effort — an orphaned blob costs storage, a
  // missing one costs the paper.
  if (supersededBlobUrl) {
    await del(supersededBlobUrl).catch(() => undefined);
  }
  return result;
}

/**
 * Drop an inbox item nobody wants, and the bytes with it.
 *
 * Only ever a *pending* item: an attached one no longer owns its blob —
 * `citation_pdfs` does — and deleting it here would take a paper's full text
 * with it. The attached row stays as the audit record of how that link was
 * made.
 *
 * The object delete is best-effort but never silent. A human clearing their
 * queue must not be blocked by a Blob outage, so the row is discarded either
 * way; but a discarded row with a null `blob_deleted_at` records that the
 * bytes may still be in the store, which is what {@link retryPendingBlobDeletions}
 * re-attempts. Swallowing the failure instead would retain licensed full text
 * indefinitely behind a UI that says it is gone, with nothing to find it by.
 */
export async function discardInboxItem(itemId: number): Promise<void> {
  const db = getDb();
  const [discarded] = await db
    .update(pdfInboxItems)
    .set({ status: 'discarded', blobDeletedAt: null })
    .where(and(eq(pdfInboxItems.id, itemId), eq(pdfInboxItems.status, 'pending')))
    .returning({ blobUrl: pdfInboxItems.blobUrl });
  if (!discarded) throw new InboxAttachError('inbox_item_not_pending');
  await deleteDiscardedBlob(itemId, discarded.blobUrl);
}

/**
 * Delete one discarded item's object and record the outcome on its row.
 *
 * A 404 from the store counts as success: the object being absent is the state
 * this is trying to reach, and re-queueing a delete for bytes that are already
 * gone would retry forever.
 */
async function deleteDiscardedBlob(
  itemId: number,
  blobUrl: string,
): Promise<boolean> {
  const db = getDb();
  try {
    await del(blobUrl);
    await db
      .update(pdfInboxItems)
      .set({ blobDeletedAt: new Date(), lastError: null })
      .where(eq(pdfInboxItems.id, itemId));
    return true;
  } catch (err) {
    await db
      .update(pdfInboxItems)
      .set({
        lastError: `blob_delete_failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      })
      .where(eq(pdfInboxItems.id, itemId))
      // The row is already discarded and `blob_deleted_at` is already null, so
      // the retry queue holds it whether or not this note lands.
      .catch(() => undefined);
    return false;
  }
}

/**
 * How many stale objects one cleanup pass will try to remove. Bounded for the
 * same reason the attach sweep is: each is a round trip to the Blob store, and
 * a pass that runs past a function's time budget reports nothing at all.
 */
const BLOB_CLEANUP_BATCH = 25;

/**
 * Re-attempt the deletes that failed, oldest first.
 *
 * Runs as part of the attach sweep rather than on a schedule of its own: the
 * sweep is the operator-initiated "work the inbox" action, so the retry
 * happens whenever somebody is actually using the feature, and its result is
 * reported back with the rest rather than disappearing into a log.
 */
export async function retryPendingBlobDeletions(): Promise<number> {
  const stale = await getDb()
    .select({ id: pdfInboxItems.id, blobUrl: pdfInboxItems.blobUrl })
    .from(pdfInboxItems)
    .where(
      and(
        eq(pdfInboxItems.status, 'discarded'),
        isNull(pdfInboxItems.blobDeletedAt),
      ),
    )
    .orderBy(pdfInboxItems.createdAt)
    .limit(BLOB_CLEANUP_BATCH);

  let cleaned = 0;
  for (const item of stale) {
    if (await deleteDiscardedBlob(item.id, item.blobUrl)) cleaned += 1;
  }
  return cleaned;
}

/** Persist a fresh grading for an item whose match was recomputed. */
export async function saveMatch(
  itemId: number,
  match: { candidates: MatchCandidate[]; confidence: MatchConfidence; citationId: number | null },
): Promise<void> {
  await getDb()
    .update(pdfInboxItems)
    .set({
      candidates: match.candidates,
      matchConfidence: match.confidence,
      matchedCitationId: match.citationId,
    })
    .where(and(eq(pdfInboxItems.id, itemId), eq(pdfInboxItems.status, 'pending')));
}

/** Record why an attach attempt failed, so a bulk run does not fail silently. */
export async function recordAttachFailure(
  itemId: number,
  code: string,
): Promise<void> {
  await getDb()
    .update(pdfInboxItems)
    .set({ lastError: code })
    .where(eq(pdfInboxItems.id, itemId));
}

/**
 * Citations with something waiting unlinked in the inbox.
 *
 * Read by the PDF-request queue so a paper whose full text is already sitting
 * here, matched but unconfirmed, does not keep advertising itself as missing —
 * the contributor would go and fetch a copy that is already on the premises.
 */
export async function citationsWithPendingInboxItems(
  citationIds: number[],
): Promise<Set<number>> {
  if (citationIds.length === 0) return new Set();
  const rows = await getDb()
    .select({ citationId: pdfInboxItems.matchedCitationId })
    .from(pdfInboxItems)
    .where(
      and(
        eq(pdfInboxItems.status, 'pending'),
        inArray(pdfInboxItems.matchedCitationId, citationIds),
      ),
    );
  return new Set(
    rows
      .map((row) => row.citationId)
      .filter((id): id is number => id !== null),
  );
}

/**
 * How many discarded items still have bytes that may be in the store.
 *
 * Surfaced to the client so the sweep — which is what retries these — stays
 * reachable even when the inbox itself is empty. Without it, a failed discard
 * on the last pending item would leave the object with nothing anywhere able
 * to trigger the retry.
 */
export async function countPendingBlobCleanups(): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(pdfInboxItems)
    .where(
      and(
        eq(pdfInboxItems.status, 'discarded'),
        isNull(pdfInboxItems.blobDeletedAt),
      ),
    );
  return row?.count ?? 0;
}

/** How many items are sitting in the inbox waiting to be linked. */
export async function countPendingInboxItems(): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(pdfInboxItems)
    .where(eq(pdfInboxItems.status, 'pending'));
  return row?.count ?? 0;
}
