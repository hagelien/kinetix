/**
 * #303: two parents can change the same metabolite's precursor box. These
 * races need separate connections: PGlite cannot expose stale snapshots or
 * graph/drug lock inversions. The migrations workflow runs this on Postgres.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { getDb, runInPoolTransaction } from '../../../api/_lib/db.js';
import {
  beginBlockHistory,
  lockMetabolismHistory,
  readDrugBlockSnapshot,
  withBlockHistory,
} from '../../../api/_lib/drugBlockHistory.js';
import { lockDrugForEntryApplicability } from '../../../api/_lib/parameterApplicabilityStore.js';
import { mergeCitations, type CitationMergeStats } from '../../../api/_lib/citation-merge.js';
import { mergeDrugs } from '../../../api/_lib/drug-merge.js';
import { replaceDrugMetabolism } from '../../../api/_lib/metabolismStore.js';
import { applyApprovedEdit } from '../../../api/_lib/pending-edits-helpers.js';
import { planDeletes, applyDeletesInTransaction } from '../../../scripts/repair-hallucinated-citations.js';
import { seedBioEntity } from '../../integration/setup/seed.js';
import { citations, drugMetabolismProfiles, drugReceptorTargets, parameterEntries, pendingEdits, drugBlockRevisions, drugs, users } from '../../../db/schema.js';
import {
  realPostgresUrl,
  resetRealPostgresDb,
  setupRealPostgresDb,
  teardownRealPostgresDb,
  type RealPostgresDb,
} from '../../integration/setup/real-postgres.js';

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { open, wait };
}

/** Observe a genuine lock wait, rather than relying on a scheduling delay. */
async function waitForAdvisory(db: RealPostgresDb, name: string) {
  for (let i = 0; i < 100; i++) {
    const result = await db.execute<{ waiting: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE application_name = ${name} AND wait_event = 'advisory') AS waiting
    `);
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${name} did not wait on the graph history lock`);
}

const input = (child: number) => ({
  profile: {}, routes: [], precursors: [],
  metabolites: [{ metaboliteDrugId: child, metaboliteName: 'Child', activity: 'unknown' as const }],
});

describe.skipIf(!realPostgresUrl())('metabolism block history on concurrent connections', () => {
  let db: RealPostgresDb;
  let actor: number;
  let parentA: number;
  let parentB: number;
  let child: number;

  beforeAll(async () => { db = await setupRealPostgresDb(); }, 120_000);
  afterAll(async () => { await teardownRealPostgresDb(); });
  beforeEach(async () => {
    await resetRealPostgresDb(db);
    const [user] = await db.insert(users).values({
      email: 'history@example.com', username: 'history', role: 'admin',
    }).returning({ id: users.id });
    actor = user!.id;
    const ids = await db.insert(drugs).values([
      { slug: 'parent-a', names: { en: 'Parent A' } },
      { slug: 'parent-b', names: { en: 'Parent B' } },
      { slug: 'child', names: { en: 'Child' } },
    ]).returning({ id: drugs.id });
    [parentA, parentB, child] = ids.map((r) => r.id) as [number, number, number];
  });

  it('chains a shared metabolite history after another parent commits', async () => {
    const firstSnapshot = gate();
    const releaseFirst = gate();
    const secondStarted = gate();
    const releaseSecond = gate();
    // Start the second transaction first. Its now() is older, even though it
    // records later: created_at must reflect recording time after the wait.
    const second = runInPoolTransaction(async () => {
      await getDb().execute(sql`SET LOCAL application_name = 'block-history-second'`);
      secondStarted.open();
      await releaseSecond.wait;
      const history = await beginBlockHistory({
        drugIds: [parentB, child], blocks: ['metabolism'], actorUserId: actor,
      });
      await replaceDrugMetabolism(getDb(), parentB, input(child), actor);
      await history.record();
    });
    await secondStarted.wait;
    const first = runInPoolTransaction(async () => {
      const history = await beginBlockHistory({
        drugIds: [parentA, child], blocks: ['metabolism'], actorUserId: actor,
      });
      firstSnapshot.open();
      await releaseFirst.wait;
      await replaceDrugMetabolism(getDb(), parentA, input(child), actor);
      await history.record();
    });
    // Avoid leaving a held connection behind when a regression fails.
    try {
      await firstSnapshot.wait;
      releaseSecond.open();
      await waitForAdvisory(db, 'block-history-second');
    } finally {
      releaseFirst.open();
      releaseSecond.open();
      await Promise.all([first, second]);
    }
    const rows = await db.select().from(drugBlockRevisions)
      .where(eq(drugBlockRevisions.drugId, child)).orderBy(asc(drugBlockRevisions.id));
    expect(rows).toHaveLength(2);
    expect(rows[1]!.oldValue).toEqual(rows[0]!.newValue);
    expect(rows[1]!.newValue).toEqual(await readDrugBlockSnapshot(getDb(), child, 'metabolism'));
    expect((rows[1]!.newValue as { precursors: unknown[] }).precursors).toHaveLength(2);
    expect(rows[1]!.createdAt.getTime()).toBeGreaterThanOrEqual(rows[0]!.createdAt.getTime());
  });


  it.each(['modelStructure', 'pharmacodynamics'] as const)(
    'locks the repair drug before the %s snapshot', async (block) => {
      const [citation] = await db.insert(citations).values({
        type: 'doi', identifier: '10.1000/repair', metadata: {},
      }).returning({ id: citations.id });
      const citationId = citation!.id;
      // Keep the repair's affected-drug set stable even while the other writer
      // has not committed. The repair removes this citation from all blocks.
      await db.insert(drugMetabolismProfiles).values({ drugId: parentA, referenceIds: [citationId] });
      let entryId: number;
      if (block === 'modelStructure') {
        const [entry] = await db.insert(parameterEntries).values({
          drugId: parentA, citationId, parameter: 'ka', route: 'oral', median: '1.2', unit: '1/h',
        }).returning({ id: parameterEntries.id });
        entryId = entry!.id;
      } else {
        const entity = await seedBioEntity(db as never);
        const [entry] = await db.insert(drugReceptorTargets).values({
          drugId: parentA, bioEntityId: entity, evidenceNote: 'Før', referenceIds: [citationId],
        }).returning({ id: drugReceptorTargets.id });
        entryId = entry!.id;
      }
      const plan = await planDeletes([citationId]);
      const beforeWrite = gate();
      const releaseWrite = gate();
      const writer = runInPoolTransaction(async () => {
        await lockDrugForEntryApplicability(parentA);
        await withBlockHistory({ drugIds: [parentA], blocks: [block], actorUserId: actor }, async () => {
          beforeWrite.open();
          await releaseWrite.wait;
          if (block === 'modelStructure') {
            await getDb().update(parameterEntries).set({ median: '1.4' }).where(eq(parameterEntries.id, entryId));
          } else {
            await getDb().update(drugReceptorTargets).set({ evidenceNote: 'Etter' }).where(eq(drugReceptorTargets.id, entryId));
          }
        });
      });
      await beforeWrite.wait;
      const repair = runInPoolTransaction(async () => {
        await getDb().execute(sql`SET LOCAL application_name = 'block-history-repair'`);
        // applyDeletes normally owns the outer transaction; use its worker so
        // both writes join this named transaction on the production DB seam.
        await applyDeletesInTransaction(plan, actor);
      });
      try {
        await waitForAdvisory(db, 'block-history-repair');
      } finally {
        releaseWrite.open();
        await Promise.all([writer, repair]);
      }
      const rows = (await db.select().from(drugBlockRevisions)
        .where(eq(drugBlockRevisions.drugId, parentA)).orderBy(asc(drugBlockRevisions.id)))
        .filter((r) => r.block === block);
      expect(rows).toHaveLength(2);
      expect(rows[1]!.oldValue).toEqual(rows[0]!.newValue);
      expect(rows[1]!.newValue).toEqual(await readDrugBlockSnapshot(getDb(), parentA, block));
    },
  );


  it('serializes two receptor-target approvals before their snapshots', async () => {
    const entity = await seedBioEntity(db as never);
    const edits = await db.insert(pendingEdits).values(['Første', 'Andre'].map((evidenceNote) => ({
      editType: 'receptor_targets', targetId: parentA, status: 'pending', submittedBy: actor,
      proposedValue: { mechanisms: [{ receptorTargetId: entity, interactionType: 'agonist', evidenceNote }] },
    }))).returning({ id: pendingEdits.id });
    const firstApplied = gate();
    const releaseFirst = gate();
    const first = runInPoolTransaction(async () => {
      await applyApprovedEdit(edits[0]!.id, actor);
      firstApplied.open();
      await releaseFirst.wait;
    });
    await firstApplied.wait;
    const second = runInPoolTransaction(async () => {
      await getDb().execute(sql`SET LOCAL application_name = 'block-history-approval'`);
      await applyApprovedEdit(edits[1]!.id, actor);
    });
    try {
      await waitForAdvisory(db, 'block-history-approval');
    } finally {
      releaseFirst.open();
      await Promise.all([first, second]);
    }
    const rows = await db.select().from(drugBlockRevisions)
      .where(eq(drugBlockRevisions.drugId, parentA)).orderBy(asc(drugBlockRevisions.id));
    expect(rows).toHaveLength(2);
    expect(rows[1]!.oldValue).toEqual(rows[0]!.newValue);
    expect(rows[1]!.pendingEditId).toBe(edits[1]!.id);
    expect(rows[1]!.newValue).toEqual(await readDrugBlockSnapshot(getDb(), parentA, 'pharmacodynamics'));
    expect((rows[1]!.newValue as { mechanisms: Array<{ evidenceNote: string }> }).mechanisms[0]!.evidenceNote).toBe('Andre');
  });

  it.each([
    ['metabolism', true], ['metabolism', false],
    ['pharmacodynamics', true], ['pharmacodynamics', false],
  ] as const)('defers a citation fold behind a %s snapshot (actor=%s)', async (block, withActor) => {
    const papers = await db.insert(citations).values([
      { type: 'doi', identifier: '10.1000/winner' },
      { type: 'doi', identifier: '10.1000/loser' },
    ]).returning({ id: citations.id });
    const [winner, loser] = papers.map((p) => p.id) as [number, number];
    const target = block === 'metabolism' ? child : parentA;
    if (block === 'metabolism') {
      await db.insert(drugMetabolismProfiles).values({ drugId: child, referenceIds: [loser] });
    } else {
      const entity = await seedBioEntity(db as never);
      await db.insert(drugReceptorTargets).values({
        drugId: parentA, bioEntityId: entity, interactionType: 'agonist', referenceIds: [loser],
      });
    }
    const before = await readDrugBlockSnapshot(getDb(), target, block);
    const snapshotted = gate();
    const release = gate();
    const writer = runInPoolTransaction(async () => {
      if (block === 'metabolism') await lockMetabolismHistory();
      await lockDrugForEntryApplicability(parentA);
      await withBlockHistory({ drugIds: [parentA, child], blocks: [block], actorUserId: actor }, async () => {
        snapshotted.open();
        await release.wait;
        if (block === 'metabolism') {
          // The new link changes CHILD's precursor block, although the writer
          // holds only its parent drug key. Citation-fold graph locking must
          // cover endpoints not discoverable from the pre-write graph.
          await replaceDrugMetabolism(getDb(), parentA, input(child), actor);
        } else {
          await getDb().update(drugReceptorTargets).set({ evidenceNote: 'Concurrent save' })
            .where(eq(drugReceptorTargets.drugId, parentA));
        }
      });
    });
    try {
      await snapshotted.wait;
      const folded = await runInPoolTransaction(() => mergeCitations(getDb(), winner, loser,
        withActor ? { actorUserId: actor } : undefined));
      expect(folded).toMatchObject({ deferred: true,
        deferredReason: block === 'metabolism' ? 'block_history_in_flight' : 'drug_locked' });
      expect(await readDrugBlockSnapshot(getDb(), target, block)).toEqual(before);
      expect(await db.select().from(citations).where(eq(citations.id, loser))).toHaveLength(1);
    } finally {
      release.open();
      await writer;
    }
    const [preFold] = await db.select({ updatedAt: drugs.updatedAt }).from(drugs).where(eq(drugs.id, target));
    const folded = await runInPoolTransaction(() => mergeCitations(getDb(), winner, loser,
      withActor ? { actorUserId: actor } : undefined));
    expect(folded.deferred).not.toBe(true);
    const [revision] = await db.select().from(drugBlockRevisions).where(eq(drugBlockRevisions.drugId, target));
    expect(revision).toBeDefined();
    expect(JSON.stringify(revision!.oldValue)).not.toContain(`"referenceIds":[${loser}]`);
    expect(JSON.stringify(revision!.newValue)).not.toContain(`"referenceIds":[${loser}]`);
    expect(revision!.newValue).toEqual(await readDrugBlockSnapshot(getDb(), target, block));
    const [postFold] = await db.select({ updatedAt: drugs.updatedAt }).from(drugs).where(eq(drugs.id, target));
    // Existing direct PUT guards compare this version after acquiring the
    // drug/graph locks: a pre-fold full replacement must be rejected.
    expect(postFold!.updatedAt.getTime()).toBeGreaterThan(preFold!.updatedAt.getTime());
  });

  it.each(['history', 'entry'] as const)(
    'locks a drug whose only loser citation is in a block %s, without an actor', async (surface) => {
    const papers = await db.insert(citations).values([
      { type: 'doi', identifier: '10.1000/winner' },
      { type: 'doi', identifier: '10.1000/loser' },
    ]).returning({ id: citations.id });
    const [winner, loser] = papers.map((p) => p.id) as [number, number];
    if (surface === 'history') {
      await db.insert(drugBlockRevisions).values({
        drugId: parentA, block: 'modelStructure', newValue: { declarations: [{ citationId: loser }] }, createdBy: actor,
      });
    } else {
      await db.insert(parameterEntries).values({
        drugId: parentA, citationId: loser, parameter: 'ka', route: 'oral', median: '1.2', unit: '1/h',
      });
    }
    const locked = gate();
    const release = gate();
    const writer = runInPoolTransaction(async () => {
      await lockDrugForEntryApplicability(parentA);
      locked.open();
      await release.wait;
    });
    try {
      await locked.wait;
      const folded = await runInPoolTransaction(() => mergeCitations(getDb(), winner, loser));
      expect(folded).toMatchObject({ deferred: true, deferredReason: 'drug_locked', lockedDrugId: parentA });
    } finally {
      release.open();
      await writer;
    }
    expect((await runInPoolTransaction(() => mergeCitations(getDb(), winner, loser))).deferred).not.toBe(true);
    if (surface === 'history') {
      const [revision] = await db.select().from(drugBlockRevisions);
      expect(revision!.newValue).toEqual({ declarations: [{ citationId: winner }] });
    } else {
      const [entry] = await db.select().from(parameterEntries);
      expect(entry!.citationId).toBe(winner);
    }
  });

  it.each(['metabolism', 'pharmacodynamics'] as const)(
    'takes the %s snapshot after an earlier citation fold commits', async (block) => {
      const papers = await db.insert(citations).values([
        { type: 'doi', identifier: '10.1000/winner' },
        { type: 'doi', identifier: '10.1000/loser' },
      ]).returning({ id: citations.id });
      const [winner, loser] = papers.map((p) => p.id) as [number, number];
      if (block === 'metabolism') {
        await db.insert(drugMetabolismProfiles).values({ drugId: parentA, referenceIds: [loser] });
      } else {
        const entity = await seedBioEntity(db as never);
        await db.insert(drugReceptorTargets).values({ drugId: parentA, bioEntityId: entity,
          interactionType: 'agonist', referenceIds: [loser] });
      }
      const folded = gate();
      const release = gate();
      let result!: CitationMergeStats;
      const fold = runInPoolTransaction(async () => {
        result = await mergeCitations(getDb(), winner, loser);
        folded.open();
        await release.wait;
      });
      await folded.wait;
      const writer = runInPoolTransaction(async () => {
        await getDb().execute(sql`SET LOCAL application_name = 'block-history-after-fold'`);
        if (block === 'metabolism') await lockMetabolismHistory();
        await lockDrugForEntryApplicability(parentA);
        await withBlockHistory({ drugIds: [parentA], blocks: [block], actorUserId: actor }, async () => {
          if (block === 'metabolism') {
            await getDb().update(drugMetabolismProfiles).set({ evidenceNote: 'After fold' })
              .where(eq(drugMetabolismProfiles.drugId, parentA));
          } else {
            await getDb().update(drugReceptorTargets).set({ evidenceNote: 'After fold' })
              .where(eq(drugReceptorTargets.drugId, parentA));
          }
        });
      });
      try {
        await waitForAdvisory(db, 'block-history-after-fold');
      } finally {
        release.open();
        await Promise.all([fold, writer]);
      }
      expect(result.deferred).not.toBe(true);
      const [revision] = await db.select().from(drugBlockRevisions);
      expect(JSON.stringify(revision!.oldValue)).toContain(`"referenceIds":[${winner}]`);
      expect(JSON.stringify(revision!.newValue)).toContain(`"referenceIds":[${winner}]`);
      expect(revision!.newValue).toEqual(await readDrugBlockSnapshot(getDb(), parentA, block));
    },
  );

  it('takes the merge graph lock before drug row locks needed by a linked writer', async () => {
    const beforeWrite = gate();
    const releaseWrite = gate();
    const writer = runInPoolTransaction(async () => {
      await lockMetabolismHistory();
      await lockDrugForEntryApplicability(parentA);
      const history = await beginBlockHistory({
        drugIds: [parentA, child], blocks: ['metabolism'], actorUserId: actor,
      });
      beforeWrite.open();
      await releaseWrite.wait;
      // This FK insert needs KEY SHARE on the child. A merge that locked the
      // child FOR UPDATE before waiting for graph history would deadlock here.
      await replaceDrugMetabolism(getDb(), parentA, input(child), actor);
      await history.record();
    });
    await beforeWrite.wait;
    const merge = runInPoolTransaction(async () => {
      await getDb().execute(sql`SET LOCAL application_name = 'block-history-merge'`);
      await mergeDrugs(getDb(), {
        winnerId: parentB, loserId: child, resolutions: {}, actorUserId: actor,
        approvedPlanFingerprint: null,
      });
    });
    try {
      await waitForAdvisory(db, 'block-history-merge');
    } finally {
      releaseWrite.open();
      await Promise.all([writer, merge]);
    }
    const live = await readDrugBlockSnapshot(getDb(), parentB, 'metabolism');
    expect((live as { precursors: unknown[] }).precursors).toHaveLength(1);
    const rows = await db.select().from(drugBlockRevisions)
      .where(eq(drugBlockRevisions.drugId, parentB)).orderBy(asc(drugBlockRevisions.id));
    expect(rows.at(-1)!.newValue).toEqual(live);
  });
});

it('runs the two-connection regressions in migrations CI', () => {
  const workflow = fs.readFileSync(path.resolve('.github/workflows/migrations.yml'), 'utf8');
  expect(workflow).toContain('tests/governance/transaction/real-postgres-block-history.test.ts');
  expect(workflow).toContain('KINETIX_TEST_PG_URL:');
});
