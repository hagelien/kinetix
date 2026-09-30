import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { NAV_ITEM_DEFS, type NavItemId } from '@/lib/navItems';
import {
  fetchHiddenNavItems,
  updateHiddenNavItem,
  NavVisibilityApiError,
  type HiddenNavItemsResponse,
} from '@/lib/navVisibilityApi';
import { useAuthStore } from '@/stores/authStore';

/**
 * Admin → Menu visibility (#1240): which header nav links are hidden from
 * the average user. Hiding a link does not restrict the route — it stays
 * reachable by URL either way — it only removes it from the primary nav for
 * everyone except an admin, who still sees it there, parenthesised.
 *
 * Same invariant as `SiteSettingsAdminSection`: `state` holds
 * server-confirmed data or nothing at all. An optimistic toggle lives in
 * `pending` and only paints its own checkbox while the request is in
 * flight; a failed save re-reads rather than assuming a rollback, since the
 * response can fail after the write already committed.
 */
export function NavVisibilityAdminSection() {
  const { t, i18n } = useTranslation();

  /** Server-confirmed state, or null when nothing authoritative is known. */
  const [state, setState] = useState<HiddenNavItemsResponse | null>(null);
  /** In-flight optimistic toggle. Paints the switch; never stored as truth. */
  const [pending, setPending] = useState<{
    id: NavItemId;
    hidden: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);

  const messageFor = useCallback(
    (err: unknown): string => {
      const code = err instanceof NavVisibilityApiError ? err.code : null;
      if (err instanceof NavVisibilityApiError) {
        console.warn('[nav-visibility]', err.status, err.detail);
      }
      return code
        ? t(`navVisibility.errors.${code}`, {
            defaultValue: t('navVisibility.errors.generic'),
          })
        : t('navVisibility.errors.generic');
    },
    [t],
  );

  /**
   * Every confirmed read lands here, including this component's own state —
   * the header (`Header.tsx`) reads `useAuthStore.hiddenNavItems`, which is
   * otherwise only loaded once at session start, so without this an admin's
   * own save would not parenthesise/un-parenthesise the item they just
   * changed until a full reload (Codex, review comment 4062137158).
   */
  function applyConfirmed(confirmed: HiddenNavItemsResponse) {
    setState(confirmed);
    useAuthStore.setState({ hiddenNavItems: confirmed.hiddenItems });
  }

  const load = useCallback(() => {
    setLoading(true);
    fetchHiddenNavItems()
      .then((next) => {
        applyConfirmed(next);
        setError(null);
        setUnconfirmed(false);
      })
      .catch((err) => {
        setState(null);
        setError(messageFor(err));
      })
      .finally(() => setLoading(false));
  }, [messageFor]);

  useEffect(load, [load]);

  async function toggle(id: NavItemId, hidden: boolean) {
    // One switch saves at a time in this panel (every switch is disabled
    // while `pending` is set); this guard is the safety net for a raw click
    // slipping through that. The server applies each toggle atomically
    // against its own current list (#1316), so a *different* switch saved
    // from another tab or by another manager can no longer be silently
    // discarded by this one's PATCH.
    if (!state || pending) return;
    setPending({ id, hidden });
    setError(null);
    setUnconfirmed(false);
    try {
      const confirmed = await updateHiddenNavItem(id, hidden);
      applyConfirmed(confirmed);
    } catch (err) {
      // The write may have committed even though the response failed, so ask
      // the server what the state actually is rather than assuming a
      // rollback.
      console.warn('[nav-visibility] save response failed; re-reading', err);
      try {
        const confirmed = await fetchHiddenNavItems();
        applyConfirmed(confirmed);
        setError(
          confirmed.hiddenItems.includes(id) === hidden
            ? null
            : t('navVisibility.errors.notApplied'),
        );
      } catch {
        // Genuinely indeterminate. Drop to "nothing authoritative known",
        // which withholds the controls — the optimistic value must not
        // survive as if it were the live policy.
        setState(null);
        setUnconfirmed(true);
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold mb-2">
        {t('navVisibility.title')}
      </h2>
      <p className="text-sm text-muted-foreground mb-4">
        {t('navVisibility.description')}
      </p>

      {error ? (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300 mb-3">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">
          {t('navVisibility.loading')}
        </p>
      ) : !state ? (
        <div className="max-w-2xl">
          <p className="text-sm text-muted-foreground mb-3">
            {unconfirmed
              ? t('navVisibility.errors.unconfirmed')
              : t('navVisibility.errors.unloaded')}
          </p>
          <Button variant="outline" onClick={load}>
            {t('navVisibility.retry')}
          </Button>
        </div>
      ) : (
        <>
          <ul className="space-y-3 max-w-2xl">
            {NAV_ITEM_DEFS.map((item) => {
              const saving = pending?.id === item.id;
              const hidden = saving
                ? pending.hidden
                : state.hiddenItems.includes(item.id);
              const label = t(item.labelKey);
              return (
                <li
                  key={item.id}
                  className="rounded-md border border-border p-3 flex items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{label}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {hidden
                        ? t('navVisibility.hidden')
                        : t('navVisibility.visible')}
                    </p>
                  </div>
                  <Switch
                    checked={hidden}
                    disabled={pending !== null}
                    aria-label={t('navVisibility.toggleLabel', { item: label })}
                    onCheckedChange={(checked) => toggle(item.id, checked)}
                  />
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground mt-3">
            {state.updatedBy
              ? t('navVisibility.changedBy', {
                  who: state.updatedBy.username,
                  when: state.updatedAt
                    ? new Date(state.updatedAt).toLocaleString(i18n.language)
                    : '—',
                })
              : t('navVisibility.neverChanged')}
          </p>
        </>
      )}
    </section>
  );
}
