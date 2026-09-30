/**
 * Notification email delivery, by hand (#1233).
 *
 *   npm run notifications:email
 *
 * Runs what the ten-minute Vercel cron runs (`api/notification-emails.ts`):
 * escalates newly overdue disputes to the admins, then sends every opted-in
 * user the email they are owed. See `api/_lib/notificationEmails.ts`. Safe
 * beside the cron — disputes and notifications are each claimed once.
 *
 * Required env:
 *   DATABASE_URL, RESEND_API_KEY, RESEND_FROM_EMAIL — same as the rest of
 *   the API (see api/_lib/email.ts).
 *
 * Optional env:
 *   PUBLIC_APP_URL — base URL linked from the emails (default https://kinetix.no).
 */
import 'dotenv/config';
import { runNotificationEmails } from '../api/_lib/notificationEmails';
import { fileURLToPath } from 'node:url';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('[send-notification-emails] DATABASE_URL is required');
    process.exit(1);
  }

  const appUrl = process.env.PUBLIC_APP_URL ?? 'https://kinetix.no';
  const { escalated, emailsSent, notificationsEmailed, failed } =
    await runNotificationEmails(appUrl);

  console.error(
    `[send-notification-emails] escalated ${escalated} overdue dispute(s); ` +
      `sent ${emailsSent} email(s) covering ${notificationsEmailed} notification(s).`,
  );
  if (failed > 0) {
    console.error(`[send-notification-emails] ${failed} email(s) failed; they will be retried.`);
    process.exitCode = 1;
  }
}

// Only run the CLI when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined &&
  process.argv[1] === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[send-notification-emails] error:', err);
    process.exit(1);
  });
}
