/**
 * Operand matching and mass basis — the cases where a plausible-looking number
 * would be the wrong number.
 *
 * Every test here was written from a review finding on the first Phase 0 commit.
 * They share a shape: the engine had a defensible-looking default (take the
 * first match, treat blood as blood, use the analyte's own weight) and each
 * default produced a result that was confidently wrong rather than absent.
 */

import { describe, it, expect } from 'vitest';

import { calculateFeatures } from './calculateFeatures.js';
import { DIAZEPAM_FIXTURE_CASE } from './fixtures.js';
import { formatInterval } from './format.js';
import { BENZODIAZEPINE_MODULE } from './modules/benzodiazepines.js';
import { resolveObservations } from './resolveObservations.js';
import { molecularWeightLookup, unionFeatures } from './substanceModules.js';
import type { PatternCaseData } from '../../types/patternCase.js';

const molecularWeightOf = molecularWeightLookup();
const features = unionFeatures([BENZODIAZEPINE_MODULE]);

function run(caseData: PatternCaseData) {
  const resolved = resolveObservations(caseData, { molecularWeightOf });
  return new Map(
    calculateFeatures(caseData, resolved, features).map((f) => [f.featureId, f]),
  );
}

describe('operand matching refuses rather than guesses', () => {
  it('will not pick between two blood specimens of the same analyte', () => {
    // Serial sampling is ordinary in a real case. Taking the first match would
    // make the ratio depend on observation order, so two readers of the same
    // case could see different numbers.
    const serial: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: [
        ...DIAZEPAM_FIXTURE_CASE.specimens,
        { id: 'blood-2', matrix: 'whole_blood', relativeTimeHours: 4 },
      ],
      observations: [
        ...DIAZEPAM_FIXTURE_CASE.observations,
        {
          id: 'obs-ndd-b2',
          specimenId: 'blood-2',
          analyte: { pubchemCid: 2997 },
          value: 300,
          unit: 'nmol/L',
          qualifier: 'quantified',
          assay: { measurandMode: 'direct' },
        },
      ],
    };

    const result = run(serial).get('ndd_dzp');
    expect(result?.status).toBe('indeterminate');
    expect(result?.calculationWarnings.map((w) => w.code)).toContain('operand_ambiguous');
  });

  it('will not build a within-matrix ratio across plasma and whole blood', () => {
    // They differ by the blood:plasma ratio, which the catalog carries per drug
    // precisely because it is not 1. A ratio spanning both would look
    // within-matrix while silently crossing that conversion.
    const mixed: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: [
        { id: 'blood-1', matrix: 'whole_blood' },
        { id: 'plasma-1', matrix: 'plasma' },
        ...DIAZEPAM_FIXTURE_CASE.specimens.filter((s) => s.id === 'urine-1'),
      ],
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
        o.id === 'obs-dzp-b' ? { ...o, specimenId: 'plasma-1' } : o,
      ),
    };

    const result = run(mixed).get('ndd_dzp');
    expect(result?.status).toBe('indeterminate');
    expect(result?.calculationWarnings.map((w) => w.code)).toContain('mixed_blood_matrix');
  });
});

describe('the reported mass basis is the laboratory’s, not the analyte’s', () => {
  it('converts on the reported-as species when the assay declares one', () => {
    // A conjugate reported on its parent's basis. Using the analyte's own weight
    // would give a systematically wrong molar concentration with nothing on
    // screen to show it.
    const reportedAsParent: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
        o.id === 'obs-oxa-u'
          ? {
              ...o,
              value: 500,
              unit: 'ng/mL',
              assay: { ...o.assay, reportedAsDrugId: 3016 },
            }
          : o,
      ),
    };
    const asOwn: PatternCaseData = {
      ...reportedAsParent,
      observations: reportedAsParent.observations.map((o) =>
        o.id === 'obs-oxa-u' ? { ...o, assay: { measurandMode: o.assay?.measurandMode } } : o,
      ),
    };

    const withBasis = run(reportedAsParent).get('oxa_ndd')?.rawValue?.low;
    const withoutBasis = run(asOwn).get('oxa_ndd')?.rawValue?.low;

    expect(withBasis).toBeDefined();
    expect(withoutBasis).toBeDefined();
    // Diazepam 284.74 against oxazepam 286.71 — a small difference, and that is
    // the point: it is invisible on screen and wrong in the same direction every
    // time.
    expect(withBasis!).not.toBeCloseTo(withoutBasis!, 6);
    expect(withBasis! / withoutBasis!).toBeCloseTo(286.71 / 284.74, 6);
  });
});

describe('a censored numerator stays an upper bound', () => {
  it('renders as <X rather than as an interval from zero', () => {
    const censored: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
        o.id === 'obs-ndd-b'
          ? {
              ...o,
              value: undefined,
              qualifier: 'below_limit' as const,
              limitRef: { label: 'rapporteringsgrense', value: 20, unit: 'nmol/L' },
            }
          : o,
      ),
    };

    const result = run(censored).get('ndd_dzp');
    expect(result?.status).toBe('upper_bound');
    // "0–0,19" would state a lower limit the measurement never established.
    expect(formatInterval(result!.rawValue!, result!.status)).toMatch(/^</);
  });
});

describe('a within-matrix ratio must resolve to one specimen', () => {
  it('refuses a ratio whose two operands sit in different blood draws', () => {
    // Each operand is internally unambiguous and each resolves to exactly one
    // specimen, so neither earlier check fires — and the ratio is still two
    // collection times pretending to be one measurement.
    const serial: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: [
        ...DIAZEPAM_FIXTURE_CASE.specimens,
        { id: 'blood-2', matrix: 'whole_blood', relativeTimeHours: 6 },
      ],
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
        o.id === 'obs-dzp-b' ? { ...o, specimenId: 'blood-2' } : o,
      ),
    };

    const result = run(serial).get('ndd_dzp');
    expect(result?.status).toBe('indeterminate');
    expect(result?.calculationWarnings.map((w) => w.code)).toContain('feature_spans_specimens');
  });
});

describe('an operand must resolve to one specimen', () => {
  it('refuses a sum whose terms sit in different urine collections', () => {
    // Each analyte has exactly one match, so the ambiguity check does not fire —
    // and the sum would still add concentrations from two collection times,
    // producing a plausible number from measurements that were never comparable.
    const twoUrines: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: [
        ...DIAZEPAM_FIXTURE_CASE.specimens,
        { id: 'urine-2', matrix: 'urine', urine: { creatinineMmolL: 6 } },
      ],
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
        o.id === 'obs-tem-u' ? { ...o, specimenId: 'urine-2' } : o,
      ),
    };

    const result = run(twoUrines).get('ndd_dwn');
    expect(result?.status).toBe('indeterminate');
    expect(result?.calculationWarnings.map((w) => w.code)).toContain('operand_spans_specimens');
  });
});

describe('a negative concentration is not a measurement', () => {
  it('resolves a negative value indeterminate rather than scaling it', () => {
    // convertConcentration will scale a negative happily, and it would then
    // travel as a real value: a negative ratio, a marker with no logarithm, and
    // threshold comparisons against a quantity that cannot exist.
    const negative: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
        o.id === 'obs-dzp-b' ? { ...o, value: -315.39 } : o,
      ),
    };

    const result = run(negative).get('ndd_dzp');
    expect(result?.status).toBe('indeterminate');
    expect(result?.rawValue).toBeUndefined();
  });

  it('still treats a quantified zero as a real result', () => {
    const zero: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
        o.id === 'obs-ndd-b' ? { ...o, value: 0 } : o,
      ),
    };

    expect(run(zero).get('ndd_dzp')?.status).toBe('point');
  });

  it('refuses a reporting limit at or below zero', () => {
    const badLimit: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
        o.id === 'obs-dzp-b'
          ? {
              ...o,
              value: undefined,
              qualifier: 'below_limit' as const,
              limitRef: { label: 'rapporteringsgrense', value: 0, unit: 'nmol/L' },
            }
          : o,
      ),
    };

    // [0, 0] would read as a quantified zero rather than as no measurement.
    expect(run(badLimit).get('ndd_dzp')?.status).toBe('indeterminate');
  });
});
