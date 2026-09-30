/**
 * Reference search against real SQL. The route unit tests mock `db.execute`,
 * so the actual predicate — per term, a UNION of the citation's own haystack
 * and its paper review's body, INTERSECTed across terms — is only proved here,
 * along with the trigram indexes that predicate is shaped to use.
 *
 * The bug this covers: a user pastes `doi:10.1093/jat/bkaa107` (the Mantinieks
 * PM/AM source) and gets "no matches", because search only ever looked at the
 * title.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { citations, paperReviews } from '../../db/schema.js';
import {
  CITATION_HAYSTACK,
  findCitationIdsMatchingQuery,
  parseReferenceQuery,
  searchCitationRows,
} from '../../api/_lib/reference-search.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});

let doiId: number;
let pmidId: number;
let unrelatedId: number;

beforeEach(async () => {
  await resetIntegrationDb(db);
  const userId = await seedUser(db);

  const inserted = await db
    .insert(citations)
    .values([
      {
        type: 'doi',
        identifier: '10.1093/jat/bkaa107',
        metadata: {
          title: 'Postmortem Drug Redistribution: A Compilation of PM/AM Ratios',
          authors: ['Mantinieks D', 'Gerostamoulos D'],
          journal: 'Journal of Analytical Toxicology',
          year: 2021,
        },
        createdBy: userId,
      },
      {
        type: 'pmid',
        identifier: '33245119',
        metadata: {
          title: 'Femoral blood sampling in forensic autopsies',
          authors: ['Hansen K'],
          journal: 'Forensic Science International',
          year: 2019,
        },
        createdBy: userId,
      },
      {
        type: 'doi',
        identifier: '10.1000/unrelated',
        metadata: { title: 'Ethanol elimination kinetics', year: 2005 },
        createdBy: userId,
      },
    ])
    .returning({ id: citations.id, identifier: citations.identifier });

  const byIdentifier = new Map(inserted.map((row) => [row.identifier, row.id]));
  doiId = byIdentifier.get('10.1093/jat/bkaa107')!;
  pmidId = byIdentifier.get('33245119')!;
  unrelatedId = byIdentifier.get('10.1000/unrelated')!;

  await db.insert(paperReviews).values({
    citationId: pmidId,
    reviewMarkdown:
      'Studien er godt gjennomført, men kohorten er liten og rekrutteringen skjedde ved ett enkelt sykehus.',
    overallScore: 72,
    conclusionSupport: 'partially_supported',
    reviewConfidence: 'medium',
    readInFull: true,
    createdBy: userId,
  });
});

async function idsFor(query: string): Promise<number[]> {
  const rows = await searchCitationRows(db, parseReferenceQuery(query));
  return rows.map((row) => row.id);
}

describe('reference search over identifiers', () => {
  it.each([
    'doi:10.1093/jat/bkaa107',
    'DOI: 10.1093/JAT/bkaa107',
    'https://doi.org/10.1093/jat/bkaa107',
    '10.1093/jat/bkaa107',
  ])('finds the paper from %s', async (query) => {
    expect(await idsFor(query)).toEqual([doiId]);
  });

  it.each(['33245119', 'PMID: 33245119', 'https://pubmed.ncbi.nlm.nih.gov/33245119/'])(
    'finds the paper from %s',
    async (query) => {
      expect(await idsFor(query)).toEqual([pmidId]);
    },
  );

  it('ranks an exact identifier hit first', async () => {
    const rows = await searchCitationRows(db, parseReferenceQuery('33245119'));
    expect(rows[0]!.match_rank).toBe(0);
    expect(rows[0]!.match_source).toBe('identifier');
  });
});

describe('reference search over metadata', () => {
  it('matches an author surname', async () => {
    expect(await idsFor('mantinieks')).toEqual([doiId]);
  });

  it('ranks a pasted author list as an author hit, not the catch-all tier', async () => {
    // Matching and ranking have to agree on the shape of `authors`. Flattening
    // only the predicate would return the row and then sort it behind less
    // relevant rows: the palette shows a short, rank-ordered list, so a tier-5
    // exact author hit can fall off the bottom of it.
    const rows = await searchCitationRows(
      db,
      parseReferenceQuery('Mantinieks D, Gerostamoulos D'),
    );
    expect(rows[0]!.id).toBe(doiId);
    expect(rows[0]!.match_rank).toBe(4);
  });

  it('attributes a comma-carrying author term to metadata, not "other"', async () => {
    // match_source is probed with the FIRST term only. In this app's rendering
    // the comma follows the initial ("Mantinieks D, Gerostamoulos D"), so the
    // leading token carries one only when the user copies part of the list —
    // here from the second author back. Against the JSON rendering that term
    // would be `D", ` and the hit would be attributed to 'other'.
    const rows = await searchCitationRows(
      db,
      parseReferenceQuery('D, Gerostamoulos'),
    );
    expect(rows[0]!.id).toBe(doiId);
    expect(rows[0]!.match_source).toBe('metadata');
  });

  it('matches an author list pasted from the reference page', async () => {
    // `/references/:id` renders `authors.join(', ')`, so this is what a user
    // copies. Before 0088 the haystack held the JSON rendering
    // `["Mantinieks D", "Gerostamoulos D"]`, and the `d,` term — the tokenizer
    // keeps the comma — could only ever match `D", `, so the paste found
    // nothing on every array-stored row in the corpus.
    expect(await idsFor('Mantinieks D, Gerostamoulos D')).toEqual([doiId]);
  });

  it('still matches a single author entry with its initial', async () => {
    expect(await idsFor('Mantinieks D')).toEqual([doiId]);
  });

  it('does not match across the gap between two authors', async () => {
    // The separator survives as ", " rather than collapsing, so the last name
    // of one author and the first of the next stay distinct terms.
    expect(await idsFor('mantinieks gerostamoulos')).toEqual([doiId]);
    expect(await idsFor('mantinieks hansen')).toEqual([]);
  });

  it('matches the journal', async () => {
    expect(await idsFor('journal of analytical toxicology')).toEqual([doiId]);
  });

  it('matches the year', async () => {
    expect(await idsFor('2005')).toEqual([unrelatedId]);
  });

  // #1018: a paper occupies one row under its strongest handle, so the DOI of a
  // paper filed under its PMID is only findable if the alt ids are in the
  // haystack. Pasting the handle you happen to have must not come up empty.
  it('finds a paper by the handle it is NOT filed under', async () => {
    await db
      .update(citations)
      .set({
        metadata: {
          title: 'Femoral blood sampling in forensic autopsies',
          authors: ['Hansen K'],
          journal: 'Forensic Science International',
          year: 2019,
          altIds: { doi: '10.1016/j.forsciint.2019.02.001' },
        },
      })
      .where(eq(citations.id, pmidId));

    expect(await idsFor('10.1016/j.forsciint.2019.02.001')).toEqual([pmidId]);
    expect(await idsFor('doi:10.1016/j.forsciint.2019.02.001')).toEqual([
      pmidId,
    ]);
  });

  // Being findable is not enough. The command palette shows a short,
  // rank-ordered list, so a hit that matched on an identifier but ranks in the
  // catch-all tier sorts behind unrelated title and author hits — the user
  // pasted an exact handle and watches it place below fuzzy matches.
  it('ranks a hit on the handle it is NOT filed under as an identifier match', async () => {
    await db
      .update(citations)
      .set({
        metadata: {
          title: 'Femoral blood sampling in forensic autopsies',
          authors: ['Hansen K'],
          journal: 'Forensic Science International',
          year: 2019,
          altIds: { doi: '10.1016/j.forsciint.2019.02.001' },
        },
      })
      .where(eq(citations.id, pmidId));

    const rows = await searchCitationRows(
      db,
      parseReferenceQuery('10.1016/j.forsciint.2019.02.001'),
    );
    expect(rows[0]!.id).toBe(pmidId);
    expect(rows[0]!.match_rank).toBe(0);
    expect(rows[0]!.match_source).toBe('identifier');
  });

  it('ANDs multiple terms so extra words narrow the result', async () => {
    expect(await idsFor('postmortem redistribution')).toEqual([doiId]);
    expect(await idsFor('postmortem ethanol')).toEqual([]);
  });
});

describe('reference search over the agent paper review', () => {
  it('finds a paper by a phrase that only appears in its review', async () => {
    const rows = await searchCitationRows(db, parseReferenceQuery('kohorten'));
    expect(rows.map((row) => row.id)).toEqual([pmidId]);
    expect(rows[0]!.match_source).toBe('review');
    expect(rows[0]!.review_snippet).toContain('kohorten er liten');
  });

  it('leaves citations without a review searchable on their own fields', async () => {
    const ids = await findCitationIdsMatchingQuery(
      db,
      parseReferenceQuery('compilation'),
    );
    expect([...ids]).toEqual([doiId]);
  });

  it('returns nothing for a query that matches nowhere', async () => {
    expect(await idsFor('ketamin')).toEqual([]);
  });
});

describe('reference search semantics across sources', () => {
  it('AND-s terms across the citation and its review', async () => {
    // "femoral" lives in the title, "kohorten" only in the review body. The
    // per-term UNION / cross-term INTERSECT shape has to keep matching this;
    // a plain UNION of the two sources would drop it.
    expect(await idsFor('femoral kohorten')).toEqual([pmidId]);
  });

  it('still requires every term to appear somewhere', async () => {
    expect(await idsFor('femoral ketamin')).toEqual([]);
  });
});

describe('reference search ordering robustness', () => {
  it('sorts a year past int4 without blowing up the query', async () => {
    // metadata.year is only bounded by z.number().int() at the write boundary,
    // so a row can carry 3000000000. Casting every digit to int4 made any
    // search matching that row a 500.
    const userId = await seedUser(db, {
      email: 'second@example.com',
      username: 'second',
    });
    await db.insert(citations).values({
      type: 'doi',
      identifier: '10.1000/huge-year',
      metadata: { title: 'Redistribution in the far future', year: 3000000000 },
      createdBy: userId,
    });

    const rows = await searchCitationRows(
      db,
      parseReferenceQuery('redistribution'),
    );
    expect(rows.map((r) => r.identifier)).toContain('10.1000/huge-year');
  });
});

describe('reference search index usability', () => {
  // enable_seqscan is turned off at session level below; restore it so a test
  // added after this block still plans normally.
  afterAll(async () => {
    await db.execute(sql`SET enable_seqscan = on`);
  });

  /**
   * The predicate is deliberately shaped as two single-table scans so the
   * trigram indexes from migration 0093 can serve it — an expression index is
   * only used when the query repeats the expression verbatim, and no index can
   * answer a predicate spanning both sides of a join. Planner cost estimates
   * favour a sequential scan on a table this small, so seqscan is disabled to
   * ask the narrower question: *can* the index answer this?
   *
   * The EXPLAIN interpolates the REAL `CITATION_HAYSTACK` rather than a copy
   * of it. A hand-written copy only proves the copy is indexable: the shipped
   * expression could drift from the migration and this test would still pass
   * while production silently fell back to a full scan.
   */
  async function planFor(query: string): Promise<string> {
    await db.execute(sql`SET enable_seqscan = off`);
    const parsed = parseReferenceQuery(query);
    const rows = await searchCitationRows(db, parsed, 5);
    expect(rows.length).toBeGreaterThanOrEqual(0);
    const explained = await db.execute<{ 'QUERY PLAN': string }>(sql`
      EXPLAIN SELECT c.id FROM citations c
      WHERE ${CITATION_HAYSTACK} ILIKE ${`%${query}%`} ESCAPE '\\'
    `);
    return (explained.rows ?? [])
      .map((row) => row['QUERY PLAN'])
      .join('\n');
  }

  it('created both trigram indexes', async () => {
    const rows = await db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN (
        'citations_search_haystack_v3_trgm_idx',
        'paper_reviews_markdown_trgm_idx'
      )
    `);
    expect((rows.rows ?? []).map((r) => r.indexname).sort()).toEqual([
      'citations_search_haystack_v3_trgm_idx',
      'paper_reviews_markdown_trgm_idx',
    ]);
  });

  it('dropped the haystack indexes it replaced', async () => {
    // Left behind, either would keep being maintained on every write while
    // serving a predicate no query issues any more.
    const rows = await db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN (
        'citations_search_haystack_trgm_idx',
        'citations_search_haystack_v2_trgm_idx'
      )
    `);
    expect(rows.rows ?? []).toHaveLength(0);
  });

  it('can answer the citation-side predicate from the haystack index', async () => {
    const plan = await planFor('redistribution');
    expect(plan).toContain('citations_search_haystack_v3_trgm_idx');
  });

  it('can answer an author-list query from the haystack index', async () => {
    // The query form the flattening exists for — it must be index-served too,
    // not merely correct.
    const plan = await planFor('Mantinieks D, Gerostamoulos D');
    expect(plan).toContain('citations_search_haystack_v3_trgm_idx');
  });

  it('can answer the review-side predicate from the review index', async () => {
    await db.execute(sql`SET enable_seqscan = off`);
    const explained = await db.execute<{ 'QUERY PLAN': string }>(sql`
      EXPLAIN SELECT pr.citation_id FROM paper_reviews pr
      WHERE pr.review_markdown ILIKE ${'%kohorten%'} ESCAPE '\\'
    `);
    const plan = (explained.rows ?? [])
      .map((row) => row['QUERY PLAN'])
      .join('\n');
    expect(plan).toContain('paper_reviews_markdown_trgm_idx');
  });
});
