import type { ReferenceRange } from '@/components/simulator/simulatorGraphShapes';
import type { NumericRange } from '@/types';
import type { ReferenceConcentrationRow } from './referenceConcentrationsApi';
import type { ReferenceMatrix, ReferenceScenario } from './referenceConcentrations';
import {
  convertConcentration,
  isConcentrationUnit,
  type ConcentrationUnit,
} from './unitConversion';
import { representativeValue } from './rangeUtils';
import {
  bloodPlasmaFactorOrNull,
  wholeBloodDisplayFactor,
  type ChartMatrix,
} from './matrixDisplay';

type Bucket = 'therapeutic' | 'toxic' | 'lethal';

const SCENARIO_TO_BUCKET: Partial<Record<ReferenceScenario, Bucket>> = {
  living_therapeutic: 'therapeutic',
  living_toxic: 'toxic',
  living_dui: 'toxic',
  postmortem_mono_intox: 'lethal',
  postmortem_poly_intox: 'lethal',
};

/** Matrices we can render on a whole-blood simulator axis. */
const BLOOD_MATRICES = new Set<ReferenceMatrix>([
  'serum',
  'plasma',
  'whole_blood',
]);

function bloodRatio(bpr: NumericRange | number | null | undefined): number {
  if (typeof bpr === 'number' && Number.isFinite(bpr) && bpr > 0) return bpr;
  if (bpr && typeof bpr === 'object') {
    const rep = representativeValue(bpr);
    if (rep !== null && rep > 0) return rep;
    if (Number.isFinite(bpr.min) && Number.isFinite(bpr.max)) {
      const mid = ((bpr.min ?? 0) + (bpr.max ?? 0)) / 2;
      if (mid > 0) return mid;
    }
    if (Number.isFinite(bpr.min) && (bpr.min ?? 0) > 0) return bpr.min!;
    if (Number.isFinite(bpr.max) && (bpr.max ?? 0) > 0) return bpr.max!;
  }
  return 1;
}

function matrixToBlood(
  value: number,
  matrix: ReferenceMatrix,
  ratio: number,
): number {
  // bloodPlasmaRatio = [blood] / [plasma], so blood = ratio * plasma.
  if (matrix === 'whole_blood') return value;
  if (matrix === 'serum' || matrix === 'plasma') return value * ratio;
  return value;
}

export interface OverlayDrugInfo {
  bloodPlasmaRatio?: NumericRange | number | null;
  molecularWeight?: number | null;
  therapeuticConcentration?: NumericRange | number | null;
  impairmentConcentration?: NumericRange | number | null;
  toxicConcentration?: NumericRange | number | null;
  fatalConcentration?: NumericRange | number | null;
}

/**
 * Collapse a drug's reference_concentrations rows into the 3-bucket
 * {therapeutic, toxic, lethal} shape consumed by SimulatorGraph.
 *
 * - Drops rows whose matrix is not serum/plasma/whole_blood.
 * - Drops rows whose scenario does not map to a bucket (case reports, etc.).
 * - Converts serum/plasma → whole blood via bloodPlasmaRatio.
 * - Converts source unit → targetUnit; drops the row if conversion fails
 *   (e.g. molar row on a drug with no molecularWeight).
 * - Merges rows within the same bucket with min(low) / max(high).
 */
export function buildSimulatorReferenceRange(
  rows: ReferenceConcentrationRow[],
  drug: OverlayDrugInfo,
  targetUnit: string,
): ReferenceRange {
  if (!isConcentrationUnit(targetUnit)) return {};
  const target = targetUnit as ConcentrationUnit;
  const ratio = bloodRatio(drug.bloodPlasmaRatio ?? null);
  const mw = drug.molecularWeight ?? undefined;

  const buckets: Record<Bucket, { min?: number; max?: number }> = {
    therapeutic: {},
    toxic: {},
    lethal: {},
  };
  const seen: Record<Bucket, boolean> = {
    therapeutic: false,
    toxic: false,
    lethal: false,
  };

  for (const row of rows) {
    const bucket = SCENARIO_TO_BUCKET[row.scenario];
    if (!bucket) continue;
    if (!BLOOD_MATRICES.has(row.matrix)) continue;
    if (!isConcentrationUnit(row.unit)) continue;

    const sourceUnit = row.unit as ConcentrationUnit;

    let low: number | undefined;
    let high: number | undefined;
    try {
      if (row.low != null) {
        const blood = matrixToBlood(row.low, row.matrix, ratio);
        low = convertConcentration(blood, sourceUnit, target, mw);
      }
      if (row.high != null) {
        const blood = matrixToBlood(row.high, row.matrix, ratio);
        high = convertConcentration(blood, sourceUnit, target, mw);
      }
    } catch {
      // cross-kind conversion without molecular weight; skip this row.
      continue;
    }

    if (low == null && high == null) continue;

    const b = buckets[bucket];
    seen[bucket] = true;
    if (low != null) b.min = b.min == null ? low : Math.min(b.min, low);
    if (high != null) b.max = b.max == null ? high : Math.max(b.max, high);
  }

  const result: ReferenceRange = {};
  if (seen.therapeutic) result.therapeutic = buckets.therapeutic;
  if (seen.toxic) result.toxic = buckets.toxic;
  if (seen.lethal) result.lethal = buckets.lethal;
  return result;
}

function numericRangeToBucket(
  value: NumericRange | number | null | undefined,
  targetUnit: ConcentrationUnit,
  molecularWeight?: number,
): { min?: number; max?: number } | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { min: value, max: value } : null;
  }
  if (!value || typeof value !== 'object') return null;

  const sourceUnit = value.unit;
  if (!sourceUnit || !isConcentrationUnit(sourceUnit)) return null;

  const convert = (n: number): number =>
    convertConcentration(n, sourceUnit as ConcentrationUnit, targetUnit, molecularWeight);

  try {
    const rep = representativeValue(value);
    if (rep !== null) {
      const converted = convert(rep);
      return { min: converted, max: converted };
    }

    const bucket: { min?: number; max?: number } = {};
    if (typeof value.min === 'number' && Number.isFinite(value.min)) {
      bucket.min = convert(value.min);
    }
    if (typeof value.max === 'number' && Number.isFinite(value.max)) {
      bucket.max = convert(value.max);
    }
    return bucket.min == null && bucket.max == null ? null : bucket;
  } catch {
    return null;
  }
}

function mergeBucket(
  target: ReferenceRange,
  key: Bucket,
  value: { min?: number; max?: number } | null,
): void {
  if (!value) return;
  const current = target[key] ?? {};
  if (value.min != null) {
    current.min = current.min == null ? value.min : Math.min(current.min, value.min);
  }
  if (value.max != null) {
    current.max = current.max == null ? value.max : Math.max(current.max, value.max);
  }
  target[key] = current;
}

/**
 * Build simulator overlays from normal reviewed drug parameters. This is the
 * primary path after reference concentration curation moved into
 * drug_parameters; the legacy reference_concentrations table is only a
 * compatibility fallback.
 */
export function buildSimulatorReferenceRangeFromParameters(
  drug: OverlayDrugInfo,
  targetUnit: string,
  displayMatrix: ChartMatrix = 'whole_blood',
): ReferenceRange {
  if (!isConcentrationUnit(targetUnit)) return {};
  const target = targetUnit as ConcentrationUnit;
  const mw = drug.molecularWeight ?? undefined;
  const out: ReferenceRange = {};

  mergeBucket(
    out,
    'therapeutic',
    numericRangeToBucket(drug.therapeuticConcentration, target, mw),
  );
  mergeBucket(
    out,
    'toxic',
    numericRangeToBucket(drug.impairmentConcentration, target, mw),
  );
  mergeBucket(
    out,
    'toxic',
    numericRangeToBucket(drug.toxicConcentration, target, mw),
  );
  mergeBucket(
    out,
    'lethal',
    numericRangeToBucket(drug.fatalConcentration, target, mw),
  );

  // These pooled parameter values are stored in whole blood (the model's
  // reference frame), so a serum/plasma view scales them by 1/(B:P). When the
  // drug has no ratio the factor is null and the thresholds stay in whole blood
  // — best-effort, with the chart's matrix note carrying the caveat.
  const factor = wholeBloodDisplayFactor(
    displayMatrix,
    bloodPlasmaFactorOrNull(drug.bloodPlasmaRatio ?? null),
  );
  if (factor != null && factor !== 1) scaleReferenceRange(out, factor);

  return out;
}

function scaleReferenceRange(range: ReferenceRange, factor: number): void {
  for (const key of ['therapeutic', 'toxic', 'lethal'] as const) {
    const band = range[key];
    if (!band) continue;
    if (band.min != null) band.min *= factor;
    if (band.max != null) band.max *= factor;
  }
}
