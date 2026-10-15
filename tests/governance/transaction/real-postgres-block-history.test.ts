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
} from '../../../api/_lib/drugBlockHistory.js';
import { lockDrugForEntryApplicability } from '../../../api/_lib/parameterApplicabilityStore.js';
import { mergeDrugs } from '../../../api/_lib/drug-merge.js';
import { replaceDrugMetabolism } from '../../../api/_lib/metabolismStore.js';
import { drugBlockRevisions, drugs, users } from '../../../db/schema.js';
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
