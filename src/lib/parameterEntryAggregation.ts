/**
 * Pure aggregation of multi-value parameter entries into a single summary.
 *
 * Each `parameter_entries` row is one source's reported value for one drug
 * parameter, in its own matrix and unit. This module collapses a set of those
 * entries into (a) a matrix-normalized central estimate + spread for the cached
 * `drug_parameters` value, and (b) a per-matrix breakdown for display.
 *
 * No database or I/O — everything here is deterministic and unit-tested.
 * Conversion reuses `convertConcentration` (unit) and mirrors the blood:plasma
 * scaling in `referenceConcentrationsOverlay` (matrix). Values are stored in
 * their source matrix/unit and converted here at read time, never at write.
 */
import type { NumericRange } from '../types/index.js';
import { representativeValue } from './rangeUtils.js';
import { convertParameterValue } from './parameterUnits.js';
import type { ReferenceMatrix } from './referenceConcentrations.js';
import {
  ARITHMETIC_INTERVAL_KINDS,
  entryCentralValue,
  roundToScale,
  storedScaleOf,
} from './entryDoseContext.js';

/** Matrices that convert to whole blood via the blood:plasma ratio. */
export const BLOOD_MATRICES: readonly ReferenceMatrix[] = [
  'serum',
  'plasma',
  'whole_blood',
];

/** One source value, reduced to the fields aggregation needs. */
export interface ParameterEntryValue {
  /**
   * `parameter_entries.id`. Not used by the arithmetic — it is carried through to
   * the summary point so the UI can tie a plotted marker back to the source row
   * it came from (hover one, highlight the other). Optional so the pure
   * aggregation entry point stays callable without a database row.
   */
  entryId?: number | null;
  citationId: number | null;
  low: number | null;
  high: number | null;
  median: number | null;
  /**
   * The labelled central estimate (`parameter_entries.central_value`), when
   * the source value states what its number is (mean, median, …). A labelled
   * entry stores its centre here INSTEAD of `median`, so it is read first —
   * see `entryCentralValue`. Optional so a caller without the column still
   * compiles; absent reads as unlabelled.
   */
  centralValue?: number | null;
  /**
   * What `low`/`high` are (`'sd'`, `'range'`, …), when stated. An arithmetic
   * interval (mean ± SD, a CI) is computed, not observed, so a bound it puts
   * outside the parameter's possible range is not a value any subject had
   * and is kept out of the pooled min/max (see `envelopeBound`).
   */
  intervalKind?: string | null;
  /**
   * Comparison operator ('<' | '>' | '≤' | '≥') when the source reports a
   * censored threshold rather than a point. Such entries are excluded from the
   * numeric pool (a "< 120" is not an observation at 120) but still shown
   * per-matrix.
   */
  qualifier: string | null;
  unit: string;
  matrix: ReferenceMatrix | null;
  /** Sample size, when reported. */
  n: number | null;
  /** paper_reviews.overall_score for this entry's citation, 0–100. */
  reviewScore: number | null;
  /**
   * Row provenance: 'legacy' / 'contributor' are real sources; 'grandfathered'
   * is a synthetic placeholder that preserves a migrated authored value while a
   * parameter has no real entries. Undefined is treated as a real source.
   */
  origin?: string | null;
  /**
   * The formulation the reading is of (#12): `parameter_entries.release_profile`
   * and `dose_interval_hours`. Entries pool only within one formulation — see
   * `formulationKey` and `selectPooledFormulation`. Optional so a caller with no
   * formulation columns (every parameter but the absorption ones) still
   * compiles; absent reads as "not stated", which is how every such row pooled
   * before.
   */
  releaseProfile?: string | null;
  doseIntervalHours?: number | null;
}

/** The formulation key of an entry that states none (the pre-#12 pool). */
export const UNSTATED_FORMULATION_KEY = '|';

/**
 * Which formulation an entry's reading is of, as a pooling key (#12): its
 * release profile and its dosing interval, so an immediate-release tablet, a
 * weekly depot (168 h) and a monthly one (~720 h) are three keys.
 *
 * A release profile of `'unknown'` is the source saying nothing, the same
 * information as no release profile at all, so the two share a key; any other
 * stated profile (`not_applicable` included) is its own. The interval is
 * compared at the column's scale, as stored.
 */
export function formulationKey(entry: {
  releaseProfile?: string | null;
  doseIntervalHours?: number | null;
}): string {
  const profile =
    entry.releaseProfile == null || entry.releaseProfile === 'unknown'
      ? ''
      : entry.releaseProfile;
  const interval =
    entry.doseIntervalHours == null || !Number.isFinite(entry.doseIntervalHours)
      ? ''
      : String(roundToScale(entry.doseIntervalHours, storedScaleOf('doseIntervalHours')));
  return `${profile}|${interval}`;
}

/** An immediate-release reading with no dosing interval: the conventional figure. */
const IMMEDIATE_RELEASE_KEY = 'immediate|';

/**
 * The one formulation whose entries a summary pools, given the keys of the
 * entries that COULD pool — or null when the choice is not the data's to make.
 *
 * Two formulations are never pooled together: an SL tablet and a monthly depot
 * of the same drug have nothing in common but the molecule, and their median
 * is a Tmax no product has. So the pool is one formulation's entries:
 *
 *   1. only one formulation present — that one (in particular, a drug whose
 *      entries state none pools exactly as it did before #12);
 *   2. otherwise the entries that state no formulation, when there are any —
 *      the pool the drug-level value has always meant, which a newly tagged
 *      reading must not move;
 *   3. otherwise an immediate-release reading with no dosing interval, the
 *      conventional single-dose figure;
 *   4. otherwise nothing: two stated formulations with no conventional one
 *      among them (a weekly and a monthly depot) pool to no value rather than
 *      to an arbitrary pick. Per-formulation values are #82's.
 */
export function selectPooledFormulation(keys: Iterable<string>): string | null {
  const distinct = new Set(keys);
  if (distinct.size === 0) return null;
  if (distinct.size === 1) return [...distinct][0]!;
  if (distinct.has(UNSTATED_FORMULATION_KEY)) return UNSTATED_FORMULATION_KEY;
  if (distinct.has(IMMEDIATE_RELEASE_KEY)) return IMMEDIATE_RELEASE_KEY;
  return null;
}

/**
 * A grandfathered row exists only to preserve an authored value while there are
 * no real sources. Once any real (non-grandfathered) entry exists, the synthetic
 * placeholder must not be pooled or displayed as an independent study — that
 * would double-count the evidence and advertise an artifact as a source.
 */
export function dropSupersededGrandfathered(
  entries: readonly ParameterEntryValue[],
): readonly ParameterEntryValue[] {
  const hasRealSource = entries.some((e) => e.origin !== 'grandfathered');
  return hasRealSource
    ? entries.filter((e) => e.origin !== 'grandfathered')
    : entries;
}

export interface AggregationContext {
  /** Canonical unit the summary is reported in. */
  targetUnit: string;
  bloodPlasmaRatio?: NumericRange | number | null;
  molecularWeight?: number | null;
  /**
   * Whether matrix is a meaningful dimension. When true, only blood-matrix
   * entries are pooled into the whole-blood summary (non-blood entries are
   * listed per-matrix but never normalized as if they were blood). When false,
   * every entry's representative is pooled directly with no matrix scaling.
   */
  matrixRelevant: boolean;
  /**
   * The range the parameter can take, in `targetUnit` (the registry's
   * `bounds`). An arithmetic interval's bound outside it is kept out of the
   * pooled min/max — see `envelopeBound`. Absent: no bound is filtered.
   */
  valueBounds?: { min: number; max: number };
}

export interface MatrixSummary {
  matrix: ReferenceMatrix;
  min: number | null;
  max: number | null;
  representative: number | null;
  /** Number of SOURCE entries in this matrix — not a biological sample size. */
  sourceCount: number;
  unit: string;
}

/**
 * One source entry normalized to the summary frame (whole blood for blood
 * matrices, unit-only otherwise). Lets the forest plot draw one interval per
 * source rather than a per-matrix envelope that implies evidence across gaps.
 */
export interface EntrySummaryPoint {
  matrix: ReferenceMatrix | null;
  low: number | null;
  high: number | null;
  representative: number | null;
  /** Set when the source is a censored threshold ('<' / '>' / '≤' / '≥'). */
  qualifier: string | null;
  citationId: number | null;
  /**
   * The `parameter_entries.id` this point was built from, when the caller
   * supplied it. Lets a plotted marker and its row in the source list identify
   * each other (they are ordered differently and a single citation can back
   * several entries, so the citation id alone is not a key).
   */
  entryId?: number | null;
  unit: string;
}

export interface ParameterSummary {
  /** Weighted median of the pooled (whole-blood-normalized) representatives. */
  representative: number | null;
  /** Weighted 25th/75th percentiles — the interquartile spread. */
  iqrLow: number | null;
  iqrHigh: number | null;
  /** Full min/max of the pooled representatives AND their interval bounds. */
  min: number | null;
  max: number | null;
  unit: string;
  /** Entries considered (all matrices). */
  entryCount: number;
  /** Entries that made it into the numeric pool (convertible blood entries). */
  pooledCount: number;
  contributingCitationIds: number[];
  byMatrix: MatrixSummary[];
  /** Per-source normalized intervals for the forest plot (one row each). */
  points: EntrySummaryPoint[];
  /**
   * The formulation the pool was drawn from (`formulationKey`'s two parts), or
   * null when it is the unstated one or nothing pooled. Optional so a summary
   * built before #12 (a cached client response) still type-checks.
   */
  pooledFormulation?: { releaseProfile: string | null; doseIntervalHours: number | null } | null;
  /**
   * Entries that would have pooled but are of a different formulation from the
   * pooled one (`selectPooledFormulation`), so were left out of the number.
   * They are still counted in `entryCount` and plotted in `points`.
   */
  formulationExcludedCount?: number;
  /**
   * True when the plotted/pooled values are matrix-normalized to whole blood
   * (matrixRelevant): a serum/plasma point's value is its whole-blood equivalent,
   * not the raw source reading, so the UI must label the frame to avoid implying
   * the source reported that number in its own matrix.
   */
  normalizedToWholeBlood: boolean;
}

/**
 * Weight floor for an entry with no review score: an un-reviewed entry still
 * counts at half the weight of a maximally-reviewed one of the same size.
 * Weight = n × (FLOOR + reviewScore/200), so score 0→×0.5, score 100→×1.0.
 * Exported so the formula is tunable and testable in one place.
 */
export const REVIEW_SCORE_WEIGHT_FLOOR = 0.5;

/**
 * Format an aggregate value for display without dropping precision on small,
 * potent-drug concentrations. Values ≥ 1 keep two decimals; sub-unit values use
 * two significant figures so e.g. 0.002 is not rounded to 0.
 */
export function formatSummaryValue(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  return Math.abs(v) >= 1
    ? String(Number(v.toFixed(2)))
    : String(Number(v.toPrecision(2)));
}

export function entryWeight(entry: ParameterEntryValue): number {
  const n = entry.n && entry.n > 0 ? entry.n : 1;
  const score = entry.reviewScore != null ? entry.reviewScore : 0;
  return n * (REVIEW_SCORE_WEIGHT_FLOOR + score / 200);
}

/**
 * Central estimate for one entry in its own matrix/unit — the curated centre
 * (labelled `centralValue`, else the legacy `median`), else
 * the midpoint of a two-sided interval. A LONE bound (only `low` or only `high`,
 * no median) has NO central estimate: `{ low: 10 }` means "≥ 10", not "= 10", so
 * treating its bound as an exact observation would bias the pooled weighted
 * median. Returns null in that case; the bound is still retained for display
 * (byMatrix min/max and the per-source forest-plot interval) but never pooled.
 */
export function entryRepresentative(entry: ParameterEntryValue): number | null {
  const central = entryCentralValue(entry);
  if (central != null) return central;
  if (entry.low != null && entry.high != null) return (entry.low + entry.high) / 2;
  return null;
}

/**
 * Whether an entry's bound, already normalized to the summary frame, may widen
 * the pooled min/max envelope. Every bound may, except an arithmetic
 * interval's bound (mean ± SD/SEM, a CI) that falls outside the range the
 * parameter can take: "0.3 ± 0.4 h" has a low of −0.1 h, which is arithmetic,
 * not a half-life anyone had, and pooled it would publish a negative minimum
 * on the drug's cached value. Judged against the parameter's declared bounds
 * (`AggregationContext.valueBounds`), not the sign of the centre — a logP CI
 * of −0.4 to 0.2 is a legitimate interval across zero. The per-source
 * interval (forest plot) still shows the bound as reported.
 */
function envelopeBound(
  entry: ParameterEntryValue,
  normalized: number | null,
  ctx: AggregationContext,
): number | null {
  if (normalized == null) return null;
  if (entry.intervalKind == null || !ARITHMETIC_INTERVAL_KINDS.has(entry.intervalKind)) {
    return normalized;
  }
  const bounds = ctx.valueBounds;
  if (bounds && (normalized < bounds.min || normalized > bounds.max)) return null;
  return normalized;
}

/** Resolve a blood:plasma ratio (scalar or NumericRange) to a positive scalar. */
export function bloodRatioScalar(
  bpr: NumericRange | number | null | undefined,
): number {
  if (typeof bpr === 'number') return Number.isFinite(bpr) && bpr > 0 ? bpr : 1;
  if (bpr && typeof bpr === 'object') {
    const rep = representativeValue(bpr);
    let resolved: number | null = null;
    if (rep != null) resolved = rep;
    else if (bpr.min != null && bpr.max != null) resolved = (bpr.min + bpr.max) / 2;
    else resolved = bpr.min ?? bpr.max ?? null;
    // A zero/negative ratio (e.g. an under-specified { min: 0 }) would collapse
    // every serum/plasma value to zero — fall back to identity instead.
    return resolved != null && resolved > 0 ? resolved : 1;
  }
  return 1;
}

function matrixToWholeBlood(
  value: number,
  matrix: ReferenceMatrix,
  ratio: number,
): number {
  // bloodPlasmaRatio = [blood]/[plasma], so blood = ratio × plasma/serum.
  if (matrix === 'serum' || matrix === 'plasma') return value * ratio;
  return value;
}

/** Convert a scalar to the target unit; null if not convertible (e.g. molar w/o MW). */
export function convertToTargetUnit(
  value: number,
  unit: string,
  ctx: AggregationContext,
): number | null {
  return convertParameterValue(
    value,
    unit,
    ctx.targetUnit,
    ctx.molecularWeight,
  );
}

/**
 * The weighted percentile every summary in the platform uses: sorted by value,
 * the first point where cumulative weight reaches `p` of the total — so a tie
 * at exactly 50% resolves DOWNWARD to a reported value, never to an
 * interpolated one. Exported so the Cmax summary calls this rather than a
 * second copy with its own tie semantics (Cmax dose-context RFC).
 */
export function weightedPercentile(
  points: readonly { value: number; weight: number }[],
  p: number,
): number | null {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, x) => s + x.weight, 0);
  if (total <= 0) return null;
  const target = p * total;
  let cum = 0;
  for (const pt of sorted) {
    cum += pt.weight;
    if (cum >= target) return pt.value;
  }
  return sorted[sorted.length - 1]!.value;
}

/**
 * Convert a bound to the target unit AND (for blood matrices) normalize it to
 * whole blood, so every plotted/pooled value shares one frame. Whole-blood and
 * non-blood matrices pass through matrixToWholeBlood unchanged.
 */
function normalizeBound(
  value: number,
  unit: string,
  matrix: ReferenceMatrix | null,
  ctx: AggregationContext,
  ratio: number,
): number | null {
  const converted = convertToTargetUnit(value, unit, ctx);
  if (converted == null) return null;
  if (!ctx.matrixRelevant || !matrix) return converted;
  return matrixToWholeBlood(converted, matrix, ratio);
}

function buildMatrixSummaries(
  entries: readonly ParameterEntryValue[],
  ctx: AggregationContext,
  ratio: number,
): MatrixSummary[] {
  const groups = new Map<ReferenceMatrix, ParameterEntryValue[]>();
  for (const e of entries) {
    if (!e.matrix) continue;
    const list = groups.get(e.matrix) ?? [];
    list.push(e);
    groups.set(e.matrix, list);
  }
  const out: MatrixSummary[] = [];
  for (const [matrix, list] of groups) {
    const bounds: number[] = [];
    const reps: number[] = [];
    for (const e of list) {
      // A censored threshold has no point marker — it must not draw an exact
      // circle at its bound; skip it from the numeric reduction (still counted).
      if (e.qualifier) continue;
      const lo =
        e.low != null
          ? envelopeBound(e, normalizeBound(e.low, e.unit, matrix, ctx, ratio), ctx)
          : null;
      const hi =
        e.high != null
          ? envelopeBound(e, normalizeBound(e.high, e.unit, matrix, ctx, ratio), ctx)
          : null;
      const rep = entryRepresentative(e);
      const repN =
        rep != null ? normalizeBound(rep, e.unit, matrix, ctx, ratio) : null;
      if (lo != null) bounds.push(lo);
      if (hi != null) bounds.push(hi);
      if (repN != null) {
        bounds.push(repN);
        reps.push(repN);
      }
    }
    out.push({
      matrix,
      min: bounds.length ? Math.min(...bounds) : null,
      max: bounds.length ? Math.max(...bounds) : null,
      representative: reps.length
        ? reps.slice().sort((a, b) => a - b)[Math.floor((reps.length - 1) / 2)]!
        : null,
      sourceCount: list.length,
      unit: ctx.targetUnit,
    });
  }
  return out.sort((a, b) => a.matrix.localeCompare(b.matrix));
}

/**
 * Aggregate a set of entries into a summary. Returns null for an empty set.
 * The numeric pool is matrix-normalized to whole blood (when matrixRelevant);
 * non-blood or unconvertible entries are omitted from the pool but still appear
 * in `byMatrix` and `entryCount`.
 */
export function aggregateEntries(
  rawEntries: readonly ParameterEntryValue[],
  ctx: AggregationContext,
): ParameterSummary | null {
  if (rawEntries.length === 0) return null;
  // Drop the synthetic grandfathered placeholder once real sources exist so it
  // is neither pooled nor shown as an independent study.
  const entries = dropSupersededGrandfathered(rawEntries);

  const ratio = bloodRatioScalar(ctx.bloodPlasmaRatio);
  // Representative points drive the weighted percentiles; the bounds set drives
  // the cached min/max so a documented interval (e.g. 10–30) is not collapsed to
  // its midpoint.
  const pool: { value: number; weight: number }[] = [];
  const bounds: number[] = [];
  const citationIds = new Set<number>();

  // The entries that could pool, before the formulation is chosen: which
  // formulation pools is decided among readings that would actually reach the
  // number, so a censored or unconvertible row cannot claim the pool for its
  // formulation and leave it empty.
  const candidates: { e: ParameterEntryValue; repN: number }[] = [];
  for (const e of entries) {
    // A censored threshold ("< 120") is not a point observation — keep it in
    // byMatrix but never pool its bound as an exact value.
    if (e.qualifier) continue;
    const rep = entryRepresentative(e);
    if (rep == null) continue;
    // Only blood matrices can be normalized to whole blood.
    if (ctx.matrixRelevant && (!e.matrix || !BLOOD_MATRICES.includes(e.matrix)))
      continue;

    const repN = normalizeBound(rep, e.unit, e.matrix, ctx, ratio);
    if (repN == null) continue;
    candidates.push({ e, repN });
  }
  // One formulation per pool (#12) — see `selectPooledFormulation`.
  const pooledKey = selectPooledFormulation(candidates.map(({ e }) => formulationKey(e)));
  let formulationExcludedCount = 0;

  for (const { e, repN } of candidates) {
    if (formulationKey(e) !== pooledKey) {
      formulationExcludedCount += 1;
      continue;
    }
    pool.push({ value: repN, weight: entryWeight(e) });
    bounds.push(repN);
    const loN =
      e.low != null
        ? envelopeBound(e, normalizeBound(e.low, e.unit, e.matrix, ctx, ratio), ctx)
        : null;
    const hiN =
      e.high != null
        ? envelopeBound(e, normalizeBound(e.high, e.unit, e.matrix, ctx, ratio), ctx)
        : null;
    if (loN != null) bounds.push(loN);
    if (hiN != null) bounds.push(hiN);
    // Attribute the aggregate only to citations that actually contributed to
    // the pooled number, not to excluded (non-blood / unconvertible) rows.
    if (e.citationId != null) citationIds.add(e.citationId);
  }

  return {
    representative: weightedPercentile(pool, 0.5),
    iqrLow: weightedPercentile(pool, 0.25),
    iqrHigh: weightedPercentile(pool, 0.75),
    min: bounds.length ? Math.min(...bounds) : null,
    max: bounds.length ? Math.max(...bounds) : null,
    unit: ctx.targetUnit,
    entryCount: entries.length,
    pooledCount: pool.length,
    contributingCitationIds: [...citationIds].sort((a, b) => a - b),
    byMatrix: buildMatrixSummaries(entries, ctx, ratio),
    points: buildEntryPoints(entries, ctx, ratio),
    pooledFormulation: describeFormulation(pooledKey),
    formulationExcludedCount,
    normalizedToWholeBlood: ctx.matrixRelevant,
  };
}

/** A pooled formulation key back as its two fields; null for the unstated one or none. */
function describeFormulation(
  key: string | null,
): { releaseProfile: string | null; doseIntervalHours: number | null } | null {
  if (key === null || key === UNSTATED_FORMULATION_KEY) return null;
  const [profile = '', interval = ''] = key.split('|');
  return {
    releaseProfile: profile === '' ? null : profile,
    doseIntervalHours: interval === '' ? null : Number(interval),
  };
}

function buildEntryPoints(
  entries: readonly ParameterEntryValue[],
  ctx: AggregationContext,
  ratio: number,
): EntrySummaryPoint[] {
  const points: EntrySummaryPoint[] = [];
  for (const e of entries) {
    const rep = entryRepresentative(e);
    const point: EntrySummaryPoint = {
      matrix: e.matrix,
      low: e.low != null ? normalizeBound(e.low, e.unit, e.matrix, ctx, ratio) : null,
      high: e.high != null ? normalizeBound(e.high, e.unit, e.matrix, ctx, ratio) : null,
      representative:
        rep != null ? normalizeBound(rep, e.unit, e.matrix, ctx, ratio) : null,
      qualifier: e.qualifier,
      citationId: e.citationId,
      entryId: e.entryId ?? null,
      unit: ctx.targetUnit,
    };
    if (point.low != null || point.high != null || point.representative != null) {
      points.push(point);
    }
  }
  // Order by matrix then value so the plot groups matrices and reads low→high.
  return points.sort((a, b) => {
    const ma = a.matrix ?? '';
    const mb = b.matrix ?? '';
    if (ma !== mb) return ma.localeCompare(mb);
    return (a.representative ?? a.low ?? a.high ?? 0) - (b.representative ?? b.low ?? b.high ?? 0);
  });
}

/**
 * Reduce a summary to the plain NumericRange cached on `drug_parameters`.
 * Full min/max preserve the range for existing consumers (drug-table sort,
 * simulator overlay); the weighted median is the central estimate. The richer
 * IQR / per-matrix data lives only on the read-time ParameterSummary.
 */
/**
 * Human-readable prefix for the cached value's `note` (display only). NOT used
 * to detect an aggregate cache — a hand-authored note could legitimately start
 * with this prose. Detection uses the structured `derivedFromEntries` marker
 * (see isAggregateCacheValue) so authored values are never misclassified and
 * cleared by a recompute.
 */
export const AGGREGATE_NOTE_PREFIX = 'Aggregated from';

export function isAggregateCacheValue(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { derivedFromEntries?: unknown }).derivedFromEntries === true
  );
}

export function summaryToNumericRange(
  summary: ParameterSummary,
): NumericRange | null {
  if (summary.pooledCount === 0 || summary.representative == null) return null;
  const note =
    summary.pooledCount === 1
      ? `${AGGREGATE_NOTE_PREFIX} 1 source entry`
      : `${AGGREGATE_NOTE_PREFIX} ${summary.pooledCount} source entries`;
  return {
    min: summary.min ?? undefined,
    max: summary.max ?? undefined,
    median: summary.representative,
    unit: summary.unit,
    note,
    // Structured provenance marker (not the note) so a later recompute can
    // safely distinguish this derived cache from a hand-authored value.
    derivedFromEntries: true,
  };
}
