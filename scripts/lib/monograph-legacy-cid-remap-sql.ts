/**
 * The exact SQL `scripts/fix-monograph-links-build.ts` runs on every deploy
 * to repair a `drug_monograph` wiki page's `drug_cid` link. Pulled into its
 * own side-effect-free module so
 * `tests/integration/fix-monograph-links-build-remap.test.ts` can replay the
 * production statements directly instead of a hand-copied copy that could
 * silently drift from what ships (importing the build script itself would
 * run its top-level `DATABASE_URL` guard and `neon()` connection).
 *
 * See the collision note in `fix-monograph-links-build.ts` (#1256 item 7):
 * `wiki_pages.drug_cid` has no uniqueness constraint, so a legacy row's CID
 * can resolve to a `drugs.id` some OTHER page already links modernly.
 * {@link LEGACY_CID_COLLISION_SQL} is that exact check, shared across every
 * repair case below — Case 1's own remap, but also Case 2 (name match) and
 * Case 3 (create a new drug), which would otherwise still recreate the
 * duplicate, or invent a spurious drug row, for a page Case 1 declined to
 * touch. A page this excludes stays dangling for
 * `scripts/fix-monograph-drug-links.ts` (or a human) to resolve.
 */

/** True when `wp.drug_cid` is a legacy CID whose drug already has a page. */
export const LEGACY_CID_COLLISION_SQL = `
  EXISTS (
    SELECT 1 FROM drugs collider
    WHERE collider.pubchem_cid = wp.drug_cid
      AND EXISTS (
        SELECT 1 FROM wiki_pages other
        WHERE other.page_type = 'drug_monograph'
          AND other.drug_cid = collider.id
          AND other.id != wp.id
      )
  )
`;

// Case 1: legacy PubChem CID stored in drug_cid → remap to internal drugs.id.
export const REMAP_LEGACY_CID_SQL = `
  UPDATE wiki_pages wp
  SET drug_cid = d.id, updated_at = NOW()
  FROM drugs d
  WHERE wp.page_type = 'drug_monograph'
    AND wp.drug_cid IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM drugs WHERE id = wp.drug_cid)
    AND d.pubchem_cid = wp.drug_cid
    AND NOT (${LEGACY_CID_COLLISION_SQL})
  RETURNING wp.id
`;

// Case 2: NULL or dangling drug_cid but title matches an existing drug name
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

// Case 3 candidates: NULL or dangling drug_cid with no name match → these get
// a minimal drug row created for them (done row-by-row in the build script,
// since each needs its own slug/name).
export const DANGLING_MONOGRAPH_PAGES_SQL = `
  SELECT wp.id, wp.title FROM wiki_pages wp
  WHERE wp.page_type = 'drug_monograph'
    AND (wp.drug_cid IS NULL OR NOT EXISTS (SELECT 1 FROM drugs WHERE id = wp.drug_cid))
    AND NOT (${LEGACY_CID_COLLISION_SQL})
`;
