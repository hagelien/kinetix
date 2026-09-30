import {
  and,
  asc,
  eq,
  ilike,
  inArray,
  like,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { bioEntities, bioEntityFunctions, wikiPages } from '../../db/schema.js';
import {
  BIO_ENTITY_FUNCTIONS,
  DEFAULT_ORGANISM,
  ENTITY_RANKS,
  findMatchingEntity,
  normalizeBioEntityKey,
  normalizeOrganismKey,
  uniprotKey,
  type BioEntityExternalIds,
  type BioEntityFunction,
  type BioEntitySummary,
  type EntityRank,
} from '../../src/lib/bioEntities.js';
import { generateSlug } from './slug.js';
import type { getDb } from './db.js';

type Db = ReturnType<typeof getDb>;

const FUNCTION_SET: ReadonlySet<string> = new Set(BIO_ENTITY_FUNCTIONS);
const RANK_SET: ReadonlySet<string> = new Set(ENTITY_RANKS);

function rankOrNull(value: string | null): EntityRank | null {
  return value && RANK_SET.has(value) ? (value as EntityRank) : null;
}

function functionsOrEmpty(values: ReadonlyArray<string>): BioEntityFunction[] {
  return values.filter((v): v is BioEntityFunction => FUNCTION_SET.has(v));
}

const ENTITY_COLUMNS = {
  id: bioEntities.id,
  slug: bioEntities.slug,
  symbol: bioEntities.symbol,
  name: bioEntities.name,
  nameEn: bioEntities.nameEn,
  organism: bioEntities.organism,
  rank: bioEntities.rank,
  parentId: bioEntities.parentId,
  entityClass: bioEntities.entityClass,
  externalIds: bioEntities.externalIds,
} as const;

type EntityRow = {
  id: number;
  slug: string;
  symbol: string;
  name: string;
  nameEn: string | null;
  organism: string;
  rank: string | null;
  parentId: number | null;
  entityClass: string | null;
  externalIds: BioEntityExternalIds;
};

function serializeEntity(
  row: EntityRow,
  functions: ReadonlyArray<string>,
): BioEntitySummary {
  return {
    id: row.id,
    slug: row.slug,
    symbol: row.symbol,
    name: row.name,
    nameEn: row.nameEn,
    organism: row.organism,
    rank: rankOrNull(row.rank),
    parentId: row.parentId,
    entityClass: row.entityClass,
    externalIds: row.externalIds ?? {},
    functions: functionsOrEmpty(functions),
  };
}

/** Fetch the function rows for a set of entities, grouped by entity id. */
async function functionsByEntity(
  db: Db,
  entityIds: ReadonlyArray<number>,
): Promise<Map<number, BioEntityFunction[]>> {
  const grouped = new Map<number, BioEntityFunction[]>();
  if (entityIds.length === 0) return grouped;
  const rows = await db
    .select({
      entityId: bioEntityFunctions.entityId,
      function: bioEntityFunctions.function,
    })
    .from(bioEntityFunctions)
    .where(inArray(bioEntityFunctions.entityId, [...entityIds]))
    .orderBy(asc(bioEntityFunctions.function));
  for (const r of rows) {
    if (!FUNCTION_SET.has(r.function)) continue;
    const list = grouped.get(r.entityId) ?? [];
    list.push(r.function as BioEntityFunction);
    grouped.set(r.entityId, list);
  }
  return grouped;
}

export interface BioEntitySearchOptions {
  function?: BioEntityFunction;
  limit?: number;
  /**
   * When set together with {@link BioEntitySearchOptions.function}, the result
   * also includes the taxonomic-group ancestors (superfamily/family/subfamily)
   * of any entity that plays `function`. The metabolism editor turns this on so
   * a curator can annotate a route at the family level (e.g. CYP3A) when the
   * specific gene responsible (e.g. CYP3A4) is unknown — the spine groups carry
   * no `metabolic_enzyme` function row of their own, only their gene leaves do.
   */
  includeFunctionAncestors?: boolean;
}

/**
 * Ids of every entity that plays `fn`, plus all of their `parent_id` ancestors
 * walked to the root. The ancestors are the taxonomic groups (family/subfamily/
 * superfamily) that sit above the function-bearing genes in the subdivision
 * spine; they have no function row of their own, so a plain function join can't
 * reach them.
 */
function functionLineageCondition(fn: BioEntityFunction): SQL {
  return sql`${bioEntities.id} IN (
    WITH RECURSIVE lineage AS (
      SELECT be.id, be.parent_id
      FROM bio_entities be
      JOIN bio_entity_functions f
        ON f.entity_id = be.id AND f.function = ${fn}
      UNION
      SELECT p.id, p.parent_id
      FROM bio_entities p
      JOIN lineage l ON p.id = l.parent_id
    )
    SELECT id FROM lineage
  )`;
}

/**
 * Typeahead over the catalog, optionally restricted to entities that play a
 * given function (e.g. only `metabolic_enzyme` for the metabolism editor). A
 * blank query returns the first `limit` entities, symbol-ordered.
 */
export async function searchBioEntities(
  db: Db,
  query: string,
  options: BioEntitySearchOptions = {},
): Promise<BioEntitySummary[]> {
  const trimmed = query.trim();
  const cap = Math.min(Math.max(options.limit ?? 10, 1), 50);
  const textFilter = trimmed
    ? or(
        ilike(bioEntities.symbol, `%${trimmed}%`),
        ilike(bioEntities.name, `%${trimmed}%`),
        ilike(bioEntities.nameEn, `%${trimmed}%`),
      )
    : undefined;

  let rows: EntityRow[];
  if (options.function && options.includeFunctionAncestors) {
    // Function-bearing entities plus their taxonomic-group ancestors, so the
    // metabolism editor can offer family/subfamily/superfamily annotations.
    // Keep the recursive lineage inside the filtered query instead of first
    // materialising every id in Node and sending them back as a large IN list
    // on each typeahead request.
    rows = await db
      .select(ENTITY_COLUMNS)
      .from(bioEntities)
      .where(and(functionLineageCondition(options.function), textFilter))
      .orderBy(asc(bioEntities.symbol))
      .limit(cap);
  } else if (options.function) {
    rows = await db
      .select(ENTITY_COLUMNS)
      .from(bioEntities)
      .innerJoin(
        bioEntityFunctions,
        eq(bioEntityFunctions.entityId, bioEntities.id),
      )
      .where(and(eq(bioEntityFunctions.function, options.function), textFilter))
      .orderBy(asc(bioEntities.symbol))
      .limit(cap);
  } else {
    rows = await db
      .select(ENTITY_COLUMNS)
      .from(bioEntities)
      .where(textFilter)
      .orderBy(asc(bioEntities.symbol))
      .limit(cap);
  }

  const functions = await functionsByEntity(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => serializeEntity(r, functions.get(r.id) ?? []));
}

/** Full catalog (symbol-ordered) with functions, for the admin view. */
export async function listBioEntities(db: Db): Promise<BioEntitySummary[]> {
  const rows = await db
    .select(ENTITY_COLUMNS)
    .from(bioEntities)
    .orderBy(asc(bioEntities.symbol));
  const functions = await functionsByEntity(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => serializeEntity(r, functions.get(r.id) ?? []));
}

/** Function-filtered full catalog for legacy role-specific shims. */
export async function listBioEntitiesByFunction(
  db: Db,
  fn: BioEntityFunction,
): Promise<BioEntitySummary[]> {
  const rows = await db
    .select(ENTITY_COLUMNS)
    .from(bioEntities)
    .innerJoin(
      bioEntityFunctions,
      eq(bioEntityFunctions.entityId, bioEntities.id),
    )
    .where(eq(bioEntityFunctions.function, fn))
    .orderBy(asc(bioEntities.symbol));
  const functions = await functionsByEntity(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => serializeEntity(r, functions.get(r.id) ?? []));
}

export async function getBioEntityById(
  db: Db,
  id: number,
): Promise<BioEntitySummary | null> {
  const [row] = await db
    .select(ENTITY_COLUMNS)
    .from(bioEntities)
    .where(eq(bioEntities.id, id))
    .limit(1);
  if (!row) return null;
  const functions = await functionsByEntity(db, [id]);
  return serializeEntity(row, functions.get(id) ?? []);
}

export async function getBioEntityBySlug(
  db: Db,
  slug: string,
): Promise<BioEntitySummary | null> {
  const [row] = await db
    .select(ENTITY_COLUMNS)
    .from(bioEntities)
    .where(eq(bioEntities.slug, slug))
    .limit(1);
  if (!row) return null;
  const functions = await functionsByEntity(db, [row.id]);
  return serializeEntity(row, functions.get(row.id) ?? []);
}

/** Slug of the entity's monograph page (#785 Phase 5), or null if none yet. */
export async function getEntityMonographSlug(
  db: Db,
  entityId: number,
): Promise<string | null> {
  const [row] = await db
    .select({ slug: wikiPages.slug })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.pageType, 'entity_monograph'),
        eq(wikiPages.entityId, entityId),
      ),
    )
    .limit(1);
  return row?.slug ?? null;
}

/** Direct children of an entity in the subdivision tree. */
export async function getChildren(
  db: Db,
  parentId: number,
): Promise<BioEntitySummary[]> {
  const rows = await db
    .select(ENTITY_COLUMNS)
    .from(bioEntities)
    .where(eq(bioEntities.parentId, parentId))
    .orderBy(asc(bioEntities.symbol));
  const functions = await functionsByEntity(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => serializeEntity(r, functions.get(r.id) ?? []));
}

/** Ancestors from the immediate parent up to the root (cycle-guarded). */
export async function getAncestors(
  db: Db,
  id: number,
): Promise<BioEntitySummary[]> {
  const chain: BioEntitySummary[] = [];
  const seen = new Set<number>([id]);
  let current = await getBioEntityById(db, id);
  while (current?.parentId != null && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    const parent = await getBioEntityById(db, current.parentId);
    if (!parent) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export class BioEntityWriteError extends Error {
  constructor(
    message: string,
    public readonly statusHint = 400,
  ) {
    super(message);
    this.name = 'BioEntityWriteError';
  }
}

export interface BioEntityWriteInput {
  symbol: string;
  name: string;
  nameEn?: string | null;
  organism?: string | null;
  rank?: EntityRank | null;
  parentId?: number | null;
  entityClass?: string | null;
  externalIds?: BioEntityExternalIds | null;
  functions?: BioEntityFunction[];
}

async function uniqueEntitySlug(
  db: Db,
  base: string,
  ignoreId?: number,
): Promise<string> {
  const root = base || 'entity';
  const existing = await db
    .select({ slug: bioEntities.slug, id: bioEntities.id })
    .from(bioEntities)
    .where(like(bioEntities.slug, `${root}%`));
  const taken = new Set(
    existing.filter((r) => r.id !== ignoreId).map((r) => r.slug),
  );
  if (!taken.has(root)) return root;
  for (let i = 2; ; i++) {
    const candidate = `${root}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Replace an entity's function rows with `functions` (deduped). */
export async function setEntityFunctions(
  db: Db,
  entityId: number,
  functions: ReadonlyArray<BioEntityFunction>,
): Promise<void> {
  const unique = [...new Set(functions.filter((f) => FUNCTION_SET.has(f)))];
  await db
    .delete(bioEntityFunctions)
    .where(eq(bioEntityFunctions.entityId, entityId));
  if (unique.length > 0) {
    await db
      .insert(bioEntityFunctions)
      .values(unique.map((f) => ({ entityId, function: f })));
  }
}

export async function createBioEntity(
  db: Db,
  input: BioEntityWriteInput,
): Promise<BioEntitySummary> {
  const slug = await uniqueEntitySlug(
    db,
    generateSlug(input.symbol) || generateSlug(input.name),
  );
  const [row] = await db
    .insert(bioEntities)
    .values({
      slug,
      symbol: input.symbol.trim(),
      name: input.name.trim(),
      nameEn: input.nameEn?.trim() || null,
      organism: input.organism?.trim() || DEFAULT_ORGANISM,
      rank: input.rank ?? null,
      parentId: input.parentId ?? null,
      entityClass: input.entityClass?.trim() || null,
      externalIds: input.externalIds ?? {},
    })
    .returning(ENTITY_COLUMNS);
  if (!row)
    throw new BioEntityWriteError('bio_entities insert returned no row');
  if (input.functions && input.functions.length > 0) {
    await setEntityFunctions(db, row.id, input.functions);
  }
  return serializeEntity(row, input.functions ?? []);
}

export async function updateBioEntity(
  db: Db,
  id: number,
  input: Partial<BioEntityWriteInput>,
): Promise<BioEntitySummary | null> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.symbol !== undefined) {
    patch.symbol = input.symbol.trim();
    patch.slug = await uniqueEntitySlug(db, generateSlug(input.symbol), id);
  }
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.nameEn !== undefined) patch.nameEn = input.nameEn?.trim() || null;
  if (input.organism !== undefined) {
    patch.organism = input.organism?.trim() || DEFAULT_ORGANISM;
  }
  if (input.rank !== undefined) patch.rank = input.rank ?? null;
  if (input.parentId !== undefined) {
    if (input.parentId === id) {
      throw new BioEntityWriteError('An entity cannot be its own parent');
    }
    patch.parentId = input.parentId ?? null;
  }
  if (input.entityClass !== undefined) {
    patch.entityClass = input.entityClass?.trim() || null;
  }
  if (input.externalIds !== undefined) {
    patch.externalIds = input.externalIds ?? {};
  }

  const [row] = await db
    .update(bioEntities)
    .set(patch)
    .where(eq(bioEntities.id, id))
    .returning(ENTITY_COLUMNS);
  if (!row) return null;
  if (input.functions !== undefined) {
    await setEntityFunctions(db, id, input.functions);
  }
  const functions = await functionsByEntity(db, [id]);
  return serializeEntity(row, functions.get(id) ?? []);
}

export async function deleteBioEntity(db: Db, id: number): Promise<boolean> {
  const [row] = await db
    .delete(bioEntities)
    .where(eq(bioEntities.id, id))
    .returning({ id: bioEntities.id });
  return Boolean(row);
}

/**
 * Resolve a catalog entity from a symbol/name pair, reusing an existing entity
 * when the normalized symbol or a shared UniProt id matches (dedup, the same
 * rule as the Phase 1 backfill), otherwise creating one. Guarantees the entity
 * carries `fn`. Used by the edit-write paths from Phase 4 onward.
 */
export async function findOrCreateEntityBySymbol(
  db: Db,
  input: {
    symbol: string;
    name?: string | null;
    nameEn?: string | null;
    /**
     * Species of the entity itself. Omitted means `Homo sapiens` — the catalog
     * is human-canonical, and a measurement made in another species is
     * recorded on the observation (`drug_receptor_targets.assay_species`), not
     * by forking the entity. Pass this only when the row genuinely IS the
     * non-human ortholog.
     */
    organism?: string | null;
    externalIds?: BioEntityExternalIds | null;
  },
  fn: BioEntityFunction,
): Promise<number> {
  const normalizedSymbol = normalizeBioEntityKey(input.symbol);
  const incomingUniprot = uniprotKey(input.externalIds);
  const normalizedOrganism = normalizeOrganismKey(input.organism);
  const conditions: SQL[] = [
    sql`upper(regexp_replace(${bioEntities.symbol}, '[^a-zA-Z0-9]', '', 'g')) = ${normalizedSymbol}`,
  ];
  if (incomingUniprot) {
    conditions.push(
      sql`lower(${bioEntities.externalIds} ->> 'uniprot') = ${incomingUniprot}`,
    );
  }

  // Organism narrows the candidate set in SQL as well as in `findMatchingEntity`
  // so the symbol index still serves the lookup and a large non-human catalog
  // never has to be shipped back to compare in TS. The predicate mirrors
  // `normalizeOrganismKey`; both sides must agree or a rat row could match here
  // and be rejected there (creating an entity that then collides on the next
  // import).
  const organismMatch = sql`lower(regexp_replace(btrim(coalesce(nullif(btrim(${bioEntities.organism}), ''), ${DEFAULT_ORGANISM})), '\\s+', ' ', 'g')) = ${normalizedOrganism}`;

  const candidates = await db
    .select({
      id: bioEntities.id,
      symbol: bioEntities.symbol,
      organism: bioEntities.organism,
      externalIds: bioEntities.externalIds,
    })
    .from(bioEntities)
    .where(and(or(...conditions), organismMatch));
  const matchId = findMatchingEntity(
    {
      symbol: input.symbol,
      organism: input.organism,
      externalIds: input.externalIds,
    },
    candidates,
  );
  if (matchId != null) {
    await ensureEntityFunction(db, matchId, fn);
    return matchId;
  }
  const created = await createBioEntity(db, {
    symbol: input.symbol,
    name: input.name?.trim() || input.symbol,
    nameEn: input.nameEn ?? null,
    organism: input.organism ?? null,
    externalIds: input.externalIds ?? {},
    functions: [fn],
  });
  return created.id;
}

/** Add a function to an entity if it doesn't already carry it. */
export async function ensureEntityFunction(
  db: Db,
  entityId: number,
  fn: BioEntityFunction,
): Promise<void> {
  const existing = await db
    .select({ id: bioEntityFunctions.id })
    .from(bioEntityFunctions)
    .where(
      and(
        eq(bioEntityFunctions.entityId, entityId),
        eq(bioEntityFunctions.function, fn),
      ),
    )
    .limit(1);
  if (existing.length === 0) {
    await db.insert(bioEntityFunctions).values({ entityId, function: fn });
  }
}
