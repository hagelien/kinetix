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
 * Summaries go out at 06:00 UTC (07:00/08:00 in Norway): daily every day,
 * weekly on Mondays, monthly on the 1st.
 */
export const DIGEST_HOUR_UTC = 6;

/**
 * Start of the summary period `now` falls in — the most recent send slot at
 * or before `now`. A summary is due when the last one went out before it.
 */
export function digestPeriodStart(frequency: Exclude<EmailFrequency, 'immediate'>, now: Date): Date {
  const slot = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), DIGEST_HOUR_UTC),
  );
  if (frequency === 'monthly') {
    slot.setUTCDate(1);
    if (slot > now) slot.setUTCMonth(slot.getUTCMonth() - 1);
    return slot;
  }
  if (slot > now) slot.setUTCDate(slot.getUTCDate() - 1);
  if (frequency === 'weekly') {
    // getUTCDay: 0 = Sunday … 1 = Monday.
    const sinceMonday = (slot.getUTCDay() + 6) % 7;
    slot.setUTCDate(slot.getUTCDate() - sinceMonday);
  }
  return slot;
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
