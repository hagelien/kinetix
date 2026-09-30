// v3 forward-projection engine — workbook v3 sheet `Fremoverregning EtOH`.
//
// Mirrors the back-calc engine in shape and shares its primitives (Widmark
// lookup tables, Watson r, sex enum). The difference is direction: instead
// of measuring a sample BAC and rewinding it to event time, the forward
// engine starts from drink intake and projects BAC forward to event time.
//
// Inputs use dL for drink volumes (consistent with v3 `B8:G8` and Phase G
// of the back-calc engine).
//
// Output naming follows the workbook conventions in `B52`/`B53`/`B54` and
// `C52`/`C53`/`C54`:
//   - "high" tier: lowest first-pass + slowest elimination → highest BAC
//   - "low" tier:  highest first-pass + fastest elimination → lowest BAC

import type { SexEnum } from './etohWorkbookFlowsV3';
import { widmarkREffective } from '@/data/widmarkLookup';
import { SEX_MALE } from './etohWorkbookFlowsV3';

export interface EtohForwardInput {
  /** Workbook v3 `B5`. Time the drinking started (Excel fractional day). */
  drinkStartTime: number;
  /** Workbook v3 `B6`. Event time the BAC is projected to. */
  eventTime: number;
  /** Workbook v3 `B8:G8`. Drink volumes in deciliters. */
  drinksDl: [number, number, number, number, number, number];
  /** Workbook v3 `B9:G9`. Per-drink ABV in percent. */
  drinksAbvPercent: [number, number, number, number, number, number];
  /** Workbook v3 `B10`. Lowest first-pass loss → highest BAC tier. */
  firstPassMinPercent: number;
  /** Workbook v3 `B11`. Likely first-pass loss. */
  firstPassLikelyPercent: number;
  /** Workbook v3 `B12`. Highest first-pass loss → lowest BAC tier. */
  firstPassHighPercent: number;
  weightKg: number;
  heightCm: number;
  /** Workbook v3 `B16`. Manual Widmark r override (>0 wins over lookup). */
  widmarkR: number;
  /** Workbook v3 `B48`: 0 unset / 1 male / 2 female. */
  sexEnum: SexEnum;
  /** Workbook v3 `F20`. Age, gates the Watson formula for males. */
  ageYears: number;
  /** Workbook v3 `B28`. Slowest elimination → highest projected BAC. */
  forwardEliminationHigh: number;
  /** Workbook v3 `B29`. Likely elimination rate. */
  forwardEliminationLikely: number;
  /** Workbook v3 `B30`. Fastest elimination → lowest projected BAC. */
  forwardEliminationLow: number;
}

export interface EtohForwardOutput {
  /** Workbook v3 `B23`. Total grams of pure ethanol in the drinks. */
  ethanolGrams: number;
  /** Workbook v3 `B24`. Theoretical promille after full absorption — Widmark, lowest first-pass. */
  theoreticalHighPromille: number;
  /** Workbook v3 `B25`. */
  theoreticalLikelyPromille: number;
  /** Workbook v3 `B26`. Highest first-pass yields lowest theoretical promille. */
  theoreticalLowPromille: number;
  /** Workbook v3 `F24` / `F25` / `F26`. Watson siblings. */
  theoreticalHighPromilleWattson: number;
  theoreticalLikelyPromilleWattson: number;
  theoreticalLowPromilleWattson: number;
  /** Workbook v3 `B54`. Forward-projected promille after `B28` * `B42` hours of elimination. */
  forwardHighPromille: number;
  /** Workbook v3 `B53`. */
  forwardLikelyPromille: number;
  /** Workbook v3 `B52`. */
  forwardLowPromille: number;
  /** Workbook v3 `C54` / `C53` / `C52`. Watson siblings. */
  forwardHighPromilleWattson: number;
  forwardLikelyPromilleWattson: number;
  forwardLowPromilleWattson: number;
  /** Workbook v3 `B42`. Hours between `drinkStartTime` and `eventTime`. */
  forwardHours: number;
  /** Effective Widmark r (manual override or `Vd M`/`Vd K` lookup). */
  widmarkREffective: number;
  /** Workbook v3 `F21`. Watson r — 0 when male and no age. */
  wattsonR: number;
}

/** Workbook hardcoded constants `B28` / `B29` / `B30`. */
export const DEFAULT_FORWARD_ELIMINATION_HIGH = 0.1;
export const DEFAULT_FORWARD_ELIMINATION_LIKELY = 0.15;
export const DEFAULT_FORWARD_ELIMINATION_LOW = 0.2;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function deltaHours(end: number, start: number): number {
  return ((end - start) + (end < start ? 1 : 0)) * 24;
}

function sumProduct(a: number[], b: number[]): number {
  return a.reduce((acc, cur, idx) => acc + cur * (b[idx] ?? 0), 0);
}

/** Watson r per workbook v3 `F21`. Same gating as the back-calc engine's `F48`. */
function wattsonRValue(input: EtohForwardInput): number {
  if (input.weightKg <= 0) return 0;
  if (input.sexEnum === SEX_MALE) {
    if (input.ageYears <= 0) return 0;
    const numerator =
      2.447 - 0.09516 * input.ageYears + 0.1074 * input.heightCm + 0.3362 * input.weightKg;
    return round2(numerator / (input.weightKg * 0.84));
  }
  // Sex female and unset both fall through to the female formula (workbook quirk).
  const numerator = -2.097 + 0.1069 * input.heightCm + 0.2466 * input.weightKg;
  return round2(numerator / (input.weightKg * 0.84));
}

export function evaluateEtohForwardFlowsV3(input: EtohForwardInput): EtohForwardOutput {
  // v3 `B23 = SUM(B8*B9 + ...) * 0.8`.
  const ethanolGrams = sumProduct(input.drinksDl, input.drinksAbvPercent) * 0.8;

  // v3 `B17 = IF(B16>0, B16, IF(B48=1, ..., IF(B48=2, ..., 0)))`.
  const rEffective = widmarkREffective(
    input.widmarkR,
    input.sexEnum,
    input.weightKg,
    input.heightCm,
  );
  const widmarkDenominator = input.weightKg * rEffective;

  function widmarkTheoretical(firstPassPercent: number): number {
    if (ethanolGrams <= 0 || widmarkDenominator <= 0) return 0;
    return (ethanolGrams * ((100 - firstPassPercent) / 100)) / widmarkDenominator;
  }

  const wR = wattsonRValue(input);
  const wattsonDenominator = input.weightKg * wR;
  function wattsonTheoretical(firstPassPercent: number): number {
    if (ethanolGrams <= 0 || wattsonDenominator <= 0) return 0;
    return (ethanolGrams * ((100 - firstPassPercent) / 100)) / wattsonDenominator;
  }

  const theoreticalHighPromille = widmarkTheoretical(input.firstPassMinPercent);
  const theoreticalLikelyPromille = widmarkTheoretical(input.firstPassLikelyPercent);
  const theoreticalLowPromille = widmarkTheoretical(input.firstPassHighPercent);
  const theoreticalHighPromilleWattson = wattsonTheoretical(input.firstPassMinPercent);
  const theoreticalLikelyPromilleWattson = wattsonTheoretical(input.firstPassLikelyPercent);
  const theoreticalLowPromilleWattson = wattsonTheoretical(input.firstPassHighPercent);

  // v3 `B42 = ((B6-B5)+(B5>B6))*24`.
  const forwardHours = deltaHours(input.eventTime, input.drinkStartTime);

  // v3 `B52..B54 = MAXA(0, theoretical - rate * hours)`.
  // Note the inverted pairing: high-tier output uses lowest first-pass + slowest
  // elimination so it stays the highest BAC after projection forward.
  const project = (theoretical: number, rate: number) =>
    Math.max(0, theoretical - rate * forwardHours);

  return {
    ethanolGrams,
    theoreticalHighPromille,
    theoreticalLikelyPromille,
    theoreticalLowPromille,
    theoreticalHighPromilleWattson,
    theoreticalLikelyPromilleWattson,
    theoreticalLowPromilleWattson,
    forwardHighPromille: project(theoreticalHighPromille, input.forwardEliminationHigh),
    forwardLikelyPromille: project(theoreticalLikelyPromille, input.forwardEliminationLikely),
    forwardLowPromille: project(theoreticalLowPromille, input.forwardEliminationLow),
    forwardHighPromilleWattson: project(theoreticalHighPromilleWattson, input.forwardEliminationHigh),
    forwardLikelyPromilleWattson: project(theoreticalLikelyPromilleWattson, input.forwardEliminationLikely),
    forwardLowPromilleWattson: project(theoreticalLowPromilleWattson, input.forwardEliminationLow),
    forwardHours,
    widmarkREffective: rEffective,
    wattsonR: wR,
  };
}
