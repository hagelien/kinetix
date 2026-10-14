/**
 * One-time seed script to create wiki page stubs for all 118 drugs.
 *
 * Usage:
 *   DATABASE_URL=... JWT_SECRET=... npx tsx scripts/seed-drug-monographs.ts <admin-user-id>
 *
 * Prerequisites:
 *   - Database tables must exist (run db:push first)
 *   - The drugs must already be seeded (`seed:drugs`): each component is
 *     matched to its `drugs` row by PubChem CID, and one with no row is skipped
 *   - An admin user must exist (register via the app, then manually set role to 'admin')
 *
 * `wiki_pages.drug_cid` is written as the drug's `drugs.id`, never its PubChem
 * CID. An earlier version of this script wrote the CID, which is how the
 * column came to hold two id spaces until migration 0148 unified it — and the
 * two overlap (25C-NBOMe is id 281, carbon monoxide CID 281), so a CID written
 * here would read back as some other drug's monograph.
 */

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { and, eq } from 'drizzle-orm';
import { drugs, wikiPages, wikiRevisions } from '../db/schema';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const adminUserId = Number(process.argv[2]);
if (!adminUserId || isNaN(adminUserId)) {
  console.error('Usage: npx tsx scripts/seed-drug-monographs.ts <admin-user-id>');
  process.exit(1);
}

// Parse embedded components
function loadComponents(): Array<{
  name: string;
  nameEn?: string;
  pubchemCid: number;
  molecularWeight?: number;
}> {
  const dataPath = join(process.cwd(), 'data', 'components.ts');
  const content = readFileSync(dataPath, 'utf-8');
  const arrayMatch = content.match(
    /export const embeddedComponents[^=]*=\s*(\[[\s\S]*\]);?\s*$/,
  );
  if (!arrayMatch) throw new Error('Could not parse components array');
  const fn = new Function(`return ${arrayMatch[1]}`);
  return fn();
}

function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 200);
}

async function main() {
  const sql = neon(DATABASE_URL!);
  const db = drizzle(sql);

  const components = loadComponents();
  console.log(`Found ${components.length} drug components. Seeding monographs...`);

  let created = 0;
  let skipped = 0;

  for (const comp of components) {
    const title = comp.name ?? comp.nameEn;
    const [drug] = await db
      .select({ id: drugs.id })
      .from(drugs)
      .where(eq(drugs.pubchemCid, comp.pubchemCid))
      .limit(1);
    if (!drug) {
      console.warn(`  Skipped: ${title} (no drug row for CID ${comp.pubchemCid})`);
      skipped++;
      continue;
    }
    const [existing] = await db
      .select({ id: wikiPages.id })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.pageType, 'drug_monograph'),
          eq(wikiPages.drugCid, drug.id),
        ),
      )
      .limit(1);
    if (existing) {
      skipped++;
      continue;
    }
    // The slug stays keyed to the ENGLISH name even though the title is
    // Norwegian. It is an identifier, not prose: the API resolves monograph
    // slugs by exact match, and KineLab's `analyteSlug`, its curated coverage
    // list and `DEFAULT_KINELAB_ANALYTE` all point at the seeded English slugs
    // (`ketamine`, `amphetamine`) — see docs/kinelab-integration.md, where
    // re-pointing those at Norwegian-ish slugs is recorded as a bug that had to
    // be fixed. Titles and body prose are what a reader sees; the slug is not.
    const slug = generateSlug(comp.nameEn ?? comp.name);

    // Build template content
    const content = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: title }],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Oversikt' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: `${title} er et stoff i Kinetix-databasen.` }],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Farmakokinetikk' }],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Farmakodynamikk' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Ikke skrevet ennå.' }] },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Forensisk toksikologi' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Ikke skrevet ennå.' }] },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Kilder' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Ikke skrevet ennå.' }] },
      ],
    };

    const contentPlaintext = `${title} Oversikt ${title} er et stoff i Kinetix-databasen. Farmakokinetikk Farmakodynamikk Ikke skrevet ennå. Forensisk toksikologi Ikke skrevet ennå. Kilder Ikke skrevet ennå.`;

    try {
      const [page] = await db
        .insert(wikiPages)
        .values({
          slug,
          title,
          content,
          contentHtml: `<h1>${title}</h1><h2>Oversikt</h2><p>${title} er et stoff i Kinetix-databasen.</p><h2>Farmakokinetikk</h2><div class="drug-info-card" data-drug-cid="${drug.id}">[Drug Info Card]</div><h2>Farmakodynamikk</h2><p>Ikke skrevet ennå.</p><h2>Forensisk toksikologi</h2><p>Ikke skrevet ennå.</p><h2>Kilder</h2><p>Ikke skrevet ennå.</p>`,
          contentPlaintext,
          pageType: 'drug_monograph',
          drugCid: drug.id,
          status: 'published',
          createdBy: adminUserId,
          updatedBy: adminUserId,
        })
        .returning({ id: wikiPages.id })
        .onConflictDoNothing();

      if (page) {
        await db.insert(wikiRevisions).values({
          pageId: page.id,
          content,
          contentHtml: '',
          editSummary: 'Første seeding',
          createdBy: adminUserId,
        });
        created++;
        console.log(`  Created: ${title} (${slug})`);
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`  Error creating ${title}:`, err);
      skipped++;
    }
  }

  console.log(`\nDone. Created: ${created}, Skipped: ${skipped}`);
}

main().catch(console.error);
