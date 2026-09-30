/**
 * Conversation ingestion — the admin write path for a
 * `kinetix-conversation-ingestion-v1` bundle (`src/lib/conversationIngestion.ts`).
 *
 * A chat assistant running the `kinetix` skill turns the reusable part of a
 * conversation into one bundle of independently verified proposals: source-level
 * parameter observations, atomic wiki facts, and (rarely) a new topic page. This
 * module resolves those proposals against the live database and — for the ones
 * an admin ticks off — writes them.
 *
 * Two entry points, one resolver:
 *
 *   planIngestion(bundle)              → what each item would do, item by item
 *   applyIngestion(bundle, { accept }) → executes the accepted items, each
 *                                        re-planned immediately before its write
 *
 * **A plan is recomputed inside apply, per item, never trusted from the client.**
 * That is what makes the admin's acceptance gate safe (a tampered request cannot
 * promote a blocked item) and what makes a re-run idempotent: an item already
 * written re-plans as `duplicate` and is skipped, so a double-clicked Apply or a
 * re-pasted bundle costs nothing. Per item rather than per batch, because
 * earlier items change the state later ones resolve against — two accepted facts
 * carrying the same statement must not both go in. There is no ingestion-run
 * table precisely because the database state itself is the record — a run row
 * would only ever duplicate what the entries, facts and revisions already say.
 *
 * Nothing here bypasses a domain invariant. Parameter observations go in through
 * `insertParameterEntry` + the ordinary recompute, so the displayed value stays
 * a derived aggregate; wiki facts are staged as a `wiki_fact` pending edit and
 * immediately approved by the acting admin through `applyApprovedEdit`, so the
 * fact splice, revision, HTML regeneration and conflict marking are the very
 * code the review queue runs. The admin's per-item acceptance IS the review —
 * that is the one thing this path shortens.
 *
 * With one exception, and it is the reason the review queue is still reachable
 * from here: a fact whose sources the assistant did NOT read in full was never
 * verified to the standard that acceptance stands on. Such a fact is staged the
 * same way and then simply left `pending`, so it reaches `/review` as an
 * ordinary proposal and a human does the full-text check. Carrying an unverified
 * claim across is useful; publishing one on an admin's single click is not, and
 * the plan — never the request — decides which of the two an item gets.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  citations,
  drugParameters,
  drugs,
  paperReviews,
  parameterEntries,
  pendingEdits,
  wikiCategories,
  wikiPageCategories,
  wikiPages,
  wikiRevisions,
} from '../../db/schema.js';
import { getDb, runInPoolTransaction } from './db.js';
import { handleMatch, resolveCitation } from './citation-store.js';
import { recordPaperReview } from './paper-review-store.js';
import { recordApproval } from './approvals.js';
import {
  isActiveAgentUser,
  recordImplicitAgentApproval,
} from './agent-verifications.js';
import {
  wikiContentFocusRefusal,
  wikiTargetFocusRefusal,
} from '../agent-focus.js';
import {
  canonicalizeReportedStatistic,
  NO_DOSE_CONTEXT,
} from '../../src/lib/entryDoseContext.js';
import { parameterDoseContextMode } from '../../src/lib/drugParameters.js';
import {
  entryDuplicateExists,
  insertParameterEntry,
  recomputeParameterAndDependents,
  findDuplicateEntry,
  attachSourceQuoteIfMissing,
} from './parameter-entries-store.js';
import { applyApprovedEdit } from './pending-edits-helpers.js';
import {
  ensureDrugMonograph,
  resolveMonographDrugCids,
} from './monograph-helpers.js';
import { generateSlug } from './slug.js';
import { ensureTopicSectionIds, extractPlaintext, renderHtml } from './tiptap-utils.js';
import {
  sourceQuoteComparisonKey,
  parameterEntryInputSchema,
  validateEntryForParameter,
  type ParameterEntryInput,
} from '../../src/lib/parameterEntries.js';
import { isDrugParameterId } from '../../src/lib/drugParameters.js';
import {
  createFactNode,
  isFactNode,
  isMonographContentV2,
  iterateSectionBodies,
  wrapV1AsV2,
  type MonographContentV2,
} from '../../src/lib/monographContent.js';
import { isMonographSectionId } from '../../src/lib/monographSections.js';
import {
  extractTopicSections,
  isValidTopicSectionId,
  mintUniqueSectionId,
} from '../../src/lib/topicSections.js';
import { normalizeMetabolismName } from '../../src/lib/metabolism.js';
import { resolveDrugName } from '../../src/lib/drugNames.js';
import { findDrugNameCandidates } from './researchImportStore.js';
// The wiki tree's depth/cycle rule lives with the route that owns page
// creation. Importing it keeps one implementation of the invariant rather than
// a second copy of its recursive CTE drifting behind the first.
import { validateParentAssignment } from '../wiki/pages.js';
import {
  canonicalCitationHandle,
  resolverHandleFromUrl,
  type CitationAltIds,
  type CitationHandleType,
} from '../../src/lib/citationHandles.js';
import { unverifiedSourceKeys } from '../../src/lib/conversationIngestion.js';
import type {
  IngestionBlockedCandidate,
  IngestionDrugTarget,
  IngestionParameterItem,
  IngestionSource,
  IngestionStudyContext,
  IngestionTopicPageItem,
  IngestionWikiFactItem,
  NormalizedConversationIngestion,
} from '../../src/lib/conversationIngestion.js';

/**
 * `parameter_entries.origin` is varchar(20), so the tag is short. It marks the
 * rows this path wrote, next to `contributor` and `deep-research`.
 */
export const CONVERSATION_ENTRY_ORIGIN = 'conversation';

/** `pending_edits.proposed_meta.source` for the facts this path stages. */
export const CONVERSATION_INGESTION_SOURCE = 'conversation-ingestion';

/** Study context has no column yet, so it is folded into the entry's comments. */
const MAX_ENTRY_COMMENTS = 2000;

// ─── Plan shapes (what the admin ticks off) ──────────────────────────────────

/**
 * What would happen to one item.
 *
 * `ready` writes on apply, `review` is staged in the `/review` queue instead of
 * being published, `duplicate` is already in the database (accepting it does
 * nothing), `blocked` cannot be written at all. Only `ready` and `review` items
 * are executable — the apply path enforces that regardless of what the client
 * sent, and it is the plan (never the request) that decides which of the two an
 * item is.
 */
export type ItemDisposition = 'ready' | 'review' | 'duplicate' | 'blocked';

/** The dispositions an accepted item may actually execute under. */
const EXECUTABLE_DISPOSITIONS: ReadonlySet<ItemDisposition> = new Set([
  'ready',
  'review',
]);

export interface SourcePlan {
  key: string;
  type: string;
  identifier: string;
  title: string | null;
  /**
   * The rest of the bibliographic data the write would persist.
   *
   * `resolveCitation` stores these on a new row and fills gaps on an existing
   * one, and they feed reference search, author grouping and the year axis — so
   * a model's invented author list is publishable content, not decoration.
   * Shown for the same reason the appraisal is.
   */
  metadata: {
    authors: string[];
    journal: string | null;
    year: number | null;
  };
  /** Existing citation row for this paper, if one is already on file. */
  citationId: number | null;
  citationAction: 'reuse' | 'create';
  /**
   * `record` writes the bundle's appraisal (no review on file, or the one on
   * file is not read-in-full); `keep` leaves an existing read-in-full review
   * alone — a chat model's appraisal never overwrites a published one.
   */
  reviewAction: 'record' | 'keep';
  /**
   * The appraisal this bundle carries for the source, verbatim — shown whether
   * or not it would be written today.
   *
   * Recording a review is not bookkeeping: `read_in_full` is the gate that
   * decides whether this paper may back a fact or a parameter anywhere in
   * Kinetix, and the markdown becomes the paper's current review. Accepting an
   * item that cites it accepts this text too, so the gate has to show it —
   * `record` vs `keep` alone tells an admin nothing about what they are signing.
   * It is disclosed even under `keep` because `keep` is a fact about the
   * database right now, not a promise: if the existing review is withdrawn
   * before Apply (a replaced PDF does exactly that), this is the text that
   * would land.
   */
  review: {
    readInFull: boolean;
    locator: string;
    evidenceSummary: string;
    reviewMarkdown: string;
    reviewConfidence: string | null;
    overallScore: number | null;
  } | null;
  /** The review this one would replace — set only when it is being replaced. */
  replacedReview: { readInFull: boolean; reviewMarkdown: string } | null;
  /**
   * The bundle asked for this paper's full text to be obtained.
   *
   * Such a source backs nothing — the contract forbids citing a paper that was
   * not read in full — so it never reaches the write path and would otherwise
   * disappear without trace. Surfacing it is the point: the conversation found a
   * paper worth having and could not get it, and that is exactly what the PDF
   * request queue exists for. This path does not open the request itself (see
   * the operator guide); it makes sure the ask is visible.
   */
  pdfRequestNeeded: boolean;
  /**
   * An earlier source key that resolves to this same paper, if any.
   *
   * Two keys can land on one row — duplicate handles, or a PMID and a DOI the
   * ID converter joins — and only the first one's appraisal is written; the
   * rest hit the existing read-in-full review and are kept. Saying `record` for
   * all of them would promise every appraisal and deliver one, so the later
   * keys report `keep` and name the key whose appraisal wins.
   */
  sameAs: string | null;
}

interface ItemPlanCommon {
  index: number;
  /**
   * Digest of the material facts this row was resolved against — the target it
   * would write to and, for a replacement, the text it would overwrite.
   *
   * Everything in it is database-derived, so it changes only when the world
   * changed under the admin: a name-only drug target re-resolving after an alias
   * edit, a fact anchor whose statement someone rewrote, a proposal whose parent
   * or categories moved. Apply refuses an item whose digest no longer matches
   * the one displayed, because "still `ready`" is not the same as "still the
   * thing you agreed to". Deliberately excludes counts and current aggregates:
   * those move for reasons that have nothing to do with this decision, and a
   * guard that cries wolf gets clicked through.
   */
  fingerprint: string;
  disposition: ItemDisposition;
  /** Stable code the React layer translates. Never user-facing prose. */
  reason: string | null;
  /** Names/ids to interpolate into the translated reason. Not translated. */
  detail: string | null;
  /** Non-fatal notes, as stable codes. */
  notes: string[];
  sourceKeys: string[];
  editSummary: string | null;
}

export interface ParameterItemPlan extends ItemPlanCommon {
  type: 'parameter_observation';
  drugId: number | null;
  /** The resolved row's own name — what the write would be filed under. */
  drugName: string;
  /** What the bundle called it. Differs from `drugName` on a stale identity. */
  targetName: string;
  parameter: string;
  /** The reading, as it would be stored. */
  reading: {
    low?: number;
    high?: number;
    /** The legacy unlabelled centre; absent when the centre is labelled. */
    median?: number;
    /**
     * The labelled centre and what it is (mean, median, …), and what
     * `low`/`high` are (SD, range, …) — in stored form, so a labelled `median`
     * shorthand shows as the `centralValue` it will be written as.
     */
    centralValue?: number;
    centralStatistic?: string;
    intervalKind?: string;
    qualifier?: string;
    unit: string;
    matrix?: string;
    scenario?: string;
    n?: number;
  };
  /** What the drug currently shows for this parameter, if anything. */
  current: { value: unknown; entryCount: number } | null;
  /**
   * The exact `parameter_entries.comments` this observation would store.
   *
   * Model-authored prose — route, dose, population, species, derivation and the
   * bundle's own comment — is folded in here until `parameter_entries.context`
   * exists. It is scientific content, so the gate has to show it: a checkbox
   * that publishes text nobody read is not a review.
   */
  comments: string | null;
  /**
   * The verbatim source quote this observation would store, or attach to an
   * existing entry it enriches.
   *
   * Carried for the same reason as `comments`, and more urgently: this one
   * claims to be the source's own words. An admin ticking it through without
   * seeing it is certifying a quotation they have not read, against a value
   * they cannot compare it to — which is the exact review failure the field was
   * added to prevent, reproduced at the gate meant to catch it.
   */
  quote: string | null;
}

export interface WikiFactItemPlan extends ItemPlanCommon {
  type: 'wiki_fact';
  pageId: number | null;
  pageTitle: string | null;
  pageType: string | null;
  sectionId: string;
  operation: 'add' | 'replace' | 'remove';
  statement: string | null;
  /** The statement being replaced or removed, read from the live page. */
  existingStatement: string | null;
  /**
   * The citations currently attached to that fact.
   *
   * A replace swaps the node, so these are discarded in favour of the bundle's;
   * a remove deletes them with it. Either way the admin is dropping provenance,
   * and a row that shows the old sentence but not the papers behind it hides
   * the more consequential half of the edit. Part of the digest too, so a
   * reference-only edit by someone else still needs fresh consent.
   */
  existingReferences: Array<{
    id: number;
    type: string;
    identifier: string;
    title: string | null;
  }>;
  /** How many facts the target section already holds. */
  sectionFactCount: number;
  /**
   * The cited source keys the assistant did not read in full.
   *
   * Non-empty is exactly what makes this row `review` rather than `ready` — the
   * row's `reason`/`detail` say the same thing in the shape every other row
   * uses, and this is the structured form, carried onto the staged proposal so
   * the reviewer inherits it.
   */
  unverifiedSourceKeys: string[];
}

export interface TopicPageItemPlan extends ItemPlanCommon {
  type: 'topic_page_proposal';
  slug: string;
  title: string;
  sectionCount: number;
  factCount: number;
  rationale: string;
  /**
   * Every heading and every statement the page would be published with.
   *
   * Counts are not a review. Accepting this item publishes each of these
   * sentences, and the gate is what replaces the review queue — so the gate has
   * to carry the prose, exactly as the wiki-fact rows carry theirs.
   */
  sections: Array<{
    /** The anchor the section will really carry — a later fact targets this. */
    sectionId: string;
    titleNb: string;
    facts: Array<{ statement: string; sourceKeys: string[] }>;
  }>;
  /**
   * Where the page would sit in the wiki tree, and which taxonomy links would be
   * published with it. Both are real writes (`wiki_pages.parent_id`,
   * `wiki_page_categories`), so both belong in front of the checkbox — a page
   * filed under the wrong parent is as much a content decision as its prose.
   * `parent` is null when none was proposed, or when the proposed one was
   * dropped (the item's notes say which).
   */
  parent: { slug: string; title: string } | null;
  /** Category names that resolved, and the proposed ones that matched nothing. */
  categories: { matched: string[]; dropped: string[] };
}

export type ItemPlan = ParameterItemPlan | WikiFactItemPlan | TopicPageItemPlan;

export interface IngestionPlan {
  idempotencyKey: string;
  mode: string;
  createdAt: string;
  sources: SourcePlan[];
  items: ItemPlan[];
  blockedCandidates: IngestionBlockedCandidate[];
  counts: { ready: number; review: number; duplicate: number; blocked: number };
}

// ─── Apply shapes ────────────────────────────────────────────────────────────

export interface AppliedItem {
  index: number;
  /**
   * `applied` is live content; `queued` is a pending edit awaiting a reviewer.
   * Distinct statuses because they are different promises to the admin, and a
   * receipt that called both "applied" would report unpublished facts as
   * published.
   */
  status: 'applied' | 'queued' | 'skipped' | 'failed';
  /** Stable code: the plan's reason for a skip, or the failure class. */
  reason: string | null;
  detail: string | null;
  /** Entry id, wiki revision id, page id, or pending-edit id — whichever this item produced. */
  createdId: number | null;
}

export interface IngestionApplyResult {
  citationsCreated: number;
  reviewsRecorded: number;
  items: AppliedItem[];
  counts: { applied: number; queued: number; skipped: number; failed: number };
}

export interface IngestionActor {
  userId: number;
}

/**
 * What the gate told the admin would happen to each source's review, keyed by
 * bundle source key.
 *
 * Supplied by the client and compared against a fresh computation. Trusting it
 * is safe in exactly one direction: a mismatch only ever WITHHOLDS a write. The
 * server still records a review only when its own check says the paper has none
 * that was read in full — this can never cause a write, only refuse one.
 *
 * It exists because `keep` is a statement about the database at Analyse time. A
 * review can be withdrawn in between (recording a replacement PDF sets
 * `read_in_full = false` precisely so a wrong-paper upload stops authorising
 * facts), and silently switching to `record` would publish an appraisal under a
 * consent the admin never gave and restore the authorization someone had
 * deliberately withdrawn.
 */
export type ExpectedReviewActions = Map<string, 'record' | 'keep'>;

/**
 * The item fingerprints the gate displayed, by item index.
 *
 * Same trust argument as {@link ExpectedReviewActions}: supplied by the client,
 * compared against a fresh computation, and able only to WITHHOLD a write. It
 * closes the general form of the same hole — an item can still be `ready` while
 * the thing it resolves to has changed underneath (a name-only drug target
 * re-resolving after an alias edit, a fact anchor whose statement someone
 * rewrote), and "still applicable" is not "still what you agreed to".
 */
export type ExpectedItemFingerprints = Map<number, string>;

/**
 * Alternate handles per bundle source key, as confirmed by the NCBI ID
 * converter. Resolved by the route (this module makes no network calls, so an
 * apply stays deterministic) and never taken from the bundle itself.
 */
export type CitationCrosswalk = Map<string, CitationAltIds>;

// ─── Internals ───────────────────────────────────────────────────────────────

/**
 * One planned item plus, when it is applicable, the closure that performs it.
 *
 * Keeping the write next to the resolution that justified it is what lets apply
 * re-plan from scratch and then execute without a second, drifting copy of the
 * resolution logic.
 */
interface PlannedItem {
  plan: ItemPlan;
  execute?: (actor: IngestionActor) => Promise<number | null>;
}

/**
 * A plan before its fingerprint is stamped on.
 *
 * The planners build the material fields; `planItem` derives the digest from
 * the finished object, so no construction site can forget it or compute a
 * different one. Distributive `Omit`, so the union stays a union.
 */
type WithoutFingerprint<T> = T extends unknown ? Omit<T, 'fingerprint'> : never;
type ItemPlanDraft = WithoutFingerprint<ItemPlan>;

interface PlannedItemDraft {
  plan: ItemPlanDraft;
  execute?: (actor: IngestionActor) => Promise<number | null>;
}

/**
 * Follow `sameAs` to the key that owns a paper.
 *
 * Several bundle keys can name one paper — declared twice, or joined by the ID
 * converter — and `planSources` records that by pointing each later key at the
 * first one in bundle order. Anything that must reason about the PAPER rather
 * than the key walks this chain: which appraisal gets written, whether a review
 * withdrawal touches an item, whether a claim counts as unverified, and which
 * citation id to record for it.
 *
 * One definition because the copies drift: an id lookup that skipped this walk
 * is exactly how a staged unread-source id came back empty for a crosswalked
 * alias.
 */
function sameAsRoot(plans: ReadonlyArray<SourcePlan>, key: string): string {
  const seen = new Set<string>();
  let current = key;
  for (;;) {
    const next = plans.find((p) => p.key === current)?.sameAs;
    if (!next || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
}

/** Citation ids by bundle source key, plus what the write path did. */
interface SourceContext {
  citationIdByKey: Map<string, number>;
  plans: SourcePlan[];
  citationsCreated: number;
  reviewsRecorded: number;
  /** Keys already written, so a source shared by two items is committed once. */
  committedKeys: Set<string>;
}

type Db = ReturnType<typeof getDb>;

/**
 * Look a source's paper up under every handle it declares, without writing.
 *
 * The apply path calls `resolveCitation`, which creates and merges rows; the
 * plan must not, so it asks the same OR predicate (`handleMatch`) whether the
 * paper is already on file. A source that resolves to nothing here is simply one
 * whose citation will be minted on apply.
 */
async function findExistingCitation(
  db: Db,
  source: IngestionSource,
  crosswalk: CitationCrosswalk,
): Promise<{ id: number } | null> {
  // The bundle's own `altIds` are NOT used to find a row. They come from an
  // unpinned model, and matching on an invented alias would attribute this
  // reading to a different paper. Only the declared handle and handles the ID
  // converter confirmed are addressable. Without a crosswalk (the read-only
  // plan makes no network calls) this can report `create` where the apply will
  // find and reuse a row — under-reporting a reuse is harmless; mis-identifying
  // a paper is not.
  const verified = crosswalk.get(source.key) ?? {};
  const handles = [
    effectiveHandle(source),
    ...(verified.pmid ? [{ type: 'pmid' as const, identifier: verified.pmid }] : []),
    ...(verified.doi ? [{ type: 'doi' as const, identifier: verified.doi }] : []),
    ...(verified.url ? [{ type: 'url' as const, identifier: verified.url }] : []),
  ];
  const [row] = await db
    .select({ id: citations.id })
    .from(citations)
    .where(handleMatch(handles))
    .limit(1);
  return row ?? null;
}

/**
 * The handle a source really names.
 *
 * The contract lets a source be `type: "url"` with a resolver address, and
 * `https://doi.org/10.x/y` is a DOI wearing a URL. `resolveCitation` does not
 * unwrap those, so filing it verbatim would mint a second row for a paper
 * already on file under its DOI — one paper, two rows, two independent reviews,
 * and the read-in-full gate answering differently depending on which one a fact
 * cites. That is the split `citation-store` exists to prevent.
 */
function effectiveHandle(source: IngestionSource): {
  type: CitationHandleType;
  identifier: string;
} {
  const unwrapped = resolverHandleFromUrl(source.identifier);
  // Only PMID and DOI: `citations` files nothing under a PMC id, so a PMC URL
  // keeps its declared handle rather than being re-typed into a column that
  // cannot hold it. The ID converter still crosswalks it.
  if (unwrapped && (unwrapped.type === 'pmid' || unwrapped.type === 'doi')) {
    return { type: unwrapped.type, identifier: unwrapped.identifier };
  }
  return { type: source.type as CitationHandleType, identifier: source.identifier };
}

/**
 * The handle `resolveCitation` would file this source under — its canonical
 * handle given the declared one plus whatever the ID converter confirmed.
 * Two bundle keys producing the same string are the same paper.
 */
function canonicalHandleKey(
  source: IngestionSource,
  crosswalk: CitationCrosswalk,
): string {
  const canonical = canonicalCitationHandle(
    effectiveHandle(source),
    crosswalk.get(source.key) ?? {},
  );
  return `${canonical.type}:${canonical.identifier.toLowerCase()}`;
}

/**
 * The citation's current review, if it has one.
 *
 * Every field `recordPaperReview` writes, not just the two the gate displays:
 * the unchanged-check below compares this against what a write would produce,
 * and a comparison that reads fewer columns than the write touches reports
 * "identical" about fields it never looked at.
 */
interface StoredReview {
  readInFull: boolean;
  reviewMarkdown: string;
  overallScore: number | null;
  conclusionSupport: string | null;
  reviewConfidence: string | null;
}

async function currentReview(
  db: Db,
  citationId: number,
): Promise<StoredReview | null> {
  const [row] = await db
    .select({
      readInFull: paperReviews.readInFull,
      reviewMarkdown: paperReviews.reviewMarkdown,
      overallScore: paperReviews.overallScore,
      conclusionSupport: paperReviews.conclusionSupport,
      reviewConfidence: paperReviews.reviewConfidence,
    })
    .from(paperReviews)
    .where(eq(paperReviews.citationId, citationId))
    .limit(1);
  if (!row) return null;
  return {
    readInFull: Boolean(row.readInFull),
    reviewMarkdown: String(row.reviewMarkdown ?? ''),
    overallScore: row.overallScore ?? null,
    conclusionSupport: row.conclusionSupport ?? null,
    reviewConfidence: row.reviewConfidence ?? null,
  };
}

/**
 * Would recording this source's appraisal change the review already on file?
 *
 * A read-in-full review is never touched (checked separately), but an unread
 * one IS replaced — and that replacement is a real editorial event: it appends
 * a `paper_review_revisions` row and resets the peer verifications the live
 * review carried. Doing that when the text is byte-identical is pure churn,
 * and it is reachable without anyone doing anything unusual: two applies of one
 * bundle overlap, both commit sources before either reaches the page lock, and
 * the one that goes on to skip its item as a duplicate has already rewritten
 * the review. `reviewMarkdownFor` is deterministic precisely so this comparison
 * is possible.
 */
function reviewIsUnchanged(
  current: StoredReview | null,
  source: IngestionSource,
): boolean {
  if (!current) return false;
  // Every field the write sets. A re-review that only moves the rubric score is
  // a real change — the score is stored content and is read back downstream —
  // so skipping on markdown alone would silently keep the old number while
  // reporting the source as handled.
  return (
    current.readInFull === source.verification.readInFull &&
    current.reviewMarkdown === reviewMarkdownFor(source) &&
    current.overallScore === (source.verification.overallScore ?? null) &&
    current.conclusionSupport === (source.verification.conclusionSupport ?? null) &&
    current.reviewConfidence === (source.verification.reviewConfidence ?? null)
  );
}

/** Read-only source pass: what apply would do with each source. */
async function planSources(
  db: Db,
  bundle: NormalizedConversationIngestion,
  crosswalk: CitationCrosswalk = new Map(),
): Promise<SourceContext> {
  const citationIdByKey = new Map<string, number>();
  const plans: SourcePlan[] = [];
  // The row each key would be filed under, so two keys naming one paper are
  // recognised here rather than discovered at write time.
  const firstKeyForPaper = new Map<string, string>();
  for (const source of bundle.sources) {
    const existing = await findExistingCitation(db, source, crosswalk);
    if (existing) citationIdByKey.set(source.key, existing.id);
    const current = existing ? await currentReview(db, existing.id) : null;

    const paperKey = existing
      ? `id:${existing.id}`
      : canonicalHandleKey(source, crosswalk);
    const sameAs = firstKeyForPaper.get(paperKey) ?? null;
    if (!sameAs) firstKeyForPaper.set(paperKey, source.key);

    // A later key for the same paper writes nothing: the first key's appraisal
    // is already the review by the time this one is reached.
    const keepReview = Boolean(current?.readInFull) || sameAs !== null;
    plans.push({
      key: source.key,
      type: source.type,
      identifier: source.identifier,
      title: source.metadata?.title ?? null,
      metadata: {
        authors: source.metadata?.authors ?? [],
        journal: source.metadata?.journal ?? null,
        year: source.metadata?.year ?? null,
      },
      citationId: existing?.id ?? null,
      citationAction: existing ? 'reuse' : 'create',
      reviewAction: keepReview ? 'keep' : 'record',
      sameAs,
      review: {
        readInFull: source.verification.readInFull,
        locator: source.verification.locator,
        evidenceSummary: source.verification.evidenceSummary,
        reviewMarkdown: reviewMarkdownFor(source),
        reviewConfidence: source.verification.reviewConfidence ?? null,
        overallScore: source.verification.overallScore ?? null,
      },
      // Only when something is actually being written over: a first review
      // replaces nothing, and a kept one is not touched at all.
      replacedReview: !keepReview && current ? current : null,
      pdfRequestNeeded: source.pdfRequestNeeded,
    });
  }
  return {
    citationIdByKey,
    plans,
    citationsCreated: 0,
    reviewsRecorded: 0,
    committedKeys: new Set(),
  };
}

/**
 * Write the sources ONE item depends on: mint or reuse each citation, then
 * record the bundle's appraisal unless a read-in-full review is already on file.
 *
 * Called immediately after that item re-plans `ready` and before it is written,
 * never for the batch. A review published in the admin's name is a real
 * editorial act — `read_in_full` decides whether the paper may back a fact or a
 * parameter anywhere in Kinetix — so it must not be left behind by an item that
 * then turns out to be a duplicate of one written moments earlier in the same
 * apply.
 *
 * Accumulates into `ctx`, so a source two accepted items share is resolved and
 * reviewed exactly once.
 */
async function commitSourcesFor(
  bundle: NormalizedConversationIngestion,
  neededKeys: Set<string>,
  actor: IngestionActor,
  ctx: SourceContext,
  crosswalk: CitationCrosswalk,
): Promise<void> {
  const pending = bundle.sources.filter(
    (source) => neededKeys.has(source.key) && !ctx.committedKeys.has(source.key),
  );
  if (pending.length === 0) return;

  // ALL of this item's sources in one transaction, not one each. A fact citing
  // two papers whose second write fails would otherwise leave the first paper
  // filed and reviewed in the admin's name while the item itself publishes
  // nothing — a globally authorising review backing content that never landed.
  // Which source's appraisal each key should publish. `sameAs` names a paper's
  // first key in BUNDLE order, and the gate showed that; but whether that key's
  // item is accepted is a separate question, so a later key can be the one that
  // actually reaches the write. Following the chain here means the review that
  // lands is the one the admin was shown either way — the alternative, deriving
  // a winner from the accepted set, would make the gate's promise depend on a
  // selection made after it was rendered.
  const appraisalFor = (key: string): IngestionSource => {
    const owner = sameAsRoot(ctx.plans, key);
    return (
      bundle.sources.find((source) => source.key === owner) ??
      bundle.sources.find((source) => source.key === key)!
    );
  };

  const outcomes = await runInPoolTransaction(async () => {
    const tx = getDb();
    const results: Array<{
      key: string;
      id: number;
      created: boolean;
      recorded: boolean;
    }> = [];

    for (const source of pending) {
      // Alternate handles come from the ID converter, never from the bundle:
      // `resolveCitation` treats a crosswalk as authoritative and may merge two
      // rows on the strength of it, and a merge of two different papers
      // repoints their references and reviews. A model's well-formed guess is
      // not bibliographic identity.
      const verified = crosswalk.get(source.key) ?? {};
      const handle = effectiveHandle(source);
      const resolved = await resolveCitation(
        tx,
        {
          type: handle.type,
          identifier: handle.identifier,
          metadata: source.metadata
            ? { ...source.metadata, altIds: verified }
            : { altIds: verified },
          crosswalk: verified,
        },
        actor.userId,
      );

      // Read INSIDE the transaction, so a second key for the same paper sees
      // the review the first one just wrote and keeps it rather than
      // overwriting it with a second appraisal.
      const current = await currentReview(tx, resolved.id);
      const appraisal = appraisalFor(source.key);
      // Nothing to do when a read-in-full review already stands (a chat model's
      // appraisal never displaces one), and nothing to do when the review on
      // file is already exactly what this would write — see
      // `reviewIsUnchanged` for why the second case is worth checking.
      if (current?.readInFull || reviewIsUnchanged(current, appraisal)) {
        results.push({
          key: source.key,
          id: resolved.id,
          created: resolved.created,
          recorded: false,
        });
        continue;
      }
      await recordPaperReview({
        citationId: resolved.id,
        authorUserId: actor.userId,
        input: {
          reviewMarkdown: reviewMarkdownFor(appraisal),
          overallScore: appraisal.verification.overallScore ?? null,
          conclusionSupport: appraisal.verification.conclusionSupport ?? null,
          reviewConfidence: appraisal.verification.reviewConfidence ?? null,
          readInFull: appraisal.verification.readInFull,
          editSummary: `Innlesing fra samtale (${bundle.idempotencyKey})`,
        },
      });
      results.push({
        key: source.key,
        id: resolved.id,
        created: resolved.created,
        recorded: true,
      });
    }
    return results;
  });

  // Context moves only after the commit, so nothing is marked done — and no
  // counter reports a write — that a rollback has undone.
  for (const outcome of outcomes) {
    ctx.citationIdByKey.set(outcome.key, outcome.id);
    if (outcome.created) ctx.citationsCreated += 1;
    if (outcome.recorded) ctx.reviewsRecorded += 1;
    ctx.committedKeys.add(outcome.key);
  }
}

/**
 * The source keys one item cites.
 *
 * Exported so the route can require an expected review action for exactly the
 * sources an apply would touch, rather than re-deriving which keys those are.
 */
export function sourceKeysOf(item: NormalizedConversationIngestion['items'][number]): Set<string> {
  if (item.type === 'parameter_observation') return new Set([item.sourceKey]);
  if (item.type === 'wiki_fact') return new Set(item.sourceKeys);
  return new Set(
    item.sections.flatMap((section) =>
      section.facts.flatMap((fact) => fact.sourceKeys),
    ),
  );
}

/**
 * The stored review body: the model's appraisal plus the evidence locator it
 * read the value at. The locator is what a later reader needs to check the
 * claim, and it exists nowhere else in the schema — dropping it would leave a
 * review that cannot be re-verified.
 *
 * Deterministic, so a re-run of the same bundle upserts identical text rather
 * than appending a second copy.
 *
 * The labels are Norwegian: this text is published as the paper review a
 * Norwegian reader sees on the reference page, so the chrome around the
 * bundle's own prose belongs in the same language as the prose.
 */
function reviewMarkdownFor(source: IngestionSource): string {
  const { reviewMarkdown, locator, evidenceSummary } = source.verification;
  return [
    reviewMarkdown.trim(),
    '',
    `**Sted i kilden:** ${locator}`,
    '',
    `**Funn:** ${evidenceSummary}`,
  ].join('\n');
}

// ─── Drug + page resolution ──────────────────────────────────────────────────

interface ResolvedDrug {
  id: number;
  names: Record<string, string>;
  aliases: string[] | null;
  pubchemCid: number | null;
}

/**
 * Resolve the drug a bundle item names.
 *
 * A chat model has no Kinetix ids, so identity normally arrives as name +
 * PubChem CID. CID is decisive when present; otherwise the name is matched
 * against the same tab-delimited search key the deep-research importer uses, and
 * a term matching two different drugs is an ambiguity the admin must settle —
 * never a coin flip between two substances.
 */
async function resolveDrugTarget(
  db: Db,
  target: IngestionDrugTarget,
): Promise<
  | { ok: true; drug: ResolvedDrug; notes: string[] }
  | {
      ok: false;
      reason: 'drug_not_found' | 'drug_ambiguous' | 'drug_identity_conflict';
      detail: string;
    }
> {
  const select = {
    id: drugs.id,
    names: drugs.names,
    aliases: drugs.aliases,
    pubchemCid: drugs.pubchemCid,
  };

  /**
   * Cross-check the identifiers the bundle supplied against the row they
   * resolved to.
   *
   * A bundle can name a drug three ways, and a stale `drugId` next to a correct
   * name is indistinguishable from a correct id next to a stale name — except by
   * asking the row. A PubChem CID that disagrees is a hard conflict: the two
   * identifiers name different substances and there is no reading of the item
   * that is safe to write. A name that matches nothing the row is known by is
   * softer (synonyms, spellings and languages legitimately differ), so it is
   * reported and the plan shows the RESOLVED name — an admin must never approve
   * a row labelled with the identity the bundle claimed rather than the one the
   * write would use.
   */
  const verify = (
    row: ResolvedDrug,
  ):
    | { ok: true; drug: ResolvedDrug; notes: string[] }
    | { ok: false; reason: 'drug_identity_conflict'; detail: string } => {
    if (
      target.pubchemCid != null &&
      row.pubchemCid != null &&
      row.pubchemCid !== target.pubchemCid
    ) {
      return {
        ok: false,
        reason: 'drug_identity_conflict',
        detail: `CID ${target.pubchemCid} ≠ ${row.pubchemCid} (drug ${row.id})`,
      };
    }
    const notes: string[] = [];
    const claimed = normalizeMetabolismName(target.drugName);
    const known = [
      ...Object.values(row.names ?? {}).map((n) => normalizeMetabolismName(String(n))),
      ...((row.aliases ?? []) as string[]).map((a) => normalizeMetabolismName(a)),
    ].filter(Boolean);
    if (claimed && known.length > 0 && !known.includes(claimed)) {
      notes.push('drug_name_mismatch');
    }
    return { ok: true, drug: row, notes };
  };

  if (target.drugId != null) {
    const [row] = await db
      .select(select)
      .from(drugs)
      .where(eq(drugs.id, target.drugId))
      .limit(1);
    if (row) return verify(row as ResolvedDrug);
    return { ok: false, reason: 'drug_not_found', detail: `id ${target.drugId}` };
  }

  if (target.pubchemCid != null) {
    const [row] = await db
      .select(select)
      .from(drugs)
      .where(eq(drugs.pubchemCid, target.pubchemCid))
      .limit(1);
    if (row) return verify(row as ResolvedDrug);
  }

  const term = normalizeMetabolismName(target.drugName);
  if (term) {
    const candidates = await findDrugNameCandidates(db, [term]);
    const matches = candidates.filter((c) => {
      const keys = [
        ...Object.values(c.names ?? {}).map((n) => normalizeMetabolismName(String(n))),
        ...((c.aliases ?? []) as string[]).map((a) => normalizeMetabolismName(a)),
      ];
      return keys.includes(term);
    });
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only) {
      const [row] = await db
        .select(select)
        .from(drugs)
        .where(eq(drugs.id, only.id))
        .limit(1);
      if (row) return verify(row as ResolvedDrug);
    }
    if (matches.length > 1) {
      return {
        ok: false,
        reason: 'drug_ambiguous',
        detail: matches.map((m) => m.id).join(', '),
      };
    }
  }

  return {
    ok: false,
    reason: 'drug_not_found',
    detail:
      target.pubchemCid != null
        ? `${target.drugName} (CID ${target.pubchemCid})`
        : target.drugName,
  };
}

/** The name the write would be filed under, not the one the bundle claimed. */
function resolvedDrugLabel(drug: ResolvedDrug): string {
  const names = drug.names ?? {};
  return (
    resolveDrugName(names as Record<string, string>, 'nb') ||
    resolveDrugName(names as Record<string, string>, 'en') ||
    `#${drug.id}`
  );
}

interface ResolvedPage {
  id: number;
  slug: string;
  title: string;
  pageType: string;
  content: unknown;
}

/** Plain text of a fact node, used for duplicate detection and preview. */
function factNodeText(node: unknown): string {
  const walk = (value: unknown): string => {
    if (!value || typeof value !== 'object') return '';
    const n = value as { text?: unknown; content?: unknown };
    if (typeof n.text === 'string') return n.text;
    if (!Array.isArray(n.content)) return '';
    return n.content.map(walk).join('');
  };
  return walk(node).trim();
}

/** Every fact node stored under one section of a page, in document order. */
function sectionFacts(page: ResolvedPage, sectionId: string): unknown[] {
  if (page.pageType === 'drug_monograph') {
    const content: MonographContentV2 = isMonographContentV2(page.content)
      ? (page.content as MonographContentV2)
      : wrapV1AsV2(page.content);
    return iterateSectionBodies(content)
      .filter((chunk) => chunk.sectionId === sectionId)
      .flatMap((chunk) => (chunk.body.content ?? []).filter(isFactNode));
  }
  const section = extractTopicSections(
    page.content as { content?: unknown[] } | null,
  ).find((s) => s.sectionId === sectionId);
  return (section?.bodyContent ?? []).filter(isFactNode);
}

/**
 * Locate a fact anywhere on the page — section, and on a monograph the field
 * within it.
 *
 * Anchoring on where the fact ACTUALLY is, rather than where the conversation
 * expected it, is what makes replace/remove survive an editor having moved it in
 * the meantime: the approval path splices by (sectionId, fieldId, factId), so a
 * pending edit carrying the conversation's stale section would search the wrong
 * body and fail to find an anchor that plainly exists.
 */
function findFactAnywhere(
  page: ResolvedPage,
  factId: string,
): { sectionId: string; fieldId?: string; node: unknown } | null {
  if (page.pageType === 'drug_monograph') {
    const content: MonographContentV2 = isMonographContentV2(page.content)
      ? (page.content as MonographContentV2)
      : wrapV1AsV2(page.content);
    for (const chunk of iterateSectionBodies(content)) {
      for (const node of chunk.body.content ?? []) {
        if (isFactNode(node) && node.attrs.factId === factId) {
          return { sectionId: chunk.sectionId, fieldId: chunk.fieldId, node };
        }
      }
    }
    return null;
  }
  for (const section of extractTopicSections(
    page.content as { content?: unknown[] } | null,
  )) {
    for (const node of section.bodyContent) {
      if (isFactNode(node) && node.attrs.factId === factId) {
        return { sectionId: section.sectionId, node };
      }
    }
  }
  return null;
}

/** Resolve citation ids to something an admin can recognise on the row. */
async function describeCitations(
  db: Db,
  ids: number[],
): Promise<
  Array<{ id: number; type: string; identifier: string; title: string | null }>
> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: citations.id,
      type: citations.type,
      identifier: citations.identifier,
      metadata: citations.metadata,
    })
    .from(citations)
    .where(inArray(citations.id, ids));
  return ids
    .map((id) => rows.find((row) => row.id === id))
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .map((row) => ({
      id: row.id,
      type: String(row.type),
      identifier: String(row.identifier),
      title:
        (row.metadata as { title?: string } | null)?.title ?? null,
    }));
}

/** The citation ids a stored fact node carries, in ascending order. */
function factReferenceIds(node: unknown): number[] {
  const attrs = (node as { attrs?: { referenceIds?: unknown } })?.attrs;
  const ids = Array.isArray(attrs?.referenceIds) ? attrs.referenceIds : [];
  return ids.filter((id): id is number => typeof id === 'number').sort((a, b) => a - b);
}

async function loadPage(db: Db, pageId: number): Promise<ResolvedPage | null> {
  const [row] = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      pageType: wikiPages.pageType,
      content: wikiPages.content,
    })
    .from(wikiPages)
    .where(eq(wikiPages.id, pageId))
    .limit(1);
  return (row as ResolvedPage | undefined) ?? null;
}

async function loadPageBySlug(db: Db, slug: string): Promise<ResolvedPage | null> {
  const [row] = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      pageType: wikiPages.pageType,
      content: wikiPages.content,
    })
    .from(wikiPages)
    .where(eq(wikiPages.slug, slug))
    .limit(1);
  return (row as ResolvedPage | undefined) ?? null;
}

/**
 * The drug's monograph, without creating one (the plan pass writes nothing).
 *
 * `wiki_pages.drug_cid` is mixed-vintage — modern rows store `drugs.id`, legacy
 * rows a PubChem CID — so both are candidates, but not unconditionally: when
 * this drug's CID happens to be another drug's internal id, the page carrying it
 * is that other drug's monograph. `resolveMonographDrugCids` is the collision
 * check `ensureDrugMonograph` already uses, and reusing it is what keeps a fact
 * from being spliced into the wrong drug's page (25C-NBOMe id=281 vs carbon
 * monoxide pubchem_cid=281).
 */
async function findMonographForDrug(
  db: Db,
  drug: ResolvedDrug,
): Promise<ResolvedPage | null> {
  const candidateCids = await resolveMonographDrugCids(db, drug);
  const [row] = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      pageType: wikiPages.pageType,
      content: wikiPages.content,
      drugCid: wikiPages.drugCid,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.pageType, 'drug_monograph'),
        inArray(wikiPages.drugCid, candidateCids),
      ),
    )
    .limit(1);
  return (row as ResolvedPage | undefined) ?? null;
}

// ─── Parameter observations ──────────────────────────────────────────────────

/**
 * The item's study context (dose, route, formulation, population, ...) —
 * facts about the reading itself, in the same sense `observationContext`
 * (migration 0120, #1257) means it everywhere else. Written to that column,
 * and it IS in `SOURCE_QUOTE_EVIDENCE_FIELDS`: a sentence about a fasted
 * single dose is not evidence for a repeated-dose reading, so a later change
 * to this text has to be able to detach a stored quote the way a change to
 * `unit` or `median` already does.
 *
 * Deterministic prose, not a structured object, so a re-run of the same
 * bundle produces byte-identical text and two bundles describing the same
 * study compare equal.
 */
function studyContextText(
  item: IngestionParameterItem,
  source: IngestionSource,
): string | undefined {
  const c: IngestionStudyContext = item.context ?? {};
  const parts: string[] = [];
  const push = (label: string, value: string | undefined) => {
    if (value && value.trim()) parts.push(`${label}: ${value.trim()}`);
  };
  push('Analytt', c.analyte);
  push('Salt/form', c.saltOrForm);
  push('Administrasjonsvei', c.route);
  push('Formulering', c.formulation);
  push('Dose', c.dose);
  push('Regime', c.regimen);
  push('Populasjon', c.population);
  push('Art', c.species);
  push('Studiedesign', c.studyDesign);
  push('Studiearm', c.studyArm);
  push('Prøvetaking', c.samplingWindow);
  push('Modell', c.model);
  push('Analysemetode', c.analyticalMethod);
  push('Postmortem', c.postmortemContext);
  if (c.derivation) {
    push('Utledning', c.derivation.kind);
    push('Ligning', c.derivation.equation);
    push('Antakelser', c.derivation.assumptions);
    push('Usikkerhet', c.derivation.uncertainty);
  }
  push('Kilde', source.verification.locator);

  const body = parts.join(' · ');
  if (!body) return undefined;
  return body.length > MAX_ENTRY_COMMENTS
    ? body.slice(0, MAX_ENTRY_COMMENTS - 1) + '…'
    : body;
}

/** The model's own commentary about the row — curatorial, not observational. See `studyContextText`. */
function curatorComment(item: IngestionParameterItem): string | undefined {
  const c = item.comments?.trim();
  return c && c.length ? c : undefined;
}

/**
 * The combined, human-readable text for the admin's review card — study
 * context and curator commentary together, exactly as `comments` used to hold
 * both before #1257 split them into two columns. Preview-only: `entryInput`
 * and `quoteEvidenceOf` write/compare the two pieces separately.
 */
function contextComments(
  item: IngestionParameterItem,
  source: IngestionSource,
): string | undefined {
  const body = [curatorComment(item), studyContextText(item, source)]
    .filter((s): s is string => Boolean(s && s.length))
    .join('\n\n');
  return body || undefined;
}

async function planParameterItem(
  db: Db,
  bundle: NormalizedConversationIngestion,
  item: IngestionParameterItem,
  index: number,
  sources: SourceContext,
): Promise<PlannedItemDraft> {
  const source = bundle.sources.find((s) => s.key === item.sourceKey)!;
  // The reported statistic as it will be stored, so the gate shows the centre
  // and what it is — an admin must not publish a mean the preview never showed.
  const statistic = canonicalizeReportedStatistic({
    median: item.median,
    centralValue: item.doseContext?.centralValue ?? undefined,
    centralStatistic: item.doseContext?.centralStatistic ?? undefined,
    intervalKind: item.doseContext?.intervalKind ?? undefined,
    valueBasis: item.doseContext?.valueBasis ?? undefined,
  });
  const reading = {
    low: item.low,
    high: item.high,
    median: statistic.median ?? undefined,
    centralValue: statistic.centralValue ?? undefined,
    centralStatistic: statistic.centralStatistic ?? undefined,
    intervalKind: statistic.intervalKind ?? undefined,
    qualifier: item.qualifier,
    unit: item.unit,
    matrix: item.matrix,
    scenario: item.scenario,
    n: item.n,
  };
  const base = {
    index,
    type: 'parameter_observation' as const,
    sourceKeys: [item.sourceKey],
    editSummary: item.editSummary,
    notes: [] as string[],
    // Filled in from the resolved row once it is known: the gate must show the
    // drug the write would land on, not the one the bundle claimed.
    drugName: item.target.drugName,
    targetName: item.target.drugName,
    parameter: item.parameter,
    reading,
    comments: contextComments(item, source) ?? null,
    quote: item.quote ?? null,
  };

  const blocked = (
    reason: string,
    detail: string | null,
    drugId: number | null = null,
  ): PlannedItemDraft => ({
    plan: {
      ...base,
      disposition: 'blocked',
      reason,
      detail,
      drugId,
      current: null,
    },
  });

  const resolved = await resolveDrugTarget(db, item.target);
  if (!resolved.ok) return blocked(resolved.reason, resolved.detail);
  const drug = resolved.drug;
  base.drugName = resolvedDrugLabel(drug);
  base.notes.push(...resolved.notes);

  // Structured dose context (Cmax dose-context RFC), with its drug references
  // resolved the way the target was. An omitted administered drug is the
  // target itself, stored as the explicit self-reference the RFC requires.
  const { administeredDrug, interactingDrug, route: doseRoute, ...doseFields } =
    item.doseContext ?? {};
  const doseContextRequired = parameterDoseContextMode(item.parameter) === 'required';
  let administeredDrugId: number | undefined;
  let interactingDrugId: number | undefined;
  if (administeredDrug) {
    const administered = await resolveDrugTarget(db, administeredDrug);
    if (!administered.ok) return blocked(administered.reason, administered.detail, drug.id);
    administeredDrugId = administered.drug.id;
  } else if (doseContextRequired) {
    administeredDrugId = drug.id;
  }
  if (interactingDrug) {
    const interacting = await resolveDrugTarget(db, interactingDrug);
    if (!interacting.ok) return blocked(interacting.reason, interacting.detail, drug.id);
    interactingDrugId = interacting.drug.id;
  }
  const doseContext = canonicalizeReportedStatistic({
    median: item.median,
    ...doseFields,
    ...(administeredDrugId !== undefined ? { administeredDrugId } : {}),
    ...(interactingDrugId !== undefined ? { interactingDrugId } : {}),
  });
  const entryRoute = doseRoute ?? undefined;

  // Re-check against the live registry rather than trusting the bundle parser:
  // a unit or bound can change between the conversation and the import.
  const invalid = validateEntryForParameter(item.parameter, {
    low: item.low,
    high: item.high,
    unit: item.unit,
    matrix: item.matrix,
    scenario: item.scenario,
    qualifier: item.qualifier,
    n: item.n,
    route: entryRoute,
    ...doseContext,
    median: doseContext.median ?? undefined,
  });
  if (invalid) return blocked('parameter_invalid', invalid, drug.id);
  if (!isDrugParameterId(item.parameter)) {
    return blocked('parameter_invalid', item.parameter, drug.id);
  }
  const parameter = item.parameter;

  const [summary] = await db
    .select({ value: drugParameters.value })
    .from(drugParameters)
    .where(
      and(eq(drugParameters.drugId, drug.id), eq(drugParameters.parameter, parameter)),
    )
    .limit(1);
  const [{ count: entryCount } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(parameterEntries)
    .where(
      and(
        eq(parameterEntries.drugId, drug.id),
        eq(parameterEntries.parameter, parameter),
      ),
    );
  const current = summary
    ? { value: summary.value, entryCount: Number(entryCount) }
    : null;

  const citationId = sources.citationIdByKey.get(item.sourceKey) ?? null;
  // The bundle parser validated matrix and scenario against the very enums the
  // entry schema uses, so this shape IS an entry input; the cast states what the
  // parser guaranteed, and `execute` re-parses it before writing anyway.
  const entryInput = (citation: number): ParameterEntryInput =>
    ({
      drugId: drug.id,
      parameter,
      low: item.low,
      high: item.high,
      qualifier: item.qualifier,
      unit: item.unit,
      matrix: item.matrix,
      scenario: item.scenario,
      route: entryRoute,
      n: item.n,
      comments: curatorComment(item),
      observationContext: studyContextText(item, source),
      quote: item.quote,
      citationId: citation,
      ...doseContext,
      median: doseContext.median ?? undefined,
    }) as ParameterEntryInput;

  /**
   * The fields a quote for THIS item attests to, for a guarded attach.
   *
   * Shared by the planner's duplicate branch and the late-duplicate branch in
   * `execute`, which ask the same question at two different moments — and would
   * otherwise be two statements of one rule, which is how they drift.
   */
  /**
   * An attach that did not write, but left the state the admin accepted.
   *
   * `attachSourceQuoteIfMissing` only fills a gap, so a failure means somebody
   * got there first. If they wrote the SAME sentence, the provenance the admin
   * approved is on the row and the item is an ordinary idempotent re-run —
   * reporting a no-op would describe it as missing. A DIFFERENT sentence is two
   * claims about what the source says, which is a question for a human, so it
   * stays a no-op. Both branches that attach ask this, and asking it in two
   * places is how they would come to answer it differently.
   */
  const alreadySaysTheSame = (current: string | null, quote: string) =>
    current != null &&
    sourceQuoteComparisonKey(current) === sourceQuoteComparisonKey(quote);

  const quoteEvidenceOf = (citation: number | null) => ({
    citationId: citation,
    unit: item.unit,
    low: item.low ?? null,
    high: item.high ?? null,
    // In stored form: a labelled `median` shorthand is written as
    // `centralValue` (canonicalizeReportedStatistic), so the row holds NULL here.
    median: doseContext.median ?? null,
    qualifier: item.qualifier ?? null,
    matrix: item.matrix ?? null,
    scenario: item.scenario ?? null,
    n: item.n ?? null,
    // Stated, not omitted. This store cannot express either — it inserts
    // drug-level numeric rows — so the observation it is matching is the one
    // with no route and no categorical value, and saying `null` is what pins
    // that. Left out, they would not be compared at all, and a direct writer
    // scoping the matched row to a route between the plan and the locked attach
    // would leave every other predicate satisfied: the admin's sentence filed
    // against an observation nobody approved it for. For a route-optional
    // parameter (`tmax`, `bioavailability`) that is an ordinary curation step,
    // not a rare one.
    route: entryRoute ?? null,
    categoricalValue: null,
    // The study context (#1257: `studyContextText`, written to
    // `observationContext`), stated rather than omitted for the same reason as
    // `route`/`categoricalValue`. It is compared before deciding to attach
    // (`observationMatches` below), so it has to be compared again under the
    // lock — otherwise the check is only as good as the gap between the two,
    // and a direct writer that changes only the context slips through every
    // other predicate unchanged. `comments` (curator commentary) is
    // deliberately absent: it is not evidence, so this snapshot must not gate
    // on it — the same reason `SOURCE_QUOTE_EVIDENCE_FIELDS` excludes it.
    observationContext: studyContextText(item, source) ?? null,
    // The dose context this item states, every field pinned — absent ones as
    // NULL, for the same reason as `route` above. For a parameter without dose
    // context that is all NULL, which is what such a row holds.
    ...NO_DOSE_CONTEXT,
    ...Object.fromEntries(
      Object.entries(doseContext).filter(
        ([key, value]) => key !== 'median' && value !== undefined && value !== null,
      ),
    ),
  });

  // A duplicate needs the citation: the same numbers from a different paper are
  // a second observation, not a repeat. Before the citation exists there is
  // nothing to duplicate, and apply re-checks once it does.
  const duplicate =
    citationId != null ? await findDuplicateEntry(entryInput(citationId)) : null;
  if (duplicate) {
    // …with one exception. The dedup identity ignores the source quote, so an
    // item that matches an existing row in every compared field may still carry
    // the sentence that row is missing — and for a row written before migration
    // 0119 this is the only route by which it can ever acquire one. Dropping it
    // as "already present" would make the duplicate check a barrier to the
    // enrichment it should permit.
    //
    // Only ever fills a gap: a row that already has a quote is a real duplicate
    // and stays one, so this can never replace one sentence with another. Both
    // rows are the same reading of the same document, so the incoming quote is
    // evidence for what is stored rather than a competing claim.
    //
    // …and only while the incoming reading describes the SAME cohort. `n` is
    // outside the dedup identity on purpose — two readings of one number from
    // one paper are one observation — but it is inside what a quote attests to,
    // and it weights the row in the pooled aggregate. A sentence saying "in 24
    // subjects" attached to a row filed as n=12 is a fabricated attribution of
    // exactly the kind this field exists to expose, and the admin card shows
    // the INCOMING sample size, so nothing on screen would reveal the mismatch.
    // Reported rather than reconciled: this branch fills a gap in an existing
    // row and never rewrites what that row already asserts.
    //
    // The STUDY CONTEXT is the same argument again, and the one with the widest
    // reach. `studyContextText` records the dose, route, formulation,
    // population and the rest — everything that makes this reading a reading
    // OF something — and none of it is in the dedup identity either. So a
    // same-paper, same-number item describing a different condition matches,
    // and only its quote would be written: a sentence about a fasted single
    // dose filed against the fed-state row. The card shows the INCOMING
    // context, so the pairing looks coherent to the admin approving it.
    //
    // Compared against `duplicate.observationContext`, never `.comments`:
    // curator commentary is not evidence (#1257), so a duplicate whose notes
    // merely read differently is still the same observation.
    const observationMatches =
      (item.n ?? null) === (duplicate.n ?? null) &&
      (studyContextText(item, source) ?? null) ===
        (duplicate.observationContext ?? null);
    const quoteWithheldForObservation =
      Boolean(item.quote) && duplicate.sourceQuote == null && !observationMatches;
    const enrichingQuote =
      item.quote && duplicate.sourceQuote == null && observationMatches
        ? item.quote
        : null;
    if (!enrichingQuote) {
      return {
        plan: {
          ...base,
          disposition: 'duplicate',
          reason: quoteWithheldForObservation
            ? 'entry_observation_mismatch'
            : 'entry_exists',
          detail: null,
          drugId: drug.id,
          current,
        },
      };
    }
    return {
      plan: {
        ...base,
        disposition: 'ready',
        reason: null,
        detail: null,
        drugId: drug.id,
        current,
      },
      execute: async () => {
        // Re-checked under the write: `attachSourceQuoteIfMissing` only writes
        // where the column is still NULL, so a quote added between planning and
        // applying is never overwritten.
        // Matched on this reading, so attach only to this reading. The plan is
        // made before the write and a direct writer can move the row's citation,
        // numbers or cohort under the drug lock in between — the id and a NULL
        // quote identify a ROW, not the observation the admin approved the
        // sentence for.
        const outcome = await attachSourceQuoteIfMissing(
          duplicate.id,
          enrichingQuote,
          quoteEvidenceOf(citationId),
        );
        if (outcome.attached) return duplicate.id;
        // Somebody filled it in between. If they wrote the same sentence, the
        // state the admin accepted is the state that exists and this is a
        // normal idempotent re-run. If they wrote a DIFFERENT one, the quote
        // the admin approved was not stored — returning the id anyway would
        // report `applied` for a write that never happened, which is a false
        // entry in the ingestion receipt about provenance. `null` reports it as
        // a no-op instead, and the differing sentences are then a disagreement
        // for a human rather than something resolved by timing.
        return alreadySaysTheSame(outcome.current, enrichingQuote)
          ? duplicate.id
          : null;
      },
    };
  }

  return {
    plan: {
      ...base,
      disposition: 'ready',
      reason: null,
      detail: null,
      drugId: drug.id,
      current,
    },
    execute: async (actor) => {
      const resolvedCitationId = sources.citationIdByKey.get(item.sourceKey);
      if (resolvedCitationId == null) return null;
      // Parse rather than trust: this is the last point before the row is
      // written, and the same schema guards the reviewed-entry path.
      const checked = parameterEntryInputSchema.safeParse(entryInput(resolvedCitationId));
      if (!checked.success) {
        throw new Error(
          checked.error.issues
            .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
            .join('; '),
        );
      }
      const finalInput = checked.data;
      // The plan's duplicate check is a fast path, not the decision: it runs
      // outside any transaction, so two concurrent applies of the same bundle
      // could both read "no duplicate" and both insert — and `parameter_entries`
      // has no unique constraint on the observation tuple to catch it, so the
      // paper would end up double-weighted in the aggregate. Decide again inside
      // the write transaction, under the drug's advisory lock. Recompute takes
      // the same lock, so this only widens the critical section to cover the
      // decision (advisory xact locks are re-entrant). Same shape as the PM/AM
      // seeder, for the same reason.
      //
      // A duplicate that appears between the plan and here is not simply a
      // no-op when this item carries a quote.
      //
      // Reachable only under genuine concurrency: `applyIngestion` re-plans
      // each item immediately before executing it, so a duplicate that exists
      // by then is caught by the planner's own enrichment branch (which is
      // tested). This covers the window after that re-plan — another request
      // writing the same observation while this one is in flight — and has no
      // deterministic test for that reason. The guarded write it delegates to
      // is tested at the store. The row that beat us to it may
      // have none — a concurrent ingestion of the same observation without one
      // — and dropping the sentence an admin reviewed would lose the one piece
      // of an entry nobody can reconstruct. Same rules as the planner's branch:
      // fill a gap, never replace, and only where the cohort matches, since a
      // sentence reporting one sample size is not evidence for another.
      const enrichLateDuplicate = async (): Promise<number | null> => {
        if (!item.quote) return null;
        const late = await findDuplicateEntry(finalInput);
        if (!late) return null;
        if (
          (item.n ?? null) !== (late.n ?? null) ||
          (studyContextText(item, source) ?? null) !==
            (late.observationContext ?? null)
        ) {
          return null;
        }
        // NOT short-circuited on `late.sourceQuote != null`.
        //
        // The attach is already guarded on the column still being NULL, so a
        // row that has a sentence makes it a no-op that reports what is there —
        // and the two answers below are then the ones that matter: the same
        // sentence means the state the admin accepted is the state that exists,
        // and a different one is a disagreement for a human. Reading "occupied"
        // as "nothing happened" gave a THIRD answer to a question that already
        // had two, and it was the wrong one: an item the admin accepted was
        // recorded as skipped/no_change over provenance sitting on the row. A
        // receipt that cannot trace accepted provenance is the one thing this
        // field exists to make traceable.
        //
        // Whether the sentence arrived a moment before this call or a moment
        // after is not a distinction anybody can act on, so it is not one this
        // code makes. One path, one rule, one extra read in a branch that only
        // runs under genuine concurrency.
        const outcome = await attachSourceQuoteIfMissing(
          late.id,
          item.quote,
          quoteEvidenceOf(resolvedCitationId),
        );
        if (outcome.attached) return late.id;
        return alreadySaysTheSame(outcome.current, item.quote) ? late.id : null;
      };
      if (await entryDuplicateExists(finalInput)) {
        return enrichLateDuplicate();
      }
      return runInPoolTransaction(async () => {
        await getDb().execute(sql`SELECT pg_advisory_xact_lock(${drug.id}::bigint)`);
        if (await entryDuplicateExists(finalInput)) {
          return enrichLateDuplicate();
        }
        const row = await insertParameterEntry(
          finalInput,
          actor.userId,
          CONVERSATION_ENTRY_ORIGIN,
        );
        const revisionId = await recomputeParameterAndDependents(
          drug.id,
          parameter,
          actor.userId,
          { approvedBy: actor.userId },
        );
        // A direct admin write produces the live revision; stamp the approval
        // so it is not shown as unapproved, exactly as the parameter-entry
        // route does for an admin.
        if (revisionId != null) {
          await recordApproval({
            targetType: 'drug_parameter_revision',
            targetId: revisionId,
            approvedBy: actor.userId,
          });
          await recordImplicitAgentApproval({
            userId: actor.userId,
            targetType: 'drug_parameter_revision',
            targetId: revisionId,
          });
        }
        return row.id;
      });
    },
  };
}

/**
 * The cited-but-unread source keys for one item, resolved per PAPER rather than
 * per bundle key.
 *
 * `unverifiedSourceKeys` reads the keys the item cites, which is the contract's
 * own view and the right one for the validator. The write path has a second
 * view the validator cannot: `planSources` has resolved which keys land on one
 * citation row, including pairs only the NCBI converter joins. Those share one
 * review — `commitSourcesFor` records the FIRST key's appraisal for all of
 * them — so routing has to ask about the paper, not the key. Otherwise an item
 * citing a verified alias publishes while the review actually stored for its
 * citation says `readInFull: false`: a live claim resting on a source the app
 * treats as unreviewed.
 *
 * Conservative by construction — any unread key in the group makes the group
 * unread — because that is the direction that matches what gets STORED, and
 * because over-queueing is answerable while over-publishing is not. It reports
 * the unread key itself, since that is the appraisal the admin will see land.
 *
 * The bundle-declared form of this contradiction is refused outright by the
 * validator (`source_verification_conflict`); what reaches here is the pair the
 * bundle had no way to know about.
 */
function unverifiedPapersFor(
  item: NormalizedConversationIngestion['items'][number],
  bundle: NormalizedConversationIngestion,
  ctx: SourceContext,
): string[] {
  const declared = unverifiedSourceKeys(item, bundle.sources);
  if (item.type !== 'wiki_fact') return declared;

  const rootOf = (key: string) => sameAsRoot(ctx.plans, key);

  const unreadByPaper = new Map<string, string>();
  for (const source of bundle.sources) {
    if (source.verification.readInFull) continue;
    const root = rootOf(source.key);
    if (!unreadByPaper.has(root)) unreadByPaper.set(root, source.key);
  }

  const keys = new Set(declared);
  for (const cited of item.sourceKeys) {
    const unread = unreadByPaper.get(rootOf(cited));
    if (unread) keys.add(unread);
  }
  return [...keys];
}

// ─── Wiki facts ──────────────────────────────────────────────────────────────

/**
 * An open `wiki_fact` proposal on this page that already says the same thing,
 * if one exists.
 *
 * The governing rule: **the queued identity mirrors the live-content identity
 * for the same operation.** A proposal is a duplicate of another exactly when
 * applying both would be applying the same edit twice, and `planWikiFactItem`
 * already decides that question against the page. Deriving the queue's answer
 * from a different set of fields is how the two drift into disagreeing about
 * what "the same edit" means. Per operation, that comes to:
 *
 *  - an `add` is identified by section AND statement, because the live check is
 *    section-local (`sectionFacts(page, sectionId)`) and compares text alone.
 *    The same sentence added to two sections of one page is two proposals;
 *  - a `replace` is identified by its anchor, statement AND citation set,
 *    because the live check requires `sameStatement && sameRefs`. Re-citing one
 *    sentence to different papers is a real edit — the item fingerprint counts
 *    `existingReferences` for the same reason — so collapsing it would discard
 *    the better provenance instead of showing the reviewer both;
 *  - a `remove` is identified by its anchor alone; it carries no statement and
 *    no citations of its own.
 *
 * Section is deliberately NOT part of a `replace`/`remove` identity: the planner
 * resolves `anchorSectionId` from the live page, so a fact that moved between
 * the queued proposal and now would otherwise read as a different proposal and
 * be queued twice. The anchor already names one fact wherever it sits.
 *
 * Matched across every submitter, not just this ingestion — a second copy of a
 * claim already waiting in the queue is noise for the reviewer whoever put the
 * first one there.
 */
async function findOpenFactProposal(
  db: Db,
  target: {
    pageId: number;
    sectionId: string;
    operation: 'add' | 'replace' | 'remove';
    statement: string | null;
    factId: string | null;
    /** Resolved citation ids this proposal would carry. */
    referenceIds: number[];
    /** False while some cited paper has no row yet — see the `replace` branch. */
    referencesKnown: boolean;
  },
): Promise<number | null> {
  const conditions = [
    eq(pendingEdits.editType, 'wiki_fact'),
    eq(pendingEdits.status, 'pending'),
    eq(pendingEdits.targetId, target.pageId),
    eq(pendingEdits.factOperation, target.operation),
  ];
  if (target.operation === 'remove') {
    if (!target.factId) return null;
    conditions.push(sql`${pendingEdits.factTargetAnchor}->>'factId' = ${target.factId}`);
  } else if (target.operation === 'replace') {
    if (target.statement == null || !target.factId) return null;
    // Citations not all minted yet: the set this would carry is not knowable,
    // so no answer here is trustworthy. Decline rather than guess — the apply
    // pass re-plans with the ids in hand, which is exactly what the live check
    // does with `refsKnown`.
    if (!target.referencesKnown) return null;
    conditions.push(eq(pendingEdits.factStatement, target.statement));
    conditions.push(sql`${pendingEdits.factTargetAnchor}->>'factId' = ${target.factId}`);
    // Set equality, order-insensitive: the stored array is in the bundle's
    // sourceKey order, which is not meaningful. A NULL `reference_ids` makes
    // both operators NULL and so fails to match, which is the safe direction —
    // an unmatched row is queued and seen, never silently dropped.
    const ids = target.referenceIds.filter((id) => Number.isInteger(id));
    const literal = sql.raw(`ARRAY[${ids.join(',')}]::int[]`);
    conditions.push(
      ids.length === 0
        ? sql`coalesce(array_length(${pendingEdits.referenceIds}, 1), 0) = 0`
        : sql`${pendingEdits.referenceIds} @> ${literal} AND ${pendingEdits.referenceIds} <@ ${literal}`,
    );
  } else {
    if (target.statement == null) return null;
    conditions.push(eq(pendingEdits.factStatement, target.statement));
    conditions.push(eq(pendingEdits.sectionId, target.sectionId));
  }
  const [row] = await db
    .select({ id: pendingEdits.id })
    .from(pendingEdits)
    .where(and(...conditions))
    .limit(1);
  return row?.id ?? null;
}

/**
 * What the live page says about a fact edit that is about to be queued.
 *
 * `already_applied` — someone has done it; queueing it again is noise.
 * `anchor_gone`     — the fact it targets is no longer there, so no reviewer
 *                     could ever approve the proposal.
 * `page_gone`       — the page it targets is no longer there. Same consequence,
 *                     different cause, and worth naming separately because the
 *                     insert would otherwise succeed: `pending_edits.target_id`
 *                     has no foreign key to `wiki_pages`.
 * `proceed`         — still a real, applicable edit.
 *
 * A verdict rather than a boolean because "not a duplicate" answers only half
 * the question, and the half it leaves out is the one that produces an
 * unapprovable row: `applyApprovedWikiFact` resolves the anchor at approval
 * time and throws when it has gone, so a replacement staged after its target
 * disappeared is dead on arrival in someone else's queue.
 *
 * Exported for tests: its wiring into the locked write is a single line, but
 * the branches are the only thing standing between an already-settled edit and
 * a proposal nobody can act on.
 *
 * This re-asks what `planWikiFactItem` already decided. The planner computes it
 * while also gathering `existingStatement`, `existingReferences` and its notes,
 * which is why this is a second reading of one rule rather than a shared call —
 * they must stay in step, and the tests pin both. It is re-asked at all because
 * both states can arrive AFTER the plan: an approval that publishes the
 * statement (leaving `pending`, so the queue check goes quiet), or a removal
 * that takes the anchor away.
 */
export type LiveFactVerdict =
  | 'proceed'
  | 'already_applied'
  | 'anchor_gone'
  | 'page_gone'
  | 'section_gone';

/**
 * The verdict plus, when it is `proceed`, where the edit actually lands NOW.
 *
 * Returning the location is the point. The planner resolved one before the
 * lock, and a fact can move between sections in between — so an insert reusing
 * the planner's value writes a row pointing at where the fact used to be, and
 * approval searches there and fails. Re-deriving the target under the lock and
 * inserting from THAT is what makes this check complete, instead of a list of
 * individual mishaps that has to be extended every time someone finds another.
 */
export type LiveFactCheck =
  | { verdict: 'proceed'; sectionId: string; fieldId?: string }
  | { verdict: Exclude<LiveFactVerdict, 'proceed'> };

export async function liveFactVerdict(
  db: Db,
  target: {
    pageId: number;
    sectionId: string;
    operation: 'add' | 'replace' | 'remove';
    statement: string | null;
    factId: string | null;
    referenceIds: number[];
    referencesKnown: boolean;
  },
): Promise<LiveFactCheck> {
  const page = await loadPage(db, target.pageId);
  // The page itself is gone. `pending_edits.target_id` carries no foreign key
  // to `wiki_pages`, so the insert would succeed and leave a proposal that
  // `applyApprovedWikiFact` refuses forever ("target page not found").
  //
  // This branch used to defer to the planner. That was the same mistake the
  // anchor case made: the planner ran before this point, and re-reading here
  // is the whole reason this function exists — anything it defers to a stale
  // decision it may as well not check.
  if (!page) return { verdict: 'page_gone' };

  if (target.operation === 'add') {
    // A monograph's sections come from a fixed schema; a topic or entity page's
    // are headings in its own content, and one can be deleted. `sectionFacts`
    // cannot tell "no such section" from "section with no facts" — both are
    // `[]` — so ask the page directly, exactly as the planner does.
    if (page.pageType === 'drug_monograph') {
      if (!isMonographSectionId(target.sectionId)) {
        return { verdict: 'section_gone' };
      }
    } else {
      const known = extractTopicSections(
        page.content as { content?: unknown[] } | null,
      ).map((s) => s.sectionId);
      if (!known.includes(target.sectionId)) return { verdict: 'section_gone' };
    }
    const incoming = (target.statement ?? '').trim();
    if (
      sectionFacts(page, target.sectionId).some(
        (node) => factNodeText(node) === incoming,
      )
    ) {
      return { verdict: 'already_applied' };
    }
    return { verdict: 'proceed', sectionId: target.sectionId };
  }

  if (!target.factId) return { verdict: 'proceed', sectionId: target.sectionId };
  const found = findFactAnywhere(page, target.factId);
  if (!found) {
    // A `remove` whose anchor is gone has already happened; a `replace` whose
    // anchor is gone has nothing left to replace.
    return {
      verdict: target.operation === 'remove' ? 'already_applied' : 'anchor_gone',
    };
  }
  // The fact's CURRENT home, which is where the staged row must point.
  const here = { sectionId: found.sectionId, fieldId: found.fieldId };
  if (target.operation === 'remove') return { verdict: 'proceed', ...here };
  // Citations not all minted yet: the set is not knowable, so this cannot be
  // called settled. The anchor check above still stands.
  if (!target.referencesKnown) return { verdict: 'proceed', ...here };
  const proposed = [...target.referenceIds].sort((a, b) => a - b);
  const stored = factReferenceIds(found.node);
  const settled =
    factNodeText(found.node) === (target.statement ?? '').trim() &&
    proposed.length === stored.length &&
    proposed.every((id, i) => id === stored[i]);
  return settled
    ? { verdict: 'already_applied' }
    : { verdict: 'proceed', ...here };
}

async function planWikiFactItem(
  db: Db,
  bundle: NormalizedConversationIngestion,
  item: IngestionWikiFactItem,
  index: number,
  sources: SourceContext,
): Promise<PlannedItemDraft> {
  // Which of this fact's papers the assistant did not read in full. Non-empty
  // means the claim was never verified to the contract's standard, so it is
  // carried across as a proposal for a human reviewer rather than published.
  const unverified = unverifiedPapersFor(item, bundle, sources);

  const base = {
    index,
    type: 'wiki_fact' as const,
    sourceKeys: item.sourceKeys,
    editSummary: item.editSummary,
    notes: [] as string[],
    sectionId: item.target.sectionId,
    operation: item.operation,
    statement: item.statement ?? null,
    unverifiedSourceKeys: unverified,
  };

  const blocked = (
    reason: string,
    detail: string | null,
    page: ResolvedPage | null = null,
  ): PlannedItemDraft => ({
    plan: {
      ...base,
      disposition: 'blocked',
      reason,
      detail,
      pageId: page?.id ?? null,
      pageTitle: page?.title ?? null,
      pageType: page?.pageType ?? null,
      existingStatement: null,
      existingReferences: [],
      sectionFactCount: 0,
    },
  });

  // ── Target page ──
  // A monograph is addressed through its drug (the model has no page ids), and
  // a drug that lost its monograph to historical drift gets one minted on
  // apply — `ensureDrugMonograph` is the same invariant repair drug creation
  // runs, not a licence to publish into a page that should not exist.
  let page: ResolvedPage | null = null;
  let monographDrug: ResolvedDrug | null = null;
  if (item.target.pageId != null) {
    page = await loadPage(db, item.target.pageId);
    if (!page) return blocked('page_not_found', `id ${item.target.pageId}`);

    // A page id is an assertion, not a fact. The bundle also says what KIND of
    // page it is and, for a monograph, whose — and a model that gets the id
    // wrong while getting the drug right would otherwise publish morphine's
    // fact onto codeine's monograph, with nothing in the gate to show it. Same
    // reasoning as the drug identity cross-check: when two identifiers are
    // supplied and disagree, neither reading is safe to write.
    const monographTarget = item.target.pageType === 'monograph';
    if (monographTarget !== (page.pageType === 'drug_monograph')) {
      return blocked(
        'page_identity_conflict',
        `${item.target.pageType} ≠ ${page.pageType}`,
        page,
      );
    }
    if (monographTarget && item.target.drug) {
      const resolvedDrug = await resolveDrugTarget(db, item.target.drug);
      if (!resolvedDrug.ok) {
        return blocked(resolvedDrug.reason, resolvedDrug.detail, page);
      }
      const owned = await resolveMonographDrugCids(db, resolvedDrug.drug);
      const [row] = await db
        .select({ drugCid: wikiPages.drugCid })
        .from(wikiPages)
        .where(eq(wikiPages.id, page.id))
        .limit(1);
      if (row?.drugCid == null || !owned.includes(row.drugCid)) {
        return blocked(
          'page_identity_conflict',
          `page ${page.id} is not ${resolvedDrugLabel(resolvedDrug.drug)}'s monograph`,
          page,
        );
      }
      monographDrug = resolvedDrug.drug;
      base.notes.push(...resolvedDrug.notes);
    }
    if (item.target.pageSlug && item.target.pageSlug !== page.slug) {
      return blocked(
        'page_identity_conflict',
        `${item.target.pageSlug} ≠ ${page.slug}`,
        page,
      );
    }
  } else if (item.target.pageType === 'monograph') {
    if (!item.target.drug) return blocked('drug_missing', null);
    const resolved = await resolveDrugTarget(db, item.target.drug);
    if (!resolved.ok) return blocked(resolved.reason, resolved.detail);
    monographDrug = resolved.drug;
    base.notes.push(...resolved.notes);
    page = await findMonographForDrug(db, resolved.drug);
  } else if (item.target.pageSlug) {
    page = await loadPageBySlug(db, item.target.pageSlug);
    if (!page) return blocked('page_not_found', item.target.pageSlug);
  } else {
    return blocked('page_unresolvable', null);
  }

  const sectionId = item.target.sectionId;

  // ── Section ──
  // Monograph sections come from the fixed schema; topic sections are minted
  // into the page's own headings, so an unknown id there means the heading the
  // conversation aimed at is not on the page.
  if (page) {
    if (page.pageType === 'drug_monograph') {
      if (!isMonographSectionId(sectionId)) {
        return blocked('section_unknown', sectionId, page);
      }
    } else if (page.pageType === 'topic' || page.pageType === 'entity_monograph') {
      if (!isValidTopicSectionId(sectionId)) {
        return blocked('section_invalid', sectionId, page);
      }
      const known = extractTopicSections(
        page.content as { content?: unknown[] } | null,
      ).map((s) => s.sectionId);
      if (!known.includes(sectionId)) {
        return blocked('section_not_found', sectionId, page);
      }
    } else {
      return blocked('page_type_unsupported', page.pageType, page);
    }
  } else if (!isMonographSectionId(sectionId)) {
    // No monograph yet: only the fixed monograph schema can be validated ahead
    // of the page existing.
    return blocked('section_unknown', sectionId);
  }

  const facts = page ? sectionFacts(page, sectionId) : [];
  const withPage = {
    ...base,
    pageId: page?.id ?? null,
    pageTitle: page?.title ?? null,
    pageType: page?.pageType ?? 'drug_monograph',
    sectionFactCount: facts.length,
    existingReferences: [] as WikiFactItemPlan['existingReferences'],
  };

  const referenceIds = item.sourceKeys
    .map((key) => sources.citationIdByKey.get(key))
    .filter((id): id is number => id != null);

  // ── Operation-specific resolution ──
  let anchorFactId: string | null = null;
  let existingStatement: string | null = null;
  // Where the fact really is. The conversation's sectionId is a hint; the live
  // page decides, and the pending edit is written against this.
  let anchorSectionId = sectionId;
  let anchorFieldId: string | undefined;
  const notes: string[] = [];

  if (item.operation === 'replace' || item.operation === 'remove') {
    if (!item.factId) return blocked('fact_anchor_missing', null, page);
    if (!page) return blocked('page_not_found', null);
    const found = findFactAnywhere(page, item.factId);
    if (!found) return blocked('fact_not_found', item.factId, page);
    if (found.sectionId !== sectionId) {
      notes.push('fact_moved_section');
    }
    anchorFactId = item.factId;
    anchorSectionId = found.sectionId;
    anchorFieldId = found.fieldId;
    existingStatement = factNodeText(found.node);
    withPage.existingReferences = await describeCitations(
      db,
      factReferenceIds(found.node),
    );
    // The row must be labelled — and fingerprinted — with the section the edit
    // will really land in. Carrying the bundle's stale id would show the admin
    // one section while writing to another, and would leave the digest blind to
    // exactly the move it exists to catch.
    withPage.sectionId = found.sectionId;

    // A replacement that has already been applied leaves its anchor in place, so
    // "the fact exists" cannot mean "still to do". Compare what is stored with
    // what is proposed: equal statement AND equal citations is the noop, and
    // without this a re-applied bundle would append an identical revision every
    // time — the idempotency this path promises.
    if (item.operation === 'replace') {
      const sameStatement = existingStatement === (item.statement ?? '').trim();
      const proposed = [...referenceIds].sort((a, b) => a - b);
      const stored = factReferenceIds(found.node);
      const sameRefs =
        proposed.length === stored.length &&
        proposed.every((id, i) => id === stored[i]);
      // Unresolved citations (`citations_pending`) mean the reference set is not
      // knowable yet, so a match on statement alone is not enough to call it
      // done — the apply pass re-plans with the ids in hand and decides then.
      const refsKnown = referenceIds.length === item.sourceKeys.length;
      if (sameStatement && refsKnown && sameRefs) {
        return {
          plan: {
            ...withPage,
            disposition: 'duplicate',
            reason: 'statement_exists',
            detail: null,
            existingStatement,
          },
        };
      }
    }
  } else {
    // `add`: an identical statement already in the section is the noop case.
    const incoming = (item.statement ?? '').trim();
    const duplicate = facts.some((node) => factNodeText(node) === incoming);
    if (duplicate) {
      return {
        plan: {
          ...withPage,
          disposition: 'duplicate',
          reason: 'statement_exists',
          detail: null,
          existingStatement: incoming,
        },
      };
    }
  }

  // A page revised since the conversation prepared this item is not a blocker —
  // the admin is reading the current state in the gate — but it is worth saying,
  // because the statement was written against older prose.
  if (item.target.observedRevisionId != null && page) {
    const [latest] = await db
      .select({ id: wikiRevisions.id })
      .from(wikiRevisions)
      .where(eq(wikiRevisions.pageId, page.id))
      .orderBy(sql`${wikiRevisions.id} desc`)
      .limit(1);
    if (latest && latest.id !== item.target.observedRevisionId) {
      notes.push('page_revised_since');
    }
  }

  const needsReferences = item.operation === 'add' || item.operation === 'replace';
  if (needsReferences && referenceIds.length === 0 && page) {
    // The citations do not exist yet (a first-time source); apply mints them
    // before the fact is staged, so this is only a planning-time gap.
    notes.push('citations_pending');
  }

  const queued = unverified.length > 0;

  // A queued fact does not land on the page, so the live-content duplicate
  // checks above cannot see a second run of the same bundle — re-pasting it
  // would stack a second identical proposal in the review queue and the
  // idempotency this path promises would hold for published facts only. The
  // open proposal IS the record for these, so that is what gets checked.
  //
  // Scoped to queued rows on purpose. A `ready` row racing an unrelated pending
  // edit is the review queue's own conflict-marking case, handled by
  // `applyApprovedEdit`, and re-routing it through here would change behaviour
  // this change has no reason to touch.
  if (queued && page) {
    const existingProposal = await findOpenFactProposal(db, {
      pageId: page.id,
      sectionId: anchorSectionId,
      operation: item.operation,
      statement: item.statement ?? null,
      factId: anchorFactId,
      referenceIds,
      referencesKnown: referenceIds.length === item.sourceKeys.length,
    });
    if (existingProposal != null) {
      return {
        plan: {
          ...withPage,
          disposition: 'duplicate',
          reason: 'already_in_review_queue',
          detail: `#${existingProposal}`,
          notes: [...base.notes, ...notes],
          existingStatement,
        },
      };
    }
  }

  return {
    plan: {
      ...withPage,
      disposition: queued ? 'review' : 'ready',
      reason: queued ? 'sources_not_read_in_full' : null,
      detail: queued ? unverified.join(', ') : null,
      notes: [...base.notes, ...notes],
      existingStatement,
    },
    execute: async (actor) => {
      const db2 = getDb();
      let targetPage = page;
      if (!targetPage && monographDrug) {
        const ensured = await ensureDrugMonograph(
          db2,
          {
            id: monographDrug.id,
            names: monographDrug.names as Record<'nb' | 'en', string>,
            pubchemCid: monographDrug.pubchemCid,
          },
          actor.userId,
        );
        targetPage = await loadPage(db2, ensured.page.id);
      }
      if (!targetPage) return null;

      const finalReferenceIds = item.sourceKeys
        .map((key) => sources.citationIdByKey.get(key))
        .filter((id): id is number => id != null);
      if (needsReferences && finalReferenceIds.length === 0) return null;

      // Which of the papers attached to this proposal nobody read, as CITATION
      // ids rather than bundle keys. `S2` means nothing once the bundle is
      // closed, and the pending edit stores its papers as numeric reference ids
      // with no key mapping — so a reviewer opening a two-source card could see
      // that something was unverified but not WHICH paper to go and read, which
      // is the one thing this queue route asks of them.
      // Through the paper root, not the key. `unverified` can name a key the
      // item does not cite — a crosswalked alias whose unread attestation is
      // what makes this claim unverified — and only the CITED key has an entry
      // in `citationIdByKey`. Looking the alias up directly yields nothing, and
      // an empty list means the review card cannot name the paper, which is the
      // whole signal.
      const idByPaper = new Map<string, number>();
      for (const [key, id] of sources.citationIdByKey) {
        idByPaper.set(sameAsRoot(sources.plans, key), id);
      }
      const unverifiedReferenceIds = [
        ...new Set(
          unverified
            .map((key) => idByPaper.get(sameAsRoot(sources.plans, key)))
            .filter((id): id is number => id != null),
        ),
      ];

      const factId = anchorFactId ?? randomUUID();
      const proposedValue =
        item.operation === 'remove'
          ? { removed: true, factId }
          : createFactNode({
              factId,
              statement: item.statement!,
              referenceIds: finalReferenceIds,
            });

      // Staged as a pending edit and — for a verified fact — approved in the
      // same breath: the splice, the revision, the HTML regeneration and the
      // conflict marking are the review queue's own code, and the row left
      // behind is the audit trail of what this ingestion wrote and who accepted
      // it.
      //
      // For an unverified fact the staging IS the outcome. The row stays
      // `pending`, so it reaches `/review` like any contributor's proposal and a
      // human does the full-text check the assistant could not. The admin's tick
      // in the gate stands for "carry this across", never for "publish this" —
      // which is why the two dispositions must not share a write.
      const values = {
        editType: 'wiki_fact',
        targetId: targetPage.id,
        proposedValue: proposedValue as never,
        proposedMeta: {
          source: CONVERSATION_INGESTION_SOURCE,
          idempotencyKey: bundle.idempotencyKey,
          editSummary: item.editSummary,
          // What a reviewer needs and cannot reconstruct: which papers back
          // this claim without anyone having read them in full. The ids are
          // what the review card resolves against the references it lists;
          // the keys ride along so the row can still be traced to the bundle
          // that produced it.
          ...(queued
            ? { unverifiedSourceKeys: unverified, unverifiedReferenceIds }
            : {}),
        } as never,
        referenceIds: finalReferenceIds.length ? finalReferenceIds : null,
        referenceId: finalReferenceIds[0] ?? null,
        status: 'pending',
        sectionId: anchorSectionId,
        fieldId: anchorFieldId ?? null,
        factStatement: item.statement ?? null,
        factOperation: item.operation,
        factTargetAnchor: anchorFactId ? ({ factId: anchorFactId } as never) : null,
        submittedBy: actor.userId,
      };

      if (queued) {
        // The plan's queue check is a fast path, not the decision: it runs
        // outside any transaction, so two concurrent applies of the same bundle
        // could both read "nothing queued" and both insert. `pending_edits` has
        // no unique constraint covering an open fact proposal — and adding one
        // would bind every other `wiki_fact` submitter to a rule that is this
        // path's, not theirs — so decide again inside the write transaction,
        // under a lock scoped to the page. Same shape, and the same reasoning,
        // as the parameter-entry branch above.
        //
        // `hashtext` over a namespaced string rather than the bare page id:
        // advisory locks share one key space, and a page id colliding with the
        // drug id the recompute locks on would serialize two unrelated writes.
        const lockKey = `wiki_fact_proposal:${targetPage.id}`;
        return runInPoolTransaction(async () => {
          const tx = getDb();
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
          // The identity this row is about to be written with, so both guards
          // test the proposal actually being inserted.
          const identity = {
            pageId: targetPage!.id,
            sectionId: anchorSectionId,
            operation: item.operation,
            statement: item.statement ?? null,
            factId: anchorFactId,
            referenceIds: finalReferenceIds,
            referencesKnown: finalReferenceIds.length === item.sourceKeys.length,
          };
          // Ask the live page as well as the queue — the plan asks both, and a
          // guard that asks one is blind to whatever changed in the other.
          // Between the plan and here, two things can land: an approval that
          // publishes the statement (the row leaves `pending`, so the queue
          // check goes quiet, and only the page shows it), or a removal that
          // takes a replacement's anchor away (leaving a proposal no reviewer
          // could ever approve, since `applyApprovedWikiFact` resolves the
          // anchor at approval time). Either way there is nothing to queue.
          //
          // This closes every approval that has COMMITTED by the time the lock
          // is held, which is the reachable form of the race. A true overlap —
          // approval committing between this read and this insert — is not
          // closed here: `applyApprovedEdit` takes no page lock, and giving it
          // one is a change to the path every editType and every reviewer goes
          // through. That gap is already documented (`docs/conversation-
          // ingestion.md`, "Concurrent approvals on one page are not
          // serialised"), it predates this route, and it belongs to the shared
          // approval path rather than here.
          const live = await liveFactVerdict(tx, identity);
          if (live.verdict !== 'proceed') return null;
          const raced = await findOpenFactProposal(tx, identity);
          if (raced != null) return null;
          const [staged] = await tx
            .insert(pendingEdits)
            // Written against the location resolved under THIS lock, not the
            // one the planner saw: a fact that moved sections in between would
            // otherwise be staged pointing at where it used to be, and
            // approval searches there and fails.
            .values({
              ...values,
              sectionId: live.sectionId,
              fieldId: live.fieldId ?? null,
            })
            .returning({ id: pendingEdits.id });
          // Left `pending` on purpose: this is the review-queue route, and the
          // id returned is the proposal's, not a revision's.
          return staged?.id ?? null;
        });
      }

      const [row] = await db2
        .insert(pendingEdits)
        .values(values)
        .returning({ id: pendingEdits.id });
      if (!row) return null;
      try {
        await applyApprovedEdit(row.id, actor.userId);
      } catch (err) {
        // The staging insert has already committed, so a failed approval would
        // otherwise leave a live `pending` proposal in the review queue —
        // content this run reported as FAILED, sitting where someone can
        // approve it later, outside the receipt the admin was shown. Retire the
        // row before surfacing the failure. Best-effort: if the cleanup itself
        // fails, the original error is still what the admin hears about.
        try {
          await db2
            .update(pendingEdits)
            .set({
              status: 'rejected',
              rejectionReason: 'other',
              rejectionComment:
                'Conversation ingestion: approval failed, staged fact withdrawn',
              reviewedBy: actor.userId,
              reviewedAt: new Date(),
            })
            .where(eq(pendingEdits.id, row.id));
        } catch {
          // Fall through to the original error.
        }
        throw err;
      }
      return row.id;
    },
  };
}

// ─── Topic page proposals ────────────────────────────────────────────────────

/**
 * The sectionId a proposed heading will actually carry.
 *
 * The contract lets a proposal declare one, and a later `wiki_fact` may anchor
 * on it — so a declared id that is well-formed and unused is honoured verbatim
 * rather than replaced by the slug of its Norwegian heading, which would leave
 * that fact resolving the page and then failing on `section_not_found`. Anything
 * malformed or colliding falls back to minting from the heading.
 */
function effectiveSectionId(
  section: { sectionId?: string; titleNb: string },
  taken: Set<string>,
): string {
  const declared = section.sectionId?.trim();
  if (declared && isValidTopicSectionId(declared) && !taken.has(declared)) {
    return declared;
  }
  // `mintUniqueSectionId` reserves room for the `-2` suffix inside the 40-char
  // cap; appending one here would mint a 42-character id that the plan shows as
  // the anchor while `ensureTopicSectionIds` publishes a differently truncated
  // one — and a later fact aiming at the previewed anchor would miss.
  return mintUniqueSectionId(section.titleNb, taken);
}

/** Sections as they would be published, each under the id it will carry. */
function planSectionIds(item: IngestionTopicPageItem) {
  const taken = new Set<string>();
  return item.sections.map((section) => {
    const sectionId = effectiveSectionId(section, taken);
    taken.add(sectionId);
    return {
      sectionId,
      titleNb: section.titleNb,
      facts: section.facts.map((fact) => ({
        statement: fact.statement,
        sourceKeys: fact.sourceKeys,
      })),
    };
  });
}

async function planTopicPageItem(
  db: Db,
  bundle: NormalizedConversationIngestion,
  item: IngestionTopicPageItem,
  index: number,
  sources: SourceContext,
): Promise<PlannedItemDraft> {
  const slug = generateSlug(item.slug || item.titleNb);
  const factCount = item.sections.reduce((n, s) => n + s.facts.length, 0);
  const base = {
    index,
    type: 'topic_page_proposal' as const,
    sourceKeys: [
      ...new Set(item.sections.flatMap((s) => s.facts.flatMap((f) => f.sourceKeys))),
    ],
    editSummary: null,
    notes: [] as string[],
    slug,
    title: item.titleNb,
    sectionCount: item.sections.length,
    factCount,
    rationale: item.rationale,
    sections: planSectionIds(item),
    parent: null as { slug: string; title: string } | null,
    categories: { matched: [] as string[], dropped: [] as string[] },
  };

  const existing = await loadPageBySlug(db, slug);
  if (existing) {
    return {
      plan: { ...base, disposition: 'blocked', reason: 'slug_taken', detail: slug },
    };
  }
  if (item.sections.length === 0 || factCount === 0) {
    return {
      plan: { ...base, disposition: 'blocked', reason: 'page_empty', detail: null },
    };
  }

  let parentId: number | null = null;
  if (item.parentSlug) {
    const parent = await loadPageBySlug(db, item.parentSlug);
    if (!parent) {
      base.notes.push('parent_not_found');
    } else {
      // The wiki tree has a depth limit, enforced in the ordinary create path.
      // This path writes the page row directly, so it has to run the same check
      // or a proposal could push the tree past `MAX_NESTING_DEPTH` — an
      // invariant no later editor can see was broken here. A parent that cannot
      // legally hold the page is not a reason to refuse the page: it is dropped
      // with a note, exactly as an unknown parent is.
      const check = await validateParentAssignment(db, null, parent.id);
      if (check.ok) {
        parentId = parent.id;
        base.parent = { slug: item.parentSlug, title: parent.title };
      } else {
        base.notes.push('parent_invalid');
      }
    }
  }

  // Categories are matched here as well as at write time so the gate can name
  // the links that would be published — and the ones silently dropped, which is
  // the half an admin would otherwise never learn about.
  if (item.categories.length > 0) {
    const rows = await db
      .select({ name: wikiCategories.name })
      .from(wikiCategories);
    const known = new Map(
      rows.map((r) => [String(r.name).toLowerCase(), String(r.name)]),
    );
    for (const name of item.categories) {
      const hit = known.get(name.toLowerCase());
      if (hit) base.categories.matched.push(hit);
      else base.categories.dropped.push(name);
    }
  }

  return {
    plan: { ...base, disposition: 'ready', reason: null, detail: null },
    execute: async (actor) => {
      // Build the page as headings + fact nodes, then let the same helper the
      // wiki create route uses mint the section anchors, so every fact on the
      // new page is immediately targetable by a later `wiki_fact` edit.
      const takenIds = new Set<string>();
      const content: unknown[] = [];
      for (const section of item.sections) {
        const headingText = section.titleNb;
        let sectionId = effectiveSectionId(section, takenIds);
        takenIds.add(sectionId);
        content.push({
          type: 'heading',
          attrs: { level: 2, sectionId },
          content: [{ type: 'text', text: headingText }],
        });
        for (const fact of section.facts) {
          const referenceIds = fact.sourceKeys
            .map((key) => sources.citationIdByKey.get(key))
            .filter((id): id is number => id != null);
          content.push(
            createFactNode({
              factId: randomUUID(),
              statement: fact.statement,
              referenceIds,
            }),
          );
        }
      }

      const doc = ensureTopicSectionIds('topic', { type: 'doc', content });
      const contentHtml = renderHtml(doc);
      const contentPlaintext = extractPlaintext(doc);

      // Page, revision, approval and categories commit together or not at all.
      // A page published without its revision cannot be repaired by re-running:
      // planning would stop at `slug_taken`, leaving a live page with no history
      // and no way for this path to finish it.
      return runInPoolTransaction(async () => {
        const db3 = getDb();
        const [page] = await db3
          .insert(wikiPages)
          .values({
            slug,
            title: item.titleNb,
            content: doc as never,
            contentHtml,
            contentPlaintext,
            pageType: 'topic',
            parentId,
            status: 'published',
            createdBy: actor.userId,
            updatedBy: actor.userId,
          })
          .returning({ id: wikiPages.id });
        if (!page) return null;

        const [revision] = await db3
          .insert(wikiRevisions)
          .values({
            pageId: page.id,
            content: doc as never,
            contentHtml,
            editSummary: `Innlesing fra samtale (${bundle.idempotencyKey})`,
            createdBy: actor.userId,
          })
          .returning({ id: wikiRevisions.id });
        if (revision) {
          await recordImplicitAgentApproval({
            userId: actor.userId,
            targetType: 'wiki_revision',
            targetId: revision.id,
          });
        }

        // Categories are matched by name, never created: a chat model inventing a
        // taxonomy entry is exactly the kind of stray content this gate exists to
        // keep out. Unmatched names are simply dropped.
        if (item.categories.length > 0) {
          const rows = await db3
            .select({ id: wikiCategories.id, name: wikiCategories.name })
            .from(wikiCategories);
          const wanted = new Set(item.categories.map((c) => c.toLowerCase()));
          const matched = rows.filter((r) => wanted.has(String(r.name).toLowerCase()));
          if (matched.length > 0) {
            await db3
              .insert(wikiPageCategories)
              .values(matched.map((c) => ({ pageId: page.id, categoryId: c.id })));
          }
        }

        return page.id;
      });
    },
  };
}

// ─── Plan + apply ────────────────────────────────────────────────────────────

async function planItem(
  db: Db,
  bundle: NormalizedConversationIngestion,
  index: number,
  sources: SourceContext,
): Promise<PlannedItem> {
  const item = bundle.items[index]!;
  const draft =
    item.type === 'parameter_observation'
      ? await planParameterItem(db, bundle, item, index, sources)
      : item.type === 'wiki_fact'
        ? await planWikiFactItem(db, bundle, item, index, sources)
        : await planTopicPageItem(db, bundle, item, index, sources);
  return {
    ...draft,
    plan: {
      ...draft.plan,
      fingerprint: fingerprintOf(draft.plan),
    } as ItemPlan,
  };
}

async function planItems(
  db: Db,
  bundle: NormalizedConversationIngestion,
  sources: SourceContext,
): Promise<PlannedItem[]> {
  const planned: PlannedItem[] = [];
  for (let index = 0; index < bundle.items.length; index += 1) {
    planned.push(await planItem(db, bundle, index, sources));
  }
  return planned;
}

/**
 * The material identity of a resolved item, as stable text.
 *
 * Computed from the finished plan so the digest the gate showed and the digest
 * apply checks come from one function — a second derivation is what drifts.
 */
function fingerprintOf(plan: ItemPlanDraft): string {
  if (plan.type === 'parameter_observation') {
    return JSON.stringify([
      'parameter_observation',
      plan.drugId,
      plan.parameter,
      plan.disposition,
    ]);
  }
  if (plan.type === 'wiki_fact') {
    return JSON.stringify([
      'wiki_fact',
      plan.pageId,
      plan.sectionId,
      plan.operation,
      // The text a replace/remove would displace. If someone rewrote the fact
      // since the gate rendered it, this ingestion would be overwriting prose
      // the admin never read.
      plan.existingStatement,
      plan.existingReferences.map((c) => c.id),
      plan.disposition,
    ]);
  }
  return JSON.stringify([
    'topic_page_proposal',
    plan.slug,
    plan.parent?.slug ?? null,
    plan.categories.matched,
    plan.sections.map((section) => section.sectionId),
    plan.disposition,
  ]);
}

function countDispositions(items: ItemPlan[]) {
  return {
    ready: items.filter((i) => i.disposition === 'ready').length,
    review: items.filter((i) => i.disposition === 'review').length,
    duplicate: items.filter((i) => i.disposition === 'duplicate').length,
    blocked: items.filter((i) => i.disposition === 'blocked').length,
  };
}

/**
 * Resolve the bundle against the live database and report, item by item, what
 * applying it would do. Writes nothing.
 */
/**
 * Why the admin agent-focus config refuses this ingestion item, or `null`.
 *
 * Conversation ingestion is a third door into wiki content — it inserts
 * `wiki_pages` and `wiki_revisions` directly and files `pending_edits` — and
 * `admin.conversationIngestion.run` carries `floorTier: 'editor'` like the
 * whole-page capabilities. So an admin who delegated it, running an
 * editor-tier agent identity, would publish monograph prose here while the
 * focus config says the agents write no wiki content at all. Humans are
 * unaffected, as everywhere else: narrowing the agents is not narrowing the
 * people. Parameter items are never touched — the focus closes the wiki
 * action, not the parameter one.
 *
 * An item whose destination page already exists is judged exactly as any other
 * write to that page. The two create-shaped cases — a monograph minted on
 * apply for a drug that lost one, and a whole topic-page proposal — carry no
 * page id, and the plan does not carry the drug, so they are judged as a
 * create with no drug: allowed under `mode = "all"` with the switch off, and
 * refused under any narrowing. That is the conservative reading of an
 * ambiguity rather than an exact one, and it is visible: the item comes back
 * skipped with this message as its detail, not silently dropped.
 */
async function ingestionFocusRefusal(
  isAgent: boolean,
  plan: ItemPlan,
): Promise<string | null> {
  if (!isAgent || plan.type === 'parameter_observation') return null;
  if (plan.type === 'wiki_fact' && plan.pageId != null) {
    return await wikiContentFocusRefusal(plan.pageId);
  }
  return await wikiTargetFocusRefusal({
    pageId: null,
    pageType:
      plan.type === 'wiki_fact'
        ? (plan.pageType ?? 'drug_monograph')
        : 'topic',
    drugId: null,
  });
}

export async function planIngestion(
  bundle: NormalizedConversationIngestion,
  opts: { crosswalk?: CitationCrosswalk } = {},
): Promise<IngestionPlan> {
  const db = getDb();
  const sources = await planSources(db, bundle, opts.crosswalk ?? new Map());
  const planned = await planItems(db, bundle, sources);
  const items = planned.map((p) => p.plan);
  return {
    idempotencyKey: bundle.idempotencyKey,
    mode: bundle.mode,
    createdAt: bundle.createdAt,
    sources: sources.plans,
    items,
    blockedCandidates: bundle.blockedCandidates,
    counts: countDispositions(items),
  };
}

/**
 * Apply the items the admin accepted.
 *
 * `accept` carries item indices from the plan the admin was shown. Every one of
 * them is re-planned here against current state and only executed if it is
 * still executable — a duplicate that landed in the meantime, a page that moved,
 * or an item the client tried to promote is skipped with its reason, not
 * written. The re-plan also decides WHICH write each item gets: an unverified
 * fact is staged in the review queue, and no request can turn it into a publish.
 */
export async function applyIngestion(
  bundle: NormalizedConversationIngestion,
  opts: IngestionActor & {
    accept: number[];
    crosswalk?: CitationCrosswalk;
    expectedReviewActions?: ExpectedReviewActions;
    expectedFingerprints?: ExpectedItemFingerprints;
  },
): Promise<IngestionApplyResult> {
  const db = getDb();
  const accepted = new Set(opts.accept);
  const actor: IngestionActor = { userId: opts.userId };
  // Resolved once: the answer cannot change mid-run, and asking per item would
  // put a join in front of every row for a question about the caller.
  const actorIsAgent = await isActiveAgentUser(opts.userId);
  const crosswalk = opts.crosswalk ?? new Map();

  // Starts as a read-only view of which papers are already on file; each item
  // that survives its own re-plan adds its citations to it as they are written.
  const sources = await planSources(db, bundle, crosswalk);

  // Sources whose review disposition moved from `keep` to `record` since the
  // gate was rendered. Items citing one of them are not applied: the admin
  // agreed to leave an existing review alone, not to publish this appraisal.
  const expected = opts.expectedReviewActions;
  const changedSources = new Set<string>();
  if (expected) {
    // Follow `sameAs` to the key that owns a paper's appraisal. A withdrawal is
    // a fact about the PAPER, and only the owning key's action reflects it —
    // the aliases read `keep` because an owner exists, not because a review
    // does. Marking the owner alone would leave an item citing an alias free to
    // publish the owner's appraisal under an acceptance that predates the
    // withdrawal, which is the hole the guard exists to close.
    const rootOf = (key: string) => sameAsRoot(sources.plans, key);
    const changedRoots = new Set<string>();
    for (const plan of sources.plans) {
      if (expected.get(plan.key) === 'keep' && plan.reviewAction === 'record') {
        changedRoots.add(rootOf(plan.key));
      }
    }
    for (const plan of sources.plans) {
      if (changedRoots.has(rootOf(plan.key))) changedSources.add(plan.key);
    }
  }

  const items: AppliedItem[] = [];
  for (let index = 0; index < bundle.items.length; index += 1) {
    if (!accepted.has(index)) {
      items.push({
        index,
        status: 'skipped',
        reason: 'not_accepted',
        detail: null,
        createdId: null,
      });
      continue;
    }

    // Three steps per item, in this order, and the order is the point.
    //
    // 1. Plan it against current state. Earlier items in this same apply have
    //    already changed that state — two accepted facts carrying the same
    //    statement must not both go in — and this is also where a tampered
    //    `accept` is refused, since the disposition that authorises the write is
    //    computed here rather than sent by the client.
    // 2. Only then write its sources. A paper review published in the admin's
    //    name is an editorial act (`read_in_full` decides what that paper may
    //    back anywhere in Kinetix), so an item that is blocked or already
    //    present must not leave one behind.
    // 3. Plan once more, now with this item's citation ids in hand — some
    //    dispositions (an entry duplicate is keyed on the citation) are not
    //    knowable until they exist.
    //
    // All three sit inside one error boundary. A citation or review write that
    // throws is this item's failure, not the run's: items already committed
    // stay committed, the rest are still attempted, and the admin gets a
    // per-item receipt instead of an error page that says nothing about what
    // landed.
    const staleSource = [...sourceKeysOf(bundle.items[index]!)].find((key) =>
      changedSources.has(key),
    );
    if (staleSource) {
      items.push({
        index,
        status: 'skipped',
        reason: 'source_review_changed',
        detail: staleSource,
        createdId: null,
      });
      continue;
    }

    try {
      const first = await planItem(db, bundle, index, sources);
      if (!EXECUTABLE_DISPOSITIONS.has(first.plan.disposition) || !first.execute) {
        items.push({
          index,
          status: 'skipped',
          reason: first.plan.reason ?? first.plan.disposition,
          detail: first.plan.detail,
          createdId: null,
        });
        continue;
      }

      // Digest check FIRST, before a single source is written. Checking it only
      // after the source commit would mean an item refused as `item_changed`
      // had already minted a citation and published its appraisal in the
      // admin's name — a review authorising a paper globally, left behind by a
      // row that was never applied.
      // Admin agent-focus gate, in the same place and for the same reason as
      // the digest check below: before a single source is written, so an item
      // the focus refuses leaves no citation and no paper appraisal published
      // in the actor's name behind it.
      const focusRefusal = await ingestionFocusRefusal(actorIsAgent, first.plan);
      if (focusRefusal) {
        items.push({
          index,
          status: 'skipped',
          reason: 'agent_focus_out_of_scope',
          detail: focusRefusal,
          createdId: null,
        });
        continue;
      }

      const expectedFingerprint = opts.expectedFingerprints?.get(index);
      if (
        expectedFingerprint !== undefined &&
        expectedFingerprint !== first.plan.fingerprint
      ) {
        items.push({
          index,
          status: 'skipped',
          reason: 'item_changed',
          detail: null,
          createdId: null,
        });
        continue;
      }

      await commitSourcesFor(
        bundle,
        sourceKeysOf(bundle.items[index]!),
        actor,
        sources,
        crosswalk,
      );

      const { plan, execute } = await planItem(db, bundle, index, sources);
      if (!EXECUTABLE_DISPOSITIONS.has(plan.disposition) || !execute) {
        items.push({
          index,
          status: 'skipped',
          reason: plan.reason ?? plan.disposition,
          detail: plan.detail,
          createdId: null,
        });
        continue;
      }

      // And again with the citations in hand: the row is still applicable, but
      // is it still the row the admin read? A changed digest means the target
      // or the text this would displace moved under them, so the acceptance no
      // longer covers what would happen.
      if (expectedFingerprint !== undefined && expectedFingerprint !== plan.fingerprint) {
        items.push({
          index,
          status: 'skipped',
          reason: 'item_changed',
          detail: null,
          createdId: null,
        });
        continue;
      }

      const createdId = await execute(actor);
      // The plan that authorised the write is also what its receipt reports:
      // a `review` row produced a proposal, not live content, and calling that
      // `applied` would tell the admin a fact is published when it is waiting
      // for a reviewer.
      items.push({
        index,
        status:
          createdId == null
            ? 'skipped'
            : plan.disposition === 'review'
              ? 'queued'
              : 'applied',
        reason: createdId == null ? 'no_change' : null,
        detail: null,
        createdId,
      });
    } catch (err) {
      items.push({
        index,
        status: 'failed',
        reason: 'write_failed',
        detail: err instanceof Error ? err.message : String(err),
        createdId: null,
      });
    }
  }

  return {
    citationsCreated: sources.citationsCreated,
    reviewsRecorded: sources.reviewsRecorded,
    items,
    counts: {
      applied: items.filter((i) => i.status === 'applied').length,
      queued: items.filter((i) => i.status === 'queued').length,
      skipped: items.filter((i) => i.status === 'skipped').length,
      failed: items.filter((i) => i.status === 'failed').length,
    },
  };
}
