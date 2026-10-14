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
import { and, asc, eq, isNull, notExists, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
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
}

type Db = ReturnType<typeof getDb>;

const EMPTY_DOC = { type: 'doc', content: [] } as const;

/**
 * Monograph pages still keyed by a legacy PubChem CID: `drug_monograph` rows
 * whose `drug_cid` is `cid` while no drug has `cid` as its `drugs.id`.
 * Migration 0148 leaves such a page where it cannot place it unambiguously
 * (its drug already had a monograph, or two pages shared the CID), and the
 * per-deploy link repair (`scripts/fix-monograph-links-build.ts`) keeps its
 * hands off it only while some drug still carries `cid` as its PubChem CID.
 *
 * So every path that retires a CID — deleting or merging away the drug that
 * holds it, or moving it with `retarget:cid` — must refuse while this returns
 * rows. Otherwise the next deploy links the page by title or creates a drug
 * for it, quietly reversing the delete or merge. Pass the transaction handle
 * so the check sees the same rows the retiring write does.
 */
export async function findLegacyCidKeyedMonographs(
  db: Db,
  cid: number,
): Promise<{ id: number; slug: string }[]> {
  const res = await db.execute<{ id: number; slug: string }>(sql`
    SELECT wp.id, wp.slug FROM wiki_pages wp
    WHERE wp.page_type = 'drug_monograph'
      AND wp.drug_cid = ${cid}
      AND NOT EXISTS (SELECT 1 FROM drugs WHERE id = ${cid})`);
  return res.rows.map((r) => ({ id: Number(r.id), slug: String(r.slug) }));
}

/** English refusal for {@link findLegacyCidKeyedMonographs} rows (scripts and API logs). */
export function legacyCidMonographRefusal(
  cid: number,
  pages: { slug: string }[],
): string {
  return (
    `${pages.length} monograph page(s) are still keyed by the legacy CID ${cid} ` +
    `(${pages.map((p) => `/${p.slug}`).join(', ')}), which migration 0148 could ` +
    `not place. Retiring the CID would leave them unprotected, and the next deploy ` +
    `would link them by title or create a drug for them. Settle them with ` +
    `scripts/fix-monograph-drug-links.ts first`
  );
}

/**
 * The `drugs.id` that owns a monograph's `wiki_pages.drug_cid`, or null when
 * no drug does (the page is dangling). Despite its name the column holds
 * `drugs.id` and nothing else — the PubChem CIDs the retired monograph seed
 * once wrote there were moved onto `drugs.id` by migration 0148 — so this is
 * an existence check, never a CID lookup. A number that is some drug's PubChem
 * CID but no drug's id names no drug here.
 *
 * Used by pending-edit submit paths that need to take the same per-drug
 * advisory lock the drug-merge admin holds, keyed by the drug that still
 * exists rather than by whatever number the page carries.
 */
export async function resolveOwningDrugIdForMonograph(
  db: Db,
  drugCid: number,
): Promise<number | null> {
  const [byId] = await db
    .select({ id: drugs.id })
    .from(drugs)
    .where(eq(drugs.id, drugCid))
    .limit(1);
  return byId?.id ?? null;
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
 * Idempotent: if a monograph already exists for the drug (`drug_cid` equal to
 * its `drugs.id`) it is returned untouched.
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
  const [existing] = await db
    .select({ id: wikiPages.id, slug: wikiPages.slug })
    .from(wikiPages)
    .where(
      and(
        eq(wikiPages.pageType, 'drug_monograph'),
        eq(wikiPages.drugCid, drug.id),
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
 *
 * A page already sitting on the slug is only reused when it is a published
 * topic: the wiki index hides drafts and non-topic pages, so adopting one would
 * hang every entity monograph under a hub nobody can see. Such a page is
 * refused (thrown) rather than silently repaired, since it is editor content.
 */
export async function ensureEntityHubPage(
  db: Db,
  userId: number,
): Promise<number> {
  const findHub = async () => {
    const [row] = await db
      .select({
        id: wikiPages.id,
        pageType: wikiPages.pageType,
        status: wikiPages.status,
      })
      .from(wikiPages)
      .where(eq(wikiPages.slug, ENTITY_HUB_SLUG))
      .limit(1);
    if (!row) return null;
    if (row.pageType !== 'topic' || row.status !== 'published') {
      throw new Error(
        `Page "${ENTITY_HUB_SLUG}" cannot serve as the entity hub: it must be a published topic page (found ${row.pageType}, ${row.status})`,
      );
    }
    return row.id;
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
    // A parent that no longer exists (`parent_id` has no foreign key, so
    // deleting the old hub leaves its children pointing at it) is not a
    // deliberate placement either.
    const parentGone =
      existing.parentId != null &&
      (await db
        .select({ id: wikiPages.id })
        .from(wikiPages)
        .where(eq(wikiPages.id, existing.parentId))
        .limit(1)).length === 0;
    if (existing.parentId == null || parentGone) {
      await db
        .update(wikiPages)
        .set({ parentId: hubId })
        .where(
          and(
            eq(wikiPages.id, existing.id),
            existing.parentId == null
              ? isNull(wikiPages.parentId)
              : eq(wikiPages.parentId, existing.parentId),
          ),
        );
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
  const parentPages = alias(wikiPages, 'parent_pages');
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
    .where(
      or(
        isNull(wikiPages.id),
        isNull(wikiPages.parentId),
        // Dangling parent: the page it was filed under has been deleted.
        notExists(
          db
            .select({ one: sql`1` })
            .from(parentPages)
            .where(eq(parentPages.id, wikiPages.parentId)),
        ),
      ),
    )
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
