/**
 * Client for `GET /api/pm-concentrations`.
 *
 * Cached and de-duplicated per id set, because the modeling chart re-renders on
 * every input keystroke while the underlying distributions change only when a
 * cohort is re-seeded. The route is gated; an ungated caller gets an empty,
 * flagged payload rather than an error, and `gated` is carried through so the
 * UI can leave the section out entirely instead of rendering an empty box.
 */
import type {
  PmConcentrationSourceInfo,
  PmDistribution,
} from './pmConcentrations';

export interface PmConcentrationsResult {
  sources: PmConcentrationSourceInfo[];
  distributions: PmDistribution[];
  gated: boolean;
}

export const EMPTY_PM_RESULT: PmConcentrationsResult = {
  sources: [],
  distributions: [],
  gated: false,
};

const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  value: PmConcentrationsResult;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<PmConcentrationsResult>>();

/**
 * Who the cached answer belongs to.
 *
 * This cache holds gated, unpublished forensic data, and Kinetix is a single-
 * page app: signing out and signing in as somebody else replaces the auth
 * store without ever reloading the module. Keyed on ids alone, a rettstoks
 * member's payload would still be served to whoever logged in next, for up to
 * the TTL, without a request the server could refuse.
 *
 * So the caller passes its identity and it becomes part of the key: a new
 * identity cannot read the old one's entries, and an in-flight request started
 * under the old one resolves into a key the new identity never looks up.
 * `null` (signed out) is an identity like any other — an anonymous session
 * caches only the empty, gated payload.
 */
export type PmAccessIdentity = number | null;

let lastIdentity: PmAccessIdentity | undefined;

/**
 * Drop entries belonging to a previous identity.
 *
 * Keying alone already makes them unreachable; this stops them lingering in
 * memory after a sign-out, which for this data is worth the one Map walk.
 */
function pruneOnIdentityChange(identity: PmAccessIdentity): void {
  if (lastIdentity === identity) return;
  lastIdentity = identity;
  cache.clear();
  inFlight.clear();
}

function cacheKey(
  identity: PmAccessIdentity,
  kind: 'drugIds' | 'cids',
  ids: number[],
): string {
  return `${identity ?? 'anon'}|${kind}:${ids.join(',')}`;
}

/** Sorted + de-duplicated, so id order cannot fragment the cache. */
function normalizeIds(ids: readonly (number | null | undefined)[]): number[] {
  const out = new Set<number>();
  for (const id of ids) {
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) out.add(id);
  }
  return Array.from(out).sort((a, b) => a - b);
}

async function request(
  kind: 'drugIds' | 'cids',
  ids: number[],
): Promise<PmConcentrationsResult> {
  const res = await fetch(`/api/pm-concentrations?${kind}=${ids.join(',')}`);
  if (!res.ok) throw new Error(`pm-concentrations failed: ${res.status}`);
  const data = (await res.json()) as Partial<PmConcentrationsResult>;
  return {
    sources: data.sources ?? [],
    distributions: data.distributions ?? [],
    gated: data.gated === true,
  };
}

async function fetchBy(
  kind: 'drugIds' | 'cids',
  rawIds: readonly (number | null | undefined)[],
  identity: PmAccessIdentity,
): Promise<PmConcentrationsResult> {
  pruneOnIdentityChange(identity);
  const ids = normalizeIds(rawIds);
  if (ids.length === 0) return EMPTY_PM_RESULT;
  const key = cacheKey(identity, kind, ids);

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = request(kind, ids)
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

/** Distributions for internal `drugs.id` values. */
export function fetchPmConcentrationsByDrugIds(
  drugIds: readonly (number | null | undefined)[],
  identity: PmAccessIdentity = null,
): Promise<PmConcentrationsResult> {
  return fetchBy('drugIds', drugIds, identity);
}

/** Distributions for PubChem CIDs, for callers holding catalog components. */
export function fetchPmConcentrationsByCids(
  cids: readonly (number | null | undefined)[],
  identity: PmAccessIdentity = null,
): Promise<PmConcentrationsResult> {
  return fetchBy('cids', cids, identity);
}

/** Drop every cached answer (used by tests and after a re-seed). */
export function clearPmConcentrationCache(): void {
  cache.clear();
  inFlight.clear();
  lastIdentity = undefined;
}
