/**
 * The laboratory's urine detection times.
 *
 *   GET /api/refs-detection-times — the whole table, once.
 *
 * Read access is gated to admins + members of a group granted it in the database
 * (`canAccessRefsDetectionTimes`). There is no write path: the table is a
 * transcription of an approved, versioned, restricted controlled document. It
 * lives in the `refs_detection_guidelines` table, loaded by an operator from
 * outside the repository, and changes when the document does — never by an
 * HTTP call, and never by a commit, because the source tree is public.
 *
 * The payload is small (~50 rows) and identical for every entitled caller, so
 * it goes out whole rather than per substance: the substance register renders a
 * column over the entire catalog from it, and that must not become one request
 * per row.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, error, withErrorHandling, noStoreHeaders } from './_lib/response.js';
import { getUserFromRequest } from './_lib/auth.js';
import { canAccessRefsDetectionTimes } from '../src/lib/featureAccess.js';
import { loadPermissionOverrides } from './_lib/permissions-store.js';
import { loadRefsGuideline } from './_lib/refs-guideline-store.js';
import { EMPTY_REFS_SOURCE } from '../src/lib/refsDetectionTimes.js';

/** Restricted internal material: never cached by a shared proxy. */
const REFS_HEADERS = noStoreHeaders();

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    error(res, 405, 'Method not allowed');
    return;
  }

  const auth = await getUserFromRequest(req);
  const entitled = canAccessRefsDetectionTimes(
    auth,
    await loadPermissionOverrides(),
  );
  if (!entitled) {
    // An empty, flagged payload rather than a 403, the way `/api/methods` and
    // `/api/pm-concentrations` answer. This backs one section of a page every
    // signed-in reader is entitled to see; a rejected request there would
    // surface as an error on a page that is working exactly as configured.
    // Nothing is read from the database on this branch, so nothing from the
    // stored guideline — not even its document identity — can reach a caller
    // outside the gate.
    json(
      res,
      200,
      { source: EMPTY_REFS_SOURCE, preamble: '', rows: [], gated: true },
      { headers: REFS_HEADERS },
    );
    return;
  }

  const guideline = await loadRefsGuideline();
  if (!guideline) {
    // Not loaded on this deployment. The client treats any non-OK answer as
    // "nothing to show", which is the truth; an empty 200 would instead read
    // as "the guideline names none of these substances".
    json(
      res,
      503,
      { error: 'Guideline not available' },
      { headers: REFS_HEADERS },
    );
    return;
  }

  json(
    res,
    200,
    {
      // The document's identity travels with its rows: a reader must be able
      // to say which revision of the guideline a band came from without a
      // second lookup.
      source: guideline.source,
      preamble: guideline.preamble,
      rows: guideline.rows,
      gated: false,
    },
    { headers: REFS_HEADERS },
  );
});

