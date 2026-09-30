/**
 * The one locking primitive every writer of a `param_entry` pending payload
 * goes through (Cmax release B, #1340; RFC *Owner review of the locking
 * design*, amendments 2–6).
 *
 * A `param_entry` payload can name drugs in two places the database cannot
 * police: the entry's owning drug (the outer `target_id` for a create, the
 * target entry's `drug_id` for an update or delete) and, from release C on,
 * the dose context's `administeredDrugId` / `interactingDrugId` nested in the
 * JSON. A drug delete or merge that commits while a proposal naming one of
 * them is being written would leave that proposal pointing at a drug that no
 * longer exists — JSON has no foreign key. Scanning the payloads at delete or
 * merge time narrows that window; only a lock closes it.
 *
 * The protocol, in this order and never another (amendment 3):
 *
 *   1. derive the effective post-write payload (the caller's job),
 *   2. resolve the owning drug for the op,
 *   3. take the per-drug advisory lock on the sorted, de-duplicated union of
 *      owner + nested ids — every advisory lock before ANY row lock
 *      (amendment 6), ascending, as `drug-merge.ts` does for its pair,
 *   4. for an update/delete, re-read the target entry and refuse if it is gone
 *      or now belongs to a drug outside the locked set,
 *   5. re-read every referenced drug row and refuse if one is gone — a lock is
 *      taken on a number and proves ordering, not existence,
 *   6. only then run the write.
 *
 * With every drug delete and merge taking the same advisory locks, the two
 * outcomes are exhaustive: the author commits first and the removal then sees
 * (and repoints or refuses on) the proposal, or the removal commits first and
 * the author's re-read refuses the write.
 *
 * `inTransaction`, never `runInPoolTransaction` (amendment 4): a nested pool
 * transaction is a second connection, and one that asks for an advisory lock
 * its caller's connection already holds waits on it forever. Joining the
 * ambient transaction keeps the locks, the re-reads and the write on one
 * connection.
 */
import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import { drugs, parameterEntries } from '../../db/schema.js';
import { getDb, inTransaction } from './db.js';
import { lockDrugForEntryApplicability } from './parameterApplicabilityStore.js';

import { ACTIVE_PENDING_EDIT_STATUSES } from './pending-edit-statuses.js';

export { ACTIVE_PENDING_EDIT_STATUSES };

/** The dose-context keys inside a `param_entry` payload that name a drug. */
export const NESTED_DRUG_REF_KEYS = ['administeredDrugId', 'interactingDrugId'] as const;

type ParamEntryOp = 'create' | 'update' | 'delete';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A `param_entry` payload's op and body (`input` for a create, `patch` for an update). */
export function paramEntryPayloadParts(
  proposedValue: unknown,
): { op: ParamEntryOp; body: Record<string, unknown> | null } | null {
  if (!isRecord(proposedValue)) return null;
  const op = proposedValue.op;
  if (op === 'create') {
    return { op, body: isRecord(proposedValue.input) ? proposedValue.input : null };
  }
  if (op === 'update') {
    return { op, body: isRecord(proposedValue.patch) ? proposedValue.patch : null };
  }
  if (op === 'delete') return { op, body: null };
  return null;
}

/** The drug ids a payload names in its dose context, unsorted, possibly repeated. */
export function nestedDrugIdsOf(proposedValue: unknown): number[] {
  const parts = paramEntryPayloadParts(proposedValue);
  if (!parts?.body) return [];
  const ids: number[] = [];
  for (const key of NESTED_DRUG_REF_KEYS) {
    const value = parts.body[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      ids.push(value);
    }
  }
  return ids;
}

/**
 * The owning drug of a `param_entry` proposal, resolved per op (RFC: "the
 * owning drug has to be resolved per operation, not read off `targetId`"):
 * a create's target IS the drug; an update's or delete's is an ENTRY, whose
 * drug has to be read. An unlocked read — step 4 re-checks it under the lock.
 */
export async function owningDrugOfParamEntry(
  op: ParamEntryOp,
  targetId: number,
): Promise<number | null> {
  if (op === 'create') return targetId;
  const [row] = await getDb()
    .select({ drugId: parameterEntries.drugId })
    .from(parameterEntries)
    .where(eq(parameterEntries.id, targetId))
    .limit(1);
  return row?.drugId ?? null;
}

/** The sorted, de-duplicated advisory-lock set for a proposal. */
export function paramEntryLockSet(owner: number | null, proposedValue: unknown): number[] {
  const ids = new Set<number>(nestedDrugIdsOf(proposedValue));
  if (owner != null) ids.add(owner);
  return [...ids].sort((a, b) => a - b);
}

export type ParamEntryLockRefusal =
  | { refused: 'target_missing' }
  | { refused: 'target_moved' }
  | { refused: 'drug_missing'; drugId: number };

export type ParamEntryLockedResult<T> = { refused: null; value: T } | ParamEntryLockRefusal;

/**
 * Run `write` under the protocol above for a `param_entry` payload, returning
 * its value, or the refusal that stopped it before anything was written.
 *
 * `targetId` is the pending row's outer target (a drug for a create, an entry
 * for an update/delete); `proposedValue` is the payload as it will be stored
 * AFTER the write — the new one for a revision, not the old.
 */
export async function withParamEntryPayloadLocks<T>(
  args: { op: ParamEntryOp; targetId: number; proposedValue: unknown },
  write: () => Promise<T>,
): Promise<ParamEntryLockedResult<T>> {
  return inTransaction(async () => {
    const owner = await owningDrugOfParamEntry(args.op, args.targetId);
    if (owner == null) return { refused: 'target_missing' } as const;
    const lockIds = paramEntryLockSet(owner, args.proposedValue);
    for (const drugId of lockIds) {
      await lockDrugForEntryApplicability(drugId);
    }
    const db = getDb();

    if (args.op !== 'create') {
      const [entry] = await db
        .select({ drugId: parameterEntries.drugId })
        .from(parameterEntries)
        .where(eq(parameterEntries.id, args.targetId))
        .limit(1);
      if (!entry) return { refused: 'target_missing' } as const;
      // A merge moved the entry between the unlocked owner read and the lock:
      // the lock we hold is on a drug that no longer owns it. Refuse rather
      // than re-lock out of order — see `assertLockedEntryOwner`.
      if (!lockIds.includes(entry.drugId)) return { refused: 'target_moved' } as const;
    }

    const present = new Set(
      (
        await db
          .select({ id: drugs.id })
          .from(drugs)
          .where(inArray(drugs.id, lockIds))
      ).map((row) => row.id),
    );
    const missing = lockIds.find((id) => !present.has(id));
    if (missing !== undefined) {
      return { refused: 'drug_missing', drugId: missing } as const;
    }

    return { refused: null, value: await write() };
  });
}

/**
 * SQL: the `pending_edits` row aliased `pe` is an ACTIVE `param_entry`
 * proposal whose dose context names `drugId` — in a create's `input` or an
 * update's `patch`, as administered or interacting drug. For the drug delete,
 * which must not leave such a proposal naming a drug that no longer exists.
 */
export function activeProposalNestsDrug(drugId: number): SQL {
  const refs = (['input', 'patch'] as const).flatMap((body) =>
    NESTED_DRUG_REF_KEYS.map((key) => {
      const path = `{${body},${key}}`;
      return sql`(jsonb_typeof(pe.proposed_value #> ${path}::text[]) = 'number'
        AND (pe.proposed_value #>> ${path}::text[])::int = ${drugId})`;
    }),
  );
  return sql`(pe.edit_type = 'param_entry'
    AND pe.status IN ${sql.raw(`('${ACTIVE_PENDING_EDIT_STATUSES.join("', '")}')`)}
    AND (${sql.join(refs, sql` OR `)}))`;
}
