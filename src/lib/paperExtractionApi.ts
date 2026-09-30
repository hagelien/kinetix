/**
 * Client for the paper fact-extraction queue (`/api/paper-extractions`).
 *
 * Editors queue an uploaded full-text paper here; a scheduled agent drains the
 * queue, reads each PDF, and files the paper's facts as `wiki_fact` pending
 * edits on the monographs and wiki pages they belong to.
 */
import type { CitationRow } from '@/lib/referencesApi';
import type { PaperExtractionStatus } from '@/lib/paperExtraction';

export interface PaperExtractionJob {
  id: number;
  citationId: number;
  status: PaperExtractionStatus | string;
  scopeNote: string | null;
  targetDrugIds: number[] | null;
  requestedBy: number | null;
  claimedBy: number | null;
  claimedAt: string | null;
  attempts: number;
  lastError: string | null;
  resultSummary: string | null;
  factsSubmitted: number | null;
  pendingEditIds: number[] | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  citationType: CitationRow['type'];
  citationIdentifier: string;
  citationMetadata: CitationRow['metadata'];
  requestedByUsername: string | null;
  claimedByUsername: string | null;
  hasPaperReview: boolean;
}

export class PaperExtractionApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = 'PaperExtractionApiError';
  }
}

async function readError(res: Response): Promise<PaperExtractionApiError> {
  const data = (await res.json().catch(() => ({}))) as { code?: string };
  return new PaperExtractionApiError(
    data.code ?? `http_${res.status}`,
    res.status,
  );
}

/** Adapt a queue row into the CitationRow shape the citation formatters take. */
export function jobCitation(job: PaperExtractionJob): CitationRow {
  return {
    id: job.citationId,
    drugId: null,
    type: job.citationType,
    identifier: job.citationIdentifier,
    metadata: job.citationMetadata,
    createdAt: job.createdAt,
  };
}

export async function fetchPaperExtractionJobs(options?: {
  status?: PaperExtractionStatus | 'open';
}): Promise<PaperExtractionJob[]> {
  const params = new URLSearchParams();
  if (options?.status) params.set('status', options.status);
  const query = params.toString();
  const res = await fetch(
    `/api/paper-extractions${query ? `?${query}` : ''}`,
  );
  // Throw on a non-2xx so the queue page shows its error state rather than an
  // empty list that reads as "nothing queued".
  if (!res.ok) throw await readError(res);
  const data = (await res.json()) as { jobs?: PaperExtractionJob[] };
  return data.jobs ?? [];
}

export async function enqueuePaperExtraction(
  citationId: number,
  input: { scopeNote?: string; targetDrugIds?: number[] } = {},
): Promise<PaperExtractionJob> {
  const body: Record<string, unknown> = {};
  if (input.scopeNote?.trim()) body.scopeNote = input.scopeNote.trim();
  if (input.targetDrugIds?.length) body.targetDrugIds = input.targetDrugIds;

  const res = await fetch(`/api/paper-extractions?citationId=${citationId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  const data = (await res.json()) as { job: PaperExtractionJob };
  return data.job;
}

export async function updatePaperExtractionJob(
  id: number,
  payload: { action: 'cancel'; reason?: string } | { action: 'requeue' },
): Promise<PaperExtractionJob> {
  const res = await fetch(`/api/paper-extractions?id=${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await readError(res);
  const data = (await res.json()) as { job: PaperExtractionJob };
  return data.job;
}
