/**
 * The reviewer's optimistic lock, against real SQL.
 *
 * A reviewer validates `reviewToken` against the row this request read, then
 * writes — and a submitter revision can commit in that gap. Since a revision
 * always re-stamps `submitted_at`, pinning that column in the UPDATE closes
 * the gap. The catch is precision: the DB `now()` default stores microseconds
 * while drizzle reads the column back as a millisecond-truncated Date, so a
 * plain equality never matches a freshly-submitted row. That mismatch only
 * shows up against a real Postgres, which is why this lives here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { pendingEdits } from '../../db/schema.js';
import { pendingEditReviewerLock } from '../../api/pending-edits.js';
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
beforeEach(async () => {
  await resetIntegrationDb(db);
});

/**
 * Insert a pending edit whose `submitted_at` carries a microsecond tail, the
 * way Neon's `now()` default stamps it in production. Written through raw SQL
 * because a JS Date only reaches millisecond precision — the whole point of
 * the mismatch this lock has to survive.
 */
async function seedPendingEdit(submittedBy: number): Promise<number> {
  const { rows } = await db.execute<{ id: number }>(sql`
    INSERT INTO pending_edits
      (edit_type, target_id, section_id, fact_operation, fact_statement,
       proposed_value, submitted_by, status, submitted_at)
    VALUES
      ('wiki_fact', 1, 'pk', 'add', 'Et faktum.',
       ${JSON.stringify({ factStatement: 'Et faktum.' })}::jsonb,
       ${submittedBy}, 'pending', TIMESTAMP '2026-08-05 02:09:14.436512')
    RETURNING id
  `);
  return rows[0]!.id;
}

async function readEdit(id: number) {
  const [row] = await db
    .select()
    .from(pendingEdits)
    .where(eq(pendingEdits.id, id))
    .limit(1);
  return row!;
}

describe('pendingEditReviewerLock over real SQL', () => {
  it('matches a row nobody has touched since the reviewer read it', async () => {
    const userId = await seedUser(db, {
      email: 'submitter@example.com',
      username: 'submitter',
      role: 'contributor',
    });
    const id = await seedPendingEdit(userId);
    const edit = await readEdit(id);

    // The row really does carry sub-millisecond precision the reviewer's
    // in-memory copy cannot represent — a plain equality would fail here.
    expect(edit.submittedAt?.getMilliseconds()).toBe(436);

    const updated = await db
      .update(pendingEdits)
      .set({ status: 'rejected', reviewedBy: userId, reviewedAt: new Date() })
      .where(pendingEditReviewerLock(edit))
      .returning({ id: pendingEdits.id });

    expect(updated).toHaveLength(1);
  });

  it('refuses the write when the submitter revised in the read→write gap', async () => {
    const userId = await seedUser(db, {
      email: 'submitter@example.com',
      username: 'submitter',
      role: 'contributor',
    });
    const id = await seedPendingEdit(userId);
    const edit = await readEdit(id);

    // The submitter revises: new payload, re-stamped submitted_at, still
    // pending — the state that used to slip past an (id, status) lock.
    await db
      .update(pendingEdits)
      .set({
        proposedValue: { factStatement: 'Et revidert faktum.' },
        factStatement: 'Et revidert faktum.',
        submittedAt: new Date(),
      })
      .where(eq(pendingEdits.id, id));

    const updated = await db
      .update(pendingEdits)
      .set({ status: 'rejected', reviewedBy: userId, reviewedAt: new Date() })
      .where(pendingEditReviewerLock(edit))
      .returning({ id: pendingEdits.id });

    expect(updated).toEqual([]);
    expect((await readEdit(id)).status).toBe('pending');
  });

  it('refuses the write when the row was already reviewed', async () => {
    const userId = await seedUser(db, {
      email: 'submitter@example.com',
      username: 'submitter',
      role: 'contributor',
    });
    const id = await seedPendingEdit(userId);
    const edit = await readEdit(id);

    await db
      .update(pendingEdits)
      .set({ status: 'approved' })
      .where(eq(pendingEdits.id, id));

    const updated = await db
      .update(pendingEdits)
      .set({ status: 'rejected', reviewedBy: userId, reviewedAt: new Date() })
      .where(pendingEditReviewerLock(edit))
      .returning({ id: pendingEdits.id });

    expect(updated).toEqual([]);
  });
});
