import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { agents, disputes, notifications } from '../../db/schema.js';
import {
  claimOverdueDisputesForEscalation,
  listOpenDisputes,
} from '../../api/_lib/disputes.js';
import { escalateOverdueDisputes } from '../../api/_lib/notificationEmails.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedUser } from './setup/seed.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-28T06:00:00Z');
const OVERDUE_BEFORE = new Date(NOW.getTime() - 7 * DAY);

let db: IntegrationDb;
let authorId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  authorId = await seedUser(db, { email: 'author@example.com', username: 'author' });
});

async function seedDispute(args: {
  targetId: number;
  ageDays: number;
  status?: 'open' | 'resolved';
  escalatedAt?: Date;
}): Promise<number> {
  const [row] = await db
    .insert(disputes)
    .values({
      targetType: 'pending_edit',
      targetId: args.targetId,
      createdBy: authorId,
      source: 'human',
      reasonMd: 'This value contradicts the cited table.',
      status: args.status ?? 'open',
      createdAt: new Date(NOW.getTime() - args.ageDays * DAY),
      escalatedAt: args.escalatedAt ?? null,
    })
    .returning({ id: disputes.id });
  return row!.id;
}

async function escalatedAtOf(id: number): Promise<Date | null> {
  const [row] = await db
    .select({ escalatedAt: disputes.escalatedAt })
    .from(disputes)
    .where(eq(disputes.id, id));
  return row!.escalatedAt;
}

describe('claimOverdueDisputesForEscalation over real SQL', () => {
  it('claims only open, unescalated disputes past the threshold, oldest first', async () => {
    const newer = await seedDispute({ targetId: 1, ageDays: 8 });
    const older = await seedDispute({ targetId: 2, ageDays: 12 });
    await seedDispute({ targetId: 3, ageDays: 2 }); // not overdue
    await seedDispute({ targetId: 4, ageDays: 20, status: 'resolved' });
    await seedDispute({
      targetId: 5,
      ageDays: 30,
      escalatedAt: new Date(NOW.getTime() - 10 * DAY),
    });

    const claimed = await claimOverdueDisputesForEscalation({
      overdueBefore: OVERDUE_BEFORE,
      now: NOW,
    });

    expect(claimed).toEqual([
      { id: older, targetType: 'pending_edit', targetId: 2 },
      { id: newer, targetType: 'pending_edit', targetId: 1 },
    ]);
    expect((await escalatedAtOf(older))?.toISOString()).toBe(NOW.toISOString());
  });

  it('exposes escalatedAt on the open-dispute feed', async () => {
    await seedDispute({ targetId: 1, ageDays: 9 });
    await seedDispute({ targetId: 2, ageDays: 1 });
    await claimOverdueDisputesForEscalation({ overdueBefore: OVERDUE_BEFORE, now: NOW });

    const feed = await listOpenDisputes({ limit: 10 });

    expect(feed.map((d) => d.escalatedAt)).toEqual([NOW.toISOString(), null]);
  });
});

describe('escalateOverdueDisputes over real SQL', () => {
  it('tells every admin in-app, once per dispute, as a reviewer-audience row', async () => {
    const adminA = await seedUser(db, { email: 'a@example.com', username: 'a', role: 'admin' });
    const adminB = await seedUser(db, { email: 'b@example.com', username: 'b', role: 'admin' });
    await seedUser(db, { email: 'e@example.com', username: 'e', role: 'editor' });
    await seedDispute({ targetId: 1, ageDays: 9 });
    await seedDispute({ targetId: 2, ageDays: 10 });

    expect(await escalateOverdueDisputes(NOW)).toBe(2);
    expect(await escalateOverdueDisputes(new Date(NOW.getTime() + DAY))).toBe(0);

    const rows = await db
      .select({
        userId: notifications.userId,
        type: notifications.type,
        audience: notifications.audience,
        url: notifications.url,
      })
      .from(notifications);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set([adminA, adminB]));
    expect(rows.every((r) => r.type === 'dispute_escalated')).toBe(true);
    expect(rows.every((r) => r.audience === 'reviewer')).toBe(true);
    expect(rows.every((r) => r.url === '/admin?pane=disputes')).toBe(true);
  });

  it('does not claim anything while there is no admin to tell', async () => {
    const id = await seedDispute({ targetId: 1, ageDays: 9 });

    expect(await escalateOverdueDisputes(NOW)).toBe(0);
    expect(await escalatedAtOf(id)).toBeNull();

    // An admin appointed later still hears about it.
    await seedUser(db, { email: 'a@example.com', username: 'a', role: 'admin' });
    expect(await escalateOverdueDisputes(NOW)).toBe(1);
    expect(await escalatedAtOf(id)).not.toBeNull();
  });

  it('does not count an agent account holding the admin role as someone to tell', async () => {
    const agentAdmin = await seedUser(db, {
      email: 'bot@example.com',
      username: 'bot',
      role: 'admin',
    });
    await db.insert(agents).values({ userId: agentAdmin, name: 'Bot', slug: 'bot' });
    const id = await seedDispute({ targetId: 1, ageDays: 9 });

    expect(await escalateOverdueDisputes(NOW)).toBe(0);
    expect(await escalatedAtOf(id)).toBeNull();
    expect(await db.select().from(notifications)).toHaveLength(0);

    const human = await seedUser(db, { email: 'h@example.com', username: 'h', role: 'admin' });
    expect(await escalateOverdueDisputes(NOW)).toBe(1);
    const rows = await db.select({ userId: notifications.userId }).from(notifications);
    expect(rows.map((r) => r.userId)).toEqual([human]);
  });

  it('rolls the claim back when the in-app notice cannot be written, so the next run retries', async () => {
    await seedUser(db, { email: 'a@example.com', username: 'a', role: 'admin' });
    const id = await seedDispute({ targetId: 1, ageDays: 9 });
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION test_block_notifications() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'notifications unavailable'; END $$
    `);
    await db.execute(sql`
      CREATE TRIGGER test_block_notifications BEFORE INSERT ON notifications
      FOR EACH ROW EXECUTE FUNCTION test_block_notifications()
    `);
    try {
      await expect(escalateOverdueDisputes(NOW)).rejects.toThrow();
      expect(await escalatedAtOf(id)).toBeNull();
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS test_block_notifications ON notifications`);
      await db.execute(sql`DROP FUNCTION IF EXISTS test_block_notifications()`);
    }

    expect(await escalateOverdueDisputes(NOW)).toBe(1);
    expect(await escalatedAtOf(id)).not.toBeNull();
    expect(await db.select().from(notifications)).toHaveLength(1);
  });
});
