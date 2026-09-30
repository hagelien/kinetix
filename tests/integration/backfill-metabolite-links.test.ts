/**
 * The rollout script against real SQL.
 *
 * It writes to a live catalog, so what matters is what it refuses to do: the
 * unique index on (parent, metabolite_name) turns a missed collision into a
 * failed insert partway through a run, and the monograph prints one metabolite
 * twice if a link lands beside an unresolved row naming the same substance.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { drugMetabolites } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug } from './setup/seed.js';

let db: IntegrationDb;
let methadoneId: number;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});

beforeEach(async () => {
  await resetIntegrationDb(db);
  methadoneId = await seedDrug(db, {
    slug: 'metadon',
    names: { nb: 'Metadon', en: 'Methadone' },
    pubchemCid: 4095,
  });
  await seedDrug(db, {
    slug: 'eddp',
    names: { nb: 'EDDP', en: '2-Ethylidene-1,5-dimethyl-3,3-diphenylpyrrolidine (EDDP)' },
    pubchemCid: 5352621,
  });
});

describe('the metabolite-link rollout', () => {
  it('leaves an unresolved row alone whichever language it was written in', async () => {
    // Whoever entered the free-text row wrote it in their own language, so an
    // English name on a Norwegian catalog entry is the ordinary case. Matching
    // only the label about to be written would insert a second link beside it,
    // and the monograph would print one metabolite twice.
    await db.insert(drugMetabolites).values({
      parentDrugId: methadoneId,
      metaboliteDrugId: null,
      metaboliteName: '2-Ethylidene-1,5-dimethyl-3,3-diphenylpyrrolidine (EDDP)',
    });

    const { run } = await import('../../scripts/backfill-metabolite-links.js');
    await run(db, true);

    const rows = await db
      .select({ id: drugMetabolites.id, metaboliteDrugId: drugMetabolites.metaboliteDrugId })
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, methadoneId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metaboliteDrugId).toBeNull();
  });

  it('links the pair when nothing is in the way', async () => {
    // The positive case, which is also what proves the negative one above is
    // not vacuous: the same run against a parent with no rows must write the
    // link it was asked for.
    const { run } = await import('../../scripts/backfill-metabolite-links.js');
    await run(db, true);

    const rows = await db
      .select({ metaboliteDrugId: drugMetabolites.metaboliteDrugId })
      .from(drugMetabolites)
      .where(eq(drugMetabolites.parentDrugId, methadoneId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metaboliteDrugId).not.toBeNull();
  });
});
