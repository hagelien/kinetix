import type { DrugRow } from '@/lib/drugApi';
import { rangeToDistribution } from '@/lib/rangeUtils';
import type { InferencePriors } from './types';
import type { DistributionSpec } from '@/types/simulator';

// Bridges the live `drugs` table into KineLab's prior shape. The page picks
// an analyte; this helper fetches+converts the matching drug row into the
// `InferencePriors` shape `LiteBrowserEngine.infer()` already expects. By
// using `rangeToDistribution` (already proven in `simulatorStore.ts`), we
// inherit its handling of fixed / uniform / triangular cases for free.

// ─── Engine-supported analytes ──────────────────────────────────────────────
//
// `inference.ts` dispatches on the priors shape: `eliminationRate` selects
// the Widmark zero-order branch, `halfLife` selects first-order. The picker
// exposes one analyte per supported model family; `analyteModelType` below
// is the source of truth for which branch to use when building priors.
//
// Slug convention: each entry must match the slug `seed-drugs.ts` writes
// for the corresponding row in `data/components.ts`. That seeder slugifies
// `nameEn || name`, so every entry uses the English-derived slug: `ethanol`
// (not Norwegian `etanol`), `ketamine` (not `ketamin`) and `amphetamine`
// (not `amfetamin`). The production API confirms these — `?slug=ketamin`
// returns "Drug not found" while `?slug=ketamine` resolves — so the earlier
// Norwegian slugs silently failed the drug lookup / model-card match.

// ─── Curated tier vs. engine-ready tier ─────────────────────────────────────
//
// Two distinct notions of "supported" that were previously conflated:
//
//  • CURATED  — analytes that have been through a hand-validation pass and
//    (mostly) carry a bespoke `PKModelCard` with analyte-specific
//    assumptions/limitations. This is the short, deliberately-conservative
//    list below.
//
//  • ENGINE-READY — any component whose live drug row carries the priors the
//    engine actually consumes (half-life + Vd + F for first-order; Vd +
//    elimination-rate for the ethanol zero-order branch). The engine has
//    ALWAYS run on these — nothing gates a run on the curated list — so this
//    is the honest answer to "how many components can this engine run?".
//    Rather than hardcode it (the catalog is edited continuously), derive it
//    from the data with `hasEngineData` / see `engineCoverage.ts`.
//
// Keep the curated list around because it still names the analytes with
// validated cards, but treat `hasEngineData` as the source of truth for
// whether a given component can be run.

export const KINELAB_CURATED_ANALYTE_SLUGS = [
  'ketamine',
  'diazepam',
  'amphetamine',
  'ethanol',
] as const;

/** @deprecated Renamed to {@link KINELAB_CURATED_ANALYTE_SLUGS}. This is the
 *  hand-validated tier, NOT the set of components the engine can run — use
 *  {@link hasEngineData} for that. Kept as an alias for back-compat. */
export const KINELAB_SUPPORTED_ANALYTE_SLUGS = KINELAB_CURATED_ANALYTE_SLUGS;

export type KinelabSupportedAnalyteSlug =
  (typeof KINELAB_CURATED_ANALYTE_SLUGS)[number];

/** True for the hand-validated curated tier only. Does NOT mean "runnable" —
 *  see {@link hasEngineData}. */
export function isSupportedAnalyteSlug(
  slug: string,
): slug is KinelabSupportedAnalyteSlug {
  return (KINELAB_CURATED_ANALYTE_SLUGS as readonly string[]).includes(slug);
}

// ─── Engine-readiness predicates (data-driven) ──────────────────────────────

/** The subset of a drug row the engine's priors are built from. Accepts the
 *  static-catalog (`RangeData`), API (`NumericRange | null`) and runtime
 *  (`NumericRange | number | undefined`) shapes so one predicate serves the
 *  seed file, the live table, and the in-memory component alike. */
export interface EnginePriorFields {
  halfLife?: RangeLike | null;
  volumeOfDistribution?: RangeLike | null;
  bioavailability?: RangeLike | null;
}

type RangeLike =
  | number
  | {
      min?: number;
      max?: number;
      mean?: number;
      median?: number;
    };

function fieldHasData(field: RangeLike | null | undefined): boolean {
  if (field == null) return false;
  if (typeof field === 'number') return Number.isFinite(field);
  return (
    Number.isFinite(field.median) ||
    Number.isFinite(field.mean) ||
    Number.isFinite(field.min) ||
    Number.isFinite(field.max)
  );
}

/** True when the row carries every prior the first-order Bayes branch needs
 *  (half-life + Vd + F) without falling back to a synthesized default. This
 *  is the "clean run, oral or IV" tier. */
export function hasFirstOrderEngineData(drug: EnginePriorFields): boolean {
  return (
    fieldHasData(drug.halfLife) &&
    fieldHasData(drug.volumeOfDistribution) &&
    fieldHasData(drug.bioavailability)
  );
}

/** True when the row can drive a clean IV run: F is fixed at 1.0 for IV, so
 *  only half-life + Vd are required. Superset of {@link hasFirstOrderEngineData}. */
export function hasIvEngineData(drug: EnginePriorFields): boolean {
  return fieldHasData(drug.halfLife) && fieldHasData(drug.volumeOfDistribution);
}

/** True when the component has the data to run the engine on the given route
 *  without synthesizing missing priors. Zero-order (ethanol) is handled by its
 *  own literature-derived prior and needs only a Vd path, so it is always
 *  engine-ready. */
export function hasEngineData(
  drug: EnginePriorFields,
  opts: { modelType?: DrugPriorModelType; isIv?: boolean } = {},
): boolean {
  if (opts.modelType === 'zero_order') return true;
  return opts.isIv ? hasIvEngineData(drug) : hasFirstOrderEngineData(drug);
}

/** Maps an analyte slug to the engine model family it dispatches against.
 *  Driving prior-shape selection from this map (rather than scattered
 *  `slug === 'ethanol'` checks in callers) keeps the parameter shape and
 *  the engine dispatch in `inference.ts` aligned through one source. */
export function analyteModelType(
  slug: KinelabSupportedAnalyteSlug,
): DrugPriorModelType {
  return slug === 'ethanol' ? 'zero_order' : 'first_order';
}

/** Mirrors the engine-side `deriveModelType` in `inference.ts`: presence of
 *  `eliminationRate` is the explicit zero-order signal. Used by the
 *  KineLab page so that a saved case whose `input.analyte` is `etanol`
 *  but whose `input.priors` are still first-order-shaped renders the
 *  correct form (and emits a schema-valid payload) on rerun. The page
 *  uses `analyteModelType(slug)` as a fallback before priors load, so
 *  the picker selection still drives the initial form render. */
export function priorsToModelType(
  priors: InferencePriors,
): DrugPriorModelType {
  if (priors.eliminationRate) return 'zero_order';
  return 'first_order';
}

// ─── Engine-side fallbacks for missing fields ──────────────────────────────
//
// When a drug row is missing one of the priors we need, fall back to a
// generic value rather than failing the inference outright. The summary
// flags the fallback so the user sees the prior was synthesized.

const FALLBACKS = {
  halfLifeHours: 4,
  vdLitres: 100,
  bioavailability: 0.5,
} as const;

/** Typical-adult body weight (kg) used to scale an `L/kg` Vd row to litres when
 *  the subject panel supplies no weight. Keeps the Vd order-of-magnitude
 *  correct — treating the per-kilogram numbers as litres was off by roughly a
 *  body weight (e.g. morphine's 4 L/kg read as 4 L instead of ~280 L) — while
 *  the `fallback` provenance tag flags that a default weight was assumed. */
const DEFAULT_SUBJECT_WEIGHT_KG = 70;

// Literature defaults for the ethanol zero-order branch. The forensic
// Widmark range is roughly 0.10–0.20 g/L/h for adults; KineLab works in
// mg/L/h, so the prior is uniform(100, 200). The Vd fallback range is
// used only when the subject panel is empty; with weight + sex the
// engine prefers the Widmark `r·weight` calculation (see
// `WIDMARK_R_FACTORS`).
const ETHANOL_DEFAULTS = {
  /** mg/L per hour. */
  eliminationRateLow: 100,
  eliminationRateHigh: 200,
  /** Litres. Conservative adult range absent a per-case Widmark calc. */
  vdLow: 35,
  vdHigh: 70,
} as const;

// Widmark distribution-ratio constants (`r`, dimensionless) used to
// compute Vd = r · weight (litres) on the zero-order branch when the
// subject panel supplies a weight and sex. Values are the canonical
// Widmark/Watson averages widely used in forensic toxicology; the
// `unknown` band covers the male–female span as a uniform when the
// reporter has not recorded sex.
const WIDMARK_R_FACTORS = {
  male: 0.68,
  female: 0.55,
  /** Uniform spans both sexes when sex is unspecified. */
  unknownLow: 0.55,
  unknownHigh: 0.68,
} as const;

// ─── Output shape ───────────────────────────────────────────────────────────

/** Per-prior provenance so the UI can label what came from drugs DB vs a
 *  fallback. The page renders this in the read-only summary panel. */
export type PriorSource = 'drug-db' | 'fallback';

export interface PriorSummaryEntry {
  source: PriorSource;
  /** Pre-formatted display string, e.g. "2.0 – 3.5 h" for a uniform range or
   *  "210 L" for a single value. The renderer keeps the formatter in one
   *  place to avoid drift between this helper and the panel. */
  display: string;
}

export interface PriorSummary {
  /** Filled for first-order analytes; placeholder ("—") for ethanol where
   *  half-life is not the elimination parameter. The panel rendering in
   *  phase 2f-2 will skip this row when the analyte is zero-order. */
  halfLife: PriorSummaryEntry;
  vd: PriorSummaryEntry;
  /** Filled for first-order analytes; placeholder for ethanol (Widmark
   *  assumes complete oral absorption, so F is not a free parameter). */
  f: PriorSummaryEntry;
  /** Only set for zero-order analytes (ethanol today). */
  eliminationRate?: PriorSummaryEntry;
}

export interface DrugDerivedPriors {
  /** What `LiteBrowserEngine.infer()` consumes. The `dose` field is left as
   *  a placeholder — the caller fills it from its own form. */
  priors: InferencePriors;
  /** What the read-only summary panel renders. */
  summary: PriorSummary;
}

// ─── Main entry point ──────────────────────────────────────────────────────

/** Per-analyte PK family. Drives which priors are emitted: first-order
 *  needs halfLife + Vd + F; zero-order needs eliminationRate + Vd. */
export type DrugPriorModelType = 'first_order' | 'zero_order';

/** Subset of `subjectSchema` (`age` / `sex` / `weightKg`) that drug-priors
 *  consume. Age is forensic metadata only — neither Vd branch reads it.
 *  Sex steers the Widmark `r` factor on the zero-order branch; weight
 *  steers both Widmark r·weight and L/kg → litres scaling on the
 *  first-order branch. Both fields are optional so the page can pass
 *  whatever the operator has typed without a pre-validation step. */
export interface SubjectInfoForPriors {
  weightKg?: number;
  sex?: 'male' | 'female' | 'unknown';
}

export function buildPriorsFromDrug(
  drug: DrugRow,
  isIv: boolean,
  modelType: DrugPriorModelType = 'first_order',
  subject?: SubjectInfoForPriors,
): DrugDerivedPriors {
  if (modelType === 'zero_order') {
    return buildZeroOrderPriors(drug, subject);
  }
  return buildFirstOrderPriors(drug, isIv, subject);
}

function buildFirstOrderPriors(
  drug: DrugRow,
  isIv: boolean,
  subject?: SubjectInfoForPriors,
): DrugDerivedPriors {
  const halfLifePresent = hasUsableRange(drug.halfLife);
  const fPresent = hasUsableRange(drug.bioavailability);

  const halfLife = rangeToDistribution(drug.halfLife, FALLBACKS.halfLifeHours);
  const { spec: vd, source: vdSource } = resolveFirstOrderVd(
    drug.volumeOfDistribution,
    subject?.weightKg,
  );
  // For IV, bioavailability is fixed at 1.0 in the engine path anyway, so we
  // short-circuit the prior to a deterministic 1 and skip the fallback
  // warning for missing F. (See LiteBrowserEngine.simulate `isIv` branch.)
  const f = isIv
    ? ({ type: 'fixed', value: 1 } as const)
    : rangeToDistribution(drug.bioavailability, FALLBACKS.bioavailability);

  // Dose remains a user-supplied prior (the dose is what we're inferring
  // about) — keep it absent here. The page reads it from its own form
  // fields and assembles the full `InferencePriors` object.
  const priors: InferencePriors = {
    dose: { type: 'fixed', value: 0 }, // placeholder; overwritten by caller
    halfLife,
    vd,
    f,
  };

  const summary: PriorSummary = {
    halfLife: {
      source: halfLifePresent ? 'drug-db' : 'fallback',
      display: formatDistribution(halfLife, 'h'),
    },
    vd: {
      source: vdSource,
      display: formatDistribution(vd, 'L'),
    },
    f: {
      // For IV we mark F as drug-db (it's deterministic by route) so the UI
      // doesn't paint a misleading "fallback" tag.
      source: isIv ? 'drug-db' : fPresent ? 'drug-db' : 'fallback',
      display: formatDistribution(f, ''),
    },
  };

  return { priors, summary };
}

/** Resolve the Vd prior + provenance for the first-order branch.
 *
 *  The seeded drug rows (ketamine, diazepam, amphetamine) all carry Vd
 *  in `L/kg`, but `rangeToDistribution` drops the unit on the floor — so
 *  pre-2g the engine was treating per-kilogram numbers as litres
 *  directly, off by a body-weight factor. With a subject weight in
 *  hand, we scale the L/kg range to litres; without one, we fall back
 *  to the rough fixed Vd default and tag the row `fallback` so the
 *  panel surfaces the synthesis. Litre-typed and unit-less rows are
 *  used as-is (those are the cases the legacy engine got right). */
function resolveFirstOrderVd(
  range: import('@/types').NumericRange | null,
  weightKg: number | undefined,
): { spec: DistributionSpec; source: PriorSource } {
  if (!range || !hasUsableRange(range)) {
    return {
      spec: { type: 'fixed', value: FALLBACKS.vdLitres },
      source: 'fallback',
    };
  }
  const unit = range.unit;
  if (unit === 'L/kg') {
    if (weightKg && weightKg > 0) {
      return {
        spec: rangeToDistribution(
          scaleNumericRange(range, weightKg),
          FALLBACKS.vdLitres,
        ),
        source: 'drug-db',
      };
    }
    // No subject weight: scale by an explicit typical-adult default weight
    // rather than silently treating the per-kilogram numbers as litres. The
    // old behaviour was off by ~a body weight (e.g. morphine 4 L/kg read as
    // 4 L instead of ~280 L). The `fallback` tag flags that a weight was
    // assumed; supply a subject weight to remove the assumption.
    return {
      spec: rangeToDistribution(
        scaleNumericRange(range, DEFAULT_SUBJECT_WEIGHT_KG),
        FALLBACKS.vdLitres,
      ),
      source: 'fallback',
    };
  }
  return {
    spec: rangeToDistribution(range, FALLBACKS.vdLitres),
    source: 'drug-db',
  };
}

function scaleNumericRange(
  range: import('@/types').NumericRange,
  factor: number,
): import('@/types').NumericRange {
  return {
    ...range,
    mean: Number.isFinite(range.mean) ? range.mean! * factor : range.mean,
    median: Number.isFinite(range.median) ? range.median! * factor : range.median,
    min: Number.isFinite(range.min) ? range.min! * factor : range.min,
    max: Number.isFinite(range.max) ? range.max! * factor : range.max,
  };
}

function buildZeroOrderPriors(
  drug: DrugRow,
  subject?: SubjectInfoForPriors,
): DrugDerivedPriors {
  // Ethanol's drugs row is unlikely to carry a queryable `eliminationRate`
  // field, and the literature is consistent enough that a uniform(100, 200)
  // mg/L/h prior is more honest than synthesizing one from per-row data.
  // If a future schema migration adds an explicit ethanol-rate column,
  // swap it in here.
  const eliminationRate = {
    type: 'uniform' as const,
    min: ETHANOL_DEFAULTS.eliminationRateLow,
    max: ETHANOL_DEFAULTS.eliminationRateHigh,
  };
  // Vd dispatch (priority order):
  //  1. Subject-driven Widmark r·weight (sex-aware) when the operator
  //     supplied a positive body weight. Authoritative — this is the
  //     canonical forensic Vd estimate for ethanol.
  //  2. Drug-row Vd in litres, used as-is. Reaches this branch only on
  //     synthetic / future data where the row stores Vd in litres
  //     instead of the seeded L/kg shape.
  //  3. Hardcoded typical-adult Widmark fallback range (35–70 L) when
  //     neither subject info nor a usable litre row is available.
  const { spec: vd, source: vdSource } = resolveZeroOrderVd(
    drug.volumeOfDistribution,
    subject,
  );

  const priors: InferencePriors = {
    dose: { type: 'fixed', value: 0 }, // placeholder; overwritten by caller
    vd,
    eliminationRate,
    // halfLife / f intentionally omitted — the engine's zero-order
    // dispatch reads `eliminationRate` and never touches them.
  };

  const HL_PLACEHOLDER = { type: 'fixed' as const, value: 0 };
  const summary: PriorSummary = {
    halfLife: {
      // The first-order PriorSummary fields stay in the shape so the
      // panel can render zero-order analytes through one summarizer.
      // Sourced as 'drug-db' to suppress the "fallback" tag — a missing
      // half-life isn't a fallback for an analyte that doesn't have one.
      source: 'drug-db',
      display: formatDistribution(HL_PLACEHOLDER, 'h'),
    },
    vd: {
      source: vdSource,
      display: formatDistribution(vd, 'L'),
    },
    f: {
      source: 'drug-db',
      display: formatDistribution({ type: 'fixed', value: 1 }, ''),
    },
    eliminationRate: {
      source: 'fallback',
      display: formatDistribution(eliminationRate, 'mg/L/h'),
    },
  };

  return { priors, summary };
}

/** Resolve the Vd prior + provenance for the zero-order (Widmark)
 *  branch. The Widmark r·weight calculation is the canonical forensic
 *  approach when subject weight + sex are known; it tags as `drug-db`
 *  even though it's computed (not read from the drug row) because it's
 *  more authoritative than the literature fallback range. Sex-unknown
 *  collapses to a uniform spanning male–female r factors. */
function resolveZeroOrderVd(
  range: import('@/types').NumericRange | null,
  subject?: SubjectInfoForPriors,
): { spec: DistributionSpec; source: PriorSource } {
  const weightKg = subject?.weightKg;
  if (weightKg && weightKg > 0) {
    const sex = subject?.sex ?? 'unknown';
    if (sex === 'male') {
      return {
        spec: { type: 'fixed', value: WIDMARK_R_FACTORS.male * weightKg },
        source: 'drug-db',
      };
    }
    if (sex === 'female') {
      return {
        spec: { type: 'fixed', value: WIDMARK_R_FACTORS.female * weightKg },
        source: 'drug-db',
      };
    }
    return {
      spec: {
        type: 'uniform',
        min: WIDMARK_R_FACTORS.unknownLow * weightKg,
        max: WIDMARK_R_FACTORS.unknownHigh * weightKg,
      },
      source: 'drug-db',
    };
  }
  const vdUnit = range?.unit;
  const vdInLitres =
    !!range && hasUsableRange(range) && (vdUnit === 'L' || vdUnit == null);
  if (vdInLitres) {
    return {
      spec: rangeToDistribution(range, FALLBACKS.vdLitres),
      source: 'drug-db',
    };
  }
  return {
    spec: {
      type: 'uniform',
      min: ETHANOL_DEFAULTS.vdLow,
      max: ETHANOL_DEFAULTS.vdHigh,
    },
    source: 'fallback',
  };
}

/**
 * Synthesize a `PriorSummary` from an already-built `InferencePriors` object.
 * Used when a saved case is loaded — its `caseData.input.priors` is already
 * stored as `DistributionSpec`s, so we don't need to re-fetch the drug to
 * render the read-only panel. All sources are tagged `drug-db` because the
 * original save flow only persists drug-DB-derived priors today (a fallback
 * value would have been re-rendered as drug-db at save time anyway, and
 * we're not adding stricter provenance until a fallback ever ships).
 *
 * The summarizer dispatches on priors shape, mirroring `inference.ts`'s own
 * `deriveModelType`: a saved case with `priors.eliminationRate` is rendered
 * as a zero-order summary; otherwise first-order. Without the dispatch, a
 * loaded ethanol case would render its half-life row as "0 h" because the
 * zero-order priors don't carry a half-life at all.
 */
export function summarizePriors(
  priors: InferencePriors,
  isIv: boolean,
): PriorSummary {
  if (priors.eliminationRate) {
    const HL_PLACEHOLDER = { type: 'fixed' as const, value: 0 };
    // Zero-order priors carry no provenance metadata in the saved input
    // (`InferencePriors` is just a `DistributionSpec` per field), so we
    // cannot tell on load whether the saved Vd came from a drug row in
    // litres or from `buildZeroOrderPriors`'s L/kg fallback range
    // (35–70 L). Likewise, the literature elimination-rate prior is
    // ALWAYS synthesized today (no drug row carries an
    // `eliminationRate` column). Tag both as `fallback` so reloads
    // don't silently drop the warning that fresh-run summaries show
    // for the same calculation inputs. The trade-off: a user who
    // explicitly entered a Vd matching the drug-row value sees a
    // `fallback` tag — strictly worse than `drug-db` would be in that
    // narrow case, but better than silently hiding synthesis when the
    // priors were genuinely synthesized. Restoring strict provenance
    // requires persisting the source tags alongside the priors —
    // deferred to the case-data schema bump that adds subject panel.
    return {
      halfLife: {
        source: 'drug-db',
        display: formatDistribution(HL_PLACEHOLDER, 'h'),
      },
      vd: { source: 'fallback', display: formatDistribution(priors.vd, 'L') },
      f: {
        source: 'drug-db',
        display: formatDistribution({ type: 'fixed', value: 1 }, ''),
      },
      eliminationRate: {
        source: 'fallback',
        display: formatDistribution(priors.eliminationRate, 'mg/L/h'),
      },
    };
  }
  const HL_PLACEHOLDER = { type: 'fixed' as const, value: 0 };
  return {
    halfLife: {
      source: 'drug-db',
      display: priors.halfLife
        ? formatDistribution(priors.halfLife, 'h')
        : formatDistribution(HL_PLACEHOLDER, 'h'),
    },
    vd: { source: 'drug-db', display: formatDistribution(priors.vd, 'L') },
    f: {
      source: 'drug-db',
      display: formatDistribution(
        isIv ? { type: 'fixed', value: 1 } : (priors.f ?? { type: 'fixed', value: 1 }),
        '',
      ),
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** True when the NumericRange has at least one finite numeric field
 *  rangeToDistribution can use. Mirrors `hasRangeData` from `rangeUtils.ts`
 *  but inlined here so we don't depend on its private export. */
function hasUsableRange(range: import('@/types').NumericRange | null): boolean {
  if (!range) return false;
  return (
    Number.isFinite(range.median) ||
    Number.isFinite(range.mean) ||
    Number.isFinite(range.min) ||
    Number.isFinite(range.max)
  );
}

function formatDistribution(
  d:
    | { type: 'fixed'; value: number }
    | { type: 'uniform'; min: number; max: number }
    | { type: 'triangular'; min: number; mode: number; max: number }
    | { type: 'lognormal'; mu: number; sigma: number },
  unit: string,
): string {
  const u = unit ? ` ${unit}` : '';
  switch (d.type) {
    case 'fixed':
      return `${formatNumber(d.value)}${u}`;
    case 'uniform':
      return `${formatNumber(d.min)} – ${formatNumber(d.max)}${u}`;
    case 'triangular':
      return `${formatNumber(d.min)} – ${formatNumber(d.max)}${u}, mode ${formatNumber(d.mode)}`;
    case 'lognormal':
      return `LN(${formatNumber(d.mu)}, ${formatNumber(d.sigma)})${u}`;
  }
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) < 0.01 && value !== 0) return value.toExponential(2);
  if (Math.abs(value) < 1) return value.toFixed(3);
  if (Math.abs(value) < 100) return value.toFixed(2);
  return Math.round(value).toLocaleString();
}
