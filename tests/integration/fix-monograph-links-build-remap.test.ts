/**
 * `scripts/fix-monograph-links-build.ts` — the per-deploy repair of dangling
 * `drug_monograph` pages, and its collision guard.
 *
 * Runs on every deploy, unattended. A page whose `drug_cid` is still some
 * drug's PubChem CID is one migration 0148 declined to move onto `drugs.id`
 * because that drug already had a monograph; linking it anyway, by title or
 * by inventing a drug for it, would produce the second page beside the one
 * that already has content (#1256 item 7) — the failure this test guards
 * against. The CID remap itself is migration 0148 and is tested there.
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
import { findLegacyCidKeyedMonographs } from '../../api/_lib/monograph-helpers.js';

let db: IntegrationDb;
let userId: number;

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

describe('fix-monograph-links-build — a page 0148 declined stays dangling', () => {
  it('Case 1 does not link a collision page by its own drug name match', async () => {
    const id = await seedDrug(db, {
      slug: 'eslicarbazepine',
      names: { nb: 'Eslikarbazepin' },
      pubchemCid: 9881504,
    });
    // The modern page — already correctly linked by drugs.id.
    await seedMonograph(id, { slug: 'eslikarbazepin', title: 'Eslikarbazepin (ny)' });
    // A stray legacy row for the same drug, titled to match its own name —
    // exactly what would make Case 1 link it if the guard didn't exclude it.
    const legacyPage = await seedMonograph(9881504, {
      slug: 'eslikarbazepin-gammel',
      title: 'Eslikarbazepin',
    });

    await runNameMatch();

    const [row] = await db
      .select({ drugCid: wikiPages.drugCid })
      .from(wikiPages)
      .where(eq(wikiPages.id, legacyPage));
    // Left at the legacy CID — Case 1 must not recreate the duplicate
    // migration 0148 declined to create.
    expect(row?.drugCid).toBe(9881504);
  });

  it('Case 2 does not offer a collision page as a candidate for a new drug', async () => {
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: 9881504 });
    await seedMonograph(id, { slug: 'eslikarbazepin', title: 'Eslikarbazepin (ny)' });
    const legacyPage = await seedMonograph(9881504, {
      slug: 'eslikarbazepin-gammel',
      // No drug is named this, so without the guard Case 2 would create a
      // spurious second drug row for what is really just a stray duplicate
      // page.
      title: 'Eslikarbazepin (duplikat)',
    });

    const candidates = await danglingPageIds();

    expect(candidates).not.toContain(legacyPage);
  });

  it('leaves two pages sharing one drug\'s CID for a human', async () => {
    // The drug has no monograph yet, but two pages carry its CID; 0148 moves
    // neither, since moving both would give it two. Linking them by title here
    // would do exactly that.
    await seedDrug(db, {
      slug: 'eslicarbazepine',
      names: { nb: 'Eslikarbazepin' },
      pubchemCid: 9881504,
    });
    const first = await seedMonograph(9881504, {
      slug: 'eslikarbazepin',
      title: 'Eslikarbazepin',
    });
    const second = await seedMonograph(9881504, {
      slug: 'eslikarbazepin-2',
      title: 'Eslikarbazepin',
    });

    await runNameMatch();

    const rows = await db
      .select({ drugCid: wikiPages.drugCid })
      .from(wikiPages)
      .where(eq(wikiPages.pageType, 'drug_monograph'));
    expect(rows.map((r) => r.drugCid)).toEqual([9881504, 9881504]);
    const candidates = await danglingPageIds();
    expect(candidates).not.toContain(first);
    expect(candidates).not.toContain(second);
  });

  it('still offers a genuinely dangling page (no collision) to Case 2', async () => {
    const orphanPage = await seedMonograph(999999, {
      slug: 'ukjent-stoff',
      title: 'Ukjent stoff',
    });

    const candidates = await danglingPageIds();

    expect(candidates).toContain(orphanPage);
  });
});

describe('findLegacyCidKeyedMonographs — what a CID-retiring path must refuse on', () => {
  async function legacyPagesFor(cid: number): Promise<number[]> {
    const rows = await findLegacyCidKeyedMonographs(
      db as unknown as Parameters<typeof findLegacyCidKeyedMonographs>[0],
      cid,
    );
    return rows.map((r) => r.id);
  }

  it('finds a declined legacy page keyed by the CID', async () => {
    // Retiring 9881504 (retarget:cid, or a merge that frees it) would end the
    // collision guard's protection for this page, and the next deploy would
    // link it by title or invent a drug for it.
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: 9881504 });
    await seedMonograph(id, { slug: 'eslikarbazepin', title: 'Eslikarbazepin (ny)' });
    const legacyPage = await seedMonograph(9881504, {
      slug: 'eslikarbazepin-gammel',
      title: 'Eslikarbazepin',
    });

    expect(await legacyPagesFor(9881504)).toEqual([legacyPage]);
  });

  it("ignores a page whose number is some drug's id", async () => {
    // The number is both drug A's id and drug B's CID: the page is A's modern
    // monograph, and changing B's CID leaves it alone.
    const a = await seedDrug(db, { slug: 'drug-a' });
    await seedDrug(db, { slug: 'drug-b', pubchemCid: a });
    await seedMonograph(a, { slug: 'drug-a', title: 'Drug A' });

    expect(await legacyPagesFor(a)).toEqual([]);
  });
});
