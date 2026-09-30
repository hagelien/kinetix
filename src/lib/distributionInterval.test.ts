import { describe, expect, it } from 'vitest';
import { distributionInterval } from './distributionInterval';

describe('distributionInterval', () => {
  it('returns the point for a fixed distribution', () => {
    expect(distributionInterval({ type: 'fixed', value: 7 })).toEqual({
      p05: 7,
      median: 7,
      p95: 7,
    });
  });

  it('places uniform quantiles linearly', () => {
    const i = distributionInterval({ type: 'uniform', min: 0, max: 100 });
    expect(i.p05).toBeCloseTo(5, 9);
    expect(i.median).toBeCloseTo(50, 9);
    expect(i.p95).toBeCloseTo(95, 9);
  });

  it('uses the lognormal median = exp(mu) and symmetric log tails', () => {
    const i = distributionInterval({ type: 'lognormal', mu: Math.log(10), sigma: 0.5 });
    expect(i.median).toBeCloseTo(10, 9);
    // tails symmetric in log space around the median
    expect(Math.log(i.p05 * i.p95)).toBeCloseTo(2 * Math.log(10), 9);
    expect(i.p05).toBeLessThan(10);
    expect(i.p95).toBeGreaterThan(10);
  });

  it('orders triangular quantiles and brackets the mode', () => {
    const i = distributionInterval({
      type: 'triangular',
      min: 0,
      mode: 4,
      max: 10,
    });
    expect(i.p05).toBeLessThan(i.median);
    expect(i.median).toBeLessThan(i.p95);
    expect(i.p05).toBeGreaterThanOrEqual(0);
    expect(i.p95).toBeLessThanOrEqual(10);
  });
});
