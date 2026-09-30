/**
 * Phase 2's acceptance (plan §10): a third module, and a case that spans two.
 *
 * The rule these tests enforce is about the diff as much as the assertions —
 * adding a module must touch no file under `src/components/`, which
 * `substanceFree.test.ts` checks from the other side by refusing to let a
 * substance name appear there at all.
 *
 * What is new here is the enzyme half. The methadone module declares a context
 * field it does not own the options for: the row appears because the catalog
 * routes the lineage through CYP2B6, and the substances it offers are whatever
 * the catalog says move that enzyme. Neither fact is written in the module, so
 * these tests supply them the way the endpoint does.
 */

import { describe, it, expect } from 'vitest';

import { calculateFeatures } from './calculateFeatures.js';
import { UNIVERSAL_CONTEXT_FIELDS, applicableContextFields } from './contextFields.js';
import { withGeneratedOptions, type LineageEnzymes } from './lineageEnzymes.js';
import { COCAINE_MODULE } from './modules/cocaine.js';
import { METHADONE_MODULE } from './modules/methadone.js';
import { PATTERN_MODULES } from './modules/index.js';
import { buildProfileFromCase } from './buildProfile.js';
import { buildRatioProfile } from './profileModel.js';
import { resolveObservations } from './resolveObservations.js';
import { evaluateSourceAmbiguity, type MetabolismGraph } from './sourceAmbiguity.js';
import {
  assertModuleWellFormed,
  assertModulesCompose,
  molecularWeightLookup,
  unionContextFields,
  unionFeatures,
} from './substanceModules.js';
import { PATTERN_CASE_KIND, type PatternCaseData } from '../../types/patternCase.js';

const METHADONE = { pubchemCid: 4095, slug: 'metadon' };
const EDDP = { pubchemCid: 5352621, slug: 'eddp' };
const COCAINE = { pubchemCid: 446220, slug: 'kokain' };
const BENZOYLECGONINE = { pubchemCid: 448223, slug: 'benzoylecgonin' };

/** Methadone's lineage as the catalog states it. */
const METHADONE_GRAPH: MetabolismGraph = {
  nodes: [
    { drug: METHADONE, substanceClass: null },
    { drug: EDDP, substanceClass: 'metabolite' },
  ],
  edges: [{ from: METHADONE, to: EDDP }],
};

const METHADONE_CASE: PatternCaseData = {
  kind: PATTERN_CASE_KIND,
  schemaVersion: 1,
  moduleIds: ['methadone'],
  normalization: { creatinineReferenceMmolL: 8.84 },
  specimens: [
    { id: 'blood-1', matrix: 'femoral_blood' },
    { id: 'urine-1', matrix: 'urine', urine: { creatinineMmolL: 8.84 } },
  ],
  observations: [
    {
      id: 'o1',
      specimenId: 'blood-1',
      analyte: METHADONE,
      value: 300,
      unit: 'ng/mL',
      qualifier: 'quantified',
      assay: { measurandMode: 'direct' },
    },
    {
      id: 'o2',
      specimenId: 'blood-1',
      analyte: EDDP,
      value: 60,
      unit: 'ng/mL',
      qualifier: 'quantified',
      assay: { measurandMode: 'direct' },
    },
    {
      id: 'o3',
      specimenId: 'urine-1',
      analyte: EDDP,
      value: 4000,
      unit: 'ng/mL',
      qualifier: 'quantified',
      assay: { measurandMode: 'direct' },
    },
  ],
  context: { postmortem: false, timeOrigin: 'first_specimen_collection', knownExposures: [], fields: {} },
};

/** What the endpoint answers for a methadone case whose catalog is curated. */
const LINEAGE: LineageEnzymes = {
  substrates: [
    { enzymeSlug: 'cyp2b6', drug: METHADONE },
    { enzymeSlug: 'cyp3a4', drug: METHADONE },
  ],
  modulators: [
    {
      enzymeSlug: 'cyp2b6',
      drug: { pubchemCid: 2554, slug: 'karbamazepin' },
      names: { nb: 'Karbamazepin', en: 'Carbamazepine' },
      role: 'inducer',
      strength: 'strong',
    },
    {
      enzymeSlug: 'cyp2b6',
      drug: { pubchemCid: 4184, slug: 'klopidogrel' },
      names: { nb: 'Klopidogrel', en: 'Clopidogrel' },
      role: 'inhibitor',
      strength: 'moderate',
    },
    // A modulator of another enzyme this lineage routes through. It is not
    // offered by the CYP2B6 field: that field asks one question, and an option
    // that answers a different one would be read as answering this one.
    {
      enzymeSlug: 'cyp3a4',
      drug: { pubchemCid: 5280343, slug: 'kinidin' },
      names: { nb: 'Kinidin', en: 'Quinidine' },
      role: 'inhibitor',
      strength: null,
    },
  ],
};

describe('a third module is still a data change (§4.1)', () => {
  it('loads without a registry error, alone and beside the others', () => {
    expect(() => assertModuleWellFormed(METHADONE_MODULE)).not.toThrow();
    // Composition is the second half: a module can be well formed on its own
    // and still collide with another over an id a case flattens.
    expect(() => assertModulesCompose([...PATTERN_MODULES])).not.toThrow();
  });

  it('computes its ratios from the catalog’s own molecular weights', () => {
    const modules = [METHADONE_MODULE];
    const features = unionFeatures(modules);
    const resolved = resolveObservations(METHADONE_CASE, {
      molecularWeightOf: molecularWeightLookup(),
    });
    const results = calculateFeatures(METHADONE_CASE, resolved, features);
    const byId = new Map(results.map((result) => [result.featureId, result]));

    // Mass→molar through the catalog, so the ratio is molar and differs from
    // the mass ratio by MW(MTD)/MW(EDDP).
    expect(byId.get('eddp_mtd_b')?.rawValue?.low).toBeCloseTo((60 / 277.4) / (300 / 309.4), 6);
    // The urine ratio has one operand and no denominator in that matrix, so it
    // is not computable — and says so rather than borrowing the blood one.
    expect(byId.get('eddp_mtd_u')?.status).not.toBe('point');
  });
});

describe('a case that spans two modules', () => {
  it('unions their features and context fields without duplication', () => {
    const modules = [COCAINE_MODULE, METHADONE_MODULE];
    const features = unionFeatures(modules);
    const ids = features.map((feature) => feature.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['be_coc', 'be_u_b', 'eddp_mtd_b', 'eddp_u_b']));

    const fields = applicableContextFields(
      [...UNIVERSAL_CONTEXT_FIELDS, ...unionContextFields(modules)],
      {
        moduleIds: ['cocaine', 'methadone'],
        measurandModes: ['direct'],
        enzymeSlugs: new Set(['cyp2b6']),
      },
    );
    const fieldIds = fields.map((field) => field.id);
    expect(new Set(fieldIds).size).toBe(fieldIds.length);
    // The universal three, plus the enzyme row methadone's lineage raises. The
    // cocaine module contributes none, and nobody decided that either.
    expect(fieldIds).toEqual(['bmatrix', 'umatrix', 'interval', 'cyp2b6_comed']);
  });

  it('draws one profile without letting either module pin the axis', () => {
    const modules = [COCAINE_MODULE, METHADONE_MODULE];
    const features = unionFeatures(modules);
    const resolved = resolveObservations(METHADONE_CASE, {
      molecularWeightOf: molecularWeightLookup(),
    });
    const profile = buildRatioProfile({
      modules,
      features,
      results: calculateFeatures(METHADONE_CASE, resolved, features),
      contextFields: [],
      selectedContext: {},
    });

    // Neither module pins, so this says nothing new on its own — what it pins
    // is that a two-module profile is one profile, on one axis, with each
    // group's rows drawn once.
    const rows = profile.ratioGroups.flatMap((group) => group.rows.map((row) => row.featureId));
    expect(new Set(rows).size).toBe(rows.length);
    expect(profile.axis.ticks.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the enzyme field neither module writes the options for', () => {
  it('appears because the catalog routes the lineage through that enzyme', () => {
    const fields = [...unionContextFields([METHADONE_MODULE])];

    // Curated: the row is offered.
    expect(
      applicableContextFields(fields, {
        moduleIds: ['methadone'],
        measurandModes: ['direct'],
        enzymeSlugs: new Set(['cyp2b6']),
      }).map((field) => field.id),
    ).toEqual(['cyp2b6_comed']);

    // Not curated — or an older deployment that cannot say — offers nothing.
    // A row whose options come from a lineage nobody recorded would ask a
    // question with no answers in it.
    expect(
      applicableContextFields(fields, {
        moduleIds: ['methadone'],
        measurandModes: ['direct'],
        enzymeSlugs: new Set(),
      }),
    ).toEqual([]);
  });

  it('offers the co-medications the catalog says move it, and no others', () => {
    const field = withGeneratedOptions(METHADONE_MODULE.contextFields[0]!, LINEAGE, {
      locale: 'nb-NO',
      effects: METHADONE_MODULE.enzymeEffects,
    });
    const labels = field.options.map((option) => option.label ?? option.labelKey);

    // Generated from `drug_enzyme_interactions` with no registry edit — the
    // module names no substance at all.
    expect(labels).toEqual([
      'pattern.profile.context.cyp2b6Comed.none',
      'Karbamazepin',
      'Klopidogrel',
      // The default stays last: it means "nobody said", and a list ending on it
      // reads as the fallback it is.
      'pattern.profile.context.notStated',
    ]);
    // Scoped to this field's own enzyme. A substance moving another enzyme the
    // lineage routes through answers a different question.
    expect(labels).not.toContain('Kinidin');
    // The value keeps the role as well as the substance, because the same drug
    // can induce one enzyme and inhibit another.
    expect(field.options.map((option) => option.value)).toContain('inducer:2554');
    // And so does the label. The catalog may record one substance in both
    // roles — the uniqueness key allows it — and two options with opposite
    // effects rendered on the name alone are two identical lines.
    expect(field.options.find((option) => option.value === 'inducer:2554')?.labelSuffixKey).toBe(
      'pattern.profile.context.modulator.inducer',
    );
    expect(field.options.find((option) => option.value === 'inhibitor:4184')?.labelSuffixKey).toBe(
      'pattern.profile.context.modulator.inhibitor',
    );

    // And each generated option carries the module's own statement about what
    // selecting it does. Without this the effects are validated at load and
    // then inert: a curator picks a strong inducer and no feature row says
    // anything at all.
    const inducer = field.options.find((option) => option.value === 'inducer:2554');
    const inhibitor = field.options.find((option) => option.value === 'inhibitor:4184');
    expect(inducer?.modifiers).toEqual([{ featureId: 'eddp_mtd_b', direction: 'increases' }]);
    // Matched on the role as well as the enzyme: the opposite role moves the
    // same feature the other way, and matching on the enzyme alone would
    // annotate both with whichever the module declared first.
    expect(inhibitor?.modifiers).toEqual([{ featureId: 'eddp_mtd_b', direction: 'decreases' }]);
  });

  it('names the substance in the reader’s language', () => {
    const english = withGeneratedOptions(METHADONE_MODULE.contextFields[0]!, LINEAGE, {
      locale: 'en-GB',
    });

    // The catalog is already the translation, so the option shows what it
    // holds for this reader rather than a message key somebody has to keep in
    // step with it.
    expect(english.options.map((option) => option.label ?? option.labelKey)).toContain(
      'Carbamazepine',
    );
  });

  it('tells one substance’s two roles apart', () => {
    // The catalog records this shape: `(drug_id, bio_entity_id, role)` is the
    // uniqueness key, so a substance that both induces and inhibits one enzyme
    // is two rows and two options — with opposite modifiers, and the same name.
    const both = withGeneratedOptions(
      METHADONE_MODULE.contextFields[0]!,
      {
        substrates: LINEAGE.substrates,
        modulators: [
          LINEAGE.modulators[0]!,
          { ...LINEAGE.modulators[0]!, role: 'inhibitor' as const, strength: 'weak' as const },
        ],
      },
      { locale: 'nb-NO', effects: METHADONE_MODULE.enzymeEffects },
    );

    const generated = both.options.filter((option) => option.label === 'Karbamazepin');
    expect(generated).toHaveLength(2);
    expect(generated.map((option) => option.labelSuffixKey)).toEqual([
      'pattern.profile.context.modulator.inducer',
      'pattern.profile.context.modulator.inhibitor',
    ]);
    // Opposite effects, so a curator who cannot tell the lines apart files the
    // opposite of what they meant.
    expect(generated.map((option) => option.modifiers?.[0]?.direction)).toEqual([
      'increases',
      'decreases',
    ]);
  });

  it('offers nothing where the lineage routes through no enzyme', () => {
    const field = withGeneratedOptions(METHADONE_MODULE.contextFields[0]!, {
      substrates: [],
      modulators: LINEAGE.modulators,
    });

    // The modulators are known and the routing is not, which is not a licence
    // to offer them: the field would then say this lineage runs through CYP2B6
    // on no evidence at all.
    expect(field.options.map((option) => option.value)).toEqual(['none', 'not_stated']);
  });
});

describe('a selected co-medication reaches the ratio it bears on', () => {
  it('states the direction on the row, without touching the value', () => {
    const modules = [METHADONE_MODULE];
    const features = unionFeatures(modules);
    const resolved = resolveObservations(METHADONE_CASE, {
      molecularWeightOf: molecularWeightLookup(),
    });
    const results = calculateFeatures(METHADONE_CASE, resolved, features);
    const field = withGeneratedOptions(METHADONE_MODULE.contextFields[0]!, LINEAGE, {
      locale: 'nb-NO',
      effects: METHADONE_MODULE.enzymeEffects,
    });

    const profile = buildRatioProfile({
      modules,
      features,
      results,
      contextFields: [field],
      selectedContext: { cyp2b6_comed: 'inducer:2554' },
    });
    const row = profile.ratioGroups
      .flatMap((group) => group.rows)
      .find((candidate) => candidate.featureId === 'eddp_mtd_b');

    // The curated effect, on the row the module named. Without this the
    // modifiers reach `countModifiers` and nothing else, so a curator selects a
    // strong inducer and the screen says nothing at all.
    expect(row?.expectedDirection).toBe('increases');
    // Stated, never applied: the value is what the laboratory measured.
    const unselected = buildRatioProfile({
      modules,
      features,
      results,
      contextFields: [field],
      selectedContext: {},
    });
    const before = unselected.ratioGroups
      .flatMap((group) => group.rows)
      .find((candidate) => candidate.featureId === 'eddp_mtd_b');
    expect(row?.valueText).toBe(before?.valueText);
    expect(before?.expectedDirection).toBeUndefined();
  });

  it('cites the works behind a direction it states, and only then', () => {
    const modules = [METHADONE_MODULE];
    const features = unionFeatures(modules);
    const resolved = resolveObservations(METHADONE_CASE, {
      molecularWeightOf: molecularWeightLookup(),
    });
    const results = calculateFeatures(METHADONE_CASE, resolved, features);
    const field = withGeneratedOptions(METHADONE_MODULE.contextFields[0]!, LINEAGE, {
      locale: 'nb-NO',
      effects: METHADONE_MODULE.enzymeEffects,
    });
    const build = (selectedContext: Record<string, string>) =>
      buildRatioProfile({
        modules,
        features,
        results,
        contextFields: [field],
        selectedContext,
      }).method.citations.map((citation) => citation.identifier);

    // The row now makes an evidence-backed claim — "an inducer raises this
    // ratio" — so the works behind it belong in the method footer with
    // everything else the screen rests on.
    expect(build({ cyp2b6_comed: 'inducer:2554' })).toEqual(
      expect.arrayContaining(['23298862', '25897175']),
    );
    // And not before. An effect nobody selected is not on screen, and citing it
    // would attribute to the profile an assessment it did not make.
    expect(build({})).not.toEqual(expect.arrayContaining(['23298862']));
  });

  it('cites what the catalog says about the interaction itself', () => {
    // Two claims, not one. The module's papers say what CYP2B6 activity does to
    // the ratio; the catalog's reference says that *this substance* moves
    // CYP2B6 — which the screen states the moment the option is offered, and
    // which no paper about the mechanism supports.
    const cited: LineageEnzymes = {
      substrates: LINEAGE.substrates,
      modulators: [
        { ...LINEAGE.modulators[0]!, citations: [{ type: 'pmid', identifier: '12345678' }] },
      ],
    };
    const field = withGeneratedOptions(METHADONE_MODULE.contextFields[0]!, cited, {
      locale: 'nb-NO',
      effects: METHADONE_MODULE.enzymeEffects,
    });
    const modules = [METHADONE_MODULE];
    const features = unionFeatures(modules);
    const resolved = resolveObservations(METHADONE_CASE, {
      molecularWeightOf: molecularWeightLookup(),
    });

    const citations = buildRatioProfile({
      modules,
      features,
      results: calculateFeatures(METHADONE_CASE, resolved, features),
      contextFields: [field],
      selectedContext: { cyp2b6_comed: 'inducer:2554' },
    }).method.citations.map((citation) => citation.identifier);

    expect(citations).toEqual(expect.arrayContaining(['12345678', '23298862']));
  });
});

describe('two modules are two source assessments', () => {
  it('walks each module’s own analytes from its own parent', () => {
    // The case is methadone's, and the cocaine module is in scope beside it —
    // the shape a curator produces by ticking two families. One walk across
    // both framed the question on whichever module the registry listed first
    // and handed it the other's detections, so a methadone result was read as
    // a possible source of a cocaine panel, and the answer changed if the
    // modules were listed the other way round.
    const spanning = { ...METHADONE_CASE, moduleIds: ['cocaine', 'methadone'] };
    const profile = buildProfileFromCase({
      caseData: spanning,
      modules: [COCAINE_MODULE, METHADONE_MODULE],
      graph: METHADONE_GRAPH,
    });

    expect(profile.sourceAmbiguities.map((a) => a.moduleId)).toEqual(['cocaine', 'methadone']);
    expect(profile.sourceAmbiguities.map((a) => a.framedOn?.pubchemCid)).toEqual([
      COCAINE.pubchemCid,
      METHADONE.pubchemCid,
    ]);

    // Methadone's own walk resolves on its own curated lineage. The cocaine
    // assessment sees no cocaine analyte in this case at all, so it has nothing
    // to infer from — and says so by finding no candidates rather than by
    // borrowing methadone's.
    const methadone = profile.sourceAmbiguities.find((a) => a.moduleId === 'methadone');
    const cocaine = profile.sourceAmbiguities.find((a) => a.moduleId === 'cocaine');
    expect(methadone?.statusKind).toBe('not_applicable');
    expect(cocaine?.candidates).toEqual([]);

    // A declared exposure is listed under the statement it bears on. The union
    // would put methadone under a cocaine statement that has just said it
    // speaks for no other module's analytes — two consecutive lines
    // contradicting each other, in a document meant for a court.
    const declared = buildProfileFromCase({
      caseData: {
        ...spanning,
        context: {
          ...spanning.context,
          knownExposures: [{ drug: METHADONE, certainty: 'confirmed' as const }],
        },
      },
      modules: [COCAINE_MODULE, METHADONE_MODULE],
      graph: METHADONE_GRAPH,
    });
    expect(
      declared.sourceAmbiguities.find((a) => a.moduleId === 'methadone')?.declared,
    ).toEqual([{ labelKey: 'pattern.profile.analyte.methadone.label', pubchemCid: METHADONE.pubchemCid, slug: 'metadon', certainty: 'confirmed' }]);
    expect(declared.sourceAmbiguities.find((a) => a.moduleId === 'cocaine')?.declared).toEqual([]);

    // Order-independent, which is the property the old shape could not have:
    // the same case with the modules the other way round answers the same.
    const reversed = buildProfileFromCase({
      caseData: { ...spanning, moduleIds: ['methadone', 'cocaine'] },
      modules: [METHADONE_MODULE, COCAINE_MODULE],
      graph: METHADONE_GRAPH,
    });
    expect(
      reversed.sourceAmbiguities.find((a) => a.moduleId === 'methadone')?.statusKind,
    ).toBe(methadone?.statusKind);
  });
});

describe('neither module raises a source ambiguity', () => {
  const observed = [METHADONE, EDDP];

  it('resolves not_applicable on a curated graph with no administrable candidate', () => {
    const ambiguity = evaluateSourceAmbiguity({
      graph: METHADONE_GRAPH,
      assumedParent: METHADONE,
      observedAnalytes: observed,
      knownExposures: [],
    });

    // Nothing administrable in the recorded neighbourhood — EDDP is
    // `metabolite` in the repository's own classification — so no alternative
    // source is on offer. What that does not assert is that methadone has no
    // other metabolites; the profile's standing caveat says so, because the
    // completeness marker that once did was withdrawn (§7.3.2, amended
    // 2026-08-24).
    expect(ambiguity.status.kind).toBe('not_applicable');
    expect(ambiguity.candidates).toEqual([]);
  });

  it('reads an unrecorded metabolite as absent rather than as a curation gap', () => {
    // The residual the withdrawn markers were meant to carry, stated as
    // behaviour: an edge nobody entered is invisible to the walk, so the answer
    // rests on what the catalog holds. That limit is disclosed on the profile
    // itself rather than encoded in a status no curator was going to clear.
    const withoutTheEdge: MetabolismGraph = { nodes: METHADONE_GRAPH.nodes, edges: [] };

    const ambiguity = evaluateSourceAmbiguity({
      graph: withoutTheEdge,
      assumedParent: METHADONE,
      observedAnalytes: observed,
      knownExposures: [],
    });

    expect(ambiguity.status.kind).toBe('not_applicable');
    expect(ambiguity.candidates).toEqual([]);
  });

  it('resolves not_applicable for the cocaine module on the same terms', () => {
    const graph: MetabolismGraph = {
      nodes: [
        { drug: COCAINE, substanceClass: null },
        { drug: BENZOYLECGONINE, substanceClass: 'metabolite' },
      ],
      edges: [{ from: COCAINE, to: BENZOYLECGONINE }],
    };

    expect(
      evaluateSourceAmbiguity({
        graph,
        assumedParent: COCAINE,
        observedAnalytes: [COCAINE, BENZOYLECGONINE],
        knownExposures: [],
      }).status.kind,
    ).toBe('not_applicable');
  });
});
