/**
 * DAO for the `reference_concentrations` table. Thin wrappers around Drizzle
 * so the HTTP handler stays focused on validation + serialization.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { citations, referenceConcentrations } from '../../db/schema.js';
import { getDb } from './db.js';
import { preservedQuoteExprFor } from './parameter-entries-store.js';
import {
  ParameterNotApplicableError,
  parameterWriteBlockedBy,
  withDrugApplicabilityLock,
} from './parameterApplicabilityStore.js';
import {
  SCENARIO_TO_PARAMETER,
  type ReferenceMatrix,
  type ReferenceScenario,
  type ReferenceConcentrationInput,
  type ReferenceConcentrationUpdateInput,
} from '../../src/lib/referenceConcentrations.js';

// Only real reference-concentration source rows are surfaced/edited through the
// legacy compatibility endpoint. Synthetic grandfather rows minted by migration
// 0078 (origin='grandfathered') are cache-preservation artifacts and must never
// appear as duplicate evidence or be editable/deletable here.
const LEGACY_ORIGIN = 'legacy';

type BaseReferenceConcentrationRow =
  typeof referenceConcentrations.$inferSelect;
type CitationRow = typeof citations.$inferSelect;

export interface ReferenceConcentrationRow extends BaseReferenceConcentrationRow {
  citation: Pick<CitationRow, 'id' | 'type' | 'identifier' | 'metadata'> | null;
}

export interface SerializedCitation {
  id: number;
  type: string;
  identifier: string;
  metadata: unknown | null;
}

export interface SerializedReferenceConcentration {
  id: number;
  drugId: number;
  low: number | null;
  high: number | null;
  unit: string;
  // Nullable since parameter_entries generalized beyond concentrations
  // (migration 0085). In practice always set here: this legacy view is filtered
  // to origin='legacy' rows, every one of which is a concentration entry.
  matrix: string | null;
  scenario: string | null;
  n: number | null;
  comments: string | null;
  /**
   * Facts about the reading itself (dose, fed/fasted state, population, assay
   * method), split out of `comments` by migration 0120. Optional here (unlike
   * the entry store's own `SerializedParameterEntry`): this legacy view
   * predates the column, and every row it ever wrote leaves it NULL, so a
   * fixture built before this field existed is still a valid row.
   */
  observationContext?: string | null;
  citationId: number | null;
  citation: SerializedCitation | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeReferenceConcentration(
  row: ReferenceConcentrationRow,
): SerializedReferenceConcentration {
  return {
    id: row.id,
    drugId: row.drugId,
    low: row.low !== null ? Number(row.low) : null,
    high: row.high !== null ? Number(row.high) : null,
    unit: row.unit,
    matrix: row.matrix,
    scenario: row.scenario,
    n: row.n,
    comments: row.comments,
    observationContext: row.observationContext,
    citationId: row.citationId,
    citation: row.citation
      ? {
          id: row.citation.id,
          type: row.citation.type,
          identifier: row.citation.identifier,
          metadata: row.citation.metadata,
        }
      : null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ListFilter {
  drugId: number;
  matrix?: ReferenceMatrix;
  scenario?: ReferenceScenario;
}

function joinedRow(joined: {
  parameter_entries: BaseReferenceConcentrationRow;
  citations: CitationRow | null;
}): ReferenceConcentrationRow {
  const citation = joined.citations;
  return {
    ...joined.parameter_entries,
    citation: citation
      ? {
          id: citation.id,
          type: citation.type,
          identifier: citation.identifier,
          metadata: citation.metadata,
        }
      : null,
  };
}

export async function listReferenceConcentrations(
  filter: ListFilter,
): Promise<ReferenceConcentrationRow[]> {
  const db = getDb();
  const conditions = [
    eq(referenceConcentrations.drugId, filter.drugId),
    eq(referenceConcentrations.origin, LEGACY_ORIGIN),
  ];
  if (filter.matrix) {
    conditions.push(eq(referenceConcentrations.matrix, filter.matrix));
  }
  if (filter.scenario) {
    conditions.push(eq(referenceConcentrations.scenario, filter.scenario));
  }
  const rows = await db
    .select()
    .from(referenceConcentrations)
    .leftJoin(citations, eq(referenceConcentrations.citationId, citations.id))
    .where(and(...conditions))
    .orderBy(desc(referenceConcentrations.createdAt));
  return rows.map(joinedRow);
}

export async function listReferenceConcentrationsForDrugIds(
  drugIds: readonly number[],
  filter: Omit<ListFilter, 'drugId'> = {},
): Promise<ReferenceConcentrationRow[]> {
  if (drugIds.length === 0) return [];

  const db = getDb();
  const conditions = [
    inArray(referenceConcentrations.drugId, [...drugIds]),
    eq(referenceConcentrations.origin, LEGACY_ORIGIN),
  ];
  if (filter.matrix) {
    conditions.push(eq(referenceConcentrations.matrix, filter.matrix));
  }
  if (filter.scenario) {
    conditions.push(eq(referenceConcentrations.scenario, filter.scenario));
  }
  const rows = await db
    .select()
    .from(referenceConcentrations)
    .leftJoin(citations, eq(referenceConcentrations.citationId, citations.id))
    .where(and(...conditions))
    .orderBy(
      asc(referenceConcentrations.drugId),
      desc(referenceConcentrations.createdAt),
    );
  return rows.map(joinedRow);
}

export async function getReferenceConcentrationById(
  id: number,
): Promise<ReferenceConcentrationRow | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(referenceConcentrations)
    .leftJoin(citations, eq(referenceConcentrations.citationId, citations.id))
    .where(eq(referenceConcentrations.id, id))
    .limit(1);
  return row ? joinedRow(row) : null;
}

export async function insertReferenceConcentration(args: {
  input: ReferenceConcentrationInput;
  createdBy: number;
}): Promise<ReferenceConcentrationRow> {
  const { input, createdBy } = args;
  const parameter = SCENARIO_TO_PARAMETER[input.scenario];
  // `referenceConcentrations` is an alias for `parameterEntries` (schema.ts),
  // so this legacy endpoint is a third way to write a source row for a
  // (drug, parameter) pair — and it bypassed `insertParameterEntry`, where the
  // applicability guard lives. A marked pair would take the row and then be
  // skipped by the recompute, leaving a live source entry beside the marker
  // forbidding it. Same check-and-write-under-one-lock as the guarded helper.
  return withDrugApplicabilityLock(input.drugId, async () => {
    const db = getDb();
    const blocked = await parameterWriteBlockedBy(db, input.drugId, parameter);
    if (blocked) {
      throw new ParameterNotApplicableError(input.drugId, parameter, blocked);
    }
    return insertReferenceConcentrationRow(input, parameter, createdBy);
  });
}

async function insertReferenceConcentrationRow(
  input: ReferenceConcentrationInput,
  parameter: string,
  createdBy: number,
): Promise<ReferenceConcentrationRow> {
  const db = getDb();
  const [row] = await db
    .insert(referenceConcentrations)
    .values({
      drugId: input.drugId,
      // parameter_entries.parameter is NOT NULL (migration 0078); the legacy
      // reference-concentrations write path derives it from the scenario.
      parameter,
      low: input.low !== undefined ? String(input.low) : null,
      high: input.high !== undefined ? String(input.high) : null,
      unit: input.unit,
      matrix: input.matrix,
      scenario: input.scenario,
      n: input.n ?? null,
      comments: input.comments ?? null,
      citationId: input.citationId ?? null,
      createdBy,
    })
    .returning();
  if (!row) {
    throw new Error('Failed to insert reference_concentration row');
  }
  // Re-read with join so the caller gets the citation payload too.
  const fetched = await getReferenceConcentrationById(row.id);
  if (!fetched) {
    throw new Error('Failed to read back inserted reference_concentration row');
  }
  return fetched;
}

export async function updateReferenceConcentration(args: {
  id: number;
  input: ReferenceConcentrationUpdateInput;
}): Promise<ReferenceConcentrationRow | null> {
  const { id, input } = args;

  // The row owns its drugId — the update payload carries only the scenario —
  // so find it before locking. Everything that decides the outcome is then
  // re-read inside the lock.
  const target = await getReferenceConcentrationById(id);
  if (!target || target.origin !== LEGACY_ORIGIN) return null;

  return withDrugApplicabilityLock(target.drugId, () =>
    updateReferenceConcentrationLocked(id, input),
  );
}

async function updateReferenceConcentrationLocked(
  id: number,
  input: ReferenceConcentrationUpdateInput,
): Promise<ReferenceConcentrationRow | null> {
  const db = getDb();

  const existing = await getReferenceConcentrationById(id);
  // Only genuine legacy source rows are mutable through this endpoint. A
  // synthetic grandfather row (a cache-preservation artifact) is reported as
  // not-found so a direct edit-by-id can't overwrite its bounds, matrix,
  // citation, etc. — the list filter already hides it, this closes the by-id
  // hole.
  if (!existing || existing.origin !== LEGACY_ORIGIN) return null;

  // The update re-derives `parameter` from the (possibly changed) scenario, so
  // it can move a live row *onto* a blocked pair — the contradiction the insert
  // guard prevents, reached sideways. Checked here, inside the lock, so a
  // marker cannot land between this read and the write below.
  const parameter = SCENARIO_TO_PARAMETER[input.scenario];
  const blocked = await parameterWriteBlockedBy(db, existing.drugId, parameter);
  if (blocked) {
    throw new ParameterNotApplicableError(existing.drugId, parameter, blocked);
  }

  const [row] = await db
    .update(referenceConcentrations)
    .set({
      // Safe to re-derive from the (possibly changed) scenario now that the row
      // is known legacy-representable and the pair is known unblocked.
      parameter,
      low: input.low !== undefined ? String(input.low) : null,
      high: input.high !== undefined ? String(input.high) : null,
      // The legacy input replaces the range and carries no central estimate, so
      // clear any hidden median rather than leaving a stale value that the
      // aggregation would prioritize over the new bounds.
      median: null,
      // Likewise the labelled reported statistic (migration 0135): a centre,
      // its statistic and what the bounds are describe the OLD reading. Kept
      // beside new bounds they would publish a stale mean ± SD, or trip the
      // statistic CHECK when the old centre falls outside the new range.
      centralValue: null,
      centralStatistic: null,
      intervalKind: null,
      unit: input.unit,
      matrix: input.matrix,
      scenario: input.scenario,
      n: input.n ?? null,
      comments: input.comments ?? null,
      citationId: input.citationId ?? null,
      // This endpoint replaces the reading and its source, and a quote is
      // evidence for a SPECIFIC reading of a SPECIFIC document — so it survives
      // this write only while every field it attests to is unchanged, exactly
      // as on the entry-update path. It carries no `quote` of its own (the
      // legacy shape predates the column), so there is nothing to put in its
      // place: the honest state after a real edit is none, and an unquoted
      // calculation-driving value is held for a human rather than published.
      //
      // Decided in SQL against the row actually being written, and only over
      // the fields this writer touches: `qualifier`, `categoricalValue` and
      // `route` are left as they are, so comparing them here would detach a
      // good quote from a row that merely happens to carry one.
      sourceQuote: preservedQuoteExprFor({
        citationId: input.citationId ?? null,
        unit: input.unit,
        low: input.low !== undefined ? String(input.low) : null,
        high: input.high !== undefined ? String(input.high) : null,
        median: null,
        centralValue: null,
        centralStatistic: null,
        intervalKind: null,
        matrix: input.matrix,
        scenario: input.scenario,
        n: input.n ?? null,
      }),
      updatedAt: new Date(),
    })
    .where(eq(referenceConcentrations.id, id))
    .returning();
  if (!row) return null;
  return getReferenceConcentrationById(row.id);
}

export async function deleteReferenceConcentration(
  id: number,
): Promise<boolean> {
  const db = getDb();
  // Refuse to delete a synthetic grandfather row through the legacy endpoint;
  // it is reported as not-found, same as the update path. Scoping the DELETE by
  // origin keeps it a single statement (no read-then-delete race).
  const deleted = await db
    .delete(referenceConcentrations)
    .where(
      and(
        eq(referenceConcentrations.id, id),
        eq(referenceConcentrations.origin, LEGACY_ORIGIN),
      ),
    )
    .returning({ id: referenceConcentrations.id });
  return deleted.length > 0;
}
