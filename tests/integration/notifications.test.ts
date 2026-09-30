import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { disputes, notifications } from '../../db/schema.js';
import { fanOutDisputeNotification } from '../../api/_lib/notifications.js';
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

describe('notification fan-out over real SQL', () => {
  it('inserts one row for the target author and each reviewer, excluding the actor', async () => {
    const actorId = await seedUser(db, {
      email: 'actor@example.com',
      username: 'actor',
      role: 'contributor',
    });
    const authorId = await seedUser(db, {
      email: 'author@example.com',
      username: 'author',
      role: 'authenticated',
    });
    const editorId = await seedUser(db, {
      email: 'editor@example.com',
      username: 'editor',
      role: 'editor',
    });
    const adminId = await seedUser(db, {
      email: 'admin@example.com',
      username: 'admin',
      role: 'admin',
    });
    await seedUser(db, {
      email: 'viewer@example.com',
      username: 'viewer',
      role: 'authenticated',
    });

    const [dispute] = await db
      .insert(disputes)
      .values({
        targetType: 'pending_edit',
        targetId: 101,
        createdBy: actorId,
        source: 'human',
        reasonMd: 'This edit needs a second look before publication.',
      })
      .returning({ id: disputes.id });

    const result = await fanOutDisputeNotification({
      type: 'dispute_opened',
      disputeId: dispute!.id,
      targetType: 'pending_edit',
      targetId: 101,
      actorUserId: actorId,
      targetAuthorUserId: authorId,
      title: 'Dispute opened',
      bodyMd: 'Please review this contested edit.',
      url: '/review',
    });

    expect(result).toEqual({ recipients: 3 });

    const rows = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(eq(notifications.disputeId, dispute!.id));
    expect(rows.map((row) => row.userId).sort()).toEqual(
      [authorId, editorId, adminId].sort(),
    );
  });
});
