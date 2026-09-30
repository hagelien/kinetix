/**
 * Client for the admin drug-merge endpoint (`/api/drug-merge`) and the drug
 * search it uses to pick the two entries. Types mirror `api/_lib/drug-merge.ts`.
 */
import { resolveDrugName } from './drugNames';

export interface DrugSearchResult {
  id: number;
  slug: string;
  names: Record<string, string>;
  nameShort: string | null;
  aliases: string[];
  pubchemCid: number | null;
}

export interface DrugMonographInfo {
  pageId: number;
  slug: string;
  hasContent: boolean;
  /** SHA-256 hex of the stored content; server-side fingerprint input. */
  contentDigest: string;
}

export interface DrugSideInfo {
  id: number;
  /**
   * Norwegian-first display name — kept for server-side prose in
   * `winnerReason`/`warnings`/`dataConflicts` fallbacks (English strings
   * the client rarely renders). React surfaces render `names` through
   * `drugSideDisplayName(side, language)` so headings, confirmation
   * prompts, and success toasts follow the caller's active i18n locale.
   */
  name: string;
  names: Record<string, string>;
  slug: string;
  pubchemCid: number | null;
  popularityScore: number;
  substanceClass: string;
  monograph: DrugMonographInfo | null;
}

export type DrugMergeConflictKind =
  | 'parameter'
  | 'applicability'
  | 'metabolism_profile';

export interface DrugMergeConflict {
  kind: DrugMergeConflictKind;
  key: string;
  id: string;
  winnerValue: unknown;
  loserValue: unknown;
}

export interface DrugMergeCounts {
  parametersMovedCleanly: number;
  parameterEntries: number;
  methodMembershipsMoved: number;
  methodMembershipsDeduped: number;
  metaboliteEdgesMoved: number;
  metaboliteEdgesDeduped: number;
  precursorLinksMoved: number;
  precursorLinksDeduped: number;
  receptorTargets: number;
  enzymeInteractions: number;
  eliminationRoutes: number;
  ionizationConstants: number;
  pmDistributions: number;
  atlasRows: number;
  wikiPagesRelinked: number;
}

export interface DrugMergeBlocker {
  parameter: string;
  reason: 'marker_vs_value' | 'substance_class';
}

export interface DrugMergeDataConflict {
  table: string;
  identity: string;
  message: DrugMergeTranslatableMessage;
}

/**
 * A message the UI localizes. `code` is an i18n key suffix under
 * `admin.drugMerge`, `params` are the interpolation values, and `fallback` is
 * the developer-facing English string rendered when the code has no entry in
 * the client's dictionary. See `messageForTranslatable` in
 * `DrugMergeAdminSection`.
 */
export interface DrugMergeTranslatableMessage {
  code: string;
  params?: Record<string, string | number>;
  fallback: string;
}

export interface DrugMergePlan {
  winner: DrugSideInfo;
  loser: DrugSideInfo;
  suggestedByMonograph: boolean;
  winnerReason: DrugMergeTranslatableMessage;
  conflicts: DrugMergeConflict[];
  blockers: DrugMergeBlocker[];
  dataConflicts: DrugMergeDataConflict[];
  substanceClassMismatch: { winner: string; loser: string } | null;
  warnings: DrugMergeTranslatableMessage[];
  counts: DrugMergeCounts;
  /**
   * Deterministic hash of the plan's decision-relevant state, returned by the
   * server. Pass it back to `applyDrugMerge` — the server rebuilds the plan
   * under the merge lock and returns 409 `stale_plan` if it changed.
   */
  planFingerprint: string;
}

export interface DrugMergeStats {
  winnerId: number;
  loserId: number;
  counts: DrugMergeCounts;
  conflictsResolved: number;
  loserMonographDeleted: boolean;
}

export type ConflictResolution = 'winner' | 'loser';

/**
 * A drug's display name from its per-language `names` map, honoring the
 * caller's active i18n language. Falls back to the other locale, then to
 * `nameShort`, then to a synthetic `Drug {id}` — never returns an empty
 * string. Callers pass the current language from `useTranslation` so search
 * results and selected drugs render in the same language as the rest of
 * the UI (rather than defaulting to Norwegian).
 */
export function drugDisplayName(
  drug: DrugSearchResult,
  language: 'nb' | 'en' = 'nb',
): string {
  const other: 'nb' | 'en' = language === 'nb' ? 'en' : 'nb';
  return (
    resolveDrugName(drug.names, language) ||
    resolveDrugName(drug.names, other) ||
    drug.nameShort ||
    `Drug ${drug.id}`
  );
}

/**
 * A merge plan side's display name, honoring the caller's active language.
 * `DrugSideInfo.name` is the server's Norwegian-first fallback; every React
 * surface that renders a plan side (survivor/removed headings, confirm
 * prompt, success toast, conflict labels) goes through here so those
 * strings match the language the picker and the rest of the UI use.
 */
export function drugSideDisplayName(
  side: DrugSideInfo,
  language: 'nb' | 'en' = 'nb',
): string {
  const other: 'nb' | 'en' = language === 'nb' ? 'en' : 'nb';
  return (
    resolveDrugName(side.names, language) ||
    resolveDrugName(side.names, other) ||
    side.name
  );
}

/**
 * Every `code` string the server hands back on a merge failure. The UI
 * decides the message from this code — the `error` prose is a developer-
 * facing fallback and never rendered to Norwegian users. Kept in sync with
 * `api/drug-merge.ts`; the string literals are the wire contract.
 */
export type DrugMergeErrorCode =
  | 'substance_class_mismatch'
  | 'applicability_conflict'
  | 'data_conflict'
  | 'unresolved_conflicts'
  | 'stale_plan';

export class DrugMergeError extends Error {
  constructor(
    public readonly httpStatus: number,
    /** Server-supplied stable code (undefined for 4xx/5xx without one). */
    public readonly code: DrugMergeErrorCode | string | undefined,
    /** Developer-facing English prose from the server, for logs only. */
    serverMessage: string,
    public readonly conflicts?: string[],
  ) {
    super(serverMessage);
    this.name = 'DrugMergeError';
  }
}

async function postMerge<T>(body: unknown): Promise<T> {
  const res = await fetch('/api/drug-merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      typeof data.error === 'string' ? data.error : 'Request failed';
    const code = typeof data.code === 'string' ? data.code : undefined;
    const conflicts = Array.isArray(data.conflicts)
      ? (data.conflicts as string[])
      : undefined;
    throw new DrugMergeError(res.status, code, message, conflicts);
  }
  return data as T;
}

export async function searchDrugsForMerge(
  query: string,
): Promise<DrugSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const res = await fetch(
    `/api/drugs?view=search&limit=10&q=${encodeURIComponent(q)}`,
  );
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as {
    drugs?: DrugSearchResult[];
  };
  return data.drugs ?? [];
}

export async function previewDrugMerge(params: {
  drugIdA: number;
  drugIdB: number;
  winnerId?: number;
}): Promise<DrugMergePlan> {
  const data = await postMerge<{ plan: DrugMergePlan }>({
    action: 'preview',
    ...params,
  });
  return data.plan;
}

export async function applyDrugMerge(params: {
  winnerId: number;
  loserId: number;
  resolutions: Record<string, ConflictResolution>;
  planFingerprint: string;
}): Promise<DrugMergeStats> {
  const data = await postMerge<{ stats: DrugMergeStats }>({
    action: 'apply',
    ...params,
  });
  return data.stats;
}
