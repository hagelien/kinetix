/**
 * Migration 0133 backfills the audience of the dispute notices written before
 * it: the disputed target's author is told as its author, everyone else as a
 * reviewer. The backfill statement is pulled out of the .sql file and re-run
 * against seeded rows, as the 0104 test does, so it cannot drift from what
 * ships.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { disputes, notifications, pendingEdits } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(HERE, '../../drizzle/0133_notification_email_delivery.sql');

function backfillStatement(): string {
  const statement = readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .find((s) => s.startsWith('UPDATE "notifications" n SET "audience"'));
  if (!statement) throw new Error('audience backfill not found in 0133');
  return statement;
}

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

describe('migration 0133 — audience backfill', () => {
  it('marks the disputed target’s author as author and leaves reviewers as reviewer', async () => {
    const author = await seedUser(db, { email: 'a@example.com', username: 'a' });
    const reviewer = await seedUser(db, { email: 'r@example.com', username: 'r', role: 'editor' });
    const disputer = await seedUser(db, { email: 'd@example.com', username: 'd' });
    const [edit] = await db
      .insert(pendingEdits)
      .values({ editType: 'wiki_fact', status: 'pending', submittedBy: author, proposedValue: {} } as never)
      .returning({ id: pendingEdits.id });
    const [dispute] = await db
      .insert(disputes)
      .values({
        targetType: 'pending_edit',
        targetId: edit!.id,
        createdBy: disputer,
        source: 'human',
        reasonMd: 'Contradicts the table.',
      })
      .returning({ id: disputes.id });
    // Legacy rows: written before the column existed, so all hold the default.
    for (const userId of [author, reviewer]) {
      await db.insert(notifications).values({
        userId,
        type: 'dispute_opened',
        title: 'Dispute opened',
        audience: 'reviewer',
        targetType: 'pending_edit',
        targetId: edit!.id,
        disputeId: dispute!.id,
      });
    }

    await db.execute(sql.raw(backfillStatement()));

    const rows = await db
      .select({ userId: notifications.userId, audience: notifications.audience })
      .from(notifications);
    expect(Object.fromEntries(rows.map((r) => [r.userId, r.audience]))).toEqual({
      [author]: 'author',
      [reviewer]: 'reviewer',
    });
  });
});
