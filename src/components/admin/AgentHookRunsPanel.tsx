/**
 * Admin panel listing recent agent-hook fire attempts (#345).
 *
 * Read-only window onto `agent_hook_runs`. Surfaces routine outages
 * (failed) and misconfigured deploys (skipped) without scraping
 * serverless logs. Filters are simple — outcome + event — and pull
 * fresh data via the `/api/admin?resource=agent-hook-runs` endpoint
 * on user action.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  fetchAgentHookRuns,
  type AgentHookRun,
  type HookRunOutcome,
} from '@/lib/agentsApi';

const OUTCOMES: ReadonlyArray<HookRunOutcome | 'all'> = [
  'all',
  'success',
  'failed',
  'skipped',
];
const PAGE_SIZE = 10;

export function AgentHookRunsPanel(): JSX.Element {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<AgentHookRun[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<HookRunOutcome | 'all'>('all');
  const [page, setPage] = useState(1);

  // i18n: bind the enum values to localized labels so Norwegian
  // sessions don't see raw English in the filter dropdown, the
  // outcome badge, or the event / target columns. Unknown values
  // fall back to the raw key so a newly-introduced event still
  // renders (just untranslated) instead of disappearing.
  const outcomeOptionLabel: Record<HookRunOutcome | 'all', string> = {
    all: t('admin.hookRuns.outcomeAll', { defaultValue: 'All' }) as string,
    success: t('admin.hookRuns.outcomeSuccess', {
      defaultValue: 'Success',
    }) as string,
    failed: t('admin.hookRuns.outcomeFailed', {
      defaultValue: 'Failed',
    }) as string,
    skipped: t('admin.hookRuns.outcomeSkipped', {
      defaultValue: 'Skipped',
    }) as string,
  };
  const eventLabel = (key: string): string => {
    const localized = t(`admin.hookRuns.events.${key}`, {
      defaultValue: '',
    }) as string;
    return localized || key;
  };
  const targetTypeLabel = (key: string): string => {
    const localized = t(`admin.hookRuns.targets.${key}`, {
      defaultValue: '',
    }) as string;
    return localized || key;
  };

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAgentHookRuns({
        outcome: outcome === 'all' ? undefined : outcome,
        limit: 100,
      });
      setRuns(data.runs);
      setPage(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // Filter dependency intentional: re-fetch on outcome change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome]);

  const totalRuns = runs?.length ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalRuns / PAGE_SIZE));
  const activePage = Math.min(page, pageCount);
  const firstVisibleIndex = (activePage - 1) * PAGE_SIZE;
  const visibleRuns = runs?.slice(
    firstVisibleIndex,
    firstVisibleIndex + PAGE_SIZE,
  );
  const firstVisibleRun = totalRuns === 0 ? 0 : firstVisibleIndex + 1;
  const lastVisibleRun = Math.min(firstVisibleIndex + PAGE_SIZE, totalRuns);

  return (
    <section className="mb-10">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">
          {t('admin.hookRuns.heading', { defaultValue: 'Agent hook runs' })}
        </h2>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground">
            {t('admin.hookRuns.outcomeLabel', { defaultValue: 'Outcome' })}
          </label>
          <select
            value={outcome}
            onChange={(e) =>
              setOutcome(e.target.value as HookRunOutcome | 'all')
            }
            className="rounded-md border border-input bg-background px-2 py-1 text-xs"
          >
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {outcomeOptionLabel[o]}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t('admin.hookRuns.refresh', { defaultValue: 'Refresh' })}
          </Button>
        </div>
      </div>

      {loading && !runs ? (
        <p className="text-sm text-muted-foreground">
          {t('admin.hookRuns.loading', { defaultValue: 'Loading…' })}
        </p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : runs && runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('admin.hookRuns.empty', { defaultValue: 'No hook runs yet.' })}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 text-left">
                    {t('admin.hookRuns.when', { defaultValue: 'When' })}
                  </th>
                  <th className="px-2 py-1 text-left">
                    {t('admin.hookRuns.event', { defaultValue: 'Event' })}
                  </th>
                  <th className="px-2 py-1 text-left">
                    {t('admin.hookRuns.target', { defaultValue: 'Target' })}
                  </th>
                  <th className="px-2 py-1 text-left">
                    {t('admin.hookRuns.outcome', { defaultValue: 'Outcome' })}
                  </th>
                  <th className="px-2 py-1 text-left">HTTP</th>
                  <th className="px-2 py-1 text-left">
                    {t('admin.hookRuns.duration', { defaultValue: 'Duration' })}
                  </th>
                  <th className="px-2 py-1 text-left">
                    {t('admin.hookRuns.errorExcerpt', {
                      defaultValue: 'Error',
                    })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRuns?.map((r) => (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="px-2 py-1 font-mono whitespace-nowrap">
                      {new Date(r.createdAt).toLocaleString()}
                    </td>
                    <td className="px-2 py-1">{eventLabel(r.event)}</td>
                    <td className="px-2 py-1">
                      {r.targetType
                        ? `${targetTypeLabel(r.targetType)} #${r.targetId ?? '?'}`
                        : '—'}
                    </td>
                    <td className="px-2 py-1">
                      <OutcomeBadge outcome={r.outcome} />
                    </td>
                    <td className="px-2 py-1 font-mono">
                      {r.httpStatus ?? '—'}
                    </td>
                    <td className="px-2 py-1 font-mono">
                      {r.durationMs != null ? `${r.durationMs}ms` : '—'}
                    </td>
                    <td className="px-2 py-1 text-destructive">
                      {r.errorMessage ?? ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalRuns > PAGE_SIZE ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {t('admin.hookRuns.rangeStatus', {
                  defaultValue: 'Showing {{from}}–{{to}} of {{total}}',
                  from: firstVisibleRun,
                  to: lastVisibleRun,
                  total: totalRuns,
                })}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={activePage === 1}
                >
                  {t('admin.hookRuns.previous', { defaultValue: 'Previous' })}
                </Button>
                <span>
                  {t('admin.hookRuns.pageStatus', {
                    defaultValue: 'Page {{page}} of {{pages}}',
                    page: activePage,
                    pages: pageCount,
                  })}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setPage((current) => Math.min(pageCount, current + 1))
                  }
                  disabled={activePage === pageCount}
                >
                  {t('admin.hookRuns.next', { defaultValue: 'Next' })}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function OutcomeBadge({ outcome }: { outcome: HookRunOutcome }): JSX.Element {
  const { t } = useTranslation();
  const cls =
    outcome === 'success'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
      : outcome === 'failed'
        ? 'border-destructive/40 bg-destructive/10 text-destructive'
        : 'border-border bg-muted text-muted-foreground';
  const label: Record<HookRunOutcome, string> = {
    success: t('admin.hookRuns.outcomeSuccess', {
      defaultValue: 'Success',
    }) as string,
    failed: t('admin.hookRuns.outcomeFailed', {
      defaultValue: 'Failed',
    }) as string,
    skipped: t('admin.hookRuns.outcomeSkipped', {
      defaultValue: 'Skipped',
    }) as string,
  };
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${cls}`}
    >
      {label[outcome]}
    </span>
  );
}
