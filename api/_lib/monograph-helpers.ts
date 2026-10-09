/**
 * Shared helper for auto-creating a drug's monograph wiki page.
 *
 * A "monograph" is a `wiki_pages` row (`page_type='drug_monograph'`) linked to
 * a drug by `drug_cid`. Historically these were created lazily — an admin had
 * to click "Create monograph" on a drug's preview page. Every drug should
 * instead own a monograph from the moment it enters the catalog, so this helper
 * is invoked whenever a drug is created (POST /api/drugs) and by the backfill
 * script for pre-existing drugs.
 *
 * The stub starts empty (`{ type: 'doc', content: [] }`) — exactly what the old
 * manual "Create monograph" button produced — so the rendered page is identical
 * to a freshly hand-created one: the drug data sidebar shows, with no prose yet.
 */
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  bioEntities,
  wikiPages,
  wikiRevisions,
  drugs,
} from '../../db/schema.js';
import { getDb } from './db.js';
import { generateSlug } from './slug.js';
import { renderHtml, extractPlaintext } from './tiptap-utils.js';
import { resolveDrugName, type LangCode } from '../../src/lib/drugNames.js';

/** Minimal drug shape needed to mint a monograph. */
export interface MonographDrug {
  id: number;
  names: Record<LangCode, string>;
  pubchemCid?: number | null;
}

type Db = ReturnType<typeof getDb>;

const EMPTY_DOC = { type: 'doc', content: [] } as const;

/**
 * Which `wiki_pages.drug_cid` values legitimately belong to a drug. `drug_cid`
 * is mixed-vintage: modern rows store `drugs.id`, legacy rows a PubChem CID.
 * The drug's own id is always a candidate. Its PubChem CID is a candidate ONLY
 * when no *other* drug claims that number as its internal id — otherwise a page
 * with `drug_cid = <our CID>` is that other drug's modern monograph, so treating
 * it as ours would mis-link it here (and, in the DELETE teardown, delete it).
 * Mirrors the /api/drugs?wikiDrugId= read resolver, which prefers the drugs.id
 * interpretation for exactly this collision (e.g. 25C-NBOMe id=281 vs carbon
 * monoxide pubchem_cid=281).
 */
export function monographDrugCidCandidates(
  drugId: number,
  pubchemCid: number | null | undefined,
  pubchemCidIsAnotherDrugId: boolean,
): number[] {
  const candidates = [drugId];
  if (
    pubchemCid != null &&
    pubchemCid !== drugId &&
    !pubchemCidIsAnotherDrugId
  ) {
    candidates.push(pubchemCid);
  }
  return candidates;
}

/**
 * Resolve {@link monographDrugCidCandidates} for a drug, querying the drugs
 * table to detect the id/PubChem-CID collision. Pass a transaction handle when
 * this must observe writes in progress (e.g. the DELETE teardown).
 */
export async function resolveMonographDrugCids(
  db: Db,
  drug: { id: number; pubchemCid?: number | null },
): Promise<number[]> {
  let collision = false;
  if (drug.pubchemCid != null && drug.pubchemCid !== drug.id) {
    const [hit] = await db
      .select({ id: drugs.id })
      .from(drugs)
      .where(eq(drugs.id, drug.pubchemCid))
      .limit(1);
    collision = Boolean(hit);
  }
  return monographDrugCidCandidates(drug.id, drug.pubchemCid, collision);
}

/**
 * Given a `wiki_pages.drug_cid` value (which is normally the owning drug's
 * internal id but for legacy rows is its PubChem CID), find the owning
 * `drugs.id`. Used by pending-edit submit paths that need to take the same
 * per-drug advisory lock the drug-merge admin holds: locking by the raw
 * `drug_cid` would use a legacy CID as the lock key while the merge locks
 * the internal id, letting the two paths race unblocked. Returns null if no
 * drug owns this drug_cid (the page is dangling).
 */
export async function resolveOwningDrugIdForMonograph(
  db: Db,
  drugCid: number,
): Promise<number | null> {
  // Modern shape: drug_cid IS the drugs.id.
  const [byId] = await db
    .select({ id: drugs.id })
    .from(drugs)
    .where(eq(drugs.id, drugCid))
    .limit(1);
  if (byId) return byId.id;
  // Legacy shape: drug_cid is the drug's PubChem CID.
  const [byCid] = await db
    .select({ id: drugs.id })
    .from(drugs)
    .where(eq(drugs.pubchemCid, drugCid))
    .limit(1);
  return byCid?.id ?? null;
}

/**
 * Find a `wiki_pages.slug` that is free, starting from `base`. Drug slugs are
 * derived from the drug name (same source as `drugs.slug`), but the wiki slug
 * namespace also holds topic pages, so a collision is possible. Append `-2`,
 * `-3`, … until a gap is found.
 */
async function resolveUniqueSlug(db: Db, base: string): Promise<string> {
  const root = base || 'drug';
  let candidate = root;
  for (let suffix = 2; suffix <= 100; suffix++) {
    const [hit] = await db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(eq(wikiPages.slug, candidate))
      .limit(1);
    if (!hit) return candidate;
    candidate = `${root}-${suffix}`;
  }
  // Pathological collision count — fall back to a guaranteed-unique suffix.
  return `${root}-${Date.now()}`;
}

export interface EnsureMonographResult {
  page: { id: number; slug: string };
  created: boolean;
}

/**
 * Ensure a drug has a monograph wiki page, creating an empty one if missing.
 * Idempotent: if a monograph already exists for the drug (linked by internal id
 * or, for legacy rows, by PubChem CID) it is returned untouched.
 *
 * @param db   Drizzle instance (passed in so the backfill script can use its
 *             own connection and callers can share a request-scoped db).
 * @param drug The drug to attach the monograph to.
 * @param userId User id recorded as the page/revision author.
 */
export async function ensureDrugMonograph(
  db: Db,
  drug: MonographDrug,
  userId: number,
): Promise<EnsureMonographResult> {
  // wiki_pages.drug_cid normally stores drugs.id, but some legacy rows carry a
  // PubChem CID. Check both so we never double-create for an existing link —
  // while excluding a CID that is actually another drug's internal id, which
  // would otherwise match (and "adopt") that unrelated drug's monograph.
  const candidateCids = await resolveMonographDrugCids(db, drug);

  const [existing] = await db
    .select({ id: wikiPages.id, slug: wikiPages.slug })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.pageType, 'drug_monograph'),
        inArray(wikiPages.drugCid, candidateCids),
      ),
    )
    .limit(1);
  if (existing) return { page: existing, created: false };

  const title =
    resolveDrugName(drug.names, 'nb') ||
    resolveDrugName(drug.names, 'en') ||
    `Drug ${drug.id}`;
  const slug = await resolveUniqueSlug(db, generateSlug(title));
  const contentHtml = renderHtml(EMPTY_DOC);
  const contentPlaintext = extractPlaintext(EMPTY_DOC);

  const [page] = await db
    .insert(wikiPages)
    .values({
      slug,
      title,
      content: EMPTY_DOC as never,
      contentHtml,
      contentPlaintext,
      pageType: 'drug_monograph',
      drugCid: drug.id,
      status: 'published',
      createdBy: userId,
      updatedBy: userId,
    })
    .returning({ id: wikiPages.id, slug: wikiPages.slug });

  if (!page) throw new Error('Failed to create monograph page');

  await db.insert(wikiRevisions).values({
    pageId: page.id,
    content: EMPTY_DOC as never,
    contentHtml,
    editSummary: 'Automatisk opprettet monografi',
    createdBy: userId,
  });

  return { page, created: true };
}

/** Minimal bio-entity shape needed to mint an entity monograph. */
export interface MonographEntity {
  id: number;
  symbol: string;
  name: string;
  nameEn?: string | null;
}

/** Slug of the top-level wiki page every entity monograph hangs under. */
export const ENTITY_HUB_SLUG = 'bioentiteter';
const ENTITY_HUB_TITLE = 'Bioentiteter';

/**
 * Ensure the top-level "Bioentiteter" topic page exists and return its id.
 * Entity monographs are its subpages, so the wiki index lists every entity
 * under one card instead of one card per entity. Looked up by slug, so a hub
 * an editor created by hand is reused rather than duplicated. Idempotent.
 */
export async function ensureEntityHubPage(
  db: Db,
  userId: number,
): Promise<number> {
  const findHub = async () => {
    const [row] = await db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(eq(wikiPages.slug, ENTITY_HUB_SLUG))
      .limit(1);
    return row?.id ?? null;
  };

  const existingId = await findHub();
  if (existingId != null) return existingId;

  const contentHtml = renderHtml(EMPTY_DOC);
  const [page] = await db
    .insert(wikiPages)
    .values({
      slug: ENTITY_HUB_SLUG,
      title: ENTITY_HUB_TITLE,
      content: EMPTY_DOC as never,
      contentHtml,
      contentPlaintext: extractPlaintext(EMPTY_DOC),
      pageType: 'topic',
      status: 'published',
      createdBy: userId,
      updatedBy: userId,
    })
    // A concurrent caller may have created it between the lookup and here.
    .onConflictDoNothing({ target: wikiPages.slug })
    .returning({ id: wikiPages.id });

  if (!page) {
    const racedId = await findHub();
    if (racedId == null) throw new Error('Failed to create entity hub page');
    return racedId;
  }

  await db.insert(wikiRevisions).values({
    pageId: page.id,
    content: EMPTY_DOC as never,
    contentHtml,
    editSummary: 'Automatisk opprettet samleside for bioentiteter',
    createdBy: userId,
  });

  return page.id;
}

/**
 * Ensure a biological entity (#785) has its own narrative monograph wiki page,
 * creating an empty one if missing. Mirrors {@link ensureDrugMonograph}: an
 * entity monograph is a `wiki_pages` row (`page_type='entity_monograph'`) linked
 * by `entity_id`, reusing the topic-page content model. The page is a subpage
 * of the "Bioentiteter" hub ({@link ensureEntityHubPage}). Idempotent.
 */
export async function ensureEntityMonograph(
  db: Db,
  entity: MonographEntity,
  userId: number,
): Promise<EnsureMonographResult> {
  const hubId = await ensureEntityHubPage(db, userId);
  const [existing] = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      parentId: wikiPages.parentId,
    })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.pageType, 'entity_monograph'),
        eq(wikiPages.entityId, entity.id),
      ),
    )
    .limit(1);
  if (existing) {
    // Adopt a stray top-level monograph into the hub. A page an editor has
    // deliberately placed under some other parent is left where it is.
    if (existing.parentId == null) {
      await db
        .update(wikiPages)
        .set({ parentId: hubId })
        .where(and(eq(wikiPages.id, existing.id), isNull(wikiPages.parentId)));
    }
    return { page: { id: existing.id, slug: existing.slug }, created: false };
  }

  // Norwegian first, like `ensureDrugMonograph` above and the `name` / `nameEn`
  // convention the catalog itself follows: `name` is the primary display name
  // and `nameEn` the English alternate, so preferring `nameEn` here published
  // an English-titled page for every entity that carried both.
  const title = entity.name || entity.nameEn || entity.symbol || `Entity ${entity.id}`;
  const slug = await resolveUniqueSlug(db, generateSlug(title));
  const contentHtml = renderHtml(EMPTY_DOC);
  const contentPlaintext = extractPlaintext(EMPTY_DOC);

  const [page] = await db
    .insert(wikiPages)
    .values({
      slug,
      title,
      content: EMPTY_DOC as never,
      contentHtml,
      contentPlaintext,
      pageType: 'entity_monograph',
      entityId: entity.id,
      parentId: hubId,
      status: 'published',
      createdBy: userId,
      updatedBy: userId,
    })
    .returning({ id: wikiPages.id, slug: wikiPages.slug });

  if (!page) throw new Error('Failed to create entity monograph page');

  await db.insert(wikiRevisions).values({
    pageId: page.id,
    content: EMPTY_DOC as never,
    contentHtml,
    editSummary: 'Automatisk opprettet entitetsmonografi',
    createdBy: userId,
  });

  return { page, created: true };
}

/**
 * Give every bio entity a monograph under the "Bioentiteter" hub. Entity
 * creation through the API mints one up front, but the seeded catalog and the
 * import paths (`findOrCreateEntityBySymbol`) do not, so this sweep covers
 * them. Only entities with no monograph, or a top-level one, are touched, so
 * a run with nothing to do costs one query. Idempotent.
 */
export async function ensureAllEntityMonographs(
  db: Db,
  userId: number,
): Promise<{ created: number; adopted: number }> {
  const rows = await db
    .select({
      id: bioEntities.id,
      symbol: bioEntities.symbol,
      name: bioEntities.name,
      nameEn: bioEntities.nameEn,
    })
    .from(bioEntities)
    .leftJoin(
      wikiPages,
      and(
        eq(wikiPages.pageType, 'entity_monograph'),
        eq(wikiPages.entityId, bioEntities.id),
      ),
    )
    .where(or(isNull(wikiPages.id), isNull(wikiPages.parentId)))
    .orderBy(asc(bioEntities.id));

  let created = 0;
  let adopted = 0;
  for (const entity of rows) {
    const result = await ensureEntityMonograph(db, entity, userId);
    if (result.created) created++;
    else adopted++;
  }
  return { created, adopted };
}
