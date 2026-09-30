import type { CmaxSummary } from './cmaxNormalization';
import type { DoseContextFields } from './entryDoseContext';
/**
 * Frontend client for /api/parameter-entries (Phase 4). Mirrors
 * referenceConcentrationsApi: bare fetch against relative paths, hand-declared
 * types, `{ error }` bodies. The aggregate summary comes from the drug object
 * (drug.parameterSummaries); this client is for the raw per-source entries.
 */
export interface EntryCitationSummary {
  id: number;
  type: string;
  identifier: string;
  metadata: unknown;
}

export interface ParameterEntryRow {
  id: number;
  parameter: string;
  low: number | null;
  high: number | null;
  median: number | null;
  qualifier: string | null;
  // The declared pick-list value for a model-structure axis (dispositionModel /
  // eliminationModel / absorptionModel, CV-1b); null for every numeric entry,
  // whose value lives in low/high/median instead.
  categoricalValue: string | null;
  unit: string;
  // The administration route this entry is scoped to (a kinetics-core RouteId),
  // for a route-scoped (`ka`) or route-optional (`absorptionModel`) parameter;
  // null for a drug-level entry (CV-2c / CV-2c-4).
  route: string | null;
  // Null for a matrix-/scenario-independent parameter (half-life, logP, B/P,
  // protein binding, …) — only concentration values carry those dimensions.
  matrix: string | null;
  scenario: string | null;
  n: number | null;
  comments: string | null;
  // Facts about the reading itself (dose, fed/fasted state, population, assay
  // method) — part of what a stored source quote is evidence for, unlike
  // `comments` (curator commentary about the row). Null for every entry
  // written before migration 0120, and for one where nobody recorded it since.
  observationContext: string | null;
  // The verbatim text this entry's value was read off (migration 0119); null
  // for every entry written before the field existed.
  sourceQuote: string | null;
  /**
   * Structured dose context and reported statistic (Cmax dose-context RFC),
   * or null for every entry of a parameter that does not carry one.
   */
  doseContext?: DoseContextFields | null;
  origin: string;
  citationId: number | null;
  citation: EntryCitationSummary | null;
}

/** Error carrying the API's stable `code` so callers can translate via t(). */
export class ParameterEntryApiError extends Error {
  code?: string;
  status: number;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ParameterEntryApiError';
    this.status = status;
    this.code = code;
  }
}

async function toApiError(res: Response): Promise<ParameterEntryApiError> {
  try {
    const data = (await res.json()) as { error?: string; code?: string };
    return new ParameterEntryApiError(
      data.error ?? `Request failed (${res.status})`,
      res.status,
      data.code,
    );
  } catch {
    return new ParameterEntryApiError(`Request failed (${res.status})`, res.status);
  }
}

export async function fetchParameterEntries(
  drugId: number,
  opts?: { parameter?: string; fresh?: boolean },
): Promise<ParameterEntryRow[]> {
  const sp = new URLSearchParams({ drugId: String(drugId) });
  if (opts?.parameter) sp.set('parameter', opts.parameter);
  // `fresh` has to be part of the URL, not just a fetch option: `cache:
  // 'no-store'` only bypasses the BROWSER cache, while this endpoint's public
  // response is also held by the CDN (s-maxage, stale-while-revalidate). An
  // editor hitting the cached copy got a source list that lagged the plot above
  // it — up to and including an empty list under a plot full of sources, right
  // after seeding. The flag both keys a separate edge entry and tells the origin
  // to answer no-store, so the edge never serves this variant from cache.
  if (opts?.fresh) sp.set('fresh', '1');
  const res = await fetch(`/api/parameter-entries?${sp.toString()}`, {
    ...(opts?.fresh ? { cache: 'no-store' as const } : {}),
  });
  if (!res.ok) throw await toApiError(res);
  const data = (await res.json()) as { items: ParameterEntryRow[] };
  return data.items;
}

export interface ParameterEntryWriteInput {
  drugId: number;
  parameter: string;
  low?: number;
  high?: number;
  median?: number;
  qualifier?: string;
  /** The chosen axis value for a categorical model-structure entry (CV-1b). */
  categoricalValue?: string;
  unit: string;
  /** The administration route (a kinetics-core RouteId) for a route-scoped/route-optional
   *  parameter; omitted for a drug-level entry (CV-2c / CV-2c-4). */
  route?: string;
  /** Omitted for matrix-independent parameters. */
  matrix?: string;
  /** Omitted for parameters with no interpretive scenario. */
  scenario?: string;
  n?: number;
  comments?: string;
  /**
   * Facts about the reading itself (dose, fed/fasted state, population, assay
   * method) — part of what a stored source quote is evidence for. Distinct
   * from `comments`, which is curator commentary about the row and is never
   * evidence for anything.
   *
   * Three states, same as `quote`: omitted PRESERVES the stored value (every
   * caller written before this field existed sends exactly this), `null`
   * CLEARS it, and text replaces it. A caller that means "no change" must
   * leave the key out; one that means "clear it" must send `null` explicitly
   * — `undefined` and `null` are not interchangeable here the way they are
   * for `comments`.
   */
  observationContext?: string | null;
  /**
   * The verbatim text this value was read off — the sentence, table cell or
   * caption in the cited source. Optional here, and enforced only at
   * agent-consensus auto-apply: a calculation-driving parameter proposed by an
   * agent is held for a human rather than published without one.
   */
  quote?: string | null;
  citationId: number;
  /**
   * The reported statistic, for any numeric parameter: the central number,
   * what it is (mean, median, …) and what `low`/`high` are (SD, range, …).
   * A labelled entry sends its centre here instead of `median`.
   */
  centralValue?: DoseContextFields['centralValue'];
  centralStatistic?: DoseContextFields['centralStatistic'];
  intervalKind?: DoseContextFields['intervalKind'];
  editSummary?: string;
  submitForReview?: boolean;
}

/**
 * A dose-context entry's write payload: the ordinary fields plus the dose
 * context (sent flat, as the API stores it).
 */
export type DoseContextEntryWriteInput = ParameterEntryWriteInput & DoseContextFields;

export interface EntryWriteResult {
  id?: number;
  pending?: boolean;
  pendingEditId?: number;
}

export async function createParameterEntry(
  input: ParameterEntryWriteInput,
): Promise<EntryWriteResult> {
  const res = await fetch('/api/parameter-entries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as EntryWriteResult;
}

export async function updateParameterEntry(
  id: number,
  input: Omit<ParameterEntryWriteInput, 'drugId' | 'parameter'>,
): Promise<EntryWriteResult> {
  const res = await fetch(`/api/parameter-entries?id=${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as EntryWriteResult;
}

export async function deleteParameterEntry(
  id: number,
  opts?: { submitForReview?: boolean },
): Promise<void> {
  const sp = new URLSearchParams({ id: String(id) });
  if (opts?.submitForReview) sp.set('submitForReview', 'true');
  const res = await fetch(`/api/parameter-entries?${sp.toString()}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw await toApiError(res);
}

/**
 * The dose-normalized Cmax summary for a drug, derived at read time on the
 * server (`?summary=cmax`) by the same pure normalizer the tests pin.
 */
/**
 * The per-dose view's data: the summary and the Cmax rows it was computed
 * from, read as one snapshot and cached as one response, so the two can never
 * disagree.
 */
export interface CmaxView {
  summary: CmaxSummary;
  items: ParameterEntryRow[];
}

export async function fetchCmaxSummary(
  drugId: number,
  opts?: { fresh?: boolean },
): Promise<CmaxView> {
  const sp = new URLSearchParams({ drugId: String(drugId), summary: 'cmax' });
  if (opts?.fresh) sp.set('fresh', '1');
  const res = await fetch(`/api/parameter-entries?${sp.toString()}`, {
    ...(opts?.fresh ? { cache: 'no-store' as const } : {}),
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as CmaxView;
}
