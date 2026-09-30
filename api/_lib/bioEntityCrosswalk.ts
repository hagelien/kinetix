import { and, eq, inArray } from 'drizzle-orm';
import { bioEntityIdMap } from '../../db/schema.js';
import type { getDb } from './db.js';

type Db = ReturnType<typeof getDb>;

/** Source registries recorded in the transitional crosswalk (#785). */
export type BioEntitySource = 'enzyme' | 'receptor_target';

/**
 * Resolve legacy catalog ids to their unified `bio_entities` ids via the Phase 1
 * crosswalk, batched into a single query. Used by the edge-table stores to
 * dual-write `bio_entity_id` alongside the legacy FK during the transition
 * (#785 Phase 2). Ids without a crosswalk row (e.g. a catalog target created
 * after the backfill) are simply absent from the returned map — the caller
 * stores null and a later phase reconciles them.
 */
export async function bioEntityIdsForSource(
  db: Db,
  source: BioEntitySource,
  sourceIds: ReadonlyArray<number>,
): Promise<Map<number, number>> {
  const ids = [...new Set(sourceIds.filter((n) => Number.isInteger(n)))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      sourceId: bioEntityIdMap.sourceId,
      entityId: bioEntityIdMap.entityId,
    })
    .from(bioEntityIdMap)
    .where(
      and(eq(bioEntityIdMap.source, source), inArray(bioEntityIdMap.sourceId, ids)),
    );
  return new Map(rows.map((r) => [r.sourceId, r.entityId]));
}
