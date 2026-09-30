/**
 * Moderator queue for open disputes (#1233).
 *
 * Before this existed there was no completion path for an open dispute
 * beyond its own /review card: nothing surfaced the whole backlog, so an
 * objection with no author-visible edit (or one nobody happened to open)
 * could sit open indefinitely with no moderator ever seeing it. This reads
 * the same deterministic, oldest-first feed agents poll
 * (`GET /api/disputes` with no `targetType`/`targetId`) and renders it for a
 * human moderator, gated the same way the endpoint itself gates the global
 * read: `dispute.queue.read` (editor+ by default, or an active agent).
 *
 * The age tier is computed from `createdAt` at render time
 * (`disputeAgeTier`; see src/lib/disputeAge.ts for the thresholds). The one
 * aging fact stored on the record is `escalatedAt`, set when the scheduled
 * notification job escalated an overdue dispute to the admins
 * (api/_lib/notificationEmails.ts).
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { UserBadge } from '@/components/ui/UserBadge';
import { useCan } from '@/lib/usePermissions';
import { useAuthStore } from '@/stores/authStore';
import {
  disputeTargetHref,
  fetchOpenDisputes,
  resolveDispute,
  type DisputeResolution,
  type DisputeRow,
} from '@/lib/disputesApi';
import { disputeAgeTier, type DisputeAgeTier } from '@/lib/disputeAge';

const PAGE_SIZE = 50;
const REASON_EXCERPT_LENGTH = 160;

function excerpt(md: string): string {
  const trimmed = md.trim();
  if (trimmed.length <= REASON_EXCERPT_LENGTH) return trimmed;
  return `${trimmed.slice(0, REASON_EXCERPT_LENGTH).trimEnd()}…`;
}

const AGE_BADGE_VARIANT: Record<
  DisputeAgeTier,
  'muted' | 'info' | 'destructive'
> = {
  fresh: 'muted',
  aging: 'info',
  overdue: 'destructive',
};

function AgeBadge({
  createdAt,
  escalatedAt,
}: {
  createdAt: string;
  escalatedAt?: string | null;
}) {
  const { t } = useTranslation();
  const tier = disputeAgeTier(createdAt);
  if (escalatedAt) {
    return (
      <Badge variant="destructive" className="whitespace-nowrap">
        {t('admin.disputesQueue.ageEscalated', { defaultValue: 'Escalated' })}
      </Badge>
    );
  }
  const label: Record<DisputeAgeTier, string> = {
    fresh: t('admin.disputesQueue.ageFresh', { defaultValue: 'Fresh' }),
    aging: t('admin.disputesQueue.ageAging', { defaultValue: 'Aging' }),
    overdue: t('admin.disputesQueue.ageOverdue', { defaultValue: 'Overdue' }),
  };
  return (
    <Badge variant={AGE_BADGE_VARIANT[tier]} className="whitespace-nowrap">
      {label[tier]}
    </Badge>
  );
}

export function DisputesAdminSection() {
  const { t } = useTranslation();
  const canResolve = useCan('dispute.resolve');
  const userId = useAuthStore((s) => s.user?.id);
  const [rows, setRows] = useState<DisputeRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const loadFirstPage = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchOpenDisputes({ limit: PAGE_SIZE, offset: 0 })
      .then((data) => {
        setRows(data.disputes);
        setOffset(data.disputes.length);
        setHasMore(data.disputes.length === PAGE_SIZE);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage]);

  async function loadMore() {
    setLoadingMore(true);
    setError(null);
    try {
      const data = await fetchOpenDisputes({ limit: PAGE_SIZE, offset });
      // The feed is oldest-first and stable, so appending is safe even if
      // the backlog changed between pages — a shifted item just repeats or
      // is skipped on the next load rather than corrupting order.
      setRows((prev) => [...prev, ...data.disputes]);
      setOffset((prev) => prev + data.disputes.length);
      setHasMore(data.disputes.length === PAGE_SIZE);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }

  // Every target type resolves through the same dispute id, not the target
  // (`PATCH /api/disputes?id=`), so this one handler closes a dispute against
  // any target — wiki revisions, parameter revisions, discussions, paper
  // reviews and pending edits alike, matching the resolution vocabulary and
  // optimistic-removal pattern `DisputePanel` already uses on /review.
  async function handleResolve(id: number, resolution: DisputeResolution) {
    setResolvingId(id);
    setResolveError(null);
    try {
      const result = await resolveDispute(id, resolution);
      // Upholding normally returns the contested proposal to its author in the
      // same act. When the server could not — it was decided or revised since,
      // or this caller may not make that particular return — the row still
      // leaves this queue, so without saying so the proposal would sit pending
      // with nobody told: the stranded edit the whole feature exists to
      // prevent, reintroduced from the one screen that never loads the target.
      if (result.pendingEditReturned === false) {
        setResolveError(
          t('review.dispute.upheldReturnSkipped', {
            defaultValue:
              'The dispute was upheld, but the proposal was not returned automatically. Check it and give it a disposition.',
          }),
        );
      }
      setRows((prev) => prev.filter((r) => r.id !== id));
      // `offset` tracks how many items this queue has already pulled from the
      // server list, so `loadMore` knows where to resume. Removing a loaded
      // row locally shortens that server list by one underneath it; without
      // this, the next "load more" keeps the stale offset and skips whatever
      // row now sits at that position (see #1299 review thread).
      setOffset((prev) => prev - 1);
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err));
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold mb-2">
        {t('admin.disputesQueue.heading', { defaultValue: 'Open disputes' })}
      </h2>
      <p className="text-sm text-muted-foreground mb-4">
        {t('admin.disputesQueue.description', {
          defaultValue:
            'Every currently open dispute, oldest first — the same backlog the dispute feed exposes to agents.',
        })}
      </p>

      {error ? (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300 mb-3">
          {error}
        </div>
      ) : null}

      {resolveError ? (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300 mb-3">
          {resolveError}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">
          {t('admin.disputesQueue.loading', {
            defaultValue: 'Loading open disputes…',
          })}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('admin.disputesQueue.empty', {
            defaultValue: 'No open disputes. The queue is clear.',
          })}
        </p>
      ) : (
        <>
          <div className="border border-border rounded-lg overflow-hidden overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">
                    {t('admin.disputesQueue.age', { defaultValue: 'Age' })}
                  </th>
                  <th className="text-left px-4 py-3 font-medium">
                    {t('admin.disputesQueue.target', { defaultValue: 'Target' })}
                  </th>
                  <th className="text-left px-4 py-3 font-medium">
                    {t('admin.disputesQueue.source', { defaultValue: 'Source' })}
                  </th>
                  <th className="text-left px-4 py-3 font-medium">
                    {t('admin.disputesQueue.reason', { defaultValue: 'Reason' })}
                  </th>
                  <th className="text-left px-4 py-3 font-medium">
                    {t('admin.disputesQueue.author', { defaultValue: 'Raised by' })}
                  </th>
                  {canResolve ? (
                    <th className="text-left px-4 py-3 font-medium">
                      {t('admin.disputesQueue.actions', {
                        defaultValue: 'Actions',
                      })}
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const href = disputeTargetHref(row);
                  const targetLabel = `${row.targetType} #${row.targetId}`;
                  return (
                    <tr key={row.id} className="border-t border-border align-top">
                      <td className="px-4 py-3 whitespace-nowrap">
                        <AgeBadge createdAt={row.createdAt} escalatedAt={row.escalatedAt} />
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {new Date(row.createdAt).toLocaleString()}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {href ? (
                          <a href={href} className="font-mono text-xs underline">
                            {targetLabel}
                          </a>
                        ) : (
                          <span className="font-mono text-xs">{targetLabel}</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {t(
                          row.source === 'agent'
                            ? 'admin.disputesQueue.sourceAgent'
                            : 'admin.disputesQueue.sourceHuman',
                          { defaultValue: row.source },
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground max-w-md">
                        {excerpt(row.reasonMd) ||
                          t('review.dispute.noReason', {
                            defaultValue: '(no reason supplied)',
                          })}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {row.author ? (
                          <UserBadge
                            user={{
                              displayName: row.author.name,
                              // The feed doesn't expose a username, only the
                              // agent slug — pass it as the fallback label so
                              // an agent (or a human row missing a display
                              // name) doesn't render as "Unknown".
                              username: row.author.agentSlug,
                              role: row.author.role,
                              isAgent: row.source === 'agent',
                            }}
                          />
                        ) : (
                          t('admin.disputesQueue.unknownAuthor', {
                            defaultValue: 'Unknown author',
                          })
                        )}
                      </td>
                      {canResolve ? (
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={resolvingId !== null}
                              onClick={() => void handleResolve(row.id, 'upheld')}
                              title={t('review.dispute.upheldHint')}
                            >
                              {t('review.dispute.uphold')}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={resolvingId !== null}
                              onClick={() =>
                                void handleResolve(row.id, 'rejected')
                              }
                              title={t('review.dispute.overruleHint')}
                            >
                              {t('review.dispute.overrule')}
                            </Button>
                            {userId === row.createdBy ? (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={resolvingId !== null}
                                onClick={() =>
                                  void handleResolve(row.id, 'withdrawn')
                                }
                              >
                                {t('review.dispute.withdraw')}
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {hasMore ? (
            <div className="mt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {t('admin.disputesQueue.loadMore', { defaultValue: 'Load more' })}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
