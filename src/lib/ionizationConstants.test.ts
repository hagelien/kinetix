import { describe, expect, it } from 'vitest';
import {
  deriveBasicPKa,
  deriveLogD,
  neutralFractionAtPh,
  transitionKey,
  type IonizationConstant,
} from './ionizationConstants';

const base = (over: Partial<IonizationConstant>): IonizationConstant => ({
  pKa: 8.4,
  protonatedCharge: 1,
  deprotonatedCharge: 0,
  evidenceType: 'experimental',
  ...over,
});

describe('deriveBasicPKa', () => {
  it('returns the pKa of the +1 → 0 transition', () => {
    expect(deriveBasicPKa([base({ pKa: 8.4 })])).toBe(8.4);
  });

  it('returns null for an acid-only profile (0 → -1)', () => {
    expect(
      deriveBasicPKa([
        base({ pKa: 4.5, protonatedCharge: 0, deprotonatedCharge: -1 }),
      ]),
    ).toBeNull();
  });

  it('returns null for an empty/absent profile', () => {
    expect(deriveBasicPKa([])).toBeNull();
    expect(deriveBasicPKa(null)).toBeNull();
  });

  it('prefers experimental values and takes their median within the transition', () => {
    const constants: IonizationConstant[] = [
      base({ pKa: 8.1, evidenceType: 'experimental' }),
      base({ pKa: 8.3, evidenceType: 'experimental' }),
      base({ pKa: 9.9, evidenceType: 'predicted' }),
    ];
    // Median of the two experimental values, predicted ignored.
    expect(deriveBasicPKa(constants)).toBeCloseTo(8.2, 6);
  });

  it('uses only macroscopic constants, ignoring microscopic ones for the same transition', () => {
    const constants: IonizationConstant[] = [
      base({ pKa: 8.4, evidenceType: 'experimental', type: 'macroscopic' }),
      base({ pKa: 6.0, evidenceType: 'experimental', type: 'microscopic', siteLabel: 'site A' }),
    ];
    // Microscopic value must not drag the macroscopic basic pKa down.
    expect(deriveBasicPKa(constants)).toBe(8.4);
  });

  it('returns null when the +1 → 0 transition has only microscopic constants', () => {
    expect(
      deriveBasicPKa([base({ pKa: 8.4, type: 'microscopic', siteLabel: 'site A' })]),
    ).toBeNull();
  });

  it('picks only the +1 → 0 transition from an amphoteric profile', () => {
    const constants: IonizationConstant[] = [
      base({ pKa: 9.2, protonatedCharge: 1, deprotonatedCharge: 0 }),
      base({ pKa: 4.1, protonatedCharge: 0, deprotonatedCharge: -1 }),
    ];
    expect(deriveBasicPKa(constants)).toBe(9.2);
  });
});

describe('neutralFractionAtPh', () => {
  it('monoprotic base: f_neutral = 1 / (1 + 10^(pKa − pH))', () => {
    const f = neutralFractionAtPh([base({ pKa: 8.4 })], 7.4);
    expect(f).toBeCloseTo(1 / (1 + 10 ** (8.4 - 7.4)), 6); // = 1/11
  });

  it('monoprotic acid: mostly ionized above its pKa', () => {
    const f = neutralFractionAtPh(
      [base({ pKa: 4.5, protonatedCharge: 0, deprotonatedCharge: -1 })],
      7.4,
    );
    expect(f).toBeCloseTo(1 / (1 + 10 ** (7.4 - 4.5)), 6);
  });

  it('diprotic base: normalizes across +2/+1/0 states', () => {
    const constants: IonizationConstant[] = [
      base({ pKa: 10.1, protonatedCharge: 2, deprotonatedCharge: 1 }),
      base({ pKa: 7.8, protonatedCharge: 1, deprotonatedCharge: 0 }),
    ];
    const f = neutralFractionAtPh(constants, 7.4);
    const p1 = 10 ** -(7.4 - 7.8);
    const p2 = p1 * 10 ** -(7.4 - 10.1);
    expect(f).toBeCloseTo(1 / (1 + p1 + p2), 6);
  });

  it('returns null for a non-adjacent (invalid) transition', () => {
    expect(
      neutralFractionAtPh(
        [base({ protonatedCharge: 2, deprotonatedCharge: 0 })],
        7.4,
      ),
    ).toBeNull();
  });

  it('returns null for a profile disconnected from the neutral state', () => {
    // A lone +2 → +1 transition never reaches charge 0, so no neutral fraction
    // can be established.
    expect(
      neutralFractionAtPh(
        [base({ pKa: 9, protonatedCharge: 2, deprotonatedCharge: 1 })],
        7.4,
      ),
    ).toBeNull();
    // A partially-connected profile with a disconnected component is rejected too.
    expect(
      neutralFractionAtPh(
        [
          base({ pKa: 8.4, protonatedCharge: 1, deprotonatedCharge: 0 }),
          base({ pKa: 12, protonatedCharge: 3, deprotonatedCharge: 2 }),
        ],
        7.4,
      ),
    ).toBeNull();
  });

  it('aggregates repeated measurements of one transition deterministically (median, not pairwise midpoint)', () => {
    const constants: IonizationConstant[] = [8, 9, 10].map((pKa) =>
      base({ pKa, protonatedCharge: 1, deprotonatedCharge: 0 }),
    );
    // Median of 8/9/10 is 9; a pairwise-midpoint fold would give 9.25 and depend
    // on row order.
    const f = neutralFractionAtPh(constants, 7.4);
    const reversed = neutralFractionAtPh([...constants].reverse(), 7.4);
    expect(f).toBeCloseTo(1 / (1 + 10 ** (9 - 7.4)), 6);
    expect(f).toBe(reversed);
  });

  it('returns null when a transition has only microscopic constants', () => {
    expect(
      neutralFractionAtPh(
        [base({ pKa: 8.4, type: 'microscopic', siteLabel: 'site A' })],
        7.4,
      ),
    ).toBeNull();
  });

  it('uses the macroscopic value when both macro and micro are present', () => {
    const f = neutralFractionAtPh(
      [
        base({ pKa: 8.4, type: 'macroscopic' }),
        base({ pKa: 6.0, type: 'microscopic', siteLabel: 'site A' }),
      ],
      7.4,
    );
    expect(f).toBeCloseTo(1 / (1 + 10 ** (8.4 - 7.4)), 6);
  });

  it('returns null for an empty profile', () => {
    expect(neutralFractionAtPh([], 7.4)).toBeNull();
  });
});

describe('deriveLogD', () => {
  it('logD = logP + log10(f_neutral), flagged derived', () => {
    const constants = [base({ pKa: 8.4 })];
    const f = neutralFractionAtPh(constants, 7.4)!;
    const result = deriveLogD(2.0, constants, 7.4);
    expect(result).not.toBeNull();
    expect(result!.derived).toBe(true);
    expect(result!.pH).toBe(7.4);
    expect(result!.value).toBeCloseTo(2.0 + Math.log10(f), 6);
  });

  it('is lower than logP for an ionized base (only neutral partitions)', () => {
    const result = deriveLogD(2.0, [base({ pKa: 9.9 })], 7.4);
    expect(result!.value).toBeLessThan(2.0);
  });

  it('returns null without logP or without an ionization profile', () => {
    expect(deriveLogD(null, [base({ pKa: 8.4 })], 7.4)).toBeNull();
    expect(deriveLogD(2.0, [], 7.4)).toBeNull();
  });
});

describe('transitionKey', () => {
  it('distinguishes transitions', () => {
    expect(transitionKey({ protonatedCharge: 1, deprotonatedCharge: 0 })).toBe(
      '1->0',
    );
    expect(transitionKey({ protonatedCharge: 0, deprotonatedCharge: -1 })).toBe(
      '0->-1',
    );
  });
});
