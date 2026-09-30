export interface DrugIndicators {
  comments: Record<string, number>;
  refs: Record<string, number[]>;
}

const INDICATOR_CACHE_TTL_MS = 60_000;
const EMPTY_INDICATORS: DrugIndicators = { comments: {}, refs: {} };

interface CachedIndicators {
  value: DrugIndicators;
  expiresAt: number;
}

const inFlightIndicatorRequests = new Map<number, Promise<DrugIndicators>>();
const indicatorCache = new Map<number, CachedIndicators>();
const indicatorVersions = new Map<number, number>();
let indicatorGlobalVersion = 0;

function readCachedIndicators(
  cache: Map<number, CachedIndicators>,
  key: number,
): DrugIndicators | null {
  const cached = cache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return cached.value;
}

function parseIndicators(data: unknown): DrugIndicators {
  const record = (data ?? {}) as {
    comments?: Record<string, number>;
    refs?: Record<string, number[]>;
  };
  return {
    comments: record.comments ?? {},
    refs: record.refs ?? {},
  };
}

function cacheVersion(versions: Map<number, number>, key: number): number {
  return indicatorGlobalVersion + (versions.get(key) ?? 0);
}

export async function fetchDrugIndicators(
  drugId: number,
): Promise<DrugIndicators> {
  const cached = readCachedIndicators(indicatorCache, drugId);
  if (cached) return cached;

  const existing = inFlightIndicatorRequests.get(drugId);
  if (existing) return existing;

  const version = cacheVersion(indicatorVersions, drugId);
  const request = (async () => {
    const res = await fetch(`/api/drug-indicators?drugId=${drugId}`);
    if (!res.ok) return EMPTY_INDICATORS;
    const data = await res.json();
    const indicators = parseIndicators(data);
    if (version === cacheVersion(indicatorVersions, drugId)) {
      indicatorCache.set(drugId, {
        value: indicators,
        expiresAt: Date.now() + INDICATOR_CACHE_TTL_MS,
      });
    }
    return indicators;
  })().finally(() => {
    if (inFlightIndicatorRequests.get(drugId) === request) {
      inFlightIndicatorRequests.delete(drugId);
    }
  });

  inFlightIndicatorRequests.set(drugId, request);
  return request;
}

export function invalidateDrugIndicators(drugId?: number): void {
  if (drugId === undefined) {
    indicatorCache.clear();
    inFlightIndicatorRequests.clear();
    indicatorGlobalVersion += 1;
    return;
  }
  indicatorCache.delete(drugId);
  inFlightIndicatorRequests.delete(drugId);
  indicatorVersions.set(drugId, (indicatorVersions.get(drugId) ?? 0) + 1);
}

// Keyed independently of the drug map so a page id and a drug id that happen
// to share a numeric value never collide on an in-flight request.
const inFlightPageIndicatorRequests = new Map<
  number,
  Promise<DrugIndicators>
>();
const pageIndicatorCache = new Map<number, CachedIndicators>();
const pageIndicatorVersions = new Map<number, number>();
let pageIndicatorGlobalVersion = 0;

/**
 * Topic (non-monograph) page fact-comment counts. Returns the same shape as
 * {@link fetchDrugIndicators} so `WikiRenderer.factCommentCounts` can consume
 * it directly; `refs` is always empty for topic pages.
 */
export async function fetchWikiPageIndicators(
  wikiPageId: number,
): Promise<DrugIndicators> {
  const cached = readCachedIndicators(pageIndicatorCache, wikiPageId);
  if (cached) return cached;

  const existing = inFlightPageIndicatorRequests.get(wikiPageId);
  if (existing) return existing;

  const version =
    pageIndicatorGlobalVersion + (pageIndicatorVersions.get(wikiPageId) ?? 0);
  const request = (async () => {
    const res = await fetch(`/api/drug-indicators?wikiPageId=${wikiPageId}`);
    if (!res.ok) return EMPTY_INDICATORS;
    const data = await res.json();
    const indicators = parseIndicators(data);
    if (
      version ===
      pageIndicatorGlobalVersion + (pageIndicatorVersions.get(wikiPageId) ?? 0)
    ) {
      pageIndicatorCache.set(wikiPageId, {
        value: indicators,
        expiresAt: Date.now() + INDICATOR_CACHE_TTL_MS,
      });
    }
    return indicators;
  })().finally(() => {
    if (inFlightPageIndicatorRequests.get(wikiPageId) === request) {
      inFlightPageIndicatorRequests.delete(wikiPageId);
    }
  });

  inFlightPageIndicatorRequests.set(wikiPageId, request);
  return request;
}

export function invalidateWikiPageIndicators(wikiPageId?: number): void {
  if (wikiPageId === undefined) {
    pageIndicatorCache.clear();
    inFlightPageIndicatorRequests.clear();
    pageIndicatorGlobalVersion += 1;
    return;
  }
  pageIndicatorCache.delete(wikiPageId);
  inFlightPageIndicatorRequests.delete(wikiPageId);
  pageIndicatorVersions.set(
    wikiPageId,
    (pageIndicatorVersions.get(wikiPageId) ?? 0) + 1,
  );
}
