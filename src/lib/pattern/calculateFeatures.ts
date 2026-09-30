/**
 * Feature results (§8, spec §17).
 *
 * Resolved observations × the feature registry → ratios, with censoring carried
 * through the arithmetic and creatinine normalisation applied exactly where the
 * operands cross specimens.
 */

import type {
  PatternCaseData,
  PatternFeatureResult,
  PatternNumericInterval,
  PatternResultStatus,
  PatternWarning,
  ResolvedObservation,
} from '../../types/patternCase.js';
import { featureRegime, isActive, type PatternFeatureDefinition, type PatternOperand } from './featureRegistry.js';
import { creatinineFactor } from './urineNormalization.js';

interface OperandResolution {
  interval: PatternNumericInterval;
  status: PatternResultStatus;
  /** Specimen ids the terms came from. A sum may span several. */
  specimenIds: string[];
  /** Concrete blood matrices the terms resolved to, for the mixing check. */
  bloodKinds: Set<string>;
  warnings: PatternWarning[];
}

export function calculateFeatures(
  caseData: PatternCaseData,
  resolved: ResolvedObservation[],
  features: PatternFeatureDefinition[],
): PatternFeatureResult[] {
  const specimenById = new Map(caseData.specimens.map((s) => [s.id, s]));

  return features.filter(isActive).map((definition) => {
    const numerator = resolveOperand(definition.numerator, resolved);
    const denominator = resolveOperand(definition.denominator, resolved);
    const warnings = [...numerator.warnings, ...denominator.warnings];

    // Whole blood, plasma and serum are not interchangeable: they differ by the
    // blood:plasma ratio, which the catalog carries per drug precisely because
    // it is not 1. The check has to span both operands, since the ordinary way
    // to hit it is a numerator from one and a denominator from the other — each
    // internally consistent, the ratio silently crossing a conversion nobody
    // applied.
    const bloodKinds = new Set([...numerator.bloodKinds, ...denominator.bloodKinds]);
    if (bloodKinds.size > 1) {
      return {
        featureId: definition.id,
        featureVersion: definition.version,
        status: 'indeterminate',
        normalization: { applied: false, basis: 'none' },
        calculationWarnings: [
          ...warnings,
          {
            code: 'mixed_blood_matrix',
            messageKey: 'pattern.profile.warning.mixedBloodMatrix',
            params: { kinds: [...bloodKinds].sort().join(', ') },
          },
        ],
      };
    }

    // A within-matrix feature whose operands sit in different specimens is two
    // collection times pretending to be one measurement. Each operand can be
    // internally unambiguous and the pair still invalid, so the check belongs
    // here rather than in either operand. Cross-matrix features are exempt by
    // construction: differing specimens are what makes them cross-matrix.
    if (
      featureRegime(definition) === 'within_matrix' &&
      new Set([...numerator.specimenIds, ...denominator.specimenIds]).size > 1
    ) {
      return {
        featureId: definition.id,
        featureVersion: definition.version,
        status: 'indeterminate',
        normalization: { applied: false, basis: 'none' },
        calculationWarnings: [
          ...warnings,
          {
            code: 'feature_spans_specimens',
            messageKey: 'pattern.profile.warning.featureSpansSpecimens',
          },
        ],
      };
    }

    const raw = divideIntervals(numerator.interval, denominator.interval);

    // `k` bears on a feature only where its operands come from different
    // specimens; within a specimen it cancels algebraically. Derived from the
    // resolved operands, never from feature configuration — a curator cannot
    // get this wrong because a curator cannot state it (§8.1).
    const crossesSpecimens =
      featureRegime(definition) === 'cross_matrix' ||
      new Set([...numerator.specimenIds, ...denominator.specimenIds]).size > 1;

    let normalizedValue: PatternNumericInterval | undefined;
    let factor: number | undefined;

    if (crossesSpecimens) {
      const urineSpecimenId = [...numerator.specimenIds, ...denominator.specimenIds].find(
        (id) => specimenById.get(id)?.matrix === 'urine',
      );
      const specimen = urineSpecimenId ? specimenById.get(urineSpecimenId) : undefined;
      const k = specimen
        ? creatinineFactor(specimen, caseData.normalization.creatinineReferenceMmolL)
        : null;

      // Only where a urine operand actually resolved *and* there was a ratio to
      // normalise. Without the first there is no specimen whose creatinine
      // could have been missing, and saying it was sends a curator to look for
      // a value that may well be recorded; without the second the failure is
      // upstream of normalisation entirely. Either way the real failure already
      // has its own warning.
      if (k === null && specimen && raw.status !== 'indeterminate') {
        warnings.push({
          code: 'normalization_unavailable',
          messageKey: 'pattern.profile.warning.normalizationUnavailable',
        });
      }
      // Only a ratio that computed. Scaling `{low: null, high: null}` yields a
      // defined interval of nulls, which every downstream presence check reads
      // as "a normalised value exists": the row renders a second em dash beside
      // the first, and the method section reports that both bases are shown for
      // a case where neither was computed.
      if (k !== null && raw.status !== 'indeterminate') {
        factor = k;
        // Which side the urine specimen supplies decides whether the factor
        // multiplies or divides. Asserting `×k` unconditionally would be wrong
        // for a correct feature whose urine operand sits in the denominator —
        // half of the cross-matrix features in this module alone.
        const urineInNumerator = numerator.specimenIds.includes(urineSpecimenId!);
        normalizedValue = scaleInterval(raw.interval, urineInNumerator ? k : 1 / k);
      }
    }

    const status = raw.status;
    return {
      featureId: definition.id,
      featureVersion: definition.version,
      status,
      rawValue: status === 'indeterminate' ? undefined : raw.interval,
      normalizedValue,
      log10Value: status === 'indeterminate' ? undefined : log10Interval(raw.interval),
      normalization: {
        applied: crossesSpecimens && factor !== undefined,
        basis: crossesSpecimens ? 'creatinine' : 'none',
        referenceMmolL: crossesSpecimens
          ? caseData.normalization.creatinineReferenceMmolL
          : undefined,
        factor,
      },
      calculationWarnings: warnings,
    };
  });
}

/**
 * Sum the terms of one operand. A term that cannot be resolved makes the whole
 * operand indeterminate rather than being treated as zero: a missing analyte is
 * not an absent one, and summing over the gap would understate the total while
 * looking like a measurement.
 */
function resolveOperand(operand: PatternOperand, resolved: ResolvedObservation[]): OperandResolution {
  const warnings: PatternWarning[] = [];
  const specimenIds: string[] = [];
  const bloodKinds = new Set<string>();
  let low: number | null = 0;
  let high: number | null = 0;
  let anyCensored = false;

  for (const term of operand.terms) {
    const matches = resolved.filter(
      (observation) =>
        observation.analyte.pubchemCid === term.analyte.pubchemCid &&
        matrixMatches(observation.matrix, term.matrix) &&
        (term.measurandMode === undefined || observation.measurandMode === term.measurandMode),
    );

    // Serial or repeated specimens of one matrix make the pairing ambiguous, and
    // taking the first would make the ratio depend on observation order — two
    // readers of the same case could then see different numbers. A composite
    // operand could also silently combine concentrations from different
    // collection times. Refuse rather than pick.
    if (matches.length > 1) {
      warnings.push({
        code: 'operand_ambiguous',
        messageKey: 'pattern.profile.warning.operandAmbiguous',
        params: { cid: term.analyte.pubchemCid, count: matches.length },
      });
      return {
        interval: { low: null, high: null },
        status: 'indeterminate',
        specimenIds,
        bloodKinds,
        warnings,
      };
    }

    const match = matches[0];
    if (!match || match.status === 'indeterminate') {
      warnings.push({
        code: 'operand_missing',
        messageKey: 'pattern.profile.warning.operandMissing',
        params: { cid: term.analyte.pubchemCid },
      });
      return {
        interval: { low: null, high: null },
        status: 'indeterminate',
        specimenIds,
        bloodKinds,
        warnings,
      };
    }

    specimenIds.push(match.specimenId);
    if (term.matrix === 'blood') bloodKinds.add(match.matrix);
    if (match.status !== 'point') anyCensored = true;

    low = addBounds(low, match.micromolarPerL.low);
    high = addBounds(high, match.micromolarPerL.high);
  }

  // Whole blood, plasma and serum are not interchangeable: they differ by the
  // blood:plasma ratio, which the catalog carries per drug precisely because it
  // is not 1. A ratio assembled across two of them would look within-matrix
  // while silently crossing that conversion, so a mixed operand is refused
  // rather than computed.
  // Every term of one operand must come from the same specimen. Each analyte
  // having exactly one match is not enough: a sum whose terms sit in two urine
  // collections adds concentrations from different times, and the result looks
  // like a measurement while being none — and a within-matrix feature would then
  // also normalise against whichever specimen's creatinine came first.
  if (new Set(specimenIds).size > 1) {
    warnings.push({
      code: 'operand_spans_specimens',
      messageKey: 'pattern.profile.warning.operandSpansSpecimens',
    });
    return {
      interval: { low: null, high: null },
      status: 'indeterminate',
      specimenIds,
      bloodKinds,
      warnings,
    };
  }

  const status: PatternResultStatus = anyCensored
    ? boundStatus(low, high)
    : 'point';

  return { interval: { low, high }, status, specimenIds, bloodKinds, warnings };
}

function matrixMatches(matrix: string, wanted: 'blood' | 'urine'): boolean {
  if (wanted === 'urine') return matrix === 'urine';
  return matrix === 'whole_blood' || matrix === 'femoral_blood' || matrix === 'cardiac_blood' ||
    matrix === 'serum' || matrix === 'plasma';
}

function addBounds(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a + b;
}

function boundStatus(low: number | null, high: number | null): PatternResultStatus {
  if (low !== null && high !== null) return low === high ? 'point' : 'interval';
  if (low !== null) return 'lower_bound';
  if (high !== null) return 'upper_bound';
  return 'indeterminate';
}

/**
 * Interval division, keeping censored operands censored.
 *
 * A guarded division returns `indeterminate`, never `0` — a quantified zero is
 * not a missing denominator, and the prototype's guard conflated them (§8.1).
 */
function divideIntervals(
  numerator: PatternNumericInterval,
  denominator: PatternNumericInterval,
): { interval: PatternNumericInterval; status: PatternResultStatus } {
  const indeterminate = {
    interval: { low: null, high: null },
    status: 'indeterminate' as const,
  };

  const nLow = numerator.low ?? 0;
  const nHigh = numerator.high ?? Infinity;
  const dLow = denominator.low ?? 0;
  const dHigh = denominator.high ?? Infinity;

  if (!Number.isFinite(nLow) && !Number.isFinite(nHigh)) return indeterminate;
  // A denominator that can be zero makes the ratio unbounded above with no
  // useful lower bound: that is not a measurement, it is an absence of one.
  if (dHigh === 0) return indeterminate;

  const low = dHigh === Infinity ? 0 : nLow / dHigh;
  const high = dLow === 0 ? Infinity : nHigh / dLow;

  if (Number.isFinite(low) && Number.isFinite(high)) {
    if (low === high) return { interval: { low, high }, status: 'point' };
    // A censored numerator gives a lower endpoint of exactly zero, and that is
    // an upper bound rather than an interval: rendering it as "0–X" would state
    // a lower limit the measurement never established. A quantified zero
    // numerator is not this case — it has low === high === 0 and returns above.
    if (low === 0) return { interval: { low: null, high }, status: 'upper_bound' };
    return { interval: { low, high }, status: 'interval' };
  }
  if (Number.isFinite(low) && low > 0) {
    return { interval: { low, high: null }, status: 'lower_bound' };
  }
  if (Number.isFinite(high)) {
    return { interval: { low: null, high }, status: 'upper_bound' };
  }
  return indeterminate;
}

function scaleInterval(interval: PatternNumericInterval, factor: number): PatternNumericInterval {
  return {
    low: interval.low === null ? null : interval.low * factor,
    high: interval.high === null ? null : interval.high * factor,
  };
}

function log10Interval(interval: PatternNumericInterval): PatternNumericInterval {
  return {
    // A quantified zero has no logarithm. It stays a real value in `rawValue`
    // and renders at the left rim with its own label (§8.3); it simply has no
    // coordinate on a log axis.
    low: interval.low === null || interval.low <= 0 ? null : Math.log10(interval.low),
    high: interval.high === null || interval.high <= 0 ? null : Math.log10(interval.high),
  };
}
