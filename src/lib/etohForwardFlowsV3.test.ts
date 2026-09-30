import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FORWARD_ELIMINATION_HIGH,
  DEFAULT_FORWARD_ELIMINATION_LIKELY,
  DEFAULT_FORWARD_ELIMINATION_LOW,
  evaluateEtohForwardFlowsV3,
  type EtohForwardInput,
} from './etohForwardFlowsV3';
import { SEX_FEMALE, SEX_MALE, SEX_UNSET } from './etohWorkbookFlowsV3';

const baseForward: EtohForwardInput = {
  drinkStartTime: 0, // midnight
  eventTime: 2 / 24, // 02:00 — two hours later
  drinksDl: [3.3, 0, 0, 0, 0, 0],
  drinksAbvPercent: [4.7, 0, 0, 0, 0, 0],
  firstPassMinPercent: 10,
  firstPassLikelyPercent: 20,
  firstPassHighPercent: 30,
  weightKg: 75,
  heightCm: 180,
  widmarkR: 0.7,
  sexEnum: SEX_MALE,
  ageYears: 35,
  forwardEliminationHigh: DEFAULT_FORWARD_ELIMINATION_HIGH,
  forwardEliminationLikely: DEFAULT_FORWARD_ELIMINATION_LIKELY,
  forwardEliminationLow: DEFAULT_FORWARD_ELIMINATION_LOW,
};

describe('evaluateEtohForwardFlowsV3 — ethanol grams (workbook B23)', () => {
  it('multiplies dL × ABV% × 0.8 for the active drink slot', () => {
    // 3.3 dL × 4.7% × 0.8 = 12.408 g
    const out = evaluateEtohForwardFlowsV3(baseForward);
    expect(out.ethanolGrams).toBeCloseTo(12.408, 6);
  });

  it('sums across all six drink slots', () => {
    const out = evaluateEtohForwardFlowsV3({
      ...baseForward,
      drinksDl: [1, 2, 0.5, 0, 0, 0],
      drinksAbvPercent: [4, 5, 40, 0, 0, 0],
    });
    // (1*4 + 2*5 + 0.5*40) * 0.8 = (4 + 10 + 20) * 0.8 = 27.2
    expect(out.ethanolGrams).toBeCloseTo(27.2, 6);
  });

  it('returns 0 when all drinks are empty', () => {
    const out = evaluateEtohForwardFlowsV3({
      ...baseForward,
      drinksDl: [0, 0, 0, 0, 0, 0],
      drinksAbvPercent: [0, 0, 0, 0, 0, 0],
    });
    expect(out.ethanolGrams).toBe(0);
    expect(out.theoreticalHighPromille).toBe(0);
    expect(out.forwardHighPromille).toBe(0);
  });
});

describe('evaluateEtohForwardFlowsV3 — theoretical promille (Widmark)', () => {
  it('B24 / B25 / B26 use the three first-pass tiers (high → low → as workbook labels them)', () => {
    // grams = 12.408, kg*r = 75*0.7 = 52.5
    // high tier (first-pass min):    12.408 * 0.90 / 52.5 ≈ 0.21271
    // likely:                        12.408 * 0.80 / 52.5 ≈ 0.18908
    // low tier (first-pass high):    12.408 * 0.70 / 52.5 ≈ 0.16544
    const out = evaluateEtohForwardFlowsV3(baseForward);
    expect(out.theoreticalHighPromille).toBeCloseTo(0.21271, 4);
    expect(out.theoreticalLikelyPromille).toBeCloseTo(0.18908, 4);
    expect(out.theoreticalLowPromille).toBeCloseTo(0.16544, 4);
    // Tier ordering: high > likely > low.
    expect(out.theoreticalHighPromille).toBeGreaterThan(out.theoreticalLikelyPromille);
    expect(out.theoreticalLikelyPromille).toBeGreaterThan(out.theoreticalLowPromille);
  });

  it('zeroes when manual r is missing and the lookup is out of grid', () => {
    const out = evaluateEtohForwardFlowsV3({
      ...baseForward,
      widmarkR: 0,
      weightKg: 130,
      heightCm: 200,
    });
    expect(out.theoreticalHighPromille).toBe(0);
    expect(out.theoreticalLikelyPromille).toBe(0);
    expect(out.theoreticalLowPromille).toBe(0);
  });

  it('falls back to the Vd M lookup table when manual r is 0', () => {
    // Sex male, weight 75 kg (rounded), height 180 cm → Vd M[180][75] = 0.74.
    // grams = 12.408, kg*r = 75*0.74 = 55.5; high-tier theoretical = 12.408*0.90/55.5 ≈ 0.20121.
    const out = evaluateEtohForwardFlowsV3({
      ...baseForward,
      widmarkR: 0,
    });
    expect(out.widmarkREffective).toBeCloseTo(0.74, 12);
    expect(out.theoreticalHighPromille).toBeCloseTo(0.20121, 4);
  });
});

describe('evaluateEtohForwardFlowsV3 — Watson r and its products', () => {
  it('male with positive age applies the male formula', () => {
    const out = evaluateEtohForwardFlowsV3({
      ...baseForward,
      sexEnum: SEX_MALE,
      ageYears: 42,
      heightCm: 188,
      weightKg: 85,
    });
    // Same reference number as the back-calc engine's male formula test.
    expect(out.wattsonR).toBe(0.66);
  });

  it('male with no age returns Watson r = 0 and zeroes Watson products', () => {
    const out = evaluateEtohForwardFlowsV3({
      ...baseForward,
      sexEnum: SEX_MALE,
      ageYears: 0,
    });
    expect(out.wattsonR).toBe(0);
    expect(out.theoreticalHighPromilleWattson).toBe(0);
    expect(out.forwardHighPromilleWattson).toBe(0);
  });

  it('female applies the female formula independent of age', () => {
    const out = evaluateEtohForwardFlowsV3({
      ...baseForward,
      sexEnum: SEX_FEMALE,
      ageYears: 0,
      weightKg: 60,
      heightCm: 165,
    });
    expect(out.wattsonR).toBe(0.6);
  });

  it('sex unset falls through to the female-formula branch (workbook quirk)', () => {
    const female = evaluateEtohForwardFlowsV3({
      ...baseForward,
      sexEnum: SEX_FEMALE,
      ageYears: 30,
      weightKg: 60,
      heightCm: 165,
    });
    const unset = evaluateEtohForwardFlowsV3({
      ...baseForward,
      sexEnum: SEX_UNSET,
      ageYears: 30,
      weightKg: 60,
      heightCm: 165,
    });
    expect(unset.wattsonR).toBe(female.wattsonR);
  });
});

describe('evaluateEtohForwardFlowsV3 — forward projection (workbook B52/B53/B54)', () => {
  it('subtracts elimination rate × hours from the matching theoretical tier', () => {
    // 2-hour window, defaults rates 0.10 / 0.15 / 0.20.
    // forwardHigh = max(0, 0.21271 - 0.10*2) = max(0, 0.01271) = 0.01271
    // forwardLikely = max(0, 0.18908 - 0.15*2) = max(0, -0.11092) = 0
    // forwardLow    = max(0, 0.16544 - 0.20*2) = max(0, -0.23456) = 0
    const out = evaluateEtohForwardFlowsV3(baseForward);
    expect(out.forwardHighPromille).toBeCloseTo(0.01271, 4);
    expect(out.forwardLikelyPromille).toBe(0);
    expect(out.forwardLowPromille).toBe(0);
  });

  it('clamps to 0 when elimination would carry the BAC below zero', () => {
    // 5-hour window, fastest rate 0.20 → eliminates 1.0 ‰ which exceeds any
    // theoretical tier here.
    const out = evaluateEtohForwardFlowsV3({
      ...baseForward,
      eventTime: 5 / 24,
    });
    expect(out.forwardLowPromille).toBe(0);
  });

  it('forwardHours wraps across midnight via deltaHours', () => {
    const out = evaluateEtohForwardFlowsV3({
      ...baseForward,
      drinkStartTime: 23 / 24, // 23:00
      eventTime: 1 / 24, // 01:00 next day
    });
    expect(out.forwardHours).toBeCloseTo(2, 12);
  });

  it('honours custom forward elimination rates', () => {
    // With high-rate 0 (no elimination), forwardHigh equals theoreticalHigh.
    const out = evaluateEtohForwardFlowsV3({
      ...baseForward,
      forwardEliminationHigh: 0,
    });
    expect(out.forwardHighPromille).toBeCloseTo(out.theoreticalHighPromille, 12);
  });

  it('Watson siblings track Watson theoretical via the same projection rule', () => {
    const out = evaluateEtohForwardFlowsV3({
      ...baseForward,
      forwardEliminationHigh: 0, // pin forward = theoretical for the high tier
    });
    expect(out.forwardHighPromilleWattson).toBeCloseTo(
      out.theoreticalHighPromilleWattson,
      12,
    );
  });
});
