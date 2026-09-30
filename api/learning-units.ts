/**
 * Read-only API for published learning units.
 *   GET ?id=<n>            — single published unit with link-out source block
 *   GET ?citationId=<n>    — list of published units anchored to that citation
 *   GET (no params)        — lightweight list of all published units (no content)
 *
 * Auth required for admins and `kinetix-learn` group members. The `source`
 * block carries only link-out identifiers (citation type + identifier);
 * PDF/full-text assets are NEVER exposed (Global Constraint: LINK-OUT-ONLY).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, eq } from 'drizzle-orm';
import {
  json,
  error,
  withErrorHandling,
  noStoreHeaders,
} from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { requireKinetixLearnAccess } from './_lib/learn-access.js';
import { learningUnits, citations } from '../db/schema.js';

/**
 * Resolve a citation's link-out URL from its type + identifier. Returns a
 * resolvable external URL for doi/pmid/url citations, or `null` for freetext
 * (and any unrecognised type). NEVER points at a PDF/full-text asset.
 */
export function sourceLinkOutUrl(
  type: string,
  identifier: string,
): string | null {
  const id = identifier.trim();
  if (!id) return null;
  switch (type) {
    case 'doi':
      return `https://doi.org/${id}`;
    case 'pmid':
      return `https://pubmed.ncbi.nlm.nih.gov/${id}/`;
    case 'url': {
      try {
        const parsed = new URL(id);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
          ? id
          : null;
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

/**
 * Build the link-out source block from a citation row. Carries only link-out
 * identifiers, a resolved external URL, and bibliographic metadata (title,
 * authors, journal, year) for the source card — never PDF/blob fields.
 */
function sourceLinkOut(c: {
  id: number;
  type: string;
  identifier: string;
  metadata: unknown;
}): {
  citationId: number;
  type: string;
  identifier: string;
  url: string | null;
  metadata: unknown;
} {
  return {
    citationId: c.id,
    type: c.type,
    identifier: c.identifier,
    url: sourceLinkOutUrl(c.type, c.identifier),
    metadata: c.metadata ?? null,
  };
}

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    error(res, 405, 'Method not allowed');
    return;
  }
  if (!(await requireKinetixLearnAccess(req, res))) return;

  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  );
  const db = getDb();
  const idParam = url.searchParams.get('id');
  const citationParam = url.searchParams.get('citationId');

  if (idParam) {
    // Single unit by id — returns content + source block
    const id = Number(idParam);
    if (!Number.isInteger(id) || id <= 0) {
      error(res, 400, 'Invalid id parameter', 'invalid_id');
      return;
    }
    const [row] = await db
      .select({
        id: learningUnits.id,
        citationId: learningUnits.citationId,
        slug: learningUnits.slug,
        title: learningUnits.title,
        difficulty: learningUnits.difficulty,
        domains: learningUnits.domains,
        kind: learningUnits.kind,
        content: learningUnits.content,
      })
      .from(learningUnits)
      // Any published row regardless of kind — the renderer branches on `kind`
      // (a unit shows its source card, a clinical case shows the scenario).
      .where(
        and(eq(learningUnits.id, id), eq(learningUnits.status, 'published')),
      )
      .limit(1);

    if (!row) {
      error(res, 404, 'Learning unit not found');
      return;
    }

    const [cite] = await db
      .select({
        id: citations.id,
        type: citations.type,
        identifier: citations.identifier,
        metadata: citations.metadata,
      })
      .from(citations)
      .where(eq(citations.id, row.citationId))
      .limit(1);

    json(
      res,
      200,
      {
        id: row.id,
        slug: row.slug,
        title: row.title,
        difficulty: row.difficulty,
        domains: row.domains,
        kind: row.kind,
        content: row.content,
        source: cite ? sourceLinkOut(cite) : null,
      },
      { headers: noStoreHeaders() },
    );
    return;
  }

  // List query — no content payload; optionally filtered by citationId.
  // `kind` defaults to 'unit' so the existing Library/Topic Map stay
  // units-only; the Cases area passes ?kind=clinical_case. Any other value
  // is rejected so a typo can't silently widen the listing.
  if (citationParam) {
    const citationId = Number(citationParam);
    if (!Number.isInteger(citationId) || citationId <= 0) {
      error(res, 400, 'Invalid citationId parameter', 'invalid_citation_id');
      return;
    }
  }
  const kindParam = url.searchParams.get('kind') ?? 'unit';
  if (kindParam !== 'unit' && kindParam !== 'clinical_case') {
    error(res, 400, 'Invalid kind parameter', 'invalid_kind');
    return;
  }
  const filters = [
    eq(learningUnits.status, 'published'),
    eq(learningUnits.kind, kindParam),
  ];
  if (citationParam) {
    filters.push(eq(learningUnits.citationId, Number(citationParam)));
  }
  const rows = await db
    .select({
      id: learningUnits.id,
      slug: learningUnits.slug,
      title: learningUnits.title,
      difficulty: learningUnits.difficulty,
      domains: learningUnits.domains,
      kind: learningUnits.kind,
    })
    .from(learningUnits)
    .where(and(...filters))
    .limit(200);

  json(res, 200, { units: rows }, { headers: noStoreHeaders() });
});
