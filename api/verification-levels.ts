/**
 * Read-only verification levels for the live values on a page.
 *
 *   GET ?drugId=N      → { levels: { [parameterId]: { level, disputed } } }
 *   GET ?wikiPageId=N  → { levels: { [factId]:      { level, disputed } } }
 *
 * Levels are a display signal (see api/_lib/approvals.ts) layered on top of
 * already-public data: drug parameters and published monographs are world-
 * readable, so the drugId mode and the published-page wikiPageId mode need no
 * auth. Draft wiki pages stay editor+-only, mirroring the page-content APIs, so
 * the level map can't leak a draft page's fact structure.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import { getDb } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { json, error, withErrorHandling } from './_lib/response.js';
import {
  callerCanReadWikiPage,
} from './_lib/permissions-store.js';
import { wikiPages } from '../db/schema.js';
import {
  factVerificationLevels,
  parameterVerificationLevels,
} from './_lib/verification-levels.js';

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    error(res, 405, 'Method not allowed');
    return;
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const drugIdRaw = url.searchParams.get('drugId');
  const wikiPageIdRaw = url.searchParams.get('wikiPageId');

  if (drugIdRaw) {
    const drugId = Number(drugIdRaw);
    if (!Number.isInteger(drugId) || drugId <= 0) {
      error(res, 400, 'drugId must be a positive integer');
      return;
    }
    json(res, 200, { levels: await parameterVerificationLevels(drugId) });
    return;
  }

  if (wikiPageIdRaw) {
    const wikiPageId = Number(wikiPageIdRaw);
    if (!Number.isInteger(wikiPageId) || wikiPageId <= 0) {
      error(res, 400, 'wikiPageId must be a positive integer');
      return;
    }
    const db = getDb();
    const [page] = await db
      .select({ status: wikiPages.status })
      .from(wikiPages)
      .where(eq(wikiPages.id, wikiPageId))
      .limit(1);
    if (!page) {
      error(res, 404, 'Page not found', 'wiki_page_not_found');
      return;
    }
    const auth = await getUserFromRequest(req);
    if (
      !(await callerCanReadWikiPage(
        page.status,
        auth ? { role: auth.role } : null,
      ))
    ) {
      // Match the wiki-content APIs: don't disclose a draft page's existence.
      error(res, 404, 'Page not found', 'wiki_page_not_found');
      return;
    }
    json(res, 200, { levels: await factVerificationLevels(wikiPageId) });
    return;
  }

  error(res, 400, 'Provide either drugId or wikiPageId');
});
