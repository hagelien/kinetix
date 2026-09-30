/**
 * Admin endpoint for conversation ingestion (`kinetix-conversation-ingestion-v1`).
 *
 * An admin pastes or uploads the JSON bundle a chat assistant produced with the
 * `kinetix` skill, and this route answers the two questions the admin pane asks:
 *
 *   POST /api/conversation-ingestion { document }
 *     → the plan: what each source, parameter observation, wiki fact and page
 *       proposal would do against current data, item by item.
 *
 *   POST /api/conversation-ingestion { document, action: 'apply', accept: [..] }
 *     → writes only the accepted items, after re-planning them.
 *
 * `accept` carries indices into `document.items`. It is a filter, never an
 * instruction: the store re-resolves every accepted item and refuses anything
 * that is not applicable, so a hand-edited request cannot promote a blocked
 * item — or turn a fact bound for the review queue into a published one.
 * Default action is the read-only plan, so a request that forgets to say what
 * it wants writes nothing.
 *
 * Admin-only (`admin.conversationIngestion.run`). The per-item gate in the pane
 * is what stands in for the review queue here: an admin already holds the
 * authority to publish, and reads every statement before ticking it. A fact the
 * assistant could not verify against full text is the case that gate cannot
 * stand in for, so it goes to `/review` instead of being published.
 */
import { json, error, withErrorHandling } from './_lib/response.js';
import { requireAdmin } from './_lib/require-admin.js';
import { CAP } from '../src/lib/permissions.js';
import {
  readBody,
  assertSameOrigin,
  RequestBodyTooLargeError,
  CrossOriginRequestError,
} from './_lib/validate.js';
import { parseConversationIngestion } from '../src/lib/conversationIngestion.js';
import {
  applyIngestion,
  planIngestion,
  sourceKeysOf,
} from './_lib/conversationIngestionStore.js';
import { resolveIngestionCrosswalk } from './_lib/citation-crosswalk.js';

// A bundle carries a full paper review per source, so it outgrows the default
// 1 MB body cap on a long conversation. Same headroom as the research importer.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export default withErrorHandling(async function handler(req, res): Promise<void> {
  if (req.method !== 'POST') {
    error(res, 405, 'Method not allowed');
    return;
  }

  assertSameOrigin(req);
  const auth = await requireAdmin(req, res, CAP['admin.conversationIngestion.run']);
  if (!auth) return;

  let raw: string;
  try {
    raw = await readBody(req, { maxBytes: MAX_BODY_BYTES });
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      error(res, 413, 'Document too large', 'ingestion_body_too_large');
      return;
    }
    if (err instanceof CrossOriginRequestError) {
      error(res, 403, 'Cross-origin request rejected');
      return;
    }
    throw err;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    error(res, 400, 'Invalid JSON body', 'ingestion_invalid_json');
    return;
  }

  // A primitive root (`42`, `"text"`) is a malformed bundle, not a server
  // fault: `in` throws on a non-object, which would turn the structured 400 the
  // validator exists to produce into a 500.
  const envelope: {
    document?: unknown;
    action?: unknown;
    accept?: unknown;
    expectedReviewActions?: unknown;
    expectedFingerprints?: unknown;
  } = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const document = 'document' in envelope ? envelope.document : body;
  const apply = envelope.action === 'apply';

  const parsed = parseConversationIngestion(document);
  if (!parsed.ok) {
    json(res, 400, {
      ok: false,
      errors: parsed.errors,
      errorDetails: parsed.errorDetails,
      warnings: parsed.warnings,
      warningDetails: parsed.warningDetails,
    });
    return;
  }
  const bundle = parsed.data;

  // Which of this bundle's sources are the same paper as an existing row, per
  // the NCBI ID converter. Resolved here rather than in the store, which stays
  // network-free — and resolved at all rather than trusting the bundle's own
  // `altIds`, which an unpinned model can get plausibly wrong: `resolveCitation`
  // may merge two rows on the strength of a crosswalk. Best-effort, so a slow or
  // unavailable NCBI just means each source is filed under the handle it
  // declared. The plan needs it too — a paper found under its other handle is
  // the difference between "record this appraisal" and "keep the existing
  // review", which is what the gate shows.
  const crosswalk = await resolveIngestionCrosswalk(bundle.sources);

  if (!apply) {
    const plan = await planIngestion(bundle, { crosswalk });
    json(res, 200, {
      ok: true,
      applied: false,
      plan,
      warnings: parsed.warnings,
      warningDetails: parsed.warningDetails,
    });
    return;
  }

  const accept = Array.isArray(envelope.accept)
    ? [
        ...new Set(
          envelope.accept.filter(
            (i): i is number =>
              typeof i === 'number' &&
              Number.isInteger(i) &&
              i >= 0 &&
              i < bundle.items.length,
          ),
        ),
      ]
    : [];
  if (accept.length === 0) {
    // Applying nothing is a client mistake worth naming: the pane always sends
    // the ticked rows, so an empty list means the gate was never filled in.
    error(res, 400, 'No items accepted', 'ingestion_nothing_accepted');
    return;
  }

  // What the gate told the admin would happen to each source's review. Read
  // from the client, but it can only ever WITHHOLD a write: the server decides
  // on its own reading whether a review is recorded, and this just refuses the
  // ones whose disposition changed since the admin looked.
  const expectedReviewActions = new Map<string, 'record' | 'keep'>();
  const declared = envelope.expectedReviewActions;
  if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
    for (const [key, value] of Object.entries(declared as Record<string, unknown>)) {
      if (value === 'record' || value === 'keep') expectedReviewActions.set(key, value);
    }
  }

  // And it is REQUIRED, for every source an accepted item cites. An optional
  // guard is no guard against the case it exists for: omit the snapshot (or one
  // key of it) and a review withdrawn since Analyse would be re-published under
  // an acceptance that predates the withdrawal. Requiring it also pins the
  // endpoint's intended order — analyse, read, then accept — for callers other
  // than the pane, which is the only way to apply something you have seen.
  const requiredKeys = new Set<string>();
  for (const index of accept) {
    for (const key of sourceKeysOf(bundle.items[index]!)) requiredKeys.add(key);
  }
  const missing = [...requiredKeys].filter((key) => !expectedReviewActions.has(key));
  if (missing.length > 0) {
    json(res, 400, {
      ok: false,
      error: 'Missing reviewed source-action snapshot',
      code: 'ingestion_review_snapshot_required',
      missingSourceKeys: missing,
    });
    return;
  }

  // The digest of each accepted row as the gate rendered it. Required for the
  // same reason the review snapshot is: an optional check does not hold in the
  // case it exists for.
  const expectedFingerprints = new Map<number, string>();
  const declaredPrints = envelope.expectedFingerprints;
  if (declaredPrints && typeof declaredPrints === 'object' && !Array.isArray(declaredPrints)) {
    for (const [key, value] of Object.entries(declaredPrints as Record<string, unknown>)) {
      const index = Number(key);
      if (Number.isInteger(index) && typeof value === 'string' && value.length > 0) {
        expectedFingerprints.set(index, value);
      }
    }
  }
  const missingPrints = accept.filter((index) => !expectedFingerprints.has(index));
  if (missingPrints.length > 0) {
    json(res, 400, {
      ok: false,
      error: 'Missing reviewed item fingerprints',
      code: 'ingestion_fingerprints_required',
      missingItems: missingPrints,
    });
    return;
  }

  const result = await applyIngestion(bundle, {
    userId: auth.userId,
    accept,
    crosswalk,
    expectedReviewActions,
    expectedFingerprints,
  });

  // The plan is refreshed so the pane can re-render the gate against post-write
  // state instead of the stale one it submitted — but it is a convenience on
  // top of a receipt for writes that have ALREADY COMMITTED. Letting it fail the
  // response would tell the admin the apply failed while the facts are live,
  // and they would re-run it. Same rule the settings write follows: never let a
  // post-commit read turn a successful write into an error.
  let plan: Awaited<ReturnType<typeof planIngestion>> | null = null;
  try {
    plan = await planIngestion(bundle, { crosswalk });
  } catch (err) {
    console.error('conversation-ingestion: post-apply plan refresh failed', {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  json(res, 200, {
    ok: true,
    applied: true,
    plan,
    result,
    warnings: parsed.warnings,
    warningDetails: parsed.warningDetails,
  });
});
