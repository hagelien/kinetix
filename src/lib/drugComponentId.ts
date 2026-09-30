/**
 * The identifier a `DrugComponent` is keyed by everywhere outside the
 * `drugs` table itself — the simulator's `?drugId=` route param,
 * `case_data.drugs[].drugId` on a saved simulator case, and the component
 * map the drug picker builds from search results.
 *
 * Historically this was `String(pubchemCid ?? id)`: a drug with a PubChem
 * CID was keyed by that CID, and a CID-less drug fell back to its own
 * internal `drugs.id`. Both live in the same integer namespace, so whenever
 * some drug's CID equals a different, CID-less drug's internal id, the
 * fallback number is genuinely ambiguous — `hydrateComponentByRouteId` (and
 * every script that repoints a saved case) resolves the CID interpretation
 * first, so the CID-less drug's own cases silently load and simulate the
 * OTHER substance. See #1256 (items 6–7 split from #1076) for the incident
 * history.
 *
 * The fix keeps the common case — a drug with a CID — spelled exactly as
 * before (a bare numeric string), so no existing link, saved case or test
 * for a CID-bearing drug changes shape. A CID-less drug is instead keyed by
 * its internal id under an explicit `drug:` prefix, which can never collide
 * with a bare CID number again.
 */
const INTERNAL_ID_PREFIX = 'drug:';

export interface DrugIdentityKeys {
  id: number;
  pubchemCid?: number | null;
}

/** Build the id a `DrugComponent` (and a freshly saved simulator case) uses for this drug. */
export function buildDrugComponentId(drug: DrugIdentityKeys): string {
  return drug.pubchemCid != null
    ? String(drug.pubchemCid)
    : `${INTERNAL_ID_PREFIX}${drug.id}`;
}

/**
 * Parse a `drug:<id>` component id, returning the internal id it names, or
 * null when `key` does not carry the prefix (a bare number — a CID under the
 * current scheme, or a pre-#1256 CID-less drug's bare internal id under the
 * old one).
 */
export function parseInternalDrugComponentId(key: string): number | null {
  if (!key.startsWith(INTERNAL_ID_PREFIX)) return null;
  const n = Number(key.slice(INTERNAL_ID_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Every spelling a saved simulator case might currently use to pin this
 * drug. A CID-bearing drug has only ever had one: its CID, unaffected by
 * this change. A CID-less drug had exactly one before #1256 — its bare
 * internal id, indistinguishable from a CID — and has exactly one now —
 * `drug:<id>` — but a case saved under the OLD code between those two
 * points still carries the bare-numeric spelling. Both are live candidates
 * until that data ages out, so anything that searches saved cases FOR a
 * specific drug (a merge, a CID retarget) has to look for both.
 */
export function simulatorDrugKeyCandidates(drug: DrugIdentityKeys): string[] {
  if (drug.pubchemCid != null) return [String(drug.pubchemCid)];
  return [String(drug.id), `${INTERNAL_ID_PREFIX}${drug.id}`];
}

/**
 * Force a component fetched by an id/CID lookup to be keyed by the string it
 * was actually looked up with, when `buildDrugComponentId`'s own canonical
 * id for the row diverges from it.
 *
 * That divergence is real, not hypothetical: a saved simulator case or a
 * bookmarked simulator URL embeds a lookup key at save time, and everything
 * that later re-reads the loaded component does so by that ORIGINAL key
 * (`case_data.drugs[].drugId` round-tripped through the client's component
 * map) — not by whatever id the drug's current row would mint today. Two
 * ways they can disagree: the key predates #1256 (a CID-less drug's bare
 * internal id, where `buildDrugComponentId` now returns a `drug:<id>`
 * key), or the drug has since been retargeted onto a different PubChem CID
 * (`scripts/retarget-pubchem-cid.ts`) since the key was saved. Silently
 * keying the loaded component by the new canonical id instead would make
 * every later lookup by the old key miss, falling back to generic
 * parameter defaults with no error.
 */
export function keyComponentByLookupId<T extends { id: string }>(
  component: T,
  lookupId: string,
): T {
  return component.id === lookupId ? component : { ...component, id: lookupId };
}
