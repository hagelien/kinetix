import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  approvals,
  citations,
  drugParameters,
  drugParameterRevisions,
  paperReviews,
  parameterEntries,
  pendingEdits,
} from '../../db/schema.js';
import {
  entryDuplicateExists,
  getParameterSummariesForDrug,
  getParameterSummariesWithRoutes,
  listEntriesForDrug,
  recomputeAndCacheParameterSummary,
  recomputeParameterAndDependents,
  recomputeSummariesCitingCitation,
  recomputeSummariesForDrug,
} from '../../api/_lib/parameter-entries-store.js';
import { recordPaperReview } from '../../api/_lib/paper-review-store.js';
import { upsertDrugParameter } from '../../api/_lib/drugParameterStore.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
});

async function seedEntry(
  drugId: number,
  over: Partial<typeof parameterEntries.$inferInsert>,
): Promise<number> {
  const [row] = await db
    .insert(parameterEntries)
    .values({
      drugId,
      parameter: 'therapeuticConcentration',
      unit: 'mg/L',
      matrix: 'whole_blood',
      scenario: 'living_therapeutic',
      origin: 'legacy',
      ...over,
    })
    .returning({ id: parameterEntries.id });
  return row!.id;
}

async function readParamValue(
  drugId: number,
  parameter: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select()
    .from(drugParameters)
    .where(
      and(
        eq(drugParameters.drugId, drugId),
        eq(drugParameters.parameter, parameter),
      ),
    );
  return (row?.value as Record<string, unknown>) ?? null;
}

describe('recomputeAndCacheParameterSummary', () => {
  it('caches the weighted median + full range and records a revision', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    await seedEntry(drugId, { median: '10' });
    await seedEntry(drugId, { median: '20' });
    await seedEntry(drugId, { median: '30' });

    await recomputeAndCacheParameterSummary(
      drugId,
      'therapeuticConcentration',
      userId,
    );

    const value = await readParamValue(drugId, 'therapeuticConcentration');
    expect(value).not.toBeNull();
    expect(Number(value!.median)).toBe(20); // weighted median of 10/20/30
    expect(Number(value!.min)).toBe(10);
    expect(Number(value!.max)).toBe(30);
    expect(value!.unit).toBe('mg/L');

    const revisions = await db
      .select()
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.drugId, drugId));
    expect(revisions).toHaveLength(1);
    // Coded summary (translated at the React boundary): recomputed from 3.
    expect(revisions[0]!.editSummary).toBe('auto:param_entries_recomputed:3');
  });

  it('records which citations entered and left the pool across recomputes (#1358)', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);

    const [citeA] = await db
      .insert(citations)
      .values({ type: 'pmid', identifier: '111', metadata: { title: 'Paper A' } })
      .returning({ id: citations.id });
    const [citeB] = await db
      .insert(citations)
      .values({ type: 'pmid', identifier: '222', metadata: { title: 'Paper B' } })
      .returning({ id: citations.id });

    await seedEntry(drugId, { median: '10', citationId: citeA!.id });
    const entryB = await seedEntry(drugId, { median: '20', citationId: citeB!.id });

    await recomputeAndCacheParameterSummary(drugId, 'therapeuticConcentration', userId);

    await db.delete(parameterEntries).where(eq(parameterEntries.id, entryB));
    await recomputeAndCacheParameterSummary(drugId, 'therapeuticConcentration', userId);

    const revisions = await db
      .select()
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.drugId, drugId))
      .orderBy(drugParameterRevisions.id);
    expect(revisions).toHaveLength(2);

    const byCitationId = (
      entries: { citationId: number; label: string | null }[],
    ) => [...entries].sort((a, b) => a.citationId - b.citationId);

    // First revision: both sources are new (nothing to diff against).
    expect(revisions[0]!.sourceDiff).toEqual({
      added: byCitationId([
        { citationId: citeA!.id, label: 'Paper A' },
        { citationId: citeB!.id, label: 'Paper B' },
      ]),
      removed: [],
    });
    // Second revision: citation B dropped out of the pool, with its title
    // still resolvable (it wasn't deleted, just its entry was).
    expect(revisions[1]!.sourceDiff).toEqual({
      added: [],
      removed: [{ citationId: citeB!.id, label: 'Paper B' }],
    });
  });

  it('keeps a removed citation id when the citation row is already gone', async () => {
    // Mirrors scripts/repair-hallucinated-citations.ts: it deletes the entry
    // AND the citation before recomputing, so the label can't be resolved —
    // the diff should still record the id rather than dropping the entry.
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);

    const [cite] = await db
      .insert(citations)
      .values({ type: 'pmid', identifier: '333', metadata: { title: 'Doomed paper' } })
      .returning({ id: citations.id });
    const entryId = await seedEntry(drugId, { median: '10', citationId: cite!.id });

    await recomputeAndCacheParameterSummary(drugId, 'therapeuticConcentration', userId);

    await db.delete(parameterEntries).where(eq(parameterEntries.id, entryId));
    await db.delete(citations).where(eq(citations.id, cite!.id));
    await recomputeAndCacheParameterSummary(
      drugId,
      'therapeuticConcentration',
      userId,
      null,
      'citation_cleanup',
    );

    const revisions = await db
      .select()
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.drugId, drugId))
      .orderBy(drugParameterRevisions.id);
    expect(revisions).toHaveLength(2);
    expect(revisions[1]!.editSummary).toBe('auto:param_entries_cleared:citation_cleanup');
    expect(revisions[1]!.sourceDiff).toEqual({
      added: [],
      removed: [{ citationId: cite!.id, label: null }],
    });
  });

  it('excludes a route-specific entry from the drug-level aggregate (CV-2c-4b)', async () => {
    // bioavailability is route-optional: a route-specific F (a per-route value) must NOT pool into
    // the drug-level cache, which aggregates only the route-less (drug-level) entries.
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    await seedEntry(drugId, {
      parameter: 'bioavailability',
      unit: 'fraction',
      matrix: null,
      scenario: null,
      median: '0.8',
    }); // drug-level (route null)
    await seedEntry(drugId, {
      parameter: 'bioavailability',
      unit: 'fraction',
      matrix: null,
      scenario: null,
      route: 'oral',
      median: '0.3',
    }); // route-specific — must be excluded from the drug-level pool

    await recomputeAndCacheParameterSummary(drugId, 'bioavailability', userId);

    const value = await readParamValue(drugId, 'bioavailability');
    expect(value).not.toBeNull();
    // Only the drug-level 0.8 aggregates; the route-specific 0.3 is left out (not (0.8+0.3)/2).
    expect(Number(value!.median)).toBe(0.8);
    expect(Number(value!.min)).toBe(0.8);
    expect(Number(value!.max)).toBe(0.8);
  });

  it('does not let a route-specific entry supersede a route-null grandfathered row (CV-2c-4)', async () => {
    // A grandfathered drug-level F is route-null and the drug-level aggregate pools only route-null
    // entries, so a route-SPECIFIC real F must not drop the grandfathered source from the list — that
    // would hide the row while the drug-level summary still shows its value.
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    await seedEntry(drugId, {
      parameter: 'bioavailability',
      unit: 'fraction',
      matrix: null,
      scenario: null,
      median: '0.8',
      origin: 'grandfathered',
      createdBy: userId,
    });
    await seedEntry(drugId, {
      parameter: 'bioavailability',
      unit: 'fraction',
      matrix: null,
      scenario: null,
      median: '0.3',
      route: 'oral',
      origin: 'contributor',
      createdBy: userId,
    });

    const list = await listEntriesForDrug(drugId, 'bioavailability');
    // Both survive: the routed real entry does not supersede the route-null grandfathered evidence.
    expect(list).toHaveLength(2);
    expect(list.some((e) => e.origin === 'grandfathered' && e.route == null)).toBe(true);
    expect(list.some((e) => e.route === 'oral')).toBe(true);
  });

  it('leaves a hand-authored value untouched when there are no entries', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'toxicConcentration',
      value: { min: 5, max: 50, unit: 'mg/L' },
      updatedBy: userId,
    });

    await recomputeAndCacheParameterSummary(
      drugId,
      'toxicConcentration',
      userId,
    );

    const value = await readParamValue(drugId, 'toxicConcentration');
    expect(Number(value!.min)).toBe(5);
    expect(Number(value!.max)).toBe(50);
    // No recompute revision was written (grandfather rule).
    const revisions = await db
      .select()
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.drugId, drugId));
    expect(revisions).toHaveLength(0);
  });

  it('weights a large well-reviewed study over a small one', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);

    const [cite] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1/big', metadata: {} })
      .returning({ id: citations.id });
    await db.insert(paperReviews).values({
      citationId: cite!.id,
      reviewMarkdown: 'big study',
      overallScore: 100,
    });

    await seedEntry(drugId, { median: '10', n: 1 });
    await seedEntry(drugId, {
      median: '100',
      n: 500,
      citationId: cite!.id,
    });

    await recomputeAndCacheParameterSummary(
      drugId,
      'therapeuticConcentration',
      userId,
    );
    const value = await readParamValue(drugId, 'therapeuticConcentration');
    expect(Number(value!.median)).toBe(100);
  });

  it('records the prior source count when a later recompute changes it (#1358)', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    await seedEntry(drugId, { median: '10' });
    await seedEntry(drugId, { median: '20' });
    const thirdEntryId = await seedEntry(drugId, { median: '30' });

    await recomputeAndCacheParameterSummary(
      drugId,
      'therapeuticConcentration',
      userId,
    );
    // Drop a source and recompute again — the resulting revision must say
    // where the count came FROM, not just what it landed on, or "how did we
    // go from 3 sources to 2?" is unanswerable from the history alone.
    await db
      .delete(parameterEntries)
      .where(eq(parameterEntries.id, thirdEntryId));
    await recomputeAndCacheParameterSummary(
      drugId,
      'therapeuticConcentration',
      userId,
    );

    const revisions = await db
      .select()
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.drugId, drugId))
      .orderBy(drugParameterRevisions.id);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]!.editSummary).toBe('auto:param_entries_recomputed:3');
    expect(revisions[1]!.editSummary).toBe(
      'auto:param_entries_recomputed:2:from:3',
    );
  });
});

describe('cache clear + normalization recompute', () => {
  it('clears the cache it produced once the last entry is deleted', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    const eid = await seedEntry(drugId, { median: '25' });
    await recomputeAndCacheParameterSummary(
      drugId,
      'therapeuticConcentration',
      userId,
    );
    expect(await readParamValue(drugId, 'therapeuticConcentration')).not.toBeNull();

    // Delete the only entry, then recompute.
    await db.delete(parameterEntries).where(eq(parameterEntries.id, eid));
    await recomputeAndCacheParameterSummary(
      drugId,
      'therapeuticConcentration',
      userId,
    );

    // The derived cache is gone (not a stale value driving consumers).
    expect(await readParamValue(drugId, 'therapeuticConcentration')).toBeNull();
  });

  it('leaves a hand-authored value in place when entries are removed', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    // Hand-authored value (no aggregate note marker).
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'toxicConcentration',
      value: { min: 5, max: 50, unit: 'mg/L' },
      updatedBy: userId,
    });

    await recomputeAndCacheParameterSummary(
      drugId,
      'toxicConcentration',
      userId,
    );

    // No entries exist → authored value untouched.
    const value = await readParamValue(drugId, 'toxicConcentration');
    expect(Number(value!.min)).toBe(5);
  });

  it('recomputes summaries for a drug when a normalization input changes', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    // A serum entry: its whole-blood value depends on the blood:plasma ratio.
    await seedEntry(drugId, { median: '100', matrix: 'serum' });
    await recomputeSummariesForDrug(drugId, userId);
    const before = await readParamValue(drugId, 'therapeuticConcentration');
    expect(Number(before!.median)).toBe(100); // ratio defaults to 1

    // Set a blood:plasma ratio of 0.5, then recompute as the write path would.
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'bloodPlasmaRatio',
      value: { median: 0.5, unit: 'ratio' },
      updatedBy: userId,
    });
    await recomputeSummariesForDrug(drugId, userId);

    const after = await readParamValue(drugId, 'therapeuticConcentration');
    expect(Number(after!.median)).toBe(50); // 0.5 × 100
  });
});

describe('recomputeSummariesCitingCitation', () => {
  it('refreshes caches for parameters whose entries cite a re-scored paper', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    const [a] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1/a', metadata: {} })
      .returning({ id: citations.id });
    const [b] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1/b', metadata: {} })
      .returning({ id: citations.id });
    await seedEntry(drugId, { median: '10', n: 100, citationId: a!.id });
    await seedEntry(drugId, { median: '100', n: 100, citationId: b!.id });

    // No reviews yet → equal weights → the weighted median picks the lower (10).
    await recomputeSummariesForDrug(drugId, userId);
    expect(
      Number((await readParamValue(drugId, 'therapeuticConcentration'))!.median),
    ).toBe(10);

    // Publish a top review for b's paper, then recompute only citing params —
    // b now outweighs a, moving the pooled median up to 100. Without the
    // recompute the cached value would stay at 10 while the read-time summary
    // already reflects the new score.
    await db.insert(paperReviews).values({
      citationId: b!.id,
      reviewMarkdown: 'strong',
      overallScore: 100,
    });
    await recomputeSummariesCitingCitation(b!.id, userId);

    expect(
      Number((await readParamValue(drugId, 'therapeuticConcentration'))!.median),
    ).toBe(100);
  });
});

describe('entryDuplicateExists', () => {
  it('detects an exact duplicate observation and allows distinct ones', async () => {
    const drugId = await seedDrug(db);
    const citationId = await (async () => {
      const [c] = await db
        .insert(citations)
        .values({ type: 'doi', identifier: '10.1/dup', metadata: {} })
        .returning({ id: citations.id });
      return c!.id;
    })();
    await seedEntry(drugId, { median: '10', citationId, origin: 'contributor' });

    const base = {
      drugId,
      parameter: 'therapeuticConcentration' as const,
      median: 10,
      unit: 'mg/L',
      matrix: 'whole_blood' as const,
      scenario: 'living_therapeutic' as const,
      citationId,
    };
    expect(await entryDuplicateExists(base)).toBe(true);
    // A different value, matrix, or citation is not a duplicate.
    expect(await entryDuplicateExists({ ...base, median: 11 })).toBe(false);
    expect(await entryDuplicateExists({ ...base, matrix: 'serum' })).toBe(false);
  });

  it('excludes the row being updated from its own duplicate check', async () => {
    const drugId = await seedDrug(db);
    const [cite] = await db
      .insert(citations)
      .values({ type: 'doi', identifier: '10.1/dup2', metadata: {} })
      .returning({ id: citations.id });
    const entryId = await seedEntry(drugId, {
      median: '10',
      citationId: cite!.id,
      origin: 'contributor',
    });
    const base = {
      drugId,
      parameter: 'therapeuticConcentration' as const,
      median: 10,
      unit: 'mg/L',
      matrix: 'whole_blood' as const,
      scenario: 'living_therapeutic' as const,
      citationId: cite!.id,
    };
    // Its own identical value is not a self-duplicate when excluded…
    expect(await entryDuplicateExists(base, entryId)).toBe(false);
    // …but a second identical row would be.
    await seedEntry(drugId, {
      median: '10',
      citationId: cite!.id,
      origin: 'contributor',
    });
    expect(await entryDuplicateExists(base, entryId)).toBe(true);
  });
});

describe('grandfathered rows in the store', () => {
  it('excludes a superseded grandfathered row from summary and list', async () => {
    const drugId = await seedDrug(db);
    await seedEntry(drugId, { median: '10', origin: 'grandfathered' });
    await seedEntry(drugId, { median: '30', origin: 'contributor' });

    const summaries = await getParameterSummariesForDrug(drugId);
    // Only the real source is pooled/counted.
    expect(summaries.therapeuticConcentration!.entryCount).toBe(1);
    expect(summaries.therapeuticConcentration!.representative).toBe(30);

    const list = await listEntriesForDrug(drugId, 'therapeuticConcentration');
    expect(list).toHaveLength(1);
    expect(list[0]!.origin).toBe('contributor');
  });

});

describe('recordPaperReview cache reconciliation', () => {
  it('recomputes when a score change moves the pooled value, not otherwise', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    const cites: number[] = [];
    for (const suffix of ['a', 'b', 'c']) {
      const [cite] = await db
        .insert(citations)
        .values({ type: 'doi', identifier: `10.1/rev-${suffix}`, metadata: {} })
        .returning({ id: citations.id });
      cites.push(cite!.id);
    }
    // Three sources at 10 / 20 / 30. Un-reviewed they carry equal weight, so
    // the weighted median sits on the middle one.
    await seedEntry(drugId, { median: '10', citationId: cites[0], origin: 'contributor' });
    await seedEntry(drugId, { median: '20', citationId: cites[1], origin: 'contributor' });
    await seedEntry(drugId, { median: '30', citationId: cites[2], origin: 'contributor' });

    const countRevisions = async () =>
      (
        await db
          .select()
          .from(drugParameterRevisions)
          .where(eq(drugParameterRevisions.drugId, drugId))
      ).length;

    const review = (citationId: number, markdown: string, score: number) =>
      recordPaperReview({
        citationId,
        authorUserId: userId,
        input: {
          reviewMarkdown: markdown,
          overallScore: score,
          conclusionSupport: null,
          reviewConfidence: null,
          readInFull: true,
        },
      });

    // A top score on the lowest source outweighs the other two and drags the
    // pooled median down to it — the cache moves, so a revision is written.
    await review(cites[0]!, 'first', 100);
    const afterFirst = await countRevisions();
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    expect((await readParamValue(drugId, 'therapeuticConcentration'))?.median).toBe(10);

    // Same score, changed prose → the pooled value is unchanged, so no new
    // revision: an identical cache must not be re-published as history noise.
    await review(cites[0]!, 'reworded', 100);
    expect(await countRevisions()).toBe(afterFirst);

    // Dropping that source's score back to the floor restores equal weights and
    // the median returns to the middle value — a real change, so a revision.
    await review(cites[0]!, 'rescored', 0);
    expect(await countRevisions()).toBeGreaterThan(afterFirst);
    expect((await readParamValue(drugId, 'therapeuticConcentration'))?.median).toBe(20);
  });
});

describe('recomputeSummariesForDrug — approved-edit linkage', () => {
  it('links derived revisions to the edit and stamps approvals', async () => {
    const userId = await seedUser(db);
    const reviewerId = await seedUser(db, {
      email: 'normrev@example.com',
      username: 'normrev',
    });
    const drugId = await seedDrug(db);
    await seedEntry(drugId, { median: '25', origin: 'contributor' });
    // A stand-in approved normalization-input edit whose id the revisions link to.
    const [pe] = await db
      .insert(pendingEdits)
      .values({
        editType: 'parameter',
        targetId: drugId,
        parameter: 'bloodPlasmaRatio',
        proposedValue: { median: 0.5 } as never,
        status: 'approved',
        submittedBy: userId,
      })
      .returning({ id: pendingEdits.id });

    await recomputeSummariesForDrug(drugId, userId, {
      pendingEditId: pe!.id,
      approvedBy: reviewerId,
    });

    const [rev] = await db
      .select()
      .from(drugParameterRevisions)
      .where(
        and(
          eq(drugParameterRevisions.drugId, drugId),
          eq(drugParameterRevisions.parameter, 'therapeuticConcentration'),
        ),
      );
    expect(rev!.pendingEditId).toBe(pe!.id);
    const stamps = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.targetType, 'drug_parameter_revision'),
          eq(approvals.targetId, rev!.id),
        ),
      );
    expect(stamps.length).toBeGreaterThanOrEqual(1);
  });
});

describe('getParameterSummariesForDrug', () => {
  it('returns aggregates keyed by parameter, omitting empty ones', async () => {
    const drugId = await seedDrug(db);
    await seedEntry(drugId, { median: '15' });
    await seedEntry(drugId, {
      parameter: 'toxicConcentration',
      scenario: 'living_toxic',
      median: '80',
    });

    const summaries = await getParameterSummariesForDrug(drugId);
    expect(Object.keys(summaries).sort()).toEqual([
      'therapeuticConcentration',
      'toxicConcentration',
    ]);
    expect(summaries.therapeuticConcentration!.representative).toBe(15);
    expect(summaries.toxicConcentration!.representative).toBe(80);
    expect(summaries.therapeuticConcentration!.unit).toBe('mg/L');
  });

  it('excludes a route-specific entry from the bulk drug-level summary (CV-2c-4b)', async () => {
    // The monograph/plot summary must agree with the route-null cache: a per-route F does not pool in.
    const drugId = await seedDrug(db);
    await seedEntry(drugId, {
      parameter: 'bioavailability',
      unit: 'fraction',
      matrix: null,
      scenario: null,
      median: '0.8',
    }); // drug-level
    await seedEntry(drugId, {
      parameter: 'bioavailability',
      unit: 'fraction',
      matrix: null,
      scenario: null,
      route: 'oral',
      median: '0.3',
    }); // route-specific — excluded

    const summaries = await getParameterSummariesForDrug(drugId);
    expect(summaries.bioavailability!.representative).toBe(0.8);
  });
});

describe('getParameterSummariesWithRoutes', () => {
  it('pools a route-scoped entry into its own route, never the drug-level summary', async () => {
    const drugId = await seedDrug(db);
    await seedEntry(drugId, {
      parameter: 'bioavailability',
      unit: 'fraction',
      matrix: null,
      scenario: null,
      median: '0.8',
    }); // drug-level
    await seedEntry(drugId, {
      parameter: 'bioavailability',
      unit: 'fraction',
      matrix: null,
      scenario: null,
      route: 'oral',
      median: '0.3',
    });
    await seedEntry(drugId, {
      parameter: 'bioavailability',
      unit: 'fraction',
      matrix: null,
      scenario: null,
      route: 'intranasal',
      median: '0.5',
    });

    const { summaries, routeSummaries } =
      await getParameterSummariesWithRoutes(drugId);
    // The drug-level pool is unchanged: neither route value leaks into it.
    expect(summaries.bioavailability!.representative).toBe(0.8);
    // Each route pools alone — an oral F is not an intranasal one.
    expect(routeSummaries.bioavailability!.oral!.representative).toBe(0.3);
    expect(routeSummaries.bioavailability!.intranasal!.representative).toBe(0.5);
  });

  it('still reports a route pool when every entry has been curated onto a route', async () => {
    // The regression this exists for: moving a drug's only Tmax entries onto `oral` used to
    // leave the monograph field and the forest plot empty, with the dialog claiming no source
    // values were registered while listing them.
    const drugId = await seedDrug(db);
    await seedEntry(drugId, {
      parameter: 'tmax',
      unit: 'h',
      matrix: null,
      scenario: null,
      route: 'oral',
      median: '3.3',
    });

    const { summaries, routeSummaries } =
      await getParameterSummariesWithRoutes(drugId);
    expect(summaries.tmax).toBeUndefined();
    expect(routeSummaries.tmax!.oral!.representative).toBe(3.3);
  });
});


describe('non-concentration parameters (matrix-free entries)', () => {
  it('aggregates and caches a half-life from matrix-free source rows', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    // No matrix, no scenario — the columns are nullable since 0085, and a
    // half-life has neither dimension.
    await db.insert(parameterEntries).values([
      {
        drugId,
        parameter: 'halfLife',
        unit: 'h',
        matrix: null,
        scenario: null,
        origin: 'contributor',
        low: '4',
        high: '9',
        median: '6',
      },
      {
        drugId,
        parameter: 'halfLife',
        unit: 'h',
        matrix: null,
        scenario: null,
        origin: 'contributor',
        median: '12',
      },
    ]);

    await recomputeAndCacheParameterSummary(drugId, 'halfLife', userId);
    const cached = await readParamValue(drugId, 'halfLife');
    expect(cached?.unit).toBe('h');
    expect(cached?.median).toBe(6);
    // Bounds span the reported interval, not just the central estimates.
    expect(cached?.min).toBe(4);
    expect(cached?.max).toBe(12);
    expect(cached?.derivedFromEntries).toBe(true);

    const summaries = await getParameterSummariesForDrug(drugId);
    expect(summaries.halfLife?.pooledCount).toBe(2);
    // Nothing is normalized to whole blood, and there is no matrix breakdown.
    expect(summaries.halfLife?.normalizedToWholeBlood).toBe(false);
    expect(summaries.halfLife?.byMatrix).toEqual([]);
  });

  it('restales the concentration caches when a blood:plasma-ratio entry lands', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    // A serum concentration is published as its whole-blood equivalent, scaled
    // by the drug's B/P ratio…
    await seedEntry(drugId, {
      median: '10',
      matrix: 'serum',
      origin: 'contributor',
    });
    await recomputeAndCacheParameterSummary(
      drugId,
      'therapeuticConcentration',
      userId,
    );
    // …which with no ratio on file is identity.
    expect(
      (await readParamValue(drugId, 'therapeuticConcentration'))?.median,
    ).toBe(10);

    // …so a source value FOR the ratio itself moves that concentration too.
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'bloodPlasmaRatio',
      unit: 'ratio',
      matrix: null,
      scenario: null,
      origin: 'contributor',
      median: '2',
    });
    await recomputeParameterAndDependents(drugId, 'bloodPlasmaRatio', userId);

    expect((await readParamValue(drugId, 'bloodPlasmaRatio'))?.median).toBe(2);
    expect(
      (await readParamValue(drugId, 'therapeuticConcentration'))?.median,
    ).toBe(20);
  });
});


describe('recompute no-op guard — citation provenance', () => {
  it('still writes a revision when only the contributing citation changes', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    const cited = async (identifier: string) => {
      const [c] = await db
        .insert(citations)
        .values({ type: 'doi', identifier, metadata: {} })
        .returning({ id: citations.id });
      return c!.id;
    };
    const first = await cited('10.1/first');
    const second = await cited('10.1/second');

    const entryId = await seedEntry(drugId, {
      median: '25',
      citationId: first,
      origin: 'contributor',
    });
    await recomputeAndCacheParameterSummary(
      drugId,
      'therapeuticConcentration',
      userId,
    );
    const revisionsAfterFirst = await db
      .select()
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.drugId, drugId));
    expect(revisionsAfterFirst).toHaveLength(1);
    expect(revisionsAfterFirst[0]!.referenceIds).toEqual([first]);

    // Re-point the entry at a different paper reporting the SAME value: the
    // pooled number, bounds and source count are all unchanged, so only the
    // provenance moved. A revision must still be recorded — the referenceIds
    // chain is what marks the new reference as cited by this parameter.
    await db
      .update(parameterEntries)
      .set({ citationId: second })
      .where(eq(parameterEntries.id, entryId));
    await recomputeAndCacheParameterSummary(
      drugId,
      'therapeuticConcentration',
      userId,
    );
    const revisions = await db
      .select()
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.drugId, drugId));
    expect(revisions).toHaveLength(2);
    expect(revisions.at(-1)!.referenceIds).toEqual([second]);

    // A genuine no-op (nothing changed at all) still writes nothing.
    await recomputeAndCacheParameterSummary(
      drugId,
      'therapeuticConcentration',
      userId,
    );
    expect(
      await db
        .select()
        .from(drugParameterRevisions)
        .where(eq(drugParameterRevisions.drugId, drugId)),
    ).toHaveLength(2);
  });
});

describe('recomputeSummariesCitingCitation — normalization cascade', () => {
  it('rescales concentrations when a re-score moves the blood:plasma ratio', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    const cited = async (identifier: string) => {
      const [c] = await db
        .insert(citations)
        .values({ type: 'doi', identifier, metadata: {} })
        .returning({ id: citations.id });
      return c!.id;
    };
    // Two B/P sources; the score a review gives one of them decides which wins
    // the weighted median.
    const lowRatioCite = await cited('10.1/bp-low');
    const highRatioCite = await cited('10.1/bp-high');
    for (const [citationId, median] of [
      [lowRatioCite, '1'],
      [highRatioCite, '2'],
    ] as const) {
      await db.insert(parameterEntries).values({
        drugId,
        parameter: 'bloodPlasmaRatio',
        unit: 'ratio',
        matrix: null,
        scenario: null,
        origin: 'contributor',
        citationId,
        median,
      });
    }
    // A serum concentration whose published value is scaled by that ratio.
    await seedEntry(drugId, {
      median: '10',
      matrix: 'serum',
      origin: 'contributor',
    });
    await recomputeSummariesForDrug(drugId, userId);
    expect((await readParamValue(drugId, 'bloodPlasmaRatio'))?.median).toBe(1);
    expect(
      (await readParamValue(drugId, 'therapeuticConcentration'))?.median,
    ).toBe(10);

    // Reviewing the higher-ratio paper outweighs the other and moves B/P to 2.
    // Nothing about the concentration ENTRY changed, but its whole-blood
    // equivalent must follow the new ratio in the same pass.
    await recordPaperReview({
      citationId: highRatioCite,
      authorUserId: userId,
      input: {
        reviewMarkdown: 'strong',
        overallScore: 100,
        conclusionSupport: null,
        reviewConfidence: null,
        readInFull: true,
      },
    });

    expect((await readParamValue(drugId, 'bloodPlasmaRatio'))?.median).toBe(2);
    expect(
      (await readParamValue(drugId, 'therapeuticConcentration'))?.median,
    ).toBe(20);
  });
});


describe('grandfather rule under a normalization sweep', () => {
  it('does not reinstate a migrated value over a later authored one', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    // The state migration 0078 leaves behind: a synthetic placeholder minted
    // from whatever value was authored at the time.
    await seedEntry(drugId, { median: '10', origin: 'grandfathered' });
    await upsertDrugParameter(db, drugId, 'therapeuticConcentration', {
      median: 10,
      unit: 'mg/L',
    } as never, userId);

    // A later authored value for the same pair. Summarizable parameters no
    // longer take one from a curator — the edit routes refuse it — but the
    // importers and seeders still write `drug_parameters` directly, so the
    // sweep must respect whatever authored value it finds rather than the
    // migrated one.
    await upsertDrugParameter(db, drugId, 'therapeuticConcentration', {
      median: 42,
      unit: 'mg/L',
    } as never, userId);

    // Any normalization change now sweeps this parameter. The placeholder must
    // NOT be pooled back over the newer authored value.
    await db.insert(parameterEntries).values({
      drugId,
      parameter: 'bloodPlasmaRatio',
      unit: 'ratio',
      matrix: null,
      scenario: null,
      origin: 'contributor',
      median: '2',
    });
    await recomputeParameterAndDependents(drugId, 'bloodPlasmaRatio', userId);

    expect(
      (await readParamValue(drugId, 'therapeuticConcentration'))?.median,
    ).toBe(42);

    // A REAL source supersedes both: now the aggregate takes over.
    await seedEntry(drugId, { median: '30', origin: 'contributor' });
    await recomputeAndCacheParameterSummary(
      drugId,
      'therapeuticConcentration',
      userId,
    );
    expect(
      (await readParamValue(drugId, 'therapeuticConcentration'))?.median,
    ).toBe(30);
  });
});
