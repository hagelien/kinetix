import { describe, it, expect } from 'vitest';

import { calculateFeatures } from './calculateFeatures.js';
import { UNIVERSAL_CONTEXT_FIELDS, HYDROLYSIS_CONTEXT_FIELD } from './contextFields.js';
import { evaluateSignals } from './evaluateSignals.js';
import { BENZODIAZEPINE_GRAPH, DIAZEPAM_FIXTURE_CASE } from './fixtures.js';
import { BENZODIAZEPINE_MODULE } from './modules/benzodiazepines.js';
import { resolveObservations } from './resolveObservations.js';
import {
  assertSignalWellFormed,
  isResolvableCitationHandle,
  type PatternSignalDefinition,
} from './signals.js';
import type { PatternCitationRef } from '../../types/patternCase.js';
import type { PatternContextFieldDefinition } from './contextFields.js';
import { evaluateSourceAmbiguity } from './sourceAmbiguity.js';
import { molecularWeightLookup, unionFeatures } from './substanceModules.js';

const features = unionFeatures([BENZODIAZEPINE_MODULE]);
const resolved = resolveObservations(DIAZEPAM_FIXTURE_CASE, {
  molecularWeightOf: molecularWeightLookup(),
});
const results = calculateFeatures(DIAZEPAM_FIXTURE_CASE, resolved, features);
const contextFields = [
  ...UNIVERSAL_CONTEXT_FIELDS,
  HYDROLYSIS_CONTEXT_FIELD,
  ...BENZODIAZEPINE_MODULE.contextFields,
];

const ambiguity = evaluateSourceAmbiguity({
  graph: BENZODIAZEPINE_GRAPH,
  assumedParent: BENZODIAZEPINE_MODULE.assumedParent,
  observedAnalytes: resolved.map((r) => r.analyte),
  knownExposures: [],
});

function run(selectedContext: Record<string, string>, urineCreatinineMmolL?: number) {
  return new Map(
    evaluateSignals({
      signals: BENZODIAZEPINE_MODULE.signals,
      results,
      contextFields,
      selectedContext,
      sourceAmbiguityByModule: new Map([['benzodiazepines', ambiguity]]),
      urineCreatinineMmolL,
      presentSpecimenMetrics: URINE_PRESENT,
    }).map((s) => [s.id, s]),
  );
}

/** The fixture collects urine, so the dilution signal's basis is offered. */
const URINE_PRESENT: ReadonlySet<'urine_creatinine'> = new Set(['urine_creatinine']);

const FULLY_STATED = {
  bmatrix: 'antemortem_whole_blood',
  umatrix: 'spot',
  interval: 'simultaneous',
  hydro: 'none',
  history: 'repeated',
};

describe('signal degradation (§7.6)', () => {
  it('names the missing field in the degradation line', () => {
    const signals = run({ ...FULLY_STATED, interval: 'not_stated' });
    const timing = signals.get('time_since_intake');

    expect(timing?.degradations).toContainEqual({
      kind: 'field',
      state: 'missing',
      shortKey: 'pattern.profile.context.interval.short',
    });
  });

  it('degrades every source-dependent signal while the source is unresolved', () => {
    // The fixture declares no exposures, so the ambiguity reads `unresolved` and
    // no case in this release reaches a state that lifts it except
    // `not_applicable` (§7.3.1).
    expect(ambiguity.status.kind).toBe('unresolved');

    const signals = run(FULLY_STATED);
    for (const id of ['time_since_intake', 'single_vs_repeated']) {
      expect(signals.get(id)?.degradations.some((d) => d.kind === 'source')).toBe(true);
    }
  });

  it('leaves a signal that does not depend on source resolution alone', () => {
    const dilution = run(FULLY_STATED, 12).get('sample_dilution');
    expect(dilution?.degradations.some((d) => d.kind === 'source')).toBe(false);
  });
});

/**
 * A threshold rule to exercise the banding machinery with.
 *
 * No shipped signal has one any more — the module's only threshold rule was
 * withdrawn when its cut-offs turned out to have no registered published source
 * — so the engine's band ordering, fallback and gating are tested against a
 * fixture rather than against whatever a registry happens to ship. That is the
 * right dependency anyway: these are properties of `evaluateSignals`.
 */
function thresholdSignal(
  thresholdProvenance: [PatternCitationRef, ...PatternCitationRef[]],
): PatternSignalDefinition {
  const dilution = BENZODIAZEPINE_MODULE.signals.find((s) => s.id === 'sample_dilution')!;
  return {
    ...dilution,
    id: 'threshold_fixture',
    strength: {
      type: 'threshold',
      quantity: { type: 'specimen_metric', metric: 'urine_creatinine' },
      bands: [
        { lt: 2, strength: 'moderate', side: 'Hd', caveatKey: 'fixture.dilute' },
        { between: [4, 20], strength: 'moderate', side: 'Hp' },
        { gt: 30, strength: 'weak', side: 'Hd', caveatKey: 'fixture.concentrated' },
      ],
      fallback: { strength: 'no_support', side: 'Hp' },
      thresholdProvenance,
    },
  };
}

/** Cone et al. 2009, which the published-works registry carries. */
const REGISTERED: [PatternCitationRef, ...PatternCitationRef[]] = [
  { type: 'pmid', identifier: '19161663' },
];

function runThreshold(
  signal: PatternSignalDefinition,
  urineCreatinineMmolL?: number,
  selectedContext: Record<string, string> = FULLY_STATED,
) {
  return evaluateSignals({
    signals: [signal],
    results,
    contextFields,
    selectedContext,
    sourceAmbiguityByModule: new Map([['benzodiazepines', ambiguity]]),
    urineCreatinineMmolL,
    presentSpecimenMetrics: URINE_PRESENT,
  })[0];
}

describe('an assumed answer is not the case’s answer', () => {
  it('degrades on an assumed dependency and says which it is', () => {
    // §7.6 puts `missing` and `assumed` on the same degradation line. A verbal
    // strength computed from an assumption rests on a fact nobody established —
    // the same objection as an unstated field, one step less obvious because
    // the screen shows a value for it.
    const assumedField: PatternContextFieldDefinition = {
      id: 'umatrix',
      labelKey: 'pattern.profile.context.umatrix.label',
      shortKey: 'pattern.profile.context.umatrix.short',
      applicability: { type: 'universal' },
      sortOrder: 20,
      options: [
        {
          value: 'spot',
          labelKey: 'pattern.profile.context.umatrix.spot',
          state: 'assumed',
          isDefault: true,
        },
      ],
    };

    const [signal] = evaluateSignals({
      signals: [thresholdSignal(REGISTERED)],
      results,
      contextFields: [assumedField],
      selectedContext: { umatrix: 'spot' },
      sourceAmbiguityByModule: new Map([['benzodiazepines', ambiguity]]),
      urineCreatinineMmolL: 12,
      presentSpecimenMetrics: URINE_PRESENT,
    });

    expect(signal?.degradations).toContainEqual({
      kind: 'field',
      state: 'assumed',
      shortKey: 'pattern.profile.context.umatrix.short',
    });
    // Reported as assumed rather than missing: the field was answered, just not
    // by the case.
    expect(signal?.strength).toEqual({
      kind: 'not_calculable',
      reasonKey: 'pattern.profile.strength.assumedContext',
    });
  });
});

describe('strength expressions come only from a published cut-off', () => {
  it('states a strength when the rule and its provenance both hold', () => {
    // 12 mmol/L falls in the 4–20 band: moderate support for Hp.
    expect(runThreshold(thresholdSignal(REGISTERED), 12)?.strength).toEqual({
      kind: 'stated',
      strengthKey: 'pattern.profile.enfsi.moderate',
      side: 'Hp',
    });
  });

  it('picks the first matching band, so band order is load-bearing', () => {
    expect(runThreshold(thresholdSignal(REGISTERED), 1.5)?.strength).toMatchObject({
      kind: 'stated',
      side: 'Hd',
      caveatKey: 'fixture.dilute',
    });
  });

  it('falls back rather than inventing a band', () => {
    // 25 is above the 4–20 band and below the >30 one. The gap is deliberate and
    // the fallback states no support rather than interpolating.
    expect(runThreshold(thresholdSignal(REGISTERED), 25)?.strength).toEqual({
      kind: 'stated',
      strengthKey: 'pattern.profile.enfsi.noSupport',
      side: 'Hp',
    });
  });

  it('states no strength for any signal the module actually ships', () => {
    // Every shipped signal is `not_calculable`: two ratio signals with no
    // validated mapping from value to ENFSI step, and the dilution signal whose
    // cut-offs had no registered published source.
    const signals = run(FULLY_STATED, 12);
    for (const id of ['time_since_intake', 'single_vs_repeated', 'sample_dilution']) {
      expect(signals.get(id)?.strength.kind).toBe('not_calculable');
    }
    expect(signals.get('sample_dilution')?.strength).toEqual({
      kind: 'not_calculable',
      reasonKey: 'pattern.profile.strength.noPublishedCutoffs',
    });
  });

  it('gates on provenance even when the caller supplies no resolver', () => {
    // The regression this pins: the gate used to run only when a caller passed
    // `provenanceResolves`, and the production pipeline passed none — so every
    // threshold rule computed ungated in the one place a reader would see it,
    // and the guard protected only the test below. The handle here is a real
    // PubMed identifier for an unrelated paper, which is the shape the mistake
    // took in this module's own registry.
    const unregistered = thresholdSignal([{ type: 'pmid', identifier: '11111111' }]);

    expect(runThreshold(unregistered, 12)?.strength).toEqual({
      kind: 'not_calculable',
      reasonKey: 'pattern.profile.strength.provenanceUnresolved',
    });
  });

  it('refuses to compute a threshold whose provenance does not resolve', () => {
    const signals = evaluateSignals({
      signals: [thresholdSignal(REGISTERED)],
      results,
      contextFields,
      selectedContext: FULLY_STATED,
      sourceAmbiguityByModule: new Map([['benzodiazepines', ambiguity]]),
      urineCreatinineMmolL: 12,
      presentSpecimenMetrics: URINE_PRESENT,
      provenanceResolves: () => false,
    });

    expect(signals[0]?.strength).toEqual({
      kind: 'not_calculable',
      reasonKey: 'pattern.profile.strength.provenanceUnresolved',
    });
  });

  it('does not state a strength from a basis whose context is unstated', () => {
    expect(
      runThreshold(thresholdSignal(REGISTERED), 12, { ...FULLY_STATED, umatrix: 'not_stated' })
        ?.strength,
    ).toEqual({
      kind: 'not_calculable',
      reasonKey: 'pattern.profile.strength.missingContext',
    });
  });

  it('does not state a strength when the basis quantity is missing', () => {
    expect(runThreshold(thresholdSignal(REGISTERED))?.strength).toEqual({
      kind: 'not_calculable',
      reasonKey: 'pattern.profile.strength.basisIndeterminate',
    });
  });
});

describe('what counts as published support', () => {
  it('accepts only handles a curator has registered as a published work', () => {
    // Registered and published.
    expect(isResolvableCitationHandle({ type: 'pmid', identifier: '19161663' })).toBe(true);

    // A syntactically perfect PMID that nobody registered — the case the
    // previous shape-only check waved through. Registration is what turns a
    // handle into a claim somebody checked: this module shipped for several
    // commits citing a paper on enzymatic-hydrolysis artefacts as the source of
    // its creatinine cut-offs, and every syntax check in the world passes that.
    expect(isResolvableCitationHandle({ type: 'pmid', identifier: '11111111' })).toBe(false);

    // Nothing at all.
    expect(isResolvableCitationHandle({ type: 'doi', identifier: '10.9999/nope' })).toBe(false);
    expect(isResolvableCitationHandle({ type: 'pmid', identifier: '  ' })).toBe(false);
    expect(isResolvableCitationHandle(undefined)).toBe(false);
  });

  it('fails an unregistered handle loudly at registry load, not quietly at render', () => {
    // A curator can act on a load error. A rule that silently stopped stating a
    // strength would look like an ordinary degradation and never be fixed.
    expect(() =>
      assertSignalWellFormed(thresholdSignal([{ type: 'pmid', identifier: '11111111' }])),
    ).toThrow(/published-works registry/);

    expect(() => assertSignalWellFormed(thresholdSignal(REGISTERED))).not.toThrow();
  });
});
