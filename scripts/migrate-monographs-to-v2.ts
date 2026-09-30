/**
 * One-time migration: wrap legacy drug-monograph content (v1 free-form
 * TipTap docs) into the v2 section-aware envelope under the first remaining
 * section (`pd` after #396). Topic pages are left untouched.
 *
 * IMPORTANT — DO NOT RUN BEFORE PHASE 1c LANDS.
 *
 * The legacy WikiEditor cannot read v2 envelopes; running this migration
 * before the per-section editor ships would either (a) be blocked by the
 * editor's v2 guard (no edit possible) or (b) regress to silently dropping
 * structure on save. The script defaults to --dry-run so an accidental
 * invocation never writes; pass --apply to actually persist changes after
 * the per-section editor is in place.
 *
 * The migration is idempotent — pages already in v2 are skipped. After it
 * runs, `wikiPages.contentHtml` is regenerated from the v2 envelope so
 * public pages render with section headings. The follow-up "redistribute
 * paragraphs to correct sections" pass is a separate agent task and is
 * intentionally not bundled here.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/migrate-monographs-to-v2.ts            # dry-run (default)
 *   DATABASE_URL=... npx tsx scripts/migrate-monographs-to-v2.ts --apply    # actually write
 */

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq } from 'drizzle-orm';
import { wikiPages } from '../db/schema';
import {
  isMonographContentV2,
  wrapV1AsV2,
} from '../src/lib/monographContent';
import { extractPlaintext, renderHtml } from '../api/_lib/tiptap-utils';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

// Fail-safe default: never write unless --apply is explicitly passed. The
// older --dry-run flag is accepted for ergonomic continuity but is now a
// no-op since dry-run is the default.
const apply = process.argv.includes('--apply');
const dryRun = !apply;

async function main(): Promise<void> {
  const sql = neon(DATABASE_URL!);
  const db = drizzle(sql);

  const monographs = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      content: wikiPages.content,
    })
    .from(wikiPages)
    .where(eq(wikiPages.pageType, 'drug_monograph'));

  let migrated = 0;
  let skipped = 0;

  for (const page of monographs) {
    if (isMonographContentV2(page.content)) {
      skipped++;
      continue;
    }

    const wrapped = wrapV1AsV2(page.content);
    const html = renderHtml(wrapped);
    const plaintext = extractPlaintext(wrapped);

    if (dryRun) {
      console.log(
        `[dry-run] would migrate id=${page.id} slug=${page.slug} ` +
          `(${plaintext.length} chars plaintext)`,
      );
      migrated++;
      continue;
    }

    await db
      .update(wikiPages)
      .set({
        content: wrapped as never,
        contentHtml: html,
        contentPlaintext: plaintext,
      })
      .where(eq(wikiPages.id, page.id));

    migrated++;
    console.log(`migrated id=${page.id} slug=${page.slug}`);
  }

  console.log(
    `${dryRun ? '[dry-run] ' : ''}done — ` +
      `${migrated} migrated, ${skipped} already v2 (total ${monographs.length})`,
  );
}

main().catch((err) => {
  console.error('migration failed:', err);
  process.exit(1);
});
