/**
 * `scripts/fix-monograph-links-build.ts` Case 1 — remapping a legacy
 * PubChem-CID-keyed `wiki_pages.drug_cid` onto the modern `drugs.id`.
 *
 * Runs on every deploy, unattended. Before #1256 item 7 this remapped a
 * legacy row even when another `drug_monograph` page already linked the
 * target drug modernly, producing a second, empty page beside the one
 * that already had content — the exact failure this test guards against.
 *
 * Runs the real production statement (imported, not hand-copied) so this
 * cannot drift from what ships — same approach as
 * `tests/integration/migration-0104-pubchem-repoints.test.ts`.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drugs, wikiPages } from '../../db/schema.js';
import {
  REMAP_LEGACY_CID_SQL,
  NAME_MATCH_SQL,
  DANGLING_MONOGRAPH_PAGES_SQL,
} from '../../scripts/lib/monograph-legacy-cid-remap-sql.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let userId: number;

async function runRemap(): Promise<void> {
  await db.execute(sql.raw(REMAP_LEGACY_CID_SQL));
}

async function runNameMatch(): Promise<void> {
  await db.execute(sql.raw(NAME_MATCH_SQL));
}

function rowsOf(res: unknown): Record<string, unknown>[] {
  return ((res as { rows?: unknown[] }).rows ?? (res as unknown[])) as Record<
    string,
    unknown
  >[];
}

async function danglingPageIds(): Promise<number[]> {
  const res = await db.execute(sql.raw(DANGLING_MONOGRAPH_PAGES_SQL));
  return rowsOf(res).map((r) => r.id as number);
}

async function seedMonograph(
  drugCid: number | null,
  over: { slug: string; title: string },
): Promise<number> {
  const [page] = await db
    .insert(wikiPages)
    .values({
      slug: over.slug,
      title: over.title,
      pageType: 'drug_monograph',
      drugCid,
      createdBy: userId,
      updatedBy: userId,
    })
    .returning({ id: wikiPages.id });
  return page!.id;
}

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  userId = await seedUser(db);
});

describe('fix-monograph-links-build Case 1 — legacy CID remap', () => {
  it('remaps a legacy CID-keyed page onto the modern drugs.id', async () => {
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: 9881504 });
    const page = await seedMonograph(9881504, {
      slug: 'eslikarbazepin',
      title: 'Eslikarbazepin',
    });

    await runRemap();

    const [row] = await db
      .select({ drugCid: wikiPages.drugCid })
      .from(wikiPages)
      .where(eq(wikiPages.id, page));
    expect(row?.drugCid).toBe(id);
  });

  it('does not remap when another page already links that drug modernly', async () => {
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: 9881504 });
    // The modern page — already correctly linked by drugs.id.
    await seedMonograph(id, { slug: 'eslikarbazepin', title: 'Eslikarbazepin (ny)' });
    // A stray legacy row for the same drug, keyed by its old CID.
    const legacyPage = await seedMonograph(9881504, {
      slug: 'eslikarbazepin-gammel',
      title: 'Eslikarbazepin (gammel)',
    });

    await runRemap();

    const [row] = await db
      .select({ drugCid: wikiPages.drugCid })
      .from(wikiPages)
      .where(eq(wikiPages.id, legacyPage));
    // Left at the legacy CID, not stolen onto the drug the other page
    // already owns — remapping it would have produced a second page for
    // the same drug, the exact bug #1256 item 7 describes.
    expect(row?.drugCid).toBe(9881504);
  });

  it('is idempotent', async () => {
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: 9881504 });
    const page = await seedMonograph(9881504, {
      slug: 'eslikarbazepin',
      title: 'Eslikarbazepin',
    });

    await runRemap();
    await runRemap();

    const [row] = await db
      .select({ drugCid: wikiPages.drugCid })
      .from(wikiPages)
      .where(eq(wikiPages.id, page));
    expect(row?.drugCid).toBe(id);
  });

  it('leaves a page alone when its drug_cid already is a valid drugs.id', async () => {
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: 9881504 });
    const page = await seedMonograph(id, { slug: 'eslikarbazepin', title: 'Eslikarbazepin' });

    await runRemap();

    const [row] = await db
      .select({ drugCid: wikiPages.drugCid })
      .from(wikiPages)
      .where(eq(wikiPages.id, page));
    expect(row?.drugCid).toBe(id);
  });
});

describe('fix-monograph-links-build Cases 2/3 — collision exclusion propagates', () => {
  it('Case 2 does not link a collision page by its own drug name match', async () => {
    const id = await seedDrug(db, {
      slug: 'eslicarbazepine',
      names: { nb: 'Eslikarbazepin' },
      pubchemCid: 9881504,
    });
    // The modern page — already correctly linked by drugs.id.
    await seedMonograph(id, { slug: 'eslikarbazepin', title: 'Eslikarbazepin (ny)' });
    // A stray legacy row for the same drug, titled to match its own name —
    // exactly what would make Case 2 link it if the guard didn't exclude it.
    const legacyPage = await seedMonograph(9881504, {
      slug: 'eslikarbazepin-gammel',
      title: 'Eslikarbazepin',
    });

    // Real script order: Case 1 first (declines, same as the test above),
    // then Case 2.
    await runRemap();
    await runNameMatch();

    const [row] = await db
      .select({ drugCid: wikiPages.drugCid })
      .from(wikiPages)
      .where(eq(wikiPages.id, legacyPage));
    // Left at the legacy CID — Case 2 must not recreate the duplicate Case 1
    // just declined to create.
    expect(row?.drugCid).toBe(9881504);
  });

  it('Case 3 does not offer a collision page as a candidate for a new drug', async () => {
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: 9881504 });
    await seedMonograph(id, { slug: 'eslikarbazepin', title: 'Eslikarbazepin (ny)' });
    const legacyPage = await seedMonograph(9881504, {
      slug: 'eslikarbazepin-gammel',
      // No drug is named this, so without the guard Case 3 would create a
      // spurious second drug row for what is really just a stray duplicate
      // page.
      title: 'Eslikarbazepin (duplikat)',
    });

    const candidates = await danglingPageIds();

    expect(candidates).not.toContain(legacyPage);
  });

  it('still offers a genuinely dangling page (no collision) to Case 3', async () => {
    const orphanPage = await seedMonograph(999999, {
      slug: 'ukjent-stoff',
      title: 'Ukjent stoff',
    });

    const candidates = await danglingPageIds();

    expect(candidates).toContain(orphanPage);
  });
});
