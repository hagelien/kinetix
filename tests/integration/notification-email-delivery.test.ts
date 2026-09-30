import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, isNull } from 'drizzle-orm';

const { sendEmailMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn() }));
vi.mock('../../api/_lib/email.js', () => ({ sendEmail: sendEmailMock }));

import {
  disputes,
  drugParameterDiscussions,
  notifications,
  pendingEdits,
  users,
  wikiPages,
} from '../../db/schema.js';
import { deliverNotificationEmails } from '../../api/_lib/notificationEmails.js';
import type { NotificationSettings } from '../../src/lib/emailNotificationPrefs.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

const APP = 'https://kinetix.no';
// A Wednesday, after the 06:00 UTC slot.
const NOW = new Date('2026-09-30T08:00:00Z');

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue(undefined);
});

async function user(
  name: string,
  settings: NotificationSettings | null,
  lastEmailDigestAt: Date | null = null,
  role: 'contributor' | 'editor' | 'admin' = 'editor',
): Promise<number> {
  const id = await seedUser(db, {
    email: `${name}@example.com`,
    username: name,
    role,
    notificationSettings: settings,
  });
  if (lastEmailDigestAt) {
    await db.update(users).set({ lastEmailDigestAt }).where(eq(users.id, id));
  }
  return id;
}

async function notify(
  userId: number,
  audience: 'author' | 'reviewer',
  type = audience === 'author' ? 'edit_approved' : 'dispute_opened',
): Promise<number> {
  const [row] = await db
    .insert(notifications)
    .values({
      userId,
      type,
      title: type === 'edit_approved' ? 'Your edit was approved' : 'Dispute opened',
      url: '/review?id=1',
      audience,
      createdAt: new Date(NOW.getTime() - 60_000),
    })
    .returning({ id: notifications.id });
  return row!.id;
}

async function unhandledCount(userId: number): Promise<number> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.userId, userId));
  const pending = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(isNull(notifications.emailHandledAt));
  return pending.filter((p) => rows.some((r) => r.id === p.id)).length;
}

describe('deliverNotificationEmails over real SQL', () => {
  it('emails nobody who has not opted in, and leaves their rows alone', async () => {
    const quiet = await user('quiet', null);
    await notify(quiet, 'author');

    const result = await deliverNotificationEmails(APP, NOW);

    expect(result).toEqual({ emailsSent: 0, notificationsEmailed: 0, failed: 0 });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(await unhandledCount(quiet)).toBe(1);
  });

  it('sends one email per event to an immediate subscriber, once', async () => {
    const eager = await user('eager', {
      emailOnFeedback: true,
      emailFrequency: 'immediate',
      emailLocale: 'en',
    });
    await notify(eager, 'author');
    await notify(eager, 'author', 'comment_reply');

    const first = await deliverNotificationEmails(APP, NOW);
    const second = await deliverNotificationEmails(APP, NOW);

    expect(first).toEqual({ emailsSent: 2, notificationsEmailed: 2, failed: 0 });
    expect(second.emailsSent).toBe(0);
    expect(sendEmailMock.mock.calls.map((c) => c[0].subject).sort()).toEqual([
      'New reply to your comment',
      'Your edit was approved',
    ]);
    expect(sendEmailMock.mock.calls.every((c) => c[0].to === 'eager@example.com')).toBe(true);
  });

  it('sends only the audiences the user opted in to', async () => {
    const author = await user('author', {
      emailOnFeedback: true,
      emailAsReviewer: false,
      emailFrequency: 'immediate',
    });
    await notify(author, 'author');
    const reviewerRow = await notify(author, 'reviewer');

    await deliverNotificationEmails(APP, NOW);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const [row] = await db
      .select({ handled: notifications.emailHandledAt })
      .from(notifications)
      .where(eq(notifications.id, reviewerRow));
    expect(row!.handled).toBeNull();
  });

  it('never emails review-queue rows to a user who may no longer read the queue', async () => {
    // Opted in while a reviewer, since demoted: the opt-in alone is not
    // authorization. Feedback on their own work still reaches them.
    const demoted = await user(
      'demoted',
      { emailOnFeedback: true, emailAsReviewer: true, emailFrequency: 'immediate' },
      null,
      'contributor',
    );
    const queueRow = await notify(demoted, 'reviewer');
    await notify(demoted, 'author');

    const result = await deliverNotificationEmails(APP, NOW);

    expect(result).toEqual({ emailsSent: 1, notificationsEmailed: 1, failed: 0 });
    expect(sendEmailMock.mock.calls[0]![0].subject).not.toMatch(/dispute/i);
    // Skipped, not deferred: regaining access later must not replay it.
    const [row] = await db
      .select({ handled: notifications.emailHandledAt })
      .from(notifications)
      .where(eq(notifications.id, queueRow));
    expect(row!.handled).not.toBeNull();
  });

  it('emails review-queue rows to a current reviewer', async () => {
    const editor = await user('editor', {
      emailAsReviewer: true,
      emailFrequency: 'immediate',
    });
    await notify(editor, 'reviewer');

    expect((await deliverNotificationEmails(APP, NOW)).emailsSent).toBe(1);
  });

  it('takes over rows whose sending run died, but not rows a live run holds', async () => {
    const eager = await user('eager', { emailOnFeedback: true, emailFrequency: 'immediate' });
    const abandoned = await notify(eager, 'author');
    const held = await notify(eager, 'author', 'comment_reply');
    // One lease lapsed long ago (the run was killed mid-send); one was taken
    // a minute ago by a run that is still sending.
    await db
      .update(notifications)
      .set({ emailClaimedAt: new Date(NOW.getTime() - 60 * 60_000) })
      .where(eq(notifications.id, abandoned));
    await db
      .update(notifications)
      .set({ emailClaimedAt: new Date(NOW.getTime() - 60_000) })
      .where(eq(notifications.id, held));

    const result = await deliverNotificationEmails(APP, NOW);

    expect(result).toEqual({ emailsSent: 1, notificationsEmailed: 1, failed: 0 });
    expect(sendEmailMock.mock.calls[0]![0].subject).toBe('Endringen din ble godkjent');
    const rows = await db
      .select({ id: notifications.id, handled: notifications.emailHandledAt })
      .from(notifications);
    expect(rows.find((r) => r.id === abandoned)!.handled).not.toBeNull();
    expect(rows.find((r) => r.id === held)!.handled).toBeNull();
  });

  it('reminds a summary reviewer of disputes still open when nothing new happened', async () => {
    const reviewer = await user(
      'reviewer',
      { emailAsReviewer: true, emailFrequency: 'daily', emailLocale: 'en' },
      new Date('2026-09-29T06:05:00Z'),
    );
    const author = await seedUser(db, { email: 'x@example.com', username: 'x' });
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: 1,
      createdBy: author,
      source: 'human',
      reasonMd: 'This value contradicts the cited table.',
      status: 'open',
      createdAt: new Date(NOW.getTime() - 4 * 86_400_000),
    });

    const result = await deliverNotificationEmails(APP, NOW);

    expect(result.emailsSent).toBe(1);
    const { to, subject, text } = sendEmailMock.mock.calls[0]![0];
    expect(to).toBe('reviewer@example.com');
    expect(subject).toBe('Kinetix: 1 open dispute waiting (daily summary)');
    expect(text).toContain('1 dispute is open right now; the oldest for 4 days.');
    expect(reviewer).toBeGreaterThan(0);
  });

  it('stops starting sends when its time budget runs out, and serves the skipped users first next run', async () => {
    const busy = await user('busy', { emailOnFeedback: true, emailFrequency: 'immediate' });
    const waiting = await user('waiting', { emailOnFeedback: true, emailFrequency: 'immediate' });
    // `busy` was never served, so it goes first; `waiting` was served before.
    await db.update(users).set({ lastEmailSentAt: new Date('2026-09-01T00:00:00Z') }).where(eq(users.id, waiting));
    await notify(busy, 'author');
    await notify(busy, 'author', 'comment_reply');
    await notify(waiting, 'author');
    // Every clock read advances one second; a 2.5 s budget covers the
    // deadline read, one send and not the second.
    let t = 0;
    const clock = () => (t += 1000);

    const first = await deliverNotificationEmails(APP, NOW, { budgetMs: 2500, clock });

    expect(first.emailsSent).toBe(1);
    expect(sendEmailMock.mock.calls.map((c) => c[0].to)).toEqual(['busy@example.com']);
    // The row it did not reach was handed back, not left leased.
    const leased = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(isNull(notifications.emailHandledAt));
    expect(leased).toHaveLength(2);

    sendEmailMock.mockClear();
    t = 0;
    await deliverNotificationEmails(APP, NOW, { budgetMs: 2500, clock });

    // `busy` was just served, so `waiting` now goes first.
    expect(sendEmailMock.mock.calls[0]![0].to).toBe('waiting@example.com');
  });

  it('does not let idle per-event subscribers use up the budget ahead of one who is owed email', async () => {
    for (const name of ['idle1', 'idle2', 'idle3']) {
      await user(name, { emailOnFeedback: true, emailFrequency: 'immediate' });
    }
    const owed = await user('owed', { emailOnFeedback: true, emailFrequency: 'immediate' });
    // The idle users were never served, so they would sort first.
    await db
      .update(users)
      .set({ lastEmailSentAt: new Date('2026-09-01T00:00:00Z') })
      .where(eq(users.id, owed));
    await notify(owed, 'author');
    let t = 0;
    const clock = () => (t += 1000);

    const result = await deliverNotificationEmails(APP, NOW, { budgetMs: 2500, clock });

    expect(result.emailsSent).toBe(1);
    expect(sendEmailMock.mock.calls[0]![0].to).toBe('owed@example.com');
  });

  it('does not count rows outside a subscriber\'s audiences as email owed', async () => {
    // Feedback-only subscribers holding review-queue rows they never opted
    // in to: claimRows takes nothing for them, so they must not be visited.
    for (const name of ['fb1', 'fb2', 'fb3']) {
      const id = await user(name, { emailOnFeedback: true, emailFrequency: 'immediate' });
      await notify(id, 'reviewer');
    }
    const owed = await user('owed', { emailOnFeedback: true, emailFrequency: 'immediate' });
    await db
      .update(users)
      .set({ lastEmailSentAt: new Date('2026-09-01T00:00:00Z') })
      .where(eq(users.id, owed));
    await notify(owed, 'author');
    let t = 0;
    const clock = () => (t += 1000);

    const result = await deliverNotificationEmails(APP, NOW, { budgetMs: 2500, clock });

    expect(result.emailsSent).toBe(1);
    expect(sendEmailMock.mock.calls[0]![0].to).toBe('owed@example.com');
  });

  it('emails a deploy-window dispute notice to its target author as feedback', async () => {
    // Opted in through the legacy toggle, before the new preferences page.
    const author = await user(
      'legacy',
      { emailWhenPendingEditReviewed: true, emailFrequency: 'immediate' },
      null,
      'contributor',
    );
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
    // Written by the previous build after the migration: 'reviewer' default.
    await db.insert(notifications).values({
      userId: author,
      type: 'dispute_opened',
      title: 'Dispute opened',
      url: '/review?id=1',
      audience: 'reviewer',
      targetType: 'pending_edit',
      targetId: edit!.id,
      disputeId: dispute!.id,
    });

    const result = await deliverNotificationEmails(APP, NOW);

    expect(result.emailsSent).toBe(1);
    expect(sendEmailMock.mock.calls[0]![0].to).toBe('legacy@example.com');
    const [row] = await db.select({ audience: notifications.audience }).from(notifications);
    expect(row!.audience).toBe('author');
  });

  it('moves a user whose sends keep failing to the back, so others are not starved', async () => {
    const failing = await user('failing', { emailOnFeedback: true, emailFrequency: 'immediate' });
    const patient = await user('patient', { emailOnFeedback: true, emailFrequency: 'immediate' });
    await db
      .update(users)
      .set({ lastEmailSentAt: new Date('2026-09-01T00:00:00Z') })
      .where(eq(users.id, patient));
    await notify(failing, 'author');
    await notify(patient, 'author');
    sendEmailMock.mockImplementation(async (msg: { to: string }) => {
      if (msg.to === 'failing@example.com') throw new Error('Resend timeout');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A budget that covers exactly one send attempt per run.
    let t = 0;
    const clock = () => (t += 1000);

    await deliverNotificationEmails(APP, NOW, { budgetMs: 2500, clock });
    expect(sendEmailMock.mock.calls.map((c) => c[0].to)).toEqual(['failing@example.com']);

    sendEmailMock.mockClear();
    t = 0;
    await deliverNotificationEmails(APP, NOW, { budgetMs: 2500, clock });

    // The failed attempt still moved `failing` to the back.
    expect(sendEmailMock.mock.calls[0]![0].to).toBe('patient@example.com');
    consoleError.mockRestore();
  });

  it('sends one summary per period even when two runs overlap', async () => {
    await user(
      'reviewer',
      { emailAsReviewer: true, emailFrequency: 'daily', emailLocale: 'en' },
      new Date('2026-09-29T06:05:00Z'),
    );
    const author = await seedUser(db, { email: 'x@example.com', username: 'x' });
    await db.insert(disputes).values({
      targetType: 'pending_edit',
      targetId: 1,
      createdBy: author,
      source: 'human',
      reasonMd: 'This value contradicts the cited table.',
      status: 'open',
      createdAt: new Date(NOW.getTime() - 2 * 86_400_000),
    });

    const [a, b] = await Promise.all([
      deliverNotificationEmails(APP, NOW),
      deliverNotificationEmails(APP, NOW),
    ]);

    expect(a.emailsSent + b.emailsSent).toBe(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('withholds a queued comment notice whose topic page the recipient can no longer read', async () => {
    const author = await user(
      'author',
      { emailOnFeedback: true, emailFrequency: 'immediate' },
      null,
      'contributor',
    );
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'topic',
        title: 'Topic',
        status: 'published',
        createdBy: author,
        updatedBy: author,
      } as never)
      .returning({ id: wikiPages.id });
    const [comment] = await db
      .insert(drugParameterDiscussions)
      .values({ wikiPageId: page!.id, parameter: null, body: 'Hidden now', createdBy: author })
      .returning({ id: drugParameterDiscussions.id });
    const [row] = await db
      .insert(notifications)
      .values({
        userId: author,
        type: 'comment_reply',
        title: 'New reply to your comment',
        bodyMd: 'Hidden now',
        url: '/wiki/topic',
        audience: 'author',
        targetType: 'drug_discussion',
        targetId: comment!.id,
        createdAt: new Date(NOW.getTime() - 60_000),
      })
      .returning({ id: notifications.id });
    // Unpublished after the notice was queued.
    await db.update(wikiPages).set({ status: 'draft' } as never).where(eq(wikiPages.id, page!.id));

    const result = await deliverNotificationEmails(APP, NOW);

    expect(result.emailsSent).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    const [after] = await db
      .select({ handled: notifications.emailHandledAt })
      .from(notifications)
      .where(eq(notifications.id, row!.id));
    expect(after!.handled).not.toBeNull();
  });

  it('withholds a queued comment notice whose comment was deleted', async () => {
    const author = await user('author', { emailOnFeedback: true, emailFrequency: 'immediate' });
    const drugId = await seedDrug(db);
    const [comment] = await db
      .insert(drugParameterDiscussions)
      .values({ drugId, parameter: null, body: 'Soon gone', createdBy: author })
      .returning({ id: drugParameterDiscussions.id });
    await db.insert(notifications).values({
      userId: author,
      type: 'comment_reply',
      title: 'New reply to your comment',
      bodyMd: 'Soon gone',
      url: '/wiki/drug',
      audience: 'author',
      targetType: 'drug_discussion',
      targetId: comment!.id,
      createdAt: new Date(NOW.getTime() - 60_000),
    });
    await db.delete(drugParameterDiscussions).where(eq(drugParameterDiscussions.id, comment!.id));

    expect((await deliverNotificationEmails(APP, NOW)).emailsSent).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('retakes a summary period whose sending run died, but not one a live run holds', async () => {
    const daily = await user(
      'daily',
      { emailOnFeedback: true, emailFrequency: 'daily' },
      new Date('2026-09-29T06:05:00Z'),
    );
    await notify(daily, 'author');
    // A live run leased the period a minute ago.
    await db
      .update(users)
      .set({ emailDigestClaimedAt: new Date(NOW.getTime() - 60_000) })
      .where(eq(users.id, daily));
    expect((await deliverNotificationEmails(APP, NOW)).emailsSent).toBe(0);

    // That run died; its lease lapsed, and the period was never marked done.
    await db
      .update(users)
      .set({ emailDigestClaimedAt: new Date(NOW.getTime() - 60 * 60_000) })
      .where(eq(users.id, daily));
    expect((await deliverNotificationEmails(APP, NOW)).emailsSent).toBe(1);
  });

  it('releases a refused email so the next run retries it', async () => {
    const eager = await user('eager', { emailOnFeedback: true, emailFrequency: 'immediate' });
    await notify(eager, 'author');
    sendEmailMock.mockRejectedValueOnce(new Error('Resend API error 500'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await deliverNotificationEmails(APP, NOW);
    const second = await deliverNotificationEmails(APP, NOW);

    expect(first).toEqual({ emailsSent: 0, notificationsEmailed: 0, failed: 1 });
    expect(second).toEqual({ emailsSent: 1, notificationsEmailed: 1, failed: 0 });
    consoleError.mockRestore();
  });

  it('collects a summary subscriber’s events into one email when the period is due', async () => {
    const daily = await user(
      'daily',
      { emailOnFeedback: true, emailAsReviewer: true, emailFrequency: 'daily', emailLocale: 'en' },
      new Date('2026-09-29T06:05:00Z'),
    );
    await notify(daily, 'author');
    await notify(daily, 'reviewer');
    await notify(daily, 'author', 'comment_reply');

    const result = await deliverNotificationEmails(APP, NOW);

    expect(result).toEqual({ emailsSent: 1, notificationsEmailed: 3, failed: 0 });
    const { subject, text } = sendEmailMock.mock.calls[0]![0];
    expect(subject).toBe('Kinetix: 3 new notifications (daily summary)');
    expect(text).toContain('Feedback on your contributions');
    expect(text).toContain('Review queue');
    const [u] = await db
      .select({ last: users.lastEmailDigestAt })
      .from(users)
      .where(eq(users.id, daily));
    expect(u!.last?.toISOString()).toBe(NOW.toISOString());

    // Already sent this period: a later run the same day sends nothing.
    await notify(daily, 'author');
    expect((await deliverNotificationEmails(APP, new Date(NOW.getTime() + 3_600_000))).emailsSent).toBe(0);
  });

  it('holds a weekly summary until Monday', async () => {
    const weekly = await user(
      'weekly',
      { emailOnFeedback: true, emailFrequency: 'weekly' },
      new Date('2026-09-28T06:05:00Z'), // this Monday's summary already went out
    );
    await notify(weekly, 'author');

    expect((await deliverNotificationEmails(APP, NOW)).emailsSent).toBe(0);
    expect(
      (await deliverNotificationEmails(APP, new Date('2026-10-05T06:10:00Z'))).emailsSent,
    ).toBe(1);
  });
});
