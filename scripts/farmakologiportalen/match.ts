/**
 * Matching a Farmakologiportalen substance to a drug already in the catalog,
 * by name.
 *
 * Split out of scripts/backfill-farmakologiportalen-links.ts so the one rule
 * that is easy to get quietly wrong — what happens when two drugs answer to
 * the same spelling — is testable without a database or a network.
 *
 * `drugs.names` has no cross-drug uniqueness: one string can be a drug's `nb`
 * name and another's `en` name. A first-writer-wins index therefore hands such
 * a key to whichever row the (unordered) catalog query returned first, and
 * anything written through it lands on an arbitrary one of the two. The rest
 * of the catalog already refuses to guess there (AGENTS.md, metabolite
 * identity): an ambiguous spelling resolves to *neither* drug. Same rule here,
 * and the stakes are the same shape — a link on the wrong monograph sends a
 * reader to a different substance, which is worse than no link at all.
 */
import { normalizeMetabolismName } from '../../src/lib/metabolism';
import { splitTitle } from './parse';

/** A spelling more than one drug answers to. Never resolved to a drug. */
export const AMBIGUOUS = Symbol('ambiguous name');

export type NameIndex = Map<string, number | typeof AMBIGUOUS>;

export interface IndexableDrug {
  id: number;
  names: Record<string, string> | null;
  aliases: string[] | null;
}

/** Normalized name/alias → drug id, or AMBIGUOUS where two drugs collide. */
export function buildNameIndex(catalog: readonly IndexableDrug[]): NameIndex {
  const index: NameIndex = new Map();
  const claim = (raw: string, drugId: number): void => {
    const key = normalizeMetabolismName(raw);
    if (!key) return;
    const held = index.get(key);
    // One drug reaching the same key twice — its own name and alias
    // normalizing alike — is not a collision. Only two distinct drugs are.
    if (held === undefined) index.set(key, drugId);
    else if (held !== drugId) index.set(key, AMBIGUOUS);
  };
  for (const drug of catalog) {
    for (const name of Object.values(drug.names ?? {})) claim(String(name), drug.id);
    for (const alias of drug.aliases ?? []) claim(alias, drug.id);
  }
  return index;
}

export interface SubstanceMatch {
  /** The drug this substance belongs to, or null when none was resolved. */
  drugId: number | null;
  /**
   * True when a candidate spelling was rejected for being shared by two drugs.
   * Distinct from "no match": this one is a curator's problem, not an absence,
   * and the caller reports it separately.
   */
  ambiguous: boolean;
}

/**
 * Resolve a portal substance title against the index.
 *
 * Candidates are tried base name → full title → parenthetical alias. An
 * ambiguous candidate is stepped over rather than resolved, so a base name two
 * drugs share can still be settled by the fuller title; if every candidate is
 * ambiguous or unknown, nothing is matched.
 */
export function matchSubstanceTitle(
  index: NameIndex,
  title: string,
): SubstanceMatch {
  const { base, alias } = splitTitle(title);
  let ambiguous = false;
  for (const candidate of [base, title, alias ?? '']) {
    const key = normalizeMetabolismName(candidate);
    if (!key) continue;
    const held = index.get(key);
    if (held === undefined) continue;
    if (held === AMBIGUOUS) {
      ambiguous = true;
      continue;
    }
    return { drugId: held, ambiguous: false };
  }
  return { drugId: null, ambiguous };
}
