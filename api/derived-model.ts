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
import { z } from 'zod';
import { error, json, publicCacheHeaders, withErrorHandling } from './_lib/response.js';
import { readLiveDerivedModel } from './_lib/model-derivation-store.js';

const querySchema = z.object({
  slug: z.string().trim().min(1).max(200),
});

export default withErrorHandling(async function handler(req, res): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    error(res, 405, 'Method not allowed');
    return;
  }
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const parsed = querySchema.safeParse({ slug: url.searchParams.get('slug') ?? '' });
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
    headers: publicCacheHeaders({ sMaxAge: 60, staleWhileRevalidate: 300 }),
  });
});
