/**
 * The unrequested full-text gap query against the real migrated schema.
 *
 * `listFullTextGaps` is hand-written SQL — ten anchor tables and three
 * NOT EXISTS guards, all named as string literals the type checker never sees.
 * The route's unit test mocks `db.execute` outright, so it proves how the rows
 * are shaped and nothing about whether the statement runs or selects the right
 * population. That is the exact drift `tests/integration/citation-usage.test.ts`
 * was written for after migration 0078 renamed `reference_concentrations`, and
 * this query names that table too.
 *
 * The population matters as much as the syntax: this list is what a
 * contributor is asked to work through, so a false positive wastes their time
 * chasing a paper that is already on file, and a false negative reproduces the
 * original bug — a reference page advertising "full text missing" while the
 * queue shows nothing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  citationPdfs,
  citations,
  drugParameterRevisions,
  paperReviews,
  parameterEntries,
  pdfRequests,
} from '../../db/schema.js';
import { getDb } from '../../api/_lib/db.js';
import { listFullTextGaps } from '../../api/_lib/full-text-gaps.js';
import { recordPaperReview } from '../../api/_lib/paper-review-store.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let userId: number;
let drugId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  userId = await seedUser(db);
  drugId = await seedDrug(db, { slug: 'alprazolam' });
});

async function seedCitation(
  identifier: string,
  type: 'pmid' | 'doi' | 'url' | 'freetext' = 'pmid',
): Promise<number> {
  const [row] = await db
    .insert(citations)
    .values({ type, identifier })
    .returning({ id: citations.id });
  return row!.id;
}

/** Anchor a citation to live content so it counts as cited. */
async function citeOnParameter(citationId: number): Promise<void> {
  await db.insert(drugParameterRevisions).values({
    drugId,
    parameter: 'halfLife',
    newValue: { median: 11, unit: 'h' },
    referenceIds: [citationId],
    createdBy: userId,
  });
}

async function storeFullText(citationId: number): Promise<void> {
  await db.insert(citationPdfs).values({
    citationId,
    blobPathname: `citations/${citationId}.pdf`,
    blobUrl: `https://blob.example/${citationId}.pdf`,
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    contentType: 'application/pdf',
    source: 'upload',
    uploadedBy: userId,
  });
}

async function review(
  citationId: number,
  readInFull: boolean,
): Promise<void> {
  await db.insert(paperReviews).values({
    citationId,
    reviewMarkdown: '## Vurdering\n\nMetodene holder.',
    readInFull,
    createdBy: userId,
  });
}

async function gapIds(): Promise<number[]> {
  const { rows } = await listFullTextGaps(getDb());
  return rows.map((row) => row.citationId);
}

describe('listFullTextGaps over real SQL', () => {
  it('runs the statement against every table it names', async () => {
    // The 42P01 class of failure: a renamed table would throw here rather
    // than return a page, and the route would 500 on every queue load.
    await expect(listFullTextGaps(getDb())).resolves.toMatchObject({
      rows: [],
      total: 0,
    });
  });

  it('lists a cited paper with no full text, review, or request', async () => {
    // The reported case: the reference page says "not reviewed because full
    // text is missing", and before this the queue disagreed.
    const citationId = await seedCitation('8513649');
    await citeOnParameter(citationId);

    expect(await gapIds()).toEqual([citationId]);
  });

  it('ignores a citation that is not cited from live content', async () => {
    // An orphan from an abandoned add-fact flow (#304). Nothing rests on it,
    // so nobody should be asked to hunt down its PDF.
    await seedCitation('99999999');

    expect(await gapIds()).toEqual([]);
  });

  it('ignores freetext citations', async () => {
    // No resolvable paper, and POST /api/pdf-requests rejects one outright —
    // listing it would offer an upload that cannot be filed.
    const citationId = await seedCitation('Baselt, 12th ed., p. 44', 'freetext');
    await citeOnParameter(citationId);

    expect(await gapIds()).toEqual([]);
  });

  it('ignores PubChem record URLs but keeps other URL citations', async () => {
    // A public database entry agents read directly; POST /api/pdf-requests
    // refuses one, so listing it would ask for a PDF that cannot exist.
    const pubchem = await seedCitation(
      'https://pubchem.ncbi.nlm.nih.gov/compound/115237',
      'url',
    );
    const other = await seedCitation('https://example.org/paper', 'url');
    await citeOnParameter(pubchem);
    await citeOnParameter(other);

    expect(await gapIds()).toEqual([other]);
  });

  it('ignores a paper whose full text is already stored', async () => {
    const citationId = await seedCitation('8513649');
    await citeOnParameter(citationId);
    await storeFullText(citationId);

    expect(await gapIds()).toEqual([]);
  });

  it('ignores a paper with a completed read-in-full review', async () => {
    const citationId = await seedCitation('8513649');
    await citeOnParameter(citationId);
    await review(citationId, true);

    expect(await gapIds()).toEqual([]);
  });

  it('still lists a paper whose review was withdrawn', async () => {
    // `read_in_full = false` is the withdrawn attestation the reader-facing
    // needsFullReview badge already flags: the claim is live and unbacked, so
    // supplying the full text is exactly what unblocks it.
    const citationId = await seedCitation('8513649');
    await citeOnParameter(citationId);
    await review(citationId, false);

    expect(await gapIds()).toEqual([citationId]);
  });

  it('hands a paper over to the requested class once a request is open', async () => {
    // No double-listing: an open request is the agent-confirmed class, and it
    // is listed by the route's own query.
    const citationId = await seedCitation('8513649');
    await citeOnParameter(citationId);
    await db.insert(pdfRequests).values({
      citationId,
      status: 'open',
      requestedBy: userId,
    });

    expect(await gapIds()).toEqual([]);
  });

  it('flags a gap whose request was cancelled rather than never filed', async () => {
    // `recordPaperReview` cancels the citation's open request whenever a
    // review lands — including a `readInFull: false` one, which leaves the
    // paper still needing full text. It belongs in this list (no open request
    // will surface it), but calling it unrequested would contradict its own
    // history, so the row carries the correction.
    const citationId = await seedCitation('8513649');
    await citeOnParameter(citationId);
    await review(citationId, false);
    await db.insert(pdfRequests).values({
      citationId,
      status: 'cancelled',
      requestedBy: userId,
    });

    const { rows } = await listFullTextGaps(getDb());
    expect(rows.map((row) => row.citationId)).toEqual([citationId]);
    expect(rows[0]!.previouslyRequested).toBe(true);
  });

  it('leaves previouslyRequested false when no request was ever filed', async () => {
    const citationId = await seedCitation('8513649');
    await citeOnParameter(citationId);

    const { rows } = await listFullTextGaps(getDb());
    expect(rows[0]!.previouslyRequested).toBe(false);
  });

  it('keeps the request open when a not-read-in-full review lands', async () => {
    // End to end through the real write path. `recordPaperReview` used to
    // cancel the open request unconditionally, which took a paper that still
    // needs full text out of the requested class — visible only because the
    // gap class caught it, and then labelled as if nobody had ever asked.
    // Now the request survives, so the paper stays where the agent put it.
    const citationId = await seedCitation('8513649');
    await citeOnParameter(citationId);
    await db.insert(pdfRequests).values({
      citationId,
      status: 'open',
      reason: 'Bak betalingsmur',
      requestedBy: userId,
    });

    await recordPaperReview({
      citationId,
      authorUserId: userId,
      input: {
        reviewMarkdown: 'Kun sammendrag tilgjengelig.',
        overallScore: null,
        conclusionSupport: null,
        reviewConfidence: 'low',
        readInFull: false,
      },
    });

    const [request] = await db
      .select({ status: pdfRequests.status })
      .from(pdfRequests)
      .where(eq(pdfRequests.citationId, citationId));
    expect(request!.status).toBe('open');
    // Still open → the requested class owns it, so it is not a gap.
    expect(await gapIds()).toEqual([]);
  });

  it('cancels the request once a read-in-full review lands', async () => {
    // The other half of the same guard: a read-in-full review means the paper
    // was obtained, so the request really is moot. It also drops out of the
    // gap class, since the completed review is what the gap query tests for.
    const citationId = await seedCitation('8513649');
    await citeOnParameter(citationId);
    await db.insert(pdfRequests).values({
      citationId,
      status: 'open',
      requestedBy: userId,
    });

    await recordPaperReview({
      citationId,
      authorUserId: userId,
      input: {
        reviewMarkdown: 'Lest i sin helhet.',
        overallScore: 82,
        conclusionSupport: 'supported',
        reviewConfidence: 'high',
        readInFull: true,
      },
    });

    const [request] = await db
      .select({ status: pdfRequests.status })
      .from(pdfRequests)
      .where(eq(pdfRequests.citationId, citationId));
    expect(request!.status).toBe('cancelled');
    expect(await gapIds()).toEqual([]);
  });

  it('lists a paper whose request was fulfilled but has no stored full text', async () => {
    // A fulfilled request with nothing on file is an unfinished handover, not
    // a settled paper — the open-request query skips it (status is not open),
    // so without this it would fall out of both classes.
    const citationId = await seedCitation('8513649');
    await citeOnParameter(citationId);
    await db.insert(pdfRequests).values({
      citationId,
      status: 'fulfilled',
      requestedBy: userId,
      fulfilledBy: userId,
      fulfilledAt: new Date(),
    });

    expect(await gapIds()).toEqual([citationId]);
  });

  it('counts a citation anchored only on a parameter entry', async () => {
    // Deep-research imports attach much of a seeded drug's sources here and
    // nowhere else; the narrower agent-sweep anchor set misses them.
    const citationId = await seedCitation('37440364');
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'therapeuticConcentration',
      citationId,
      low: '0.02',
      high: '0.04',
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'therapeutic',
      createdBy: userId,
    });

    expect(await gapIds()).toEqual([citationId]);
  });

  it('reports the pre-limit total so a truncated page can say so', async () => {
    for (const identifier of ['1111111', '2222222', '3333333']) {
      await citeOnParameter(await seedCitation(identifier));
    }

    const page = await listFullTextGaps(getDb(), 2);
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(3);
  });
});
