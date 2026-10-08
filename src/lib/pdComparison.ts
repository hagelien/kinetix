import {
  formatRange,
  formatWithMaxDecimals,
  hasRangeData,
  rangeMax,
  rangeMin,
  rangeRepresentative,
} from '@/lib/rangeUtils';
import type { DrugReceptorTargetSummary } from '@/lib/receptorTargets';
import type { NumericRange } from '@/types';

/**
 * Pharmacodynamic comparison across the basket.
 *
 * The drug-level Ki/IC50/EC50 parameters were retired in favour of per-target
 * measurements on the mechanism rows (`drug_receptor_targets`), so this module
 * compares drugs *at a receptor*: for one target (e.g. OPRM1) it lines up each
 * drug's Ki, EC50, Emax, … converted to a shared unit.
 */

/** Per-mechanism measurement columns, in display order. */
export const PD_METRICS = [
  'ki',
  'ec50',
  'ic50',
  'emax',
  'affinity',
  'potency',
  'efficacy',
  'selectivityRatio',
] as const;
export type PdMetric = (typeof PD_METRICS)[number];

/**
 * Binding/potency constants where a lower concentration means a stronger
 * drug. The relative column inverts these so ">1x" always reads "stronger
 * than the reference".
 */
const INVERSE_STRENGTH_METRICS = new Set<PdMetric>(['ki', 'ec50', 'ic50']);

export function isInverseStrengthMetric(metric: PdMetric): boolean {
  return INVERSE_STRENGTH_METRICS.has(metric);
}

/** Molar concentration units, as a factor to nmol/L (written "nM"). */
const MOLAR_TO_NM: Record<string, number> = {
  fm: 1e-6,
  'fmol/l': 1e-6,
  pm: 1e-3,
  'pmol/l': 1e-3,
  nm: 1,
  'nmol/l': 1,
  'µm': 1e3,
  'µmol/l': 1e3,
  mm: 1e6,
  'mmol/l': 1e6,
  m: 1e9,
  'mol/l': 1e9,
};

export const MOLAR_DISPLAY_UNIT = 'nM';

/**
 * Normalise a free-text measurement unit so values from different sources
 * line up. Molar concentrations (pM, nM, µM, nmol/L, …) convert to nM; any
 * other unit is kept as written and only compared against the same unit.
 */
export function normalizePdUnit(unit: string | null | undefined): {
  unit: string;
  factor: number;
} {
  const trimmed = (unit ?? '').trim();
  if (!trimmed) return { unit: '', factor: 1 };
  // Fold every micro spelling (Greek μ, ASCII u) onto the Latin µ first.
  const key = trimmed
    .replace(/\u03BC/g, 'µ')
    .replace(/^u(?=m)/i, 'µ')
    .replace(/\s+/g, '')
    .toLowerCase();
  const factor = MOLAR_TO_NM[key];
  if (factor !== undefined) return { unit: MOLAR_DISPLAY_UNIT, factor };
  if (key === '%' || key === 'percent') return { unit: '%', factor: 1 };
  return { unit: trimmed, factor: 1 };
}

export interface PdTarget {
  id: number;
  symbol: string;
  name: string;
  nameEn: string | null;
  /** Number of basket drugs with at least one mechanism at this target. */
  drugCount: number;
}

export interface PdDrugInput {
  id: number;
  receptorTargets?: DrugReceptorTargetSummary[] | null;
}

/**
 * Every receptor target any basket drug has a mechanism at, most-shared
 * first — a target several drugs act on is the one worth comparing.
 */
export function collectPdTargets(drugs: readonly PdDrugInput[]): PdTarget[] {
  const byId = new Map<number, PdTarget & { drugs: Set<number> }>();
  for (const drug of drugs) {
    for (const mechanism of drug.receptorTargets ?? []) {
      const { target } = mechanism;
      const entry = byId.get(target.id) ?? {
        id: target.id,
        symbol: target.symbol,
        name: target.name,
        nameEn: target.nameEn,
        drugCount: 0,
        drugs: new Set<number>(),
      };
      entry.drugs.add(drug.id);
      entry.drugCount = entry.drugs.size;
      byId.set(target.id, entry);
    }
  }
  return [...byId.values()]
    .map(({ drugs: _drugs, ...target }) => target)
    .sort(
      (a, b) =>
        b.drugCount - a.drugCount || a.symbol.localeCompare(b.symbol),
    );
}

export interface PdValue {
  drugId: number;
  /** The mechanism row the value was read from, when the drug has one. */
  mechanism: DrugReceptorTargetSummary | null;
  raw: NumericRange | null;
  /** Representative value in `unit` (molar values converted to nM). */
  numeric: number | null;
  min: number | null;
  max: number | null;
  unit: string;
}

export interface PdMetricComparison {
  metric: PdMetric;
  values: PdValue[];
  commonUnit: string | null;
  hasUnitMismatch: boolean;
  inverseStrength: boolean;
}

export interface PdTargetComparison {
  targetId: number;
  /** Every mechanism each drug has at the target, keyed by drug id. */
  mechanismsByDrug: Map<number, DrugReceptorTargetSummary[]>;
  /** Metrics at least one drug reports, in {@link PD_METRICS} order. */
  metrics: PdMetricComparison[];
}

function readPdValue(
  drugId: number,
  mechanism: DrugReceptorTargetSummary | null,
  metric: PdMetric,
): PdValue {
  const raw = mechanism?.[metric] ?? null;
  if (!hasRangeData(raw)) {
    return {
      drugId,
      mechanism,
      raw: null,
      numeric: null,
      min: null,
      max: null,
      unit: '',
    };
  }
  const { unit, factor } = normalizePdUnit(raw.unit);
  const scale = (value: number | null) =>
    value === null ? null : value * factor;
  return {
    drugId,
    mechanism,
    raw,
    numeric: scale(rangeRepresentative(raw)),
    min: scale(rangeMin(raw)),
    max: scale(rangeMax(raw)),
    unit,
  };
}

/**
 * Line up every basket drug at one receptor target. A drug with several
 * mechanisms at the same target (say an agonist row and a separate binding
 * row) contributes, per metric, the first row that reports it — ranked rows
 * first, so the primary mechanism wins.
 */
export function buildPdTargetComparison(
  targetId: number,
  drugs: readonly PdDrugInput[],
): PdTargetComparison {
  const tierRank = (m: DrugReceptorTargetSummary) =>
    m.tier === 'primary' ? 0 : m.tier === 'secondary' ? 1 : m.tier === 'tertiary' ? 2 : 3;
  const mechanismsByDrug = new Map<number, DrugReceptorTargetSummary[]>();
  for (const drug of drugs) {
    mechanismsByDrug.set(
      drug.id,
      (drug.receptorTargets ?? [])
        .filter((m) => m.target.id === targetId)
        .sort((a, b) => tierRank(a) - tierRank(b)),
    );
  }

  const metrics: PdMetricComparison[] = [];
  for (const metric of PD_METRICS) {
    const values = drugs.map((drug) => {
      const mechanisms = mechanismsByDrug.get(drug.id) ?? [];
      const source =
        mechanisms.find((m) => hasRangeData(m[metric])) ?? mechanisms[0] ?? null;
      return readPdValue(drug.id, source, metric);
    });
    const populated = values.filter((value) => value.numeric !== null);
    if (!populated.length) continue;
    const units = [...new Set(populated.map((value) => value.unit))];
    metrics.push({
      metric,
      values,
      commonUnit: units.length === 1 ? units[0]! : null,
      hasUnitMismatch: units.length > 1,
      inverseStrength: isInverseStrengthMetric(metric),
    });
  }

  return { targetId, mechanismsByDrug, metrics };
}

/** Metrics that express how tightly/potently a drug acts, strongest signal first. */
const HEADLINE_METRICS: PdMetric[] = ['ki', 'ec50', 'ic50'];

export interface PdHeadline {
  metric: PdMetric;
  mechanism: DrugReceptorTargetSummary;
  /** Molar value in nM, or null when the unit is not a molar concentration. */
  nanomolar: number | null;
  formatted: string;
}

/**
 * The single number the receptor-profile matrix shows for a drug at a target:
 * Ki when known (affinity), else EC50 (functional potency), else IC50.
 */
export function pdHeadline(
  mechanisms: readonly DrugReceptorTargetSummary[],
): PdHeadline | null {
  for (const metric of HEADLINE_METRICS) {
    for (const mechanism of mechanisms) {
      const value = readPdValue(0, mechanism, metric);
      if (value.numeric === null) continue;
      const nanomolar = value.unit === MOLAR_DISPLAY_UNIT ? value.numeric : null;
      return {
        metric,
        mechanism,
        nanomolar,
        formatted:
          nanomolar !== null
            ? formatPdNumber(nanomolar, MOLAR_DISPLAY_UNIT)
            : formatRange(value.raw, { showNote: false }),
      };
    }
  }
  return null;
}

export function formatPdNumber(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return '';
  return `${formatWithMaxDecimals(value, value < 1 ? 3 : 2)}${unit ? ` ${unit}` : ''}`;
}

/**
 * Render a PD value in its normalised unit: "0.49 nM", "2–5 nM", or the
 * stored text when the unit is not one we convert.
 */
export function formatPdValue(value: PdValue): string {
  if (value.numeric === null || !value.raw) return '';
  if (value.unit !== MOLAR_DISPLAY_UNIT) {
    return formatRange(value.raw, { showNote: false });
  }
  if (value.min !== null && value.max !== null && value.min !== value.max) {
    return `${formatWithMaxDecimals(value.min, 3)}–${formatPdNumber(value.max, value.unit)}`;
  }
  return formatPdNumber(value.numeric, value.unit);
}

/**
 * 0 (weakest) … 1 (strongest) position of a nanomolar affinity on a log scale
 * spanning 0.01 nM to 10 µM — the range that covers clinically relevant
 * receptor binding. Drives the matrix cell shading.
 */
export function affinityStrength(nanomolar: number | null): number | null {
  if (nanomolar === null || !Number.isFinite(nanomolar) || nanomolar <= 0) {
    return null;
  }
  const log = Math.log10(nanomolar);
  return Math.min(1, Math.max(0, (4 - log) / 6));
}
