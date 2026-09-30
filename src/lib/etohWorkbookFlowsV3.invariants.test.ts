import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_ABSORPTION_HIGH_HOURS,
  DEFAULT_ELIMINATION_HIGH,
  DEFAULT_ELIMINATION_LOW_BAC,
  DEFAULT_FIRST_PASS_HIGH_PERCENT,
  SEX_FEMALE,
  SEX_MALE,
  evaluateEtohWorkbookFlowsV3,
  type EtohV3ParityInput,
  type SexEnum,
} from './etohWorkbookFlowsV3';

/**
 * Property-based tests on the v3 engine alone.
 *
 * These verify mathematical invariants that must hold for any input — no
 * oracle needed. Failures here indicate the v3 hand-port has a structural
 * bug independent of the snapshot. Ported from the v1 invariants suite when
 * the v1 engine was retired. 200 runs per property keeps the suite fast while
 * still exploring the input space broadly.
 */

const RUNS = 200;

const dbl = (min: number, max: number) =>
  fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

const arbDrinks = fc
  .array(dbl(0, 5), { minLength: 6, maxLength: 6 })
  .map((arr) => arr as unknown as [number, number, number, number, number, number]);

const arbAbv = fc
  .array(dbl(0, 60), { minLength: 6, maxLength: 6 })
  .map((arr) => arr as unknown as [number, number, number, number, number, number]);

function arbInput(overrides: Partial<EtohV3ParityInput> = {}): fc.Arbitrary<EtohV3ParityInput> {
  return fc
    .record({
      drinkStopTime: dbl(0, 0.999),
      eventTime: dbl(0, 0.999),
      sampleTime: dbl(0, 0.999),
      detectedPromille: dbl(0, 4),
      eliminationMin: fc.constantFrom(0.08, 0.1, 0.12),
      eliminationLikely: fc.constantFrom(0.13, 0.15, 0.18),
      eliminationHigh: fc.constantFrom(0.18, 0.2, 0.22),
      eliminationLowBac: fc.constantFrom(0.06, 0.08, 0.1),
      absorptionMinHours: fc.constantFrom(2, 3, 4),
      absorptionLikelyHours: fc.constantFrom(0.5, 1, 1.5),
      absorptionHighHours: fc.constantFrom(0, 0.5, 1),
      drinksDl: arbDrinks,
      drinksAbvPercent: arbAbv,
      firstPassMinPercent: dbl(0, 30),
      firstPassLikelyPercent: dbl(0, 50),
      firstPassHighPercent: dbl(0, 70),
      weightKg: dbl(40, 130),
      widmarkR: dbl(0.5, 0.85),
      sexEnum: fc.constantFrom(SEX_MALE, SEX_FEMALE) as fc.Arbitrary<SexEnum>,
      heightCm: dbl(140, 210),
      ageYears: dbl(18, 90),
    })
    .map((v) => ({ ...v, ...overrides }));
}

describe('EtOH v3 engine invariants (oracle-free)', () => {
  it('zero detected promille → zero back-calc on every tier', () => {
    fc.assert(
      fc.property(arbInput({ detectedPromille: 0 }), (input) => {
        const out = evaluateEtohWorkbookFlowsV3(input);
        expect(out.backcalcMinPromille).toBe(0);
        expect(out.backcalcLikelyPromille).toBe(0);
        expect(out.backcalcHighPromille).toBe(0);
      }),
      { numRuns: RUNS, seed: 42 },
    );
  });

  it('zero drinks → zero ethanolGrams and after-intake outputs (all tiers)', () => {
    fc.assert(
      fc.property(
        arbInput({
          drinksDl: [0, 0, 0, 0, 0, 0],
          drinksAbvPercent: [0, 0, 0, 0, 0, 0],
        }),
        (input) => {
          const out = evaluateEtohWorkbookFlowsV3(input);
          expect(out.ethanolGrams).toBe(0);
          expect(out.afterIntakeMaxPromille).toBe(0);
          expect(out.afterIntakeLikelyPromille).toBe(0);
          expect(out.afterIntakeMinPromille).toBe(0);
          expect(out.afterIntakeBackcalcMinPromille).toBeNull();
          expect(out.afterIntakeBackcalcLikelyPromille).toBeNull();
          expect(out.afterIntakeBackcalcHighPromille).toBeNull();
        },
      ),
      { numRuns: RUNS, seed: 43 },
    );
  });

  it('doubling all drink volumes doubles ethanolGrams and after-intake promille', () => {
    fc.assert(
      fc.property(arbInput(), (input) => {
        const base = evaluateEtohWorkbookFlowsV3(input);
        const doubled = evaluateEtohWorkbookFlowsV3({
          ...input,
          drinksDl: input.drinksDl.map((v) => v * 2) as [
            number,
            number,
            number,
            number,
            number,
            number,
          ],
        });
        if (base.ethanolGrams === 0) return; // nothing to compare
        expect(doubled.ethanolGrams).toBeCloseTo(base.ethanolGrams * 2, 9);
        expect(doubled.afterIntakeMaxPromille).toBeCloseTo(base.afterIntakeMaxPromille * 2, 9);
        expect(doubled.afterIntakeLikelyPromille).toBeCloseTo(
          base.afterIntakeLikelyPromille * 2,
          9,
        );
        expect(doubled.afterIntakeMinPromille).toBeCloseTo(base.afterIntakeMinPromille * 2, 9);
      }),
      { numRuns: RUNS, seed: 44 },
    );
  });

  it('higher first-pass percent → lower after-intake promille (monotonic)', () => {
    fc.assert(
      fc.property(
        arbInput().filter((i) => i.drinksDl.some((v, idx) => v * (i.drinksAbvPercent[idx] ?? 0) > 0)),
        (input) => {
          const low = evaluateEtohWorkbookFlowsV3({ ...input, firstPassMinPercent: 5 });
          const high = evaluateEtohWorkbookFlowsV3({ ...input, firstPassMinPercent: 25 });
          expect(high.afterIntakeMaxPromille).toBeLessThanOrEqual(low.afterIntakeMaxPromille);
        },
      ),
      { numRuns: RUNS, seed: 45 },
    );
  });

  it('larger weight → lower after-intake promille (Widmark monotonic)', () => {
    fc.assert(
      fc.property(
        arbInput().filter((i) => i.drinksDl.some((v, idx) => v * (i.drinksAbvPercent[idx] ?? 0) > 0)),
        (input) => {
          const light = evaluateEtohWorkbookFlowsV3({ ...input, weightKg: 60 });
          const heavy = evaluateEtohWorkbookFlowsV3({ ...input, weightKg: 100 });
          expect(heavy.afterIntakeMaxPromille).toBeLessThanOrEqual(
            light.afterIntakeMaxPromille,
          );
        },
      ),
      { numRuns: RUNS, seed: 46 },
    );
  });

  it('higher elimination rate → higher back-calc (when measured BAC ≥ 0.2)', () => {
    fc.assert(
      fc.property(
        arbInput({ detectedPromille: 1.0 }).filter((i) => i.detectedPromille > 0),
        (input) => {
          const slow = evaluateEtohWorkbookFlowsV3({ ...input, eliminationMin: 0.08 });
          const fast = evaluateEtohWorkbookFlowsV3({ ...input, eliminationMin: 0.18 });
          expect(fast.backcalcMinPromille).toBeGreaterThanOrEqual(slow.backcalcMinPromille);
        },
      ),
      { numRuns: RUNS, seed: 47 },
    );
  });

  it('three-tier ordering: high ≥ likely ≥ min back-calc when rates are ordered', () => {
    fc.assert(
      fc.property(arbInput({ detectedPromille: 1.0 }), (input) => {
        const ordered = evaluateEtohWorkbookFlowsV3({
          ...input,
          eliminationMin: 0.1,
          eliminationLikely: 0.15,
          eliminationHigh: 0.2,
          // Match absorption windows so the three paths share i60/i61/i62 hours.
          absorptionMinHours: 1,
          absorptionLikelyHours: 1,
          absorptionHighHours: 1,
        });
        expect(ordered.backcalcHighPromille).toBeGreaterThanOrEqual(
          ordered.backcalcLikelyPromille,
        );
        expect(ordered.backcalcLikelyPromille).toBeGreaterThanOrEqual(
          ordered.backcalcMinPromille,
        );
      }),
      { numRuns: RUNS, seed: 48 },
    );
  });
});

// Sanity: keep the defaults importable so future refactors notice if a
// constant gets renamed.
void DEFAULT_ABSORPTION_HIGH_HOURS;
void DEFAULT_ELIMINATION_HIGH;
void DEFAULT_ELIMINATION_LOW_BAC;
void DEFAULT_FIRST_PASS_HIGH_PERCENT;
