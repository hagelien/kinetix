import type { EntityRank } from './bioEntities';

export type MetaboliteActivity = 'active' | 'inactive' | 'unknown';

/**
 * A metabolic quantity (metabolite conversion or elimination-route share)
 * recorded as a range of dose fractions (0–1). `median` is the representative
 * central estimate (median preferred over mean, per the project's NumericRange
 * convention); `min`/`max` are the bounds. Any field may be null — e.g. a
 * literature range of "30–40%" with no point estimate is
 * `{ min: 0.3, median: null, max: 0.4 }`.
 */
export interface MetabolismFractionRange {
  min: number | null;
  median: number | null;
  max: number | null;
}

/** True when a fraction range carries no value at all. */
export function fractionRangeIsEmpty(
  range: MetabolismFractionRange | null | undefined,
): boolean {
  return (
    !range ||
    (range.min == null && range.median == null && range.max == null)
  );
}

/**
 * Single representative scalar for a fraction range: the explicit median if
 * set, otherwise the midpoint of the bounds, otherwise whichever bound exists.
 * Returns null for an empty range.
 */
export function fractionRangeRepresentative(
  range: MetabolismFractionRange | null | undefined,
): number | null {
  if (!range) return null;
  if (range.median != null) return range.median;
  if (range.min != null && range.max != null) return (range.min + range.max) / 2;
  if (range.min != null) return range.min;
  if (range.max != null) return range.max;
  return null;
}

/** Normalize a possibly-partial fraction range to the canonical shape, or null. */
export function toFractionRange(
  range:
    | MetabolismFractionRange
    | { min?: number | null; median?: number | null; max?: number | null }
    | number
    | null
    | undefined,
): MetabolismFractionRange | null {
  if (range == null) return null;
  if (typeof range === 'number') {
    return Number.isFinite(range) ? { min: null, median: range, max: null } : null;
  }
  const normalized: MetabolismFractionRange = {
    min: range.min ?? null,
    median: range.median ?? null,
    max: range.max ?? null,
  };
  return fractionRangeIsEmpty(normalized) ? null : normalized;
}

export interface RelatedMetabolismDrug {
  id: number;
  slug: string;
  names: Record<string, string>;
  pubchemCid: number | null;
}

export interface DrugMetaboliteLink {
  id: number;
  parentDrugId: number;
  metaboliteDrugId: number | null;
  metaboliteName: string;
  conversionFraction: MetabolismFractionRange | null;
  activity: MetaboliteActivity;
  sortOrder: number;
  evidenceNote: string | null;
  referenceIds: number[] | null;
  drug: RelatedMetabolismDrug | null;
}

/**
 * A canonical metabolic enzyme (e.g. CYP3A4, Alcohol dehydrogenase). Enzymes
 * are a first-class, searchable entity shared across drugs — the analogue of
 * `receptor_targets` for metabolism. Drug-specific data (which fraction goes
 * through it, references) lives on {@link DrugEliminationRoute}.
 */
export interface MetabolismEnzyme {
  id: number;
  slug: string;
  symbol: string;
  name: string;
  nameEn: string | null;
  enzymeClass: string | null;
  /**
   * Position in the enzyme subdivision tree (#785 spine). `gene`/`isoform` is a
   * specific enzyme; `superfamily`/`family`/`subfamily` is a taxonomic group —
   * picked when the exact gene responsible for a biotransformation is unknown
   * but the family it belongs to is. `null` for flat (un-ranked) entities.
   */
  rank?: EntityRank | null;
}

/**
 * A group-level enzyme annotation: superfamily, family, or subfamily. These are
 * the ranks a curator selects when the specific gene/enzyme behind a route is
 * unknown but its family/subfamily/superfamily has been characterized.
 */
export function isEnzymeGroupRank(
  rank: EntityRank | null | undefined,
): boolean {
  return rank === 'superfamily' || rank === 'family' || rank === 'subfamily';
}

/**
 * What happens to a fraction of the dose:
 * - `enzyme` — metabolized by a specific (ideally canonical) enzyme.
 * - `metabolized` — metabolized, enzyme unspecified.
 * - `renal_unchanged` — excreted unchanged renally.
 * - `fecal_biliary` — excreted unchanged via feces/bile.
 * - `other_unchanged` — excreted unchanged by another route (sweat, breath, …).
 */
export type EliminationRouteKind =
  | 'enzyme'
  | 'metabolized'
  | 'renal_unchanged'
  | 'fecal_biliary'
  | 'other_unchanged';

export const ELIMINATION_ROUTE_KINDS: readonly EliminationRouteKind[] = [
  'enzyme',
  'metabolized',
  'renal_unchanged',
  'fecal_biliary',
  'other_unchanged',
];

export interface DrugEliminationRoute {
  id: number;
  kind: EliminationRouteKind;
  /** Canonical enzyme id when `kind === 'enzyme'` and one was matched. */
  enzymeId: number | null;
  /** Hydrated canonical enzyme (when linked). */
  enzyme: MetabolismEnzyme | null;
  /** Free-text label: unmatched enzyme name, or an "other" route description. */
  label: string | null;
  /** Share of dose through this route (0–1), as a range, when known. */
  fraction: MetabolismFractionRange | null;
  note: string | null;
  referenceIds: number[] | null;
  sortOrder: number;
}

export interface DrugMetabolism {
  routes: DrugEliminationRoute[];
  evidenceNote: string | null;
  metabolites: DrugMetaboliteLink[];
  precursors: DrugMetaboliteLink[];
}

/**
 * One drug↔entity edge read from the entity's side: a drug that routes part of
 * its dose through this bio entity. The reverse view of
 * {@link DrugEliminationRoute}, used by the entity monograph to list every
 * component the metabolism database links to it.
 */
export interface EntityMetabolismDrug {
  /** `drug_elimination_routes.id` — a drug may link twice with different notes. */
  routeId: number;
  drug: RelatedMetabolismDrug;
  /** Share of the drug's dose through this entity (0–1), when known. */
  fraction: MetabolismFractionRange | null;
  note: string | null;
}

/** Format a single 0–1 fraction as a percent string, or null when absent. */
export function formatFractionPercent(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `${(value * 100).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })}%`;
}

/**
 * Human-readable percent rendering of a fraction range:
 * - bounds only      → "30–40%"
 * - bounds + median  → "30–40% (35%)"
 * - median only      → "35%"
 * - single bound     → "≥30%" / "≤40%"
 * Returns null when the range carries nothing.
 */
export function formatFractionRangePercent(
  range: MetabolismFractionRange | null | undefined,
): string | null {
  if (fractionRangeIsEmpty(range) || !range) return null;
  const min = formatFractionPercent(range.min);
  const max = formatFractionPercent(range.max);
  const median = formatFractionPercent(range.median);

  let bounds: string | null = null;
  if (min && max) bounds = min === max ? min : `${min}–${max}`;
  else if (min) bounds = `≥${min}`;
  else if (max) bounds = `≤${max}`;

  if (bounds && median && range.min !== range.max) return `${bounds} (${median})`;
  if (bounds) return bounds;
  return median;
}

export function normalizeMetabolismName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Identity of a metabolite/precursor link: the **substance** it points at, not
 * the string that names it.
 *
 * `metaboliteName` is a label, not a key. The editor pre-fills it from the
 * linked drug's name *in the editing user's language*, the research importer
 * takes it verbatim from a paper, the farmakologiportalen importer takes the
 * Norwegian spelling — so one substance reaches this table as
 * "Benzoylecgonine", "benzoylecgonin" and "benzoylecgonin (BE)" depending on
 * who wrote the row. Every uniqueness check used to key on that string, so
 * those three landed as three rows, and the monograph sidebar — which renders
 * `link.drug`'s localized name and falls back to `metaboliteName` only when
 * nothing is linked — printed the same line three times.
 *
 * `link.drug` is the *other* end of the junction in both directions (the
 * metabolite when read from the parent, the parent when read from the
 * metabolite), which is why this works unchanged for precursor lists: keying
 * on `metaboliteDrugId` instead would collapse every precursor of a drug into
 * one, since that column holds the drug being viewed on that side.
 */
export function metaboliteLinkIdentity(
  link: Pick<DrugMetaboliteLink, 'metaboliteName' | 'drug'>,
): string {
  return link.drug
    ? `drug:${link.drug.id}`
    : `name:${normalizeMetabolismName(link.metaboliteName)}`;
}

/**
 * Every way the linked substances in `links` are spelled — each drug's names
 * in all locales, plus whatever label the row itself carries — mapped to that
 * substance's identity.
 *
 * This is what catches the mixed case the identity function alone cannot: a
 * free-text row spelled exactly the way a *linked* row's drug is spelled in
 * some language. "benzoylecgonin" with no `metabolite_drug_id` and a row
 * linked to the drug whose `nb` name is "benzoylecgonin" are one substance
 * twice, and they render identically, but they are distinct strings and
 * distinct identities until the names are consulted.
 *
 * A name claimed by **two** linked substances maps to `null` — ambiguous —
 * rather than to whichever came first. `drugs.names` has no cross-drug
 * uniqueness, so one spelling can be a drug's Norwegian name and another
 * drug's English one, and a free-text row carrying it names neither in
 * particular. Resolving that by position would attach its range, note and
 * citations to an arbitrary substance, which a later full-replace save then
 * makes permanent — the same misattribution this whole change exists to
 * prevent, arrived at from the other side. Unresolved, the row stays its own
 * entry, which is exactly what it is.
 */
function nameIndexFor(
  links: readonly Pick<DrugMetaboliteLink, 'metaboliteName' | 'drug'>[],
): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const link of links) {
    if (!link.drug) continue;
    const identity = metaboliteLinkIdentity(link);
    for (const name of [
      link.metaboliteName,
      ...Object.values(link.drug.names ?? {}),
    ]) {
      const key = normalizeMetabolismName(String(name ?? ''));
      if (!key) continue;
      if (!index.has(key)) index.set(key, identity);
      else if (index.get(key) !== identity) index.set(key, null);
    }
  }
  return index;
}

function unionReferenceIds(
  a: number[] | null,
  b: number[] | null,
): number[] | null {
  if (!a?.length) return b?.length ? [...new Set(b)] : (a ?? b);
  if (!b?.length) return [...new Set(a)];
  return [...new Set([...a, ...b])];
}

function sameFractionRange(
  a: MetabolismFractionRange | null | undefined,
  b: MetabolismFractionRange | null | undefined,
): boolean {
  return (
    (a?.min ?? null) === (b?.min ?? null) &&
    (a?.median ?? null) === (b?.median ?? null) &&
    (a?.max ?? null) === (b?.max ?? null)
  );
}

/**
 * True when merging these two links would have to *choose* between them —
 * they state the same field differently.
 *
 * This is the line between redundancy and contradiction, and only redundancy
 * may be collapsed. The deduped list is what the metabolism editor loads, and
 * a save from that editor replaces the drug's links wholesale — so a merge
 * that quietly dropped one of two conflicting claims would become permanent
 * the next time anyone edited anything on the box, with nothing ever having
 * shown the editor that a disagreement existed. Two rows that genuinely
 * disagree therefore stay two rows: the monograph shows both (they differ
 * visibly — activity and conversion share are what it renders), and a curator
 * resolves them.
 */
function metaboliteLinksConflict(
  a: DrugMetaboliteLink,
  b: DrugMetaboliteLink,
): boolean {
  if (
    a.activity !== 'unknown' &&
    b.activity !== 'unknown' &&
    a.activity !== b.activity
  ) {
    return true;
  }
  if (
    !fractionRangeIsEmpty(a.conversionFraction) &&
    !fractionRangeIsEmpty(b.conversionFraction) &&
    !sameFractionRange(a.conversionFraction, b.conversionFraction)
  ) {
    return true;
  }
  const noteA = a.evidenceNote?.trim();
  const noteB = b.evidenceNote?.trim();
  return Boolean(noteA && noteB && noteA !== noteB);
}

/**
 * Whichever of the two notes actually says something, preferring `a`.
 *
 * Blank is absent, not present. {@link metaboliteLinksConflict} already trims
 * before deciding whether two notes disagree, so a row holding `''` and a row
 * holding a real note count as agreeing — and a plain `a ?? b` would then keep
 * the empty string and drop the note, while still taking that row's citations.
 * The result populates the editor, whose next save replaces the drug's links
 * wholesale, so the row holding the evidence would be deleted with the note
 * already gone from the payload.
 */
function firstStatedNote(
  a: string | null,
  b: string | null,
): string | null {
  if (a?.trim()) return a;
  if (b?.trim()) return b;
  return a ?? b;
}

/**
 * Fold `extra` into `base`, keeping `base`'s position (id, sortOrder, label)
 * and taking from `extra` only what `base` does not have.
 *
 * Only ever called on links that do not conflict, so every field taken here
 * fills a gap rather than overruling a claim — the merge is lossless, which is
 * what makes it safe to hand to the editor. "Does not have" has to mean the
 * same thing here as it does in the conflict test, or a field the test read as
 * absent gets treated as present and the other row's value is dropped.
 */
function mergeMetaboliteLinks(
  base: DrugMetaboliteLink,
  extra: DrugMetaboliteLink,
): DrugMetaboliteLink {
  return {
    ...base,
    metaboliteDrugId: base.metaboliteDrugId ?? extra.metaboliteDrugId,
    drug: base.drug ?? extra.drug,
    conversionFraction: fractionRangeIsEmpty(base.conversionFraction)
      ? extra.conversionFraction
      : base.conversionFraction,
    activity: base.activity === 'unknown' ? extra.activity : base.activity,
    evidenceNote: firstStatedNote(base.evidenceNote, extra.evidenceNote),
    referenceIds: unionReferenceIds(base.referenceIds, extra.referenceIds),
  };
}

/**
 * Collapse links that name the same substance **and agree about it**,
 * preserving order.
 *
 * A read-side safety net, not the fix: `drug_metabolites` carries a unique
 * index per substance and the write paths reject duplicates, so the only shape
 * that still reaches here is the one the index cannot represent — a resolved
 * link beside a free-text row spelling that same substance in another locale.
 * It exists because the alternative failure — the sidebar printing
 * "benzoylecgonin · inaktiv" twice — is silent, looks like broken data to a
 * reader, and gives nobody a way to tell two rows from one rendered twice.
 *
 * Resolution is **all-or-nothing per substance**, the same rule migration 0099
 * applies to the table: if any two links for one substance disagree, none of
 * them are merged. Merging pairwise instead would let a third link that
 * contradicts nobody — carrying, say, the only conversion range and the only
 * citation — fall into whichever contradictory branch happened to come first,
 * attributing its measurement to a claim it never made. That is not a display
 * quirk: this list is what the metabolism editor loads, and a save from it
 * replaces the drug's links wholesale, so deleting the arbitrarily chosen
 * branch would take that third link's evidence with it.
 *
 * What survives is only ever redundancy collapsing (see
 * {@link metaboliteLinksConflict}), so the result never states anything the
 * source rows did not.
 */
export function dedupeMetaboliteLinks(
  links: readonly DrugMetaboliteLink[],
): DrugMetaboliteLink[] {
  if (links.length < 2) return [...links];
  const byName = nameIndexFor(links);
  const identities = links.map((link) => {
    if (link.drug) return metaboliteLinkIdentity(link);
    // `?? undefined` first: an ambiguous name is stored as null, and falling
    // back to the row's own identity is the right answer for both "no linked
    // row spells it this way" and "more than one does".
    const resolved =
      byName.get(normalizeMetabolismName(link.metaboliteName)) ?? undefined;
    return resolved ?? metaboliteLinkIdentity(link);
  });

  const groups = new Map<string, DrugMetaboliteLink[]>();
  identities.forEach((identity, i) => {
    const group = groups.get(identity);
    if (group) group.push(links[i]!);
    else groups.set(identity, [links[i]!]);
  });

  // Pairwise over each group — metabolite lists run to a handful of rows, so
  // the quadratic worst case is not worth avoiding.
  const consistent = new Map<string, boolean>();
  for (const [identity, group] of groups) {
    consistent.set(
      identity,
      group.every((a, i) =>
        group.slice(i + 1).every((b) => !metaboliteLinksConflict(a, b)),
      ),
    );
  }

  // Walk the original list so surviving links keep their original positions,
  // and a merged group takes the position of its first member.
  const out: DrugMetaboliteLink[] = [];
  links.forEach((link, i) => {
    const identity = identities[i]!;
    const group = groups.get(identity)!;
    if (group.length === 1 || !consistent.get(identity)) {
      out.push(link);
    } else if (group[0] === link) {
      out.push(group.reduce(mergeMetaboliteLinks));
    }
  });
  return out;
}

export function inferMetaboliteActivity(value: string): MetaboliteActivity {
  const normalized = normalizeMetabolismName(value);
  if (/\binactive\b/.test(normalized)) return 'inactive';
  if (/\bactive\b/.test(normalized)) return 'active';
  return 'unknown';
}

/** i18n key suffix under `metabolismRoute.*` for a route kind. */
export function eliminationRouteKindKey(kind: EliminationRouteKind): string {
  switch (kind) {
    case 'enzyme':
      return 'enzyme';
    case 'metabolized':
      return 'metabolized';
    case 'renal_unchanged':
      return 'renalUnchanged';
    case 'fecal_biliary':
      return 'fecalBiliary';
    case 'other_unchanged':
      return 'otherUnchanged';
  }
}

/** Best display name for an elimination route's enzyme/label portion. */
export function eliminationRouteEnzymeLabel(
  route: Pick<DrugEliminationRoute, 'enzyme' | 'label'>,
  lang: string,
): string {
  if (route.enzyme) {
    const useEn = lang.toLowerCase().startsWith('en');
    const name = useEn ? route.enzyme.nameEn : route.enzyme.name;
    return route.enzyme.symbol || name || route.enzyme.name;
  }
  return route.label ?? '';
}

export function hasMetabolismData(
  metabolism: DrugMetabolism | null | undefined,
): boolean {
  if (!metabolism) return false;
  return (
    metabolism.routes.length > 0 ||
    Boolean(metabolism.evidenceNote && metabolism.evidenceNote.trim()) ||
    metabolism.metabolites.length > 0 ||
    metabolism.precursors.length > 0
  );
}
