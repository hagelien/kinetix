/**
 * One-time fix script: ensure every drug_monograph wiki page has a valid
 * drugCid pointing to an existing row in the drugs table.
 *
 * For monographs with null drugCid or drugCid pointing to a nonexistent
 * drug, the script:
 *   1. Tries to match the page title to an existing drug by name
 *   2. Tries to match drugCid as a legacy PubChem CID
 *   3. Auto-creates a minimal drug row from the page title if no match
 *
 * `wiki_pages.drug_cid` has no uniqueness constraint (#1256), so mapping a
 * legacy CID-keyed page (case 2) onto `drugs.id` can collide with a page that
 * already links that drug modernly — the exact "second, empty page beside
 * the written one" failure #1256 describes. When that happens the legacy row
 * is deleted if it is provably empty (a pure backfill artifact — the earlier
 * run of this very script, or a stale seed, that never got written to); a
 * legacy row that actually carries prose is left for a human to reconcile,
 * same as every other genuinely ambiguous case in this file.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/fix-monograph-drug-links.ts
 *
 * Dry-run (no writes):
 *   DATABASE_URL=... npx tsx scripts/fix-monograph-drug-links.ts --dry-run
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { wikiPages, wikiRevisions, pendingEdits, drugs } from '../db/schema';
import { monographHasContent } from '../src/lib/monographContent';

const dryRun = process.argv.includes('--dry-run');

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 200);
}

type Db = ReturnType<typeof drizzle>;

/**
 * Whether a legacy monograph page that currently has no content is *safe* to
 * delete as a pure duplicate artifact, rather than a page whose history a
 * delete would destroy.
 *
 * Current emptiness alone isn't enough: `ensureDrugMonograph` inserts one
 * revision (the stub itself) on every page it creates, so requiring zero
 * revisions would never treat any legitimately-created empty page as safe.
 * More than that one, though, means someone edited the page after creation —
 * possibly clearing it back to empty — and `wiki_revisions` cascades on
 * delete, so that history would be gone with the row. A pending edit
 * (`wiki_page`/`wiki_section`/`wiki_fact`) targeting the page by id is
 * likewise polymorphic and not FK-bound; deleting the page out from under it
 * leaves it pointing at nothing, open or settled.
 *
 * Pure so it can be unit tested without a database; {@link countPageHistory}
 * does the actual querying.
 */
export function isEmptyDuplicateSafeToDelete(
  revisionCount: number,
  pendingEditCount: number,
): boolean {
  return revisionCount <= 1 && pendingEditCount === 0;
}

async function countPageHistory(
  db: Db,
  pageId: number,
): Promise<{ revisionCount: number; pendingEditCount: number }> {
  const revisionRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(wikiRevisions)
    .where(eq(wikiRevisions.pageId, pageId));

  const pendingEditRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pendingEdits)
    .where(
      and(
        eq(pendingEdits.targetId, pageId),
        inArray(pendingEdits.editType, ['wiki_page', 'wiki_section', 'wiki_fact']),
      ),
    );
  return {
    revisionCount: revisionRows[0]?.count ?? 0,
    pendingEditCount: pendingEditRows[0]?.count ?? 0,
  };
}

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const client = neon(DATABASE_URL);
  const db = drizzle(client);

  if (dryRun) {
    console.log('=== DRY RUN — no changes will be written ===\n');
  }

  // Load all drug_monograph pages
  const monographPages = await db
    .select({
      id: wikiPages.id,
      slug: wikiPages.slug,
      title: wikiPages.title,
      drugCid: wikiPages.drugCid,
      content: wikiPages.content,
      contentPlaintext: wikiPages.contentPlaintext,
    })
    .from(wikiPages)
    .where(eq(wikiPages.pageType, 'drug_monograph'));

  console.log(`Found ${monographPages.length} drug_monograph pages.\n`);

  // Load all drugs for matching
  const allDrugs = await db
    .select({
      id: drugs.id,
      names: drugs.names,
      pubchemCid: drugs.pubchemCid,
      slug: drugs.slug,
    })
    .from(drugs);

  const drugByName = new Map<string, typeof allDrugs[0]>();
  const drugById = new Map<number, typeof allDrugs[0]>();
  const drugByPubchemCid = new Map<number, typeof allDrugs[0]>();

  for (const d of allDrugs) {
    for (const name of Object.values(d.names ?? {})) {
      if (typeof name === 'string' && name) {
        drugByName.set(name.toLowerCase(), d);
      }
    }
    drugById.set(d.id, d);
    if (d.pubchemCid) drugByPubchemCid.set(d.pubchemCid, d);
  }

  let fixedCount = 0;
  let createdCount = 0;
  let alreadyOkCount = 0;
  let legacyCidFixed = 0;
  let duplicateDeleted = 0;
  let conflictSkipped = 0;

  // Every `drugCid` a page already legitimately owns (case 1), so a legacy
  // CID (case 2) that would map onto one of these is recognized as a
  // collision rather than silently creating a second page for that drug.
  // `wiki_pages.drug_cid` has no uniqueness constraint, so nothing else
  // enforces this.
  const claimedDrugCids = new Set<number>();
  for (const page of monographPages) {
    if (page.drugCid != null && drugById.has(page.drugCid)) {
      claimedDrugCids.add(page.drugCid);
    }
  }

  for (const page of monographPages) {
    // Case 1: drugCid is set and points to an existing drug row
    if (page.drugCid != null && drugById.has(page.drugCid)) {
      alreadyOkCount++;
      continue;
    }

    // Case 2: drugCid is a legacy PubChem CID (not an internal drug ID)
    if (page.drugCid != null && !drugById.has(page.drugCid)) {
      const matchByPubchemCid = drugByPubchemCid.get(page.drugCid);
      if (matchByPubchemCid) {
        if (claimedDrugCids.has(matchByPubchemCid.id)) {
          // Another page already links this drug modernly. Mapping this one
          // too would produce the second, orphaned page #1256 describes.
          const { revisionCount, pendingEditCount } = await countPageHistory(
            db,
            page.id,
          );
          const safeToDelete =
            !monographHasContent(page) &&
            isEmptyDuplicateSafeToDelete(revisionCount, pendingEditCount);
          if (safeToDelete) {
            console.log(
              `  [DUPLICATE] "${page.title}" (/${page.slug}) — legacy drugCid ` +
              `${page.drugCid} resolves to drugs.id=${matchByPubchemCid.id}, which ` +
              `already has a monograph, and this page is empty with no edit ` +
              `history or pending edits. Deleting it.`,
            );
            if (!dryRun) {
              await db.delete(wikiPages).where(eq(wikiPages.id, page.id));
            }
            duplicateDeleted++;
          } else {
            console.log(
              `  [CONFLICT] "${page.title}" (/${page.slug}) — legacy drugCid ` +
              `${page.drugCid} resolves to drugs.id=${matchByPubchemCid.id}, which ` +
              `already has a monograph, and THIS page has its own content, edit ` +
              `history, or a pending edit. Needs a human to reconcile (merge the ` +
              `prose, or /admin/drug-merge the drugs).`,
            );
            conflictSkipped++;
          }
          continue;
        }
        console.log(
          `  [LEGACY CID] "${page.title}" — drugCid ${page.drugCid} is PubChem CID, ` +
          `mapping to drugs.id=${matchByPubchemCid.id}`,
        );
        if (!dryRun) {
          await db
            .update(wikiPages)
            .set({ drugCid: matchByPubchemCid.id, updatedAt: new Date() })
            .where(eq(wikiPages.id, page.id));
        }
        claimedDrugCids.add(matchByPubchemCid.id);
        legacyCidFixed++;
        fixedCount++;
        continue;
      }
    }

    // Case 3: drugCid is null or points to nonexistent drug
    // Try to match by page title
    const matchByName = drugByName.get(page.title.toLowerCase());
    if (matchByName) {
      const matchLabel =
        Object.values(matchByName.names ?? {}).find(
          (v): v is string => typeof v === 'string' && !!v,
        ) ?? `id ${matchByName.id}`;
      console.log(
        `  [MATCH] "${page.title}" — linked to existing drug "${matchLabel}" (id=${matchByName.id})`,
      );
      if (!dryRun) {
        await db
          .update(wikiPages)
          .set({ drugCid: matchByName.id, updatedAt: new Date() })
          .where(eq(wikiPages.id, page.id));
      }
      fixedCount++;
      continue;
    }

    // Case 4: No match found — create a new drug row
    const slug = generateSlug(page.title);
    const searchKey = page.title.toLowerCase();

    console.log(
      `  [CREATE] "${page.title}" — creating new drug row (slug="${slug}")`,
    );
    if (!dryRun) {
      try {
        // Default the page title into the Norwegian slot — most legacy
        // monographs were authored in NO. Authors can promote it into other
        // language slots later via the per-language edit flow.
        const names: Record<string, string> = { nb: page.title };
        const [newDrug] = await db
          .insert(drugs)
          .values({
            slug,
            names,
            aliases: [],
            searchKey,
          })
          .onConflictDoNothing()
          .returning({ id: drugs.id });

        if (newDrug) {
          await db
            .update(wikiPages)
            .set({ drugCid: newDrug.id, updatedAt: new Date() })
            .where(eq(wikiPages.id, page.id));
          createdCount++;
          fixedCount++;
          // Add to lookup maps so duplicate titles don't create duplicates
          drugById.set(newDrug.id, {
            id: newDrug.id,
            names,
            pubchemCid: null,
            slug,
          });
          drugByName.set(page.title.toLowerCase(), drugById.get(newDrug.id)!);
        } else {
          console.log(`    ⚠ Slug conflict for "${slug}" — skipped`);
        }
      } catch (err) {
        console.error(`    ✗ Failed to create drug for "${page.title}":`, err);
      }
    } else {
      createdCount++;
      fixedCount++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Already OK:          ${alreadyOkCount}`);
  console.log(`  Legacy CID fixed:    ${legacyCidFixed}`);
  console.log(`  Matched by name:     ${fixedCount - legacyCidFixed - createdCount}`);
  console.log(`  New drugs created:   ${createdCount}`);
  console.log(`  Total fixed:         ${fixedCount}`);
  console.log(`  Empty duplicates deleted: ${duplicateDeleted}`);
  console.log(`  Conflicts needing a human: ${conflictSkipped}`);
  if (dryRun) {
    console.log(`\n(Dry run — no changes were written. Remove --dry-run to apply.)`);
  }
}

// Run only as a CLI; importing this module for its pure helpers (tests) must
// not hit the database or read DATABASE_URL.
const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch(console.error);
}
