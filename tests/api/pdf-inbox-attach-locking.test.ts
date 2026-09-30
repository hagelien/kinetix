/**
 * The two things that keep concurrent attaches from silently overwriting each
 * other's full text.
 *
 * A bulk drop runs three upload-completion callbacks in parallel, so two files
 * matching the same citation — the same paper downloaded twice, or an article
 * and a preprint both carrying the stamped DOI — routinely attach at the same
 * moment. Locking only the inbox row serialises two attempts on the same
 * *file* and nothing at all on the same *paper*: both transactions read
 * `citation_pdfs` as empty, both conclude they are not replacing anything, and
 * the second overwrites the first through the upsert. `mayReplace` is never
 * consulted, the read-in-full attestation is never withdrawn, and the first
 * file's object is orphaned while its row still claims it was attached.
 *
 * A real race cannot be staged against the single-connection PGlite harness
 * the integration suite uses, so the invariants are pinned here instead, on a
 * transaction stub that records what the store asked the database for:
 *
 *   1. the citation row is locked `FOR UPDATE` before `citation_pdfs` is read;
 *   2. an upsert that writes nothing — which is what the guarded
 *      `ON CONFLICT ... DO UPDATE` produces when a row appeared under us —
 *      fails the attach instead of reporting success.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runInPoolTransactionMock, getDbMock, delMock } = vi.hoisted(() => ({
  runInPoolTransactionMock: vi.fn(),
  getDbMock: vi.fn(),
  delMock: vi.fn(async () => undefined),
}));

vi.mock('../../api/_lib/db.js', () => ({
  runInPoolTransaction: runInPoolTransactionMock,
  getDb: getDbMock,
}));
vi.mock('@vercel/blob', () => ({ del: delMock }));

import { attachInboxItem } from '../../api/_lib/pdf-inbox-store.js';
import {
  citationPdfs,
  citations,
  paperExtractionJobs,
  paperReviews,
  pdfInboxItems,
  pdfRequests,
} from '../../db/schema.js';

const ITEM = {
  id: 1,
  status: 'pending',
  blobPathname: 'pdf-inbox/dropped-abc.pdf',
  blobUrl: 'https://blob.example/pdf-inbox/dropped-abc.pdf',
  sizeBytes: 1024,
  sha256: 'a'.repeat(64),
  contentType: 'application/pdf',
};

const CITATION = { id: 7, type: 'doi' };

interface TxOptions {
  /** Rows `citation_pdfs` returns for the citation. */
  existingPdf?: Array<{ id: number; blobUrl: string }>;
  /** What the guarded citation_pdfs upsert returns. Empty = it wrote nothing. */
  storedReturning?: Array<{ id: number }>;
}

interface TxRecord {
  /**
   * Every read the store issued, in order, as `read:<table>` followed by
   * `lock:<table>` when it asked for `FOR UPDATE`. One sequence rather than
   * two lists, because the claim being pinned is an *ordering*: the citation
   * lock has to be taken before `citation_pdfs` is consulted, and a lock
   * acquired afterwards leaves open exactly the window it exists to close.
   */
  ops: string[];
  /** The `setWhere` the citation_pdfs upsert was given, if any. */
  citationPdfSetWhere: unknown;
}

function tableName(table: unknown): string {
  if (table === pdfInboxItems) return 'pdf_inbox_items';
  if (table === citations) return 'citations';
  if (table === citationPdfs) return 'citation_pdfs';
  if (table === pdfRequests) return 'pdf_requests';
  if (table === paperReviews) return 'paper_reviews';
  if (table === paperExtractionJobs) return 'paper_extraction_jobs';
  return 'unknown';
}

/**
 * A transaction stub shaped like the drizzle builder the store actually uses.
 * `limit()` resolves to the rows *and* carries `.for()`, so whether the store
 * asked for a lock is observable rather than inferred.
 */
function stubTransaction(options: TxOptions = {}): {
  tx: unknown;
  record: TxRecord;
} {
  const record: TxRecord = { ops: [], citationPdfSetWhere: undefined };

  const rowsFor = (table: unknown): unknown[] => {
    if (table === pdfInboxItems) return [ITEM];
    if (table === citations) return [CITATION];
    if (table === citationPdfs) return options.existingPdf ?? [];
    if (table === paperExtractionJobs) return [];
    return [];
  };

  const select = () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: () => {
          const rows = rowsFor(table);
          record.ops.push(`read:${tableName(table)}`);
          const settled = Promise.resolve(rows) as Promise<unknown[]> & {
            for: (mode: string) => Promise<unknown[]>;
          };
          settled.for = () => {
            record.ops.push(`lock:${tableName(table)}`);
            return Promise.resolve(rows);
          };
          return settled;
        },
      }),
    }),
  });

  const insert = (table: unknown) => ({
    values: () => ({
      onConflictDoUpdate: (config: { setWhere?: unknown }) => {
        if (table === citationPdfs) {
          record.citationPdfSetWhere = config.setWhere;
        }
        const done = Promise.resolve([]) as Promise<unknown[]> & {
          returning: () => Promise<unknown[]>;
        };
        done.returning = () =>
          Promise.resolve(
            table === citationPdfs
              ? (options.storedReturning ?? [{ id: 99 }])
              : [],
          );
        return done;
      },
    }),
  });

  const update = () => ({
    set: () => ({ where: () => Promise.resolve([]) }),
  });

  return { tx: { select, insert, update }, record };
}

function runAttach(options: TxOptions = {}): {
  promise: Promise<unknown>;
  record: TxRecord;
} {
  const { tx, record } = stubTransaction(options);
  runInPoolTransactionMock.mockImplementation(
    (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  );
  return {
    promise: attachInboxItem({
      itemId: 1,
      citationId: 7,
      userId: 3,
      mayReplace: false,
      auto: false,
    }),
    record,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getDbMock.mockReturnValue({});
});

describe('attach locking', () => {
  it('locks the citation, not just the inbox item', async () => {
    // The inbox lock serialises two attaches of the same FILE. Two different
    // files matching one paper share only the citation row, so that is what
    // has to be held while `citation_pdfs` is checked and written.
    const { promise, record } = runAttach();
    await promise;

    expect(record.ops).toContain('lock:citations');
    expect(record.ops).toContain('lock:pdf_inbox_items');
  });

  it('takes the citation lock before reading citation_pdfs', async () => {
    // Ordering is the whole point: a lock taken afterwards leaves the window
    // it exists to close wide open.
    const { promise, record } = runAttach();
    await promise;

    const lockedCitation = record.ops.indexOf('lock:citations');
    const readStoredPdf = record.ops.indexOf('read:citation_pdfs');
    expect(lockedCitation).toBeGreaterThanOrEqual(0);
    expect(readStoredPdf).toBeGreaterThan(lockedCitation);
    // Lock order is item → citation everywhere, so two attaches cannot
    // deadlock against each other.
    expect(record.ops.indexOf('lock:pdf_inbox_items')).toBeLessThan(
      lockedCitation,
    );
  });

  it('disarms the conflict update when it saw no stored PDF', async () => {
    // Nothing was there when we looked, so a conflict means a row appeared
    // under us — the DO UPDATE must not fire.
    const { promise, record } = runAttach();
    await promise;

    expect(record.citationPdfSetWhere).toBeDefined();
  });

  it('fails the attach when the guarded upsert writes nothing', async () => {
    // An empty RETURNING is a lost race. Reporting success here is the bug:
    // the caller marks the item attached while `citation_pdfs` still points
    // at somebody else's bytes.
    const { promise } = runAttach({ storedReturning: [] });
    await expect(promise).rejects.toMatchObject({
      code: 'inbox_attach_conflict',
    });
  });

  it('still refuses a replacement it was not authorized for', async () => {
    // The guard is defence in depth, not a replacement for the check: a
    // caller without the editor capability is refused before any write.
    const { promise } = runAttach({
      existingPdf: [{ id: 5, blobUrl: 'https://blob.example/old.pdf' }],
    });
    await expect(promise).rejects.toMatchObject({
      code: 'pdf_replace_requires_editor',
    });
  });
});
