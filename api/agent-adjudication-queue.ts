/**
 * T3 adjudication case feed (docs/plans/2026-09-18-t3-adjudication-backend.md
 * §3.4, agents/drug-db-adjudication.md §3).
 *
 *   GET                       an adjudicator: the cases it sits on, and open
 *                             cases with a free seat it may take (identifiers
 *                             only). A person who may read the dispute queue:
 *                             the cases handed to a person (`?handoffs=1`).
 *   GET  ?caseId=N            the case file. A panelist only on a case it sits
 *                             on, and never the other seat's opinions before
 *                             the case is sealed; a person reads all of it,
 *                             the T4 handoff included.
 *   POST ?action=claim        take a free seat on an open case, before any of
 *                             its content is served. Body: { caseId }.
 *
 * Adjudicator: an active agent with the server-owned `adjudicator` grant AND
 * the flagship tier. A blind T2 verifier has neither the grant nor a seat, so
 * this rich feed is unreachable from the blind side; the identifier-only T2
 * feed stays api/agent-escalation-queue.ts. Nothing here resolves a dispute.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { error, json, noStoreHeaders, withErrorHandling } from './_lib/response.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { callerCan } from './_lib/permissions-store.js';
import { CAP } from '../src/lib/permissions.js';
import { adjudicationClaimSchema } from './_lib/schemas.js';
import {
  claimAdjudicationSeat,
  resolveAdjudicator,
} from './_lib/adjudication/cases.js';
import {
  buildCaseFile,
  listAdjudicatorCases,
  listHandoffs,
} from './_lib/adjudication/caseFile.js';

const CLAIM_REFUSALS: Record<string, { status: number; message: string }> = {
  case_not_found: { status: 404, message: 'No such case' },
  case_not_open: { status: 409, message: 'This case is no longer open' },
  not_eligible: { status: 403, message: 'An active flagship-tier adjudicator is required' },
  conflicted: {
    status: 409,
    message: 'You have a part in this case (a verdict, a dispute or the target itself), so you cannot sit on its panel',
  },
  panel_full: { status: 409, message: 'Both seats on this case are taken' },
  target_unavailable: {
    status: 409,
    message: 'The target can no longer be served to the panel; this case has been closed',
  },
  target_drifted: {
    status: 409,
    message: 'What the target is compared against changed under the panel; this case has been closed',
  },
  target_version_moved: { status: 409, message: 'The target changed; this case has been closed' },
};

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const adjudicator = await resolveAdjudicator(auth.userId);

  if (req.method === 'POST') {
    assertSameOrigin(req);
    if (url.searchParams.get('action') !== 'claim') {
      error(res, 400, 'Unknown action', 'adjudication_unknown_action');
      return;
    }
    if (adjudicator === null || adjudicator === 'not_eligible') {
      error(res, 403, 'An active flagship-tier adjudicator is required', 'adjudication_not_eligible');
      return;
    }
    const parsed = await parseAndValidate(req, adjudicationClaimSchema);
    if ('error' in parsed) {
      error(res, 400, parsed.error);
      return;
    }
    const claimed = await claimAdjudicationSeat({
      caseId: parsed.data.caseId,
      agentId: adjudicator.agentId,
    });
    if (!claimed.ok) {
      const refusal = CLAIM_REFUSALS[claimed.reason]!;
      error(res, refusal.status, refusal.message, `adjudication_${claimed.reason}`);
      return;
    }
    json(res, 200, { seat: claimed.seat, alreadySeated: claimed.alreadySeated }, {
      headers: noStoreHeaders(),
    });
    return;
  }

  if (req.method !== 'GET') {
    error(res, 405, 'Method not allowed');
    return;
  }

  // A person reads as T4; an agent only as a seated adjudicator — an agent
  // backing a reviewer role is still an agent, never a person here.
  const person =
    adjudicator === null && (await callerCan(auth.role, CAP['dispute.queue.read']));
  if (adjudicator === 'not_eligible' || (adjudicator === null && !person)) {
    error(res, 403, 'An adjudicator or a dispute reviewer is required', 'adjudication_not_eligible');
    return;
  }

  const caseIdRaw = url.searchParams.get('caseId');
  if (caseIdRaw !== null) {
    const caseId = Number(caseIdRaw);
    if (!Number.isInteger(caseId) || caseId <= 0) {
      error(res, 400, 'caseId must be a positive integer');
      return;
    }
    const file = await buildCaseFile(
      caseId,
      adjudicator !== null
        ? {
            kind: 'panelist',
            agentId: adjudicator.agentId,
            agentUserId: adjudicator.userId,
            role: auth.role,
          }
        : { kind: 'person', role: auth.role },
    );
    if (!file) {
      // Not found, or not a case this panelist sits on: the same answer, so
      // the existence of a case is not disclosed to an unseated identity.
      error(res, 404, 'No such case, or you hold no seat on it', 'adjudication_case_unavailable');
      return;
    }
    json(res, 200, file, { headers: noStoreHeaders() });
    return;
  }

  if (adjudicator !== null) {
    json(res, 200, await listAdjudicatorCases(adjudicator.agentId), {
      headers: noStoreHeaders(),
    });
    return;
  }
  json(res, 200, { handoffs: await listHandoffs() }, { headers: noStoreHeaders() });
});
