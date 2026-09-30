import type { DrugSimConfig, DrugSimResult } from '@/types/simulator';

/**
 * Stale-result detection.
 *
 * A computed `DrugSimResult` is only meaningful for the exact inputs it was run
 * against. Editing a parameter or moving an event must not leave the previous
 * curve standing as if it still describes the component. We stamp every result
 * with a hash of the inputs that affect the computation; the UI compares the
 * live component's hash against the stored one and dims a result that no longer
 * matches.
 *
 * Display-only settings (colour, visibility, axis/normalize/time-format choices)
 * are deliberately excluded — re-styling a chart does not invalidate the math.
 */

/** Stable JSON: object keys sorted recursively so key order never perturbs the hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(',')}}`;
}

/** FNV-1a 32-bit, returned as 8-char hex. Collision risk is negligible here. */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Hash of exactly the component fields that change a computed result. Drug
 * identity is included (it selects the literature priors); the human-facing
 * label, colour, and display flags are not.
 */
export function hashRunInputs(config: DrugSimConfig): string {
  const relevant = {
    drugId: config.drugId,
    engine: config.engine ?? 'pk-montecarlo',
    events: config.events ?? [],
    weight: config.weight,
    ethanol: config.ethanol,
    kinelab: config.kinelab,
    route: config.route,
    questionMode: config.questionMode,
    inputs: config.inputs,
    overrides: config.overrides,
  };
  return fnv1a(stableStringify(relevant));
}

/**
 * Whether a stored result no longer matches its component's current inputs.
 * Results without a stamped hash (e.g. older saved cases) are treated as
 * current — we cannot prove staleness and false "out of date" flags are noise.
 */
export function isResultStale(
  config: DrugSimConfig,
  result: DrugSimResult | undefined,
): boolean {
  if (!result || result.inputHash == null) return false;
  return result.inputHash !== hashRunInputs(config);
}
