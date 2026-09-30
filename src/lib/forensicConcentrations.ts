/**
 * Forensic postmortem concentration overlay — the shared domain layer.
 *
 * This recreates the three "Døde" (deceased) columns of the legacy toxbase for
 * the modeling chart: concentrations measured at autopsy, split by the forensic
 * context the death was classified under —
 *
 *   - `postmortem_non_intox`  — found in a death NOT caused by the drug
 *   - `postmortem_mono_intox` — fatal poisoning by this drug ALONE
 *   - `postmortem_poly_intox` — fatal poisoning by this drug WITH others
 *
 * These are the `scenario` values already stored on `parameter_entries` (the
 * "source values" / kildeverdier — one reviewed row per published reference,
 * each carrying its own `n`, matrix and citation). This layer reads those rows
 * directly rather than the single pooled `fatalConcentration` cache, because the
 * point of the overlay is to keep the three contexts distinct AND to show how
 * much evidence stands behind each band — which the collapsed cache throws away.
 *
 * Everything here is pure and free of i18n/Plotly so it can be unit-tested
 * against numbers: the hook turns each result into drawable reference lines and
 * bands with the translated labels.
 *
 * IMPORTANT: a postmortem finding is a MEASUREMENT ("this is what gets seen at
 * autopsy"), not an interpretive threshold ("this concentration means death").
 * The two must never read as the same kind of line — these bands are drawn
 * below the interpretive therapeutic/toxic/lethal lines and labelled as
 * distributions, never as limits.
 */
import {
  convertConcentration,
  isConcentrationUnit,
  type ConcentrationUnit,
} from './unitConversion';
import {
  bloodPlasmaFactorOrNull,
  convertToDisplayMatrix,
  isConvertibleMatrix,
  type ChartMatrix,
} from './matrixDisplay';
import type { NumericRange } from '@/types';

/** The three forensic postmortem categories, in display order (least → most severe). */
export const FORENSIC_CATEGORY_IDS = [
  'postmortem_non_intox',
  'postmortem_mono_intox',
  'postmortem_poly_intox',
] as const;

export type ForensicCategoryId = (typeof FORENSIC_CATEGORY_IDS)[number];

export function isForensicCategory(
  scenario: string | null | undefined,
): scenario is ForensicCategoryId {
  return (
    scenario != null &&
    (FORENSIC_CATEGORY_IDS as readonly string[]).includes(scenario)
  );
}

export interface ForensicCategoryMeta {
  id: ForensicCategoryId;
  /** i18n key under `forensicConc.category`. */
  i18nKey: string;
  /**
   * Base hue for this category's band and line, BEFORE evidence opacity is
   * applied. Chosen so severity reads at a glance: a neutral slate for a death
   * the drug did not cause, warning amber where the drug was one of several
   * causes, and red where it was the sole cause.
   */
  color: string;
  /** Whether this category is drawn before the reader touches the controls. */
  defaultVisible: boolean;
}

export const FORENSIC_CATEGORIES: readonly ForensicCategoryMeta[] = [
  {
    id: 'postmortem_non_intox',
    i18nKey: 'forensicConc.category.postmortem_non_intox',
    color: '#64748b',
    defaultVisible: true,
  },
  {
    id: 'postmortem_mono_intox',
    i18nKey: 'forensicConc.category.postmortem_mono_intox',
    color: '#dc2626',
    defaultVisible: true,
  },
  {
    id: 'postmortem_poly_intox',
    i18nKey: 'forensicConc.category.postmortem_poly_intox',
    color: '#d97706',
    defaultVisible: true,
  },
];

const CATEGORY_BY_ID = new Map(FORENSIC_CATEGORIES.map((c) => [c.id, c]));

export function forensicCategoryMeta(
  id: ForensicCategoryId,
): ForensicCategoryMeta | undefined {
  return CATEGORY_BY_ID.get(id);
}

export interface ForensicLineSettings {
  /** Master switch for the whole overlay. */
  enabled: boolean;
  /** Which categories are drawn. */
  categories: Record<ForensicCategoryId, boolean>;
  /**
   * When false (the default), each category is one pooled band + a
   * representative line whose opacity reflects the total evidence behind it.
   * When true, every contributing reference is drawn as its own faint→strong
   * line so the reader can see the individual sources — the toxbase's
   * row-per-reference view.
   */
  showIndividual: boolean;
}

export const DEFAULT_FORENSIC_LINE_SETTINGS: ForensicLineSettings = {
  enabled: true,
  categories: FORENSIC_CATEGORIES.reduce(
    (acc, c) => {
      acc[c.id] = c.defaultVisible;
      return acc;
    },
    {} as Record<ForensicCategoryId, boolean>,
  ),
  showIndividual: false,
};

/**
 * Merge a stored settings blob with the defaults.
 *
 * Persisted preferences outlive the code that wrote them: a category added in a
 * later release is absent from a blob written today. Resolving against the
 * current registry means a stale blob can neither hide a new category nor
 * resurrect a removed one.
 */
export function normalizeForensicLineSettings(
  stored: unknown,
  fallback: ForensicLineSettings = DEFAULT_FORENSIC_LINE_SETTINGS,
): ForensicLineSettings {
  const raw = (stored ?? {}) as Partial<ForensicLineSettings>;
  const categories = {} as Record<ForensicCategoryId, boolean>;
  for (const cat of FORENSIC_CATEGORIES) {
    const value = (raw.categories as Record<string, unknown> | undefined)?.[
      cat.id
    ];
    categories[cat.id] =
      typeof value === 'boolean' ? value : fallback.categories[cat.id];
  }
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    categories,
    showIndividual:
      typeof raw.showIndividual === 'boolean'
        ? raw.showIndividual
        : fallback.showIndividual,
  };
}

// --- Evidence-strength encoding -------------------------------------------

/**
 * Sample size at which a band reaches full opacity. Fixed (not per-drug) so a
 * band's strength is comparable ACROSS drugs — a faint mono-intox band on one
 * drug and a solid one on another differ because their evidence differs, not
 * because each was normalised to its own maximum.
 */
export const EVIDENCE_N_REF = 100;
export const EVIDENCE_ALPHA_MIN = 0.2;
export const EVIDENCE_ALPHA_MAX = 0.85;

/**
 * Opacity for a band/line backed by `n` observations.
 *
 * Saturating (log), not linear: published forensic n spans a single case
 * report (n=1) to large series (n in the hundreds), and a linear map would
 * leave everything below ~n=50 invisible. A log curve keeps a lone case report
 * faint-but-legible while a large series is near-opaque, without washing out the
 * middle. `n≤0`/missing is treated as a single observation rather than zero, so
 * a reference with an unrecorded count is still shown at minimum strength rather
 * than dropped.
 */
export function evidenceAlpha(n: number): number {
  const effective = Number.isFinite(n) && n > 0 ? n : 1;
  const f = Math.min(1, Math.log1p(effective) / Math.log1p(EVIDENCE_N_REF));
  return EVIDENCE_ALPHA_MIN + (EVIDENCE_ALPHA_MAX - EVIDENCE_ALPHA_MIN) * f;
}

/** Bands sit behind the lines, so their fill is a fraction of the line opacity. */
export const BAND_FILL_SCALE = 0.35;

/**
 * Apply an alpha to a `#rrggbb`/`#rgb` hex colour, returning `rgba(...)`.
 *
 * Pure and self-contained (the chart's own `colorWithAlpha` is not exported and
 * handles hsl too; the category palette here is hex only). A colour that is not
 * hex is returned unchanged rather than guessed at.
 */
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  if (color.startsWith('#') && (color.length === 7 || color.length === 4)) {
    const normalized =
      color.length === 4
        ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
        : color;
    const r = parseInt(normalized.slice(1, 3), 16);
    const g = parseInt(normalized.slice(3, 5), 16);
    const b = parseInt(normalized.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  return color;
}

// --- Conversion (source matrix/unit → the chart's display matrix) ----------
// The blood/plasma arithmetic and the missing-ratio policy live in the shared
// `matrixDisplay` module, so this overlay, the postmortem-percentile overlay and
// the interpretive thresholds all convert the same way toward whichever matrix
// the chart is being shown in.

// --- Inputs / outputs ------------------------------------------------------

/** One source value (a `parameter_entries` row), reduced to what the overlay needs. */
export interface ForensicEntryInput {
  scenario: string | null;
  low: number | null;
  high: number | null;
  median: number | null;
  /** Censoring operator ('<' / '>' / '≤' / '≥') when the value is a threshold, else null. */
  qualifier: string | null;
  unit: string;
  matrix: string | null;
  n: number | null;
  /** Row provenance; a superseded `grandfathered` placeholder is dropped. */
  origin?: string | null;
  citationId: number | null;
  /** Short human label for the citation (rendered in the individual view). */
  citationLabel?: string | null;
}

export interface ForensicConversionContext {
  /** Unit the chart is displaying. */
  targetUnit: string;
  /** Matrix the chart is displaying (whole blood / serum / plasma). */
  displayMatrix: ChartMatrix;
  molecularWeight?: number | null;
  bloodPlasmaRatio?: NumericRange | number | null;
}

/** One contributing reference, converted onto the chart axis. */
export interface ForensicPoint {
  representative: number;
  n: number;
  citationId: number | null;
  citationLabel: string | null;
}

/** One category's pooled result, all values already in the target unit. */
export interface ForensicCategoryResult {
  category: ForensicCategoryId;
  color: string;
  /** Pooled span [low, high] across every contributing reference. */
  band: { low: number; high: number } | null;
  /** n-weighted median of the per-reference representatives. */
  representative: number | null;
  /** Σn across contributing references (the evidence behind the pooled band). */
  totalN: number;
  /** Number of distinct contributing references. */
  refCount: number;
  points: ForensicPoint[];
}

/**
 * Central estimate for one entry — a curated median, else the midpoint of a
 * two-sided interval. A LONE bound (`{ low: 10 }` = "≥ 10", not "= 10") has NO
 * central estimate and returns null, matching `parameterEntryAggregation`: its
 * bound is still shown in the band range but never plotted as an exact point or
 * pooled into the representative.
 */
function entryRepresentative(entry: ForensicEntryInput): number | null {
  if (entry.median != null && Number.isFinite(entry.median)) return entry.median;
  if (
    entry.low != null &&
    entry.high != null &&
    Number.isFinite(entry.low) &&
    Number.isFinite(entry.high)
  ) {
    return (entry.low + entry.high) / 2;
  }
  return null;
}

/**
 * Drop every grandfathered row — UNCONDITIONALLY, unlike the summary
 * aggregation's `dropSupersededGrandfathered` which keeps one as a last-resort
 * central estimate.
 *
 * The difference is the point of this overlay. A grandfathered row is a
 * synthetic placeholder migration 0078 mints to preserve an authored
 * `fatalConcentration` value, defaulting its matrix to `whole_blood` and its
 * scenario to `postmortem_mono_intox`. That default is a cache artifact, not an
 * autopsy measurement — so on a MEASURED-source-evidence overlay it is not
 * evidence at all, and presenting it as a mono-intoxication band with an
 * n-count would fabricate a finding no paper reported. The summary aggregation
 * keeps it because there it stands in for the authored value; here there is
 * nothing for it to stand in for.
 */
function dropGrandfathered(
  entries: readonly ForensicEntryInput[],
): readonly ForensicEntryInput[] {
  return entries.filter((e) => e.origin !== 'grandfathered');
}

/** Put a source value onto the chart's display matrix + unit, or null if it cannot be. */
function toAxisValue(
  value: number,
  entry: ForensicEntryInput,
  displayMatrix: ChartMatrix,
  ratio: number | null,
  target: ConcentrationUnit,
  mw: number | undefined,
): number | null {
  const source = entry.unit as ConcentrationUnit;
  const inMatrix = convertToDisplayMatrix(value, entry.matrix!, displayMatrix, ratio);
  if (inMatrix == null) return null;
  try {
    const out = convertConcentration(inMatrix, source, target, mw);
    return Number.isFinite(out) && out > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Whether an entry is a forensic, blood/plasma-matrix, uncensored concentration row. */
function isDrawableForensicRow(entry: ForensicEntryInput): boolean {
  return (
    isForensicCategory(entry.scenario) &&
    !entry.qualifier &&
    entry.matrix != null &&
    isConvertibleMatrix(entry.matrix) &&
    isConcentrationUnit(entry.unit)
  );
}

/**
 * Whether the drug has forensic rows that COULD be drawn but cannot be
 * converted onto the display axis — a plasma/serum value with no blood:plasma
 * ratio, or a molar value with no molecular weight. The rows are correctly
 * declined (never drawn at a guessed height), but the caller reports the gap so
 * the panel does not read identically to "no forensic data at all".
 */
export function hasUnconvertibleForensicRows(
  entries: readonly ForensicEntryInput[],
  ctx: ForensicConversionContext,
): boolean {
  const drawable = dropGrandfathered(entries).filter(
    (entry) =>
      isDrawableForensicRow(entry) &&
      [entry.median, entry.low, entry.high].some(
        (v) => v != null && Number.isFinite(v),
      ),
  );
  // A chart axis the overlay cannot target at all — the ethanol Widmark engine's
  // `g/dL`, say — makes every drawable row unshowable. Report it (rather than
  // returning silently) so the panel says the data exists but cannot be placed,
  // instead of looking like the drug has no forensic sources.
  if (!isConcentrationUnit(ctx.targetUnit)) return drawable.length > 0;
  const target = ctx.targetUnit as ConcentrationUnit;
  const mw = ctx.molecularWeight ?? undefined;
  const ratio = bloodPlasmaFactorOrNull(ctx.bloodPlasmaRatio ?? null);
  for (const entry of drawable) {
    const values = [entry.median, entry.low, entry.high].filter(
      (v): v is number => v != null && Number.isFinite(v),
    );
    const anyConverts = values.some(
      (v) => toAxisValue(v, entry, ctx.displayMatrix, ratio, target, mw) != null,
    );
    if (!anyConverts) return true;
  }
  return false;
}

/** Weighted median of `{ value, weight }` points. Returns null on an empty pool. */
function weightedMedian(
  points: readonly { value: number; weight: number }[],
): number | null {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, p) => s + p.weight, 0);
  if (total <= 0) return sorted[Math.floor((sorted.length - 1) / 2)]!.value;
  let cum = 0;
  for (const p of sorted) {
    cum += p.weight;
    if (cum >= total / 2) return p.value;
  }
  return sorted[sorted.length - 1]!.value;
}

/**
 * Reduce a drug's forensic source values into one result per category.
 *
 * Drops rows whose matrix cannot land on a blood axis, whose unit cannot be
 * converted (a molar row on a drug with no molecular weight), or whose scenario
 * is not one of the three forensic categories. Every kept row is normalised to
 * whole blood via the blood:plasma ratio and to the target display unit, so a
 * band and the curve beneath it are always in the same unit.
 *
 * Categories the settings turn off are skipped; a category with no usable data
 * is omitted from the result entirely rather than returned empty.
 */
export function buildForensicCategories(
  entries: readonly ForensicEntryInput[],
  ctx: ForensicConversionContext,
  settings: ForensicLineSettings,
): ForensicCategoryResult[] {
  if (!settings.enabled) return [];
  if (!isConcentrationUnit(ctx.targetUnit)) return [];
  const target = ctx.targetUnit as ConcentrationUnit;
  const mw = ctx.molecularWeight ?? undefined;
  const ratio = bloodPlasmaFactorOrNull(ctx.bloodPlasmaRatio ?? null);
  // A synthetic grandfathered placeholder is a cache artifact, never autopsy
  // evidence — dropped unconditionally for this measured-source overlay.
  const pool = dropGrandfathered(entries);

  const results: ForensicCategoryResult[] = [];

  for (const meta of FORENSIC_CATEGORIES) {
    if (!settings.categories[meta.id]) continue;

    const points: ForensicPoint[] = [];
    let bandLow: number | null = null;
    let bandHigh: number | null = null;
    let totalN = 0;
    // Every contributing row counts toward the reference total, including a
    // range-only row that draws a band but never becomes a representative
    // point. Cited rows are de-duplicated by citation id; uncited legacy rows
    // are each their own source and counted alongside — otherwise a category of
    // one cited + two uncited rows would report a single reference.
    const contributingCitationIds = new Set<number>();
    let uncitedRows = 0;

    for (const entry of pool) {
      if (entry.scenario !== meta.id) continue;
      if (!entry.matrix || !isConvertibleMatrix(entry.matrix)) continue;
      if (!isConcentrationUnit(entry.unit)) continue;
      // A censored threshold ("> 2000") is not a point observation: excluded
      // from the band and the representative, never drawn as a measurement —
      // the same rule the parameter-entry aggregation applies.
      if (entry.qualifier) continue;

      const toAxis = (value: number): number | null =>
        toAxisValue(value, entry, ctx.displayMatrix, ratio, target, mw);

      const rep = entryRepresentative(entry);
      const repAxis = rep != null ? toAxis(rep) : null;
      const lowAxis = entry.low != null ? toAxis(entry.low) : null;
      const highAxis = entry.high != null ? toAxis(entry.high) : null;

      // A row with nothing convertible contributes no line and no evidence.
      if (repAxis == null && lowAxis == null && highAxis == null) continue;

      const n = entry.n != null && entry.n > 0 ? entry.n : 1;
      totalN += n;
      if (entry.citationId != null) contributingCitationIds.add(entry.citationId);
      else uncitedRows += 1;

      for (const v of [repAxis, lowAxis, highAxis]) {
        if (v == null) continue;
        bandLow = bandLow == null ? v : Math.min(bandLow, v);
        bandHigh = bandHigh == null ? v : Math.max(bandHigh, v);
      }

      if (repAxis != null) {
        points.push({
          representative: repAxis,
          n,
          citationId: entry.citationId,
          citationLabel: entry.citationLabel ?? null,
        });
      }
    }

    if (points.length === 0 && bandLow == null) continue;

    const representative =
      points.length > 0
        ? weightedMedian(
            points.map((p) => ({ value: p.representative, weight: p.n })),
          )
        : null;

    results.push({
      category: meta.id,
      color: meta.color,
      band:
        bandLow != null && bandHigh != null
          ? { low: bandLow, high: bandHigh }
          : null,
      representative,
      totalN,
      refCount: contributingCitationIds.size + uncitedRows,
      // Strongest evidence drawn last so it sits on top in the individual view.
      points: points.sort((a, b) => a.n - b.n),
    });
  }

  return results;
}
