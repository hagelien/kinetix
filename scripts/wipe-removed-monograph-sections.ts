/**
 * One-off cleanup for issue #396: wipe authored content stored under the
 * three sections removed from the monograph schema (`summary`,
 * `key_facts`, `chemistry`). Those keys still validate against
 * `isMonographContentV2` for backwards compatibility with existing JSON
 * envelopes, but they are no longer in `MONOGRAPH_SECTIONS`, so the
 * schema-driven server renderer and the plaintext extractor walk past
 * them. On the next normal save the regenerated `contentHtml` and
 * `contentPlaintext` would silently drop those bodies; this script
 * makes the removal explicit and brings every row into a consistent
 * state immediately.
 *
 * Strategy:
 * - Walk every `drug_monograph` row.
 * - If `content` is a v2 envelope, delete the removed-section keys.
 * - Re-render `contentHtml` and `contentPlaintext` so the public page
 *   and search index reflect the wipe right away.
 * - Skip rows that don't store v2 content or that have nothing under
 *   the removed sections.
 *
 * Defaults to dry-run; pass `--apply` to actually write.
 *
 *   DATABASE_URL=… npx tsx scripts/wipe-removed-monograph-sections.ts
 *   DATABASE_URL=… npx tsx scripts/wipe-removed-monograph-sections.ts --apply
 */

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { eq } from 'drizzle-orm';
import { wikiPages } from '../db/schema';
import {
  isMonographContentV2,
  type MonographContentV2,
  type MonographSectionContentV2,
} from '../src/lib/monographContent';
import { extractPlaintext, renderHtml } from '../api/_lib/tiptap-utils';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const dryRun = !apply;

const REMOVED_SECTION_IDS = ['summary', 'key_facts', 'chemistry'] as const;

interface WipeReport {
  removedKeys: string[];
}

/**
 * Returns the new envelope with the removed-section keys stripped, plus a
 * list of which keys were actually present so the dry-run log can show
 * what would change.
 */
function stripRemovedSections(
  content: MonographContentV2,
): { next: MonographContentV2; report: WipeReport } {
  const sections = { ...content.sections } as Record<
    string,
    MonographSectionContentV2 | undefined
  >;
  const removedKeys: string[] = [];
  for (const id of REMOVED_SECTION_IDS) {
    if (sections[id] !== undefined) {
      removedKeys.push(id);
      delete sections[id];
    }
  }
  return {
    next: { version: 2, sections: sections as MonographContentV2['sections'] },
    report: { removedKeys },
  };
}

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

  let updated = 0;
  let skipped = 0;

  for (const page of monographs) {
    if (!isMonographContentV2(page.content)) {
      skipped++;
      continue;
    }

    const { next, report } = stripRemovedSections(page.content);
    if (report.removedKeys.length === 0) {
      skipped++;
      continue;
    }

    const html = renderHtml(next);
    const plaintext = extractPlaintext(next);

    if (dryRun) {
      console.log(
        `[dry-run] would wipe id=${page.id} slug=${page.slug} ` +
          `(removed keys: ${report.removedKeys.join(', ')})`,
      );
      updated++;
      continue;
    }

    await db
      .update(wikiPages)
      .set({
        content: next as never,
        contentHtml: html,
        contentPlaintext: plaintext,
      })
      .where(eq(wikiPages.id, page.id));

    updated++;
    console.log(
      `wiped id=${page.id} slug=${page.slug} ` +
        `(removed keys: ${report.removedKeys.join(', ')})`,
    );
  }

  console.log(
    `${dryRun ? '[dry-run] ' : ''}done — ` +
      `${updated} wiped, ${skipped} untouched (total ${monographs.length})`,
  );
}

main().catch((err) => {
  console.error('wipe failed:', err);
  process.exit(1);
});
