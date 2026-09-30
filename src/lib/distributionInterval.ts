import type { DistributionSpec } from '@/types/simulator';

/** Standard-normal quantiles for the 5th / 50th / 95th percentiles. */
const Z05 = -1.6448536269514722;
const Z95 = 1.6448536269514722;

export interface DistributionInterval {
  p05: number;
  median: number;
  p95: number;
}

/** Inverse CDF of a triangular(min, mode, max) distribution at probability p. */
function triangularQuantile(
  min: number,
  mode: number,
  max: number,
  p: number,
): number {
  const span = max - min;
  if (span <= 0) return min;
  const fMode = (mode - min) / span;
  if (p <= fMode) {
    return min + Math.sqrt(p * span * (mode - min));
  }
  return max - Math.sqrt((1 - p) * span * (max - mode));
}

/**
 * Analytic 5/50/95 interval for a distribution spec, used to show a prior
 * interval next to the inferred posterior interval. Pure and deterministic —
 * no sampling — so the prior column never jitters between runs.
 */
export function distributionInterval(
  spec: DistributionSpec,
): DistributionInterval {
  switch (spec.type) {
    case 'fixed':
      return { p05: spec.value, median: spec.value, p95: spec.value };
    case 'uniform': {
      const span = spec.max - spec.min;
      return {
        p05: spec.min + 0.05 * span,
        median: spec.min + 0.5 * span,
        p95: spec.min + 0.95 * span,
      };
    }
    case 'triangular':
      return {
        p05: triangularQuantile(spec.min, spec.mode, spec.max, 0.05),
        median: triangularQuantile(spec.min, spec.mode, spec.max, 0.5),
        p95: triangularQuantile(spec.min, spec.mode, spec.max, 0.95),
      };
    case 'lognormal':
      return {
        p05: Math.exp(spec.mu + spec.sigma * Z05),
        median: Math.exp(spec.mu),
        p95: Math.exp(spec.mu + spec.sigma * Z95),
      };
  }
}
