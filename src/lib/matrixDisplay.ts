/**
 * Chart display matrix — the shared conversion layer.
 *
 * The modeling chart can be viewed in one biological matrix at a time: whole
 * blood (the model's reference frame), serum, or plasma. Everything plotted —
 * the modelled curve AND every reference overlay (interpretive thresholds,
 * postmortem percentiles, forensic bands) — is expressed in that one matrix, so
 * a sample curve and the reference data around it are always comparable.
 *
 * Conversion is by the drug's blood:plasma ratio r = [blood] / [plasma], so
 * `blood = r · plasma` and `plasma = blood / r`. Serum is treated as plasma.
 * A conversion that needs a ratio the drug does not have returns `null` — the
 * caller then declines to draw (an overlay) or leaves the value in whole blood
 * and says so (the curve). A factor of 1 is never substituted for a missing
 * ratio: that would relabel a value's matrix rather than convert it.
 *
 * This replaces three near-duplicate `matrixToBlood`/`bloodRatio` helpers that
 * each hard-targeted whole blood (and disagreed on the missing-ratio fallback).
 */
import { meanRange } from './rangeUtils.js';
import type { NumericRange } from '@/types';

/** The matrices the chart can be displayed in. Serum and plasma share B/P. */
export const CHART_MATRICES = ['whole_blood', 'serum', 'plasma'] as const;
export type ChartMatrix = (typeof CHART_MATRICES)[number];

export const DEFAULT_CHART_MATRIX: ChartMatrix = 'whole_blood';

export function isChartMatrix(value: unknown): value is ChartMatrix {
  return (
    typeof value === 'string' &&
    (CHART_MATRICES as readonly string[]).includes(value)
  );
}

/** i18n keys for the selector, under `chartMatrix.option`. */
export const CHART_MATRIX_LABEL_KEYS: Record<ChartMatrix, string> = {
  whole_blood: 'chartMatrix.option.whole_blood',
  serum: 'chartMatrix.option.serum',
  plasma: 'chartMatrix.option.plasma',
};

/**
 * Source matrices that are whole-blood-equivalent for B/P purposes — the plain
 * whole-blood label plus the postmortem/site blood variants, which are all
 * blood and so convert to plasma the same way.
 */
const BLOOD_LIKE_MATRICES = new Set([
  'whole_blood',
  'femoral_blood',
  'cardiac_blood',
  'postmortem_femoral_blood',
  'postmortem_heart_blood',
]);

/** Source matrices that are already plasma-side (serum ≈ plasma). */
const PLASMA_LIKE_MATRICES = new Set(['serum', 'plasma']);

export function isBloodLikeMatrix(matrix: string): boolean {
  return BLOOD_LIKE_MATRICES.has(matrix);
}

export function isPlasmaLikeMatrix(matrix: string): boolean {
  return PLASMA_LIKE_MATRICES.has(matrix);
}

/** Whether a source matrix can be placed on the blood/plasma concentration axis at all. */
export function isConvertibleMatrix(matrix: string): boolean {
  return isBloodLikeMatrix(matrix) || isPlasmaLikeMatrix(matrix);
}

/**
 * The single blood:plasma factor to use, or `null` when the drug has none.
 *
 * `meanRange`: a central estimate (median/mean) or the midpoint of a two-sided
 * range. A one-sided bound is not a representative factor and yields `null`.
 */
export function bloodPlasmaFactorOrNull(
  bpr: NumericRange | number | null | undefined,
): number | null {
  if (typeof bpr === 'number') return Number.isFinite(bpr) && bpr > 0 ? bpr : null;
  if (bpr && typeof bpr === 'object') {
    const value = meanRange(bpr);
    if (value !== null && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

/**
 * Whether displaying `sourceMatrix` in `displayMatrix` is a NON-trivial
 * conversion (crosses the blood/plasma boundary), so a derived value can be
 * labelled as such. Same-side moves (blood→whole_blood, plasma→serum) return
 * false; an unknown source returns false because nothing can be drawn anyway.
 */
export function matrixConversionApplies(
  sourceMatrix: string,
  displayMatrix: ChartMatrix,
): boolean {
  const displayIsBlood = displayMatrix === 'whole_blood';
  if (isBloodLikeMatrix(sourceMatrix)) return !displayIsBlood;
  if (isPlasmaLikeMatrix(sourceMatrix)) return displayIsBlood;
  return false;
}

/**
 * Convert a value FROM its source matrix TO the chart's display matrix.
 *
 * Returns `null` when the move needs a B/P ratio the drug does not have, or the
 * source matrix is one the blood/plasma axis cannot represent (urine, vitreous,
 * hair, …). Same-side moves pass through untouched.
 */
export function convertToDisplayMatrix(
  value: number,
  sourceMatrix: string,
  displayMatrix: ChartMatrix,
  ratio: number | null,
): number | null {
  if (!Number.isFinite(value)) return null;
  const displayIsBlood = displayMatrix === 'whole_blood';

  if (isBloodLikeMatrix(sourceMatrix)) {
    if (displayIsBlood) return value; // blood → whole blood
    // blood → plasma/serum: plasma = blood / r
    return ratio != null ? value / ratio : null;
  }
  if (isPlasmaLikeMatrix(sourceMatrix)) {
    if (!displayIsBlood) return value; // plasma/serum → plasma/serum
    // plasma → whole blood: blood = r · plasma
    return ratio != null ? value * ratio : null;
  }
  return null; // a matrix the concentration axis cannot represent
}

/**
 * Factor to multiply a figure in `sourceMatrix` by to express it in the display
 * matrix. Multiplicative because every blood/plasma move is a ratio, so one
 * factor can rescale a whole series without walking each point.
 *
 * `null` when the move needs a B/P ratio the drug does not have, or the source
 * matrix is off the blood/plasma axis — the caller then keeps the value in its
 * OWN matrix and says so, rather than relabelling it.
 */
export function matrixDisplayFactor(
  sourceMatrix: string,
  displayMatrix: ChartMatrix,
  ratio: number | null,
): number | null {
  return convertToDisplayMatrix(1, sourceMatrix, displayMatrix, ratio);
}

/**
 * Factor for a figure known to be stored in WHOLE BLOOD — the pooled
 * interpretive thresholds and the reference overlays, which genuinely are.
 *
 * The MODELLED CURVE is not one of these: a reviewed model computes in its own
 * declared matrix (plasma for most of the registry), so it converts with
 * `matrixDisplayFactor` from `assumptions.nativeMatrix`. Treating a plasma curve
 * as whole blood silently scaled it by the blood:plasma ratio.
 *
 * `1` for whole blood; `1/r` for serum/plasma; `null` when serum/plasma is
 * asked for but the drug has no ratio.
 */
export function wholeBloodDisplayFactor(
  displayMatrix: ChartMatrix,
  ratio: number | null,
): number | null {
  return matrixDisplayFactor('whole_blood', displayMatrix, ratio);
}
