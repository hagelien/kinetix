/**
 * Fill `drugs.farmakologiportalen_path` for substances Farmakologiportalen
 * lists, so each drug monograph can link out to its counterpart there.
 *
 * The full importer (scripts/import-farmakologiportalen.ts) also writes these
 * links, but it fetches ~1500 content pages and resolves a PubChem CID per
 * substance — minutes of traffic against two third-party services, and it
 * writes parameters and metabolite rows on the way. Linking needs none of
 * that: the substance index alone carries every title and its content path, in
 * a single request. This script does that and nothing else, so the links can
 * be (re)filled cheaply and reviewed on their own.
 *
 * Matching follows the importer's name fallback — normalized drug names and
 * aliases against the portal title, its base name, and its parenthetical alias
 * — with one guard the importer's create-or-match pass does not need: a
 * spelling two DIFFERENT drugs answer to resolves to neither of them, and the
 * substance is reported and left unlinked. Substances the portal does not list
 * keep a NULL path and simply show no link.
 *
 * This is also the post-deploy step migration 0101 needs — it adds the column
 * NULL for every existing row, so no monograph shows a link until this runs.
 * `.github/workflows/farmakologiportalen-links.yml` runs it from CI for
 * operators without a production DATABASE_URL; the runbook is
 * docs/ops/farmakologiportalen-links.md.
 *
 * Usage:
 *   npm run backfill:farmakologiportalen-links
 *   npm run backfill:farmakologiportalen-links -- --dry-run
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { and, eq, sql } from 'drizzle-orm';
import { drugs } from '../db/schema';
import { farmakologiportalenUrl } from '../src/lib/farmakologiportalen';
import { parseSubstanceList } from './farmakologiportalen/parse';
import { buildNameIndex, matchSubstanceTitle } from './farmakologiportalen/match';

const BASE_URL = 'https://farmakologiportalen.no';
const LIST_URL = `${BASE_URL}/farma/search/substances`;
const USER_AGENT =
  'KinetixImporter/1.0 (+https://github.com/hagelien/kinetix; substance link backfill)';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const dryRun = process.argv.slice(2).includes('--dry-run');

async function main(): Promise<void> {
  console.log(`Fetching substance index from ${LIST_URL} …`);
  const res = await fetch(LIST_URL, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Substance index returned ${res.status}`);
  const list = parseSubstanceList(await res.json());
  console.log(`  → ${list.length} substances listed.`);
  if (list.length === 0) throw new Error('Substance index was empty');

  const db = drizzle(neon(DATABASE_URL!));
  const existing = await db
    .select({
      id: drugs.id,
      names: drugs.names,
      aliases: drugs.aliases,
      path: drugs.farmakologiportalenPath,
    })
    .from(drugs);

  const byName = buildNameIndex(existing);
  const pathById = new Map<number, string | null>(
    existing.map((d) => [d.id, d.path]),
  );

  const stats = {
    matched: 0,
    written: 0,
    corrected: 0,
    unmatched: 0,
    invalid: 0,
    ambiguous: 0,
  };
  // One drug per portal entry: if two entries normalize onto the same drug
  // (a substance and a salt of it, say) the first one keeps the link rather
  // than the last write silently winning.
  const claimed = new Set<number>();

  for (const item of list) {
    // A path this module would refuse to render is worth nothing in the
    // column — better an absent link than a stored one that never appears.
    if (!farmakologiportalenUrl(item.url)) {
      stats.invalid++;
      continue;
    }
    const { drugId, ambiguous } = matchSubstanceTitle(byName, item.title);
    if (drugId === null) {
      // Reported apart from "no matching drug": this one is a curator's
      // problem (two drugs share a spelling), not an absence.
      if (ambiguous) {
        stats.ambiguous++;
        console.warn(
          `  [ambiguous] ${item.title} — more than one drug answers to this name; left unlinked`,
        );
      } else {
        stats.unmatched++;
      }
      continue;
    }
    if (claimed.has(drugId)) continue;
    claimed.add(drugId);
    stats.matched++;

    const current = pathById.get(drugId) ?? null;
    if (current === item.url) continue;
    if (dryRun) {
      console.log(
        `  [${current ? 'fix' : 'link'}] ${item.title} → drug ${drugId}: ${item.url}`,
      );
      if (current) stats.corrected++;
      else stats.written++;
      continue;
    }
    const updated = await db
      .update(drugs)
      .set({ farmakologiportalenPath: item.url, updatedAt: new Date() })
      .where(
        and(
          eq(drugs.id, drugId),
          sql`${drugs.farmakologiportalenPath} IS DISTINCT FROM ${item.url}`,
        ),
      )
      .returning({ id: drugs.id });
    if (updated.length) {
      if (current) stats.corrected++;
      else stats.written++;
    }
  }

  console.log('\nBackfill summary' + (dryRun ? ' (dry run)' : '') + ':');
  console.log(`  portal substances    : ${list.length}`);
  console.log(`  matched to a drug    : ${stats.matched}`);
  console.log(`  links written        : ${stats.written}`);
  console.log(`  links corrected      : ${stats.corrected}`);
  console.log(`  no matching drug     : ${stats.unmatched}`);
  if (stats.ambiguous) {
    console.log(
      `  ambiguous name       : ${stats.ambiguous} (two drugs share the spelling — left unlinked)`,
    );
  }
  if (stats.invalid) {
    console.log(`  unusable portal paths: ${stats.invalid}`);
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
