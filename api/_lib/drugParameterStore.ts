/**
 * Single read/write surface for `drug_parameters` (#302 P2).
 *
 * Replaces the per-column storage on `drugs` for the eight migrated
 * parameters: halfLife, volumeOfDistribution, bioavailability,
 * proteinBinding, bloodPlasmaRatio, tmax, pKa, molecularWeight. The set
 * is identified at runtime by `parameter.group !== null` in the spec
 * registry, so future PRs that register new grouped parameters
 * automatically flow through here without code changes.
 *
 * The API serializer in api/drugs.ts uses these helpers to flatten the
 * row table back onto each drug response (preserving the legacy
 * `drug.<param>` shape that consumers rely on); the parameter PUT and
 * pending-edit approval paths use them to upsert.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { drugParameters } from '../../db/schema.js';
import { getDb } from './db.js';
import {
  DRUG_PARAMETERS,
  isDrugParameterId,
  parameterHasDrugLevelValue,
  type DrugParameterId,
} from '../../src/lib/drugParameters.js';
import {
  withDrugApplicabilityLock,
  parameterWriteBlockedBy,
  ParameterNotApplicableError,
} from './parameterApplicabilityStore.js';

/**
 * Drizzle handle as returned by `getDb()` in api/_lib/db.ts. Co-locating
 * the type alias here avoids cross-file generic widening that surfaces
 * when api callers pass their handle to a function typed against the
 * `db/index.ts` `Db` re-export.
 */
type Db = ReturnType<typeof getDb>;

/**
 * The set of parameter ids stored in `drug_parameters`. Anything with
 * `spec.group !== null` is a "grouped" parameter — i.e. a numeric or
 * tabular value that #302 moves out of monograph prose and into the
 * row table. Metadata (names, aliases, pubchemCid) keeps its dedicated
 * column on `drugs`.
 */
export function isStoredInDrugParameters(parameter: string): parameter is DrugParameterId {
  if (!isDrugParameterId(parameter)) return false;
  // An entry-only parameter (Cmax) carries a group for display but has no
  // drug-level value to store: its values are cited source entries only.
  return (
    DRUG_PARAMETERS[parameter].group !== null &&
    parameterHasDrugLevelValue(parameter)
  );
}

/**
 * Bulk-fetch parameters for many drugs at once. Returns a map keyed by
 * drugId where each entry is a parameter→value map. Used by the list
 * endpoint serializer to avoid an N+1.
 */
export async function getDrugParametersByDrugIds(
  db: Db,
  drugIds: number[],
): Promise<Map<number, Map<string, unknown>>> {
  const out = new Map<number, Map<string, unknown>>();
  if (drugIds.length === 0) return out;

  const rows = await db
    .select({
      drugId: drugParameters.drugId,
      parameter: drugParameters.parameter,
      value: drugParameters.value,
    })
    .from(drugParameters)
    .where(inArray(drugParameters.drugId, drugIds));

  for (const r of rows) {
    let drugMap = out.get(r.drugId);
    if (!drugMap) {
      drugMap = new Map<string, unknown>();
      out.set(r.drugId, drugMap);
    }
    drugMap.set(r.parameter, r.value);
  }
  return out;
}

/**
 * Fetch one drug's parameter map. Returns an empty map when no rows
 * exist — callers should treat missing parameters as `null`.
 */
export async function getDrugParameterMap(
  db: Db,
  drugId: number,
): Promise<Map<string, unknown>> {
  const rows = await db
    .select({
      parameter: drugParameters.parameter,
      value: drugParameters.value,
    })
    .from(drugParameters)
    .where(eq(drugParameters.drugId, drugId));
  return new Map(rows.map((r) => [r.parameter, r.value]));
}

/**
 * Read a single parameter value. `null` means "not stored" (which the
 * serializer renders as the absence of the field). Throws when the
 * parameter is not one routed to `drug_parameters`.
 */
export async function getDrugParameterValue(
  db: Db,
  drugId: number,
  parameter: DrugParameterId,
): Promise<unknown> {
  if (!isStoredInDrugParameters(parameter)) {
    throw new Error(
      `Parameter "${parameter}" is not stored in drug_parameters; read its column on \`drugs\` instead.`,
    );
  }
  const [row] = await db
    .select({ value: drugParameters.value })
    .from(drugParameters)
    .where(
      and(
        eq(drugParameters.drugId, drugId),
        eq(drugParameters.parameter, parameter),
      ),
    )
    .limit(1);
  return row?.value ?? null;
}

/**
 * Upsert one parameter for one drug. Passing `null` deletes the row
 * (the corresponding column would have been set to NULL pre-#302).
 *
 * Every write to `drug_parameters` funnels through here — the parameter PUT,
 * the pending-edit approval path, and the entry-summary recompute — so this is
 * where the not-applicable invariant is enforced. Guarding only the PUT would
 * leave the other two able to publish a value for a pair an editor has marked
 * as an undefined quantity, and the database would then assert both at once.
 * The three callers pre-check so the user gets a specific message; this throw
 * is the backstop that makes the invariant hold rather than being a convention.
 *
 * Clearing a value is always allowed: removing the contradiction must never be
 * blocked by the contradiction.
 */
export async function upsertDrugParameter(
  db: Db,
  drugId: number,
  parameter: DrugParameterId,
  value: unknown,
  updatedBy: number,
): Promise<void> {
  if (!isStoredInDrugParameters(parameter)) {
    throw new Error(
      `Parameter "${parameter}" is not stored in drug_parameters.`,
    );
  }
  if (value === null || value === undefined) {
    await db
      .delete(drugParameters)
      .where(
        and(
          eq(drugParameters.drugId, drugId),
          eq(drugParameters.parameter, parameter),
        ),
      );
    return;
  }

  // Check and write as one locked unit. Reading the guard and then inserting
  // as two separate statements is a race: a marker created in between would
  // land beside the value it forbids. `withDrugApplicabilityLock` opens a
  // transaction when the caller has not, because a transaction-scoped advisory
  // lock taken on the auto-commit client is released the instant its own
  // SELECT returns and serializes nothing — the direct /api/drug-parameter
  // write reaches here outside any transaction, so guarding only the callers
  // that happen to have one would leave that path racing.
  await withDrugApplicabilityLock(drugId, async () => {
    // Re-resolve the client: when the helper opened the transaction, `db` is
    // still the caller's auto-commit handle and the write must go through the
    // transactional one to be covered by the lock.
    const tx = getDb() as Db;
    const blocked = await parameterWriteBlockedBy(tx, drugId, parameter);
    if (blocked) {
      throw new ParameterNotApplicableError(drugId, parameter, blocked);
    }
    await tx
      .insert(drugParameters)
      .values({
        drugId,
        parameter,
        value: value as never,
        updatedBy,
      })
      .onConflictDoUpdate({
        target: [drugParameters.drugId, drugParameters.parameter],
        set: {
          value: value as never,
          updatedBy,
          updatedAt: new Date(),
        },
      });
  });
}

/**
 * Migrated parameter ids whose dedicated column was dropped on `drugs`
 * by 0018. The serializer fills these with `null` when the
 * drug_parameters row is absent so the API response keeps the legacy
 * `drug.halfLife: null`, `drug.molecularWeight: null` shape that the
 * frontend client (`src/lib/drugApi.ts`) types as required nullable
 * fields. Future grouped parameters added by P3 PRs are NOT included
 * here — those start out as undefined-on-absence (consistent with
 * adding a new optional field) until clients are updated.
 */
const MIGRATED_PARAMETER_IDS_NULL_FILL: readonly string[] = [
  'halfLife',
  'volumeOfDistribution',
  'bioavailability',
  'proteinBinding',
  'bloodPlasmaRatio',
  'tmax',
  'pKa',
  'molecularWeight',
];

/**
 * Merge a drug_parameters map onto a drug row so the response keeps the
 * legacy `drug.halfLife`, `drug.molecularWeight`, etc. shape consumers
 * expect. Pass the map produced by getDrugParameterMap or pulled out of
 * getDrugParametersByDrugIds. Missing migrated parameters are filled
 * with `null` to preserve the pre-#302 nullable-column contract.
 */
export function mergeDrugParametersIntoRow<T extends { id: number }>(
  row: T,
  paramMap: Map<string, unknown> | undefined,
): T & Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const id of MIGRATED_PARAMETER_IDS_NULL_FILL) {
    if (!(id in merged)) merged[id] = null;
  }
  if (paramMap) {
    for (const [parameter, value] of paramMap) {
      merged[parameter] = value;
    }
  }
  return merged as T & Record<string, unknown>;
}
