import { sql } from 'drizzle-orm';
import { getDb } from './db.js';
import { PUBCHEM_RECORD_URL_PATTERN } from '../../src/lib/publicDatabaseRecord.js';

type Db = ReturnType<typeof getDb>;

/**
 * A cited paper with no full text on file, no completed read-in-full review,
 * and no *open* `pdf_requests` row — so nothing currently puts it in front of
 * a contributor.
 */
export interface FullTextGapRow {
  citationId: number;
  citationType: string;
  citationIdentifier: string;
  citationMetadata: unknown;
  /** The citation row's creation time — a gap has no open request to date from. */
  citationCreatedAt: string;
  /**
   * A `pdf_requests` row exists but is no longer open — so somebody *did*
   * reach this paper, and "nobody has looked yet" would be a false claim
   * about it.
   *
   * Two paths reach here. A request marked `fulfilled` whose full text is not
   * actually stored is an unfinished handover: the open-request query skips it
   * (status is not open), so without this class it would be visible nowhere.
   * And rows cancelled by `recordPaperReview` before it learned to gate that
   * cancel on `readInFull` are still in the table — that write path no longer
   * produces new ones (a not-read-in-full review now leaves the request open,
   * and a read-in-full one takes the citation out of this list entirely), but
   * the history it already wrote is real and this list must not misdescribe
   * it.
   */
  previouslyRequested: boolean;
}

export interface FullTextGapPage {
  rows: FullTextGapRow[];
  /** Total gaps before the limit, so the UI can say what it is not showing. */
  total: number;
}

export const FULL_TEXT_GAP_LIMIT = 200;

/**
 * Cited, resolvable papers that are missing full text but carry no PDF
 * request.
 *
 * The reference page offers "upload the full text so this can be reviewed"
 * from purely client-side state — no stored PDF, no paper review — while the
 * PDF-request queue reads `pdf_requests`. Nothing bridged the two: a request
 * row is written only when the review agent walks the citation and hits a
 * paywall, or at the instant a contributor actually uploads. So a paper could
 * advertise "full text missing" on its own page indefinitely while the queue
 * showed nothing. This query is that bridge — the same population the
 * reference pages are already describing, computed without writing rows the
 * agent has not earned.
 *
 * A citation qualifies when all of the following hold:
 *   - it is **cited from live content** (the anchors below),
 *   - it is resolvable (`type <> 'freetext'` — a freetext row has no paper,
 *     and `POST /api/pdf-requests` rejects one),
 *   - it is not a PubChem record URL — a public database entry agents read
 *     directly, which `POST /api/pdf-requests` likewise rejects,
 *   - no `citation_pdfs` row (full text is not stored),
 *   - no approved read-in-full `paper_reviews` row — the same test
 *     `findCitationsNeedingFullReview` applies for the reader-facing
 *     `needsFullReview` badge, so a review withdrawn to `read_in_full = false`
 *     still counts as a gap,
 *   - no `pdf_requests` row in `open` status. Those are the agent-confirmed
 *     class and are listed separately; a gap that gets requested moves over
 *     rather than appearing twice. A *closed* request (cancelled or fulfilled
 *     with nothing on file) still belongs here — the paper still needs full
 *     text and no open request will surface it — but it sets
 *     `previouslyRequested` so the caller does not claim nobody asked.
 *
 * "Live content" mirrors the anchors `collectUsedCitationIdsForDrug` proves a
 * bibliography entry against, minus pending edits. A pending edit is not a
 * live claim, and the read-in-full gate rejects a submission whose references
 * lack reviews (`reference_not_judged`), so pending rows would seed the queue
 * with citations attached to edits that cannot be approved as they stand.
 */
export async function listFullTextGaps(
  db: Db,
  limit: number = FULL_TEXT_GAP_LIMIT,
): Promise<FullTextGapPage> {
  const result = await db.execute<{
    citation_id: number;
    type: string;
    identifier: string;
    metadata: unknown;
    // The neon-http driver hands timestamps back as Date; PGlite (the
    // integration harness) as an ISO string. Normalize below.
    created_at: Date | string;
    previously_requested: boolean;
    total_count: number | string;
  }>(sql`
    WITH used AS (
      SELECT DISTINCT citation_id
      FROM (
        SELECT (r.v #>> '{}')::int AS citation_id
        FROM (
          SELECT content FROM wiki_pages
          WHERE status = 'published' AND content IS NOT NULL
        ) pages
        CROSS JOIN LATERAL (
          SELECT t.v
          FROM jsonb_path_query(pages.content, '$.**.referenceIds[*]') t(v)
          WHERE jsonb_typeof(t.v) = 'number'
          UNION ALL
          SELECT t.v
          FROM jsonb_path_query(pages.content, '$.**.referenceId') t(v)
          WHERE jsonb_typeof(t.v) = 'number'
          UNION ALL
          SELECT t.v
          FROM jsonb_path_query(pages.content, '$.**.refs[*]') t(v)
          WHERE jsonb_typeof(t.v) = 'number'
        ) r(v)
        UNION ALL
        SELECT reference_id AS citation_id
        FROM drug_parameter_revisions
        WHERE reference_id IS NOT NULL
        UNION ALL
        SELECT unnest(reference_ids) AS citation_id
        FROM drug_parameter_revisions
        WHERE reference_ids IS NOT NULL
        UNION ALL
        SELECT citation_id
        FROM parameter_entries
        WHERE citation_id IS NOT NULL
        UNION ALL
        SELECT unnest(reference_ids) AS citation_id
        FROM drug_receptor_targets
        WHERE reference_ids IS NOT NULL
        UNION ALL
        SELECT unnest(reference_ids) AS citation_id
        FROM drug_metabolism_profiles
        WHERE reference_ids IS NOT NULL
        UNION ALL
        SELECT unnest(reference_ids) AS citation_id
        FROM drug_elimination_routes
        WHERE reference_ids IS NOT NULL
        UNION ALL
        SELECT unnest(reference_ids) AS citation_id
        FROM drug_metabolites
        WHERE reference_ids IS NOT NULL
        UNION ALL
        SELECT unnest(reference_ids) AS citation_id
        FROM drug_enzyme_interactions
        WHERE reference_ids IS NOT NULL
        UNION ALL
        SELECT unnest(reference_ids) AS citation_id
        FROM drug_ionization_constants
        WHERE reference_ids IS NOT NULL
      ) anchors
      WHERE citation_id IS NOT NULL AND citation_id > 0
    ),
    gaps AS (
      SELECT c.id, c.type, c.identifier, c.metadata, c.created_at,
             EXISTS (
               SELECT 1 FROM pdf_requests r WHERE r.citation_id = c.id
             ) AS previously_requested
      FROM used u
      JOIN citations c ON c.id = u.citation_id
      WHERE c.type <> 'freetext'
        AND NOT (c.type = 'url' AND btrim(c.identifier) ~* ${PUBCHEM_RECORD_URL_PATTERN})
        AND NOT EXISTS (
          SELECT 1 FROM citation_pdfs p WHERE p.citation_id = c.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM paper_reviews pr
          WHERE pr.citation_id = c.id AND pr.read_in_full = true
        )
        AND NOT EXISTS (
          SELECT 1 FROM pdf_requests r
          WHERE r.citation_id = c.id AND r.status = 'open'
        )
    )
    SELECT id AS citation_id, type, identifier, metadata, created_at,
           previously_requested,
           count(*) OVER () AS total_count
    FROM gaps
    -- Newest citation first, matching the open queue's newest-request-first
    -- order; id breaks ties so paging is stable across identical timestamps.
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}
  `);

  const rows = result.rows.map(
    (row): FullTextGapRow => ({
      citationId: row.citation_id,
      citationType: row.type,
      citationIdentifier: row.identifier,
      citationMetadata: row.metadata,
      citationCreatedAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : row.created_at,
      previouslyRequested: Boolean(row.previously_requested),
    }),
  );

  // `count(*) OVER ()` rides along on every row, so the total costs no extra
  // round trip — but it is only present when at least one row came back.
  const first = result.rows[0];
  const total = first ? Number(first.total_count) : 0;

  return { rows, total };
}
