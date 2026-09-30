// v3 engine — port of the legacy ethanol back-calculation spreadsheet (v3).
//
// Adopted in v3 so far:
//   - Phase C: piecewise sub-0.2 ‰ back-calc + configurable absorption thresholds
//   - Phase E: sex selector 0/1/2 + Watson age gating
//   - Phase F: Widmark r lookup by height/weight (`src/data/widmarkLookup.ts`)
//   - Phase D1: three-tier estimates (low / likely / high)
//
// Remaining v3 UI delta: drink presets.
//
// The output surface is intentionally a strict superset of v1: every v1 field
// is produced with v3 semantics so engine-vs-oracle parity can be measured on
// the v3 oracle snapshot using the same comparator the v1 path uses.
//
// This file is the v3 sibling of the v1 engine, not a replacement.

import type { EtohParityOutput } from './etohWorkbookFlows';
import { widmarkREffective } from '@/data/widmarkLookup';

/**
 * Workbook v3 `B84`: 0 = unset (no sex selected), 1 = male, 2 = female.
 * Differs from v1's `B36` (0 = female, 1 = male).
 */
export type SexEnum = 0 | 1 | 2;
export const SEX_UNSET = 0 satisfies SexEnum;
export const SEX_MALE = 1 satisfies SexEnum;
export const SEX_FEMALE = 2 satisfies SexEnum;

export interface EtohV3ParityInput {
  drinkStopTime: number;
  eventTime: number;
  sampleTime: number;
  detectedPromille: number;
  eliminationMin: number; // I3
  eliminationLikely: number; // I4
  /** Workbook v3 `I5`. Highest elimination tier (default 0.20 ‰/h). */
  eliminationHigh: number;
  /** Workbook v3 `I6`. Elimination rate (‰/h) used while BAC < 0.2 ‰. */
  eliminationLowBac: number;
  absorptionMinHours: number;
  absorptionLikelyHours: number;
  /** Workbook v3 `I9` in hours. Absorption window for the high tier (default 0). */
  absorptionHighHours: number;
  /**
   * Workbook v3 `B35:G35`. Drink volume **in deciliters**. v1 used millilitres
   * at `B29:G29`; the v3 sheet switched units (and rebased the formula
   * `B50 = SUM(...) * 0.8` accordingly, dropping the `/ 100`).
   */
  drinksDl: [number, number, number, number, number, number];
  drinksAbvPercent: [number, number, number, number, number, number];
  firstPassMinPercent: number;
  firstPassLikelyPercent: number;
  /** Workbook v3 `B39`. Highest first-pass-loss tier (default 0). */
  firstPassHighPercent: number;
  weightKg: number;
  widmarkR: number;
  /** Workbook v3 `B84`: 0 unset / 1 male / 2 female. */
  sexEnum: SexEnum;
  heightCm: number;
  ageYears: number;
}

/**
 * v3 engine output. Strict superset of `EtohParityOutput` (v1 stays frozen);
 * five additional fields cover the workbook's high tier.
 *
 * Note on naming: the workbook calls the Widmark high-first-pass output
 * "Min" / "lav" because the highest first-pass loss yields the *lowest*
 * theoretical promille from the recorded drinks. The v3 oracle snapshot
 * already stores the field as `afterIntakeMinPromille`; we keep that name.
 */
export interface EtohV3ParityOutput extends EtohParityOutput {
  /** Workbook v3 `B12`. Back-calc using `eliminationHigh` and the high path. */
  backcalcHighPromille: number;
  /** Workbook v3 `B53`. Theoretical promille using `firstPassHighPercent`. */
  afterIntakeMinPromille: number;
  /** Workbook v3 `F53`. Watson sibling of `afterIntakeMinPromille`. */
  afterIntakeMinPromilleWattson: number;
  /** Workbook v3 `B58`. `null` mirrors the workbook's empty-string output. */
  afterIntakeBackcalcHighPromille: number | null;
  /** Workbook v3 `F58`. `null` mirrors the workbook's empty-string output. */
  afterIntakeBackcalcHighPromilleWattson: number | null;
}

export const DEFAULT_ELIMINATION_LOW_BAC = 0.08;
export const DEFAULT_ELIMINATION_HIGH = 0.2;
export const DEFAULT_ABSORPTION_HIGH_HOURS = 0;
export const DEFAULT_FIRST_PASS_HIGH_PERCENT = 0;

function wrapTime(t: number): number {
  if (t < 0) return t - Math.floor(t);
  return t % 1;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function deltaHours(end: number, start: number): number {
  return ((end - start) + (end < start ? 1 : 0)) * 24;
}

function sumProduct(a: number[], b: number[]): number {
  return a.reduce((acc, cur, idx) => acc + cur * (b[idx] ?? 0), 0);
}

/**
 * Watson r per workbook v3 `F48`:
 *
 *   F48 = ROUND( IF(B84=1, IF(F47>0, maleFormula, 0),
 *                          femaleFormula),
 *                2 )
 *
 * Differences vs v1's `B39`:
 *   1. Sex is the 0/1/2 enum (`B84`), not 0/1.
 *   2. Male path with no age returns numeric 0 (gated). v1's cell emitted ""
 *      and the v1 engine surfaced that as null.
 *   3. The else-branch (anything that isn't male, including unset and
 *      explicit female) computes the female formula. This means a sexEnum=0
 *      input still produces a Watson r — workbook quirk, faithfully ported
 *      so the engine matches the v3 oracle. The companion Widmark r `B44`
 *      gates explicitly on `B84=2` (see Phase F).
 */
function wattsonRValue(input: EtohV3ParityInput): number {
  if (input.weightKg <= 0) {
    return 0;
  }
  if (input.sexEnum === SEX_MALE) {
    if (input.ageYears <= 0) {
      return 0;
    }
    const numerator =
      2.447 - 0.09516 * input.ageYears + 0.1074 * input.heightCm + 0.3362 * input.weightKg;
    return round2(numerator / (input.weightKg * 0.84));
  }
  // SEX_FEMALE — and SEX_UNSET — fall through to the workbook's else-branch.
  const numerator = -2.097 + 0.1069 * input.heightCm + 0.2466 * input.weightKg;
  return round2(numerator / (input.weightKg * 0.84));
}

/**
 * Piecewise back-calculation from a measured BAC `b6` to `hours` earlier.
 *
 * Mirrors v3 `B88`/`B89`/`B90`. When `b6 ≥ 0.2` the result is the standard
 * linear `b6 + standardRate * hours` (matches v1). When `0 < b6 < 0.2` the
 * back-calc applies `lowBacRate` for the segment that brings BAC up to 0.2 ‰
 * (which takes `hoursToReachThreshold = (0.2 - b6) / lowBacRate`), then
 * `standardRate` for any remaining time. When `b6 ≤ 0` returns 0.
 */
function piecewiseBackcalc(
  b6: number,
  hours: number,
  standardRate: number,
  lowBacRate: number,
): number {
  if (b6 <= 0) return 0;
  if (b6 >= 0.2) return b6 + standardRate * hours;
  const hoursToReachThreshold = (0.2 - b6) / lowBacRate;
  if (hours > hoursToReachThreshold) {
    return 0.2 + standardRate * (hours - hoursToReachThreshold);
  }
  return b6 + lowBacRate * hours;
}

export function evaluateEtohWorkbookFlowsV3(input: EtohV3ParityInput): EtohV3ParityOutput {
  const b55 = deltaHours(input.eventTime, input.drinkStopTime);
  const b52 = wrapTime(input.drinkStopTime + input.absorptionMinHours / 24);
  const b53 = wrapTime(input.drinkStopTime + input.absorptionLikelyHours / 24);
  // High-tier counterpart of `b52`/`b53`. Workbook cell `B66 = B3 + I9`.
  const b54 = wrapTime(input.drinkStopTime + input.absorptionHighHours / 24);

  // v3 ties absorption-window cutoffs to the user-configurable I7/I8/I9 inputs:
  //   I69 = IF(B68 >= I7*24, 0, 1)   B69 = IF(I69=1, ..., B4)   B74 = ...
  //   I70 = IF(B68 >= I8*24, 0, 1)   B70 = IF(I70=1, ..., B4)   B75 = ...
  //   I71 = IF(B68 >= I9*24, 0, 1)   B71 = IF(I71=1, ..., B4)   B76 = ...
  // v1 hardcoded the first two to 3 h and 1 h and had no third tier. The
  // three paths each have separate flags (I69/I70/I71) and thresholds.
  const minThresholdHours = input.absorptionMinHours;
  const likelyThresholdHours = input.absorptionLikelyHours;
  const highThresholdHours = input.absorptionHighHours;

  const i56 = b55 >= minThresholdHours ? 0 : 1;
  const i57 = b55 >= likelyThresholdHours ? 0 : 1;
  const i58 = b55 >= highThresholdHours ? 0 : 1;
  const b56 = b55 >= minThresholdHours ? input.eventTime : b52;
  const b57 = b55 >= likelyThresholdHours ? input.eventTime : b53;
  const b58 = b55 >= highThresholdHours ? input.eventTime : b54;

  const b59 = deltaHours(input.sampleTime, input.drinkStopTime);
  const b60 =
    i56 === 1
      ? b59 <= minThresholdHours
        ? input.sampleTime
        : b56
      : input.eventTime;
  const b61 =
    i57 === 1
      ? b59 <= likelyThresholdHours
        ? input.sampleTime
        : b57
      : input.eventTime;
  const b62 =
    i58 === 1
      ? b59 <= highThresholdHours
        ? input.sampleTime
        : b58
      : input.eventTime;

  const i60 = deltaHours(input.sampleTime, b60);
  const i61 = deltaHours(input.sampleTime, b61);
  const i62 = deltaHours(input.sampleTime, b62);

  const backcalcMinPromille = piecewiseBackcalc(
    input.detectedPromille,
    i60,
    input.eliminationMin,
    input.eliminationLowBac,
  );
  const backcalcLikelyPromille = piecewiseBackcalc(
    input.detectedPromille,
    i61,
    input.eliminationLikely,
    input.eliminationLowBac,
  );
  const backcalcHighPromille = piecewiseBackcalc(
    input.detectedPromille,
    i62,
    input.eliminationHigh,
    input.eliminationLowBac,
  );

  // v3 `B50 = SUM(B35*B36 + ... + G35*G36) * 0.8`. Volumes are dL, ABV is a
  // percentage, so `dL × % × 0.8 g/mL × 10 mL/dL ÷ 100% = grams`.
  const ethanolGrams = sumProduct(input.drinksDl, input.drinksAbvPercent) * 0.8;

  // v3 `B44`: manual override `widmarkR` wins; otherwise the lookup tables
  // (`Vd M` / `Vd K`) drive the value. Out of grid → 0, which collapses the
  // theoretical-promille outputs to 0 just as the workbook does.
  const rEffective = widmarkREffective(
    input.widmarkR,
    input.sexEnum,
    input.weightKg,
    input.heightCm,
  );
  const widmarkDenominator = input.weightKg * rEffective;

  const afterIntakeMaxPromille =
    ethanolGrams > 0 && widmarkDenominator > 0
      ? (ethanolGrams * ((100 - input.firstPassMinPercent) / 100)) / widmarkDenominator
      : 0;
  const afterIntakeLikelyPromille =
    ethanolGrams > 0 && widmarkDenominator > 0
      ? (ethanolGrams * ((100 - input.firstPassLikelyPercent) / 100)) / widmarkDenominator
      : 0;
  // `afterIntakeMinPromille` (workbook `B53`) — "Min" because the highest
  // first-pass loss yields the *lowest* theoretical promille from drinks.
  // Not to be confused with the "min tier" elimination back-calc (B10/B11).
  const afterIntakeMinPromille =
    ethanolGrams > 0 && widmarkDenominator > 0
      ? (ethanolGrams * ((100 - input.firstPassHighPercent) / 100)) / widmarkDenominator
      : 0;

  const afterIntakeBackcalcMinPromille =
    afterIntakeMaxPromille > 0 ? backcalcMinPromille - afterIntakeMaxPromille : null;
  const afterIntakeBackcalcLikelyPromille =
    afterIntakeLikelyPromille > 0 ? backcalcLikelyPromille - afterIntakeLikelyPromille : null;
  const afterIntakeBackcalcHighPromille =
    afterIntakeMinPromille > 0 ? backcalcHighPromille - afterIntakeMinPromille : null;

  const wR = wattsonRValue(input);
  // wattsonRValue now returns 0 (not null) when gated. Downstream cells
  // mirror the workbook: `IF(B41>0, ... / (B40*F48), 0)` → 0 when wR is 0.
  const canWattson = wR !== 0;
  const afterIntakeMaxPromilleWattson =
    ethanolGrams > 0 && canWattson
      ? (ethanolGrams * ((100 - input.firstPassMinPercent) / 100)) / (input.weightKg * wR)
      : 0;
  const afterIntakeLikelyPromilleWattson =
    ethanolGrams > 0 && canWattson
      ? (ethanolGrams * ((100 - input.firstPassLikelyPercent) / 100)) / (input.weightKg * wR)
      : 0;
  const afterIntakeMinPromilleWattson =
    ethanolGrams > 0 && canWattson
      ? (ethanolGrams * ((100 - input.firstPassHighPercent) / 100)) / (input.weightKg * wR)
      : 0;
  const afterIntakeBackcalcMinPromilleWattson =
    afterIntakeMaxPromilleWattson > 0 ? backcalcMinPromille - afterIntakeMaxPromilleWattson : null;
  const afterIntakeBackcalcLikelyPromilleWattson =
    afterIntakeLikelyPromilleWattson > 0 ? backcalcLikelyPromille - afterIntakeLikelyPromilleWattson : null;
  const afterIntakeBackcalcHighPromilleWattson =
    afterIntakeMinPromilleWattson > 0 ? backcalcHighPromille - afterIntakeMinPromilleWattson : null;

  return {
    backcalcMinPromille,
    backcalcLikelyPromille,
    backcalcHighPromille,
    ethanolGrams,
    afterIntakeMaxPromille,
    afterIntakeLikelyPromille,
    afterIntakeMinPromille,
    afterIntakeBackcalcMinPromille,
    afterIntakeBackcalcLikelyPromille,
    afterIntakeBackcalcHighPromille,
    wattsonR: wR,
    afterIntakeMaxPromilleWattson,
    afterIntakeLikelyPromilleWattson,
    afterIntakeMinPromilleWattson,
    afterIntakeBackcalcMinPromilleWattson,
    afterIntakeBackcalcLikelyPromilleWattson,
    afterIntakeBackcalcHighPromilleWattson,
  };
}
