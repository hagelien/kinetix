/**
 * Backfill: ensure every drug in the `drugs` table owns a monograph wiki page.
 *
 * New drugs get a monograph automatically at creation time (POST /api/drugs →
 * ensureDrugMonograph). This one-off script does the same for drugs that
 * pre-date that behaviour, so no drug is left requiring a manual
 * "Create monograph" click. It is idempotent — drugs that already have a
 * monograph are skipped — so it is safe to re-run.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/backfill-drug-monographs.ts <admin-user-id>
 *
 * <admin-user-id> is recorded as the author of the created monograph pages and
 * their initial revisions; it must be an existing user id.
 */
import { getDb } from '../api/_lib/db.js';
import { ensureDrugMonograph } from '../api/_lib/monograph-helpers.js';
import { drugs } from '../db/schema.js';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const adminUserId = Number(process.argv[2]);
  if (!Number.isInteger(adminUserId) || adminUserId <= 0) {
    console.error(
      'Usage: npx tsx scripts/backfill-drug-monographs.ts <admin-user-id>',
    );
    process.exit(1);
  }

  const db = getDb();
  const rows = await db
    .select({ id: drugs.id, names: drugs.names, pubchemCid: drugs.pubchemCid })
    .from(drugs);

  console.log(`Found ${rows.length} drugs. Ensuring monographs…`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const result = await ensureDrugMonograph(db, row, adminUserId);
      if (result.created) {
        created++;
        console.log(`  Created: ${result.page.slug}`);
      } else {
        skipped++;
      }
    } catch (err) {
      failed++;
      console.error(`  Failed for drug ${row.id}:`, err);
    }
  }

  console.log(
    `\nDone. Created: ${created}, Skipped (already had one): ${skipped}, Failed: ${failed}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
