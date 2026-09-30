import { describe, it, expect } from 'vitest';

import { evaluateArtefactRules } from './artefactRules.js';
import { HYDROLYSIS_CONTEXT_FIELD } from './contextFields.js';
import { DIAZEPAM_FIXTURE_CASE } from './fixtures.js';
import { BENZODIAZEPINE_MODULE } from './modules/benzodiazepines.js';
import { resolveObservations } from './resolveObservations.js';
import { molecularWeightLookup, unionFeatures } from './substanceModules.js';
import type { PatternFeatureDefinition } from './featureRegistry.js';
import type { ResolvedObservation } from '../../types/patternCase.js';

const resolved = resolveObservations(DIAZEPAM_FIXTURE_CASE, {
  molecularWeightOf: molecularWeightLookup(),
});
const features = unionFeatures([BENZODIAZEPINE_MODULE]);

function flagsFor(hydro: string): string[] {
  return evaluateArtefactRules({
    rules: BENZODIAZEPINE_MODULE.artefactRules,
    features,
    resolved,
    selectedContext: { hydro },
    contextFields: [HYDROLYSIS_CONTEXT_FIELD],
  }).map((f) => f.featureId);
}

describe('assay artefact rules (§7.4)', () => {
  it('flags exactly five of the six features, and not the blood-only ratio', () => {
    // The Phase 0 acceptance criterion. NDD ∶ DZP has both operands in blood,
    // which a urine hydrolysis cannot reach; that asymmetry is the entire point
    // of scoping the rule to the material the protocol touched.
    const flagged = flagsFor('snail');

    expect(new Set(flagged)).toEqual(
      new Set(['oxa_ndd', 'tem_oxa', 'ndd_dwn', 'ndd_u_b', 'oxa_u_ndd_b']),
    );
    expect(flagged).not.toContain('ndd_dzp');
  });

  it('flags the ratio whose denominator was consumed, not just the product', () => {
    // TEM ∶ OXA contains no nordazepam at all: it is flagged because oxazepam,
    // the consumed species, sits in its denominator. A rule that only followed
    // the inflated product would miss it entirely.
    expect(flagsFor('snail')).toContain('tem_oxa');
  });

  it('fires when the protocol is unrecorded, not only when it is declared', () => {
    // "Not stated" is a missing datum, not an assertion of "none" — §3.3's first
    // content change exists so that absence stops reading as absence of risk.
    expect(flagsFor('not_stated').length).toBe(5);
  });

  it('fires on the field default when the case answered nothing', () => {
    // The ordinary shape of a fresh case is `fields: {}`. Reading the record and
    // skipping on `undefined` would suppress the caution on exactly the cases it
    // exists for — the ones where nobody wrote the protocol down.
    const flags = evaluateArtefactRules({
      rules: BENZODIAZEPINE_MODULE.artefactRules,
      features,
      resolved,
      selectedContext: {},
      contextFields: [HYDROLYSIS_CONTEXT_FIELD],
    });

    expect(flags.length).toBe(5);
  });

  it('treats an unrecognised stored value as unstated, not as an answer', () => {
    // An option withdrawn since the case was saved. The case-data view already
    // marks it missing; the rule must agree, or the caution disappears exactly
    // when the protocol is least known.
    const flags = evaluateArtefactRules({
      rules: BENZODIAZEPINE_MODULE.artefactRules,
      features,
      resolved,
      selectedContext: { hydro: 'enzyme_from_2019' },
      contextFields: [HYDROLYSIS_CONTEXT_FIELD],
    });

    expect(flags.length).toBe(5);
  });

  it('stays silent when the protocol rules the conversion out', () => {
    expect(flagsFor('none')).toEqual([]);
    expect(flagsFor('recombinant')).toEqual([]);
  });
});

describe('a warning belongs to the observation the feature actually used', () => {
  it('does not warn a free-measurand term from a hydrolysed observation', () => {
    // A case can hold both a free and a hydrolysed result for one analyte in
    // one matrix. `calculateFeatures` resolves the operand by
    // `term.measurandMode`, so a term naming the free measurand never reads the
    // hydrolysed observation — and a caution drawn from a result the row did
    // not use is a warning spent where it is not true, which erodes it where it
    // is. Here only the hydrolysed oxazepam exists, so it is the sole possible
    // source of a flag on a term that asked for the free one.
    const OXAZEPAM = { pubchemCid: 4616 };
    const TEMAZEPAM = { pubchemCid: 5391 };

    const freeTerm: PatternFeatureDefinition = {
      id: 'free_only',
      version: '1.0.0',
      moduleId: 'test',
      kind: 'parent_metabolite_ratio',
      labelKey: 'x',
      numerator: {
        terms: [{ analyte: OXAZEPAM, matrix: 'urine', measurandMode: 'free' }],
      },
      denominator: {
        terms: [{ analyte: TEMAZEPAM, matrix: 'urine', measurandMode: 'free' }],
      },
      sortOrder: 10,
    };

    const resolved: ResolvedObservation[] = [
      {
        observationId: 'hydrolysed',
        specimenId: 'urine-1',
        analyte: OXAZEPAM,
        matrix: 'urine',
        measurandMode: 'total_after_hydrolysis',
        status: 'point',
        micromolarPerL: { low: 4, high: 4 },
        qualifier: 'quantified',
      },
      {
        observationId: 'tem',
        specimenId: 'urine-1',
        analyte: TEMAZEPAM,
        matrix: 'urine',
        measurandMode: 'free',
        status: 'point',
        micromolarPerL: { low: 2, high: 2 },
        qualifier: 'quantified',
      },
    ];

    const flagsFor = (feature: PatternFeatureDefinition) =>
      evaluateArtefactRules({
        rules: BENZODIAZEPINE_MODULE.artefactRules,
        features: [feature],
        resolved,
        selectedContext: { hydro: 'snail' },
        contextFields: [HYDROLYSIS_CONTEXT_FIELD],
      }).map((f) => f.featureId);

    expect(flagsFor(freeTerm)).not.toContain('free_only');

    // And it still fires where the operand does read that observation.
    const hydrolysedTerm: PatternFeatureDefinition = {
      ...freeTerm,
      id: 'hydrolysed_only',
      numerator: {
        terms: [
          { analyte: OXAZEPAM, matrix: 'urine', measurandMode: 'total_after_hydrolysis' },
        ],
      },
    };

    expect(flagsFor(hydrolysedTerm)).toContain('hydrolysed_only');
  });

  it('still warns a term that names no measurand mode', () => {
    // Most terms do not name one, and an unspecified term reads whatever the
    // case holds — so the restriction above must not quietly narrow the rule
    // for every feature that did not opt in.
    const results = evaluateArtefactRules({
      rules: BENZODIAZEPINE_MODULE.artefactRules,
      features: unionFeatures([BENZODIAZEPINE_MODULE]),
      resolved: resolveObservations(DIAZEPAM_FIXTURE_CASE, {
        molecularWeightOf: molecularWeightLookup(),
      }),
      selectedContext: {},
      contextFields: [HYDROLYSIS_CONTEXT_FIELD],
    });

    expect(results.length).toBeGreaterThan(0);
  });
});
