/**
 * Opt-in email delivery for in-app notifications, and overdue-dispute
 * escalation (#1233).
 *
 * Every email is built from `notifications` rows. Nobody gets email unless
 * they opted in on /preferences (src/lib/emailNotificationPrefs.ts):
 *
 *   - `author` rows (feedback on the user's own contribution) need
 *     `emailOnFeedback`; `reviewer` rows (the review queue) need
 *     `emailAsReviewer`.
 *   - `immediate` users get one email per row; `daily` / `weekly` / `monthly`
 *     users get one summary per period, at the 03:00 UTC slot.
 *
 * A run leases each row (`email_claimed_at`, conditional UPDATE) before
 * sending it, so overlapping runs never send the same row concurrently, and
 * marks it `email_handled_at` only after the provider accepts it. A refused
 * send releases the lease at once; a run that dies mid-send leaves a lease
 * that lapses, and the next run takes the row over.
 *
 * Driven by the Vercel cron against `api/notification-emails.ts` once a day,
 * at 05:00 in Norway; `npm run notifications:email` runs the same thing by
 * hand. Immediate-mode users therefore get at most `IMMEDIATE_BATCH` emails a
 * day; the preferences page no longer offers that mode.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getDb, inTransaction } from './db.js';
import { sendEmail } from './email.js';
import { claimOverdueDisputesForEscalation } from './disputes.js';
import {
  adminUserIds,
  notifyAdminsOfEscalatedDisputes,
  reclassifyTargetAuthorNotices,
  unreadableNotificationIds,
} from './notifications.js';
import { PARAMETER_LABELS } from './parameterLabels.js';
import { callerCan } from './permissions-store.js';
import { CAP } from '../../src/lib/permissions.js';
import { DISPUTE_OVERDUE_THRESHOLD_MS } from '../../src/lib/disputeAge.js';
import { resolveDrugName } from '../../src/lib/drugNames.js';
import {
  digestDue,
  digestPeriodStart,
  enabledAudiences,
  resolveEmailPrefs,
  type EmailFrequency,
  type EmailLocale,
  type NotificationAudience,
  type NotificationSettings,
} from '../../src/lib/emailNotificationPrefs.js';

/** Rows one immediate-mode user is sent per run; the rest wait for the next. */
const IMMEDIATE_BATCH = 5;
/** Rows one summary carries at most; a larger backlog continues next period. */
const DIGEST_BATCH = 200;
const BODY_EXCERPT = 300;
const ABOUT_DETAIL_EXCERPT = 160;

/**
 * What a notice is about, read from its target when the email is built: the
 * page, drug parameter, paper or learning unit, and a short detail (the edit
 * summary, the comment text). Lets a summary line say "Paracetamol ·
 * Half-life: corrected the range" instead of only "your contribution got a
 * stamp". Every part is optional; a deleted target yields nothing.
 */
export interface NotificationAbout {
  title: string | null;
  drugNames: Record<string, string> | null;
  parameter: string | null;
  detail: string | null;
}

export interface NotificationRowForEmail {
  id: number;
  type: string;
  title: string;
  bodyMd: string | null;
  url: string | null;
  audience: NotificationAudience;
  createdAt: Date;
  about?: NotificationAbout | null;
}

interface Recipient {
  id: number;
  email: string;
  role: string;
  settings: NotificationSettings | null;
  lastDigestAt: Date | null;
}

export interface NotificationEmailRunResult {
  /** Overdue disputes escalated to the admins this run. */
  escalated: number;
  /** Emails the provider accepted. */
  emailsSent: number;
  /** Notifications those emails covered. */
  notificationsEmailed: number;
  /** Emails the provider refused; their rows are retried next run. */
  failed: number;
}

// ─── Copy ──────────────────────────────────────────────────────────────────

const COPY = {
  nb: {
    titles: {
      dispute_opened: 'Innsigelse mot noe du kan vurdere eller har bidratt med',
      dispute_opened_author: 'Noen har bestridt noe du har sendt inn',
      dispute_upheld: 'En innsigelse ble tatt til følge',
      dispute_rejected: 'En innsigelse ble avvist',
      dispute_withdrawn: 'En innsigelse ble trukket',
      dispute_escalated: 'En innsigelse har stått åpen i over en uke',
      adjudication_handoff: 'Et T3-panel har overlatt en sak til et menneske',
      edit_approved: 'Endringen din ble godkjent',
      edit_rejected: 'Endringen din ble avvist',
      edit_returned: 'Endringen din ble sendt tilbake for endringer',
      comment_reply: 'Nytt svar på kommentaren din',
      comment_on_contribution: 'Ny kommentar på bidraget ditt',
      comment_in_thread: 'Ny kommentar i en diskusjon du deltar i',
      contribution_endorsed: 'Bidraget ditt fikk et godkjenningsstempel',
    } as Record<string, string>,
    open: 'Åpne i Kinetix',
    feedbackHeading: 'Tilbakemeldinger på bidragene dine',
    reviewerHeading: 'Vurderingskøen',
    summarySubject: (n: number, period: string) =>
      `Kinetix: ${n} ${n === 1 ? 'ny hendelse' : 'nye hendelser'} (${period})`,
    backlogSubject: (n: number, period: string) =>
      `Kinetix: ${n} ${n === 1 ? 'åpen innsigelse' : 'åpne innsigelser'} venter (${period})`,
    period: { daily: 'daglig oppsummering', weekly: 'ukentlig oppsummering', monthly: 'månedlig oppsummering' },
    backlog: (n: number, days: number) =>
      `${n} ${n === 1 ? 'innsigelse står' : 'innsigelser står'} åpne nå; den eldste i ${days} ${days === 1 ? 'dag' : 'dager'}.`,
    footer: 'Du får denne e-posten fordi du har slått på e-postvarsler.',
    settings: 'Endre e-postinnstillinger',
  },
  en: {
    titles: {
      dispute_opened: 'A dispute was raised on something you review or contributed',
      dispute_opened_author: 'Someone disputed something you submitted',
      dispute_upheld: 'A dispute was upheld',
      dispute_rejected: 'A dispute was rejected',
      dispute_withdrawn: 'A dispute was withdrawn',
      dispute_escalated: 'A dispute has been open for over a week',
      adjudication_handoff: 'A T3 panel left a case for a person',
      edit_approved: 'Your edit was approved',
      edit_rejected: 'Your edit was rejected',
      edit_returned: 'Your edit was returned for changes',
      comment_reply: 'New reply to your comment',
      comment_on_contribution: 'New comment on your contribution',
      comment_in_thread: 'New comment in a discussion you joined',
      contribution_endorsed: 'Your contribution received an approval stamp',
    } as Record<string, string>,
    open: 'Open in Kinetix',
    feedbackHeading: 'Feedback on your contributions',
    reviewerHeading: 'Review queue',
    summarySubject: (n: number, period: string) =>
      `Kinetix: ${n} new ${n === 1 ? 'notification' : 'notifications'} (${period})`,
    backlogSubject: (n: number, period: string) =>
      `Kinetix: ${n} open ${n === 1 ? 'dispute' : 'disputes'} waiting (${period})`,
    period: { daily: 'daily summary', weekly: 'weekly summary', monthly: 'monthly summary' },
    backlog: (n: number, days: number) =>
      `${n} ${n === 1 ? 'dispute is' : 'disputes are'} open right now; the oldest for ${days} ${days === 1 ? 'day' : 'days'}.`,
    footer: "You're receiving this because you turned on email notifications.",
    settings: 'Change email settings',
  },
} satisfies Record<EmailLocale, unknown>;

/** Localized title; the stored English title for any type not listed. */
export function notificationTitle(
  row: Pick<NotificationRowForEmail, 'type' | 'title'> &
    Partial<Pick<NotificationRowForEmail, 'audience'>>,
  locale: EmailLocale,
): string {
  let key = row.type;
  if (row.type === 'dispute_opened' && row.audience === 'author') {
    // Only the submitter gets an `author` copy, so say so plainly.
    key = 'dispute_opened_author';
  } else if (row.type === 'dispute_resolved') {
    // Stored as `Dispute ${resolution}`, the same token the bell reads.
    const outcome = row.title.trim().split(/\s+/).pop()?.toLowerCase();
    key = `dispute_${outcome}`;
  }
  return COPY[locale].titles[key] ?? row.title;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function excerpt(body: string | null): string | null {
  const t = body?.trim();
  if (!t) return null;
  return t.length <= BODY_EXCERPT ? t : `${t.slice(0, BODY_EXCERPT).trimEnd()}…`;
}

function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}…`;
}

/**
 * One line naming what a notice is about, e.g. `Paracetamol · Half-life:
 * corrected the range`; null when nothing is known. The detail is left out
 * when the notice body already says the same (a comment notice carries the
 * comment itself).
 */
export function aboutLine(
  row: Pick<NotificationRowForEmail, 'about' | 'bodyMd'>,
  locale: EmailLocale,
): string | null {
  const a = row.about;
  if (!a) return null;
  const drug = a.drugNames ? resolveDrugName(a.drugNames, locale) : '';
  const parameter =
    a.parameter && !a.parameter.startsWith('fact:')
      ? (PARAMETER_LABELS[locale][a.parameter] ?? a.parameter)
      : '';
  const where = [a.title?.trim(), drug, parameter].filter(Boolean).join(' · ');
  const detail = a.detail?.trim();
  const showDetail =
    detail && !detail.startsWith('auto:') && detail !== row.bodyMd?.trim()
      ? shorten(detail, ABOUT_DETAIL_EXCERPT)
      : '';
  if (where && showDetail) return `${where}: ${showDetail}`;
  return where || showDetail || null;
}

function absolute(appUrl: string, path: string | null): string {
  const base = appUrl.replace(/\/$/, '');
  if (!path) return base;
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

function shell(appUrl: string, locale: EmailLocale, heading: string, inner: string): string {
  const c = COPY[locale];
  return `
    <div style="font-family: system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px;">
      <h1 style="font-size: 20px; margin-bottom: 12px;">${escapeHtml(heading)}</h1>
      ${inner}
      <p style="color: #888; font-size: 12px; margin-top: 32px;">
        ${escapeHtml(c.footer)}
        <a href="${absolute(appUrl, '/preferences')}" style="color: #888;">${escapeHtml(c.settings)}</a>
      </p>
    </div>
  `;
}

export function buildEventEmail(
  row: NotificationRowForEmail,
  appUrl: string,
  locale: EmailLocale,
): { subject: string; html: string; text: string } {
  const c = COPY[locale];
  const title = notificationTitle(row, locale);
  const about = aboutLine(row, locale);
  const body = excerpt(row.bodyMd);
  const link = absolute(appUrl, row.url);
  const html = shell(
    appUrl,
    locale,
    title,
    `${about ? `<p style="color: #555; margin: 0 0 12px;">${escapeHtml(about)}</p>` : ''}
      ${body ? `<p style="color: #333; line-height: 1.5; white-space: pre-wrap;">${escapeHtml(body)}</p>` : ''}
      <p style="margin: 24px 0;">
        <a href="${link}" style="display: inline-block; padding: 10px 20px; background: #0f172a; color: #fff; border-radius: 6px; text-decoration: none;">${escapeHtml(c.open)}</a>
      </p>`,
  );
  const text = `${title}\n\n${about ? `${about}\n\n` : ''}${body ? `${body}\n\n` : ''}${c.open}: ${link}\n\n${c.settings}: ${absolute(appUrl, '/preferences')}\n`;
  return { subject: title, html, text };
}

export function buildSummaryEmail(args: {
  rows: NotificationRowForEmail[];
  frequency: Exclude<EmailFrequency, 'immediate'>;
  appUrl: string;
  locale: EmailLocale;
  /** Open-dispute backlog, shown to reviewer subscribers. */
  backlog: { open: number; oldestDays: number } | null;
}): { subject: string; html: string; text: string } {
  const c = COPY[args.locale];
  const subject =
    args.rows.length === 0 && args.backlog
      ? c.backlogSubject(args.backlog.open, c.period[args.frequency])
      : c.summarySubject(args.rows.length, c.period[args.frequency]);
  const sections = (
    [
      ['author', c.feedbackHeading],
      ['reviewer', c.reviewerHeading],
    ] as const
  )
    .map(([audience, heading]) => ({
      audience,
      heading,
      rows: args.rows.filter((r) => r.audience === audience),
    }))
    .filter((s) => s.rows.length > 0 || (s.audience === 'reviewer' && args.backlog));

  const itemHtml = (r: NotificationRowForEmail) => {
    const about = aboutLine(r, args.locale);
    const body = excerpt(r.bodyMd);
    return `<li style="margin-bottom: 12px;"><a href="${absolute(args.appUrl, r.url)}">${escapeHtml(notificationTitle(r, args.locale))}</a>${about ? `<br><span style="color: #555;">${escapeHtml(about)}</span>` : ''}${body ? `<br><span style="color: #555;">${escapeHtml(body)}</span>` : ''}</li>`;
  };
  const itemText = (r: NotificationRowForEmail) => {
    const about = aboutLine(r, args.locale);
    const body = excerpt(r.bodyMd);
    return `- ${notificationTitle(r, args.locale)}${about ? ` (${about})` : ''}${body ? ` — ${body}` : ''}\n  ${absolute(args.appUrl, r.url)}`;
  };
  const backlogLine =
    args.backlog && args.backlog.open > 0
      ? c.backlog(args.backlog.open, args.backlog.oldestDays)
      : null;

  const html = shell(
    args.appUrl,
    args.locale,
    subject,
    sections
      .map(
        (s) => `
      <h2 style="font-size: 15px; margin: 20px 0 6px;">${escapeHtml(s.heading)}</h2>
      ${s.audience === 'reviewer' && backlogLine ? `<p style="color: #555;">${escapeHtml(backlogLine)} <a href="${absolute(args.appUrl, '/admin?pane=disputes')}">${escapeHtml(c.open)}</a></p>` : ''}
      <ul style="color: #333; line-height: 1.5; padding-left: 20px; margin-top: 0;">${s.rows.map(itemHtml).join('\n')}</ul>`,
      )
      .join('\n'),
  );
  const text =
    `${subject}\n\n` +
    sections
      .map(
        (s) =>
          `${s.heading}\n` +
          (s.audience === 'reviewer' && backlogLine ? `${backlogLine}\n` : '') +
          s.rows.map(itemText).join('\n'),
      )
      .join('\n\n') +
    `\n\n${c.settings}: ${absolute(args.appUrl, '/preferences')}\n`;
  return { subject, html, text };
}

// ─── Escalation ────────────────────────────────────────────────────────────

/**
 * Escalate every newly overdue dispute to the admins. The claim on
 * `disputes.escalated_at` and the admins' in-app rows commit together: if
 * anything fails before the commit, the claim rolls back and the next run
 * escalates the dispute again, so a dispute is never marked escalated
 * without the admins having been told. Email follows through the ordinary
 * delivery below, for admins who opted in to reviewer email.
 */
export async function escalateOverdueDisputes(now: Date): Promise<number> {
  return inTransaction(async () => {
    // With nobody to tell there is no escalation: claiming anyway would mark
    // the disputes escalated for good, and an admin appointed later would
    // never hear of them. Leave them unclaimed for the next run.
    const adminIds = await adminUserIds();
    if (adminIds.length === 0) return 0;
    const claimed = await claimOverdueDisputesForEscalation({
      overdueBefore: new Date(now.getTime() - DISPUTE_OVERDUE_THRESHOLD_MS),
      now,
    });
    if (claimed.length === 0) return 0;
    await notifyAdminsOfEscalatedDisputes({ adminIds, disputes: claimed });
    return claimed.length;
  });
}

// ─── Delivery ──────────────────────────────────────────────────────────────

async function optedInRecipients(now: Date): Promise<Recipient[]> {
  const leaseLapsedBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
  // A coarse SQL pre-filter; resolveEmailPrefs decides precisely (an explicit
  // `emailOnFeedback: false` overrides the legacy toggle).
  const result = await getDb().execute<{
    id: number;
    email: string;
    role: string;
    notification_settings: NotificationSettings | null;
    last_email_digest_at: Date | string | null;
  }>(sql`
    SELECT id, email, role, notification_settings, last_email_digest_at
    FROM users
    WHERE (notification_settings->>'emailOnFeedback' = 'true'
       OR notification_settings->>'emailAsReviewer' = 'true'
       OR notification_settings->>'emailWhenPendingEditReviewed' = 'true')
      -- A per-event subscriber with nothing claimRows would take has nothing
      -- to do this run; leaving them out keeps idle users from filling the
      -- front of the order and using up the budget ahead of users who are
      -- owed email. "Would take" mirrors claimRows: unsent, not leased by a
      -- live run, and in an audience the user opted in to (resolveEmailPrefs'
      -- rule, legacy toggle included). Summary subscribers stay in: a
      -- reviewer's summary can be due with no new rows (the open-dispute
      -- reminder).
      AND (
        notification_settings->>'emailFrequency' IS DISTINCT FROM 'immediate'
        OR EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.user_id = users.id
            AND n.email_handled_at IS NULL
            AND (n.email_claimed_at IS NULL OR n.email_claimed_at < ${leaseLapsedBefore})
            AND (
              (n.audience = 'author' AND COALESCE(
                notification_settings->>'emailOnFeedback',
                notification_settings->>'emailWhenPendingEditReviewed'
              ) = 'true')
              OR (n.audience = 'reviewer'
                AND notification_settings->>'emailAsReviewer' = 'true')
            )
        )
      )
    -- Least recently served first: a run that ends on its time budget
    -- leaves the users it did not reach at the front of the next run.
    ORDER BY last_email_sent_at ASC NULLS FIRST, id
  `);
  return result.rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    settings: r.notification_settings,
    lastDigestAt: r.last_email_digest_at ? new Date(r.last_email_digest_at) : null,
  }));
}

function toRow(r: {
  id: number;
  type: string;
  title: string;
  body_md: string | null;
  url: string | null;
  audience: string;
  created_at: Date | string;
  about_title?: string | null;
  about_drug_names?: Record<string, string> | null;
  about_parameter?: string | null;
  about_detail?: string | null;
}): NotificationRowForEmail {
  const about: NotificationAbout = {
    title: r.about_title ?? null,
    drugNames: r.about_drug_names ?? null,
    parameter: r.about_parameter ?? null,
    detail: r.about_detail ?? null,
  };
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    bodyMd: r.body_md,
    url: r.url,
    audience: r.audience === 'author' ? 'author' : 'reviewer',
    createdAt: new Date(r.created_at),
    about: Object.values(about).some((v) => v != null) ? about : null,
  };
}

/**
 * The {@link NotificationAbout} columns for a notification whose
 * `target_type` / `target_id` are in scope, as correlated subqueries for a
 * RETURNING list. Pending edits name the page, drug or paper they target;
 * other targets are read from their own row.
 */
function aboutColumnsSql(targetType: SQL, targetId: SQL): SQL {
  const pe = sql`(SELECT * FROM pending_edits WHERE id = ${targetId})`;
  const title = sql`CASE ${targetType}
    WHEN 'wiki_revision' THEN (
      SELECT p.title FROM wiki_revisions r JOIN wiki_pages p ON p.id = r.page_id
      WHERE r.id = ${targetId})
    WHEN 'learning_unit_revision' THEN (
      SELECT u.title FROM learning_unit_revisions r JOIN learning_units u ON u.id = r.unit_id
      WHERE r.id = ${targetId})
    WHEN 'paper_review' THEN (
      SELECT c.metadata->>'title' FROM paper_reviews pr JOIN citations c ON c.id = pr.citation_id
      WHERE pr.id = ${targetId})
    WHEN 'drug_discussion' THEN (
      SELECT p.title FROM drug_parameter_discussions d JOIN wiki_pages p ON p.id = d.wiki_page_id
      WHERE d.id = ${targetId})
    WHEN 'pending_edit' THEN (
      SELECT CASE
        WHEN e.edit_type IN ('wiki_page', 'wiki_fact', 'wiki_section')
          THEN (SELECT title FROM wiki_pages WHERE id = e.target_id)
        WHEN e.edit_type = 'wiki_new' THEN e.proposed_meta->>'title'
        WHEN e.edit_type = 'learning_unit'
          THEN (SELECT title FROM learning_units WHERE id = e.target_id)
        WHEN e.edit_type = 'paper_review'
          THEN (SELECT metadata->>'title' FROM citations WHERE id = e.target_id)
      END FROM ${pe} e)
  END`;
  const drugNames = sql`CASE ${targetType}
    WHEN 'drug_parameter_revision' THEN (
      SELECT dr.names FROM drug_parameter_revisions r JOIN drugs dr ON dr.id = r.drug_id
      WHERE r.id = ${targetId})
    WHEN 'drug_discussion' THEN (
      SELECT dr.names FROM drug_parameter_discussions d JOIN drugs dr ON dr.id = d.drug_id
      WHERE d.id = ${targetId})
    WHEN 'pending_edit' THEN (
      SELECT dr.names FROM ${pe} e JOIN drugs dr ON dr.id = e.target_id
      WHERE e.edit_type = 'parameter')
  END`;
  const parameter = sql`CASE ${targetType}
    WHEN 'drug_parameter_revision' THEN (
      SELECT parameter FROM drug_parameter_revisions WHERE id = ${targetId})
    WHEN 'drug_discussion' THEN (
      SELECT parameter FROM drug_parameter_discussions WHERE id = ${targetId})
    WHEN 'pending_edit' THEN (SELECT e.parameter FROM ${pe} e WHERE e.edit_type = 'parameter')
  END`;
  const detail = sql`CASE ${targetType}
    WHEN 'wiki_revision' THEN (SELECT edit_summary FROM wiki_revisions WHERE id = ${targetId})
    WHEN 'learning_unit_revision' THEN (
      SELECT edit_summary FROM learning_unit_revisions WHERE id = ${targetId})
    WHEN 'drug_parameter_revision' THEN (
      SELECT edit_summary FROM drug_parameter_revisions WHERE id = ${targetId})
    WHEN 'drug_discussion' THEN (SELECT body FROM drug_parameter_discussions WHERE id = ${targetId})
    WHEN 'pending_edit' THEN (SELECT e.fact_statement FROM ${pe} e)
  END`;
  return sql`${title} AS about_title, ${drugNames} AS about_drug_names,
    ${parameter} AS about_parameter, ${detail} AS about_detail`;
}

/**
 * How long a claimed row stays reserved for the run that claimed it. A run
 * that dies mid-send (a function timeout, a crash) cannot release its claims;
 * once the lease lapses the next run takes them over. Far longer than a run
 * can live, so a live run never loses a claim to the next one.
 */
const CLAIM_LEASE_MS = 15 * 60 * 1000;

/**
 * Lease up to `limit` of a user's unsent rows in the given audiences. A row is
 * claimable when it has not been sent and either nobody holds it or the
 * holder's lease lapsed. `email_handled_at` is written only after the send
 * succeeds ({@link markSent}), so an interrupted run leaves its rows
 * retryable instead of silently marked as done. The cost is at-least-once
 * delivery: a run killed between the provider accepting and `markSent` may
 * see the row sent again once the lease lapses.
 */
async function claimRows(
  userId: number,
  audiences: NotificationAudience[],
  limit: number,
  now: Date,
): Promise<NotificationRowForEmail[]> {
  const leaseLapsedBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
  const claimable = sql`
    email_handled_at IS NULL
    AND (email_claimed_at IS NULL OR email_claimed_at < ${leaseLapsedBefore})
  `;
  const result = await getDb().execute<Parameters<typeof toRow>[0]>(sql`
    UPDATE notifications
    SET email_claimed_at = ${now}
    WHERE id IN (
      SELECT id FROM notifications
      WHERE user_id = ${userId}
        AND ${claimable}
        AND audience IN (${sql.join(audiences.map((a) => sql`${a}`), sql`, `)})
      ORDER BY created_at, id
      LIMIT ${limit}
    )
      AND ${claimable}
    RETURNING id, type, title, body_md, url, audience, created_at,
      ${aboutColumnsSql(sql`notifications.target_type`, sql`notifications.target_id`)}
  `);
  return result.rows
    .map(toRow)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id);
}

/**
 * Split claimed rows into those the recipient may still read and those they
 * may not ({@link unreadableNotificationIds}): a queued email must not
 * deliver what the app itself would now hide, and a notice whose comment,
 * revision or page was deleted is withheld too.
 */
async function splitByReadability(
  rows: NotificationRowForEmail[],
  role: string,
): Promise<{ readable: NotificationRowForEmail[]; withheld: number[] }> {
  const withheld = await unreadableNotificationIds(
    rows.map((r) => r.id),
    role,
  );
  return {
    readable: rows.filter((r) => !withheld.has(r.id)),
    withheld: [...withheld],
  };
}

/** Mark specific rows handled without sending them. */
async function skipRowIds(ids: number[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await getDb().execute(sql`
    UPDATE notifications SET email_handled_at = ${now}, email_claimed_at = NULL
    WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `);
}

/**
 * Mark a user's unsent rows in `audience` handled without sending them: the
 * user opted in but is not (or no longer) allowed to receive that audience.
 */
async function skipRows(
  userId: number,
  audience: NotificationAudience,
  now: Date,
): Promise<void> {
  await getDb().execute(sql`
    UPDATE notifications SET email_handled_at = ${now}
    WHERE user_id = ${userId} AND audience = ${audience}
      AND email_handled_at IS NULL
  `);
}

/** Record rows as sent, after the provider accepted the email. */
async function markSent(ids: number[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await getDb().execute(sql`
    UPDATE notifications SET email_handled_at = ${now}, email_claimed_at = NULL
    WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `);
}

/** Give rows back after a refused send, so the next run retries them. */
async function releaseRows(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await getDb().execute(sql`
    UPDATE notifications SET email_claimed_at = NULL
    WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `);
}

/** Move a user to the back of the delivery order after sending them email. */
async function setLastSentAt(userId: number, at: Date): Promise<void> {
  await getDb().execute(sql`
    UPDATE users SET last_email_sent_at = ${at} WHERE id = ${userId}
  `);
}

/**
 * Lease this period's summary for a user. A conditional UPDATE on a separate
 * claim column: only one of two overlapping runs wins it, so a user never
 * receives the same period twice (or two halves of it). The period itself is
 * recorded done (`last_email_digest_at`) only by {@link finishDigestPeriod},
 * after the summary was sent or deliberately skipped, so a run that dies in
 * between leaves a lease that lapses rather than a period marked done with
 * nothing sent.
 */
async function claimDigestPeriod(
  userId: number,
  periodStart: Date,
  now: Date,
): Promise<boolean> {
  const leaseLapsedBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
  const result = await getDb().execute<{ id: number }>(sql`
    UPDATE users SET email_digest_claimed_at = ${now}
    WHERE id = ${userId}
      AND (last_email_digest_at IS NULL OR last_email_digest_at < ${periodStart})
      AND (email_digest_claimed_at IS NULL OR email_digest_claimed_at < ${leaseLapsedBefore})
    RETURNING id
  `);
  return result.rows.length > 0;
}

/** Record the period done — summary sent, or nothing to send — and drop the lease. */
async function finishDigestPeriod(userId: number, now: Date): Promise<void> {
  await getDb().execute(sql`
    UPDATE users SET last_email_digest_at = ${now}, email_digest_claimed_at = NULL
    WHERE id = ${userId}
  `);
}

/** Drop the lease after a refused send, so the next run retries the period. */
async function releaseDigestPeriod(userId: number): Promise<void> {
  await getDb().execute(sql`
    UPDATE users SET email_digest_claimed_at = NULL WHERE id = ${userId}
  `);
}

async function disputeBacklog(
  now: Date,
): Promise<{ open: number; oldestDays: number }> {
  const result = await getDb().execute<{ open: number; oldest: Date | string | null }>(sql`
    SELECT count(*)::int AS open, min(created_at) AS oldest
    FROM disputes WHERE status = 'open'
  `);
  const row = result.rows[0];
  const oldest = row?.oldest ? new Date(row.oldest) : null;
  return {
    open: row?.open ?? 0,
    oldestDays: oldest
      ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 86_400_000))
      : 0,
  };
}

async function trySend(
  to: string,
  message: { subject: string; html: string; text: string },
): Promise<boolean> {
  try {
    await sendEmail({ to, ...message });
    return true;
  } catch (err) {
    console.error('[notification-emails] send failed:', err);
    return false;
  }
}

/**
 * Wall-clock budget for starting new sends in one run. `sendEmail` may take
 * up to 10 s, so a send started just inside the budget still finishes well
 * within the function's `maxDuration` (vercel.json). Work left over when the
 * budget runs out waits for the next run, the next day, and the users it
 * belongs to go first then (least recently served first).
 */
export const RUN_BUDGET_MS = 40_000;

export async function deliverNotificationEmails(
  appUrl: string,
  now: Date = new Date(),
  opts: { budgetMs?: number; clock?: () => number } = {},
): Promise<Omit<NotificationEmailRunResult, 'escalated'>> {
  const totals = { emailsSent: 0, notificationsEmailed: 0, failed: 0 };
  let backlog: { open: number; oldestDays: number } | undefined;
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? RUN_BUDGET_MS);
  const outOfTime = () => clock() >= deadline;
  await reclassifyTargetAuthorNotices();

  // Reviewer email carries dispute content, so whether a user may receive it
  // is an authorization decision taken NOW, through the fail-closed
  // `callerCan` — not the opt-in they saved while they were a reviewer. A
  // demoted user, or a role an admin raised `dispute.queue.read` above,
  // stops getting queue email at once; an unreadable policy denies every
  // role the matrix could exclude. Computed once per role per run.
  const reviewerAllowed = new Map<string, boolean>();
  const mayReceiveReviewerEmail = async (role: string): Promise<boolean> => {
    let allowed = reviewerAllowed.get(role);
    if (allowed === undefined) {
      allowed = await callerCan(role, CAP['dispute.queue.read']);
      reviewerAllowed.set(role, allowed);
    }
    return allowed;
  };

  for (const user of await optedInRecipients(now)) {
    if (outOfTime()) break;
    const prefs = resolveEmailPrefs(user.settings);
    if (prefs.reviewer && !(await mayReceiveReviewerEmail(user.role))) {
      // Queued queue rows are not sent later either, should access return:
      // they were written for a reviewer this user no longer is.
      await skipRows(user.id, 'reviewer', now);
      prefs.reviewer = false;
    }
    const audiences = enabledAudiences(prefs);
    if (audiences.length === 0) continue;

    if (prefs.frequency === 'immediate') {
      const claimed = await claimRows(user.id, audiences, IMMEDIATE_BATCH, now);
      const { readable: rows, withheld } = await splitByReadability(claimed, user.role);
      await skipRowIds(withheld, now);
      for (const [i, row] of rows.entries()) {
        if (outOfTime()) {
          // Hand the rest back now rather than leaving them leased for
          // fifteen minutes: the next run should find them at once.
          await releaseRows(rows.slice(i).map((r) => r.id));
          break;
        }
        if (await trySend(user.email, buildEventEmail(row, appUrl, prefs.locale))) {
          await markSent([row.id], now);
          totals.emailsSent += 1;
          totals.notificationsEmailed += 1;
        } else {
          totals.failed += 1;
          await releaseRows([row.id]);
        }
      }
      // Rotate the user to the back once they were visited, sent or not: a
      // user whose sends keep failing, or whose claim came back empty, must
      // not stay first and use up every run's budget. Failed rows stay
      // retryable.
      await setLastSentAt(user.id, now);
      continue;
    }

    const frequency = prefs.frequency;
    if (!digestDue(frequency, user.lastDigestAt, now)) continue;
    // Claim the period first; a run that loses the claim leaves it alone.
    if (!(await claimDigestPeriod(user.id, digestPeriodStart(frequency, now), now))) {
      continue;
    }
    const claimed = await claimRows(user.id, audiences, DIGEST_BATCH, now);
    const { readable: rows, withheld } = await splitByReadability(claimed, user.role);
    await skipRowIds(withheld, now);
    if (prefs.reviewer && backlog === undefined) backlog = await disputeBacklog(now);
    // A reviewer's summary also reminds them of disputes still waiting, even
    // in a period with no new event: an unresolved dispute must not drop out
    // of the recurring summary after the one event that announced it.
    const reviewerBacklog = prefs.reviewer && backlog && backlog.open > 0 ? backlog : null;
    if (rows.length === 0 && !reviewerBacklog) {
      // Nothing happened and nothing waits: no email, and the period is done.
      await finishDigestPeriod(user.id, now);
      continue;
    }
    const message = buildSummaryEmail({
      rows,
      frequency,
      appUrl,
      locale: prefs.locale,
      backlog: reviewerBacklog,
    });
    const sent = await trySend(user.email, message);
    if (sent) {
      await markSent(rows.map((r) => r.id), now);
      await finishDigestPeriod(user.id, now);
      totals.emailsSent += 1;
      totals.notificationsEmailed += rows.length;
    } else {
      totals.failed += 1;
      await releaseRows(rows.map((r) => r.id));
      await releaseDigestPeriod(user.id);
    }
    await setLastSentAt(user.id, now);
  }
  return totals;
}

/** One cron run: escalate overdue disputes, then deliver owed email. */
export async function runNotificationEmails(
  appUrl: string,
  now: Date = new Date(),
): Promise<NotificationEmailRunResult> {
  const escalated = await escalateOverdueDisputes(now);
  const delivered = await deliverNotificationEmails(appUrl, now);
  return { escalated, ...delivered };
}
