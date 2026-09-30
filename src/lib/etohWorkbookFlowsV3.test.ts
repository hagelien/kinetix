import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ABSORPTION_HIGH_HOURS,
  DEFAULT_ELIMINATION_HIGH,
  DEFAULT_ELIMINATION_LOW_BAC,
  DEFAULT_FIRST_PASS_HIGH_PERCENT,
  SEX_FEMALE,
  SEX_MALE,
  SEX_UNSET,
  evaluateEtohWorkbookFlowsV3,
  type EtohV3ParityInput,
} from './etohWorkbookFlowsV3';

const baseV3: EtohV3ParityInput = {
  drinkStopTime: 0.5,
  eventTime: 0.7916666667, // 19:00
  sampleTime: 0.8333333333, // 20:00
  detectedPromille: 0.84,
  eliminationMin: 0.1,
  eliminationLikely: 0.15,
  eliminationHigh: DEFAULT_ELIMINATION_HIGH,
  eliminationLowBac: DEFAULT_ELIMINATION_LOW_BAC,
  absorptionMinHours: 3,
  absorptionLikelyHours: 1,
  absorptionHighHours: DEFAULT_ABSORPTION_HIGH_HOURS,
  drinksDl: [0, 0, 0, 0, 0, 0],
  drinksAbvPercent: [0, 0, 0, 0, 0, 0],
  firstPassMinPercent: 15,
  firstPassLikelyPercent: 25,
  firstPassHighPercent: DEFAULT_FIRST_PASS_HIGH_PERCENT,
  weightKg: 78,
  widmarkR: 0.7,
  sexEnum: SEX_MALE,
  heightCm: 182,
  ageYears: 35,
};

describe('evaluateEtohWorkbookFlowsV3 — piecewise sub-0.2 ‰ back-calculation', () => {
  it('reduces to the linear v1-shape back-calc when detectedPromille >= 0.2', () => {
    // baseV3 puts drinkStop at 12:00, event at 19:00, sample at 20:00.
    // b55 = 7 h (event past 3 h absorption) → i56=0 → b60=eventTime → i60=1 h.
    // backcalcMin = 0.84 + 0.10 * 1 = 0.94; backcalcLikely = 0.84 + 0.15 * 1 = 0.99.
    const out = evaluateEtohWorkbookFlowsV3(baseV3);
    expect(out.backcalcMinPromille).toBeCloseTo(0.94, 9);
    expect(out.backcalcLikelyPromille).toBeCloseTo(0.99, 9);
  });

  it('returns 0 when detectedPromille is 0', () => {
    const out = evaluateEtohWorkbookFlowsV3({ ...baseV3, detectedPromille: 0 });
    expect(out.backcalcMinPromille).toBe(0);
    expect(out.backcalcLikelyPromille).toBe(0);
  });

  // Helper: drinkStop at midnight pushes us well past the absorption window so
  // i60 / i61 reduce to (sampleTime - eventTime) hours. The piecewise math is
  // applied to that hour count.
  const pastAbsorption = (eventHour: number, sampleHour: number) => ({
    drinkStopTime: 0,
    eventTime: eventHour / 24,
    sampleTime: sampleHour / 24,
  });

  it('uses lowBacRate alone when back-calc time stays below the 0.2 threshold', () => {
    // detectedPromille 0.10, lowBacRate 0.08, back-calc 1 hour:
    //   hoursToReachThreshold = (0.2 - 0.10) / 0.08 = 1.25 h
    //   1 < 1.25 → result = 0.10 + 0.08 * 1 = 0.18
    const out = evaluateEtohWorkbookFlowsV3({
      ...baseV3,
      detectedPromille: 0.1,
      ...pastAbsorption(18, 19),
    });
    expect(out.backcalcMinPromille).toBeCloseTo(0.18, 9);
  });

  it('switches to standardRate after BAC reaches 0.2 ‰', () => {
    // detectedPromille 0.10, lowBacRate 0.08, eliminationMin 0.10, back-calc 2 hours:
    //   hoursToReachThreshold = (0.2 - 0.10) / 0.08 = 1.25 h
    //   2 > 1.25 → result = 0.2 + 0.10 * (2 - 1.25) = 0.275
    const out = evaluateEtohWorkbookFlowsV3({
      ...baseV3,
      detectedPromille: 0.1,
      ...pastAbsorption(18, 20),
    });
    expect(out.backcalcMinPromille).toBeCloseTo(0.275, 9);
  });

  it('respects per-tier rates: likely path uses eliminationLikely beyond threshold', () => {
    // Same setup, checking the likely tier:
    //   i61 = 2 h; threshold at 1.25 h × 0.08; remaining 0.75 h × 0.15 = 0.1125
    //   result = 0.2 + 0.1125 = 0.3125
    const out = evaluateEtohWorkbookFlowsV3({
      ...baseV3,
      detectedPromille: 0.1,
      ...pastAbsorption(18, 20),
    });
    expect(out.backcalcLikelyPromille).toBeCloseTo(0.3125, 9);
  });

  it('uses the configurable I7/I8 absorption-window thresholds, not hardcoded 3/1', () => {
    // absorptionMinHours = 4, sample 3.5 h after drinkStop. v3 should keep
    // the min path at 0 elapsed elimination hours (we are still inside the
    // absorption window); v1's hardcoded `3` cutoff would otherwise route
    // through the wraparound branch and inject ~24 h of elimination.
    const drinkStop = 0;
    const sampleHours = 3.5;
    const out = evaluateEtohWorkbookFlowsV3({
      ...baseV3,
      drinkStopTime: drinkStop,
      eventTime: drinkStop, // event coincides with drinkStop
      sampleTime: sampleHours / 24,
      absorptionMinHours: 4,
      absorptionLikelyHours: 4,
      detectedPromille: 1.0, // arbitrary, ≥0.2
    });
    // i60 should be 0 → backcalc reduces to the measured value.
    expect(out.backcalcMinPromille).toBeCloseTo(1.0, 12);
    expect(out.backcalcLikelyPromille).toBeCloseTo(1.0, 12);
  });

  it('honours a custom eliminationLowBac override', () => {
    // With lowBacRate = 0.04 (half of default), 1-hour back-calc from 0.10
    // returns 0.10 + 0.04 = 0.14 (still below threshold; hoursToReach = 2.5 h).
    const out = evaluateEtohWorkbookFlowsV3({
      ...baseV3,
      detectedPromille: 0.1,
      eliminationLowBac: 0.04,
      ...pastAbsorption(18, 19),
    });
    expect(out.backcalcMinPromille).toBeCloseTo(0.14, 9);
  });
});

describe('evaluateEtohWorkbookFlowsV3 — sex selector + Watson age gating', () => {
  it('male with positive age applies the male formula', () => {
    const out = evaluateEtohWorkbookFlowsV3({
      ...baseV3,
      sexEnum: SEX_MALE,
      ageYears: 42,
      heightCm: 188,
      weightKg: 85,
    });
    // Same reference number as the v1 test for the male formula.
    expect(out.wattsonR).toBe(0.66);
  });

  it('male with no age returns 0 — gates per workbook v3 F48', () => {
    const out = evaluateEtohWorkbookFlowsV3({
      ...baseV3,
      sexEnum: SEX_MALE,
      ageYears: 0,
      drinksDl: [3.3, 0, 0, 0, 0, 0],
      drinksAbvPercent: [4.7, 0, 0, 0, 0, 0],
    });
    expect(out.wattsonR).toBe(0);
    // All Wattson products collapse to 0 / null when wR is gated.
    expect(out.afterIntakeMaxPromilleWattson).toBe(0);
    expect(out.afterIntakeLikelyPromilleWattson).toBe(0);
    expect(out.afterIntakeBackcalcMinPromilleWattson).toBeNull();
    expect(out.afterIntakeBackcalcLikelyPromilleWattson).toBeNull();
  });

  it('female applies the female formula independent of age', () => {
    const out = evaluateEtohWorkbookFlowsV3({
      ...baseV3,
      sexEnum: SEX_FEMALE,
      ageYears: 0, // explicitly absent
      weightKg: 60,
      heightCm: 165,
    });
    // Same reference number as the v1 test for the female formula.
    expect(out.wattsonR).toBe(0.6);
  });

  it('falls back to the Widmark lookup table when manual r is missing', () => {
    // Sex male, weight 75 kg, height 170 cm → Vd M lookup = 0.70.
    // Theoretical Widmark promille = ethanolGrams * (1 - firstPass/100) / (kg * r).
    const out = evaluateEtohWorkbookFlowsV3({
      ...baseV3,
      sexEnum: SEX_MALE,
      weightKg: 75,
      heightCm: 170,
      widmarkR: 0, // no manual override
      drinksDl: [3.3, 0, 0, 0, 0, 0],
      drinksAbvPercent: [4.7, 0, 0, 0, 0, 0],
      firstPassMinPercent: 10,
      firstPassLikelyPercent: 20,
    });
    // grams = 330 * 4.7 * 0.8 / 100 = 12.408
    // r = 0.70, denom = 75 * 0.70 = 52.5
    // max:    12.408 * 0.90 / 52.5 ≈ 0.21271
    // likely: 12.408 * 0.80 / 52.5 ≈ 0.18908
    expect(out.afterIntakeMaxPromille).toBeCloseTo(0.21271, 4);
    expect(out.afterIntakeLikelyPromille).toBeCloseTo(0.18908, 4);
  });

  it('zeroes the Widmark theoretical promille when manual r is missing and the lookup is out of grid', () => {
    const out = evaluateEtohWorkbookFlowsV3({
      ...baseV3,
      sexEnum: SEX_MALE,
      weightKg: 130, // out of table
      heightCm: 200,
      widmarkR: 0,
      drinksDl: [3.3, 0, 0, 0, 0, 0],
      drinksAbvPercent: [4.7, 0, 0, 0, 0, 0],
    });
    expect(out.afterIntakeMaxPromille).toBe(0);
    expect(out.afterIntakeLikelyPromille).toBe(0);
    expect(out.afterIntakeBackcalcMinPromille).toBeNull();
    expect(out.afterIntakeBackcalcLikelyPromille).toBeNull();
  });

  it('sex unset falls through to the female-formula branch (v3 workbook quirk)', () => {
    const female = evaluateEtohWorkbookFlowsV3({
      ...baseV3,
      sexEnum: SEX_FEMALE,
      ageYears: 30,
      weightKg: 60,
      heightCm: 165,
    });
    const unset = evaluateEtohWorkbookFlowsV3({
      ...baseV3,
      sexEnum: SEX_UNSET,
      ageYears: 30,
      weightKg: 60,
      heightCm: 165,
    });
    expect(unset.wattsonR).toBe(female.wattsonR);
  });
});

describe('evaluateEtohWorkbookFlowsV3 — three-tier (low / likely / high)', () => {
  it('high tier reduces to the likely tier when their inputs are equal', () => {
    const out = evaluateEtohWorkbookFlowsV3({
      ...baseV3,
      eliminationHigh: baseV3.eliminationLikely,
      absorptionHighHours: baseV3.absorptionLikelyHours,
      firstPassHighPercent: baseV3.firstPassLikelyPercent,
      drinksDl: [3.3, 0, 0, 0, 0, 0],
      drinksAbvPercent: [4.7, 0, 0, 0, 0, 0],
    });
    expect(out.backcalcHighPromille).toBeCloseTo(out.backcalcLikelyPromille, 12);
    expect(out.afterIntakeMinPromille).toBeCloseTo(out.afterIntakeLikelyPromille, 12);
    expect(out.afterIntakeMinPromilleWattson).toBeCloseTo(
      out.afterIntakeLikelyPromilleWattson,
      12,
    );
  });

  it('with default absorptionHighHours=0 and event past drinkStop, i62 = sample - event hours', () => {
    // drinkStop at midnight, event at 18:00, sample at 19:00 → i62 should be 1.0,
    // so backcalcHigh = 0.84 + 0.20 * 1.0 = 1.04 (b6 ≥ 0.2 → linear branch).
    const out = evaluateEtohWorkbookFlowsV3({
      ...baseV3,
      drinkStopTime: 0,
      eventTime: 18 / 24,
      sampleTime: 19 / 24,
      detectedPromille: 0.84,
    });
    expect(out.backcalcHighPromille).toBeCloseTo(0.84 + 0.2, 12);
  });

  it('afterIntakeMinPromille uses firstPassHighPercent — highest first-pass yields lowest promille', () => {
    // grams = 330 * 4.7 * 0.8 / 100 = 12.408. r = 0.70, denom = 78 * 0.70 = 54.6.
    // firstPassHighPercent = 35 → afterIntakeMin = 12.408 * 0.65 / 54.6 ≈ 0.14770
    const out = evaluateEtohWorkbookFlowsV3({
      ...baseV3,
      firstPassMinPercent: 15,
      firstPassLikelyPercent: 25,
      firstPassHighPercent: 35,
      drinksDl: [3.3, 0, 0, 0, 0, 0],
      drinksAbvPercent: [4.7, 0, 0, 0, 0, 0],
    });
    expect(out.afterIntakeMaxPromille).toBeGreaterThan(out.afterIntakeLikelyPromille);
    expect(out.afterIntakeLikelyPromille).toBeGreaterThan(out.afterIntakeMinPromille);
    expect(out.afterIntakeMinPromille).toBeCloseTo(0.14770, 4);
  });

  it('afterIntakeBackcalcHighPromille is null with no drinks (mirrors workbook B58 = "")', () => {
    const out = evaluateEtohWorkbookFlowsV3({
      ...baseV3,
      drinksDl: [0, 0, 0, 0, 0, 0],
      drinksAbvPercent: [0, 0, 0, 0, 0, 0],
    });
    expect(out.afterIntakeMinPromille).toBe(0);
    expect(out.afterIntakeBackcalcHighPromille).toBeNull();
    expect(out.afterIntakeBackcalcHighPromilleWattson).toBeNull();
  });
});
