/**
 * Source ambiguity (§7.3).
 *
 * A profile dominated by oxazepam is equally consistent with diazepam intake and
 * with oxazepam intake, and the handoff's screen assumed a parent without
 * asking. This is fully derivable and needs no benzodiazepine knowledge — but it
 * requires walking the metabolism graph in **both** directions.
 *
 * The upstream walk is not a refinement. For a graph `A → M ← B`, an assumed
 * parent `A` and an observed metabolite `M`, the administered substance may have
 * been `B`, which no downstream walk from `A` will ever reach. Codeine and heroin
 * over morphine is exactly this shape, and getting it wrong is the forensic
 * error Layer A's A4 warns about in its most consequential form.
 *
 * **The walk reads the edges the catalog holds, and nothing certifies that set
 * complete.** An earlier design made completeness an explicit per-substance,
 * per-direction assertion by a curator, so that an empty candidate set could
 * mean "nothing can confound this profile" rather than "nobody has entered the
 * edges yet". It was withdrawn (owner, 2026-08-24): the assertion was a manual
 * step nobody performs in the course of real curation, so in practice every node
 * stayed unasserted and every case resolved to a curation complaint instead of
 * an assessment — a screen full of requests that were never going to be
 * answered, and no analysis behind them.
 *
 * What replaces it is a standing caveat on the profile itself
 * (`pattern.profile.metaboliteCoverage`): the assessment reads recorded edges,
 * and a metabolite nobody entered may disturb both the ratios and this walk. So
 * `not_applicable` here now means "no administrable alternative among the
 * recorded edges", not "no administrable alternative exists" — the residual is
 * stated once, in the open, rather than encoded in a status nobody could clear.
 */

import type { PatternDrugRef, PatternKnownExposure } from '../../types/patternCase.js';
import { substanceIsAdministered, type SubstanceClass } from '../parameterApplicability.js';

/**
 * The module-scoped metabolism neighbourhood.
 *
 * Phase 0 supplies this from a fixture; Phase 1 fetches it from
 * `/api/metabolism-graph`. The shape is the same either way — the endpoint is
 * module-scoped precisely so the case's analyte ids never appear in a request
 * URL, which spec §41.1 prohibits because it discloses case content to the
 * server.
 */
export interface MetabolismGraph {
  nodes: Array<{
    drug: PatternDrugRef;
    /**
     * From `drugs.substance_class`. Administrability is **read, not inferred**:
     * `data/substanceClasses.ts` sets an explicit bar ("nobody administers it in
     * any form") and instructs "when in doubt, leave it off", so an unclassified
     * substance defaults to administered. That default is the safe one here — a
     * missing classification raises an ambiguity that may be unnecessary, and
     * never suppresses one that is real.
     */
    substanceClass?: SubstanceClass | null;
  }>;
  /** Directed parent → metabolite edges. */
  edges: Array<{ from: PatternDrugRef; to: PatternDrugRef }>;
}

export interface SourceCandidate {
  drug: PatternDrugRef;
  direction: 'downstream' | 'upstream';
  /** Whether its own recorded lineage covers the whole observed panel. */
  role: 'sole_capable' | 'contributing';
}

export type SourceAmbiguityStatus =
  | { kind: 'not_applicable' }
  | { kind: 'unresolved' }
  | { kind: 'mixed_source' };

export interface SourceAmbiguity {
  assumedParent: PatternDrugRef;
  candidates: SourceCandidate[];
  status: SourceAmbiguityStatus;
}

export function evaluateSourceAmbiguity(input: {
  graph: MetabolismGraph;
  assumedParent: PatternDrugRef;
  observedAnalytes: PatternDrugRef[];
  knownExposures: PatternKnownExposure[];
}): SourceAmbiguity {
  const { graph, assumedParent, observedAnalytes, knownExposures } = input;

  const observed = new Set(observedAnalytes.map((a) => a.pubchemCid));

  // Nothing was detected, so there is no profile whose source could be in
  // question. Walking anyway would frame an assessment on an empty panel: every
  // administrable neighbour of the assumed parent would be enumerated as an
  // alternative source of nothing, and every source-dependent signal on a case
  // with nothing to say would degrade behind it.
  if (observed.size === 0) {
    return { assumedParent, candidates: [], status: { kind: 'not_applicable' } };
  }

  // Downstream from the assumed parent, and upstream from every observed
  // analyte. Both walks are transitive: an alternative source two steps up is
  // still the substance that was administered.
  const downstream = walk(graph, [assumedParent], 'metabolites');
  const upstream = walk(graph, observedAnalytes, 'precursors');

  const candidateCids = new Set<number>();
  const candidates: SourceCandidate[] = [];

  for (const [cids, direction] of [
    [downstream, 'downstream'],
    [upstream, 'upstream'],
  ] as const) {
    for (const cid of cids) {
      if (cid === assumedParent.pubchemCid) continue;
      if (candidateCids.has(cid)) continue;
      const node = nodeFor(graph, cid);
      if (!node) continue;
      if (!isAdministrable(node.substanceClass)) continue;

      // A candidate whose recorded lineage reaches nothing observed explains no
      // observation in this case, so it is dropped rather than listed. What it
      // does not prove is that no such substance exists — an unrecorded edge
      // under it would put it back — which is the residual the profile's
      // standing caveat states.
      const classification = classify(graph, { pubchemCid: cid }, observed);
      if (classification === null) continue;

      candidateCids.add(cid);
      candidates.push({ drug: node.drug, direction, role: classification });
    }
  }

  return {
    assumedParent,
    candidates,
    status: resolveStatus({ candidates, assumedParent, knownExposures }),
  };
}

/**
 * Positive evidence is read before anything else: two confirmed exposures are
 * `mixed_source` even when no history source was consulted, because provenance
 * absence should not downgrade a claim the observations already support.
 */
function resolveStatus(input: {
  candidates: SourceCandidate[];
  assumedParent: PatternDrugRef;
  knownExposures: PatternKnownExposure[];
}): SourceAmbiguityStatus {
  const { candidates, assumedParent, knownExposures } = input;

  const declared = new Set(
    knownExposures
      .filter((e) => e.certainty === 'confirmed' || e.certainty === 'reported')
      .map((e) => e.drug.pubchemCid),
  );
  const declaredAmongSources = [assumedParent, ...candidates.map((c) => c.drug)].filter((d) =>
    declared.has(d.pubchemCid),
  );

  // Two or more positively declared sources *assert* that several administered
  // substances fed the profile — a statement about this case's history, which
  // outranks the enumeration of what the graph merely allows.
  if (declaredAmongSources.length >= 2) return { kind: 'mixed_source' };

  // No administrable candidate anywhere in the recorded neighbourhood. This is
  // the one status that lifts every source degradation, and it rests on the
  // edges the catalog holds — see the file header, and the caveat the profile
  // carries beside every assessment.
  if (candidates.length === 0) return { kind: 'not_applicable' };

  // Everything else, including a single confirmed exposure: one source
  // established and an open question is not the same claim as mixed sourcing.
  return { kind: 'unresolved' };
}

function walk(
  graph: MetabolismGraph,
  from: PatternDrugRef[],
  direction: 'metabolites' | 'precursors',
): Set<number> {
  const seen = new Set<number>();
  const queue = from.map((d) => d.pubchemCid);

  while (queue.length > 0) {
    const cid = queue.shift()!;
    if (seen.has(cid)) continue;
    seen.add(cid);

    for (const edge of graph.edges) {
      if (direction === 'metabolites' && edge.from.pubchemCid === cid) {
        queue.push(edge.to.pubchemCid);
      } else if (direction === 'precursors' && edge.to.pubchemCid === cid) {
        queue.push(edge.from.pubchemCid);
      }
    }
  }

  // Start nodes stay in the set. An observed analyte that is itself
  // administrable is a legitimate candidate — oxazepam observed on a diazepam
  // panel is Layer A's A4 case exactly — so removing them here would drop the
  // finding this module exists to produce. The assumed parent is excluded by the
  // caller instead, which is the only node that genuinely cannot be its own
  // alternative.
  return seen;
}

/**
 * Classify a candidate by what its own recorded downstream lineage covers, or
 * return `null` where it reaches nothing observed.
 */
function classify(
  graph: MetabolismGraph,
  candidate: PatternDrugRef,
  observed: Set<number>,
): 'sole_capable' | 'contributing' | null {
  const lineage = walk(graph, [candidate], 'metabolites');
  lineage.add(candidate.pubchemCid);

  const covered = [...observed].filter((cid) => lineage.has(cid));

  if (covered.length === 0) return null;
  return covered.length === observed.size ? 'sole_capable' : 'contributing';
}

function nodeFor(graph: MetabolismGraph, pubchemCid: number) {
  return graph.nodes.find((n) => n.drug.pubchemCid === pubchemCid);
}

/**
 * Read through the catalog's own contract rather than a vocabulary invented
 * here.
 *
 * An earlier version admitted a class the catalog does not have
 * (`'administered'`) and excluded only `'metabolite'`, which meant an
 * `endogenous` substance counted as an administered alternative source: a false
 * ambiguity, degrading every source-dependent signal on the case. It also would
 * not have survived Phase 1, where the column returns `drug`. Deferring to
 * `substanceIsAdministered` keeps the two definitions from drifting again, and
 * keeps the unclassified default — `drug`, and so administrable — which is the
 * safe direction: a missing classification may raise an ambiguity that turns
 * out unnecessary, and never suppresses one that is real.
 */
function isAdministrable(substanceClass: SubstanceClass | null | undefined): boolean {
  return substanceIsAdministered(substanceClass);
}
