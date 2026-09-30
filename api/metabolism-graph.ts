/**
 * Module-scoped metabolism graph (plan §7.3, §10; spec §35).
 *
 *   GET ?module=<id>  — the transitive metabolism neighbourhood of that
 *                       module's substances, in both directions
 *
 * Scoped to a module rather than to a case's analytes on purpose. Naming the
 * analytes in the URL would disclose the case's content to the server, which
 * spec §41.1 prohibits; and a per-drug fetch could only ask about substances
 * the client already knows, which are precisely not the ones the upstream walk
 * exists to discover.
 *
 * Public, like the rest of the catalog it is a projection of: it says which
 * substances metabolise into which, and carries nothing about any case.
 */
import type { ServerResponse } from 'node:http';

import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { getLineageEnzymes, getModuleMetabolismGraph } from './_lib/metabolismGraphStore.js';
import {
  moduleSubstanceCids,
  patternModuleById,
} from '../src/lib/pattern/modules/index.js';

export default withErrorHandling(async function handler(req, res): Promise<void> {
  if (req.method !== 'GET') {
    error(res, 405, 'Method not allowed', 'metabolism_graph_method_not_allowed');
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const moduleId = url.searchParams.get('module');
  if (!moduleId) {
    error(res, 400, 'Missing module', 'metabolism_graph_missing_module');
    return;
  }

  const module = patternModuleById(moduleId);
  if (!module) {
    // A named module that does not exist is a client bug, not an empty graph:
    // answering `{nodes: [], edges: []}` would let a typo read as "this family
    // has no metabolism", which the walk would resolve as an uncurated graph
    // rather than as the missing module it is.
    error(res, 404, `No module ${moduleId}`, 'metabolism_graph_unknown_module');
    return;
  }

  return handleGet(res, moduleSubstanceCids(module));
});

async function handleGet(res: ServerResponse, seedCids: number[]): Promise<void> {
  const db = getDb();
  // The enzymes the module's own substances route through, and what the catalog
  // says moves them — the two facts an enzyme-derived context field and its
  // generated co-medication options are built from (plan §7.2). Answered here
  // rather than by a second endpoint because they are scoped by the same module
  // id, for the same privacy reason, and a screen that has one without the
  // other can only offer options for a field it cannot decide to show.
  const [graph, enzymes] = await Promise.all([
    getModuleMetabolismGraph(db, seedCids),
    getLineageEnzymes(db, seedCids),
  ]);
  json(res, 200, { graph, enzymes });
}
