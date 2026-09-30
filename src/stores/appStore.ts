import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { getStoredValue, removeStoredValues, setStoredValue } from '@/lib/storage';
import {
  DEFAULT_PM_LINE_SETTINGS,
  normalizePmLineSettings,
  type PmLineSettings,
  type PmStatisticId,
} from '@/lib/pmConcentrations';
import {
  DEFAULT_FORENSIC_LINE_SETTINGS,
  normalizeForensicLineSettings,
  type ForensicCategoryId,
  type ForensicLineSettings,
} from '@/lib/forensicConcentrations';
import {
  DEFAULT_FRACTION_DISPLAY,
  normalizeFractionDisplay,
  type FractionDisplay,
} from '@/lib/rangeUtils';

export type ConcentrationUnit =
  | 'mg/L'
  | 'µg/mL'
  | 'ng/mL'
  | 'µg/L'
  | 'ng/L'
  | 'mg/dL'
  | 'µg/dL'
  | 'ng/dL'
  | 'mmol/L'
  | 'µmol/L'
  | 'nmol/L'
  | 'mmol/dL'
  | 'µmol/dL'
  | 'nmol/dL';

export const DEFAULT_ENABLED_UNITS: ConcentrationUnit[] = ['µmol/L', 'mg/L'];

export type ThemeMode = 'system' | 'light' | 'dark';

interface AppState {
  textScale: number;
  /**
   * User-selected concentration units (#306). The first item is the
   * primary display unit; the rest are alternatives shown in
   * tooltips, converters, and pickers. Always non-empty.
   */
  enabledUnits: ConcentrationUnit[];
  themeMode: ThemeMode;
  /**
   * How dimensionless fractions — bioavailability (F) and plasma protein
   * binding — are written across the site: the stored 0–1 decimal ("0.3") or
   * the same number as a percentage ("30%").
   *
   * Display only: the catalog, the export and every calculation keep the
   * canonical fraction, so switching the preference can never change a result.
   * Entry fields stay in decimals for the same reason — the preference must not
   * silently reinterpret what a curator types.
   */
  fractionDisplay: FractionDisplay;
  /**
   * Master switch for the universal "helpful tips" system (#…). When false,
   * tips never auto-open from user interaction anywhere on the site; the
   * manual help triggers (the `?` buttons) still work. Reversible from the
   * preferences page.
   */
  tipsEnabled: boolean;
  /**
   * Stable ids of tips the user has dismissed via "don't show this again".
   * A dismissed tip never auto-opens again, but its manual `?` trigger keeps
   * working. Persisted so the choice survives reloads.
   */
  dismissedTips: string[];
  /**
   * Which postmortem distribution lines the chart draws, and whether they are
   * converted out of whole blood.
   *
   * A per-user preference rather than per-case state: a forensic toxicologist
   * who works from the 95th percentile wants it on the next chart too, and the
   * next case after that. Persisted with the rest of the app settings, so the
   * choice survives the session.
   */
  pmLines: PmLineSettings;
  /**
   * Which forensic postmortem categories (non-/mono-/poly-intoxication) the
   * modeling chart overlays, and whether the individual references are shown.
   * A per-user preference for the same reason as `pmLines`: a forensic
   * toxicologist who wants the mono-intoxication band on this chart wants it on
   * the next case too.
   */
  forensicLines: ForensicLineSettings;
  setTextScale: (scale: number) => void;
  increaseTextScale: () => void;
  decreaseTextScale: () => void;
  setEnabledUnits: (units: ConcentrationUnit[]) => void;
  setThemeMode: (mode: ThemeMode) => void;
  setFractionDisplay: (mode: FractionDisplay) => void;
  setTipsEnabled: (enabled: boolean) => void;
  dismissTip: (id: string) => void;
  resetDismissedTips: () => void;
  setPmLinesEnabled: (enabled: boolean) => void;
  togglePmStatistic: (id: PmStatisticId) => void;
  resetPmLineSettings: () => void;
  setForensicLinesEnabled: (enabled: boolean) => void;
  toggleForensicCategory: (id: ForensicCategoryId) => void;
  setForensicShowIndividual: (show: boolean) => void;
  resetForensicLineSettings: () => void;
}

const MIN_SCALE = 0.7;
const MAX_SCALE = 1.3;
const SCALE_STEP = 0.05;
const APP_SETTINGS_KEY = 'kinetix.settings';
const LEGACY_APP_SETTINGS_KEY = 'fjelltox.settings';

/** Convenience accessor: the user's primary display unit. */
export function primaryUnit(state: AppState): ConcentrationUnit {
  return state.enabledUnits[0] ?? DEFAULT_ENABLED_UNITS[0]!;
}

/**
 * Subscribe to the fraction-display preference. A named hook rather than an
 * inline selector because nearly every table, sidebar and comparison surface
 * needs it, and one shared selector keeps them re-rendering on the same key.
 */
export function useFractionDisplay(): FractionDisplay {
  return useAppStore((state) => state.fractionDisplay);
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      textScale: 0.95,
      enabledUnits: [...DEFAULT_ENABLED_UNITS],
      themeMode: 'system' as ThemeMode,
      fractionDisplay: DEFAULT_FRACTION_DISPLAY,
      tipsEnabled: true,
      dismissedTips: [],
      pmLines: DEFAULT_PM_LINE_SETTINGS,
      forensicLines: DEFAULT_FORENSIC_LINE_SETTINGS,
      setTextScale: (scale) =>
        set({ textScale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)) }),
      increaseTextScale: () =>
        set((state) => ({
          textScale: Math.min(MAX_SCALE, state.textScale + SCALE_STEP),
        })),
      decreaseTextScale: () =>
        set((state) => ({
          textScale: Math.max(MIN_SCALE, state.textScale - SCALE_STEP),
        })),
      setEnabledUnits: (units) =>
        set({
          enabledUnits: units.length > 0 ? units : [...DEFAULT_ENABLED_UNITS],
        }),
      setThemeMode: (mode) => set({ themeMode: mode }),
      setFractionDisplay: (mode) => set({ fractionDisplay: mode }),
      setTipsEnabled: (enabled) => set({ tipsEnabled: enabled }),
      dismissTip: (id) =>
        set((state) =>
          state.dismissedTips.includes(id)
            ? state
            : { dismissedTips: [...state.dismissedTips, id] },
        ),
      resetDismissedTips: () => set({ dismissedTips: [] }),
      setPmLinesEnabled: (enabled) =>
        set((state) => ({ pmLines: { ...state.pmLines, enabled } })),
      togglePmStatistic: (id) =>
        set((state) => ({
          pmLines: {
            ...state.pmLines,
            statistics: {
              ...state.pmLines.statistics,
              [id]: !state.pmLines.statistics[id],
            },
          },
        })),
      resetPmLineSettings: () => set({ pmLines: DEFAULT_PM_LINE_SETTINGS }),
      setForensicLinesEnabled: (enabled) =>
        set((state) => ({
          forensicLines: { ...state.forensicLines, enabled },
        })),
      toggleForensicCategory: (id) =>
        set((state) => ({
          forensicLines: {
            ...state.forensicLines,
            categories: {
              ...state.forensicLines.categories,
              [id]: !state.forensicLines.categories[id],
            },
          },
        })),
      setForensicShowIndividual: (showIndividual) =>
        set((state) => ({
          forensicLines: { ...state.forensicLines, showIndividual },
        })),
      resetForensicLineSettings: () =>
        set({ forensicLines: DEFAULT_FORENSIC_LINE_SETTINGS }),
    }),
    {
      name: APP_SETTINGS_KEY,
      version: 5,
      storage: createJSONStorage(() => ({
        getItem: (name) => getStoredValue(name, [LEGACY_APP_SETTINGS_KEY]),
        setItem: (name, value) => setStoredValue(name, value, [LEGACY_APP_SETTINGS_KEY]),
        removeItem: (name) => removeStoredValues(name, [LEGACY_APP_SETTINGS_KEY]),
      })),
      // v1 → v2: the binary `preferredUnit` setting is replaced by the
      // multi-select `enabledUnits` array. Pre-#306 sessions get their old
      // primary plus the other default appended so unit-conversion tooltips
      // keep showing both kinds.
      migrate: (persistedState, version) => {
        // v2 → v3 adds `pmLines`; v3 → v4 adds `forensicLines`; v4 → v5 adds
        // `fractionDisplay`. All are applied to every older state on the way out
        // rather than as branches of their own. Normalizing (instead of
        // defaulting) also repairs a blob written by a build that knew a
        // different set of statistics/categories.
        const withOverlayLines = (state: unknown): AppState => {
          const record = state as Record<string, unknown>;
          return {
            ...record,
            pmLines: normalizePmLineSettings(record.pmLines),
            forensicLines: normalizeForensicLineSettings(record.forensicLines),
            fractionDisplay: normalizeFractionDisplay(record.fractionDisplay),
          } as unknown as AppState;
        };
        if (version >= 2) return withOverlayLines(persistedState);
        const legacy = persistedState as { preferredUnit?: ConcentrationUnit } &
          Record<string, unknown>;
        const primary = legacy.preferredUnit ?? DEFAULT_ENABLED_UNITS[0]!;
        const other =
          primary === 'mg/L' ? ('µmol/L' as const) : ('mg/L' as const);
        const enabled = primary === other ? [primary] : [primary, other];
        const { preferredUnit: _drop, ...rest } = legacy;
        void _drop;
        return withOverlayLines({ ...rest, enabledUnits: enabled });
      },
    }
  )
);
