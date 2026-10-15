/**
 * Lineage of drug merges (#29): what a merge moved, and where the survivor's
 * `source_diff` "previous revision" continues from afterwards.
 *
 * A merge repoints the loser's `drug_parameter_revisions` onto the survivor,
 * keeping their ids, then deletes the loser. Two formerly independent
 * histories become one `(drug, parameter)` stream, interleaved by id.
 * `drug_merge_events` (migration 0152) records each merge so that stream can
 * still be taken apart:
 *
 *   - "Which revisions on S came from L, and when?" —
 *     `SELECT parameter_revision_ids, merged_at FROM drug_merge_events
 *      WHERE survivor_drug_id = S AND loser_drug_id = L`.
 *   - "Which drug was revision X on when revision R was written?" —
 *     {@link drugAtSql}.
 *
 * ## The previous-revision rule
 *
 * `source_diff` on a revision R is the change in contributing citations since
 * "the previous revision of this (drug, parameter)". {@link previousRevisionSql}
 * is the one definition, shared by the live writer
 * (`recomputeAndCacheParameterSummary`) and the backfill
 * (`scripts/backfill-parameter-revision-source-diff.ts`):
 *
 *   1. Candidates are the rows with a lower id that were on the SAME drug as R
 *      at the time R was written. For the live writer that is every row now on
 *      the drug — which is what the plain "latest by id" lookup always read.
 *      For the backfill it excludes a row that was still on the other drug of
 *      a later merge: before this, a backfill run after a merge could pick a
 *      repointed row the live writer never saw, merely because its id was
 *      lower, and record citation changes that never happened.
 *   2. Take the newest candidate. If a merge into R's drug, made before R was
 *      written (R's id is above the merge's `revision_high_water`), recorded that row as superseded for this parameter, use the
 *      baseline it recorded instead. A merge where the survivor kept its own
 *      value, but the newest pre-merge row is the loser's, would otherwise
 *      diff the survivor's next recompute against the other drug's citations
 *      (and the reverse when the admin picked the loser's value).
 *
 * Merges made before migration 0152 recorded none of this; rows they moved are
 * indistinguishable from native ones, and both rules fall back to "latest by
 * id" for them.
 */
import { sql, type SQL } from 'drizzle-orm';
import { drugMergeEvents } from '../../db/schema.js';
import type { getDb } from './db.js';

type Db = ReturnType<typeof getDb>;

export interface RevisionBaseline {
  /** The newest pre-merge row the survivor's history would otherwise read as previous. */
  supersededRevisionId: number;
  /** The previous revision of the side whose value survived; null when it had none. */
  baselineRevisionId: number | null;
}

export type ParameterBaselines = Record<string, RevisionBaseline>;

/**
 * The drug a `drug_parameter_revisions` row (table alias `alias`) was on when
 * revision `revisionId` was written: the loser of the first recorded merge
 * that moved it after that write, or, if none did, the drug it is on now.
 * Drug ids are never reused, so the walk needs no chain — the first later move
 * names the drug it sat on. "After that write" is `revision_high_water >=
 * revisionId` (the revision already existed when the merge ran), decided by id
 * rather than by clock. `revisionId` null means a revision not written yet,
 * which no recorded merge can follow.
 */
export function drugAtSql(alias: string, revisionId: SQL | null): SQL {
  const a = sql.raw(`"${alias}"`);
  if (!revisionId) return sql`${a}."drug_id"`;
  return sql`COALESCE((
    SELECT e_at."loser_drug_id"
    FROM "drug_merge_events" e_at
    WHERE ${a}."id" = ANY(e_at."parameter_revision_ids")
      AND e_at."revision_high_water" >= ${revisionId}
    ORDER BY e_at."id"
    LIMIT 1
  ), ${a}."drug_id")`;
}

/**
 * A subquery yielding at most one row `(id, reference_ids)`: the previous
 * revision of revision `revisionId` on `drugId` / `parameter` (see the module
 * comment), or of the next revision written there when `revisionId` is null.
 * `drugAtTime` is the drug that revision was on when written. A row with a
 * null `id` means a merge recorded that the surviving side had no previous
 * revision at all.
 */
export function previousRevisionSql(target: {
  drugId: SQL;
  drugAtTime: SQL;
  parameter: SQL;
  revisionId: SQL | null;
}): SQL {
  const { drugId, drugAtTime, parameter, revisionId } = target;
  return sql`
    SELECT b."id" AS id, b."reference_ids" AS reference_ids
    FROM (
      SELECT p."id"
      FROM "drug_parameter_revisions" p
      WHERE p."drug_id" = ${drugId}
        AND p."parameter" = ${parameter}
        ${revisionId ? sql`AND p."id" < ${revisionId}` : sql``}
        AND ${drugAtSql('p', revisionId)} = ${drugAtTime}
      ORDER BY p."id" DESC
      LIMIT 1
    ) raw
    LEFT JOIN LATERAL (
      SELECT true AS matched,
             (e."parameter_baselines" -> (${parameter})::text ->> 'baselineRevisionId')::int
               AS baseline_id
      FROM "drug_merge_events" e
      WHERE e."survivor_drug_id" = ${drugAtTime}
        ${revisionId ? sql`AND e."revision_high_water" < ${revisionId}` : sql``}
        AND (e."parameter_baselines" -> (${parameter})::text ->> 'supersededRevisionId')::int
              = raw."id"
      ORDER BY e."id" DESC
      LIMIT 1
    ) sub ON true
    LEFT JOIN "drug_parameter_revisions" b
      ON b."id" = CASE WHEN sub.matched THEN sub.baseline_id ELSE raw."id" END`;
}

/**
 * The previous revision for the next revision written on `(drugId, parameter)`
 * now — what the live `source_diff` writer diffs against. Null when there is
 * none (or a merge recorded that the surviving side had none).
 */
export async function previousRevisionForNextWrite(
  db: Db,
  drugId: number,
  parameter: string,
): Promise<{ id: number; referenceIds: number[] | null } | null> {
  const result = await db.execute<{ id: number | null; reference_ids: number[] | null }>(
    previousRevisionSql({
      drugId: sql`${drugId}`,
      drugAtTime: sql`${drugId}`,
      parameter: sql`${parameter}`,
      revisionId: null,
    }),
  );
  const row = result.rows[0];
  if (!row || row.id == null) return null;
  return { id: Number(row.id), referenceIds: row.reference_ids };
}

/**
 * Work out, before a merge moves anything, where each parameter's
 * previous-revision chain must continue from once both histories share the
 * survivor. `survivingSide(parameter)` says whose `drug_parameters` value the
 * merge keeps. Returns only the parameters the plain "newest row" read would
 * get wrong.
 */
export async function planParameterBaselines(
  db: Db,
  params: {
    winnerId: number;
    loserId: number;
    survivingSide: (parameter: string) => 'winner' | 'loser';
  },
): Promise<ParameterBaselines> {
  const { winnerId, loserId, survivingSide } = params;
  const newest = await db.execute<{ parameter: string; id: number }>(sql`
    SELECT parameter, max(id)::int AS id
    FROM drug_parameter_revisions
    WHERE drug_id IN (${winnerId}, ${loserId})
    GROUP BY parameter
    ORDER BY parameter`);
  const baselines: ParameterBaselines = {};
  for (const { parameter, id } of newest.rows) {
    const sideId = survivingSide(parameter) === 'loser' ? loserId : winnerId;
    const baseline = await previousRevisionForNextWrite(db, sideId, parameter);
    const supersededRevisionId = Number(id);
    const baselineRevisionId = baseline?.id ?? null;
    if (baselineRevisionId !== supersededRevisionId) {
      baselines[parameter] = { supersededRevisionId, baselineRevisionId };
    }
  }
  return baselines;
}

/** Move every loser revision onto the winner; returns the moved ids. */
export async function repointParameterRevisions(
  db: Db,
  params: { winnerId: number; loserId: number },
): Promise<number[]> {
  const moved = await db.execute<{ id: number }>(sql`
    UPDATE drug_parameter_revisions SET drug_id = ${params.winnerId}
    WHERE drug_id = ${params.loserId}
    RETURNING id`);
  return moved.rows.map((r) => Number(r.id)).sort((a, b) => a - b);
}

/**
 * Write the merge's lineage record. Call inside the merge transaction, after
 * the repoint and before the survivor's summaries are recomputed (the
 * recompute reads `parameterBaselines` through {@link previousRevisionSql}).
 */
export async function recordDrugMergeEvent(
  db: Db,
  event: {
    survivorDrugId: number;
    loser: {
      id: number;
      slug: string;
      pubchemCid: number | null;
      names: Record<string, string>;
    };
    parameterRevisionIds: number[];
    parameterBaselines: ParameterBaselines;
    repointedMonographPageId: number | null;
    mergedVia: 'admin' | 'script';
    mergedBy: number | null;
  },
): Promise<number> {
  // Read under the merge's locks: every revision of either drug that exists
  // now has an id at or below it, and anything written after the merge
  // (its own recompute included) gets a higher one.
  const highWater = await db.execute<{ id: number | null }>(
    sql`SELECT max(id)::int AS id FROM drug_parameter_revisions`,
  );
  const [row] = await db
    .insert(drugMergeEvents)
    .values({
      revisionHighWater: Number(highWater.rows[0]?.id ?? 0),
      survivorDrugId: event.survivorDrugId,
      loserDrugId: event.loser.id,
      loserSlug: event.loser.slug,
      loserPubchemCid: event.loser.pubchemCid,
      loserNames: event.loser.names,
      parameterRevisionIds: event.parameterRevisionIds,
      parameterBaselines: event.parameterBaselines,
      repointedMonographPageId: event.repointedMonographPageId,
      mergedVia: event.mergedVia,
      mergedBy: event.mergedBy,
    })
    .returning({ id: drugMergeEvents.id });
  if (!row) throw new Error('recordDrugMergeEvent: insert returned no row');
  return row.id;
}
