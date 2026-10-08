/**
 * Live catalogue-derived model endpoint.
 *   GET ?slug= — Build one catalogue drug's derived model from the database as it stands now
 *                (`readLiveDerivedModel`): the definition and its grade facts, or the coverage
 *                entry naming why it has no curve.
 *
 * This is what keeps the simulator's derived tier current without regenerating the committed
 * artifact: the app asks for a drug's model when it runs it, so a value curated into the catalogue
 * reaches the next curve. The committed artifact remains the fallback when this cannot be reached.
 *
 * Public, like the catalogue it reads. Whether a curve is SHOWN is still decided by its grade in the
 * app; this endpoint only reports what the data builds. Edge-cached for a minute, so a burst of runs
 * costs one build and a curator's edit is visible within about a minute.
 */
import { error, json, publicCacheHeaders, withErrorHandling } from './_lib/response.js';
import { readLiveDerivedModel } from './_lib/model-derivation-store.js';
import { derivedModelQuerySchema } from './_lib/schemas.js';
import { consumeRateLimit, getClientAddressKey } from './_lib/rate-limit.js';

// Per client, before any database work: each request that misses the edge cache (and every unknown
// slug does) opens a pool and a transaction. A real session asks once per drug per minute, so this
// leaves ample room for a case with many drugs.
const DERIVED_MODEL_IP_LIMIT = 60;
const DERIVED_MODEL_WINDOW_MS = 60_000;

export default withErrorHandling(async function handler(req, res): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    error(res, 405, 'Method not allowed');
    return;
  }
  const ipLimit = consumeRateLimit(
    'derived-model-ip',
    getClientAddressKey(req),
    DERIVED_MODEL_IP_LIMIT,
    DERIVED_MODEL_WINDOW_MS,
  );
  if (ipLimit.limited) {
    res.setHeader('Retry-After', String(ipLimit.retryAfterSeconds));
    error(res, 429, 'Too many requests. Please wait before trying again.', 'rate_limited');
    return;
  }
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const parsed = derivedModelQuerySchema.safeParse({ slug: url.searchParams.get('slug') ?? '' });
  if (!parsed.success) {
    error(res, 400, 'A drug slug is required', 'invalid_slug');
    return;
  }
  const result = await readLiveDerivedModel(parsed.data.slug);
  if (result.status === 'not-found') {
    error(res, 404, 'No drug with that slug', 'drug_not_found');
    return;
  }
  json(res, 200, result, {
    // No stale window: a corrected or withdrawn value must not keep drawing curves past the
    // minute this cache is trusted for.
    headers: publicCacheHeaders({ sMaxAge: 60, staleWhileRevalidate: 0 }),
  });
});
