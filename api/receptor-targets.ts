/**
 * Receptor-target catalog endpoint.
 *   GET ?q=  — search the catalog by symbol or name for the mechanism editor's
 *              target picker. Read-only and public.
 *
 * #785 Phase 7: this now serves the unified bio_entities registry (entities
 * with the `drug_target` function), mapped to the legacy ReceptorTargetSummary
 * shape so the existing editor keeps working — but the ids are now bio_entity
 * ids, which the flipped store resolves on write.
 */
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { searchBioEntities } from './_lib/bioEntityStore.js';
import type { ReceptorTargetSummary } from '../src/lib/receptorTargets.js';

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
    if (req.method !== 'GET') {
      error(res, 405, 'Method not allowed');
      return;
    }
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );
    const q = url.searchParams.get('q') ?? '';
    const entities = await searchBioEntities(getDb(), q, {
      function: 'drug_target',
      limit: 20,
    });
    const targets: ReceptorTargetSummary[] = entities.map((e) => ({
      id: e.id,
      slug: e.slug,
      symbol: e.symbol,
      name: e.name,
      nameEn: e.nameEn,
      targetClass: e.entityClass,
      organism: e.organism,
    }));
    json(res, 200, { targets });
  },
);
