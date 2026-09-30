import type { DrugComponent } from '@/types';
import { buildDrugSearchKey } from '@/lib/drugNames';

/**
 * Stable, collision-free identity for a drug component, suitable as a React
 * list key.
 *
 * Before #1256, `DrugComponent.id` fell back to the internal `drugs` row id
 * for a CID-less drug, sharing a string namespace with real CIDs: a CID-less
 * drug (e.g. Canakinumab, db id 401) collided with a different drug whose
 * `pubchemCid` happened to be 401 (Sykloserin). #1256 gave a CID-less drug's
 * id an explicit `drug:` prefix instead, which already can't collide with a
 * CID — but `_dbId` is still preferred here, both because it predates that
 * fix and because it is unique even across two components built from the
 * same drug row by different code paths.
 *
 * `_dbId` is the `drugs` primary key and is always unique, so prefer it.
 * Embedded-fallback components carry no `_dbId`; their `id` (a PubChem CID)
 * is unique within that bundle, so fall back to it.
 */
export function drugComponentKey(
  drug: Pick<DrugComponent, 'id' | '_dbId'>,
): string {
  return drug._dbId != null ? `db-${drug._dbId}` : drug.id;
}

/**
 * Search drug components by query string.
 *
 * Uses the pre-computed `_searchKey` (which spans every language name plus
 * aliases plus shortname) so a query in any language matches
 * regardless of which UI language is active. Falls back to a fresh
 * concatenation when no `_searchKey` is set.
 */
export function searchDrugs(
  components: DrugComponent[],
  query: string,
  limit?: number,
): DrugComponent[] {
  const capped =
    limit !== undefined && Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : null;
  if (!query.trim()) return capped ? components.slice(0, capped) : components;

  const q = query.toLowerCase();
  const filtered: DrugComponent[] = [];
  for (const c of components) {
    const key =
      c._searchKey ??
      buildDrugSearchKey({
        names: c.names,
        nameShort: c.nameShort,
        aliases: c.aliases,
      });
    if (!key.includes(q)) continue;
    filtered.push(c);
    if (capped && filtered.length >= capped) return filtered;
  }

  return filtered;
}
