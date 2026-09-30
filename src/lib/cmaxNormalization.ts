/**
 * Dose-normalized Cmax — the pure normalizer and the stratified summary
 * (Cmax dose-context RFC, *Derived normalization* and *Aggregation*).
 *
 * Nothing here is persisted: a normalized Cmax is derived at read time from
 * the stored source entries, so a better ratio, molecular weight or rule
 * changes every derived number at once and no stale copy survives.
 *
 * Every entry gets exactly one outcome:
 *   - `ineligible` — no normalized value exists; the raw entry is shown with
 *     the reason;
 *   - `normalized_not_poolable` — a real normalized value, shown, but never in
 *     a summary (exactly four reasons: an unstated dose level, an unnamed salt,
 *     a censored threshold, no central value);
 *   - `poolable` — the only input the summary accepts.
 * Nothing is ever resolved by a default: no midpoint for a missing centre or
 * a dose range, no ratio of 1 for a missing blood:plasma ratio, no inferred
 * salt, route, fed state or population.
 *
 * Reuses the repository's own contracts rather than restating them — the RFC's
 * most repeated defect was restating one wrongly: `convertToDisplayMatrix` for
 * the blood ↔ plasma arithmetic (plasma = blood / r), `entryWeight` for the
 * weight and `weightedPercentile` for the median and its downward tie-break.
 */
import {
  convertConcentration,
  isConcentrationUnit,
  type ConcentrationUnit,
} from './unitConversion.js';
import { convertToDisplayMatrix, isConvertibleMatrix, isBloodLikeMatrix } from './matrixDisplay.js';
import { entryWeight, weightedPercentile } from './parameterEntryAggregation.js';
import {
  doseNormalizedDenominator,
  doseUnitFamily,
  type CentralStatistic,
  type DoseContextFields,
  type IntervalKind,
} from './entryDoseContext.js';

/** The canonical frame: plasma, µmol/L per mg (or per mg/kg). Fixed once (RFC). */
export const CMAX_TARGET_MATRIX = 'plasma' as const;
export const CMAX_CANONICAL_CONCENTRATION: ConcentrationUnit = 'µmol/L';

export type IneligibilityReason =
  | 'dose_range_without_exact_dose'
  | 'missing_dose'
  | 'missing_route'
  | 'unresolved_route'
  | 'missing_matrix_conversion'
  | 'unsupported_matrix_conversion'
  | 'bounds_only_matrix_ratio'
  | 'unsourced_matrix_ratio'
  | 'censored_matrix_ratio'
  | 'missing_molecular_weight'
  | 'incompatible_dose_family'
  | 'unknown_dose_regimen'
  | 'unresolved_exposure_state'
  | 'unsupported_regimen_context'
  | 'unknown_iv_input_mode'
  | 'unknown_formulation'
  | 'unknown_prandial_state'
  | 'missing_dosing_interval'
  | 'interaction_arm_not_pooled'
  | 'unknown_coadministration_state'
  | 'altered_population_not_pooled'
  | 'unknown_population'
  | 'unknown_dose_basis'
  | 'unspecified_salt_form'
  | 'unstated_dose_level'
  | 'missing_central_value'
  | 'censored_value'
  | 'unlabelled_statistic';

/** The four reasons that leave a real normalized value visible but unpooled. */
export const NOT_POOLABLE_REASONS = [
  'unstated_dose_level',
  'unspecified_salt_form',
  'censored_value',
  'missing_central_value',
] as const satisfies readonly IneligibilityReason[];

export type DoseStratum =
  | { kind: 'exact'; value: number; unit: 'mg' | 'mg/kg' }
  | { kind: 'range'; low: number; high: number; unit: 'mg' | 'mg/kg' }
  | { kind: 'unstated'; unit: 'mg' | 'mg/kg' };

/** A stored Cmax source entry, as the normalizer reads it. */
export interface CmaxSourceEntry {
  entryId: number;
  low: number | null;
  high: number | null;
  median: number | null;
  qualifier: string | null;
  unit: string;
  matrix: string | null;
  route: string | null;
  n: number | null;
  reviewScore: number | null;
  citationId: number | null;
  doseContext: DoseContextFields;
}

export interface DoseNormalizedEntry {
  entryId: number;
  normalizedLow?: number;
  normalizedHigh?: number;
  /** The normalized central value; what it IS is `centralStatistic`. Never a midpoint. */
  normalizedCentralValue?: number;
  normalizedUnit: string;
  normalizedMatrix: typeof CMAX_TARGET_MATRIX;
  doseStratum: DoseStratum;
  doseBasis: string | null;
  doseSaltForm: string | null;
  /** Null when there is nothing to label, or the value is a censored threshold. */
  centralStatistic: CentralStatistic | null;
  intervalKind: IntervalKind | null;
  qualifier: string | null;
  n: number | null;
  reviewScore: number | null;
  citationId: number | null;
  route: string;
  releaseProfile: string;
  physicalForm: string;
  prandialState: string | null;
  coadministrationState: string;
  pkPopulation: string;
  valueBasis: string;
  regimen: string;
  doseIntervalHours: number | null;
  doseNumber: number | null;
  regimenDurationHours: number | null;
  priorDosingRegular: boolean | null;
  ivInputMode: string | null;
  administrationDurationMin: number | null;
  administeredDrugId: number;
}

export type PoolableEntry = DoseNormalizedEntry & {
  normalizedCentralValue: number;
  centralStatistic: CentralStatistic;
};

export type NormalizationOutcome =
  | { kind: 'ineligible'; entryId: number; reason: IneligibilityReason }
  | { kind: 'normalized_not_poolable'; entry: DoseNormalizedEntry; reason: IneligibilityReason }
  | { kind: 'poolable'; entry: PoolableEntry };

// ─── The blood:plasma ratio ─────────────────────────────────────────────────

/** A `bloodPlasmaRatio` source entry, as the ratio resolver reads it. */
export interface RatioSourceEntry {
  median: number | null;
  centralValue?: number | null;
  low: number | null;
  high: number | null;
  qualifier: string | null;
  n: number | null;
  reviewScore: number | null;
  citationId: number | null;
  origin: string;
}

export type RatioResolution =
  | { ratio: number }
  | {
      reason:
        | 'unsourced_matrix_ratio'
        | 'bounds_only_matrix_ratio'
        | 'censored_matrix_ratio'
        | 'missing_matrix_conversion';
    };

/**
 * The drug's blood:plasma ratio for a Cmax conversion, from SOURCE ENTRIES —
 * never the cached drug-level scalar, which may hold a midpoint the aggregate
 * invented (RFC: "the ratio must be source-backed, not merely numeric").
 *
 * An entry qualifies when it is sourced (a citation, not a grandfathered
 * placeholder), reports its own central value, that value is finite and
 * positive, and it is not a censored threshold. Several qualify → their
 * `entryWeight`-weighted median. None → the reason says which of the four ways
 * the evidence fell short; no factor of 1 is ever substituted.
 */
export function resolveBloodPlasmaRatio(entries: readonly RatioSourceEntry[]): RatioResolution {
  const sourced = entries.filter((e) => e.citationId != null && e.origin !== 'grandfathered');
  if (sourced.length === 0) return { reason: 'unsourced_matrix_ratio' };
  const points: { value: number; weight: number }[] = [];
  let censored = 0;
  let boundsOnly = 0;
  for (const e of sourced) {
    const centre = e.centralValue ?? e.median;
    if (centre == null) {
      if (e.low != null || e.high != null) boundsOnly += 1;
      continue;
    }
    if (e.qualifier) {
      censored += 1;
      continue;
    }
    if (!Number.isFinite(centre) || centre <= 0) continue;
    points.push({ value: centre, weight: entryWeight(e as never) });
  }
  if (points.length > 0) {
    const ratio = weightedPercentile(points, 0.5);
    if (ratio != null && ratio > 0) return { ratio };
  }
  if (boundsOnly > 0 && censored === 0) return { reason: 'bounds_only_matrix_ratio' };
  if (censored > 0) return { reason: 'censored_matrix_ratio' };
  return { reason: 'missing_matrix_conversion' };
}

// ─── The normalizer ─────────────────────────────────────────────────────────

export interface CmaxNormalizationContext {
  /** g/mol; needed to express a mass concentration in µmol/L. */
  molecularWeight: number | null;
  /** From `resolveBloodPlasmaRatio`; consulted only for a blood ↔ plasma crossing. */
  bloodPlasma: RatioResolution;
}

const DOSE_TO_CANONICAL: Record<string, { factor: number; unit: 'mg' | 'mg/kg' }> = {
  µg: { factor: 0.001, unit: 'mg' },
  mg: { factor: 1, unit: 'mg' },
  g: { factor: 1000, unit: 'mg' },
  'µg/kg': { factor: 0.001, unit: 'mg/kg' },
  'mg/kg': { factor: 1, unit: 'mg/kg' },
};

function ineligible(entryId: number, reason: IneligibilityReason): NormalizationOutcome {
  return { kind: 'ineligible', entryId, reason };
}

/**
 * Normalize one Cmax entry to plasma µmol/L per canonical dose unit, or say
 * exactly why not. Checks run in a fixed order, so the reason an entry shows
 * is deterministic when several apply.
 */
export function normalizeCmaxEntry(
  entry: CmaxSourceEntry,
  ctx: CmaxNormalizationContext,
): NormalizationOutcome {
  const dc = entry.doseContext;
  const id = entry.entryId;
  const centre = dc.centralValue ?? entry.median ?? null;
  const hasBounds = entry.low != null || entry.high != null;
  const statistic = dc.centralStatistic ?? (dc.centralValue == null && entry.median != null ? 'median' : null);

  // What the number is.
  if (!dc.valueBasis) return ineligible(id, 'unlabelled_statistic');
  // 'unknown' is storable — the paper's silence — but labels nothing.
  if (centre != null && !entry.qualifier && (!statistic || statistic === 'unknown')) {
    return ineligible(id, 'unlabelled_statistic');
  }
  if (hasBounds && !entry.qualifier && (!dc.intervalKind || dc.intervalKind === 'unknown')) {
    return ineligible(id, 'unlabelled_statistic');
  }

  // Route: resolved, and not the catch-all.
  if (!entry.route) return ineligible(id, 'missing_route');
  if (entry.route === 'other') return ineligible(id, 'unresolved_route');

  // The dose, per value basis (the RFC's eligibility table).
  const hasExact = dc.doseValue != null;
  const hasRange = dc.doseLow != null && dc.doseHigh != null;
  const concentration = dc.valueBasis === 'concentration';
  if (concentration) {
    if (!hasExact && hasRange) return ineligible(id, 'dose_range_without_exact_dose');
    if (!hasExact) return ineligible(id, 'missing_dose');
  }
  const doseCanon = dc.doseUnit ? DOSE_TO_CANONICAL[dc.doseUnit] : undefined;
  if ((hasExact || hasRange) && !doseCanon) return ineligible(id, 'missing_dose');
  // Required whether or not a dose level is stated: a ratio "per mg" with no
  // basis could be per mg of salt, free base, parent or active moiety, which
  // are different quantities (RFC: doseBasis is required to normalize).
  if (!dc.doseBasis) return ineligible(id, 'unknown_dose_basis');

  // The dose family of a declared ratio must agree with its stated dose.
  let ratioDenominator: string | null = null;
  if (!concentration) {
    ratioDenominator = doseNormalizedDenominator(entry.unit);
    if (!ratioDenominator) return ineligible(id, 'incompatible_dose_family');
    if (doseCanon && doseUnitFamily(ratioDenominator) !== doseUnitFamily(dc.doseUnit!)) {
      return ineligible(id, 'incompatible_dose_family');
    }
  }
  const family: 'mg' | 'mg/kg' = doseCanon
    ? doseCanon.unit
    : doseUnitFamily(ratioDenominator ?? 'mg') === 'weight'
      ? 'mg/kg'
      : 'mg';

  // Matrix: only the blood/plasma axis converts; a crossing needs a sourced ratio.
  const matrix = entry.matrix ?? '';
  if (!isConvertibleMatrix(matrix)) return ineligible(id, 'unsupported_matrix_conversion');
  let ratio: number | null = null;
  if (isBloodLikeMatrix(matrix)) {
    if ('reason' in ctx.bloodPlasma) return ineligible(id, ctx.bloodPlasma.reason);
    ratio = ctx.bloodPlasma.ratio;
  }

  // The concentration part of the unit, and its conversion to µmol/L.
  const concentrationUnit = concentration
    ? entry.unit
    : entry.unit.slice(0, entry.unit.length - ratioDenominatorSuffix(ratioDenominator!).length);
  if (!isConcentrationUnit(concentrationUnit)) return ineligible(id, 'unsupported_matrix_conversion');
  const needsMw = !['mmol/L', 'µmol/L', 'nmol/L'].includes(concentrationUnit);
  if (needsMw && !(ctx.molecularWeight != null && ctx.molecularWeight > 0)) {
    return ineligible(id, 'missing_molecular_weight');
  }

  // The context profile the headline's label claims.
  if (!dc.releaseProfile || dc.releaseProfile === 'unknown') return ineligible(id, 'unknown_formulation');
  if (!dc.physicalForm || dc.physicalForm === 'unknown' || dc.physicalForm === 'other') {
    return ineligible(id, 'unknown_formulation');
  }
  if (entry.route === 'oral' && (!dc.prandialState || dc.prandialState === 'unspecified')) {
    return ineligible(id, 'unknown_prandial_state');
  }
  if (entry.route === 'iv' && (!dc.ivInputMode || dc.ivInputMode === 'unknown')) {
    return ineligible(id, 'unknown_iv_input_mode');
  }
  if (!dc.doseRegimen || dc.doseRegimen === 'unknown') return ineligible(id, 'unknown_dose_regimen');
  const repeated = dc.doseRegimen === 'multiple' || dc.doseRegimen === 'steady_state';
  if (repeated && !(dc.doseIntervalHours != null && dc.doseIntervalHours > 0)) {
    return ineligible(id, 'missing_dosing_interval');
  }
  // Accumulated exposure is comparable only when every preceding dose followed
  // the recorded regimen; a missed, changed or undocumented dose is not that
  // (RFC: repeated dosing requires an explicit priorDosingRegular: true).
  if (repeated && dc.priorDosingRegular !== true) {
    return ineligible(id, 'unsupported_regimen_context');
  }
  if (dc.doseRegimen === 'multiple' && dc.doseNumber == null && dc.regimenDurationHours == null) {
    return ineligible(id, 'unresolved_exposure_state');
  }
  if (dc.coadministrationState === 'with_interacting_drug') return ineligible(id, 'interaction_arm_not_pooled');
  if (dc.coadministrationState !== 'monotherapy') return ineligible(id, 'unknown_coadministration_state');
  if (!dc.pkPopulation || dc.pkPopulation === 'unknown' || dc.pkPopulation === 'other') {
    return ineligible(id, 'unknown_population');
  }
  if (dc.pkPopulation !== 'healthy_adult') return ineligible(id, 'altered_population_not_pooled');
  if (dc.administeredDrugId == null) return ineligible(id, 'missing_dose');

  // The arithmetic: matrix (plasma = blood / r), then unit, then the division.
  const exactDose = hasExact ? dc.doseValue! * doseCanon!.factor : null;
  const denominatorFactor = concentration
    ? null
    : DOSE_TO_CANONICAL[ratioDenominator!]!.factor; // a ratio per µg is 1000× the same ratio per mg
  const normalize = (value: number | null | undefined): number | undefined => {
    if (value == null) return undefined;
    const inPlasma = convertToDisplayMatrix(value, matrix, CMAX_TARGET_MATRIX, ratio);
    if (inPlasma == null) return undefined;
    const molar = convertConcentration(
      inPlasma,
      concentrationUnit as ConcentrationUnit,
      CMAX_CANONICAL_CONCENTRATION,
      ctx.molecularWeight ?? undefined,
    );
    return concentration ? molar / exactDose! : molar / denominatorFactor!;
  };

  const stratum: DoseStratum = hasExact
    ? { kind: 'exact', value: exactDose!, unit: family }
    : hasRange
      ? {
          kind: 'range',
          low: dc.doseLow! * doseCanon!.factor,
          high: dc.doseHigh! * doseCanon!.factor,
          unit: family,
        }
      : { kind: 'unstated', unit: family };

  const normalized: DoseNormalizedEntry = {
    entryId: id,
    normalizedLow: entry.qualifier ? undefined : normalize(entry.low),
    normalizedHigh: entry.qualifier ? undefined : normalize(entry.high),
    normalizedCentralValue: normalize(centre),
    normalizedUnit: family === 'mg' ? 'µmol/L/mg' : 'µmol/L/(mg/kg)',
    normalizedMatrix: CMAX_TARGET_MATRIX,
    doseStratum: stratum,
    doseBasis: dc.doseBasis ?? null,
    doseSaltForm: dc.doseSaltForm ?? null,
    centralStatistic: entry.qualifier ? null : ((statistic as CentralStatistic | null) ?? null),
    intervalKind: entry.qualifier ? null : (dc.intervalKind ?? null),
    qualifier: entry.qualifier,
    n: entry.n,
    reviewScore: entry.reviewScore,
    citationId: entry.citationId,
    route: entry.route,
    releaseProfile: dc.releaseProfile,
    physicalForm: dc.physicalForm,
    prandialState: entry.route === 'oral' ? (dc.prandialState ?? null) : null,
    coadministrationState: dc.coadministrationState,
    pkPopulation: dc.pkPopulation,
    valueBasis: dc.valueBasis,
    regimen: dc.doseRegimen,
    doseIntervalHours: repeated ? (dc.doseIntervalHours ?? null) : null,
    doseNumber: dc.doseRegimen === 'multiple' ? (dc.doseNumber ?? null) : null,
    regimenDurationHours: dc.doseRegimen === 'multiple' ? (dc.regimenDurationHours ?? null) : null,
    priorDosingRegular: repeated ? (dc.priorDosingRegular ?? null) : null,
    ivInputMode: entry.route === 'iv' ? (dc.ivInputMode ?? null) : null,
    administrationDurationMin:
      entry.route === 'iv' && dc.ivInputMode === 'infusion' ? (dc.administrationDurationMin ?? null) : null,
    administeredDrugId: dc.administeredDrugId,
  };

  // Normalizable, but not comparable with its neighbours.
  if (entry.qualifier) return { kind: 'normalized_not_poolable', entry: normalized, reason: 'censored_value' };
  if (normalized.normalizedCentralValue == null) {
    return { kind: 'normalized_not_poolable', entry: normalized, reason: 'missing_central_value' };
  }
  if (stratum.kind === 'unstated') {
    return { kind: 'normalized_not_poolable', entry: normalized, reason: 'unstated_dose_level' };
  }
  if (dc.doseBasis === 'salt' && !dc.doseSaltForm) {
    return { kind: 'normalized_not_poolable', entry: normalized, reason: 'unspecified_salt_form' };
  }
  return {
    kind: 'poolable',
    entry: normalized as PoolableEntry,
  };
}

function ratioDenominatorSuffix(denominator: string): string {
  return doseUnitFamily(denominator) === 'weight' ? `/(${denominator})` : `/${denominator}`;
}

// ─── Strata and the summary ─────────────────────────────────────────────────

/**
 * The pooling key: every dimension the RFC lists. Only entries with an
 * identical key pool; `populationQualifier` is display-only and not in it.
 * Dose MAGNITUDE is part of the key — pooling across dose levels would assume
 * a dose proportionality nobody has established.
 */
export function cmaxPoolingKey(e: PoolableEntry): string {
  const s = e.doseStratum;
  const dose =
    s.kind === 'exact' ? `exact:${round(s.value)}${s.unit}` : s.kind === 'range' ? `range:${round(s.low)}-${round(s.high)}${s.unit}` : 'unstated';
  return [
    dose,
    e.normalizedUnit,
    e.normalizedMatrix,
    e.doseBasis ?? '',
    e.doseBasis === 'salt' ? (e.doseSaltForm ?? '') : '',
    e.route,
    e.releaseProfile,
    e.physicalForm,
    e.prandialState ?? '',
    e.coadministrationState,
    e.pkPopulation,
    e.valueBasis,
    e.regimen,
    e.doseIntervalHours ?? '',
    e.doseNumber ?? '',
    e.regimenDurationHours ?? '',
    e.ivInputMode ?? '',
    e.administrationDurationMin ?? '',
    e.administeredDrugId,
    e.centralStatistic,
  ].join('|');
}

function round(v: number): string {
  return String(Number(v.toPrecision(10)));
}

export interface CmaxStratum {
  key: string;
  /** One member's context, shared by all (the key guarantees it). */
  context: PoolableEntry;
  cohorts: number;
  /** Weighted median of the members' normalized central values. */
  value: number;
  /** Between-cohort spread (min–max of the central values); null for one cohort. */
  spread: { low: number; high: number } | null;
  /** For a single cohort: its own reported interval and what it is. */
  ownInterval: { low: number; high: number; kind: IntervalKind | null } | null;
  entryIds: number[];
}

export type CmaxHeadline =
  | { kind: 'none' }
  | { kind: 'single'; stratum: CmaxStratum }
  | { kind: 'multiple'; strata: number };

export interface CmaxSummary {
  outcomes: NormalizationOutcome[];
  strata: CmaxStratum[];
  /** Exactly one stratum → its headline; several → no single number; none → none. */
  headline: CmaxHeadline;
}

/**
 * Normalize every entry and pool the poolable ones by stratum. The point
 * estimate is the `entryWeight`-weighted median (ties downward, a reported
 * value), the interval the between-cohort spread. Reported per-entry
 * intervals are never combined. The summary never picks among strata.
 */
export function summarizeCmax(
  entries: readonly CmaxSourceEntry[],
  ctx: CmaxNormalizationContext,
): CmaxSummary {
  const outcomes = entries.map((e) => normalizeCmaxEntry(e, ctx));
  const groups = new Map<string, PoolableEntry[]>();
  for (const o of outcomes) {
    if (o.kind !== 'poolable') continue;
    const key = cmaxPoolingKey(o.entry);
    const list = groups.get(key);
    if (list) list.push(o.entry);
    else groups.set(key, [o.entry]);
  }
  const strata: CmaxStratum[] = [...groups.entries()]
    .map(([key, members]) => {
      const values = members.map((m) => m.normalizedCentralValue);
      const value = weightedPercentile(
        members.map((m) => ({
          value: m.normalizedCentralValue,
          weight: entryWeight({ n: m.n, reviewScore: m.reviewScore } as never),
        })),
        0.5,
      )!;
      const single = members.length === 1 ? members[0]! : null;
      return {
        key,
        context: members[0]!,
        cohorts: members.length,
        value,
        spread: single ? null : { low: Math.min(...values), high: Math.max(...values) },
        ownInterval:
          single && single.normalizedLow != null && single.normalizedHigh != null
            ? { low: single.normalizedLow, high: single.normalizedHigh, kind: single.intervalKind }
            : null,
        entryIds: members.map((m) => m.entryId),
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  const headline: CmaxHeadline =
    strata.length === 0
      ? { kind: 'none' }
      : strata.length === 1
        ? { kind: 'single', stratum: strata[0]! }
        : { kind: 'multiple', strata: strata.length };
  return { outcomes, strata, headline };
}
