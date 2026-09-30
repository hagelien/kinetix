import type {
  ReferenceConcentrationInput,
  ReferenceConcentrationUpdateInput,
  ReferenceMatrix,
  ReferenceScenario,
  ReferenceUnit,
} from './referenceConcentrations';

export interface ReferenceCitationSummary {
  id: number;
  type: 'freetext' | 'url' | 'pmid' | 'doi' | string;
  identifier: string;
  metadata: {
    title?: string;
    authors?: string;
    journal?: string;
    year?: number | string;
    volume?: string;
    pages?: string;
  } | null;
}

export interface ReferenceConcentrationRow {
  id: number;
  drugId: number;
  low: number | null;
  high: number | null;
  unit: ReferenceUnit;
  matrix: ReferenceMatrix;
  scenario: ReferenceScenario;
  n: number | null;
  comments: string | null;
  /**
   * Facts about the reading itself, split out of `comments` by migration 0120.
   * Optional: this legacy view predates the column and every row it writes
   * leaves it NULL.
   */
  observationContext?: string | null;
  citationId: number | null;
  citation: ReferenceCitationSummary | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

const REFERENCE_CONCENTRATION_BATCH_SIZE = 100;

export async function fetchReferenceConcentrations(
  drugId: number,
  opts?: {
    matrix?: ReferenceMatrix;
    scenario?: ReferenceScenario;
    fresh?: boolean;
  },
): Promise<ReferenceConcentrationRow[]> {
  const sp = new URLSearchParams({ drugId: String(drugId) });
  if (opts?.matrix) sp.set('matrix', opts.matrix);
  if (opts?.scenario) sp.set('scenario', opts.scenario);
  if (opts?.fresh) sp.set('fresh', '1');

  const url = `/api/reference-concentrations?${sp.toString()}`;
  const res = opts?.fresh
    ? await fetch(url, { cache: 'no-store' })
    : await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch reference concentrations: ${res.status}`);
  }
  const data = (await res.json()) as { items: ReferenceConcentrationRow[] };
  return data.items;
}

export async function fetchReferenceConcentrationsBatch(
  drugIds: readonly number[],
  opts?: { matrix?: ReferenceMatrix; scenario?: ReferenceScenario },
): Promise<Record<number, ReferenceConcentrationRow[]>> {
  const uniqueDrugIds = [...new Set(drugIds)].filter((drugId) =>
    Number.isInteger(drugId),
  );
  if (uniqueDrugIds.length === 0) return {};

  const chunks: number[][] = [];
  for (
    let i = 0;
    i < uniqueDrugIds.length;
    i += REFERENCE_CONCENTRATION_BATCH_SIZE
  ) {
    chunks.push(uniqueDrugIds.slice(i, i + REFERENCE_CONCENTRATION_BATCH_SIZE));
  }
  const fetchChunk = (chunk: readonly number[]) =>
    fetchReferenceConcentrationsBatchChunk(chunk, opts);
  const chunkResults =
    chunks.length === 1
      ? [await fetchChunk(chunks[0]!)]
      : await Promise.all(chunks.map(fetchChunk));
  const itemsByDrugId = Object.assign({}, ...chunkResults) as Record<
    string,
    ReferenceConcentrationRow[]
  >;
  return Object.fromEntries(
    uniqueDrugIds.map((drugId) => [
      drugId,
      itemsByDrugId[String(drugId)] ?? [],
    ]),
  );
}

async function fetchReferenceConcentrationsBatchChunk(
  drugIds: readonly number[],
  opts?: { matrix?: ReferenceMatrix; scenario?: ReferenceScenario },
): Promise<Record<string, ReferenceConcentrationRow[]>> {
  const sp = new URLSearchParams({ drugIds: drugIds.join(',') });
  if (opts?.matrix) sp.set('matrix', opts.matrix);
  if (opts?.scenario) sp.set('scenario', opts.scenario);

  const res = await fetch(`/api/reference-concentrations?${sp.toString()}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch reference concentrations: ${res.status}`);
  }
  const data = (await res.json()) as {
    itemsByDrugId: Record<string, ReferenceConcentrationRow[]>;
  };
  return data.itemsByDrugId;
}

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

export async function createReferenceConcentration(
  input: ReferenceConcentrationInput,
): Promise<ReferenceConcentrationRow> {
  const res = await fetch('/api/reference-concentrations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(
      await readErrorMessage(
        res,
        `Failed to create reference concentration: ${res.status}`,
      ),
    );
  }
  const data = (await res.json()) as { item: ReferenceConcentrationRow };
  return data.item;
}

export async function updateReferenceConcentration(
  id: number,
  input: ReferenceConcentrationUpdateInput,
): Promise<ReferenceConcentrationRow> {
  const res = await fetch(`/api/reference-concentrations?id=${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    throw new Error(
      await readErrorMessage(
        res,
        `Failed to update reference concentration: ${res.status}`,
      ),
    );
  }
  const data = (await res.json()) as { item: ReferenceConcentrationRow };
  return data.item;
}

export async function deleteReferenceConcentration(id: number): Promise<void> {
  const res = await fetch(`/api/reference-concentrations?id=${id}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error(
      await readErrorMessage(
        res,
        `Failed to delete reference concentration: ${res.status}`,
      ),
    );
  }
}
