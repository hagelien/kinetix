/**
 * Asking the registries what a citation identifies, and storing the answer
 * (§13.3). The vocabulary and the rules for combining and expiring a verdict
 * are pure and live in `src/lib/citationWorkKind.ts`; this is the half that
 * touches the network and the row.
 *
 * ## Resolution is lazy, and refusal happens after asking
 *
 * Every citation predating migration 0107 is `unresolved`, and nothing
 * re-derives one on its own: `handleCreate` in `api/references.ts` returns an
 * exact existing row *before* calling the resolvers, treating the table as a
 * local cache, so reuse never refreshes metadata. A fail-closed rule applied to
 * that state would refuse every reference the catalog already holds — including
 * the journal articles the atlas is supposed to be built from. So a caller that
 * meets an unresolved (or expired) classification resolves it here, stores it,
 * and only then judges. `scripts/backfill-citation-work-kind.ts` does the same
 * work ahead of time so the first admission is not also the first fetch.
 *
 * ## A handle counts as examined only when a registry actually answered
 *
 * This is the distinction the whole thing turns on. "Crossref says this DOI is
 * a dataset" and "Crossref could not be reached" are both non-answers to the
 * question "is this a journal article", but they must not be recorded the same
 * way: listing an unreachable handle among the examined ones would make the
 * claim "every handle was asked" true while a registry's verdict was never
 * heard, and a PMID-primary row whose DOI resolves to a dataset would be
 * admitted on the strength of an outage. An examined handle is one that
 * produced a record. A handle that errored, timed out, or is unknown to every
 * registry is left out — the classification then never covers the row's current
 * handles, so it reads as expired and is asked again.
 *
 * A record that carries no object kind (a PubMed entry whose `pubtype` names
 * only study design) still counts as examined: the registry answered, it simply
 * did not say. That matters when another handle did say — the row resolves on
 * that handle's verdict instead of being stuck asking forever.
 */
import { sql } from 'drizzle-orm';
import {
  classificationCoversHandles,
  classificationHandles,
  isAdmissibleCitationWorkKind,
  isCitationWorkKind,
  isCitationWorkKindStatus,
  mergeStoredClassifications,
  workKindFromCrossrefType,
  workKindFromDataCiteType,
  workKindFromPubMedTypes,
  type CitationWorkKind,
  type CitationWorkKindStatus,
  type CitationWorkKindVerdict,
} from '../../src/lib/citationWorkKind.js';
import { normalizeReferenceMetadata } from './reference-metadata.js';
import { fetchCrossRefMetadata } from './crossref.js';
import { fetchDataCiteRecord } from './datacite.js';
import { fetchPubMedMetadata } from './pubmed.js';
import { getDb } from './db.js';

type Db = ReturnType<typeof getDb>;

/** The columns a classification is read from. */
export interface CitationClassificationRow {
  id: number;
  type: string;
  identifier: string;
  metadata: unknown;
  workKind: string | null;
  workKindStatus: string;
  workKindHandles: string[] | null;
  workKindVerdicts: unknown;
}

export interface StoredClassification {
  status: CitationWorkKindStatus;
  kind: CitationWorkKind | null;
  /** The handles the row carries right now, sorted. */
  handles: string[];
  /**
   * Whether the stored verdict is still a claim about this row — every current
   * handle is among the examined ones. False for an unresolved row, and false
   * for one whose handle set has grown since.
   */
  current: boolean;
}

/**
 * What the row says about itself, with currency computed rather than read.
 *
 * The currency test is a subset in one direction only: the claim is "every
 * handle this citation carried was asked", so it survives a handle
 * disappearing and expires when one appears. That asymmetry is what stops a
 * `PATCH /api/references` that drops a DOI from erasing the `conflicted`
 * verdict that DOI produced.
 */
export function readClassification(
  row: CitationClassificationRow,
): StoredClassification {
  const metadata = normalizeReferenceMetadata(row.metadata);
  const handles = classificationHandles({
    type: row.type,
    identifier: row.identifier,
    altIds: metadata?.altIds ?? null,
  });
  const status = isCitationWorkKindStatus(row.workKindStatus)
    ? row.workKindStatus
    : 'unresolved';
  const kind = isCitationWorkKind(row.workKind) ? row.workKind : null;
  return {
    status,
    kind,
    handles,
    current:
      status !== 'unresolved' &&
      classificationCoversHandles(row.workKindHandles, handles),
  };
}

/** One registry lookup's outcome for one handle. */
interface HandleAnswer {
  /** A registry produced a record for this handle. */
  examined: boolean;
  kind: CitationWorkKind | null;
}

/**
 * The registry calls, injectable so the storage rules can be tested without a
 * network and so a caller with its own rate-limit budget can supply throttled
 * ones.
 */
export interface WorkKindProviders {
  crossref: typeof fetchCrossRefMetadata;
  datacite: typeof fetchDataCiteRecord;
  pubmed: typeof fetchPubMedMetadata;
}

const DEFAULT_PROVIDERS: WorkKindProviders = {
  crossref: fetchCrossRefMetadata,
  datacite: fetchDataCiteRecord,
  pubmed: fetchPubMedMetadata,
};

const NO_ANSWER: HandleAnswer = { examined: false, kind: null };

async function askPubMed(
  pmid: string,
  providers: WorkKindProviders,
): Promise<HandleAnswer> {
  try {
    const record = await providers.pubmed(pmid);
    if (!record) return NO_ANSWER;
    return { examined: true, kind: workKindFromPubMedTypes(record.publicationTypes) };
  } catch {
    // Transient: unreachable is not an answer, so the handle stays unexamined
    // and the classification expires until someone asks again.
    return NO_ANSWER;
  }
}

/**
 * A DOI is asked of its registrar, and there are two.
 *
 * Crossref first, because journal DOIs are Crossref DOIs and that is the
 * overwhelming majority of what this catalog cites. DataCite second, and it is
 * not a fallback for completeness: research datasets are registered there, so
 * without it the gate's headline case — a dataset admitted under a DOI —
 * answers "unknown to Crossref" and resolves nothing.
 *
 * Whichever registry produces a record answers for the handle. A DOI neither
 * one knows was not examined, so it does not become a publication by omission.
 */
async function askDoi(
  doi: string,
  providers: WorkKindProviders,
): Promise<HandleAnswer> {
  try {
    const record = await providers.crossref(doi);
    if (record) {
      return { examined: true, kind: workKindFromCrossrefType(record.workType) };
    }
  } catch {
    // Fall through: DataCite may still be able to answer, and if it cannot the
    // handle is left unexamined either way.
  }
  try {
    const record = await providers.datacite(doi);
    if (record) {
      return {
        examined: true,
        kind: workKindFromDataCiteType(record.resourceTypeGeneral),
      };
    }
  } catch {
    return NO_ANSWER;
  }
  return NO_ANSWER;
}

export type ResolveWorkKindOutcome =
  | { outcome: 'current'; classification: StoredClassification }
  | { outcome: 'stored'; classification: StoredClassification }
  | { outcome: 'unanswered'; classification: StoredClassification }
  | { outcome: 'no_handles'; classification: StoredClassification }
  | { outcome: 'raced'; classification: StoredClassification };

/**
 * Resolve one citation's work kind, storing it if the registries answer.
 *
 * Returns without touching the network when the stored classification still
 * covers the row's handles. Otherwise every askable handle is consulted — all
 * of them, not just the primary one: a citation keyed by PMID with a DOI in
 * `metadata.altIds` is asked through both, and a disagreement between them
 * lands in `conflicted` rather than being decided by whichever handle happened
 * to be stronger.
 *
 * The write is conditional on the handles not having moved while the fetches
 * were in flight. A resolve that started before a concurrent merge or `PATCH`
 * added a handle would otherwise read the old set and write `resolved` over the
 * top — a publication verdict that never looked at the new DOI, with no further
 * handle change to expire it. Zero rows updated means the row moved; the caller
 * asks again.
 */
export async function resolveCitationWorkKind(
  db: Db,
  citationId: number,
  providers: WorkKindProviders = DEFAULT_PROVIDERS,
): Promise<ResolveWorkKindOutcome> {
  const before = await loadClassificationRow(db, citationId);
  if (!before) {
    throw new Error(`Citation ${citationId} not found`);
  }
  const stored = readClassification(before);
  if (stored.current) return { outcome: 'current', classification: stored };
  if (stored.handles.length === 0) {
    // Nothing any registry can be asked about — a `freetext` row, or a `url`
    // that is not a resolver. It stays unresolved, which is the honest state
    // and the one admission refuses.
    return { outcome: 'no_handles', classification: stored };
  }

  const examined: string[] = [];
  const verdicts: CitationWorkKindVerdict[] = [];
  for (const handle of stored.handles) {
    const [type, identifier] = splitHandle(handle);
    const answer =
      type === 'pmid'
        ? await askPubMed(identifier, providers)
        : await askDoi(identifier, providers);
    if (!answer.examined) continue;
    examined.push(handle);
    if (answer.kind) verdicts.push({ handle, kind: answer.kind });
  }

  // Fold this attempt into what the row already knew, rather than replacing it.
  //
  // Replacing was the first shape, and it erases evidence exactly when the
  // evidence matters. A row conflicted between a PMID article and a DOI dataset
  // gains a third handle, is re-asked while the dataset DOI is unreachable, and
  // comes back with verdicts only from the handles that answered: an article,
  // over a smaller examined set. Remove the unreachable DOI afterwards and the
  // subset test finds that article verdict current — the conflict deleted by an
  // outage plus a patch, neither of which learned anything about the object.
  //
  // A fresh answer overrides the old one for the same handle, so a registry
  // that corrects itself is still heard; a handle that did not answer keeps the
  // verdict it gave last time.
  const priorVerdicts = storedVerdicts(before.workKindVerdicts);
  const priorHandles = before.workKindHandles ?? [];
  const merged = mergeStoredClassifications(
    { handles: examined, verdicts },
    { handles: priorHandles, verdicts: priorVerdicts },
  );

  const learnedSomething =
    examined.some((handle) => !priorHandles.includes(handle)) ||
    verdicts.some(
      (verdict) =>
        priorVerdicts?.find((prior) => prior.handle === verdict.handle)?.kind !==
        verdict.kind,
    );

  if (merged.status === 'unresolved' || !learnedSomething) {
    // Either nobody answered, or the ones who did told us only what the row
    // already recorded. There is nothing to store — and storing "we asked and
    // learned nothing" as a fresh resolution would move the answer's date to a
    // moment at which no registry said anything.
    return { outcome: 'unanswered', classification: stored };
  }
  const classified = merged;

  const updated = await db.execute<{ id: number }>(sql`
    UPDATE "citations"
       SET "work_kind" = ${classified.kind},
           "work_kind_status" = ${classified.status},
           "work_kind_handles" = ARRAY(
             SELECT jsonb_array_elements_text(${JSON.stringify(classified.handles)}::jsonb)
           ),
           "work_kind_verdicts" = ${JSON.stringify(classified.verdicts)}::jsonb,
           "work_kind_resolved_at" = now()
     WHERE "id" = ${citationId}
       AND "type" = ${before.type}
       AND "identifier" = ${before.identifier}
       AND COALESCE("metadata" -> 'altIds', 'null'::jsonb)
             IS NOT DISTINCT FROM ${JSON.stringify(storedAltIds(before.metadata))}::jsonb
    RETURNING "id"
  `);

  if (updated.rows.length === 0) {
    return { outcome: 'raced', classification: stored };
  }

  const after = await loadClassificationRow(db, citationId);
  return {
    outcome: 'stored',
    classification: after ? readClassification(after) : stored,
  };
}

/**
 * The `altIds` object exactly as the row stores it — not as
 * `normalizeReferenceMetadata` would render it.
 *
 * The optimistic guard compares this against the column, so it has to be the
 * same bytes the column holds. Comparing a normalized copy would make the guard
 * fail forever on any row whose stored alt ids predate normalization: the write
 * would never land, the classification would never be stored, and the row would
 * be re-fetched from the registries on every read.
 */
function storedAltIds(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  return (metadata as Record<string, unknown>).altIds ?? null;
}

function splitHandle(handle: string): [string, string] {
  const separator = handle.indexOf(':');
  return [handle.slice(0, separator), handle.slice(separator + 1)];
}

export async function loadClassificationRow(
  db: Db,
  citationId: number,
): Promise<CitationClassificationRow | null> {
  const result = await db.execute<{
    id: number;
    type: string;
    identifier: string;
    metadata: unknown;
    work_kind: string | null;
    work_kind_status: string;
    work_kind_handles: string[] | null;
    work_kind_verdicts: unknown;
  }>(sql`
    SELECT "id", "type", "identifier", "metadata",
           "work_kind", "work_kind_status", "work_kind_handles",
           "work_kind_verdicts"
      FROM "citations"
     WHERE "id" = ${citationId}
     LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    type: row.type,
    identifier: row.identifier,
    metadata: row.metadata,
    workKind: row.work_kind,
    workKindStatus: row.work_kind_status,
    workKindHandles: row.work_kind_handles,
    workKindVerdicts: row.work_kind_verdicts,
  };
}

/**
 * The stored verdict list, as verdicts. The column is `jsonb`, so its shape is
 * held by a check constraint rather than by the type system; an entry that
 * fails the shape is dropped rather than folded, since a malformed one is
 * evidence of nothing.
 */
function storedVerdicts(value: unknown): CitationWorkKindVerdict[] | null {
  if (!Array.isArray(value)) return null;
  const verdicts = value.filter(
    (entry): entry is CitationWorkKindVerdict =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as { handle?: unknown }).handle === 'string' &&
      isCitationWorkKind((entry as { kind?: unknown }).kind),
  );
  return verdicts.length > 0 ? verdicts : null;
}

/**
 * Why a citation may not back a reference cohort, or `null` when it may.
 *
 * Each reason is a different thing to do about it, which is why they are not
 * one boolean: `unresolved` is waiting on a registry, `stale` is waiting on a
 * re-resolve, `conflicted` is waiting on a human, and `not_a_publication` is
 * settled and will not change.
 */
export type CohortAdmissionRefusal =
  | 'unresolved'
  | 'stale'
  | 'conflicted'
  | 'not_a_publication'
  | 'not_read_in_full';

export interface CohortAdmissionVerdict {
  admissible: boolean;
  reason: CohortAdmissionRefusal | null;
  classification: StoredClassification;
}

/**
 * Whether a citation may back a cohort, judged from what is already stored.
 *
 * Pure in the sense that matters: it asks no registry. `stale` is a state of
 * its own here rather than being folded into `unresolved`, because the two
 * differ in what is known — a stale row has a verdict that covered a smaller
 * handle set, and treating it as never-asked would discard the evidence that
 * verdict holds.
 */
export function judgeStoredAdmission(
  classification: StoredClassification,
  readInFull: boolean,
): CohortAdmissionVerdict {
  const classificationRefusal = judgeClassificationForAtlas(classification);
  if (classificationRefusal) {
    return { admissible: false, reason: classificationRefusal, classification };
  }
  if (!readInFull) {
    return { admissible: false, reason: 'not_read_in_full', classification };
  }
  return { admissible: true, reason: null, classification };
}

/**
 * The half of admission that keeps being true or stops being true.
 *
 * Separated because the two halves have different lifetimes. Whether a human
 * read the paper is a statement about the moment the cohort was admitted, and
 * a review later replaced does not retroactively unadmit it (§34.4). Whether
 * the citation is *currently* a resolved publication is a claim that expires —
 * a handle appears, a merge makes it conflicted — so matching re-reads exactly
 * this part on every case, and a cohort failing it contributes nothing.
 */
export function judgeClassificationForAtlas(
  classification: StoredClassification,
): CohortAdmissionRefusal | null {
  if (classification.status === 'unresolved') return 'unresolved';
  if (classification.status === 'conflicted') return 'conflicted';
  if (!classification.current) return 'stale';
  if (!isAdmissibleCitationWorkKind(classification.kind)) {
    return 'not_a_publication';
  }
  return null;
}

/**
 * The admission path: resolve if the row needs it, then judge.
 *
 * Refusal happens after asking, never instead of asking. Every citation
 * predating migration 0107 is `unresolved`, and nothing re-derives one on its
 * own — `handleCreate` returns an exact existing row before calling the
 * resolvers — so a gate that judged the stored state directly would refuse
 * every reference the catalog already holds, including the journal articles
 * this atlas is built from. One resolve attempt is made when the stored
 * classification does not cover the row's handles; if the registries do not
 * answer, the refusal is `unresolved` or `stale`, which is an outage rather
 * than a verdict and says so.
 *
 * The read-in-full condition (§34.4) is checked here and not re-checked by
 * matching, deliberately: it is a statement about whether a human vouched for
 * the paper at the moment it was admitted, and a review that is later replaced
 * does not retroactively unadmit a cohort. What can expire is the
 * classification — which is precisely what matching re-reads.
 */
export async function admitCitationForCohort(
  db: Db,
  citationId: number,
  providers: WorkKindProviders = DEFAULT_PROVIDERS,
): Promise<CohortAdmissionVerdict> {
  const resolved = await resolveCitationWorkKind(db, citationId, providers);
  const readInFull = await citationHasReadInFullReview(db, citationId);
  return judgeStoredAdmission(resolved.classification, readInFull);
}

async function citationHasReadInFullReview(
  db: Db,
  citationId: number,
): Promise<boolean> {
  const result = await db.execute<{ read_in_full: boolean }>(sql`
    SELECT COALESCE(bool_or("read_in_full"), FALSE) AS read_in_full
      FROM "paper_reviews"
     WHERE "citation_id" = ${citationId}
  `);
  return result.rows[0]?.read_in_full === true;
}
