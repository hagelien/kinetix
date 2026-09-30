/**
 * Client for the PDF inbox — the bulk drop-off that lets a human hand over a
 * whole folder of downloads in one go and let the system work out which
 * citation each file belongs to.
 *
 * Kept apart from `referencesApi.ts` (which owns the one-paper-at-a-time
 * upload) because the two answer different questions. There, the citation is
 * known and the file is missing; here, the file is in hand and the citation is
 * the unknown.
 */
import type { CitationRow } from './referencesApi';

/** How far a match may be trusted — mirrors api/_lib/pdf-inbox-match.ts. */
export type MatchConfidence = 'exact' | 'strong' | 'weak' | 'none';

export type MatchVia = 'doi' | 'pmid' | 'pmcid' | 'title';

/** Where an extracted identifier came from — shown so a reviewer can weigh it. */
export type IdentifierSource = 'filename' | 'xmp' | 'info' | 'text';

export interface ExtractedIdentifiers {
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  title: string | null;
  year: number | null;
  sources: Partial<Record<'doi' | 'pmid' | 'pmcid' | 'title' | 'year', IdentifierSource>>;
}

export interface InboxCandidate {
  citationId: number;
  via: MatchVia;
  score: number;
  citationType: CitationRow['type'];
  citationIdentifier: string;
  citationMetadata: CitationRow['metadata'];
  hasPdf: boolean;
}

export interface InboxItem {
  id: number;
  originalFilename: string;
  sizeBytes: number;
  status: 'pending' | 'attached' | 'discarded' | string;
  extracted: ExtractedIdentifiers | null;
  candidates: InboxCandidate[] | null;
  matchedCitationId: number | null;
  matchConfidence: MatchConfidence;
  autoAttached: boolean;
  attachedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface InboxListing {
  items: InboxItem[];
  /**
   * Every citation the listing refers to, read fresh rather than from the
   * copy stored at match time — the queue's whole purpose is "is this the
   * right paper?", which a stale title would answer wrongly.
   */
  citations: CitationRow[];
  /**
   * Discarded items whose bytes may still be in storage. The sweep is what
   * retries those deletions, so this keeps that action reachable even when
   * nothing is pending.
   */
  cleanupPending: number;
}

export class PdfInboxError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'PdfInboxError';
  }
}

async function failure(res: Response): Promise<PdfInboxError> {
  const data = (await res.json().catch(() => ({}))) as { code?: string };
  return new PdfInboxError(data.code ?? `http_${res.status}`);
}

export async function fetchInbox(
  status: 'pending' | 'attached' = 'pending',
): Promise<InboxListing> {
  const res = await fetch(`/api/pdf-inbox?status=${status}`);
  // Throw rather than resolving empty: "the inbox is clear" and "the inbox
  // could not be read" look identical on the page, and only one of them means
  // there is nothing left to do.
  if (!res.ok) throw await failure(res);
  const data = (await res.json()) as Partial<InboxListing>;
  return {
    items: data.items ?? [],
    citations: data.citations ?? [],
    cleanupPending: data.cleanupPending ?? 0,
  };
}

/**
 * How many PDFs are waiting to be linked. Feeds the header badge, so — like
 * the PDF-request count it sums with — it never throws: a transient failure
 * resolves to 0 and can only under-report, never blank the other counts.
 */
export async function fetchInboxCount(): Promise<number> {
  try {
    const res = await fetch('/api/pdf-inbox?countOnly=1');
    if (!res.ok) return 0;
    const data = (await res.json()) as { count?: number };
    return typeof data.count === 'number' ? data.count : 0;
  } catch {
    return 0;
  }
}

export async function attachInboxItem(
  itemId: number,
  citationId: number,
): Promise<void> {
  const res = await fetch(
    `/api/pdf-inbox?id=${itemId}&citationId=${citationId}`,
    { method: 'POST' },
  );
  if (!res.ok) throw await failure(res);
}

export async function rematchInboxItem(itemId: number): Promise<MatchConfidence> {
  const res = await fetch(`/api/pdf-inbox?id=${itemId}&action=rematch`, {
    method: 'POST',
  });
  if (!res.ok) throw await failure(res);
  const data = (await res.json()) as { match?: { confidence?: MatchConfidence } };
  return data.match?.confidence ?? 'none';
}

export interface AutoAttachSummary {
  attached: Array<{ itemId: number; citationId: number }>;
  failed: Array<{ itemId: number; code: string }>;
  scanned: number;
  /** The sweep hit its batch limit, so running it again will do more. */
  truncated: boolean;
  pending: number;
  /** Objects from earlier failed discards that this pass finally removed. */
  cleaned: number;
}

export async function autoAttachInbox(): Promise<AutoAttachSummary> {
  const res = await fetch('/api/pdf-inbox?action=autoAttach', { method: 'POST' });
  if (!res.ok) throw await failure(res);
  const data = (await res.json()) as Partial<AutoAttachSummary>;
  return {
    attached: data.attached ?? [],
    failed: data.failed ?? [],
    scanned: data.scanned ?? 0,
    truncated: Boolean(data.truncated),
    pending: data.pending ?? 0,
    cleaned: data.cleaned ?? 0,
  };
}

export async function discardInboxItem(itemId: number): Promise<void> {
  const res = await fetch(`/api/pdf-inbox?id=${itemId}`, { method: 'DELETE' });
  if (!res.ok) throw await failure(res);
}

/** Mirrors STORAGE_PROBE_EVENT in api/_lib/pdf-storage.ts. */
const STORAGE_PROBE_EVENT = 'kinetix.storage-probe';

/** Mirrors INBOX_BLOB_PATH in api/pdf-inbox-upload.ts. */
const INBOX_BLOB_PATH = 'pdf-inbox/dropped.pdf';

/**
 * Probe Blob storage once before a batch.
 *
 * The single-file path probes on every upload because there is only ever one.
 * A folder of forty would make forty identical round trips and, on a
 * misconfigured store, produce forty identical failures — so the caller probes
 * once and then uploads, which is also what makes a storage outage read as one
 * clear message instead of a wall of them.
 */
export async function probeInboxStorage(): Promise<void> {
  const res = await fetch('/api/pdf-inbox-upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: STORAGE_PROBE_EVENT }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { code?: string };
    // Only claim a storage problem when the server reported one: a 401
    // (expired cookie) or 403 (demoted user) carries no code, and telling
    // somebody to reconnect Blob storage over an expired session sends them
    // after the wrong thing entirely.
    throw new PdfInboxError(data.code ?? 'unknown');
  }
}

/**
 * Upload one file into the inbox.
 *
 * The path is a constant: the server refuses anything else, because there is
 * no citation to derive a key from and turning a user-supplied filename into a
 * storage key is how traversal and overwrite bugs are born. The real filename
 * travels in `clientPayload` and is stored as data — where it also earns its
 * keep, since publisher downloads are routinely named after their DOI.
 */
export async function uploadToInbox(file: File): Promise<void> {
  const { upload } = await import('@vercel/blob/client');
  await upload(INBOX_BLOB_PATH, file, {
    access: 'private',
    contentType: 'application/pdf',
    handleUploadUrl: '/api/pdf-inbox-upload',
    clientPayload: JSON.stringify({ filename: file.name }),
  });
}
