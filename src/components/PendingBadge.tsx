import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { fetchPendingEditCount } from '@/lib/pendingEditsApi';
import { fetchOpenPdfRequestCount } from '@/lib/referencesApi';
import { fetchInboxCount } from '@/lib/pdfInboxApi';
import { useCan, useCanAnyInGroup } from '@/lib/usePermissions';
import { useTranslation } from 'react-i18next';

const ACTIVE_PENDING_POLL_MS = 30_000;
const IDLE_PENDING_POLL_MS = 120_000;

export function PendingBadge() {
  // Re-poll when the signed-in identity changes, not just its role.
  const userId = useAuthStore((s) => s.user?.id);
  const [count, setCount] = useState<number | null>(null);
  const { t } = useTranslation();
  // This badge is the navigation into the review queue and the PDF-request
  // sub-item it hosts, so it follows the capabilities behind those queues
  // rather than a role rank: reviewers see the global pending count, anyone
  // who can submit something sees their own, and PDF fulfillers see the open
  // requests. Holding none of them means there is nothing here to surface.
  const canReadQueue = useCan('review.queue.readAll');
  const canSubmitSomething = useCanAnyInGroup('contribute');
  const canFulfilPdfs = useCan('citation.pdf.access');
  // A bulk-dropped PDF nobody has linked is a handover that stalled halfway:
  // the bytes are on the premises and the paper still reads as missing full
  // text everywhere else. That is exactly what this badge exists to surface,
  // so it is counted for the people who can end it.
  const canResolveInbox = useCan('pdfInbox.resolve');
  const hasQueue =
    canReadQueue || canSubmitSomething || canFulfilPdfs || canResolveInbox;

  useEffect(() => {
    if (!hasQueue) {
      setCount(null);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    let pollTimer: number | null = null;
    let nextPollDelay = IDLE_PENDING_POLL_MS;
    const hasDocument = typeof document !== 'undefined';
    const canPoll = () => !hasDocument || document.visibilityState !== 'hidden';
    const clearPollTimer = () => {
      if (pollTimer != null) {
        window.clearTimeout(pollTimer);
        pollTimer = null;
      }
    };
    const scheduleNextPoll = () => {
      if (cancelled) return;
      clearPollTimer();
      pollTimer = window.setTimeout(() => {
        pollTimer = null;
        if (canPoll()) {
          load();
        } else {
          scheduleNextPoll();
        }
      }, nextPollDelay);
    };
    const load = () => {
      if (inFlight) return;
      clearPollTimer();
      inFlight = true;
      // The badge sums three "needs attention" queues: pending edits awaiting
      // review, open PDF requests (papers the agent couldn't access, awaiting a
      // human to supply full text), and bulk-dropped PDFs awaiting a link. The
      // pending count is primary — if it fails the badge shows the unknown
      // state; the two PDF counts are best-effort (resolve to 0 on failure) so
      // they can only add, never blank.
      Promise.all([
        fetchPendingEditCount(),
        // Only sum in a queue for callers who can actually act on it: the
        // pages hide the links for everyone else, so counting one would be a
        // notification with nowhere to go.
        canFulfilPdfs ? fetchOpenPdfRequestCount() : Promise.resolve(0),
        canResolveInbox ? fetchInboxCount() : Promise.resolve(0),
      ])
        .then(([pending, pdfCount, inboxCount]) => {
          if (!cancelled) {
            const total = pending.count + pdfCount + inboxCount;
            setCount(total);
            nextPollDelay = total > 0 ? ACTIVE_PENDING_POLL_MS : IDLE_PENDING_POLL_MS;
          }
        })
        .catch(() => {
          if (!cancelled) {
            setCount(null);
            nextPollDelay = IDLE_PENDING_POLL_MS;
          }
        })
        .finally(() => {
          inFlight = false;
          scheduleNextPoll();
        });
    };
    const loadIfVisible = () => {
      if (canPoll()) load();
    };
    load();
    if (hasDocument) {
      document.addEventListener('visibilitychange', loadIfVisible);
    }
    return () => {
      cancelled = true;
      clearPollTimer();
      if (hasDocument) {
        document.removeEventListener('visibilitychange', loadIfVisible);
      }
    };
  }, [hasQueue, canFulfilPdfs, canResolveInbox, userId]);

  if (!hasQueue) return null;

  const label =
    count == null
      ? t('nav.reviewNotificationsUnknown')
      : count > 0
        ? t('nav.reviewNotificationsCount', { count })
        : t('nav.reviewNotifications');

  return (
    <Link
      to="/review"
      className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-white/50 transition-colors hover:bg-white/8 hover:text-white sm:min-h-0 sm:min-w-0"
      aria-label={label}
      title={label}
    >
      {count != null && count > 0 ? (
        <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-destructive px-1 font-mono text-[10px] font-bold tabular-nums leading-none text-destructive-foreground">
          {count}
        </span>
      ) : (
        <span className="h-2.5 w-2.5 rounded-full bg-white/25 ring-1 ring-white/20" />
      )}
    </Link>
  );
}
