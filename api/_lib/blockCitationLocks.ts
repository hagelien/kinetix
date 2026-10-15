/** Incoming block references join the entry writers' citation-membership protocol. */
import { inArray } from 'drizzle-orm';
import { citations } from '../../db/schema.js';
import { isInPoolTransaction, type getDb } from './db.js';
import { ParameterApplyError } from './drugs-helpers.js';
import { lockCitationMembershipsShared } from './parameter-entries-store.js';

type Db = ReturnType<typeof getDb>;

/** Only referenceIds are citations; drug/entity ids in the same payload are not. */
export function blockReferenceIds(value: unknown): number[] {
  const ids = new Set<number>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
    } else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (key === 'referenceIds' && Array.isArray(child)) {
          for (const id of child) {
            if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ids.add(id);
          }
        } else visit(child);
      }
    }
  };
  visit(value);
  return [...ids].sort((a, b) => a - b);
}

/**
 * After graph/drug keys, BEFORE snapshots or any child/pending-edit row lock.
 * A fold tries these keys exclusively, including when no committed block yet
 * cites the paper. Re-read existence after waiting: the fold may have won and
 * deleted a formerly valid id. Refuse the stale write so it cannot recreate a
 * dangling array or history. The stores repeat this for standalone callers.
 */
export async function lockBlockCitationIds(db: Db, citationIds: Iterable<number>): Promise<void> {
  const ids = [...new Set(citationIds)].sort((a, b) => a - b);
  if (ids.length === 0) return;
  if (!isInPoolTransaction()) {
    throw new Error('Block citation locks must run inside the block write transaction');
  }
  await lockCitationMembershipsShared(ids);
  const found = new Set((await db.select({ id: citations.id }).from(citations)
    .where(inArray(citations.id, ids))).map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    throw new ParameterApplyError(
      `Reference(s) no longer exist: ${missing.join(', ')}. Reload and retry.`,
      400,
      'block_reference_missing',
    );
  }
}

export async function lockBlockCitationReferences(db: Db, payload: unknown): Promise<void> {
  await lockBlockCitationIds(db, blockReferenceIds(payload));
}
