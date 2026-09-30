/**
 * Build a stable numbering for a drug's references so the same citation id
 * always renders as the same `[n]` superscript across parameter boxes.
 * Inline monograph footnotes come first in their order of appearance, so the
 * prose starts at reference 1. Parameter-attached refs follow (sorted by
 * parameter key, then insertion order) so sidebar-only citations remain listed.
 */
export function buildDrugBibliography(
  refsByParameter: Record<string, number[]>,
  extraIds: number[] = [],
): Map<number, number> {
  const order: number[] = [];
  const seen = new Set<number>();
  for (const id of extraIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  const paramKeys = Object.keys(refsByParameter).sort();
  for (const key of paramKeys) {
    for (const id of refsByParameter[key] ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
    }
  }
  const map = new Map<number, number>();
  order.forEach((id, i) => map.set(id, i + 1));
  return map;
}

export function indicesFor(bib: Map<number, number>, ids: number[]): number[] {
  return ids
    .map((id) => bib.get(id))
    .filter((n): n is number => typeof n === "number");
}
