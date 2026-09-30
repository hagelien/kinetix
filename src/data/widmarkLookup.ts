// Widmark r by sex, height and weight — the distribution factor the ethanol
// back-calculation uses when no manual r is entered.
//
// r follows Forrest's body-mass-index regression (Forrest ARW, "The estimation
// of Widmark's factor", J Forensic Sci Soc 1986;26:249–252):
//
//   men    r = 1.0181 − 0.01213 · BMI
//   women  r = 0.9367 − 0.01240 · BMI
//
// evaluated on a 5-cm × 5-kg grid (heights 150–205 cm, weights 45–115 kg) and
// reported to two decimals. Only the realistic body-composition envelope
// 15 ≤ BMI ≤ 30 is answered; any other point (e.g. 150 cm with 70 kg) is
// "absent", and so is anything off the grid. Absent reads as 0, which the
// caller uses to prompt for a manual r.
//
// The two-decimal values are rounded after a small downward offset (0.0002
// for men, 0.0005 for women). That is what the simulator's validated legacy
// lookup did: 9 of its 218 cells sit on a rounding boundary, and the offset
// reproduces every one of them exactly, so moving from a transcribed table to
// the formula changes no result.

import { SEX_FEMALE, SEX_MALE, SEX_UNSET, type SexEnum } from '@/lib/etohWorkbookFlowsV3';

export const WIDMARK_LOOKUP_WEIGHTS_KG: readonly number[] = [
  45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115,
];
export const WIDMARK_LOOKUP_HEIGHTS_CM: readonly number[] = [
  150, 155, 160, 165, 170, 175, 180, 185, 190, 195, 200, 205,
];

interface ForrestCoefficients {
  intercept: number;
  slope: number;
  /** Subtracted before rounding; see the module comment. */
  roundingOffset: number;
}

const FORREST_MALE: ForrestCoefficients = {
  intercept: 1.0181,
  slope: 0.01213,
  roundingOffset: 0.0002,
};
const FORREST_FEMALE: ForrestCoefficients = {
  intercept: 0.9367,
  slope: 0.0124,
  roundingOffset: 0.0005,
};

/** Body-composition envelope the lookup answers, inclusive. */
const MIN_BMI = 15;
const MAX_BMI = 30;

function coefficientsFor(sex: SexEnum): ForrestCoefficients | null {
  if (sex === SEX_MALE) return FORREST_MALE;
  if (sex === SEX_FEMALE) return FORREST_FEMALE;
  return null;
}

/** r at a grid point, or null when the point is outside the envelope. */
function forrestR(
  coefficients: ForrestCoefficients,
  weightKg: number,
  heightCm: number,
): number | null {
  const heightM = heightCm / 100;
  const bmi = weightKg / (heightM * heightM);
  // A hair of tolerance so a grid point exactly on the boundary (200 cm with
  // 60 kg is BMI 15.0) is not lost to floating point.
  if (bmi < MIN_BMI - 1e-9 || bmi > MAX_BMI + 1e-9) return null;
  const raw =
    coefficients.intercept -
    coefficients.slope * bmi -
    coefficients.roundingOffset;
  return Math.round(raw * 100) / 100;
}

const WEIGHT_STEP_KG = 5;
const HEIGHT_STEP_CM = 5;

/** Weight and height snap to the nearest grid step before the lookup. */
function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * Look up Widmark r on the height × weight grid.
 *
 * Returns `0` to signal "no match" — out-of-grid weight or height, an absent
 * cell at the matched (height, weight) coordinate, an `r >= 1` value (the
 * clamp), or a sex of `SEX_UNSET`. Callers can use the
 * `widmarkLookupOutOfTable` helper to differentiate "in-grid but absent"
 * from "outside the table altogether" if they need to prompt the user.
 */
export function lookupWidmarkR(sex: SexEnum, weightKg: number, heightCm: number): number {
  const coefficients = coefficientsFor(sex);
  if (!coefficients) return 0;
  if (!Number.isFinite(weightKg) || !Number.isFinite(heightCm)) return 0;
  const w = roundToStep(weightKg, WEIGHT_STEP_KG);
  const h = roundToStep(heightCm, HEIGHT_STEP_CM);
  const heightIdx = WIDMARK_LOOKUP_HEIGHTS_CM.indexOf(h);
  const weightIdx = WIDMARK_LOOKUP_WEIGHTS_KG.indexOf(w);
  if (heightIdx < 0 || weightIdx < 0) return 0;
  const cell = forrestR(coefficients, w, h);
  if (cell == null) return 0;
  // Defensive clamp: an r of 1 or more is not a plausible distribution factor
  // and is treated as "no answer" (the envelope never produces one).
  if (cell >= 1) return 0;
  return cell;
}

/**
 * Returns true when the (sex, weight, height) triple is outside the lookup
 * grid AND there is no positive manual override (weight, height and sex all
 * given, effective r still 0). Used by the UI to prompt for manual `r` entry —
 * clears the moment the user enters a valid `r`, since the effective r then
 * equals the override and is no longer 0. Caller does not need to handle
 * `SEX_UNSET`; the form asks for a sex before this flag fires.
 */
export function widmarkLookupOutOfTable(
  manualR: number,
  sex: SexEnum,
  weightKg: number,
  heightCm: number,
): boolean {
  if (sex === SEX_UNSET) return false;
  if (weightKg <= 0 || heightCm <= 0) return false;
  return widmarkREffective(manualR, sex, weightKg, heightCm) === 0;
}

/**
 * The r the calculation uses.
 *
 * Manual `widmarkR` overrides the table when positive. Otherwise the table
 * lookup is used for explicit male/female; sex unset returns 0.
 */
export function widmarkREffective(
  manualR: number,
  sex: SexEnum,
  weightKg: number,
  heightCm: number,
): number {
  if (manualR > 0) return manualR;
  return lookupWidmarkR(sex, weightKg, heightCm);
}
