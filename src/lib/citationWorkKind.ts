/**
 * What kind of object a citation identifies — as opposed to which identifier it
 * is keyed by (§13.3).
 *
 * `citations.type` records the *handle*: `pmid`, `doi`, `url`, `freetext`,
 * ranked by durability in `CITATION_HANDLE_PREFERENCE`. It says nothing about
 * what sits behind the handle. Datasets carry DOIs — that is the normal way to
 * publish one — so a rule written against the handle admits, one level up, the
 * unpublished-dataset route the owner's 2026-08-12 decision refuses. The
 * classification has to be about the object, and the providers are the only
 * ones who know: Crossref carries `work.type`, PubMed carries `pubtype`.
 *
 * This module is the pure half — the canonical vocabulary, the two provider
 * mappings, and the rules for combining and expiring a verdict. Fetching and
 * storing live in `api/_lib/citation-work-kind.ts`.
 *
 * **Providers do not speak one vocabulary, so nothing compares raw strings.**
 * Crossref returns one type (`journal-article`); PubMed returns an array that
 * mixes the object's kind with the study's design (`Journal Article`,
 * `Randomized Controlled Trial`). Compared as they arrive, an ordinary article
 * known under both handles disagrees with itself, and every cohort resting on
 * it is refused — the gate failing closed on precisely the sources it exists to
 * admit. Each vocabulary therefore maps into a canonical kind first, study
 * design is dropped as a different axis entirely, and only canonical values are
 * stored, compared or persisted.
 */

import {
  normalizeAltIds,
  normalizeHandleIdentifier,
  resolverHandleFromUrl,
  type CitationAltIds,
} from './citationHandles.js';
import type { PublishedWorkKind } from './pattern/publishedWorks.js';

/**
 * The canonical kinds, settled against the two live vocabularies rather than
 * invented: every Crossref `work.type` and every PubMed `pubtype` that names an
 * *object* lands on one of these.
 *
 * `other` is the deliberate catch-all for a resolved answer that is not a work
 * we have a kind for — a container (a whole journal, a proceedings volume), a
 * grant, or a type a provider adds after this list was written. It is an
 * answer, not a gap: `unresolved` means nobody has asked, and conflating the
 * two would send every unmapped type back to the provider on every read.
 */
export const CITATION_WORK_KINDS = [
  'journal_article',
  'conference_paper',
  'book',
  'book_chapter',
  'preprint',
  'dissertation',
  'report',
  'dataset',
  'database',
  'peer_review',
  'component',
  'other',
] as const;

export type CitationWorkKind = (typeof CITATION_WORK_KINDS)[number];

export function isCitationWorkKind(value: unknown): value is CitationWorkKind {
  return (
    typeof value === 'string' &&
    (CITATION_WORK_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Where a classification stands. Three states, because two cannot express the
 * case that matters most.
 *
 * - `unresolved` — nobody has asked yet. Every row predating the column starts
 *   here, and so does a row whose handle set has since grown.
 * - `resolved` — every handle that answered agreed.
 * - `conflicted` — two registries disagree about what the object *is*. That is
 *   a curation question, not something a retry settles, so it is a state of its
 *   own rather than a failed resolution: a retry would just reproduce it, and
 *   clearing it to `unresolved` would route back into a re-resolve that can
 *   land on the more permissive verdict.
 */
export const CITATION_WORK_KIND_STATUSES = [
  'unresolved',
  'resolved',
  'conflicted',
] as const;

export type CitationWorkKindStatus =
  (typeof CITATION_WORK_KIND_STATUSES)[number];

export function isCitationWorkKindStatus(
  value: unknown,
): value is CitationWorkKindStatus {
  return (
    typeof value === 'string' &&
    (CITATION_WORK_KIND_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Crossref `work.type` → canonical kind.
 *
 * Containers map to `other` on purpose. A DOI for a whole journal, a
 * proceedings volume or a book series identifies the shelf, not the work on
 * it, so it is not a publication this catalog can cite — and calling it one
 * would let a cohort hang off a container whose contents nobody named.
 *
 * `posted-content` is Crossref's type for preprints; it also carries a
 * `subtype` (`preprint`, `letter`, `other`) which this mapping deliberately
 * does not read, because the distinction that matters downstream — peer
 * reviewed or not — is the same for every subtype.
 */
export const CROSSREF_WORK_TYPE_KINDS: Readonly<
  Record<string, CitationWorkKind>
> = {
  'journal-article': 'journal_article',
  'proceedings-article': 'conference_paper',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  'reference-book': 'book',
  'book-chapter': 'book_chapter',
  'book-section': 'book_chapter',
  'book-part': 'book_chapter',
  'book-track': 'book_chapter',
  'reference-entry': 'book_chapter',
  'posted-content': 'preprint',
  dissertation: 'dissertation',
  report: 'report',
  'report-series': 'report',
  standard: 'report',
  'standard-series': 'report',
  dataset: 'dataset',
  database: 'database',
  'peer-review': 'peer_review',
  component: 'component',
  journal: 'other',
  'journal-issue': 'other',
  'journal-volume': 'other',
  proceedings: 'other',
  'book-series': 'other',
  'book-set': 'other',
  grant: 'other',
  other: 'other',
};

/**
 * PubMed `pubtype` entry → canonical kind, for the entries that name an object.
 *
 * Only object kinds appear here. Everything else PubMed puts in the same array
 * — `Review`, `Randomized Controlled Trial`, `Case Reports`, `English
 * Abstract`, `Research Support, Non-U.S. Gov't` — describes the study or the
 * indexing, not the thing published, and an axis that is not the object's kind
 * cannot answer a question about the object's kind. Those entries are ignored
 * rather than listed: an unrecognised term and a design term are handled the
 * same way, so a term NLM adds tomorrow behaves like the design terms it sits
 * beside instead of becoming a wrong verdict.
 *
 * `Letter`, `Editorial` and `Comment` are journal articles here, and that is
 * not a shortcut. A large share of the forensic case reports this atlas is
 * built from were published as letters to the editor; refusing them would
 * throw away the literature the gate exists to admit, and none of them is the
 * unpublished object the decision refuses.
 */
export const PUBMED_PUBLICATION_TYPE_KINDS: Readonly<
  Record<string, CitationWorkKind>
> = {
  'journal article': 'journal_article',
  'introductory journal article': 'journal_article',
  letter: 'journal_article',
  editorial: 'journal_article',
  comment: 'journal_article',
  news: 'journal_article',
  'published erratum': 'journal_article',
  'retraction of publication': 'journal_article',
  'retracted publication': 'journal_article',
  'clinical conference': 'conference_paper',
  book: 'book',
  'books and documents': 'book',
  'book chapter': 'book_chapter',
  preprint: 'preprint',
  'academic dissertation': 'dissertation',
  'technical report': 'report',
  dataset: 'dataset',
};

/**
 * DataCite `types.resourceTypeGeneral` → canonical kind.
 *
 * The third vocabulary is here because of where datasets are registered:
 * Crossref answers `404` for most of them, so a gate that asked only Crossref
 * would return "unknown" for the exact object it exists to refuse.
 *
 * `Text` is DataCite's catch-all for textual works — reports, theses, working
 * papers, anything a depositor did not type more finely — and it maps to
 * `other` rather than to a publication kind. That is deliberately conservative:
 * the value does not say what the object is, and reading it as a publication
 * would admit an unreviewed deposit on the strength of a field that never
 * claimed as much.
 */
export const DATACITE_RESOURCE_TYPE_KINDS: Readonly<
  Record<string, CitationWorkKind>
> = {
  journalarticle: 'journal_article',
  datapaper: 'journal_article',
  conferencepaper: 'conference_paper',
  book: 'book',
  bookchapter: 'book_chapter',
  preprint: 'preprint',
  dissertation: 'dissertation',
  report: 'report',
  standard: 'report',
  outputmanagementplan: 'report',
  dataset: 'dataset',
  peerreview: 'peer_review',
};

/** The canonical kind DataCite's answer means; unmapped values are `other`. */
export function workKindFromDataCiteType(
  resourceTypeGeneral: string | null | undefined,
): CitationWorkKind | null {
  if (typeof resourceTypeGeneral !== 'string') return null;
  const key = resourceTypeGeneral.trim().toLowerCase();
  if (!key) return null;
  return DATACITE_RESOURCE_TYPE_KINDS[key] ?? 'other';
}

/** The canonical kind Crossref's answer means, or null for no answer at all. */
export function workKindFromCrossrefType(
  type: string | null | undefined,
): CitationWorkKind | null {
  if (typeof type !== 'string') return null;
  const key = type.trim().toLowerCase();
  if (!key) return null;
  // An unmapped type is still an answer — Crossref told us what this is, we
  // simply have no finer kind for it — so it lands on `other` rather than
  // leaving the row looking unasked.
  return CROSSREF_WORK_TYPE_KINDS[key] ?? 'other';
}

/**
 * The canonical kind PubMed's `pubtype` array means, or null when the array
 * names no object kind.
 *
 * Null rather than `other` here, and the asymmetry with Crossref is the point:
 * Crossref answers with exactly one type, so an unmapped value is a kind we do
 * not model. PubMed answers with a mixed list, so a list carrying only design
 * terms means the object's kind was never stated — a gap, not an answer.
 *
 * A list naming two object kinds is a conflict inside one provider (a chapter
 * indexed as both `Book` and `Book Chapter` is the ordinary case, and the more
 * specific one is right). They are ranked rather than compared: the most
 * specific object kind present wins, and only kinds that disagree about what
 * the object is — never about how specific the description is — reach the
 * conflict path.
 */
export function workKindFromPubMedTypes(
  types: readonly string[] | null | undefined,
): CitationWorkKind | null {
  if (!Array.isArray(types)) return null;
  const found: CitationWorkKind[] = [];
  for (const entry of types) {
    if (typeof entry !== 'string') continue;
    const kind = PUBMED_PUBLICATION_TYPE_KINDS[entry.trim().toLowerCase()];
    if (kind && !found.includes(kind)) found.push(kind);
  }
  if (found.length === 0) return null;
  if (found.length === 1) return found[0]!;
  // Specific before general: `Book Chapter` beside `Book` describes one object
  // at two grains, and taking the coarser one would file a chapter as a book.
  const specificity: CitationWorkKind[] = ['book_chapter', 'book'];
  for (const kind of specificity) {
    if (found.includes(kind)) return kind;
  }
  return found[0]!;
}

/** One handle's verdict, kept so a conflict can name which registry said what. */
export interface CitationWorkKindVerdict {
  /** The handle asked, as `type:identifier` — `pmid:12345678`. */
  handle: string;
  kind: CitationWorkKind;
}

export interface CitationWorkKindClassification {
  status: CitationWorkKindStatus;
  /** The agreed kind; null while unresolved, and null while conflicted. */
  kind: CitationWorkKind | null;
  /** Every verdict collected, including the disagreeing ones. */
  verdicts: CitationWorkKindVerdict[];
}

/**
 * Combine the verdicts collected from a row's handles.
 *
 * A handle that answered nothing contributes nothing — it is not evidence of
 * agreement and not evidence of conflict. Silence from every handle leaves the
 * row unresolved, which is what "a DOI whose kind cannot be resolved is
 * refused, not assumed" needs: refusal happens after asking, never instead of
 * asking.
 */
export function classifyFromVerdicts(
  verdicts: readonly CitationWorkKindVerdict[],
): CitationWorkKindClassification {
  const collected = verdicts.filter((verdict) => isCitationWorkKind(verdict.kind));
  if (collected.length === 0) {
    return { status: 'unresolved', kind: null, verdicts: [] };
  }
  const distinct = new Set(collected.map((verdict) => verdict.kind));
  if (distinct.size > 1) {
    return { status: 'conflicted', kind: null, verdicts: [...collected] };
  }
  return {
    status: 'resolved',
    kind: collected[0]!.kind,
    verdicts: [...collected],
  };
}

/**
 * Is a stored classification still a claim about this row?
 *
 * The claim a resolution makes is "every handle this citation carried was
 * asked". It stays true exactly while the row's current handles are all
 * handles that were examined — so the test is a subset, and its direction is
 * the whole design:
 *
 * - **A handle appears** — through a merge, a promotion, or an `altIds`
 *   expansion — and the claim is false: a PMID row classified as an article
 *   can quietly acquire a DOI that resolves to a dataset, and nothing about
 *   the earlier answer covers the new handle. The verdict expires and is
 *   re-earned by asking again.
 * - **A handle disappears** and the claim is still true: we asked *more* than
 *   the row now carries. This is the asymmetry §13.3 requires, and it is what
 *   makes a `conflicted` verdict sticky across a shrink. `PATCH
 *   /api/references` can drop a DOI from `altIds`; were removal to expire the
 *   verdict, that patch would re-open the question, a re-resolve would consult
 *   only the surviving PMID, hear "journal article", and admit the cohort —
 *   the evidence against it deleted by deleting the handle that produced it.
 *   Adding a handle re-opens the question; removing one does not answer it.
 *
 * Nothing caches this answer, deliberately: it is computed from the row's own
 * handles every time it is read, the shape migration 0102's completeness
 * markers use. There is no cached flag to fall behind, no trigger for a future
 * writer to bypass, and no way for a `PATCH` that never heard of this column to
 * leave a stale verdict looking current.
 */
export function classificationCoversHandles(
  examined: readonly string[] | null | undefined,
  current: readonly string[],
): boolean {
  if (!examined) return false;
  const asked = new Set(examined);
  return current.every((handle) => asked.has(handle));
}

/**
 * The handles a classification asks, for one citation row.
 *
 * Two providers can answer this question — Crossref through a DOI, PubMed
 * through a PMID — so those are the handles the set contains, wherever they sit
 * on the row: in its own columns, in `metadata.altIds`, or behind a resolver
 * URL, since `https://doi.org/10.1234/x` is a DOI wearing a coat and a row
 * keyed by that URL is otherwise unclassifiable.
 *
 * **A handle nobody asks is not in the set.** A raw `url`, a `freetext` string
 * and a PMC id are all left out, and the reason is that this same set is
 * compared against the examined one to decide whether a verdict still stands
 * (see {@link classificationCoversHandles}): a handle counted here but never
 * asked would leave every row permanently short of its own set, re-resolving on
 * every read and never becoming current. Nothing is lost by the omission — a
 * PMC id names the same article its PMID does, and a URL that is not a resolver
 * identifies no object any registry knows.
 */
export function classificationHandles(row: {
  type: string;
  identifier: string;
  altIds?: CitationAltIds | null;
}): string[] {
  const found = new Set<string>();

  const add = (type: string, identifier: string) => {
    if (type !== 'pmid' && type !== 'doi') return;
    const normalized = normalizeHandleIdentifier(type, identifier);
    if (normalized) found.add(`${type}:${normalized}`);
  };

  const fromUrl = (value: string) => {
    const resolved = resolverHandleFromUrl(value);
    if (resolved) add(resolved.type, resolved.identifier);
  };

  add(row.type, row.identifier);
  if (row.type === 'url') fromUrl(row.identifier);

  const altIds = normalizeAltIds(row.altIds);
  if (altIds.pmid) add('pmid', altIds.pmid);
  if (altIds.doi) add('doi', altIds.doi);
  if (altIds.url) fromUrl(altIds.url);

  return [...found].sort();
}

/** A stored classification, as the columns hold it. */
export interface StoredWorkKindClassification {
  handles: string[] | null;
  verdicts: CitationWorkKindVerdict[] | null;
}

/**
 * Fold two rows' classifications together when a merge folds the rows.
 *
 * Without this the answer is lost exactly when it is most expensive to have:
 * `mergeCitations` deletes the loser, so a resolved DOI row folded into a
 * stronger PMID row whose kind was never asked leaves the merged citation
 * unclassified — and the re-resolve that follows would ask the *winner's*
 * handles, hear "journal article" from PubMed, and admit a cohort whose DOI
 * Crossref had already called a dataset.
 *
 * Both sides' evidence is kept, so a disagreement between the two rows surfaces
 * as `conflicted` rather than as whichever row happened to survive. The
 * examined set is the union, which is also what keeps the merged claim current:
 * the winner's handle set grows by exactly the loser's handles, and those are
 * the handles the loser's resolution examined.
 *
 * Two verdicts for one handle can only come from two resolutions at different
 * times — the same registry asked twice — so the survivor's is kept rather than
 * treated as a disagreement between registries, which is what `conflicted`
 * means.
 */
export function mergeStoredClassifications(
  winner: StoredWorkKindClassification,
  loser: StoredWorkKindClassification,
): CitationWorkKindClassification & { handles: string[] } {
  const byHandle = new Map<string, CitationWorkKindVerdict>();
  for (const verdict of loser.verdicts ?? []) {
    if (isCitationWorkKind(verdict?.kind) && typeof verdict.handle === 'string') {
      byHandle.set(verdict.handle, verdict);
    }
  }
  for (const verdict of winner.verdicts ?? []) {
    if (isCitationWorkKind(verdict?.kind) && typeof verdict.handle === 'string') {
      byHandle.set(verdict.handle, verdict);
    }
  }
  const handles = [
    ...new Set([...(winner.handles ?? []), ...(loser.handles ?? [])]),
  ].sort();
  const classified = classifyFromVerdicts([...byHandle.values()]);
  return {
    ...classified,
    // A classification with no verdicts is unresolved, and an unresolved row
    // stores no examined set: the columns are only meaningful together.
    handles: classified.status === 'unresolved' ? [] : handles,
  };
}

/**
 * The kinds a reference cohort may rest on (§13.3, §34.4).
 *
 * **This is not a fresh policy.** `src/lib/pattern/publishedWorks.ts` already
 * answers the owner's published-sources decision for the registries, and its
 * own header says the citations store replaces that table without the shape of
 * the question changing. So the rule this list has to satisfy is a relation,
 * not a taste: a kind whose counterpart there is *outside* `PUBLISHED_KINDS`
 * must not be admissible here, or a source that fails the registries' gate
 * would start backing inferential reference data through a different door.
 * `PUBLISHED_WORK_COUNTERPART` below states the correspondence, and a test
 * enforces the relation rather than trusting this comment.
 *
 * Being *stricter* than the standing policy is allowed, and this list is,
 * deliberately, in one place: `report` covers Crossref's `report`, `standard`
 * and their series, which is both an ENFSI-style guideline — published, and
 * admissible there as `official_guideline` — and the write-up an institution
 * would give its own casework, which is materially the route the 2026-08-12
 * decision declined. One canonical kind cannot separate them, so it is refused
 * until something can.
 *
 * The other three refusals follow the standing policy directly: a `preprint` is
 * published but unreviewed, a `dissertation` is its `thesis`, and a
 * `conference_paper` is the nearest thing it has to `conference_abstract`.
 * Each becomes admissible by adding one entry here and one in migration 0108,
 * which is where the SQL guard reads the same list — and, for the three that
 * mirror the standing policy, by changing that policy too.
 */
export const CITATION_ADMISSIBLE_WORK_KINDS: readonly CitationWorkKind[] = [
  'journal_article',
  'book',
  'book_chapter',
];

export function isAdmissibleCitationWorkKind(
  kind: CitationWorkKind | null | undefined,
): boolean {
  return !!kind && CITATION_ADMISSIBLE_WORK_KINDS.includes(kind);
}

/**
 * What each canonical kind is, in the vocabulary the registries' gate uses.
 *
 * Only the faithful correspondences are listed. `conference_paper` has none —
 * a proceedings paper is not a `conference_abstract`, and pretending otherwise
 * would smuggle a judgement into a mapping — so it is absent here and refused
 * above on its own account. A kind missing from this map is simply one the
 * standing policy has no opinion about.
 */
export const PUBLISHED_WORK_COUNTERPART: Readonly<
  Partial<Record<CitationWorkKind, PublishedWorkKind>>
> = {
  journal_article: 'journal_article',
  book: 'book',
  book_chapter: 'book',
  preprint: 'preprint',
  dissertation: 'thesis',
  report: 'official_guideline',
};
