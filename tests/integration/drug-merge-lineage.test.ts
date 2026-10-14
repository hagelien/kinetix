/**
 * Drug-merge lineage (#29, migration 0152).
 *
 * A merge repoints the loser's `drug_parameter_revisions` onto the survivor and
 * deletes the loser. These tests pin down what now survives that: the merge
 * event naming the loser and every revision it moved, and a `source_diff`
 * "previous revision" that still follows the right history — live, for the
 * survivor's next recompute, and in the backfill of rows written before the
 * merge.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';

import {
  citations,
  drugMergeEvents,
  drugParameterRevisions,
  drugs,
  parameterEntries,
  wikiPages,
} from '../../db/schema.js';
import { mergeDrugs, type DrugMergeResolutions } from '../../api/_lib/drug-merge.js';
import { getDb, runInPoolTransaction } from '../../api/_lib/db.js';
import { ensureDrugMonograph } from '../../api/_lib/monograph-helpers.js';
import { recomputeAndCacheParameterSummary } from '../../api/_lib/parameter-entries-store.js';
import { backfillSourceDiffs } from '../../scripts/backfill-parameter-revision-source-diff.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

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

/** The fold as the endpoint runs it: in a pooled transaction, on getDb(). */
function merge(winnerId: number, loserId: number, resolutions: DrugMergeResolutions = {}) {
  return runInPoolTransaction(() =>
    mergeDrugs(getDb(), {
      winnerId,
      loserId,
      resolutions,
      actorUserId: userId,
      approvedPlanFingerprint: null,
    }),
  );
}

async function insertRevision(
  drugId: number,
  over: Partial<typeof drugParameterRevisions.$inferInsert>,
): Promise<number> {
  const [row] = await db
    .insert(drugParameterRevisions)
    .values({ drugId, parameter: 'halfLife', createdBy: userId, ...over })
    .returning({ id: drugParameterRevisions.id });
  return row!.id;
}

async function citation(identifier: string, title: string): Promise<number> {
  const [row] = await db
    .insert(citations)
    .values({ type: 'pmid', identifier, metadata: { title } })
    .returning({ id: citations.id });
  return row!.id;
}

const PARAM = 'therapeuticConcentration';

/** One poolable source entry, then the drug's cached aggregate + revision. */
async function publishFromSource(drugId: number, median: string, citationId: number) {
  await db.insert(parameterEntries).values({
    drugId,
    parameter: PARAM,
    unit: 'mg/L',
    matrix: 'whole_blood',
    scenario: 'living_therapeutic',
    origin: 'legacy',
    median,
    citationId,
  });
  const revisionId = await recomputeAndCacheParameterSummary(drugId, PARAM, userId);
  expect(revisionId).not.toBeNull();
  return revisionId!;
}

async function revisionsOf(drugId: number) {
  return db
    .select()
    .from(drugParameterRevisions)
    .where(and(eq(drugParameterRevisions.drugId, drugId), eq(drugParameterRevisions.parameter, PARAM)))
    .orderBy(asc(drugParameterRevisions.id));
}

describe('drug merge lineage', () => {
  it('records the loser and every revision the merge moved onto the survivor', async () => {
    const winnerId = await seedDrug(db, { slug: 'mhd', names: { nb: 'MHD' } });
    const loserId = await seedDrug(db, {
      slug: 'mhd-dup',
      names: { nb: 'Monohydroksyderivat', en: 'MHD (duplicate)' },
      pubchemCid: 4_216_301,
    });
    // The survivor has no monograph of its own, so the loser's is kept and
    // repointed — the event names it, since its wiki history moves with it.
    const loserPage = await ensureDrugMonograph(
      db,
      { id: loserId, names: { nb: 'Monohydroksyderivat' }, pubchemCid: 4_216_301 },
      userId,
    );

    const native = await insertRevision(winnerId, { parameter: 'halfLife' });
    const movedA = await insertRevision(loserId, { parameter: 'halfLife' });
    const movedB = await insertRevision(loserId, { parameter: 'logP' });

    await merge(winnerId, loserId);

    const events = await db.select().from(drugMergeEvents);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({
      survivorDrugId: winnerId,
      loserDrugId: loserId,
      loserSlug: 'mhd-dup',
      loserPubchemCid: 4_216_301,
      loserNames: { nb: 'Monohydroksyderivat', en: 'MHD (duplicate)' },
      parameterRevisionIds: [movedA, movedB],
      repointedMonographPageId: loserPage.page.id,
      mergedVia: 'admin',
      mergedBy: userId,
    });
    expect(event.mergedAt).toBeInstanceOf(Date);
    // Every revision that existed at the merge sits at or below the mark.
    expect(event.revisionHighWater).toBe(movedB);

    // The loser row is gone, but the question the issue asks is answerable:
    // which revisions on the survivor came from the merged drug, and when.
    expect(await db.select().from(drugs).where(eq(drugs.id, loserId))).toHaveLength(0);
    const fromLoser = await db.execute<{ id: number; merged_at: Date }>(sql`
      SELECT r.id, e.merged_at
      FROM drug_parameter_revisions r
      JOIN drug_merge_events e ON r.id = ANY(e.parameter_revision_ids)
      WHERE r.drug_id = ${winnerId} AND e.loser_drug_id = ${loserId}
      ORDER BY r.id`);
    expect(fromLoser.rows.map((r) => Number(r.id))).toEqual([movedA, movedB]);
    const onSurvivor = await db
      .select({ id: drugParameterRevisions.id })
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.drugId, winnerId))
      .orderBy(asc(drugParameterRevisions.id));
    expect(onSurvivor.map((r) => r.id)).toEqual([native, movedA, movedB]);
    const [page] = await db
      .select({ drugCid: wikiPages.drugCid })
      .from(wikiPages)
      .where(eq(wikiPages.id, loserPage.page.id));
    expect(page?.drugCid).toBe(winnerId);
  });

  it("diffs the survivor's first recompute against its own kept value, not the loser's newer revision", async () => {
    const winnerId = await seedDrug(db, { slug: 'winner' });
    const loserId = await seedDrug(db, { slug: 'loser' });
    const citeA = await citation('111', 'Paper A');
    const citeB = await citation('222', 'Paper B');

    const winnerRev = await publishFromSource(winnerId, '10', citeA);
    // Written later, so after the repoint it is the newest row by id.
    const loserRev = await publishFromSource(loserId, '20', citeB);

    // Both hold a cached value; the admin keeps the survivor's.
    await merge(winnerId, loserId, { [`parameter:${PARAM}`]: 'winner' });

    const [event] = await db.select().from(drugMergeEvents);
    expect(event!.parameterBaselines).toEqual({
      [PARAM]: { supersededRevisionId: loserRev, baselineRevisionId: winnerRev },
    });

    const revisions = await revisionsOf(winnerId);
    expect(revisions.map((r) => r.id).slice(0, 2)).toEqual([winnerRev, loserRev]);
    const recomputed = revisions[2]!;
    expect(recomputed.referenceIds).toEqual([citeA, citeB].sort((a, b) => a - b));
    // The survivor published A; the merge brought in B. A plain "newest row"
    // lookup would have diffed against the loser's [B] and reported A added.
    expect(recomputed.sourceDiff).toEqual({
      added: [{ citationId: citeB, label: 'Paper B' }],
      removed: [],
    });
  });

  it("follows the loser's history when the admin keeps the loser's value", async () => {
    const winnerId = await seedDrug(db, { slug: 'winner' });
    const loserId = await seedDrug(db, { slug: 'loser' });
    const citeA = await citation('111', 'Paper A');
    const citeB = await citation('222', 'Paper B');

    const loserRev = await publishFromSource(loserId, '20', citeB);
    // The survivor's revision is the newer one here.
    const winnerRev = await publishFromSource(winnerId, '10', citeA);

    await merge(winnerId, loserId, { [`parameter:${PARAM}`]: 'loser' });

    const [event] = await db.select().from(drugMergeEvents);
    expect(event!.parameterBaselines).toEqual({
      [PARAM]: { supersededRevisionId: winnerRev, baselineRevisionId: loserRev },
    });
    const recomputed = (await revisionsOf(winnerId)).at(-1)!;
    expect(recomputed.sourceDiff).toEqual({
      added: [{ citationId: citeA, label: 'Paper A' }],
      removed: [],
    });
  });

  it('records no baseline when the newest row already belongs to the kept side', async () => {
    const winnerId = await seedDrug(db, { slug: 'winner' });
    const loserId = await seedDrug(db, { slug: 'loser' });
    const citeA = await citation('111', 'Paper A');
    const citeB = await citation('222', 'Paper B');
    await publishFromSource(loserId, '20', citeB);
    await publishFromSource(winnerId, '10', citeA);

    await merge(winnerId, loserId, { [`parameter:${PARAM}`]: 'winner' });

    const [event] = await db.select().from(drugMergeEvents);
    expect(event!.parameterBaselines).toEqual({});
    const recomputed = (await revisionsOf(winnerId)).at(-1)!;
    expect(recomputed.sourceDiff).toEqual({
      added: [{ citationId: citeB, label: 'Paper B' }],
      removed: [],
    });
  });

  it('backfills a pre-merge revision against what it saw then, not a repointed row with a lower id', async () => {
    const winnerId = await seedDrug(db, { slug: 'winner' });
    const loserId = await seedDrug(db, { slug: 'loser' });
    const [a, b, c] = [900_001, 900_002, 900_003];

    // Interleaved, source_diff not yet written (the shape the backfill targets).
    const w0 = await insertRevision(winnerId, {
      editSummary: 'auto:param_entries_recomputed:1',
      referenceIds: [a],
    });
    const l1 = await insertRevision(loserId, {
      editSummary: 'auto:param_entries_recomputed:1',
      referenceIds: [b],
    });
    const w2 = await insertRevision(winnerId, {
      editSummary: 'auto:param_entries_recomputed:2',
      referenceIds: [a, c],
    });

    await merge(winnerId, loserId);
    const counts = await backfillSourceDiffs(db, { apply: true, limit: null });
    expect(counts.raced).toBe(0);

    const byId = new Map(
      (
        await db
          .select({ id: drugParameterRevisions.id, sourceDiff: drugParameterRevisions.sourceDiff })
          .from(drugParameterRevisions)
          .where(eq(drugParameterRevisions.drugId, winnerId))
      ).map((r) => [r.id, r.sourceDiff]),
    );
    expect(byId.get(w0)).toEqual({ added: [{ citationId: a, label: null }], removed: [] });
    // The loser's row had no predecessor of its own; w0 was on the other drug.
    expect(byId.get(l1)).toEqual({ added: [{ citationId: b, label: null }], removed: [] });
    // w2's live predecessor was w0, not l1 (lower id, but then on the loser).
    expect(byId.get(w2)).toEqual({ added: [{ citationId: c, label: null }], removed: [] });
  });
});
