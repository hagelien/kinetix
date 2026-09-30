/**
 * Raw observations → canonical µmol/L, censoring preserved (§8, spec §10.1).
 *
 * Mass→molar goes through the existing `src/lib/unitConversion.ts`; there is no
 * second implementation of it here. What this module adds is the censoring
 * semantics: a `<LOQ` becomes an interval open at the bottom rather than a
 * number, so every downstream division carries the uncertainty instead of
 * inventing a point.
 */

import {
  convertConcentration,
  isConcentrationUnit,
  normalizeUnit,
  type ConcentrationUnit,
} from '../unitConversion.js';
import type {
  PatternCaseData,
  PatternDrugRef,
  PatternNumericInterval,
  PatternObservation,
  PatternResultStatus,
  ResolvedObservation,
} from '../../types/patternCase.js';

/**
 * Molecular weights by PubChem CID, supplied by the substance module.
 *
 * Phase 0 reads them from the module registry because it renders from a fixture
 * with no database; Phase 1 resolves them from the catalog through the graph
 * endpoint. The shape is the same either way, so only the source changes.
 */
export type MolecularWeightLookup = (analyte: PatternDrugRef) => number | undefined;

export interface ResolveOptions {
  molecularWeightOf: MolecularWeightLookup;
}

/**
 * Resolve every observation in the case. Observations that cannot be resolved —
 * unknown unit, missing molecular weight for a mass result, a censored result
 * with no stated limit — come back with `status: 'indeterminate'` and an empty
 * interval rather than being dropped, so the feature that needed them can say
 * *which* operand was missing instead of silently not rendering.
 */
export function resolveObservations(
  caseData: PatternCaseData,
  options: ResolveOptions,
): ResolvedObservation[] {
  const specimenById = new Map(caseData.specimens.map((s) => [s.id, s]));

  return caseData.observations.map((observation) => {
    const specimen = specimenById.get(observation.specimenId);
    const { status, interval } = resolveValue(observation, options);

    return {
      observationId: observation.id,
      specimenId: observation.specimenId,
      analyte: observation.analyte,
      matrix: specimen?.matrix ?? 'other',
      measurandMode: observation.assay?.measurandMode ?? 'unknown',
      status,
      micromolarPerL: interval,
      qualifier: observation.qualifier,
    };
  });
}

function resolveValue(
  observation: PatternObservation,
  options: ResolveOptions,
): { status: PatternResultStatus; interval: PatternNumericInterval } {
  const indeterminate = {
    status: 'indeterminate' as const,
    interval: { low: null, high: null },
  };

  switch (observation.qualifier) {
    case 'quantified': {
      if (observation.value === undefined || observation.unit === undefined) return indeterminate;
      // A concentration below zero is not a measurement. convertConcentration
      // will happily scale one, and it would then travel as a real value:
      // negative ratios, a marker with no logarithm, and threshold comparisons
      // against a quantity that cannot exist. Zero itself is kept — §8.1 makes a
      // quantified zero a real result.
      if (observation.value < 0) return indeterminate;
      const converted = toMicromolar(observation.value, observation.unit, massBasisOf(observation), options);
      if (converted === null) return indeterminate;
      return { status: 'point', interval: { low: converted, high: converted } };
    }

    case 'not_detected':
    case 'detected_not_quantified':
    case 'below_limit': {
      // All three are "somewhere below this threshold". They differ in what
      // they claim about presence, not in what they bound, and that
      // distinction is carried by `qualifier` rather than by the interval —
      // the arithmetic only needs the bound.
      //
      // `detected_not_quantified` used to return indeterminate whether or not
      // a threshold was stated, on the reasoning that presence alone bounds
      // nothing. True where nothing else is said, and wrong for the ordinary
      // report — "påvist, ikke kvantifisert (< 0,01 µmol/L)" — where the
      // laboratory states exactly what the result was under. Discarding that
      // bound made the commonest censored result on a real panel the one the
      // engine could compute least from.
      //
      // The lower end stays 0 rather than a detection limit: presence says the
      // value is above zero, but no number for it is stored, and inventing one
      // would state a threshold the report does not.
      const limit = observation.limitRef;
      // A reporting limit must be strictly positive: a bound at or below zero
      // states nothing, and an interval of [0, 0] would read as a quantified
      // zero rather than as an absent measurement.
      if (!limit || limit.value <= 0) return indeterminate;
      const converted = toMicromolar(limit.value, limit.unit, massBasisOf(observation), options);
      if (converted === null) return indeterminate;
      return { status: 'upper_bound', interval: { low: 0, high: converted } };
    }

    case 'above_limit': {
      const limit = observation.limitRef;
      if (!limit || limit.value <= 0) return indeterminate;
      const converted = toMicromolar(limit.value, limit.unit, massBasisOf(observation), options);
      if (converted === null) return indeterminate;
      return { status: 'lower_bound', interval: { low: converted, high: null } };
    }

    default:
      return indeterminate;
  }
}

/**
 * Which species' molecular weight defines the reported mass basis.
 *
 * A laboratory may report a conjugate on its parent's basis — spec §7.2 models
 * that as `assay.reportedAsDrugId`, and honouring it is not optional: using the
 * analyte's own weight there produces a systematically wrong molar
 * concentration, and therefore a wrong ratio, with nothing on screen to show it.
 */
function massBasisOf(observation: PatternObservation): PatternDrugRef {
  const reportedAs = observation.assay?.reportedAsDrugId;
  return reportedAs === undefined ? observation.analyte : { pubchemCid: reportedAs };
}

function toMicromolar(
  value: number,
  unit: string,
  analyte: PatternDrugRef,
  options: ResolveOptions,
): number | null {
  // `umol/L`, `μmol/L` (Greek mu) and `ug/L` are all in use in imported and
  // hand-entered data, and an exact-string check would reject each of them and
  // make every dependent feature indeterminate. normalizeUnit already
  // canonicalises them, so the guard runs on the canonical form.
  const canonical = normalizeUnit(unit);
  if (!isConcentrationUnit(canonical)) return null;
  const from = canonical as ConcentrationUnit;
  const molecularWeight = options.molecularWeightOf(analyte);
  try {
    return convertConcentration(value, from, 'µmol/L', molecularWeight);
  } catch {
    // convertConcentration throws when a mass→molar conversion has no MW. That
    // is a curation gap, not a crash: the operand resolves indeterminate and the
    // feature says so.
    return null;
  }
}
