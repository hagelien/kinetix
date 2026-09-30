import { describe, it, expect } from 'vitest';

import { calculateFeatures } from './calculateFeatures.js';
import { DIAZEPAM_FIXTURE_CASE } from './fixtures.js';
import { BENZODIAZEPINE_MODULE } from './modules/benzodiazepines.js';
import { resolveObservations } from './resolveObservations.js';
import { molecularWeightLookup, unionFeatures } from './substanceModules.js';
import type { PatternCaseData } from '../../types/patternCase.js';

const molecularWeightOf = molecularWeightLookup();

function run(caseData: PatternCaseData = DIAZEPAM_FIXTURE_CASE) {
  const resolved = resolveObservations(caseData, { molecularWeightOf });
  const features = calculateFeatures(caseData, resolved, unionFeatures([BENZODIAZEPINE_MODULE]));
  return new Map(features.map((f) => [f.featureId, f]));
}

describe('calculateFeatures — the handoff fixture (§10 Phase 0 acceptance)', () => {
  it('computes the four within-matrix ratios', () => {
    const results = run();

    expect(results.get('ndd_dzp')?.rawValue?.low).toBeCloseTo(1.45, 3);
    expect(results.get('oxa_ndd')?.rawValue?.low).toBeCloseTo(1.79, 3);
    expect(results.get('tem_oxa')?.rawValue?.low).toBeCloseTo(0.212, 3);
    expect(results.get('ndd_dwn')?.rawValue?.low).toBeCloseTo(0.461, 3);
  });

  it('computes the two cross-matrix ratios at the spec §11.3 creatinine reference', () => {
    const results = run();

    // The handoff's 3,71 and 6,64 restated at 8.84 mmol/L rather than its own
    // round 10 — §8.1. The raw ratio is unnormalised; the normalised variant is
    // the one the handoff's figure corresponds to.
    expect(results.get('ndd_u_b')?.normalizedValue?.low).toBeCloseTo(3.28, 2);
    expect(results.get('oxa_u_ndd_b')?.normalizedValue?.low).toBeCloseTo(5.87, 2);
  });

  it('applies k only across specimens — the plan’s central invariant', () => {
    const results = run();

    for (const id of ['ndd_dzp', 'oxa_ndd', 'tem_oxa', 'ndd_dwn']) {
      const result = results.get(id);
      expect(result?.normalization.applied, `${id} must not be normalised`).toBe(false);
      expect(result?.normalizedValue, `${id} must have no normalised variant`).toBeUndefined();
    }

    for (const id of ['ndd_u_b', 'oxa_u_ndd_b']) {
      expect(results.get(id)?.normalization.applied, `${id} must be normalised`).toBe(true);
      // k = 8.84 / 13.26 = 2/3: the fixture's creatinine is not the reference.
      expect(results.get(id)?.normalization.factor).toBeCloseTo(8.84 / 13.26, 6);
    }
  });

  it('leaves every within-matrix ratio unchanged when the urine is diluted', () => {
    // Dilution invariance, asserted the way the UI claims it: halve every urine
    // concentration *and* the creatinine, and the within-matrix ratios must not
    // move at all while the normalised cross-matrix ones also hold.
    const diluted: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: DIAZEPAM_FIXTURE_CASE.specimens.map((s) =>
        s.id === 'urine-1' ? { ...s, urine: { creatinineMmolL: 13.26 / 2 } } : s,
      ),
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
        o.specimenId === 'urine-1' && o.value !== undefined ? { ...o, value: o.value / 2 } : o,
      ),
    };

    const before = run();
    const after = run(diluted);

    for (const id of ['oxa_ndd', 'tem_oxa', 'ndd_dwn']) {
      expect(after.get(id)?.rawValue?.low).toBeCloseTo(before.get(id)!.rawValue!.low!, 9);
    }
    for (const id of ['ndd_u_b', 'oxa_u_ndd_b']) {
      expect(after.get(id)?.normalizedValue?.low).toBeCloseTo(
        before.get(id)!.normalizedValue!.low!,
        9,
      );
    }
  });

  it('never emits a row for a withdrawn feature', () => {
    const results = run();
    expect(results.has('sum_u_b')).toBe(false);
  });
});

describe('calculateFeatures — censoring and guards (§8.1, §8.2)', () => {
  it('carries a censored operand through as a bound rather than a point', () => {
    const censored: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
        o.id === 'obs-dzp-b'
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
    // NDD / (<20 nmol/L) is bounded below, not equal to its limit.
    expect(result?.status).toBe('lower_bound');
    expect(result?.rawValue?.low).toBeCloseTo(457.317 / 20, 6);
    expect(result?.rawValue?.high).toBeNull();
  });

  it('returns indeterminate, never 0, when the denominator can be zero', () => {
    const zeroed: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
        o.id === 'obs-dzp-b' ? { ...o, value: 0 } : o,
      ),
    };

    const result = run(zeroed).get('ndd_dzp');
    expect(result?.status).toBe('indeterminate');
    expect(result?.rawValue).toBeUndefined();
  });

  it('keeps a quantified zero numerator as a real value', () => {
    // A quantified zero is not a missing measurement: it is a point at zero,
    // with no logarithm and no "—".
    const zeroed: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
        o.id === 'obs-ndd-b' ? { ...o, value: 0 } : o,
      ),
    };

    const result = run(zeroed).get('ndd_dzp');
    expect(result?.status).toBe('point');
    expect(result?.rawValue?.low).toBe(0);
    expect(result?.log10Value?.low).toBeNull();
  });

  it('reports a missing operand rather than summing over the gap', () => {
    const missing: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.filter((o) => o.id !== 'obs-tem-u'),
    };

    const result = run(missing).get('ndd_dwn');
    expect(result?.status).toBe('indeterminate');
    expect(result?.calculationWarnings.map((w) => w.code)).toContain('operand_missing');
  });
});

describe('a result reported as detected but not quantified', () => {
  /** The ordinary panel line: seen, not quantified, stated under a threshold. */
  const detected = (limitRef?: { label: string; value: number; unit: string }): PatternCaseData => ({
    ...DIAZEPAM_FIXTURE_CASE,
    observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
      o.id === 'obs-ndd-b'
        ? { ...o, value: undefined, qualifier: 'detected_not_quantified' as const, limitRef }
        : o,
    ),
  });

  it('is bounded by the threshold the laboratory stated', () => {
    // Presence bounds nothing on its own, which is why this used to resolve
    // indeterminate — but a report saying "påvist, ikke kvantifisert
    // (< 0,01 µmol/L)" states exactly what the result was under, and throwing
    // that away made the commonest censored line on a real panel the one the
    // engine could compute least from. The presence claim stays in the
    // qualifier, exactly as it does for `below_limit` against `not_detected`.
    const result = run(detected({ label: 'MKK', value: 0.01, unit: 'µmol/L' })).get('ndd_dzp');

    // NDD:DZP with the numerator censored: the ratio is at most the threshold
    // over the diazepam the fixture states (315.39 nmol/L).
    expect(result?.status).toBe('upper_bound');
    expect(result?.rawValue?.high).toBeCloseTo(0.01 / (315.39 / 1000), 6);
    // Unbounded below rather than "0–X": a censored numerator never
    // established a lower limit, which is the engine's standing rule and reads
    // the same for a detection as for a non-detect.
    expect(result?.rawValue?.low).toBeNull();
  });

  it('stays indeterminate when nothing was stated to bound it', () => {
    const result = run(detected()).get('ndd_dzp');

    expect(result?.status).toBe('indeterminate');
  });
});
