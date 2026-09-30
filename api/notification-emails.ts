/**
 * Notification email delivery (#1233).
 *
 *   GET — escalate newly overdue disputes to the admins (in-app), then send
 *         every opted-in user the email they are owed: one per notification,
 *         or their daily / weekly / monthly summary when it is due. See
 *         api/_lib/notificationEmails.ts.
 *
 * Called by the Vercel cron declared in vercel.json (every ten minutes). Vercel
 * sends `Authorization: Bearer <CRON_SECRET>` when the project has a
 * `CRON_SECRET` environment variable, and that header is the only way in:
 * the endpoint fails closed with 503 while the secret is unset, rather than
 * letting anyone on the internet trigger email.
 *
 * Re-running is safe: escalation is claimed once per dispute on
 * `disputes.escalated_at`, and each notification once on
 * `notifications.email_handled_at`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { error, json, noStoreHeaders, withErrorHandling } from './_lib/response.js';
import { runNotificationEmails } from './_lib/notificationEmails.js';

/** Constant-time comparison of the presented bearer token with the secret. */
export function cronAuthorized(
  header: string | string[] | undefined,
  secret: string,
): boolean {
  if (typeof header !== 'string') return false;
  // Hash both sides so the comparison is fixed-length (timingSafeEqual throws
  // on a length mismatch) and leaks nothing about the secret's length.
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    error(res, 405, 'Method not allowed');
    return;
  }
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    error(res, 503, 'CRON_SECRET is not configured', 'cron_secret_unconfigured');
    return;
  }
  if (!cronAuthorized(req.headers.authorization, secret)) {
    error(res, 401, 'Unauthorized', 'cron_unauthorized');
    return;
  }

  const appUrl = process.env.PUBLIC_APP_URL ?? 'https://kinetix.no';
  const result = await runNotificationEmails(appUrl);
  // A refused email is a failed run as far as the cron dashboard is
  // concerned. Its notifications were released and are retried next run.
  json(res, result.failed > 0 ? 502 : 200, result, {
    headers: noStoreHeaders(),
  });
});
