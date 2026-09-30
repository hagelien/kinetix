/**
 * One-time migration: mint stable `sectionId` attributes onto every
 * top-level heading in topic-page wiki content (#310 phase 2 / #348).
 *
 * Drug-monograph pages are skipped — their sections come from the v2
 * envelope schema and don't use heading-anchored ids. Only `pageType =
 * 'topic'` rows are touched.
 *
 * The script defaults to --dry-run so an accidental invocation never
 * writes; pass --apply to persist. Idempotent: pages already fully
 * sectioned are skipped.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/mint-topic-section-ids.ts            # dry-run (default)
 *   DATABASE_URL=... npx tsx scripts/mint-topic-section-ids.ts --apply    # actually write
 */

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq } from 'drizzle-orm';
import { wikiPages } from '../db/schema';
import { mintTopicSectionIds } from '../src/lib/topicSections';
import { extractPlaintext, renderHtml } from '../api/_lib/tiptap-utils';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const dryRun = !apply;

async function main(): Promise<void> {
  const sql = neon(DATABASE_URL!);
  const db = drizzle(sql);

  const topics = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      content: wikiPages.content,
    })
    .from(wikiPages)
    .where(eq(wikiPages.pageType, 'topic'));

  let migrated = 0;
  let skipped = 0;

  for (const page of topics) {
    const result = mintTopicSectionIds(page.content as never);
    if (!result.changed) {
      skipped++;
      continue;
    }

    const nextContent = result.doc;
    const html = renderHtml(nextContent);
    const plaintext = extractPlaintext(nextContent);

    if (dryRun) {
      console.log(
        `[dry-run] would mint sectionIds on id=${page.id} slug=${page.slug}`,
      );
      migrated++;
      continue;
    }

    await db
      .update(wikiPages)
      .set({
        content: nextContent as never,
        contentHtml: html,
        contentPlaintext: plaintext,
      })
      .where(eq(wikiPages.id, page.id));

    migrated++;
    console.log(`minted id=${page.id} slug=${page.slug}`);
  }

  console.log(
    `${dryRun ? '[dry-run] ' : ''}done — ` +
      `${migrated} updated, ${skipped} already sectioned (total ${topics.length})`,
  );
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
