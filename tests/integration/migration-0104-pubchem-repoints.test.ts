/**
 * Migration 0104 — repointing two drugs whose `pubchem_cid` named a different
 * PubChem record than the drug.
 *
 * The correction itself is one column. What makes it worth a test is everything
 * keyed by the number rather than by the row: a legacy monograph link, and
 * saved simulator cases. `case_data.drugs[].drugId` is
 * `String(pubchemCid ?? id)` and `hydrateComponentByRouteId` resolves it as a
 * CID first, falling back to an internal id — so a stale key does not fail
 * loudly, it loads whatever drug happens to have that internal id. That is the
 * failure this migration exists to prevent, and it is invisible from the schema.
 *
 * The harness truncates every table between tests, so the migration's own pass
 * (against an empty database) leaves nothing to observe. The real statements are
 * pulled out of the .sql file and re-run against seeded rows — the same approach
 * as the 0078, 0087 and 0098 tests, so this cannot drift from what ships.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drugs, simulatorCases, wikiPages } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
let userId: number;

/** Eslikarbazepin. The pair with no duplicate row anywhere. */
const OLD = 195085;
const NEW = 9881504;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(HERE, '../../drizzle/0104_pubchem_identity_repoints.sql');

function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runMigration(): Promise<void> {
  for (const statement of migrationStatements()) {
    await db.execute(sql.raw(statement));
  }
}

/** A saved case pinning one drug by the key the simulator writes. */
async function seedCase(name: string, drugKey: string): Promise<number> {
  const [row] = await db
    .insert(simulatorCases)
    .values({
      name,
      caseData: { drugs: [{ drugId: drugKey, doses: [] }] },
      createdBy: userId,
    })
    .returning({ id: simulatorCases.id });
  return row!.id;
}

async function caseKeys(id: number): Promise<string[]> {
  const [row] = await db
    .select({ data: simulatorCases.caseData })
    .from(simulatorCases)
    .where(eq(simulatorCases.id, id));
  const data = row!.data as { drugs: { drugId: string }[] };
  return data.drugs.map((d) => d.drugId);
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

describe('migration 0104 — PubChem identity repoints', () => {
  it('corrects the CID in place, keeping the row and everything hanging off it', async () => {
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: OLD });

    await runMigration();

    const [row] = await db.select().from(drugs).where(eq(drugs.id, id));
    // Same id, so all 16 cascade children stay attached — the whole reason
    // this is an UPDATE and not a merge.
    expect(row?.id).toBe(id);
    expect(row?.pubchemCid).toBe(NEW);
    expect(row?.slug).toBe('eslicarbazepine');
  });

  it('moves a legacy monograph that stored the CID instead of the row id', async () => {
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: OLD });
    const [page] = await db
      .insert(wikiPages)
      .values({
        slug: 'eslikarbazepin',
        title: 'Eslikarbazepin',
        pageType: 'drug_monograph',
        drugCid: OLD,
        createdBy: userId,
        updatedBy: userId,
      })
      .returning({ id: wikiPages.id });

    await runMigration();

    const [after] = await db
      .select({ drugCid: wikiPages.drugCid })
      .from(wikiPages)
      .where(eq(wikiPages.id, page!.id));
    // Onto the row id, which is what `ensureDrugMonograph` writes today. Left
    // at the old CID it would strand, and the next backfill would build a
    // second, empty monograph beside the written one.
    expect(after?.drugCid).toBe(id);
  });

  it('rewrites saved cases pinned to the retired number', async () => {
    await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: OLD });
    const stale = await seedCase('Eslikarbazepin-kasus', String(OLD));
    const other = await seedCase('Annet kasus', '2244');

    await runMigration();

    expect(await caseKeys(stale)).toEqual([String(NEW)]);
    // Only the matching key moves. `jsonb_agg` rebuilds the whole array, so a
    // case naming several drugs is the one that would lose the others.
    expect(await caseKeys(other)).toEqual(['2244']);
  });

  it('rewrites only the matching entry in a multi-drug case', async () => {
    await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: OLD });
    const [row] = await db
      .insert(simulatorCases)
      .values({
        name: 'Kombinasjon',
        caseData: {
          drugs: [{ drugId: '2244' }, { drugId: String(OLD) }, { drugId: '3672' }],
        },
        createdBy: userId,
      })
      .returning({ id: simulatorCases.id });

    await runMigration();

    expect(await caseKeys(row!.id)).toEqual(['2244', String(NEW), '3672']);
  });

  it('leaves a database that already holds both rows for a reviewed merge', async () => {
    const stale = await seedDrug(db, { slug: 'eslicarbazepine-old', pubchemCid: OLD });
    const canonical = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: NEW });
    const pinned = await seedCase('Kasus på gammel rad', String(OLD));

    await runMigration();

    // Two rows for one substance is a duplicate needing a human decision about
    // which parameter values and method memberships survive. Picking one here
    // would move data nobody reviewed, so the guard declines.
    const [old] = await db.select().from(drugs).where(eq(drugs.id, stale));
    expect(old?.pubchemCid).toBe(OLD);
    const [keep] = await db.select().from(drugs).where(eq(drugs.id, canonical));
    expect(keep?.pubchemCid).toBe(NEW);
    // And the cases stay put: the row they name is still there and still
    // resolves. Rewriting them would be the bug, not the fix.
    expect(await caseKeys(pinned)).toEqual([String(OLD)]);
  });

  it('leaves the drug alone when saved cases pin an ambiguous number', async () => {
    // `String(pubchemCid ?? id)` makes the key ambiguous whenever a CID-less
    // drug's internal id equals someone else's CID: some of these cases mean
    // the drug being repointed, some mean the namesake, and nothing on the row
    // says which.
    await db.execute(sql`
      INSERT INTO drugs (id, slug, names, pubchem_cid)
      VALUES (${OLD}, 'namesake', ${JSON.stringify({ nb: 'Navnebror' })}::jsonb, NULL)
    `);
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: OLD });
    const pinned = await seedCase('Tvetydig kasus', String(OLD));

    await runMigration();

    // Repointing while leaving the cases behind would MANUFACTURE the bug this
    // migration exists to prevent: the CID lookup would find nothing and the id
    // fallback would hand every one of these cases to the namesake. So the
    // whole repoint stands down, the way `retarget-pubchem-cid.ts` refuses.
    const [row] = await db.select().from(drugs).where(eq(drugs.id, id));
    expect(row?.pubchemCid).toBe(OLD);
    expect(await caseKeys(pinned)).toEqual([String(OLD)]);
  });

  it('still repoints when the namesake exists but no case pins the number', async () => {
    // The ambiguity only bites through the saved cases. With none pinned there
    // is nothing to misresolve, so standing down would leave `seed:drugs`
    // aborting for no reason.
    await db.execute(sql`
      INSERT INTO drugs (id, slug, names, pubchem_cid)
      VALUES (${OLD}, 'namesake', ${JSON.stringify({ nb: 'Navnebror' })}::jsonb, NULL)
    `);
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: OLD });

    await runMigration();

    const [row] = await db.select().from(drugs).where(eq(drugs.id, id));
    expect(row?.pubchemCid).toBe(NEW);
  });

  it('declines when the NEW number is already a CID-less drug\'s internal id', async () => {
    // Taking a CID that another row carries as its internal id makes the CID
    // lookup win over the id fallback, so every saved case for that drug —
    // existing and future — would load the repointed substance instead.
    await db.execute(sql`
      INSERT INTO drugs (id, slug, names, pubchem_cid)
      VALUES (${NEW}, 'skyggerad', ${JSON.stringify({ nb: 'Skyggerad' })}::jsonb, NULL)
    `);
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: OLD });

    await runMigration();

    const [row] = await db.select().from(drugs).where(eq(drugs.id, id));
    expect(row?.pubchemCid).toBe(OLD);
  });

  it('declines on the new number even when no case uses it yet', async () => {
    // No "only when cases exist today" version of that guard: the shadowed
    // drug still has no CID afterwards, so the first case saved for it later
    // resolves to the wrong substance too.
    await db.execute(sql`
      INSERT INTO drugs (id, slug, names, pubchem_cid)
      VALUES (${NEW}, 'skyggerad', ${JSON.stringify({ nb: 'Skyggerad' })}::jsonb, NULL)
    `);
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: OLD });
    const rows = await db.select().from(simulatorCases);
    expect(rows).toHaveLength(0);

    await runMigration();

    const [row] = await db.select().from(drugs).where(eq(drugs.id, id));
    expect(row?.pubchemCid).toBe(OLD);
  });

  it('is idempotent', async () => {
    const id = await seedDrug(db, { slug: 'eslicarbazepine', pubchemCid: OLD });
    const pinned = await seedCase('Eslikarbazepin-kasus', String(OLD));

    await runMigration();
    await runMigration();

    const [row] = await db.select().from(drugs).where(eq(drugs.id, id));
    expect(row?.pubchemCid).toBe(NEW);
    expect(await caseKeys(pinned)).toEqual([String(NEW)]);
  });
});
