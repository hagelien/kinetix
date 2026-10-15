/**
 * Revision history for the whole-block parts of a monograph (#37): metabolism,
 * pharmacodynamics (receptor-target mechanisms) and the PK model structure.
 *
 * Each write to one of these blocks records a `drug_block_revisions` row with
 * a snapshot of the block before and after. The snapshots are content only:
 * row ids and sort indexes are dropped, because the metabolism and mechanism
 * stores replace their rows wholesale on every save, so a re-save of identical
 * content would otherwise read as a change. An unchanged snapshot records
 * nothing.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { drugBlockRevisions, parameterEntries } from '../../db/schema.js';
import type { getDb } from './db.js';
import type { DrugBlockId } from '../../src/lib/drugBlocks.js';
import { MODEL_STRUCTURE_PARAMETER_IDS } from '../../src/lib/drugParameters.js';
import type { DrugMetabolism } from '../../src/lib/metabolism.js';
import type { DrugReceptorTargetSummary } from '../../src/lib/receptorTargets.js';

type Db = ReturnType<typeof getDb>;

/** Drop the per-row identity fields a wholesale replace re-mints. */
function withoutRowIdentity<T extends object>(
  row: T,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
}

export interface MetabolismBlockSnapshot {
  evidenceNote: string | null;
  routes: Record<string, unknown>[];
  metabolites: Record<string, unknown>[];
  precursors: Record<string, unknown>[];
}

/** The metabolism box as a content snapshot; an empty box is empty lists. */
export function metabolismBlockSnapshot(
  metabolism: DrugMetabolism | null,
): MetabolismBlockSnapshot {
  const strip = (row: object) => withoutRowIdentity(row, ['id', 'sortOrder']);
  return {
    evidenceNote: metabolism?.evidenceNote ?? null,
    routes: (metabolism?.routes ?? []).map(strip),
    metabolites: (metabolism?.metabolites ?? []).map(strip),
    precursors: (metabolism?.precursors ?? []).map(strip),
  };
}

export interface PharmacodynamicsBlockSnapshot {
  mechanisms: Record<string, unknown>[];
}

/** The drug's receptor-target mechanisms, in stored order, as a snapshot. */
export function pharmacodynamicsBlockSnapshot(
  targets: DrugReceptorTargetSummary[],
): PharmacodynamicsBlockSnapshot {
  return {
    mechanisms: targets.map((row) => withoutRowIdentity(row, ['id', 'drugId'])),
  };
}

export interface ModelStructureBlockSnapshot {
  declarations: Array<{
    parameter: string;
    categoricalValue: string | null;
    route: string | null;
    citationId: number | null;
    sourceQuote: string | null;
  }>;
}

/** Every model-structure declaration of the drug, in a stable order. */
export async function modelStructureBlockSnapshot(
  db: Db,
  drugId: number,
): Promise<ModelStructureBlockSnapshot> {
  const rows = await db
    .select({
      parameter: parameterEntries.parameter,
      categoricalValue: parameterEntries.categoricalValue,
      route: parameterEntries.route,
      citationId: parameterEntries.citationId,
      sourceQuote: parameterEntries.sourceQuote,
    })
    .from(parameterEntries)
    .where(
      and(
        eq(parameterEntries.drugId, drugId),
        inArray(parameterEntries.parameter, MODEL_STRUCTURE_PARAMETER_IDS),
      ),
    );
  // Sorted in JS on the content itself, so the order cannot depend on row ids.
  const declarations = rows
    .map((row) => ({
      parameter: row.parameter,
      categoricalValue: row.categoricalValue ?? null,
      route: row.route ?? null,
      citationId: row.citationId ?? null,
      sourceQuote: row.sourceQuote ?? null,
    }))
    .sort((a, b) =>
      canonicalJson(a) < canonicalJson(b)
        ? -1
        : canonicalJson(a) > canonicalJson(b)
          ? 1
          : 0,
    );
  return { declarations };
}

/**
 * JSON with object keys sorted at every level. jsonb does not keep key order,
 * so a snapshot read back from the table and one built in memory compare
 * equal only in this form.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * Record one change to a block. Returns the revision id, or null when the
 * snapshot did not change (a re-save of the same content).
 */
export async function recordDrugBlockRevision(
  db: Db,
  args: {
    drugId: number;
    block: DrugBlockId;
    /** The state before the change; null when it was never recorded. */
    oldValue: unknown;
    newValue: unknown;
    createdBy: number;
    pendingEditId?: number | null;
  },
): Promise<number | null> {
  if (
    args.oldValue != null &&
    canonicalJson(args.oldValue) === canonicalJson(args.newValue)
  ) {
    return null;
  }
  const [row] = await db
    .insert(drugBlockRevisions)
    .values({
      drugId: args.drugId,
      block: args.block,
      oldValue: (args.oldValue ?? null) as never,
      newValue: args.newValue as never,
      createdBy: args.createdBy,
      pendingEditId: args.pendingEditId ?? null,
    })
    .returning({ id: drugBlockRevisions.id });
  return row?.id ?? null;
}

/**
 * Record the model structure's current state after a declaration was written.
 *
 * Model-structure declarations are written through several paths (the entry
 * endpoint, an approved `param_entry` edit, conversation ingestion), all of
 * which meet in the parameter recompute — after the write. So the "before" is
 * the previous revision's "after"; when there is none, the prior state was
 * never recorded and `oldValue` stays NULL rather than claiming the block was
 * empty.
 */
export async function recordModelStructureRevision(
  db: Db,
  drugId: number,
  actorUserId: number,
  pendingEditId: number | null = null,
): Promise<number | null> {
  const next = await modelStructureBlockSnapshot(db, drugId);
  const [latest] = await db
    .select({ newValue: drugBlockRevisions.newValue })
    .from(drugBlockRevisions)
    .where(
      and(
        eq(drugBlockRevisions.drugId, drugId),
        eq(drugBlockRevisions.block, 'modelStructure'),
      ),
    )
    .orderBy(desc(drugBlockRevisions.createdAt), desc(drugBlockRevisions.id))
    .limit(1);
  return recordDrugBlockRevision(db, {
    drugId,
    block: 'modelStructure',
    oldValue: latest?.newValue ?? null,
    newValue: next,
    createdBy: actorUserId,
    pendingEditId,
  });
}
