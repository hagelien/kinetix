export interface CitationRow {
  id: number;
  drugId: number | null;
  type: 'freetext' | 'url' | 'pmid' | 'doi' | string;
  identifier: string;
  metadata: {
    title?: string;
    authors?: string | string[];
    journal?: string;
    year?: number | string;
    volume?: string;
    pages?: string;
  } | null;
  createdAt: string;
  /**
   * True when this is a resolvable citation (pmid/doi/url) that lacks an
   * approved read-in-full paper review — i.e. it should not yet be backing a
   * factual claim. Populated by `/api/references`; absent on rows built
   * client-side. See api/_lib/reference-review-status.ts.
   */
  needsFullReview?: boolean;
}

const inFlightDrugReferenceRequests = new Map<number, Promise<CitationRow[]>>();

export async function fetchDrugReferences(
  drugId: number,
): Promise<CitationRow[]> {
  const existing = inFlightDrugReferenceRequests.get(drugId);
  if (existing) return existing;

  const request = (async () => {
    const res = await fetch(`/api/references?drugId=${drugId}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { references?: CitationRow[] };
    return data.references ?? [];
  })().finally(() => {
    if (inFlightDrugReferenceRequests.get(drugId) === request) {
      inFlightDrugReferenceRequests.delete(drugId);
    }
  });

  inFlightDrugReferenceRequests.set(drugId, request);
  return request;
}

export class ReferenceFetchError extends Error {
  constructor(public readonly status: number) {
    super(`reference fetch failed (${status})`);
    this.name = 'ReferenceFetchError';
  }
}

export class PaperReviewFetchError extends Error {
  constructor(public readonly status: number) {
    super(`paper review fetch failed (${status})`);
    this.name = 'PaperReviewFetchError';
  }
}

export async function fetchReference(id: number): Promise<CitationRow> {
  const res = await fetch(`/api/references?id=${id}`);
  if (!res.ok) {
    throw new ReferenceFetchError(res.status);
  }
  const data = (await res.json()) as { reference?: CitationRow };
  if (!data.reference) {
    throw new ReferenceFetchError(500);
  }
  return data.reference;
}

export async function fetchReferences(ids: number[]): Promise<CitationRow[]> {
  const uniqueIds = [...new Set(ids)].filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  if (uniqueIds.length === 0) return [];

  const params = new URLSearchParams({ ids: uniqueIds.join(',') });
  const res = await fetch(`/api/references?${params}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { references?: CitationRow[] };
  return data.references ?? [];
}

export function referenceModulePath(id: number): string {
  return `/references/${id}`;
}

/** The axis the reference index is grouped and paginated along. */
export type ReferenceGroupBy = 'drug' | 'alpha' | 'author' | 'year';

/**
 * One group in the site-wide reference index — a drug monograph or wiki page
 * (`groupBy=drug`), a title initial (`alpha`), a first-author surname initial
 * (`author`), or a publication year (`year`).
 * Returned by `/api/references?view=index`.
 */
export interface ReferenceGroup {
  kind: 'drug' | 'wiki' | 'alpha' | 'author' | 'year';
  /** Stable identity across pages, e.g. `drug-7`, `alpha-M`, `year-2019`. */
  key: string;
  /** Drug id (kind='drug') or wiki page id (kind='wiki'). */
  id?: number;
  slug?: string;
  /** Per-language drug names; present only when kind='drug'. */
  names?: Record<string, string>;
  /** Wiki page title; present only when kind='wiki'. */
  title?: string;
  /** Wiki page type (e.g. `topic`, `entity_monograph`); kind='wiki' only. */
  pageType?: string;
  /** In-app path to the owning monograph / page; owner groups only. */
  href?: string;
  /**
   * Letter or year label; `null` for the catch-all groups — undated sources on
   * the year axis, authorless ones on the author axis.
   */
  label?: string | null;
  references: CitationRow[];
  /** References in this group across every page, not just the visible slice. */
  totalReferences: number;
}

/** One entry in the letter / year / monograph jump index. */
export interface ReferenceBucket {
  key: string;
  label: string | null;
  count: number;
}

export interface ReferenceIndex {
  groups: ReferenceGroup[];
  buckets: ReferenceBucket[];
  groupBy: ReferenceGroupBy;
  /** The bucket actually applied; `null` when none (or an unknown one). */
  bucket: string | null;
  page: number;
  pageSize: number;
  totalPages: number;
  /** Distinct anchored citations across the whole site, ignoring the query. */
  totalReferences: number;
  /** Distinct citations matching the query, ignoring the bucket filter. */
  matchedReferences: number;
  /** Rows on the current axis — a source counts once per owner in drug mode. */
  totalRows: number;
  rangeStart: number;
  rangeEnd: number;
}

export interface ReferenceIndexQuery {
  q?: string;
  groupBy?: ReferenceGroupBy;
  bucket?: string | null;
  page?: number;
  pageSize?: number;
  /** Active UI language — drives drug-name headings and collation. */
  lang?: string;
}

export async function fetchReferenceIndex(
  query: ReferenceIndexQuery = {},
  signal?: AbortSignal,
): Promise<ReferenceIndex> {
  const params = new URLSearchParams({ view: 'index' });
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.groupBy) params.set('groupBy', query.groupBy);
  if (query.bucket) params.set('bucket', query.bucket);
  if (query.page && query.page > 1) params.set('page', String(query.page));
  if (query.pageSize) params.set('pageSize', String(query.pageSize));
  if (query.lang) params.set('lang', query.lang);

  const res = await fetch(`/api/references?${params}`, { signal });
  if (!res.ok) {
    throw new ReferenceFetchError(res.status);
  }
  const data = (await res.json()) as Partial<ReferenceIndex>;
  return {
    groups: data.groups ?? [],
    buckets: data.buckets ?? [],
    groupBy: data.groupBy ?? query.groupBy ?? 'drug',
    bucket: data.bucket ?? null,
    page: data.page ?? 1,
    pageSize: data.pageSize ?? 50,
    totalPages: data.totalPages ?? 1,
    totalReferences: data.totalReferences ?? 0,
    matchedReferences: data.matchedReferences ?? 0,
    totalRows: data.totalRows ?? 0,
    rangeStart: data.rangeStart ?? 0,
    rangeEnd: data.rangeEnd ?? 0,
  };
}

/** Where a search query hit, so the UI can explain a non-obvious match. */
export type ReferenceMatchSource =
  | 'identifier'
  | 'metadata'
  | 'review'
  | 'other';

export interface ReferenceSearchHit extends CitationRow {
  /**
   * Server-assigned relevance tier, lowest first: 0 = the query *is* this
   * identifier, 1 = title prefix, 2 = identifier substring, 3 = title, 4 =
   * authors, 5 = matched elsewhere (journal, year, or the review body).
   */
  matchRank: number;
  matchSource: ReferenceMatchSource;
  /** Excerpt of the agent review around the match; only for review hits. */
  reviewSnippet: string | null;
}

/**
 * Free-text reference lookup: identifiers (a pasted DOI, PubMed ID, or link),
 * every metadata field, and the agent's paper-review text. Backs the command
 * palette; returns [] rather than throwing so a failed lookup can never blank
 * the palette's drug/wiki results.
 */
export async function searchReferences(
  q: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<ReferenceSearchHit[]> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const params = new URLSearchParams({
    view: 'search',
    q: trimmed,
    limit: String(options.limit ?? 6),
  });
  const res = await fetch(`/api/references?${params}`, {
    signal: options.signal,
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { references?: ReferenceSearchHit[] };
  return data.references ?? [];
}

/**
 * A single place a reference is cited from — a drug monograph or a wiki page.
 * Returned by `/api/references?view=usage&id=...` (the reverse cross-links of
 * the reference module page).
 */
export type ReferenceUsageLocation =
  | {
      kind: 'drug';
      id: number;
      slug: string;
      names: Record<string, string>;
      href: string;
    }
  | {
      kind: 'wiki';
      id: number;
      slug: string;
      title: string;
      pageType: string;
      href: string;
    };

export async function fetchReferenceUsage(
  id: number,
): Promise<ReferenceUsageLocation[]> {
  const res = await fetch(`/api/references?view=usage&id=${id}`);
  if (!res.ok) {
    throw new ReferenceFetchError(res.status);
  }
  const data = (await res.json()) as { usage?: ReferenceUsageLocation[] };
  return data.usage ?? [];
}

export interface PaperReviewRow {
  id: number;
  citationId: number;
  reviewMarkdown: string;
  overallScore: number | null;
  conclusionSupport: string | null;
  reviewConfidence: string | null;
  readInFull?: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function fetchPaperReview(
  citationId: number,
): Promise<PaperReviewRow | null> {
  const res = await fetch(`/api/paper-reviews?citationId=${citationId}`);
  if (!res.ok) {
    throw new PaperReviewFetchError(res.status);
  }
  const data = (await res.json()) as { review?: PaperReviewRow | null };
  return data.review ?? null;
}

/** One entry in a reference's paper-review history (newest first). */
export interface PaperReviewRevisionRow {
  id: number;
  reviewMarkdown: string;
  overallScore: number | null;
  conclusionSupport: string | null;
  reviewConfidence: string | null;
  readInFull: boolean;
  /** The author's reason for this (re-)review; null on the first revision. */
  editSummary: string | null;
  createdAt: string;
  author: {
    id: number | null;
    username: string | null;
    displayName: string | null;
    role: string | null;
    isAgent: boolean;
  };
}

export async function fetchPaperReviewHistory(
  citationId: number,
): Promise<PaperReviewRevisionRow[]> {
  const res = await fetch(
    `/api/paper-reviews?citationId=${citationId}&view=history`,
  );
  if (!res.ok) {
    throw new PaperReviewFetchError(res.status);
  }
  const data = (await res.json()) as { revisions?: PaperReviewRevisionRow[] };
  return data.revisions ?? [];
}

export interface PdfRequestRow {
  id: number;
  citationId: number;
  status: 'open' | 'fulfilled' | 'cancelled' | string;
  reason: string | null;
  /** Editor-only to fulfil — this request replaces stored full text. */
  isReplacement?: boolean;
  createdAt: string;
}

export interface PdfRequestState {
  request: PdfRequestRow | null;
  hasPdf: boolean;
}

export async function fetchPdfRequest(
  citationId: number,
): Promise<PdfRequestState> {
  const res = await fetch(`/api/pdf-requests?citationId=${citationId}`);
  if (!res.ok) return { request: null, hasPdf: false };
  const data = (await res.json()) as Partial<PdfRequestState>;
  return { request: data.request ?? null, hasPdf: Boolean(data.hasPdf) };
}

/** An open PDF request enriched with its citation, for the queue view. */
export interface OpenPdfRequestRow {
  id: number;
  citationId: number;
  status: string;
  reason: string | null;
  createdAt: string;
  citationType: CitationRow['type'];
  citationIdentifier: string;
  citationMetadata: CitationRow['metadata'];
  /**
   * A bulk-dropped PDF in the inbox is already matched to this paper, waiting
   * for somebody to confirm the link. The row still says full text is missing,
   * because it is — but nobody should go and fetch a copy that is already on
   * the premises.
   */
  pdfInInbox?: boolean;
}

/**
 * Count of the OPEN PDF-request queue — papers the review agent couldn't
 * access, awaiting a human contributor to supply full text. Feeds the header
 * review badge alongside the pending-edit count so these "needs attention"
 * items are surfaced. Never throws: a transient failure resolves to 0 so it
 * can only add to the badge, never blank the pending count it sums with.
 */
export async function fetchOpenPdfRequestCount(): Promise<number> {
  try {
    const res = await fetch('/api/pdf-requests?countOnly=true');
    if (!res.ok) return 0;
    const data = (await res.json()) as { count?: number };
    return typeof data.count === 'number' ? data.count : 0;
  } catch {
    return 0;
  }
}

/**
 * A cited paper missing full text that carries no PDF request — nothing has
 * asked for it yet, it is simply not on file. Distinct from an open request,
 * which is an agent's (or a contributor's) explicit "this one is needed".
 */
export interface FullTextGapRow {
  citationId: number;
  citationType: CitationRow['type'];
  citationIdentifier: string;
  citationMetadata: CitationRow['metadata'];
  citationCreatedAt: string;
  /**
   * A request exists but is closed (cancelled or fulfilled with nothing on
   * file), so this paper was reached before even though no open request
   * surfaces it now. The UI says so rather than implying nobody asked.
   */
  previouslyRequested: boolean;
  /** A bulk-dropped PDF matched to this paper is waiting in the inbox. */
  pdfInInbox?: boolean;
}

export interface PdfQueue {
  /** Open requests — an agent hit a paywall, or a contributor asked. */
  requests: OpenPdfRequestRow[];
  /** Cited papers with no full text and no request on file. */
  gaps: FullTextGapRow[];
  /** Total gaps server-side, so a truncated list can say what it omits. */
  gapTotal: number;
}

/**
 * The whole PDF queue: open requests (agents file these when they hit a
 * paywall) plus the unrequested full-text gaps the reference pages already
 * advertise. Both classes are actionable by the same upload; they are kept
 * apart because only the first carries an agent's confirmation that the full
 * text could not be obtained freely.
 */
export async function fetchPdfQueue(): Promise<PdfQueue> {
  const res = await fetch('/api/pdf-requests');
  // Throw on a non-2xx (DB/Vercel outage, future auth failure) so the queue
  // page shows its error state rather than a misleading "queue is clear".
  if (!res.ok) throw new Error(`pdf requests fetch failed (${res.status})`);
  const data = (await res.json()) as Partial<PdfQueue>;
  const gaps = data.gaps ?? [];
  return {
    requests: data.requests ?? [],
    gaps,
    gapTotal: data.gapTotal ?? gaps.length,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForCitationPdf(
  citationId: number,
  options: { attempts?: number; intervalMs?: number } = {},
): Promise<PdfRequestState> {
  const attempts = options.attempts ?? 6;
  const intervalMs = options.intervalMs ?? 1_000;
  let latest = await fetchPdfRequest(citationId);
  for (let i = 1; i < attempts && !latest.hasPdf; i += 1) {
    await sleep(intervalMs);
    latest = await fetchPdfRequest(citationId);
  }
  return latest;
}

export class PdfFulfillError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'PdfFulfillError';
  }
}

/** A minted, time-limited download link for a stored citation PDF. */
export interface PdfShareLink {
  /** Absolute URL — shareable as-is with someone who has no Kinetix account. */
  url: string;
  /** ISO timestamp after which the link stops working. */
  expiresAt: string;
  /** Lifetime the server granted, for "valid for N minutes" copy. */
  expiresInSeconds: number;
}

/**
 * Mint a temporary public download URL for a citation's stored PDF.
 *
 * Gated by `citation.pdf.share` (admin by default). The server returns a
 * relative path and this makes it absolute against the current origin, so the
 * shareable URL is never assembled from a request header the caller controls.
 */
export async function createPdfShareLink(
  citationId: number,
): Promise<PdfShareLink> {
  const res = await fetch(
    `/api/citation-pdf-share?citationId=${citationId}`,
    { method: 'POST' },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { code?: string };
    throw new PdfFulfillError(data.code ?? `http_${res.status}`);
  }
  const data = (await res.json()) as {
    path?: string;
    expiresAt?: string;
    expiresInSeconds?: number;
  };
  if (!data.path || !data.expiresAt) {
    throw new PdfFulfillError('pdf_share_invalid_response');
  }
  return {
    url: new URL(data.path, window.location.origin).toString(),
    expiresAt: data.expiresAt,
    expiresInSeconds: data.expiresInSeconds ?? 600,
  };
}

/**
 * Self-provision an open PDF request for a citation. Contributors call this to
 * supply full text directly from the reference page when no agent has filed a
 * request yet — the upload/URL routes require an open request, and the
 * resulting fulfilled request feeds the agent's follow-up review queue.
 */
export async function createPdfRequest(
  citationId: number,
  options: { replace?: boolean } = {},
): Promise<void> {
  const res = await fetch(`/api/pdf-requests?citationId=${citationId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // `replace` (editor+) reopens a request for a citation that already has
    // full text, so an unusable stored PDF can be swapped. Without it the
    // server treats an existing PDF as "already satisfied" and refuses.
    body: JSON.stringify(options.replace ? { replace: true } : {}),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { code?: string };
    throw new PdfFulfillError(data.code ?? `http_${res.status}`);
  }
}

export async function submitPdfUrl(
  citationId: number,
  url: string,
): Promise<void> {
  const res = await fetch(`/api/citation-pdf?citationId=${citationId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { code?: string };
    throw new PdfFulfillError(data.code ?? `http_${res.status}`);
  }
}

// Custom upload-route event used to probe storage health before a
// client-direct upload. Mirrors STORAGE_PROBE_EVENT in api/_lib/pdf-storage.ts.
const STORAGE_PROBE_EVENT = 'kinetix.storage-probe';

export async function uploadCitationPdf(
  citationId: number,
  file: File,
): Promise<void> {
  // Probe storage health first. The Vercel SDK swallows our token-route error
  // body into a generic BlobError, so a misconfigured Blob store would
  // otherwise reach the user as an opaque browser CORS/400 failure on the
  // direct PUT. This surfaces it as a clear, localized message instead.
  const probe = await fetch('/api/citation-pdf-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: STORAGE_PROBE_EVENT }),
  });
  if (!probe.ok) {
    const data = (await probe.json().catch(() => ({}))) as { code?: string };
    // Only claim a storage problem when the server actually reported one.
    // A 401 (expired cookie), 403 (demoted user), or generic 500 carries no
    // `code`, so fall back to the generic upload failure rather than wrongly
    // telling the user the Blob store needs reconnecting.
    throw new PdfFulfillError(data.code ?? 'unknown');
  }

  // Direct browser → Blob upload; bytes never traverse our serverless body.
  const { upload } = await import('@vercel/blob/client');
  await upload(`citation-pdfs/${citationId}.pdf`, file, {
    access: 'private',
    contentType: 'application/pdf',
    handleUploadUrl: '/api/citation-pdf-upload',
    clientPayload: String(citationId),
  });
}
