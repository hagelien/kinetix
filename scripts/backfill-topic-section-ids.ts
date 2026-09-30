import { and, eq } from 'drizzle-orm';
import { getDb } from '../api/_lib/db.js';
import { extractPlaintext, renderHtml } from '../api/_lib/tiptap-utils.js';
import { mintTopicSectionIds } from '../src/lib/topicSections.js';
import { wikiPages } from '../db/schema.js';

/**
 * One-shot backfill (#348 follow-up): mint stable `sectionId` anchors onto
 * the top-level headings of every existing topic (non-monograph) wiki page.
 *
 * Section anchors were previously minted only client-side in WikiEditor, so
 * any topic page that hadn't been re-saved through the editor carried
 * headings with no `sectionId` — and no `wiki_fact` could ever target them.
 * Server-side write paths now mint on save/approval (ensureTopicSectionIds),
 * but pages untouched since then still need this pass so agents and editors
 * can anchor atomic facts immediately.
 *
 * Idempotent: mintTopicSectionIds leaves already-anchored docs unchanged, so
 * re-running is a no-op. Only rows whose content actually changes are written,
 * along with refreshed contentHtml/contentPlaintext.
 */
async function run(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      content: wikiPages.content,
    })
    .from(wikiPages)
    .where(eq(wikiPages.pageType, 'topic'));

  let updatedCount = 0;

  for (const row of rows) {
    if (!row.content || typeof row.content !== 'object') continue;
    const { doc, changed } = mintTopicSectionIds(
      row.content as { content?: unknown[] },
    );
    if (!changed) continue;

    const contentHtml = renderHtml(doc);
    const contentPlaintext = extractPlaintext(doc);
    await db
      .update(wikiPages)
      .set({
        content: doc as never,
        contentHtml,
        contentPlaintext,
      })
      .where(and(eq(wikiPages.id, row.id), eq(wikiPages.pageType, 'topic')));
    updatedCount += 1;
    // eslint-disable-next-line no-console
    console.log(`  minted section ids on topic page #${row.id} (${row.slug})`);
  }

  // eslint-disable-next-line no-console
  console.log(
    `Backfill complete. Anchored ${updatedCount} of ${rows.length} topic page(s).`,
  );
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Backfill failed:', err);
  process.exitCode = 1;
});
