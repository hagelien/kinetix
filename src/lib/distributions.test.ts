import { describe, it, expect } from 'vitest';
import {
  PRNG,
  sampleFixed,
  sampleUniform,
  sampleTriangular,
  sampleLogNormal,
  sampleDistribution,
  percentile,
  computePercentiles,
} from './distributions';

describe('PRNG', () => {
  it('produces deterministic sequences from the same seed', () => {
    const rng1 = new PRNG(42);
    const rng2 = new PRNG(42);
    for (let i = 0; i < 100; i++) {
      expect(rng1.next()).toBe(rng2.next());
    }
  });

  it('produces different sequences from different seeds', () => {
    const rng1 = new PRNG(42);
    const rng2 = new PRNG(99);
    let same = 0;
    for (let i = 0; i < 100; i++) {
      if (rng1.next() === rng2.next()) same++;
    }
    expect(same).toBeLessThan(5);
  });

  it('produces values in [0, 1)', () => {
    const rng = new PRNG(1);
    for (let i = 0; i < 10000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('nextGaussianPair produces roughly standard normal values', () => {
    const rng = new PRNG(7);
    let sum = 0;
    let sumSq = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) {
      const [a, b] = rng.nextGaussianPair();
      sum += a + b;
      sumSq += a * a + b * b;
    }
    const mean = sum / (2 * N);
    const variance = sumSq / (2 * N) - mean * mean;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(Math.abs(variance - 1)).toBeLessThan(0.1);
  });
});

describe('distribution samplers', () => {
  it('sampleFixed always returns the value', () => {
    expect(sampleFixed({ type: 'fixed', value: 3.14 })).toBe(3.14);
  });

  it('sampleUniform stays within bounds', () => {
    const rng = new PRNG(42);
    for (let i = 0; i < 1000; i++) {
      const v = sampleUniform({ type: 'uniform', min: 2, max: 8 }, rng);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThanOrEqual(8);
    }
  });

  it('sampleTriangular stays within bounds and clusters around mode', () => {
    const rng = new PRNG(42);
    let sum = 0;
    const N = 10000;
    for (let i = 0; i < N; i++) {
      const v = sampleTriangular({ type: 'triangular', min: 1, mode: 3, max: 5 }, rng);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(5);
      sum += v;
    }
    const mean = sum / N;
    // Expected mean of triangular(1,3,5) = (1+3+5)/3 = 3
    expect(Math.abs(mean - 3)).toBeLessThan(0.1);
  });

  it('sampleLogNormal produces positive values', () => {
    const rng = new PRNG(42);
    for (let i = 0; i < 1000; i++) {
      const v = sampleLogNormal({ type: 'lognormal', mu: 1, sigma: 0.5 }, rng);
      expect(v).toBeGreaterThan(0);
    }
  });

  it('sampleDistribution dispatches correctly', () => {
    const rng = new PRNG(42);
    expect(sampleDistribution({ type: 'fixed', value: 5 }, rng)).toBe(5);
    const u = sampleDistribution({ type: 'uniform', min: 0, max: 1 }, rng);
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThanOrEqual(1);
  });
});

describe('percentile', () => {
  it('computes exact percentiles for small sorted arrays', () => {
    const arr = [1, 2, 3, 4, 5];
    expect(percentile(arr, 0)).toBe(1);
    expect(percentile(arr, 50)).toBe(3);
    expect(percentile(arr, 100)).toBe(5);
  });

  it('interpolates between values', () => {
    const arr = [10, 20, 30, 40];
    const p25 = percentile(arr, 25);
    expect(p25).toBe(17.5); // index 0.75 → lerp(10, 20, 0.75)
  });
});

describe('computePercentiles', () => {
  it('returns correct percentiles for a known distribution', () => {
    // Create 100 evenly spaced values from 1 to 100
    const values = new Float64Array(100);
    for (let i = 0; i < 100; i++) values[i] = i + 1;
    const p = computePercentiles(values);
    expect(p.p05).toBeCloseTo(5.95, 1);
    expect(p.p25).toBeCloseTo(25.75, 1);
    expect(p.median).toBeCloseTo(50.5, 1);
    expect(p.p75).toBeCloseTo(75.25, 1);
    expect(p.p95).toBeCloseTo(95.05, 1);
  });

  it('p05 <= p25 <= median <= p75 <= p95', () => {
    const rng = new PRNG(42);
    const values = new Float64Array(1000);
    for (let i = 0; i < 1000; i++) values[i] = rng.next() * 100;
    const p = computePercentiles(values);
    expect(p.p05).toBeLessThanOrEqual(p.p25);
    expect(p.p25).toBeLessThanOrEqual(p.median);
    expect(p.median).toBeLessThanOrEqual(p.p75);
    expect(p.p75).toBeLessThanOrEqual(p.p95);
  });
});
