/**
 * `scripts/backfill-parameter-revision-source-diff.ts` (#1378): reconstructs
 * `drug_parameter_revisions.source_diff` for revisions the aggregate cache
 * wrote before that column existed, using each row's own `reference_ids`
 * against the immediately preceding revision's — the same inputs the live
 * writer (`computeSourceDiff` in `api/_lib/parameter-entries-store.ts`) uses.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { citations, drugParameterRevisions } from '../../db/schema.js';
import { backfillSourceDiffs } from '../../scripts/backfill-parameter-revision-source-diff.js';
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

async function insertRevision(
  drugId: number,
  userId: number,
  over: Partial<typeof drugParameterRevisions.$inferInsert>,
): Promise<number> {
  const [row] = await db
    .insert(drugParameterRevisions)
    .values({ drugId, parameter: 'halfLife', createdBy: userId, ...over })
    .returning({ id: drugParameterRevisions.id });
  return row!.id;
}

describe('backfillSourceDiffs', () => {
  it('reconstructs added/removed against the immediately preceding revision, and recovers a since-deleted citation from the deletion backup', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    const [live] = await db
      .insert(citations)
      .values({ type: 'pmid', identifier: '111', metadata: { title: 'Still here' } })
      .returning({ id: citations.id });
    const liveId = live!.id;
    // A citation that exists only in a deletion backup (never in this fresh
    // test database) — proves the fallback actually reads the backup file.
    const deletedId = 900_001;
    const backupDir = mkdtempSync(path.join(os.tmpdir(), 'citation-backups-'));
    writeFileSync(
      path.join(backupDir, 'citation-deletion-backup-synthetic.json'),
      JSON.stringify({
        generatedAt: '2000-01-01T00:00:00.000Z',
        citationIds: [deletedId],
        citations: [
          {
            id: deletedId,
            type: 'pmid',
            identifier: '0000001',
            metadata: { title: 'Synthetic deleted citation' },
          },
        ],
      }),
    );

    const first = await insertRevision(drugId, userId, {
      editSummary: 'auto:param_entries_recomputed:2',
      referenceIds: [deletedId, liveId],
    });
    const second = await insertRevision(drugId, userId, {
      editSummary: 'auto:param_entries_recomputed:1:from:2',
      referenceIds: [liveId],
    });
    // No actual change in the contributing set — must stay null, exactly as the
    // live writer would have left it (computeSourceDiff returns null unchanged).
    const third = await insertRevision(drugId, userId, {
      editSummary: 'auto:param_entries_recomputed:1',
      referenceIds: [liveId],
    });
    // Not a cache write (no recognized edit-summary code) — out of scope even
    // though its reference_ids differ from the row before it.
    const humanEdit = await insertRevision(drugId, userId, {
      editSummary: 'Manual correction',
      referenceIds: [],
    });

    const counts = await backfillSourceDiffs(db, {
      apply: true,
      limit: null,
      backupDir,
    });
    expect(counts.scanned).toBe(3);
    expect(counts.written).toBe(2);
    expect(counts.unchanged).toBe(1);

    const rows = await db
      .select()
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.drugId, drugId))
      .orderBy(asc(drugParameterRevisions.id));
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get(first)!.sourceDiff).toEqual({
      added: [
        { citationId: deletedId, label: 'Synthetic deleted citation' },
        { citationId: liveId, label: 'Still here' },
      ],
      removed: [],
    });
    expect(byId.get(second)!.sourceDiff).toEqual({
      added: [],
      removed: [{ citationId: deletedId, label: 'Synthetic deleted citation' }],
    });
    expect(byId.get(third)!.sourceDiff).toBeNull();
    expect(byId.get(humanEdit)!.sourceDiff).toBeNull();
  });

  it('dry run reports what it would write without writing it', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    const [cite] = await db
      .insert(citations)
      .values({ type: 'pmid', identifier: '222', metadata: { title: 'Paper' } })
      .returning({ id: citations.id });

    const revisionId = await insertRevision(drugId, userId, {
      editSummary: 'auto:param_entries_recomputed:1',
      referenceIds: [cite!.id],
    });

    const counts = await backfillSourceDiffs(db, { apply: false, limit: null });
    expect(counts.scanned).toBe(1);
    expect(counts.wouldWrite).toBe(1);
    expect(counts.written).toBe(0);

    const [row] = await db
      .select({ sourceDiff: drugParameterRevisions.sourceDiff })
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.id, revisionId));
    expect(row!.sourceDiff).toBeNull();
  });

  it('skips a revision that already carries a source_diff', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    const already = { added: [], removed: [] };
    await insertRevision(drugId, userId, {
      editSummary: 'auto:param_entries_recomputed:1',
      referenceIds: [1],
      sourceDiff: already as never,
    });

    const counts = await backfillSourceDiffs(db, { apply: true, limit: null });
    expect(counts.scanned).toBe(0);
  });

  it('respects --limit, stopping without scanning what it does not need', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    await insertRevision(drugId, userId, {
      editSummary: 'auto:param_entries_recomputed:1',
      referenceIds: [1],
    });
    const second = await insertRevision(drugId, userId, {
      editSummary: 'auto:param_entries_recomputed:2:from:1',
      referenceIds: [1, 2],
    });

    const counts = await backfillSourceDiffs(db, { apply: true, limit: 1 });
    // Stops as soon as the one actionable write is in hand — the second
    // target is never even queried, not just left unwritten (#1411 review).
    expect(counts.scanned).toBe(1);
    expect(counts.written).toBe(1);

    const [row] = await db
      .select({ sourceDiff: drugParameterRevisions.sourceDiff })
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.id, second));
    expect(row!.sourceDiff).toBeNull();
  });

  it('does not let unchanged rows exhaust --limit before an actionable one (#1412)', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    // Already backfilled (or written live) — excluded from scanning entirely,
    // so it establishes the contributing set the next row is diffed against.
    await insertRevision(drugId, userId, {
      editSummary: 'auto:param_entries_recomputed:1',
      referenceIds: [1],
      sourceDiff: { added: [{ citationId: 1, label: null }], removed: [] } as never,
    });
    // Same contributing set as the row before it: unchanged, must not count
    // against a limit of 1.
    await insertRevision(drugId, userId, {
      editSummary: 'auto:param_entries_recomputed:1',
      referenceIds: [1],
    });
    // The set actually changes here — this is the one --limit: 1 should reach.
    const actionable = await insertRevision(drugId, userId, {
      editSummary: 'auto:param_entries_recomputed:2:from:1',
      referenceIds: [1, 2],
    });

    const counts = await backfillSourceDiffs(db, { apply: true, limit: 1 });
    expect(counts.scanned).toBe(2);
    expect(counts.unchanged).toBe(1);
    expect(counts.written).toBe(1);

    const [row] = await db
      .select({ sourceDiff: drugParameterRevisions.sourceDiff })
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.id, actionable));
    expect(row!.sourceDiff).toEqual({ added: [{ citationId: 2, label: null }], removed: [] });
  });

  it('pages the target query instead of fetching the whole backlog at once (#1411 review)', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    // Five independent (drug, parameter) pairs, each a first-ever revision
    // (so each is actionable, never "unchanged") — with pageSize: 2, this
    // spans three pages.
    const ids: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(
        await insertRevision(drugId, userId, {
          parameter: `param${i}`,
          editSummary: 'auto:param_entries_recomputed:1',
          referenceIds: [100 + i],
        }),
      );
    }

    const counts = await backfillSourceDiffs(db, { apply: true, limit: null, pageSize: 2 });
    expect(counts.scanned).toBe(5);
    expect(counts.written).toBe(5);

    const rows = await db
      .select({ id: drugParameterRevisions.id, sourceDiff: drugParameterRevisions.sourceDiff })
      .from(drugParameterRevisions)
      .where(inArray(drugParameterRevisions.id, ids));
    for (const row of rows) {
      expect(row.sourceDiff).not.toBeNull();
    }
  });

  it('stops paging as soon as a bounded run has enough, without fetching later pages', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    for (let i = 0; i < 5; i += 1) {
      await insertRevision(drugId, userId, {
        parameter: `param${i}`,
        editSummary: 'auto:param_entries_recomputed:1',
        referenceIds: [200 + i],
      });
    }

    const counts = await backfillSourceDiffs(db, { apply: true, limit: 1, pageSize: 2 });
    // The limit is reached inside the first page (size 2) — only that one
    // row is scanned, even though four more sit in later pages.
    expect(counts.scanned).toBe(1);
    expect(counts.written).toBe(1);
  });

  it('skips a row instead of writing a diff computed from data a concurrent merge already changed (#1411 review)', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    // Unrelated to the race — a first-ever revision, always actionable —
    // present only to prove the race guard doesn't hold up a row it doesn't
    // apply to.
    const unaffected = await insertRevision(drugId, userId, {
      editSummary: 'auto:param_entries_recomputed:1',
      referenceIds: [1],
    });
    const target = await insertRevision(drugId, userId, {
      editSummary: 'auto:param_entries_recomputed:2:from:1',
      referenceIds: [1, 2],
    });

    // Simulates a citation or drug merge repointing this exact row's
    // reference_ids in the gap between reading the snapshot and writing the
    // diff computed from it.
    const counts = await backfillSourceDiffs(db, {
      apply: true,
      limit: null,
      onAfterSnapshot: async (row) => {
        if (row.id !== target) return;
        await db
          .update(drugParameterRevisions)
          .set({ referenceIds: [1, 2, 3] })
          .where(eq(drugParameterRevisions.id, target));
      },
    });

    expect(counts.written).toBe(1);
    expect(counts.raced).toBe(1);

    const rows = await db
      .select({ id: drugParameterRevisions.id, sourceDiff: drugParameterRevisions.sourceDiff })
      .from(drugParameterRevisions)
      .where(inArray(drugParameterRevisions.id, [unaffected, target]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(unaffected)!.sourceDiff).not.toBeNull();
    // Left null rather than wrong — a later run sees the current
    // reference_ids ([1, 2, 3]) and computes against those instead.
    expect(byId.get(target)!.sourceDiff).toBeNull();
  });

  it('skips a row when a merge changes which revision its predecessor is, even if its own reference_ids never move (#1411 review, second pass)', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    const otherDrugId = await seedDrug(db, { slug: 'other-drug' });
    const oldPrev = await insertRevision(drugId, userId, {
      editSummary: 'auto:param_entries_recomputed:1',
      referenceIds: [1],
    });
    // Sits between oldPrev and target by id, but belongs to a different
    // (drug, parameter) — until the hook below repoints it, as a drug merge
    // would.
    const [filler] = await db
      .insert(drugParameterRevisions)
      .values({
        drugId: otherDrugId,
        parameter: 'clearance',
        createdBy: userId,
        editSummary: 'auto:param_entries_recomputed:1',
        referenceIds: [999],
      })
      .returning({ id: drugParameterRevisions.id });
    const target = await insertRevision(drugId, userId, {
      editSummary: 'auto:param_entries_recomputed:2:from:1',
      referenceIds: [1, 2],
    });

    const counts = await backfillSourceDiffs(db, {
      apply: true,
      limit: null,
      onAfterSnapshot: async (row) => {
        if (row.id !== target) return;
        // Simulates a drug merge repointing `filler` into this (drug,
        // parameter)'s history — it now sits, by id, between oldPrev and
        // target, so it becomes target's new nearest predecessor. target's
        // own reference_ids never change.
        await db
          .update(drugParameterRevisions)
          .set({ drugId, parameter: 'halfLife' })
          .where(eq(drugParameterRevisions.id, filler!.id));
      },
    });

    expect(counts.raced).toBeGreaterThanOrEqual(1);
    const [row] = await db
      .select({ sourceDiff: drugParameterRevisions.sourceDiff })
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.id, target));
    // Left null — a diff against oldPrev ([1]) would have been wrong the
    // moment filler ([999]) became the real predecessor.
    expect(row!.sourceDiff).toBeNull();
  });

  it('does not let a raced row exhaust --limit before an actionable one (#1411 review, third pass)', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    const raced = await insertRevision(drugId, userId, {
      parameter: 'halfLife',
      editSummary: 'auto:param_entries_recomputed:1',
      referenceIds: [1],
    });
    const actionable = await insertRevision(drugId, userId, {
      parameter: 'clearance',
      editSummary: 'auto:param_entries_recomputed:1',
      referenceIds: [5],
    });

    const counts = await backfillSourceDiffs(db, {
      apply: true,
      limit: 1,
      onAfterSnapshot: async (row) => {
        if (row.id !== raced) return;
        await db
          .update(drugParameterRevisions)
          .set({ referenceIds: [1, 2] })
          .where(eq(drugParameterRevisions.id, raced));
      },
    });

    expect(counts.raced).toBe(1);
    // The raced row didn't spend the budget of 1 — the actionable row after
    // it still got written in the same run.
    expect(counts.written).toBe(1);

    const rows = await db
      .select({ id: drugParameterRevisions.id, sourceDiff: drugParameterRevisions.sourceDiff })
      .from(drugParameterRevisions)
      .where(inArray(drugParameterRevisions.id, [raced, actionable]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(raced)!.sourceDiff).toBeNull();
    expect(byId.get(actionable)!.sourceDiff).not.toBeNull();
  });

  it('does not treat a differently-punctuated edit summary as an aggregate-cache write (#1411 review)', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    // Same length and colon placement as `auto:param_entries_recomputed:1`,
    // but every underscore replaced with a space — under a plain
    // `LIKE 'auto:param_entries_recomputed:%'`, each literal `_` is a
    // single-character wildcard, so this would incorrectly match.
    const lookalike = await insertRevision(drugId, userId, {
      editSummary: 'auto:param entries recomputed:1',
      referenceIds: [1, 2],
    });

    const counts = await backfillSourceDiffs(db, { apply: true, limit: null });
    expect(counts.scanned).toBe(0);

    const [row] = await db
      .select({ sourceDiff: drugParameterRevisions.sourceDiff })
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.id, lookalike));
    expect(row!.sourceDiff).toBeNull();
  });

  it('rejects an edit summary that merely starts with the aggregate-cache prefix but is not the exact shape the writer produces (#1411 review)', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    // starts_with() alone would have matched this — it really does start with
    // the reserved prefix, e.g. a human-authored edit summary that happens to
    // begin the same way. Nothing prevents that: editSummary is an
    // unrestricted free-text field on every human write path.
    const humanLookalike = await insertRevision(drugId, userId, {
      editSummary: 'auto:param_entries_recomputed:1 (double-checked against the label)',
      referenceIds: [1, 2],
    });

    const counts = await backfillSourceDiffs(db, { apply: true, limit: null });
    expect(counts.scanned).toBe(0);

    const [row] = await db
      .select({ sourceDiff: drugParameterRevisions.sourceDiff })
      .from(drugParameterRevisions)
      .where(eq(drugParameterRevisions.id, humanLookalike));
    expect(row!.sourceDiff).toBeNull();
  });
});
