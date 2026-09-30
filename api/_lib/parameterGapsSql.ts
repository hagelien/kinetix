/**
 * The three suppression reasons, as SQL, in one place.
 *
 * They are needed in three shapes that do not look alike:
 *
 * - the gap queue ANDs their negations into a WHERE clause ("show me pairs no
 *   reason suppresses");
 * - the suppression counts rank them in a CASE ("which reason suppressed this
 *   one, most durable first");
 * - `scripts/prioritize-param.ts` ANDs the negations again, against different
 *   column names, for the dev-side view of the same queue.
 *
 * They were written out three times. When the absent cooldown learned to be
 * superseded by newer evidence, exactly one copy learned it — so the queue
 * reopened a pair while the count in the same response still called it
 * suppressed, and the script kept hiding it entirely. The comment on the
 * queue's helper claimed the counts shared it and could "never disagree",
 * which had never been true: the counts cannot AND the reasons together, they
 * have to ask about each one separately.
 *
 * So the unit of sharing is the individual predicate, not the assembled
 * clause. Each of the three shapes builds from these; none of them can restate
 * a rule. `PairColumns` exists because the three call sites reach the same
 * three values through different aliases.
 */
import {
  ABSENT_RECHECK_DAYS,
  CORE_COVERAGE_PARAMETERS,
  DOSE_CONTEXT_OBSERVATION_PARAMETERS,
  MODEL_DECLARATION_PARAMETERS,
  nonAdministeredSubstanceClasses,
  parametersRequiringAdministration,
} from '../../src/lib/parameterApplicability.js';
import {
  DRUG_COVERAGE_AREA_IDS,
  type DrugCoverageAreaId,
} from '../../src/lib/drugCoverageAreas.js';

/**
 * Render a string list as a SQL array literal.
 *
 * Every input is a parameter id or substance class from an `as const` list, so
 * the character check can never fail today. It is here so that it fails loudly
 * if that ever stops being true — a future id with a quote in it would
 * otherwise produce a silently malformed query rather than an error.
 */
export function sqlTextArray(values: readonly string[]): string {
  for (const v of values) {
    if (!/^[A-Za-z0-9_]+$/.test(v)) {
      throw new Error(
        `Cannot inline ${JSON.stringify(v)} into gap-queue SQL: expected an identifier-shaped constant.`,
      );
    }
  }
  return `ARRAY[${values.map((v) => `'${v}'`).join(', ')}]::text[]`;
}

/** Render an integer list as a SQL array literal, rejecting non-integers. */
export function sqlIntArray(values: readonly number[]): string {
  for (const v of values) {
    if (!Number.isInteger(v)) {
      throw new Error(`Cannot inline ${JSON.stringify(v)}: expected an integer.`);
    }
  }
  return `ARRAY[${values.join(', ')}]::int[]`;
}

/** Guard the cooldown before it is inlined as a bare integer literal. */
export function sqlIntLiteral(value: number): string {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Expected a non-negative integer, got ${value}`);
  }
  return String(value);
}

export const CORE_PARAMETERS_SQL = sqlTextArray([...CORE_COVERAGE_PARAMETERS]);
export const DECLARATION_PARAMETERS_SQL = sqlTextArray([
  ...MODEL_DECLARATION_PARAMETERS,
]);
export const COVERAGE_AREAS_SQL = sqlTextArray([...DRUG_COVERAGE_AREA_IDS]);
export const OBSERVATION_PARAMETERS_SQL = sqlTextArray([
  ...DOSE_CONTEXT_OBSERVATION_PARAMETERS,
]);
export const REQUIRES_ADMINISTRATION_SQL = sqlTextArray(
  parametersRequiringAdministration(),
);
export const NOT_ADMINISTERED_SQL = sqlTextArray(
  nonAdministeredSubstanceClasses(),
);
export const ABSENT_RECHECK_DAYS_SQL = sqlIntLiteral(ABSENT_RECHECK_DAYS);

/**
 * How a given query names the three values every reason needs. The queue joins
 * `drugs d` to a `wanted w` CTE, the counts read a flattened `candidates c`,
 * and the dev script unnests into a bare `core` column.
 */
export interface PairColumns {
  /** Expression yielding drugs.id. */
  readonly drugId: string;
  /** Expression yielding the candidate parameter id. */
  readonly parameter: string;
  /** Expression yielding drugs.substance_class. */
  readonly substanceClass: string;
}

/** An editor marked this exact pair as not a defined quantity. Permanent. */
export function markedNotApplicableSql(c: PairColumns): string {
  return `EXISTS (
        SELECT 1 FROM drug_parameter_applicability a
        WHERE a.drug_id = ${c.drugId}
          AND a.parameter = ${c.parameter}
          AND a.status = 'not_applicable'
      )`;
}

/**
 * The substance is not administered, and this parameter describes the fate of
 * an administered dose. Class-wide and permanent.
 */
export function ruledOutBySubstanceClassSql(c: PairColumns): string {
  return `(
        ${c.substanceClass} = ANY(${NOT_ADMINISTERED_SQL})
        AND ${c.parameter} = ANY(${REQUIRES_ADMINISTRATION_SQL})
      )`;
}

/**
 * An exhaustive search came back empty recently — and nothing has been learned
 * since.
 *
 * The second half is load-bearing. An absence is a claim about the state of
 * the literature on the day it was checked, not a property of the pair, so a
 * later verification that DID find sources retires it. Without that, a pair
 * whose proposal was rejected, withdrawn, or whose value was later cleared
 * stays hidden for the rest of the window while the audit trail says sources
 * exist — hiding a real gap, which is the failure this whole lane exists to
 * prevent. Re-serving one merely costs a cycle.
 *
 * Order, not presence: a second absence supersedes nothing, and evidence that
 * predates the absence is the older claim. `concordance IS NOT NULL` keeps a
 * `no_change` sweep row from counting as evidence it never reported.
 */
export function withinAbsentCooldownSql(c: PairColumns): string {
  return `EXISTS (
        SELECT 1 FROM verification_log vl
        WHERE vl.target_type = 'parameter'
          AND vl.target_id = ${c.drugId}
          AND vl.parameter = ${c.parameter}
          AND vl.concordance = 'absent'
          AND vl.verified_at > now() - make_interval(days => ${ABSENT_RECHECK_DAYS_SQL})
          AND NOT EXISTS (
            SELECT 1 FROM verification_log newer
            WHERE newer.target_type = 'parameter'
              AND newer.target_id = vl.target_id
              AND newer.parameter = vl.parameter
              AND newer.concordance IS NOT NULL
              AND newer.concordance <> 'absent'
              AND newer.verified_at > vl.verified_at
          )
      )`;
}

/**
 * The two **permanent** reasons, ORed — the SQL counterpart of
 * `parameterWriteBlockedBy`. A write must refuse when either holds.
 *
 * The absent cooldown is deliberately absent from this one. It records that a
 * search came back empty, not that the quantity cannot exist, so someone who
 * has now found a source must be able to store it — that is the outcome the
 * cooldown is waiting for. Only the queue treats all three alike.
 *
 * For writers that cannot take the advisory lock (a raw-SQL backfill on the
 * auto-commit client, say): folding this into the INSERT's WHERE makes the
 * check and the write one statement, which serializes without a lock.
 */
export function writeBlockedSql(c: PairColumns): string {
  return `(${markedNotApplicableSql(c)} OR ${ruledOutBySubstanceClassSql(c)})`;
}

// ─── Fill tests ─────────────────────────────────────────────────────────────
//
// "Is this pair already filled?" has three answers, because the catalogue
// stores three different kinds of thing under one `parameter` key. (The fourth
// lane, dose-context observations, reuses the declaration answer — see
// `hasObservationEntrySql`.)
//
// A MEASURED parameter publishes a pooled aggregate into `drug_parameters`, so
// a missing row is the gap. A DECLARED one (the CV-1b model-structure axes, and
// the route-scoped `ka`) never writes that row at all:
// `recomputeAndCacheParameterSummary` returns early unless the parameter is
// `summarizable`, and none of them are. Asking the `drug_parameters` question
// about a declaration therefore always answers "missing", however many cited
// entries exist — the benzoylecgonine loop, rebuilt. Its evidence lives in
// `parameter_entries`, so that is what its fill test reads.
//
// A COVERAGE AREA (`src/lib/drugCoverageAreas.ts`) writes neither: metabolism
// and pharmacodynamics are graphs of relationship rows, and asking either of
// the questions above about one always answers "missing" however complete the
// section is — the benzoylecgonine loop again, this time on the two most
// expensive sections of a monograph. Its evidence is the relationship rows
// themselves, so that is what its fill test counts.
//
// `drug_parameters.value` is NOT NULL, so for a measured parameter row
// existence and value presence are the same question.

/** A measured parameter is filled when its cached aggregate row exists. */
export function hasStoredValueSql(c: PairColumns): string {
  return `EXISTS (
        SELECT 1 FROM drug_parameters dp
        WHERE dp.drug_id = ${c.drugId}
          AND dp.parameter = ${c.parameter}
      )`;
}

/**
 * A declared parameter is filled when any live source entry asserts it.
 *
 * Entries are hard-deleted, so row existence is liveness — there is no status
 * or tombstone column to filter on. Route is deliberately not part of the test:
 * `absorptionModel` and `ka` may be declared per route, and treating each route
 * as its own gap would need a (drug, parameter, route) queue this one is not
 * shaped for. One declaration retires the pair; deepening it to every route is
 * flag and tier-C work, exactly as an under-corroborated value is.
 */
export function hasDeclarationEntrySql(c: PairColumns): string {
  return `EXISTS (
        SELECT 1 FROM parameter_entries pe_fill
        WHERE pe_fill.drug_id = ${c.drugId}
          AND pe_fill.parameter = ${c.parameter}
      )`;
}

/**
 * A dose-context observation (Cmax) is filled when any live source entry
 * records one — the declaration test, for the same reason: the parameter is
 * entry-only, so `drug_parameters` never holds a row for it.
 *
 * One reading retires the pair. A single cohort is a thin evidence base, and
 * the per-dose headline wants several comparable ones, but deepening it is flag
 * and tier-C work exactly as corroborating an under-sourced value is; a queue
 * that kept serving the pair until some corpus size was reached would pin the
 * lane to the most-studied drugs and starve every other one.
 */
export function hasObservationEntrySql(c: PairColumns): string {
  return hasDeclarationEntrySql(c);
}

/**
 * Per-area fill tests for the coverage lane, keyed by id so the compiler
 * refuses a new area that arrives without one — the failure would otherwise be
 * silent and permanent (see the ELSE in `hasCoverageAreaSql`).
 *
 * "Covered" is the same bar the monograph's own `hasMetabolismData` uses: any
 * route, any metabolite edge, or a profile whose evidence note actually says
 * something. A profile row on its own is a stub the editor created and
 * abandoned, so it does not retire the gap.
 *
 * Precursor edges — rows where this drug is somebody else's metabolite — are
 * deliberately not counted. They are the PARENT's metabolism, and letting them
 * close this drug's gap would mark every metabolite covered without a word
 * being written about what becomes of it.
 */
export const COVERAGE_AREA_FILL_SQL: Record<
  DrugCoverageAreaId,
  (c: PairColumns) => string
> = {
  metabolism: (c) => `(
        EXISTS (
          SELECT 1 FROM drug_elimination_routes der
          WHERE der.drug_id = ${c.drugId}
        )
        OR EXISTS (
          SELECT 1 FROM drug_metabolites dm
          WHERE dm.parent_drug_id = ${c.drugId}
        )
        OR EXISTS (
          SELECT 1 FROM drug_metabolism_profiles dmp
          WHERE dmp.drug_id = ${c.drugId}
            AND btrim(coalesce(dmp.evidence_note, '')) <> ''
        )
      )`,
  pharmacodynamics: (c) => `EXISTS (
        SELECT 1 FROM drug_receptor_targets drt
        WHERE drt.drug_id = ${c.drugId}
      )`,
};

/**
 * Which `pending_edits.edit_type` proposes a change to each coverage area.
 *
 * Both relationship routes queue a contributor's write as a FULL-REPLACEMENT
 * pending edit keyed on `target_id = drugs.id`, with `parameter` left NULL —
 * there is no parameter id to put there. The queue's pending-edit exclusion
 * matches on `pe.parameter`, so without this mapping a proposal awaiting
 * review suppresses nothing: the same gap is served every cycle, the routine
 * files another full replacement each time, and approving a stale one
 * overwrites the relationships an earlier one added. Keyed by id, like the
 * fill tests, so a new area cannot arrive without one.
 */
export const COVERAGE_AREA_PENDING_EDIT_TYPE: Record<
  DrugCoverageAreaId,
  string
> = {
  metabolism: 'metabolism',
  pharmacodynamics: 'receptor_targets',
};

/**
 * "A pending edit already proposes this drug's coverage area."
 *
 * `drug` and `pendingEdit` are the query's aliases for `drugs` and the
 * correlated `pending_edits` row; `parameter` is the candidate area. The CASE
 * yields NULL for anything that is not a coverage area, and `edit_type = NULL`
 * is never true, so this predicate is inert on the other two lanes and needs no
 * `fill_kind` guard of its own.
 */
export function coverageAreaProposedSql(
  c: PairColumns,
  pendingEdit: string,
): string {
  const branches = Object.entries(COVERAGE_AREA_PENDING_EDIT_TYPE)
    .map(([id, editType]) => `WHEN '${id}' THEN '${editType}'`)
    .join('\n              ');
  return `(
              ${pendingEdit}.target_id = ${c.drugId}
              AND ${pendingEdit}.edit_type = CASE ${c.parameter}
              ${branches}
              END
            )`;
}

/**
 * A coverage area is filled when its section has any substance to it.
 *
 * The ELSE is unreachable — the candidate ids come from `DRUG_COVERAGE_AREA_IDS`
 * in this same build — and answers TRUE ("already filled") rather than FALSE on
 * purpose: an id this build has no fill test for is one the routine could not
 * close either, so serving it would re-open the very loop this module exists to
 * prevent.
 */
export function hasCoverageAreaSql(c: PairColumns): string {
  const branches = Object.entries(COVERAGE_AREA_FILL_SQL)
    .map(([id, build]) => `WHEN '${id}' THEN ${build(c)}`)
    .join('\n        ');
  return `CASE ${c.parameter}
        ${branches}
        ELSE TRUE
      END`;
}

/**
 * The fill test for whichever lane this candidate came from, selected by the
 * `fill_kind` discriminator the candidate CTE carries.
 *
 * One expression rather than four queries so that every other rule — the three
 * suppressions, the pending-edit exclusion, the focus narrowing, the ranking —
 * is written once and applies to every lane identically.
 */
export function alreadyFilledSql(c: PairColumns, fillKind: string): string {
  return `CASE ${fillKind}
        WHEN 'declaration' THEN ${hasDeclarationEntrySql(c)}
        WHEN 'relation' THEN ${hasCoverageAreaSql(c)}
        WHEN 'observation' THEN ${hasObservationEntrySql(c)}
        ELSE ${hasStoredValueSql(c)}
      END`;
}

/**
 * All three negated and ANDed — "no reason suppresses this pair". For the
 * queue and the dev script; the counts need the reasons apart, so they build
 * from the three above directly.
 */
export function notSuppressedSql(c: PairColumns): string {
  return `NOT ${markedNotApplicableSql(c)}
      AND NOT ${ruledOutBySubstanceClassSql(c)}
      AND NOT ${withinAbsentCooldownSql(c)}`;
}
