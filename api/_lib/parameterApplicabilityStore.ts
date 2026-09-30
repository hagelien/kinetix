/**
 * Read/write surface for `drug_parameter_applicability` — the pair-level
 * "this quantity does not exist for this substance" marker.
 *
 * The rule this table serves, and why it is separate from a missing value, is
 * documented in src/lib/parameterApplicability.ts.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drugParameterApplicability, drugs } from '../../db/schema.js';
import { getDb, inTransaction, isInPoolTransaction } from './db.js';
import type { DrugParameterId } from '../../src/lib/drugParameters.js';
import {
  isApplicabilityStatus,
  parameterAppliesToSubstanceClass,
} from '../../src/lib/parameterApplicability.js';

type Db = ReturnType<typeof getDb>;

/**
 * Thrown when a write would store a value for a pair an editor has marked as
 * not a defined quantity. Its own class (rather than a generic Error) so the
 * three call sites that can surface it to a user — the parameter PUT, the
 * approval path and the entry endpoint — can map it to a 409 with a stable
 * code instead of a 500.
 */
export class ParameterNotApplicableError extends Error {
  readonly code = 'parameter_not_applicable';
  constructor(
    drugId: number,
    parameter: string,
    reason: 'not_applicable_marker' | 'substance_class',
  ) {
    super(
      reason === 'substance_class'
        ? `Parameter "${parameter}" is not a defined quantity for drug ${drugId}: the substance is not administered, so it has no dose whose fate this parameter could describe. Correct the drug's substanceClass if the classification is wrong.`
        : `Parameter "${parameter}" is marked not applicable for drug ${drugId}; lift the marker via /api/drug-parameter-applicability before storing a value.`,
    );
    this.name = 'ParameterNotApplicableError';
  }
}

export interface ApplicabilityRow {
  drugId: number;
  parameter: string;
  status: string;
  reason: string;
  setBy: number | null;
  updatedAt: Date;
}

/** Every marker on one drug, parameter-ascending for a stable response. */
export async function listApplicabilityForDrug(
  db: Db,
  drugId: number,
): Promise<ApplicabilityRow[]> {
  return db
    .select({
      drugId: drugParameterApplicability.drugId,
      parameter: drugParameterApplicability.parameter,
      status: drugParameterApplicability.status,
      reason: drugParameterApplicability.reason,
      setBy: drugParameterApplicability.setBy,
      updatedAt: drugParameterApplicability.updatedAt,
    })
    .from(drugParameterApplicability)
    .where(eq(drugParameterApplicability.drugId, drugId))
    .orderBy(drugParameterApplicability.parameter);
}

/**
 * Whether a specific pair is marked not-applicable. The hot path for the
 * write guard on PUT /api/drug-parameter, so it selects one column only.
 */
export async function isMarkedNotApplicable(
  db: Db,
  drugId: number,
  parameter: string,
): Promise<boolean> {
  const [row] = await db
    .select({ status: drugParameterApplicability.status })
    .from(drugParameterApplicability)
    .where(
      and(
        eq(drugParameterApplicability.drugId, drugId),
        eq(drugParameterApplicability.parameter, parameter),
      ),
    )
    .limit(1);
  return isApplicabilityStatus(row?.status);
}

/**
 * Why a value may not be stored for this pair, or `null` when it may.
 *
 * Both permanent layers of the applicability model bind writes, not just the
 * explicit marker: a substance classified as an analyte has no bioavailability
 * whether or not anyone has written the marker row down, so publishing one
 * would leave the queue calling the pair impossible while the monograph serves
 * a number for it. Enforcing only the marker would make the class rule a
 * queue-display convention rather than a fact about the data.
 *
 * The **absent cooldown is deliberately not a write barrier.** It records that
 * a search came back empty, not that the quantity cannot exist — someone who
 * has now found a source should be able to store it immediately, and doing so
 * is the outcome the cooldown is waiting for.
 *
 * One query for both layers: this sits on every parameter write.
 */
/**
 * Serialize everything that could contradict the applicability invariant for
 * one drug.
 *
 * Both directions are check-then-write: the marker endpoint reads "does a
 * value exist?" then inserts the marker, while a parameter write reads "is
 * this pair blocked?" then inserts the value. Run concurrently, both reads can
 * see no conflict and both writes can commit, leaving a marker beside the live
 * value it forbids.
 *
 * This is the same per-drug advisory lock `parameter-entries-store` already
 * takes for recompute (`pg_advisory_xact_lock(drugId)`), deliberately reused
 * rather than adding a second lock id: one lock per drug, always acquired
 * first, is what keeps these paths from deadlocking against each other or
 * against a recompute. It is re-entrant within a transaction, so a path that
 * already holds it pays nothing.
 *
 * Transaction-scoped, so it only serializes callers running inside
 * `runInPoolTransaction` — which every parameter write path does.
 */
async function lockDrugForApplicability(db: Db, drugId: number): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(${drugId}::bigint)`);
}

/**
 * Take the per-drug applicability lock inside a transaction the caller already
 * has. For paths that write something *other* than a `drug_parameters` row —
 * a `parameter_entries` row, say — and so cannot go through
 * {@link withDrugApplicabilityLock}, but still need their check and their
 * write to be one unit.
 *
 * Callers must already be inside `runInPoolTransaction`; the lock is
 * transaction-scoped and would release immediately otherwise. Throwing rather
 * than silently doing nothing is deliberate — a lock that quietly serializes
 * nothing is how the first attempt at this failed review.
 */
export async function lockDrugForEntryApplicability(
  drugId: number,
): Promise<void> {
  if (!isInPoolTransaction()) {
    throw new Error(
      'lockDrugForEntryApplicability must be called inside runInPoolTransaction; ' +
        'a transaction-scoped advisory lock taken on the auto-commit client serializes nothing.',
    );
  }
  await lockDrugForApplicability(getDb(), drugId);
}

/**
 * Run a check-then-write about this drug's applicability while holding the
 * per-drug lock, opening a transaction if the caller has not already.
 *
 * The lock is transaction-scoped, so on the auto-commit client it is released
 * as soon as its own `SELECT` returns — taking it there looks like
 * serialization and provides none. `parameter-entries-store` documents the
 * same trap ("a lock on the base auto-commit client releases immediately").
 * Rather than requiring every call site to remember a transaction, this makes
 * the guarded write serialized *by construction*: a caller already inside
 * `runInPoolTransaction` joins it and pays nothing, and one that is not gets a
 * transaction of its own.
 *
 * Callers that need several parameters covered by one lock should wrap the
 * whole unit in `runInPoolTransaction` themselves; the lock is re-entrant, so
 * the inner acquisitions are free.
 */
export async function withDrugApplicabilityLock<T>(
  drugId: number,
  fn: () => Promise<T>,
): Promise<T> {
  return inTransaction(async () => {
    await lockDrugForApplicability(getDb(), drugId);
    return fn();
  });
}

export async function parameterWriteBlockedBy(
  db: Db,
  drugId: number,
  parameter: string,
): Promise<'not_applicable_marker' | 'substance_class' | null> {
  const [row] = await db
    .select({
      substanceClass: drugs.substanceClass,
      markerStatus: drugParameterApplicability.status,
    })
    .from(drugs)
    .leftJoin(
      drugParameterApplicability,
      and(
        eq(drugParameterApplicability.drugId, drugs.id),
        eq(drugParameterApplicability.parameter, parameter),
      ),
    )
    .where(eq(drugs.id, drugId))
    .limit(1);

  // No drug row: not this guard's business. The FK on drug_parameters, or the
  // caller's own 404, is the right failure for a nonexistent target.
  if (!row) return null;

  if (isApplicabilityStatus(row.markerStatus)) return 'not_applicable_marker';
  if (!parameterAppliesToSubstanceClass(parameter, row.substanceClass)) {
    return 'substance_class';
  }
  return null;
}

/**
 * Which of these parameters may not be given a value on this drug, by either
 * permanent layer. The bulk form of {@link parameterWriteBlockedBy}, for
 * callers holding a whole bag of parameters — one query rather than one per
 * parameter, and it lets the caller name every offender at once instead of
 * failing on the first.
 */
export async function blockedParametersFor(
  db: Db,
  drugId: number,
  parameters: string[],
): Promise<string[]> {
  if (parameters.length === 0) return [];
  const [drug] = await db
    .select({ substanceClass: drugs.substanceClass })
    .from(drugs)
    .where(eq(drugs.id, drugId))
    .limit(1);
  if (!drug) return [];
  const marked = await markedNotApplicableAmong(db, drugId, parameters);
  return parameters.filter(
    (p) =>
      marked.has(p) || !parameterAppliesToSubstanceClass(p, drug.substanceClass),
  );
}

/**
 * Bulk lookup for a set of parameters on one drug. Returns the marked subset
 * so callers can filter a candidate list without an N+1.
 */
export async function markedNotApplicableAmong(
  db: Db,
  drugId: number,
  parameters: string[],
): Promise<Set<string>> {
  if (parameters.length === 0) return new Set();
  const rows = await db
    .select({
      parameter: drugParameterApplicability.parameter,
      status: drugParameterApplicability.status,
    })
    .from(drugParameterApplicability)
    .where(
      and(
        eq(drugParameterApplicability.drugId, drugId),
        inArray(drugParameterApplicability.parameter, parameters),
      ),
    );
  return new Set(
    rows.filter((r) => isApplicabilityStatus(r.status)).map((r) => r.parameter),
  );
}

/** Create or update the marker for one pair. */
export async function upsertApplicability(
  db: Db,
  input: {
    drugId: number;
    parameter: DrugParameterId;
    status: string;
    reason: string;
    setBy: number;
  },
): Promise<ApplicabilityRow> {
  const [row] = await db
    .insert(drugParameterApplicability)
    .values({
      drugId: input.drugId,
      parameter: input.parameter,
      status: input.status,
      reason: input.reason,
      setBy: input.setBy,
    })
    .onConflictDoUpdate({
      target: [
        drugParameterApplicability.drugId,
        drugParameterApplicability.parameter,
      ],
      set: {
        status: input.status,
        reason: input.reason,
        setBy: input.setBy,
        updatedAt: new Date(),
      },
    })
    .returning({
      drugId: drugParameterApplicability.drugId,
      parameter: drugParameterApplicability.parameter,
      status: drugParameterApplicability.status,
      reason: drugParameterApplicability.reason,
      setBy: drugParameterApplicability.setBy,
      updatedAt: drugParameterApplicability.updatedAt,
    });
  if (!row) throw new Error('drug_parameter_applicability upsert returned no row');
  return row;
}

/** Lift the marker. Returns false when there was nothing to lift. */
export async function deleteApplicability(
  db: Db,
  drugId: number,
  parameter: string,
): Promise<boolean> {
  const deleted = await db
    .delete(drugParameterApplicability)
    .where(
      and(
        eq(drugParameterApplicability.drugId, drugId),
        eq(drugParameterApplicability.parameter, parameter),
      ),
    )
    .returning({ parameter: drugParameterApplicability.parameter });
  return deleted.length > 0;
}
