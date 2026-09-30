import type {
  DistributionSpec,
  FixedDistribution,
  UniformDistribution,
  TriangularDistribution,
  LogNormalDistribution,
} from '@/types/simulator';

// --- Seedable PRNG (xorshift128) ---

export class PRNG {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    // Initialize state from seed using splitmix32
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
    // Ensure at least one bit is set
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) {
      this.s0 = 1;
    }
  }

  /** Returns a random float in [0, 1) */
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

  /** Returns a pair of standard normal variates (Box-Muller) */
  nextGaussianPair(): [number, number] {
    const u1 = this.next() || 1e-10; // avoid log(0)
    const u2 = this.next();
    const r = Math.sqrt(-2 * Math.log(u1));
    const theta = 2 * Math.PI * u2;
    return [r * Math.cos(theta), r * Math.sin(theta)];
  }
}

// --- Distribution samplers ---

export function sampleFixed(dist: FixedDistribution): number {
  return dist.value;
}

export function sampleUniform(dist: UniformDistribution, rng: PRNG): number {
  return dist.min + rng.next() * (dist.max - dist.min);
}

export function sampleTriangular(dist: TriangularDistribution, rng: PRNG): number {
  const { min, mode, max } = dist;
  const u = rng.next();
  const fc = (mode - min) / (max - min);
  if (u < fc) {
    return min + Math.sqrt(u * (max - min) * (mode - min));
  }
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

export function sampleLogNormal(dist: LogNormalDistribution, rng: PRNG): number {
  const [z] = rng.nextGaussianPair();
  return Math.exp(dist.mu + dist.sigma * z);
}

export function sampleDistribution(dist: DistributionSpec, rng: PRNG): number {
  switch (dist.type) {
    case 'fixed':
      return sampleFixed(dist);
    case 'uniform':
      return sampleUniform(dist, rng);
    case 'triangular':
      return sampleTriangular(dist, rng);
    case 'lognormal':
      return sampleLogNormal(dist, rng);
  }
}

// --- Percentile computation ---

/** Compute a percentile (0-100) from a sorted array of numbers */
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

/** Compute standard summary percentiles from an unsorted array */
export function computePercentiles(values: Float64Array): {
  p05: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
} {
  const sorted = new Float64Array(values);
  sorted.sort();
  return {
    p05: percentile(sorted, 5),
    p25: percentile(sorted, 25),
    median: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p95: percentile(sorted, 95),
  };
}
