/**
 * Migration 0148 — moving the last PubChem-CID-keyed monograph pages onto
 * `drugs.id`, so `wiki_pages.drug_cid` means one thing and the readers can stop
 * interpreting it as a CID.
 *
 * What is worth pinning is what it must NOT move: a page whose number is some
 * drug's internal id (it is that drug's modern monograph, whatever other drug's
 * CID the number also is), and a page whose placement would give a drug two
 * monographs. Getting either wrong moves a written page onto the wrong
 * substance, silently.
 *
 * The harness truncates every table between tests, so the migration's own pass
 * (against an empty database) leaves nothing to observe. The real statement is
 * read out of the .sql file and re-run against seeded rows — the same approach
 * as the 0104 test, so this cannot drift from what ships.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { wikiPages } from '../../db/schema.js';
import {
  ensureDrugMonograph,
  resolveOwningDrugIdForMonograph,
} from '../../api/_lib/monograph-helpers.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let userId: number;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  HERE,
  '../../drizzle/0148_monograph_drug_cid_single_id_space.sql',
);

async function runMigration(): Promise<void> {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
}

async function seedMonograph(
  drugCid: number | null,
  slug: string,
): Promise<number> {
  const [page] = await db
    .insert(wikiPages)
    .values({
      slug,
      title: slug,
      pageType: 'drug_monograph',
      drugCid,
      createdBy: userId,
      updatedBy: userId,
    })
    .returning({ id: wikiPages.id });
  return page!.id;
}

async function drugCidOf(pageId: number): Promise<number | null> {
  const [row] = await db
    .select({ drugCid: wikiPages.drugCid })
    .from(wikiPages)
    .where(eq(wikiPages.id, pageId));
  return row?.drugCid ?? null;
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

describe('migration 0148 — monograph drug_cid holds drugs.id only', () => {
  it('moves a CID-keyed page onto the drug that carries that CID', async () => {
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: 9881504 });
    const page = await seedMonograph(9881504, 'eslikarbazepin');

    await runMigration();

    expect(await drugCidOf(page)).toBe(id);
  });

  it('leaves a page whose number is a drug id, even when it is also another drug\'s CID', async () => {
    // 25C-NBOMe id=281 vs carbon monoxide CID 281, in miniature: the page is
    // the first drug's modern monograph, and moving it would hand it to the
    // second.
    const owner = await seedDrug(db, { slug: '25c-nbome' });
    await seedDrug(db, { slug: 'carbon-monoxide', pubchemCid: owner });
    const page = await seedMonograph(owner, '25c-nbome');

    await runMigration();

    expect(await drugCidOf(page)).toBe(owner);
  });

  it('leaves a CID-keyed page when the drug already has a monograph', async () => {
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: 9881504 });
    const modern = await seedMonograph(id, 'eslikarbazepin');
    const legacy = await seedMonograph(9881504, 'eslikarbazepin-gammel');

    await runMigration();

    // Moving it would give the drug two monographs; which survives is a
    // human's call.
    expect(await drugCidOf(legacy)).toBe(9881504);
    expect(await drugCidOf(modern)).toBe(id);
  });

  it('leaves two pages that carry the same CID', async () => {
    await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: 9881504 });
    const first = await seedMonograph(9881504, 'eslikarbazepin');
    const second = await seedMonograph(9881504, 'eslikarbazepin-2');

    await runMigration();

    // One UPDATE sees the same snapshot for both, so without the twin guard
    // each would find the drug page-less and both would move onto it.
    expect(await drugCidOf(first)).toBe(9881504);
    expect(await drugCidOf(second)).toBe(9881504);
  });

  it('leaves a dangling page whose number is no drug\'s id or CID', async () => {
    const page = await seedMonograph(999999, 'ukjent-stoff');
    const unlinked = await seedMonograph(null, 'uten-lenke');

    await runMigration();

    expect(await drugCidOf(page)).toBe(999999);
    expect(await drugCidOf(unlinked)).toBeNull();
  });

  it('does not touch a topic page that happens to carry a CID', async () => {
    await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: 9881504 });
    const [topic] = await db
      .insert(wikiPages)
      .values({
        slug: 'emne',
        title: 'Emne',
        pageType: 'topic',
        drugCid: 9881504,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning({ id: wikiPages.id });

    await runMigration();

    expect(await drugCidOf(topic!.id)).toBe(9881504);
  });

  it('is idempotent', async () => {
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: 9881504 });
    const page = await seedMonograph(9881504, 'eslikarbazepin');

    await runMigration();
    await runMigration();

    expect(await drugCidOf(page)).toBe(id);
  });
});

describe('after 0148 — a CID-keyed page is no drug\'s monograph', () => {
  it('ensureDrugMonograph does not adopt a page carrying the drug\'s CID', async () => {
    // A page 0148 left behind (or any page someone keys by a CID by hand) is
    // dangling. Adopting it as this drug's monograph is the reading that, with
    // overlapping id spaces, hands one drug's page to another.
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: 9881504 });
    const cidKeyed = await seedMonograph(9881504, 'eslikarbazepin-gammel');

    const ensured = await ensureDrugMonograph(
      db as never,
      { id, names: { nb: 'Eslikarbazepin', en: 'Eslicarbazepine' } },
      userId,
    );

    expect(ensured.created).toBe(true);
    expect(ensured.page.id).not.toBe(cidKeyed);
    expect(await drugCidOf(ensured.page.id)).toBe(id);
  });

  it('resolveOwningDrugIdForMonograph does not read the number as a CID', async () => {
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: 9881504 });

    expect(await resolveOwningDrugIdForMonograph(db as never, id)).toBe(id);
    expect(await resolveOwningDrugIdForMonograph(db as never, 9881504)).toBeNull();
  });
});
