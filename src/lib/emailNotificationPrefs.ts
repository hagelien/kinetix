/**
 * Email notification preferences (#1233 follow-up).
 *
 * Email is strictly opt-in: every category is off until the user turns it on
 * in /preferences. Two categories, matching the two audiences a notification
 * row is written for (`notifications.audience`):
 *
 *   - `emailOnFeedback` — feedback on the user's OWN contributions: a review
 *     decision on an edit they submitted, a dispute raised against or resolved
 *     on something they wrote, a comment on a parameter or fact they
 *     contributed, a reply to their comment, an approval stamp.
 *   - `emailAsReviewer` — the review queue: disputes on other people's
 *     content, and overdue disputes escalated to admins.
 *
 * `emailFrequency` decides the shape of delivery: one email per event, or the
 * events collected into one daily / weekly / monthly summary.
 *
 * Stored in `users.notification_settings` (jsonb). Pure and framework-free so
 * the preferences page and the server delivery job read it identically.
 */

export const EMAIL_FREQUENCIES = ['immediate', 'daily', 'weekly', 'monthly'] as const;
export type EmailFrequency = (typeof EMAIL_FREQUENCIES)[number];

/**
 * The frequencies the preferences page offers. `immediate` is left out: email
 * is sent by one run a day, so "one email per event, as it happens" would not
 * be true. A stored `immediate` is still read and honoured by that daily run.
 */
export const SELECTABLE_EMAIL_FREQUENCIES: readonly EmailFrequency[] = [
  'daily',
  'weekly',
  'monthly',
];

export const EMAIL_LOCALES = ['nb', 'en'] as const;
export type EmailLocale = (typeof EMAIL_LOCALES)[number];

export type NotificationAudience = 'author' | 'reviewer';

/** The jsonb shape. Every key optional: absent means the default. */
export interface NotificationSettings {
  emailOnFeedback?: boolean;
  emailAsReviewer?: boolean;
  emailFrequency?: EmailFrequency;
  /** Language the emails are written in; the UI language when last saved. */
  emailLocale?: EmailLocale;
  /**
   * Legacy toggle from before email delivery existed ("email me when a
   * pending edit I submitted is reviewed"). Read as `emailOnFeedback` when
   * that key is absent, so a user who ticked it keeps what they asked for.
   */
  emailWhenPendingEditReviewed?: boolean;
}

export interface ResolvedEmailPrefs {
  feedback: boolean;
  reviewer: boolean;
  frequency: EmailFrequency;
  locale: EmailLocale;
}

export const DEFAULT_EMAIL_FREQUENCY: EmailFrequency = 'daily';
export const DEFAULT_EMAIL_LOCALE: EmailLocale = 'nb';

export function resolveEmailPrefs(
  settings: NotificationSettings | null | undefined,
): ResolvedEmailPrefs {
  const s = settings ?? {};
  return {
    feedback: s.emailOnFeedback ?? s.emailWhenPendingEditReviewed ?? false,
    reviewer: s.emailAsReviewer ?? false,
    frequency: EMAIL_FREQUENCIES.includes(s.emailFrequency as EmailFrequency)
      ? (s.emailFrequency as EmailFrequency)
      : DEFAULT_EMAIL_FREQUENCY,
    locale: EMAIL_LOCALES.includes(s.emailLocale as EmailLocale)
      ? (s.emailLocale as EmailLocale)
      : DEFAULT_EMAIL_LOCALE,
  };
}

/** The audiences a user has opted in to. */
export function enabledAudiences(prefs: ResolvedEmailPrefs): NotificationAudience[] {
  const out: NotificationAudience[] = [];
  if (prefs.feedback) out.push('author');
  if (prefs.reviewer) out.push('reviewer');
  return out;
}

/**
 * Summary periods start at the daily 05:00 Europe/Oslo run — 03:00 UTC in
 * summer, 04:00 UTC in winter (`vercel.json` fires at both hours; the period
 * claim lets only the one at 05:00 Oslo send). A fixed UTC hour would sit an
 * hour before the winter run, so a change made in that hour would be read as
 * "already sent this period" and postpone the first summary by a day: daily
 * every day, weekly on Mondays, monthly on the 1st.
 */
export const DIGEST_TIME_ZONE = 'Europe/Oslo';
export const DIGEST_HOUR_LOCAL = 5;

const osloFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: DIGEST_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});

function osloParts(at: Date) {
  const get: Record<string, number> = {};
  for (const p of osloFormat.formatToParts(at)) {
    if (p.type !== 'literal') get[p.type] = Number(p.value);
  }
  const n = (k: string) => get[k] ?? 0;
  return {
    year: n('year'),
    month: n('month'),
    day: n('day'),
    hour: n('hour'),
    minute: n('minute'),
    second: n('second'),
  };
}

function osloCalendar(at: Date): { y: number; m: number; d: number } {
  const p = osloParts(at);
  return { y: p.year, m: p.month - 1, d: p.day };
}

/** The instant of 05:00 Oslo on the given Oslo calendar day (day may over/underflow). */
function digestSlot(y: number, m: number, d: number): Date {
  const day = new Date(Date.UTC(y, m, d));
  // DST changes happen at 01:00 UTC, so the offset at 03:00 UTC that day is
  // the one in force at 05:00 Oslo.
  const probe = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 3);
  const p = osloParts(new Date(probe));
  const offsetMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - probe;
  return new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), DIGEST_HOUR_LOCAL) -
      offsetMs,
  );
}

/**
 * Start of the summary period `now` falls in — the most recent send slot at
 * or before `now`. A summary is due when the last one went out before it.
 */
export function digestPeriodStart(frequency: Exclude<EmailFrequency, 'immediate'>, now: Date): Date {
  const { y, m, d } = osloCalendar(now);
  if (frequency === 'monthly') {
    const slot = digestSlot(y, m, 1);
    return slot > now ? digestSlot(y, m - 1, 1) : slot;
  }
  // Calendar day of the most recent slot at or before `now`.
  const today = digestSlot(y, m, d);
  const day = new Date(Date.UTC(y, m, d - (today > now ? 1 : 0)));
  if (frequency === 'weekly') {
    // getUTCDay on the calendar date: 0 = Sunday … 1 = Monday.
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  }
  return digestSlot(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

/**
 * Whether a summary is due now. `lastSentAt` is null only for a user who has
 * never been sent one and has no baseline; the preferences endpoint sets a
 * baseline when email is switched on, so a new subscriber's first summary
 * waits for the next send slot instead of arriving minutes after opting in.
 */
export function digestDue(
  frequency: Exclude<EmailFrequency, 'immediate'>,
  lastSentAt: Date | null,
  now: Date,
): boolean {
  if (!lastSentAt) return true;
  return lastSentAt < digestPeriodStart(frequency, now);
}
