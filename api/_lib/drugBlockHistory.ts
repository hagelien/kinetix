/**
 * The one place a write to a whole monograph block — metabolism,
 * pharmacodynamics (receptor-target mechanisms) or the PK model structure — is
 * turned into `drug_block_revisions` rows (#37).
 *
 * Every path that mutates those tables wraps its work in
 * {@link withBlockHistory} (or the two-phase {@link beginBlockHistory} when the
 * work spans a long function, as the drug merge does): the blocks in scope are
 * snapshotted before, again after, and every block whose content changed gets
 * one revision. `tests/drug-block-writers.test.ts` pins the list of writers, so
 * a new path that writes these tables without coming through here fails CI
 * rather than leaving a silent gap in the history.
 *
 * Metabolism is a graph: a metabolite link is shown on the parent's box (as a
 * metabolite) AND on the metabolite's box (as a precursor). So the metabolism
 * scope always widens to every drug linked to the drugs in scope, before and
 * after the write — editing a drug's precursors changes its parents' boxes,
 * and they are recorded too.
 */
import { and, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { drugBlockRevisions, drugMetabolites, drugs } from '../../db/schema.js';
import type { getDb } from './db.js';
import {
  canonicalJson,
  metabolismBlockSnapshot,
  modelStructureBlockSnapshot,
  pharmacodynamicsBlockSnapshot,
  recordDrugBlockRevision,
} from './drugBlockRevisions.js';
import { getDrugMetabolism } from './metabolismStore.js';
import { getDrugReceptorTargets } from './receptorTargetStore.js';
import { DRUG_BLOCK_IDS, type DrugBlockId } from '../../src/lib/drugBlocks.js';

type Db = ReturnType<typeof getDb>;

/** One block of one drug as `drug_block_revisions` records it. */
export async function readDrugBlockSnapshot(
  db: Db,
  drugId: number,
  block: DrugBlockId,
): Promise<unknown> {
  switch (block) {
    case 'metabolism':
      return metabolismBlockSnapshot(await getDrugMetabolism(db, drugId));
    case 'pharmacodynamics':
      return pharmacodynamicsBlockSnapshot(await getDrugReceptorTargets(db, drugId));
    case 'modelStructure':
      return modelStructureBlockSnapshot(db, drugId);
  }
}

/** Every drug whose metabolism box shows a link touching one of `drugIds`. */
async function linkedMetabolismDrugIds(db: Db, drugIds: number[]): Promise<number[]> {
  if (drugIds.length === 0) return [];
  const rows = await db
    .select({
      parent: drugMetabolites.parentDrugId,
      metabolite: drugMetabolites.metaboliteDrugId,
    })
    .from(drugMetabolites)
    .where(
      or(
        inArray(drugMetabolites.parentDrugId, drugIds),
        inArray(drugMetabolites.metaboliteDrugId, drugIds),
      ),
    );
  const out = new Set<number>();
  for (const row of rows) {
    out.add(row.parent);
    if (row.metabolite != null) out.add(row.metabolite);
  }
  return [...out];
}

export interface BlockHistoryScope {
  /** The drugs the write targets. Metabolism widens to their linked drugs. */
  drugIds: readonly number[];
  /** The blocks the write can change; all three when omitted. */
  blocks?: readonly DrugBlockId[];
  /** Who made the change; null for an operator script without a user. */
  actorUserId: number | null;
  /** The approved pending edit the write applies, when it is one. */
  pendingEditId?: number | null;
}

const key = (drugId: number, block: DrugBlockId) => `${drugId}:${block}`;

/**
 * Snapshot the blocks in scope now; the returned `record()` snapshots them
 * again and writes one revision per block that changed, returning how many.
 * Call `record()` inside the same transaction as the write when there is one.
 */
export async function beginBlockHistory(db: Db, scope: BlockHistoryScope) {
  const blocks = scope.blocks ?? DRUG_BLOCK_IDS;
  const ids = [...new Set(scope.drugIds)];
  const targets = new Map<DrugBlockId, Set<number>>();
  for (const block of blocks) {
    const drugIdsForBlock = new Set(ids);
    if (block === 'metabolism') {
      for (const id of await linkedMetabolismDrugIds(db, ids)) drugIdsForBlock.add(id);
    }
    targets.set(block, drugIdsForBlock);
  }
  const before = new Map<string, unknown>();
  for (const [block, drugIdsForBlock] of targets) {
    for (const drugId of drugIdsForBlock) {
      before.set(key(drugId, block), await readDrugBlockSnapshot(db, drugId, block));
    }
  }
  // Revisions written inside the scope by a nested recorder (the model
  // structure's recompute hook) are newer than this; see `record()`.
  const [mark] = await db
    .select({ id: sql<number | null>`max(${drugBlockRevisions.id})` })
    .from(drugBlockRevisions);
  const highWater = Number(mark?.id ?? 0);

  return {
    async record(): Promise<number> {
      // A write can add links to drugs that were not linked before.
      const metabolismTargets = targets.get('metabolism');
      if (metabolismTargets) {
        for (const id of await linkedMetabolismDrugIds(db, ids)) metabolismTargets.add(id);
      }
      const all = [...new Set([...targets.values()].flatMap((s) => [...s]))];
      // A drug the write deleted (a merge's loser) has no history left to keep.
      const live = new Set(
        all.length === 0
          ? []
          : (
              await db.select({ id: drugs.id }).from(drugs).where(inArray(drugs.id, all))
            ).map((r) => r.id),
      );
      let recorded = 0;
      for (const [block, drugIdsForBlock] of targets) {
        for (const drugId of drugIdsForBlock) {
          if (!live.has(drugId)) continue;
          const after = await readDrugBlockSnapshot(db, drugId, block);
          // Already recorded inside this scope (e.g. by the recompute hook)?
          const [nested] = await db
            .select({ newValue: drugBlockRevisions.newValue })
            .from(drugBlockRevisions)
            .where(
              and(
                eq(drugBlockRevisions.drugId, drugId),
                eq(drugBlockRevisions.block, block),
                gt(drugBlockRevisions.id, highWater),
              ),
            )
            .orderBy(desc(drugBlockRevisions.id))
            .limit(1);
          if (nested && canonicalJson(nested.newValue) === canonicalJson(after)) continue;
          const k = key(drugId, block);
          // A drug linked only by this write was not snapshotted before it;
          // its last recorded state is the best "before" there is (NULL when
          // nothing was ever recorded, which the history shows as such).
          const oldValue = before.has(k)
            ? before.get(k)
            : await latestRecordedSnapshot(db, drugId, block);
          const id = await recordDrugBlockRevision(db, {
            drugId,
            block,
            oldValue,
            newValue: after,
            createdBy: scope.actorUserId,
            pendingEditId: scope.pendingEditId ?? null,
          });
          if (id != null) recorded += 1;
        }
      }
      return recorded;
    },
  };
}

async function latestRecordedSnapshot(
  db: Db,
  drugId: number,
  block: DrugBlockId,
): Promise<unknown> {
  const [latest] = await db
    .select({ newValue: drugBlockRevisions.newValue })
    .from(drugBlockRevisions)
    .where(and(eq(drugBlockRevisions.drugId, drugId), eq(drugBlockRevisions.block, block)))
    .orderBy(desc(drugBlockRevisions.createdAt), desc(drugBlockRevisions.id))
    .limit(1);
  return latest?.newValue ?? null;
}

/**
 * The other drugs a metabolism write names: its metabolites' and precursors'
 * own drugs. Their boxes show the links too, so they belong in the scope from
 * the start (a link to a drug that was not linked before has no "before"
 * otherwise).
 */
export function metabolismInputLinkedDrugIds(input: {
  metabolites: ReadonlyArray<{ metaboliteDrugId?: number | null }>;
  precursors: ReadonlyArray<{ precursorDrugId: number }>;
}): number[] {
  return [
    ...input.metabolites.flatMap((m) => (m.metaboliteDrugId != null ? [m.metaboliteDrugId] : [])),
    ...input.precursors.map((p) => p.precursorDrugId),
  ];
}

/** Run `fn` and record every block in scope that it changed. */
export async function withBlockHistory<T>(
  db: Db,
  scope: BlockHistoryScope,
  fn: () => Promise<T>,
): Promise<T> {
  const history = await beginBlockHistory(db, scope);
  const result = await fn();
  await history.record();
  return result;
}
