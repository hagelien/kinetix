/**
 * Store for the multi-value `parameter_entries` table (Phase 2). Loads a
 * parameter's source entries (joined to their review score) for aggregation,
 * and recomputes + caches the aggregate summary onto `drug_parameters`.
 *
 * Unlike `reference-concentrations-helpers` (the legacy compatibility DAO, which
 * filters to origin='legacy'), this store sees EVERY entry — legacy source rows
 * and grandfathered synthetic rows alike — because all of them feed the summary.
 */
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import {
  parameterEntries,
  paperReviews,
  drugParameterRevisions,
  citations,
} from '../../db/schema.js';
import { getDb } from './db.js';
import { markEntryMutationsConflicted } from './entry-conflicts.js';
import { getDrugParameterMap, upsertDrugParameter } from './drugParameterStore.js';
import {
  ParameterNotApplicableError,
  parameterWriteBlockedBy,
  withDrugApplicabilityLock,
} from './parameterApplicabilityStore.js';
import { recordImplicitAgentApproval } from './agent-verifications.js';
import { recordApproval } from './approvals.js';
import {
  aggregateEntries,
  AGGREGATE_NOTE_PREFIX,
  isAggregateCacheValue,
  summaryToNumericRange,
  type ParameterEntryValue,
  type ParameterSummary,
} from '../../src/lib/parameterEntryAggregation.js';
import {
  getRangeSpec,
  isDrugParameterId,
  parameterIsMatrixRelevant,
  parameterIsSummarizable,
  SUMMARIZED_PARAMETER_IDS,
  type DrugParameterId,
} from '../../src/lib/drugParameters.js';
import type { ReferenceMatrix } from '../../src/lib/referenceConcentrations.js';
import {
  resolveBloodPlasmaRatio,
  summarizeCmax,
  type CmaxSourceEntry,
  type CmaxSummary,
} from '../../src/lib/cmaxNormalization.js';
import {
  canonicalizeReportedStatistic,
  DOSE_CONTEXT_FIELD_KEYS,
  doseContextNumericType,
  NUMERIC_DOSE_CONTEXT_FIELDS,
  type DoseContextFieldKey,
  type DoseContextFields,
} from '../../src/lib/entryDoseContext.js';
import type { NumericRange } from '../../src/types/index.js';
import {
  canonicalSourceQuote,
  CONFUSABLE_FOLD_FROM,
  CONFUSABLE_FOLD_TO,
  sourceQuoteComparisonKey,
  storedEvidenceValue,
  SOURCE_QUOTE_EVIDENCE_FIELDS,
  type ParameterEntryInput,
  type ParameterEntryPatch,
} from '../../src/lib/parameterEntries.js';

/**
 * Serialize every cache recompute for one drug.
 *
 * ONE lock, at the level the work actually spans. Recomputes are not
 * independent per parameter: the blood:plasma ratio and molecular weight
 * normalize every concentration aggregate, so a recompute of parameter X can
 * depend on the committed value of parameter Y. Two finer-grained locks (one
 * per parameter, one per sweep) made that dependency raceable in both
 * directions —
 *
 *   - order: a normalization path holding B/P and then sweeping the registry
 *     could deadlock against a sweep that reached B/P last (ABBA);
 *   - visibility: a sweep decided which parameters to touch from committed
 *     state, so a concurrent transaction inserting a drug's FIRST entry for
 *     some parameter was invisible to it — that transaction then published a
 *     cache normalized with the pre-change ratio and nothing revisited it.
 *
 * A per-drug lock removes both: whichever transaction goes second sees the
 * other's committed entries and values. It costs contention only between
 * concurrent curation writes to the SAME drug, which is a rare, human-paced
 * event. Callers that touch several drugs must acquire in ascending drug-id
 * order so they cannot deadlock against each other.
 *
 * Uses the single-argument advisory-lock form; it is re-entrant within a
 * transaction, so nested recompute paths take it freely.
 */
async function lockDrugForRecompute(drugId: number): Promise<void> {
  await getDb().execute(sql`SELECT pg_advisory_xact_lock(${drugId}::bigint)`);
}

function toNum(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Load a parameter's entries reduced to the fields aggregation needs. */
export async function loadEntryValuesForParameter(
  drugId: number,
  parameter: string,
): Promise<ParameterEntryValue[]> {
  const db = getDb();
  const rows = await db
    .select({
      entryId: parameterEntries.id,
      citationId: parameterEntries.citationId,
      low: parameterEntries.low,
      high: parameterEntries.high,
      median: parameterEntries.median,
      centralValue: parameterEntries.centralValue,
      intervalKind: parameterEntries.intervalKind,
      qualifier: parameterEntries.qualifier,
      unit: parameterEntries.unit,
      matrix: parameterEntries.matrix,
      n: parameterEntries.n,
      origin: parameterEntries.origin,
      reviewScore: paperReviews.overallScore,
    })
    .from(parameterEntries)
    .leftJoin(
      paperReviews,
      eq(paperReviews.citationId, parameterEntries.citationId),
    )
    .where(
      and(
        eq(parameterEntries.drugId, drugId),
        eq(parameterEntries.parameter, parameter),
        // Drug-level aggregation only: a route-scoped entry (a per-route F/ka, CV-2c/CV-2c-4) is NOT a
        // drug-level observation and must not pool into the drug-level summary cache — the per-route
        // derivation reads those separately. A drug-level (route-null) F still aggregates as before.
        isNull(parameterEntries.route),
      ),
    );
  return rows.map((r) => ({
    entryId: r.entryId,
    citationId: r.citationId,
    low: toNum(r.low),
    high: toNum(r.high),
    median: toNum(r.median),
    centralValue: toNum(r.centralValue),
    intervalKind: r.intervalKind,
    qualifier: r.qualifier,
    unit: r.unit,
    matrix: r.matrix as ReferenceMatrix | null,
    n: r.n,
    origin: r.origin,
    reviewScore: r.reviewScore ?? null,
  }));
}

/**
 * A drug's Cmax source rows and the dose-normalized summary computed from
 * exactly those rows (Cmax dose-context RFC, *Derived normalization* /
 * *Aggregation*). The summary is derived at read time and never stored.
 *
 * One read, one snapshot: the summary is built from the same rows the
 * response lists, so the per-dose view can never show a headline computed
 * from other rows than the ones beside it. Served as two separately cached
 * URLs, the list and the summary could refresh at different times after an
 * edit (Codex P1 on #1387).
 *
 * Weights come from the rows' citations' review scores; the matrix ratio from
 * the drug's SOURCED blood:plasma entries (never the cached scalar, which may
 * hold an invented midpoint); the unit conversion from its molecular weight.
 * All of it goes to the pure normalizer, the same function the tests pin.
 */
export async function getCmaxViewForDrug(
  drugId: number,
): Promise<{ items: SerializedParameterEntry[]; summary: CmaxSummary }> {
  const db = getDb();
  const items = await listEntriesForDrug(drugId, 'cmax');
  const citationIds = [...new Set(items.map((i) => i.citationId).filter((id): id is number => id != null))];
  const scores = citationIds.length
    ? await db
        .select({ citationId: paperReviews.citationId, score: paperReviews.overallScore })
        .from(paperReviews)
        .where(inArray(paperReviews.citationId, citationIds))
    : [];
  const scoreByCitation = new Map(scores.map((r) => [r.citationId, r.score]));
  const entries: CmaxSourceEntry[] = items.map((item) => ({
    entryId: item.id,
    low: item.low,
    high: item.high,
    median: item.median,
    qualifier: item.qualifier,
    unit: item.unit,
    matrix: item.matrix,
    route: item.route,
    n: item.n,
    reviewScore: item.citationId != null ? (scoreByCitation.get(item.citationId) ?? null) : null,
    citationId: item.citationId,
    doseContext: (item.doseContext ?? {}) as DoseContextFields,
  }));
  const ratioEntries = await loadEntryValuesForParameter(drugId, 'bloodPlasmaRatio');
  const { molecularWeight: mw } = normalizationInputsFrom(await getDrugParameterMap(db, drugId));
  const molecularWeight = mw != null && mw > 0 ? mw : null;
  const summary = summarizeCmax(entries, {
    molecularWeight,
    bloodPlasma: resolveBloodPlasmaRatio(
      ratioEntries.map((e) => ({ ...e, origin: e.origin ?? 'legacy' })),
    ),
  });
  return { items, summary };
}

/** The summary alone, for callers that do not list the rows. */
export async function getCmaxSummaryForDrug(drugId: number): Promise<CmaxSummary> {
  return (await getCmaxViewForDrug(drugId)).summary;
}

/**
 * A drug's entry-backed summaries, split by the level the evidence was recorded at.
 *
 * The two pools never merge: a route-scoped entry (a per-route F/Tmax, CV-2c-4) is a statement
 * about ONE absorption phase, so pooling it into the drug-level figure is exactly the collapse
 * route-keying exists to prevent. But "not the drug-level value" is not "not shown": before this
 * split, curating a drug's only Tmax/F entries onto a route emptied the monograph field and the
 * forest plot, and the sources dialog said no source values were registered while listing them.
 * The per-route pools travel beside the drug-level ones so the UI can show a route-labelled value
 * instead of an em dash, without either number pretending to be the other.
 */
export interface DrugParameterSummaries {
  /** Drug-level (route-null) pools — the monograph's headline value, unchanged. */
  summaries: Record<string, ParameterSummary>;
  /** Per-route pools, keyed parameter → `RouteId`. Never mixed into `summaries`. */
  routeSummaries: Record<string, Record<string, ParameterSummary>>;
}

/**
 * Compute the aggregate summary for every summarizable parameter of a drug, in
 * one entry query — drug-level and per-route (see `DrugParameterSummaries`).
 * Used to enrich the single-drug API response. Parameters with no entries are omitted.
 */
export async function getParameterSummariesWithRoutes(
  drugId: number,
): Promise<DrugParameterSummaries> {
  const db = getDb();
  const rows = await db
    .select({
      parameter: parameterEntries.parameter,
      route: parameterEntries.route,
      entryId: parameterEntries.id,
      citationId: parameterEntries.citationId,
      low: parameterEntries.low,
      high: parameterEntries.high,
      median: parameterEntries.median,
      centralValue: parameterEntries.centralValue,
      intervalKind: parameterEntries.intervalKind,
      qualifier: parameterEntries.qualifier,
      unit: parameterEntries.unit,
      matrix: parameterEntries.matrix,
      n: parameterEntries.n,
      origin: parameterEntries.origin,
      reviewScore: paperReviews.overallScore,
    })
    .from(parameterEntries)
    .leftJoin(
      paperReviews,
      eq(paperReviews.citationId, parameterEntries.citationId),
    )
    .where(
      and(
        eq(parameterEntries.drugId, drugId),
        inArray(parameterEntries.parameter, [...SUMMARIZED_PARAMETER_IDS]),
      ),
    );
  if (rows.length === 0) return { summaries: {}, routeSummaries: {} };

  // Grouped by (parameter, route) so a route-scoped entry pools ONLY with the other entries for
  // its own route — the drug-level pool stays route-null exactly as `loadEntryValuesForParameter`
  // and the `drug_parameters` cache define it, and the two can never disagree.
  const byParam = new Map<string, ParameterEntryValue[]>();
  const groupKey = (parameter: string, route: string | null) =>
    route ? `${parameter}\u0000${route}` : parameter;
  for (const r of rows) {
    const key = groupKey(r.parameter, r.route);
    const list = byParam.get(key) ?? [];
    list.push({
      entryId: r.entryId,
      citationId: r.citationId,
      low: toNum(r.low),
      high: toNum(r.high),
      median: toNum(r.median),
      centralValue: toNum(r.centralValue),
      intervalKind: r.intervalKind,
      qualifier: r.qualifier,
      unit: r.unit,
      matrix: r.matrix as ReferenceMatrix | null,
      n: r.n,
      origin: r.origin,
      reviewScore: r.reviewScore ?? null,
    });
    byParam.set(key, list);
  }

  const { bloodPlasmaRatio, molecularWeight } =
    await readAggregationContextInputs(drugId);
  const summaries: Record<string, ParameterSummary> = {};
  const routeSummaries: Record<string, Record<string, ParameterSummary>> = {};
  for (const [key, entries] of byParam) {
    const [parameter, route] = key.split('\u0000') as [string, string | undefined];
    if (!isDrugParameterId(parameter)) continue;
    const summary = aggregateEntries(entries, {
      targetUnit: getRangeSpec(parameter).canonicalUnit,
      bloodPlasmaRatio: bloodPlasmaRatio as never,
      molecularWeight,
      matrixRelevant: parameterIsMatrixRelevant(parameter),
      valueBounds: getRangeSpec(parameter).bounds,
    });
    if (!summary) continue;
    if (route) (routeSummaries[parameter] ??= {})[route] = summary;
    else summaries[parameter] = summary;
  }
  return { summaries, routeSummaries };
}

/** The drug-level summaries alone — the pre-CV-2c shape, for callers that want only those. */
export async function getParameterSummariesForDrug(
  drugId: number,
): Promise<Record<string, ParameterSummary>> {
  return (await getParameterSummariesWithRoutes(drugId)).summaries;
}

/** Pull the normalization inputs out of an already-loaded parameter map. */
function normalizationInputsFrom(paramMap: Map<string, unknown>): {
  bloodPlasmaRatio: unknown;
  molecularWeight: number | null;
} {
  const mwRaw = paramMap.get('molecularWeight');
  return {
    bloodPlasmaRatio: paramMap.get('bloodPlasmaRatio') ?? null,
    molecularWeight: typeof mwRaw === 'number' ? mwRaw : null,
  };
}

/** Read the drug's blood:plasma ratio and molecular weight for normalization. */
async function readAggregationContextInputs(
  drugId: number,
): Promise<{ bloodPlasmaRatio: unknown; molecularWeight: number | null }> {
  return normalizationInputsFrom(await getDrugParameterMap(getDb(), drugId));
}

/**
 * Aggregate a parameter's entries into a summary (no DB writes). Pass
 * `paramMap` when the caller already holds the drug's parameter map so the
 * normalization inputs (blood:plasma ratio, molecular weight) are not re-read
 * per parameter during a sweep.
 */
export async function computeParameterSummary(
  drugId: number,
  parameter: DrugParameterId,
  paramMap?: Map<string, unknown>,
  preloadedEntries?: ParameterEntryValue[],
): Promise<ParameterSummary | null> {
  const entries =
    preloadedEntries ?? (await loadEntryValuesForParameter(drugId, parameter));
  if (entries.length === 0) return null;
  const { bloodPlasmaRatio, molecularWeight } = paramMap
    ? normalizationInputsFrom(paramMap)
    : await readAggregationContextInputs(drugId);
  return aggregateEntries(entries, {
    targetUnit: getRangeSpec(parameter).canonicalUnit,
    bloodPlasmaRatio: bloodPlasmaRatio as never,
    molecularWeight,
    matrixRelevant: parameterIsMatrixRelevant(parameter),
    valueBounds: getRangeSpec(parameter).bounds,
  });
}

/**
 * Recompute a parameter's aggregate and cache it onto `drug_parameters`,
 * recording a revision. Grandfather rule: when there are no entries (or nothing
 * pools numerically), the existing hand-authored value is LEFT UNTOUCHED — the
 * cache is only overwritten when the entries actually produce a value.
 *
 * Call inside the same transaction as the entry mutation so entry-write +
 * cache-write commit atomically.
 */
/**
 * Coded revision summaries (not English prose) for the auto-generated cache
 * revisions. ParameterHistoryDialog translates these at the React boundary so a
 * Norwegian reviewer doesn't see hardcoded English. Kept stable; the recompute
 * count is appended after the colon.
 */
import {
  CACHE_REVISION_CLEARED_CODE,
  CACHE_REVISION_RECOMPUTED_CODE,
} from './cache-revision-codes.js';
export { CACHE_REVISION_CLEARED_CODE, CACHE_REVISION_RECOMPUTED_CODE };

/**
 * Recognized `reason` codes a caller can attach to a recompute, appended
 * after the pooled count (`auto:param_entries_recomputed:3:citation_cleanup`).
 * ParameterHistoryDialog translates each one; an unrecognized code (there
 * shouldn't be one, this is the only producer) falls back to the untranslated
 * summary rather than hiding the count.
 */
export type RecomputeReason = 'citation_cleanup';

export interface SourceDiffEntry {
  citationId: number;
  /** Best-effort citation title, captured at diff time; null if unresolvable. */
  label: string | null;
}

export interface SourceDiff {
  added: SourceDiffEntry[];
  removed: SourceDiffEntry[];
}

async function fetchPreviousReferenceIds(
  drugId: number,
  parameter: string,
): Promise<number[]> {
  const [latest] = await getDb()
    .select({ referenceIds: drugParameterRevisions.referenceIds })
    .from(drugParameterRevisions)
    .where(
      and(
        eq(drugParameterRevisions.drugId, drugId),
        eq(drugParameterRevisions.parameter, parameter),
      ),
    )
    .orderBy(desc(drugParameterRevisions.id))
    .limit(1);
  return latest?.referenceIds ?? [];
}

/** Both sides are sorted ascending (see `sameContributingCitations`). */
function contributingCitationsUnchanged(prev: number[], next: number[]): boolean {
  return prev.length === next.length && prev.every((id, i) => id === next[i]);
}

/**
 * Exported so `scripts/backfill-parameter-revision-source-diff.ts` (#1378) can
 * derive the same label for a citation row recovered from a deletion backup
 * file, which has the same `{identifier, metadata}` shape as the live table
 * but no longer has a row here for `labelsForCitations` to find.
 */
export function citationLabel(citation: { identifier: string; metadata: unknown }): string {
  const meta = citation.metadata;
  if (meta && typeof meta === 'object' && 'title' in meta) {
    const title = (meta as { title?: unknown }).title;
    if (typeof title === 'string' && title.trim()) return title;
  }
  return citation.identifier;
}

/**
 * Labels for whichever of the given citation ids still exist. A citation the
 * caller already deleted (e.g. the hallucinated-citation cleanup, which drops
 * the row before recomputing) resolves to no entry here — the diff still
 * records its id, just with `label: null`.
 */
async function labelsForCitations(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await getDb()
    .select({
      id: citations.id,
      identifier: citations.identifier,
      metadata: citations.metadata,
    })
    .from(citations)
    .where(inArray(citations.id, ids));
  return new Map(rows.map((r) => [r.id, citationLabel(r)]));
}

/**
 * Which citation ids entered/left a contributing set, with no label lookup.
 * Exported so the backfill script (#1378) can reuse the exact set logic
 * `computeSourceDiff` uses live, then resolve labels its own way — including
 * a citation the live table can no longer answer for at all.
 */
export function diffContributingCitationIds(
  prevReferenceIds: number[],
  nextReferenceIds: number[],
): { addedIds: number[]; removedIds: number[] } {
  const prevSet = new Set(prevReferenceIds);
  const nextSet = new Set(nextReferenceIds);
  return {
    addedIds: nextReferenceIds.filter((id) => !prevSet.has(id)),
    removedIds: prevReferenceIds.filter((id) => !nextSet.has(id)),
  };
}

/**
 * Diffs the previous revision's contributing citations against the newly
 * computed set, for `drug_parameter_revisions.source_diff` (#1358 — the edit
 * history didn't say which sources a recompute dropped or gained). Returns
 * null when the contributing set is unchanged, so a revision written for an
 * unrelated reason (the value moved, the entries didn't) doesn't carry a
 * misleadingly empty diff object.
 */
async function computeSourceDiff(
  prevReferenceIds: number[],
  nextReferenceIds: number[],
): Promise<SourceDiff | null> {
  const { addedIds, removedIds } = diffContributingCitationIds(
    prevReferenceIds,
    nextReferenceIds,
  );
  if (addedIds.length === 0 && removedIds.length === 0) return null;
  const labels = await labelsForCitations([...addedIds, ...removedIds]);
  return {
    added: addedIds.map((citationId) => ({
      citationId,
      label: labels.get(citationId) ?? null,
    })),
    removed: removedIds.map((citationId) => ({
      citationId,
      label: labels.get(citationId) ?? null,
    })),
  };
}

/**
 * Whether a freshly derived cache value is identical to the stored one. Compared
 * field-by-field over the NumericRange the aggregate produces (the `note` is
 * derived from pooledCount, so it moves whenever the pool does).
 */
/**
 * The source-entry count the currently-cached aggregate was pooled from, read
 * back out of its `note` (the only place that count survives between
 * recomputes — see `summaryToNumericRange`). Null for a hand-authored value or
 * one this store hasn't produced yet, so a revision's editSummary never
 * fabricates a "from N" that wasn't actually the prior state.
 */
function priorPooledCount(existing: unknown): number | null {
  if (!isAggregateCacheValue(existing)) return null;
  const note = (existing as { note?: unknown }).note;
  if (typeof note !== 'string') return null;
  const match = note.match(
    new RegExp(`^${AGGREGATE_NOTE_PREFIX} (\\d+) source entr`),
  );
  return match ? Number(match[1]) : null;
}

function sameCachedValue(existing: unknown, next: NumericRange): boolean {
  const a = existing as Record<string, unknown> | null;
  if (!a) return false;
  const keys: (keyof NumericRange)[] = ['min', 'max', 'median', 'unit', 'note'];
  return keys.every((k) => a[k as string] === next[k]);
}

/**
 * Whether the newly derived aggregate credits exactly the citations the last
 * revision recorded.
 *
 * The provenance can move while the NUMBER does not: swap an entry's citation
 * for a different paper reporting the same value and the pooled median, bounds
 * and source count are all unchanged. Skipping the revision then would strand
 * the new citation — `referenceIds` on the revision chain is what
 * `collectParameterCitationUsageForDrug` reads to answer "which parameter cites
 * this reference?", so the reference would never appear as used. Compare both
 * before treating a recompute as a no-op.
 */
export async function recomputeAndCacheParameterSummary(
  drugId: number,
  parameter: DrugParameterId,
  actorUserId: number,
  // Set to the approved pending edit's id when this recompute is driven by a
  // reviewed param_entry, so the resulting revision is linked (pending_edit_id)
  // and the scheduled peer sweep can pick it up for post-publication review.
  pendingEditId: number | null = null,
  // Attaches a machine-readable cause to the revision's edit summary
  // (`…:3:citation_cleanup`), for a recompute triggered by something other
  // than the ordinary entry-write path (right now, only the hallucinated-
  // citation cleanup script). Left null for every other caller.
  reason: RecomputeReason | null = null,
): Promise<number | null> {
  if (!parameterIsSummarizable(parameter)) return null;

  const db = getDb();

  // A pair with no defined quantity — marked by an editor, or ruled out by the
  // substance's class — publishes no cached aggregate. Skipped rather than
  // thrown because a single entry write cascades a recompute across every
  // summarizable parameter on the drug (a blood:plasma-ratio change restales
  // them all), so throwing here would let one excluded parameter block the
  // recompute of its siblings. The entry endpoint rejects new entries on such
  // a pair up front, so reaching this means a pre-existing entry or a
  // marker/reclassification added after the fact; in both cases the
  // applicability rule wins and no value is published.
  if (await parameterWriteBlockedBy(db, drugId, parameter)) return null;
  // Every recompute path funnels through here, so taking the drug lock at this
  // one point gives the whole subsystem a single, always-first lock: a second
  // transaction waits until the first commits and then reads its entries and
  // its normalization inputs, rather than caching a summary that omits them.
  await lockDrugForRecompute(drugId);

  // One read of the drug's parameter map serves both the normalization inputs
  // and the current value, instead of one query per purpose per parameter.
  const paramMap = await getDrugParameterMap(db, drugId);
  const entries = await loadEntryValuesForParameter(drugId, parameter);
  const summary = await computeParameterSummary(
    drugId,
    parameter,
    paramMap,
    entries,
  );
  const value = summary ? summaryToNumericRange(summary) : null;
  const existing = paramMap.get(parameter) ?? null;
  const prevReferenceIds = await fetchPreviousReferenceIds(drugId, parameter);

  // The grandfather rule, enforced against the synthetic rows themselves. A
  // `grandfathered` entry is a migration artifact minted from whatever value was
  // authored at the time — not a source. Publishing it as an aggregate would
  // reinstate that migrated number over any authored value written since (the
  // importers and seeders still write `drug_parameters` directly, even though
  // the edit routes no longer let a curator author one for these parameters).
  // Only overwrite a value we derived ourselves; leave an authored value in
  // place until a real source entry exists to supersede it.
  const hasRealSource = entries.some((e) => e.origin !== 'grandfathered');
  if (!hasRealSource && !isAggregateCacheValue(existing)) return null;

  if (!value) {
    // No poolable entries remain. If the current value is a cache WE produced,
    // clear it so a stale aggregate doesn't keep driving the table/simulator; a
    // genuinely hand-authored value (grandfather rule) is left untouched.
    if (!isAggregateCacheValue(existing)) return null;
    await upsertDrugParameter(db, drugId, parameter, null, actorUserId);
    const clearedDiff = await computeSourceDiff(prevReferenceIds, []);
    const [cleared] = await db
      .insert(drugParameterRevisions)
      .values({
        drugId,
        parameter,
        oldValue: existing as never,
        newValue: null,
        editSummary: reason
          ? `${CACHE_REVISION_CLEARED_CODE}:${reason}`
          : CACHE_REVISION_CLEARED_CODE,
        sourceDiff: clearedDiff as never,
        pendingEditId,
        createdBy: actorUserId,
      })
      .returning({ id: drugParameterRevisions.id });
    return cleared?.id ?? null;
  }

  // value non-null implies summary non-null; assert for the type checker.
  if (!summary) return null;
  // Nothing moved: the cache we already published is exactly what this pass
  // computed. Skip the write so a sweep over every summarizable parameter (a
  // blood:plasma-ratio change restales them all) doesn't spray identical
  // no-op revisions across the drug's history. Only a value WE derived can be
  // compared this way — a hand-authored one must still be replaced by the cache.
  if (
    isAggregateCacheValue(existing) &&
    sameCachedValue(existing, value) &&
    contributingCitationsUnchanged(prevReferenceIds, summary.contributingCitationIds)
  ) {
    return null;
  }
  await upsertDrugParameter(db, drugId, parameter, value, actorUserId);
  const sourceDiff = await computeSourceDiff(
    prevReferenceIds,
    summary.contributingCitationIds,
  );
  // Note the prior source count alongside the new one whenever it moved, so
  // the history dialog can say "6 → 3" instead of just "3" — the question
  // "how did we go from 6 sources to 3?" (#1358) is unanswerable from the new
  // count alone once the dropped entries are gone.
  const fromCount = priorPooledCount(existing);
  const editSummaryBase =
    fromCount !== null && fromCount !== summary.pooledCount
      ? `${CACHE_REVISION_RECOMPUTED_CODE}:${summary.pooledCount}:from:${fromCount}`
      : `${CACHE_REVISION_RECOMPUTED_CODE}:${summary.pooledCount}`;
  const editSummary = reason ? `${editSummaryBase}:${reason}` : editSummaryBase;
  const [rev] = await db
    .insert(drugParameterRevisions)
    .values({
      drugId,
      parameter,
      oldValue: existing as never,
      newValue: value as never,
      editSummary,
      referenceIds: summary.contributingCitationIds.length
        ? summary.contributingCitationIds
        : null,
      sourceDiff: sourceDiff as never,
      pendingEditId,
      createdBy: actorUserId,
    })
    .returning({ id: drugParameterRevisions.id });
  return rev?.id ?? null;
}

/**
 * Parameters whose value is a normalization input for the aggregate cache
 * (blood:plasma ratio, molecular weight). Changing one restales every
 * summarizable parameter's cached value, so callers recompute after editing them.
 */
const NORMALIZATION_INPUT_PARAMS = new Set(['bloodPlasmaRatio', 'molecularWeight']);

export function isNormalizationInput(parameter: string): boolean {
  return NORMALIZATION_INPUT_PARAMS.has(parameter);
}

/**
 * Recompute a parameter's cached aggregate AND anything downstream of it.
 *
 * The blood:plasma ratio is itself entry-backed now, and it is also the scaling
 * factor every concentration aggregate normalizes serum/plasma values with. So a
 * source entry on B/P moves not just B/P's own cached value but every
 * concentration summary for that drug — recompute those too, or the table and
 * simulator keep consuming aggregates computed with the previous ratio.
 *
 * Returns the revision id for the parameter's OWN recompute (the caller stamps
 * approvals on it); the cascaded revisions are stamped here via `opts`.
 */
export async function recomputeParameterAndDependents(
  drugId: number,
  parameter: DrugParameterId,
  actorUserId: number,
  opts?: { pendingEditId?: number | null; approvedBy?: number },
): Promise<number | null> {
  const revisionId = await recomputeAndCacheParameterSummary(
    drugId,
    parameter,
    actorUserId,
    opts?.pendingEditId ?? null,
  );
  if (isNormalizationInput(parameter)) {
    // recomputeSummariesForDrug re-runs this parameter too; that pass is a
    // no-op (the value it just cached is what it recomputes) and the cascade
    // is not re-entered, so there is no recursion.
    await recomputeSummariesForDrug(drugId, actorUserId, {
      pendingEditId: opts?.pendingEditId ?? undefined,
      approvedBy: opts?.approvedBy,
    });
  }
  return revisionId;
}

/**
 * Whether ANY `parameter_entries` row exists for this pair, synthetic
 * `origin='grandfathered'` rows included.
 *
 * The inclusion is the point. The applicability marker asks "would the UI still
 * show a source value for a pair I am about to declare undefined?" — and
 * `GET /api/parameter-entries` returns grandfathered rows, so a pair whose only
 * entry is grandfathered would be marked and still render a numeric entry
 * underneath the marker. Excluding them (as the aggregation itself does, once a
 * real source exists) would answer a different question than the one the marker
 * is asking.
 */
export async function hasAnyEntryForParameter(
  drugId: number,
  parameter: string,
): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: parameterEntries.id })
    .from(parameterEntries)
    .where(
      and(
        eq(parameterEntries.drugId, drugId),
        eq(parameterEntries.parameter, parameter),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Recompute every summarizable parameter's cached aggregate for a drug. When the
 * recompute is driven by an approved edit (a normalization-input change), pass
 * `opts` so each derived revision is linked to that edit (pending_edit_id) and
 * carries the same reviewer/author approvals — otherwise those revisions would
 * become unapproved level-0 rows invisible to the peer sweep.
 */
export async function recomputeSummariesForDrug(
  drugId: number,
  actorUserId: number,
  opts?: { pendingEditId?: number; approvedBy?: number },
): Promise<void> {
  // Held across staleableParametersForDrug as well as the recomputes: the set of
  // parameters to touch is read from committed state, so it must not be decided
  // while another transaction is still inserting a drug's first entry for one.
  await lockDrugForRecompute(drugId);
  for (const parameter of await staleableParametersForDrug(drugId)) {
    const revisionId = await recomputeAndCacheParameterSummary(
      drugId,
      parameter,
      actorUserId,
      opts?.pendingEditId ?? null,
    );
    if (revisionId == null) continue;
    if (opts?.approvedBy != null) {
      await recordApproval({
        targetType: 'drug_parameter_revision',
        targetId: revisionId,
        approvedBy: opts.approvedBy,
      });
    }
    // Stamp the author's own stake regardless of who (if anyone) approved: a
    // derived revision with no approval at all sits as an unapproved level-0
    // row invisible to the peer sweep. No-op for a non-agent author.
    await recordImplicitAgentApproval({
      userId: actorUserId,
      targetType: 'drug_parameter_revision',
      targetId: revisionId,
    });
  }
}

/**
 * The summarizable parameters a normalization change can actually move for this
 * drug: the ones with source entries, plus any whose current value is a cache we
 * derived (so an emptied entry set still gets its stale aggregate cleared).
 *
 * Sweeping the whole registry instead would spend an advisory lock, an entry
 * query and a parameter-map read on ~20 parameters that have no entries and
 * would return immediately — and that cost grows with every parameter added to
 * the registry. Two queries here replace most of those round trips.
 */
async function staleableParametersForDrug(
  drugId: number,
): Promise<DrugParameterId[]> {
  const db = getDb();
  const [withEntries, paramMap] = await Promise.all([
    db
      .selectDistinct({ parameter: parameterEntries.parameter })
      .from(parameterEntries)
      .where(eq(parameterEntries.drugId, drugId)),
    getDrugParameterMap(db, drugId),
  ]);
  const entryParams = new Set(withEntries.map((r) => r.parameter));
  return SUMMARIZED_PARAMETER_IDS.filter(
    (p) => entryParams.has(p) || isAggregateCacheValue(paramMap.get(p)),
  );
}

/** Distinct (drugId, parameter) pairs that have an entry citing this citation. */
export async function findParametersCitingCitation(
  citationId: number,
): Promise<Array<{ drugId: number; parameter: string }>> {
  return getDb()
    .selectDistinct({
      drugId: parameterEntries.drugId,
      parameter: parameterEntries.parameter,
    })
    .from(parameterEntries)
    .where(eq(parameterEntries.citationId, citationId));
}

/**
 * Recompute the cached aggregate for every summarizable parameter backed by an
 * entry that cites this citation. A paper review's `overall_score` feeds the
 * aggregation weight, so publishing or re-scoring a review can move the pooled
 * value without any entry changing — this keeps the cache consumed by the table
 * and simulator in step with the read-time summary. Runs in the ambient
 * transaction (getDb) so it commits atomically with the review write.
 */
export async function recomputeSummariesCitingCitation(
  citationId: number,
  actorUserId: number,
): Promise<void> {
  // Ascending drug id: this is the one path that locks SEVERAL drugs, so two
  // concurrent re-scores must walk them in the same order or they can deadlock
  // against each other on the per-drug recompute lock.
  const affected = (await findParametersCitingCitation(citationId)).sort(
    (a, b) => a.drugId - b.drugId,
  );
  // A re-score can move the blood:plasma ratio itself, which every concentration
  // aggregate is normalized with — so the drugs whose B/P actually changed need
  // the same dependent sweep an entry mutation triggers, or their serum/plasma
  // concentrations stay scaled by the previous ratio until some unrelated edit
  // happens to refresh them. Collected and run once per drug after the direct
  // recomputes, so a drug with several affected parameters sweeps once.
  const drugsToCascade = new Set<number>();
  for (const { drugId, parameter } of affected) {
    if (isDrugParameterId(parameter) && parameterIsSummarizable(parameter)) {
      const revisionId = await recomputeAndCacheParameterSummary(
        drugId,
        parameter,
        actorUserId,
      );
      // These revisions are produced by an agent's auto-published review (not a
      // reviewed pending edit), so there is no pending_edit_id to link. Stamp the
      // author's implicit approval so the derived value carries the same approval
      // state as the review that caused it, rather than sitting as an unapproved
      // level-0 revision (no-op for a non-agent author).
      if (revisionId != null) {
        await recordImplicitAgentApproval({
          userId: actorUserId,
          targetType: 'drug_parameter_revision',
          targetId: revisionId,
        });
        // A null revision id means the recompute was a no-op — the ratio did
        // not move, so nothing downstream is stale.
        if (isNormalizationInput(parameter)) drugsToCascade.add(drugId);
      }
    }
  }
  for (const drugId of drugsToCascade) {
    await recomputeSummariesForDrug(drugId, actorUserId);
  }
}

// ─── Entry CRUD (Phase 3) ───────────────────────────────────────────────────
// These operate on ANY entry (all origins). Contributor/admin writes create
// rows with origin='contributor'; the caller recomputes the summary afterward.

export interface ParameterEntryRow {
  id: number;
  drugId: number;
  parameter: string;
  /**
   * What the write ACTUALLY left on the row. Returned rather than inferred
   * because the preserved-quote expression is evaluated against the row as it
   * is at write time, which is not necessarily the row a gate read earlier.
   */
  sourceQuote: string | null;
}

function numToStr(v: number | undefined): string | null {
  return v === undefined ? null : String(v);
}

/**
 * The dose-context columns (migration 0127) as a write sets them: every field,
 * absent or null alike written as NULL, numerics bound as strings.
 *
 * Absent means NULL here — not "preserve", which is what `observationContext`
 * and `quote` get on an update. Preserve-when-omitted exists to protect a
 * stored value from a client that predates the field; no client predates the
 * dose fields for the only parameters that may carry them, because dose
 * context is forbidden everywhere else (`validateDoseContext`) and every
 * writer of a dose-context entry is new. A legacy client that edits such an
 * entry omits `valueBasis` and is refused by validation — loudly — rather than
 * silently wiping context.
 *
 * The reported statistic (`centralValue` / `centralStatistic` /
 * `intervalKind`, optional on every parameter since migration 0135) follows
 * the same whole-row rule as the legacy `low`/`high`/`median` it sits beside:
 * an update states the complete reading. It is the reading itself, not
 * context about it, so preserving an omitted centre while the patch moved the
 * bounds would store a combination nobody wrote.
 */
export function doseContextValuesForWrite(
  entry: DoseContextFields,
): Pick<typeof parameterEntries.$inferInsert, DoseContextFieldKey> {
  const out = {} as Record<DoseContextFieldKey, unknown>;
  for (const key of DOSE_CONTEXT_FIELD_KEYS) {
    const value = entry[key];
    out[key] =
      value === undefined || value === null
        ? null
        : NUMERIC_DOSE_CONTEXT_FIELDS.has(key)
          ? String(value)
          : value;
  }
  return out as Pick<typeof parameterEntries.$inferInsert, DoseContextFieldKey>;
}

/**
 * The dose-context half of the duplicate identity: one NULL-safe equality per
 * field, generated from `DOSE_CONTEXT_FIELD_KEYS` so a field cannot be missing
 * from it. Absent and null both mean "not recorded" and match only NULL.
 */
function doseContextIdentity(entry: DoseContextFields): SQL[] {
  return DOSE_CONTEXT_FIELD_KEYS.map((key) => {
    const column = parameterEntries[key];
    const value = entry[key];
    if (value === undefined || value === null) return isNull(column);
    // Cast to the column's own type, which rounds exactly as the write did:
    // a value with more digits than the column keeps must still find the row
    // it was stored as (Codex P1 on #1360).
    return NUMERIC_DOSE_CONTEXT_FIELDS.has(key)
      ? sql`${column} = CAST(${String(value)} AS ${sql.raw(doseContextNumericType(key))})`
      : sql`${column} = ${value}`;
  });
}

/** An entry's dose context as the API returns it; see `SerializedParameterEntry`. */
export type SerializedDoseContext = {
  [K in DoseContextFieldKey]-?: Exclude<DoseContextFields[K], undefined>;
};

/**
 * Read a row's dose-context columns back out, or null when the row carries
 * none — which is every row that is not a dose-context entry, so the legacy
 * response shape grows by one null field rather than twenty-five.
 */
export function serializeDoseContext(
  row: Record<DoseContextFieldKey, unknown>,
): SerializedDoseContext | null {
  let any = false;
  const out = {} as Record<DoseContextFieldKey, unknown>;
  for (const key of DOSE_CONTEXT_FIELD_KEYS) {
    const raw = row[key];
    if (raw !== null && raw !== undefined) any = true;
    out[key] =
      raw === null || raw === undefined
        ? null
        : NUMERIC_DOSE_CONTEXT_FIELDS.has(key)
          ? Number(raw)
          : raw;
  }
  return any ? (out as SerializedDoseContext) : null;
}

/**
 * Whether an EXACT duplicate source observation already exists — same drug,
 * parameter, citation, matrix, scenario, unit, qualifier, and low/high/median.
 * Distinct values are still allowed; an exact re-insert (two contributors, or a
 * retried request) would otherwise be pooled twice and skew the weighted median
 * and IQR. Checked before both direct insertion and approval.
 */
export async function entryDuplicateExists(
  input: ParameterEntryInput,
  // Exclude this entry id (the row being updated) so a self-match isn't a
  // "duplicate" — an update only conflicts with a DIFFERENT identical row.
  excludeId?: number,
): Promise<boolean> {
  return (await findDuplicateEntry(input, excludeId)) != null;
}

/**
 * The stored row an incoming entry would duplicate, with the one field the
 * dedup identity deliberately ignores: its source quote.
 *
 * Exists so a caller that has found a duplicate can still tell whether the
 * incoming item carries provenance the stored row lacks. Dropping an item as
 * "already present" when it would have supplied the missing sentence makes the
 * duplicate check a barrier to the very enrichment it should permit — and for a
 * row written before migration 0119 there is no other route to that sentence.
 */
export async function findDuplicateEntry(
  input: ParameterEntryInput,
  excludeId?: number,
): Promise<{
  id: number;
  sourceQuote: string | null;
  n: number | null;
  comments: string | null;
  observationContext: string | null;
} | null> {
  const db = getDb();
  // The stored form: a dose-context entry's `median` shorthand is compared as
  // the centralValue it will be written as, so the same cohort authored both
  // ways collides instead of being counted twice.
  input = canonicalizeReportedStatistic(input);
  // `numeric(14, 6)`, rounded as the insert rounds it — the same excess-
  // precision miss as the dose-context fields below, on the legacy values.
  const numMatch = (col: AnyColumn, v: number | undefined) =>
    v == null ? isNull(col) : sql`${col} = CAST(${String(v)} AS numeric(14, 6))`;
  const [row] = await db
    .select({
      id: parameterEntries.id,
      sourceQuote: parameterEntries.sourceQuote,
      // Neither of these is part of the dedup identity — two readings of the
      // same number from the same paper are one observation whatever cohort
      // size and study context are recorded against them — but both are
      // returned because a caller attaching a QUOTE to this row needs them. A
      // sentence reporting one cohort is not evidence for a row weighted by
      // another, and a sentence about one dose, route or population is not
      // evidence for a reading recorded under a different one.
      n: parameterEntries.n,
      comments: parameterEntries.comments,
      observationContext: parameterEntries.observationContext,
    })
    .from(parameterEntries)
    .where(
      and(
        eq(parameterEntries.drugId, input.drugId),
        eq(parameterEntries.parameter, input.parameter),
        input.matrix != null
          ? eq(parameterEntries.matrix, input.matrix)
          : isNull(parameterEntries.matrix),
        input.scenario != null
          ? eq(parameterEntries.scenario, input.scenario)
          : isNull(parameterEntries.scenario),
        // Route-scoped entries (CV-2c) for two different routes are distinct
        // observations, so the route is part of what makes two entries "the same".
        input.route != null
          ? eq(parameterEntries.route, input.route)
          : isNull(parameterEntries.route),
        eq(parameterEntries.unit, input.unit),
        input.citationId != null
          ? eq(parameterEntries.citationId, input.citationId)
          : isNull(parameterEntries.citationId),
        input.qualifier != null
          ? eq(parameterEntries.qualifier, input.qualifier)
          : isNull(parameterEntries.qualifier),
        // Model-structure axes (CV-1b) differ only in this categorical value —
        // the numeric columns are all NULL — so it is part of what makes two
        // entries "the same observation" for dedup. An empty string is treated
        // as absent, matching the `|| null` the write path stores.
        input.categoricalValue
          ? eq(parameterEntries.categoricalValue, input.categoricalValue)
          : isNull(parameterEntries.categoricalValue),
        numMatch(parameterEntries.low, input.low),
        numMatch(parameterEntries.high, input.high),
        numMatch(parameterEntries.median, input.median),
        // The complete dose context (Cmax dose-context RFC, *Write surfaces*):
        // two arms of one paper reporting the same Cmax at different doses,
        // regimens or populations are two observations, not a duplicate.
        ...doseContextIdentity(input),
        excludeId != null ? ne(parameterEntries.id, excludeId) : undefined,
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Attach a source quote to an existing entry that has none.
 *
 * Only ever fills a gap: the `IS NULL` guard is in the WHERE clause, so a row
 * that already carries a quote is left alone and this can never silently
 * replace one sentence with another.
 *
 * Reports what actually happened rather than just whether it succeeded. A
 * caller that ignores a failed attach would tell its user the quote was stored
 * when another request had filled the column with something else in between —
 * and "we recorded your provenance" is not a claim to make on a guess. The
 * `current` value lets the caller see what is really there and decide.
 *
 * A direct write to `parameter_entries`, so it carries the obligation every
 * other direct writer has: proposals queued against the row are marked
 * conflicted, in the same unit of work. Without it a contributor's pending
 * update stays approvable and can clear or replace the sentence an admin just
 * reviewed, or its delete can take the row away — and nothing warns the
 * reviewer, because the proposal's review token covers the PROPOSAL, and only
 * the live entry moved. The invariant lives here rather than at the callers for
 * the same reason `insertParameterEntry` owns its applicability check: a caller
 * cannot opt out by forgetting.
 *
 * `withDrugApplicabilityLock` makes the marking and the write one unit and
 * joins a caller's transaction when it has one. The drug has to be read before
 * the lock can be taken — and an entry DOES move between drugs: a merge
 * reassigns every one of the loser's rows to the winner. So the owner is read
 * again under the lock, and a row that moved in between is retried against its
 * new owner rather than written while holding a lock over the drug that used to
 * own it. That lock would protect nothing, and the write would then take the
 * entry row and the `pending_edits` row without the winner's drug lock —
 * rebuilding exactly the ABBA pair against a concurrent approval that these
 * locks exist to prevent.
 *
 * `expected` is what the caller believes the row says — the evidence fields it
 * matched on when it decided this quote belongs here. They are compared inside
 * the WHERE, under the lock, because the id and a NULL quote are not enough to
 * identify an OBSERVATION: a concurrent direct write can move the citation, the
 * reading or the cohort between the moment a caller planned the attach and the
 * moment it runs, and the sentence would then be filed against a reading nobody
 * approved it for. Omitting `expected` keeps the id-only behaviour, for a
 * caller that has no reading to match.
 */
const ENTRY_MOVED = Symbol('entry moved to another drug');

/** The drug that owns this entry right now, or `null` if it is gone. */
async function owningDrugId(id: number): Promise<number | null> {
  const [row] = await getDb()
    .select({ drugId: parameterEntries.drugId })
    .from(parameterEntries)
    .where(eq(parameterEntries.id, id))
    .limit(1);
  return row?.drugId ?? null;
}

export async function attachSourceQuoteIfMissing(
  id: number,
  quote: string,
  expected?: QuoteEvidenceSnapshot,
): Promise<{ attached: boolean; current: string | null }> {
  // A merge can reassign the row between the read and the lock. Bounded rather
  // than unbounded: a merge is a rare administrative act, two in a row against
  // one entry while a single attach is in flight is not a case to spin on, and
  // giving up reports a no-op — the conservative direction, since the quote is
  // simply not attached and the receipt says so.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const drugId = await owningDrugId(id);
    if (drugId == null) return { attached: false, current: null };
    const outcome = await attachUnderDrugLock(id, drugId, quote, expected);
    if (outcome !== ENTRY_MOVED) return outcome;
  }
  return { attached: false, current: await storedQuoteOf(id) };
}

/** What `source_quote` holds right now, for reporting a refusal honestly. */
async function storedQuoteOf(id: number): Promise<string | null> {
  const [row] = await getDb()
    .select({ quote: parameterEntries.sourceQuote })
    .from(parameterEntries)
    .where(eq(parameterEntries.id, id))
    .limit(1);
  return row?.quote ?? null;
}

async function attachUnderDrugLock(
  id: number,
  drugId: number,
  quote: string,
  expected: QuoteEvidenceSnapshot | undefined,
): Promise<{ attached: boolean; current: string | null } | typeof ENTRY_MOVED> {
  return withDrugApplicabilityLock(drugId, async () => {
    // Under the lock, and only now, is the ownership stable. A row that moved
    // is not ours to write while holding the old drug's lock.
    const owner = await owningDrugId(id);
    if (owner == null) return { attached: false, current: null };
    if (owner !== drugId) return ENTRY_MOVED;
    const db = getDb();
    const [updated] = await db
      .update(parameterEntries)
      .set({ sourceQuote: quote, updatedAt: new Date() })
      .where(
        and(
          eq(parameterEntries.id, id),
          isNull(parameterEntries.sourceQuote),
          ...(expected ? quoteEvidenceMatches(expected) : []),
        ),
      )
      .returning({ quote: parameterEntries.sourceQuote });
    if (updated) {
      // Only when the row actually changed: a no-op attach (somebody filled the
      // column first) invalidates nothing, and conflicting proposals over a
      // write that did not happen would be its own small lie.
      await markEntryMutationsConflicted(id);
      return { attached: true, current: updated.quote ?? null };
    }
    const [row] = await db
      .select({ quote: parameterEntries.sourceQuote })
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id))
      .limit(1);
    return { attached: false, current: row?.quote ?? null };
  });
}

export async function insertParameterEntry(
  input: ParameterEntryInput,
  createdBy: number,
  origin = 'contributor',
): Promise<ParameterEntryRow> {
  // Creation is guarded HERE, not only at the callers.
  //
  // An entry is evidence for a value of the quantity, so it cannot be filed
  // against a pair that has none. The endpoint and the approval path each
  // pre-check to produce a specific message, but relying on that was wrong:
  // `scripts/seed-pm-am-ratios.ts` is a third caller that went through neither,
  // and inserted live source rows beside a permanent marker. The recompute
  // would not catch it either — it *skips* an excluded parameter rather than
  // failing — so nothing downstream objected.
  //
  // Same shape as `upsertDrugParameter`: the choke point owns the invariant, so
  // a caller cannot opt out by forgetting. `withDrugApplicabilityLock` makes
  // check-and-insert one unit and joins a caller's transaction when it has one.
  return withDrugApplicabilityLock(input.drugId, async () => {
    const blocked = await parameterWriteBlockedBy(
      getDb(),
      input.drugId,
      input.parameter,
    );
    if (blocked) {
      throw new ParameterNotApplicableError(
        input.drugId,
        input.parameter,
        blocked,
      );
    }
    return insertParameterEntryRow(input, createdBy, origin);
  });
}

async function insertParameterEntryRow(
  rawInput: ParameterEntryInput,
  createdBy: number,
  origin: string,
): Promise<ParameterEntryRow> {
  const db = getDb();
  // A dose-context entry's `median` shorthand is stored as the centralValue it
  // stands for (src/lib/entryDoseContext.ts); a legacy entry is untouched.
  const input = canonicalizeReportedStatistic(rawInput);
  const [row] = await db
    .insert(parameterEntries)
    .values({
      drugId: input.drugId,
      parameter: input.parameter,
      low: numToStr(input.low),
      high: numToStr(input.high),
      median: numToStr(input.median),
      qualifier: input.qualifier ?? null,
      // A categorical model-structure entry (CV-1b) carries its pick-list value
      // here and no numbers; every numeric entry leaves this NULL. `|| null`
      // (not `?? null`) so an empty string from a generic client serializing a
      // blank field normalizes to NULL — otherwise it would persist `''`, which
      // the migration-0109 CHECK rejects for a numeric parameter as an opaque DB
      // error. A categorical value is always non-empty (validated on write).
      categoricalValue: input.categoricalValue || null,
      unit: input.unit,
      matrix: input.matrix ?? null,
      scenario: input.scenario ?? null,
      // Administration route for a route-scoped parameter (CV-2c); NULL for every
      // drug-level parameter. `|| null` normalizes a blank from a generic client.
      route: input.route || null,
      n: input.n ?? null,
      comments: input.comments ?? null,
      observationContext: input.observationContext ?? null,
      // The verbatim text the value was read off (migration 0119). Absent on a
      // proposal written before the field existed, and on a direct write that
      // simply does not supply one — NULL is the honest record of "nobody wrote
      // the sentence down", not a validation failure.
      sourceQuote: canonicalSourceQuote(input.quote) ?? null,
      citationId: input.citationId,
      // Structured dose context (migration 0127). Every field, so an approval
      // persists the complete shape a proposal carries rather than the legacy
      // column list — the truncation release B exists to prevent.
      ...doseContextValuesForWrite(input),
      createdBy,
      origin,
    })
    .returning({
      id: parameterEntries.id,
      drugId: parameterEntries.drugId,
      parameter: parameterEntries.parameter,
      sourceQuote: parameterEntries.sourceQuote,
    });
  if (!row) throw new Error('Failed to insert parameter entry');
  return row;
}

export async function updateParameterEntryRow(
  id: number,
  rawPatch: ParameterEntryPatch,
): Promise<ParameterEntryRow | null> {
  const db = getDb();
  const patch = canonicalizeReportedStatistic(rawPatch);
  const [row] = await db
    .update(parameterEntries)
    .set({
      low: numToStr(patch.low),
      high: numToStr(patch.high),
      median: numToStr(patch.median),
      qualifier: patch.qualifier ?? null,
      // `|| null`: normalize an empty-string categorical field to NULL so a
      // numeric entry never persists `''` (rejected by the 0109 CHECK). See the
      // insert path for the full rationale.
      categoricalValue: patch.categoricalValue || null,
      unit: patch.unit,
      matrix: patch.matrix ?? null,
      scenario: patch.scenario ?? null,
      route: patch.route || null,
      n: patch.n ?? null,
      comments: patch.comments ?? null,
      // Preserve-when-omitted, same rule and same reason as `quote` below:
      // `observationContext` is new, so every integration and cached client
      // written before it existed omits it on every update, and `?? null`
      // would let one of them silently erase context a different (newer)
      // caller recorded. Unlike `quote`, no staleness condition gates the
      // preservation — there is nothing recursive here, just presence.
      observationContext:
        patch.observationContext === undefined
          ? sql`${parameterEntries.observationContext}`
          : patch.observationContext,
      // Three-way, and the third case is the subtle one.
      //
      // An explicit value (text, or null from a blank) is obeyed. An OMITTED
      // quote does not clear: `quote` is new, so every integration and cached
      // client in existence omits it, and treating silence as "delete" would
      // let one of them destroy a sentence nobody can reconstruct.
      //
      // But an omitted quote is only preserved while it is still evidence for
      // what the row says. A quote is evidence for a specific reading OF a
      // specific document; if this patch moves the citation or the numbers and
      // says nothing about the quote, keeping it would present words copied
      // from the old source as though they supported the new value — a
      // fabricated attribution, which is worse than having no quote at all.
      // Clearing is also the safe direction: an unquoted calculation-driving
      // proposal is held for a human rather than auto-published.
      //
      // "What the row says" is every dimension that makes the reading the
      // reading, not just its numbers: route, matrix and scenario define WHICH
      // observation this is. A sentence about an oral dose is not evidence for
      // an intravenous one, and a whole-blood concentration is not a plasma
      // concentration — so moving any of them detaches the quote exactly as
      // moving the numbers does. `n` counts too: a sentence reporting "in 12
      // participants" is not evidence for a reading filed as n=24, and the
      // sample size is what weights the row in the pooled aggregate.
      //
      // Decided in SQL so the comparison is against the row actually being
      // written, atomically, rather than against a copy read a moment earlier.
      sourceQuote: effectiveQuoteExpr(patch),
      citationId: patch.citationId,
      // Whole-row replacement, absent meaning NULL — see
      // `doseContextValuesForWrite` for why that is safe here.
      ...doseContextValuesForWrite(patch),
      updatedAt: new Date(),
    })
    .where(eq(parameterEntries.id, id))
    .returning({
      id: parameterEntries.id,
      drugId: parameterEntries.drugId,
      parameter: parameterEntries.parameter,
      sourceQuote: parameterEntries.sourceQuote,
    });
  return row ?? null;
}

/**
 * The SQL deciding whether an OMITTED quote survives this patch: the stored
 * quote when every dimension it is evidence for is unchanged, NULL otherwise.
 *
 * The columns compared are `SOURCE_QUOTE_EVIDENCE_FIELDS`
 * (src/lib/parameterEntries.ts) — the same list `withoutStaleEntryQuote` uses,
 * named once there so the two cannot drift. `comments` is absent from it on
 * purpose: curator notes are commentary, not part of what the sentence attests.
 *
 * A builder rather than an inline expression because two callers need the same
 * answer — the update itself, and the consensus gate asking what the quote will
 * BE after the update. Two copies of this predicate would drift, and a gate
 * disagreeing with the write it is gating is worse than either being wrong
 * alone.
 */
const QUOTE_EVIDENCE_COLUMNS = {
  citationId: parameterEntries.citationId,
  unit: parameterEntries.unit,
  low: parameterEntries.low,
  high: parameterEntries.high,
  median: parameterEntries.median,
  qualifier: parameterEntries.qualifier,
  categoricalValue: parameterEntries.categoricalValue,
  route: parameterEntries.route,
  matrix: parameterEntries.matrix,
  scenario: parameterEntries.scenario,
  n: parameterEntries.n,
  observationContext: parameterEntries.observationContext,
  ...(Object.fromEntries(
    DOSE_CONTEXT_FIELD_KEYS.map((key) => [key, parameterEntries[key]]),
  ) as unknown as Record<DoseContextFieldKey, AnyColumn>),
} satisfies Record<(typeof SOURCE_QUOTE_EVIDENCE_FIELDS)[number], AnyColumn>;

/** The numeric columns, which need an explicit cast to compare against a bound string. */
const NUMERIC_EVIDENCE_FIELDS: ReadonlySet<string> = new Set([
  'low',
  'high',
  'median',
  ...NUMERIC_DOSE_CONTEXT_FIELDS,
]);

/** An evidence numeric's column type: `numeric(14, 6)` unless the dose context says otherwise. */
function evidenceNumericType(field: string): string {
  return NUMERIC_DOSE_CONTEXT_FIELDS.has(field as DoseContextFieldKey)
    ? doseContextNumericType(field as DoseContextFieldKey)
    : 'numeric(14, 6)';
}

export type QuoteEvidenceValues = Partial<
  Record<(typeof SOURCE_QUOTE_EVIDENCE_FIELDS)[number], unknown>
> & {
  /**
   * Only ever supplied by a caller MATCHING a row, never by the update's own
   * preserve rule (`preservedQuoteExpr`) — which excludes `comments`
   * deliberately, because curator notes are commentary and editing them must
   * not cost an entry its provenance. Nothing currently supplies this key: the
   * conversation ingestion used to, before #1257 gave it its own structured
   * `observationContext` column (already in `SOURCE_QUOTE_EVIDENCE_FIELDS`, so
   * that need is covered without this escape hatch) — kept for a future
   * caller with its own reason to pin unchanged commentary as part of what it
   * matched.
   */
  comments?: string | null;
};

/**
 * Every evidence field, all of them required — what a caller MATCHING a stored
 * observation must pin.
 *
 * Partial is right for `preservedQuoteExprFor`, whose caller is a writer and
 * whose omissions mean "I do not touch this". It is wrong here, and the two
 * uses sharing one permissive type is what let the gap open: a matcher's
 * omission means "I did not think about this", and an unpinned dimension is one
 * a concurrent direct write can move while the guarded WHERE still matches —
 * filing an approved sentence against a different observation. `route` was
 * omitted from the ingestion's snapshot exactly that way, silently, because
 * nothing could object.
 *
 * Total, so nothing can be omitted silently again: leave a field out and it is
 * a type error, and a matcher that genuinely expects NULL says `null` rather
 * than saying nothing. The value is the same either way; what changes is that
 * the caller had to mean it.
 *
 * No `comments` here, unlike `QuoteEvidenceValues`: every evidence field a
 * matcher must pin is already required through `SOURCE_QUOTE_EVIDENCE_FIELDS`
 * (which includes `observationContext`), and `comments` was never one of
 * them.
 */
export type QuoteEvidenceSnapshot = Record<
  (typeof SOURCE_QUOTE_EVIDENCE_FIELDS)[number],
  unknown
>;

/**
 * The stored quote, but only while every evidence field this writer TOUCHES
 * still matches what it is about to write; NULL otherwise.
 *
 * A field the caller omits is one it does not change, so it is not compared —
 * which is the difference between the two writers of this table. The entry
 * update replaces the whole row and therefore passes all eleven (an absent
 * patch key means null there, not "leave alone"). The legacy
 * reference-concentration endpoint writes only the concentration's own fields
 * and leaves `qualifier`, `categoricalValue` and `route` as they are —
 * comparing those against nothing would detach a perfectly good quote from a
 * row that happens to carry one.
 */
export function preservedQuoteExprFor(values: QuoteEvidenceValues) {
  // Never the `comments` key: this decides what an UPDATE preserves, and
  // curator notes are outside what a quote attests to. Only a caller matching a
  // row passes it (see `QuoteEvidenceValues`).
  const { comments: _excluded, ...evidence } = values;
  const comparisons = quoteEvidenceMatches(evidence);
  if (comparisons.length === 0) return sql`${parameterEntries.sourceQuote}`;
  return sql`CASE WHEN ${sql.join(comparisons, sql` AND `)}
                THEN ${parameterEntries.sourceQuote} ELSE NULL END`;
}

/**
 * The same comparisons as `preservedQuoteExprFor`, as WHERE predicates.
 *
 * One list of fields, two shapes: the update needs them inside a CASE to decide
 * what to write, a guarded write needs them in its WHERE to decide whether to
 * write at all. Built from the same map so a field cannot be in one and not the
 * other.
 */
export function quoteEvidenceMatches(values: QuoteEvidenceValues): SQL[] {
  const matches = SOURCE_QUOTE_EVIDENCE_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(values, field),
  ).map((field) => {
    const column = QUOTE_EVIDENCE_COLUMNS[field];
    // Same rule as the writer: a caller's blank is the row's NULL for the
    // fields written that way, so a predicate built from a payload compares
    // against what the column will actually hold.
    const value = storedEvidenceValue(field, values[field]);
    // Cast to the column's own type, which rounds as the write does: a patch
    // repeating a stored value with excess digits is the same evidence, and
    // must not detach the quote (Codex P1 on #1360).
    return NUMERIC_EVIDENCE_FIELDS.has(field)
      ? sql`${column} IS NOT DISTINCT FROM CAST(${value} AS ${sql.raw(evidenceNumericType(field))})`
      : sql`${column} IS NOT DISTINCT FROM ${value}`;
  });
  if (Object.prototype.hasOwnProperty.call(values, 'comments')) {
    matches.push(
      sql`${parameterEntries.comments} IS NOT DISTINCT FROM ${values.comments ?? null}`,
    );
  }
  return matches;
}

/**
 * `sourceQuoteComparisonKey` (src/lib/parameterEntries.ts), in SQL, for a
 * stored quote column.
 *
 * Two quotes that render identically are the same sentence, and there are two
 * ways for one sentence to have two spellings: an invisible joiner, and a
 * differently-composed character. Both reach the database through ordinary
 * copy-paste, because storage deliberately keeps the source's own text.
 *
 * Every SQL site that asks "are these the same sentence?" has to ask it the
 * same way — the update deciding whether a stated quote is an echo, and the
 * merge deciding whether two rows disagree. Written once here rather than
 * inlined per query: a second copy is how one site starts recognising an echo
 * that another calls a conflict, and the two answers are both defensible in
 * isolation and incoherent together.
 *
 * `normalize(..., NFC)` is Postgres's own implementation of the standard
 * `String.prototype.normalize` implements, so the SQL and JS forms agree by
 * construction. The confusable fold agrees for a stronger reason: both sides
 * are driven by the SAME table (`CONFUSABLE_FOLD` in src/lib/parameterEntries),
 * exported as the two strings `translate()` takes, so a character added to it
 * changes both forms at once and neither can be edited into disagreeing.
 *
 * NULL through all three functions is NULL, so a row with no quote compares as
 * having none rather than as a distinct sentence.
 */
export function sourceQuoteComparisonKeySql(column: SQL | AnyColumn): SQL {
  return sql`translate(normalize(regexp_replace(${column}, '[\u200C\u200D]', '', 'g'), NFC), ${CONFUSABLE_FOLD_FROM}, ${CONFUSABLE_FOLD_TO})`;
}

/**
 * What this patch leaves in `source_quote` — the whole rule, in one expression.
 *
 * Three cases, and the third is the one presence alone gets wrong:
 *
 *  - the patch says nothing → the stored quote survives while the evidence it
 *    attests to does, and is cleared otherwise;
 *  - the patch states a DIFFERENT sentence → the author is asserting new
 *    evidence for the new payload, and it is obeyed;
 *  - the patch states the sentence already stored → that asserts nothing. It is
 *    an echo, whatever it cost the sender to type, and it goes back through the
 *    preserve-or-clear rule. Treating it as a fresh assertion is a bypass of
 *    the whole guard: change the reading, copy the old quote into the payload,
 *    and the staleness comparison never runs.
 *
 * Compared canonically, against the row as it is being written, so a re-wrapped
 * copy of the stored sentence is recognised as the echo it is.
 */
function effectiveQuoteExpr(patch: ParameterEntryPatch) {
  if (patch.quote === undefined) return preservedQuoteExpr(patch);
  const stated = canonicalSourceQuote(patch.quote) ?? null;
  // Compared on the COMPARISON key, not the stored text: a joiner appended to
  // the stored sentence is invisible, and a differently-composed `é` is
  // identical on screen, so either would otherwise make an echo look newly
  // authored and skip the staleness check entirely.
  //
  // The column gets the SAME treatment, through `sourceQuoteComparisonKeySql`
  // — a comparison is only as good as whichever side an attacker does not
  // control, and the stored text is whatever spelling its source used: rows
  // written before this rule existed were never composed on the way in. Both
  // sides are NULL-safe, so a row with no quote still matches a stated `null`.
  const statedKey =
    stated === null ? null : sourceQuoteComparisonKey(stated) || null;
  return sql`CASE WHEN ${sourceQuoteComparisonKeySql(parameterEntries.sourceQuote)} IS NOT DISTINCT FROM ${statedKey}
                THEN (${preservedQuoteExpr(patch)}) ELSE ${stated} END`;
}

function preservedQuoteExpr(patch: ParameterEntryPatch) {
  // Every field, explicitly: this writer replaces the whole row, so an absent
  // patch key means NULL rather than "unchanged".
  // Through `storedEvidenceValue` rather than a per-field `?? null` / `|| null`
  // spelled out here: that spelling IS the rule the comparisons have to match,
  // and a rule written in two places is a rule that drifts. It drifted — a
  // blank `categoricalValue` was absent to this writer and present to
  // `sourceQuoteEvidenceUnchanged`, so the review card stopped showing an
  // inherited quote the approval would keep.
  return preservedQuoteExprFor({
    citationId: storedEvidenceValue('citationId', patch.citationId),
    unit: patch.unit,
    low: numToStr(patch.low),
    high: numToStr(patch.high),
    median: numToStr(patch.median),
    qualifier: storedEvidenceValue('qualifier', patch.qualifier),
    categoricalValue: storedEvidenceValue(
      'categoricalValue',
      patch.categoricalValue,
    ),
    route: storedEvidenceValue('route', patch.route),
    matrix: storedEvidenceValue('matrix', patch.matrix),
    scenario: storedEvidenceValue('scenario', patch.scenario),
    n: storedEvidenceValue('n', patch.n),
    // Present only when the patch STATES a value, unlike every field above.
    // Those are old and every writer sends them; `observationContext` is new
    // (like `quote`), so an unaware caller omits it, and `preservedQuoteExprFor`
    // treats a key's absence as "this patch says nothing about that field" —
    // excluding it from the comparison entirely — rather than as the column's
    // stored value having been asserted to be NULL. Populating the key
    // unconditionally here would make every omission read as "cleared it",
    // invalidating a perfectly good quote on every update an unaware caller
    // makes, which is the same failure the write above exists to avoid.
    ...(patch.observationContext !== undefined
      ? {
          observationContext: storedEvidenceValue(
            'observationContext',
            patch.observationContext,
          ),
        }
      : {}),
    // Every dose-context field, stated: the update writes them all, absent as
    // NULL (`doseContextValuesForWrite`), so that is what the row will hold.
    ...doseContextValuesForWrite(patch),
  });
}

/**
 * The quote this entry would carry after `patch` is applied.
 *
 * The consensus gate cannot read it off the payload alone: the editor omits an
 * untouched quote on purpose, and the update preserves the stored one when the
 * reading is unchanged. Reading only the payload would classify every such
 * proposal as unquoted and hold it forever — a contributor fixing a typo in the
 * comments on a well-quoted entry could never get it published. So the gate
 * asks the same expression the write uses.
 */
export async function quoteAfterUpdate(
  id: number,
  patch: ParameterEntryPatch,
): Promise<string | null> {
  // The very expression the write uses, evaluated against the same row — not a
  // re-derivation of it. A stated quote is not simply returned: it may be an
  // echo of the stored sentence, which `effectiveQuoteExpr` puts back through
  // the preserve-or-clear rule, and a gate that answered "carries a quote"
  // there would authorize a publication the write then leaves unquoted.
  const db = getDb();
  const [row] = await db
    .select({ quote: effectiveQuoteExpr(canonicalizeReportedStatistic(patch)) })
    .from(parameterEntries)
    .where(eq(parameterEntries.id, id))
    .limit(1);
  return (row?.quote as string | null | undefined) ?? null;
}

export async function deleteParameterEntryRow(
  id: number,
): Promise<ParameterEntryRow | null> {
  const db = getDb();
  const [row] = await db
    .delete(parameterEntries)
    .where(eq(parameterEntries.id, id))
    .returning({
      id: parameterEntries.id,
      drugId: parameterEntries.drugId,
      parameter: parameterEntries.parameter,
      sourceQuote: parameterEntries.sourceQuote,
    });
  return row ?? null;
}

export interface SerializedParameterEntry {
  id: number;
  parameter: string;
  low: number | null;
  high: number | null;
  median: number | null;
  qualifier: string | null;
  /** The declared pick-list value for a model-structure axis (CV-1b); null for numeric entries. */
  categoricalValue: string | null;
  unit: string;
  matrix: string | null;
  scenario: string | null;
  /** Administration route for a route-scoped entry (CV-2c); null for drug-level entries. */
  route: string | null;
  n: number | null;
  comments: string | null;
  /**
   * Facts about the reading itself (dose, fed/fasted state, population, assay
   * method) — part of what a stored source quote is evidence for, unlike
   * `comments`. Null for every entry written before migration 0120, and for
   * one where nobody recorded it since.
   */
  observationContext: string | null;
  /** The verbatim text this entry's value was read off; null when none was recorded. */
  sourceQuote: string | null;
  /**
   * Structured dose context and reported statistic (migration 0127), or null
   * when the entry has none — every entry of a parameter that does not declare
   * dose context. Returned from release B on so an entry written by release C
   * can be read, reviewed and round-tripped faithfully.
   */
  doseContext: SerializedDoseContext | null;
  origin: string;
  citationId: number | null;
  citation: {
    id: number;
    type: string;
    identifier: string;
    metadata: unknown;
  } | null;
}

/**
 * All entries for a drug (every origin), for the multi-value display surface.
 * Optionally narrowed to one parameter. Ordered by parameter then sort order.
 */
export async function listEntriesForDrug(
  drugId: number,
  parameter?: string,
): Promise<SerializedParameterEntry[]> {
  const db = getDb();
  const conditions = [eq(parameterEntries.drugId, drugId)];
  if (parameter) conditions.push(eq(parameterEntries.parameter, parameter));
  const rows = await db
    .select({
      entry: parameterEntries,
      citation: {
        id: citations.id,
        type: citations.type,
        identifier: citations.identifier,
        metadata: citations.metadata,
      },
    })
    .from(parameterEntries)
    .leftJoin(citations, eq(citations.id, parameterEntries.citationId))
    .where(and(...conditions))
    .orderBy(
      asc(parameterEntries.parameter),
      asc(parameterEntries.sortOrder),
      asc(parameterEntries.id),
    );
  const mapped = rows.map(({ entry, citation }) => ({
    id: entry.id,
    parameter: entry.parameter,
    low: toNum(entry.low),
    high: toNum(entry.high),
    median: toNum(entry.median),
    qualifier: entry.qualifier,
    categoricalValue: entry.categoricalValue,
    unit: entry.unit,
    matrix: entry.matrix,
    scenario: entry.scenario,
    route: entry.route,
    n: entry.n,
    comments: entry.comments,
    observationContext: entry.observationContext,
    sourceQuote: entry.sourceQuote,
    doseContext: serializeDoseContext(entry),
    origin: entry.origin,
    citationId: entry.citationId,
    citation: citation && citation.id != null ? citation : null,
  }));
  // Hide a superseded grandfathered placeholder for any parameter that already
  // has a real source, so the displayed source set matches what aggregation
  // pools (see dropSupersededGrandfathered). Keyed by parameter AND route
  // (CV-2c-4): a grandfathered row is always drug-level (route null), and the
  // drug-level aggregate only pools route-null entries, so a route-SPECIFIC real
  // entry must not supersede the route-null grandfathered evidence — that would
  // drop the source row while the drug-level summary still shows its value.
  const scopeKey = (e: { parameter: string; route: string | null }): string =>
    `${e.parameter}\u0000${e.route ?? ''}`;
  const realSourceScopes = new Set(
    mapped.filter((e) => e.origin !== 'grandfathered').map(scopeKey),
  );
  return mapped.filter(
    (e) => e.origin !== 'grandfathered' || !realSourceScopes.has(scopeKey(e)),
  );
}

export interface ParameterEntryContents extends SerializedParameterEntry {
  drugId: number;
}

/**
 * Batch-load the full contents of entries by id (for the review queue). Unlike
 * getParameterEntryRowById this returns the value/matrix/scenario/citation so a
 * reviewer can inspect what an update or delete proposal affects before
 * approving it. Includes drugId so the card can resolve and link the drug.
 */
export async function getParameterEntryContentsByIds(
  ids: number[],
): Promise<Map<number, ParameterEntryContents>> {
  if (ids.length === 0) return new Map();
  const db = getDb();
  const rows = await db
    .select({
      entry: parameterEntries,
      citation: {
        id: citations.id,
        type: citations.type,
        identifier: citations.identifier,
        metadata: citations.metadata,
      },
    })
    .from(parameterEntries)
    .leftJoin(citations, eq(citations.id, parameterEntries.citationId))
    .where(inArray(parameterEntries.id, ids));
  const map = new Map<number, ParameterEntryContents>();
  for (const { entry, citation } of rows) {
    map.set(entry.id, {
      id: entry.id,
      drugId: entry.drugId,
      parameter: entry.parameter,
      low: toNum(entry.low),
      high: toNum(entry.high),
      median: toNum(entry.median),
      qualifier: entry.qualifier,
      categoricalValue: entry.categoricalValue,
      unit: entry.unit,
      matrix: entry.matrix,
      scenario: entry.scenario,
      route: entry.route,
      n: entry.n,
      comments: entry.comments,
      observationContext: entry.observationContext,
      sourceQuote: entry.sourceQuote,
      doseContext: serializeDoseContext(entry),
      origin: entry.origin,
      citationId: entry.citationId,
      citation: citation && citation.id != null ? citation : null,
    });
  }
  return map;
}

export async function getParameterEntryRowById(
  id: number,
): Promise<ParameterEntryRow | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: parameterEntries.id,
      drugId: parameterEntries.drugId,
      parameter: parameterEntries.parameter,
      sourceQuote: parameterEntries.sourceQuote,
    })
    .from(parameterEntries)
    .where(eq(parameterEntries.id, id))
    .limit(1);
  return row ?? null;
}
