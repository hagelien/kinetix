import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDrugStore } from '@/stores/drugStore';
import { trackDrugInteraction } from '@/lib/drugApi';
import type { DrugComponent } from '@/types';

// Module-level cache shared by every hook caller. Full drug API rows now carry
// their monograph slug, so the cache is only for fallback lookups when a caller
// hands us a component from an older/slimmer source.
const slugCache = new Map<string, string>();

function rememberSlug(drug: DrugComponent, slug: string): void {
  if (drug._dbId != null) slugCache.set(String(drug._dbId), slug);
  slugCache.set(drug.id, slug);
}

function lookupKnownSlug(drug: DrugComponent): string | undefined {
  return (
    drug._monographSlug ??
    (drug._dbId != null ? slugCache.get(String(drug._dbId)) : undefined) ??
    slugCache.get(drug.id)
  );
}

/**
 * Shared row-click behavior for the full drug table and the sidebar list.
 *
 * Sets the row as the active drug, navigates to its monograph, and - when
 * invoked from the full table - collapses the global drug-table shell down to
 * the sidebar view so the monograph becomes immediately readable underneath. A
 * drug picked from the sidebar list keeps the sidebar mounted (no transition),
 * matching the behavior described in issue #298.
 */
export function useDrugRowSelect() {
  const navigate = useNavigate();
  const setActiveDrug = useDrugStore((s) => s.setActiveDrug);
  const setTableView = useDrugStore((s) => s.setTableView);

  const select = useCallback(
    async (drug: DrugComponent, opts: { collapseToSidebar?: boolean } = {}) => {
      setActiveDrug(drug);
      if (drug._dbId) trackDrugInteraction(drug._dbId, 'wiki_open');

      if (opts.collapseToSidebar) {
        setTableView('sidebar');
      }

      const slug = lookupKnownSlug(drug);
      if (slug) {
        navigate(`/wiki/${slug}`);
        return;
      }

      // Components from older/slimmer sources may not carry _monographSlug.
      // Resolve on demand before falling back to the create-flow so users with
      // a real monograph don't land on a misleading "no monograph" page.
      if (drug._dbId) {
        try {
          const res = await fetch(`/api/wiki/pages?drugCid=${drug._dbId}`);
          if (res.ok) {
            const data = (await res.json()) as { page?: { slug?: string } };
            if (data?.page?.slug) {
              rememberSlug(drug, data.page.slug);
              navigate(`/wiki/${data.page.slug}`);
              return;
            }
          }
        } catch {
          /* fall through to preview */
        }
        navigate(`/wiki/drug/${drug._dbId}`);
      }
    },
    [navigate, setActiveDrug, setTableView],
  );

  return { select };
}
