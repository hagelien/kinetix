/**
 * `scripts/fix-simulator-case-drug-keys.ts` reads every `simulator_cases`
 * row, decides which entries need a key rewrite, then writes each changed
 * row back. Between the read and that write, nothing stops a user from
 * saving their own edit to the same case — a plain `UPDATE ... WHERE id =
 * $id` would silently replace their edit with the script's stale in-memory
 * copy.
 *
 * The script guards its UPDATE with `AND case_data = $originalCaseData`
 * (drizzle's `eq` on the jsonb column), the same optimistic-concurrency
 * shape tested here directly against the real column type — a plain object
 * comparison in TypeScript would not have caught a serialization mismatch a
 * jsonb round-trip could introduce.
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { simulatorCases } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

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

describe('optimistic-concurrency guard on a simulator_cases rewrite', () => {
  it('writes through when case_data still matches what was read', async () => {
    const original = { drugs: [{ drugId: '803', drugName: 'Shadow Drug' }] };
    const [row] = await db
      .insert(simulatorCases)
      .values({ name: 'Kasus', caseData: original, createdBy: userId })
      .returning({ id: simulatorCases.id });

    const rewritten = { drugs: [{ drugId: 'drug:803', drugName: 'Shadow Drug' }] };
    const [updated] = await db
      .update(simulatorCases)
      .set({ caseData: rewritten })
      .where(and(eq(simulatorCases.id, row!.id), eq(simulatorCases.caseData, original)))
      .returning({ id: simulatorCases.id });

    expect(updated?.id).toBe(row!.id);
    const [after] = await db
      .select({ caseData: simulatorCases.caseData })
      .from(simulatorCases)
      .where(eq(simulatorCases.id, row!.id));
    expect(after?.caseData).toEqual(rewritten);
  });

  it('does not overwrite a case a user edited after it was read', async () => {
    const original = { drugs: [{ drugId: '803', drugName: 'Shadow Drug' }] };
    const [row] = await db
      .insert(simulatorCases)
      .values({ name: 'Kasus', caseData: original, createdBy: userId })
      .returning({ id: simulatorCases.id });

    // The user's own edit lands between the script's read and its write.
    const userEdited = {
      drugs: [{ drugId: '803', drugName: 'Shadow Drug', weight: 70 }],
    };
    await db
      .update(simulatorCases)
      .set({ caseData: userEdited })
      .where(eq(simulatorCases.id, row!.id));

    // The script's write, still holding the now-stale snapshot it read.
    const staleRewrite = { drugs: [{ drugId: 'drug:803', drugName: 'Shadow Drug' }] };
    const [updated] = await db
      .update(simulatorCases)
      .set({ caseData: staleRewrite })
      .where(and(eq(simulatorCases.id, row!.id), eq(simulatorCases.caseData, original)))
      .returning({ id: simulatorCases.id });

    // No row matched the stale predicate, so nothing was overwritten.
    expect(updated).toBeUndefined();
    const [after] = await db
      .select({ caseData: simulatorCases.caseData })
      .from(simulatorCases)
      .where(eq(simulatorCases.id, row!.id));
    expect(after?.caseData).toEqual(userEdited);
  });
});
