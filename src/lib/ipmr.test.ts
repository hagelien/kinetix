import { describe, expect, it } from 'vitest';
import {
  computeIpmrLs,
  deriveDrugIpmr,
  ipmrBand,
  type IpmrInputs,
} from './ipmr';

describe('computeIpmrLs (iPMR-LS v1.1)', () => {
  const amphetamine: IpmrInputs = {
    vd: 4,
    logP: 1.76,
    pKaBasic: 9.9,
    logD74: -0.7,
    fu: 0.8,
  };

  it('reproduces the amphetamine worked example (60–65 band)', () => {
    const score = computeIpmrLs(amphetamine);
    expect(score).toBe(64);
    expect(ipmrBand(score!)).toBe('high');
  });

  it('falls back to logP when logD7.4 is absent', () => {
    const withLogD = computeIpmrLs({ ...amphetamine, logD74: -0.7 });
    const withoutLogD = computeIpmrLs({ ...amphetamine, logD74: null });
    // Dropping the (lower) logD7.4 and falling back to the higher logP can
    // only raise the small L_D contribution, so the score does not drop.
    expect(withoutLogD!).toBeGreaterThanOrEqual(withLogD!);
  });

  it('treats a missing basic centre as B = 0', () => {
    const basic = computeIpmrLs({ ...amphetamine, pKaBasic: 9.9 });
    const nonBasic = computeIpmrLs({ ...amphetamine, pKaBasic: null });
    expect(nonBasic!).toBeLessThan(basic!);
  });

  it('imputes fu = 0.5 when protein binding is unknown', () => {
    const explicit = computeIpmrLs({ ...amphetamine, fu: 0.5 });
    const imputed = computeIpmrLs({ ...amphetamine, fu: null });
    expect(imputed).toBe(explicit);
  });

  it('returns null without the two required inputs', () => {
    expect(computeIpmrLs({ ...amphetamine, vd: 0 })).toBeNull();
    expect(computeIpmrLs({ ...amphetamine, vd: Number.NaN })).toBeNull();
    expect(computeIpmrLs({ ...amphetamine, logP: Number.NaN })).toBeNull();
  });

  it('stays within 0–100', () => {
    const high = computeIpmrLs({
      vd: 50,
      logP: 6,
      pKaBasic: 11,
      logD74: 5,
      fu: 1,
    });
    const low = computeIpmrLs({
      vd: 0.1,
      logP: -2,
      pKaBasic: null,
      logD74: -2,
      fu: 0,
    });
    expect(high!).toBeLessThanOrEqual(100);
    expect(low!).toBeGreaterThanOrEqual(0);
    expect(ipmrBand(low!)).toBe('low');
  });
});

describe('ipmrBand', () => {
  it('maps scores to interpretation bands', () => {
    expect(ipmrBand(0)).toBe('low');
    expect(ipmrBand(20)).toBe('low');
    expect(ipmrBand(21)).toBe('lowModerate');
    expect(ipmrBand(40)).toBe('lowModerate');
    expect(ipmrBand(41)).toBe('moderate');
    expect(ipmrBand(60)).toBe('moderate');
    expect(ipmrBand(61)).toBe('high');
    expect(ipmrBand(80)).toBe('high');
    expect(ipmrBand(81)).toBe('veryHigh');
    expect(ipmrBand(100)).toBe('veryHigh');
  });
});

describe('deriveDrugIpmr', () => {
  it('derives from stored drug parameters (logD7.4 + protein binding → fu = 1 − bound)', () => {
    const result = deriveDrugIpmr({
      volumeOfDistribution: { median: 4, unit: 'L/kg' },
      logP: { median: 1.76 },
      logD: { median: -0.7 },
      pKa: { median: 9.9 },
      proteinBinding: { median: 0.2, unit: 'fraction' },
    });
    expect(result).not.toBeNull();
    expect(result!.score).toBe(
      computeIpmrLs({
        vd: 4,
        logP: 1.76,
        pKaBasic: 9.9,
        logD74: -0.7,
        fu: 0.8,
      }),
    );
  });

  it('falls back to logP when the logD parameter is not set', () => {
    const result = deriveDrugIpmr({
      volumeOfDistribution: { median: 4, unit: 'L/kg' },
      logP: { median: 1.76 },
      pKa: { median: 9.9 },
      proteinBinding: { median: 0.2, unit: 'fraction' },
    });
    expect(result!.score).toBe(
      computeIpmrLs({
        vd: 4,
        logP: 1.76,
        pKaBasic: 9.9,
        logD74: null,
        fu: 0.8,
      }),
    );
  });

  it('returns null when required inputs are missing', () => {
    expect(deriveDrugIpmr({ logP: { median: 2 } })).toBeNull();
    expect(
      deriveDrugIpmr({ volumeOfDistribution: { median: 4, unit: 'L/kg' } }),
    ).toBeNull();
    expect(deriveDrugIpmr(null)).toBeNull();
  });

  it('derives pKaBasic from the +1 → 0 ionization transition, not the scalar pKa', () => {
    const result = deriveDrugIpmr({
      volumeOfDistribution: { median: 4, unit: 'L/kg' },
      logP: { median: 1.76 },
      logD: { median: -0.7 },
      proteinBinding: { median: 0.2, unit: 'fraction' },
      // A basic centre at 9.9 alongside an acidic one that must be ignored.
      ionizationConstants: [
        { pKa: 9.9, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental' },
        { pKa: 4.1, protonatedCharge: 0, deprotonatedCharge: -1, evidenceType: 'experimental' },
      ],
    });
    expect(result!.score).toBe(
      computeIpmrLs({ vd: 4, logP: 1.76, pKaBasic: 9.9, logD74: -0.7, fu: 0.8 }),
    );
  });

  it('yields B = 0 for an acid-only ionization profile (no +1 → 0 transition)', () => {
    const acid = deriveDrugIpmr({
      volumeOfDistribution: { median: 4, unit: 'L/kg' },
      logP: { median: 1.76 },
      logD: { median: -0.7 },
      proteinBinding: { median: 0.2, unit: 'fraction' },
      // A high numeric pKa on an ACIDIC transition must NOT be read as basic.
      pKa: { median: 9.9 },
      ionizationConstants: [
        { pKa: 9.9, protonatedCharge: 0, deprotonatedCharge: -1, evidenceType: 'experimental' },
      ],
    });
    expect(acid!.score).toBe(
      computeIpmrLs({ vd: 4, logP: 1.76, pKaBasic: null, logD74: -0.7, fu: 0.8 }),
    );
  });

  it('falls back to the scalar pKa only when no ionization constants are present', () => {
    const result = deriveDrugIpmr({
      volumeOfDistribution: { median: 4, unit: 'L/kg' },
      logP: { median: 1.76 },
      logD: { median: -0.7 },
      pKa: { median: 9.9 },
      proteinBinding: { median: 0.2, unit: 'fraction' },
    });
    expect(result!.score).toBe(
      computeIpmrLs({ vd: 4, logP: 1.76, pKaBasic: 9.9, logD74: -0.7, fu: 0.8 }),
    );
  });

  it('derives logD7.4 transiently from logP + ionization profile when logD is unmeasured', () => {
    const constants = [
      { pKa: 9.9, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental' as const },
    ];
    const result = deriveDrugIpmr({
      volumeOfDistribution: { median: 4, unit: 'L/kg' },
      logP: { median: 1.76 },
      proteinBinding: { median: 0.2, unit: 'fraction' },
      ionizationConstants: constants,
    });
    expect(result!.logD74Derived).toBe(true);
    // f_neutral at pH 7.4 for a base with pKa 9.9.
    const fNeutral = 1 / (1 + 10 ** (9.9 - 7.4));
    expect(result!.inputs.logD74).toBeCloseTo(1.76 + Math.log10(fNeutral), 6);
  });

  it('does not flag logD as derived when a measured logD is present', () => {
    const result = deriveDrugIpmr({
      volumeOfDistribution: { median: 4, unit: 'L/kg' },
      logP: { median: 1.76 },
      logD: { median: -0.7 },
      ionizationConstants: [
        { pKa: 9.9, protonatedCharge: 1, deprotonatedCharge: 0, evidenceType: 'experimental' },
      ],
    });
    expect(result!.logD74Derived).toBeUndefined();
    expect(result!.inputs.logD74).toBe(-0.7);
  });

  it('uses min/max midpoints for ranged inputs', () => {
    const result = deriveDrugIpmr({
      volumeOfDistribution: { min: 2, max: 6, unit: 'L/kg' },
      logP: { median: 1.76 },
    });
    expect(result).not.toBeNull();
    // Midpoint of 2–6 is 4, matching the worked example's Vd.
    expect(result!.score).toBe(
      computeIpmrLs({
        vd: 4,
        logP: 1.76,
        pKaBasic: null,
        logD74: null,
        fu: null,
      }),
    );
  });
});
