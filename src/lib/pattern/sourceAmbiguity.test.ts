/**
 * The codeine/morphine acceptance fixture (§4.1, third check).
 *
 * It tests both walk directions in one case: morphine is a metabolite of codeine
 * *and* a marketed product (downstream), and heroin is an administrable
 * precursor of the observed morphine that no downstream walk from codeine ever
 * reaches (upstream). A fixture asserting only the first would pass on an
 * implementation that never looks upstream — the failure mode with the worst
 * forensic consequence, so the assertions name both.
 *
 * No benzodiazepine code is involved: the statement comes from the graph alone.
 */

import { describe, it, expect } from 'vitest';

import { BENZODIAZEPINE_GRAPH } from './fixtures.js';
import { evaluateSourceAmbiguity, type MetabolismGraph } from './sourceAmbiguity.js';

const CODEINE = { pubchemCid: 5284371, slug: 'kodein' };
const MORPHINE = { pubchemCid: 5288826, slug: 'morfin' };
const HEROIN = { pubchemCid: 5462328, slug: 'heroin' };
const COCAINE = { pubchemCid: 446220, slug: 'kokain' };
const BENZOYLECGONINE = { pubchemCid: 448223, slug: 'benzoylecgonin' };

/** `codeine → morphine ← heroin`. */
const OPIOID_GRAPH: MetabolismGraph = {
  nodes: [
    { drug: CODEINE, substanceClass: 'drug' },
    { drug: MORPHINE, substanceClass: 'drug' },
    { drug: HEROIN, substanceClass: 'drug' },
  ],
  edges: [
    { from: CODEINE, to: MORPHINE },
    { from: HEROIN, to: MORPHINE },
  ],
};

describe('source ambiguity — codeine/morphine (§7.3)', () => {
  it('finds the downstream candidate and the upstream one', () => {
    const ambiguity = evaluateSourceAmbiguity({
      graph: OPIOID_GRAPH,
      assumedParent: CODEINE,
      observedAnalytes: [MORPHINE],
      knownExposures: [],
    });

    const byCid = new Map(ambiguity.candidates.map((c) => [c.drug.pubchemCid, c]));

    expect(byCid.get(MORPHINE.pubchemCid)?.direction).toBe('downstream');
    // The assertion that matters: a downstream-only enumeration returns an empty
    // set here, resolves not_applicable, and renders every parent-dependent
    // signal as if the source were settled while a second compatible parent sits
    // one edge away.
    expect(byCid.get(HEROIN.pubchemCid)?.direction).toBe('upstream');
    expect(ambiguity.status.kind).toBe('unresolved');
  });

  it('classifies heroin sole-capable over an observed morphine panel', () => {
    const ambiguity = evaluateSourceAmbiguity({
      graph: OPIOID_GRAPH,
      assumedParent: CODEINE,
      observedAnalytes: [MORPHINE],
      knownExposures: [],
    });

    const heroin = ambiguity.candidates.find((c) => c.drug.pubchemCid === HEROIN.pubchemCid);
    expect(heroin?.role).toBe('sole_capable');
  });

  it('demotes heroin to contributing once codeine is observed too', () => {
    // Neither heroin nor morphine can account for an observed codeine on its
    // own, so neither could ever replace the assumed parent.
    const ambiguity = evaluateSourceAmbiguity({
      graph: OPIOID_GRAPH,
      assumedParent: CODEINE,
      observedAnalytes: [MORPHINE, CODEINE],
      knownExposures: [],
    });

    const heroin = ambiguity.candidates.find((c) => c.drug.pubchemCid === HEROIN.pubchemCid);
    expect(heroin?.role).toBe('contributing');
  });

  it('asserts mixed sourcing from the observations, without asking about provenance', () => {
    const ambiguity = evaluateSourceAmbiguity({
      graph: OPIOID_GRAPH,
      assumedParent: CODEINE,
      observedAnalytes: [MORPHINE],
      knownExposures: [
        { drug: CODEINE, certainty: 'confirmed' },
        { drug: HEROIN, certainty: 'reported' },
      ],
    });

    expect(ambiguity.status.kind).toBe('mixed_source');
  });

  it('does not call one confirmed exposure mixed sourcing', () => {
    const ambiguity = evaluateSourceAmbiguity({
      graph: OPIOID_GRAPH,
      assumedParent: CODEINE,
      observedAnalytes: [MORPHINE],
      knownExposures: [{ drug: CODEINE, certainty: 'confirmed' }],
    });

    // One source established and an open question is not the claim that several
    // administered sources fed the profile.
    expect(ambiguity.status.kind).toBe('unresolved');
  });
});

describe('source ambiguity — the walk reads recorded edges (§7.3.2)', () => {
  it('reaches an upstream source through the edges that are entered', () => {
    // The completeness markers this walk once required were withdrawn: they
    // were a curator assertion nobody made, so every case resolved to a
    // curation complaint instead of an assessment. What the walk reads now is
    // the entered data, and heroin is entered data.
    const ambiguity = evaluateSourceAmbiguity({
      graph: OPIOID_GRAPH,
      assumedParent: CODEINE,
      observedAnalytes: [MORPHINE],
      knownExposures: [],
    });

    expect(ambiguity.candidates.map((c) => c.drug.pubchemCid)).toContain(HEROIN.pubchemCid);
    expect(ambiguity.status.kind).toBe('unresolved');
  });

  it('cannot see a source nobody entered, which is what the profile caveat states', () => {
    // The honest limit of the design, pinned rather than left implicit. Drop
    // the heroin edge and heroin stops being a candidate — the analysis is
    // exactly as complete as the catalog, and the ratio profile says so in a
    // standing line rather than in a status no curator was ever going to clear.
    const withoutHeroinEdge: MetabolismGraph = {
      nodes: OPIOID_GRAPH.nodes,
      edges: OPIOID_GRAPH.edges.filter((e) => e.from.pubchemCid !== HEROIN.pubchemCid),
    };

    const ambiguity = evaluateSourceAmbiguity({
      graph: withoutHeroinEdge,
      assumedParent: CODEINE,
      observedAnalytes: [MORPHINE],
      knownExposures: [],
    });

    expect(ambiguity.candidates.map((c) => c.drug.pubchemCid)).not.toContain(HEROIN.pubchemCid);
  });

  it('lets positive evidence outrank the enumeration', () => {
    const ambiguity = evaluateSourceAmbiguity({
      graph: OPIOID_GRAPH,
      assumedParent: CODEINE,
      observedAnalytes: [MORPHINE],
      knownExposures: [
        { drug: CODEINE, certainty: 'confirmed' },
        { drug: HEROIN, certainty: 'confirmed' },
      ],
    });

    expect(ambiguity.status.kind).toBe('mixed_source');
  });
});

describe('source ambiguity — the diazepam panel (§10 Phase 0 acceptance)', () => {
  const DIAZEPAM = { pubchemCid: 3016 };
  const NORDAZEPAM = { pubchemCid: 2997 };
  const TEMAZEPAM = { pubchemCid: 5391 };
  const OXAZEPAM = { pubchemCid: 4616 };

  it('lists the downstream products as contributing, never sole-capable', () => {
    const ambiguity = evaluateSourceAmbiguity({
      graph: BENZODIAZEPINE_GRAPH,
      assumedParent: DIAZEPAM,
      observedAnalytes: [DIAZEPAM, NORDAZEPAM, TEMAZEPAM, OXAZEPAM],
      knownExposures: [],
    });

    const byCid = new Map(ambiguity.candidates.map((c) => [c.drug.pubchemCid, c]));

    // Each is a marketed product and each can inflate part of the profile, but
    // none can produce the measured blood diazepam — so none could replace the
    // parent, and calling one sole-capable would propose reframing the case onto
    // a substance that leaves an observation unexplained.
    expect(byCid.get(OXAZEPAM.pubchemCid)?.role).toBe('contributing');
    expect(byCid.get(TEMAZEPAM.pubchemCid)?.role).toBe('contributing');
    expect(byCid.get(NORDAZEPAM.pubchemCid)?.role).toBe('contributing');
    expect(ambiguity.status.kind).toBe('unresolved');
  });

  it('never resolves the ambiguity from an absence of declared exposures', () => {
    // §7.3.1: this release states the ambiguity and never settles it. No case
    // reaches a state that lifts the degradation except not_applicable.
    const ambiguity = evaluateSourceAmbiguity({
      graph: BENZODIAZEPINE_GRAPH,
      assumedParent: DIAZEPAM,
      observedAnalytes: [DIAZEPAM, NORDAZEPAM, OXAZEPAM],
      knownExposures: [{ drug: DIAZEPAM, certainty: 'confirmed' }],
    });

    expect(ambiguity.status.kind).toBe('unresolved');
    expect(ambiguity.candidates.length).toBeGreaterThan(0);
  });
});

describe('source ambiguity — the no-alternative case (§4.1)', () => {
  const cocaineGraph: MetabolismGraph = {
    nodes: [
      { drug: COCAINE, substanceClass: 'drug' },
      {
        // The repository's own judgement: an inactive hydrolysis product with no
        // reason to give it.
        drug: BENZOYLECGONINE,
        substanceClass: 'metabolite',
      },
    ],
    edges: [{ from: COCAINE, to: BENZOYLECGONINE }],
  };

  it('resolves not_applicable, so no warning fires where the ambiguity cannot exist', () => {
    const ambiguity = evaluateSourceAmbiguity({
      graph: cocaineGraph,
      assumedParent: COCAINE,
      observedAnalytes: [BENZOYLECGONINE],
      knownExposures: [],
    });

    expect(ambiguity.candidates).toEqual([]);
    expect(ambiguity.status.kind).toBe('not_applicable');
  });

  it('resolves not_applicable on an empty panel without enumerating anything', () => {
    // A detection is what puts a source in question. With nothing found there
    // is no profile to explain, and walking anyway would list every
    // administrable neighbour as an alternative source of nothing.
    const ambiguity = evaluateSourceAmbiguity({
      graph: cocaineGraph,
      assumedParent: COCAINE,
      observedAnalytes: [],
      knownExposures: [],
    });

    expect(ambiguity.candidates).toEqual([]);
    expect(ambiguity.status.kind).toBe('not_applicable');
  });
});

describe('source ambiguity — a candidate is classified by its recorded lineage', () => {
  const M2 = { pubchemCid: 999001, slug: 'm2' };
  const X = { pubchemCid: 999002, slug: 'x' };

  /** `codeine → M ← B`, `B → X`, `codeine → M2`. */
  const deepGraph: MetabolismGraph = {
    nodes: [
      { drug: CODEINE, substanceClass: 'drug' },
      { drug: MORPHINE, substanceClass: 'drug' },
      { drug: HEROIN, substanceClass: 'drug' },
      { drug: X, substanceClass: 'metabolite' },
      { drug: M2, substanceClass: 'metabolite' },
    ],
    edges: [
      { from: CODEINE, to: MORPHINE },
      { from: HEROIN, to: MORPHINE },
      { from: HEROIN, to: X },
      { from: CODEINE, to: M2 },
    ],
  };

  it('calls a candidate contributing where its lineage reaches part of the panel', () => {
    // Heroin's recorded lineage reaches morphine but not M2, so it explains
    // part of what was found and could not replace the assumed parent.
    const ambiguity = evaluateSourceAmbiguity({
      graph: deepGraph,
      assumedParent: CODEINE,
      observedAnalytes: [MORPHINE, M2],
      knownExposures: [],
    });

    const heroin = ambiguity.candidates.find((c) => c.drug.pubchemCid === HEROIN.pubchemCid);
    expect(heroin?.role).toBe('contributing');
  });

  it('drops a candidate whose lineage reaches nothing observed', () => {
    // X is not administrable anyway; the rule under test is coverage. A
    // substance that explains no observation in this case is not offered as a
    // possible source of it.
    const ambiguity = evaluateSourceAmbiguity({
      graph: deepGraph,
      assumedParent: CODEINE,
      observedAnalytes: [M2],
      knownExposures: [],
    });

    expect(ambiguity.candidates.map((c) => c.drug.pubchemCid)).not.toContain(HEROIN.pubchemCid);
  });
});

describe('the catalog decides what counts as administered', () => {
  it('does not treat an endogenous substance as an alternative source', () => {
    // The vocabulary here was invented rather than shared: it admitted a class
    // the catalog does not have and excluded only `metabolite`, so an
    // endogenous substance passed as an administered candidate — a false
    // ambiguity, degrading every source-dependent signal on the case.
    const parent = { pubchemCid: 1 };
    const metabolite = { pubchemCid: 2 };
    const endogenous = { pubchemCid: 3 };

    const graph: MetabolismGraph = {
      nodes: [
        {
          drug: parent,
          substanceClass: 'drug',
        },
        {
          drug: metabolite,
          substanceClass: 'metabolite',
        },
        {
          drug: endogenous,
          substanceClass: 'endogenous',
        },
      ],
      edges: [
        { from: parent, to: metabolite },
        { from: endogenous, to: metabolite },
      ],
    };

    const ambiguity = evaluateSourceAmbiguity({
      graph,
      assumedParent: parent,
      observedAnalytes: [metabolite],
      knownExposures: [],
    });

    // Nobody administers the endogenous substance, so it cannot be the source
    // of an exposure — even though it does form the observed metabolite.
    expect(ambiguity.candidates.map((c) => c.drug.pubchemCid)).not.toContain(3);
    expect(ambiguity.status.kind).toBe('not_applicable');
  });
});
