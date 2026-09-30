/**
 * §4.1's second acceptance test: a whole profile for a drug family the engine
 * has never seen, built from registry entries alone.
 *
 * The rule this test enforces is about the diff, not the assertions: **adding a
 * module must touch no file under `src/components/`.** If this test ever needs a
 * component change to pass, the generalisation has failed and the plan's central
 * claim with it.
 */

import { describe, it, expect } from 'vitest';

import { calculateFeatures } from './calculateFeatures.js';
import { UNIVERSAL_CONTEXT_FIELDS, applicableContextFields } from './contextFields.js';
import { BENZODIAZEPINE_MODULE } from './modules/benzodiazepines.js';
import { COCAINE_MODULE } from './modules/cocaine.js';
import { buildRatioProfile } from './profileModel.js';
import { resolveObservations } from './resolveObservations.js';
import {
  assertModuleWellFormed,
  molecularWeightLookup,
  unionContextFields,
  unionFeatures,
} from './substanceModules.js';
import { PATTERN_CASE_KIND, type PatternCaseData } from '../../types/patternCase.js';

const COCAINE = { pubchemCid: 446220, slug: 'kokain' };
const BENZOYLECGONINE = { pubchemCid: 448223, slug: 'benzoylecgonin' };

const COCAINE_CASE: PatternCaseData = {
  kind: PATTERN_CASE_KIND,
  schemaVersion: 1,
  moduleIds: ['cocaine'],
  normalization: { creatinineReferenceMmolL: 8.84 },
  specimens: [
    { id: 'blood-1', matrix: 'femoral_blood' },
    { id: 'urine-1', matrix: 'urine', urine: { creatinineMmolL: 8.84 } },
  ],
  observations: [
    {
      id: 'o1',
      specimenId: 'blood-1',
      analyte: COCAINE,
      value: 120,
      unit: 'ng/mL',
      qualifier: 'quantified',
      assay: { measurandMode: 'direct' },
    },
    {
      id: 'o2',
      specimenId: 'blood-1',
      analyte: BENZOYLECGONINE,
      value: 900,
      unit: 'ng/mL',
      qualifier: 'quantified',
      assay: { measurandMode: 'direct' },
    },
    {
      id: 'o3',
      specimenId: 'urine-1',
      analyte: BENZOYLECGONINE,
      value: 40000,
      unit: 'ng/mL',
      qualifier: 'quantified',
      assay: { measurandMode: 'direct' },
    },
  ],
  context: { postmortem: true, timeOrigin: 'death', knownExposures: [], fields: {} },
};

function buildCocaineProfile() {
  const modules = [COCAINE_MODULE];
  const features = unionFeatures(modules);
  const resolved = resolveObservations(COCAINE_CASE, {
    molecularWeightOf: molecularWeightLookup(),
  });
  const results = calculateFeatures(COCAINE_CASE, resolved, features);
  const contextFields = applicableContextFields(
    [...UNIVERSAL_CONTEXT_FIELDS, ...unionContextFields(modules)],
    {
      moduleIds: COCAINE_CASE.moduleIds,
      measurandModes: resolved.map((r) => r.measurandMode),
    },
  );
  return { results, profile: buildRatioProfile({
    modules,
    features,
    results,
    contextFields,
    selectedContext: COCAINE_CASE.context.fields,
  }) };
}

describe('a second module is a data change (§4.1)', () => {
  it('loads without a registry error', () => {
    expect(() => assertModuleWellFormed(COCAINE_MODULE)).not.toThrow();
  });

  it('splits the within-matrix ratios by the matrix they come from', () => {
    const { profile } = buildCocaineProfile();

    expect(profile.ratioGroups.map((g) => g.group)).toEqual(['blood', 'cross_matrix']);
    expect(profile.ratioGroups[0]?.rows.map((r) => r.featureId)).toEqual(['be_coc']);
    expect(profile.ratioGroups[1]?.rows.map((r) => r.featureId)).toEqual(['be_u_b']);
    // No urine group at all: this family ships no urine-internal ratio, and an
    // empty heading would state a matrix the profile has nothing to say about.
    expect(profile.ratioGroups.map((g) => g.group)).not.toContain('urine');
  });

  it('offers no reference band at all — not a hatched placeholder', () => {
    const { profile } = buildCocaineProfile();

    expect(profile.provisional.anyProvisional).toBe(false);
    expect(profile.provisional.totalBands).toBe(0);
    for (const group of profile.ratioGroups) {
      for (const row of group.rows) expect(row.band).toBeNull();
    }
  });

  it('computes the axis from the case values alone, with no module pin', () => {
    const { profile } = buildCocaineProfile();

    // The benzodiazepine module pins 0.03–100; this one pins nothing, so the
    // axis must differ from that pin and still contain both markers.
    expect([profile.axis.lo, profile.axis.hi]).not.toEqual([0.03, 100]);
    expect(profile.axis.ticks.length).toBeGreaterThanOrEqual(3);
    for (const group of profile.ratioGroups) {
      for (const row of group.rows) {
        expect(row.marker?.outOfAxis ?? null).toBeNull();
      }
    }
  });

  it('offers no genotype and no hydrolysis field, without anyone deciding so', () => {
    const { profile } = buildCocaineProfile();
    const ids = profile.contextFields.map((f) => f.id);

    // The genotype field is enzyme-derived and this lineage routes through no
    // CYP; the hydrolysis field is measurand-derived and nothing here is
    // conjugated or measured after hydrolysis.
    expect(ids).not.toContain('geno');
    expect(ids).not.toContain('hydro');
    // The module-scoped benzodiazepine field must not leak in either.
    expect(ids).not.toContain('history');
    expect(ids).toEqual(['bmatrix', 'umatrix', 'interval']);
  });

  it('does not draw one module’s ratios in the other module’s window', () => {
    // A pin is a statement about the window *that* module's ratios are read
    // in, made without knowledge of any other. Taking the first available one
    // across a two-module case decides the shared axis by registry order: the
    // benzodiazepine module pins 0.03–100, the cocaine module pins nothing,
    // and every cocaine ratio would be drawn in a window asked for on behalf
    // of diazepam.
    const modules = [BENZODIAZEPINE_MODULE, COCAINE_MODULE];
    const features = unionFeatures(modules);
    const resolved = resolveObservations(COCAINE_CASE, {
      molecularWeightOf: molecularWeightLookup(),
    });
    const profile = buildRatioProfile({
      modules,
      features,
      results: calculateFeatures(COCAINE_CASE, resolved, features),
      contextFields: [],
      selectedContext: {},
    });

    expect(BENZODIAZEPINE_MODULE.axisPin).toEqual({ lo: 0.03, hi: 100 });
    expect([profile.axis.lo, profile.axis.hi]).not.toEqual([0.03, 100]);
  });

  it('gives a two-module case one assessment per module, each named', () => {
    // Phase 2's answer to a question Phase 1 could only state: a case spanning
    // two families gets a walk per module, each framed on its own parent —
    // rather than one walk framed on whichever module the registry lists
    // first, reading the other module's detections as evidence about a lineage
    // they have nothing to do with.
    const modules = [BENZODIAZEPINE_MODULE, COCAINE_MODULE];
    const profile = buildRatioProfile({
      modules,
      features: [],
      results: [],
      contextFields: [],
      selectedContext: {},
      sourceAmbiguities: modules.map((module) => ({
        moduleId: module.id,
        ambiguity: {
          assumedParent: module.assumedParent,
          candidates: [],
          status: { kind: 'not_applicable' as const },
        },
      })),
    });

    expect(profile.sourceAmbiguities.map((a) => a.moduleId)).toEqual([
      'benzodiazepines',
      'cocaine',
    ]);
    // Each says which lineage it is about, because two statements on one screen
    // are otherwise indistinguishable — and `not_applicable` renders as no
    // statement at all, which is where the framing would vanish entirely.
    expect(profile.sourceAmbiguities.map((a) => a.framedOn?.pubchemCid)).toEqual([
      BENZODIAZEPINE_MODULE.assumedParent.pubchemCid,
      COCAINE_MODULE.assumedParent.pubchemCid,
    ]);

    // And nothing to say where there is nothing to choose between.
    const single = buildRatioProfile({
      modules: [COCAINE_MODULE],
      features: [],
      results: [],
      contextFields: [],
      selectedContext: {},
      sourceAmbiguity: {
        assumedParent: COCAINE_MODULE.assumedParent,
        candidates: [],
        status: { kind: 'not_applicable' },
      },
    });
    expect(single.sourceAmbiguities[0]?.framedOn).toBeNull();
  });

  it('raises no signal, because no basis feature qualifies', () => {
    expect(COCAINE_MODULE.signals).toEqual([]);
    expect(COCAINE_MODULE.notEstablished).toEqual([]);
  });

  it('still computes both ratios correctly', () => {
    const { results } = buildCocaineProfile();
    const byId = new Map(results.map((r) => [r.featureId, r]));

    // Mass→molar via the catalog's own molecular weights, so the ratio is molar
    // and differs from the mass ratio by MW(COC)/MW(BE).
    const expectedBeCoc = (900 / 289.33) / (120 / 303.35);
    expect(byId.get('be_coc')?.rawValue?.low).toBeCloseTo(expectedBeCoc, 6);

    // Creatinine equals the reference here, so k is 1 and the normalised value
    // matches the raw one — the degenerate case, asserted so the cross-matrix
    // path is exercised even in a module with no dilution story of its own.
    expect(byId.get('be_u_b')?.normalization.applied).toBe(true);
    expect(byId.get('be_u_b')?.normalization.factor).toBeCloseTo(1, 9);
    expect(byId.get('be_u_b')?.rawValue?.low).toBeCloseTo(40000 / 900, 6);
  });
});
