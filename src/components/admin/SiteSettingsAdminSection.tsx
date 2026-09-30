import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  SITE_SETTING_LIST,
  type SiteSettingId,
  type SiteSettings,
} from '@/lib/siteSettings';
import {
  fetchSiteSettings,
  SiteSettingsApiError,
  updateSiteSettings,
  type SiteSettingRow,
} from '@/lib/siteSettingsApi';

/** Translation keys cannot hold dots, mirroring `admin_users_manage`. */
function keyOf(id: string): string {
  return id.replace(/\./g, '_');
}

/**
 * Admin → Settings: the runtime policy switches.
 *
 * The rows are driven by the client's own registry rather than by the server
 * response, so a switch this build knows about is always listed even if the
 * server is a version behind. Server provenance (who changed it, when) is
 * merged in by id.
 *
 * **One invariant governs this component: `settings` holds server-confirmed
 * state or nothing at all.** Every wrong-state bug this panel can have is the
 * same bug — rendering a value we do not actually know as though we did, with
 * the gate shown on while it is really off. So an optimistic value never enters
 * `settings`; it lives in `pending` and only paints the switch while its
 * request is in flight. When a save settles we either replace `settings` with
 * what the server confirmed, or drop it to null — and null withholds the
 * controls entirely rather than falling back to registry defaults.
 *
 * Toggling saves immediately; there is no Save button to forget. A failed
 * request is not treated as proof the save did not happen, since the response
 * can fail after the write committed: the component re-reads, and reports what
 * the server actually holds.
 */
export function SiteSettingsAdminSection() {
  const { t, i18n } = useTranslation();

  /** Server-confirmed values, or null when nothing authoritative is known. */
  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [rows, setRows] = useState<SiteSettingRow[]>([]);
  /** In-flight optimistic toggle. Paints the switch; never stored as truth. */
  const [pending, setPending] = useState<{
    id: SiteSettingId;
    value: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** True when a save's outcome could not be established at all. */
  const [unconfirmed, setUnconfirmed] = useState(false);

  /** Translate a failure by its stable code, never by the server's prose. */
  const messageFor = useCallback(
    (err: unknown): string => {
      const code = err instanceof SiteSettingsApiError ? err.code : null;
      if (err instanceof SiteSettingsApiError) {
        // Prose is for the console; the UI gets a translated string.
        console.warn('[site-settings]', err.status, err.detail);
      }
      return code
        ? t(`siteSettings.errors.${code}`, {
            defaultValue: t('siteSettings.errors.generic'),
          })
        : t('siteSettings.errors.generic');
    },
    [t],
  );

  const load = useCallback(() => {
    setLoading(true);
    fetchSiteSettings()
      .then(({ settings: next, rows: serverRows }) => {
        setSettings(next);
        if (serverRows) setRows(serverRows);
        setError(null);
        setUnconfirmed(false);
      })
      .catch((err) => {
        setSettings(null);
        setError(messageFor(err));
      })
      .finally(() => setLoading(false));
  }, [messageFor]);

  useEffect(load, [load]);

  async function toggle(id: SiteSettingId, next: boolean) {
    setPending({ id, value: next });
    setError(null);
    setUnconfirmed(false);
    try {
      const { settings: confirmed, rows: serverRows } = await updateSiteSettings(
        { [id]: next },
      );
      setSettings(confirmed);
      // Null means the server could not refresh provenance; keep what we have.
      if (serverRows) setRows(serverRows);
    } catch (err) {
      // The write may have committed even though the response failed, so ask
      // the server what the state actually is rather than assuming a rollback.
      // The original failure never reaches the UI (the re-read is what we can
      // actually stand behind), but it is the useful thing to debug from.
      console.warn('[site-settings] save response failed; re-reading', err);
      try {
        const { settings: confirmed, rows: serverRows } =
          await fetchSiteSettings();
        setSettings(confirmed);
        if (serverRows) setRows(serverRows);
        // The re-read is authoritative, so report what it found rather than
        // the failed response: a value that matches the request means the save
        // DID happen, and saying otherwise would be as wrong as the reverse.
        setError(
          confirmed[id] === next ? null : t('siteSettings.errors.notApplied'),
        );
      } catch {
        // Genuinely indeterminate. Drop to "nothing authoritative known", which
        // withholds the controls — the optimistic value must not survive as if
        // it were the live policy.
        setSettings(null);
        setUnconfirmed(true);
      }
    } finally {
      setPending(null);
    }
  }

  const rowById = new Map(rows.map((r) => [r.id, r]));

  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold mb-2">{t('siteSettings.title')}</h2>
      <p className="text-sm text-muted-foreground mb-4">
        {t('siteSettings.description')}
      </p>

      {error ? (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300 mb-3">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">
          {t('siteSettings.loading')}
        </p>
      ) : !settings ? (
        // Nothing authoritative is known. Rendering the switches from the
        // registry defaults would put the gate in its `true` position on screen
        // while the stored policy may be `false`, with a live control attached.
        // An error banner beside a confident-looking toggle does not undo that
        // reading, so withhold the controls rather than assert a policy nobody
        // knows.
        <div className="max-w-2xl">
          <p className="text-sm text-muted-foreground mb-3">
            {unconfirmed
              ? t('siteSettings.errors.unconfirmed')
              : t('siteSettings.errors.unloaded')}
          </p>
          <Button variant="outline" onClick={load}>
            {t('siteSettings.retry')}
          </Button>
        </div>
      ) : (
        <ul className="space-y-3 max-w-2xl">
          {SITE_SETTING_LIST.map((def) => {
            const row = rowById.get(def.id);
            const saving = pending?.id === def.id;
            // The optimistic value paints the switch only while its own request
            // is in flight; everything else comes from confirmed state.
            const value = saving ? pending.value : settings[def.id];
            // Derive "is it at its default" from the live value, never from
            // `row.isDefault`: when a save's provenance re-read failed the
            // retained row is the PRE-save one, and trusting it would print
            // "At its shipped default" next to a toggle that is visibly off.
            const isDefault = value === def.defaultValue;
            // The retained row only describes the current state if it agrees
            // about the value; otherwise its who/when belongs to a superseded
            // state and must not be shown as if it were current.
            const provenance = row && row.value === value ? row : null;
            const key = keyOf(def.id);
            return (
              <li
                key={def.id}
                className="rounded-md border border-border p-3 flex items-start justify-between gap-4"
              >
                <div className="min-w-0">
                  <p className="font-medium">
                    {t(`siteSettings.items.${key}.label`)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t(`siteSettings.items.${key}.description`)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-2">
                    {value
                      ? t(`siteSettings.items.${key}.whenOn`)
                      : t(`siteSettings.items.${key}.whenOff`)}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {def.enforcedAt.map((where) => (
                      <code
                        key={where}
                        className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {where}
                      </code>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    {isDefault
                      ? t('siteSettings.atDefault')
                      : provenance
                        ? t('siteSettings.changedBy', {
                            who:
                              provenance.updatedBy?.username ??
                              t('siteSettings.unknownUser'),
                            when: provenance.updatedAt
                              ? new Date(provenance.updatedAt).toLocaleString(
                                  // Follow the app's persisted language, not
                                  // the device locale — they differ often.
                                  i18n.language,
                                )
                              : '—',
                          })
                        : t('siteSettings.provenanceUnavailable')}
                  </p>
                </div>
                <Switch
                  checked={value}
                  disabled={saving}
                  aria-label={t(`siteSettings.items.${key}.label`)}
                  onCheckedChange={(checked) => toggle(def.id, checked)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
