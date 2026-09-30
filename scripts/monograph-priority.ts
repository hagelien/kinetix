import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);

// A: unreferenced flags in discussions
const flags = await sql`
  SELECT d.id AS drug_id, d.slug, dpd.id AS discussion_id, LEFT(dpd.body, 200) AS body
  FROM drug_parameter_discussions dpd
  JOIN drugs d ON d.id = dpd.drug_id
  WHERE dpd.body LIKE '%[unreferenced-flag]%'
    AND dpd.parameter IS NULL
  ORDER BY dpd.created_at ASC
  LIMIT 5
`;
console.log("UNREFERENCED_FLAGS:" + JSON.stringify(flags));

// B: most popular published drug monograph shorter than ~800 words
// COALESCE treats NULL plaintext as 0 so legacy/empty pages rank first.
// LATERAL join resolves drug_cid as either drugs.id (modern) or
// drugs.pubchem_cid (legacy rows), returning at most one drug per page.
const shortMonographs = await sql`
  SELECT wp.id, wp.drug_cid, wp.title, wp.status,
         COALESCE(LENGTH(wp.content_plaintext), 0) AS plaintext_len,
         d.slug, d.names, d.popularity_score
  FROM wiki_pages wp
  JOIN LATERAL (
    SELECT id, slug, names, popularity_score
    FROM drugs
    WHERE id = wp.drug_cid OR pubchem_cid = wp.drug_cid
    LIMIT 1
  ) d ON true
  WHERE wp.status = 'published'
    AND wp.page_type = 'drug_monograph'
    AND COALESCE(LENGTH(wp.content_plaintext), 0) < 4800
  ORDER BY d.popularity_score DESC
  LIMIT 10
`;
console.log("SHORT_MONOGRAPHS:" + JSON.stringify(shortMonographs));

// C: stalest published monograph
const stalest = await sql`
  SELECT wp.id, wp.drug_cid, wp.title, wp.updated_at, d.slug, d.names
  FROM wiki_pages wp
  JOIN LATERAL (
    SELECT id, slug, names
    FROM drugs
    WHERE id = wp.drug_cid OR pubchem_cid = wp.drug_cid
    LIMIT 1
  ) d ON true
  WHERE wp.status = 'published'
    AND wp.page_type = 'drug_monograph'
  ORDER BY wp.updated_at ASC
  LIMIT 5
`;
console.log("STALEST:" + JSON.stringify(stalest));
