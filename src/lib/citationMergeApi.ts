/**
 * Client for the admin citation-merge endpoint (`/api/citation-merge`).
 * Types mirror `api/citation-merge.ts`.
 */
import { citationHandleRank } from './citationHandles';

export interface CitationMergeCandidate {
  id: number;
  type: 'freetext' | 'url' | 'pmid' | 'doi' | string;
  identifier: string;
  metadata: {
    title?: string;
    authors?: string[];
    journal?: string;
    year?: number | null;
  } | null;
  /** Claims, parameter entries, revisions and edits citing this row. */
  usageCount: number;
  review: { readInFull: boolean } | null;
  hasPdf: boolean;
  pdfRequestStatus: string | null;
}

export interface CitationMergeResult {
  survivorId: number;
  merged: number[];
  /** Rows another merge into the same survivor was already folding. */
  deferred: number[];
}

/**
 * Every `code` the endpoint returns on a refusal. The UI picks its message
 * from the code; the server's `error` prose is English and for logs only.
 */
export type CitationMergeErrorCode =
  | 'not_found'
  | 'weaker_survivor'
  | 'nothing_to_merge'
  | 'cohort_conflict'
  | 'extraction_in_flight'
  | 'agent_refused';

export class CitationMergeError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: CitationMergeErrorCode | string | undefined,
    serverMessage: string,
  ) {
    super(serverMessage);
    this.name = 'CitationMergeError';
  }
}

async function readOrThrow<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new CitationMergeError(
      res.status,
      typeof data.code === 'string' ? data.code : undefined,
      typeof data.error === 'string' ? data.error : 'Request failed',
    );
  }
  return data as T;
}

export async function searchCitationsForMerge(
  query: string,
  signal?: AbortSignal,
): Promise<CitationMergeCandidate[]> {
  const q = query.trim();
  if (!q) return [];
  const res = await fetch(`/api/citation-merge?q=${encodeURIComponent(q)}`, {
    signal,
  });
  const data = await readOrThrow<{ candidates?: CitationMergeCandidate[] }>(res);
  return data.candidates ?? [];
}

export async function applyCitationMerge(params: {
  survivorId: number;
  mergeIds: number[];
}): Promise<CitationMergeResult> {
  const res = await fetch('/api/citation-merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return readOrThrow<CitationMergeResult>(res);
}

/**
 * Which of the selected rows to keep by default. The server only accepts a
 * survivor filed under the group's strongest handle (PMID > DOI > URL > free
 * text); among those, the one already carrying the most — a read-in-full
 * review, then a stored PDF, then the most citing claims — and finally the
 * oldest row.
 */
export function suggestSurvivor(
  rows: readonly CitationMergeCandidate[],
): CitationMergeCandidate | null {
  if (rows.length === 0) return null;
  return [...rows].sort(
    (a, b) =>
      citationHandleRank(a.type) - citationHandleRank(b.type) ||
      Number(b.review?.readInFull ?? false) - Number(a.review?.readInFull ?? false) ||
      Number(b.hasPdf) - Number(a.hasPdf) ||
      b.usageCount - a.usageCount ||
      a.id - b.id,
  )[0]!;
}

/** True when `candidate` may be kept for this selection (see `suggestSurvivor`). */
export function isEligibleSurvivor(
  candidate: CitationMergeCandidate,
  rows: readonly CitationMergeCandidate[],
): boolean {
  const strongest = Math.min(...rows.map((row) => citationHandleRank(row.type)));
  return citationHandleRank(candidate.type) <= strongest;
}
