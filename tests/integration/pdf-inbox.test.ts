/**
 * The bulk PDF drop-off, against the real migrated schema.
 *
 * Almost everything load-bearing here is invisible to a mocked unit test: the
 * matcher's handle lookup is hand-written SQL that reaches into
 * `metadata->'altIds'`, the de-duplication is a *partial* unique index, and
 * the attach is a multi-table transaction that must leave a paper in exactly
 * the state a one-at-a-time upload would have left it in — a `citation_pdfs`
 * row, a fulfilled `pdf_requests` row feeding the agent's follow-up queue,
 * and, on a replacement, a withdrawn read-in-full attestation.
 *
 * That last equivalence is the point of the whole feature and the thing worth
 * guarding: the bulk path exists to be faster, never to be a weaker path that
 * skips a gate the careful one holds.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  citationPdfs,
  citations,
  paperExtractionJobs,
  paperReviews,
  pdfInboxItems,
  pdfRequests,
} from '../../db/schema.js';
import { matchInboxItem, mayAutoAttach } from '../../api/_lib/pdf-inbox-match.js';
import { mergeCitations } from '../../api/_lib/citation-merge.js';
import {
  InboxAttachError,
  attachInboxItem,
  citationsWithPendingInboxItems,
  countPendingInboxItems,
  discardInboxItem,
  retryPendingBlobDeletions,
} from '../../api/_lib/pdf-inbox-store.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

// The store deletes Blob objects on discard and on replacement. There is no
// Blob store here, so stub the SDK — and keep a handle on it, because whether
// a delete succeeded is now recorded on the row and retried when it did not.
const { delMock } = vi.hoisted(() => ({ delMock: vi.fn(async () => undefined) }));
vi.mock('@vercel/blob', () => ({ del: delMock }));

let db: IntegrationDb;
let userId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  userId = await seedUser(db);
  delMock.mockReset();
  delMock.mockResolvedValue(undefined);
});

async function seedCitation(
  type: 'pmid' | 'doi' | 'url' | 'freetext',
  identifier: string,
  metadata: Record<string, unknown> | null = null,
): Promise<number> {
  const [row] = await db
    .insert(citations)
    .values({ type, identifier, metadata })
    .returning({ id: citations.id });
  return row!.id;
}

let shaCounter = 0;
async function seedInboxItem(
  over: Partial<typeof pdfInboxItems.$inferInsert> = {},
): Promise<number> {
  shaCounter += 1;
  const [row] = await db
    .insert(pdfInboxItems)
    .values({
      blobPathname: `pdf-inbox/dropped-${shaCounter}.pdf`,
      blobUrl: `https://blob.example/pdf-inbox/dropped-${shaCounter}.pdf`,
      sizeBytes: 1024,
      sha256: String(shaCounter).padStart(64, '0'),
      contentType: 'application/pdf',
      originalFilename: `paper-${shaCounter}.pdf`,
      uploadedBy: userId,
      ...over,
    })
    .returning({ id: pdfInboxItems.id });
  return row!.id;
}

function extracted(over: Record<string, unknown> = {}) {
  return {
    doi: null,
    pmid: null,
    pmcid: null,
    title: null,
    year: null,
    sources: {},
    ...over,
  } as Parameters<typeof matchInboxItem>[1];
}

describe('matching an inbox PDF against the citation corpus', () => {
  it('finds a citation by its own DOI handle', async () => {
    const citationId = await seedCitation('doi', '10.1016/j.jpba.2020.113456');
    const match = await matchInboxItem(
      db,
      extracted({ doi: '10.1016/j.jpba.2020.113456', sources: { doi: 'xmp' } }),
    );
    expect(match.confidence).toBe('exact');
    expect(match.citationId).toBe(citationId);
  });

  it('matches case-insensitively, because DOIs are', async () => {
    const citationId = await seedCitation('doi', '10.1016/J.JPBA.2020.113456');
    const match = await matchInboxItem(
      db,
      extracted({ doi: '10.1016/j.jpba.2020.113456', sources: { doi: 'xmp' } }),
    );
    expect(match.citationId).toBe(citationId);
  });

  it('finds a citation through its altIds crosswalk', async () => {
    // `citations` files one paper under exactly ONE handle. A paper this
    // database knows as a PMID is invisible to a DOI lookup that does not
    // consult the alt ids — and the DOI is what a publisher PDF stamps on
    // page one, so without this the commonest case would miss.
    const citationId = await seedCitation('pmid', '32155444', {
      title: 'Midazolam PK',
      altIds: { doi: '10.1016/j.jpba.2020.113456', pmcid: 'PMC7123456' },
    });

    const byDoi = await matchInboxItem(
      db,
      extracted({ doi: '10.1016/j.jpba.2020.113456', sources: { doi: 'xmp' } }),
    );
    expect(byDoi.citationId).toBe(citationId);

    const byPmcid = await matchInboxItem(
      db,
      extracted({ pmcid: 'PMC7123456', sources: { pmcid: 'text' } }),
    );
    expect(byPmcid.citationId).toBe(citationId);
  });

  it('counts a citation matching on two handles once, not twice', async () => {
    const citationId = await seedCitation('pmid', '32155444', {
      altIds: { doi: '10.1016/j.jpba.2020.113456' },
    });
    const match = await matchInboxItem(
      db,
      extracted({
        doi: '10.1016/j.jpba.2020.113456',
        pmid: '32155444',
        sources: { doi: 'xmp' },
      }),
    );
    expect(match.candidates).toHaveLength(1);
    expect(match.confidence).toBe('exact');
    expect(match.citationId).toBe(citationId);
  });

  it('drops to weak when a file names two different papers', async () => {
    // A supplement stamped with the article's DOI while its own PMID is
    // printed in the footer. Not resolvable from the file.
    await seedCitation('doi', '10.1016/j.jpba.2020.113456');
    await seedCitation('pmid', '32155444');
    const match = await matchInboxItem(
      db,
      extracted({
        doi: '10.1016/j.jpba.2020.113456',
        pmid: '32155444',
        sources: { doi: 'xmp' },
      }),
    );
    expect(match.confidence).toBe('weak');
    expect(match.citationId).toBeNull();
    expect(match.candidates).toHaveLength(2);
  });

  it('matches a near-identical title when no identifier resolves', async () => {
    // Trigram, not equality: the trailing full stop below is exactly the kind
    // of difference three metadata providers disagree about on every row.
    const citationId = await seedCitation('pmid', '111', {
      title: 'Population pharmacokinetics of midazolam in critically ill adults.',
    });
    const match = await matchInboxItem(
      db,
      extracted({
        title: 'Population pharmacokinetics of midazolam in critically ill adults',
        sources: { title: 'xmp' },
      }),
    );
    expect(match.candidates[0]?.citationId).toBe(citationId);
    // A title never reaches `exact`, however close — a corrigendum or a
    // reprint shares one with the paper it is not.
    expect(match.confidence).toBe('strong');
    expect(mayAutoAttach(match)).toBe(false);
  });

  it('ignores a title that merely shares a stock phrase', async () => {
    await seedCitation('pmid', '111', {
      title: 'Pharmacokinetics of paracetamol in healthy volunteers',
    });
    const match = await matchInboxItem(
      db,
      extracted({ title: 'A comparison of assay methods for ethanol in blood' }),
    );
    expect(match.confidence).toBe('none');
    expect(match.candidates).toHaveLength(0);
  });

  it('reports whether a candidate already has full text', async () => {
    const citationId = await seedCitation('doi', '10.1000/has-pdf');
    await db.insert(citationPdfs).values({
      citationId,
      blobPathname: 'citation-pdfs/x.pdf',
      blobUrl: 'https://blob.example/x.pdf',
      sizeBytes: 10,
      sha256: 'a'.repeat(64),
      contentType: 'application/pdf',
      source: 'upload',
    });
    const match = await matchInboxItem(
      db,
      extracted({ doi: '10.1000/has-pdf', sources: { doi: 'xmp' } }),
    );
    expect(match.confidence).toBe('exact');
    expect(match.candidates[0]?.hasPdf).toBe(true);
    // Exact identity, but attaching would overwrite — so not unattended.
    expect(mayAutoAttach(match)).toBe(false);
  });
});

describe('attaching an inbox item', () => {
  it('leaves exactly the state a one-at-a-time upload leaves', async () => {
    const citationId = await seedCitation('doi', '10.1000/new');
    const itemId = await seedInboxItem();

    const result = await attachInboxItem({
      itemId,
      citationId,
      userId,
      mayReplace: false,
      auto: true,
    });
    expect(result).toEqual({ citationId, replaced: false });

    const [pdf] = await db
      .select()
      .from(citationPdfs)
      .where(eq(citationPdfs.citationId, citationId));
    expect(pdf?.blobPathname).toBe(`pdf-inbox/dropped-${shaCounter}.pdf`);

    // The request row is what the agent's follow-up queue reads to find papers
    // awaiting review. An attach that skipped it would deliver full text no
    // reviewer is ever told about.
    const [request] = await db
      .select()
      .from(pdfRequests)
      .where(eq(pdfRequests.citationId, citationId));
    expect(request?.status).toBe('fulfilled');
    expect(request?.fulfilledBy).toBe(userId);

    const [item] = await db
      .select()
      .from(pdfInboxItems)
      .where(eq(pdfInboxItems.id, itemId));
    expect(item?.status).toBe('attached');
    expect(item?.matchedCitationId).toBe(citationId);
    expect(item?.autoAttached).toBe(true);
  });

  it('closes an open request the agent had already filed', async () => {
    const citationId = await seedCitation('doi', '10.1000/requested');
    await db
      .insert(pdfRequests)
      .values({ citationId, status: 'open', reason: 'paywalled' });
    const itemId = await seedInboxItem();

    await attachInboxItem({ itemId, citationId, userId, mayReplace: false, auto: false });

    const rows = await db
      .select()
      .from(pdfRequests)
      .where(eq(pdfRequests.citationId, citationId));
    // One lifecycle per paper — the attach is its latest event, not a second
    // parallel record.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('fulfilled');
  });

  it('refuses a freetext citation, which names no paper', async () => {
    const citationId = await seedCitation('freetext', 'Personal communication');
    const itemId = await seedInboxItem();
    await expect(
      attachInboxItem({ itemId, citationId, userId, mayReplace: false, auto: false }),
    ).rejects.toMatchObject({ code: 'pdf_request_unresolvable_citation' });
  });

  it('refuses to overwrite stored full text without the editor capability', async () => {
    const citationId = await seedCitation('doi', '10.1000/occupied');
    await db.insert(citationPdfs).values({
      citationId,
      blobPathname: 'citation-pdfs/old.pdf',
      blobUrl: 'https://blob.example/old.pdf',
      sizeBytes: 10,
      sha256: 'b'.repeat(64),
      contentType: 'application/pdf',
      source: 'upload',
    });
    const itemId = await seedInboxItem();

    await expect(
      attachInboxItem({ itemId, citationId, userId, mayReplace: false, auto: false }),
    ).rejects.toMatchObject({ code: 'pdf_replace_requires_editor' });

    // And nothing moved: the refusal is before any write.
    const [pdf] = await db
      .select()
      .from(citationPdfs)
      .where(eq(citationPdfs.citationId, citationId));
    expect(pdf?.blobPathname).toBe('citation-pdfs/old.pdf');
    const [item] = await db
      .select()
      .from(pdfInboxItems)
      .where(eq(pdfInboxItems.id, itemId));
    expect(item?.status).toBe('pending');
  });

  it('withdraws the read-in-full attestation when it does replace', async () => {
    // `paper_reviews` is keyed by CITATION and the reference gate resolves on
    // that key alone, so a review left standing beside replaced bytes would
    // keep authorizing facts drawn from a document nobody read.
    const citationId = await seedCitation('doi', '10.1000/replaced');
    await db.insert(citationPdfs).values({
      citationId,
      blobPathname: 'citation-pdfs/old.pdf',
      blobUrl: 'https://blob.example/old.pdf',
      sizeBytes: 10,
      sha256: 'c'.repeat(64),
      contentType: 'application/pdf',
      source: 'upload',
    });
    await db
      .insert(paperReviews)
      .values({ citationId, readInFull: true, reviewMarkdown: 'Lest i sin helhet.' });
    const itemId = await seedInboxItem();

    const result = await attachInboxItem({
      itemId,
      citationId,
      userId,
      mayReplace: true,
      auto: false,
    });
    expect(result.replaced).toBe(true);

    const [review] = await db
      .select()
      .from(paperReviews)
      .where(eq(paperReviews.citationId, citationId));
    expect(review?.readInFull).toBe(false);

    const [request] = await db
      .select()
      .from(pdfRequests)
      .where(eq(pdfRequests.citationId, citationId));
    expect(request?.isReplacement).toBe(true);
  });

  it('refuses to replace while an extraction job is still open', async () => {
    const citationId = await seedCitation('doi', '10.1000/in-flight');
    await db.insert(citationPdfs).values({
      citationId,
      blobPathname: 'citation-pdfs/old.pdf',
      blobUrl: 'https://blob.example/old.pdf',
      sizeBytes: 10,
      sha256: 'd'.repeat(64),
      contentType: 'application/pdf',
      source: 'upload',
    });
    await db
      .insert(paperExtractionJobs)
      .values({ citationId, status: 'claimed', requestedBy: userId });
    const itemId = await seedInboxItem();

    await expect(
      attachInboxItem({ itemId, citationId, userId, mayReplace: true, auto: false }),
    ).rejects.toMatchObject({ code: 'pdf_replace_extraction_in_flight' });
  });

  it('attaches an item only once', async () => {
    const first = await seedCitation('doi', '10.1000/first');
    const second = await seedCitation('doi', '10.1000/second');
    const itemId = await seedInboxItem();

    await attachInboxItem({ itemId, citationId: first, userId, mayReplace: false, auto: false });
    await expect(
      attachInboxItem({ itemId, citationId: second, userId, mayReplace: false, auto: false }),
    ).rejects.toMatchObject({ code: 'inbox_item_not_pending' });
  });

  it('reports a missing item and a missing citation distinctly', async () => {
    const citationId = await seedCitation('doi', '10.1000/exists');
    const itemId = await seedInboxItem();
    await expect(
      attachInboxItem({ itemId: 999_999, citationId, userId, mayReplace: false, auto: false }),
    ).rejects.toMatchObject({ code: 'inbox_item_not_found' });
    await expect(
      attachInboxItem({ itemId, citationId: 999_999, userId, mayReplace: false, auto: false }),
    ).rejects.toMatchObject({ code: 'citation_not_found' });
  });
});

describe('discarding', () => {
  it('marks a pending item discarded', async () => {
    const itemId = await seedInboxItem();
    await discardInboxItem(itemId);
    const [item] = await db
      .select()
      .from(pdfInboxItems)
      .where(eq(pdfInboxItems.id, itemId));
    expect(item?.status).toBe('discarded');
  });

  it('refuses to discard an attached item', async () => {
    // An attached item no longer owns its bytes — `citation_pdfs` does — so
    // discarding it would take a paper's full text with it.
    const citationId = await seedCitation('doi', '10.1000/attached');
    const itemId = await seedInboxItem();
    await attachInboxItem({ itemId, citationId, userId, mayReplace: false, auto: false });
    await expect(discardInboxItem(itemId)).rejects.toBeInstanceOf(InboxAttachError);

    const [pdf] = await db
      .select()
      .from(citationPdfs)
      .where(eq(citationPdfs.citationId, citationId));
    expect(pdf).toBeDefined();
  });

  it('records the object as gone when the delete succeeds', async () => {
    const itemId = await seedInboxItem();
    await discardInboxItem(itemId);
    const [item] = await db
      .select()
      .from(pdfInboxItems)
      .where(eq(pdfInboxItems.id, itemId));
    expect(item?.blobDeletedAt).not.toBeNull();
  });

  it('keeps a failed delete findable instead of swallowing it', async () => {
    // The row has already left the pending queue and the UI says "discarded",
    // so a silently-dropped failure retains licensed full text indefinitely
    // with nothing anywhere recording that it is still in the store.
    delMock.mockRejectedValueOnce(new Error('Blob store unreachable'));
    const itemId = await seedInboxItem();

    // The human is not blocked: the discard still happens.
    await discardInboxItem(itemId);

    const [item] = await db
      .select()
      .from(pdfInboxItems)
      .where(eq(pdfInboxItems.id, itemId));
    expect(item?.status).toBe('discarded');
    expect(item?.blobDeletedAt).toBeNull();
    expect(item?.lastError).toContain('blob_delete_failed');
  });

  it('retries a failed delete and marks it done once it lands', async () => {
    delMock.mockRejectedValueOnce(new Error('Blob store unreachable'));
    const itemId = await seedInboxItem();
    await discardInboxItem(itemId);

    expect(await retryPendingBlobDeletions()).toBe(1);

    const [item] = await db
      .select()
      .from(pdfInboxItems)
      .where(eq(pdfInboxItems.id, itemId));
    expect(item?.blobDeletedAt).not.toBeNull();
    expect(item?.lastError).toBeNull();
    // Once cleared it leaves the retry queue rather than being re-attempted
    // on every sweep forever.
    expect(await retryPendingBlobDeletions()).toBe(0);
  });

  it('never re-deletes an attached item\u2019s object', async () => {
    // `citation_pdfs` owns those bytes. A cleanup pass that touched them would
    // delete a paper's full text out from under every citing fact.
    const citationId = await seedCitation('doi', '10.1000/owned');
    const itemId = await seedInboxItem();
    await attachInboxItem({ itemId, citationId, userId, mayReplace: false, auto: false });
    delMock.mockClear();

    expect(await retryPendingBlobDeletions()).toBe(0);
    expect(delMock).not.toHaveBeenCalled();
  });
});

describe('de-duplication', () => {
  it('refuses a second pending row for identical bytes', async () => {
    // Dragging the same folder in twice is the normal way to use this. A
    // second row would offer the same paper for linking to a citation the
    // first already satisfied.
    const sha256 = 'e'.repeat(64);
    await seedInboxItem({ sha256 });
    await expect(seedInboxItem({ sha256 })).rejects.toThrow();
  });

  it('lets a discarded file be dropped again', async () => {
    // A discard is a statement about that upload ("wrong paper", "unreadable
    // scan"), not a permanent ban on the bytes — so a mistaken one must be
    // undoable by simply dropping the file again.
    const sha256 = 'f'.repeat(64);
    const itemId = await seedInboxItem({ sha256 });
    await discardInboxItem(itemId);
    await expect(seedInboxItem({ sha256 })).resolves.toBeGreaterThan(0);
  });
});

describe('surviving a citation merge', () => {
  // `pdf_inbox_items.matched_citation_id` is ON DELETE SET NULL, so a merge
  // that forgets this table does not fail — it quietly empties the column, and
  // both consequences are silent.

  it('repoints a pending item at the surviving citation', async () => {
    // Otherwise the row stops being reported by
    // `citationsWithPendingInboxItems`, and the PDF-request queue goes back to
    // telling a contributor the full text is missing while a copy sits
    // unlinked in the inbox — the exact wasted trip the inbox exists to stop.
    const winner = await seedCitation('pmid', '32155444');
    const loser = await seedCitation('doi', '10.1016/j.jpba.2020.113456');
    const itemId = await seedInboxItem({
      matchedCitationId: loser,
      matchConfidence: 'strong',
    });

    await mergeCitations(db, winner, loser);

    const [item] = await db
      .select()
      .from(pdfInboxItems)
      .where(eq(pdfInboxItems.id, itemId));
    expect(item?.matchedCitationId).toBe(winner);
    expect([...(await citationsWithPendingInboxItems([winner]))]).toEqual([winner]);
  });

  it('keeps an attached item\u2019s audit record pointing somewhere', async () => {
    // An attached row is the record of how a paper's full text came to be
    // linked. Null there means it no longer says which paper.
    const winner = await seedCitation('pmid', '111');
    const loser = await seedCitation('doi', '10.1000/loser');
    const itemId = await seedInboxItem();
    await attachInboxItem({
      itemId,
      citationId: loser,
      userId,
      mayReplace: false,
      auto: true,
    });

    await mergeCitations(db, winner, loser);

    const [item] = await db
      .select()
      .from(pdfInboxItems)
      .where(eq(pdfInboxItems.id, itemId));
    expect(item?.status).toBe('attached');
    expect(item?.matchedCitationId).toBe(winner);
  });

  it('rewrites the loser out of a stored candidate list', async () => {
    // The candidates are what the "Link" buttons are built from; one naming a
    // citation that no longer exists is a refusal the reader cannot act on.
    const winner = await seedCitation('pmid', '222');
    const loser = await seedCitation('doi', '10.1000/folded');
    const other = await seedCitation('doi', '10.1000/untouched');
    const itemId = await seedInboxItem({
      candidates: [
        { citationId: loser, via: 'doi', score: 1, hasPdf: false },
        { citationId: other, via: 'title', score: 0.8, hasPdf: false },
      ],
    });

    await mergeCitations(db, winner, loser);

    const [item] = await db
      .select()
      .from(pdfInboxItems)
      .where(eq(pdfInboxItems.id, itemId));
    const candidates = item?.candidates as Array<{ citationId: number }>;
    expect(candidates.map((candidate) => candidate.citationId)).toEqual([
      winner,
      other,
    ]);
  });

  it('leaves an item that never named the loser alone', async () => {
    const winner = await seedCitation('pmid', '333');
    const loser = await seedCitation('doi', '10.1000/irrelevant');
    const other = await seedCitation('doi', '10.1000/elsewhere');
    const itemId = await seedInboxItem({
      matchedCitationId: other,
      candidates: [{ citationId: other, via: 'doi', score: 1, hasPdf: false }],
    });

    await mergeCitations(db, winner, loser);

    const [item] = await db
      .select()
      .from(pdfInboxItems)
      .where(eq(pdfInboxItems.id, itemId));
    expect(item?.matchedCitationId).toBe(other);
    expect(
      (item?.candidates as Array<{ citationId: number }>)[0]?.citationId,
    ).toBe(other);
  });
});

describe('reporting back to the PDF-request queue', () => {
  it('names the citations with something waiting unlinked', async () => {
    const waiting = await seedCitation('doi', '10.1000/waiting');
    const other = await seedCitation('doi', '10.1000/other');
    await seedInboxItem({ matchedCitationId: waiting, matchConfidence: 'strong' });

    const flagged = await citationsWithPendingInboxItems([waiting, other]);
    expect([...flagged]).toEqual([waiting]);
  });

  it('stops naming a citation once its item is linked', async () => {
    const citationId = await seedCitation('doi', '10.1000/linked');
    const itemId = await seedInboxItem({ matchedCitationId: citationId });
    await attachInboxItem({ itemId, citationId, userId, mayReplace: false, auto: true });
    expect([...(await citationsWithPendingInboxItems([citationId]))]).toEqual([]);
  });

  it('counts only what is still pending', async () => {
    const citationId = await seedCitation('doi', '10.1000/counted');
    await seedInboxItem();
    const attachedItem = await seedInboxItem();
    await attachInboxItem({
      itemId: attachedItem,
      citationId,
      userId,
      mayReplace: false,
      auto: false,
    });
    const discarded = await seedInboxItem();
    await discardInboxItem(discarded);

    expect(await countPendingInboxItems()).toBe(1);
  });
});
