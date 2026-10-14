/**
 * The exact SQL `scripts/fix-monograph-links-build.ts` runs on every deploy
 * to repair a `drug_monograph` wiki page's `drug_cid` link. Pulled into its
 * own side-effect-free module so
 * `tests/integration/fix-monograph-links-build-remap.test.ts` can replay the
 * production statements directly instead of a hand-copied copy that could
 * silently drift from what ships (importing the build script itself would
 * run its top-level `DATABASE_URL` guard and `neon()` connection).
 *
 * There is no PubChem-CID remap here any more. `wiki_pages.drug_cid` holds
 * `drugs.id` only; migration 0148 moved every CID-keyed page it could place
 * unambiguously, once, and nothing writes a CID there now.
 *
 * So a dangling page whose number is still some drug's PubChem CID is one
 * 0148 declined: that drug already had a monograph, or a second page carried
 * the same CID, and placing it would give the drug two pages (#1256 item 7).
 * {@link LEGACY_CID_COLLISION_SQL} keeps the two repair cases below off such a
 * page: Case 1 (name match) would otherwise recreate that duplicate by title,
 * and Case 2 (create a new drug) would invent a spurious drug row for it. A
 * page this excludes stays dangling for `scripts/fix-monograph-drug-links.ts`
 * (or a human) to resolve.
 */

/** True when `wp.drug_cid` is a legacy CID migration 0148 declined to move. */
export const LEGACY_CID_COLLISION_SQL = `
  EXISTS (
    SELECT 1 FROM drugs collider
    WHERE collider.pubchem_cid = wp.drug_cid
  )
`;

// Case 1: NULL or dangling drug_cid but title matches an existing drug name
// in any language slot of the `names` jsonb.
export const NAME_MATCH_SQL = `
  UPDATE wiki_pages wp
  SET drug_cid = d.id, updated_at = NOW()
  FROM drugs d
  WHERE wp.page_type = 'drug_monograph'
    AND (wp.drug_cid IS NULL OR NOT EXISTS (SELECT 1 FROM drugs WHERE id = wp.drug_cid))
    AND EXISTS (
      SELECT 1
      FROM jsonb_each_text(d.names) AS n(lang, value)
      WHERE lower(n.value) = lower(wp.title)
    )
    AND NOT (${LEGACY_CID_COLLISION_SQL})
  RETURNING wp.id
`;

// Case 2 candidates: NULL or dangling drug_cid with no name match → these get
// a minimal drug row created for them (done row-by-row in the build script,
// since each needs its own slug/name).
export const DANGLING_MONOGRAPH_PAGES_SQL = `
  SELECT wp.id, wp.title FROM wiki_pages wp
  WHERE wp.page_type = 'drug_monograph'
    AND (wp.drug_cid IS NULL OR NOT EXISTS (SELECT 1 FROM drugs WHERE id = wp.drug_cid))
    AND NOT (${LEGACY_CID_COLLISION_SQL})
`;
