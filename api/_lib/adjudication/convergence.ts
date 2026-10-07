/**
 * T3 convergence, decided in code (docs/plans/2026-09-18-t3-adjudication-backend.md
 * §3.5, agents/drug-db-adjudication.md §6).
 *
 * Two sealed opinions converge only when they agree on the typed fields: the
 * same `resolution`, the same normalised `scopeKey`, and — where both endorse
 * a value — the same value once both are converted to the parameter's
 * canonical unit. `proposition` and `reasoningMd` are never compared: they are
 * prose, so two opinions endorsing different numbers can share a label, and
 * two endorsing the same number can state it in different units.
 *
 * Units go through `convertParameterValue` (src/lib/parameterUnits.ts), not
 * `unitConversion.ts`, so a clearance pair such as 60 L/h and 1 L/min reads as
 * the same value. Two units of different families are not a conversion
 * failure but a disagreement about what was measured, and are reported as
 * such.
 */

import type {
  AdjudicationConvergence,
  AdjudicationDivergenceReason,
  AdjudicationRecommendation,
  AdjudicationResolution,
} from '../../../db/schema.js';
import {
  convertParameterValue,
  parameterUnitFamily,
} from '../../../src/lib/parameterUnits.js';

/** Resolutions that endorse a value (§3.2): only these carry one. */
export const VALUE_ENDORSING_RESOLUTIONS: readonly AdjudicationResolution[] = [
  'approve',
  'split_scope',
];

/** Relative tolerance for two canonical values to count as the same. */
const RELATIVE_TOLERANCE = 1e-6;

export interface ComparableOpinion {
  id: number;
  resolution: AdjudicationResolution;
  scopeKey: Record<string, string>;
  resolvedValue: number | null;
  resolvedLow: number | null;
  resolvedHigh: number | null;
  resolvedUnit: string | null;
  humanRequired: boolean;
}

/** What the comparison needs to know about the adjudicated target. */
export interface ComparisonTarget {
  /** The parameter's canonical unit when the target is a numeric parameter; else null. */
  canonicalUnit: string | null;
  molecularWeight: number | null;
}

/** Scope as a comparable string: keys and values trimmed and lower-cased, empties dropped, sorted. */
export function normaliseScopeKey(scope: Record<string, string>): string {
  const entries = Object.entries(scope ?? {})
    .map(([k, v]) => [k.trim().toLowerCase(), String(v ?? '').trim().toLowerCase()] as const)
    .filter(([k, v]) => k !== '' && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

type CanonicalValue =
  | { kind: 'scalar'; value: number }
  | { kind: 'range'; low: number; high: number };

function sameNumber(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= RELATIVE_TOLERANCE * scale;
}

/** The opinion's value in the canonical unit, or why it cannot be. */
function canonicalValue(
  o: ComparableOpinion,
  target: ComparisonTarget & { canonicalUnit: string },
): CanonicalValue | 'unit_not_convertible' | null {
  if (o.resolvedUnit === null) return null;
  const convert = (v: number) =>
    convertParameterValue(v, o.resolvedUnit!, target.canonicalUnit, target.molecularWeight);
  if (o.resolvedValue !== null) {
    const value = convert(o.resolvedValue);
    return value === null ? 'unit_not_convertible' : { kind: 'scalar', value };
  }
  if (o.resolvedLow !== null && o.resolvedHigh !== null) {
    const low = convert(o.resolvedLow);
    const high = convert(o.resolvedHigh);
    return low === null || high === null
      ? 'unit_not_convertible'
      : { kind: 'range', low, high };
  }
  return null;
}

export interface ConvergenceResult {
  convergence: AdjudicationConvergence;
  /** Set only when the panel converged and nobody asked for a human. */
  recommendation: AdjudicationRecommendation | null;
}

export function compareOpinions(
  a: ComparableOpinion,
  b: ComparableOpinion,
  target: ComparisonTarget,
  now: Date = new Date(),
): ConvergenceResult {
  const humanRequested =
    a.resolution === 'human' ||
    b.resolution === 'human' ||
    a.humanRequired ||
    b.humanRequired;
  const done = (
    reason: AdjudicationDivergenceReason | null,
    value: AdjudicationRecommendation['value'] = null,
  ): ConvergenceResult => {
    const converged = reason === null;
    return {
      convergence: {
        converged,
        reason,
        humanRequested,
        canonicalUnit: value ? value.unit : null,
        comparedAt: now.toISOString(),
      },
      recommendation:
        // An agreed abstention resolves nothing, so it recommends nothing.
        converged && !humanRequested && a.resolution !== 'abstain'
          ? {
              resolution: a.resolution,
              scopeKey: a.scopeKey,
              value,
              opinionIds: [a.id, b.id],
            }
          : null,
    };
  };

  if (a.resolution !== b.resolution) return done('resolution_differs');
  if (normaliseScopeKey(a.scopeKey) !== normaliseScopeKey(b.scopeKey)) {
    return done('scope_differs');
  }
  const endorses =
    VALUE_ENDORSING_RESOLUTIONS.includes(a.resolution) && target.canonicalUnit !== null;
  if (!endorses) return done(null);

  const numeric = target as ComparisonTarget & { canonicalUnit: string };
  if (
    a.resolvedUnit !== null &&
    b.resolvedUnit !== null &&
    parameterUnitFamily(a.resolvedUnit) !== parameterUnitFamily(b.resolvedUnit)
  ) {
    return done('unit_family_differs');
  }
  const va = canonicalValue(a, numeric);
  const vb = canonicalValue(b, numeric);
  if (va === 'unit_not_convertible' || vb === 'unit_not_convertible') {
    return done('unit_not_convertible');
  }
  // The write path requires a value on an endorsing opinion for a numeric
  // target; a missing one here cannot be compared, so it cannot converge.
  if (va === null || vb === null || va.kind !== vb.kind) return done('value_shape_differs');
  if (va.kind === 'scalar' && vb.kind === 'scalar') {
    return sameNumber(va.value, vb.value)
      ? done(null, { kind: 'scalar', value: va.value, unit: numeric.canonicalUnit })
      : done('value_differs');
  }
  if (va.kind === 'range' && vb.kind === 'range') {
    return sameNumber(va.low, vb.low) && sameNumber(va.high, vb.high)
      ? done(null, { kind: 'range', low: va.low, high: va.high, unit: numeric.canonicalUnit })
      : done('value_differs');
  }
  return done('value_shape_differs');
}
