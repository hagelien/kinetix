/**
 * Build-time data fix: every bio entity owns a monograph wiki page, filed
 * under the top-level "Bioentiteter" page. Idempotent — safe to run on every
 * deploy; once the catalog is covered it is a single query.
 *
 * Invoked from vercel.json buildCommand after migrations, before the app
 * build. Pages are authored by the lowest-id admin, the same account a human
 * would pass to `scripts/backfill-drug-monographs.ts`.
 */
import { asc, eq } from 'drizzle-orm';
import { getDb } from '../api/_lib/db.js';
import { ensureAllEntityMonographs } from '../api/_lib/monograph-helpers.js';
import { users } from '../db/schema.js';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('[entity-monographs] DATABASE_URL not set, skipping.');
    return;
  }

  const db = getDb();
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'admin'))
    .orderBy(asc(users.id))
    .limit(1);
  if (!admin) {
    console.log('[entity-monographs] No admin user to author pages, skipping.');
    return;
  }

  const { created, adopted } = await ensureAllEntityMonographs(db, admin.id);
  console.log(
    `[entity-monographs] Created: ${created}, moved under hub: ${adopted}`,
  );
}

main().catch((err) => {
  console.error('[entity-monographs] Error:', err);
  // Don't fail the build — the fix is supplementary
  process.exit(0);
});
