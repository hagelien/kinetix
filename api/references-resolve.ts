import { eq, and } from 'drizzle-orm';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { resolveReferenceSchema } from './_lib/schemas.js';
import { normalizeReferenceMetadata } from './_lib/reference-metadata.js';
import { fetchPubMedMetadata } from './_lib/pubmed.js';
import { fetchCrossRefMetadata } from './_lib/crossref.js';
import { citations } from '../db/schema.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import { consumeRateLimit, getClientAddressKey } from './_lib/rate-limit.js';

/**
 * Keep the resolver response on the public citation-metadata contract.
 *
 * Do not use `normalizeReferenceMetadata` here: normalization intentionally
 * drops empty arrays and strings from stored JSON, while the picker expects a
 * resolver preview to contain `authors` even when the provider reports none.
 * An explicit projection strips provider-only classifier fields without
 * weakening that UI contract.
 */
function publicResolverMetadata(metadata: {
  title: string;
  authors: string[];
  journal: string;
  year: number | null;
  volume: string | null;
  pages: string | null;
}) {
  return {
    title: metadata.title,
    authors: metadata.authors,
    journal: metadata.journal,
    year: metadata.year,
    volume: metadata.volume,
    pages: metadata.pages,
  };
}

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
    if (req.method !== 'POST') {
      error(res, 405, 'Method not allowed');
      return;
    }
    assertSameOrigin(req);

    const auth = await getUserFromRequest(req);
    if (!auth) {
      error(res, 401, 'Authentication required');
      return;
    }
    if (!(await callerCan(auth.role, CAP['reference.create']))) {
      error(res, 403, 'Contributor role required');
      return;
    }

    // Rate-limit external API proxying to prevent abuse of PubMed / CrossRef
    // and excessive Neon round-trips from a single client.
    const ipLimit = consumeRateLimit(
      'references-resolve-ip',
      getClientAddressKey(req),
      30,
      60_000,
    );
    if (ipLimit.limited) {
      res.setHeader('Retry-After', String(ipLimit.retryAfterSeconds));
      error(
        res,
        429,
        'Too many reference resolution requests. Please try again later.',
      );
      return;
    }

    const parsed = await parseAndValidate(req, resolveReferenceSchema);
    if ('error' in parsed) {
      error(res, 400, parsed.error);
      return;
    }

    const { type, identifier } = parsed.data;

    if (type !== 'pmid' && type !== 'doi') {
      json(res, 200, { metadata: null });
      return;
    }

    // Check the citations table first — same identifier was already resolved
    // and stored, so we can skip the external API call entirely. The unique
    // index on (type, identifier) makes this lookup O(1).
    const db = getDb();
    const [cached] = await db
      .select({ metadata: citations.metadata })
      .from(citations)
      .where(
        and(eq(citations.type, type), eq(citations.identifier, identifier)),
      )
      .limit(1);

    if (cached) {
      const normalized = normalizeReferenceMetadata(cached.metadata);
      // Only serve from cache when metadata is structurally complete enough to
      // match the resolver shape: `authors` must be an array (possibly empty)
      // because the picker renders `preview.metadata.authors.slice(...)`.
      // Sparse rows (manually submitted citations with partial fields) fall
      // through to the authoritative provider so the picker never receives an
      // object where authors is undefined.
      if (normalized && Array.isArray(normalized.authors)) {
        json(res, 200, { metadata: normalized });
        return;
      }
    }

    if (type === 'pmid') {
      const metadata = await fetchPubMedMetadata(identifier).catch(() => null);
      if (!metadata) {
        json(res, 200, {
          metadata: null,
          error: 'Could not resolve PubMed ID',
        });
        return;
      }
      // The provider record also carries `publicationTypes` for the internal
      // work-kind classifier. It is not citation metadata and the strict
      // POST /api/references schema quite correctly rejects it.
      json(res, 200, { metadata: publicResolverMetadata(metadata) });
      return;
    }

    const metadata = await fetchCrossRefMetadata(identifier).catch(() => null);
    if (!metadata) {
      json(res, 200, { metadata: null, error: 'Could not resolve DOI' });
      return;
    }
    // Crossref likewise adds its raw `workType` classifier input. Keep that
    // server-side field out of the round trip to POST /api/references.
    json(res, 200, { metadata: publicResolverMetadata(metadata) });
  },
);
