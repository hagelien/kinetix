import { eq } from 'drizzle-orm';
import { getDb } from '../api/_lib/db.js';
import { normalizeReferenceMetadata } from '../api/_lib/reference-metadata.js';
import { citations } from '../db/schema.js';

async function run(): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(citations);

  let updatedCount = 0;

  for (const row of rows) {
    const normalized = normalizeReferenceMetadata(row.metadata);
    const before = JSON.stringify(row.metadata ?? null);
    const after = JSON.stringify(normalized);
    if (before === after) continue;

    await db
      .update(citations)
      .set({ metadata: normalized })
      .where(eq(citations.id, row.id));
    updatedCount += 1;
  }

  // eslint-disable-next-line no-console
  console.log(`Backfill complete. Updated ${updatedCount} citation metadata row(s).`);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Backfill failed:', err);
  process.exitCode = 1;
});

