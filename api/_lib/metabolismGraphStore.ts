/**
 * The module-scoped metabolism neighbourhood (plan §7.3, §10).
 *
 * Source ambiguity walks the graph in **both** directions: an alternative
 * source is either a metabolite of the assumed parent or, transitively, a
 * precursor of something observed. For `A → M ← B`, no downstream walk from `A`
 * ever reaches `B`, and `B` is the administered substance the case would
 * otherwise never mention — codeine and heroin over morphine is that shape.
 *
 * So the whole transitive neighbourhood comes back at once, keyed to a
 * *module* rather than to a case's analytes. That is a privacy requirement and
 * not a convenience: putting the analytes in a request URL would disclose the
 * case's content to the server (spec §41.1), and asking per drug would also
 * miss the nodes the client does not yet know to ask about — which are exactly
 * the ones the upstream walk exists to find.
 */
import { sql } from 'drizzle-orm';

import type { LineageEnzymes } from '../../src/lib/pattern/lineageEnzymes.js';
import type { MetabolismGraph } from '../../src/lib/pattern/sourceAmbiguity.js';
import type { SubstanceClass } from '../../src/lib/parameterApplicability.js';
import type { getDb } from './db.js';

type Db = ReturnType<typeof getDb>;

interface NodeRow {
  pubchem_cid: number;
  slug: string;
  substance_class: string | null;
}

interface EdgeRow {
  from_cid: number;
  to_cid: number;
}

/**
 * The neighbourhood reachable from a module's substances, in both directions.
 *
 * `seedCids` are PubChem CIDs, because that is what a module names and what the
 * engine matches on. A CID the catalog does not carry contributes nothing and
 * is not an error: a module may legitimately name a substance nobody has
 * entered yet, and the walk's answer to that is a neighbourhood without it —
 * which the profile's standing caveat about unrecorded metabolites covers,
 * rather than this function refusing.
 */
export async function getModuleMetabolismGraph(
  db: Db,
  seedCids: number[],
): Promise<MetabolismGraph> {
  const cids = [...new Set(seedCids)].filter((cid) => Number.isInteger(cid) && cid > 0);
  if (cids.length === 0) return { nodes: [], edges: [] };

  // Nodes and edges in **one statement**, which is one snapshot. Read
  // separately they are two database states stitched together, and the walk
  // would then reason over a node set and an edge set that never coexisted —
  // a substance present with the edge that made it reachable already deleted.
  //
  // One recursive term, referencing `reach` once: Postgres refuses a recursive
  // CTE that names itself twice, and the two directions are unioned inside a
  // lateral instead.
  const result = await db.execute(sql`
    WITH RECURSIVE seed AS (
      SELECT id FROM drugs WHERE pubchem_cid = ANY(${sql.raw(`ARRAY[${cids.join(',')}]::int[]`)})
    ),
    reach AS (
      SELECT id FROM seed
      UNION
      SELECT step.id
        FROM reach r
        JOIN LATERAL (
          SELECT m.metabolite_drug_id AS id
            FROM drug_metabolites m
           WHERE m.parent_drug_id = r.id AND m.metabolite_drug_id IS NOT NULL
          UNION ALL
          SELECT m.parent_drug_id AS id
            FROM drug_metabolites m
           WHERE m.metabolite_drug_id = r.id
        ) step ON TRUE
    ),
    node_rows AS (
      SELECT
        d.pubchem_cid,
        d.slug,
        d.substance_class
      FROM drugs d
      WHERE d.id IN (SELECT id FROM reach)
        AND d.pubchem_cid IS NOT NULL
    ),
    edge_rows AS (
      SELECT DISTINCT p.pubchem_cid AS from_cid, c.pubchem_cid AS to_cid
        FROM drug_metabolites m
        JOIN drugs p ON p.id = m.parent_drug_id
        JOIN drugs c ON c.id = m.metabolite_drug_id
       WHERE m.parent_drug_id IN (SELECT id FROM reach)
         AND m.metabolite_drug_id IN (SELECT id FROM reach)
         AND p.pubchem_cid IS NOT NULL
         AND c.pubchem_cid IS NOT NULL
    )
    SELECT
      COALESCE((SELECT json_agg(to_jsonb(n) ORDER BY n.pubchem_cid) FROM node_rows n),
               '[]'::json) AS nodes,
      COALESCE((SELECT json_agg(to_jsonb(e) ORDER BY e.from_cid, e.to_cid) FROM edge_rows e),
               '[]'::json) AS edges
  `);

  const row = (result.rows as Array<Record<string, unknown>>)[0];
  if (!row) return { nodes: [], edges: [] };

  return {
    nodes: (row.nodes as NodeRow[]).map((node) => ({
      drug: { pubchemCid: Number(node.pubchem_cid), slug: node.slug },
      substanceClass: (node.substance_class as SubstanceClass | null) ?? null,
    })),
    edges: (row.edges as EdgeRow[]).map((edge) => ({
      from: { pubchemCid: Number(edge.from_cid) },
      to: { pubchemCid: Number(edge.to_cid) },
    })),
  };
}

interface SubstrateRow {
  enzyme_slug: string;
  pubchem_cid: number;
  slug: string;
}

interface ModulatorRow {
  enzyme_slug: string;
  pubchem_cid: number;
  slug: string;
  names: Record<string, string> | null;
  role: string;
  strength: string | null;
  citations: Array<{ type: string; identifier: string }> | null;
}

/**
 * Which enzymes a module's substances are eliminated through, and which
 * substances the catalog says move those enzymes (plan §7.2, §7.5).
 *
 * Scoped to the module's **own** substances rather than to the transitive
 * neighbourhood the graph returns. The enzyme field asks what this case's
 * lineage routes through; the neighbourhood deliberately reaches substances the
 * case has nothing to do with — an upstream source nobody administered is
 * exactly what the source walk exists to surface — and letting those contribute
 * enzymes would offer a curator a CYP2D6 row because some unrelated precursor
 * of an observed metabolite happens to route through it.
 *
 * Interactions come back for every role the catalog records except `substrate`:
 * a co-medication is offered because it *moves* the enzyme, and a fellow
 * substrate competing for it is a different claim that this field does not make.
 */
export async function getLineageEnzymes(db: Db, seedCids: number[]): Promise<LineageEnzymes> {
  const cids = [...new Set(seedCids)].filter((cid) => Number.isInteger(cid) && cid > 0);
  if (cids.length === 0) return { substrates: [], modulators: [] };

  // One statement again, and for a weaker reason than the graph's: these two
  // are read together and rendered together, so a split read would offer
  // options for an enzyme the other half no longer lists. Nothing worse than a
  // stale option, but there is no reason to accept even that.
  const result = await db.execute(sql`
    WITH seed AS (
      SELECT id, pubchem_cid, slug
        FROM drugs
       WHERE pubchem_cid = ANY(${sql.raw(`ARRAY[${cids.join(',')}]::int[]`)})
    ),
    -- The enzymes the lineage routes through. A renal or biliary route carries
    -- no entity and says nothing about an enzyme; so does a route whose entity
    -- nobody matched, which is a free-text label the field cannot name.
    routes AS (
      SELECT DISTINCT b.slug AS enzyme_slug, s.pubchem_cid, s.slug
        FROM drug_elimination_routes r
        JOIN seed s ON s.id = r.drug_id
        JOIN bio_entities b ON b.id = r.bio_entity_id
       WHERE r.bio_entity_id IS NOT NULL
    ),
    modulators AS (
      SELECT DISTINCT
             b.slug AS enzyme_slug,
             d.pubchem_cid,
             d.slug,
             -- The whole names object, not one language's entry: which name to
             -- show is the reader's locale's question, and this endpoint is
             -- public catalog data with no reader attached. There is no
             -- singular name column to ask for either -- migration 0013 dropped
             -- it, and names have been per-language JSONB since.
             d.names,
             i.role,
             i.strength,
             -- The interaction's own sources, resolved to handles here because
             -- reference_ids are row ids and a client cannot follow them. The
             -- screen states "carbamazepine induces CYP2B6" as a fact from the
             -- catalog, and a reader asking who says so is owed the catalog's
             -- answer rather than the module's papers about what the enzyme
             -- does. A freetext citation is excluded: it resolves to nothing,
             -- so it could only print as a claim with a citation-shaped hole.
             -- jsonb rather than json: the select is DISTINCT, and the json
             -- type has no equality operator for Postgres to group on. Casting
             -- is cheaper than dropping the DISTINCT and trusting an index to
             -- be the only thing keeping a substance from being offered twice.
             COALESCE((
               SELECT jsonb_agg(jsonb_build_object('type', c.type, 'identifier', c.identifier)
                                ORDER BY c.type, c.identifier)
                 FROM citations c
                WHERE c.id = ANY(i.reference_ids)
                  AND c.type IN ('pmid', 'doi', 'url')
             ), '[]'::jsonb) AS citations
        FROM drug_enzyme_interactions i
        JOIN bio_entities b ON b.id = i.bio_entity_id
        JOIN drugs d ON d.id = i.drug_id
       WHERE i.role <> 'substrate'
         AND d.pubchem_cid IS NOT NULL
         AND b.slug IN (SELECT enzyme_slug FROM routes)
    )
    SELECT
      COALESCE((SELECT json_agg(to_jsonb(r) ORDER BY r.enzyme_slug, r.pubchem_cid) FROM routes r),
               '[]'::json) AS substrates,
      COALESCE((SELECT json_agg(to_jsonb(m) ORDER BY m.slug, m.role) FROM modulators m),
               '[]'::json) AS modulators
  `);

  const row = (result.rows as Array<Record<string, unknown>>)[0];
  if (!row) return { substrates: [], modulators: [] };

  return {
    substrates: (row.substrates as SubstrateRow[]).map((substrate) => ({
      enzymeSlug: substrate.enzyme_slug,
      drug: { pubchemCid: Number(substrate.pubchem_cid), slug: substrate.slug },
    })),
    // A role outside the two this field can state is dropped rather than
    // carried: the option would say a substance moves the enzyme without
    // saying which way, which is not an answer a curator can give about their
    // own case.
    modulators: (row.modulators as ModulatorRow[]).flatMap((modulator) =>
      modulator.role === 'inducer' || modulator.role === 'inhibitor'
        ? [
            {
              enzymeSlug: modulator.enzyme_slug,
              drug: { pubchemCid: Number(modulator.pubchem_cid), slug: modulator.slug },
              names: modulator.names ?? {},
              role: modulator.role,
              strength: normalizeStrength(modulator.strength),
              citations: (modulator.citations ?? []).flatMap((citation) =>
                citation.type === 'pmid' || citation.type === 'doi' || citation.type === 'url'
                  ? [{ type: citation.type, identifier: citation.identifier }]
                  : [],
              ),
            },
          ]
        : [],
    ),
  };
}

/** The catalog's coarse magnitude, or null for anything it does not rate. */
function normalizeStrength(value: string | null): 'weak' | 'moderate' | 'strong' | null {
  return value === 'weak' || value === 'moderate' || value === 'strong' ? value : null;
}
