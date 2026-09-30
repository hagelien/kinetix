export interface ReferenceMetadata {
  title: string;
  authors: string[];
  journal: string;
  year: number | null;
  volume: string | null;
  pages: string | null;
}

export interface ReferenceRow {
  id: number;
  drugId: number | null;
  type: 'freetext' | 'url' | 'pmid' | 'doi';
  identifier: string;
  metadata: ReferenceMetadata | null;
  createdBy: number | null;
  createdAt: string;
  /**
   * Whether this citation carries a read-in-full paper review, as of the
   * response that produced this row. Supplied by the pending-edits payload so a
   * review card can name the paper that still needs reading; absent elsewhere.
   */
  readInFull?: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  // Read the body defensively. A failure surfaced by the platform rather than
  // the app — a gateway timeout, a proxy error page, a 413 — can arrive as HTML
  // or an empty body, and calling `res.json()` on that throws a SyntaxError.
  // Because the throw escapes before the `res.ok` check, the real HTTP status
  // never reaches the caller: a 401/429/502 would surface as an opaque
  // "failed to save" instead of an actionable error. Parse the text ourselves
  // and tolerate a non-JSON body so the status (and any `code`) always survive.
  const raw = await res.text();
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const errorData =
      data && typeof data === 'object'
        ? (data as { error?: unknown; code?: unknown })
        : {};
    const message =
      typeof errorData.error === 'string'
        ? errorData.error
        : `Request failed (${res.status})`;
    const code =
      typeof errorData.code === 'string' ? errorData.code : undefined;
    throw new ApiError(message, res.status, code);
  }
  return data as T;
}

export async function resolveReference(
  type: string,
  identifier: string,
): Promise<{ metadata: ReferenceMetadata | null; error?: string }> {
  return apiFetch('/api/references-resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, identifier }),
  });
}

export async function createReference(data: {
  drugId?: number | null;
  type: string;
  identifier: string;
  metadata?: ReferenceMetadata | null;
}): Promise<{ reference: ReferenceRow }> {
  return apiFetch('/api/references', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function fetchReferences(
  drugId: number,
): Promise<{ references: ReferenceRow[] }> {
  return apiFetch(`/api/references?drugId=${drugId}`);
}

export async function fetchReferencesByIds(
  ids: number[],
): Promise<{ references: ReferenceRow[] }> {
  const uniqueIds = [...new Set(ids)].filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  if (uniqueIds.length === 0) return { references: [] };

  const params = new URLSearchParams({ ids: uniqueIds.join(',') });
  return apiFetch(`/api/references?${params}`);
}

export function referenceModulePath(id: number): string {
  return `/references/${id}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeAuthors(input: unknown): string[] {
  if (Array.isArray(input)) return input.filter(isNonEmptyString);
  if (typeof input === 'string')
    return input
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  return [];
}

function encodeDoiPathSegment(segment: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}

export function formatReference(ref: ReferenceRow): string {
  if (ref.metadata && typeof ref.metadata === 'object') {
    const m = ref.metadata as unknown as Record<string, unknown>;
    const authorsList = normalizeAuthors(m.authors);
    const authors =
      authorsList.length > 3
        ? `${authorsList.slice(0, 3).join(', ')}, et al.`
        : authorsList.join(', ');
    const title = isNonEmptyString(m.title) ? m.title.trim() : '';
    const journal = isNonEmptyString(m.journal) ? m.journal.trim() : '';
    const year =
      typeof m.year === 'number' && Number.isFinite(m.year) ? m.year : null;
    const volume = isNonEmptyString(m.volume) ? m.volume.trim() : '';
    const pages = isNonEmptyString(m.pages) ? m.pages.trim() : '';
    const parts: string[] = [];
    if (authors) parts.push(authors);
    if (title) parts.push(`"${title}"`);
    if (journal) parts.push(journal + '.');
    if (year !== null) parts.push(String(year));
    if (volume) {
      let vol = `;${volume}`;
      if (pages) vol += `:${pages}`;
      parts.push(vol + '.');
    }
    if (ref.type === 'pmid') parts.push(`PMID: ${ref.identifier}`);
    if (ref.type === 'doi') parts.push(`DOI: ${ref.identifier}`);
    return parts.join(' ');
  }
  if (ref.type === 'url') return ref.identifier;
  return ref.identifier;
}

export function referenceExternalHref(
  ref: Pick<ReferenceRow, 'type' | 'identifier'>,
): string | null {
  const id = ref.identifier?.trim();
  if (!id) return null;
  if (ref.type === 'doi') {
    const cleaned = id
      .replace(/^doi:\s*/i, '')
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
    const encoded = cleaned.split('/').map(encodeDoiPathSegment).join('/');
    return `https://doi.org/${encoded}`;
  }
  if (ref.type === 'pmid') {
    const numeric = id.replace(/\D+/g, '');
    if (!numeric) return null;
    return `https://pubmed.ncbi.nlm.nih.gov/${numeric}/`;
  }
  if (ref.type === 'url') {
    try {
      const url = new URL(id);
      return url.protocol === 'http:' || url.protocol === 'https:' ? id : null;
    } catch {
      return null;
    }
  }
  return null;
}
