/**
 * Inject a failure into the block-history insert (#37): while `fn` runs, every
 * INSERT into `drug_block_revisions` raises. Used to prove a block write and
 * its revision rows commit together — the write must roll back with the
 * failed history insert, not survive it.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '../../../api/_lib/db.js';

export async function failBlockRevisionInserts(fn: () => Promise<void>): Promise<void> {
  const db = getDb();
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION test_fail_block_revision() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'injected drug_block_revisions failure';
    END;
    $$ LANGUAGE plpgsql
  `));
  await db.execute(sql.raw(`
    CREATE TRIGGER test_fail_block_revision_trg
      BEFORE INSERT ON drug_block_revisions
      FOR EACH ROW EXECUTE FUNCTION test_fail_block_revision()
  `));
  try {
    await fn();
  } finally {
    await db.execute(sql.raw('DROP TRIGGER IF EXISTS test_fail_block_revision_trg ON drug_block_revisions'));
    await db.execute(sql.raw('DROP FUNCTION IF EXISTS test_fail_block_revision()'));
  }
}
