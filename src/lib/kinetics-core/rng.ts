/**
 * Seedable PRNG and percentile helpers — a verbatim port of the relevant parts
 * of `src/lib/distributions.ts`. Kept byte-for-byte identical so a seeded
 * Monte-Carlo run produces the SAME draw stream (and therefore the same
 * uncertainty bands) under V8 (Kinetix) and Hermes (Redose).
 *
 * `src/lib/kinetics-core/__tests__/rng-parity.test.ts` asserts this PRNG
 * matches `distributions.ts` PRNG for a shared seed.
 */

/** xorshift128 seeded via splitmix32. Deterministic for a given seed. */
export class PRNG {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    let z = (seed | 0) >>> 0;
    const vals: number[] = [];
    for (let i = 0; i < 4; i++) {
      z = (z + 0x9e3779b9) >>> 0;
      let t = z ^ (z >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t = t ^ (t >>> 15);
      t = Math.imul(t, 0x735a2d97);
      t = t ^ (t >>> 15);
      vals.push(t >>> 0);
    }
    this.s0 = vals[0]!;
    this.s1 = vals[1]!;
    this.s2 = vals[2]!;
    this.s3 = vals[3]!;
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) {
      this.s0 = 1;
    }
  }

  /** Random float in [0, 1). */
  next(): number {
    const t = this.s1 << 9;
    let r = this.s0 * 5;
    r = ((r << 7) | (r >>> 25)) * 9;

    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = (this.s3 << 11) | (this.s3 >>> 21);

    return (r >>> 0) / 4294967296;
  }

  /** A pair of standard normal variates (Box-Muller). */
  nextGaussianPair(): [number, number] {
    const u1 = this.next() || 1e-10; // avoid log(0)
    const u2 = this.next();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    return [r * Math.cos(theta), r * Math.sin(theta)];
  }
}

export function covarianceCholesky(matrix: number[][]): number[][] {
  const n = matrix.length;
  if (!n || matrix.some((row) => row.length !== n)) throw new Error('covariance must be square');
  const out = Array.from({ length: n }, () => Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    if (!Number.isFinite(matrix[i]![j]!) || Math.abs(matrix[i]![j]! - matrix[j]![i]!) > 1e-10) throw new Error('covariance must be finite and symmetric');
    let value = matrix[i]![j]!;
    for (let k = 0; k < j; k++) value -= out[i]![k]! * out[j]![k]!;
    if (i === j) {
      if (value < -1e-12) throw new Error('covariance must be positive semidefinite');
      out[i]![j] = Math.sqrt(Math.max(0, value));
    } else if (out[j]![j] === 0) {
      if (Math.abs(value) > 1e-12) throw new Error('covariance must be positive semidefinite');
    } else out[i]![j] = value / out[j]![j]!;
  }
  return out;
}

export function sampleMultivariateNormal(mean: number[], covariance: number[][], rng: PRNG): number[] {
  if (mean.length !== covariance.length || mean.some((x) => !Number.isFinite(x))) throw new Error('mean/covariance dimension mismatch');
  const lower = covarianceCholesky(covariance);
  const z: number[] = [];
  while (z.length < mean.length) z.push(...rng.nextGaussianPair());
  return mean.map((value, i) => value + lower[i]!.reduce((sum, coefficient, j) => sum + coefficient * z[j]!, 0));
}

/** Compute a percentile (0-100) from a sorted array. */
export function percentile(sorted: Float64Array | number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0]!;

  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;

  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/** Standard summary percentiles from an unsorted array. */
export function computePercentiles(values: Float64Array | number[]): {
  p05: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
} {
  const sorted = Float64Array.from(values);
  sorted.sort();
  return {
    p05: percentile(sorted, 5),
    p25: percentile(sorted, 25),
    median: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p95: percentile(sorted, 95),
  };
}
