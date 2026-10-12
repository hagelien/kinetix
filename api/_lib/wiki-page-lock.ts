import { eq } from 'drizzle-orm';
import { wikiPages } from '../../db/schema.js';
import { getDb } from './db.js';

/**
 * Share-lock a wiki page's row for the rest of the current transaction and
 * report whether the page still exists.
 *
 * Every writer that inserts a page-scoped `pending_edits` row (target_id is the
 * page id, with no foreign key) calls this inside its transaction right before
 * the insert. Deleting a page locks the same row FOR UPDATE before it sweeps the
 * page's proposals, so a proposal either commits first and is swept with the
 * page, or waits for the delete and sees `false` here. Must run inside
 * runInPoolTransaction: on the auto-commit client the lock is released at once.
 */
export async function lockWikiPageShared(pageId: number): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: wikiPages.id })
    .from(wikiPages)
    .where(eq(wikiPages.id, pageId))
    .limit(1)
    .for('share');
  return row != null;
}
