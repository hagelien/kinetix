import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor, Moon, Sun } from 'lucide-react';
import { AuthGuard } from '@/components/AuthGuard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useAppStore, type ThemeMode } from '@/stores/appStore';
import type { FractionDisplay } from '@/lib/rangeUtils';
import {
  DEFAULT_ENABLED_UNITS,
  useAuthStore,
  type ConcentrationUnitName,
  type NotificationSettings,
} from '@/stores/authStore';
import { useCan } from '@/lib/usePermissions';
import {
  SELECTABLE_EMAIL_FREQUENCIES,
  resolveEmailPrefs,
  type EmailFrequency,
} from '@/lib/emailNotificationPrefs';
import {
  ETHANOL_UNIT_OPTIONS,
  normalizeEthanolUnit,
} from '@/lib/ethanolUnits';

interface FormState {
  displayName: string;
  /** Selected units in primary-first order. Always non-empty when valid. */
  enabledUnits: ConcentrationUnitName[];
  primaryUnit: ConcentrationUnitName;
  /** Ethanol's own display unit (‰, %, or any concentration unit). */
  ethanolUnit: ConcentrationUnitName;
  emailOnFeedback: boolean;
  emailAsReviewer: boolean;
  emailFrequency: EmailFrequency;
}

// Mass + molar units the preferences UI exposes. Mirrors the master list in
// src/lib/unitConversion.ts. Grouped for the picker so the user sees mg/L
// next to mg/dL etc. Order within each group is the same order the
// unit-tooltip already uses.
const MASS_UNITS: ConcentrationUnitName[] = [
  'mg/L',
  'µg/mL',
  'ng/mL',
  'µg/L',
  'ng/L',
  'mg/dL',
  'µg/dL',
  'ng/dL',
];
const MOLAR_UNITS: ConcentrationUnitName[] = [
  'mmol/L',
  'µmol/L',
  'nmol/L',
  'mmol/dL',
  'µmol/dL',
  'nmol/dL',
];

// Concentration units the simulator worker (montecarlo.worker.ts:152)
// understands. The row/tooltip converter (`src/lib/conversions.ts`'s
// massUnits/molarUnits) now has a matching <select> option for every unit
// this page can enable (#1209), but the simulator launch still silently
// mis-scales on the units left out below (#317 P1 / P2 review), so those
// stay enabled for tooltip + converter-modal display only, never as primary.
const PRIMARY_ELIGIBLE_UNITS = new Set<ConcentrationUnitName>([
  'mg/L',
  'µg/L',
  'mmol/L',
  'µmol/L',
  'nmol/L',
]);

function formFromUser(
  user: ReturnType<typeof useAuthStore.getState>['user'],
): FormState {
  const enabled =
    user?.enabledConcentrationUnits && user.enabledConcentrationUnits.length > 0
      ? user.enabledConcentrationUnits
      : [...DEFAULT_ENABLED_UNITS];
  return {
    displayName: user?.displayName ?? '',
    enabledUnits: enabled,
    primaryUnit: enabled[0]!,
    ethanolUnit: normalizeEthanolUnit(user?.ethanolConcentrationUnit),
    ...(() => {
      const prefs = resolveEmailPrefs(user?.notificationSettings);
      return {
        emailOnFeedback: prefs.feedback,
        emailAsReviewer: prefs.reviewer,
        emailFrequency: prefs.frequency,
      };
    })(),
  };
}

/** Move the chosen unit to the front of the array if it's already enabled. */
function withPrimary(
  units: ConcentrationUnitName[],
  primary: ConcentrationUnitName,
): ConcentrationUnitName[] {
  if (!units.includes(primary)) return [primary, ...units];
  return [primary, ...units.filter((u) => u !== primary)];
}

/**
 * Translate the few stable error codes our preferences API emits.
 *
 * `parseAndValidate` joins Zod issues as `${path}: ${message}`, so the
 * `error` body looks like `enabledConcentrationUnits: errors.unknownConcentrationUnit`.
 * We pull the trailing token (after the last `:` and trim) and try to
 * translate it; unknown codes fall through unchanged so server-error
 * strings still surface in production.
 */
function translateApiError(
  raw: unknown,
  t: (key: string) => string,
): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const tail = raw.split(':').pop()?.trim() ?? raw;
  if (tail.startsWith('errors.')) {
    const translated = t(tail);
    return translated === tail ? raw : translated;
  }
  return raw;
}

function PreferencesContent() {
  const { t, i18n } = useTranslation();
  const canReview = useCan('dispute.queue.read');
  const user = useAuthStore((s) => s.user);
  const applyPreferences = useAuthStore((s) => s.applyPreferences);
  const themeMode = useAppStore((s) => s.themeMode);
  const setThemeMode = useAppStore((s) => s.setThemeMode);
  const fractionDisplay = useAppStore((s) => s.fractionDisplay);
  const setFractionDisplay = useAppStore((s) => s.setFractionDisplay);
  const tipsEnabled = useAppStore((s) => s.tipsEnabled);
  const setTipsEnabled = useAppStore((s) => s.setTipsEnabled);
  const dismissedTipCount = useAppStore((s) => s.dismissedTips.length);
  const resetDismissedTips = useAppStore((s) => s.resetDismissedTips);

  const [form, setForm] = useState<FormState>(() => formFromUser(user));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [tipsReset, setTipsReset] = useState(false);

  // Re-seed the form when the user reference changes (e.g. after another tab
  // saved a different value and checkAuth re-ran).
  useEffect(() => {
    setForm(formFromUser(user));
  }, [user]);

  const enabledSet = useMemo(
    () => new Set(form.enabledUnits),
    [form.enabledUnits],
  );
  const themeOptions: {
    mode: ThemeMode;
    label: string;
    icon: typeof Monitor;
  }[] = [
    { mode: 'system', label: t('theme.system'), icon: Monitor },
    { mode: 'light', label: t('theme.light'), icon: Sun },
    { mode: 'dark', label: t('theme.dark'), icon: Moon },
  ];
  // The example carries the whole explanation: a bioavailability of 0.3 is the
  // same number as 30%, so the two buttons show it both ways rather than
  // describing the notation in prose.
  const fractionOptions: {
    mode: FractionDisplay;
    label: string;
    example: string;
  }[] = [
    {
      mode: 'decimal',
      label: t('preferences.fractionsDecimal'),
      example: '0.3',
    },
    {
      mode: 'percent',
      label: t('preferences.fractionsPercent'),
      example: '30%',
    },
  ];

  function toggleUnit(unit: ConcentrationUnitName, checked: boolean) {
    setForm((prev) => {
      const next = checked
        ? Array.from(new Set([...prev.enabledUnits, unit]))
        : prev.enabledUnits.filter((u) => u !== unit);
      // Don't allow deselecting the very last unit — fall back to the primary.
      const safe = next.length > 0 ? next : [prev.primaryUnit];
      // The primary must remain simulator-supported (#317 P1/P2). If the
      // user just unchecked the last eligible unit, re-add their previous
      // primary so the form can never reach a state the API would reject
      // for `primaryUnitNotSupported`.
      let withEligible = safe;
      if (!safe.some((u) => PRIMARY_ELIGIBLE_UNITS.has(u))) {
        const fallback = PRIMARY_ELIGIBLE_UNITS.has(prev.primaryUnit)
          ? prev.primaryUnit
          : ((DEFAULT_ENABLED_UNITS.find((u) =>
              PRIMARY_ELIGIBLE_UNITS.has(u as ConcentrationUnitName),
            ) as ConcentrationUnitName | undefined) ?? 'µmol/L');
        withEligible = [...safe, fallback];
      }
      const primary =
        withEligible.includes(prev.primaryUnit) &&
        PRIMARY_ELIGIBLE_UNITS.has(prev.primaryUnit)
          ? prev.primaryUnit
          : withEligible.find((u) => PRIMARY_ELIGIBLE_UNITS.has(u))!;
      return {
        ...prev,
        enabledUnits: withPrimary(withEligible, primary),
        primaryUnit: primary,
      };
    });
  }

  function setPrimary(unit: ConcentrationUnitName) {
    setForm((prev) => ({
      ...prev,
      primaryUnit: unit,
      enabledUnits: withPrimary(prev.enabledUnits, unit),
    }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const trimmedName = form.displayName.trim();
      // Always written in full, so the legacy toggle is superseded rather than
      // left to be read back as a fallback. The email language follows the
      // UI language the user is saving from.
      const notificationSettings: NotificationSettings = {
        emailOnFeedback: form.emailOnFeedback,
        // Written back as stored even when the control is hidden: `canReview`
        // can be momentarily false (permissions still loading, or a failed
        // load leaving the shipped defaults), and deriving the value from it
        // would silently unsubscribe a legitimate reviewer. Delivery re-checks
        // queue access before every reviewer email anyway.
        emailAsReviewer: form.emailAsReviewer,
        emailFrequency: form.emailFrequency,
        emailLocale: i18n?.language?.startsWith('en') ? 'en' : 'nb',
      };

      const res = await fetch('/api/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: trimmedName.length > 0 ? trimmedName : null,
          enabledConcentrationUnits: withPrimary(
            form.enabledUnits,
            form.primaryUnit,
          ),
          ethanolConcentrationUnit: form.ethanolUnit,
          notificationSettings,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          translateApiError(data.error, t) ??
            t('preferences.saveFailedStatus', { status: res.status }),
        );
      }

      const data = (await res.json()) as {
        preferences: {
          displayName: string | null;
          enabledConcentrationUnits: ConcentrationUnitName[];
          ethanolConcentrationUnit?: ConcentrationUnitName;
          notificationSettings: NotificationSettings | null;
          favoriteParameters: string[];
        };
      };
      applyPreferences(data.preferences);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('preferences.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex-1 bg-background">
      <main className="max-w-2xl mx-auto p-6">
        <h1 className="text-2xl font-semibold mb-1">
          {t('preferences.title')}
        </h1>
        <p className="text-sm text-muted-foreground mb-6">
          {t('preferences.subtitle')}
        </p>

        <form onSubmit={handleSubmit} className="space-y-6">
          <section>
            <h2 className="text-base font-semibold mb-2">
              {t('preferences.displayNameTitle')}
            </h2>
            <p className="text-sm text-muted-foreground mb-2">
              {t('preferences.displayNameHelp', {
                username: user?.username ?? '',
              })}
            </p>
            <Input
              value={form.displayName}
              onChange={(e) =>
                setForm({ ...form, displayName: e.target.value })
              }
              maxLength={100}
              placeholder={user?.username ?? ''}
              className="max-w-md"
            />
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2">
              {t('preferences.themeTitle')}
            </h2>
            <p className="text-sm text-muted-foreground mb-3">
              {t('preferences.themeHelp')}
            </p>
            <div className="flex flex-wrap gap-2">
              {themeOptions.map(({ mode, label, icon: Icon }) => (
                <Button
                  key={mode}
                  type="button"
                  variant={themeMode === mode ? 'default' : 'outline'}
                  onClick={() => setThemeMode(mode)}
                  className="gap-2"
                  aria-pressed={themeMode === mode}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </Button>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2">
              {t('preferences.fractionsTitle')}
            </h2>
            <p className="text-sm text-muted-foreground mb-3">
              {t('preferences.fractionsHelp')}
            </p>
            <div className="flex flex-wrap gap-2">
              {fractionOptions.map(({ mode, label, example }) => (
                <Button
                  key={mode}
                  type="button"
                  variant={fractionDisplay === mode ? 'default' : 'outline'}
                  onClick={() => setFractionDisplay(mode)}
                  className="gap-2"
                  aria-pressed={fractionDisplay === mode}
                >
                  {label}
                  <span className="text-xs opacity-70 tabular-nums">
                    {example}
                  </span>
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {t('preferences.fractionsNote')}
            </p>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2">
              {t('preferences.unitsTitle')}
            </h2>
            <p className="text-sm text-muted-foreground mb-3">
              {t('preferences.unitsHelp')}
            </p>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 max-w-md">
              <fieldset>
                <legend className="text-xs font-medium text-muted-foreground mb-1">
                  {t('preferences.unitsMolarGroup')}
                </legend>
                {MOLAR_UNITS.map((unit) => (
                  <label
                    key={unit}
                    className="flex items-center gap-2 text-sm py-0.5"
                  >
                    <input
                      type="checkbox"
                      checked={enabledSet.has(unit)}
                      onChange={(e) => toggleUnit(unit, e.target.checked)}
                    />
                    <span>{unit}</span>
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend className="text-xs font-medium text-muted-foreground mb-1">
                  {t('preferences.unitsMassGroup')}
                </legend>
                {MASS_UNITS.map((unit) => (
                  <label
                    key={unit}
                    className="flex items-center gap-2 text-sm py-0.5"
                  >
                    <input
                      type="checkbox"
                      checked={enabledSet.has(unit)}
                      onChange={(e) => toggleUnit(unit, e.target.checked)}
                    />
                    <span>{unit}</span>
                  </label>
                ))}
              </fieldset>
            </div>
            <div className="mt-4 max-w-md">
              <label
                htmlFor="primary-unit"
                className="text-xs font-medium text-muted-foreground"
              >
                {t('preferences.unitsPrimaryLabel')}
              </label>
              <select
                id="primary-unit"
                className="mt-1 bg-background border border-input rounded px-2 py-2 text-sm h-10 w-full"
                value={form.primaryUnit}
                onChange={(e) => setPrimary(e.target.value)}
              >
                {form.enabledUnits
                  .filter((u) => PRIMARY_ELIGIBLE_UNITS.has(u))
                  .map((u) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                {t('preferences.unitsPrimaryHelp')}
              </p>
            </div>
            <div className="mt-4 max-w-md">
              <label
                htmlFor="ethanol-unit"
                className="text-xs font-medium text-muted-foreground"
              >
                {t('preferences.ethanolUnitLabel')}
              </label>
              <select
                id="ethanol-unit"
                className="mt-1 bg-background border border-input rounded px-2 py-2 text-sm h-10 w-full"
                value={form.ethanolUnit}
                onChange={(e) =>
                  setForm({ ...form, ethanolUnit: e.target.value })
                }
              >
                {ETHANOL_UNIT_OPTIONS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                {t('preferences.ethanolUnitHelp')}
              </p>
            </div>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2">
              {t('preferences.notificationsTitle')}
            </h2>
            <p className="text-sm text-muted-foreground mb-2">
              {t('preferences.notificationsHelp')}
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.emailOnFeedback}
                onChange={(e) =>
                  setForm({ ...form, emailOnFeedback: e.target.checked })
                }
                className="mt-1"
              />
              <span>
                {t('preferences.notify_feedback')}
                <span className="block text-xs text-muted-foreground">
                  {t('preferences.notify_feedbackHelp')}
                </span>
              </span>
            </label>
            {canReview && (
              <label className="flex items-start gap-2 text-sm mt-3">
                <input
                  type="checkbox"
                  checked={form.emailAsReviewer}
                  onChange={(e) =>
                    setForm({ ...form, emailAsReviewer: e.target.checked })
                  }
                  className="mt-1"
                />
                <span>
                  {t('preferences.notify_reviewer')}
                  <span className="block text-xs text-muted-foreground">
                    {t('preferences.notify_reviewerHelp')}
                  </span>
                </span>
              </label>
            )}
            <fieldset
              className="mt-4"
              disabled={!form.emailOnFeedback && !(canReview && form.emailAsReviewer)}
            >
              <legend className="text-sm font-medium mb-1">
                {t('preferences.emailFrequencyLabel')}
              </legend>
              <div className="flex flex-col gap-1">
                {SELECTABLE_EMAIL_FREQUENCIES.map((f) => (
                  <label key={f} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="emailFrequency"
                      value={f}
                      checked={form.emailFrequency === f}
                      onChange={() => setForm({ ...form, emailFrequency: f })}
                    />
                    {t(`preferences.emailFrequency.${f}`)}
                  </label>
                ))}
              </div>
            </fieldset>
          </section>

          <section>
            <h2 className="text-base font-semibold mb-2">
              {t('preferences.tipsTitle')}
            </h2>
            <p className="text-sm text-muted-foreground mb-3">
              {t('preferences.tipsHelp')}
            </p>
            <label className="flex items-center gap-3 text-sm">
              <Switch
                checked={tipsEnabled}
                onCheckedChange={setTipsEnabled}
              />
              <span>{t('preferences.tipsToggleLabel')}</span>
            </label>
            <div className="mt-3 flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={dismissedTipCount === 0}
                onClick={() => {
                  resetDismissedTips();
                  setTipsReset(true);
                }}
              >
                {t('preferences.tipsReset')}
              </Button>
              {tipsReset && dismissedTipCount === 0 && (
                <span className="text-sm text-emerald-600">
                  {t('preferences.tipsResetDone')}
                </span>
              )}
            </div>
          </section>

          {error && <p className="text-sm text-red-600">{error}</p>}
          {!error && savedAt && (
            <p className="text-sm text-emerald-600">{t('preferences.saved')}</p>
          )}

          <div>
            <Button type="submit" disabled={busy}>
              {busy ? t('preferences.saving') : t('preferences.save')}
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}

export function PreferencesPage() {
  return (
    <AuthGuard>
      <PreferencesContent />
    </AuthGuard>
  );
}
