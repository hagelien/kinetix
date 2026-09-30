import type { BioEntityFunction, BioEntitySummary } from './bioEntities';
import type { EntityMetabolismDrug } from './metabolism';

/**
 * Client for the unified biological-entity catalog (#785). Backs the registry
 * admin UI and the shared entity search dropdown.
 */

export interface BioEntityInput {
  symbol: string;
  name: string;
  nameEn?: string | null;
  organism?: string | null;
  rank?: BioEntitySummary['rank'];
  parentId?: number | null;
  entityClass?: string | null;
  externalIds?: BioEntitySummary['externalIds'];
  functions?: BioEntityFunction[];
}

export type BioEntityUpdateInput = Partial<BioEntityInput>;

/** Optional review-flow extras a write request may carry. */
export interface BioEntityWriteOptions {
  editSummary?: string;
  /** Admins may opt to route the change through the review queue. */
  submitForReview?: boolean;
}

/**
 * Result of a catalog write. Contributor writes (and admin writes with
 * `submitForReview`) are queued for review and resolve to `pending`; admin
 * direct writes resolve with the saved `entity`.
 */
export type BioEntityWriteResult =
  | { pending: true; pendingEditId: number }
  | { pending: false; entity: BioEntitySummary };

async function readErrorMessage(
  res: Response,
  fallback: string,
): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error ?? fallback;
  } catch {
    return fallback;
  }
}

export interface SearchBioEntitiesOptions {
  function?: BioEntityFunction;
  limit?: number;
  signal?: AbortSignal;
}

/** Typeahead over the catalog, optionally restricted to one function. */
export async function searchBioEntities(
  query: string,
  options: SearchBioEntitiesOptions = {},
): Promise<BioEntitySummary[]> {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  if (options.function) params.set('function', options.function);
  if (options.limit) params.set('limit', String(options.limit));
  const res = await fetch(`/api/bio-entities?${params.toString()}`, {
    cache: 'no-store',
    signal: options.signal,
  });
  if (!res.ok) throw new Error(`Failed to search entities: ${res.status}`);
  const data = (await res.json()) as { entities: BioEntitySummary[] };
  return data.entities;
}

/** Full catalog (admin management view). */
export async function fetchAllBioEntities(): Promise<BioEntitySummary[]> {
  const res = await fetch('/api/bio-entities?view=all', { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch entities: ${res.status}`);
  const data = (await res.json()) as { entities: BioEntitySummary[] };
  return data.entities;
}

/**
 * The drugs the metabolism database links to this entity, most significant
 * dose share first. Backs the entity monograph's linked-components section.
 */
export async function fetchEntityMetabolismDrugs(
  entityId: number,
  signal?: AbortSignal,
): Promise<EntityMetabolismDrug[]> {
  const res = await fetch(`/api/bio-entities?metabolismDrugs=${entityId}`, {
    cache: 'no-store',
    signal,
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch linked drugs: ${res.status}`);
  }
  const data = (await res.json()) as { drugs: EntityMetabolismDrug[] };
  return data.drugs ?? [];
}

function readWriteResult(data: unknown): BioEntityWriteResult {
  const obj = (data ?? {}) as {
    pending?: boolean;
    pendingEditId?: number;
    entity?: BioEntitySummary;
  };
  if (obj.pending && typeof obj.pendingEditId === 'number') {
    return { pending: true, pendingEditId: obj.pendingEditId };
  }
  return { pending: false, entity: obj.entity as BioEntitySummary };
}

export async function createBioEntity(
  input: BioEntityInput,
  options: BioEntityWriteOptions = {},
): Promise<BioEntityWriteResult> {
  const res = await fetch('/api/bio-entities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, ...options }),
  });
  if (!res.ok) {
    throw new Error(
      await readErrorMessage(res, `Failed to create entity: ${res.status}`),
    );
  }
  return readWriteResult(await res.json());
}

export async function updateBioEntity(
  id: number,
  input: BioEntityUpdateInput,
  options: BioEntityWriteOptions = {},
): Promise<BioEntityWriteResult> {
  const res = await fetch(`/api/bio-entities?id=${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, ...options }),
  });
  if (!res.ok) {
    throw new Error(
      await readErrorMessage(res, `Failed to update entity: ${res.status}`),
    );
  }
  return readWriteResult(await res.json());
}

export async function deleteBioEntity(id: number): Promise<void> {
  const res = await fetch(`/api/bio-entities?id=${id}`, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(
      await readErrorMessage(res, `Failed to delete entity: ${res.status}`),
    );
  }
}
