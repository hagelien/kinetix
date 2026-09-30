/**
 * Database side of the deep-research importer (#drug-database-bulk-seed).
 *
 * Pure-ish orchestration: given a drizzle handle, a validated
 * NormalizedResearchImport, and an attributing user id, it writes the drug and
 * all of its data. Shared by both entry points — the CLI
 * (scripts/import-research-output.ts, `npm run import:research`) and the
 * admin API endpoint (api/research-import.ts, the browser upload path) — so the
 * terminal and the UI seed a drug through exactly the same code. Keeping it in
 * api/_lib (not scripts/) also lets the PGlite integration suite exercise the
 * whole DB path without the CLI's argument/dotenv/stdin machinery.
 *
 * Every write is idempotent (upsert / insert-if-absent) and, by default,
 * non-destructive toward existing curated values. See the CLI header for the
 * operator-facing contract.
 */
import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  drugs,
  drugParameters,
  drugParameterRevisions,
  drugMetabolismProfiles,
  drugEliminationRoutes,
  drugMetabolites,
  drugReceptorTargets,
  drugEnzymeInteractions,
  parameterEntries,
} from '../../db/schema.js';
import { generateSlug } from './slug.js';
import { buildDrugSearchKey } from '../../src/lib/drugNames.js';
import { normalizeMetabolismName } from '../../src/lib/metabolism.js';
import { findOrCreateEntityBySymbol } from './bioEntityStore.js';
import { resolveCitation } from './citation-store.js';
import {
  mergeAltIds,
  type CitationAltIds,
} from '../../src/lib/citationHandles.js';
import {
  doseContextValuesForWrite,
  recomputeSummariesForDrug,
} from './parameter-entries-store.js';
import { parameterDoseContextMode } from '../../src/lib/drugParameters.js';
import {
  canonicalizeReportedStatistic,
  DOSE_CONTEXT_FIELD_KEYS,
  doseContextIdentityKey,
  roundToScale,
  type DoseContextFieldKey,
} from '../../src/lib/entryDoseContext.js';
import { seedIonizationConstants } from './ionizationConstantsStore.js';
import {
  canonicalSourceQuote,
  sourceQuoteComparisonKey,
  validateEntryForParameter,
} from '../../src/lib/parameterEntries.js';
import { markEntryMutationsConflicted } from './entry-conflicts.js';
import {
  blockedParametersFor,
  withDrugApplicabilityLock,
} from './parameterApplicabilityStore.js';
import { getDb, runInPoolTransaction } from './db.js';
import type {
  NormalizedResearchImport,
  ImportNumericRange,
  ImportParameterSourceValue,
} from '../../src/lib/deepResearchImport.js';

export const RESEARCH_IMPORT_SOURCE = 'deep-research';

/**
 * Structural type for any drizzle handle (neon-http in the CLI, PGlite in the
 * integration suite). Typed loosely on purpose — the query builder is
 * driver-agnostic and the two concrete handle types don't unify.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDb = any;

export interface ImportStats {
  drugId: number;
  drugCreated: boolean;
  citations: number;
  parameters: number;
  parametersSkipped: number;
  pdTargets: number;
  routes: number;
  metabolites: number;
  enzymeInteractions: number;
  /**
   * Parameters whose existing value was kept (non-destructive default) even
   * though the document cited sources for the value it proposed instead.
   *
   * Those citations are deliberately NOT attached to the kept value — they back
   * the number the research agent synthesized, not the one already in the
   * database, and silently crediting them to a different value would fabricate
   * provenance. But dropping them without a word is how a seed run ends with a
   * parameter still flagged "no references" and its papers anchored to nothing,
   * so the operator gets told which parameters those were and can re-run with
   * `--overwrite` (or reconcile by hand).
   */
  keptWithUnattachedSources: Array<{ parameter: string; sources: number }>;
  /**
   * Parameters whose stored value already equalled the researched one and that
   * gained a provenance-only revision carrying this document's citations. No
   * value changed; only the sourcing did.
   */
  sourcesAttachedToUnchanged: number;
  /** `parameter_entries` rows inserted from `sourceValues[]` (#1025). */
  entries: number;
  /** Rows this importer had already written whose reading changed (--overwrite). */
  entriesUpdated: number;
  /** Readings already present, unchanged — what a re-run of the same document hits. */
  entriesSkipped: number;
  /**
   * Readings that differ from a row this importer wrote and were LEFT ALONE
   * because the run was non-destructive. Re-run with `--overwrite` to apply them.
   */
  entriesKept: Array<{ parameter: string; entries: number }>;
  /** Readings rejected by the registry at write time (unit, bounds, matrix). */
  entriesInvalid: Array<{ parameter: string; message: string }>;
  /** Source values whose `sourceId` never became a citation row. */
  entrySourcesUnresolved: number;
  /**
   * Metabolites the document named that the drug already links **under a
   * different spelling** — so nothing from the document's row was imported:
   * not its conversion range, not its note, not its citations.
   *
   * Since 0099 a metabolite link is keyed on the substance, so a paper writing
   * "Benzoylecgonine" where the monograph says "benzoylecgonin" no longer
   * lands as a second row. Not importing it is right — the alternative is the
   * duplicate line this whole change removes — but dropping it in silence is
   * not: the operator would see `metabolites: 0` and read it as an idempotent
   * re-run while a paper's evidence went nowhere. Same reasoning as
   * {@link ImportStats.keptWithUnattachedSources}: the run is non-destructive,
   * and what it declined to write it names.
   */
  metabolitesKept: Array<{ name: string; linkedAs: string }>;
  /** Ionization constants inserted / updated / skipped / kept from `ionizationConstants[]`. */
  ionizationConstants: number;
  ionizationConstantsUpdated: number;
  ionizationConstantsSkipped: number;
  /** Differing constants left untouched (curated row, or research row without --overwrite). */
  ionizationConstantsKept: number;
  /**
   * Parameters the document proposed that are not defined quantities for this
   * substance — an editor marked the pair, or its `substance_class` says it is
   * never administered so it has no bioavailability/dose.
   *
   * Skipped rather than imported, and skipped rather than aborting the run: a
   * document proposing twenty parameters should not fail wholesale because one
   * of them cannot exist. Reported so the operator sees what was dropped —
   * a silent skip would look exactly like the parameter never being in the
   * document. Both the value and its source entries are withheld.
   */
  parametersNotApplicable: string[];
}

/**
 * Extra handles for a source, keyed by its `sourceId` — what an ID-converter
 * lookup found beyond what the document itself declared (#1018). Resolved by
 * the caller (route or CLI), never here: this store makes no network calls, so
 * an import stays deterministic and NCBI's rate ceiling stays out of the DB
 * layer.
 */
export type CitationCrosswalk = Map<string, CitationAltIds>;

export interface RunImportOptions {
  userId: number;
  overwrite: boolean;
  crosswalk?: CitationCrosswalk;
}

/** numeric(…) columns want a string; keep null as null. */
function numStr(v: number | null): string | null {
  return v === null ? null : String(v);
}

function namesJson(data: NormalizedResearchImport): Record<string, string> {
  const names: Record<string, string> = {};
  if (data.drug.nameNb) names.nb = data.drug.nameNb;
  if (data.drug.nameEn) names.en = data.drug.nameEn;
  return names;
}

function measurementJson(r: ImportNumericRange | null): unknown {
  return r ?? null;
}

/**
 * Structural equality for a stored parameter value against a freshly parsed one.
 *
 * The stored side has been through `jsonb`, which does not preserve key order —
 * Postgres normalizes object keys by length then bytewise. Comparing
 * `JSON.stringify` output therefore reports two identical values as different
 * whenever the document happens to order its keys differently from Postgres,
 * which is most of the time. Compare the shapes instead.
 */
function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((item, i) => sameJsonValue(item, b[i]))
    );
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(bo, k) &&
        sameJsonValue(ao[k], bo[k]),
    )
  );
}

function resolveRefIds(
  sourceIds: string[],
  map: Map<string, number>,
): number[] {
  const out: number[] = [];
  for (const sid of sourceIds) {
    const id = map.get(sid);
    if (id != null && !out.includes(id)) out.push(id);
  }
  return out;
}

function escapeSearchKeyLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function exactSearchKeyTermCondition(term: string): SQL {
  const escaped = escapeSearchKeyLikePattern(term);
  return or(
    eq(drugs.searchKey, term),
    sql`${drugs.searchKey} LIKE ${`${escaped}\t%`} ESCAPE '\\'`,
    sql`${drugs.searchKey} LIKE ${`%\t${escaped}\t%`} ESCAPE '\\'`,
    sql`${drugs.searchKey} LIKE ${`%\t${escaped}`} ESCAPE '\\'`,
  )!;
}

function citationKey(type: string, identifier: string): string {
  return `${type}\0${identifier}`;
}

/**
 * Drugs whose search key contains any of `terms`, as normalized name keys.
 *
 * Exported for the conversation importer (`conversationIngestionStore.ts`),
 * which resolves the same "a document names a drug, which row is that" question
 * and must not re-derive the tab-delimited search-key matching — a second copy
 * drifts, and a drift here silently files an observation on the wrong substance.
 */
export async function findDrugNameCandidates(
  db: AnyDb,
  terms: string[],
): Promise<
  Array<{ id: number; names: Record<string, string>; aliases: string[] | null }>
> {
  const normalized = [
    ...new Set(terms.map((t) => normalizeMetabolismName(t)).filter(Boolean)),
  ];
  if (normalized.length === 0) return [];

  return db
    .select({ id: drugs.id, names: drugs.names, aliases: drugs.aliases })
    .from(drugs)
    .where(or(...normalized.map(exactSearchKeyTermCondition)));
}

export async function runImport(
  db: AnyDb,
  data: NormalizedResearchImport,
  opts: RunImportOptions,
): Promise<ImportStats> {
  const stats: ImportStats = {
    drugId: 0,
    drugCreated: false,
    citations: 0,
    parameters: 0,
    parametersSkipped: 0,
    pdTargets: 0,
    routes: 0,
    metabolites: 0,
    enzymeInteractions: 0,
    keptWithUnattachedSources: [],
    sourcesAttachedToUnchanged: 0,
    entries: 0,
    entriesUpdated: 0,
    entriesSkipped: 0,
    entriesKept: [],
    entriesInvalid: [],
    entrySourcesUnresolved: 0,
    parametersNotApplicable: [],
    metabolitesKept: [],
    ionizationConstants: 0,
    ionizationConstantsUpdated: 0,
    ionizationConstantsSkipped: 0,
    ionizationConstantsKept: 0,
  };

  const drugId = await resolveDrug(db, data, stats);
  stats.drugId = drugId;
  const citationMap = await seedCitations(
    db,
    drugId,
    data,
    opts.userId,
    stats,
    opts.crosswalk,
  );
  // Both parameter seeders under one hold of the per-drug applicability lock.
  // Each preflights with blockedParametersFor, but a preflight on the
  // auto-commit client is a check-then-write: an editor marking a pair, or
  // reclassifying the substance, between the read and the inserts would see no
  // conflict from its side either, and both would commit. Holding the lock
  // across both seeders also makes their view of applicability consistent —
  // the value and its source entries cannot disagree about whether the pair is
  // allowed.
  await withDrugApplicabilityLock(drugId, async () => {
    const tx = getDb();
    await seedParameters(tx, drugId, data, citationMap, opts, stats);
    await seedParameterEntries(tx, drugId, data, citationMap, opts, stats);
  });
  const ionStats = await seedIonizationConstants(
    db,
    drugId,
    data.ionizationConstants,
    (ids) => resolveRefIds(ids, citationMap),
    opts.userId,
    opts.overwrite,
  );
  stats.ionizationConstants = ionStats.inserted;
  stats.ionizationConstantsUpdated = ionStats.updated;
  stats.ionizationConstantsSkipped = ionStats.skipped;
  stats.ionizationConstantsKept = ionStats.kept;
  await seedPdTargets(db, drugId, data, citationMap, opts.userId, stats);
  await seedMetabolism(db, drugId, data, citationMap, opts.userId, stats);
  // seedParameters upserts summarizable drug_parameters values directly (incl.
  // the normalization input molecularWeight). For a drug that already has source
  // entries, those values are derived caches — reconcile them so an imported
  // scalar can't linger in place of the aggregate the table/simulator consume.
  // No-op for a fresh drug with no entries (grandfather rule leaves values as-is).
  // In a transaction so the recompute's advisory lock serializes against
  // concurrent entry mutations (seeding runs on the base auto-commit client).
  await runInPoolTransaction(async () => {
    await recomputeSummariesForDrug(drugId, opts.userId);
  });
  return stats;
}

async function resolveDrug(
  db: AnyDb,
  data: NormalizedResearchImport,
  stats: ImportStats,
): Promise<number> {
  const names = namesJson(data);
  const nameKeys = Object.values(names).map((n) => normalizeMetabolismName(n));
  const aliasKeys = data.drug.aliases.map((a) => normalizeMetabolismName(a));

  if (data.drug.pubchemCid != null) {
    const byCid = await db
      .select({ id: drugs.id })
      .from(drugs)
      .where(eq(drugs.pubchemCid, data.drug.pubchemCid))
      .limit(1);
    if (byCid[0]) {
      await backfillDrug(db, byCid[0].id, data);
      return byCid[0].id;
    }
  }

  const allNameKeys = [...new Set([...nameKeys, ...aliasKeys])].filter(Boolean);
  if (allNameKeys.length) {
    const rows = await findDrugNameCandidates(db, allNameKeys);
    for (const r of rows) {
      const keys = [
        ...Object.values(r.names ?? {}).map((n) =>
          normalizeMetabolismName(String(n)),
        ),
        ...((r.aliases ?? []) as string[]).map((a) =>
          normalizeMetabolismName(a),
        ),
      ];
      if (keys.some((k) => allNameKeys.includes(k))) {
        await backfillDrug(db, r.id, data);
        return r.id;
      }
    }
  }

  const baseSlug =
    generateSlug(data.drug.nameEn || data.drug.nameNb || 'drug') || 'drug';
  let slug = baseSlug;
  for (let n = 2; ; n++) {
    const clash = await db
      .select({ id: drugs.id })
      .from(drugs)
      .where(eq(drugs.slug, slug))
      .limit(1);
    if (!clash[0]) break;
    slug = `${baseSlug}-${n}`;
  }
  const searchKey = buildDrugSearchKey({
    names,
    aliases: data.drug.aliases,
    nameShort: data.drug.nameShort ?? undefined,
  });
  const inserted = await db
    .insert(drugs)
    .values({
      slug,
      names,
      nameShort: data.drug.nameShort,
      aliases: data.drug.aliases,
      pubchemCid: data.drug.pubchemCid,
      searchKey,
      source: RESEARCH_IMPORT_SOURCE,
    })
    .returning({ id: drugs.id });
  stats.drugCreated = true;
  return inserted[0].id;
}

async function backfillDrug(
  db: AnyDb,
  drugId: number,
  data: NormalizedResearchImport,
): Promise<void> {
  await db
    .update(drugs)
    .set({ source: RESEARCH_IMPORT_SOURCE, updatedAt: new Date() })
    .where(and(eq(drugs.id, drugId), sql`${drugs.source} IS NULL`));
  if (data.drug.pubchemCid != null) {
    await db
      .update(drugs)
      .set({ pubchemCid: data.drug.pubchemCid, updatedAt: new Date() })
      .where(and(eq(drugs.id, drugId), sql`${drugs.pubchemCid} IS NULL`));
  }
  if (data.drug.nameShort) {
    await db
      .update(drugs)
      .set({ nameShort: data.drug.nameShort, updatedAt: new Date() })
      .where(and(eq(drugs.id, drugId), sql`${drugs.nameShort} IS NULL`));
  }
}

async function seedCitations(
  db: AnyDb,
  drugId: number,
  data: NormalizedResearchImport,
  userId: number,
  stats: ImportStats,
  crosswalk?: CitationCrosswalk,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (data.sources.length === 0) return map;

  const uniqueSources = new Map<string, (typeof data.sources)[number]>();
  for (const s of data.sources) {
    const key = citationKey(s.type, s.identifier);
    if (!uniqueSources.has(key)) uniqueSources.set(key, s);
  }

  // One row per paper, not per handle (#1018). `resolveCitation` looks the
  // paper up under every handle the source declared before it inserts, so a
  // seed reporting a DOI for a paper already filed under its PMID lands on the
  // existing row — with its paper review, and therefore its read-in-full
  // attestation — instead of minting a second one. Sequential because two
  // sources in the same document can resolve to the same row.
  const idByKey = new Map<string, number>();
  for (const s of uniqueSources.values()) {
    const resolved = await resolveCitation(
      db,
      {
        type: s.type,
        identifier: s.identifier,
        metadata: s.metadata ?? null,
        drugId,
        crosswalk: mergeAltIds(s.altIds, crosswalk?.get(s.sourceId)),
      },
      userId,
    );
    idByKey.set(citationKey(s.type, s.identifier), resolved.id);
  }

  for (const s of data.sources) {
    const id = idByKey.get(citationKey(s.type, s.identifier));
    if (id != null) {
      map.set(s.sourceId, id);
      stats.citations += 1;
    }
  }
  return map;
}

/**
 * Citation ids on each parameter's most recent revision.
 *
 * Ordered by id rather than created_at: several revisions from one import land
 * inside the same clock tick, and only the serial breaks that tie reliably.
 * Read through the query builder (not `DISTINCT ON`) so the same code runs on
 * both drivers this store is used with.
 */
async function loadLatestRevisionReferences(
  db: AnyDb,
  drugId: number,
  parameters: string[],
): Promise<Map<string, number[]>> {
  const latest = new Map<string, number[]>();
  if (parameters.length === 0) return latest;

  const rows = (await db
    .select({
      parameter: drugParameterRevisions.parameter,
      referenceId: drugParameterRevisions.referenceId,
      referenceIds: drugParameterRevisions.referenceIds,
    })
    .from(drugParameterRevisions)
    .where(
      and(
        eq(drugParameterRevisions.drugId, drugId),
        inArray(drugParameterRevisions.parameter, parameters),
      ),
    )
    .orderBy(desc(drugParameterRevisions.id))) as Array<{
    parameter: string;
    referenceId: number | null;
    referenceIds: number[] | null;
  }>;

  for (const row of rows) {
    if (latest.has(row.parameter)) continue;
    latest.set(
      row.parameter,
      row.referenceIds && row.referenceIds.length > 0
        ? row.referenceIds
        : row.referenceId != null
          ? [row.referenceId]
          : [],
    );
  }
  return latest;
}

async function seedParameters(
  db: AnyDb,
  drugId: number,
  data: NormalizedResearchImport,
  citationMap: Map<string, number>,
  opts: RunImportOptions,
  stats: ImportStats,
): Promise<void> {
  const entries = [...data.parameters];
  if (
    data.drug.molecularWeight != null &&
    !entries.some((p) => p.parameter === 'molecularWeight')
  ) {
    entries.push({
      parameter: 'molecularWeight',
      value: data.drug.molecularWeight,
      sourceIds: [],
      sourceValues: [],
    });
  }

  const existingByParameter = new Map<string, unknown>();
  const parameterNames = [...new Set(entries.map((p) => p.parameter))];
  if (parameterNames.length) {
    const existingRows = await db
      .select({
        parameter: drugParameters.parameter,
        value: drugParameters.value,
      })
      .from(drugParameters)
      .where(
        and(
          eq(drugParameters.drugId, drugId),
          inArray(drugParameters.parameter, parameterNames),
        ),
      );
    for (const row of existingRows)
      existingByParameter.set(row.parameter, row.value);
  }

  // Citations already recorded for each parameter, newest revision first. Used
  // to decide whether an unchanged value is missing the sources this document
  // cites for it — without this the provenance-only write below would append an
  // identical revision on every re-run and break idempotency.
  const citedByParameter = await loadLatestRevisionReferences(
    db,
    drugId,
    parameterNames,
  );

  // This store writes `drug_parameters` directly rather than through
  // `upsertDrugParameter`, so it does not inherit that function's applicability
  // guard — an import would otherwise publish a value for a pair the gap queue
  // has been told cannot exist, leaving the monograph serving a number the
  // queue calls impossible. One query for the whole document.
  const notApplicable = new Set(
    await blockedParametersFor(db, drugId, parameterNames),
  );

  for (const p of entries) {
    if (notApplicable.has(p.parameter)) {
      stats.parametersNotApplicable.push(p.parameter);
      continue;
    }
    // An entries-only parameter (v2): it carries no synthesized value, so there
    // is nothing to upsert here — `seedParameterEntries` writes the source rows
    // and the post-import recompute derives `drug_parameters.value` from them.
    if (p.value === undefined) continue;
    const hasExisting = existingByParameter.has(p.parameter);
    const existingValue = existingByParameter.get(p.parameter);
    const valueUnchanged = hasExisting && sameJsonValue(existingValue, p.value);

    if (hasExisting && (valueUnchanged || !opts.overwrite)) {
      stats.parametersSkipped += 1;
      const refIds = resolveRefIds(p.sourceIds, citationMap);

      if (!refIds.length) continue;

      if (!valueUnchanged) {
        // A different value is kept, so its revision — the only place a
        // parameter's citations live — is never written and these sources end
        // up anchored to nothing. They are NOT attached to the kept value: they
        // back the number this document proposed, not the one already stored.
        // Report them rather than letting the run look complete.
        stats.keptWithUnattachedSources.push({
          parameter: p.parameter,
          sources: refIds.length,
        });
        continue;
      }

      // The stored value IS the researched value, so these sources genuinely
      // back it and attaching them invents nothing. Without this the citations
      // are lost either way: the non-destructive path skips the revision, and
      // re-running with --overwrite (what the report above tells the operator
      // to do) falls into this same branch because there is no value to change.
      const alreadyCited = citedByParameter.get(p.parameter) ?? [];
      if (refIds.every((id) => alreadyCited.includes(id))) continue;
      const merged = [...new Set([...alreadyCited, ...refIds])];
      await db.insert(drugParameterRevisions).values({
        drugId,
        parameter: p.parameter,
        oldValue: existingValue as never,
        newValue: p.value,
        editSummary:
          `Knyttet deep research-kilder til en uendret verdi ` +
          `(${RESEARCH_IMPORT_SOURCE})`,
        referenceId: merged[0] ?? null,
        referenceIds: merged,
        createdBy: opts.userId,
      });
      citedByParameter.set(p.parameter, merged);
      stats.sourcesAttachedToUnchanged += 1;
      continue;
    }

    await db
      .insert(drugParameters)
      .values({
        drugId,
        parameter: p.parameter,
        value: p.value,
        updatedBy: opts.userId,
      })
      .onConflictDoUpdate({
        target: [drugParameters.drugId, drugParameters.parameter],
        set: { value: p.value, updatedBy: opts.userId, updatedAt: new Date() },
      });

    const refIds = resolveRefIds(p.sourceIds, citationMap);
    await db.insert(drugParameterRevisions).values({
      drugId,
      parameter: p.parameter,
      oldValue: hasExisting ? existingValue : null,
      newValue: p.value,
      editSummary: `Seedet fra deep research-utdata (${RESEARCH_IMPORT_SOURCE})`,
      referenceId: refIds[0] ?? null,
      referenceIds: refIds.length ? refIds : null,
      createdBy: opts.userId,
    });
    existingByParameter.set(p.parameter, p.value);
    stats.parameters += 1;
  }
}

/**
 * The identity a source value is reconciled on across re-runs.
 *
 * Every dimension that makes a stored row a DIFFERENT observation belongs here,
 * because anything left out silently merges two observations into one. Route
 * and the categorical axis value are two of them: an oral Tmax and an
 * intravenous Tmax from the same paper, in the same matrix and scenario, are
 * not the same reading — they are the comparison the paper exists to report.
 *
 * The import document cannot express either, so an incoming value is always
 * route-less and numeric, and including them means a route-scoped or
 * categorical row simply stops being a candidate. That is the point: the
 * importer then INSERTS its own row instead of writing one source value's
 * sentence and cohort size onto a different observation's record. The cost is a
 * second row where a row this importer wrote has since been re-scoped to a
 * route by hand; a duplicate a curator can see and merge is a far better
 * failure than a quote silently attributed to the wrong observation.
 */
function entryKey(
  parameter: string,
  citationId: number,
  matrix: string | null | undefined,
  scenario: string | null | undefined,
  route: string | null | undefined,
  categoricalValue: string | null | undefined,
  // The structured dose context (Cmax dose-context RFC): two arms of one paper
  // reporting the same Cmax at different doses are two observations, and must
  // never reconcile against — or be rewritten into — each other.
  doseContext: string,
): string {
  return [
    parameter,
    citationId,
    matrix ?? '',
    scenario ?? '',
    route ?? '',
    categoricalValue ?? '',
    doseContext,
  ].join('\0');
}

function sameNum(stored: string | null, incoming: number | undefined): boolean {
  if (stored === null) return incoming === undefined;
  if (incoming === undefined) return false;
  // Rounded to the `numeric(14, 6)` scale the value is written at, the way
  // Postgres rounds it, so a re-import carrying one digit more than the column
  // keeps still recognises the row it wrote rather than inserting it again.
  return Number(stored) === roundToScale(incoming, 6);
}

interface ExistingEntryRow {
  id: number;
  parameter: string;
  citationId: number | null;
  matrix: string | null;
  scenario: string | null;
  /** Route-scoped entries (CV-2c) are separate observations — see `entryKey`. */
  route: string | null;
  /** The declared pick-list value for a model-structure axis (CV-1b). */
  categoricalValue: string | null;
  low: string | null;
  high: string | null;
  median: string | null;
  unit: string;
  qualifier: string | null;
  n: number | null;
  sourceQuote: string | null;
  observationContext: string | null;
  origin: string;
  /** Dose-context columns (migration 0127), as the driver returns them. */
  doseContext: Record<DoseContextFieldKey, unknown>;
}

/**
 * Rewrite one existing `parameter_entries` row, marking any pending proposal
 * against it as conflicted in the same breath.
 *
 * Every other direct writer of this table does this — see
 * `markEntryMutationsConflicted`, shared by `api/parameter-entries.ts` and the
 * legacy reference-concentrations route — and the importer under `--overwrite`
 * is a direct writer too. Without it a proposal queued against the row stays
 * approvable against a reading that no longer exists, so approving it silently
 * reverses the import. An unattended approval is worse still: the consensus
 * gate resolves what the entry will carry — its inherited quote among other
 * things — from the row as it was BEFORE this rewrite, and the write it
 * authorizes then evaluates against the row as it is after, which can clear a
 * quote the gate was promised and publish a calculation-driving value with no
 * provenance at all.
 *
 * What makes that a guarantee rather than a likelihood is where this runs:
 * inside `withDrugApplicabilityLock`, which holds the per-drug advisory lock
 * across the whole of entry seeding, so the marking and the rewrite commit as
 * one and no approval can slip between them.
 *
 * That only works because the approval takes the SAME locks in the same order.
 * It did not: a `param_entry` approval used to reach its drug lock deep inside
 * the apply, after the `pending_edits` row lock, which is an ABBA pair against
 * every direct writer here — PostgreSQL would resolve it by killing one of
 * them. `drugAdvisoryLockIdsForEdit` now returns the entry's drug, so the
 * approval takes advisory-then-row like everyone else and the two queue:
 * either the approval holds the drug and this waits — leaving the row its gate
 * read untouched until it commits — or this holds it and the approval blocks,
 * then reads the conflict marker and refuses.
 *
 * Deliberately NOT its own transaction: opening one here would take a second
 * connection and block on the locks the seeding transaction already holds.
 */
async function rewriteExistingEntry(
  db: AnyDb,
  entryId: number,
  set: Record<string, unknown>,
): Promise<void> {
  await markEntryMutationsConflicted(entryId);
  await db
    .update(parameterEntries)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(parameterEntries.id, entryId));
}

/**
 * Is this stored row the same READING as this incoming source value?
 *
 * Deliberately numbers-and-unit only. The quote is not part of the reading: it
 * is provenance ABOUT the reading, and a row that gains or corrects one is
 * still the same observation from the same paper. Folding it in here would
 * make a quote-only difference look like a different value, and an incoming
 * value with no matching row is INSERTED — so adding a quote to a document
 * would silently double-weight that paper in the aggregate. The quote is
 * reconciled separately by the caller, on rows this importer owns.
 */
function sameReading(
  row: ExistingEntryRow,
  sv: ImportParameterSourceValue,
): boolean {
  return (
    // Belt and braces with `entryKey`, which already keeps a categorical row
    // out of the candidate list. Stated here too because for a model-structure
    // axis this column IS the value: a row asserting `first_order` is not the
    // same reading as an incoming numeric one merely because both have no
    // low/high/median to compare.
    row.categoricalValue === null &&
    row.unit === sv.unit &&
    (row.qualifier ?? undefined) === sv.qualifier &&
    sameNum(row.low, sv.low) &&
    sameNum(row.high, sv.high) &&
    sameNum(row.median, sv.median) &&
    // A dose-context entry's reported central value is part of the reading
    // like the other three (null and absent alike are "none").
    sameNum(
      (row.doseContext.centralValue as string | null) ?? null,
      sv.centralValue ?? undefined,
    ) &&
    // So is what the numbers ARE. On a parameter without dose context the
    // statistic is outside the identity key (`doseContextIdentityKey`), so a
    // document relabelling a stored mean as a median lands in this group and
    // must read as a changed reading, not an identical one.
    (row.doseContext.centralStatistic ?? null) === (sv.centralStatistic ?? null) &&
    (row.doseContext.intervalKind ?? null) === (sv.intervalKind ?? null)
  );
}

/**
 * Write each parameter's `sourceValues[]` as `parameter_entries` rows — the
 * kildeverdier half of the import (#1025).
 *
 * Before this, an imported value was a hand-authored scalar backed by N
 * citations: no per-source rows, so no entry list and no forest plot, and the
 * grandfather rule kept it only until someone added the first real entry — at
 * which point the aggregate of that ONE row replaced the synthesized
 * multi-source number. Seeding the sources themselves makes the imported value
 * a derived cache like any other, computed by the recompute at the end of
 * `runImport`.
 *
 * Idempotency is by (parameter, citation, matrix, scenario), the same identity
 * the PM/AM seeder uses, so a re-run reconciles instead of duplicating:
 *  - an identical reading is left alone;
 *  - a CHANGED reading on a row this importer wrote is updated under
 *    `--overwrite`, and otherwise reported (never silently applied);
 *  - a reading with no counterpart is inserted.
 * Rows a human wrote are never rewritten — a second value from the same paper
 * is a new observation, not a correction of theirs.
 */
async function seedParameterEntries(
  db: AnyDb,
  drugId: number,
  data: NormalizedResearchImport,
  citationMap: Map<string, number>,
  opts: RunImportOptions,
  stats: ImportStats,
): Promise<void> {
  const withValues = data.parameters.filter((p) => p.sourceValues.length > 0);
  if (withValues.length === 0) return;

  const parameterNames = [...new Set(withValues.map((p) => p.parameter))];

  // Same guard as the value path above. A source entry is evidence for a value
  // of the quantity, so it cannot be filed against a pair that has none — and
  // the post-import recompute would not catch it, since that skips an excluded
  // parameter rather than failing. Recorded on the same stats field: from the
  // operator's side the parameter was dropped, whether it carried a value, a
  // set of readings, or both.
  const notApplicable = new Set(
    await blockedParametersFor(db, drugId, parameterNames),
  );

  const rawRows = await db
    .select({
      id: parameterEntries.id,
      parameter: parameterEntries.parameter,
      citationId: parameterEntries.citationId,
      matrix: parameterEntries.matrix,
      scenario: parameterEntries.scenario,
      route: parameterEntries.route,
      categoricalValue: parameterEntries.categoricalValue,
      low: parameterEntries.low,
      high: parameterEntries.high,
      median: parameterEntries.median,
      unit: parameterEntries.unit,
      qualifier: parameterEntries.qualifier,
      n: parameterEntries.n,
      sourceQuote: parameterEntries.sourceQuote,
      observationContext: parameterEntries.observationContext,
      origin: parameterEntries.origin,
      ...Object.fromEntries(
        DOSE_CONTEXT_FIELD_KEYS.map((key) => [`dc_${key}`, parameterEntries[key]]),
      ),
    })
    .from(parameterEntries)
    .where(
      and(
        eq(parameterEntries.drugId, drugId),
        inArray(parameterEntries.parameter, parameterNames),
      ),
    );
  const existingRows: ExistingEntryRow[] = rawRows.map((raw: unknown) => {
    const row = raw as unknown as Record<string, unknown>;
    const doseContext = {} as Record<DoseContextFieldKey, unknown>;
    for (const key of DOSE_CONTEXT_FIELD_KEYS) {
      doseContext[key] = row[`dc_${key}`] ?? null;
      delete row[`dc_${key}`];
    }
    return { ...(row as unknown as Omit<ExistingEntryRow, 'doseContext'>), doseContext };
  });

  // Unclaimed rows per identity group; each incoming value consumes at most one.
  const byKey = new Map<string, ExistingEntryRow[]>();
  for (const row of existingRows) {
    if (row.citationId == null) continue;
    const key = entryKey(
      row.parameter,
      row.citationId,
      row.matrix,
      row.scenario,
      row.route,
      row.categoricalValue,
      doseContextIdentityKey(row.doseContext, parameterDoseContextMode(row.parameter)),
    );
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }

  for (const p of withValues) {
    if (notApplicable.has(p.parameter)) {
      // Only record it here when the value path did not already: an
      // entries-only parameter (no synthesized value) never reached that loop.
      if (!stats.parametersNotApplicable.includes(p.parameter)) {
        stats.parametersNotApplicable.push(p.parameter);
      }
      continue;
    }
    for (const rawSv of p.sourceValues) {
      const citationId = citationMap.get(rawSv.sourceId);
      if (citationId == null) {
        // The source itself failed to resolve to a citation row (a malformed
        // handle, dropped upstream). Without provenance an entry may not exist:
        // every entry-backed parameter is citation-gated by design.
        stats.entrySourcesUnresolved += 1;
        continue;
      }
      // Defense in depth, exactly like the metabolism path: the document was
      // validated against the registry when it was parsed, but this store is
      // also reachable from the CLI with a hand-edited file.
      // The stored form of a dose-context value (median shorthand → centralValue),
      // so it reconciles against rows the store canonicalized the same way.
      // A dose-context reading from a document is self-administered: the
      // document cannot name another substance by this catalog's ids (see
      // `doseContextFromDocument`), so the importer records the explicit
      // self-reference the RFC requires — never a null standing for "same".
      const sv = canonicalizeReportedStatistic(
        parameterDoseContextMode(p.parameter) === 'required'
          ? { ...rawSv, administeredDrugId: drugId }
          : rawSv,
      );
      const invalid = validateEntryForParameter(p.parameter, sv);
      if (invalid) {
        stats.entriesInvalid.push({ parameter: p.parameter, message: invalid });
        continue;
      }

      // An import document states no route and no categorical value, so these
      // are always empty on the incoming side and only an equally unscoped row
      // can reconcile against it.
      const key = entryKey(
        p.parameter,
        citationId,
        sv.matrix,
        sv.scenario,
        null,
        null,
        doseContextIdentityKey(sv, parameterDoseContextMode(p.parameter)),
      );
      const candidates = byKey.get(key) ?? [];

      const identical = candidates.findIndex((row) => sameReading(row, sv));
      if (identical >= 0) {
        const identicalRow = candidates[identical]!;
        candidates.splice(identical, 1);
        // Same numbers, so this is the same observation and must never be
        // inserted again. The QUOTE may still differ: every row written before
        // migration 0119 has none, and a re-import is the only way those rows
        // can ever acquire one — nobody can reconstruct the sentences by hand.
        // Without this branch the early skip below swallows that, and a
        // corrected document could only land its quote if some unrelated number
        // moved too.
        //
        // Scoped to rows this importer wrote, under the same `--overwrite` rule
        // that governs every other change to one: a human's row is never
        // rewritten, and an unrequested overwrite is reported rather than
        // silently applied.
        // `undefined` is a document that does not mention a quote — which is
        // every document written before this field existed — and must NOT be
        // read as "clear it". Otherwise re-importing an older document under
        // --overwrite to correct a number would wipe every quote on the rows
        // this importer owns, including ones a curator added by hand, and
        // nobody can reconstruct those sentences. Same rule as the PATCH path:
        // silence preserves, an explicit null clears.
        //
        // The SAME applies to the cohort size. `n` is not part of the reading
        // either — it is the other thing the sentence states about it, and it
        // weights the aggregate. A document that corrects the cohort size
        // without moving the number describes the same observation, so it lands
        // here and not in the changed-reading branch below; reconciling only
        // the quote would leave the row asserting a corrected sentence over the
        // old sample size. The two are written together, or not at all.
        const incomingQuote = canonicalSourceQuote(sv.quote);
        // Compared on the comparison key, as the update and the merge now are.
        // A document re-exported with the accents composed the other way, or
        // carrying a joiner, or with a homoglyph in it, states the SAME
        // sentence — the rest of this feature defines those forms as one — so
        // calling it a change is wrong in both modes: without --overwrite the
        // importer reports the entry kept when nothing differs, and with it,
        // `rewriteExistingEntry` rewrites provenance for no reason AND marks
        // every draft, returned and pending proposal against the row
        // conflicted, sending contributors to rebase against a change that was
        // never made.
        //
        // NULL against a sentence stays a change: that is a quote arriving
        // where there was none, which is the backfill this branch exists for.
        const quoteChanged =
          incomingQuote !== undefined &&
          (identicalRow.sourceQuote === null || incomingQuote === null
            ? identicalRow.sourceQuote !== incomingQuote
            : sourceQuoteComparisonKey(identicalRow.sourceQuote) !==
              sourceQuoteComparisonKey(incomingQuote));
        const incomingN = sv.n ?? null;
        const nChanged = identicalRow.n !== incomingN;
        // Same "part of what the sentence attests" argument as `n`, per
        // `SOURCE_QUOTE_EVIDENCE_FIELDS` (src/lib/parameterEntries.ts): a
        // fasted-state description is not evidence for a reading now filed as
        // fed. Unlike `n`, silence PRESERVES here rather than clearing — this
        // field is new (#1257/#1289), so a document that never mentions it
        // (every one written before it existed) must not be read as "there is
        // no context", matching the three-state rule `ImportParameterSourceValue`
        // documents for it.
        const incomingContext = sv.observationContext;
        const contextChanged =
          incomingContext !== undefined &&
          (identicalRow.observationContext ?? null) !== incomingContext;
        if (
          (quoteChanged || nChanged || contextChanged) &&
          identicalRow.origin === RESEARCH_IMPORT_SOURCE
        ) {
          if (!opts.overwrite) {
            stats.entriesKept.push({ parameter: p.parameter, entries: 1 });
            continue;
          }
          await rewriteExistingEntry(db, identicalRow.id, {
            // Silence about `n` clears it: a document that no longer states a
            // cohort size is stating that it does not have one, and it can
            // restate it at will.
            //
            // Silence about the QUOTE preserves — but only while the quote is
            // still evidence for what the row says, which is the same condition
            // `preservedQuoteExpr` applies on the PATCH path, and `n` and
            // `observationContext` are both in that field list. A sentence
            // reporting "in 12 participants" is not evidence for a reading now
            // filed and aggregate-weighted as n=24, and a sentence about one
            // context is not evidence for a reading now filed under another. So
            // either one changing under a silent document detaches the
            // sentence, exactly as a moved number does in the changed-reading
            // branch below; only a document that supplies a replacement keeps
            // one.
            ...(incomingQuote === undefined
              ? nChanged || contextChanged
                ? { sourceQuote: null }
                : {}
              : { sourceQuote: incomingQuote }),
            n: incomingN,
            ...(incomingContext === undefined
              ? {}
              : { observationContext: incomingContext }),
          });
          stats.entriesUpdated += 1;
          continue;
        }
        stats.entriesSkipped += 1;
        continue;
      }

      const ours = candidates.findIndex(
        (row) => row.origin === RESEARCH_IMPORT_SOURCE,
      );
      const ourRow = ours >= 0 ? candidates[ours] : undefined;
      if (ourRow) {
        if (!opts.overwrite) {
          // A value we seeded now reads differently in the document. Applying it
          // silently would be the destructive behaviour the importer's default
          // exists to prevent; inserting it would pool both numbers as if two
          // papers reported them. Report and leave it.
          stats.entriesKept.push({ parameter: p.parameter, entries: 1 });
          continue;
        }
        candidates.splice(ours, 1);
        await rewriteExistingEntry(db, ourRow.id, {
          low: numStr(sv.low ?? null),
          high: numStr(sv.high ?? null),
          median: numStr(sv.median ?? null),
          qualifier: sv.qualifier ?? null,
          unit: sv.unit,
          n: sv.n ?? null,
          comments: sv.comments ?? null,
          // Cleared on silence here, and PRESERVED on silence in the
          // reconciliation branch above. The two look contradictory and are
          // the same rule: a quote (and, per `SOURCE_QUOTE_EVIDENCE_FIELDS`,
          // the observation context) is evidence for a specific reading, so
          // it survives exactly as long as that reading does.
          //
          // This branch is reached only because `sameReading` FAILED — the
          // numbers are moving. A stored sentence describing the old ones is
          // not evidence for the new ones, and keeping it would attach words
          // from the document to a value the document does not state. An
          // empty field is honest; a re-attributed sentence is not, and it is
          // the exact error class this whole change exists to expose.
          observationContext: sv.observationContext ?? null,
          sourceQuote: canonicalSourceQuote(sv.quote) ?? null,
          // Same identity group, so the same dose context — written anyway so
          // the reading's reported statistic moves with its numbers.
          ...doseContextValuesForWrite(sv),
        });
        stats.entriesUpdated += 1;
        continue;
      }

      await db.insert(parameterEntries).values({
        drugId,
        parameter: p.parameter,
        low: numStr(sv.low ?? null),
        high: numStr(sv.high ?? null),
        median: numStr(sv.median ?? null),
        qualifier: sv.qualifier ?? null,
        unit: sv.unit,
        matrix: sv.matrix ?? null,
        scenario: sv.scenario ?? null,
        n: sv.n ?? null,
        comments: sv.comments ?? null,
        // A create has no prior row to preserve from, so silence writes NULL —
        // the same rule `insertParameterEntryRow` applies (src/lib/parameterEntries.ts).
        observationContext: sv.observationContext ?? null,
        sourceQuote: canonicalSourceQuote(sv.quote) ?? null,
        // The complete shape, as the entry store writes it — never a legacy
        // column subset that would drop a value's dose context.
        ...doseContextValuesForWrite(sv),
        citationId,
        createdBy: opts.userId,
        origin: RESEARCH_IMPORT_SOURCE,
      });
      stats.entries += 1;
    }
  }
}

async function seedPdTargets(
  db: AnyDb,
  drugId: number,
  data: NormalizedResearchImport,
  citationMap: Map<string, number>,
  uid: number,
  stats: ImportStats,
): Promise<void> {
  for (const t of data.pharmacodynamicTargets) {
    const bioEntityId = await findOrCreateEntityBySymbol(
      db,
      { symbol: t.symbol, name: t.name ?? t.symbol },
      'drug_target',
    );
    const existing = await db
      .select({ id: drugReceptorTargets.id })
      .from(drugReceptorTargets)
      .where(
        and(
          eq(drugReceptorTargets.drugId, drugId),
          eq(drugReceptorTargets.bioEntityId, bioEntityId),
          eq(drugReceptorTargets.interactionType, t.interactionType),
        ),
      )
      .limit(1);
    if (existing[0]) continue;

    const refIds = resolveRefIds(t.sourceIds, citationMap);
    await db.insert(drugReceptorTargets).values({
      drugId,
      bioEntityId,
      interactionType: t.interactionType,
      tier: t.tier,
      affinity: measurementJson(t.affinity),
      potency: measurementJson(t.potency),
      efficacy: measurementJson(t.efficacy),
      ki: measurementJson(t.ki),
      ic50: measurementJson(t.ic50),
      ec50: measurementJson(t.ec50),
      emax: measurementJson(t.emax),
      selectivityRatio: measurementJson(t.selectivityRatio),
      assaySpecies: t.assaySpecies,
      referenceIds: refIds.length ? refIds : null,
      evidenceNote: t.evidenceNote,
      createdBy: uid,
      updatedBy: uid,
    });
    stats.pdTargets += 1;
  }
}

async function seedMetabolism(
  db: AnyDb,
  drugId: number,
  data: NormalizedResearchImport,
  citationMap: Map<string, number>,
  uid: number,
  stats: ImportStats,
): Promise<void> {
  const m = data.metabolism;

  if (m.profileNote || m.profileSourceIds.length) {
    const refIds = resolveRefIds(m.profileSourceIds, citationMap);
    await db
      .insert(drugMetabolismProfiles)
      .values({
        drugId,
        evidenceNote: m.profileNote,
        referenceIds: refIds.length ? refIds : null,
        updatedBy: uid,
      })
      .onConflictDoUpdate({
        target: drugMetabolismProfiles.drugId,
        set: {
          evidenceNote: m.profileNote,
          referenceIds: refIds.length ? refIds : null,
          updatedBy: uid,
          updatedAt: new Date(),
        },
      });
  }

  const existingRoutes = await db
    .select({
      kind: drugEliminationRoutes.kind,
      label: drugEliminationRoutes.label,
    })
    .from(drugEliminationRoutes)
    .where(eq(drugEliminationRoutes.drugId, drugId));
  const routeKey = (kind: string, label: string | null) =>
    `${kind}::${(label ?? '').toLowerCase()}`;
  const seenRoutes = new Set<string>(
    existingRoutes.map((r: { kind: string; label: string | null }) =>
      routeKey(r.kind, r.label),
    ),
  );
  let sortOrder = existingRoutes.length;
  for (const r of m.eliminationRoutes) {
    if (seenRoutes.has(routeKey(r.kind, r.label))) continue;
    let bioEntityId: number | null = null;
    if (r.kind === 'enzyme') {
      bioEntityId = await findOrCreateEntityBySymbol(
        db,
        { symbol: r.label, name: r.label },
        'metabolic_enzyme',
      );
    }
    const refIds = resolveRefIds(r.sourceIds, citationMap);
    await db.insert(drugEliminationRoutes).values({
      drugId,
      kind: r.kind,
      bioEntityId,
      label: r.label,
      fraction: numStr(r.fraction),
      fractionMin: numStr(r.fractionMin),
      fractionMax: numStr(r.fractionMax),
      note: r.note,
      referenceIds: refIds.length ? refIds : null,
      sortOrder: sortOrder++,
    });
    seenRoutes.add(routeKey(r.kind, r.label));
    stats.routes += 1;
  }

  if (m.metabolites.length) {
    const allDrugs = await findDrugNameCandidates(
      db,
      m.metabolites.map((mb) => mb.name),
    );
    const byName = new Map<string, number>();
    for (const d of allDrugs) {
      for (const n of Object.values(d.names ?? {}))
        byName.set(normalizeMetabolismName(String(n)), d.id);
      for (const a of (d.aliases ?? []) as string[])
        byName.set(normalizeMetabolismName(a), d.id);
    }
    // What the drug already links, so a skip can be explained rather than just
    // counted. The ON CONFLICT below is still the authority on whether a row
    // was written — this read only decides what to tell the operator.
    const existingLinks: Array<{
      name: string;
      metaboliteDrugId: number | null;
    }> = await db
      .select({
        name: drugMetabolites.metaboliteName,
        metaboliteDrugId: drugMetabolites.metaboliteDrugId,
      })
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, drugId));
    const existingNames = new Set(
      existingLinks.map((l) => normalizeMetabolismName(l.name)),
    );
    const existingByDrugId = new Map<number, string>();
    for (const l of existingLinks) {
      if (
        l.metaboliteDrugId != null &&
        !existingByDrugId.has(l.metaboliteDrugId)
      ) {
        existingByDrugId.set(l.metaboliteDrugId, l.name);
      }
    }

    let mSort = 0;
    for (const mb of m.metabolites) {
      const refIds = resolveRefIds(mb.sourceIds, citationMap);
      const normalized = normalizeMetabolismName(mb.name);
      const linkedDrugId = byName.get(normalized) ?? null;
      // Already there under another name: the substance index will refuse the
      // insert, and the document's range, note and citations go nowhere. Say
      // so. A row the drug already lists under the *same* name is an ordinary
      // idempotent re-run and stays silent.
      if (
        linkedDrugId != null &&
        !existingNames.has(normalized) &&
        existingByDrugId.has(linkedDrugId)
      ) {
        stats.metabolitesKept.push({
          name: mb.name,
          linkedAs: existingByDrugId.get(linkedDrugId)!,
        });
        continue;
      }
      const res = await db
        .insert(drugMetabolites)
        .values({
          parentDrugId: drugId,
          metaboliteDrugId: linkedDrugId,
          metaboliteName: mb.name,
          conversionFraction: numStr(mb.conversionFraction),
          conversionFractionMin: numStr(mb.conversionFractionMin),
          conversionFractionMax: numStr(mb.conversionFractionMax),
          activity: mb.activity,
          evidenceNote: mb.note,
          referenceIds: refIds.length ? refIds : null,
          sortOrder: mSort++,
        })
        // Untargeted: the parent already listing this substance is a skip
        // whether the existing row spells it the same way (the name index) or
        // spells it differently but resolves to the same drug (the substance
        // index added in 0099). A paper's spelling must not become a second
        // copy of a metabolite the monograph already lists.
        .onConflictDoNothing()
        .returning({ id: drugMetabolites.id });
      if (res.length) {
        stats.metabolites += 1;
        // Keep the two lookups current, or a document naming one substance
        // twice — say "Benzoylecgonine" and "benzoylecgonin (BE)" — would find
        // nothing on its second row's pre-check, hit the index instead, and
        // lose that row's range, note and citations without a word. The
        // conflict a run creates is as real as one it inherits.
        existingNames.add(normalized);
        if (linkedDrugId != null && !existingByDrugId.has(linkedDrugId)) {
          existingByDrugId.set(linkedDrugId, mb.name);
        }
      } else if (!existingNames.has(normalized)) {
        // Refused by one of the two unique indexes even though the pre-check
        // saw nothing to refuse it. Report rather than assume the pre-check
        // enumerated every way that can happen — an unreported skip is
        // indistinguishable from a row that was never in the document. Only a
        // row whose exact name is already present stays silent, which is the
        // idempotent re-run.
        stats.metabolitesKept.push({
          name: mb.name,
          linkedAs:
            (linkedDrugId != null ? existingByDrugId.get(linkedDrugId) : null) ??
            mb.name,
        });
      }
    }
  }

  for (const ei of m.enzymeInteractions) {
    const bioEntityId = await findOrCreateEntityBySymbol(
      db,
      { symbol: ei.enzymeSymbol, name: ei.enzymeSymbol },
      'metabolic_enzyme',
    );
    const refIds = resolveRefIds(ei.sourceIds, citationMap);
    const res = await db
      .insert(drugEnzymeInteractions)
      .values({
        drugId,
        bioEntityId,
        role: ei.role,
        strength: ei.strength,
        note: ei.note,
        referenceIds: refIds.length ? refIds : null,
        createdBy: uid,
        updatedBy: uid,
      })
      .onConflictDoNothing({
        target: [
          drugEnzymeInteractions.drugId,
          drugEnzymeInteractions.bioEntityId,
          drugEnzymeInteractions.role,
        ],
      })
      .returning({ id: drugEnzymeInteractions.id });
    if (res.length) stats.enzymeInteractions += 1;
  }
}
