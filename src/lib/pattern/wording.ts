/**
 * The wording table (§5, §7.6).
 *
 * The ENFSI verbal scale and the not-calculable reasons live in one place so
 * that report output and screen output cannot drift — which is the handoff's own
 * open item, recorded there as "the strength expressions and degradation lines
 * should come from a shared wording table". Phase 4 exports the same
 * `PatternFinding[]` through this module.
 */

import type { EnfsiStrength } from './signals.js';

/**
 * The seven-step scale. Keys only: the view translates, and a report renders the
 * same key through the same bundle, so neither can invent its own phrasing.
 */
export const ENFSI_STRENGTH_KEYS: Record<EnfsiStrength, string> = {
  no_support: 'pattern.profile.enfsi.noSupport',
  weak: 'pattern.profile.enfsi.weak',
  moderate: 'pattern.profile.enfsi.moderate',
  moderately_strong: 'pattern.profile.enfsi.moderatelyStrong',
  strong: 'pattern.profile.enfsi.strong',
  very_strong: 'pattern.profile.enfsi.veryStrong',
  extremely_strong: 'pattern.profile.enfsi.extremelyStrong',
};

/**
 * Why a strength could not be computed. Each is a statement about the evidence,
 * not an apology for the software: "ikke beregnbar" with no reason is the
 * wording the handoff already rejected.
 */
export const NOT_CALCULABLE_KEYS = {
  assumedContext: 'pattern.profile.strength.assumedContext',
  /** A dependency the case never stated. */
  missingContext: 'pattern.profile.strength.missingContext',
  /** The source of the analytes is unresolved, so the basis is confounded. */
  unresolvedSource: 'pattern.profile.strength.unresolvedSource',
  /** The basis quantity itself could not be computed. */
  basisIndeterminate: 'pattern.profile.strength.basisIndeterminate',
  /** A threshold rule whose published support does not resolve. */
  provenanceUnresolved: 'pattern.profile.strength.provenanceUnresolved',
} as const;

export const DEGRADATION_KEYS = {
  field: 'pattern.profile.degradation.field',
  assumedField: 'pattern.profile.degradation.assumedField',
  source: 'pattern.profile.degradation.source',
  attribution: 'pattern.profile.degradation.attribution',
} as const;

export function strengthKey(strength: EnfsiStrength): string {
  return ENFSI_STRENGTH_KEYS[strength];
}
