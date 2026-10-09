/**
 * Merge two catalog entries for one substance (#admin-drug-merge).
 *
 * A drug occasionally gets registered twice — MHD (mono-hydroxy derivative of
 * carbamazepine / oxcarbazepine) is the standing example, entered as ids 988 and
 * 115. Rather than delete one and re-key everything by hand, an admin merges the
 * pair: one row survives (the *winner*) and the other (the *loser*) is folded
 * into it and deleted.
 *
 * Which row survives is decided by the monograph: the entry that already carries
 * a written monograph keeps its identity, and the other's data is repointed onto
 * it. The endpoint may override the suggestion, but that is the rule this module
 * suggests ({@link suggestWinner}).
 *
 * The merge is meant to be smooth. Everything that can move without ambiguity is
 * repointed silently; the only thing the admin is asked to decide is a genuine
 * conflict — a single-valued datum that both entries already carry (a curated
 * drug parameter, an applicability marker, the metabolism-profile row). Those
 * are surfaced by {@link buildDrugMergePlan} and resolved per-key by the caller.
 *
 * Unlike `citation-merge.ts`, which runs over the transaction-less neon-http
 * driver and is written to be idempotent step-by-step, this runs inside one
 * pooled transaction (see the endpoint) so the whole fold is atomic: a failure
 * anywhere leaves both drugs exactly as they were.
 *
 * The full set of things a drug is referenced by — and which are cascade-bound
 * vs. must be moved by hand — is the same checklist the DELETE handler in
 * `api/drugs.ts` documents; this module moves what that handler would drop.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  analyticalMethodComponents,
  citations,
  drugEliminationRoutes,
  drugEnzymeInteractions,
  drugInteractions,
  drugIonizationConstants,
  drugMetabolismProfiles,
  drugMetabolites,
  drugParameterApplicability,
  drugParameterDiscussions,
  drugParameterRevisions,
  drugParameters,
  drugReceptorTargets,
  drugs,
  parameterEntries,
  parameterPriorityFlags,
  patternReferenceAggregates,
  patternReferenceExposures,
  patternReferenceObservations,
  pendingEdits,
  pmConcentrationDistributions,
  verificationLog,
  wikiPages,
  wikiRevisions,
} from '../../db/schema.js';
import type { getDb } from './db.js';
import { buildSearchKey } from './drugs-helpers.js';
import { resolveMonographDrugCids } from './monograph-helpers.js';
import {
  recomputeSummariesForDrug,
  sourceQuoteComparisonKeySql,
} from './parameter-entries-store.js';
import { markEntryMutationsConflicted } from './entry-conflicts.js';
import { mergeEntryIdentity } from './entry-identity-sql.js';
import {
  ACTIVE_PENDING_EDIT_STATUSES,
  NESTED_DRUG_REF_KEYS,
} from './param-entry-payload-locks.js';
import { lockDrugForEntryApplicability } from './parameterApplicabilityStore.js';
import { parameterAppliesToSubstanceClass } from '../../src/lib/parameterApplicability.js';
import { normalizeAliases, resolveDrugName } from '../../src/lib/drugNames.js';
import {
  buildDrugComponentId,
  simulatorDrugKeyCandidates,
} from '../../src/lib/drugComponentId.js';
import { monographHasContent } from '../../src/lib/monographContent.js';
import {
  rewriteDrugLinksInHtml,
  rewriteDrugLinksInJson,
  type DrugLinkRewrite,
} from '../../src/lib/drugMergeLinks.js';

type Db = ReturnType<typeof getDb>;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DrugMonographInfo {
  pageId: number;
  slug: string;
  hasContent: boolean;
  /**
   * SHA-256 hex of the monograph's stored content — the JSONB `content` and
   * the plaintext cache. Feeds the plan fingerprint so an editor's prose
   * change between preview and apply is detected even when `hasContent`
   * stays true (a monograph edited from one non-empty snapshot to another).
   */
  contentDigest: string;
}

export interface DrugSideInfo {
  id: number;
  /**
   * Norwegian-first display name — kept for server-side prose in
   * `winnerReason`/`warnings`/`dataConflicts` fallbacks (developer-facing
   * English strings the client rarely renders). React surfaces should use
   * `names` with the caller's active `i18n.language` (via
   * `drugSideDisplayName`) so headings, toasts, and confirmation prompts
   * render in the reader's locale.
   */
  name: string;
  /** Full per-language names map, verbatim from `drugs.names`. */
  names: Record<string, string>;
  slug: string;
  pubchemCid: number | null;
  popularityScore: number;
  /** 'drug' | 'metabolite' | 'endogenous' — see SUBSTANCE_CLASSES. */
  substanceClass: string;
  monograph: DrugMonographInfo | null;
}

/** The kinds of single-valued data a merge asks the admin to reconcile. */
export type DrugMergeConflictKind =
  | 'parameter'
  | 'applicability'
  | 'metabolism_profile';

export interface DrugMergeConflict {
  kind: DrugMergeConflictKind;
  /** Parameter id for `parameter`/`applicability`; `'profile'` for the profile. */
  key: string;
  /** `${kind}:${key}` — the key the resolutions map is keyed by. */
  id: string;
  /** The value the winner currently holds (JSON-serializable for display). */
  winnerValue: unknown;
  /** The value the loser currently holds. */
  loserValue: unknown;
}

export type ConflictResolution = 'winner' | 'loser';
export type DrugMergeResolutions = Record<string, ConflictResolution>;

export interface DrugMergeCounts {
  parametersMovedCleanly: number;
  parameterEntries: number;
  methodMembershipsMoved: number;
  methodMembershipsDeduped: number;
  metaboliteEdgesMoved: number;
  metaboliteEdgesDeduped: number;
  precursorLinksMoved: number;
  precursorLinksDeduped: number;
  receptorTargets: number;
  enzymeInteractions: number;
  eliminationRoutes: number;
  ionizationConstants: number;
  pmDistributions: number;
  atlasRows: number;
  wikiPagesRelinked: number;
}

/**
 * A parameter that cannot be folded because the result would break the
 * parameter-applicability invariant on the survivor (AGENTS.md §49-50): a
 * not-applicable marker beside a live value, or a value for a parameter the
 * survivor's substance class declares undefined. These are not admin-resolvable
 * per-key like {@link DrugMergeConflict} — a merge that produced one would leave
 * the monograph serving a number the applicability system says cannot exist, so
 * the merge is refused until the contradiction is cleared on the drugs.
 */
export interface DrugMergeBlocker {
  parameter: string;
  reason: 'marker_vs_value' | 'substance_class';
}

/**
 * A message the UI localizes: `code` is an i18n key suffix under
 * `admin.drugMerge` (e.g. `winnerReason.byMonograph`), `params` interpolates
 * into the localized template, and `fallback` is the developer-facing English
 * string rendered when the client dictionary has no entry for `code`. The
 * server produces these; nb.json and en.json each carry a translated
 * template.
 */
export interface DrugMergeTranslatableMessage {
  code: string;
  params?: Record<string, string | number>;
  fallback: string;
}

/**
 * Two rows collide on an identity key AND state different validated data — two
 * measurements written twice, not one duplicate. A merge cannot pick one
 * silently: dropping either would erase a distinct forensic figure or its
 * provenance. Follows the "CORRECT BY REFUSAL" rule of `scripts/merge-drugs.ts`.
 *
 * `table` is the schema table (e.g. `analytical_method_components`); `identity`
 * is a human-readable label naming the colliding row (e.g. "method M1"); the
 * `message` is a localized description of what disagrees.
 */
export interface DrugMergeDataConflict {
  table: string;
  identity: string;
  message: DrugMergeTranslatableMessage;
}

export interface DrugMergePlan {
  winner: DrugSideInfo;
  loser: DrugSideInfo;
  /** True when the monograph rule alone decided the winner. */
  suggestedByMonograph: boolean;
  winnerReason: DrugMergeTranslatableMessage;
  conflicts: DrugMergeConflict[];
  /** Applicability contradictions that must be cleared before merging. */
  blockers: DrugMergeBlocker[];
  /**
   * Identity-key collisions where the two rows disagree on validated data. A
   * merge cannot pick one silently — a curator has to reconcile them on the
   * drugs first.
   */
  dataConflicts: DrugMergeDataConflict[];
  /**
   * Winner and loser disagree on `substance_class`. Reported as a blocker
   * rather than silently adopting the winner's, since class controls which
   * parameters are defined at all (bioavailability + dose ranges are undefined
   * for non-administered classes) and winner selection is by monograph/
   * popularity, not by scientific classification.
   */
  substanceClassMismatch: { winner: string; loser: string } | null;
  warnings: DrugMergeTranslatableMessage[];
  counts: DrugMergeCounts;
  /**
   * Deterministic hash of the decision-relevant state the admin sees in this
   * plan: conflict values on both sides, blockers, dataConflicts, substance
   * class, and monograph fill state on both drugs. The apply route recomputes
   * this under the merge lock and refuses the merge on mismatch. Same-input
   * fingerprint is stable across sessions.
   */
  planFingerprint: string;
}

/** Thrown by {@link mergeDrugs} when the applicability invariant would break. */
export class DrugMergeBlockedError extends Error {
  constructor(public readonly blockers: DrugMergeBlocker[]) {
    super('Drug merge would violate the parameter-applicability invariant');
    this.name = 'DrugMergeBlockedError';
  }
}

/**
 * Thrown by {@link mergeDrugs} when identity-key collisions carry divergent
 * data that a merge cannot pick between (see {@link DrugMergeDataConflict}).
 */
export class DrugMergeDataConflictError extends Error {
  constructor(public readonly conflicts: DrugMergeDataConflict[]) {
    super('Drug merge would drop divergent validated data');
    this.name = 'DrugMergeDataConflictError';
  }
}

/**
 * Thrown by {@link mergeDrugs} when the winner and loser have different
 * `substance_class` values. That column decides which parameters are defined
 * at all — merging into the winner's class would silently reopen or hide gaps
 * — so it must be reconciled on the drugs first.
 */
export class DrugMergeClassMismatchError extends Error {
  constructor(public readonly winnerClass: string, public readonly loserClass: string) {
    super(
      `Drug merge refused: substance_class differs (winner '${winnerClass}', loser '${loserClass}')`,
    );
    this.name = 'DrugMergeClassMismatchError';
  }
}

/**
 * Thrown by {@link mergeDrugs} when a conflict detected under the merge lock has
 * no explicit resolution — a value that appeared after the route's preflight.
 * Defaulting it to the winner would silently drop the other side's new datum.
 */
export class UnresolvedDrugMergeConflictError extends Error {
  constructor(public readonly conflicts: string[]) {
    super('Drug merge has unresolved conflicts');
    this.name = 'UnresolvedDrugMergeConflictError';
  }
}

/**
 * Thrown by {@link mergeDrugs} when the plan fingerprint the admin approved
 * (the values a conflict listed, the emptiness of the loser monograph, the
 * blocker/dataConflict set) has been changed by concurrent writes between
 * preview and apply. Refuse the apply so the admin re-runs the preview and
 * re-approves the current picture — a stale approval could delete a datum the
 * admin never saw.
 */
export class DrugMergeStalePlanError extends Error {
  constructor() {
    super('Drug merge plan has changed since the preview');
    this.name = 'DrugMergeStalePlanError';
  }
}

export interface DrugMergeStats {
  winnerId: number;
  loserId: number;
  counts: DrugMergeCounts;
  conflictsResolved: number;
  loserMonographDeleted: boolean;
}

// ─── Loading & winner selection ───────────────────────────────────────────────

/**
 * Resolve one drug's monograph page, if it has one. Uses the same mixed-vintage
 * `drug_cid` resolution as the DELETE teardown so a legacy CID that is really
 * another drug's internal id is not mistaken for this drug's monograph.
 */
async function loadMonograph(
  db: Db,
  drug: { id: number; pubchemCid: number | null },
): Promise<DrugMonographInfo | null> {
  const candidates = await resolveMonographDrugCids(db, drug);
  const [page] = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      content: wikiPages.content,
      contentPlaintext: wikiPages.contentPlaintext,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.pageType, 'drug_monograph'),
        inArray(wikiPages.drugCid, candidates),
      ),
    )
    .limit(1);
  if (!page) return null;
  return {
    pageId: page.id,
    slug: page.slug,
    hasContent: monographHasContent(page),
    contentDigest: monographContentDigest(page),
  };
}

/**
 * SHA-256 hex of the monograph's stored content (JSONB + plaintext). Used
 * as a fingerprint input so a prose change between preview and apply is
 * caught even when `hasContent` stays true on both sides of the edit.
 * Serialized via `stableStringify` for determinism across Node versions.
 */
function monographContentDigest(row: {
  content: unknown;
  contentPlaintext: string | null;
}): string {
  return createHash('sha256')
    .update(
      stableStringify({
        content: row.content ?? null,
        contentPlaintext: row.contentPlaintext ?? null,
      }),
    )
    .digest('hex');
}

export async function loadDrugSideInfo(
  db: Db,
  drugId: number,
): Promise<DrugSideInfo | null> {
  const [row] = await db
    .select({
      id: drugs.id,
      names: drugs.names,
      slug: drugs.slug,
      pubchemCid: drugs.pubchemCid,
      popularityScore: drugs.popularityScore,
      substanceClass: drugs.substanceClass,
    })
    .from(drugs)
    .where(eq(drugs.id, drugId))
    .limit(1);
  if (!row) return null;
  const monograph = await loadMonograph(db, {
    id: row.id,
    pubchemCid: row.pubchemCid,
  });
  const name =
    resolveDrugName(row.names, 'nb') ||
    resolveDrugName(row.names, 'en') ||
    `Drug ${row.id}`;
  return {
    id: row.id,
    name,
    names: (row.names ?? {}) as Record<string, string>,
    slug: row.slug,
    pubchemCid: row.pubchemCid,
    popularityScore: row.popularityScore,
    substanceClass: row.substanceClass,
    monograph,
  };
}

/**
 * Suggest which of two drugs should survive. The one with a written monograph
 * wins; failing that, the one with more popularity, then the lower id — always
 * deterministic so a preview and the apply agree. `byMonograph` reports whether
 * the monograph rule alone decided it (the caller may still override).
 */
export function suggestWinner(
  a: DrugSideInfo,
  b: DrugSideInfo,
): {
  winner: DrugSideInfo;
  loser: DrugSideInfo;
  byMonograph: boolean;
  reason: DrugMergeTranslatableMessage;
} {
  const aHas = a.monograph?.hasContent ?? false;
  const bHas = b.monograph?.hasContent ?? false;
  if (aHas !== bHas) {
    const winner = aHas ? a : b;
    const loser = aHas ? b : a;
    return {
      winner,
      loser,
      byMonograph: true,
      reason: {
        code: 'winnerReason.byMonograph',
        params: { winnerName: winner.name, winnerId: winner.id, loserName: loser.name, loserId: loser.id },
        fallback: `"${winner.name}" (id ${winner.id}) has a monograph and "${loser.name}" (id ${loser.id}) does not, so it keeps its identity.`,
      },
    };
  }
  // Both have a monograph, or neither does — the monograph rule cannot decide.
  const [winner, loser] =
    a.popularityScore !== b.popularityScore
      ? a.popularityScore > b.popularityScore
        ? [a, b]
        : [b, a]
      : a.id <= b.id
        ? [a, b]
        : [b, a];
  const reason: DrugMergeTranslatableMessage = aHas
    ? {
        code: 'winnerReason.bothHaveMonograph',
        fallback: `Both entries have a written monograph; defaulted to the more-used one. Confirm which should survive — the other monograph's prose will be discarded.`,
      }
    : {
        code: 'winnerReason.neitherHasMonograph',
        fallback: `Neither entry has a written monograph; defaulted to the more-used entry. Confirm which should survive.`,
      };
  return { winner, loser, byMonograph: false, reason };
}

// ─── Plan (conflicts + counts) ────────────────────────────────────────────────

/**
 * The two single-valued, (drug_id, parameter)-keyed tables a merge reconciles.
 * Both share the shape, so they are handled by column-name via raw SQL rather
 * than by two type-divergent drizzle query builders.
 */
const PARAM_KEYED_TABLES: ReadonlyArray<{
  kind: DrugMergeConflictKind;
  table: string;
  valueColumn: string;
}> = [
  { kind: 'parameter', table: 'drug_parameters', valueColumn: 'value' },
  { kind: 'applicability', table: 'drug_parameter_applicability', valueColumn: 'reason' },
];

export async function detectSingleValueConflicts(
  db: Db,
  winnerId: number,
  loserId: number,
): Promise<DrugMergeConflict[]> {
  const conflicts: DrugMergeConflict[] = [];

  for (const { kind, table, valueColumn } of PARAM_KEYED_TABLES) {
    const tbl = sql.raw(table);
    const col = sql.raw(valueColumn);
    const [winnerRows, loserRows] = await Promise.all([
      db.execute<{ parameter: string; value: unknown }>(
        sql`SELECT parameter, ${col} AS value FROM ${tbl} WHERE drug_id = ${winnerId}`,
      ),
      db.execute<{ parameter: string; value: unknown }>(
        sql`SELECT parameter, ${col} AS value FROM ${tbl} WHERE drug_id = ${loserId}`,
      ),
    ]);
    const winnerByParam = new Map(winnerRows.rows.map((r) => [r.parameter, r.value]));
    for (const loserRow of loserRows.rows) {
      if (!winnerByParam.has(loserRow.parameter)) continue;
      conflicts.push({
        kind,
        key: loserRow.parameter,
        id: `${kind}:${loserRow.parameter}`,
        winnerValue: winnerByParam.get(loserRow.parameter) ?? null,
        loserValue: loserRow.value,
      });
    }
  }

  // drug_metabolism_profiles: PK is drug_id, so at most one row per drug. The
  // admin only chooses between the two `evidenceNote` prose values — the two
  // sides' `referenceIds` arrays are UNIONed by the fold regardless of the
  // pick (citations are additive; losing one side's set as a side effect of
  // picking a note over the other would silently discard provenance). The
  // conflict payload carries both refs sets so the admin can see what they
  // are keeping.
  const profiles = await db
    .select({
      drugId: drugMetabolismProfiles.drugId,
      note: drugMetabolismProfiles.evidenceNote,
      referenceIds: drugMetabolismProfiles.referenceIds,
    })
    .from(drugMetabolismProfiles)
    .where(inArray(drugMetabolismProfiles.drugId, [winnerId, loserId]));
  const winnerProfile = profiles.find((p) => p.drugId === winnerId);
  const loserProfile = profiles.find((p) => p.drugId === loserId);
  if (winnerProfile && loserProfile) {
    conflicts.push({
      kind: 'metabolism_profile',
      key: 'profile',
      id: 'metabolism_profile:profile',
      winnerValue: {
        note: winnerProfile.note ?? null,
        referenceIds: winnerProfile.referenceIds ?? [],
      },
      loserValue: {
        note: loserProfile.note ?? null,
        referenceIds: loserProfile.referenceIds ?? [],
      },
    });
  }

  return conflicts;
}

/**
 * Applicability contradictions the merge would create on the survivor.
 *
 * The survivor ends up with the UNION of both sides' markers, values and source
 * entries. The parameter-applicability invariant forbids two of those unions:
 *
 *   - a not-applicable **marker** on one side beside a **value or source entry**
 *     on the other (post-merge: a marker saying "undefined" next to a live
 *     value), and
 *   - a **value or source entry** for a parameter the survivor's **substance
 *     class** declares undefined (bioavailability / the dose ranges on a
 *     non-administered class).
 *
 * Every ordinary write path refuses these (`parameterWriteBlockedBy`), but a
 * merge repoints rows straight past those guards — so it must run the same check
 * itself and refuse. A pre-merge database never holds a marker beside a value
 * for one drug, so any hit here is genuinely cross-side and unresolvable by a
 * per-key pick; the admin clears it on the drugs first (drop the value, lift the
 * marker, or reclassify) and merges again.
 */
export async function detectApplicabilityBlockers(
  db: Db,
  winnerId: number,
  loserId: number,
): Promise<DrugMergeBlocker[]> {
  const ids = [winnerId, loserId];
  const [winnerRow] = await db
    .select({ substanceClass: drugs.substanceClass })
    .from(drugs)
    .where(eq(drugs.id, winnerId))
    .limit(1);
  const winnerClass = winnerRow?.substanceClass ?? 'drug';

  const [markerRows, paramRows, entryRows] = await Promise.all([
    db
      .select({ parameter: drugParameterApplicability.parameter })
      .from(drugParameterApplicability)
      .where(inArray(drugParameterApplicability.drugId, ids)),
    db
      .select({ parameter: drugParameters.parameter })
      .from(drugParameters)
      .where(inArray(drugParameters.drugId, ids)),
    db
      .selectDistinct({ parameter: parameterEntries.parameter })
      .from(parameterEntries)
      .where(inArray(parameterEntries.drugId, ids)),
  ]);

  const markers = new Set(markerRows.map((r) => r.parameter));
  const valued = new Set(
    [...paramRows, ...entryRows].map((r) => r.parameter),
  );

  const blockers: DrugMergeBlocker[] = [];
  for (const parameter of valued) {
    if (markers.has(parameter)) {
      blockers.push({ parameter, reason: 'marker_vs_value' });
    } else if (!parameterAppliesToSubstanceClass(parameter, winnerClass)) {
      blockers.push({ parameter, reason: 'substance_class' });
    }
  }
  return blockers.sort((a, b) => a.parameter.localeCompare(b.parameter));
}

/**
 * Identity-key collisions where the two rows disagree on validated data. A
 * merge silently picking one would substitute one measurement for another —
 * refusable per `scripts/merge-drugs.ts`'s "CORRECT BY REFUSAL" contract.
 *
 * Covers:
 *   - `analytical_method_components`: same method_id, differing LOR/MKK/LOD/
 *     unit/uncertainty.
 *   - `pm_concentration_distributions`: same source_id, differing numeric
 *     order statistics (whole published set — averaging is not defined).
 *   - `drug_ionization_constants`: same reconciliation identity, differing pKa,
 *     backing citations, note, or origin (curated vs deep-research).
 *   - `drug_metabolites`: same identity (name OR resolved metabolite) where the
 *     loser row carries EVIDENCE (conversion fraction, note, refs, non-unknown
 *     activity) — dropping it would silently retire a distinct claim.
 *   - `wiki_revisions`: loser monograph blank now but with prose in history —
 *     cascade on the page delete would destroy editorial history blanking did
 *     not.
 *   - `simulator_cases`: winner or loser saved-case KEY is a numeric string
 *     that names another drug too (CID/id collision) — the rewrite would
 *     misfire on unrelated cases.
 *
 * Read-only. The apply path re-runs it under the merge lock and refuses if any
 * conflict remains — a fresh divergence introduced after the caller's preview
 * fails loud, never silent.
 */
export async function detectDataConflicts(
  db: Db,
  winner: DrugSideInfo,
  loser: DrugSideInfo,
): Promise<DrugMergeDataConflict[]> {
  const winnerId = winner.id;
  const loserId = loser.id;
  const conflicts: DrugMergeDataConflict[] = [];
  // The dose-context half of every parameter_entries identity predicate
  // below (Cmax release B, #1340), with drug references read as they will be
  // after the merge — see api/_lib/entry-identity-sql.ts.
  const dk = mergeEntryIdentity(winnerId, loserId);

  const methodRows = await db.execute<{
    method_id: number;
    method_code: string;
    what: string;
  }>(sql`
    SELECT s.method_id AS method_id, am.code AS method_code,
      concat_ws(', ',
        CASE WHEN s.lor IS DISTINCT FROM t.lor THEN 'LOR' END,
        CASE WHEN s.mkk IS DISTINCT FROM t.mkk THEN 'MKK' END,
        CASE WHEN s.lod IS DISTINCT FROM t.lod THEN 'LOD' END,
        CASE WHEN s.unit IS DISTINCT FROM t.unit THEN 'unit' END,
        CASE WHEN s.measurement_uncertainty IS DISTINCT FROM t.measurement_uncertainty THEN 'uncertainty' END
      ) AS what
    FROM analytical_method_components s
    JOIN analytical_method_components t ON t.method_id = s.method_id
    JOIN analytical_methods am ON am.id = s.method_id
    WHERE s.drug_id = ${winnerId} AND t.drug_id = ${loserId}
      AND (s.lor IS DISTINCT FROM t.lor
        OR s.mkk IS DISTINCT FROM t.mkk
        OR s.lod IS DISTINCT FROM t.lod
        OR s.unit IS DISTINCT FROM t.unit
        OR s.measurement_uncertainty IS DISTINCT FROM t.measurement_uncertainty)`);
  for (const row of methodRows.rows) {
    conflicts.push({
      table: 'analytical_method_components',
      identity: `method ${row.method_code}`,
      message: {
        code: 'dataConflict.analyticalMethodFigures',
        params: { what: row.what },
        fallback: `both entries carry a membership in this method with different validated figures (${row.what}) — two forensic measurements, not one written twice`,
      },
    });
  }

  // `printed` is a JSONB map of the source's exact typography per statistic
  // ("0.20" vs "0.2" — a hair the numeric column cannot preserve, and the
  // reason the column exists). The apply-side merges it with `w.printed ||
  // l.printed`, which is JSONB concat: on a key present in both, the RIGHT
  // side wins silently. Two conflicting spellings would erase the winner's
  // significant-figure choice without an admin ever seeing the swap. Any
  // key overlap with different values counts here.
  // `analyte` is the source table's printed analyte name — kept for
  // auditability (a transcriber's spelling of "9-carboxy-THC" vs
  // "THC-COOH"). A silent pick on collision drops one transcription; the
  // dedup at apply time deletes the loser row and keeps the winner's label.
  const pmRows = await db.execute<{ source_id: number; analyte: string }>(sql`
    SELECT s.source_id, s.analyte
    FROM pm_concentration_distributions s
    JOIN pm_concentration_distributions t
      ON t.source_id = s.source_id AND t.drug_id = ${loserId}
    WHERE s.drug_id = ${winnerId}
      AND (s.loq IS DISTINCT FROM t.loq
        OR s.mean IS DISTINCT FROM t.mean
        OR s.median IS DISTINCT FROM t.median
        OR s.p90 IS DISTINCT FROM t.p90
        OR s.p95 IS DISTINCT FROM t.p95
        OR s.p975 IS DISTINCT FROM t.p975
        OR s.tc_plasma IS DISTINCT FROM t.tc_plasma
        OR s.median_over_tc IS DISTINCT FROM t.median_over_tc
        OR s.n IS DISTINCT FROM t.n
        OR s.analyte IS DISTINCT FROM t.analyte
        OR EXISTS (
          SELECT 1
          FROM jsonb_each_text(coalesce(s.printed, '{}'::jsonb)) sp(k, v)
          JOIN jsonb_each_text(coalesce(t.printed, '{}'::jsonb)) tp(k, v) USING (k)
          WHERE sp.v IS DISTINCT FROM tp.v
        ))`);
  for (const row of pmRows.rows) {
    conflicts.push({
      table: 'pm_concentration_distributions',
      identity: `cohort source ${row.source_id}, analyte "${row.analyte}"`,
      message: {
        code: 'dataConflict.pmDistributions',
        fallback: 'two order-statistic transcriptions of the same source disagree — a merge cannot pick one without inventing a number, and JSONB concat of `printed` would let the loser silently overwrite significant-figure choices on any shared statistic',
      },
    });
  }

  const ionRows = await db.execute<{
    protonated: number;
    deprotonated: number;
    what: string;
  }>(sql`
    SELECT s.protonated_charge AS protonated, s.deprotonated_charge AS deprotonated,
      concat_ws(', ',
        CASE WHEN s.pka IS DISTINCT FROM t.pka THEN 'pKa' END,
        CASE WHEN s.reference_ids IS DISTINCT FROM t.reference_ids THEN 'references' END,
        CASE WHEN s.note IS DISTINCT FROM t.note THEN 'note' END,
        CASE WHEN s.origin IS DISTINCT FROM t.origin THEN 'origin' END
      ) AS what
    FROM drug_ionization_constants s
    JOIN drug_ionization_constants t
      ON t.drug_id = ${loserId}
     AND t.protonated_charge = s.protonated_charge
     AND t.deprotonated_charge = s.deprotonated_charge
     AND t.constant_type = s.constant_type
     AND t.evidence_type = s.evidence_type
     AND lower(coalesce(t.site_label, '')) = lower(coalesce(s.site_label, ''))
     AND lower(coalesce(t.medium, '')) = lower(coalesce(s.medium, ''))
     AND coalesce(t.temperature_c::text, '') = coalesce(s.temperature_c::text, '')
    WHERE s.drug_id = ${winnerId}
      AND (s.pka IS DISTINCT FROM t.pka
        OR s.reference_ids IS DISTINCT FROM t.reference_ids
        OR s.note IS DISTINCT FROM t.note
        OR s.origin IS DISTINCT FROM t.origin)`);
  for (const row of ionRows.rows) {
    conflicts.push({
      table: 'drug_ionization_constants',
      identity: `equilibrium ${row.protonated} → ${row.deprotonated}`,
      message: {
        code: 'dataConflict.ionizationMeasurement',
        params: { what: row.what },
        fallback: `both entries record the same equilibrium but disagree on ${row.what} — an admin-side merge cannot substitute one measurement for another (esp. for a curated row overwritten by a deep-research one)`,
      },
    });
  }

  const metaboliteRows = await db.execute<{
    identity: string;
    parent_side: boolean;
  }>(sql`
    SELECT
      CASE
        WHEN t.metabolite_drug_id IS NOT NULL AND s.metabolite_drug_id = t.metabolite_drug_id
          THEN 'metabolite drug id ' || t.metabolite_drug_id::text
        ELSE 'metabolite name "' || t.metabolite_name || '"'
      END AS identity,
      TRUE AS parent_side
    FROM drug_metabolites s
    JOIN drug_metabolites t
      ON t.parent_drug_id = ${loserId}
     AND (
       (t.metabolite_drug_id IS NOT NULL AND t.metabolite_drug_id = s.metabolite_drug_id)
       OR t.metabolite_name = s.metabolite_name
     )
    WHERE s.parent_drug_id = ${winnerId}
      AND (
        t.conversion_fraction IS NOT NULL
        OR t.conversion_fraction_min IS NOT NULL
        OR t.conversion_fraction_max IS NOT NULL
        OR t.evidence_note IS NOT NULL
        OR (t.reference_ids IS NOT NULL AND array_length(t.reference_ids, 1) > 0)
        OR t.activity <> 'unknown'
      )
    UNION ALL
    SELECT
      'precursor ' || t.parent_drug_id::text AS identity,
      FALSE AS parent_side
    FROM drug_metabolites s
    JOIN drug_metabolites t
      ON t.metabolite_drug_id = ${loserId}
     AND t.parent_drug_id = s.parent_drug_id
    WHERE s.metabolite_drug_id = ${winnerId}
      AND (
        t.conversion_fraction IS NOT NULL
        OR t.conversion_fraction_min IS NOT NULL
        OR t.conversion_fraction_max IS NOT NULL
        OR t.evidence_note IS NOT NULL
        OR (t.reference_ids IS NOT NULL AND array_length(t.reference_ids, 1) > 0)
        OR t.activity <> 'unknown'
      )`);
  for (const row of metaboliteRows.rows) {
    conflicts.push({
      table: 'drug_metabolites',
      identity: row.identity,
      message: {
        code: 'dataConflict.metaboliteEvidence',
        fallback: 'both entries claim this metabolic edge and the loser row carries its own evidence (conversion fraction, activity, note, or citations) — dropping it would silently retire a distinct claim',
      },
    });
  }

  // Same `metabolite_name` on both sides but different resolved
  // `metabolite_drug_id`. The name-based dedup would delete the loser row
  // by label; two different substances are two different scientific claims
  // even without ancillary evidence fields. Symmetric across the parent /
  // precursor direction.
  // Two shapes counted here:
  //   1. Both sides resolved to different drugs — two distinct claims.
  //   2. Winner unresolved (metabolite_drug_id IS NULL, free-text link) but
  //      loser resolved to a canonical drug. The parent-side dedup matches
  //      on `metabolite_name` and would delete the loser row, silently
  //      replacing the resolved relationship with the winner's free-text
  //      link. The resolved id is stronger data; either enrich the winner
  //      row with it or refuse the merge. Refuse, since enrichment might
  //      have been the free-text intent all along — the curator resolves
  //      first, then merges.
  const metaboliteNameDrugRows = await db.execute<{
    what: string;
    identity: string;
  }>(sql`
    SELECT 'metabolite' AS what,
      'metabolite name "' || t.metabolite_name || '" — winner→' ||
        coalesce(s.metabolite_drug_id::text, 'unresolved') ||
        ' vs loser→' || t.metabolite_drug_id::text AS identity
    FROM drug_metabolites s
    JOIN drug_metabolites t
      ON t.parent_drug_id = ${loserId}
     AND t.metabolite_name = s.metabolite_name
    WHERE s.parent_drug_id = ${winnerId}
      AND t.metabolite_drug_id IS NOT NULL
      AND (s.metabolite_drug_id IS NULL OR s.metabolite_drug_id <> t.metabolite_drug_id)
    UNION ALL
    SELECT 'precursor' AS what,
      'precursor of ' || t.metabolite_name || ' — winner parent ' ||
        s.parent_drug_id::text || ' vs loser parent ' || t.parent_drug_id::text AS identity
    FROM drug_metabolites s
    JOIN drug_metabolites t
      ON t.metabolite_drug_id = ${loserId}
     AND t.metabolite_name = s.metabolite_name
     AND t.parent_drug_id <> s.parent_drug_id
    WHERE s.metabolite_drug_id = ${winnerId}`);
  for (const row of metaboliteNameDrugRows.rows) {
    conflicts.push({
      table: 'drug_metabolites',
      identity: row.identity,
      message: {
        code: 'dataConflict.metaboliteNameDifferentDrug',
        params: { what: row.what },
        fallback: `both entries have a ${row.what} edge under the same name but the name resolves to different drugs (or the loser has resolved it and the winner still holds it as a free-text link). A name-only dedup would silently drop the loser's resolved id. Reconcile on the drugs first (change one label, or resolve the winner's link to match), then merge.`,
      },
    });
  }

  // Divergent non-null receptor-target measurements. The merge fills the
  // winner's NULL columns from the loser (round-3 fix), but two non-null
  // values that DISAGREE would be silently reconciled to the winner's — worse,
  // the reference union then makes the loser's citation appear to support the
  // winner's number. Same reasoning as the ionization-constant conflict.
  const receptorRows = await db.execute<{
    bio_entity_id: number;
    interaction: string;
    what: string;
  }>(sql`
    SELECT s.bio_entity_id, s.interaction_type AS interaction,
      concat_ws(', ',
        CASE WHEN s.tier IS NOT NULL AND t.tier IS NOT NULL AND s.tier <> t.tier THEN 'tier' END,
        CASE WHEN s.affinity IS NOT NULL AND t.affinity IS NOT NULL AND s.affinity <> t.affinity THEN 'affinity' END,
        CASE WHEN s.potency IS NOT NULL AND t.potency IS NOT NULL AND s.potency <> t.potency THEN 'potency' END,
        CASE WHEN s.efficacy IS NOT NULL AND t.efficacy IS NOT NULL AND s.efficacy <> t.efficacy THEN 'efficacy' END,
        CASE WHEN s.ki IS NOT NULL AND t.ki IS NOT NULL AND s.ki <> t.ki THEN 'Ki' END,
        CASE WHEN s.ic50 IS NOT NULL AND t.ic50 IS NOT NULL AND s.ic50 <> t.ic50 THEN 'IC50' END,
        CASE WHEN s.ec50 IS NOT NULL AND t.ec50 IS NOT NULL AND s.ec50 <> t.ec50 THEN 'EC50' END,
        CASE WHEN s.emax IS NOT NULL AND t.emax IS NOT NULL AND s.emax <> t.emax THEN 'Emax' END,
        CASE WHEN s.selectivity_ratio IS NOT NULL AND t.selectivity_ratio IS NOT NULL AND s.selectivity_ratio <> t.selectivity_ratio THEN 'selectivity ratio' END,
        CASE WHEN s.assay_species IS NOT NULL AND t.assay_species IS NOT NULL AND s.assay_species <> t.assay_species THEN 'assay species' END
      ) AS what
    FROM drug_receptor_targets s
    JOIN drug_receptor_targets t
      ON t.drug_id = ${loserId}
     AND t.bio_entity_id = s.bio_entity_id
     AND t.interaction_type = s.interaction_type
    WHERE s.drug_id = ${winnerId}
      AND (
        (s.tier IS NOT NULL AND t.tier IS NOT NULL AND s.tier <> t.tier)
        OR (s.affinity IS NOT NULL AND t.affinity IS NOT NULL AND s.affinity <> t.affinity)
        OR (s.potency IS NOT NULL AND t.potency IS NOT NULL AND s.potency <> t.potency)
        OR (s.efficacy IS NOT NULL AND t.efficacy IS NOT NULL AND s.efficacy <> t.efficacy)
        OR (s.ki IS NOT NULL AND t.ki IS NOT NULL AND s.ki <> t.ki)
        OR (s.ic50 IS NOT NULL AND t.ic50 IS NOT NULL AND s.ic50 <> t.ic50)
        OR (s.ec50 IS NOT NULL AND t.ec50 IS NOT NULL AND s.ec50 <> t.ec50)
        OR (s.emax IS NOT NULL AND t.emax IS NOT NULL AND s.emax <> t.emax)
        OR (s.selectivity_ratio IS NOT NULL AND t.selectivity_ratio IS NOT NULL AND s.selectivity_ratio <> t.selectivity_ratio)
        OR (s.assay_species IS NOT NULL AND t.assay_species IS NOT NULL AND s.assay_species <> t.assay_species)
      )`);
  for (const row of receptorRows.rows) {
    conflicts.push({
      table: 'drug_receptor_targets',
      identity: `entity ${row.bio_entity_id}, ${row.interaction}`,
      message: {
        code: 'dataConflict.receptorMeasurement',
        params: { what: row.what },
        fallback: `both entries record this receptor mechanism but disagree on ${row.what} — a silent pick would attach the loser's citation to the winner's number`,
      },
    });
  }

  // Same reasoning for enzyme interactions: divergent non-null `strength`.
  const enzymeRows = await db.execute<{
    bio_entity_id: number;
    role: string;
  }>(sql`
    SELECT s.bio_entity_id, s.role
    FROM drug_enzyme_interactions s
    JOIN drug_enzyme_interactions t
      ON t.drug_id = ${loserId}
     AND t.bio_entity_id = s.bio_entity_id
     AND t.role = s.role
    WHERE s.drug_id = ${winnerId}
      AND s.strength IS NOT NULL AND t.strength IS NOT NULL
      AND s.strength <> t.strength`);
  for (const row of enzymeRows.rows) {
    conflicts.push({
      table: 'drug_enzyme_interactions',
      identity: `entity ${row.bio_entity_id}, role ${row.role}`,
      message: {
        code: 'dataConflict.enzymeStrength',
        fallback: 'both entries record this enzyme interaction but disagree on strength — a silent pick would substitute one rating for another',
      },
    });
  }

  // Self-edges the merge would create carrying real evidence. My later dedup
  // deletes any `loser→winner` (or `winner→loser`) metabolite edge as a
  // future self-edge, but if that edge carries a conversion fraction, a
  // known activity, notes or citations it's a distinct scientific claim
  // being silently retired. The other detect-branches above only join loser
  // rows to rows already owned by the winner, so this shape doesn't fall out
  // of them.
  const selfEdgeRows = await db.execute<{ identity: string }>(sql`
    SELECT
      'metabolite of ' || ${loserId}::text || ' resolving to winner ' || ${winnerId}::text AS identity
    FROM drug_metabolites t
    WHERE t.parent_drug_id = ${loserId}
      AND t.metabolite_drug_id = ${winnerId}
      AND (
        t.conversion_fraction IS NOT NULL
        OR t.conversion_fraction_min IS NOT NULL
        OR t.conversion_fraction_max IS NOT NULL
        OR t.evidence_note IS NOT NULL
        OR (t.reference_ids IS NOT NULL AND array_length(t.reference_ids, 1) > 0)
        OR t.activity <> 'unknown'
      )
    UNION ALL
    SELECT
      'precursor of ' || ${loserId}::text || ' parented on winner ' || ${winnerId}::text AS identity
    FROM drug_metabolites t
    WHERE t.metabolite_drug_id = ${loserId}
      AND t.parent_drug_id = ${winnerId}
      AND (
        t.conversion_fraction IS NOT NULL
        OR t.conversion_fraction_min IS NOT NULL
        OR t.conversion_fraction_max IS NOT NULL
        OR t.evidence_note IS NOT NULL
        OR (t.reference_ids IS NOT NULL AND array_length(t.reference_ids, 1) > 0)
        OR t.activity <> 'unknown'
      )`);
  for (const row of selfEdgeRows.rows) {
    conflicts.push({
      table: 'drug_metabolites',
      identity: row.identity,
      message: {
        code: 'dataConflict.selfEdgeEvidence',
        fallback: 'this edge would become a self-edge on the surviving drug after the merge, but it carries real evidence (conversion fraction, activity, note, or citations). A silent delete would retire the claim — reconcile it on the drugs first (drop the edge or re-target its resolved drug)',
      },
    });
  }

  // Active proposals against the loser's monograph. The delete-teardown would
  // otherwise drop them wholesale, discarding contributor work-in-progress.
  // Only active statuses (draft/pending/returned) matter — approved/rejected
  // are terminal. The candidate CID list handles legacy-keyed monographs whose
  // `drug_cid` is the loser's PubChem CID rather than its internal id — same
  // mixed-vintage resolution as `loadMonograph`, so a proposal on a legacy
  // page is not missed and later dropped by the page delete.
  const loserMonographCids = await resolveMonographDrugCids(db, {
    id: loser.id,
    pubchemCid: loser.pubchemCid,
  });
  const loserMonographCidList = sql.join(
    loserMonographCids.map((c) => sql`${c}`),
    sql`, `,
  );
  const monographProposalRows = await db.execute<{
    kind: string;
    count: number;
  }>(sql`
    SELECT edit_type AS kind, count(*)::int AS count
    FROM pending_edits
    WHERE edit_type IN ('wiki_page', 'wiki_section', 'wiki_fact')
      AND status IN ('pending', 'draft', 'returned')
      AND target_id IN (
        SELECT id FROM wiki_pages
        WHERE page_type = 'drug_monograph'
          AND drug_cid IN (${loserMonographCidList})
      )
    GROUP BY edit_type`);
  for (const row of monographProposalRows.rows) {
    conflicts.push({
      table: 'pending_edits',
      identity: `${row.count} active ${row.kind} proposal(s) on the loser monograph`,
      message: {
        code: 'dataConflict.monographProposals',
        fallback: 'the loser monograph has unfinished review-queue proposals. A merge would delete the page and drop the proposals with it. Settle or move them from the /review queue first, then merge.',
      },
    });
  }

  // Full-replacement pending proposals on EITHER side. `metabolism`,
  // `receptor_targets`, and `enzyme_interaction` proposals carry the whole
  // list a curator wants the drug to have — approving one is a wholesale
  // replacement of the current rows. Two failure modes:
  //   - a loser-side proposal retargeted to the winner would wipe rows the
  //     merge preserved on the winner side; the retarget step avoids this by
  //     refusing the merge instead of retargeting.
  //   - a WINNER-side proposal, still authored against the winner's pre-merge
  //     rows, would on approval wipe the loser-only rows the merge just
  //     folded in.
  // Refuse both. The curator settles proposals against the loser (or the
  // merged winner directly) before the merge.
  const fullReplacementRows = await db.execute<{
    kind: string;
    side: string;
    count: number;
  }>(sql`
    SELECT
      edit_type AS kind,
      CASE WHEN target_id = ${winnerId} THEN 'winner' ELSE 'loser' END AS side,
      count(*)::int AS count
    FROM pending_edits
    WHERE edit_type IN ('metabolism', 'receptor_targets', 'enzyme_interaction')
      AND status IN ('pending', 'draft', 'returned')
      AND target_id IN (${winnerId}, ${loserId})
    GROUP BY edit_type, target_id`);
  for (const row of fullReplacementRows.rows) {
    conflicts.push({
      table: 'pending_edits',
      identity: `${row.count} active ${row.kind} proposal(s) on ${row.side}`,
      message: {
        code: 'dataConflict.fullReplacementProposals',
        params: { kind: row.kind, side: row.side },
        fallback: `the ${row.side} has unfinished ${row.kind} proposal(s) whose approval REPLACES the drug's whole ${row.kind} list. A merge would leave the proposal authored against the pre-merge row set, so approving it later would wipe every row the merge just folded in or preserved. Settle it from the /review queue (approve, reject, or re-submit against the merged drug) first, then merge.`,
      },
    });
  }

  // Active `wiki_new` proposals when the survivor will OWN a monograph after
  // the merge. `wiki_pages` has no uniqueness constraint on `drug_cid` and
  // the approval path checks only slug uniqueness, so approving a wiki_new
  // proposal on a drug that also has a monograph publishes a SECOND
  // `drug_monograph`. Three shapes:
  //
  //   1. winner already has a monograph, wiki_new proposal on loser:
  //      retargeting proposed_meta.drugCid to the winner would then create
  //      the second page on approval. Refuse.
  //   2. winner already has a monograph, wiki_new proposal on winner:
  //      same failure mode — the existing proposal already targets a drug
  //      that has a monograph. Refuse.
  //   3. manual-override case: winner has NO monograph, loser has one, so
  //      step 9 REPOINTS the loser's page to the winner. After merge, the
  //      winner owns that page. An existing wiki_new proposal on the winner
  //      (or on the loser, since it retargets to the winner) would still
  //      create a second page on approval. Refuse.
  //
  // In short: check whether the winner will own a monograph AFTER the merge
  // (winner.monograph || loser.monograph), and if so refuse any active
  // wiki_new proposal on either side.
  const winnerWillOwnMonograph =
    winner.monograph != null || loser.monograph != null;
  if (winnerWillOwnMonograph) {
    const wikiNewRows = await db.execute<{
      side: string;
      count: number;
    }>(sql`
      SELECT
        CASE WHEN (proposed_meta ->> 'drugCid')::int = ${winnerId} THEN 'winner' ELSE 'loser' END AS side,
        count(*)::int AS count
      FROM pending_edits
      WHERE edit_type = 'wiki_new'
        AND status IN ('pending', 'draft', 'returned')
        AND (proposed_meta ->> 'drugCid')::int IN (${winnerId}, ${loserId})
      GROUP BY (proposed_meta ->> 'drugCid')::int`);
    for (const row of wikiNewRows.rows) {
      conflicts.push({
        table: 'pending_edits',
        identity: `${row.count} active wiki_new proposal(s) on ${row.side} while survivor will own a monograph`,
        message: {
          code: 'dataConflict.wikiNewOnLoserWithWinnerMonograph',
          params: { side: row.side, count: row.count },
          fallback: `the ${row.side} has active new-monograph proposals but the survivor will already own a monograph after the merge. Retargeting or approving them would publish a second monograph on the survivor (wiki_pages has no drug_cid uniqueness). Settle the proposals from the /review queue — reject, or fold their content into the survivor as sections/facts — then merge.`,
        },
      });
    }
  }

  // Multi-monograph refusal: `wiki_pages.drug_cid` isn't unique-per-drug at
  // the schema level, so a legacy CID-keyed page and a modern id-keyed page
  // can coexist for the same substance. `loadMonograph` returns only one —
  // whichever the planner-side query happened to see — so the delete step
  // would only handle that one, leaving a second page attached to a deleted
  // loser (or worse, still resolving as the drug's monograph). Check BOTH
  // sides: on the loser this leaves an orphan page behind the delete; on the
  // winner it means link rewrites and fingerprint reads land on an arbitrary
  // slug/page id, and the survivor stays ambiguously attached to more than
  // one monograph. Either way an admin must merge or delete the extras first.
  const loserPageCidList = sql.join(
    loserMonographCids.map((c) => sql`${c}`),
    sql`, `,
  );
  const loserPagesRows = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM wiki_pages
    WHERE page_type = 'drug_monograph' AND drug_cid IN (${loserPageCidList})`);
  const loserPageCount = loserPagesRows.rows[0]?.n ?? 0;
  if (loserPageCount > 1) {
    conflicts.push({
      table: 'wiki_pages',
      identity: `${loserPageCount} monograph pages resolve to loser (mixed-vintage drug_cid)`,
      message: {
        code: 'dataConflict.multiMonograph',
        params: { side: 'loser', count: loserPageCount },
        fallback: 'the loser has more than one monograph page — a modern id-keyed page AND a legacy PubChem-CID-keyed page both resolve to it. The merge would delete only one, leaving the other attached to a deleted drug. Delete or merge the extra page(s) first, then merge.',
      },
    });
  }
  const winnerMonographCids = await resolveMonographDrugCids(db, {
    id: winner.id,
    pubchemCid: winner.pubchemCid,
  });
  const winnerPageCidList = sql.join(
    winnerMonographCids.map((c) => sql`${c}`),
    sql`, `,
  );
  const winnerPagesRows = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM wiki_pages
    WHERE page_type = 'drug_monograph' AND drug_cid IN (${winnerPageCidList})`);
  const winnerPageCount = winnerPagesRows.rows[0]?.n ?? 0;
  if (winnerPageCount > 1) {
    conflicts.push({
      table: 'wiki_pages',
      identity: `${winnerPageCount} monograph pages resolve to winner (mixed-vintage drug_cid)`,
      message: {
        code: 'dataConflict.multiMonograph',
        params: { side: 'winner', count: winnerPageCount },
        fallback: 'the winner has more than one monograph page — a modern id-keyed page AND a legacy PubChem-CID-keyed page both resolve to it. Link rewrites and the fingerprint read would land on whichever page loadMonograph returned first, leaving the survivor ambiguously attached to more than one monograph. Delete or merge the extra page(s) first, then merge.',
      },
    });
  }

  // A `param_entry` update or delete proposal (target_id = parameter_entries.id)
  // whose loser-side entry would be DROPPED by the identical-row dedup at
  // merge time. The retarget step handles only 'create' proposals; an
  // update/delete proposal on a deleted entry is orphaned and later approval
  // fails with `param_entry_target_missing`. The dedup predicate mirrors the
  // one used at apply time in step 7.
  const orphanedEntryProposalRows = await db.execute<{
    kind: string;
    count: number;
  }>(sql`
    SELECT (proposed_value ->> 'op') AS kind, count(*)::int AS count
    FROM pending_edits pe
    WHERE pe.edit_type = 'param_entry'
      AND pe.status IN ('pending', 'draft', 'returned')
      AND (proposed_value ->> 'op') IN ('update', 'delete')
      AND pe.target_id IN (
        SELECT l.id FROM parameter_entries AS l
        WHERE l.drug_id = ${loserId}
          AND EXISTS (
            SELECT 1 FROM parameter_entries AS w
            WHERE w.drug_id = ${winnerId}
              AND w.parameter = l.parameter
              AND w.unit = l.unit
              AND w.matrix IS NOT DISTINCT FROM l.matrix
              AND w.scenario IS NOT DISTINCT FROM l.scenario
              AND w.route IS NOT DISTINCT FROM l.route
              AND w.citation_id IS NOT DISTINCT FROM l.citation_id
              AND w.qualifier IS NOT DISTINCT FROM l.qualifier
              AND w.categorical_value IS NOT DISTINCT FROM l.categorical_value
              AND w.low IS NOT DISTINCT FROM l.low
              AND w.high IS NOT DISTINCT FROM l.high
              AND w.median IS NOT DISTINCT FROM l.median
              ${dk.eq('w', 'l')}
          )
      )
    GROUP BY (proposed_value ->> 'op')`);
  for (const row of orphanedEntryProposalRows.rows) {
    conflicts.push({
      table: 'pending_edits',
      identity: `${row.count} active param_entry ${row.kind} proposal(s) on a duplicate entry`,
      message: {
        code: 'dataConflict.orphanedEntryProposal',
        params: { kind: row.kind },
        fallback: `a param_entry ${row.kind} proposal targets a loser-side entry that would be dropped by the identical-row dedup at merge time — the retarget step only handles 'create' proposals, so approval would fail with param_entry_target_missing. Settle it from the /review queue (approve, reject, or move to the equivalent winner entry) first, then merge.`,
      },
    });
  }

  // Divergent-`n` collisions on parameter_entries. Two rows with the same
  // write-path identity (matching `entryDuplicateExists` — no `n`) but
  // different sample sizes: a normal insert would reject the second, but the
  // merge would either arbitrarily drop one `n` at dedup (silently retiring a
  // sample-size claim) or, if `n` were in the dedup identity, silently keep
  // both and let `entryWeight` double-pool the same source. Neither is safe;
  // refuse and let the curator merge the `n` fields, drop one row, or file
  // them under distinct citations first.
  const divergentAncillaryRows = await db.execute<{
    parameter: string;
    citation_id: number | null;
    field: 'n' | 'comments' | 'observation_context' | 'source_quote' | 'origin_ambiguous';
    winner_val: string;
    loser_val: string;
  }>(sql`
    SELECT parameter, citation_id, field, winner_val, loser_val FROM (
      SELECT
        w.parameter,
        w.citation_id,
        'n'::text AS field,
        coalesce(w.n::text, 'null') AS winner_val,
        coalesce(l.n::text, 'null') AS loser_val,
        w.n IS DISTINCT FROM l.n AS mismatch
      FROM parameter_entries w
      JOIN parameter_entries l ON
        w.drug_id = ${winnerId}
        AND l.drug_id = ${loserId}
        AND w.parameter = l.parameter
        AND w.unit = l.unit
        AND w.matrix IS NOT DISTINCT FROM l.matrix
        AND w.scenario IS NOT DISTINCT FROM l.scenario
        AND w.route IS NOT DISTINCT FROM l.route
        AND w.citation_id IS NOT DISTINCT FROM l.citation_id
        AND w.qualifier IS NOT DISTINCT FROM l.qualifier
        AND w.categorical_value IS NOT DISTINCT FROM l.categorical_value
        AND w.low IS NOT DISTINCT FROM l.low
        AND w.high IS NOT DISTINCT FROM l.high
        AND w.median IS NOT DISTINCT FROM l.median
        ${dk.eq('w', 'l')}
      UNION ALL
      SELECT
        w.parameter,
        w.citation_id,
        'comments'::text AS field,
        coalesce(w.comments, '(none)') AS winner_val,
        coalesce(l.comments, '(none)') AS loser_val,
        w.comments IS DISTINCT FROM l.comments AS mismatch
      FROM parameter_entries w
      JOIN parameter_entries l ON
        w.drug_id = ${winnerId}
        AND l.drug_id = ${loserId}
        AND w.parameter = l.parameter
        AND w.unit = l.unit
        AND w.matrix IS NOT DISTINCT FROM l.matrix
        AND w.scenario IS NOT DISTINCT FROM l.scenario
        AND w.route IS NOT DISTINCT FROM l.route
        AND w.citation_id IS NOT DISTINCT FROM l.citation_id
        AND w.qualifier IS NOT DISTINCT FROM l.qualifier
        AND w.categorical_value IS NOT DISTINCT FROM l.categorical_value
        AND w.low IS NOT DISTINCT FROM l.low
        AND w.high IS NOT DISTINCT FROM l.high
        AND w.median IS NOT DISTINCT FROM l.median
        ${dk.eq('w', 'l')}
      UNION ALL
      -- observation_context (#1257) is evidence, unlike comments above — it IS
      -- in SOURCE_QUOTE_EVIDENCE_FIELDS, so two identically-numbered rows that
      -- disagree on it are not simply additive commentary, they may be
      -- describing different readings that coincide on the numbers.
      --
      -- The dedup identity (this GROUP BY) deliberately excludes context, so
      -- a "group" can legitimately hold several WINNER rows already — e.g. a
      -- fasted-state row and a fed-state row on the same drug, nothing stops
      -- that. A merge only ever drops LOSER rows that match a winner on this
      -- identity (see the delete around line ~2770); it never dedupes two
      -- winner rows against each other. So the old approach of counting
      -- DISTINCT non-null context values across the WHOLE group (winner and
      -- loser combined) over-refused: winner rows A and B plus a loser row A
      -- look like "2 distinct values" even though the loser's A is already on
      -- a surviving winner row and dropping it loses nothing (#1291).
      --
      -- Two earlier attempts here tried to verify that a genuinely NEW loser
      -- context could be safely rescued through the context-promotion UPDATE
      -- below (~2651) whenever some receiving condition held. Codex review
      -- (PR #1297) found FOUR distinct ways that reasoning was still unsafe,
      -- each a different interaction between context-promotion and
      -- quote-promotion that a preflight predicate built one condition at a
      -- time kept failing to anticipate — including a case where 'some
      -- winner row already carries a quote' was wrongly treated as proof
      -- that nothing could be lost, when the quote in question was on an
      -- unrelated context.
      --
      -- Rather than continue trying to characterize every case where
      -- promoting a new value is safe, this check now allows it only in the
      -- narrowest case where no such interaction is even possible: exactly
      -- one loser context is missing from the winner, the loser holds no
      -- OTHER context value in this group (so there is no ambiguity about
      -- which loser row the promotion's 'DISTINCT ON <identity> ORDER BY
      -- ..., l.id' would pick — trivially the only one), EXACTLY ONE
      -- NULL-context, UNQUOTED winner row exists to receive it (not merely
      -- 'at least one' — the promotion UPDATE has no LIMIT and touches
      -- every NULL-context winner row that matches, so 2+ such rows would
      -- all be asserted to hold the SAME new reading on nothing more than
      -- one loser row's say-so — a further Codex finding), and — the part
      -- every earlier attempt got wrong — NO row on EITHER side of the
      -- group carries a source_quote at all. With no quote anywhere in the
      -- group, there is nothing left for either promotion step to
      -- misattach.
      -- One hazard remains and is refused independently of the above: a
      -- NULL-context LOSER row can itself carry a source_quote (its context
      -- is simply unknown, not divergent). Quote-promotion below only
      -- matches a winner row whose context IS NOT DISTINCT FROM the
      -- loser's (here, NULL) — so it needs an available NULL-context winner
      -- row: either unquoted (receives it directly), or already quoted
      -- ('winner_null_quoted' — safe rather than risky here, because the
      -- separate source_quote branch below already refuses the WHOLE merge
      -- the moment 2+ distinct quote texts exist anywhere in this identity
      -- group, so by the time this predicate is even evaluated, any
      -- existing quote on a NULL-context winner row is GUARANTEED to
      -- already agree with the loser's — nothing to promote, nothing at
      -- risk). Refuse only when NEITHER exists.
      --
      -- This does NOT also need "and the loser holds no other non-null
      -- context": the context-promotion UPDATE (~2834) carries its OWN
      -- 'NOT EXISTS' guard that skips promoting a REDUNDANT
      -- (already-matched) value onto ANY NULL-context winner row in the
      -- group — so whenever the loser's other context(s) are all already
      -- matched (the only way to reach this branch without the
      -- unmatched-value branch above having already refused),
      -- context-promotion never touches the NULL-context winner row at
      -- all, and it remains available exactly as this branch assumes. Two
      -- earlier versions of this check got this wrong in opposite
      -- directions on the same scenario (winner holds context A and a
      -- quoted NULL row, loser repeats A): one refused it, assuming
      -- context-promotion fires unconditionally whenever the loser holds
      -- any non-null context — true before the guard existed, a false
      -- positive after; the other then required an UNQUOTED receiver
      -- specifically, missing that an already-quoted receiver is just as
      -- safe once the source_quote branch's whole-group guarantee is
      -- accounted for (Codex review, PR #1297, both times).
      SELECT
        parameter,
        citation_id,
        'observation_context'::text AS field,
        coalesce(nullif(array_to_string(g.winner_ctxs, ', '), ''), 'null') AS winner_val,
        coalesce(
          nullif(array_to_string(u.unmatched, ', '), ''),
          CASE WHEN g.loser_null_has_quote THEN 'null (quoted)' ELSE 'null' END
        ) AS loser_val,
        (
          cardinality(u.unmatched) >= 2
          OR (
            cardinality(u.unmatched) = 1
            AND NOT (
              g.winner_null_unquoted_count = 1
              AND cardinality(g.loser_ctxs) = 1
              AND NOT g.any_quote_in_group
            )
          )
          OR (
            g.loser_null_has_quote
            AND NOT (g.winner_null_unquoted OR g.winner_null_quoted)
          )
          -- Independent of everything above: quote-promotion (~2722) picks
          -- at most ONE loser row per group to promote a quote from —
          -- 'DISTINCT ON <identity> ORDER BY ..., l.id', where identity
          -- excludes context, so it does not pick per-context, it picks
          -- once for the WHOLE group. If the loser holds a quote on 2+ of
          -- its rows, only the lowest-id one is ever promoted; every other
          -- quoted loser row is discarded by the delete with no conflict
          -- raised elsewhere (Codex's finding: both drugs already share
          -- contexts A and B, winner's A/B rows are unquoted, and BOTH
          -- loser rows — one under A, one under B — carry the same quote;
          -- 'unmatched' is empty and the source_quote branch below sees
          -- only one distinct quote text, so neither refuses, yet only one
          -- of the two context-to-quote associations survives). Refuse
          -- whenever 2+ loser rows in the group carry a quote, regardless
          -- of context — this is deliberately blunt rather than checking
          -- whether each already matches its target, for the same reason
          -- the cases above stopped trying to characterize every promotion
          -- interaction individually.
          OR (g.loser_quoted_count >= 2)
        ) AS mismatch
      FROM (
        SELECT
          parameter, unit, matrix, scenario, route,
          citation_id, qualifier, categorical_value, low, high, median,
          ${dk.select(null)},
          array_agg(DISTINCT observation_context) FILTER (
            WHERE drug_id = ${winnerId} AND observation_context IS NOT NULL
          ) AS winner_ctxs,
          array_agg(DISTINCT observation_context) FILTER (
            WHERE drug_id = ${loserId} AND observation_context IS NOT NULL
          ) AS loser_ctxs,
          bool_or(
            drug_id = ${winnerId} AND observation_context IS NULL AND source_quote IS NULL
          ) AS winner_null_unquoted,
          count(*) FILTER (
            WHERE drug_id = ${winnerId} AND observation_context IS NULL AND source_quote IS NULL
          ) AS winner_null_unquoted_count,
          bool_or(
            drug_id = ${winnerId} AND observation_context IS NULL AND source_quote IS NOT NULL
          ) AS winner_null_quoted,
          bool_or(source_quote IS NOT NULL) AS any_quote_in_group,
          bool_or(
            drug_id = ${loserId} AND observation_context IS NULL AND source_quote IS NOT NULL
          ) AS loser_null_has_quote,
          count(*) FILTER (
            WHERE drug_id = ${loserId} AND source_quote IS NOT NULL
          ) AS loser_quoted_count
        FROM parameter_entries
        WHERE drug_id IN (${winnerId}, ${loserId})
        GROUP BY
          parameter, unit, matrix, scenario, route,
          citation_id, qualifier, categorical_value, low, high, median, ${dk.cols(null)}
        HAVING count(*) FILTER (WHERE drug_id = ${winnerId}) > 0
          AND count(*) FILTER (WHERE drug_id = ${loserId}) > 0
      ) g
      CROSS JOIN LATERAL (
        SELECT array(
          SELECT unnest(coalesce(g.loser_ctxs, ARRAY[]::text[]))
          EXCEPT
          SELECT unnest(coalesce(g.winner_ctxs, ARRAY[]::text[]))
        ) AS unmatched
      ) u
      UNION ALL
      -- Quotes are compared ACROSS THE WHOLE dedup group, not pairwise like the
      -- comments branch above, because the dedup deletes every matching loser row
      -- at once and promotes a single quote onto the survivor. A pairwise
      -- winner-vs-loser test misses the case where the winner is unquoted and
      -- the LOSER holds two same-identity rows quoting different sentences:
      -- neither pair looks like a disagreement, the DISTINCT ON ... ORDER BY
      -- l.id promotion takes whichever came first, and the delete removes the
      -- other claim with it. Nothing in the schema forbids those two rows:
      -- there is no uniqueness constraint on the observation tuple.
      --
      -- A one-sided quote is still not a disagreement: a row that has one and a
      -- row that does not is the promotion case, which is why this counts
      -- DISTINCT NON-NULL quotes and fires only at two or more. And the group
      -- must contain rows from both drugs — with no winner row the losers are
      -- repointed rather than deduplicated, so both quotes survive and there is
      -- nothing to refuse.
      SELECT
        parameter,
        citation_id,
        'source_quote'::text AS field,
        min(source_quote) AS winner_val,
        max(source_quote) AS loser_val,
        true AS mismatch
      FROM parameter_entries
      WHERE drug_id IN (${winnerId}, ${loserId})
      GROUP BY
        parameter, unit, matrix, scenario, route,
        citation_id, qualifier, categorical_value, low, high, median, ${dk.cols(null)}
      -- Counted on the COMPARISON key, not the stored text. Storage keeps the
      -- source's own spelling on purpose — a joiner inside a Persian word is
      -- part of that word, and whether an accent arrives composed or decomposed
      -- is decided by the contributor's keyboard — so two rows can hold the
      -- same visible sentence in two encodings. Counting the raw text calls
      -- that a disagreement and refuses a merge over a difference nobody can
      -- see, with no way for an operator to reconcile rows that already say
      -- the same thing. sourceQuoteComparisonKeySql is the same form the
      -- update uses to recognise an echo, so one sentence cannot be an echo
      -- there and a conflict here.
      HAVING count(DISTINCT ${sourceQuoteComparisonKeySql(sql.raw('source_quote'))}) > 1
        AND count(*) FILTER (WHERE drug_id = ${winnerId}) > 0
        AND count(*) FILTER (WHERE drug_id = ${loserId}) > 0
      UNION ALL
      -- Origin-promotion (~2800) upgrades a winner row's 'origin' from a
      -- matching loser row's stronger one. A context-agnostic (NULL-context)
      -- loser row is eligible for this in two ways: an exact match onto a
      -- winner row that ALSO has NULL context (no ambiguity — the loser
      -- observation says nothing a NULL-context winner row contradicts,
      -- whatever OTHER context-bearing winner rows also exist under the
      -- identity), or — only when no such exact receiver exists — the
      -- 'sole winner row' exception in that UPDATE, which requires exactly
      -- one winner row under the identity so there is no ambiguity about
      -- which one it verifies.
      --
      -- So it is genuinely ambiguous, and correctly promotes onto NEITHER
      -- winner row, only when BOTH escapes are unavailable: 2+ winner rows
      -- share the identity AND none of them has NULL context (an earlier
      -- version of this check refused whenever 2+ winner rows existed at
      -- all, wrongly blocking a merge where the loser's context-agnostic
      -- row had an exact NULL-context winner receiver sitting right there —
      -- Codex's finding). When it is genuinely ambiguous, the unconditional
      -- final delete removes the loser row anyway (winner holds
      -- deep-research rows under contexts A and B only, loser holds a
      -- single NULL-context 'contributor' row — the merge would silently
      -- discard that human verification and leave both surviving readings
      -- importer-rewritable, with no trace a stronger origin ever existed).
      -- Refuse rather than lose it — but only when it would actually have
      -- mattered: if the loser's context-agnostic origin is no stronger
      -- than every winner row already holds, promoting it would have
      -- changed nothing, so dropping it is not a loss.
      SELECT
        parameter,
        citation_id,
        'origin_ambiguous'::text AS field,
        winner_row_count::text AS winner_val,
        loser_null_origin::text AS loser_val,
        true AS mismatch
      FROM (
        SELECT
          parameter, unit, matrix, scenario, route,
          citation_id, qualifier, categorical_value, low, high, median,
          ${dk.select(null)},
          count(*) FILTER (WHERE drug_id = ${winnerId}) AS winner_row_count,
          bool_or(observation_context IS NULL) FILTER (
            WHERE drug_id = ${winnerId}
          ) AS winner_has_null_row,
          array_agg(DISTINCT observation_context) FILTER (
            WHERE drug_id = ${winnerId} AND observation_context IS NOT NULL
          ) AS winner_ctxs,
          array_agg(DISTINCT observation_context) FILTER (
            WHERE drug_id = ${loserId} AND observation_context IS NOT NULL
          ) AS loser_ctxs,
          -- min(effective_prio), not min(own prio) (Codex review, PR
          -- #1297): an exact-context loser match promotes a winner row's
          -- origin regardless of the NULL-context ambiguity question below
          -- (it is a separate, unconditional exact match in the real
          -- UPDATE), so a winner row this weak right now may already be
          -- guaranteed to end up stronger than the ambiguous NULL-context
          -- loser origin by the time the merge actually runs. Comparing
          -- against the PRE-promotion minimum treated that already-settled
          -- upgrade as if it hadn't happened, refusing merges where nothing
          -- would actually have been lost.
          min(effective_prio) FILTER (WHERE drug_id = ${winnerId}) AS winner_min_prio,
          max(CASE origin
                WHEN 'contributor' THEN 4
                WHEN 'legacy' THEN 3
                WHEN 'deep-research' THEN 2
                WHEN 'grandfathered' THEN 1
                ELSE 0
              END) FILTER (
                WHERE drug_id = ${loserId} AND observation_context IS NULL
              ) AS loser_null_max_prio,
          -- NOT max(origin): that picks the lexicographically greatest
          -- LABEL ('legacy' > 'contributor' as text), which can disagree
          -- with loser_null_max_prio's priority-based pick when a group
          -- holds several NULL-context loser rows with different origins
          -- (Codex review, PR #1297) — misreporting which provenance is
          -- actually at risk. 'array_agg(... ORDER BY <same CASE> DESC)'
          -- orders by the identical priority expression, so '[1]' is
          -- guaranteed to be the origin 'loser_null_max_prio' computed.
          (array_agg(origin ORDER BY
            CASE origin
              WHEN 'contributor' THEN 4
              WHEN 'legacy' THEN 3
              WHEN 'deep-research' THEN 2
              WHEN 'grandfathered' THEN 1
              ELSE 0
            END DESC
          ) FILTER (
            WHERE drug_id = ${loserId} AND observation_context IS NULL
          ))[1] AS loser_null_origin
        FROM (
          SELECT
            pe.*,
            CASE WHEN pe.drug_id = ${winnerId} THEN GREATEST(
              CASE pe.origin
                WHEN 'contributor' THEN 4
                WHEN 'legacy' THEN 3
                WHEN 'deep-research' THEN 2
                WHEN 'grandfathered' THEN 1
                ELSE 0
              END,
              -- A NULL-context winner row that context-promotion (~2834)
              -- is about to consume (its group has exactly one, genuinely
              -- new loser context, one candidate NULL-unquoted winner row,
              -- no quotes anywhere — the SAME 'safe to promote' gate the
              -- observation_context branch itself uses) will NOT still
              -- have NULL context by the time origin-promotion runs, so
              -- matching against its CURRENT (pre-promotion) context here
              -- overstates its effective strength (a further Codex
              -- finding: winner NULL row matches the loser's separate
              -- NULL-context 'contributor' row exactly, scoring 4 — but
              -- that NULL row is about to become context B, where the
              -- only candidate is a weaker 'deep-research' row, and the
              -- contributor row, now unmatched, is deleted with no
              -- target). Match against the row's POST-promotion context
              -- instead whenever that condition holds; otherwise (steady
              -- state) match against its actual current context, which
              -- covers both non-null context rows and NULL rows that stay
              -- NULL.
              coalesce((
                SELECT max(CASE l.origin
                      WHEN 'contributor' THEN 4
                      WHEN 'legacy' THEN 3
                      WHEN 'deep-research' THEN 2
                      WHEN 'grandfathered' THEN 1
                      ELSE 0
                    END)
                FROM parameter_entries AS l
                WHERE l.drug_id = ${loserId}
                  AND l.parameter = pe.parameter
                  AND l.unit = pe.unit
                  AND l.matrix IS NOT DISTINCT FROM pe.matrix
                  AND l.scenario IS NOT DISTINCT FROM pe.scenario
                  AND l.route IS NOT DISTINCT FROM pe.route
                  AND l.citation_id IS NOT DISTINCT FROM pe.citation_id
                  AND l.qualifier IS NOT DISTINCT FROM pe.qualifier
                  AND l.categorical_value IS NOT DISTINCT FROM pe.categorical_value
                  AND l.low IS NOT DISTINCT FROM pe.low
                  AND l.high IS NOT DISTINCT FROM pe.high
                  AND l.median IS NOT DISTINCT FROM pe.median
                  ${dk.eq('l', 'pe')}
                  AND (
                    CASE
                      -- pe is NULL-context and about to be consumed: match
                      -- against the group's single genuinely-new loser
                      -- context instead of NULL. This WHEN condition is
                      -- deliberately self-contained on 'pe' alone (no
                      -- reference to 'l') — it must evaluate the same way
                      -- for every candidate loser row, including the
                      -- NULL-context one itself, which an earlier version
                      -- of this fix got wrong by comparing against
                      -- 'l.observation_context' even when 'l' WAS the
                      -- NULL-context row.
                      WHEN pe.observation_context IS NULL
                        AND pe.source_quote IS NULL
                        -- exactly one distinct non-null loser context for
                        -- this identity
                        AND (
                          SELECT count(DISTINCT l2.observation_context)
                          FROM parameter_entries AS l2
                          WHERE l2.drug_id = ${loserId}
                            AND l2.parameter = pe.parameter AND l2.unit = pe.unit
                            AND l2.matrix IS NOT DISTINCT FROM pe.matrix
                            AND l2.scenario IS NOT DISTINCT FROM pe.scenario
                            AND l2.route IS NOT DISTINCT FROM pe.route
                            AND l2.citation_id IS NOT DISTINCT FROM pe.citation_id
                            AND l2.qualifier IS NOT DISTINCT FROM pe.qualifier
                            AND l2.categorical_value IS NOT DISTINCT FROM pe.categorical_value
                            AND l2.low IS NOT DISTINCT FROM pe.low
                            AND l2.high IS NOT DISTINCT FROM pe.high
                            AND l2.median IS NOT DISTINCT FROM pe.median
                            ${dk.eq('l2', 'pe')}
                            AND l2.observation_context IS NOT NULL
                        ) = 1
                        -- that single value is genuinely new: not already
                        -- present on any winner row for this identity
                        AND NOT EXISTS (
                          SELECT 1
                          FROM parameter_entries AS w4
                          JOIN parameter_entries AS l4 ON
                            l4.drug_id = ${loserId}
                            AND l4.parameter = pe.parameter AND l4.unit = pe.unit
                            AND l4.matrix IS NOT DISTINCT FROM pe.matrix
                            AND l4.scenario IS NOT DISTINCT FROM pe.scenario
                            AND l4.route IS NOT DISTINCT FROM pe.route
                            AND l4.citation_id IS NOT DISTINCT FROM pe.citation_id
                            AND l4.qualifier IS NOT DISTINCT FROM pe.qualifier
                            AND l4.categorical_value IS NOT DISTINCT FROM pe.categorical_value
                            AND l4.low IS NOT DISTINCT FROM pe.low
                            AND l4.high IS NOT DISTINCT FROM pe.high
                            AND l4.median IS NOT DISTINCT FROM pe.median
                            ${dk.eq('l4', 'pe')}
                            AND l4.observation_context IS NOT NULL
                          WHERE w4.drug_id = ${winnerId}
                            AND w4.parameter = pe.parameter AND w4.unit = pe.unit
                            AND w4.matrix IS NOT DISTINCT FROM pe.matrix
                            AND w4.scenario IS NOT DISTINCT FROM pe.scenario
                            AND w4.route IS NOT DISTINCT FROM pe.route
                            AND w4.citation_id IS NOT DISTINCT FROM pe.citation_id
                            AND w4.qualifier IS NOT DISTINCT FROM pe.qualifier
                            AND w4.categorical_value IS NOT DISTINCT FROM pe.categorical_value
                            AND w4.low IS NOT DISTINCT FROM pe.low
                            AND w4.high IS NOT DISTINCT FROM pe.high
                            AND w4.median IS NOT DISTINCT FROM pe.median
                            ${dk.eq('w4', 'pe')}
                            AND w4.observation_context = l4.observation_context
                        )
                        -- exactly one NULL-context, unquoted winner row for
                        -- this identity (pe must be it, by construction)
                        AND (
                          SELECT count(*) FROM parameter_entries AS w5
                          WHERE w5.drug_id = ${winnerId}
                            AND w5.parameter = pe.parameter AND w5.unit = pe.unit
                            AND w5.matrix IS NOT DISTINCT FROM pe.matrix
                            AND w5.scenario IS NOT DISTINCT FROM pe.scenario
                            AND w5.route IS NOT DISTINCT FROM pe.route
                            AND w5.citation_id IS NOT DISTINCT FROM pe.citation_id
                            AND w5.qualifier IS NOT DISTINCT FROM pe.qualifier
                            AND w5.categorical_value IS NOT DISTINCT FROM pe.categorical_value
                            AND w5.low IS NOT DISTINCT FROM pe.low
                            AND w5.high IS NOT DISTINCT FROM pe.high
                            AND w5.median IS NOT DISTINCT FROM pe.median
                            ${dk.eq('w5', 'pe')}
                            AND w5.observation_context IS NULL
                            AND w5.source_quote IS NULL
                        ) = 1
                        -- no quotes anywhere in the group
                        AND NOT EXISTS (
                          SELECT 1 FROM parameter_entries AS q
                          WHERE q.drug_id IN (${winnerId}, ${loserId})
                            AND q.parameter = pe.parameter AND q.unit = pe.unit
                            AND q.matrix IS NOT DISTINCT FROM pe.matrix
                            AND q.scenario IS NOT DISTINCT FROM pe.scenario
                            AND q.route IS NOT DISTINCT FROM pe.route
                            AND q.citation_id IS NOT DISTINCT FROM pe.citation_id
                            AND q.qualifier IS NOT DISTINCT FROM pe.qualifier
                            AND q.categorical_value IS NOT DISTINCT FROM pe.categorical_value
                            AND q.low IS NOT DISTINCT FROM pe.low
                            AND q.high IS NOT DISTINCT FROM pe.high
                            AND q.median IS NOT DISTINCT FROM pe.median
                            ${dk.eq('q', 'pe')}
                            AND q.source_quote IS NOT NULL
                        )
                      -- Consumed: only a non-null-context loser row can be
                      -- the promoted value — the NULL-context loser row
                      -- itself is never a candidate for this branch.
                      THEN l.observation_context IS NOT NULL
                      -- Steady state: match the row's actual current
                      -- context (NULL matches NULL, a non-null context
                      -- matches exactly).
                      ELSE l.observation_context IS NOT DISTINCT FROM pe.observation_context
                    END
                  )
              ), 0)
            ) END AS effective_prio
          FROM parameter_entries AS pe
          WHERE pe.drug_id IN (${winnerId}, ${loserId})
        ) scored
        GROUP BY
          parameter, unit, matrix, scenario, route,
          citation_id, qualifier, categorical_value, low, high, median, ${dk.cols(null)}
        HAVING count(*) FILTER (WHERE drug_id = ${winnerId}) > 0
          AND count(*) FILTER (WHERE drug_id = ${loserId}) > 0
      ) ambiguous
      WHERE winner_row_count >= 2
        AND (
          NOT winner_has_null_row
          OR (
            -- Even when a NULL-context winner row exists right now, it
            -- will not survive to receive the loser's context-agnostic
            -- origin if context-promotion (~2700, running BEFORE origin-
            -- promotion) consumes it first for an unrelated reason — a
            -- further Codex finding: winner holds a NULL-context row plus
            -- context A; loser holds a NULL-context 'contributor' row PLUS
            -- a genuinely new context B row. detectDataConflicts' own
            -- 'observation_context' branch allows promoting B (the only
            -- unmatched value, one candidate, no ambiguity there) onto the
            -- sole NULL-context winner row — which then has context B by
            -- the time origin-promotion runs, leaving nothing for the
            -- NULL-context loser row to exact-match against. This mirrors
            -- that branch's own 'safe to promote a new value' gate exactly
            -- (cardinality(loser_ctxs) = 1 and it is not already on the
            -- winner): only in that shape does context-promotion touch the
            -- NULL winner row at all.
            cardinality(loser_ctxs) = 1
            AND NOT (loser_ctxs[1] = ANY(coalesce(winner_ctxs, ARRAY[]::text[])))
          )
        )
        AND loser_null_max_prio IS NOT NULL
        AND loser_null_max_prio > winner_min_prio
    ) unioned WHERE mismatch`);
  for (const row of divergentAncillaryRows.rows) {
    if (row.field === 'n') {
      conflicts.push({
        table: 'parameter_entries',
        identity: `${row.parameter} (citation ${row.citation_id ?? 'none'}) — winner n=${row.winner_val} vs loser n=${row.loser_val}`,
        message: {
          code: 'dataConflict.parameterEntryDivergentN',
          params: {
            parameter: row.parameter,
            winnerN: row.winner_val,
            loserN: row.loser_val,
          },
          fallback: `both entries have an identical observation for ${row.parameter} but disagree on sample size (n=${row.winner_val} vs n=${row.loser_val}). A normal insert would reject the duplicate; a merge cannot pick one n without silently changing the survivor's aggregate weight. Reconcile on the drugs first (merge the n values, drop one row, or file them under distinct citations), then merge.`,
        },
      });
    } else if (row.field === 'source_quote') {
      conflicts.push({
        table: 'parameter_entries',
        identity: `${row.parameter} (citation ${row.citation_id ?? 'none'}) — two different source quotes in the merged group`,
        message: {
          code: 'dataConflict.parameterEntryDivergentQuotes',
          params: {
            parameter: row.parameter,
            winnerQuote: row.winner_val,
            loserQuote: row.loser_val,
          },
          fallback: `the rows being folded together for ${row.parameter} are an identical observation citing the same source, but quote different text from it ("${row.winner_val}" vs "${row.loser_val}"). One of them is reading the wrong sentence, which is exactly the error a stored quote exists to expose — a silent dedup would keep one at random and delete the other. Check the source, keep the quote that states this value, then merge.`,
        },
      });
    } else if (row.field === 'observation_context') {
      conflicts.push({
        table: 'parameter_entries',
        identity: `${row.parameter} (citation ${row.citation_id ?? 'none'}) — winner observation context ≠ loser observation context`,
        message: {
          code: 'dataConflict.parameterEntryDivergentObservationContext',
          params: {
            parameter: row.parameter,
            winnerContext: row.winner_val,
            loserContext: row.loser_val,
          },
          fallback: `both entries have an identical observation for ${row.parameter} but disagree on study context — either stating different text, or one stating none while a quote is attached somewhere in the group (values seen: "${row.winner_val}" / "${row.loser_val}"). Unlike a curator note, this is evidence a stored quote attests to — a silent dedup could keep one context at random or leave a quote attached to a context it was never checked against. Reconcile on the drugs first (merge the context, or file the observations under distinct citations), then merge.`,
        },
      });
    } else if (row.field === 'origin_ambiguous') {
      conflicts.push({
        table: 'parameter_entries',
        identity: `${row.parameter} (citation ${row.citation_id ?? 'none'}) — loser origin '${row.loser_val}' cannot be attributed to one of ${row.winner_val} same-identity winner rows`,
        message: {
          code: 'dataConflict.parameterEntryAmbiguousOrigin',
          params: {
            parameter: row.parameter,
            winnerRowCount: row.winner_val,
            loserOrigin: row.loser_val,
          },
          fallback: `a loser observation for ${row.parameter} states no study context and would be dropped as a duplicate, but its origin ('${row.loser_val}') is stronger than at least one of the ${row.winner_val} winner rows sharing this identity under different contexts — and which one it verifies cannot be determined without a context to match against. Dropping it silently would lose that provenance. Reconcile on the drugs first (add a context to the loser observation, or file it under a distinct citation), then merge.`,
        },
      });
    } else {
      conflicts.push({
        table: 'parameter_entries',
        identity: `${row.parameter} (citation ${row.citation_id ?? 'none'}) — winner comment ≠ loser comment`,
        message: {
          code: 'dataConflict.parameterEntryDivergentComments',
          params: {
            parameter: row.parameter,
            winnerComment: row.winner_val,
            loserComment: row.loser_val,
          },
          fallback: `both entries have an identical observation for ${row.parameter} but hold different curator comments (winner: "${row.winner_val}"; loser: "${row.loser_val}"). Source entries stay additive across the fold, so a silent dedup would drop the loser's note. Reconcile on the drugs first (merge the comments, or file the observations under distinct citations), then merge.`,
        },
      });
    }
  }

  // An interaction arm whose interacting drug and either its analyte or the
  // drug dosed are the two sides of this merge (Cmax release B, #1340). The
  // merge repoints `drug_id`, `administered_drug_id` and `interacting_drug_id`
  // loser → winner, so "W's Cmax when coadministered with L" — or a third
  // drug's metabolite reading "after dosing L, coadministered with W" — would
  // become an interaction study with one drug in it. That is not a duplicate
  // to drop or a value to pick; the source recorded the two as DIFFERENT
  // substances, measuring one in the presence of the other, which is evidence
  // against merging them at all. Any drug's entry can carry it, not only the
  // two being merged (Codex P1 on #1360). Nothing writes
  // `interacting_drug_id` before release C, so this cannot fire today — it
  // ships here because a handler has to be deployed before the first value
  // exists.
  const selfInteractionRows = await db.execute<{
    id: number;
    parameter: string;
  }>(sql`
    SELECT id, parameter
    FROM parameter_entries
    WHERE interacting_drug_id IN (${winnerId}, ${loserId})
      AND (
        (drug_id IN (${winnerId}, ${loserId}) AND drug_id <> interacting_drug_id)
        OR (administered_drug_id IN (${winnerId}, ${loserId})
            AND administered_drug_id <> interacting_drug_id)
      )
    ORDER BY id`);
  for (const row of selfInteractionRows.rows) {
    conflicts.push({
      table: 'parameter_entries',
      identity: `${row.parameter} entry ${row.id} — an interaction arm between the two drugs being merged`,
      message: {
        code: 'dataConflict.parameterEntrySelfInteraction',
        params: { parameter: row.parameter, entryId: row.id },
        fallback: `source entry ${row.id} records ${row.parameter} with one of these drugs measured or dosed in the presence of the other — an interaction study that treats them as two different substances. Merging would turn it into a drug interacting with itself. Correct or remove that entry on the drugs first if they really are one substance, then merge.`,
      },
    });
  }

  // The same self-interaction, inside an active proposal's payload: the
  // proposal's analyte (a create's target, or the drug owning an update's
  // entry) or its `administeredDrugId` on one side, and `interactingDrugId`
  // on the other. The nested repoint in step 11 would turn it into a drug
  // interacting with itself, which approval would then publish.
  const selfInteractionProposals = await db.execute<{ id: number }>(sql`
    SELECT id FROM (
      SELECT pe.id,
             coalesce(
               CASE WHEN (pe.proposed_value ->> 'op') = 'create' THEN pe.target_id END,
               e.drug_id
             ) AS owner,
             CASE WHEN jsonb_typeof(coalesce(
                    pe.proposed_value #> '{input,administeredDrugId}',
                    pe.proposed_value #> '{patch,administeredDrugId}')) = 'number'
                  THEN coalesce(
                    (pe.proposed_value #>> '{input,administeredDrugId}')::int,
                    (pe.proposed_value #>> '{patch,administeredDrugId}')::int)
             END AS administered,
             CASE WHEN jsonb_typeof(coalesce(
                    pe.proposed_value #> '{input,interactingDrugId}',
                    pe.proposed_value #> '{patch,interactingDrugId}')) = 'number'
                  THEN coalesce(
                    (pe.proposed_value #>> '{input,interactingDrugId}')::int,
                    (pe.proposed_value #>> '{patch,interactingDrugId}')::int)
             END AS interacting
      FROM pending_edits pe
      LEFT JOIN parameter_entries e
        ON (pe.proposed_value ->> 'op') = 'update' AND e.id = pe.target_id
      WHERE pe.edit_type = 'param_entry'
        AND pe.status IN ${sql.raw(`('${ACTIVE_PENDING_EDIT_STATUSES.join("', '")}')`)}
    ) p
    WHERE interacting IN (${winnerId}, ${loserId})
      AND (
        (owner IN (${winnerId}, ${loserId}) AND owner <> interacting)
        OR (administered IN (${winnerId}, ${loserId}) AND administered <> interacting)
      )
    ORDER BY id`);
  for (const row of selfInteractionProposals.rows) {
    conflicts.push({
      table: 'pending_edits',
      identity: `param_entry proposal ${row.id} — an interaction arm between the two drugs being merged`,
      message: {
        code: 'dataConflict.pendingEntrySelfInteraction',
        params: { pendingEditId: row.id },
        fallback: `open proposal ${row.id} records a value with one of these drugs measured or dosed in the presence of the other. Merging would turn it into a drug interacting with itself. Settle it from the /review queue first, then merge.`,
      },
    });
  }

  // Two entries of a THIRD drug that differ only in naming the loser where the
  // other names the winner (as administered or interacting drug). The repoint
  // makes them one observation recorded twice — pooled twice — and the dedup
  // further down compares only the two merged drugs' own rows, so nothing
  // would drop either (Codex P1 on #1360). Which of the two carries the
  // provenance (quote, n, origin, open proposals) is not the merge's to pick:
  // refused, like the other identical-observation disagreements, until a
  // curator removes one.
  const thirdPartyCollisions = await db.execute<{
    parameter: string;
    first_id: number;
    second_id: number;
  }>(sql`
    SELECT a.parameter, a.id AS first_id, b.id AS second_id
    FROM parameter_entries AS a
    JOIN parameter_entries AS b
      ON b.drug_id = a.drug_id
     AND b.id > a.id
     AND b.parameter = a.parameter
     AND b.unit = a.unit
     AND b.matrix IS NOT DISTINCT FROM a.matrix
     AND b.scenario IS NOT DISTINCT FROM a.scenario
     AND b.route IS NOT DISTINCT FROM a.route
     AND b.citation_id IS NOT DISTINCT FROM a.citation_id
     AND b.qualifier IS NOT DISTINCT FROM a.qualifier
     AND b.categorical_value IS NOT DISTINCT FROM a.categorical_value
     AND b.low IS NOT DISTINCT FROM a.low
     AND b.high IS NOT DISTINCT FROM a.high
     AND b.median IS NOT DISTINCT FROM a.median
     ${dk.eq('a', 'b')}
    WHERE a.drug_id NOT IN (${winnerId}, ${loserId})
      AND (a.administered_drug_id IS DISTINCT FROM b.administered_drug_id
        OR a.interacting_drug_id IS DISTINCT FROM b.interacting_drug_id)
    ORDER BY a.id, b.id`);
  for (const row of thirdPartyCollisions.rows) {
    conflicts.push({
      table: 'parameter_entries',
      identity: `${row.parameter} entries ${row.first_id} and ${row.second_id} — one observation once both drugs are one`,
      message: {
        code: 'dataConflict.parameterEntryThirdPartyDuplicate',
        params: {
          parameter: row.parameter,
          firstEntryId: row.first_id,
          secondEntryId: row.second_id,
        },
        fallback: `source entries ${row.first_id} and ${row.second_id} record the same ${row.parameter} observation for another drug, one naming each of these drugs as the drug given or coadministered. Once they are merged the two are one observation recorded twice, and it would be counted twice. Remove one of them on that drug first, then merge.`,
      },
    });
  }

  // Pending parameter proposals both entries hold for the same parameter. The
  // sweep before drug delete would otherwise drop the loser's to satisfy the
  // open-parameter unique index — silently discarding a contributor's queued
  // work-in-progress. Surface it so a curator can reject or apply one first.
  const pendingRows = await db.execute<{ parameter: string }>(sql`
    SELECT DISTINCT s.parameter AS parameter
    FROM pending_edits s
    JOIN pending_edits t
      ON t.edit_type = 'parameter'
     AND t.status = 'pending'
     AND t.target_id = ${loserId}
     AND t.parameter IS NOT DISTINCT FROM s.parameter
    WHERE s.edit_type = 'parameter'
      AND s.status = 'pending'
      AND s.target_id = ${winnerId}`);
  for (const row of pendingRows.rows) {
    conflicts.push({
      table: 'pending_edits',
      identity: `open parameter proposal: ${row.parameter}`,
      message: {
        code: 'dataConflict.pendingParameterProposal',
        fallback: 'both entries have an open review-queue proposal for this parameter — merging would silently discard the loser\'s. Resolve one from the /review queue first, then merge.',
      },
    });
  }

  // A monograph that is EMPTY NOW can still have been written. `wiki_revisions`
  // cascades on the page delete, so blanking a page and then merging it away
  // destroys the editorial history that blanking did not — and the current
  // snapshot, which is all `monographHasContent` reads, says nothing about it.
  // Inspect BOTH channels: the tag-stripped `content_html`, AND the JSONB
  // `content` for any non-empty `.text` node. `scripts/seed-drug-monographs.ts`
  // creates rows with populated `content` and `contentHtml: ''`, so an HTML-
  // only check would misclassify those as disposable stubs. Only meaningful
  // when the current snapshot is empty; a monograph with current prose is
  // already reported as a warning by `buildDrugMergePlan`.
  // Meaningful revision: any of
  //   - `content_html` has non-empty text after tag-stripping (paragraph
  //     prose), OR
  //   - the JSONB `content` has a non-empty `.text` node (paragraph prose
  //     the HTML cache doesn't have), OR
  //   - the JSONB `content` has any structural node beyond the empty-doc
  //     baseline: `type` other than `doc` or `paragraph` (image, heading,
  //     table, blockquote, list, mediaEmbed, etc.). This mirrors the semantics
  //     of `isTipTapDocEmpty` used elsewhere — an empty doc is at most a
  //     wrapping `doc` with empty `paragraph` children, and anything else is
  //     editorial content worth preserving in history.
  if (loser.monograph && !loser.monograph.hasContent) {
    const rows = (
      await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM wiki_revisions
        WHERE page_id = ${loser.monograph.pageId}
          AND (
            length(btrim(regexp_replace(coalesce(content_html, ''),
                                        '<[^>]*>', '', 'g'))) > 0
            OR jsonb_path_exists(
                 coalesce(content, '{}'::jsonb),
                 '$.**.text ? (@.type() == "string" && @ != "")'
               )
            OR jsonb_path_exists(
                 coalesce(content, '{}'::jsonb),
                 '$.**.type ? (@.type() == "string" && @ != "doc" && @ != "paragraph")'
               )
          )`)
    ).rows;
    const writtenRevisions = rows[0]?.n ?? 0;
    if (writtenRevisions > 0) {
      conflicts.push({
        table: 'wiki_revisions',
        identity: `${writtenRevisions} written revision(s) on loser monograph /${loser.monograph.slug}`,
        message: {
          code: 'dataConflict.revisionHistory',
          fallback: 'the loser monograph is empty now but has revisions with meaningful content in them (paragraph prose, images, headings, tables, lists or other structural nodes). `wiki_revisions` cascades on the page delete, so a merge would destroy editorial history that blanking the page did not. Move the content onto the survivor, or accept the loss deliberately by clearing the history first, then merge.',
        },
      });
    }
  }

  // Ambiguous saved-simulator keys — a bare-numeric `case_data.drugs[].drugId`
  // (predating #1256, or naming a CID under it either way) is ambiguous
  // whenever one drug carries that number as a `pubchem_cid` while another
  // CID-less drug carries it as its `drugs.id`. `hydrateComponentByRouteId`
  // prefers the CID lookup, and the merge's saved-case rewrite matches by
  // that string — so on the loser side the rewrite would sweep up cases
  // pointing at the *other* drug, and on the winner side the winner's own
  // cases might already be resolving to a different substance. Refuse before
  // touching `simulator_cases`, same as the CLI merge
  // (`scripts/merge-drugs.ts` `ambiguousSimulatorKey`). Checks every spelling
  // {@link simulatorDrugKeyCandidates} says a saved case might currently use
  // — a `drug:<id>` key is never ambiguous and is skipped by the regex below.
  const winnerSimKeys = simulatorDrugKeyCandidates(winner);
  const loserSimKeys = simulatorDrugKeyCandidates(loser);
  for (const [role, key] of [
    ...winnerSimKeys.map((key) => ['winner', key] as const),
    ...loserSimKeys.map((key) => ['loser', key] as const),
  ] as const) {
    if (!/^\d+$/.test(key)) continue;
    const n = Number(key);
    if (!Number.isSafeInteger(n)) continue;
    const rows = (
      await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM drugs a
        WHERE a.pubchem_cid = ${n}
          AND EXISTS (
            SELECT 1 FROM drugs b
            WHERE b.id = ${n} AND b.pubchem_cid IS NULL AND b.id <> a.id
          )`)
    ).rows;
    const ambiguousCount = rows[0]?.n ?? 0;
    if (ambiguousCount > 0) {
      conflicts.push({
        table: 'simulator_cases',
        identity: `${role} saved-case key "${key}"`,
        message: {
          code: 'dataConflict.ambiguousSimulatorKey',
          params: { role, key },
          fallback: `the ${role} saved-simulator key "${key}" names two substances — one drug carries it as its PubChem CID and another CID-less drug carries it as its internal id. Rewriting saved cases by that string would sweep up the other drug's cases too. Correct the CID collision on the drugs first, then merge.`,
        },
      });
    }
  }

  return conflicts;
}

/**
 * Look up every seed file that still keys a substance by this PubChem CID.
 *
 * Delegates to `scripts/pubchem/seed-sources.ts` — the same exhaustive check
 * `scripts/merge-drugs.ts` uses. `data/components.ts` is only one of the seed
 * inputs; `data/substanceClasses.ts` and the `resources/*.json` datasets are
 * keyed by CID too, and a stale entry in any of them either resurrects the
 * retired drug (`seed:drugs`, `seed:pm-concentrations`), mis-classifies it, or
 * silently leaves its data unattached (`seed:pm-am-ratios`). A merge that
 * leaves any of them behind silently reverses on the next seed run.
 *
 * Lazy-imported so an unrelated build step that pulls `api/_lib/drug-merge`
 * doesn't drag the whole fixture set into every bundle. Cached per PubChem CID
 * because the fixtures are static files and this warning is called from every
 * merge preview.
 */
interface FixtureHit {
  file: string;
  label?: string;
}
const fixtureCidCache = new Map<number, FixtureHit[]>();
async function fixtureEntriesForCid(pubchemCid: number): Promise<FixtureHit[]> {
  if (fixtureCidCache.has(pubchemCid)) return fixtureCidCache.get(pubchemCid)!;
  const [{ seedSourcesFor }, { embeddedComponents }] = await Promise.all([
    import('../../scripts/pubchem/seed-sources.js'),
    import('../../data/components.js'),
  ]);
  const hits = seedSourcesFor(pubchemCid, embeddedComponents);
  fixtureCidCache.set(pubchemCid, hits);
  return hits;
}

/**
 * Union two `reference_ids` arrays, de-duplicating while preserving first-seen
 * order — the same rule the `citation-merge.ts` array repointer uses, and for
 * the same reason: reference order is authored and decides `[1][2]` marker
 * numbering.
 */
function mergeReferenceIdArrays(
  winnerRefs: number[] | null | undefined,
  loserRefs: number[] | null | undefined,
): number[] | null {
  const combined = [...(winnerRefs ?? []), ...(loserRefs ?? [])];
  if (combined.length === 0) return null;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of combined) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

async function countRows(db: Db, query: SQL): Promise<number> {
  const result = await db.execute<{ count: number }>(query);
  return Number(result.rows?.[0]?.count ?? 0);
}

async function buildCounts(
  db: Db,
  winnerId: number,
  loserId: number,
  conflicts: DrugMergeConflict[],
  loserSlug: string,
): Promise<DrugMergeCounts> {
  const conflictParams = new Set(
    conflicts.filter((c) => c.kind === 'parameter').map((c) => c.key),
  );

  const [
    loserParams,
    entries,
    methodRows,
    metaboliteRows,
    precursorRows,
    receptorTargets,
    enzymeInteractions,
    eliminationRoutes,
    ionizationConstants,
    pmDistributions,
  ] = await Promise.all([
    db.select({ parameter: drugParameters.parameter }).from(drugParameters).where(eq(drugParameters.drugId, loserId)),
    countRows(db, sql`SELECT count(*)::int AS count FROM parameter_entries WHERE drug_id = ${loserId}`),
    db.select({ methodId: analyticalMethodComponents.methodId }).from(analyticalMethodComponents).where(eq(analyticalMethodComponents.drugId, loserId)),
    db.select({ id: drugMetabolites.id, metaboliteDrugId: drugMetabolites.metaboliteDrugId, name: drugMetabolites.metaboliteName }).from(drugMetabolites).where(eq(drugMetabolites.parentDrugId, loserId)),
    db.select({ id: drugMetabolites.id, parentDrugId: drugMetabolites.parentDrugId }).from(drugMetabolites).where(eq(drugMetabolites.metaboliteDrugId, loserId)),
    countRows(db, sql`SELECT count(*)::int AS count FROM drug_receptor_targets WHERE drug_id = ${loserId}`),
    countRows(db, sql`SELECT count(*)::int AS count FROM drug_enzyme_interactions WHERE drug_id = ${loserId}`),
    countRows(db, sql`SELECT count(*)::int AS count FROM drug_elimination_routes WHERE drug_id = ${loserId}`),
    countRows(db, sql`SELECT count(*)::int AS count FROM drug_ionization_constants WHERE drug_id = ${loserId}`),
    countRows(db, sql`SELECT count(*)::int AS count FROM pm_concentration_distributions WHERE drug_id = ${loserId}`),
  ]);

  // Method memberships that would collide vs. move.
  const winnerMethods = new Set(
    (
      await db
        .select({ methodId: analyticalMethodComponents.methodId })
        .from(analyticalMethodComponents)
        .where(eq(analyticalMethodComponents.drugId, winnerId))
    ).map((r) => r.methodId),
  );
  let methodMembershipsDeduped = 0;
  for (const row of methodRows) {
    if (winnerMethods.has(row.methodId)) methodMembershipsDeduped += 1;
  }

  const atlasRows = await countRows(
    db,
    sql`
      SELECT (
        (SELECT count(*) FROM pattern_reference_exposures WHERE drug_id = ${loserId})
        + (SELECT count(*) FROM pattern_reference_observations WHERE drug_id = ${loserId} OR reported_as_drug_id = ${loserId})
        + (SELECT count(*) FROM pattern_reference_aggregates WHERE drug_id = ${loserId} OR reported_as_drug_id = ${loserId})
      )::int AS count`,
  );

  const idLike = `%/wiki/drug/${loserId}%`;
  const slugLike = `%/wiki/${loserSlug}%`;
  const wikiPagesRelinked = await countRows(
    db,
    sql`
      SELECT count(*)::int AS count FROM wiki_pages
      WHERE content::text LIKE ${idLike} OR content_html LIKE ${idLike}
         OR content::text LIKE ${slugLike} OR content_html LIKE ${slugLike}`,
  );

  return {
    parametersMovedCleanly: loserParams.filter((r) => !conflictParams.has(r.parameter)).length,
    parameterEntries: entries,
    methodMembershipsMoved: methodRows.length - methodMembershipsDeduped,
    methodMembershipsDeduped,
    metaboliteEdgesMoved: metaboliteRows.length,
    metaboliteEdgesDeduped: 0,
    precursorLinksMoved: precursorRows.length,
    precursorLinksDeduped: 0,
    receptorTargets,
    enzymeInteractions,
    eliminationRoutes,
    ionizationConstants,
    pmDistributions,
    atlasRows,
    wikiPagesRelinked,
  };
}

/**
 * Build the merge plan for a chosen direction: the conflicts an admin must
 * resolve and a count of what will move. Read-only.
 */
export async function buildDrugMergePlan(
  db: Db,
  winner: DrugSideInfo,
  loser: DrugSideInfo,
  suggestion: { byMonograph: boolean; reason: DrugMergeTranslatableMessage },
): Promise<DrugMergePlan> {
  const conflicts = await detectSingleValueConflicts(db, winner.id, loser.id);
  const blockers = await detectApplicabilityBlockers(db, winner.id, loser.id);
  const dataConflicts = await detectDataConflicts(db, winner, loser);
  const substanceClassMismatch =
    winner.substanceClass !== loser.substanceClass
      ? { winner: winner.substanceClass, loser: loser.substanceClass }
      : null;
  const counts = await buildCounts(db, winner.id, loser.id, conflicts, loser.slug);
  const warnings: DrugMergeTranslatableMessage[] = [];
  if (loser.monograph?.hasContent) {
    warnings.push({
      code: 'warnings.loserHasContent',
      params: { loserName: loser.name, loserId: loser.id },
      fallback: `The entry being removed ("${loser.name}", id ${loser.id}) has a written monograph. Its prose will NOT be carried over — only structured data is merged. Copy anything worth keeping into the surviving monograph first.`,
    });
  }
  // The seed fixtures are `pubchem_cid`-keyed inputs to the database (data/
  // and resources/): if the loser's CID still appears in ANY of them, the
  // next `npm run seed:*` recreates the duplicate — the merge silently
  // reverses — OR the fixture's data lands on, or silently misses, a different
  // substance whose id now happens to equal the freed CID. Warn the admin to prune or retarget every named entry
  // first; the merge itself still proceeds (fixture edits happen outside the
  // admin UI). The full seed-source set is the same one `scripts/merge-drugs.ts`
  // refuses on — the admin path only warns because a curator running this UI
  // may be about to commit the fixture change immediately.
  if (loser.pubchemCid != null) {
    const seedHits = await fixtureEntriesForCid(loser.pubchemCid);
    if (seedHits.length > 0) {
      const named = seedHits
        .map((s) => (s.label ? `${s.file} ("${s.label}")` : s.file))
        .join(', ');
      warnings.push({
        code: 'warnings.seedFixtureReseed',
        params: { pubchemCid: loser.pubchemCid, sources: named },
        fallback: `The entry being removed has PubChem CID ${loser.pubchemCid}, which is still keyed in ${named}. The next seed run for any of these will recreate the duplicate — or silently attach the fixture's data to whichever surviving drug now claims that internal id. Prune or retarget every named entry before the next seed run, or the merge will silently reverse.`,
      });
    }
  }
  const planFingerprint = computePlanFingerprint({
    winner,
    loser,
    conflicts,
    blockers,
    dataConflicts,
    substanceClassMismatch,
  });
  return {
    winner,
    loser,
    suggestedByMonograph: suggestion.byMonograph,
    winnerReason: suggestion.reason,
    conflicts,
    blockers,
    dataConflicts,
    substanceClassMismatch,
    warnings,
    counts,
    planFingerprint,
  };
}

/**
 * SHA-256 hex over a stable serialisation of the decision-relevant plan state.
 * The admin approved a specific set of values and refusal shapes — every one
 * of them factors in, and NOTHING that is only informational (counts, human
 * warnings, suggestion reason, id-only ordering) does. A different fingerprint
 * from the one the admin sees at apply time is a stale approval: the value a
 * conflict listed changed, the loser monograph gained prose, a new blocker
 * appeared. See {@link DrugMergeStalePlanError}.
 *
 * Uses `stableStringify` (keys sorted, arrays kept in order) so serialisation
 * is stable across Node versions and V8 map-order quirks. Same-input hash is
 * identical between preview and re-derivation under the merge lock.
 */
function computePlanFingerprint(input: {
  winner: DrugSideInfo;
  loser: DrugSideInfo;
  conflicts: DrugMergeConflict[];
  blockers: DrugMergeBlocker[];
  dataConflicts: DrugMergeDataConflict[];
  substanceClassMismatch: { winner: string; loser: string } | null;
}): string {
  // Sort conflicts by their canonical id so preview order and apply order
  // (which re-derives them) hash to the same string regardless of the loop's
  // insertion order.
  const conflicts = [...input.conflicts]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => ({
      id: c.id,
      winnerValue: c.winnerValue ?? null,
      loserValue: c.loserValue ?? null,
    }));
  const blockers = [...input.blockers]
    .sort((a, b) =>
      a.parameter.localeCompare(b.parameter) || a.reason.localeCompare(b.reason),
    )
    .map((b) => ({ parameter: b.parameter, reason: b.reason }));
  const dataConflicts = [...input.dataConflicts]
    .sort((a, b) =>
      a.table.localeCompare(b.table) || a.identity.localeCompare(b.identity),
    )
    .map((d) => ({ table: d.table, identity: d.identity }));
  const payload = {
    winnerId: input.winner.id,
    loserId: input.loser.id,
    winnerClass: input.winner.substanceClass,
    loserClass: input.loser.substanceClass,
    winnerMonographHasContent: input.winner.monograph?.hasContent ?? null,
    loserMonographHasContent: input.loser.monograph?.hasContent ?? null,
    winnerMonographPageId: input.winner.monograph?.pageId ?? null,
    loserMonographPageId: input.loser.monograph?.pageId ?? null,
    // Include the content digests too — `hasContent` only catches empty↔
    // written transitions, but an edit between two non-empty snapshots
    // (existing prose being rewritten while the admin reviews the plan)
    // leaves `hasContent` true on both sides and would slip past the
    // fingerprint check otherwise.
    winnerMonographContentDigest: input.winner.monograph?.contentDigest ?? null,
    loserMonographContentDigest: input.loser.monograph?.contentDigest ?? null,
    conflicts,
    blockers,
    dataConflicts,
    substanceClassMismatch: input.substanceClassMismatch,
  };
  const canonical = stableStringify(payload);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Canonical JSON: object keys sorted lexicographically at every level, arrays
 * left in order. Handles `undefined` / functions by dropping them (the same
 * way `JSON.stringify` does at the top level), and treats `NaN`/`Infinity` as
 * null (matches JSON's inability to represent them). Deterministic and free of
 * V8's own key-order quirks.
 */
function stableStringify(value: unknown): string {
  const seen = new WeakSet();
  const walk = (node: unknown): unknown => {
    if (node === null) return null;
    if (typeof node === 'number') return Number.isFinite(node) ? node : null;
    if (typeof node === 'bigint') return node.toString();
    if (typeof node !== 'object') return node;
    if (seen.has(node as object)) return null;
    seen.add(node as object);
    if (Array.isArray(node)) return node.map(walk);
    const keys = Object.keys(node as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const v = walk((node as Record<string, unknown>)[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

// ─── Execution helpers ────────────────────────────────────────────────────────

/**
 * Fold a single-valued table (PK includes drug_id) from loser to winner. For a
 * key both hold, the resolution decides: keep the winner's row (drop the
 * loser's) or take the loser's (drop the winner's, then repoint the loser's).
 * Keys only the loser holds always move.
 */
async function mergeParamKeyedTable(
  db: Db,
  spec: { kind: DrugMergeConflictKind; table: string },
  winnerId: number,
  loserId: number,
  resolutions: DrugMergeResolutions,
): Promise<void> {
  const tbl = sql.raw(spec.table);
  const [winnerRows, loserRows] = await Promise.all([
    db.execute<{ parameter: string }>(sql`SELECT parameter FROM ${tbl} WHERE drug_id = ${winnerId}`),
    db.execute<{ parameter: string }>(sql`SELECT parameter FROM ${tbl} WHERE drug_id = ${loserId}`),
  ]);
  const winnerParams = new Set(winnerRows.rows.map((r) => r.parameter));

  for (const { parameter } of loserRows.rows) {
    if (!winnerParams.has(parameter)) {
      await db.execute(
        sql`UPDATE ${tbl} SET drug_id = ${winnerId} WHERE drug_id = ${loserId} AND parameter = ${parameter}`,
      );
      continue;
    }
    const choice = resolutions[`${spec.kind}:${parameter}`] ?? 'winner';
    if (choice === 'loser') {
      await db.execute(sql`DELETE FROM ${tbl} WHERE drug_id = ${winnerId} AND parameter = ${parameter}`);
      await db.execute(
        sql`UPDATE ${tbl} SET drug_id = ${winnerId} WHERE drug_id = ${loserId} AND parameter = ${parameter}`,
      );
    } else {
      // Winner keeps its row; the loser's is dropped (it would cascade with the
      // loser drug anyway, but deleting here keeps the intent explicit).
      await db.execute(sql`DELETE FROM ${tbl} WHERE drug_id = ${loserId} AND parameter = ${parameter}`);
    }
  }
}

/**
 * SQL that unions two `reference_ids` arrays on the same row, de-duplicating in
 * first-seen order. Read as `<union-refs>` in the UPDATE statements below.
 * Nulls become empty arrays; an all-empty union becomes NULL to match the
 * pre-merge convention (empty vs. absent is the same to callers).
 */
const REFS_UNION = sql`
  (
    SELECT NULLIF(
      COALESCE(
        (
          SELECT array_agg(v ORDER BY min_ord)
          FROM (
            SELECT u.v, min(u.ord) AS min_ord
            FROM unnest(
              COALESCE(w.reference_ids, ARRAY[]::int[])
              || COALESCE(l.reference_ids, ARRAY[]::int[])
            ) WITH ORDINALITY AS u(v, ord)
            GROUP BY u.v
          ) deduped
        ),
        ARRAY[]::int[]
      ),
      ARRAY[]::int[]
    )
  )
`;

/**
 * Concatenate two text columns when both are present and differ, taking either
 * side's non-empty value when only one has one. `column` is the column name on
 * both `w` and `l` — passed as `sql.raw` because column identifiers cannot be
 * parameterized.
 */
function mergeText(column: string): SQL {
  const col = sql.raw(column);
  return sql`CASE
    WHEN NULLIF(trim(coalesce(w.${col}, '')), '') IS NULL THEN l.${col}
    WHEN NULLIF(trim(coalesce(l.${col}, '')), '') IS NULL THEN w.${col}
    WHEN w.${col} = l.${col} THEN w.${col}
    ELSE w.${col} || E'\n\n[merged from duplicate entry]\n' || l.${col}
  END`;
}

/**
 * Merge receptor-target rows the winner and loser both hold under the same
 * `(bio_entity_id, interaction_type)` identity: numeric evidence fields COALESCE
 * winner-wins, `assay_species`/`tier` fill blanks, `evidence_note` concatenates
 * differing text, references union. Then drops the loser's colliding rows so
 * the subsequent repoint moves only the non-colliding ones.
 */
async function mergeReceptorTargetCollisions(
  db: Db,
  winnerId: number,
  loserId: number,
  actorUserId: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE drug_receptor_targets AS w
    SET tier              = COALESCE(w.tier, l.tier),
        affinity          = COALESCE(w.affinity, l.affinity),
        potency           = COALESCE(w.potency, l.potency),
        efficacy          = COALESCE(w.efficacy, l.efficacy),
        ki                = COALESCE(w.ki, l.ki),
        ic50              = COALESCE(w.ic50, l.ic50),
        ec50              = COALESCE(w.ec50, l.ec50),
        emax              = COALESCE(w.emax, l.emax),
        selectivity_ratio = COALESCE(w.selectivity_ratio, l.selectivity_ratio),
        assay_species     = COALESCE(w.assay_species, l.assay_species),
        evidence_note     = ${mergeText('evidence_note')},
        reference_ids     = ${REFS_UNION},
        updated_by        = ${actorUserId},
        updated_at        = NOW()
    FROM drug_receptor_targets AS l
    WHERE w.drug_id = ${winnerId}
      AND l.drug_id = ${loserId}
      AND w.bio_entity_id = l.bio_entity_id
      AND w.interaction_type = l.interaction_type`);
  await db.execute(sql`
    DELETE FROM drug_receptor_targets AS l
    WHERE l.drug_id = ${loserId}
      AND EXISTS (
        SELECT 1 FROM drug_receptor_targets AS w
        WHERE w.drug_id = ${winnerId}
          AND w.bio_entity_id = l.bio_entity_id
          AND w.interaction_type = l.interaction_type
      )`);
}

/**
 * Same rule for enzyme interactions, keyed on `(bio_entity_id, role)`: fill in
 * `strength`, merge `note`, union references.
 */
async function mergeEnzymeInteractionCollisions(
  db: Db,
  winnerId: number,
  loserId: number,
  actorUserId: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE drug_enzyme_interactions AS w
    SET strength      = COALESCE(w.strength, l.strength),
        note          = ${mergeText('note')},
        reference_ids = ${REFS_UNION},
        updated_by    = ${actorUserId},
        updated_at    = NOW()
    FROM drug_enzyme_interactions AS l
    WHERE w.drug_id = ${winnerId}
      AND l.drug_id = ${loserId}
      AND w.bio_entity_id = l.bio_entity_id
      AND w.role = l.role`);
  await db.execute(sql`
    DELETE FROM drug_enzyme_interactions AS l
    WHERE l.drug_id = ${loserId}
      AND EXISTS (
        SELECT 1 FROM drug_enzyme_interactions AS w
        WHERE w.drug_id = ${winnerId}
          AND w.bio_entity_id = l.bio_entity_id
          AND w.role = l.role
      )`);
}

/**
 * Same rule for ionization constants. The 8-column identity key includes pKa's
 * equilibrium, evidence type and medium — same identity means literally the
 * same equilibrium measurement, so the pKa itself doesn't merge. Only `note`
 * and `reference_ids` differ across independently-curated transcriptions of
 * one measurement.
 */
async function mergeIonizationConstantCollisions(
  db: Db,
  winnerId: number,
  loserId: number,
  actorUserId: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE drug_ionization_constants AS w
    SET note          = ${mergeText('note')},
        reference_ids = ${REFS_UNION},
        updated_by    = ${actorUserId},
        updated_at    = NOW()
    FROM drug_ionization_constants AS l
    WHERE w.drug_id = ${winnerId}
      AND l.drug_id = ${loserId}
      AND w.protonated_charge = l.protonated_charge
      AND w.deprotonated_charge = l.deprotonated_charge
      AND w.constant_type = l.constant_type
      AND w.evidence_type = l.evidence_type
      AND lower(coalesce(w.site_label, '')) = lower(coalesce(l.site_label, ''))
      AND lower(coalesce(w.medium, '')) = lower(coalesce(l.medium, ''))
      AND coalesce(w.temperature_c::text, '') = coalesce(l.temperature_c::text, '')`);
  await db.execute(sql`
    DELETE FROM drug_ionization_constants AS l
    WHERE l.drug_id = ${loserId}
      AND EXISTS (
        SELECT 1 FROM drug_ionization_constants AS w
        WHERE w.drug_id = ${winnerId}
          AND w.protonated_charge = l.protonated_charge
          AND w.deprotonated_charge = l.deprotonated_charge
          AND w.constant_type = l.constant_type
          AND w.evidence_type = l.evidence_type
          AND lower(coalesce(w.site_label, '')) = lower(coalesce(l.site_label, ''))
          AND lower(coalesce(w.medium, '')) = lower(coalesce(l.medium, ''))
          AND coalesce(w.temperature_c::text, '') = coalesce(l.temperature_c::text, '')
      )`);
}

/**
 * Same rule for PM concentration distributions, keyed on `source_id`. Same
 * source means the same published statistics; the winner's numbers stay. But
 * the row's editorial fields (`anomaly`, `review_note`, the `printed` map for
 * exact-string values, and `undrawable` warnings) can legitimately differ
 * between two transcriptions and are folded together.
 */
async function mergePmDistributionCollisions(
  db: Db,
  winnerId: number,
  loserId: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE pm_concentration_distributions AS w
    SET anomaly     = ${mergeText('anomaly')},
        review_note = ${mergeText('review_note')},
        printed     = w.printed || l.printed,
        undrawable  = (
          SELECT COALESCE(jsonb_agg(v), '[]'::jsonb)
          FROM (
            SELECT jsonb_array_elements_text(w.undrawable) AS v
            UNION
            SELECT jsonb_array_elements_text(l.undrawable) AS v
          ) merged
        ),
        updated_at  = NOW()
    FROM pm_concentration_distributions AS l
    WHERE w.drug_id = ${winnerId}
      AND l.drug_id = ${loserId}
      AND w.source_id = l.source_id`);
  await db.execute(sql`
    DELETE FROM pm_concentration_distributions AS l
    WHERE l.drug_id = ${loserId}
      AND EXISTS (
        SELECT 1 FROM pm_concentration_distributions AS w
        WHERE w.drug_id = ${winnerId} AND w.source_id = l.source_id
      )`);
}

// ─── Execution ────────────────────────────────────────────────────────────────

/**
 * Merge `loserId` into `winnerId` and delete the loser. MUST be called inside a
 * pooled transaction (`runInPoolTransaction`) — the fold touches ~two dozen
 * tables and is atomic only under one.
 *
 * `resolutions` must carry an explicit choice for every conflict that exists
 * when the merge runs — the check is redone here under the lock, and a missing
 * key throws {@link UnresolvedDrugMergeConflictError} rather than defaulting, so
 * a value that appeared after the caller's preflight is never silently dropped.
 * An applicability contradiction throws {@link DrugMergeBlockedError}.
 */
export async function mergeDrugs(
  db: Db,
  params: {
    winnerId: number;
    loserId: number;
    resolutions: DrugMergeResolutions;
    actorUserId: number;
    /**
     * The `planFingerprint` the admin approved (returned by
     * {@link buildDrugMergePlan}). Rebuilt under the merge lock and compared —
     * any drift throws {@link DrugMergeStalePlanError}. Test callers may pass
     * `null` to skip the check (production paths must not).
     */
    approvedPlanFingerprint: string | null;
  },
): Promise<DrugMergeStats> {
  const { winnerId, loserId, resolutions, actorUserId, approvedPlanFingerprint } = params;
  // Dose-context half of the parameter_entries dedup identity (step 7); see
  // api/_lib/entry-identity-sql.ts.
  const dk = mergeEntryIdentity(winnerId, loserId);
  if (winnerId === loserId) {
    throw new Error('mergeDrugs: winner and loser are the same drug');
  }

  // Two layers of locks, both acquired in fixed id order so two merges of the
  // same pair cannot deadlock:
  //
  // 1. **Per-drug advisory lock first** (`lockDrugForEntryApplicability`). Same
  //    lock the parameter/applicability/recompute paths take, re-entrant within
  //    the transaction. A concurrent parameter writer takes THIS lock first and
  //    only then does its FK insert (which takes `FOR KEY SHARE` on the parent
  //    drug row); if the merge took `FOR UPDATE` on the drug row first and only
  //    then waited on the advisory lock, the two transactions would be a
  //    classic ABBA deadlock and Postgres would abort one at random. Advisory
  //    first, everywhere on both paths, means the merge and any writer contend
  //    on the same first lock in the same order — no cycle possible.
  //
  // 2. **`SELECT FOR UPDATE` on both `drugs` rows.** Postgres FK inserts take
  //    `FOR KEY SHARE` on the parent, which conflicts with `FOR UPDATE`, so
  //    this blocks any concurrent writer that inserts a row FK-ing to either
  //    drug (receptor targets, enzyme interactions, metabolism edges, method
  //    memberships, atlas rows, source entries — the whole surface not covered
  //    by the applicability lock). Without it, a writer that inserted a row on
  //    the loser after we repointed its table would have that row
  //    cascade-deleted with the loser at step 11, and return success to a
  //    caller whose data was already gone.
  const orderedIds = [winnerId, loserId].sort((a, b) => a - b);
  for (const id of orderedIds) {
    await lockDrugForEntryApplicability(id);
  }
  await db.execute<{ id: number }>(
    sql`SELECT id FROM drugs WHERE id IN (${orderedIds[0]}, ${orderedIds[1]}) ORDER BY id FOR UPDATE`,
  );

  // Lock every drug-scoped child row that participates in a conflict scan or
  // dedup below. The parent `drugs` row lock only serializes writers that
  // insert or update FK-bearing rows in a way that takes `FOR KEY SHARE` on
  // the parent — plain UPDATEs on non-FK columns of existing child rows
  // don't. Importers (`runImport(..., overwrite: true)`, `seedIonizationConstants`,
  // `replaceDrugReceptorTargets` etc.) update child rows by their own id
  // without touching the parent, so without these SELECTs the merge's
  // conflict scan could miss a concurrent write and dedup it away.
  //
  // No ORDER BY: two concurrent merges targeting overlapping drug ids are
  // already serialized by the per-drug advisory lock at the top of this
  // function, so cross-merge deadlock on child-row locks isn't reachable.
  // Some tables (analytical_method_components, drug_parameters,
  // drug_parameter_applicability) use composite PKs and have no `id`
  // column — a bare `SELECT 1 ... FOR UPDATE` is enough to take the row
  // locks we need.
  const drugScopedChildTables = [
    'analytical_method_components',
    'drug_elimination_routes',
    'drug_enzyme_interactions',
    'drug_ionization_constants',
    'drug_metabolism_profiles',
    'drug_parameter_applicability',
    'drug_parameters',
    'drug_receptor_targets',
    'parameter_entries',
    'pm_concentration_distributions',
  ];
  for (const table of drugScopedChildTables) {
    const tbl = sql.raw(table);
    await db.execute(sql`
      SELECT 1 FROM ${tbl}
      WHERE drug_id IN (${orderedIds[0]}, ${orderedIds[1]})
      FOR UPDATE`);
  }
  // drug_metabolites has TWO drug FKs (parent_drug_id, metabolite_drug_id),
  // so it needs a WHERE clause that covers both — a row where either side
  // is our winner or loser is subject to move/dedup by the merge.
  await db.execute(sql`
    SELECT 1 FROM drug_metabolites
    WHERE parent_drug_id IN (${orderedIds[0]}, ${orderedIds[1]})
       OR metabolite_drug_id IN (${orderedIds[0]}, ${orderedIds[1]})
    FOR UPDATE`);
  // Any drug's entry that names either side as the drug administered or
  // coadministered (Cmax release B). The merge repoints those references and
  // its preflight refuses a pair of such entries that the repoint would make
  // identical — so they must hold still between the scan and the repoint, or
  // a concurrent value edit can create the duplicate after the check passed
  // (Codex review on #1368). A new row naming either side is already held
  // off by the drug row locks above: its foreign key needs FOR KEY SHARE.
  await db.execute(sql`
    SELECT 1 FROM parameter_entries
    WHERE administered_drug_id IN (${orderedIds[0]}, ${orderedIds[1]})
       OR interacting_drug_id IN (${orderedIds[0]}, ${orderedIds[1]})
    FOR UPDATE`);

  const [winner, loser] = await Promise.all([
    loadDrugSideInfo(db, winnerId),
    loadDrugSideInfo(db, loserId),
  ]);
  if (!winner) throw new Error(`mergeDrugs: drug ${winnerId} does not exist`);
  if (!loser) throw new Error(`mergeDrugs: drug ${loserId} does not exist`);

  // Lock the monograph pages so a concurrent editor cannot change their
  // content between the fingerprint compute below and step 9's page delete.
  // `wiki_pages` has no FK to `drugs`, so the drug row lock above does not
  // reach it; without this a writer that saves prose after fingerprint but
  // before delete would land in the page just as the merge cascades it and
  // its revision history away. Ordered by id to match the drug lock order
  // and avoid a cycle with an editor doing a multi-page write. After the
  // lock, reload each monograph's `hasContent` from the locked row — that
  // is the state the fingerprint must reflect, and the state step 9 will
  // see when the delete runs.
  const monographPageIdsToLock = [
    winner.monograph?.pageId,
    loser.monograph?.pageId,
  ]
    .filter((id): id is number => id != null)
    .sort((a, b) => a - b);
  if (monographPageIdsToLock.length > 0) {
    const lockedList = sql.join(
      monographPageIdsToLock.map((id) => sql`${id}`),
      sql`, `,
    );
    const lockedPages = await db.execute<{
      id: number;
      content: unknown;
      content_plaintext: string | null;
    }>(sql`
      SELECT id, content, content_plaintext
      FROM wiki_pages
      WHERE id IN (${lockedList})
      ORDER BY id
      FOR UPDATE`);
    const byPageId = new Map(lockedPages.rows.map((r) => [r.id, r]));
    for (const side of [winner, loser]) {
      if (side.monograph) {
        const row = byPageId.get(side.monograph.pageId);
        if (row) {
          const rowShape = {
            content: row.content,
            contentPlaintext: row.content_plaintext,
          };
          side.monograph = {
            ...side.monograph,
            hasContent: monographHasContent(rowShape),
            contentDigest: monographContentDigest(rowShape),
          };
        }
      }
    }
  }

  // Substance class is a whole-drug scientific classification, not a merge
  // decision. Winner selection is by monograph/popularity, so silently adopting
  // the winner's class would reopen (into 'drug') or hide (into 'metabolite'/
  // 'endogenous') gaps the previous class already answered. Reconcile it on
  // the drugs first, then merge — same as `scripts/merge-drugs.ts`.
  if (winner.substanceClass !== loser.substanceClass) {
    throw new DrugMergeClassMismatchError(winner.substanceClass, loser.substanceClass);
  }

  // The applicability invariant comes next: a merge that would fold a value
  // and a marker (or a class-forbidden value) onto the survivor is refused
  // outright — it is not a per-key pick.
  const blockers = await detectApplicabilityBlockers(db, winnerId, loserId);
  if (blockers.length > 0) throw new DrugMergeBlockedError(blockers);

  // Identity-key collisions where the two rows disagree on validated data
  // (analytical-method reporting figures, PM cohort statistics, ionization
  // measurements, evidence-carrying metabolic edges) are refused for the same
  // reason: a merge cannot pick between two independent measurements silently.
  const dataConflicts = await detectDataConflicts(db, winner, loser);
  if (dataConflicts.length > 0) throw new DrugMergeDataConflictError(dataConflicts);

  // Re-derive conflicts under the lock and require an explicit resolution for
  // each. A conflict with no resolution is one that appeared after the caller's
  // preflight; defaulting it to the winner would silently delete the other
  // side's new datum, so refuse instead.
  const conflicts = await detectSingleValueConflicts(db, winnerId, loserId);
  const unresolved = conflicts
    .filter((c) => resolutions[c.id] !== 'winner' && resolutions[c.id] !== 'loser')
    .map((c) => c.id);
  if (unresolved.length > 0) {
    throw new UnresolvedDrugMergeConflictError(unresolved);
  }

  // The stale-plan check. The admin approved a specific set of values (each
  // conflict's winner/loser), a specific loser-monograph emptiness, a specific
  // blocker/dataConflict set, a specific substance class on each side. Even
  // where the ID-only checks above passed, a concurrent write could have
  // *changed* the value behind a conflict id — same key, different underlying
  // value — and blindly applying the admin's `winner`/`loser` pick would
  // delete a datum the admin never saw. Or the loser monograph could have
  // gained prose that the delete step is about to destroy without warning.
  // Recompute the fingerprint here (same inputs as preview) and refuse the
  // apply on drift.
  const currentFingerprint = computePlanFingerprint({
    winner,
    loser,
    conflicts,
    blockers,
    dataConflicts,
    substanceClassMismatch: null, // reached this line means classes match
  });
  if (approvedPlanFingerprint != null && approvedPlanFingerprint !== currentFingerprint) {
    throw new DrugMergeStalePlanError();
  }

  const counts = await buildCounts(db, winnerId, loserId, conflicts, loser.slug);

  // 1. Metadata: fold the loser's names + aliases into the winner's aliases so
  //    the merged entry stays findable by the old spelling (MHD's second name),
  //    then rebuild the search key.
  const metadataCols = {
    names: drugs.names,
    nameShort: drugs.nameShort,
    aliases: drugs.aliases,
    popularityScore: drugs.popularityScore,
    source: drugs.source,
    farmakologiportalenPath: drugs.farmakologiportalenPath,
    metabolitesCompleteDigest: drugs.metabolitesCompleteDigest,
    precursorsCompleteDigest: drugs.precursorsCompleteDigest,
  };
  const [winnerRow, loserRow] = await Promise.all([
    db.select(metadataCols).from(drugs).where(eq(drugs.id, winnerId)).limit(1).then((r) => r[0]),
    db.select(metadataCols).from(drugs).where(eq(drugs.id, loserId)).limit(1).then((r) => r[0]),
  ]);
  if (winnerRow && loserRow) {
    const winnerNameValues = new Set(Object.values(winnerRow.names ?? {}));
    // Fold every non-winner string that a curator might search by — the
    // loser's language values, aliases, AND `nameShort` (which is part of the
    // search key). Without the nameShort, an abbreviation only the loser
    // carries (MHD would be a real example) stops finding the merged drug.
    const mergedAliases = normalizeAliases([
      ...(winnerRow.aliases ?? []),
      ...(loserRow.aliases ?? []),
      ...Object.values(loserRow.names ?? {}),
      ...(loserRow.nameShort ? [loserRow.nameShort] : []),
    ]).filter((alias) => !winnerNameValues.has(alias));
    // Loser-only registry metadata that would vanish with the loser row:
    //   - `farmakologiportalen_path` (outbound portal link)
    //   - `metabolites_complete_digest` / `precursors_complete_digest`
    //     (reviewed-completeness markers keyed to the substance's edge set)
    // Winner-wins where both hold a value; the loser fills a NULL. The two
    // completeness digests are the substance's answer to "every metabolite /
    // precursor is reviewed" — if the surviving edge set is the SAME set the
    // marker was made about, it stays current, but a merge that changes any
    // edges lets `metabolite_edges_digest_of` disagree with the stored digest
    // and the completeness read stops reporting the claim as current. So the
    // marker is preserved but not asserted here: the read side does the check.
    const nextUpdates: Record<string, unknown> = {
      aliases: mergedAliases,
      searchKey: buildSearchKey({
        names: winnerRow.names,
        nameShort: winnerRow.nameShort,
        aliases: mergedAliases,
      }),
      popularityScore:
        (winnerRow.popularityScore ?? 0) + (loserRow.popularityScore ?? 0),
      updatedAt: new Date(),
    };
    // `drugs.source` marks how the row entered the catalog ('farmakologiportalen',
    // 'deep-research', import batch tag, etc.) and is the read side's provenance
    // for that fact. Never overwrite a winner value — an imported drug hand-
    // curated later stays imported — but fill a NULL from the loser rather than
    // silently erasing an import/corroboration source on merge.
    if (!winnerRow.source && loserRow.source) {
      nextUpdates.source = loserRow.source;
    }
    if (!winnerRow.farmakologiportalenPath && loserRow.farmakologiportalenPath) {
      nextUpdates.farmakologiportalenPath = loserRow.farmakologiportalenPath;
    }
    if (!winnerRow.metabolitesCompleteDigest && loserRow.metabolitesCompleteDigest) {
      nextUpdates.metabolitesCompleteDigest = loserRow.metabolitesCompleteDigest;
    }
    if (!winnerRow.precursorsCompleteDigest && loserRow.precursorsCompleteDigest) {
      nextUpdates.precursorsCompleteDigest = loserRow.precursorsCompleteDigest;
    }
    await db.update(drugs).set(nextUpdates).where(eq(drugs.id, winnerId));
  }

  // 2. Single-valued conflict tables.
  for (const spec of PARAM_KEYED_TABLES) {
    await mergeParamKeyedTable(db, spec, winnerId, loserId, resolutions);
  }

  // drug_metabolism_profiles (PK = drug_id). The `evidenceNote` prose is the
  // one thing an admin chooses between; the two sides' `referenceIds` arrays
  // are UNIONed onto the survivor regardless of the note-pick, because
  // citations are additive — dropping one side's set as a side effect of
  // picking a note over the other would silently discard provenance the
  // remaining note may well cite.
  const winnerHasProfile = conflicts.some((c) => c.kind === 'metabolism_profile');
  if (winnerHasProfile) {
    const profileChoice = resolutions['metabolism_profile:profile'] ?? 'winner';
    const profileRows = await db
      .select({
        drugId: drugMetabolismProfiles.drugId,
        note: drugMetabolismProfiles.evidenceNote,
        referenceIds: drugMetabolismProfiles.referenceIds,
      })
      .from(drugMetabolismProfiles)
      .where(inArray(drugMetabolismProfiles.drugId, [winnerId, loserId]));
    const w = profileRows.find((r) => r.drugId === winnerId)!;
    const l = profileRows.find((r) => r.drugId === loserId)!;
    const mergedRefs = mergeReferenceIdArrays(w.referenceIds, l.referenceIds);
    const keptNote = profileChoice === 'loser' ? l.note : w.note;
    // Delete the loser's row first (frees the PK), then update the winner's
    // in place with the picked note and the unioned refs.
    await db.delete(drugMetabolismProfiles).where(eq(drugMetabolismProfiles.drugId, loserId));
    await db
      .update(drugMetabolismProfiles)
      .set({
        evidenceNote: keptNote,
        referenceIds: mergedRefs,
        updatedAt: new Date(),
      })
      .where(eq(drugMetabolismProfiles.drugId, winnerId));
  } else {
    await db.update(drugMetabolismProfiles).set({ drugId: winnerId }).where(eq(drugMetabolismProfiles.drugId, loserId));
  }

  // 3. Analytical-method memberships (analytical_method_components, PK
  //    (method_id, drug_id)) and the atlas observations that reference them.
  //
  //    pattern_reference_observations carries a composite FK
  //    (analytical_method_id, drug_id) → (method_id, drug_id) here, so the order
  //    is delicate in both directions: an observation on (M, loser) blocks a
  //    DELETE *or* an UPDATE of the loser's (M, loser) component row, and it
  //    cannot be repointed to (M, winner) until that pair exists. Break the
  //    cycle by making the winner a member of every method the loser is in
  //    FIRST — copying the loser's reporting figures where the winner is not
  //    already listed — so both (M, loser) and (M, winner) exist at once. Then
  //    repoint the observations, then drop the loser's now-unreferenced rows.
  await db.execute(sql`
    INSERT INTO analytical_method_components
      (method_id, drug_id, lor, mkk, lod, unit, measurement_uncertainty, sort_order)
    SELECT method_id, ${winnerId}, lor, mkk, lod, unit, measurement_uncertainty, sort_order
    FROM analytical_method_components
    WHERE drug_id = ${loserId}
    ON CONFLICT (method_id, drug_id) DO NOTHING`);

  // 4. Pattern atlas (ON DELETE RESTRICT — must be repointed, never cascaded).
  //    Observations first (their method-component FK is now satisfied for every
  //    method), then aggregates and exposures. No unique constraint on drug
  //    here, so no dedup.
  await db.update(patternReferenceObservations).set({ drugId: winnerId }).where(eq(patternReferenceObservations.drugId, loserId));
  await db.update(patternReferenceObservations).set({ reportedAsDrugId: winnerId }).where(eq(patternReferenceObservations.reportedAsDrugId, loserId));

  // The loser's method rows are now unreferenced (observations repointed) and
  // the winner already carries an equivalent membership for each — drop them.
  await db.delete(analyticalMethodComponents).where(eq(analyticalMethodComponents.drugId, loserId));

  await db.update(patternReferenceAggregates).set({ drugId: winnerId }).where(eq(patternReferenceAggregates.drugId, loserId));
  await db.update(patternReferenceAggregates).set({ reportedAsDrugId: winnerId }).where(eq(patternReferenceAggregates.reportedAsDrugId, loserId));
  await db.update(patternReferenceExposures).set({ drugId: winnerId }).where(eq(patternReferenceExposures.drugId, loserId));

  // 5. Multi-row identity tables. When both entries carry a row with the same
  //    identity key, the winner's row is enriched from the loser's before the
  //    loser's row is dropped: NULL columns on the winner fill in from the
  //    loser (Ki, IC50, species, tier, strength, note, …), and reference_ids
  //    are UNIONed in first-seen order. A blind dedup-delete would discard
  //    scientific evidence the winner didn't have — the very case an admin
  //    would never notice was silently lost.
  //
  //    Notes that differ concatenate with a marker rather than one clobbering
  //    the other. Numeric values that already exist on the winner are kept as
  //    the "kept" side: two different Ki measurements are not automatically
  //    reconcilable, and the winner is who the admin already agreed survives.
  await mergeReceptorTargetCollisions(db, winnerId, loserId, actorUserId);
  await db.update(drugReceptorTargets).set({ drugId: winnerId }).where(eq(drugReceptorTargets.drugId, loserId));

  await mergeEnzymeInteractionCollisions(db, winnerId, loserId, actorUserId);
  await db.update(drugEnzymeInteractions).set({ drugId: winnerId }).where(eq(drugEnzymeInteractions.drugId, loserId));

  await mergeIonizationConstantCollisions(db, winnerId, loserId, actorUserId);
  await db.update(drugIonizationConstants).set({ drugId: winnerId }).where(eq(drugIonizationConstants.drugId, loserId));

  await mergePmDistributionCollisions(db, winnerId, loserId);
  await db.update(pmConcentrationDistributions).set({ drugId: winnerId }).where(eq(pmConcentrationDistributions.drugId, loserId));

  // 6. Metabolite / precursor edges (the "links to the deleted page" the task
  //    calls out — DB-row side). Two directions, both deduped against the
  //    winner's edges and guarded against the winner becoming its own
  //    metabolite/precursor.
  //
  //    Parent side: rows where the loser IS the parent. Drop a loser edge whose
  //    metabolite the winner already lists (by resolved drug or by name), drop a
  //    self-edge (loser→winner would become winner→winner), then repoint.
  const metaboliteDeduped = await db.execute<{ id: number }>(sql`
    DELETE FROM drug_metabolites AS l
    WHERE l.parent_drug_id = ${loserId}
      AND (
        l.metabolite_drug_id = ${winnerId}
        OR EXISTS (
          SELECT 1 FROM drug_metabolites AS w
          WHERE w.parent_drug_id = ${winnerId}
            AND (
              (w.metabolite_drug_id IS NOT NULL AND w.metabolite_drug_id = l.metabolite_drug_id)
              OR w.metabolite_name = l.metabolite_name
            )
        )
      )
    RETURNING l.id`);
  await db.update(drugMetabolites).set({ parentDrugId: winnerId }).where(eq(drugMetabolites.parentDrugId, loserId));

  //    Precursor side: rows where the loser IS the metabolite of some parent.
  //    Drop a self-edge (parent already the winner) and any edge whose parent
  //    already lists the winner as a metabolite, then repoint.
  const precursorDeduped = await db.execute<{ id: number }>(sql`
    DELETE FROM drug_metabolites AS l
    WHERE l.metabolite_drug_id = ${loserId}
      AND (
        l.parent_drug_id = ${winnerId}
        OR EXISTS (
          SELECT 1 FROM drug_metabolites AS w
          WHERE w.parent_drug_id = l.parent_drug_id
            AND w.metabolite_drug_id = ${winnerId}
        )
      )
    RETURNING l.id`);
  await db.update(drugMetabolites).set({ metaboliteDrugId: winnerId }).where(eq(drugMetabolites.metaboliteDrugId, loserId));

  counts.metaboliteEdgesDeduped = metaboliteDeduped.rows?.length ?? 0;
  counts.precursorLinksDeduped = precursorDeduped.rows?.length ?? 0;
  counts.metaboliteEdgesMoved = Math.max(0, counts.metaboliteEdgesMoved - counts.metaboliteEdgesDeduped);
  counts.precursorLinksMoved = Math.max(0, counts.precursorLinksMoved - counts.precursorLinksDeduped);

  // 7. Additive repoints — no drug-scoped unique constraint, so a plain move.
  await db.update(drugEliminationRoutes).set({ drugId: winnerId }).where(eq(drugEliminationRoutes.drugId, loserId));

  // `parameter_entries` has no unique constraint on drug — that is by design,
  // parameters are multi-value. But two rows describing the SAME observation
  // (same source citation, matrix, scenario, unit, low/high/median, qualifier,
  // categorical value) would pool the same measurement twice through
  // source-weighted aggregation, skewing the winner's cached medians. Drop the
  // loser's copy first where the winner already has an identical row — same
  // key `entryDuplicateExists` uses on the ordinary write path.
  // The dedup identity matches `entryDuplicateExists` at the ordinary write
  // path exactly: drug + parameter + unit + matrix + scenario + route +
  // citation + qualifier + categoricalValue + low + high + median. `n`
  // (sample size) is intentionally NOT part of the identity — the write path
  // treats two rows differing only on `n` as duplicates and rejects the
  // insert. To keep merge-side behavior aligned with what a normal insert
  // would allow, divergent-`n` collisions are refused up front in
  // `detectDataConflicts` (a wholesale drop would arbitrarily pick one `n`
  // and skew `entryWeight`, keeping both would double-pool the same source).
  // If we reach step 7, any row pair matching this predicate is a true
  // duplicate that can be dropped without losing sample-size information.
  //
  // Reconcile observation_context on the surviving winner row BEFORE origin
  // and quote promotion below, both of which need to see the winner's final
  // context rather than promote against a row that is about to change out
  // from under them. `observation_context` (#1257) is evidence a stored
  // quote attests to, so the dedup identity above does not include it
  // either, and a loser row identical in every compared field is deleted —
  // taking its context with it even when the winner has none.
  //
  // Promote where the survivor has nothing, which is unambiguous. Where both
  // sides carry DIFFERENT non-null context, `detectDataConflicts` already
  // refused the merge (the divergent-ancillary check above) — this predicate
  // can never fire that case, but states `w.observation_context IS NULL`
  // anyway rather than relying on that invariant silently.
  //
  // Skip a NULL-context winner row whose group ALREADY holds a different
  // winner row with the promoted context (the `NOT EXISTS`, Codex review on
  // PR #1297): the dedup identity excludes context, so a group can hold a
  // winner row with context A alongside a winner row with unknown context —
  // and when the loser only repeats A (already represented, not genuinely
  // new — `detectDataConflicts` allows this case precisely because dropping
  // the loser loses nothing), there is nothing that identifies the
  // survivor's unknown-context reading as ALSO being A. Writing A onto it
  // anyway would assert a reading nobody actually supplied. Promotion still
  // fires exactly as before when the NULL-context row is the winner's only
  // row for this identity — the ordinary one-sided-gap case.
  //
  // Repoint the dose-context drug references first (Cmax release B, #1340).
  // `administered_drug_id` and `interacting_drug_id` name a drug on ANY
  // drug's entry — a metabolite's Cmax names its parent as the administered
  // drug — and both are ON DELETE RESTRICT, so a reference left on the loser
  // fails the loser's delete at the end of this merge. They run BEFORE the
  // dedup below so that comparison sees post-merge values: an entry whose
  // administered drug was the loser becomes a self-reference on the winner
  // and must collide with an identical native one, not survive beside it.
  // A direct write to rows another drug may own, so it marks queued
  // proposals against them the same way the promotions below do.
  // `detectDataConflicts` has already refused the two shapes this cannot
  // repoint sensibly: an interaction arm between the winner and the loser,
  // and two entries of a third drug that the repoint would make identical.
  const administeredRepointed = await db.execute(sql`
    UPDATE parameter_entries SET administered_drug_id = ${winnerId}
    WHERE administered_drug_id = ${loserId}
    RETURNING id`);
  const interactingRepointed = await db.execute(sql`
    UPDATE parameter_entries SET interacting_drug_id = ${winnerId}
    WHERE interacting_drug_id = ${loserId}
    RETURNING id`);
  await markEntryMutationsConflicted(
    [
      ...(administeredRepointed.rows as Array<{ id: number | string }>),
      ...(interactingRepointed.rows as Array<{ id: number | string }>),
    ].map((row) => Number(row.id)),
  );
  const contextPromoted = await db.execute(sql`
    UPDATE parameter_entries AS w
    SET observation_context = best.observation_context
    FROM (
      SELECT DISTINCT ON (
        l.parameter, l.unit, l.matrix, l.scenario, l.route,
        l.citation_id, l.qualifier, l.categorical_value,
        l.low, l.high, l.median, ${dk.cols('l')}
      )
        l.parameter, l.unit, l.matrix, l.scenario, l.route,
        l.citation_id, l.qualifier, l.categorical_value,
        l.low, l.high, l.median,
        ${dk.select('l')},
        l.observation_context
      FROM parameter_entries AS l
      WHERE l.drug_id = ${loserId}
        AND l.observation_context IS NOT NULL
      ORDER BY
        l.parameter, l.unit, l.matrix, l.scenario, l.route,
        l.citation_id, l.qualifier, l.categorical_value,
        l.low, l.high, l.median,
        ${dk.cols('l')},
        l.id
    ) AS best
    WHERE w.drug_id = ${winnerId}
      AND w.parameter = best.parameter
      AND w.unit = best.unit
      AND w.matrix IS NOT DISTINCT FROM best.matrix
      AND w.scenario IS NOT DISTINCT FROM best.scenario
      AND w.route IS NOT DISTINCT FROM best.route
      AND w.citation_id IS NOT DISTINCT FROM best.citation_id
      AND w.qualifier IS NOT DISTINCT FROM best.qualifier
      AND w.categorical_value IS NOT DISTINCT FROM best.categorical_value
      AND w.low IS NOT DISTINCT FROM best.low
      AND w.high IS NOT DISTINCT FROM best.high
      AND w.median IS NOT DISTINCT FROM best.median
      ${dk.eqSelected('w', 'best')}
      AND w.observation_context IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM parameter_entries AS w2
        WHERE w2.drug_id = ${winnerId}
          AND w2.id <> w.id
          AND w2.parameter = best.parameter
          AND w2.unit = best.unit
          AND w2.matrix IS NOT DISTINCT FROM best.matrix
          AND w2.scenario IS NOT DISTINCT FROM best.scenario
          AND w2.route IS NOT DISTINCT FROM best.route
          AND w2.citation_id IS NOT DISTINCT FROM best.citation_id
          AND w2.qualifier IS NOT DISTINCT FROM best.qualifier
          AND w2.categorical_value IS NOT DISTINCT FROM best.categorical_value
          AND w2.low IS NOT DISTINCT FROM best.low
          AND w2.high IS NOT DISTINCT FROM best.high
          AND w2.median IS NOT DISTINCT FROM best.median
          ${dk.eqSelected('w2', 'best')}
          AND w2.observation_context = best.observation_context
      )
    RETURNING w.id`);
  await markEntryMutationsConflicted(
    (contextPromoted.rows as Array<{ id: number | string }>).map((row) =>
      Number(row.id),
    ),
  );
  // Reconcile origin provenance next, now that the winner's context is
  // final: `parameter_entries.origin` decides whose write path may later
  // overwrite the row. `deep-research` rows are importer-owned (a re-import
  // can rewrite them via `seedParameterEntries`); `contributor` and `legacy`
  // rows are human/curated and are never touched by the importer. So a
  // deep-research winner + contributor loser pair, dropped naively, would
  // convert human evidence into importer-rewritable data. Promote the
  // winner's origin to the strongest priority found among matching losers
  // (contributor > legacy > deep-research > grandfathered) so the surviving
  // row keeps whichever protection either side had.
  //
  // Scoped by `observation_context` (Codex review, PR #1297, on #1291's
  // relaxed context check): the dedup identity below deliberately excludes
  // context, so a group can hold several winner rows differing only in
  // context (a fasted-state row and a fed-state row). Grouping losers by
  // identity ALONE and applying the strongest origin found to every winner
  // row sharing that identity — regardless of context — would let a
  // contributor's fasted-state loser row upgrade a fed-state winner row's
  // origin too, though no contributor verified that reading. Matching
  // context as well (`IS NOT DISTINCT FROM`, so NULL-context sides still
  // pair with each other) means only the winner row an origin actually
  // attests to can be promoted. This runs AFTER context-promotion above,
  // deliberately: a winner row that just received a promoted context from a
  // loser row should be matched against that SAME loser row's origin, not
  // against the NULL context it held a moment ago — running origin
  // promotion first would compare it against the wrong (pre-promotion)
  // context and miss the pairing.
  //
  // Exception: a LOSER row with NULL context doesn't assert any SPECIFIC
  // context — it isn't evidence for "the fed-state reading" as opposed to
  // "the fasted-state reading", it just doesn't say. A strict context match
  // would then never promote its origin onto anything (a further Codex
  // finding on this same PR: an unquoted, otherwise-identical NULL-context
  // contributor row would silently lose that provenance to a deep-research
  // winner row it will be deleted as a duplicate of). Let it match
  // REGARDLESS of the winner row's context, but only when that winner row
  // is the ONLY winner row for this identity — i.e. there is no ambiguity
  // about which reading the context-agnostic loser observation corresponds
  // to. With 2+ winner rows under one identity, a context-less loser row is
  // genuinely ambiguous between them and promotes onto neither.
  //
  // Picked via a LATERAL, one candidate per winner row, rather than a flat
  // multi-row `best` set joined with `FROM` (yet another Codex finding):
  // when a winner row is the sole row for its identity AND the loser holds
  // BOTH an exact-context row and a separate NULL-context row, both would
  // satisfy a flat join predicate — an exact-context 'legacy' row and a
  // context-agnostic 'contributor' row, say — and `UPDATE ... FROM` with
  // multiple matching source rows applies them in an unspecified order, so
  // the stronger 'contributor' origin could lose to 'legacy' nondeterminis-
  // tically. Selecting one row per winner up front via `ORDER BY prio DESC
  // LIMIT 1` makes the pick the strongest ELIGIBLE origin deterministically,
  // whether it came from an exact-context match or the NULL-context
  // exception.
  // Computed as a self-contained derived table (`DISTINCT ON (w2.id) ...
  // ORDER BY w2.id, prio DESC`) rather than a LATERAL subquery in the
  // UPDATE's FROM clause: Postgres does not allow a LATERAL subquery there
  // to reference the UPDATE's own target table, only preceding FROM items.
  // `w2` plays the role `w` would in a LATERAL version — one row per winner
  // id, paired with its single strongest eligible loser candidate — and the
  // outer UPDATE then joins back to the real target by id.
  await db.execute(sql`
    UPDATE parameter_entries AS w
    SET origin = best.origin
    FROM (
      SELECT DISTINCT ON (w2.id)
        w2.id AS winner_id,
        l.origin,
        CASE l.origin
          WHEN 'contributor' THEN 4
          WHEN 'legacy' THEN 3
          WHEN 'deep-research' THEN 2
          WHEN 'grandfathered' THEN 1
          ELSE 0
        END AS prio
      FROM parameter_entries AS w2
      JOIN parameter_entries AS l ON
        l.drug_id = ${loserId}
        AND l.parameter = w2.parameter
        AND l.unit = w2.unit
        AND l.matrix IS NOT DISTINCT FROM w2.matrix
        AND l.scenario IS NOT DISTINCT FROM w2.scenario
        AND l.route IS NOT DISTINCT FROM w2.route
        AND l.citation_id IS NOT DISTINCT FROM w2.citation_id
        AND l.qualifier IS NOT DISTINCT FROM w2.qualifier
        AND l.categorical_value IS NOT DISTINCT FROM w2.categorical_value
        AND l.low IS NOT DISTINCT FROM w2.low
        AND l.high IS NOT DISTINCT FROM w2.high
        AND l.median IS NOT DISTINCT FROM w2.median
        ${dk.eq('l', 'w2')}
        AND (
          l.observation_context IS NOT DISTINCT FROM w2.observation_context
          OR (
            l.observation_context IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM parameter_entries AS w3
              WHERE w3.drug_id = ${winnerId}
                AND w3.id <> w2.id
                AND w3.parameter = w2.parameter
                AND w3.unit = w2.unit
                AND w3.matrix IS NOT DISTINCT FROM w2.matrix
                AND w3.scenario IS NOT DISTINCT FROM w2.scenario
                AND w3.route IS NOT DISTINCT FROM w2.route
                AND w3.citation_id IS NOT DISTINCT FROM w2.citation_id
                AND w3.qualifier IS NOT DISTINCT FROM w2.qualifier
                AND w3.categorical_value IS NOT DISTINCT FROM w2.categorical_value
                AND w3.low IS NOT DISTINCT FROM w2.low
                AND w3.high IS NOT DISTINCT FROM w2.high
                AND w3.median IS NOT DISTINCT FROM w2.median
                ${dk.eq('w3', 'w2')}
            )
          )
        )
      WHERE w2.drug_id = ${winnerId}
      ORDER BY
        w2.id,
        CASE l.origin
          WHEN 'contributor' THEN 4
          WHEN 'legacy' THEN 3
          WHEN 'deep-research' THEN 2
          WHEN 'grandfathered' THEN 1
          ELSE 0
        END DESC
    ) AS best
    WHERE w.id = best.winner_id
      AND (CASE w.origin
            WHEN 'contributor' THEN 4
            WHEN 'legacy' THEN 3
            WHEN 'deep-research' THEN 2
            WHEN 'grandfathered' THEN 1
            ELSE 0
           END) < best.prio`);
  // Same reasoning for the source quote, one step further. The dedup identity
  // above does not include `source_quote`, so a loser row identical in every
  // compared field is deleted — taking its quote with it even when the winner
  // has none. That is the one piece of an entry nobody can reconstruct: the
  // sentence was read out of a paper by whoever recorded it, and the rows being
  // folded together cite the SAME document for the SAME numbers, so the loser's
  // quote is evidence for the survivor's claim rather than a competing one.
  //
  // Promote it where the survivor has nothing, which is unambiguous and strictly
  // a gain. Where both sides carry DIFFERENT quotes there is a real
  // disagreement about what the source says, and that is refused in the
  // preflight rather than resolved here (see the divergent-ancillary check) —
  // the same treatment `comments` already gets, for a stronger reason.
  //
  // Also matched on `observation_context` — the field is evidence
  // (`SOURCE_QUOTE_EVIDENCE_FIELDS`, #1257), so a loser's quote is only
  // evidence for a winner describing the SAME reading. Context promotion above
  // already reconciles the one-sided-gap case before this runs, and the
  // preflight already refused a genuine two-sided disagreement, so this match
  // should always hold by construction — stated explicitly rather than relied
  // on silently, the same way `w.observation_context IS NULL` is stated above
  // rather than assumed.
  //
  // The promotion is a direct write to a WINNER row, so it owes the review queue
  // what every other direct write does: a proposal queued against that row was
  // reviewed against an unquoted entry, and approving it afterwards can clear
  // the sentence just preserved (an update carrying an explicit null) or delete
  // the row it sits on — with its review token still valid, because the
  // proposal did not change. The preflight only refuses proposals against LOSER
  // rows, which are the ones about to disappear; these survive.
  const promoted = await db.execute(sql`
    UPDATE parameter_entries AS w
    SET source_quote = best.source_quote
    FROM (
      SELECT DISTINCT ON (
        l.parameter, l.unit, l.matrix, l.scenario, l.route,
        l.citation_id, l.qualifier, l.categorical_value,
        l.low, l.high, l.median, ${dk.cols('l')}
      )
        l.parameter, l.unit, l.matrix, l.scenario, l.route,
        l.citation_id, l.qualifier, l.categorical_value,
        l.low, l.high, l.median,
        ${dk.select('l')},
        l.observation_context,
        l.source_quote
      FROM parameter_entries AS l
      WHERE l.drug_id = ${loserId}
        AND l.source_quote IS NOT NULL
      ORDER BY
        l.parameter, l.unit, l.matrix, l.scenario, l.route,
        l.citation_id, l.qualifier, l.categorical_value,
        l.low, l.high, l.median,
        ${dk.cols('l')},
        l.id
    ) AS best
    WHERE w.drug_id = ${winnerId}
      AND w.parameter = best.parameter
      AND w.unit = best.unit
      AND w.matrix IS NOT DISTINCT FROM best.matrix
      AND w.scenario IS NOT DISTINCT FROM best.scenario
      AND w.route IS NOT DISTINCT FROM best.route
      AND w.citation_id IS NOT DISTINCT FROM best.citation_id
      AND w.qualifier IS NOT DISTINCT FROM best.qualifier
      AND w.categorical_value IS NOT DISTINCT FROM best.categorical_value
      AND w.low IS NOT DISTINCT FROM best.low
      AND w.high IS NOT DISTINCT FROM best.high
      AND w.median IS NOT DISTINCT FROM best.median
      ${dk.eqSelected('w', 'best')}
      AND w.observation_context IS NOT DISTINCT FROM best.observation_context
      AND w.source_quote IS NULL
    RETURNING w.id`);
  await markEntryMutationsConflicted(
    (promoted.rows as Array<{ id: number | string }>).map((row) =>
      Number(row.id),
    ),
  );
  // Still the same dedup identity as `entryDuplicateExists`, deliberately
  // excluding `observation_context` alongside `n` and `comments`: by this
  // point context promotion has already filled any one-sided gap and the
  // preflight has already refused any two-sided disagreement, so a loser row
  // matching here has nothing left to lose by being dropped.
  await db.execute(sql`
    DELETE FROM parameter_entries AS l
    WHERE l.drug_id = ${loserId}
      AND EXISTS (
        SELECT 1 FROM parameter_entries AS w
        WHERE w.drug_id = ${winnerId}
          AND w.parameter = l.parameter
          AND w.unit = l.unit
          AND w.matrix IS NOT DISTINCT FROM l.matrix
          AND w.scenario IS NOT DISTINCT FROM l.scenario
          AND w.route IS NOT DISTINCT FROM l.route
          AND w.citation_id IS NOT DISTINCT FROM l.citation_id
          AND w.qualifier IS NOT DISTINCT FROM l.qualifier
          AND w.categorical_value IS NOT DISTINCT FROM l.categorical_value
          AND w.low IS NOT DISTINCT FROM l.low
          AND w.high IS NOT DISTINCT FROM l.high
          AND w.median IS NOT DISTINCT FROM l.median
          ${dk.eq('w', 'l')}
      )`);
  await db.update(parameterEntries).set({ drugId: winnerId }).where(eq(parameterEntries.drugId, loserId));
  await db.update(drugParameterRevisions).set({ drugId: winnerId }).where(eq(drugParameterRevisions.drugId, loserId));
  await db.update(drugParameterDiscussions).set({ drugId: winnerId }).where(eq(drugParameterDiscussions.drugId, loserId));
  await db.update(drugInteractions).set({ drugId: winnerId }).where(eq(drugInteractions.drugId, loserId));
  await db.update(parameterPriorityFlags).set({ drugId: winnerId }).where(eq(parameterPriorityFlags.drugId, loserId));
  await db.update(citations).set({ drugId: winnerId }).where(eq(citations.drugId, loserId));

  // verification_log.target_id is a drug id only for target_type='parameter'.
  await db
    .update(verificationLog)
    .set({ targetId: winnerId })
    .where(and(eq(verificationLog.targetType, 'parameter'), eq(verificationLog.targetId, loserId)));

  // paper_extraction_jobs.target_drug_ids is an advisory id array.
  await db.execute(sql`
    UPDATE paper_extraction_jobs
    SET target_drug_ids = (
      SELECT array_agg(DISTINCT v)
      FROM unnest(array_replace(target_drug_ids, ${loserId}, ${winnerId})) AS v
    )
    WHERE ${loserId} = ANY(target_drug_ids)`);

  // 8. Rewrite internal wiki links pointing at the loser's monograph (both the
  //    /wiki/drug/<id> route and the /wiki/<slug> shape) so precursor and
  //    metabolite prose keeps resolving after the loser page is deleted.
  const rewrite: DrugLinkRewrite = {
    fromId: loserId,
    toId: winnerId,
    fromSlug: loser.monograph?.slug ?? null,
    toSlug: winner.monograph?.slug ?? null,
  };
  await rewriteWikiLinks(db, rewrite);

  // 9. Resolve the loser's monograph page, unless it happens to be the winner's
  //    own page (legacy CID collision).
  let loserMonographDeleted = false;
  if (loser.monograph && loser.monograph.pageId !== winner.monograph?.pageId) {
    const pageId = loser.monograph.pageId;
    if (!winner.monograph) {
      // The survivor has no monograph of its own (only possible on a manual
      // winner override, since every drug is created with a stub). Keep the
      // loser's page by repointing it rather than deleting the only monograph in
      // the merge — links already resolving to it stay valid.
      await db.update(wikiPages).set({ drugCid: winnerId }).where(eq(wikiPages.id, pageId));
    } else {
      // The survivor already carries the monograph; the loser's is a duplicate
      // (its prose was flagged in the plan warnings if it had any). Delete it
      // and the wiki-scoped pending edits targeting it, as the DELETE teardown
      // does. Also retarget the admin's agent-focus page-mode selection so a
      // config that named the loser's monograph doesn't silently resolve to an
      // empty scope after the delete (resolveFocusNarrowing joins page_ids
      // through wiki_pages — a dangling id is worse than no config at all).
      const winnerPageId = winner.monograph.pageId;
      const loserPageIdJson = JSON.stringify(pageId);
      await db.execute(sql`
        UPDATE agent_focus_config
        SET page_ids = (
          SELECT COALESCE(jsonb_agg(DISTINCT v ORDER BY v), '[]'::jsonb)
          FROM (
            SELECT CASE WHEN (elem)::int = ${pageId} THEN ${winnerPageId}::int
                        ELSE (elem)::int END AS v
            FROM jsonb_array_elements_text(page_ids) elem
          ) mapped
        )
        WHERE mode = 'pages'
          AND page_ids @> ${loserPageIdJson}::jsonb`);
      await db
        .delete(pendingEdits)
        .where(
          and(
            eq(pendingEdits.targetId, pageId),
            inArray(pendingEdits.editType, ['wiki_page', 'wiki_section', 'wiki_fact']),
          ),
        );
      await db.delete(wikiPages).where(eq(wikiPages.id, pageId));
      loserMonographDeleted = true;
    }
  }

  // 10. Saved simulator cases. `simulator_cases.case_data` embeds drug
  //     references in two shapes, both unconstrained by any FK:
  //
  //     - Forward-simulator cases: `case_data.drugs[].drugId` =
  //       `buildDrugComponentId(drug)` — a bare CID, or (#1256) a
  //       `drug:<id>` key for a CID-less drug. A CID-less loser can have
  //       cases saved under either spelling — see
  //       {@link simulatorDrugKeyCandidates} — so both are searched. If
  //       unrewritten, hydration fails or resolves to an unrelated drug
  //       whose internal id collides with the retired CID.
  //     - KineLab cases: `case_data.input.analyte` = the drug's slug. If the
  //       slug disappears, `loadCase` silently falls back to
  //       `DEFAULT_KINELAB_ANALYTE`, modelling a substance nobody chose.
  //
  //     Both shapes point at a SUBSTANCE and the substance survives the merge,
  //     so both are rewritten from the loser's key(s) to the winner's.
  const loserSimKeys = simulatorDrugKeyCandidates(loser);
  const winnerSimKey = buildDrugComponentId(winner);
  if (!loserSimKeys.every((key) => key === winnerSimKey)) {
    // Forward cases: replace drugId inside the drugs[] array where present.
    const loserSimKeyContainment = sql.join(
      loserSimKeys.map(
        (key) => sql`case_data -> 'drugs' @> ${JSON.stringify([{ drugId: key }])}::jsonb`,
      ),
      sql` OR `,
    );
    const loserSimKeySqlList = sql.join(
      loserSimKeys.map((key) => sql`${key}`),
      sql`, `,
    );
    await db.execute(sql`
      UPDATE simulator_cases SET case_data = jsonb_set(
        case_data, '{drugs}',
        (SELECT jsonb_agg(
           CASE WHEN d ->> 'drugId' IN (${loserSimKeySqlList})
                THEN jsonb_set(d, '{drugId}', to_jsonb(${winnerSimKey}::text))
                ELSE d END)
         FROM jsonb_array_elements(case_data -> 'drugs') d)
      )
      WHERE ${loserSimKeyContainment}`);
  }
  // KineLab cases: rewrite the analyte slug regardless of key equality, since
  // slug can change even when the id/CID does not.
  if (loser.slug !== winner.slug) {
    await db.execute(sql`
      UPDATE simulator_cases
      SET case_data = jsonb_set(case_data, '{input,analyte}', to_jsonb(${winner.slug}::text))
      WHERE case_data ->> 'kind' = 'kinelab-case'
        AND case_data -> 'input' ->> 'analyte' = ${loser.slug}`);
  }

  // 11. Polymorphic pending_edits whose target_id is the loser drug id.
  //
  //     Placed LAST, right before the drug delete: `pending_edits.target_id`
  //     is polymorphic and has no FK to `drugs`, so the row lock on the loser
  //     doesn't block a submission from inserting a proposal that targets the
  //     loser. A submission that lands earlier in the transaction (after step
  //     8's rewrite but before the delete) would otherwise be permanently
  //     orphaned. Sweeping here catches every proposal on disk at commit time
  //     — the loser drug row can't be deleted until this sweep and the delete
  //     both commit, and after commit no writer can insert a proposal
  //     against an id that no longer exists.
  //
  //     Order inside the sweep: drop loser rows that would collide with a
  //     winner row on the open-parameter unique index first, then repoint the
  //     rest of the drug-scoped edit kinds and the `param_entry` CREATE
  //     proposals (which also key by drug id).
  await db.execute(sql`
    DELETE FROM pending_edits AS l
    WHERE l.edit_type = 'parameter' AND l.status = 'pending' AND l.target_id = ${loserId}
      AND EXISTS (
        SELECT 1 FROM pending_edits AS w
        WHERE w.edit_type = 'parameter' AND w.status = 'pending'
          AND w.target_id = ${winnerId} AND w.parameter IS NOT DISTINCT FROM l.parameter
      )`);
  // Only `parameter` is safe to retarget silently regardless of status: it is
  // keyed by drug id + parameter name, and the ACTIVE collision case is
  // handled by the pre-DELETE above (or refused by `detectDataConflicts`).
  // `metabolism`, `receptor_targets`, and `enzyme_interaction` proposals
  // carry a FULL-REPLACEMENT payload — approving one after the merge would
  // wipe out every row the merge just preserved on the winner. ACTIVE ones
  // are refused ahead of time in `detectDataConflicts`, so if this
  // transaction reached step 11 no active row of those kinds targets the
  // loser. SETTLED (approved/rejected) rows are historical audit records
  // that can never be re-applied, but their polymorphic `target_id` would
  // still point at the deleted drug id after this step; retarget them too
  // so the audit trail stays resolvable.
  await db
    .update(pendingEdits)
    .set({ targetId: winnerId })
    .where(and(
      eq(pendingEdits.editType, 'parameter'),
      eq(pendingEdits.targetId, loserId),
    ));
  await db.execute(sql`
    UPDATE pending_edits
    SET target_id = ${winnerId}
    WHERE edit_type IN ('metabolism', 'receptor_targets', 'enzyme_interaction')
      AND status IN ('approved', 'rejected')
      AND target_id = ${loserId}`);
  // `param_entry` create proposals carry the drug id in TWO places: as the
  // polymorphic `target_id`, and inside `proposed_value.input.drugId`.
  // `applyApprovedParameterEntry` refuses to apply a proposal whose two ids
  // don't match (`param_entry_target_mismatch`). Retargeting only the outer
  // id would leave the inner id pointing at the deleted loser and make the
  // proposal impossible to approve. Rewrite both atomically.
  await db.execute(sql`
    UPDATE pending_edits
    SET target_id = ${winnerId},
        proposed_value = jsonb_set(
          proposed_value,
          '{input,drugId}',
          to_jsonb(${winnerId}::int)
        )
    WHERE edit_type = 'param_entry' AND target_id = ${loserId}
      AND (proposed_value ->> 'op') = 'create'`);
  // …and, from Cmax release C, in two more: the dose context's
  // `administeredDrugId` / `interactingDrugId`, nested in the create's `input`
  // or the update's `patch` (Cmax release B, #1340). The retarget above selects
  // proposals by their OUTER target — the analyte — so one about drug A naming
  // the loser as its administered drug is never selected there, and deleting
  // the loser would leave it pointing at nothing (JSON carries no foreign key).
  // Every active proposal, on any drug. One atomic UPDATE per path: a
  // concurrent PATCH of the same payload takes the advisory lock on every drug
  // the payload names (`withParamEntryPayloadLocks`), the loser included, so
  // it serializes behind this merge rather than overwriting the rewrite.
  for (const body of ['input', 'patch'] as const) {
    for (const key of NESTED_DRUG_REF_KEYS) {
      const path = `{${body},${key}}`;
      await db.execute(sql`
        UPDATE pending_edits
        SET proposed_value = jsonb_set(proposed_value, ${path}::text[], to_jsonb(${winnerId}::int))
        WHERE edit_type = 'param_entry'
          AND status IN ${sql.raw(`('${ACTIVE_PENDING_EDIT_STATUSES.join("', '")}')`)}
          AND jsonb_typeof(proposed_value #> ${path}::text[]) = 'number'
          AND (proposed_value #>> ${path}::text[])::int = ${loserId}`);
    }
  }
  // `wiki_new` proposals are monographs that don't exist yet, so they carry
  // the drug id under `proposed_meta.drugCid` rather than `target_id`. A
  // proposal targeting the loser's id must move to the winner or it will
  // publish a monograph for a nonexistent drug on approval. Every ACTIVE
  // status must be retargeted, not just 'pending' — a `draft` or `returned`
  // proposal can be resubmitted through `PATCH /api/pending-edits` and would
  // otherwise carry the stale loser id to approval time.
  await db.execute(sql`
    UPDATE pending_edits
    SET proposed_meta = jsonb_set(proposed_meta, '{drugCid}', to_jsonb(${winnerId}::int))
    WHERE edit_type = 'wiki_new'
      AND status IN ('pending', 'draft', 'returned')
      AND (proposed_meta ->> 'drugCid')::int = ${loserId}`);

  // 11a. Late-insert re-check for the full-replacement proposal kinds, as a
  //      backstop. The three submit handlers now take the per-drug advisory
  //      lock before inserting (#1076 item 1), so an ordinary contributor
  //      submission through the API already serializes against this merge —
  //      it either lands before `detectDataConflicts` runs (and is caught by
  //      the up-front refusal) or blocks on the lock until this transaction
  //      commits or rolls back. `pending_edits.target_id` still has no FK to
  //      `drugs`, though, so nothing stops a row landing outside that locked
  //      path (a direct insert, a future writer that forgets the lock) — keep
  //      this check as the last line of defense: rolling back here is the
  //      correct end-state, since the merge would otherwise leave the
  //      proposal pointed at a drug row the delete below removes, and a
  //      later approval would REPLACE the merged drug's whole list
  //      (metabolism / receptor_targets / enzyme_interaction) with a payload
  //      authored against the pre-merge loser.
  // Check BOTH sides. A submission that lands against the winner between
  // detectDataConflicts and this line is authored against the winner's
  // pre-merge rows; approving it after the merge would wipe the loser-only
  // rows the fold just inserted.
  const lateFullReplacementRows = await db.execute<{
    kind: string;
    side: string;
    count: number;
  }>(sql`
    SELECT
      edit_type AS kind,
      CASE WHEN target_id = ${winnerId} THEN 'winner' ELSE 'loser' END AS side,
      count(*)::int AS count
    FROM pending_edits
    WHERE edit_type IN ('metabolism', 'receptor_targets', 'enzyme_interaction')
      AND status IN ('pending', 'draft', 'returned')
      AND target_id IN (${winnerId}, ${loserId})
    GROUP BY edit_type, target_id`);
  if (lateFullReplacementRows.rows.length > 0) {
    throw new DrugMergeDataConflictError(
      lateFullReplacementRows.rows.map((row) => ({
        table: 'pending_edits',
        identity: `${row.count} active ${row.kind} proposal(s) on ${row.side} (submitted mid-merge)`,
        message: {
          code: 'dataConflict.fullReplacementProposalsLateInsert',
          params: { kind: row.kind, side: row.side },
          fallback: `a ${row.kind} proposal was submitted against the ${row.side} while this merge was preparing to commit. Approving it after the merge would REPLACE the merged drug's whole ${row.kind} list with a payload authored against the pre-merge row set. Settle it from the /review queue first, then merge again.`,
        },
      })),
    );
  }

  // 11b. Same late-insert race for `wiki_new`, which is keyed by
  //      `proposed_meta.drugCid` rather than `target_id`. Two failure modes,
  //      both destructive: a submission observed by the step 11 UPDATE that
  //      retargeted drugCid to the winner now points at a drug the survivor
  //      already has a monograph for (or WILL have via the step-9 repoint),
  //      so approval publishes a SECOND monograph on the survivor; a
  //      submission that lands just after that UPDATE still points at the
  //      loser id, so approval publishes a page for a nonexistent drug.
  //      Detect either shape here and roll back. Same "residual window
  //      only" comment as above applies.
  const winnerWillOwnMonograph =
    winner.monograph != null || loser.monograph != null;
  const wikiNewNoWinnerLater = await db.execute<{
    side: string;
    count: number;
  }>(sql`
    SELECT
      CASE WHEN (proposed_meta ->> 'drugCid')::int = ${winnerId} THEN 'winner' ELSE 'loser' END AS side,
      count(*)::int AS count
    FROM pending_edits
    WHERE edit_type = 'wiki_new'
      AND status IN ('pending', 'draft', 'returned')
      AND (proposed_meta ->> 'drugCid')::int IN (${winnerId}, ${loserId})
    GROUP BY (proposed_meta ->> 'drugCid')::int`);
  if (wikiNewNoWinnerLater.rows.length > 0) {
    // Winner-side proposals only fail when the survivor will own a
    // monograph (would create a second one). Loser-side proposals are
    // ALWAYS an orphan (loser id is about to be deleted).
    const bad = wikiNewNoWinnerLater.rows.filter(
      (row) => row.side === 'loser' || winnerWillOwnMonograph,
    );
    if (bad.length > 0) {
      throw new DrugMergeDataConflictError(
        bad.map((row) => ({
          table: 'pending_edits',
          identity: `${row.count} active wiki_new proposal(s) on ${row.side} (submitted mid-merge)`,
          message: {
            code: 'dataConflict.wikiNewLateInsert',
            params: { side: row.side, count: row.count },
            fallback: `a wiki_new proposal was submitted against the ${row.side} while this merge was preparing to commit. Approval after the merge would ${row.side === 'winner' ? 'publish a second monograph on the survivor (wiki_pages has no drug_cid uniqueness)' : 'publish a page for a drug that no longer exists (the loser is about to be deleted)'}. Settle it from the /review queue first, then merge again.`,
          },
        })),
      );
    }
  }

  // 12. Finally delete the loser drug row. Everything cascade-bound that we did
  //     not move goes with it; everything RESTRICT-bound was repointed above.
  await db.delete(drugs).where(eq(drugs.id, loserId));

  // 13. The winner now holds the loser's source entries, so its cached
  //     parameter summaries (weighted medians/IQRs over parameter_entries) are
  //     stale. Recompute them, attributing the revisions to the acting admin.
  await recomputeSummariesForDrug(winnerId, actorUserId);

  return {
    winnerId,
    loserId,
    counts,
    conflictsResolved: conflicts.length,
    loserMonographDeleted,
  };
}

/**
 * Rewrite drug links inside wiki page content, wiki revision snapshots and
 * queued edit payloads. Scoped by a `LIKE` prefilter so only rows that could
 * mention the loser are read and re-serialized.
 */
async function rewriteWikiLinks(db: Db, r: DrugLinkRewrite): Promise<void> {
  const idLike = `%/wiki/drug/${r.fromId}%`;
  const slugLike = r.fromSlug ? `%/wiki/${r.fromSlug}%` : idLike;

  // `FOR UPDATE` on each read-modify-write target so an editor's concurrent
  // UPDATE on the same row blocks until this merge transaction commits —
  // without the lock, the merge and the editor form a lost-update race:
  // both read the same starting content and the last writer clobbers the
  // other. `wiki_pages`/`wiki_revisions` beyond the winner and loser
  // monographs (third-party pages that merely mention the loser) were not
  // held by earlier FOR UPDATE calls in this transaction, so they need
  // their own lock here.
  const pages = await db.execute<{
    id: number;
    content: unknown;
    content_html: string | null;
  }>(sql`
    SELECT id, content, content_html FROM wiki_pages
    WHERE content::text LIKE ${idLike}
       OR content_html LIKE ${idLike}
       OR content::text LIKE ${slugLike}
       OR content_html LIKE ${slugLike}
    FOR UPDATE`);
  for (const page of pages.rows) {
    const nextContent = rewriteDrugLinksInJson(page.content, r);
    const nextHtml = rewriteDrugLinksInHtml(page.content_html ?? '', r);
    if (!nextContent.changed && !nextHtml.changed) continue;
    // Bump updated_at in the same UPDATE. The direct wiki save's optimistic
    // predicate compares the caller's snapshot against wiki_pages.updated_at
    // to detect drift; without a bump here, a save that waited behind this
    // rewrite would still match its pre-merge timestamp and commit its
    // pre-merge content on top of ours, restoring the loser URL.
    await db
      .update(wikiPages)
      .set({
        ...(nextContent.changed ? { content: nextContent.value as never } : {}),
        ...(nextHtml.changed ? { contentHtml: nextHtml.value } : {}),
        updatedAt: new Date(),
      })
      .where(eq(wikiPages.id, page.id));
  }

  const revisions = await db.execute<{
    id: number;
    content: unknown;
    content_html: string | null;
  }>(sql`
    SELECT id, content, content_html FROM wiki_revisions
    WHERE content::text LIKE ${idLike}
       OR content_html LIKE ${idLike}
       OR content::text LIKE ${slugLike}
       OR content_html LIKE ${slugLike}
    FOR UPDATE`);
  for (const revision of revisions.rows) {
    const nextContent = rewriteDrugLinksInJson(revision.content, r);
    const nextHtml = rewriteDrugLinksInHtml(revision.content_html ?? '', r);
    if (!nextContent.changed && !nextHtml.changed) continue;
    await db
      .update(wikiRevisions)
      .set({
        ...(nextContent.changed ? { content: nextContent.value as never } : {}),
        ...(nextHtml.changed ? { contentHtml: nextHtml.value } : {}),
      })
      .where(eq(wikiRevisions.id, revision.id));
  }

  const queued = await db.execute<{
    id: number;
    proposed_value: unknown;
  }>(sql`
    SELECT id, proposed_value FROM pending_edits
    WHERE proposed_value::text LIKE ${idLike}
       OR proposed_value::text LIKE ${slugLike}
    FOR UPDATE`);
  for (const edit of queued.rows) {
    const next = rewriteDrugLinksInJson(edit.proposed_value, r);
    if (!next.changed) continue;
    await db.update(pendingEdits).set({ proposedValue: next.value as never }).where(eq(pendingEdits.id, edit.id));
  }
}
