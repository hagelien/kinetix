/**
 * Is this free-text citation a paper we already have?
 *
 * A `pmid` / `doi` / `url` citation has a handle two writers can agree on, and
 * `citationHandles.ts` makes sure they do. A `freetext` citation has only its
 * own wording, and research agents never word a reference the same way twice:
 * "Schulz M, Schmoldt A. Therapeutic and toxic concentrations of …", "…
 * Beyreuth: GIT Verlag; 2003." and the bare title are three `(type,
 * identifier)` pairs, so they became three rows — next to the PMID row the
 * paper actually has. Every one of those rows then shows up as its own
 * candidate in the PDF inbox, carries its own review, and splits the claims
 * that cite the paper.
 *
 * What the wordings do agree on is the bibliographic record the agent filled in
 * beside the text: first author, year, title. This module compares works by
 * that record. It is deliberately conservative — a false match folds two papers
 * into one, which is far worse than leaving a duplicate — so it requires all
 * three, and treats any difference in the numbers a title carries ("12th ed.",
 * "800 drugs", "1,000 drugs") as a different work.
 *
 * Pure: the DB half lives in `api/_lib/citation-store.ts` (reuse a match on
 * write) and `scripts/merge-split-citations.ts` (fold the rows that already
 * exist).
 */

/** The slice of `ReferenceMetadata` a fingerprint reads. */
export interface WorkRecord {
  title?: string;
  authors?: string[];
  year?: number | null;
}

export interface WorkFingerprint {
  /** First author's surname, case- and accent-folded. */
  surname: string;
  year: number;
  /** Title words, folded; punctuation and edition noise removed. */
  titleTokens: string[];
  /** Every number in the title, which must match exactly. */
  titleNumbers: string[];
}

/**
 * Fewer title words than this and the title says too little to tell two works
 * apart ("Diazepam", "Ethanol") — no fingerprint.
 */
const MIN_TITLE_TOKENS = 4;

/**
 * Shared-word ratio (Jaccard) two titles need to count as one. A one-word
 * slip in a twelve-word title — "blood concentrations" for "concentrations" —
 * scores 0.92; titles of different papers by the same author in the same year
 * score far lower.
 */
export const TITLE_SIMILARITY_THRESHOLD = 0.85;

/**
 * Words that carry no identity. Leaving `ed` / `edn` / `edition` in would make
 * "Clarke's Analysis …, 4th ed." and "Clarke's Analysis …, 4th edition"
 * disagree; the edition number itself is a title number and still has to match.
 */
const NOISE_TOKENS = new Set(['ed', 'edn', 'edition']);

/** Lower-case, accents removed, every run of non-letters/digits a space. */
export function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    // "1,000" and "1.000" are one number, not two.
    .replace(/(\d)[,.](?=\d{3}\b)/g, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function titleTokensOf(title: string): string[] {
  return foldText(title)
    .split(' ')
    .filter((token) => token.length > 0 && !NOISE_TOKENS.has(token));
}

/**
 * "Schulz M", "Schulz, M.", "M. Schulz", "Jostell K-G": the surname is the
 * longest word, which in every one of those is the right one, and is robust to
 * the initials-first and initials-last orders agents mix freely.
 */
function surnameOf(author: string): string | null {
  const words = foldText(author)
    .split(' ')
    .filter((word) => /\p{L}/u.test(word));
  if (words.length === 0) return null;
  const longest = words.reduce((best, word) =>
    word.length > best.length ? word : best,
  );
  return longest.length >= 2 ? longest : null;
}

export function workFingerprint(
  metadata: WorkRecord | null | undefined,
): WorkFingerprint | null {
  if (!metadata) return null;
  const firstAuthor = metadata.authors?.[0];
  const year = metadata.year;
  const title = metadata.title;
  if (!firstAuthor || typeof year !== 'number' || !title) return null;
  const surname = surnameOf(firstAuthor);
  if (!surname) return null;
  const titleTokens = titleTokensOf(title);
  if (titleTokens.length < MIN_TITLE_TOKENS) return null;
  const titleNumbers = titleTokens.filter((token) => /\d/.test(token)).sort();
  return { surname, year, titleTokens, titleNumbers };
}

function jaccard(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

export function isSameWork(a: WorkFingerprint, b: WorkFingerprint): boolean {
  if (a.surname !== b.surname || a.year !== b.year) return false;
  if (a.titleNumbers.join(' ') !== b.titleNumbers.join(' ')) return false;
  return jaccard(a.titleTokens, b.titleTokens) >= TITLE_SIMILARITY_THRESHOLD;
}

/**
 * Does a free-text row's own wording describe the record filed beside it?
 *
 * The record is what the match runs on, so a row whose record describes a
 * different work from its text would be folded into the wrong paper. That
 * happens: an agent pastes two references into one string and fills in the
 * record for the second ("Schulz M, Schmoldt A. Therapeutic and toxic … Basalt
 * RC. Disposition of Toxic Drugs …" filed as Baselt). Such a row is left for a
 * person rather than merged either way.
 *
 * The text has to open with the first author or with the title, and contain
 * nearly every title word.
 */
export function freetextMatchesRecord(
  identifier: string,
  fingerprint: WorkFingerprint,
): boolean {
  const text = foldText(identifier);
  const words = text.split(' ');
  const opensWithAuthor = words[0] === fingerprint.surname;
  const opensWithTitle = words[0] === fingerprint.titleTokens[0];
  if (!opensWithAuthor && !opensWithTitle) return false;
  const present = new Set(words);
  const covered = fingerprint.titleTokens.filter((token) =>
    present.has(token),
  ).length;
  return covered / fingerprint.titleTokens.length >= 0.9;
}

export interface WorkMatchRow {
  id: number;
  type: string;
  identifier: string;
  metadata: WorkRecord | null | undefined;
  /**
   * The canonical handle (`pmid:…`) of a resolvable row; null for free text.
   * Two resolvable rows with different keys are two papers as far as anything
   * here can prove, however alike their titles.
   */
  handleKey: string | null;
}

/** The fingerprint a row may be matched on, or null when it may not be. */
export function matchableFingerprint(row: {
  type: string;
  identifier: string;
  metadata: WorkRecord | null | undefined;
}): WorkFingerprint | null {
  const fingerprint = workFingerprint(row.metadata);
  if (!fingerprint) return null;
  if (row.type === 'freetext' && !freetextMatchesRecord(row.identifier, fingerprint)) {
    return null;
  }
  return fingerprint;
}

/**
 * Does every member agree with every other, not merely with a neighbour?
 *
 * Title similarity is not transitive: an abbreviated title can sit within the
 * threshold of two longer ones ("… after oral …", "… after intravenous …")
 * that are not within it of each other. A chain like that is two papers joined
 * through a third wording, and folding it would repoint one paper's claims and
 * review onto the other. Two resolvable rows sharing a handle are one paper by
 * their handles, so their own titles are not compared.
 */
export function isMutuallySameWork(
  members: ReadonlyArray<{
    type: string;
    handleKey: string | null;
    fingerprint: WorkFingerprint;
  }>,
): boolean {
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const a = members[i]!;
      const b = members[j]!;
      if (a.handleKey !== null && a.handleKey === b.handleKey) continue;
      if (!isSameWork(a.fingerprint, b.fingerprint)) return false;
    }
  }
  return true;
}

export interface SameWorkCluster<T extends WorkMatchRow> {
  /** Every row the title match ties together, free text and resolvable alike. */
  rows: T[];
  /**
   * The cluster reaches two or more resolvable handles — the free text could
   * be either paper (or they are one paper whose PMID and DOI were never
   * crosswalked) — or its members are only chained together, not each a match
   * for every other. Nothing is merged on the title alone.
   */
  ambiguous: boolean;
}

/**
 * Group rows that are one work by title, author and year. Only a free-text row
 * is ever joined on its record: two resolvable rows are tied together by their
 * handles or not at all, so a pair of distinct PMIDs that share a title (a
 * guideline and its reprint, say) is never folded here. Clusters without a
 * free-text member are not returned — there is nothing for this match to add.
 */
export function clusterSameWorks<T extends WorkMatchRow>(
  rows: ReadonlyArray<T>,
): SameWorkCluster<T>[] {
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  };

  const buckets = new Map<string, Array<{ row: T; fp: WorkFingerprint }>>();
  const fingerprintOf = new Map<number, WorkFingerprint>();
  for (const row of rows) {
    parent.set(row.id, row.id);
    const fp = matchableFingerprint(row);
    if (!fp) continue;
    fingerprintOf.set(row.id, fp);
    const key = `${fp.surname}|${fp.year}`;
    buckets.set(key, [...(buckets.get(key) ?? []), { row, fp }]);
  }

  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i]!;
        const b = bucket[j]!;
        if (a.row.type !== 'freetext' && b.row.type !== 'freetext') continue;
        if (isSameWork(a.fp, b.fp)) union(a.row.id, b.row.id);
      }
    }
  }

  const byRoot = new Map<number, T[]>();
  for (const row of rows) {
    const root = find(row.id);
    byRoot.set(root, [...(byRoot.get(root) ?? []), row]);
  }

  return [...byRoot.values()]
    .filter(
      (group) =>
        group.length > 1 && group.some((row) => row.type === 'freetext'),
    )
    .map((group) => {
      const handles = new Set(
        group
          .map((row) => row.handleKey)
          .filter((key): key is string => key !== null),
      );
      // Every member got here through a title edge, so each has a fingerprint.
      const mutual = isMutuallySameWork(
        group.map((row) => ({
          type: row.type,
          handleKey: row.handleKey,
          fingerprint: fingerprintOf.get(row.id)!,
        })),
      );
      return { rows: group, ambiguous: handles.size > 1 || !mutual };
    });
}
