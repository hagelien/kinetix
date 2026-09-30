/**
 * Shared logic for the unified biological-entity registry (#785).
 *
 * A `bio_entity` is one canonical, non-drug macromolecule (enzyme, receptor,
 * transporter, …). The same molecule can play several roles, so its roles live
 * in `bio_entity_functions` rather than being implied by a registry. This
 * module holds the pure rules that decide when two registry rows are the *same*
 * entity — used by the Phase 1 backfill migration and, from Phase 3, by inline
 * entity creation so a curator adding "MAO-A" as a drug target reuses the
 * existing "MAO-A" enzyme instead of forking a duplicate.
 */

/** Function (role) a biological entity can play. */
export type BioEntityFunction =
  | 'metabolic_enzyme'
  | 'drug_target'
  | 'transporter'
  | 'ion_channel'
  | 'biomarker'
  | 'structural';

export const BIO_ENTITY_FUNCTIONS: readonly BioEntityFunction[] = [
  'metabolic_enzyme',
  'drug_target',
  'transporter',
  'ion_channel',
  'biomarker',
  'structural',
];

export type BioEntityExternalIds = Record<
  string,
  string | number | string[] | number[] | null
>;

/** Position in the subdivision tree. Free-form, but these are the known ranks. */
export type EntityRank =
  | 'superfamily'
  | 'family'
  | 'subfamily'
  | 'gene'
  | 'isoform'
  | 'subunit'
  | 'variant'
  | 'complex';

export const ENTITY_RANKS: readonly EntityRank[] = [
  'superfamily',
  'family',
  'subfamily',
  'gene',
  'isoform',
  'subunit',
  'variant',
  'complex',
];

/**
 * A canonical biological entity as served by the unified `/api/bio-entities`
 * catalog (#785). `functions` are the roles it plays (enzyme, target, …);
 * `parentId` links it to its parent in the subdivision tree.
 */
export interface BioEntitySummary {
  id: number;
  slug: string;
  symbol: string;
  name: string;
  nameEn: string | null;
  organism: string;
  rank: EntityRank | null;
  parentId: number | null;
  entityClass: string | null;
  externalIds: BioEntityExternalIds;
  functions: BioEntityFunction[];
}

/**
 * Canonical match key for a symbol: strip every non-alphanumeric character and
 * upper-case the rest. Must stay in lock-step with the SQL used by the backfill
 * migration — `upper(regexp_replace(symbol, '[^a-zA-Z0-9]', '', 'g'))` — so the
 * TS and SQL dedup decisions never disagree. This collapses cosmetic spelling
 * differences ("MAO-A" / "MAOA" / "mao a") while keeping genuinely different
 * isoforms apart ("CYP3A4" vs "CYP3A5").
 */
export function normalizeBioEntityKey(symbol: string): string {
  return symbol.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/** Lower-cased UniProt id when present, for cross-registry matching. */
export function uniprotKey(
  externalIds: BioEntityExternalIds | null | undefined,
): string | null {
  const raw = externalIds?.uniprot;
  if (typeof raw === 'string' && raw.trim()) return raw.trim().toLowerCase();
  return null;
}

/** The organism every entity carries when none was stated. */
export const DEFAULT_ORGANISM = 'Homo sapiens';

/**
 * Canonical match key for an organism: case- and whitespace-insensitive, so
 * "homo sapiens" and "Homo  sapiens" are the same species. An absent organism
 * reads as the column default (`Homo sapiens`), matching what the DB stores.
 */
export function normalizeOrganismKey(
  organism: string | null | undefined,
): string {
  const trimmed = (organism ?? '').trim().replace(/\s+/g, ' ');
  return (trimmed || DEFAULT_ORGANISM).toLowerCase();
}

export interface BioEntityMatchCandidate {
  id: number;
  symbol: string;
  organism?: string | null;
  externalIds?: BioEntityExternalIds | null;
}

/**
 * Decide whether an incoming registry row matches one of the entities already
 * created. Returns the matched entity's id, or null to create a new entity.
 * Symbol match wins; a shared UniProt id is the fallback — the same precedence
 * as the migration's DO block.
 *
 * Both arms are scoped to the organism (#1017). `bio_entities.symbol` is only
 * indexed, not unique, so the catalog can hold a human and a rat `SLC6A3` as
 * separate rows; without this scope whichever row the query found first won,
 * and because the catalog is shared across drugs a mislabelled bind leaks into
 * every other drug pointing at that entity. Missing organism on either side
 * means `Homo sapiens`, so the human-only catalog behaves exactly as before.
 */
export function findMatchingEntity(
  incoming: {
    symbol: string;
    organism?: string | null;
    externalIds?: BioEntityExternalIds | null;
  },
  existing: ReadonlyArray<BioEntityMatchCandidate>,
): number | null {
  const key = normalizeBioEntityKey(incoming.symbol);
  const organism = normalizeOrganismKey(incoming.organism);
  const sameOrganism = existing.filter(
    (e) => normalizeOrganismKey(e.organism) === organism,
  );

  const bySymbol = sameOrganism.find(
    (e) => normalizeBioEntityKey(e.symbol) === key,
  );
  if (bySymbol) return bySymbol.id;

  const uni = uniprotKey(incoming.externalIds);
  if (uni) {
    const byUniprot = sameOrganism.find(
      (e) => uniprotKey(e.externalIds) === uni,
    );
    if (byUniprot) return byUniprot.id;
  }
  return null;
}

/**
 * The taxonomic ancestor symbols of a CYP gene symbol, root-first. The CYP
 * naming scheme is itself the hierarchy: CYP3A4 → subfamily CYP3A → family CYP3
 * → superfamily CYP. Returns [] for anything that isn't a recognizable CYP gene
 * (e.g. "ADH", "CYP3A" itself, "SERT"), so non-CYP entities are left untouched.
 *
 * Used by the Phase 6 spine backfill to mint the intermediate family entities
 * and wire each gene's parent_id chain.
 */
export function deriveCypLineage(symbol: string): string[] {
  const m = /^CYP(\d+)([A-Z]+)(\d+)$/.exec(symbol.trim().toUpperCase());
  if (!m) return [];
  const [, family, subfamilyLetters] = m;
  return ['CYP', `CYP${family}`, `CYP${family}${subfamilyLetters}`];
}

/** Rank for a CYP lineage symbol produced by {@link deriveCypLineage}. */
export function cypLineageRank(symbol: string): EntityRank {
  if (symbol === 'CYP') return 'superfamily';
  if (/^CYP\d+$/.test(symbol)) return 'family';
  return 'subfamily';
}

/**
 * Merge external ids when folding a registry row into an existing entity. The
 * existing entity's values win on key conflicts; the incoming row only
 * contributes ids the entity is missing — mirroring the migration's
 * `incoming || existing` jsonb concatenation.
 */
export function mergeExternalIds(
  existing: BioEntityExternalIds | null | undefined,
  incoming: BioEntityExternalIds | null | undefined,
): BioEntityExternalIds {
  return { ...(incoming ?? {}), ...(existing ?? {}) };
}
