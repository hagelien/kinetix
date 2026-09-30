import { useEffect, useMemo, useRef, useState } from 'react';
import { useDrugStore } from '@/stores/drugStore';
import {
  fetchDrugs,
  fetchDrugSearchResults,
  drugRowToComponent,
} from '@/lib/drugApi';
import { searchDrugs } from '@/lib/drugSearch';
import type { DrugComponent } from '@/types';

const SEARCH_LIMIT = 100;
const DEBOUNCE_MS = 200;

/**
 * Resolve the candidate drug list for the drug-table surfaces (full table and
 * sidebar) given the current search query.
 *
 * With no query it returns the preloaded, popularity-sorted catalog held in the
 * store. With a query it first runs the slim server-side search used by the
 * Ctrl+K command palette, then hydrates only the bounded result IDs into full
 * rows for table columns. The preload is capped at the top-N drugs by
 * popularity, so a low-popularity, DB-only drug can still be found here without
 * returning and rendering a 1000-row full-view response for broad searches.
 *
 * The preloaded catalog is still filtered client-side as (a) an instant first
 * paint while the request is in flight and (b) an offline fallback if the
 * request fails, so the table never regresses below the previous behaviour.
 */
export function useDrugTableSearchResults(): {
  components: DrugComponent[];
  searching: boolean;
} {
  const allComponents = useDrugStore((s) => s.components);
  const searchQuery = useDrugStore((s) => s.searchQuery);
  const trimmed = searchQuery.trim();

  const [serverResults, setServerResults] = useState<DrugComponent[] | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  // Monotonic id so a slow response for an earlier query can never overwrite
  // the results of a newer one; the AbortController additionally cancels the
  // in-flight search and hydration requests when the query changes or the hook
  // unmounts, so superseded work stops spending server time.
  const requestId = useRef(0);

  useEffect(() => {
    // Drop any prior query's hits immediately so they can't linger under the
    // new query before its request resolves.
    setServerResults(null);
    if (!trimmed) {
      requestId.current += 1;
      setSearching(false);
      return;
    }
    const id = ++requestId.current;
    const controller = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const { drugs: searchRows } = await fetchDrugSearchResults({
          q: trimmed,
          limit: SEARCH_LIMIT,
          signal: controller.signal,
        });
        if (requestId.current !== id) return;

        const ids = searchRows.map((drug) => drug.id);
        if (ids.length === 0) {
          setServerResults([]);
          return;
        }

        const { drugs } = await fetchDrugs({
          ids,
          limit: ids.length,
          signal: controller.signal,
        });
        if (requestId.current !== id) return;
        setServerResults(drugs.map(drugRowToComponent));
      } catch {
        // Network/DB failure (or an aborted stale request): leave serverResults
        // null so the client-side fallback below keeps the table usable.
        if (requestId.current === id) setServerResults(null);
      } finally {
        if (requestId.current === id) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (requestId.current === id) requestId.current += 1;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [trimmed]);

  const localFiltered = useMemo(
    () => (trimmed ? searchDrugs(allComponents, trimmed) : allComponents),
    [allComponents, trimmed],
  );

  const components = !trimmed
    ? allComponents
    : (serverResults ?? localFiltered);

  return { components, searching };
}
