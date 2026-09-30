import { useEffect, useMemo, useState } from 'react';
import { fetchDrugByWikiDrugId } from '@/lib/drugApi';
import { fetchDrugIndicators } from '@/lib/drugIndicatorsApi';
import {
  fetchDrugReferences,
  fetchReferences,
  type CitationRow,
} from '@/lib/referencesApi';
import { buildDrugBibliography } from '@/lib/bibliography';

export interface OrderedReference {
  index: number;
  row: CitationRow;
}

export interface DrugBibliography {
  ordered: OrderedReference[] | null;
  bibliographyMap: Map<number, number>;
  /** Citation ids attached to each parameter id (e.g. `halfLife` → [12, 40]). */
  refsByParameter: Record<string, number[]>;
}

export interface UseDrugBibliographyOptions {
  /**
   * Internal `drugs.id` when the caller already has the resolved drug row.
   * Supplying this skips the id/CID disambiguation request and goes straight
   * to citation and indicator reads.
   */
  resolvedDrugId?: number | null;
}

/**
 * Loads every citation attached to a drug (via parameter refs or monograph
 * footnotes) and returns one shared numbering. Both the inline footnote
 * markers in monograph prose and the bottom-of-page references list use this,
 * so a `[3]` superscript always points to entry 3 of the list.
 *
 * Footnote refs are batch-loaded when they aren't already covered by the
 * drug-scoped fetch — citations are deduplicated globally by (type, identifier)
 * so a monograph can legitimately cite a row whose `drug_id` is null or
 * belongs to another drug.
 */
export function useDrugBibliography(
  drugIdOrCid: number | null,
  footnoteRefIds: number[],
  options: UseDrugBibliographyOptions = {},
): DrugBibliography {
  const [refs, setRefs] = useState<CitationRow[] | null>(null);
  const [refsByParameter, setRefsByParameter] = useState<
    Record<string, number[]>
  >({});
  // Stringify so the array identity doesn't churn between renders.
  const footnoteKey = footnoteRefIds.join(',');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let drugRefs: CitationRow[] = [];
      let indicatorsRefs: Record<string, number[]> = {};
      let drugId: number | null = options.resolvedDrugId ?? null;
      if (drugId == null && drugIdOrCid != null) {
        try {
          const { drug } = await fetchDrugByWikiDrugId(drugIdOrCid);
          drugId = drug.id;
        } catch {
          drugId = null;
        }
      }
      if (drugId != null) {
        const [citations, indicators] = await Promise.all([
          fetchDrugReferences(drugId),
          fetchDrugIndicators(drugId),
        ]);
        drugRefs = citations;
        indicatorsRefs = indicators.refs;
      }
      const known = new Set(drugRefs.map((r) => r.id));
      const missing = [...new Set(footnoteRefIds)].filter(
        (id) => !known.has(id),
      );
      const fetched = missing.length ? await fetchReferences(missing) : [];
      if (cancelled) return;
      setRefs([...drugRefs, ...fetched]);
      setRefsByParameter(indicatorsRefs);
    })();
    return () => {
      cancelled = true;
    };
    // footnoteKey captures footnoteRefIds; eslint can't see through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drugIdOrCid, footnoteKey, options.resolvedDrugId]);

  return useMemo<DrugBibliography>(() => {
    if (!refs)
      return {
        ordered: null,
        bibliographyMap: new Map(),
        refsByParameter,
      };
    const bibliography = buildDrugBibliography(refsByParameter, footnoteRefIds);
    const byId = new Map(refs.map((r) => [r.id, r] as const));
    const ordered: OrderedReference[] = [];
    const used = new Set<number>();
    for (const [id, index] of bibliography.entries()) {
      const row = byId.get(id);
      if (!row) continue;
      ordered.push({ index, row });
      used.add(id);
    }
    let nextIndex = bibliography.size + 1;
    for (const row of refs) {
      if (used.has(row.id)) continue;
      ordered.push({ index: nextIndex++, row });
    }
    ordered.sort((a, b) => a.index - b.index);
    return { ordered, bibliographyMap: bibliography, refsByParameter };
  }, [refs, refsByParameter, footnoteRefIds]);
}
