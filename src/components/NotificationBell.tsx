import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/authStore';
import {
  fetchNotifications,
  fetchUnreadNotificationCount,
  markNotificationsRead,
  type NotificationRow,
} from '@/lib/notificationsApi';

const ACTIVE_POLL_MS = 30_000;
const IDLE_POLL_MS = 120_000;

/**
 * Header bell for the in-app inbox (`/api/notifications`). Polls the unread
 * count while signed in; opening the panel loads the newest rows. Clicking a
 * row marks it read and follows its `url`; "mark all read" clears the badge.
 *
 * Rows are minted server-side on dispute events, so anyone who reviews or
 * authors edits can accrue them — this is the only surface that reads them.
 */

/** Contribution-feedback notification types → their localized title key. */
const FEEDBACK_TITLE_KEYS: Record<string, string> = {
  edit_approved: 'notifications.types.editApproved',
  edit_rejected: 'notifications.types.editRejected',
  edit_returned: 'notifications.types.editReturned',
  comment_reply: 'notifications.types.commentReply',
  comment_on_contribution: 'notifications.types.commentOnContribution',
  contribution_endorsed: 'notifications.types.contributionEndorsed',
};
export function NotificationBell() {
  const userId = useAuthStore((s) => s.user?.id);
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [unread, setUnread] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  // Monotonic token so a superseded inbox GET can't clobber newer state: an
  // optimistic mark-read (which bumps it) invalidates any load still in flight,
  // and only the latest load applies its result.
  const loadSeqRef = useRef(0);

  // Poll just the unread count for the badge. Visibility-aware and identity-
  // keyed, mirroring PendingBadge so a backgrounded tab doesn't hammer the API.
  useEffect(() => {
    // Identity changed (e.g. re-login as another account without unmounting the
    // header): drop the previous account's inbox, close the panel, and
    // invalidate any list load still in flight so its rows can't populate under
    // the new identity.
    loadSeqRef.current++;
    setItems(null);
    setLoadError(false);
    setOpen(false);
    if (userId == null) {
      setUnread(null);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    let delay = IDLE_POLL_MS;
    let inFlight = false;
    const hasDocument = typeof document !== 'undefined';
    const canPoll = () => !hasDocument || document.visibilityState !== 'hidden';
    const clear = () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };
    const schedule = () => {
      if (cancelled) return;
      clear();
      timer = window.setTimeout(() => {
        timer = null;
        if (canPoll()) load();
        else schedule();
      }, delay);
    };
    const load = () => {
      // Serialize polls: a visibilitychange-triggered load must not overlap a
      // scheduled one, or two responses could resolve out of order and leave a
      // stale count. Only one count request is ever in flight (as PendingBadge
      // does); a call while busy is dropped and the running one reschedules.
      if (inFlight) return;
      inFlight = true;
      // Capture the generation so a count that was read before an optimistic
      // mark-read (which bumps loadSeqRef) can't resolve afterward and restore
      // the stale unread badge. Scheduling still continues regardless.
      const seq = loadSeqRef.current;
      const fresh = () => !cancelled && seq === loadSeqRef.current;
      fetchUnreadNotificationCount()
        .then((count) => {
          if (!fresh()) return;
          setUnread(count);
          delay = count > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS;
        })
        .catch(() => {
          if (fresh()) setUnread(null);
        })
        .finally(() => {
          inFlight = false;
          if (!cancelled) schedule();
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
      clear();
      if (hasDocument) {
        document.removeEventListener('visibilitychange', loadIfVisible);
      }
    };
  }, [userId]);

  // Re-sync just the badge from the server. Used to reconcile after an
  // optimistic mark-read write fails, so the panel and badge never drift from
  // the truth until the next scheduled poll.
  const refreshUnread = useCallback(() => {
    const seq = loadSeqRef.current;
    fetchUnreadNotificationCount()
      .then((count) => {
        if (seq === loadSeqRef.current) setUnread(count);
      })
      .catch(() => {});
  }, []);

  const loadItems = useCallback(() => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setLoadError(false);
    fetchNotifications({ limit: 50 })
      .then((res) => {
        if (seq !== loadSeqRef.current) return; // superseded by a newer action
        setItems(res.notifications);
        setUnread(res.unreadCount);
      })
      // A failed load must not masquerade as an empty inbox — surface an
      // explicit error + retry instead of rendering "No notifications".
      .catch(() => {
        if (seq === loadSeqRef.current) setLoadError(true);
      })
      .finally(() => {
        if (seq === loadSeqRef.current) setLoading(false);
      });
  }, []);

  // Open the panel: load the list, and close on outside-click or Escape.
  useEffect(() => {
    if (!open) return;
    loadItems();
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, loadItems]);

  const handleRowClick = useCallback(
    (row: NotificationRow) => {
      setOpen(false);
      if (row.readAt == null) {
        // Invalidate any in-flight load so it can't restore this row as unread.
        loadSeqRef.current++;
        setItems((prev) =>
          prev
            ? prev.map((n) =>
                n.id === row.id ? { ...n, readAt: new Date().toISOString() } : n,
              )
            : prev,
        );
        setUnread((prev) => (prev != null && prev > 0 ? prev - 1 : prev));
        // If the write fails, the optimistic decrement is wrong — re-sync the
        // badge from the server rather than leaving it low.
        void markNotificationsRead({ ids: [row.id] }).catch(() => refreshUnread());
      }
      if (row.url) navigate(row.url);
    },
    [navigate, refreshUnread],
  );

  const handleMarkAllRead = useCallback(() => {
    // Invalidate any load already in flight so its stale rows can't restore the
    // unread state after this optimistic clear.
    loadSeqRef.current++;
    setItems((prev) =>
      prev
        ? prev.map((n) =>
            n.readAt == null ? { ...n, readAt: new Date().toISOString() } : n,
          )
        : prev,
    );
    setUnread(0);
    // Reconcile with authoritative state once the write settles — on success
    // this also picks up any unread rows beyond the loaded page; on failure it
    // undoes the optimistic clear the panel is now contradicting.
    void markNotificationsRead({ all: true }).finally(() => loadItems());
  }, [loadItems]);

  // Titles are minted server-side in fixed English (dispute_*, edit_*,
  // comment_*, contribution_endorsed). Localise them at the React boundary, falling back to the
  // raw title for any future type. The user-authored `bodyMd` is left as
  // written.
  //
  // A resolved dispute's title is `Dispute ${resolution}` with a stable outcome
  // token (upheld/rejected/withdrawn); recover it so the outcome survives
  // localisation instead of collapsing to one generic sentence. If the wording
  // ever changes the token won't match and we fall back to the server title.
  const titleFor = (row: NotificationRow): string => {
    if (row.type === 'dispute_opened') {
      return t('notifications.types.disputeOpened');
    }
    if (row.type === 'dispute_escalated') {
      return t('notifications.types.disputeEscalated');
    }
    const feedbackKey = FEEDBACK_TITLE_KEYS[row.type];
    if (feedbackKey) return t(feedbackKey);
    if (row.type === 'dispute_resolved') {
      const outcome = row.title.trim().split(/\s+/).pop()?.toLowerCase();
      if (outcome === 'upheld') return t('notifications.types.disputeUpheld');
      if (outcome === 'rejected') return t('notifications.types.disputeRejected');
      if (outcome === 'withdrawn')
        return t('notifications.types.disputeWithdrawn');
      return row.title;
    }
    return row.title;
  };

  if (userId == null) return null;

  const hasUnread = unread != null && unread > 0;
  const label = hasUnread
    ? t('nav.notificationsUnread', { count: unread })
    : t('nav.notifications');

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        className="relative inline-flex min-h-9 min-w-9 items-center justify-center rounded-md text-white/50 transition-colors hover:bg-white/8 hover:text-white sm:min-h-0 sm:min-w-0"
      >
        <Bell className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
        {hasUnread && (
          <span className="absolute -right-0.5 -top-0.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-destructive px-1 font-mono text-[9px] font-bold tabular-nums leading-none text-destructive-foreground">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={t('nav.notifications')}
          className="absolute right-0 top-full z-20 mt-1 w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span className="text-sm font-semibold">
              {t('nav.notifications')}
            </span>
            {/* Based on the global unread count, not just loaded rows: with
                >50 notifications the newest page can be all-read while older
                unread rows remain, and mark-all ({all:true}) clears them too. */}
            {hasUnread && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {t('notifications.markAllRead')}
              </button>
            )}
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {loadError ? (
              <div className="flex flex-col items-center gap-2 px-3 py-6 text-center">
                <p className="text-sm text-muted-foreground">
                  {t('notifications.loadError')}
                </p>
                <button
                  type="button"
                  onClick={loadItems}
                  className="text-xs font-medium text-foreground underline-offset-2 transition-colors hover:underline"
                >
                  {t('notifications.retry')}
                </button>
              </div>
            ) : loading && items == null ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t('notifications.loading')}
              </p>
            ) : !items || items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t('notifications.empty')}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {items.map((row) => {
                  const unreadRow = row.readAt == null;
                  const interactive = Boolean(row.url);
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => handleRowClick(row)}
                        disabled={!interactive && !unreadRow}
                        className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors ${
                          interactive || unreadRow
                            ? 'hover:bg-accent'
                            : 'cursor-default'
                        } ${unreadRow ? 'bg-accent/40' : ''}`}
                      >
                        <span className="flex w-full items-start gap-2">
                          {unreadRow && (
                            <span
                              aria-hidden
                              className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive"
                            />
                          )}
                          <span
                            className={`text-sm ${unreadRow ? 'font-semibold' : 'font-medium'}`}
                          >
                            {titleFor(row)}
                          </span>
                        </span>
                        {row.bodyMd && (
                          <span className="line-clamp-2 text-xs text-muted-foreground">
                            {row.bodyMd}
                          </span>
                        )}
                        <span className="text-[11px] text-muted-foreground">
                          {new Date(row.createdAt).toLocaleString(i18n.language)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
