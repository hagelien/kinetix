import { describe, expect, it } from 'vitest';
import { bacAtTime, estimateBacCurve } from './bac';
import type { EthanolIntake, EthanolPersonParams } from './types';

const params: EthanolPersonParams = {
  weightKg: 70,
  biologicalSex: 'male',
  eliminationRateGdlPerHour: 0.015,
};

const r = 0.68; // male Widmark factor
const rise = (grams: number) => grams / (r * params.weightKg * 10);

describe('bacAtTime — chronological state model', () => {
  it('single intake declines at exactly β after the peak', () => {
    const intakes: EthanolIntake[] = [
      { id: '1', timeHour: 0, ethanolGrams: 28 },
    ];
    const atOne = bacAtTime(intakes, params, 1);
    const atTwo = bacAtTime(intakes, params, 2);
    expect(atOne - atTwo).toBeCloseTo(0.015, 6);
  });

  it('two overlapping intakes still decline at β (not 2β) after the last intake', () => {
    const intakes: EthanolIntake[] = [
      { id: '1', timeHour: 0, ethanolGrams: 28 },
      { id: '2', timeHour: 1, ethanolGrams: 28 },
    ];
    // After the second intake the whole pool decays once at β per hour.
    const atTwo = bacAtTime(intakes, params, 2);
    const atThree = bacAtTime(intakes, params, 3);
    const slope = atTwo - atThree;
    expect(slope).toBeCloseTo(0.015, 6); // β, NOT 0.030
  });

  it('adds each intake instantaneously after decaying the running total once', () => {
    const intakes: EthanolIntake[] = [
      { id: '1', timeHour: 0, ethanolGrams: 28 },
      { id: '2', timeHour: 1, ethanolGrams: 28 },
    ];
    // At t=1: decay intake-1's rise by β·1, then add intake-2's rise.
    const expected = Math.max(0, rise(28) - 0.015) + rise(28);
    expect(bacAtTime(intakes, params, 1)).toBeCloseTo(expected, 6);
  });

  it('clamps at zero and a later drink starts a fresh rise', () => {
    const intakes: EthanolIntake[] = [
      { id: '1', timeHour: 0, ethanolGrams: 7 }, // small, fully cleared by t=10
      { id: '2', timeHour: 10, ethanolGrams: 28 },
    ];
    // The first drink is long gone; the second starts from its own rise.
    expect(bacAtTime(intakes, params, 10)).toBeCloseTo(rise(28), 6);
  });

  it('returns 0 before any intake and with no intakes', () => {
    expect(bacAtTime([], params, 5)).toBe(0);
    expect(
      bacAtTime([{ id: '1', timeHour: 2, ethanolGrams: 28 }], params, 1),
    ).toBe(0);
  });

  it('estimateBacCurve uses the same state model as bacAtTime', () => {
    const intakes: EthanolIntake[] = [
      { id: '1', timeHour: 0, ethanolGrams: 28 },
      { id: '2', timeHour: 1, ethanolGrams: 28 },
    ];
    const curve = estimateBacCurve(intakes, params, {
      fromHour: 0,
      toHour: 4,
      stepHours: 1,
    });
    for (const p of curve.points) {
      expect(p.bacGdl).toBeCloseTo(bacAtTime(intakes, params, p.t), 9);
    }
  });
});
