/**
 * ParamSpec constructors, central-tendency resolution (deterministic path), and
 * seeded sampling (uncertainty path). Sampling mirrors `distributions.ts` so a
 * seeded run matches the Kinetix engine's draw semantics.
 */
import type { ParamSpec } from './types.js';
import type { PRNG } from './rng.js';

export function fixed(value: number): ParamSpec {
  return { kind: 'fixed', value };
}

export function uniform(min: number, max: number): ParamSpec {
  return { kind: 'uniform', min, max, bounds: { kind: 'extrema' } };
}

export function triangular(min: number, mode: number, max: number): ParamSpec {
  return { kind: 'triangular', min, mode, max, bounds: { kind: 'extrema' } };
}

export function validateParamSpec(spec: ParamSpec): void {
  const finite = (...xs: number[]) => xs.every(Number.isFinite);
  if (spec.kind === 'fixed' && !finite(spec.value)) throw new Error('fixed value must be finite');
  if (spec.kind === 'uniform' && (!finite(spec.min, spec.max) || spec.min > spec.max)) throw new Error('uniform requires finite min <= max');
  if (spec.kind === 'triangular' && (!finite(spec.min, spec.mode, spec.max) || spec.min > spec.mode || spec.mode > spec.max || spec.min === spec.max)) throw new Error('invalid triangular distribution');
  if (spec.kind === 'lognormal' && (!finite(spec.mu, spec.sigma, spec.median) || spec.sigma < 0 || spec.median <= 0)) throw new Error('invalid lognormal distribution');
}

/** Lognormal specified by its median (= e^mu) and sigma on the log scale. */
export function lognormal(median: number, sigma: number): ParamSpec {
  return { kind: 'lognormal', mu: Math.log(median), sigma, median };
}

/**
 * The deterministic / median value of a spec. Chosen so the median CURVE equals
 * this-parameters curve: for symmetric-in-log lognormal the median is e^mu; for
 * uniform/triangular the mode/midpoint is the central estimate.
 */
export function centralValue(spec: ParamSpec): number {
  switch (spec.kind) {
    case 'fixed':
      return spec.value;
    case 'uniform':
      return (spec.min + spec.max) / 2;
    case 'triangular':
      return spec.mode;
    case 'lognormal':
      return spec.median;
  }
}

/** Draw one sample from a spec using the shared PRNG. */
export function sampleParam(spec: ParamSpec, rng: PRNG): number {
  switch (spec.kind) {
    case 'fixed':
      return spec.value;
    case 'uniform':
      return spec.min + rng.next() * (spec.max - spec.min);
    case 'triangular': {
      const { min, mode, max } = spec;
      const u = rng.next();
      const fc = (mode - min) / (max - min);
      if (u < fc) {
        return min + Math.sqrt(u * (max - min) * (mode - min));
      }
      return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
    }
    case 'lognormal': {
      const [z] = rng.nextGaussianPair();
      return Math.exp(spec.mu + spec.sigma * z);
    }
  }
}
