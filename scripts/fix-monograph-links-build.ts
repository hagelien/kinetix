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
 * The UPDATEs below carry `RETURNING` so the log lines can count what they
 * touched: `neon()` without `fullResults` resolves to a plain row array, so
 * the `.count` these used to read was always `undefined` and every deploy
 * reported 0 rows fixed regardless of what it did.
 *
 * The collision guard (#1256 item 7): `wiki_pages.drug_cid` has no
 * uniqueness constraint, so a legacy row's CID can resolve to a `drugs.id`
 * that some OTHER page already links modernly. Remapping the legacy row onto
 * it anyway would produce a second page for a drug that already has one —
 * exactly the silent duplicate `scripts/fix-monograph-drug-links.ts` (the
 * manual, `[CONFLICT]`-reporting counterpart to this build-time pass) exists
 * to catch. That script escalates the case to a human; this one, running
 * unattended on every deploy, can only skip it and leave the legacy row
 * dangling for that script (or a human) to resolve — in EVERY case below, not
 * only Case 1: a page the guard excludes there would otherwise still fall
 * through to Case 2 (linked by a title match) or Case 3 (a spurious new drug
 * created for it), recreating the same duplicate a different way.
 */
import { neon } from '@neondatabase/serverless';
import {
  REMAP_LEGACY_CID_SQL,
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

  // Case 1: Legacy PubChem CID stored in drug_cid → remap to internal drugs.id
  const r1 = await sql.query(REMAP_LEGACY_CID_SQL);
  console.log(`  Legacy CID remapped: ${r1.length}`);

  // Case 2: NULL or dangling drug_cid but title matches an existing drug name
  // in any language slot of the `names` jsonb.
  const r2 = await sql.query(NAME_MATCH_SQL);
  console.log(`  Matched by name:    ${r2.length}`);

  // Case 3: NULL or dangling drug_cid with no match → create minimal drug rows.
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
