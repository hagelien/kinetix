/**
 * `retarget:cid` rewrites saved simulator-case keys and then moves the drug's
 * CID. A case save takes the per-drug advisory lock (`saveCaseWithMergeLock`);
 * the retarget has to take the same one, or a save can store the old key after
 * the only rewrite has run (#1076 item 4).
 *
 * PGlite has one connection and cannot block, so the lock is asserted through
 * `pg_locks` inside the transaction rather than through a race.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drugs, simulatorCases } from '../../db/schema.js';
import { getDb, runInPoolTransaction } from '../../api/_lib/db.js';
import {
  lockDrugForRetarget,
  rewriteCaseKeysAndCid,
} from '../../scripts/lib/retarget-cid-apply.js';
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

async function holdsAdvisoryLock(drugId: number): Promise<boolean> {
  const res = (await getDb().execute(sql`
    SELECT 1 AS held FROM pg_locks
    WHERE locktype = 'advisory' AND granted
      AND ((classid::bigint << 32) | objid::bigint) = ${drugId}::bigint`)) as unknown as {
    rows?: unknown[];
  };
  return (res.rows ?? (res as unknown as unknown[])).length > 0;
}

describe('retarget:cid write step', () => {
  it('holds the per-drug advisory lock a case save takes', async () => {
    const drugId = await seedDrug(db, { slug: 'a', pubchemCid: 111 });
    const held = await runInPoolTransaction(async () => {
      await lockDrugForRetarget(drugId);
      return holdsAdvisoryLock(drugId);
    });
    expect(held).toBe(true);
    expect(await holdsAdvisoryLock(drugId)).toBe(false);
  });

  it('refuses to take the lock outside a transaction', async () => {
    const drugId = await seedDrug(db, { slug: 'b', pubchemCid: 222 });
    await expect(lockDrugForRetarget(drugId)).rejects.toThrow(/runInPoolTransaction/);
  });

  it('repoints saved case keys and moves the CID', async () => {
    const drugId = await seedDrug(db, { slug: 'c', pubchemCid: 333 });
    await db.insert(simulatorCases).values({
      name: 'case',
      createdBy: userId,
      caseData: { drugs: [{ drugId: '333' }, { drugId: '999' }] },
    });
    await runInPoolTransaction(async () => {
      await lockDrugForRetarget(drugId);
      await rewriteCaseKeysAndCid(getDb(), drugId, ['333'], 444);
    });
    const [c] = await db.select().from(simulatorCases);
    expect(c!.caseData).toEqual({ drugs: [{ drugId: '444' }, { drugId: '999' }] });
    const [d] = await db.select().from(drugs).where(eq(drugs.id, drugId));
    expect(d!.pubchemCid).toBe(444);
  });
});
