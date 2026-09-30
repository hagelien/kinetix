/**
 * The dose-context half of a `parameter_entries` row's duplicate identity, in
 * SQL — for the drug merge, whose dedup and conflict checks are hand-written
 * queries over two aliases rather than drizzle predicates.
 *
 * The legacy identity (drug, parameter, unit, matrix, scenario, route,
 * citation, qualifier, categorical value, low/high/median) contains none of
 * the dimensions the Cmax dose-context RFC adds, so two arms of one paper
 * reporting the same Cmax at different doses are "identical" to it — and a
 * merge deletes one of them as a duplicate. Every identity predicate has to
 * compare the complete shape (RFC, *Write surfaces*). The merge carries about
 * twenty copies of the legacy tuple; each appends one of these fragments,
 * generated from `DOSE_CONTEXT_FIELDS`, so the dose half cannot drift between
 * them or fall behind a field added later.
 *
 * The two drug references are compared AS THEY WILL BE AFTER THE MERGE: a
 * reference to the loser reads as the winner. The preflight runs before the
 * apply repoints them, and a loser entry naming the loser as its administered
 * drug must collide with the winner's self-referencing twin in the preflight
 * exactly as it will in the apply — otherwise the conflict checks judge a
 * different grouping from the one the delete acts on. On the apply side, after
 * the repoint, the mapping is a no-op.
 *
 * Ids are inlined as integer literals rather than bound: Postgres matches a
 * GROUP BY or DISTINCT ON expression to its SELECT / ORDER BY twin textually,
 * and two binds of the same id are different parameters (`$3` vs `$7`), which
 * it would refuse as "must appear in the GROUP BY clause".
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  DOSE_CONTEXT_FIELD_KEYS,
  DOSE_CONTEXT_FIELDS,
  type DoseContextFieldKey,
} from '../../src/lib/entryDoseContext.js';

/** camelCase entry key → its snake_case column (the schema's own convention). */
export function doseContextColumn(key: DoseContextFieldKey): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

const COLUMNS = DOSE_CONTEXT_FIELD_KEYS.map((key) => ({
  column: doseContextColumn(key),
  drug: DOSE_CONTEXT_FIELDS[key] === 'drug',
}));

function intLiteral(id: number): SQL {
  if (!Number.isSafeInteger(id)) throw new Error(`Not an integer id: ${id}`);
  return sql.raw(String(id));
}

export interface MergeEntryIdentity {
  /** `AND a.col IS NOT DISTINCT FROM b.col …` for every dose-context column. */
  eq(a: string, b: string): SQL;
  /** Same, against a derived table that selected them with `select()`. */
  eqSelected(a: string, derived: string): SQL;
  /** The column expressions, comma-separated (GROUP BY, DISTINCT ON, ORDER BY). */
  cols(alias: string | null): SQL;
  /** The column expressions aliased `dc_<column>`, for a derived table's SELECT. */
  select(alias: string | null): SQL;
}

export function mergeEntryIdentity(
  winnerId: number,
  loserId: number,
): MergeEntryIdentity {
  const winner = intLiteral(winnerId);
  const loser = intLiteral(loserId);
  const expr = (alias: string | null, c: (typeof COLUMNS)[number]): SQL => {
    const ref = sql.raw(alias ? `${alias}.${c.column}` : c.column);
    return c.drug
      ? sql`(CASE WHEN ${ref} = ${loser} THEN ${winner} ELSE ${ref} END)`
      : ref;
  };
  return {
    eq: (a, b) =>
      sql.join(
        COLUMNS.map(
          (c) => sql`AND ${expr(a, c)} IS NOT DISTINCT FROM ${expr(b, c)}`,
        ),
        sql`\n`,
      ),
    eqSelected: (a, derived) =>
      sql.join(
        COLUMNS.map(
          (c) =>
            sql`AND ${expr(a, c)} IS NOT DISTINCT FROM ${sql.raw(`${derived}.dc_${c.column}`)}`,
        ),
        sql`\n`,
      ),
    cols: (alias) => sql.join(COLUMNS.map((c) => expr(alias, c)), sql`, `),
    select: (alias) =>
      sql.join(
        COLUMNS.map((c) => sql`${expr(alias, c)} AS ${sql.raw(`dc_${c.column}`)}`),
        sql`, `,
      ),
  };
}
