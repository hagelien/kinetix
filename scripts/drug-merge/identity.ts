/**
 * How a merged drug's identity is assembled (scripts/merge-drugs.ts).
 *
 * Split out from the CLI so the one part with real judgement in it is testable
 * without a database: everything else the merge does is "move these rows, then
 * delete that one", but identity decides what a reader can still find the
 * substance by afterwards. Drop a name here and every search for it dead-ends,
 * with nothing to indicate the substance is still in the catalog under another
 * spelling.
 *
 * The rule is additive in both directions, unlike the row moves. A parameter
 * the survivor already holds is a competing claim and the survivor's wins; a
 * second name for one substance is a synonym, and both are true at once.
 */
import { buildDrugSearchKey } from '../../src/lib/drugNames';

export interface DrugIdentity {
  names: Record<string, string>;
  aliases: string[];
  /** Abbreviation / shortname, language-agnostic. Indexed like a name. */
  nameShort?: string | null;
}

export interface MergedIdentity {
  names: Record<string, string>;
  aliases: string[];
  nameShort: string | null;
  searchKey: string;
  /** Human-readable account of what the merge added, for the dry-run report. */
  addedNames: string[];
  addedAliases: string[];
  /** Set when the survivor had no shortname and inherited the loser's. */
  inheritedNameShort: string | null;
}

function clean(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * Fold the loser's names, shortname and aliases into the survivor's.
 *
 * - A language the survivor has no name for takes the loser's.
 * - A language it does have keeps its own — but the loser's spelling is not
 *   discarded, it becomes an alias, because someone searches by it.
 * - Same for the shortname: inherited when the survivor has none, kept as an
 *   alias when the survivor has a different one. `nameShort` is a *search term*
 *   (`collectSearchTerms` includes it), so losing it silently breaks lookup by
 *   the abbreviation while the column still shows one.
 * - A spelling already present as a name or shortname is not repeated as an
 *   alias; the search key indexes all three alike, so a duplicate only bloats
 *   the row.
 *
 * Comparison for "already present" is case-insensitive on the whole trimmed
 * string: these are display spellings, and `Efedrin` / `efedrin` are the same
 * search term, not two.
 */
export function mergeIdentity(
  survivor: DrugIdentity,
  loser: DrugIdentity,
): MergedIdentity {
  const names = { ...(survivor.names ?? {}) };
  const addedNames: string[] = [];
  for (const [lang, value] of Object.entries(loser.names ?? {})) {
    const v = clean(value);
    if (!v) continue;
    if (!names[lang]) {
      names[lang] = v;
      addedNames.push(`${lang}="${v}"`);
    }
  }

  const survivorShort = clean(survivor.nameShort);
  const loserShort = clean(loser.nameShort);
  const nameShort = survivorShort || loserShort || null;
  const inheritedNameShort = !survivorShort && loserShort ? loserShort : null;

  const present = new Set<string>();
  for (const value of Object.values(names)) present.add(value.toLowerCase());
  if (nameShort) present.add(nameShort.toLowerCase());

  const aliases: string[] = [];
  for (const value of survivor.aliases ?? []) {
    const v = clean(value);
    if (!v || present.has(v.toLowerCase())) continue;
    present.add(v.toLowerCase());
    aliases.push(v);
  }

  const addedAliases: string[] = [];
  // Everything the loser answered to that did not win a slot above. Its own
  // names and shortname are the spellings most at risk of vanishing with the
  // row, so they are candidates here alongside its aliases.
  for (const value of [
    ...(loser.aliases ?? []),
    ...Object.values(loser.names ?? {}),
    loserShort,
  ]) {
    const v = clean(value);
    if (!v || present.has(v.toLowerCase())) continue;
    present.add(v.toLowerCase());
    aliases.push(v);
    addedAliases.push(v);
  }

  return {
    names,
    aliases,
    nameShort,
    searchKey: buildDrugSearchKey({ names, aliases, nameShort }),
    addedNames,
    addedAliases,
    inheritedNameShort,
  };
}
