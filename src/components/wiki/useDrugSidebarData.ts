import { useEffect, useState, useCallback } from 'react';
import { fetchDrugByWikiDrugId, type DrugRow } from '@/lib/drugApi';
import { useAuthStore } from '@/stores/authStore';
import { fetchPendingEdits, type PendingEditRow } from '@/lib/pendingEditsApi';
import {
  fetchDrugIndicators,
  type DrugIndicators,
} from '@/lib/drugIndicatorsApi';

export interface DrugSidebarData {
  drug: DrugRow | null;
  /** Whether `drug` is the substance the page currently asks for. */
  drugMatchesRequest: boolean;
  indicators: DrugIndicators;
  pendingCounts: Record<string, number>;
  ownPendingParams: Set<string>;
  pendingEditsByParam: Record<string, PendingEditRow[]>;
  reload: () => void;
}

export function useDrugSidebarData(drugCid: number): DrugSidebarData {
  const [drug, setDrug] = useState<DrugRow | null>(null);
  // Which request the loaded row answers. The row is deliberately kept across a
  // `drugCid` change so the sidebar does not blank during navigation, which
  // means `drug` can be the substance you came from while the page is already
  // the one you went to. Anything that *writes* has to know the difference, and
  // it cannot be re-derived from the row: `wiki_pages.drug_cid` holds
  // `drugs.id` on modern rows and a PubChem CID on legacy ones (api/drugs.ts),
  // so comparing either field to `drugCid` is wrong for half the catalog.
  const [loadedForCid, setLoadedForCid] = useState<number | null>(null);
  const [indicators, setIndicators] = useState<DrugIndicators>({
    comments: {},
    refs: {},
  });
  const [pendingCounts, setPendingCounts] = useState<Record<string, number>>(
    {},
  );
  const [ownPendingParams, setOwnPendingParams] = useState<Set<string>>(
    new Set(),
  );
  const [pendingEditsByParam, setPendingEditsByParam] = useState<
    Record<string, PendingEditRow[]>
  >({});
  const { user } = useAuthStore();

  const reload = useCallback(() => {
    // `fresh: true` bypasses the CDN cache. /api/drugs?wikiDrugId= is served
    // with s-maxage=3600, which is right for read-only list/search views but
    // would let an admin's just-saved metadata edit (e.g. the English name)
    // sit invisible behind the edge cache for up to an hour — even though the
    // write succeeded and the change is already visible in the parameter
    // history. The monograph metadata header and PK sidebar are editor-facing
    // surfaces that must reflect the live drug row, matching WikiPage's own
    // fresh fetch of the same drugCid (which this call dedupes with on mount).
    fetchDrugByWikiDrugId(drugCid, { fresh: true })
      .then(({ drug: row }) => {
        setDrug(row);
        setLoadedForCid(drugCid);
      })
      .catch(() => {
        /* sidebar is supplementary, fail silently */
      });
  }, [drugCid]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!drug) return;
    fetchDrugIndicators(drug.id)
      .then(setIndicators)
      .catch(() => {});
    fetchPendingEdits({
      status: 'pending',
      editType: 'parameter',
      targetId: drug.id,
    })
      .then((data) => {
        const counts: Record<string, number> = {};
        const own = new Set<string>();
        const grouped: Record<string, PendingEditRow[]> = {};

        for (const edit of data.pendingEdits) {
          if (!edit.parameter) continue;
          counts[edit.parameter] = (counts[edit.parameter] ?? 0) + 1;
          if (edit.submitter?.id === user?.id) own.add(edit.parameter);
          grouped[edit.parameter] = [...(grouped[edit.parameter] ?? []), edit];
        }

        setPendingCounts(counts);
        setOwnPendingParams(own);
        setPendingEditsByParam(grouped);
      })
      .catch(() => {});
  }, [drug, user?.id]);

  return {
    drug,
    drugMatchesRequest: drug !== null && loadedForCid === drugCid,
    indicators,
    pendingCounts,
    ownPendingParams,
    pendingEditsByParam,
    reload,
  };
}
