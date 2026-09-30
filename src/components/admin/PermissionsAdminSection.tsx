import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { showToast } from '@/lib/toast';
import {
  CAPABILITY_GROUPS,
  CAPABILITY_LIST,
  PERMISSION_TIERS,
  getCapability,
  type CapabilityDef,
  type CapabilityGroup,
  type PermissionTier,
} from '@/lib/permissions';
import {
  PermissionApiError,
  fetchPermissionMatrix,
  savePermissionChanges,
  type PermissionHistoryRow,
  type PermissionMatrixRow,
} from '@/lib/permissionsApi';
import { useAuthStore } from '@/stores/authStore';

const TIER_INDEX = new Map<PermissionTier, number>(
  PERMISSION_TIERS.map((tier, index) => [tier, index]),
);

function atLeast(tier: PermissionTier, min: PermissionTier): boolean {
  return (TIER_INDEX.get(tier) ?? 0) >= (TIER_INDEX.get(min) ?? 0);
}

/**
 * Resolve an error thrown by the API helpers. Those carry an i18n key (and
 * the capability the server refused) rather than server prose, so an admin
 * reading Norwegian never sees an English validation message.
 */
type Translate = (key: string, opts?: Record<string, unknown>) => string;

function translateError(
  err: unknown,
  fallbackKey: string,
  translate: Translate,
): string {
  if (err instanceof PermissionApiError) {
    const label = err.capability
      ? translate(labelKey(err.capability))
      : undefined;
    return translate(err.message, { capability: label ?? err.capability });
  }
  return translate(fallbackKey);
}

/** i18n keys can't carry the dots in a capability id. */
function labelKey(capability: string): string {
  return `admin.permissions.capabilities.${capability.replace(/\./g, '_')}`;
}

/**
 * Admin → Permissions: the capability matrix as an editable grid.
 *
 * Rows are capabilities, columns are tiers, and a cell is checked when that
 * tier holds the capability. Clicking a cell makes that tier the minimum, so
 * everything to its right fills in — the ladder can only ever be moved, never
 * punctured. Locked rows render read-only, and cells below a capability's
 * floor are disabled rather than hidden so the boundary is visible.
 */
export function PermissionsAdminSection(): JSX.Element {
  const { t, i18n } = useTranslation();
  const reloadPermissions = useAuthStore((s) => s.loadPermissions);
  const [rows, setRows] = useState<PermissionMatrixRow[]>([]);
  const [history, setHistory] = useState<PermissionHistoryRow[]>([]);
  const [pending, setPending] = useState<Record<string, PermissionTier>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // `t` is only used for toast copy; keeping it out of the effect's deps
  // avoids re-fetching the matrix on every language-provider re-render.
  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchPermissionMatrix();
      setRows(data.rows);
      setHistory(data.history);
      setPending({});
    } catch (err) {
      showToast(translateError(err, 'admin.permissions.loadFailed', tRef.current));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const effective = useMemo(() => {
    const map = new Map<string, PermissionTier>();
    for (const row of rows) map.set(row.capability, row.minTier);
    for (const [capability, tier] of Object.entries(pending)) {
      map.set(capability, tier);
    }
    return map;
  }, [rows, pending]);

  const changeCount = Object.keys(pending).length;

  function selectTier(capability: string, tier: PermissionTier): void {
    const row = rows.find((r) => r.capability === capability);
    setPending((prev) => {
      const next = { ...prev };
      if (row && row.minTier === tier) delete next[capability];
      else next[capability] = tier;
      return next;
    });
  }

  function resetRow(capability: string): void {
    const cap = getCapability(capability);
    if (!cap) return;
    selectTier(capability, cap.defaultTier);
  }

  async function save(): Promise<void> {
    setSaving(true);
    try {
      const result = await savePermissionChanges(
        Object.entries(pending).map(([capability, minTier]) => {
          const cap = getCapability(capability);
          // Send null for "back to the shipped default" so the row is
          // cleared rather than pinned to a value that may move in a later
          // release.
          return {
            capability,
            minTier: cap && cap.defaultTier === minTier ? null : minTier,
          };
        }),
      );
      setRows(result.rows);
      setPending({});
      // The saved matrix governs this admin's own UI too.
      await reloadPermissions();
      await load();
      showToast(t('admin.permissions.saved'));
    } catch (err) {
      showToast(translateError(err, 'admin.permissions.saveFailed', t));
    } finally {
      setSaving(false);
    }
  }

  const byGroup = useMemo(() => {
    const map = new Map<CapabilityGroup, CapabilityDef[]>();
    for (const group of CAPABILITY_GROUPS) {
      map.set(
        group,
        CAPABILITY_LIST.filter((cap) => cap.group === group),
      );
    }
    return map;
  }, []);

  return (
    <section className="mb-10">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl">
          <h2 className="text-xl font-semibold">{t('admin.permissions.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('admin.permissions.intro')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {changeCount > 0 && (
            <>
              <span className="text-sm text-muted-foreground">
                {t('admin.permissions.unsaved', { count: changeCount })}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPending({})}
                disabled={saving}
              >
                {t('admin.permissions.discard')}
              </Button>
            </>
          )}
          <Button size="sm" onClick={save} disabled={saving || changeCount === 0}>
            {saving ? t('admin.permissions.saving') : t('admin.permissions.save')}
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[52rem] text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium">
                  {t('admin.permissions.capability')}
                </th>
                {PERMISSION_TIERS.map((tier) => (
                  <th
                    key={tier}
                    scope="col"
                    className="px-3 py-3 text-center font-medium whitespace-nowrap"
                  >
                    {t(`admin.permissions.tiers.${tier}`)}
                  </th>
                ))}
                <th className="px-3 py-3" />
              </tr>
            </thead>
            <tbody>
              {CAPABILITY_GROUPS.flatMap((group) => [
                <tr key={`group-${group}`} className="border-t border-border">
                  <th
                    colSpan={PERMISSION_TIERS.length + 2}
                    scope="colgroup"
                    className="bg-muted/30 px-4 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    {t(`admin.permissions.groups.${group}`)}
                  </th>
                </tr>,
                ...(byGroup.get(group) ?? []).map((cap) => {
                  const row = rows.find((r) => r.capability === cap.id);
                  const current = effective.get(cap.id) ?? cap.defaultTier;
                  const dirty = pending[cap.id] !== undefined;
                  const isDefault = current === cap.defaultTier;
                  return (
                    <tr
                      key={cap.id}
                      className={`border-t border-border align-top ${
                        dirty ? 'bg-amber-50/60 dark:bg-amber-950/20' : ''
                      }`}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium">{t(labelKey(cap.id))}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {cap.enforcedAt.map((where) => (
                            <code
                              key={where}
                              className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                            >
                              {where}
                            </code>
                          ))}
                        </div>
                        {cap.alsoGrantedBy && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t('admin.permissions.alsoGrantedBy', {
                              sources: cap.alsoGrantedBy.join(', '),
                            })}
                          </p>
                        )}
                        {cap.locked && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            🔒 {t('admin.permissions.lockedHint')}
                          </p>
                        )}
                        {!isDefault && !dirty && row?.updatedBy && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t('admin.permissions.changedBy', {
                              user: row.updatedBy.username,
                              date: row.updatedAt
                                ? new Date(row.updatedAt).toLocaleDateString(
                                    i18n.language,
                                  )
                                : '',
                            })}
                          </p>
                        )}
                      </td>
                      {PERMISSION_TIERS.map((tier) => {
                        const granted = atLeast(tier, current);
                        const selectable =
                          !cap.locked && atLeast(tier, cap.floorTier);
                        const isMin = tier === current;
                        return (
                          <td key={tier} className="px-3 py-3 text-center">
                            <button
                              type="button"
                              aria-label={`${t(labelKey(cap.id))} — ${t(
                                `admin.permissions.tiers.${tier}`,
                              )}`}
                              aria-pressed={isMin}
                              disabled={!selectable}
                              title={
                                selectable
                                  ? undefined
                                  : cap.locked
                                    ? t('admin.permissions.lockedHint')
                                    : t('admin.permissions.floorHint', {
                                        tier: t(
                                          `admin.permissions.tiers.${cap.floorTier}`,
                                        ),
                                      })
                              }
                              onClick={() => selectTier(cap.id, tier)}
                              className={`h-7 w-7 rounded border text-sm leading-none ${
                                granted
                                  ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                  : 'border-border text-muted-foreground'
                              } ${isMin ? 'ring-2 ring-emerald-500/70' : ''} ${
                                selectable
                                  ? 'cursor-pointer hover:border-emerald-500'
                                  : 'cursor-not-allowed opacity-60'
                              }`}
                            >
                              {granted ? '✓' : '—'}
                            </button>
                          </td>
                        );
                      })}
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        {isDefault ? (
                          <span className="text-xs text-muted-foreground">
                            {t('admin.permissions.default')}
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => resetRow(cap.id)}
                            disabled={cap.locked}
                          >
                            {t('admin.permissions.resetRow')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                }),
              ])}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6">
        <h3 className="mb-2 text-sm font-semibold">
          {t('admin.permissions.history')}
        </h3>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('admin.permissions.historyEmpty')}
          </p>
        ) : (
          <ul className="space-y-1 text-sm text-muted-foreground">
            {history.map((entry) => (
              <li key={entry.id}>
                <span className="text-foreground">
                  {t(labelKey(entry.capability))}
                </span>
                {': '}
                {entry.fromTier
                  ? t(`admin.permissions.tiers.${entry.fromTier}`)
                  : t('admin.permissions.default')}
                {' → '}
                {entry.toTier
                  ? t(`admin.permissions.tiers.${entry.toTier}`)
                  : t('admin.permissions.default')}
                {' · '}
                {new Date(entry.changedAt).toLocaleString(i18n.language)}
                {entry.changedBy ? ` · ${entry.changedBy.username}` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
