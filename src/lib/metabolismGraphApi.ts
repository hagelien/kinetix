/**
 * Client wrapper for the module-scoped metabolism graph (plan §7.3, §10).
 *
 * Phase 0 handed the engine a fixture graph; this is where the browser gets a
 * real one. The argument is a module id and never the case's analytes — the
 * request URL must not disclose what a case contains (spec §41.1), and a
 * per-analyte fetch could only ask about substances the client already knows,
 * which are exactly not the ones the upstream walk exists to discover.
 */
import { ApiError } from './referenceApi';
import type { LineageEnzymes } from './pattern/lineageEnzymes';
import type { MetabolismGraph } from './pattern/sourceAmbiguity';

/**
 * What one module's fetch answers with: the metabolism neighbourhood the source
 * walk reads, and the enzymes its own substances route through with whatever
 * the catalog says moves them (plan §7.2).
 */
export interface ModuleMetabolism {
  graph: MetabolismGraph;
  enzymes: LineageEnzymes;
}

export async function fetchModuleMetabolismGraph(
  moduleId: string,
  signal?: AbortSignal,
): Promise<ModuleMetabolism> {
  const res = await fetch(`/api/metabolism-graph?module=${encodeURIComponent(moduleId)}`, {
    signal,
  });
  const data: unknown = await res.json();
  if (!res.ok) {
    const body =
      data && typeof data === 'object' ? (data as { error?: unknown; code?: unknown }) : {};
    throw new ApiError(
      typeof body.error === 'string' ? body.error : `Request failed (${res.status})`,
      res.status,
      typeof body.code === 'string' ? body.code : undefined,
    );
  }
  // A malformed body is not an empty graph. An empty graph is a real answer — a
  // module whose substances nobody has entered edges for — and the walk reads it
  // as a neighbourhood with no alternative source in it, which is the one
  // reading that lifts every source degradation. Substituting it for a broken
  // response would clear those degradations on a network fault.
  const graph = (data as { graph?: unknown }).graph;
  if (
    !graph ||
    typeof graph !== 'object' ||
    !Array.isArray((graph as MetabolismGraph).nodes) ||
    !Array.isArray((graph as MetabolismGraph).edges)
  ) {
    throw new ApiError('Malformed metabolism graph', res.status, 'metabolism_graph_malformed');
  }
  // The enzymes are optional in a way the graph is not: an older deployment
  // answers without them, and a case whose module needs no enzyme field is
  // unaffected either way. A field that does need them then finds none, which
  // reads as a lineage routing through nothing — the same answer an unentered
  // elimination route gives, and the one that offers no option rather than a
  // wrong one.
  const enzymes = (data as { enzymes?: unknown }).enzymes;
  return {
    graph: graph as MetabolismGraph,
    enzymes:
      enzymes &&
      typeof enzymes === 'object' &&
      Array.isArray((enzymes as LineageEnzymes).substrates) &&
      Array.isArray((enzymes as LineageEnzymes).modulators)
        ? (enzymes as LineageEnzymes)
        : { substrates: [], modulators: [] },
  };
}

/**
 * The graph for every module a case names, as one graph.
 *
 * A case can span families (Phase 2 unions two modules), and the walk reads one
 * graph — so the alternative to unioning here is a walk that sees only the
 * first module's neighbourhood and finds no alternative source in the rest.
 *
 * Merging is by identity, `drugs.pubchem_cid`, never by slug. Two modules
 * describing the same substance describe it identically — they read one
 * database — so the first reading is kept rather than reconciled.
 */
export async function fetchModulesMetabolismGraph(
  moduleIds: readonly string[],
  signal?: AbortSignal,
): Promise<ModuleMetabolism> {
  const answers = await Promise.all(
    [...new Set(moduleIds)].map((moduleId) => fetchModuleMetabolismGraph(moduleId, signal)),
  );
  const graphs = answers.map((answer) => answer.graph);

  const nodes = new Map<number, MetabolismGraph['nodes'][number]>();
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      if (!nodes.has(node.drug.pubchemCid)) nodes.set(node.drug.pubchemCid, node);
    }
  }

  const edges = new Map<string, MetabolismGraph['edges'][number]>();
  for (const graph of graphs) {
    for (const edge of graph.edges) {
      edges.set(`${edge.from.pubchemCid}->${edge.to.pubchemCid}`, edge);
    }
  }

  // Enzymes union by identity too, and without disagreement to resolve: each
  // module answers about its own substances, so two modules contribute
  // different rows rather than two readings of one. The keys keep a substance
  // that both modules name from offering its enzyme twice.
  const substrates = new Map<string, LineageEnzymes['substrates'][number]>();
  const modulators = new Map<string, LineageEnzymes['modulators'][number]>();
  for (const { enzymes } of answers) {
    for (const substrate of enzymes.substrates) {
      substrates.set(`${substrate.enzymeSlug}:${substrate.drug.pubchemCid}`, substrate);
    }
    for (const modulator of enzymes.modulators) {
      modulators.set(
        `${modulator.enzymeSlug}:${modulator.role}:${modulator.drug.pubchemCid}`,
        modulator,
      );
    }
  }

  return {
    graph: { nodes: [...nodes.values()], edges: [...edges.values()] },
    enzymes: { substrates: [...substrates.values()], modulators: [...modulators.values()] },
  };
}
