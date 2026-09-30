// EtOH workbook input/output type shapes — v3 engine consumes these via the
// `promoteToV3()` adapter in WorkbookBackcalcPanel and the parity harness.
//
// The frozen v1 engine that originally lived here was retired in Phase L of
// #218 once the v3 engine reached oracle parity (217 cases × 17 fields for
// `Tilbakeregning EtOH` and 217 × 16 for `Fremoverregning EtOH`). Keep this
// file as the persisted-input contract: the Zustand store and the URL/JSON
// scenario schema both shape themselves around `EtohParityInput`, so renaming
// it would touch every consumer for no behavioural benefit. New v3-only
// fields live on `EtohV3ParityInput` in `etohWorkbookFlowsV3.ts`, which is a
// strict superset and the actual engine input.

export interface EtohParityInput {
  drinkStopTime: number;
  eventTime: number;
  sampleTime: number;
  detectedPromille: number;
  /** Workbook v3 `B16`. Optional second sample time. */
  secondSampleTime?: number | null;
  /** Workbook v3 `B17`. Optional second sample EtOH in promille. */
  secondSamplePromille?: number;
  eliminationMin: number;
  eliminationLikely: number;
  absorptionMinHours: number;
  absorptionLikelyHours: number;
  drinksMl: [number, number, number, number, number, number];
  drinksAbvPercent: [number, number, number, number, number, number];
  firstPassMinPercent: number;
  firstPassLikelyPercent: number;
  weightKg: number;
  widmarkR: number;
  sexMale01: 0 | 1;
  heightCm: number;
  ageYears: number;
}

export interface EtohParityOutput {
  backcalcMinPromille: number;
  backcalcLikelyPromille: number;
  ethanolGrams: number;
  afterIntakeMaxPromille: number;
  afterIntakeLikelyPromille: number;
  afterIntakeBackcalcMinPromille: number | null;
  afterIntakeBackcalcLikelyPromille: number | null;
  wattsonR: number | null;
  afterIntakeMaxPromilleWattson: number;
  afterIntakeLikelyPromilleWattson: number;
  afterIntakeBackcalcMinPromilleWattson: number | null;
  afterIntakeBackcalcLikelyPromilleWattson: number | null;
}
