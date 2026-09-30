/**
 * Grading a match — how much weight an inbox PDF's identifiers may carry.
 *
 * The asymmetry these tests protect: failing to match costs a human half a
 * minute of looking, while matching the *wrong* citation binds a paper's full
 * text to another paper and then lets the read-in-full review gate authorize
 * facts drawn from a document nobody checked the identity of. So every case
 * below is really one question — is this confident enough to act on without a
 * person — and the answer is only ever yes under conditions that cannot be
 * produced by an ambiguous file.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  mayAutoAttach,
  matchInboxItem,
  type MatchResult,
} from '../../api/_lib/pdf-inbox-match.js';
import type { ExtractedIdentifiers } from '../../api/_lib/pdf-identifiers.js';

type Db = Parameters<typeof matchInboxItem>[0];

/** A db whose `execute` replays the given result sets in call order. */
function fakeDb(resultSets: Array<Array<Record<string, unknown>>>): {
  db: Db;
  execute: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  const execute = vi.fn(() => {
    const rows = resultSets[call] ?? [];
    call += 1;
    return Promise.resolve({ rows });
  });
  return { db: { execute } as unknown as Db, execute };
}

function extracted(
  overrides: Partial<ExtractedIdentifiers> = {},
): ExtractedIdentifiers {
  return {
    doi: null,
    pmid: null,
    pmcid: null,
    title: null,
    year: null,
    sources: {},
    ...overrides,
  };
}

function citationRow(
  id: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    type: 'doi',
    identifier: `10.1000/${id}`,
    metadata: { title: `Paper ${id}` },
    via: 'doi',
    score: 1,
    has_pdf: false,
    ...overrides,
  };
}

describe('matchInboxItem', () => {
  it('does not query at all when the file gave up nothing', async () => {
    const { db, execute } = fakeDb([]);
    const result = await matchInboxItem(db, extracted());
    expect(result).toEqual({ candidates: [], confidence: 'none', citationId: null });
    expect(execute).not.toHaveBeenCalled();
  });

  it('calls a stamped DOI resolving to one citation exact', async () => {
    const { db } = fakeDb([[citationRow(7)]]);
    const result = await matchInboxItem(
      db,
      extracted({ doi: '10.1016/j.x', sources: { doi: 'xmp' } }),
    );
    expect(result.confidence).toBe('exact');
    expect(result.citationId).toBe(7);
  });

  it('will not call a FILENAME-derived identifier exact', async () => {
    // A filename is a claim about what somebody named a download, and nothing
    // in the artifact corroborates it. Usually right; occasionally the paper
    // it was fetched beside. So it proposes rather than decides.
    const { db } = fakeDb([[citationRow(7, { via: 'doi' })]]);
    const result = await matchInboxItem(
      db,
      extracted({ doi: '10.1016/j.x', sources: { doi: 'filename' } }),
    );
    expect(result.confidence).toBe('strong');
    expect(result.citationId).toBe(7);
    expect(mayAutoAttach(result)).toBe(false);
  });

  it('will not call a RAW-byte identifier exact either', async () => {
    // A DOI found loose in the uncompressed region cannot say which object it
    // came from, and the likeliest thing living there is a reference list's
    // link annotations — i.e. other papers' DOIs. So it proposes.
    const { db } = fakeDb([[citationRow(7, { via: 'doi' })]]);
    const result = await matchInboxItem(
      db,
      extracted({ doi: '10.1016/j.x', sources: { doi: 'raw' } }),
    );
    expect(result.confidence).toBe('strong');
    expect(mayAutoAttach(result)).toBe(false);
  });

  it('still calls page text ahead of the references exact', async () => {
    // The downgrade must not swallow the case it exists to protect: a DOI
    // stamped on page one is a claim about this document.
    const { db } = fakeDb([[citationRow(7, { via: 'doi' })]]);
    const result = await matchInboxItem(
      db,
      extracted({ doi: '10.1016/j.x', sources: { doi: 'text' } }),
    );
    expect(result.confidence).toBe('exact');
    expect(mayAutoAttach(result)).toBe(true);
  });

  it('drops to weak when one file points at two citations', async () => {
    // Real causes: the same paper entered twice under different handles before
    // the crosswalk folded such pairs together, and a supplement stamped with
    // the article's DOI. Neither is distinguishable from the PDF alone.
    const { db } = fakeDb([[citationRow(7), citationRow(9, { via: 'pmid' })]]);
    const result = await matchInboxItem(
      db,
      extracted({ doi: '10.1016/j.x', pmid: '123', sources: { doi: 'xmp' } }),
    );
    expect(result.confidence).toBe('weak');
    expect(result.citationId).toBeNull();
    expect(result.candidates).toHaveLength(2);
    // Ranked so the strongest handle is offered first.
    expect(result.candidates[0]?.via).toBe('doi');
  });

  it('falls through to a title search only when no identifier resolved', async () => {
    const { db, execute } = fakeDb([
      [], // identifier lookup found nothing
      [citationRow(11, { via: 'title', score: 0.95 })],
    ]);
    const result = await matchInboxItem(
      db,
      extracted({ doi: '10.1016/j.x', title: 'Population pharmacokinetics' }),
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.confidence).toBe('strong');
  });

  it('never calls a title match exact, however close', async () => {
    // A corrigendum, a conference abstract and its full paper, a reprint — all
    // share a title with the thing they are not. No similarity score
    // distinguishes them, so none may attach unattended.
    // One query only: with no identifier to look up, the handle lookup is
    // skipped rather than run against three nulls.
    const { db, execute } = fakeDb([[citationRow(11, { via: 'title', score: 1 })]]);
    const result = await matchInboxItem(db, extracted({ title: 'A title' }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.confidence).toBe('strong');
    expect(mayAutoAttach(result)).toBe(false);
  });

  it('keeps a near-tie between two titles uncertain', async () => {
    const { db } = fakeDb([
      [
        citationRow(11, { via: 'title', score: 0.94 }),
        citationRow(12, { via: 'title', score: 0.91 }),
      ],
    ]);
    const result = await matchInboxItem(db, extracted({ title: 'A title' }));
    expect(result.confidence).toBe('weak');
    expect(result.citationId).toBeNull();
  });

  it('calls a lone but loose title match uncertain', async () => {
    const { db } = fakeDb([[citationRow(11, { via: 'title', score: 0.62 })]]);
    const result = await matchInboxItem(db, extracted({ title: 'A title' }));
    expect(result.confidence).toBe('weak');
  });
});

describe('mayAutoAttach', () => {
  const exact = (hasPdf: boolean): MatchResult => ({
    confidence: 'exact',
    citationId: 5,
    candidates: [
      {
        citationId: 5,
        via: 'doi',
        score: 1,
        citationType: 'doi',
        citationIdentifier: '10.1000/5',
        citationMetadata: null,
        hasPdf,
      },
    ],
  });

  it('attaches an exact match to a citation with no full text', () => {
    expect(mayAutoAttach(exact(false))).toBe(true);
  });

  it('refuses when the citation already has full text', () => {
    // Overwriting stored full text is editor-gated everywhere else, because it
    // discards an asset and invalidates the review written about it. A bulk
    // drop must not be the side door — and the commonest cause here is simply
    // the same folder dropped twice.
    expect(mayAutoAttach(exact(true))).toBe(false);
  });

  it('refuses anything below exact', () => {
    for (const confidence of ['strong', 'weak', 'none'] as const) {
      expect(mayAutoAttach({ ...exact(false), confidence })).toBe(false);
    }
  });

  it('refuses an exact grade with no chosen candidate', () => {
    expect(mayAutoAttach({ ...exact(false), citationId: null })).toBe(false);
  });
});
