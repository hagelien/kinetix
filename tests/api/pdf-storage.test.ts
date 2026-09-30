import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getNeonClientMock, transactionMock } = vi.hoisted(() => {
  const transaction = vi.fn();
  const neonSql = Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      void values;
      return Promise.resolve([{ id: 1, text: strings.join('?') }]);
    }),
    { transaction },
  );
  return {
    getNeonClientMock: vi.fn(() => neonSql),
    transactionMock: transaction,
  };
});

vi.mock('../../api/_lib/db.js', () => ({
  getNeonClient: getNeonClientMock,
}));

import { recordCitationPdf } from '../../api/_lib/pdf-storage.js';

const openRequestCreatedAt = '2026-06-03 02:00:00.123456';

describe('recordCitationPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionMock.mockResolvedValue(undefined);
  });

  it('persists the PDF pointer and closes the request atomically', async () => {
    await recordCitationPdf({
      citationId: 12,
      pdfRequestId: 7,
      pdfRequestCreatedAt: openRequestCreatedAt,
      blobPathname: 'citation-pdfs/12-random.pdf',
      blobUrl: 'https://blob.example/citation-pdfs/12-random.pdf',
      sizeBytes: 128,
      sha256: 'a'.repeat(64),
      contentType: 'application/pdf',
      source: 'upload',
      sourceUrl: null,
      uploadedBy: 42,
    });

    const neonSql = getNeonClientMock.mock.results[0]?.value;
    expect(neonSql).toHaveBeenCalledTimes(1);
    const statement = await neonSql.mock.results[0].value;
    expect(statement[0].text).toContain('UPDATE pdf_requests');
    expect(statement[0].text).toContain('AND id =');
    expect(statement[0].text).toContain('created_at::text =');
    expect(statement[0].text).toContain("status = 'open'");
    expect(statement[0].text).toContain('INSERT INTO citation_pdfs');
    expect(statement[0].text).toContain('ON CONFLICT (citation_id)');
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('expires a read-in-full review in the same statement as a replacement', async () => {
    // paper_reviews is keyed by CITATION and the read-in-full gate resolves on
    // that key alone, so a review of a wrong-paper or unreadable upload would
    // keep authorizing facts about a document nobody has read once the bytes
    // are swapped. It has to ride in this one statement: a separate write that
    // failed would leave exactly that state.
    //
    // Shape assertion, not behaviour: recordCitationPdf goes through the raw
    // Neon client, which the PGlite integration harness does not provide, so
    // this SQL cannot currently be executed in a test.
    await recordCitationPdf({
      citationId: 12,
      pdfRequestId: 7,
      pdfRequestCreatedAt: openRequestCreatedAt,
      blobPathname: 'citation-pdfs/12-random.pdf',
      blobUrl: 'https://blob.example/citation-pdfs/12-random.pdf',
      sizeBytes: 128,
      sha256: 'a'.repeat(64),
      contentType: 'application/pdf',
      source: 'upload',
      sourceUrl: null,
      uploadedBy: 42,
    });

    const neonSql = getNeonClientMock.mock.results[0]?.value;
    const statement = (await neonSql.mock.results[0].value)[0].text as string;

    expect(statement).toContain('UPDATE paper_reviews');
    expect(statement).toContain('read_in_full = false');
    // Conditioned on the request being a replacement — an ordinary first
    // upload must not invalidate an existing review.
    expect(statement).toContain('RETURNING id, is_replacement');
    expect(statement).toContain('SELECT 1 FROM open_request WHERE is_replacement');
    // One round trip: the expiry is a CTE beside the swap, not a second call.
    expect(neonSql).toHaveBeenCalledTimes(1);
  });

  it('rejects storage when no open request was fulfilled', async () => {
    const neonSql = getNeonClientMock();
    vi.mocked(neonSql).mockResolvedValueOnce([]);

    await expect(
      recordCitationPdf({
        citationId: 12,
        pdfRequestId: 7,
        pdfRequestCreatedAt: openRequestCreatedAt,
        blobPathname: 'citation-pdfs/12-random.pdf',
        blobUrl: 'https://blob.example/citation-pdfs/12-random.pdf',
        sizeBytes: 128,
        sha256: 'a'.repeat(64),
        contentType: 'application/pdf',
        source: 'upload',
        sourceUrl: null,
        uploadedBy: 42,
      }),
    ).rejects.toThrow('No open PDF request exists');
  });
});
