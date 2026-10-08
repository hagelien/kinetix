/**
 * One paper, one citation row (#1018).
 *
 * `citations` is unique on `(type, identifier)` and every write path took the
 * declared `citationType` at face value, so the same paper declared as `doi` in
 * one seed and as `pmid` in another produced two rows. That is not merely a
 * duplicate: `paper_reviews` is unique on `citation_id`, so the two rows carry
 * two independent reviews — and since `read_in_full` is what lets a reference
 * back a fact or a parameter, the same source came out simultaneously
 * admissible and inadmissible depending on which handle a seed happened to
 * declare.
 *
 * This module is the pure half of the fix: which handle wins, how an identifier
 * is normalized before it is compared, and how the losing handles are kept
 * (in `metadata.altIds`) so they stay searchable and so a later write arriving
 * under the other handle finds the same row. The DB half lives in
 * `api/_lib/citation-store.ts` (resolve-or-create) and
 * `api/_lib/citation-merge.ts` (fold an already-split pair back together).
 */

/**
 * Handle strength, strongest first. A PMID is a stable, resolvable identity
 * with metadata behind it; a DOI is stable but resolves to a publisher record;
 * a URL rots; free text identifies nothing. Ties are impossible — a citation
 * carries exactly one type.
 */
export const CITATION_HANDLE_PREFERENCE = [
  'pmid',
  'doi',
  'url',
  'freetext',
] as const;

export type CitationHandleType = (typeof CITATION_HANDLE_PREFERENCE)[number];

export interface CitationHandle {
  type: CitationHandleType;
  identifier: string;
}

/**
 * The handles a citation is NOT filed under. Kept on `metadata.altIds` so the
 * crosswalk survives in the row itself: the reference search indexes them, and
 * a write arriving under one of them resolves to this row instead of minting a
 * second one. `pmcid` is carried when the resolver knows it — it is never a
 * `citations.type`, only a searchable alias.
 */
export interface CitationAltIds {
  pmid?: string;
  doi?: string;
  pmcid?: string;
  url?: string;
}

const ALT_ID_KEYS = ['pmid', 'doi', 'pmcid', 'url'] as const;

export function isCitationHandleType(
  value: unknown,
): value is CitationHandleType {
  return (
    typeof value === 'string' &&
    (CITATION_HANDLE_PREFERENCE as readonly string[]).includes(value)
  );
}

/** Position in {@link CITATION_HANDLE_PREFERENCE}; lower is stronger. */
export function citationHandleRank(type: string): number {
  const index = (CITATION_HANDLE_PREFERENCE as readonly string[]).indexOf(type);
  return index === -1 ? CITATION_HANDLE_PREFERENCE.length : index;
}

/**
 * Canonical spelling of an identifier for its type, so two spellings of one
 * handle cannot occupy two rows:
 *   - `pmid` — the bare number, with a `PMID:` / `pubmed:` wrapper removed.
 *   - `doi` — lower-cased (DOIs are case-insensitive by spec) with a
 *     `doi:` prefix or a `https://doi.org/` resolver URL removed.
 *   - `pmcid` — upper-cased with the `PMC` prefix present.
 *   - `url` / `freetext` — trimmed only; nothing else is safe to assume.
 *
 * Anything that does not look like the declared type is returned trimmed but
 * otherwise untouched: mangling an unrecognized identifier would lose the row's
 * only handle.
 */
export function normalizeHandleIdentifier(
  type: string,
  identifier: string,
): string {
  const trimmed = identifier.trim();
  if (type === 'pmid') {
    const bare = trimmed.replace(/^(pmid|pubmed)\s*:?\s*/i, '').trim();
    return /^\d+$/.test(bare) ? bare.replace(/^0+(?=\d)/, '') : trimmed;
  }
  if (type === 'doi') {
    const bare = trimmed
      .replace(/^doi\s*:?\s*/i, '')
      .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
      .trim();
    return /^10\./.test(bare) ? bare.toLowerCase() : trimmed.toLowerCase();
  }
  if (type === 'pmcid') {
    const bare = trimmed.replace(/^pmc\s*:?\s*/i, 'PMC').toUpperCase();
    return /^PMC\d+$/.test(bare) ? bare : trimmed;
  }
  return trimmed;
}

/**
 * Does a normalized identifier actually look like the type it is filed under?
 *
 * Only alt ids are held to this. `normalizeHandleIdentifier` deliberately lets
 * an unrecognized *declared* identifier through untouched, and that is right:
 * it is the row's only handle, so mangling or dropping it would lose the
 * citation entirely. An alt id is the opposite case — it is supplementary, and
 * a malformed one is not inert, because `canonicalCitationHandle` treats every
 * alt handle as a candidate for the row the paper is filed under. An altIds
 * entry of `pmid: "not-a-pmid"` would win on handle strength and promote the
 * row to an unresolvable `pmid` identifier, which is worse than not knowing the
 * PMID at all. Anything that fails its shape is dropped, not corrected.
 *
 * The patterns match the write-boundary validators in `api/_lib/schemas.ts`, so
 * an alt handle cannot enter through a path that holds it to a weaker standard
 * than the same value declared as the citation's own type.
 */
function altIdIsWellFormed(key: (typeof ALT_ID_KEYS)[number], value: string) {
  if (key === 'pmid') return /^\d{1,8}$/.test(value);
  if (key === 'doi') return /^10\.\d{4,}\/.+/.test(value);
  if (key === 'pmcid') return /^PMC\d+$/.test(value);
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Normalized alt ids, with blanks, non-strings and malformed handles dropped.
 */
export function normalizeAltIds(
  input: CitationAltIds | null | undefined,
): CitationAltIds {
  const out: CitationAltIds = {};
  if (!input) return out;
  for (const key of ALT_ID_KEYS) {
    const raw = input[key];
    if (typeof raw !== 'string') continue;
    const normalized = normalizeHandleIdentifier(key, raw);
    if (normalized && altIdIsWellFormed(key, normalized)) out[key] = normalized;
  }
  return out;
}

/**
 * Fill gaps only. An alt id already on the row was resolved (or declared) at
 * some earlier point and is not overwritten by a fresh guess — the same rule
 * `mergeExternalIds` uses for bio-entity ids.
 */
export function mergeAltIds(
  existing: CitationAltIds | null | undefined,
  incoming: CitationAltIds | null | undefined,
): CitationAltIds {
  const merged = normalizeAltIds(existing);
  const add = normalizeAltIds(incoming);
  for (const key of ALT_ID_KEYS) {
    if (!merged[key] && add[key]) merged[key] = add[key]!;
  }
  return merged;
}

export interface CanonicalCitationHandle extends CitationHandle {
  /** Every other handle known for this paper, normalized. */
  altIds: CitationAltIds;
}

/**
 * Pick the row this paper belongs in, given what the caller declared plus
 * whatever the crosswalk resolved. The strongest available handle wins and
 * every other one becomes an alt id — including the declared handle when the
 * crosswalk turned up something stronger, which is the case that used to mint
 * a second row.
 *
 * A `freetext` declaration is never promoted away from its own text: free text
 * is not resolvable, so a crosswalk claiming otherwise is not about this row.
 */
export function canonicalCitationHandle(
  declared: CitationHandle,
  crosswalk?: CitationAltIds | null,
): CanonicalCitationHandle {
  const declaredIdentifier = normalizeHandleIdentifier(
    declared.type,
    declared.identifier,
  );
  const alt = normalizeAltIds(crosswalk);

  if (declared.type === 'freetext') {
    return {
      type: 'freetext',
      identifier: declaredIdentifier,
      altIds: alt,
    };
  }

  // Candidates: what the caller declared, plus every resolvable alt handle.
  const candidates: CitationHandle[] = [
    { type: declared.type, identifier: declaredIdentifier },
  ];
  for (const type of ['pmid', 'doi', 'url'] as const) {
    const identifier = alt[type];
    if (identifier) candidates.push({ type, identifier });
  }

  const winner = candidates.reduce((best, candidate) =>
    citationHandleRank(candidate.type) < citationHandleRank(best.type)
      ? candidate
      : best,
  );

  const altIds = mergeAltIds(alt, {
    [declared.type]: declaredIdentifier,
  } as CitationAltIds);
  // The winning handle lives in the row's own columns; keeping it in altIds too
  // would duplicate it into the search haystack.
  delete altIds[winner.type as keyof CitationAltIds];

  return { type: winner.type, identifier: winner.identifier, altIds };
}

/**
 * Every `(type, identifier)` pair a row for this paper could already be sitting
 * under — the canonical handle first, then the alt handles that are themselves
 * valid citation types. This is the lookup set the write path uses before it
 * inserts: hitting any of them means the paper is already in the table, just
 * filed under a weaker handle.
 */
export function addressableHandles(
  canonical: CanonicalCitationHandle,
): CitationHandle[] {
  const handles: CitationHandle[] = [
    { type: canonical.type, identifier: canonical.identifier },
  ];
  for (const type of ['pmid', 'doi', 'url'] as const) {
    const identifier = canonical.altIds[type];
    if (identifier && type !== canonical.type) {
      handles.push({ type, identifier });
    }
  }
  return handles;
}

/**
 * The form a handle is stored and looked up under in `citation_identifier_aliases`.
 * DOIs are case-insensitive by specification, so the alias keeps the lower-case
 * form and the lookup lowers its input the same way — one index, one equality.
 */
export function aliasIdentifier(handle: CitationHandle): string {
  return handle.type === 'doi' ? handle.identifier.toLowerCase() : handle.identifier;
}

/**
 * What a resolver URL points at. `pmcid` is not a `citations.type` — it is an
 * alt id — but it is a perfectly good identity for comparing two declarations
 * of one article, so it belongs in this answer even though it can never be a
 * {@link CitationHandle}.
 */
export interface ResolvedUrlHandle {
  type: 'pmid' | 'doi' | 'pmcid';
  identifier: string;
}

/**
 * The resolvable handle a resolver URL is a front for, or null for a URL that
 * identifies nothing but itself.
 *
 * `https://doi.org/10.1234/x` and `10.1234/x` are one paper, but they are two
 * different handles and `normalizeHandleIdentifier` will not fold them — for a
 * `url` row it deliberately trims and nothing else, because a URL it does not
 * recognize is that row's only handle and mangling it would lose the citation.
 * This is the recognizing half, kept separate and non-destructive: a caller
 * comparing identities can ask what a URL really points at, while the stored
 * handle stays exactly as declared.
 */
export function resolverHandleFromUrl(url: string): ResolvedUrlHandle | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  // Path only. A query string or fragment on a resolver URL is decoration —
  // a tracking parameter or an anchor — and letting it into the identifier
  // would make one paper two.
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    path = parsed.pathname;
  }
  path = path.replace(/\/+$/, '');

  if (host === 'doi.org' || host === 'dx.doi.org') {
    const doi = path.replace(/^\//, '');
    return /^10\.\d{4,}\/.+/.test(doi)
      ? { type: 'doi', identifier: doi.toLowerCase() }
      : null;
  }

  if (host === 'pubmed.ncbi.nlm.nih.gov' || host === 'ncbi.nlm.nih.gov') {
    const pmid = /^\/(?:pubmed\/)?(\d{1,8})$/.exec(path);
    if (pmid) return { type: 'pmid', identifier: pmid[1]! };
  }

  if (host === 'pmc.ncbi.nlm.nih.gov' || host === 'ncbi.nlm.nih.gov') {
    const pmcid = /^(?:\/pmc)?\/articles\/(PMC\d+)$/i.exec(path);
    if (pmcid) return { type: 'pmcid', identifier: pmcid[1]!.toUpperCase() };
  }

  return null;
}

/**
 * Stable identity key for grouping rows that are the same paper: the strongest
 * handle known for the row, including its alt ids. Two rows sharing a key are a
 * split pair.
 */
export function citationIdentityKey(
  handle: CitationHandle,
  altIds?: CitationAltIds | null,
): string {
  const canonical = canonicalCitationHandle(handle, altIds);
  return `${canonical.type}:${canonical.identifier}`;
}

/**
 * The keys under which a citation id appears inside stored JSON: TipTap fact
 * nodes and footnote marks in `wiki_pages.content` / `wiki_revisions.content`,
 * and the `referenceIds` arrays inside `pending_edits.proposed_value`. Merging
 * two rows has to follow those too or a fact silently loses its reference.
 */
const CITATION_ID_KEYS = new Set([
  'referenceId',
  'referenceIds',
  'citationId',
  'citationIds',
  'refs',
]);

/**
 * Rewrite every citation-id reference inside a stored JSON value. Key-aware on
 * purpose: a blind numeric replace would also rewrite a year, a dose or a page
 * number that happened to equal the id.
 */
export function rewriteCitationIdsInJson<T>(
  value: T,
  from: number,
  to: number,
): { value: T; changed: boolean } {
  let changed = false;

  const walk = (node: unknown, underIdKey: boolean): unknown => {
    if (Array.isArray(node)) {
      return node.map((item) => walk(item, underIdKey));
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(
        node as Record<string, unknown>,
      )) {
        out[key] = walk(child, CITATION_ID_KEYS.has(key));
      }
      return out;
    }
    if (underIdKey && typeof node === 'number' && node === from) {
      changed = true;
      return to;
    }
    return node;
  };

  return { value: walk(value, false) as T, changed };
}
