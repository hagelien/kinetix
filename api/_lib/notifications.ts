/**
 * Helpers for the `notifications` in-app inbox.
 *
 * Fan-out policy (see docs/superpowers/specs/2026-06-23-unified-disputes.md):
 * on a dispute event we notify the target's author plus every reviewer
 * (editor/admin), minus the actor who raised/resolved it — you don't get an
 * inbox ping for your own action. Agents are deliberately NOT notified here:
 * they pull the deterministic GET /api/disputes feed each cycle instead of
 * needing a push channel.
 *
 * Every row carries an `audience`: 'author' when it is feedback on the
 * recipient's own contribution (a dispute on something they wrote, a review
 * decision on their edit, a comment on their parameter or fact, a reply to
 * their comment), 'reviewer' when it reaches them as part of the review
 * queue. These rows are the in-app inbox AND the source of every email: the
 * delivery job (api/_lib/notificationEmails.ts) mails a row only to a user
 * who opted in to its audience, per event or as a summary.
 */

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from './db.js';
import {
  notifications,
  users,
  type NotificationType,
} from '../../db/schema.js';
import { ROLES, ROLE_VALUES } from '../../src/lib/roles.js';
import { CAP } from '../../src/lib/permissions.js';
import { callerCan, callerCanReadWikiPage } from './permissions-store.js';

export interface NotificationRow {
  id: number;
  type: string;
  targetType: string | null;
  targetId: number | null;
  disputeId: number | null;
  title: string;
  bodyMd: string | null;
  url: string | null;
  readAt: string | null;
  createdAt: string;
}

/** users.id of every reviewer (editor/admin) — the dispute broadcast audience. */
export async function reviewerUserIds(): Promise<number[]> {
  const db = getDb();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.role, [ROLES.editor, ROLES.admin]));
  return rows.map((r) => r.id);
}

/** users.id of every human admin — the escalation audience for an overdue dispute. */
export async function adminUserIds(): Promise<number[]> {
  // Human admins only: an agent's backing user may hold the admin role, but
  // agents read the dispute feed, never the inbox. Counting one here would
  // let escalation claim disputes that no person was ever told about.
  const result = await getDb().execute<{ id: number }>(sql`
    SELECT u.id FROM users u
    WHERE u.role = ${ROLES.admin}
      AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.user_id = u.id)
  `);
  return result.rows.map((r) => r.id);
}

/**
 * One in-app `dispute_escalated` row per (admin, escalated dispute), deep
 * linking to the moderator queue. The inbox copy of the escalation email, so
 * an admin who does not read that email still sees it the next time they open
 * the app. No-op when either list is empty.
 */
export async function notifyAdminsOfEscalatedDisputes(args: {
  adminIds: number[];
  disputes: { id: number; targetType: string; targetId: number }[];
}): Promise<void> {
  if (args.adminIds.length === 0 || args.disputes.length === 0) return;
  const db = getDb();
  const now = new Date();
  await db.insert(notifications).values(
    args.adminIds.flatMap((userId) =>
      args.disputes.map((d) => ({
        userId,
        type: 'dispute_escalated' satisfies NotificationType,
        targetType: d.targetType,
        targetId: d.targetId,
        disputeId: d.id,
        title: 'Dispute overdue',
        bodyMd: null,
        url: '/admin?pane=disputes',
        audience: 'reviewer',
        createdAt: now,
      })),
    ),
  );
}

/**
 * Pure recipient policy: target author ∪ reviewers, minus the actor and any
 * null id, de-duplicated. Extracted so the fan-out rule is unit-testable
 * without a database.
 */
export function disputeNotificationRecipients(args: {
  reviewerIds: number[];
  targetAuthorUserId: number | null;
  actorUserId: number;
}): number[] {
  const set = new Set<number>(args.reviewerIds);
  if (args.targetAuthorUserId !== null) set.add(args.targetAuthorUserId);
  set.delete(args.actorUserId);
  return [...set];
}

/**
 * The roles that may read the dispute queue under the CURRENT capability
 * matrix — the reviewer audience of a dispute event. Resolved through the
 * fail-closed {@link callerCan}, so an admin lowering `dispute.queue.read` to
 * contributors brings them into the fan-out (and so into reviewer email),
 * raising it takes editors out, and an unreadable policy narrows the
 * audience to the roles no override can exclude rather than widening it.
 */
export async function disputeQueueReaderRoles(): Promise<string[]> {
  const roles: string[] = [];
  for (const role of ROLE_VALUES) {
    if (await callerCan(role, CAP['dispute.queue.read'])) roles.push(role);
  }
  return roles;
}

/**
 * Compute the recipient set for a dispute event and insert one row each.
 * Recipients = target author ∪ everyone whose role may read the dispute
 * queue ({@link disputeQueueReaderRoles}), minus the actor (and any null ids),
 * de-duplicated. A single bulk insert; no-op when the set is empty.
 */
export async function fanOutDisputeNotification(args: {
  type: NotificationType;
  disputeId: number;
  targetType: string;
  targetId: number;
  actorUserId: number;
  targetAuthorUserId: number | null;
  title: string;
  bodyMd?: string | null;
  url?: string | null;
}): Promise<{ recipients: number }> {
  const db = getDb();
  const now = new Date();
  const readerRoles = await disputeQueueReaderRoles();
  // `ROLES.admin` is never excluded by the matrix; it keeps the IN list
  // non-empty even when every lower role is denied.
  const roleList = sql.join(
    [...new Set([...readerRoles, ROLES.admin])].map((r) => sql`${r}`),
    sql`, `,
  );
  const result = await db.execute<{ recipients: number }>(sql`
    WITH candidate_recipients AS (
      SELECT id AS user_id
      FROM users
      WHERE role IN (${roleList})
        -- Agents read the deterministic dispute feed, never the inbox; with
        -- the queue lowered to contributors, their backing users would
        -- otherwise join the reviewer audience. A human target author is
        -- still added below.
        AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.user_id = users.id)
      UNION
      SELECT author_user_id AS user_id
      FROM (
        SELECT ${args.targetAuthorUserId}::int AS author_user_id
      ) author
      WHERE author_user_id IS NOT NULL
    ),
    inserted AS (
      INSERT INTO notifications (
        user_id,
        type,
        target_type,
        target_id,
        dispute_id,
        title,
        body_md,
        url,
        audience,
        created_at
      )
      SELECT
        user_id,
        ${args.type},
        ${args.targetType},
        ${args.targetId},
        ${args.disputeId},
        ${args.title},
        ${args.bodyMd ?? null},
        ${args.url ?? null},
        -- The target's author is told as its author even when they are also
        -- a reviewer: it is feedback on their own work.
        CASE
          WHEN user_id = ${args.targetAuthorUserId}::int THEN 'author'
          ELSE 'reviewer'
        END,
        ${now}
      FROM candidate_recipients
      WHERE user_id IS NOT NULL
        AND user_id <> ${args.actorUserId}
      RETURNING id
    )
    SELECT count(*)::int AS recipients
    FROM inserted
  `);
  return { recipients: result.rows[0]?.recipients ?? 0 };
}

/**
 * Tell a human contributor about feedback on something they contributed: a
 * review decision on their edit, a comment on their parameter or fact, a
 * reply to their comment, an approval stamp. One `author`-audience row.
 *
 * Skipped — in SQL, so it holds inside any caller's transaction — when there
 * is no recipient, when the recipient is the actor (no ping for your own
 * action), and when the recipient is an agent's backing user: agents learn
 * about feedback through their hooks and the dispute feed, never the inbox.
 */
export async function notifyContributionFeedback(args: {
  recipientUserId: number | null;
  actorUserId: number | null;
  type: NotificationType;
  targetType: string;
  targetId: number;
  title: string;
  bodyMd?: string | null;
  url: string;
}): Promise<{ notified: boolean }> {
  if (args.recipientUserId === null) return { notified: false };
  if (args.actorUserId !== null && args.recipientUserId === args.actorUserId) {
    return { notified: false };
  }
  const result = await getDb().execute<{ id: number }>(sql`
    INSERT INTO notifications (
      user_id, type, target_type, target_id, title, body_md, url, audience, created_at
    )
    SELECT
      u.id,
      ${args.type},
      ${args.targetType},
      ${args.targetId},
      ${args.title},
      ${args.bodyMd ?? null},
      ${args.url},
      'author',
      ${new Date()}
    FROM users u
    WHERE u.id = ${args.recipientUserId}
      AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.user_id = u.id)
    RETURNING id
  `);
  return { notified: result.rows.length > 0 };
}

/**
 * The notifications among `ids` whose subject `role` may no longer see.
 *
 * A notice about a discussion comment or a wiki revision carries text from a
 * topic page, and access can change after the row is written: the page is
 * unpublished, the reader's role narrows, or the comment, revision or page is
 * deleted. Every surface that shows the stored text — the inbox and the email
 * delivery — asks this first, with the same `callerCanReadWikiPage` the
 * discussion endpoint answers 404 with. A missing target counts as unreadable.
 * Notices with no topic page behind them (drug monographs, pending edits,
 * other dispute targets) are never returned.
 */
export async function unreadableNotificationIds(
  ids: number[],
  role: string,
): Promise<Set<number>> {
  const unreadable = new Set<number>();
  if (ids.length === 0) return unreadable;
  const result = await getDb().execute<{
    id: number;
    target_type: string;
    discussion_id: number | null;
    discussion_page_id: number | null;
    revision_id: number | null;
    page_id: number | null;
    status: string | null;
  }>(sql`
    SELECT n.id, n.target_type,
           d.id AS discussion_id, d.wiki_page_id AS discussion_page_id,
           wr.id AS revision_id, wp.id AS page_id, wp.status
    FROM notifications n
    LEFT JOIN drug_parameter_discussions d
      ON n.target_type = 'drug_discussion' AND d.id = n.target_id
    LEFT JOIN wiki_revisions wr
      ON n.target_type = 'wiki_revision' AND wr.id = n.target_id
    LEFT JOIN wiki_pages wp ON wp.id = COALESCE(d.wiki_page_id, wr.page_id)
    WHERE n.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      AND n.target_type IN ('drug_discussion', 'wiki_revision')
  `);
  for (const r of result.rows) {
    const targetGone =
      r.target_type === 'drug_discussion'
        ? r.discussion_id === null ||
          (r.discussion_page_id !== null && r.page_id === null)
        : r.revision_id === null || r.page_id === null;
    if (targetGone) {
      unreadable.add(r.id);
      continue;
    }
    // A drug-hosted discussion has no topic page: readable to anyone.
    if (r.page_id === null || r.status === 'published') continue;
    if (!(await callerCanReadWikiPage(r.status, { role }))) unreadable.add(r.id);
  }
  return unreadable;
}

/**
 * The author of a dispute notice's target, per target type — the same
 * resolution as `targetAuthorUserId` (agent-verifications.ts); migration 0133
 * backfills stored rows with it too. Only the two dispute event types the
 * previous build wrote are matched: their target author's copy is feedback on
 * their own work.
 */
const DISPUTE_NOTICE_OF_TARGET_AUTHOR = sql`
  n.type IN ('dispute_opened', 'dispute_resolved')
  AND n.dispute_id IS NOT NULL
  AND n.user_id = CASE n.target_type
    WHEN 'wiki_revision' THEN (SELECT created_by FROM wiki_revisions WHERE id = n.target_id)
    WHEN 'drug_parameter_revision' THEN (SELECT created_by FROM drug_parameter_revisions WHERE id = n.target_id)
    WHEN 'drug_discussion' THEN (SELECT created_by FROM drug_parameter_discussions WHERE id = n.target_id)
    WHEN 'paper_review' THEN (SELECT created_by FROM paper_reviews WHERE id = n.target_id)
    WHEN 'learning_unit_revision' THEN (SELECT created_by FROM learning_unit_revisions WHERE id = n.target_id)
    WHEN 'pending_edit' THEN (SELECT submitted_by FROM pending_edits WHERE id = n.target_id)
  END
`;

/** The notifications among `ids` that tell `userId` about a dispute on their own work. */
async function targetAuthoredNotificationIds(
  ids: number[],
  userId: number,
): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const result = await getDb().execute<{ id: number }>(sql`
    SELECT n.id
    FROM notifications n
    WHERE n.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      AND n.user_id = ${userId}
      AND ${DISPUTE_NOTICE_OF_TARGET_AUTHOR}
  `);
  return new Set(result.rows.map((r) => r.id));
}

/**
 * Re-tag as `author` every not-yet-emailed dispute notice that went to the
 * disputed target's author with the `reviewer` default — rows the previous
 * build wrote during the 0133 deploy window, after the migration's backfill.
 * The current build tags these rows itself, so after the window this matches
 * nothing. Run before each email delivery, so a user already opted in to
 * feedback (the legacy toggle carries over) gets them as feedback.
 */
export async function reclassifyTargetAuthorNotices(): Promise<number> {
  const result = await getDb().execute(sql`
    UPDATE notifications n SET audience = 'author'
    WHERE n.audience = 'reviewer'
      AND n.email_handled_at IS NULL
      AND ${DISPUTE_NOTICE_OF_TARGET_AUTHOR}
  `);
  return result.rowCount ?? 0;
}

/**
 * Caller's inbox, newest first; optionally only unread. The stored excerpt is
 * withheld (`bodyMd: null`) from any notice whose subject the caller may no
 * longer read ({@link unreadableNotificationIds}), and from review-queue
 * notices once the caller may no longer read the queue; the generic title
 * stays so the inbox count and history do not silently change.
 */
export async function listNotifications(args: {
  userId: number;
  role: string;
  unreadOnly?: boolean;
  limit: number;
}): Promise<NotificationRow[]> {
  const db = getDb();
  const where = args.unreadOnly
    ? and(eq(notifications.userId, args.userId), isNull(notifications.readAt))
    : eq(notifications.userId, args.userId);
  const rows = await db
    .select()
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(args.limit);
  const hidden = await unreadableNotificationIds(
    rows.map((r) => r.id),
    args.role,
  );
  // Review-queue notices carry dispute content: readable only while the
  // caller may still read the queue, under the current matrix (fail-closed),
  // exactly as the email delivery and GET /api/disputes decide it.
  // A row naming the caller as the disputed target's author stays readable:
  // it is feedback on their own work, whatever its stored audience (rows the
  // previous build wrote during the 0133 deploy window default to 'reviewer').
  const reviewerRows = rows.filter((r) => r.audience === 'reviewer');
  if (
    reviewerRows.length > 0 &&
    !(await callerCan(args.role, CAP['dispute.queue.read']))
  ) {
    const own = await targetAuthoredNotificationIds(
      reviewerRows.map((r) => r.id),
      args.userId,
    );
    for (const r of reviewerRows) if (!own.has(r.id)) hidden.add(r.id);
  }
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    targetType: r.targetType,
    targetId: r.targetId,
    disputeId: r.disputeId,
    title: r.title,
    bodyMd: hidden.has(r.id) ? null : r.bodyMd,
    url: r.url,
    readAt: r.readAt ? r.readAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Count of the caller's unread notifications (drives the bell badge). */
export async function unreadNotificationCount(userId: number): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return row?.count ?? 0;
}

/**
 * Mark the caller's notifications read. Scoped to the caller's own rows so a
 * passed id list can never touch someone else's inbox. Returns rows updated.
 */
export async function markNotificationsRead(args: {
  userId: number;
  ids?: number[];
  all?: boolean;
}): Promise<number> {
  const db = getDb();
  const base = and(
    eq(notifications.userId, args.userId),
    isNull(notifications.readAt),
  );
  const where =
    args.all === true
      ? base
      : and(base, inArray(notifications.id, args.ids ?? []));
  const updated = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(where)
    .returning({ id: notifications.id });
  return updated.length;
}
