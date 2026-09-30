/**
 * Feature definitions (§7.1, spec §16.3).
 *
 * Everything on the handoff's screen that looks like a constant — the six
 * analytes, the six ratios, the three groups, the axis bounds — is an instance
 * of a class named here. The point of the file is that the second drug family is
 * a data change and not a code change (§4.1).
 */

import type { PatternCitationRef, PatternDrugRef, PatternMeasurandMode } from '../../types/patternCase.js';

/**
 * What kind of quantity a feature is. The vocabulary is load-bearing rather than
 * decorative: `branch_ratio` *derives* the sub-label warning that a branch
 * product is not a sequential step, so every future module inherits Layer A's
 * A1 correction without its author knowing the finding exists.
 */
export type PatternFeatureKind =
  | 'parent_metabolite_ratio'
  | 'branch_ratio'
  | 'lineage_burden'
  | 'matrix_same_analyte'
  | 'matrix_matched_lineage';

/**
 * One side of a ratio. A term names an analyte and the matrix it must come
 * from; a sum names several, which is how a lineage burden is expressed without
 * a bespoke feature kind.
 */
export interface PatternOperand {
  terms: Array<{
    analyte: PatternDrugRef;
    /** Which specimen supplies it, by matrix. */
    matrix: 'blood' | 'urine';
    /**
     * Required measurand mode, where the feature is only meaningful for one.
     * Absent means any mode is acceptable and the artefact rules do the work.
     */
    measurandMode?: PatternMeasurandMode;
  }>;
}

/**
 * A band shipped with the registry until the atlas supersedes it (§7.7).
 * `provenance: null` is the type-level gate: `percentileOf` does not accept one,
 * so no statistic can be computed from a placeholder. Phase 3 deletes these.
 */
export interface ProvisionalBand {
  p5: number;
  p50: number;
  p95: number;
  provenance: null;
  /**
   * Which quantity the percentiles describe, stated rather than assumed.
   *
   * A cross-matrix case has two materially different values — the raw ratio and
   * the creatinine-normalised one — and §3.4 asserts neither is the correct one.
   * A band is a claim about where a value sits, so it can only be compared
   * against the quantity it was derived from: plotting the raw value against a
   * standardised distribution misstates the position by exactly the
   * normalisation factor, silently and with no mark on screen.
   *
   * `unstated` is the honest answer for a provisional band nobody sourced. It is
   * not a synonym for `raw`: where the two quantities differ, a band whose basis
   * is unknown cannot be compared with either, and the model withholds it rather
   * than picking one.
   */
  basis: 'raw' | 'creatinine_normalized' | 'unstated';
}

export interface PatternFeatureDefinition {
  id: string;
  version: string;
  moduleId: string;
  kind: PatternFeatureKind;
  labelKey: string;
  /** Stated in the view under the label; never a causal claim (§3.3). */
  basisKey?: string;
  numerator: PatternOperand;
  denominator: PatternOperand;
  /** Ordering inside its derived group. Groups themselves are matrix-ordered. */
  sortOrder: number;
  /**
   * A feature deliberately not offered, with the reason rendered as the group
   * footnote — a ratio a reader expects to see, whose absence must be stated
   * rather than inferred.
   */
  status?: 'active' | 'withdrawn';
  withdrawnRationaleKey?: string;
  provisionalBand?: ProvisionalBand;
  referenceCitations?: PatternCitationRef[];
}

/**
 * The groups the profile is read in: one per matrix a feature stays inside, and
 * one for the features that span two.
 *
 * A single "within matrix" heading is not the same screen. It puts a blood
 * ratio beside three urine ones under one note, and the note cannot be true of
 * both: a urine-internal ratio is dilution-invariant *because* the creatinine
 * factor cancels, while dilution is not a thing that happens to blood at all.
 * The reader loses the matrix each ratio belongs to exactly where matrix is the
 * thing being compared (§4 generalisation contract).
 */
export type PatternRatioGroup = 'blood' | 'urine' | 'cross_matrix';

/** In reading order: the matrices, then what spans them. */
export const RATIO_GROUPS: readonly PatternRatioGroup[] = ['blood', 'urine', 'cross_matrix'];

/**
 * Which group a feature belongs to, derived from its operands rather than
 * declared. A curator cannot mislabel a cross-matrix ratio as a urine one,
 * because the label is not theirs to write (§8.1).
 */
export function featureGroup(definition: PatternFeatureDefinition): PatternRatioGroup {
  const matrices = new Set<'blood' | 'urine'>();
  for (const term of definition.numerator.terms) matrices.add(term.matrix);
  for (const term of definition.denominator.terms) matrices.add(term.matrix);
  if (matrices.size > 1) return 'cross_matrix';
  // A feature with no terms at all is malformed, and the group it lands in is
  // not the interesting thing about it: `assertModuleWellFormed` reads the
  // terms, and a ratio with no operands computes nothing to show here.
  return matrices.has('urine') ? 'urine' : 'blood';
}

/**
 * The dilution regime, which is what decides whether `k` applies (§7.2). Two
 * groups share one: a ratio inside blood and a ratio inside urine are both
 * unaffected by the normalisation factor, for different reasons.
 */
export function featureRegime(
  definition: PatternFeatureDefinition,
): 'within_matrix' | 'cross_matrix' {
  return featureGroup(definition) === 'cross_matrix' ? 'cross_matrix' : 'within_matrix';
}

/** Every analyte a feature reads, in order, numerator first. */
export function featureAnalytes(definition: PatternFeatureDefinition): PatternDrugRef[] {
  return [...definition.numerator.terms, ...definition.denominator.terms].map((t) => t.analyte);
}

export function isActive(definition: PatternFeatureDefinition): boolean {
  return (definition.status ?? 'active') === 'active';
}
