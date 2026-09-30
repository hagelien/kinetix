import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  citations,
  drugParameterRevisions,
  drugs,
  referenceConcentrations,
} from '../../db/schema.js';
import { getDb } from './db.js';

type Db = ReturnType<typeof getDb>;

/**
 * Citation ids that are linked from at least one persistent surface for the
 * given drug. The references API filters its drug-scoped listing through
 * this set so citations created during a cancelled "add fact" flow stay
 * out of the bibliography (#304).
 *
 * Sources considered "in use":
 *   - Approved wiki page content (fact node referenceIds, field.refs,
 *     inline footnote marks) on any published page tied to the drug.
 *   - Drug parameter revisions (current + historical edits).
 *   - Parameter entries (the per-source rows the aggregate cache pools; the
 *     table `reference_concentrations` was renamed to in migration 0078).
 *   - Pharmacodynamic targets and the metabolism box (profile, elimination
 *     routes, metabolites, enzyme interactions). The sidebar renders these
 *     citations as numbered markers, so a citation anchored only there is
 *     cited content, not an orphan.
 *   - Pending edits still in the review queue (status='pending') whose
 *     target is one of the drug's pages or the drug itself.
 *
 * Rejected pending edits are intentionally excluded — once an edit is
 * rejected its citation has no anchor and behaves like an orphan.
 */
export async function collectUsedCitationIdsForDrug(
  db: Db,
  drugId: number,
): Promise<Set<number>> {
  const used = new Set<number>();

  // Keep the drug-scoped bibliography proof inside one SQL statement. This
  // route is loaded by monograph sidebars; avoiding five independent Neon HTTP
  // round trips also avoids shipping revision/pending-edit arrays to Node just
  // to collect citation IDs.
  const result = await db.execute<{ citation_id: number }>(sql`
    WITH page_citations AS (
      SELECT DISTINCT (r.v #>> '{}')::int AS citation_id
      FROM (
        SELECT content FROM wiki_pages
        WHERE drug_cid = ${drugId}
          AND status = 'published'
          AND content IS NOT NULL
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
      WHERE (r.v #>> '{}')::int > 0
    ),
    revision_scalar_citations AS (
      SELECT reference_id AS citation_id
      FROM drug_parameter_revisions
      WHERE drug_id = ${drugId}
        AND reference_id IS NOT NULL
    ),
    revision_array_citations AS (
      SELECT unnest(reference_ids) AS citation_id
      FROM drug_parameter_revisions
      WHERE drug_id = ${drugId}
        AND reference_ids IS NOT NULL
    ),
    concentration_citations AS (
      SELECT citation_id
      FROM parameter_entries
      WHERE drug_id = ${drugId}
        AND citation_id IS NOT NULL
    ),
    receptor_target_citations AS (
      SELECT unnest(reference_ids) AS citation_id
      FROM drug_receptor_targets
      WHERE drug_id = ${drugId}
        AND reference_ids IS NOT NULL
    ),
    metabolism_profile_citations AS (
      SELECT unnest(reference_ids) AS citation_id
      FROM drug_metabolism_profiles
      WHERE drug_id = ${drugId}
        AND reference_ids IS NOT NULL
    ),
    elimination_route_citations AS (
      SELECT unnest(reference_ids) AS citation_id
      FROM drug_elimination_routes
      WHERE drug_id = ${drugId}
        AND reference_ids IS NOT NULL
    ),
    metabolite_citations AS (
      -- Both directions of the junction: getDrugMetabolism() reads the rows
      -- where this drug is the metabolite back as its precursors, and the
      -- metabolism box renders their citations the same way it renders the
      -- parent-side ones.
      SELECT unnest(reference_ids) AS citation_id
      FROM drug_metabolites
      WHERE (parent_drug_id = ${drugId} OR metabolite_drug_id = ${drugId})
        AND reference_ids IS NOT NULL
    ),
    enzyme_interaction_citations AS (
      SELECT unnest(reference_ids) AS citation_id
      FROM drug_enzyme_interactions
      WHERE drug_id = ${drugId}
        AND reference_ids IS NOT NULL
    ),
    ionization_constant_citations AS (
      SELECT unnest(reference_ids) AS citation_id
      FROM drug_ionization_constants
      WHERE drug_id = ${drugId}
        AND reference_ids IS NOT NULL
    ),
    pending_parameter_scalar_citations AS (
      SELECT reference_id AS citation_id
      FROM pending_edits
      WHERE edit_type = 'parameter'
        AND status = 'pending'
        AND target_id = ${drugId}
        AND reference_id IS NOT NULL
    ),
    pending_parameter_array_citations AS (
      SELECT unnest(reference_ids) AS citation_id
      FROM pending_edits
      WHERE edit_type = 'parameter'
        AND status = 'pending'
        AND target_id = ${drugId}
        AND reference_ids IS NOT NULL
    ),
    pending_fact_scalar_citations AS (
      SELECT pe.reference_id AS citation_id
      FROM pending_edits pe
      INNER JOIN wiki_pages p
        ON p.id = pe.target_id
       AND p.drug_cid = ${drugId}
      WHERE pe.edit_type = 'wiki_fact'
        AND pe.status = 'pending'
        AND pe.reference_id IS NOT NULL
    ),
    pending_fact_array_citations AS (
      SELECT unnest(pe.reference_ids) AS citation_id
      FROM pending_edits pe
      INNER JOIN wiki_pages p
        ON p.id = pe.target_id
       AND p.drug_cid = ${drugId}
      WHERE pe.edit_type = 'wiki_fact'
        AND pe.status = 'pending'
        AND pe.reference_ids IS NOT NULL
    )
    SELECT DISTINCT citation_id
    FROM (
      SELECT citation_id FROM page_citations
      UNION ALL
      SELECT citation_id FROM revision_scalar_citations
      UNION ALL
      SELECT citation_id FROM revision_array_citations
      UNION ALL
      SELECT citation_id FROM concentration_citations
      UNION ALL
      SELECT citation_id FROM receptor_target_citations
      UNION ALL
      SELECT citation_id FROM metabolism_profile_citations
      UNION ALL
      SELECT citation_id FROM elimination_route_citations
      UNION ALL
      SELECT citation_id FROM metabolite_citations
      UNION ALL
      SELECT citation_id FROM enzyme_interaction_citations
      UNION ALL
      SELECT citation_id FROM ionization_constant_citations
      UNION ALL
      SELECT citation_id FROM pending_parameter_scalar_citations
      UNION ALL
      SELECT citation_id FROM pending_parameter_array_citations
      UNION ALL
      SELECT citation_id FROM pending_fact_scalar_citations
      UNION ALL
      SELECT citation_id FROM pending_fact_array_citations
    ) used
    WHERE citation_id IS NOT NULL
  `);

  for (const row of result.rows) {
    if (row.citation_id != null) used.add(row.citation_id);
  }

  return used;
}

/**
 * Filter an arbitrary citation-id list down to rows that have at least one
 * approved or still-reviewable anchor. This is the global counterpart to
 * collectUsedCitationIdsForDrug() for direct `/api/references?id(s)=...`
 * lookups, where no drug id is available. Orphaned citation rows are excluded
 * so sequential IDs cannot enumerate abandoned AddFact/ReferenceInput drafts.
 *
 * A citation is anchored by the same surfaces collectUsedCitationIdsForDrug()
 * proves against — including the pharmacodynamic-target and metabolism rows the
 * monograph sidebar renders — so following a reference marker from one of those
 * boxes to the reference module resolves instead of 404ing.
 *
 * A citation is also anchored when it carries a PDF request or a paper review:
 * the review agent files those when it hits a paywall (or after reading the
 * paper), and both are already surfaced publicly — the PDF-requests queue lists
 * the request and the reference module renders the review. Without this, a
 * citation that is only cited from a discussion comment and awaiting full text
 * (#304's filter doesn't count comments) 404s when a contributor follows the
 * "Deliver PDF" link from the queue to fulfil the request. Including them does
 * not widen the enumeration surface: abandoned drafts have neither a request
 * nor a review.
 */
export async function filterUsedCitationIds(
  db: Db,
  citationIds: number[],
): Promise<Set<number>> {
  const candidates = [...new Set(citationIds)].filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  const used = new Set<number>();
  if (candidates.length === 0) return used;

  const idList = sql.join(
    candidates.map((id) => sql`${id}`),
    sql`, `,
  );

  // Keep the visibility proof inside one SQL statement. This endpoint is hit by
  // direct and batched reference lookups, and the Neon HTTP driver charges every
  // independent query as another round trip; the previous implementation fanned
  // six queries per call. Each UNION arm is still constrained to the requested
  // candidate IDs, including the JSONB page-content scan.
  const result = await db.execute<{ citation_id: number }>(sql`
    WITH candidate_ids AS (
      SELECT unnest(ARRAY[${idList}]::int[]) AS citation_id
    ),
    page_citations AS (
      SELECT DISTINCT (r.v #>> '{}')::int AS citation_id
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
      INNER JOIN candidate_ids c
        ON c.citation_id = (r.v #>> '{}')::int
    ),
    revision_scalar_citations AS (
      SELECT reference_id AS citation_id
      FROM drug_parameter_revisions
      WHERE reference_id IN (${idList})
    ),
    revision_array_citations AS (
      SELECT unnest(reference_ids) AS citation_id
      FROM drug_parameter_revisions
      WHERE reference_ids && ARRAY[${idList}]::int[]
    ),
    concentration_citations AS (
      SELECT citation_id
      FROM parameter_entries
      WHERE citation_id IN (${idList})
    ),
    receptor_target_citations AS (
      SELECT unnest(reference_ids) AS citation_id
      FROM drug_receptor_targets
      WHERE reference_ids && ARRAY[${idList}]::int[]
    ),
    metabolism_profile_citations AS (
      SELECT unnest(reference_ids) AS citation_id
      FROM drug_metabolism_profiles
      WHERE reference_ids && ARRAY[${idList}]::int[]
    ),
    elimination_route_citations AS (
      SELECT unnest(reference_ids) AS citation_id
      FROM drug_elimination_routes
      WHERE reference_ids && ARRAY[${idList}]::int[]
    ),
    metabolite_citations AS (
      SELECT unnest(reference_ids) AS citation_id
      FROM drug_metabolites
      WHERE reference_ids && ARRAY[${idList}]::int[]
    ),
    enzyme_interaction_citations AS (
      SELECT unnest(reference_ids) AS citation_id
      FROM drug_enzyme_interactions
      WHERE reference_ids && ARRAY[${idList}]::int[]
    ),
    ionization_constant_citations AS (
      SELECT unnest(reference_ids) AS citation_id
      FROM drug_ionization_constants
      WHERE reference_ids && ARRAY[${idList}]::int[]
    ),
    pending_scalar_citations AS (
      SELECT reference_id AS citation_id
      FROM pending_edits
      WHERE status = 'pending'
        AND reference_id IN (${idList})
    ),
    pending_array_citations AS (
      SELECT unnest(reference_ids) AS citation_id
      FROM pending_edits
      WHERE status = 'pending'
        AND reference_ids && ARRAY[${idList}]::int[]
    ),
    pdf_request_citations AS (
      SELECT citation_id
      FROM pdf_requests
      WHERE citation_id IN (${idList})
    ),
    paper_review_citations AS (
      SELECT citation_id
      FROM paper_reviews
      WHERE citation_id IN (${idList})
    )
    SELECT DISTINCT citation_id
    FROM (
      SELECT citation_id FROM page_citations
      UNION ALL
      SELECT citation_id FROM revision_scalar_citations
      UNION ALL
      SELECT citation_id FROM revision_array_citations
      UNION ALL
      SELECT citation_id FROM concentration_citations
      UNION ALL
      SELECT citation_id FROM receptor_target_citations
      UNION ALL
      SELECT citation_id FROM metabolism_profile_citations
      UNION ALL
      SELECT citation_id FROM elimination_route_citations
      UNION ALL
      SELECT citation_id FROM metabolite_citations
      UNION ALL
      SELECT citation_id FROM enzyme_interaction_citations
      UNION ALL
      SELECT citation_id FROM ionization_constant_citations
      UNION ALL
      SELECT citation_id FROM pending_scalar_citations
      UNION ALL
      SELECT citation_id FROM pending_array_citations
      UNION ALL
      SELECT citation_id FROM pdf_request_citations
      UNION ALL
      SELECT citation_id FROM paper_review_citations
    ) used
    INNER JOIN candidate_ids c USING (citation_id)
    WHERE citation_id IS NOT NULL
  `);

  for (const row of result.rows) {
    if (row.citation_id != null) used.add(row.citation_id);
  }

  return used;
}

/**
 * Parameter-level citation anchors for the given drug. This is intentionally
 * narrower than collectUsedCitationIdsForDrug: it answers "which parameter
 * thread should a reference-specific note use?" without exposing the agent
 * runner to direct SQL.
 */
export async function collectParameterCitationUsageForDrug(
  db: Db,
  drugId: number,
): Promise<Map<number, Set<string>>> {
  const rows = await db
    .select({
      parameter: drugParameterRevisions.parameter,
      referenceId: drugParameterRevisions.referenceId,
      referenceIds: drugParameterRevisions.referenceIds,
    })
    .from(drugParameterRevisions)
    .where(eq(drugParameterRevisions.drugId, drugId));

  const byCitation = new Map<number, Set<string>>();
  for (const row of rows) {
    const ids =
      row.referenceIds && row.referenceIds.length > 0
        ? row.referenceIds
        : row.referenceId != null
          ? [row.referenceId]
          : [];
    for (const id of ids) {
      if (typeof id !== 'number') continue;
      const parameters = byCitation.get(id) ?? new Set<string>();
      parameters.add(row.parameter);
      byCitation.set(id, parameters);
    }
  }

  return byCitation;
}

/** One place a reference is cited from: a drug monograph or a wiki page. */
export type ReferenceUsageLocation =
  | {
      kind: 'drug';
      id: number;
      slug: string;
      names: Record<string, string>;
      href: string;
    }
  | {
      kind: 'wiki';
      id: number;
      slug: string;
      title: string;
      pageType: string;
      href: string;
    };

/**
 * The inverse of collectUsedCitationIdsForDrug: given a single citation, list
 * every drug monograph and wiki page that references it. Powers the "cited in"
 * cross-links on the reference module page.
 *
 * A citation is attributed to a **drug** when it is that drug's direct
 * `citations.drug_id`, appears in one of the drug's parameter revisions or
 * parameter-entry rows, backs one of its pharmacodynamic targets or any part of
 * its metabolism box, or is cited from the drug's monograph page content — the
 * same surfaces collectUsedCitationIdsForDrug() proves visibility against, so
 * a reference the bibliography shows can always say where it is cited from. It
 * is attributed to a **wiki page** when it is cited from a
 * non-monograph published page (topic / entity monograph). Each query is
 * scoped to the one citation id, so this stays cheap enough to run on every
 * reference page view.
 */
export async function collectReferenceUsage(
  db: Db,
  citationId: number,
): Promise<ReferenceUsageLocation[]> {
  const idJson = JSON.stringify({ cid: citationId });

  const [directRows, paramRows, concRows, relationshipRows, pageRows] =
    await Promise.all([
    db
      .select({ drugId: citations.drugId })
      .from(citations)
      .where(and(eq(citations.id, citationId), isNotNull(citations.drugId))),
    db
      .selectDistinct({ drugId: drugParameterRevisions.drugId })
      .from(drugParameterRevisions)
      .where(
        sql`${drugParameterRevisions.referenceId} = ${citationId}
          OR ${drugParameterRevisions.referenceIds} @> ARRAY[${citationId}]::int[]`,
      ),
    db
      .selectDistinct({ drugId: referenceConcentrations.drugId })
      .from(referenceConcentrations)
      .where(eq(referenceConcentrations.citationId, citationId)),
    // Pharmacodynamic-target and metabolism anchors, in one round trip. These
    // are the same surfaces collectUsedCitationIdsForDrug() proves visibility
    // against; without them a citation held only there passes the visibility
    // check but lands on a reference page whose "cited in" list is empty — or,
    // worse, shows just the unrelated drug that happens to own `citations.
    // drug_id`, since citations are deduplicated globally on (type, identifier)
    // and that column keeps pointing at whichever drug created the row first.
    db.execute<{ drug_id: number }>(sql`
      SELECT DISTINCT drug_id FROM (
        SELECT drug_id
        FROM drug_receptor_targets
        WHERE reference_ids @> ARRAY[${citationId}]::int[]
        UNION ALL
        SELECT drug_id
        FROM drug_metabolism_profiles
        WHERE reference_ids @> ARRAY[${citationId}]::int[]
        UNION ALL
        SELECT drug_id
        FROM drug_elimination_routes
        WHERE reference_ids @> ARRAY[${citationId}]::int[]
        UNION ALL
        SELECT drug_id
        FROM drug_enzyme_interactions
        WHERE reference_ids @> ARRAY[${citationId}]::int[]
        UNION ALL
        SELECT drug_id
        FROM drug_ionization_constants
        WHERE reference_ids @> ARRAY[${citationId}]::int[]
        UNION ALL
        -- Both ends of the metabolite junction, matching the bibliography:
        -- the row shows up in the parent's metabolites and in the
        -- metabolite's precursors, so it is cited from both monographs.
        SELECT parent_drug_id AS drug_id
        FROM drug_metabolites
        WHERE reference_ids @> ARRAY[${citationId}]::int[]
        UNION ALL
        SELECT metabolite_drug_id AS drug_id
        FROM drug_metabolites
        WHERE reference_ids @> ARRAY[${citationId}]::int[]
          AND metabolite_drug_id IS NOT NULL
      ) rel
      WHERE drug_id IS NOT NULL
    `),
    db.execute<{
      page_id: number;
      slug: string;
      title: string;
      page_type: string;
      drug_cid: number | null;
    }>(sql`
      SELECT p.id AS page_id, p.slug, p.title, p.page_type, p.drug_cid
      FROM wiki_pages p
      WHERE p.status = 'published'
        AND p.content IS NOT NULL
        AND (
          jsonb_path_exists(
            p.content, '$.**.referenceIds[*] ? (@ == $cid)', ${idJson}::jsonb
          )
          OR jsonb_path_exists(
            p.content, '$.**.referenceId ? (@ == $cid)', ${idJson}::jsonb
          )
          OR jsonb_path_exists(
            p.content, '$.**.refs[*] ? (@ == $cid)', ${idJson}::jsonb
          )
        )
    `),
  ]);

  const drugIds = new Set<number>();
  for (const row of directRows) {
    if (row.drugId != null) drugIds.add(row.drugId);
  }
  for (const row of paramRows) {
    if (row.drugId != null) drugIds.add(row.drugId);
  }
  for (const row of concRows) {
    if (row.drugId != null) drugIds.add(row.drugId);
  }
  for (const row of relationshipRows.rows) {
    if (row.drug_id != null) drugIds.add(row.drug_id);
  }

  // Split pages: a drug monograph counts as its drug; everything else is a
  // standalone wiki location.
  const wikiPageRows: typeof pageRows.rows = [];
  for (const row of pageRows.rows) {
    if (row.page_type === 'drug_monograph' && row.drug_cid != null) {
      drugIds.add(row.drug_cid);
    } else {
      wikiPageRows.push(row);
    }
  }

  const drugRows =
    drugIds.size > 0
      ? await db
          .select({ id: drugs.id, slug: drugs.slug, names: drugs.names })
          .from(drugs)
          .where(inArray(drugs.id, [...drugIds]))
      : [];

  const locations: ReferenceUsageLocation[] = [
    ...drugRows.map(
      (d): ReferenceUsageLocation => ({
        kind: 'drug',
        id: d.id,
        slug: d.slug,
        names: d.names,
        href: `/wiki/drug/${d.id}`,
      }),
    ),
    ...wikiPageRows.map(
      (p): ReferenceUsageLocation => ({
        kind: 'wiki',
        id: p.page_id,
        slug: p.slug,
        title: p.title,
        pageType: p.page_type,
        href: `/wiki/${p.slug}`,
      }),
    ),
  ];

  return locations;
}
