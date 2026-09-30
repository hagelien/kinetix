/**
 * Helpers for the multilingual drug-name shape (`names` jsonb + `aliases`
 * jsonb array). Used by both server- and client-side code. No DOM/i18n
 * dependencies — callers pass the active language explicitly.
 */

/** BCP-47 language code (e.g. `"nb"`, `"en"`). */
export type LangCode = string;

export interface NamedDrug {
  /** Per-language names. At least one entry is guaranteed. */
  names: Record<LangCode, string>;
  /** Optional shortname / abbreviation, language-agnostic. */
  nameShort?: string | null;
  /** Optional aliases — literature variants, brand and street names. */
  aliases?: string[] | null;
}

const FALLBACK_LANG_ORDER: LangCode[] = ['en', 'nb'];

/**
 * Resolve the best display name for the given locale.
 *
 * Resolution order:
 *   1. `names[lang]`
 *   2. `names[fallback]` for each fallback lang in order
 *   3. The first non-empty value in the `names` object
 *   4. Empty string (only if `names` is missing or empty — not expected)
 */
export function resolveDrugName(
  names: Record<LangCode, string> | null | undefined,
  lang: LangCode | null | undefined,
): string {
  if (!names) return '';
  if (lang && typeof names[lang] === 'string' && names[lang]) {
    return names[lang];
  }
  for (const fb of FALLBACK_LANG_ORDER) {
    if (typeof names[fb] === 'string' && names[fb]) {
      return names[fb];
    }
  }
  for (const value of Object.values(names)) {
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

/**
 * Standardise the *display* case of a drug name.
 *
 * House style: generic (INN) substance names render lower-case
 * (`diazepam`, `morphine`, `buprenorphine`), while brand names — which live
 * in `aliases`, not in `names` — keep their capitalisation (`Subutex`,
 * `Ritalin`). Since the primary `names` of a drug are always the generic
 * substance, this normaliser only ever sees generics and simply lower-cases
 * the leading letter.
 *
 * The leading letter is lower-cased ONLY when the second character is a
 * lower-case letter. That single guard preserves every case where the
 * capital is meaningful:
 *   - Acronyms / initialisms: `LSD`, `THC`, `MDMA`, `PMMA`, `EDDP`
 *   - Stereochemistry / locant prefixes: `N-desmetyldiazepam`,
 *     `O-desmetyltramadol`, `L-DOPA`
 *   - Names that already start with a digit/locant: `3-CMC`,
 *     `6-monoacetylmorfin`, `7-aminoflunitrazepam`
 *
 * This is a presentation-only transform. The canonical value stored in
 * `names` is never changed, so edit forms and the database keep the original
 * casing.
 */
export function formatGenericDrugName(name: string): string {
  if (!name) return name;
  const first = name[0]!;
  const second = name[1];
  // Only act on an upper-case leading letter…
  if (first === first.toLowerCase()) return name;
  // …and only when the next character is a lower-case letter, so acronyms
  // (`THC`), locant prefixes (`N-…`) and already-lower tails are left alone.
  if (!second || second !== second.toLowerCase() || second === second.toUpperCase()) {
    return name;
  }
  return first.toLowerCase() + name.slice(1);
}

/**
 * Inverse of {@link formatGenericDrugName}: capitalise the leading letter of a
 * generic drug name for surfaces that render it as a heading (drug table,
 * monograph title — see #860). Most `names` are stored capitalised already
 * (`Diazepam`), so this is mostly a safety net that also normalises the few
 * rows stored lower-case (`buprenorfin` → `Buprenorfin`).
 *
 * The leading letter is upper-cased ONLY when it is a lower-case letter AND the
 * second character is a lower-case letter AND the first token carries no hyphen.
 * Those three guards preserve every case where the capital is meaningful:
 *   - Acronyms / initialisms: `THC`, `LSD`, `MDMA`, `PMMA`, `BHB` (already
 *     upper-case → untouched)
 *   - Mixed-case shorthands: `mCPP` (second char is upper-case → untouched)
 *   - Names starting with a digit/locant: `3-CMC`, `6-monoacetylmorfin`
 *     (leading char isn't a letter → untouched)
 *   - Lower-case stereochemistry / locant descriptors that precede a hyphen:
 *     `para-Metoksymetamfetamin`, `cis-…`, `gamma-…`, `p-…` (hyphen in the
 *     first token → untouched)
 *
 * Presentation-only: the canonical value stored in `names` is never changed.
 */
export function capitalizeGenericDrugName(name: string): string {
  if (!name) return name;
  const first = name[0]!;
  // Only act on a lower-case leading letter (skips digits, symbols and names
  // that already start with a capital — `first === toUpperCase` for all three).
  if (first === first.toUpperCase()) return name;
  const second = name[1];
  // …and only when the next character is a lower-case letter, so mixed-case
  // shorthands (`mCPP`) keep their meaningful casing.
  if (!second || second !== second.toLowerCase() || second === second.toUpperCase()) {
    return name;
  }
  // …and never a lower-case locant / stereo descriptor that precedes a hyphen
  // in the first token (`para-…`, `cis-…`, `gamma-…`): its case is chemically
  // meaningful.
  if (name.split(' ')[0]!.includes('-')) return name;
  return first.toUpperCase() + name.slice(1);
}

/**
 * Pick the secondary (alternate) name to render under the primary display
 * name. Returns the first language entry that differs from the primary name.
 */
export function resolveAltDrugName(
  names: Record<LangCode, string> | null | undefined,
  primary: string,
): string | null {
  if (!names) return null;
  for (const value of Object.values(names)) {
    if (typeof value === 'string' && value && value !== primary) return value;
  }
  return null;
}

/**
 * Build the secondary line shown under a drug's primary name in search
 * results: the alternate-language (usually English) name, the short
 * name/abbreviation, and every alias — all the things a user might have
 * typed to land on this row but which the bold title doesn't surface.
 *
 * The alternate name leads (it's the most useful disambiguator and matches
 * the existing subtitle behaviour); the short name and aliases follow. When a
 * `query` is passed, the short-name/alias terms that contain it float to the
 * front of that group so the reason an otherwise non-obvious row matched
 * (e.g. searching an alias or a substring like "2-ene") stays visible even
 * when the line is truncated.
 *
 * Generic substance names (the alternate name) are run through
 * `formatGenericDrugName` for house-style lower-casing; aliases and the short
 * name are kept verbatim because they include brand/street names whose
 * capitalisation is meaningful. Terms equal to the primary name, and
 * duplicates, are dropped (case-insensitive). Returns an empty string when
 * there is nothing secondary to show.
 */
export function buildDrugSearchSubtitle(
  names: Record<LangCode, string> | null | undefined,
  primary: string,
  nameShort?: string | null,
  aliases?: string[] | null,
  query?: string,
): string {
  const seen = new Set<string>([primary.trim().toLowerCase()]);
  const lead: string[] = [];
  const alt = resolveAltDrugName(names, primary);
  if (alt) {
    seen.add(alt.trim().toLowerCase());
    lead.push(formatGenericDrugName(alt.trim()));
  }

  const extras: string[] = [];
  const add = (value: string | null | undefined) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    extras.push(trimmed);
  };
  add(nameShort);
  for (const alias of aliases ?? []) add(alias);

  const q = query?.trim().toLowerCase();
  if (q) {
    // Stable sort keeps the stored order within each group; matches first.
    extras.sort(
      (a, b) =>
        (a.toLowerCase().includes(q) ? 0 : 1) -
        (b.toLowerCase().includes(q) ? 0 : 1),
    );
  }

  return [...lead, ...extras].join(' · ');
}

/**
 * The secondary identifiers a drug goes by — its shortname/abbreviation and
 * every alias (literature variants, brand and street names) — for the drug
 * table's name tooltip. The shortname leads because it is the abbreviation the
 * table used to show inline; aliases follow in stored order.
 *
 * Terms are trimmed, empties dropped, and duplicates removed case-insensitively,
 * with any term equal to `primary` (the standard name already shown) filtered
 * out so the tooltip never merely repeats the visible name. Original casing is
 * preserved — shortnames and brand/street names carry meaningful capitalisation.
 */
export function collectDrugAkaTerms(
  drug: Pick<NamedDrug, 'nameShort' | 'aliases'>,
  primary: string,
): { shortName: string | null; aliases: string[] } {
  const seen = new Set<string>([primary.trim().toLowerCase()]);
  const take = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    return trimmed;
  };
  const shortName = take(drug.nameShort);
  const aliases: string[] = [];
  for (const alias of drug.aliases ?? []) {
    const kept = take(alias);
    if (kept) aliases.push(kept);
  }
  return { shortName, aliases };
}

/**
 * All searchable terms for a drug: every language name, every alias, and the
 * shortname. Used to build the trigram-indexed `search_key`. Empty/falsy
 * values are dropped; output is lowercased.
 */
export function collectSearchTerms(drug: NamedDrug): string[] {
  const out: string[] = [];
  if (drug.names) {
    for (const value of Object.values(drug.names)) {
      if (typeof value === 'string' && value) out.push(value);
    }
  }
  if (Array.isArray(drug.aliases)) {
    for (const alias of drug.aliases) {
      if (typeof alias === 'string' && alias) out.push(alias);
    }
  }
  if (drug.nameShort) out.push(drug.nameShort);
  return out;
}

/**
 * Build the canonical lowercase, tab-separated `search_key` value. Mirrors
 * the SQL backfill in `drizzle/0013_drug_names_jsonb.sql` so server-side and
 * client-side searching produce identical matches.
 */
export function buildDrugSearchKey(drug: NamedDrug): string {
  return collectSearchTerms(drug).join('\t').toLowerCase();
}

/**
 * Normalise an `aliases` payload into a clean string array: trims each entry,
 * drops empties, and de-duplicates while preserving order. Accepts a
 * comma/newline-separated string for convenience (form input).
 */
export function normalizeAliases(input: unknown): string[] {
  if (input == null) return [];
  const list: string[] = [];
  if (typeof input === 'string') {
    list.push(...input.split(/[\n,]/));
  } else if (Array.isArray(input)) {
    for (const v of input) {
      if (typeof v === 'string') list.push(v);
    }
  } else {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Normalise a `names` payload: trim each value, drop empty entries, and
 * lowercase language keys. Throws if the result is empty (a drug must have
 * at least one name).
 */
export function normalizeNames(
  input: unknown,
): Record<LangCode, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('names must be an object keyed by language code');
  }
  const out: Record<LangCode, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    if (typeof rawValue !== 'string') continue;
    const trimmed = rawValue.trim();
    if (!trimmed) continue;
    const key = rawKey.toLowerCase().trim();
    if (!key) continue;
    out[key] = trimmed;
  }
  if (Object.keys(out).length === 0) {
    throw new Error('At least one language name is required');
  }
  return out;
}

/**
 * Map per-language metadata parameter ids to the `names` jsonb language key
 * they read/write. Mirrors `NAME_PARAMETER_LANG` in `api/_lib/drugs-helpers.ts`.
 */
const NAME_PARAMETER_LANG: Record<string, LangCode> = {
  nameNb: 'nb',
  nameEn: 'en',
};

/**
 * Read the value of a metadata parameter from a drug-shaped object,
 * indirecting through `names` for per-language ids (`nameNb`, `nameEn`) so
 * the sidebar/edit-dialog UI can use a uniform `parameter -> value` lookup
 * even though the underlying schema stores names in a single jsonb column.
 *
 * Returns the live value or `null` when missing — never `undefined`.
 */
export function readDrugMetadataValue(
  drug: Record<string, unknown> | null | undefined,
  parameter: string,
): unknown {
  if (!drug) return null;
  const lang = NAME_PARAMETER_LANG[parameter];
  if (lang) {
    const names = (drug.names ?? {}) as Record<string, unknown>;
    return names[lang] ?? null;
  }
  return drug[parameter] ?? null;
}

