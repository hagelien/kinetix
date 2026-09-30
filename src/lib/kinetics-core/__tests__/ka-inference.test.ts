import { describe, expect, it } from 'vitest';
import { inferKaFromTmax } from '../ka-inference.js';

/** The forward relation the inference inverts: tmax for a one-compartment first-order input. */
function tmaxFor(kaPerHour: number, kePerHour: number): number {
  return Math.log(kaPerHour / kePerHour) / (kaPerHour - kePerHour);
}

const keFor = (halfLifeHours: number) => Math.LN2 / halfLifeHours;

describe('inferKaFromTmax', () => {
  it('round-trips: the inferred ka reproduces the tmax it was inferred from', () => {
    // Spread across fast/slow absorption and short/long half-lives, each pair chosen so that
    // ke·tmax < 1 (the non-flip-flop regime this inference covers).
    const cases: [halfLife: number, tmax: number][] = [
      [4, 1],
      [4, 0.25],
      [1, 0.1],
      [12, 2],
      [0.5, 0.05],
      [36, 4],
      [2, 1.5],
    ];
    for (const [halfLife, tmax] of cases) {
      const result = inferKaFromTmax(tmax, halfLife);
      expect(result.status, `t½=${halfLife} tmax=${tmax}`).toBe('inferred');
      if (result.status !== 'inferred') continue;
      expect(tmaxFor(result.kaPerHour, result.kePerHour)).toBeCloseTo(tmax, 8);
      // The regime guarantee: absorption faster than elimination.
      expect(result.kaPerHour).toBeGreaterThan(result.kePerHour);
    }
  });

  it('recovers a ka the forward relation generated', () => {
    // Start from a known ka, compute its tmax, and check the inference finds the ka back.
    const ka = 1.8;
    const halfLife = 6;
    const ke = keFor(halfLife);
    const result = inferKaFromTmax(tmaxFor(ka, ke), halfLife);
    expect(result.status).toBe('inferred');
    if (result.status !== 'inferred') return;
    expect(result.kaPerHour).toBeCloseTo(ka, 6);
  });

  it('refuses the flip-flop regime rather than returning a number', () => {
    // ke·tmax >= 1: the unique solution has ka <= ke, so the stored half-life is not safely an
    // ELIMINATION half-life and inferring from it would compound the misreading.
    const halfLife = 4; // ke = 0.1733/h, so 1/ke = 5.77 h
    const result = inferKaFromTmax(8, halfLife);
    expect(result.status).toBe('flip-flop');
    if (result.status !== 'flip-flop') return;
    expect(result.maxTmaxHours).toBeCloseTo(4 / Math.LN2, 6);
    expect(result.reason).toMatch(/absorption-rate-limited/);
  });

  it('treats the ka = ke boundary as flip-flop, not as a curve', () => {
    // tmax exactly 1/ke is the degenerate ka = ke case the first-order closed form cannot express.
    const halfLife = 4;
    const result = inferKaFromTmax(1 / keFor(halfLife), halfLife);
    expect(result.status).toBe('flip-flop');
  });

  it('infers just inside the flip-flop boundary', () => {
    const halfLife = 4;
    const boundary = 1 / keFor(halfLife);
    const result = inferKaFromTmax(boundary * 0.999, halfLife);
    expect(result.status).toBe('inferred');
    if (result.status !== 'inferred') return;
    // Just inside the boundary ka is only marginally above ke — the series branch of h() is what
    // keeps this from losing its precision to cancellation.
    expect(result.kaPerHour).toBeGreaterThan(result.kePerHour);
    expect(tmaxFor(result.kaPerHour, result.kePerHour)).toBeCloseTo(boundary * 0.999, 6);
  });

  it('is monotone: a shorter tmax implies a faster absorption', () => {
    const halfLife = 8;
    const fast = inferKaFromTmax(0.5, halfLife);
    const slow = inferKaFromTmax(2, halfLife);
    expect(fast.status).toBe('inferred');
    expect(slow.status).toBe('inferred');
    if (fast.status !== 'inferred' || slow.status !== 'inferred') return;
    expect(fast.kaPerHour).toBeGreaterThan(slow.kaPerHour);
  });

  it.each([
    ['zero tmax', 0, 4],
    ['negative tmax', -1, 4],
    ['non-finite tmax', Number.NaN, 4],
    ['zero half-life', 1, 0],
    ['negative half-life', 1, -4],
    ['non-finite half-life', 1, Number.POSITIVE_INFINITY],
  ])('refuses %s', (_label, tmax, halfLife) => {
    expect(inferKaFromTmax(tmax, halfLife).status).toBe('not-inferable');
  });

  it('solves an extreme ratio rather than clipping it', () => {
    // Very fast absorption (smoked/insufflated) against a slow elimination: r is large but finite.
    const halfLife = 48;
    const tmax = 0.05;
    const result = inferKaFromTmax(tmax, halfLife);
    expect(result.status).toBe('inferred');
    if (result.status !== 'inferred') return;
    expect(result.kaPerHour / result.kePerHour).toBeGreaterThan(100);
    expect(tmaxFor(result.kaPerHour, result.kePerHour)).toBeCloseTo(tmax, 8);
  });
});
