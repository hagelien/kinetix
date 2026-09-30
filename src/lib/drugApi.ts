import type { DrugComponent, NumericRange } from '@/types';
import type { MethodMatrix, MethodType } from '@/lib/methodMatrices';
import type { ParameterSummary } from '@/lib/parameterEntryAggregation';
import type { IonizationConstant } from '@/lib/ionizationConstants';
import {
  parameterRequiresReference,
  type DrugParameterId,
} from '@/lib/drugParameters';
import {
  discussionHostParams,
  type DiscussionHost,
  type FactDiscussionTargetKey,
} from '@/lib/discussionTargets';
import type {
  DrugMetabolism,
  EliminationRouteKind,
  MetabolismEnzyme,
  MetabolismFractionRange,
} from '@/lib/metabolism';
import type {
  DrugReceptorTargetSummary,
  ReceptorTargetSummary,
} from '@/lib/receptorTargets';
import { buildDrugSearchKey } from '@/lib/drugNames';
import { buildDrugComponentId } from '@/lib/drugComponentId';
import {
  invalidateDrugIndicators,
  invalidateWikiPageIndicators,
} from '@/lib/drugIndicatorsApi';
import type { UserBadgeData } from '@/components/ui/UserBadge';

export interface DrugRow {
  id: number;
  slug: string;
  names: Record<string, string>;
  nameShort: string | null;
  aliases: string[] | null;
  pubchemCid: number | null;
  /**
   * Farmakologiportalen content path for this substance, e.g.
   * '/content/757/Morfin-3-glukuronid-M3G'. Null when the portal has no
   * counterpart (or none has been matched yet). Render it through
   * `farmakologiportalenUrl` — never interpolate it into an href directly.
   */
  farmakologiportalenPath?: string | null;
  molecularWeight: number | null;
  halfLife: NumericRange | null;
  volumeOfDistribution: NumericRange | null;
  bioavailability: NumericRange | null;
  proteinBinding: NumericRange | null;
  bloodPlasmaRatio: NumericRange | null;
  tmax: NumericRange | null;
  pKa: NumericRange | null;
  therapeuticConcentration?: NumericRange | null;
  supratherapeuticConcentration?: NumericRange | null;
  impairmentConcentration?: NumericRange | null;
  toxicConcentration?: NumericRange | null;
  fatalConcentration?: NumericRange | null;
  popularityScore: number;
  searchKey: string | null;
  monographSlug?: string | null;
  metabolism?: DrugMetabolism | null;
  receptorTargets?: DrugReceptorTargetSummary[];
  /** Structured ionization profile (single-drug reads); supersedes scalar pKa. */
  ionizationConstants?: IonizationConstant[];
  /** Aggregated multi-value summaries keyed by parameter (single-drug reads). */
  parameterSummaries?: Record<string, ParameterSummary>;
  /**
   * Per-route pools for the route-optional parameters (F, Tmax — CV-2c-4), keyed parameter →
   * `RouteId`. Deliberately separate from `parameterSummaries`: a route's F is not the drug's F,
   * so it never pools into the headline. It is carried so the UI can SHOW a route-labelled value
   * rather than an em dash once a curator moves a drug's only entries onto a route.
   */
  parameterRouteSummaries?: Record<string, Record<string, ParameterSummary>>;
  createdAt: string;
  updatedAt: string;
}

export interface DrugSearchRow {
  id: number;
  slug: string;
  names: Record<string, string>;
  nameShort: string | null;
  aliases: string[] | null;
  pubchemCid: number | null;
}

// Re-exported from the shared vocabulary so the API and the app cannot drift.
export type { MethodMatrix, MethodType };

export interface MethodRow {
  id: number;
  code: string;
  name: string;
  description: string | null;
  matrices: MethodMatrix[];
  volumeMl: number | null;
  methodType: MethodType | null;
  componentCount: number;
  drugIds: number[];
  pubchemCids: number[];
}

export interface MethodComponentRow {
  drugId: number;
  /** The sheet's "Påvisn." limit. A limit-type name, not a definition (#1058). */
  lor: number | null;
  /** The sheet's "MKK" limit — not necessarily the LLOQ (#1058). */
  mkk: number | null;
  /** The sheet's "Terskel" limit. A limit-type name, not a definition (#1058). */
  lod: number | null;
  unit: string | null;
  measurementUncertainty: number | null;
  sortOrder: number;
  slug: string;
  names: Record<string, string>;
  nameShort: string | null;
  pubchemCid: number | null;
  /** Molecular weight (g/mol) — enables molar↔mass conversion tooltips. */
  molecularWeight: number | null;
}

export interface MethodDetail {
  id: number;
  code: string;
  name: string;
  description: string | null;
  matrices: MethodMatrix[];
  volumeMl: number | null;
  methodType: MethodType | null;
  createdAt: string;
  updatedAt: string;
  components: MethodComponentRow[];
}

export interface MethodComponentInput {
  drugId: number;
  lor?: number | null;
  mkk?: number | null;
  lod?: number | null;
  unit?: string | null;
  measurementUncertainty?: number | null;
}

export interface MethodInput {
  code: string;
  name: string;
  description?: string | null;
  matrices?: MethodMatrix[];
  volumeMl?: number | null;
  methodType?: MethodType | null;
  components?: MethodComponentInput[];
}

export interface MethodsResponse {
  methods: MethodRow[];
  gated?: boolean;
}

export interface DrugParameterRevisionSourceDiffEntry {
  citationId: number;
  /** Best-effort title, snapshotted when the diff was computed; null if unresolvable. */
  label: string | null;
}

export interface DrugParameterRevisionSourceDiff {
  added: DrugParameterRevisionSourceDiffEntry[];
  removed: DrugParameterRevisionSourceDiffEntry[];
}

/** One agent's approve/dispute/abstain verdict on a revision (#1358). */
export interface DrugParameterRevisionVerificationDTO {
  id: number;
  verdict: 'approve' | 'dispute' | 'abstain';
  rationaleMd: string;
  isImplicit: boolean;
  createdAt: string;
  /** Bumped whenever the agent re-casts; used to tell a live `dispute`
   *  verdict apart from one a resolved mirror already answered (#1393). */
  updatedAt: string;
  agent: { id: number; slug: string; name: string } | null;
}

/** One human or agent dispute raised against a revision (#1358). */
export interface DrugParameterRevisionDisputeDTO {
  id: number;
  source: 'human' | 'agent';
  reasonMd: string;
  status: string;
  createdAt: string;
  /** Set to the resolution time when `status` is `resolved` (#1393). */
  updatedAt: string;
  author: { id: number; name: string | null; agentSlug: string | null } | null;
}

export interface DrugParameterRevisionDTO {
  id: number;
  oldValue: unknown;
  newValue: unknown;
  editSummary: string | null;
  /** Citations pooled into this revision's aggregate, oldest revision first. */
  referenceIds?: number[] | null;
  /** Which of those citations were newly added/removed vs. the prior revision. */
  sourceDiff?: DrugParameterRevisionSourceDiff | null;
  /** Set when this revision is the applied result of a reviewed `param_entry`
   * pending edit — also the id to fetch that edit's agent verdicts for (#1358). */
  pendingEditId?: number | null;
  createdAt: string;
  author: ({ id: number } & UserBadgeData) | null;
  /** Server includes approval summary on the history endpoint (#344, #361). */
  approvals?: import('@/lib/approvalsApi').ApprovalSummary;
  /**
   * Agent verdict tally for `pendingEditId`, present only when both a
   * pending edit produced this revision AND the requester may see its
   * verdicts (reviewers, its own agent verifiers — never an anonymous
   * caller). Absence means there is nothing to show, not that nobody looked.
   */
  verifications?: import('@/lib/agentVerificationsApi').AgentVerificationSummary;
  /**
   * Full approve/dispute/abstain verdicts recorded directly against this
   * revision (post-publication peer review, distinct from `verifications`'
   * pre-publication pending-edit tally), plus disputes raised against it —
   * the review "round" #1358 asked to see (#1363).
   */
  reviewVerdicts?: DrugParameterRevisionVerificationDTO[];
  disputes?: DrugParameterRevisionDisputeDTO[];
}

export interface DrugDiscussionDTO {
  id: number;
  /** Null for topic-page fact threads, which key off `wikiPageId` instead. */
  drugId: number | null;
  /** Null for drug-monograph threads. */
  wikiPageId?: number | null;
  parameter: string | null;
  parentId: number | null;
  body: string;
  createdAt: string;
  author: ({ id: number } & UserBadgeData) | null;
  /** Optional — server includes approval summary on the list endpoint (#344). */
  approvals?: import('@/lib/approvalsApi').ApprovalSummary;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** Stable error code the React boundary maps to a translated string. */
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  let data: Record<string, unknown>;
  try {
    data = await res.json();
  } catch {
    if (res.ok && res.status === 204) return undefined as T;
    throw new ApiError(`Request failed with status ${res.status}`, res.status);
  }
  if (!res.ok) {
    throw new ApiError(
      (data.error as string) ?? `Request failed with status ${res.status}`,
      res.status,
      typeof data.code === 'string' ? data.code : undefined,
    );
  }
  return data as T;
}

const inFlightDrugRequests = new Map<string, Promise<unknown>>();

function dedupeInFlight<T>(key: string, request: () => Promise<T>): Promise<T> {
  const existing = inFlightDrugRequests.get(key);
  if (existing) return existing as Promise<T>;

  const promise = request().finally(() => {
    if (inFlightDrugRequests.get(key) === promise) {
      inFlightDrugRequests.delete(key);
    }
  });
  inFlightDrugRequests.set(key, promise);
  return promise;
}

export async function fetchDrugs(params?: {
  sort?: 'popularity' | 'name' | 'molecularWeight';
  q?: string;
  methodId?: number;
  ids?: readonly number[];
  limit?: number;
  signal?: AbortSignal;
}): Promise<{ drugs: DrugRow[] }> {
  const sp = new URLSearchParams();
  if (params?.sort) sp.set('sort', params.sort);
  if (params?.q) sp.set('q', params.q);
  if (params?.methodId) sp.set('methodId', String(params.methodId));
  if (params?.ids?.length) sp.set('ids', params.ids.join(','));
  if (params?.limit) sp.set('limit', String(params.limit));
  const qs = sp.toString();
  return apiFetch(
    `/api/drugs${qs ? `?${qs}` : ''}`,
    params?.signal ? { signal: params.signal } : undefined,
  );
}

export async function fetchDrugsByIds(
  ids: readonly number[],
): Promise<{ drugs: DrugRow[] }> {
  const uniqueIds = [...new Set(ids)].filter((id) => Number.isInteger(id));
  if (uniqueIds.length === 0) return { drugs: [] };
  return fetchDrugs({ ids: uniqueIds, limit: uniqueIds.length });
}

export async function fetchDrugSearchResults(params: {
  q: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<{ drugs: DrugSearchRow[] }> {
  const sp = new URLSearchParams({
    view: 'search',
    q: params.q,
  });
  if (params.limit) sp.set('limit', String(params.limit));
  return apiFetch(
    `/api/drugs?${sp}`,
    params.signal ? { signal: params.signal } : undefined,
  );
}

/**
 * Fetch a drug row by internal id. Pass `fresh: true` to bypass the
 * browser/CDN cache — `/api/drugs?id=` is served with PUBLIC_DRUG_CACHE
 * headers (s-maxage=60, swr=600) which is right for the popularity-driven
 * sidebar/list views but wrong for callers (like WikiPage's inline
 * parameter-anchor hydration, #276 phase 1d) that need to reflect the
 * latest approved values immediately.
 */
export async function fetchDrugById(
  id: number,
  options?: { fresh?: boolean },
): Promise<{ drug: DrugRow }> {
  const fresh = options?.fresh === true;
  return dedupeInFlight(`drug:id:${id}:fresh:${fresh}`, () =>
    apiFetch(`/api/drugs?id=${id}`, fresh ? { cache: 'no-store' } : undefined),
  );
}

/**
 * Fetch a drug row by PubChem CID. See `fetchDrugById` for the semantics
 * of `fresh`.
 */
export async function fetchDrugByCid(
  cid: number,
  options?: { fresh?: boolean },
): Promise<{ drug: DrugRow }> {
  const fresh = options?.fresh === true;
  return dedupeInFlight(`drug:cid:${cid}:fresh:${fresh}`, () =>
    apiFetch(
      `/api/drugs?cid=${cid}`,
      fresh ? { cache: 'no-store' } : undefined,
    ),
  );
}

/**
 * Resolve a `wiki_pages.drugCid` value, which can be either the internal
 * drugs.id (modern rows) or a legacy PubChem CID. The server checks both
 * candidates in one query and rejects ambiguous collisions.
 */
export async function fetchDrugByWikiDrugId(
  wikiDrugId: number,
  options?: { fresh?: boolean },
): Promise<{ drug: DrugRow }> {
  const fresh = options?.fresh === true;
  return dedupeInFlight(`drug:wiki:${wikiDrugId}:fresh:${fresh}`, () =>
    apiFetch(
      `/api/drugs?wikiDrugId=${wikiDrugId}`,
      fresh ? { cache: 'no-store' } : undefined,
    ),
  );
}

export async function fetchDrugBySlug(
  slug: string,
): Promise<{ drug: DrugRow }> {
  return dedupeInFlight(`drug:slug:${slug}`, () =>
    apiFetch(`/api/drugs?slug=${encodeURIComponent(slug)}`),
  );
}

export async function fetchDrugComponentById(
  id: number,
): Promise<DrugComponent> {
  const { drug } = await fetchDrugById(id);
  return drugRowToComponent(drug);
}

export async function fetchDrugComponentByCid(
  cid: number,
): Promise<DrugComponent> {
  const { drug } = await fetchDrugByCid(cid);
  return drugRowToComponent(drug);
}

export async function fetchDrugComponentBySlug(
  slug: string,
): Promise<DrugComponent> {
  const { drug } = await fetchDrugBySlug(slug);
  return drugRowToComponent(drug);
}

export async function fetchMethods(): Promise<MethodsResponse> {
  const res = await fetch('/api/methods');
  let data: Record<string, unknown>;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Request failed with status ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(
      (data.error as string) ?? `Request failed with status ${res.status}`,
    );
  }
  return data as unknown as MethodsResponse;
}

export async function fetchMethodDetail(
  id: number,
): Promise<{ method: MethodDetail }> {
  return apiFetch(`/api/methods?id=${id}`);
}

/**
 * One analytical method that includes a given drug, carrying that drug's
 * per-method reporting figures, surfaced as the "Fra metoder" rows in the
 * monograph sidebar's analytics-and-detection section. `lor` (Påvisn.), `mkk`
 * (MKK) and `lod` (Terskel) carry the sheet's limit-type names, which tell the
 * limits apart without defining them (#1058) — none is presented as an LOD,
 * LOQ or LLOQ.
 */
export interface MethodLimitForDrug {
  id: number;
  code: string;
  name: string;
  methodType: MethodType | null;
  matrices: MethodMatrix[];
  lor: number | null;
  mkk: number | null;
  lod: number | null;
  unit: string | null;
  measurementUncertainty: number | null;
}

export async function fetchMethodLimitsForDrug(
  drugId: number,
): Promise<{ methods: MethodLimitForDrug[]; gated?: boolean }> {
  return apiFetch(`/api/methods?drugId=${drugId}`);
}

export async function createMethod(
  input: MethodInput,
): Promise<{ method: MethodRow }> {
  return apiFetch('/api/methods', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function updateMethod(
  id: number,
  input: Partial<MethodInput>,
): Promise<{ method: MethodRow }> {
  return apiFetch(`/api/methods?id=${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function deleteMethod(id: number): Promise<{ ok: true }> {
  return apiFetch(`/api/methods?id=${id}`, { method: 'DELETE' });
}

/**
 * Permanently delete a drug component (admin only). The server also removes
 * the drug's monograph wiki page and all FK-cascaded structured data
 * (parameters, metabolism, receptor targets, method components, …).
 */
export async function deleteDrug(
  id: number,
): Promise<{ ok: true; id: number }> {
  return apiFetch(`/api/drugs?id=${id}`, { method: 'DELETE' });
}

export async function updateDrugParameter(
  drugId: number,
  parameter: DrugParameterId,
  value: unknown,
  referenceIds: number[],
  editSummary?: string,
  options?: { submitForReview?: boolean },
): Promise<
  | { parameter: string; value: unknown }
  | { pending: true; pendingEditId: number }
> {
  // Identity/constant metadata (names, aliases, molecular mass, PubChem CID)
  // may be saved without a source; every other parameter must cite one.
  if (parameterRequiresReference(parameter) && !referenceIds.length)
    throw new Error('At least one reference is required');
  return apiFetch(
    `/api/drug-parameter?drugId=${drugId}&parameter=${encodeURIComponent(parameter)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value,
        editSummary,
        referenceId: referenceIds[0],
        referenceIds: referenceIds.length ? referenceIds : undefined,
        submitForReview: options?.submitForReview,
      }),
    },
  );
}

// ─── Metabolism ────────────────────────────────────────────────────────────

export interface MetabolismMetaboliteInput {
  metaboliteName: string;
  metaboliteDrugId?: number | null;
  conversionFraction?: MetabolismFractionRange | null;
  activity: 'active' | 'inactive' | 'unknown';
  evidenceNote?: string | null;
  referenceIds?: number[] | null;
}

export interface MetabolismPrecursorInput {
  precursorDrugId: number;
  precursorName?: string;
  conversionFraction?: MetabolismFractionRange | null;
  activity: 'active' | 'inactive' | 'unknown';
  evidenceNote?: string | null;
  referenceIds?: number[] | null;
}

export interface MetabolismRouteInput {
  kind: EliminationRouteKind;
  enzymeId?: number | null;
  label?: string | null;
  fraction?: MetabolismFractionRange | null;
  note?: string | null;
  referenceIds?: number[] | null;
}

export interface MetabolismProfileInput {
  evidenceNote?: string | null;
  referenceIds?: number[] | null;
}

export interface MetabolismWriteInput {
  profile: MetabolismProfileInput;
  routes: MetabolismRouteInput[];
  metabolites: MetabolismMetaboliteInput[];
  precursors: MetabolismPrecursorInput[];
  editSummary?: string;
  submitForReview?: boolean;
}

/** Typeahead over the canonical enzyme catalog (api/enzymes). */
export async function fetchEnzymeSearch(opts: {
  q: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<{ enzymes: MetabolismEnzyme[] }> {
  const params = new URLSearchParams({ q: opts.q });
  if (opts.limit) params.set('limit', String(opts.limit));
  return apiFetch(`/api/enzymes?${params.toString()}`, { signal: opts.signal });
}

/**
 * Replace a drug's metabolism box. Contributor+ submissions are queued for
 * review (`{ pending: true }`); admins write directly unless they pass
 * `submitForReview`. The payload is full-replace — send the complete state.
 */
export async function submitDrugMetabolism(
  drugId: number,
  input: MetabolismWriteInput,
): Promise<
  | { metabolism: DrugMetabolism | null }
  | { pending: true; pendingEditId: number }
> {
  return apiFetch(`/api/drug-metabolism?drugId=${drugId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

// ─── Receptor-target mechanisms (pharmacodynamics box) ──────────────────────

/** One quantitative measurement on a mechanism (binding/potency/efficacy). */
export interface MechanismMeasurementInput {
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
  unit?: string;
  note?: string;
}

export interface ReceptorMechanismInput {
  /** Link an existing catalog target, or create one from symbol + name. */
  receptorTargetId?: number | null;
  targetSymbol?: string;
  targetName?: string;
  interactionType: string;
  tier?: 'primary' | 'secondary' | 'tertiary' | null;
  affinity?: MechanismMeasurementInput | null;
  potency?: MechanismMeasurementInput | null;
  efficacy?: MechanismMeasurementInput | null;
  ki?: MechanismMeasurementInput | null;
  ic50?: MechanismMeasurementInput | null;
  ec50?: MechanismMeasurementInput | null;
  emax?: MechanismMeasurementInput | null;
  selectivityRatio?: MechanismMeasurementInput | null;
  /** Species the measurements were made in (#1017); null/absent = unstated. */
  assaySpecies?: string | null;
  referenceIds?: number[] | null;
  evidenceNote?: string | null;
}

export interface ReceptorTargetsWriteInput {
  mechanisms: ReceptorMechanismInput[];
  editSummary?: string;
  submitForReview?: boolean;
}

/**
 * Replace a drug's receptor-target mechanisms. Contributor+ submissions are
 * queued for review (`{ pending: true }`); admins write directly unless they
 * pass `submitForReview`. The payload is full-replace — send the complete set.
 */
export async function submitDrugReceptorTargets(
  drugId: number,
  input: ReceptorTargetsWriteInput,
): Promise<
  | { receptorTargets: DrugReceptorTargetSummary[] }
  | { pending: true; pendingEditId: number }
> {
  return apiFetch(`/api/drug-receptor-targets?drugId=${drugId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** Search the receptor-target catalog by symbol/name for the mechanism picker. */
export async function searchReceptorTargets(
  query: string,
): Promise<ReceptorTargetSummary[]> {
  const { targets } = await apiFetch<{ targets: ReceptorTargetSummary[] }>(
    `/api/receptor-targets?q=${encodeURIComponent(query)}`,
  );
  return targets;
}

export async function fetchDrugParameterHistory(
  drugId: number,
  parameter: DrugParameterId,
): Promise<{ revisions: DrugParameterRevisionDTO[] }> {
  return apiFetch(
    `/api/drug-parameter-history?drugId=${drugId}&parameter=${encodeURIComponent(parameter)}`,
  );
}

export async function fetchDiscussions(
  host: DiscussionHost,
  parameter?: DrugParameterId | FactDiscussionTargetKey | null,
): Promise<{ discussions: DrugDiscussionDTO[] }> {
  const sp = discussionHostParams(host);
  if (parameter) sp.set('parameter', parameter);
  return apiFetch(`/api/drug-discussions?${sp}`);
}

export async function postDiscussion(
  host: DiscussionHost,
  body: string,
  parameter?: DrugParameterId | FactDiscussionTargetKey | null,
  parentId?: number,
): Promise<{ discussion: DrugDiscussionDTO }> {
  const sp = discussionHostParams(host);
  if (parameter) sp.set('parameter', parameter);
  const result = await apiFetch<{ discussion: DrugDiscussionDTO }>(
    `/api/drug-discussions?${sp}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, parentId }),
    },
  );
  if ('drugId' in host) {
    invalidateDrugIndicators(host.drugId);
  } else {
    invalidateWikiPageIndicators(host.wikiPageId);
  }
  return result;
}

export async function trackDrugInteraction(
  drugId: number,
  eventType: 'view' | 'wiki_open' | 'simulator_open' | 'edit',
): Promise<void> {
  try {
    await fetch(`/api/drug-track?drugId=${drugId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType }),
      keepalive: true,
    });
  } catch {
    // Fire and forget.
  }
}

const DRUG_ROW_COMPONENT_FIELDS = new Set([
  'id',
  'slug',
  'names',
  'nameShort',
  'aliases',
  'pubchemCid',
  'molecularWeight',
  'halfLife',
  'volumeOfDistribution',
  'bioavailability',
  'proteinBinding',
  'bloodPlasmaRatio',
  'tmax',
  'pKa',
  'therapeuticConcentration',
  'supratherapeuticConcentration',
  'impairmentConcentration',
  'toxicConcentration',
  'fatalConcentration',
  'popularityScore',
  'searchKey',
  'monographSlug',
  'metabolism',
  'receptorTargets',
  'createdAt',
  'updatedAt',
]);

/**
 * Adapt a DrugRow from the API into the legacy DrugComponent shape so the
 * existing DrugTable / stores keep working without an invasive refactor.
 */
export function drugRowToComponent(row: DrugRow): DrugComponent {
  const names = row.names ?? {};
  const aliases = row.aliases ?? undefined;
  const component: DrugComponent = {
    id: buildDrugComponentId(row),
    names,
    nameShort: row.nameShort ?? undefined,
    aliases,
    pubchemCid: row.pubchemCid ?? undefined,
    molecularWeight: row.molecularWeight ?? undefined,
    halfLife: row.halfLife ?? undefined,
    volumeOfDistribution: row.volumeOfDistribution ?? undefined,
    bioavailability: row.bioavailability ?? undefined,
    proteinBinding: row.proteinBinding ?? undefined,
    bloodPlasmaRatio: row.bloodPlasmaRatio ?? undefined,
    tmax: row.tmax ?? undefined,
    pKa: row.pKa ?? undefined,
    therapeuticConcentration: row.therapeuticConcentration ?? undefined,
    supratherapeuticConcentration:
      row.supratherapeuticConcentration ?? undefined,
    impairmentConcentration: row.impairmentConcentration ?? undefined,
    toxicConcentration: row.toxicConcentration ?? undefined,
    fatalConcentration: row.fatalConcentration ?? undefined,
    _searchKey:
      row.searchKey ??
      buildDrugSearchKey({
        names,
        nameShort: row.nameShort,
        aliases,
      }),
    _dbId: row.id,
    _monographSlug: row.monographSlug ?? undefined,
    _popularityScore: row.popularityScore,
  };
  const source = row as unknown as Record<string, unknown>;
  const target = component as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    if (!DRUG_ROW_COMPONENT_FIELDS.has(key) && value != null) {
      target[key] = value;
    }
  }
  return component;
}

export function drugSearchRowToComponent(row: DrugSearchRow): DrugComponent {
  const names = row.names ?? {};
  const aliases = row.aliases ?? undefined;
  return {
    id: buildDrugComponentId(row),
    names,
    nameShort: row.nameShort ?? undefined,
    aliases,
    pubchemCid: row.pubchemCid ?? undefined,
    _searchKey: buildDrugSearchKey({
      names,
      nameShort: row.nameShort,
      aliases,
    }),
    _dbId: row.id,
  };
}
