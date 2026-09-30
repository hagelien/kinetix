/**
 * Enzyme catalog endpoint (read-only typeahead).
 *   GET — typeahead (`?q=&limit=`) or full list (`?view=all`) over the canonical
 *         metabolic-enzyme catalog, served from the unified bio_entities registry
 *         filtered to the `metabolic_enzyme` function. Public.
 *
 * #791 Part B step 6: the legacy `enzymes` table and its admin CRUD were removed.
 * The enzyme catalog is edited through the bio_entities admin (`/api/bio-entities`);
 * this shim stays only so the existing metabolism editor's typeahead keeps
 * resolving bio_entity ids under the legacy MetabolismEnzyme shape.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import {
  listBioEntitiesByFunction,
  searchBioEntities,
} from './_lib/bioEntityStore.js';
import type { BioEntitySummary } from '../src/lib/bioEntities.js';
import type { MetabolismEnzyme } from '../src/lib/metabolism.js';

// The enzyme catalog is the unified bio_entities registry filtered to the
// `metabolic_enzyme` function, mapped to the legacy MetabolismEnzyme shape so
// the existing metabolism editor keeps working with bio_entity ids.
function toEnzyme(e: BioEntitySummary): MetabolismEnzyme {
  return {
    id: e.id,
    slug: e.slug,
    symbol: e.symbol,
    name: e.name,
    nameEn: e.nameEn,
    enzymeClass: e.entityClass,
    rank: e.rank,
  };
}

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
    if (req.method !== 'GET') {
      error(res, 405, 'Method not allowed');
      return;
    }
    return handleGet(req, res);
  },
);

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  );
  if (url.searchParams.get('view') === 'all') {
    const enzymes = (
      await listBioEntitiesByFunction(getDb(), 'metabolic_enzyme')
    ).map(toEnzyme);
    json(res, 200, { enzymes });
    return;
  }
  const q = url.searchParams.get('q') ?? '';
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 10;
  const entities = await searchBioEntities(getDb(), q, {
    function: 'metabolic_enzyme',
    // Also surface family/subfamily/superfamily groups so a route can be
    // annotated at the family level when the specific gene is unknown.
    includeFunctionAncestors: true,
    limit,
  });
  json(res, 200, { enzymes: entities.map(toEnzyme) });
}
