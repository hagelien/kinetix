import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  citations,
  drugParameterRevisions,
  drugReceptorTargets,
  paperReviewRevisions,
  paperReviews,
  parameterEntries,
  pendingEdits,
  wikiPages,
} from '../../db/schema.js';
import { handleMatch, resolveCitation } from '../../api/_lib/citation-store.js';
import {
  lockPendingEditsCitingCitation,
  mergeCitations,
} from '../../api/_lib/citation-merge.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedBioEntity, seedDrug, seedUser } from './setup/seed.js';

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
});

const DOI = '10.1093/jat/bkaa107';
const PMID = '33245119';

async function seedCitation(
  over: Partial<typeof citations.$inferInsert> = {},
): Promise<number> {
  const [row] = await db
    .insert(citations)
    .values({
      type: over.type ?? 'pmid',
      identifier: over.identifier ?? PMID,
      ...over,
    })
    .returning({ id: citations.id });
  return row!.id;
}

describe('resolveCitation — one paper, one row (#1018)', () => {
  it('finds the PMID row when the caller declares the DOI', async () => {
    const existing = await seedCitation({ type: 'pmid', identifier: PMID });

    const resolved = await resolveCitation(
      db,
      { type: 'doi', identifier: DOI, crosswalk: { pmid: PMID } },
      userId,
    );

    expect(resolved.id).toBe(existing);
    expect(resolved.created).toBe(false);
    const [row] = await db
      .select()
      .from(citations)
      .where(eq(citations.id, existing));
    // The DOI is kept, so the next seed declaring it lands here too.
    expect(row?.type).toBe('pmid');
    expect(
      (row?.metadata as { altIds?: Record<string, string> })?.altIds?.doi,
    ).toBe(DOI);
    const all = await db.select({ id: citations.id }).from(citations);
    expect(all).toHaveLength(1);
  });

  it('finds a row by a handle it carries only in altIds, with no crosswalk', async () => {
    // The NCBI-unavailable path: the caller knows the DOI and nothing else, and
    // the row is filed under its PMID with the DOI recorded locally. Comparing
    // columns to columns finds nothing here and inserts a second row —
    // re-creating the split for as long as the outage lasts.
    const existing = await seedCitation({
      type: 'pmid',
      identifier: PMID,
      metadata: { altIds: { doi: DOI } },
    });

    const resolved = await resolveCitation(
      db,
      { type: 'doi', identifier: DOI },
      userId,
    );

    expect(resolved.id).toBe(existing);
    expect(resolved.created).toBe(false);
    const all = await db.select({ id: citations.id }).from(citations);
    expect(all).toHaveLength(1);
  });

  it('matches a stored alt DOI case-insensitively', async () => {
    const existing = await seedCitation({
      type: 'pmid',
      identifier: PMID,
      metadata: { altIds: { doi: DOI } },
    });

    const resolved = await resolveCitation(
      db,
      { type: 'doi', identifier: DOI.toUpperCase() },
      userId,
    );

    expect(resolved.id).toBe(existing);
    const all = await db.select({ id: citations.id }).from(citations);
    expect(all).toHaveLength(1);
  });

  it('promotes an existing DOI row in place when the PMID is learned', async () => {
    const existing = await seedCitation({ type: 'doi', identifier: DOI });
    // A review on the DOI row is exactly what a delete-and-recreate would sever.
    await db.insert(paperReviews).values({
      citationId: existing,
      reviewMarkdown: 'Lest i sin helhet.',
      readInFull: true,
    });

    const resolved = await resolveCitation(
      db,
      { type: 'pmid', identifier: PMID, crosswalk: { doi: DOI } },
      userId,
    );

    expect(resolved.id).toBe(existing);
    expect(resolved.promotedFrom).toEqual({ type: 'doi', identifier: DOI });
    const [row] = await db
      .select()
      .from(citations)
      .where(eq(citations.id, existing));
    expect(row?.type).toBe('pmid');
    expect(row?.identifier).toBe(PMID);
    // The read-in-full attestation is still attached to the same row.
    const [review] = await db
      .select({ readInFull: paperReviews.readInFull })
      .from(paperReviews)
      .where(eq(paperReviews.citationId, existing));
    expect(review?.readInFull).toBe(true);
  });

  it('folds an already-split pair together when it meets one', async () => {
    const pmidRow = await seedCitation({ type: 'pmid', identifier: PMID });
    const doiRow = await seedCitation({ type: 'doi', identifier: DOI });

    const resolved = await resolveCitation(
      db,
      { type: 'doi', identifier: DOI, crosswalk: { pmid: PMID } },
      userId,
    );

    expect(resolved.id).toBe(pmidRow);
    expect(resolved.mergedIds).toEqual([doiRow]);
    const all = await db.select({ id: citations.id }).from(citations);
    expect(all).toHaveLength(1);
  });

  it('creates one row when the paper is genuinely new', async () => {
    const resolved = await resolveCitation(
      db,
      {
        type: 'doi',
        identifier: DOI,
        crosswalk: { pmid: PMID },
        metadata: { title: 'Postmortem redistribution' },
      },
      userId,
    );

    expect(resolved.created).toBe(true);
    const [row] = await db
      .select()
      .from(citations)
      .where(eq(citations.id, resolved.id));
    // Filed under the strongest handle even though the caller declared the DOI.
    expect(row?.type).toBe('pmid');
    expect(row?.identifier).toBe(PMID);
    expect(row?.metadata).toMatchObject({
      title: 'Postmortem redistribution',
      altIds: { doi: DOI },
    });
  });

  it('leaves free text alone — it identifies nothing resolvable', async () => {
    const resolved = await resolveCitation(
      db,
      {
        type: 'freetext',
        identifier: 'Personlig meddelelse, 2024',
        crosswalk: { pmid: PMID },
      },
      userId,
    );
    const [row] = await db
      .select()
      .from(citations)
      .where(eq(citations.id, resolved.id));
    expect(row?.type).toBe('freetext');
  });

  const schulz = {
    authors: ['Schulz M', 'Schmoldt A'],
    year: 2003,
    title:
      'Therapeutic and toxic blood concentrations of more than 800 drugs and other xenobiotics.',
  };

  it('reuses the PMID row for a reworded free-text reference to the same paper', async () => {
    const existing = await seedCitation({
      type: 'pmid',
      identifier: '12889529',
      metadata: schulz,
    });

    const resolved = await resolveCitation(
      db,
      {
        type: 'freetext',
        identifier:
          'Schulz M, Schmoldt A. Therapeutic and toxic concentrations of more than 800 drugs and other xenobiotics. Beyreuth: GIT Verlag; 2003.',
        metadata: {
          ...schulz,
          title:
            'Therapeutic and toxic concentrations of more than 800 drugs and other xenobiotics',
        },
      },
      userId,
    );

    expect(resolved.id).toBe(existing);
    expect(resolved.created).toBe(false);
    const all = await db.select({ id: citations.id }).from(citations);
    expect(all).toHaveLength(1);
  });

  it('reuses an earlier free-text row for the same work', async () => {
    const existing = await seedCitation({
      type: 'freetext',
      identifier: 'Schulz M, Schmoldt A. ' + schulz.title,
      metadata: schulz,
    });

    const resolved = await resolveCitation(
      db,
      {
        type: 'freetext',
        identifier: schulz.title + ' Pharmazie 2003;58:447-74.',
        metadata: schulz,
      },
      userId,
    );

    expect(resolved.id).toBe(existing);
  });

  it('creates a new row for a different edition', async () => {
    const martindale = {
      authors: ['Sweetman SC'],
      year: 2014,
      title: 'Martindale: The Complete Drug Reference, 38th ed.',
    };
    const existing = await seedCitation({
      type: 'freetext',
      identifier: 'Sweetman SC. Martindale: The Complete Drug Reference. 38th ed.',
      metadata: martindale,
    });

    const resolved = await resolveCitation(
      db,
      {
        type: 'freetext',
        identifier: 'Sweetman SC. Martindale: The Complete Drug Reference. 39th ed.',
        metadata: { ...martindale, title: 'Martindale: The Complete Drug Reference, 39th ed.' },
      },
      userId,
    );

    expect(resolved.id).not.toBe(existing);
    expect(resolved.created).toBe(true);
  });

  it('reuses nothing when the free text sits between two different papers', async () => {
    // Each long wording is close enough to the short one, but not to each other.
    const base = 'Pharmacokinetics of diazepam in healthy volunteers after administration';
    const rec = (title: string) => ({ authors: ['Klotz U'], year: 1975, title });
    const oral = base.replace('after', 'after oral');
    const iv = base.replace('after', 'after intravenous');
    await seedCitation({ type: 'freetext', identifier: 'Klotz U. ' + oral, metadata: rec(oral) });
    await seedCitation({ type: 'freetext', identifier: 'Klotz U. ' + iv, metadata: rec(iv) });

    const resolved = await resolveCitation(
      db,
      { type: 'freetext', identifier: 'Klotz U. ' + base, metadata: rec(base) },
      userId,
    );

    expect(resolved.created).toBe(true);
  });

  it('reuses nothing when the free text matches two different papers', async () => {
    await seedCitation({ type: 'pmid', identifier: '1', metadata: schulz });
    await seedCitation({ type: 'doi', identifier: '10.1000/x', metadata: schulz });

    const resolved = await resolveCitation(
      db,
      { type: 'freetext', identifier: schulz.title, metadata: schulz },
      userId,
    );

    expect(resolved.created).toBe(true);
  });
});

describe('mergeCitations — folding a split pair (#1018)', () => {
  it('repoints every surface and deletes the loser', async () => {
    const drugId = await seedDrug(db);
    const entityId = await seedBioEntity(db, {}, ['drug_target']);
    const winner = await seedCitation({ type: 'pmid', identifier: PMID });
    const loser = await seedCitation({ type: 'doi', identifier: DOI });

    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'halfLife',
      citationId: loser,
      value: 4,
      unit: 'h',
    });
    await db.insert(drugParameterRevisions).values({
      drugId,
      parameter: 'halfLife',
      referenceId: loser,
      // Both handles cited on one row: the merge must not leave {winner, winner}.
      referenceIds: [winner, loser],
      createdBy: userId,
    });
    await db.insert(drugReceptorTargets).values({
      drugId,
      bioEntityId: entityId,
      interactionType: 'inhibitor',
      referenceIds: [loser],
    });
    await db.insert(wikiPages).values({
      slug: 'monografi',
      title: 'Monografi',
      content: {
        sections: {
          pk: {
            body: {
              type: 'doc',
              content: [
                { type: 'fact', attrs: { referenceIds: [loser] } },
                // Not a citation id — must survive the rewrite untouched.
                { type: 'paragraph', attrs: { year: loser } },
              ],
            },
          },
        },
      },
      createdBy: userId,
      updatedBy: userId,
    });

    const stats = await mergeCitations(db, winner, loser);
    expect(stats.rowsRepointed).toBeGreaterThan(0);

    const [entry] = await db
      .select({ citationId: parameterEntries.citationId })
      .from(parameterEntries);
    expect(entry?.citationId).toBe(winner);

    const [revision] = await db
      .select({
        referenceId: drugParameterRevisions.referenceId,
        referenceIds: drugParameterRevisions.referenceIds,
      })
      .from(drugParameterRevisions);
    expect(revision?.referenceId).toBe(winner);
    expect(revision?.referenceIds).toEqual([winner]);

    const [target] = await db
      .select({ referenceIds: drugReceptorTargets.referenceIds })
      .from(drugReceptorTargets);
    expect(target?.referenceIds).toEqual([winner]);

    const [page] = await db
      .select({ content: wikiPages.content })
      .from(wikiPages);
    const content = page?.content as {
      sections: { pk: { body: { content: Array<{ attrs: Record<string, unknown> }> } } };
    };
    expect(content.sections.pk.body.content[0]!.attrs).toEqual({
      referenceIds: [winner],
    });
    expect(content.sections.pk.body.content[1]!.attrs).toEqual({ year: loser });

    const remaining = await db.select({ id: citations.id }).from(citations);
    expect(remaining.map((r) => r.id)).toEqual([winner]);
    const [survivor] = await db
      .select({ metadata: citations.metadata })
      .from(citations);
    expect(
      (survivor?.metadata as { altIds?: Record<string, string> })?.altIds?.doi,
    ).toBe(DOI);
  });

  it('keeps the read-in-full review when both rows carry one', async () => {
    const winner = await seedCitation({ type: 'pmid', identifier: PMID });
    const loser = await seedCitation({ type: 'doi', identifier: DOI });

    // The weaker row holds the attestation that gates admissibility; losing it
    // would silently make every claim citing this paper unusable.
    const [abstractOnly] = await db
      .insert(paperReviews)
      .values({
        citationId: winner,
        reviewMarkdown: 'Kun sammendrag.',
        readInFull: false,
      })
      .returning({ id: paperReviews.id });
    const [readInFull] = await db
      .insert(paperReviews)
      .values({
        citationId: loser,
        reviewMarkdown: 'Lest i sin helhet.',
        readInFull: true,
      })
      .returning({ id: paperReviews.id });
    await db.insert(paperReviewRevisions).values({
      paperReviewId: readInFull!.id,
      citationId: loser,
      reviewMarkdown: 'Lest i sin helhet.',
      createdBy: userId,
    });

    await mergeCitations(db, winner, loser);

    const reviews = await db
      .select({
        id: paperReviews.id,
        citationId: paperReviews.citationId,
        readInFull: paperReviews.readInFull,
      })
      .from(paperReviews);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.id).toBe(readInFull!.id);
    expect(reviews[0]!.citationId).toBe(winner);
    expect(reviews[0]!.readInFull).toBe(true);
    expect(abstractOnly!.id).not.toBe(reviews[0]!.id);

    // History follows the surviving review rather than being dropped.
    const revisions = await db
      .select({
        citationId: paperReviewRevisions.citationId,
        paperReviewId: paperReviewRevisions.paperReviewId,
      })
      .from(paperReviewRevisions);
    expect(revisions).toEqual([
      { citationId: winner, paperReviewId: readInFull!.id },
    ]);
  });

  it('is a no-op when asked to merge a row into itself', async () => {
    const id = await seedCitation({});
    const stats = await mergeCitations(db, id, id);
    expect(stats.rowsRepointed).toBe(0);
    const rows = await db.select({ id: citations.id }).from(citations);
    expect(rows).toHaveLength(1);
  });

  it('keeps the retired review’s own history when the loser’s review wins', async () => {
    // Both rows carry a review AND both carry revisions. The winner row's
    // review is the one retired here (the loser's is read-in-full), and its
    // revisions are scoped to the WINNER citation — so a citation-scoped
    // reparent misses them and `paper_review_id ON DELETE CASCADE` destroys
    // history that belongs to this paper.
    const winner = await seedCitation({ type: 'pmid', identifier: PMID });
    const loser = await seedCitation({ type: 'doi', identifier: DOI });

    const [abstractOnly] = await db
      .insert(paperReviews)
      .values({
        citationId: winner,
        reviewMarkdown: 'Kun sammendrag lest.',
        readInFull: false,
      })
      .returning({ id: paperReviews.id });
    const [readInFull] = await db
      .insert(paperReviews)
      .values({
        citationId: loser,
        reviewMarkdown: 'Lest i sin helhet.',
        readInFull: true,
      })
      .returning({ id: paperReviews.id });

    await db.insert(paperReviewRevisions).values([
      {
        paperReviewId: abstractOnly!.id,
        citationId: winner,
        reviewMarkdown: 'Tidligere utkast på vinnerraden.',
        readInFull: false,
      },
      {
        paperReviewId: readInFull!.id,
        citationId: loser,
        reviewMarkdown: 'Tidligere utkast på taperraden.',
        readInFull: true,
      },
    ]);

    await mergeCitations(db, winner, loser, { actorUserId: userId });

    const revisions = await db
      .select({
        citationId: paperReviewRevisions.citationId,
        paperReviewId: paperReviewRevisions.paperReviewId,
      })
      .from(paperReviewRevisions);
    // Both survive, re-parented onto the review that won.
    expect(revisions).toHaveLength(2);
    expect(
      revisions.every(
        (r) => r.citationId === winner && r.paperReviewId === readInFull!.id,
      ),
    ).toBe(true);
  });

  it('repoints a queued paper_review edit, and only that edit type', async () => {
    const winner = await seedCitation({ type: 'pmid', identifier: PMID });
    const loser = await seedCitation({ type: 'doi', identifier: DOI });

    const [reviewEdit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'paper_review',
        targetId: loser,
        proposedValue: { reviewMarkdown: 'Køet anmeldelse.' },
        submittedBy: userId,
      })
      .returning({ id: pendingEdits.id });
    // `target_id` is polymorphic: on any other edit type the same number means
    // something else entirely (a drug, a wiki page), so it must not be touched.
    const [otherEdit] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: loser,
        proposedValue: { factStatement: 'Urelatert.' },
        submittedBy: userId,
      })
      .returning({ id: pendingEdits.id });

    await mergeCitations(db, winner, loser, { actorUserId: userId });

    const [moved] = await db
      .select({ targetId: pendingEdits.targetId })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, reviewEdit!.id));
    expect(moved?.targetId).toBe(winner);

    const [untouched] = await db
      .select({ targetId: pendingEdits.targetId })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, otherEdit!.id));
    expect(untouched?.targetId).toBe(loser);
  });

  it('locks the pending proposals citing the loser before touching any review', async () => {
    // A consensus publication holds the fact's row before its cited papers'
    // review rows; the merge takes the same order, so the two cannot deadlock.
    const winner = await seedCitation({ type: 'pmid', identifier: PMID });
    const loser = await seedCitation({ type: 'doi', identifier: DOI });
    const insert = async (values: Partial<typeof pendingEdits.$inferInsert>) => {
      const [row] = await db
        .insert(pendingEdits)
        .values({
          editType: 'wiki_fact',
          targetId: 1,
          proposedValue: { factStatement: 'x' },
          submittedBy: userId,
          ...values,
        })
        .returning({ id: pendingEdits.id });
      return row!.id;
    };
    const byColumn = await insert({ referenceId: loser });
    const byArray = await insert({ referenceIds: [winner, loser] });
    const byNode = await insert({
      proposedValue: { type: 'fact', attrs: { factId: 'f', referenceIds: [loser] } },
    });
    const byMarker = await insert({ proposedMeta: { unverifiedReferenceIds: [loser] } });
    // Whatever its status: a draft or returned one can turn pending mid-merge.
    const returned = await insert({ referenceId: loser, status: 'returned' });
    // Not locked: a queued review (the merge writes those after the reviews)
    // and one citing only the winner.
    await insert({ editType: 'paper_review', targetId: loser, proposedValue: {} });
    await insert({ referenceId: winner });

    const locked = await db.transaction((tx) =>
      lockPendingEditsCitingCitation(tx as never, loser),
    );
    expect(locked).toEqual([byColumn, byArray, byNode, byMarker, returned]);
  });

  it("repoints an ingested fact's unread-paper marker", async () => {
    // Consensus holds the fact until every listed paper has a read-in-full
    // review; left on the loser, the marker would wait on a deleted citation
    // and no review of the surviving paper could release it.
    const winner = await seedCitation({ type: 'pmid', identifier: PMID });
    const loser = await seedCitation({ type: 'doi', identifier: DOI });
    const [fact] = await db
      .insert(pendingEdits)
      .values({
        editType: 'wiki_fact',
        targetId: 1,
        proposedValue: { factStatement: 'Usjekket påstand.' },
        proposedMeta: {
          source: 'conversation_ingestion',
          unverifiedSourceKeys: ['S1', 'S2'],
          unverifiedReferenceIds: [loser, winner],
          // Not the merge's to write: it touches the marker key alone.
          returnedAt: '2026-10-06T00:00:00.000Z',
        },
        submittedBy: userId,
      })
      .returning({ id: pendingEdits.id });

    await mergeCitations(db, winner, loser, { actorUserId: userId });

    const [moved] = await db
      .select({ proposedMeta: pendingEdits.proposedMeta })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, fact!.id));
    expect(moved?.proposedMeta).toEqual({
      source: 'conversation_ingestion',
      unverifiedSourceKeys: ['S1', 'S2'],
      unverifiedReferenceIds: [winner],
      returnedAt: '2026-10-06T00:00:00.000Z',
    });
  });
});

describe('mergeCitations — parameter summary recompute (#1018)', () => {
  // A review's `overall_score` weights its entries in source-weighted
  // aggregation, so both of these move the cached value: entries changing hands
  // (now weighted by the winner's review) and the winner ending up under a
  // different review. Neither goes through the entry-mutation path that
  // normally triggers a recompute.
  async function mergeWithEntryOn(
    citationId: number,
    winner: number,
    loser: number,
    actorUserId: number | null,
  ) {
    const drugId = await seedDrug(db);
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'halfLife',
      citationId,
      value: 4,
      unit: 'h',
    });
    return mergeCitations(db, winner, loser, { actorUserId });
  }

  it('recomputes when parameter entries change hands', async () => {
    const winner = await seedCitation({ type: 'pmid', identifier: PMID });
    const loser = await seedCitation({ type: 'doi', identifier: DOI });
    const stats = await mergeWithEntryOn(loser, winner, loser, userId);
    expect(stats.summaryRecompute).toBe('ran');
  });

  it('recomputes when the winner ends up under a different review', async () => {
    const winner = await seedCitation({ type: 'pmid', identifier: PMID });
    const loser = await seedCitation({ type: 'doi', identifier: DOI });
    // No entries move; the winner simply gains the loser's review.
    await db.insert(paperReviews).values({
      citationId: loser,
      reviewMarkdown: 'Lest i sin helhet.',
      readInFull: true,
    });

    const stats = await mergeCitations(db, winner, loser, {
      actorUserId: userId,
    });
    expect(stats.summaryRecompute).toBe('ran');
  });

  it('does no work when nothing that feeds a summary moved', async () => {
    const winner = await seedCitation({ type: 'pmid', identifier: PMID });
    const loser = await seedCitation({ type: 'doi', identifier: DOI });
    const stats = await mergeCitations(db, winner, loser, {
      actorUserId: userId,
    });
    expect(stats.summaryRecompute).toBe('not-needed');
  });

  it('reports a needed recompute it could not attribute', async () => {
    // Surfaced rather than swallowed: a caller with no actor cannot silently
    // leave stale cached values behind.
    const winner = await seedCitation({ type: 'pmid', identifier: PMID });
    const loser = await seedCitation({ type: 'doi', identifier: DOI });
    const stats = await mergeWithEntryOn(loser, winner, loser, null);
    expect(stats.summaryRecompute).toBe('skipped');
  });
});

describe('alt-handle lookup index usability (#1018)', () => {
  afterAll(async () => {
    await db.execute(sql`SET enable_seqscan = on`);
  });

  it('created the alt-id lookup indexes', async () => {
    const rows = await db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes
      WHERE indexname IN (
        'citations_alt_pmid_idx',
        'citations_alt_doi_idx',
        'citations_alt_url_idx'
      )
    `);
    expect((rows.rows ?? []).map((r) => r.indexname).sort()).toEqual([
      'citations_alt_doi_idx',
      'citations_alt_pmid_idx',
      'citations_alt_url_idx',
    ]);
  });

  it.each([
    ['doi', DOI, 'citations_alt_doi_idx'],
    ['pmid', PMID, 'citations_alt_pmid_idx'],
  ] as const)(
    'can answer the stored-%s lookup from its index',
    async (type, identifier, index) => {
      // Planner cost estimates favour a sequential scan on a table this small,
      // so seqscan is disabled to ask the narrower question: *can* the index
      // answer this? The predicate is the real one the write path builds.
      await db.execute(sql`SET enable_seqscan = off`);
      // No alias: the predicate qualifies its columns with the full table name.
      const explained = await db.execute<{ 'QUERY PLAN': string }>(sql`
        EXPLAIN SELECT id FROM citations
        WHERE ${handleMatch([{ type, identifier }])}
      `);
      const plan = (explained.rows ?? [])
        .map((row) => row['QUERY PLAN'])
        .join('\n');
      expect(plan).toContain(index);
    },
  );
});
