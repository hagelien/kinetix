/**
 * Build-time data fix: ensure every drug_monograph wiki page has a valid
 * drug link. All SQL is idempotent — safe to run on every deploy.
 *
 * Invoked from vercel.json buildCommand before the app build.
 *
 * Runs against the post-`0013_drug_names_jsonb` schema where drug names live
 * in a `names` jsonb keyed by BCP-47 language code (no top-level `name` /
 * `name_en` columns) and `aliases` is a jsonb string array.
 *
 * The UPDATE below carries `RETURNING` so the log line can count what it
 * touched: `neon()` without `fullResults` resolves to a plain row array, so
 * the `.count` these used to read was always `undefined` and every deploy
 * reported 0 rows fixed regardless of what it did.
 *
 * `wiki_pages.drug_cid` holds `drugs.id` only, so a page is dangling when its
 * number is no drug's id; it is never reinterpreted as a PubChem CID. The
 * one-off remap of CID-keyed pages this script used to repeat on every deploy
 * is migration 0148.
 *
 * The collision guard (#1256 item 7): a page 0148 declined to move — its
 * number is still a drug's PubChem CID, because placing it would have given
 * that drug two monographs — must not be linked by Case 1 (a title match onto
 * that same drug) or Case 2 (a spurious new drug created for it).
 * `scripts/fix-monograph-drug-links.ts`, the manual `[CONFLICT]`-reporting
 * counterpart to this build-time pass, escalates it to a human; this one,
 * running unattended on every deploy, can only leave it dangling.
 */
import { neon } from '@neondatabase/serverless';
import {
  NAME_MATCH_SQL,
  DANGLING_MONOGRAPH_PAGES_SQL,
} from './lib/monograph-legacy-cid-remap-sql';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.log('[fix-monograph-links] DATABASE_URL not set, skipping.');
  process.exit(0);
}

const sql = neon(DATABASE_URL);

async function main() {
  console.log('[fix-monograph-links] Fixing orphaned drug_monograph pages...');

  // Case 1: NULL or dangling drug_cid but title matches an existing drug name
  // in any language slot of the `names` jsonb.
  const r1 = await sql.query(NAME_MATCH_SQL);
  console.log(`  Matched by name:    ${r1.length}`);

  // Case 2: NULL or dangling drug_cid with no match → create minimal drug rows.
  // Default the page title into the Norwegian slot to mirror what
  // `scripts/fix-monograph-drug-links.ts` does — most legacy monographs were
  // authored in NO and authors can promote into other languages later.
  const orphans = await sql.query(DANGLING_MONOGRAPH_PAGES_SQL);

  let created = 0;
  for (const page of orphans) {
    const slug = page.title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 200);

    const rows = await sql`
      INSERT INTO drugs (slug, names, aliases, search_key, created_at, updated_at)
      VALUES (
        ${slug},
        jsonb_build_object('nb', ${page.title}::text),
        '[]'::jsonb,
        ${page.title.toLowerCase()},
        NOW(),
        NOW()
      )
      ON CONFLICT (slug) DO UPDATE SET slug = drugs.slug
      RETURNING id
    `;
    const drugId = rows[0]?.id;
    if (drugId) {
      await sql`UPDATE wiki_pages SET drug_cid = ${drugId}, updated_at = NOW() WHERE id = ${page.id}`;
      created++;
    }
  }
  console.log(`  New drugs created:  ${created}`);
  console.log('[fix-monograph-links] Done.');
}

main().catch((err) => {
  console.error('[fix-monograph-links] Error:', err);
  // Don't fail the build — the fix is supplementary
  process.exit(0);
});
