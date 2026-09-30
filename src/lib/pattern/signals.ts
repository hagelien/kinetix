/**
 * Signal definitions (§7.6).
 *
 * A signal is a proposition pair with a basis quantity and a rule for how much
 * the quantity supports one side. The type deliberately admits **one** source of
 * verbal strength — a published cut-off — because the alternative it does not
 * admit is the important part: see below.
 */

import type { PatternCitationRef } from '../../types/patternCase.js';
import { resolvesToPublishedWork } from './publishedWorks.js';

/** The ENFSI seven-step verbal scale. Wording lives in `wording.ts`. */
export type EnfsiStrength =
  | 'no_support'
  | 'weak'
  | 'moderate'
  | 'moderately_strong'
  | 'strong'
  | 'very_strong'
  | 'extremely_strong';

/** A quantity of the specimen itself rather than of a computed feature. */
export type PatternSpecimenMetric = 'urine_creatinine';

export type PatternSignalBasis =
  | { type: 'feature'; featureId: string }
  | { type: 'specimen_metric'; metric: PatternSpecimenMetric };

/**
 * **There is deliberately no rule deriving strength from a band position.**
 *
 * An earlier draft of the plan had one. It would have been wrong: a percentile
 * in one empirical cohort says where a value sits, not which of Hp and Hd that
 * supports, nor at which of seven ENFSI steps. A `side` field does not fix it,
 * because what is missing is a validated mapping from distributional position to
 * evidential weight — and filling that in code means inventing a forensic
 * conclusion. A band position renders as a descriptive reference comparison, and
 * strength stays not-calculable until such a mapping is specified.
 */
export type PatternStrengthRule =
  | { type: 'not_calculable'; reasonKey: string }
  | {
      type: 'threshold';
      quantity: PatternSignalBasis;
      bands: Array<{
        lt?: number;
        gt?: number;
        between?: [number, number];
        strength: EnfsiStrength;
        side: 'Hp' | 'Hd';
        caveatKey?: string;
      }>;
      fallback: { strength: EnfsiStrength; side: 'Hp' | 'Hd' };
      /**
       * The published support for these cut-offs, required and non-empty.
       *
       * Ungated, a `threshold` rule would let any curator emit ENFSI wording
       * from a number they picked — the failure the band-provenance gate exists
       * to prevent, arriving by the other door. `evaluateSignals` degrades a
       * rule with unresolvable provenance to `not_calculable` rather than
       * computing it.
       */
      thresholdProvenance: [PatternCitationRef, ...PatternCitationRef[]];
    };

export interface PatternSignalDefinition {
  id: string;
  version: string;
  moduleId: string;
  titleKey: string;
  /** Colour only. It does not gate computation; provenance does. */
  grade: 'exploratory' | 'suggestive' | 'validated';
  propositionHpKey: string;
  propositionHdKey: string;
  basisKey: string;
  basis: PatternSignalBasis;
  /** Context field ids this signal presupposes. */
  dependsOn: string[];
  dependsOnSourceResolution?: boolean;
  strength: PatternStrengthRule;
  referenceCitations: PatternCitationRef[];
}

/**
 * A finding that makes no claim, and so should not occupy a claim-shaped row.
 *
 * §3.3's fourth content change moves "Etterlevelse av forskrivning" here from
 * the signal list, keeping its bounded-negative wording verbatim: an exploratory
 * signal with no computable strength *and* no established band renders under
 * "Ikke etablert", not among rows that read as findings.
 */
export interface PatternNotEstablishedDefinition {
  id: string;
  moduleId: string;
  titleKey: string;
  rationaleKey: string;
  referenceCitations: PatternCitationRef[];
}

/**
 * Whether a citation handle names a work that actually supports a claim.
 *
 * An earlier version checked the handle's *shape* — eight digits pass as a
 * PMID. That is worth nothing here, and the proof is in this module's own
 * history: a mistyped identifier passed the shape check while pointing at an
 * unrelated paper, and authorised the only ENFSI strength statement in the
 * benzodiazepine registry. Resolution now means a curator registered the work
 * and recorded what kind of work it is, which is what "published sources only"
 * (§13.3) turns on.
 */
export function isResolvableCitationHandle(ref: PatternCitationRef | undefined): boolean {
  return resolvesToPublishedWork(ref);
}

/**
 * Whether a signal's strength rule may be computed at all.
 *
 * A rule that states no strength needs no provenance. A `threshold` rule needs
 * *every* handle behind its cut-offs to resolve: one unresolvable citation among
 * several does not become acceptable because the others are fine — the cut-offs
 * are one claim, and the reader is told they are published.
 */
export function thresholdProvenanceResolves(signal: PatternSignalDefinition): boolean {
  if (signal.strength.type !== 'threshold') return true;
  const provenance = signal.strength.thresholdProvenance;
  return (
    Array.isArray(provenance) &&
    provenance.length > 0 &&
    provenance.every(isResolvableCitationHandle)
  );
}

/**
 * Validate a signal at registry load. Fails loudly rather than degrading,
 * because a `threshold` rule with no provenance is a curation error that should
 * never reach a reader, and a silent downgrade would hide it from the curator
 * who could fix it.
 */
export function assertSignalWellFormed(signal: PatternSignalDefinition): void {
  if (signal.strength.type !== 'threshold') return;
  const provenance = signal.strength.thresholdProvenance;
  if (!provenance || provenance.length === 0) {
    throw new Error(
      `Signal ${signal.id}: a threshold rule requires non-empty thresholdProvenance (§7.6)`,
    );
  }
  const unresolved = provenance.filter((ref) => !isResolvableCitationHandle(ref));
  if (unresolved.length > 0) {
    throw new Error(
      `Signal ${signal.id}: every thresholdProvenance handle must name a registered ` +
        `published work, but ${unresolved.map((ref) => `${ref.type}:${ref.identifier}`).join(', ')} ` +
        `is not in the published-works registry (§7.6, §13.3)`,
    );
  }
  if (signal.strength.bands.length === 0) {
    throw new Error(`Signal ${signal.id}: a threshold rule requires at least one band`);
  }

  // `matchesBand` tests `lt`, then `gt`, then `between`, and returns on the
  // first one present. A band with none never matches, a band with two silently
  // honours only the first, an inverted `between` never matches, and a
  // non-finite cut-off matches nothing. Each of those hands the reader the
  // fallback's verbal strength, or a neighbouring band's, in place of the one
  // the curator wrote — a wrong ENFSI step rather than an absent one, which is
  // the worse of the two failures by some distance.
  for (const band of signal.strength.bands) {
    const predicates = [band.lt, band.gt, band.between].filter((p) => p !== undefined);
    if (predicates.length !== 1) {
      throw new Error(
        `Signal ${signal.id}: every threshold band needs exactly one of lt, gt or between, ` +
          `and one has ${predicates.length}`,
      );
    }
    if (band.between) {
      const [low, high] = band.between;
      if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) {
        throw new Error(
          `Signal ${signal.id}: a between band needs finite bounds in order, got ` +
            `[${low}, ${high}]`,
        );
      }
    } else {
      const cutoff = band.lt ?? band.gt!;
      if (!Number.isFinite(cutoff)) {
        throw new Error(`Signal ${signal.id}: a threshold band cut-off must be finite, got ${cutoff}`);
      }
    }
  }
}
